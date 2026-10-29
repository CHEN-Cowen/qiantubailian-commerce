/**
 * E06 测试：三种说明图（包装内容清单 / 尺寸说明 / SKU 对比）的确定性排版与采用闭环。
 *
 * 覆盖：
 * 1. 纯函数 buildExplainerPlan：三种图种的行内容、缺资料明说（NO_SKU_PROFILE / CONTENT_MISSING /
 *    SIZE_FACTS_MISSING / PEER_* / COMPARE_EMPTY）、未提供一侧不推断；
 * 2. 纯函数编辑守卫：只允许标题/副标题/脚注，改数量/单位/条目名 → FACT_VALUE_IMMUTABLE；
 *    承诺词 → CLAIM_NOT_ALLOWED；超长 → INVALID_FIELD；
 * 3. 纯函数 auditExplainerPlan：逐行核对快照数量/单位/对照值；档案与确认事实同名属性矛盾 → truth_conflict；
 * 4. 纯函数 explainerStale / dependencyEntriesFor / renderExplainerSvg（确定性、转义、免责声明）；
 * 5. 纯函数 presentExplainer 状态派生与 validateExplainerReview / validateExplainerFeedback；
 * 6. 集成：预览不落库、创建幂等与重复检测（force 才重做）、内容下载、复核/选版闸口、替换包导出与下载、
 *    采用反馈、require_photo 报价、素材底图与非法底图、跨租户 404；
 * 7. 集成（含真实任务）：未过导出闸口的图片版本不能免费当底图（SOURCE_NOT_ENTITLED）；
 *    已发布版本可继承权益；事实变化被变更单识别并确定性重排（不扣费）。
 * 运行：node --test test/e06.js（Node 22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  CLAIM_BLOCKLIST, EXPLAINER_CANVAS, SIZE_DISCLAIMER, applyExplainerEdits, auditExplainerPlan,
  buildExplainerPlan, dependencyEntriesFor, explainerPath, explainerStale, planFingerprint,
  presentExplainer, renderExplainerSvg, validateExplainerFeedback, validateExplainerReview,
} from '../src/explainer.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 纯函数 fixture ----------

const PROFILE = {
  version: 3,
  skus: [
    {
      id: 'sku_e06_a', sku_code: 'E06-01', label: '标准装', confirmed: true,
      attributes: [
        { key: '容量', value: '50', unit: 'g' },
        { key: '长', value: '30', unit: 'cm' },
        { key: '宽', value: '20', unit: 'cm' },
        { key: '高', value: '10', unit: 'cm' },
        { key: '核心卖点', value: '舒缓维稳' },
      ],
      contents: [
        { item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' },
        { item: '礼盒', quantity: 1, unit: '个', included: false, source: 'user_input' },
      ],
    },
    {
      id: 'sku_e06_b', sku_code: 'E06-02', label: '双支装', confirmed: true,
      attributes: [
        { key: '容量', value: '100', unit: 'g' },
        { key: '长', value: '30', unit: 'cm' },
        { key: '宽', value: '20', unit: 'cm' },
        { key: '高', value: '10', unit: 'cm' },
      ],
      contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
    },
  ],
};
const TRUTH = {
  version: 4,
  sku: 'E06-01',
  facts: [
    { key: '容量', value: '50', unit: 'g' },
    { key: '长', value: '30', unit: 'cm' },
    { key: '核心卖点', value: '舒缓维稳' },
  ],
};
const planOf = (kind, extra = {}) => buildExplainerPlan({
  kind, skuProfile: PROFILE, skuId: 'sku_e06_a', truth: TRUTH, ...extra,
});

test('E06 纯函数 buildExplainerPlan：包装清单含排除项、尺寸只列长度、对比不推断', () => {
  const packing = planOf('packing_list');
  assert.equal(packing.ok, true);
  assert.equal(packing.rows.length, 2);
  const included = packing.rows.find(row => row.label === '瓶装');
  const excluded = packing.rows.find(row => row.label === '礼盒');
  assert.equal(included.section, 'included');
  assert.equal(included.value, '1 瓶');
  assert.equal(excluded.section, 'excluded', '不随包装交付的条目要单列，不能混在清单里');
  assert.deepEqual(packing.sources.sku_profile_version, 3);
  assert.equal(typeof packing.plan_hash, 'string');

  const size = planOf('size');
  assert.equal(size.ok, true);
  assert.deepEqual(size.rows.map(row => row.label), ['长', '宽', '高'], '容量(g)不是长度单位，不得进尺寸图');
  assert.equal(size.rows[0].value, '30 cm');
  assert.equal(size.disclaimer, SIZE_DISCLAIMER);

  const compare = planOf('sku_compare', { peerSkuId: 'sku_e06_b' });
  assert.equal(compare.ok, true);
  const capacity = compare.rows.find(row => row.label === '容量');
  assert.equal(capacity.a, '50 g');
  assert.equal(capacity.b, '100 g');
  assert.equal(capacity.diff, true);
  const bottle = compare.rows.find(row => row.label === '瓶装');
  assert.equal(bottle.b, '2 瓶');
  const gift = compare.rows.find(row => row.label === '礼盒');
  assert.equal(gift.b, '未包含', '对侧没有的条目要明说未包含，不能省略');
  assert.equal(gift.diff, true);
});

test('E06 纯函数 buildExplainerPlan：缺资料返回 code 与 missing，不猜测补齐', () => {
  assert.equal(planOf('packing_list', { skuProfile: null }).code, 'NO_SKU_PROFILE');
  assert.equal(planOf('packing_list', { skuId: 'nope' }).code, 'SKU_NOT_FOUND');
  const noContents = { version: 1, skus: [{ id: 'x', sku_code: 'X-1', label: '空', attributes: [], contents: [] }] };
  assert.equal(planOf('packing_list', { skuProfile: noContents, skuId: 'x' }).code, 'CONTENT_MISSING');
  const noSize = { version: 1, skus: [{ id: 'x', sku_code: 'X-1', label: '空', attributes: [{ key: '长', value: '30' }], contents: [] }] };
  const sizeMissing = planOf('size', { skuProfile: noSize, skuId: 'x' });
  assert.equal(sizeMissing.code, 'SIZE_FACTS_MISSING');
  assert.match(sizeMissing.missing[0], /缺单位/);
  assert.equal(planOf('size', { skuProfile: { version: 1, skus: [{ id: 'x', sku_code: 'X-1', label: '空', attributes: [{ key: '颜色', value: '白' }], contents: [] }] }, skuId: 'x' }).code, 'SIZE_FACTS_MISSING');
  assert.equal(planOf('sku_compare').code, 'PEER_SKU_REQUIRED');
  assert.equal(planOf('sku_compare', { peerSkuId: 'sku_e06_a' }).code, 'PEER_SKU_INVALID');
  assert.equal(planOf('sku_compare', { peerSkuCode: 'E06-01' }).code, 'PEER_SKU_INVALID');
  assert.equal(planOf('sku_compare', { peerSkuId: 'ghost' }).code, 'PEER_SKU_NOT_FOUND');
  const emptyCompare = { version: 1, skus: [
    { id: 'a', sku_code: 'A-1', label: 'A', attributes: [], contents: [] },
    { id: 'b', sku_code: 'B-1', label: 'B', attributes: [], contents: [] },
  ] };
  assert.equal(planOf('sku_compare', { skuProfile: emptyCompare, skuId: 'a', peerSkuId: 'b' }).code, 'COMPARE_EMPTY');
  // 档案重写换了内部 ID 时，可用商家编号回落定位同一 SKU
  assert.equal(buildExplainerPlan({ kind: 'packing_list', skuProfile: PROFILE, skuCode: 'E06-01' }).ok, true);
});

test('E06 纯函数编辑守卫：只改文案，不改事实值；承诺词拒绝', () => {
  const plan = planOf('packing_list');
  const titled = applyExplainerEdits({ plan, edits: { title: '标准装 · 收到什么' } });
  assert.deepEqual(titled.issues, []);
  assert.equal(titled.changed, true);
  assert.equal(titled.plan.title, '标准装 · 收到什么');
  assert.notEqual(titled.plan.plan_hash, plan.plan_hash, '改文案应产生新的计划指纹');
  assert.deepEqual(titled.plan.rows, plan.rows, '行内容必须保持原样');

  const quantity = applyExplainerEdits({ plan, edits: { rows: [{ label: '瓶装', value: '99 瓶' }] } });
  assert.equal(quantity.issues[0].code, 'FACT_VALUE_IMMUTABLE');
  const rename = applyExplainerEdits({ plan, edits: { item: '赠品' } });
  assert.equal(rename.issues[0].code, 'FACT_VALUE_IMMUTABLE');

  const claim = applyExplainerEdits({ plan, edits: { subtitle: '适合所有肤质' } });
  assert.equal(claim.issues[0].code, 'CLAIM_NOT_ALLOWED');
  assert.ok(CLAIM_BLOCKLIST.includes('适合'));

  const tooLong = applyExplainerEdits({ plan, edits: { title: 'x'.repeat(41) } });
  assert.equal(tooLong.issues[0].code, 'INVALID_FIELD');
  assert.equal(applyExplainerEdits({ plan, edits: { title: plan.title } }).changed, false);
});

test('E06 纯函数 audit：逐行核对快照；档案与确认事实矛盾直接阻断', () => {
  const plan = planOf('size');
  assert.equal(auditExplainerPlan(plan, { truth: TRUTH }).ok, true);
  const tampered = structuredClone(plan);
  tampered.rows[0].value = '32 cm';
  const audit = auditExplainerPlan(tampered, { truth: TRUTH });
  assert.equal(audit.ok, false);
  assert.equal(audit.mismatches[0].field, 'value');
  // 档案写 30cm、确认事实写 32cm：不能选一边照排
  const conflict = auditExplainerPlan(plan, { truth: { version: 5, facts: [{ key: '长', value: '32', unit: 'cm' }] } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.mismatches[0].field, 'truth_conflict');
  const claimed = structuredClone(plan);
  claimed.title = '通用尺寸说明';
  const claimAudit = auditExplainerPlan(claimed);
  assert.equal(claimAudit.claims.ok, false);
  assert.equal(claimAudit.ok, false);
  assert.equal(auditExplainerPlan(null).ok, false);
});

test('E06 纯函数 过期判定/依赖条目/确定性渲染/present 与校验', () => {
  const plan = planOf('size');
  const version = { plan };
  assert.deepEqual(explainerStale({ version, skuProfile: PROFILE, truth: TRUTH }), { stale: false, reasons: [] });
  const staleSku = explainerStale({ version, skuProfile: { ...PROFILE, version: 4 }, truth: TRUTH });
  assert.equal(staleSku.reasons[0].code, 'SKU_PROFILE_CHANGED');
  const staleTruth = explainerStale({ version, skuProfile: PROFILE, truth: { ...TRUTH, version: 5 } });
  assert.equal(staleTruth.reasons[0].code, 'TRUTH_CHANGED');

  const entries = dependencyEntriesFor({ plan, truth: TRUTH, basePhoto: { type: 'asset', asset_id: 'asset_1' } });
  assert.ok(entries.some(entry => entry.kind === 'sku' && entry.ref === 'E06-01'));
  assert.ok(entries.some(entry => entry.kind === 'fact' && entry.ref === '长'), '尺寸行引用的确认事实要进依赖');
  assert.ok(entries.some(entry => entry.kind === 'asset' && entry.ref === 'asset_1'));

  const svg = renderExplainerSvg(plan);
  assert.equal(svg, renderExplainerSvg(plan), '同一计划必须得到同一张图（确定性排版）');
  assert.ok(svg.includes('30 cm'));
  assert.ok(svg.includes('不推断适配机型'), '尺寸图必须固定附上不推断声明');
  const injected = renderExplainerSvg({ ...plan, title: '<script>&"坏"' });
  assert.ok(injected.includes('&lt;script&gt;'));
  assert.ok(!injected.includes('<script>'));
  assert.equal(plan.canvas.width, EXPLAINER_CANVAS.width);

  const record = {
    id: 'ex_1', project_id: 'p1', kind: 'size', kind_label: '尺寸说明图',
    sku: { id: 'sku_e06_a', sku_code: 'E06-01', label: '标准装' }, peer_sku: null,
    versions: [{
      id: 'exv_1', number: 1, active: true, hash: 'h1', width: 1080, height: 1350,
      plan, checks: { audit: { ok: true } }, review: { decision: 'pending' }, created_at: '2026-01-01',
    }],
    created_at: '2026-01-01', updated_at: '2026-01-01',
  };
  assert.equal(presentExplainer({ record, skuProfile: PROFILE, truth: TRUTH }).status, 'awaiting_review');
  const confirmed = structuredClone(record);
  confirmed.versions[0].review = { decision: 'confirmed' };
  assert.equal(presentExplainer({ record: confirmed, skuProfile: PROFILE, truth: TRUTH }).status, 'active');
  const stale = structuredClone(confirmed);
  stale.versions[0].plan = { ...plan, sources: { ...plan.sources, truth_version: 1 } };
  assert.equal(presentExplainer({ record: stale, skuProfile: PROFILE, truth: TRUTH }).status, 'stale');
  assert.equal(presentExplainer({ record: confirmed, skuProfile: PROFILE, truth: TRUTH }).replacement_list[0].path,
    explainerPath({ kind: 'size', sku: { sku_code: 'E06-01' } }, { number: 1 }));
  assert.match(explainerPath({ kind: 'size', sku: { sku_code: 'E06/01' } }, { number: 2 }), /images\/explainers\/size\/E06-01-v2\.png$/);

  assert.throws(() => validateExplainerReview({ action: 'confirm', reason: '逐项看过' }, { checks: {} }), error => error.code === 'AUDIT_FAILED');
  assert.throws(() => validateExplainerReview({ action: 'confirm' }, record.versions[0]), error => error.code === 'INVALID_FIELD');
  assert.deepEqual(validateExplainerReview({ action: 'confirm', reason: '逐项核对过' }, record.versions[0]),
    { action: 'confirm', reason: '逐项核对过' });
  assert.throws(() => validateExplainerFeedback({ used: 'yes' }), error => error.code === 'INVALID_FIELD');
  const feedback = validateExplainerFeedback({ used: true, channel: '详情页' });
  assert.match(feedback.note, /不代表店铺曝光、点击或转化收益/);
});

// ---------- 集成脚手架 ----------

function createFixture() {
  let submitCount = 0;
  const calls = new Map();
  return {
    capabilities: () => ({ id: 'e06-fixture', version: '1', image: true, video: false,
      max_references: 6, supports_mask: false, supports_post_composite: true, supports_async: true,
      supports_revision: false, supports_cancel: true, max_side: 4096, formats: ['png', 'jpg'],
      simulated: true, acceptance: 'simulated_only' }),
    validate: () => ({ ok: true }),
    estimate: () => ({ estimated_credits: 1, max_credits: 1 }),
    submit(request) {
      submitCount += 1;
      calls.set(request.idempotency_key, { request, seed: submitCount });
      return { provider_job_id: request.idempotency_key, status: 'queued' };
    },
    poll(handle) {
      const entry = calls.get(handle.provider_job_id);
      const seed = entry?.seed ?? 0;
      const width = entry?.request?.target_width ?? 1024;
      const height = entry?.request?.target_height ?? 1024;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 3;
          rgb[index] = (x * 3 + y * 2 + seed * 17) % 256;
          rgb[index + 1] = (y * 5 + x + seed * 29) % 256;
          rgb[index + 2] = (x * 7 + y * 3 + seed * 53) % 256;
        }
      }
      const bytes = encodeRgbPng(width, height, rgb);
      return { status: 'succeeded', result: {
        provider: 'e06-fixture', model: 'fixture/image', model_version: '1',
        provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ cancelled: true }),
  };
}

async function setup(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e06-'));
  const app = createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 0,
    tickMs: 5, attemptTimeoutMs: 30_000, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

async function registerClient(port, { email, tenantName }) {
  let cookie = '';
  let csrf = '';
  const req = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie, 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const json = contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null;
    if (json?.csrf_token) csrf = json.csrf_token;
    return { status: response.status, json, buffer, contentType, headers: response.headers };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'E06Account2026!', display_name: 'E06', tenant_name: tenantName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return { req };
}

async function sharpImage(width = 1200, height = 1200) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#dde5dd' } })
    .composite([{ input: await sharp({ create: { width: 360, height: 540, channels: 3, background: '#335577' } }).png().toBuffer(), left: 420, top: 330 }])
    .png().toBuffer();
}

const E06_FACTS = [
  { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '长', value: '30', unit: 'cm', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
];

function skuPayload() {
  return {
    confirm: true,
    skus: [
      {
        sku_code: 'E06-01', label: '标准装', confirmed: true,
        attributes: [
          { key: '容量', value: '50', unit: 'g' },
          { key: '长', value: '30', unit: 'cm' },
          { key: '宽', value: '20', unit: 'cm' },
          { key: '高', value: '10', unit: 'cm' },
          { key: '核心卖点', value: '舒缓维稳' },
        ],
        contents: [
          { item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' },
          { item: '礼盒', quantity: 1, unit: '个', included: false, source: 'user_input' },
        ],
      },
      {
        sku_code: 'E06-02', label: '双支装', confirmed: true,
        attributes: [
          { key: '容量', value: '100', unit: 'g' },
          { key: '长', value: '30', unit: 'cm' },
          { key: '宽', value: '20', unit: 'cm' },
          { key: '高', value: '10', unit: 'cm' },
        ],
        contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
      },
    ],
  };
}

/** 建项目 → 素材（主体 + 风格）→ SKU 档案 → 事实。 */
async function createProject(req, key = 'E06') {
  const created = await req('/api/projects', {
    method: 'POST',
    body: { name: 'E06 面霜', sku: 'E06-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;

  const subject = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: await sharpImage(), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(subject.status, 201, JSON.stringify(subject.json));
  const style = await req(`/api/projects/${projectId}/assets?role=style&filename=style.png`, {
    method: 'POST', body: await sharpImage(600, 600), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(style.status, 201, JSON.stringify(style.json));

  const profile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT', body: { base_version: 0, ...skuPayload() },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.json));
  const skuIds = Object.fromEntries(profile.json.sku_profile.skus.map(item => [item.sku_code, item.id]));

  const truth = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: { base_version: 0, confirm: true, facts: E06_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  return { projectId, skuIds, subjectAssetId: subject.json.asset.id, styleAssetId: style.json.asset.id, key };
}

async function waitRun(req, runId, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const run = (await req(`/api/runs/${runId}`)).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() - started > timeoutMs) throw new Error(`任务未进入终态，最后状态 ${run?.status}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function reviewToPublishable(req, reportId) {
  const report = (await req(`/api/quality-reports/${reportId}`)).json.report;
  if (!report || report.decision === 'publishable') return report;
  const decisions = (report.checks ?? [])
    .filter(item => item.required && item.status === 'unknown' && item.adjudicable)
    .map(item => ({ code: item.code, decision: 'pass', reason: 'E06 测试样本人工检查通过', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await req(`/api/quality-reports/${reportId}/reviews`, {
    method: 'POST', body: { decisions, note: '仅测试 fixture，不证明真实模型效果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  return reviewed.json.report;
}

async function publishAllVersions(req, runId) {
  const versions = (await req(`/api/runs/${runId}/versions`)).json.versions;
  for (const item of versions.filter(version => version.current)) await reviewToPublishable(req, item.report_id);
}

// ---------- 集成：说明图闭环 ----------

test('E06 集成：预览不落库、幂等/重复、复核选版、替换包、反馈与跨租户', async (t) => {
  const { port } = await setup(t);
  const owner = await registerClient(port, { email: 'e06-a@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'e06-b@example.test', tenantName: '乙店' });
  const { req } = owner;
  const { projectId, skuIds, subjectAssetId, styleAssetId } = await createProject(req);

  // 1. 预览：不落库、免费、无重复
  const preview = await req(`/api/projects/${projectId}/explainers/plan`, {
    method: 'POST', body: { kind: 'packing_list', sku_id: skuIds['E06-01'] },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.plan.ok, true);
  assert.equal(preview.json.plan.rows.length, 2);
  assert.equal(preview.json.audit.ok, true);
  assert.equal(preview.json.ready, true);
  assert.equal(preview.json.duplicate, null);
  assert.equal(preview.json.credit_cost, 0);
  assert.equal((await req(`/api/projects/${projectId}/explainers`)).json.summary.total, 0, '预览不得落库');

  // 2. 创建：缺幂等键 400；首建 201；重放 200；同排版不重复；force 才重做
  const noKey = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', body: { kind: 'packing_list', sku_id: skuIds['E06-01'] },
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.error, 'MISSING_IDEMPOTENCY_KEY');

  const created = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-packing-1' },
    body: { kind: 'packing_list', sku_id: skuIds['E06-01'] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const explainer = created.json.explainer;
  assert.equal(explainer.kind, 'packing_list');
  assert.equal(explainer.status, 'awaiting_review');
  assert.equal(explainer.active_version.number, 1);
  assert.equal(explainer.active_version.width, EXPLAINER_CANVAS.width);

  const replay = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-packing-1' },
    body: { kind: 'packing_list', sku_id: skuIds['E06-01'] },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.explainer.id, explainer.id);

  const duplicate = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-packing-2' },
    body: { kind: 'packing_list', sku_id: skuIds['E06-01'] },
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.explainer.active_version.number, 1, '已有同排版时不重复制作');
  assert.match(duplicate.json.message, /force/);

  const forced = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-packing-3' },
    body: { kind: 'packing_list', sku_id: skuIds['E06-01'], force: true },
  });
  assert.equal(forced.status, 201, JSON.stringify(forced.json));
  assert.equal(forced.json.explainer.active_version.number, 2);

  // 3. 内容下载：PNG 签名 + 哈希头一致
  const content = await req(`/api/explainers/${explainer.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.contentType, 'image/png');
  assert.equal(content.buffer.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(content.headers.get('x-content-sha256'), forced.json.explainer.active_version.hash);

  // 4. 复核闸口：拒绝必须留依据；确认后状态 active
  const noReason = await req(`/api/explainers/${explainer.id}/review`, { method: 'POST', body: { action: 'confirm' } });
  assert.equal(noReason.status, 422);
  const rejected = await req(`/api/explainers/${explainer.id}/review`, {
    method: 'POST', body: { action: 'reject', reason: '文案再收敛一点' },
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
  const confirmedV2 = await req(`/api/explainers/${explainer.id}/review`, {
    method: 'POST', body: { action: 'confirm', reason: '逐项核对数量与单位一致' },
  });
  assert.equal(confirmedV2.status, 200, JSON.stringify(confirmedV2.json));
  assert.equal(confirmedV2.json.explainer.status, 'active');

  // 5. 选版：未复核版本不能选；旧版确认后可切换
  const v1 = forced.json.explainer.versions.find(item => item.number === 1);
  const notReviewed = await req(`/api/explainers/${explainer.id}/select`, {
    method: 'POST', body: { version_id: v1.id },
  });
  assert.equal(notReviewed.status, 409);
  assert.equal(notReviewed.json.error, 'REVIEW_REQUIRED');
  await req(`/api/explainers/${explainer.id}/review`, {
    method: 'POST', body: { action: 'confirm', reason: '补复核旧版', version_id: v1.id },
  });
  const selected = await req(`/api/explainers/${explainer.id}/select`, {
    method: 'POST', body: { version_id: v1.id },
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.json));
  assert.equal(selected.json.explainer.active_version.number, 1);
  assert.equal((await req(`/api/explainers/${explainer.id}/select`, {
    method: 'POST', body: { version_id: 'exv_missing' },
  })).status, 404);

  // 6. 替换包：先复核再导出；zip 含清单；可下载
  const packaged = await req(`/api/explainers/${explainer.id}/package`, { method: 'POST', body: {} });
  assert.equal(packaged.status, 201, JSON.stringify(packaged.json));
  assert.match(packaged.json.filename, /^qtb-explainer-.*-v1\.zip$/);
  assert.equal(packaged.json.replace_list[0].path, explainerPath({ kind: 'packing_list', sku: { sku_code: 'E06-01' } }, { number: 1 }));
  assert.match(packaged.json.replace_list[0].note, /不会自动同步平台/);
  const download = await req(`/api/exports/${packaged.json.export_id}/download`);
  assert.equal(download.status, 200);
  assert.equal(download.buffer.slice(0, 2).toString('latin1'), 'PK');
  assert.ok(download.buffer.toString('latin1').includes('explainer-manifest.json'), '包内应有替换清单');

  // 7. 采用反馈：布尔校验；note 明确不代表转化
  assert.equal((await req(`/api/explainers/${explainer.id}/feedback`, {
    method: 'POST', body: { used: 'yes' },
  })).status, 422);
  const feedback = await req(`/api/explainers/${explainer.id}/feedback`, {
    method: 'POST', body: { used: true, channel: '天猫详情页', reason: '已替换主图下方说明' },
  });
  assert.equal(feedback.status, 201, JSON.stringify(feedback.json));
  assert.equal(feedback.json.explainer.adoption.length, 1);
  assert.match(feedback.json.feedback.note, /不代表店铺曝光、点击或转化收益/);

  // 8. 改版：只许文案；改事实值 422；承诺词 422；无变化 409；成功生成新版本
  const activeV1 = selected.json.explainer.active_version;
  const immutable = await req(`/api/explainers/${explainer.id}/edits`, {
    method: 'POST', body: { base_version_id: activeV1.id, edits: { rows: [] } },
  });
  assert.equal(immutable.status, 422);
  assert.equal(immutable.json.error, 'FACT_VALUE_IMMUTABLE');
  const claim = await req(`/api/explainers/${explainer.id}/edits`, {
    method: 'POST', body: { base_version_id: activeV1.id, edits: { title: '适合所有肤质' } },
  });
  assert.equal(claim.status, 422);
  assert.equal(claim.json.error, 'CLAIM_NOT_ALLOWED');
  const same = await req(`/api/explainers/${explainer.id}/edits`, {
    method: 'POST', body: { base_version_id: activeV1.id, edits: { title: activeV1.plan.title } },
  });
  assert.equal(same.status, 409);
  assert.equal(same.json.error, 'NO_CHANGES');
  const edited = await req(`/api/explainers/${explainer.id}/edits`, {
    method: 'POST', body: { base_version_id: activeV1.id, edits: { title: '标准装 · 收到的全部内容' } },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.number, 3);
  assert.equal(edited.json.explainer.status, 'awaiting_review', '新版本必须重新复核');

  // 9. require_photo：无底图只报价不生成，创建被拦并附报价
  const photoPreview = await req(`/api/projects/${projectId}/explainers/plan`, {
    method: 'POST', body: { kind: 'packing_list', sku_id: skuIds['E06-01'], require_photo: true },
  });
  assert.equal(photoPreview.json.needs_photo, true);
  assert.equal(photoPreview.json.photo_quote.estimated_credits, 1);
  const photoBlocked = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-photo-1' },
    body: { kind: 'packing_list', sku_id: skuIds['E06-01'], require_photo: true },
  });
  assert.equal(photoBlocked.status, 409);
  assert.equal(photoBlocked.json.error, 'PHOTO_SOURCE_REQUIRED');
  assert.equal(photoBlocked.json.details.quote.estimated_credits, 1);
  assert.equal(photoBlocked.json.details.quote.regenerate_count, 1);

  // 10. 素材底图：主体素材可复用；风格素材明确拒绝
  const sizeWithBase = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-size-1' },
    body: { kind: 'size', sku_id: skuIds['E06-01'], base_photo: { type: 'asset', asset_id: subjectAssetId } },
  });
  assert.equal(sizeWithBase.status, 201, JSON.stringify(sizeWithBase.json));
  assert.equal(sizeWithBase.json.explainer.active_version.base_photo.type, 'asset');
  assert.equal(sizeWithBase.json.explainer.active_version.plan.rows.length, 3);
  const styleBase = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-size-2' },
    body: { kind: 'size', sku_id: skuIds['E06-01'], base_photo: { type: 'asset', asset_id: styleAssetId } },
  });
  assert.equal(styleBase.status, 422);
  assert.equal(styleBase.json.error, 'BASE_PHOTO_INVALID');
  const badType = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-size-3' },
    body: { kind: 'size', sku_id: skuIds['E06-01'], base_photo: { type: 'url', url: 'https://example.test/x.png' } },
  });
  assert.equal(badType.status, 422);

  // 11. 对比图：缺对比 SKU / 自比 / 未知对比 SKU
  assert.equal((await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-cmp-1' }, body: { kind: 'sku_compare', sku_id: skuIds['E06-01'] },
  })).json.error, 'PEER_SKU_REQUIRED');
  assert.equal((await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-cmp-2' },
    body: { kind: 'sku_compare', sku_id: skuIds['E06-01'], peer_sku_id: skuIds['E06-01'] },
  })).json.error, 'PEER_SKU_INVALID');
  const compare = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-cmp-3' },
    body: { kind: 'sku_compare', sku_id: skuIds['E06-01'], peer_sku_id: skuIds['E06-02'] },
  });
  assert.equal(compare.status, 201, JSON.stringify(compare.json));
  const capacityRow = compare.json.explainer.active_version.plan.rows.find(row => row.label === '容量');
  assert.equal(capacityRow.diff, true);

  // 12. 跨租户：详情/列表/预览/改版/内容/下载 一律 404
  assert.equal((await outsider.req(`/api/explainers/${explainer.id}`)).status, 404);
  assert.equal((await outsider.req(`/api/explainers/${explainer.id}/content`)).status, 404);
  assert.equal((await outsider.req(`/api/projects/${projectId}/explainers`)).status, 404);
  assert.equal((await outsider.req(`/api/projects/${projectId}/explainers/plan`, {
    method: 'POST', body: { kind: 'packing_list', sku_id: skuIds['E06-01'] },
  })).status, 404);
  assert.equal((await outsider.req(`/api/explainers/${explainer.id}/edits`, {
    method: 'POST', body: { base_version_id: activeV1.id, edits: { title: '偷改' } },
  })).status, 404);
  assert.equal((await outsider.req(`/api/exports/${packaged.json.export_id}/download`)).status, 404);
});

// ---------- 集成：底图权益 + E03 联动 ----------

test('E06 集成：未过闸口的版本不能当底图；已发布版本可继承；事实变化确定性重排', async (t) => {
  const { port } = await setup(t, { provider: createFixture() });
  const { req } = await registerClient(port, { email: 'e06-c@example.test', tenantName: '丙店' });
  const { projectId, skuIds, subjectAssetId } = await createProject(req);

  const kit = await req('/api/brand-kits', {
    method: 'POST',
    body: {
      name: 'E06 品牌套件', palette: { primary: '#2F6B4F', secondary: ['#F8FAFC'] },
      logo: { present: false },
      fonts: [{ name: '思源黑体', license: 'licensed', license_ref: 'LIC-E06' }],
      tone: '克制、可信', banned_expressions: [],
    },
  });
  assert.equal(kit.status, 201, JSON.stringify(kit.json));
  const preview0 = await req(`/api/projects/${projectId}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id },
  });
  assert.equal(preview0.status, 200, JSON.stringify(preview0.json));
  const resolutions = {};
  for (const conflict of [...preview0.json.payload.conflicts.pending, ...preview0.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await req(`/api/projects/${projectId}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id, conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  const quote = await req('/api/quotes', { method: 'POST', body: { project_id: projectId } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const run = await req('/api/runs', {
    method: 'POST', body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
    headers: { 'Idempotency-Key': 'e06-run-1' },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  const finished = await waitRun(req, run.json.run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 400));

  const versions = (await req(`/api/runs/${run.json.run.id}/versions`)).json.versions;
  const target = versions.find(item => item.current);
  assert.ok(target, '任务应有当前版本');
  const basePhoto = { type: 'version', run_id: run.json.run.id, deliverable_id: target.deliverable_id, version_id: target.id };

  // 未复核/未发布：版本未过导出闸口，不能免费拿来当说明图底图
  const denied = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-ent-1' },
    body: { kind: 'size', sku_id: skuIds['E06-01'], base_photo: basePhoto },
  });
  assert.equal(denied.status, 422, JSON.stringify(denied.json));
  assert.equal(denied.json.error, 'SOURCE_NOT_ENTITLED');

  // 商家素材底图不依赖任何计费版本：事实变化时可以免费确定性重排
  const assetBased = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-ent-asset' },
    body: { kind: 'size', sku_id: skuIds['E06-02'], base_photo: { type: 'asset', asset_id: subjectAssetId } },
  });
  assert.equal(assetBased.status, 201, JSON.stringify(assetBased.json));
  const assetExplainerId = assetBased.json.explainer.id;
  const assetVersion1 = assetBased.json.explainer.active_version;
  const assetConfirmed = await req(`/api/explainers/${assetExplainerId}/review`, {
    method: 'POST', body: { action: 'confirm', reason: '尺寸与档案逐项一致' },
  });
  assert.equal(assetConfirmed.status, 200, JSON.stringify(assetConfirmed.json));

  await publishAllVersions(req, run.json.run.id);

  const entitled = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-ent-2' },
    body: { kind: 'size', sku_id: skuIds['E06-01'], base_photo: basePhoto },
  });
  assert.equal(entitled.status, 201, JSON.stringify(entitled.json));
  const explainerId = entitled.json.explainer.id;
  assert.equal(entitled.json.explainer.active_version.base_photo.type, 'version');
  assert.equal(entitled.json.explainer.active_version.base_photo.version_id, target.id);

  const confirmed = await req(`/api/explainers/${explainerId}/review`, {
    method: 'POST', body: { action: 'confirm', reason: '尺寸与档案逐项一致' },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  // E03：只改「长」这一条确认事实（SKU 档案不动）→ 变更单应找到这张说明图并免费重排
  const changedFacts = E06_FACTS.map(fact => (fact.key === '长' ? { ...fact, value: '32' } : fact));
  const impact = await req(`/api/projects/${projectId}/changes/preview`, {
    method: 'POST', body: { facts: changedFacts },
  });
  assert.equal(impact.status, 200, JSON.stringify(impact.json));
  const explainerItems = impact.json.impact_items.filter(entry => entry.source === 'explainer');
  assert.equal(explainerItems.length, 2, '两张尺寸图都应被事实变化找到');
  const versionItem = explainerItems.find(entry => entry.explainer_id === explainerId);
  const assetItem = explainerItems.find(entry => entry.explainer_id === assetExplainerId);
  assert.ok(versionItem && assetItem, JSON.stringify(explainerItems));
  assert.equal(versionItem.action, 'text_recompose');
  assert.ok(versionItem.matched.includes('fact:长'));
  assert.equal(assetItem.action, 'text_recompose');
  assert.equal(impact.json.quote.estimated_credits, 0, '说明图重排不消耗生图额度');

  const change = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e06-change-1' },
    body: { base_truth_version: 1, facts: changedFacts },
  });
  assert.equal(change.status, 201, JSON.stringify(change.json));
  const executed = await req(`/api/changes/${change.json.change.id}/execute`, { method: 'POST', body: {} });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  const executedItems = executed.json.change.impact_items.filter(entry => entry.source === 'explainer');
  const assetDone = executedItems.find(entry => entry.explainer_id === assetExplainerId);
  const versionFailed = executedItems.find(entry => entry.explainer_id === explainerId);
  assert.equal(assetDone.status, 'done', JSON.stringify(assetDone));
  assert.ok(assetDone.result_version_id, '素材底图的说明图应重排出新版本');
  // 成品底图绑定旧事实，事实一变即失效：不能再免费复用
  assert.equal(versionFailed.status, 'failed', JSON.stringify(versionFailed));
  assert.equal(versionFailed.error_code, 'SOURCE_NOT_ENTITLED');
  assert.equal(executed.json.change.status, 'partial_failed');

  const afterAsset = await req(`/api/explainers/${assetExplainerId}`);
  assert.equal(afterAsset.status, 200, JSON.stringify(afterAsset.json));
  const activeAsset = afterAsset.json.explainer.active_version;
  assert.equal(activeAsset.number, 2);
  assert.equal(activeAsset.plan.rows.find(row => row.label === '长').value, '32 cm', '重排后应反映最新确认事实');
  assert.equal(afterAsset.json.explainer.stale, false);
  assert.equal(afterAsset.json.explainer.replacement_list[0].previous_sha256, assetVersion1.hash);
  assert.equal(afterAsset.json.explainer.status, 'awaiting_review', '重排后仍需人工复核');

  const afterVersion = await req(`/api/explainers/${explainerId}`);
  assert.equal(afterVersion.json.explainer.stale, true, '底图与版本未变，但事实已更新，应标为过期');
  assert.equal(afterVersion.json.explainer.stale_reasons[0].code, 'TRUTH_CHANGED');

  // 未复核前不允许导出，避免自动放行
  const blocked = await req(`/api/explainers/${assetExplainerId}/package`, { method: 'POST', body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'REVIEW_REQUIRED');
});
