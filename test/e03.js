/**
 * E03 测试：商品变更更新助手完整流程。
 *
 * 覆盖：
 * 1. 纯函数：diffTruth 逐字段差异、classifyImpact 分类、quoteChange 预算、deriveChangeStatus 整单状态
 *    （含 awaiting_material / awaiting_review：跳过≠完成）、computeImpactList 无依赖记录进 needs_review；
 * 2. 预览不落库、不触发生成；无差异确认 409；
 * 3. 确认：缺幂等键 400、非法 base 422、合法但过期 base 409（旧单不覆盖新 head）、
 *    同一事务建事实版本+变更单、幂等重放返回同一单；
 * 4. 文字变更走免费重合成：账本零流水；数量类变化 visual_check=required，未确认前整单不 completed；
 * 5. 视觉核对确认（带 reason）后整单 completed；completed 单拒绝重试；
 * 6. 部分失败：重生成子任务失败（fixture 按提交上下文精准命中子任务）→ partial_failed 且成功项保留、
 *    预留释放；重试用 :rN 新幂等键成功，账本断言两次预留、一次释放、一次捕获（不重复扣费）；
 *    重生成按变更单新事实版本冻结 spec，产物依赖指向新事实版本；
 * 7. 换包装素材 → needs_new_photo：执行跳过附原因，整单 awaiting_material（不是 completed）；
 *    硬阻断（无素材不能覆盖为重生成）→ 补拍素材登记 → 以新素材为底图重合成续做到 completed；
 * 8. 执行闸口：重生成必须报价确认（缺 409 / 过期 409 / 余额不足 402，均不预留不扣费）；
 * 9. 取消：确认后取消幂等；运行中取消一并取消子任务并释放预留；
 * 10. 并发认领互斥（同单一 execute 只成功一次）；中断恢复（running 无子任务 → EXECUTION_INTERRUPTED）可重试；
 * 11. needs_review 覆盖必须有确切依据（422），skip 不需要；
 * 12. 替换待办：按旧版本匹配历史导出生成（带渠道标签），confirm 只记「商家确认已替换」；
 * 13. 跨租户 404。
 * 运行：node --test test/e03.js（Node 22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  classifyImpact, computeImpactList, deriveChangeStatus, diffIsEmpty, diffTruth, quoteChange,
} from '../src/change.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 纯函数 ----------

test('E03 纯函数：diffTruth 按 key 对齐事实差异 + 类目/关键文字/素材变化', () => {
  const oldTruth = {
    sku: 'A-01', category: '面霜',
    facts: [
      { key: '容量', value: '50', unit: 'g' },
      { key: '卖点', value: '舒缓', unit: null },
      { key: '旧字段', value: 'x', unit: null },
    ],
    critical_text: [{ text: '月光舒缓' }],
  };
  const diff = diffTruth(oldTruth, {
    category: '乳液',
    facts: [
      { key: '容量', value: '70', unit: 'g' },       // 值变化
      { key: '卖点', value: '舒缓', unit: null },       // 不变
      { key: '产地', value: '上海', unit: null },       // 新增
    ],
    critical_text: [{ text: '新包装文案' }],
    changed_asset_ids: ['asset_p1', 'asset_p1'],
    brand_kit_changed: true,
  });
  const byKey = Object.fromEntries(diff.facts.map(item => [item.key, item]));
  assert.equal(byKey['容量'].change, 'changed');
  assert.deepEqual(byKey['容量'].from, { value: '50', unit: 'g' });
  assert.deepEqual(byKey['容量'].to, { value: '70', unit: 'g' });
  assert.equal(byKey['产地'].change, 'added');
  assert.equal(byKey['旧字段'].change, 'removed');
  assert.equal(byKey['卖点'], undefined, '无变化不进差异');
  assert.deepEqual(diff.category, { from: '面霜', to: '乳液' });
  assert.equal(diff.sku, null, 'SKU 不变（校验层强制等于项目 SKU）');
  assert.deepEqual(diff.critical_text.to, ['新包装文案']);
  assert.deepEqual(diff.changed_asset_ids, ['asset_p1'], '素材 id 去重');
  assert.equal(diff.brand_kit_changed, true);
  assert.equal(diffIsEmpty(diff), false);
  assert.equal(diffIsEmpty(diffTruth(oldTruth, {
    category: '面霜',
    facts: oldTruth.facts,
    critical_text: oldTruth.critical_text,
  })), true, '完全一致时差异为空');
});

test('E03 纯函数：classifyImpact 分类规则（文案/数量/关键文字/素材/证据不足/无匹配）', () => {
  const diff = {
    facts: [
      { key: '容量', change: 'changed', from: { value: '50', unit: 'g' }, to: { value: '70', unit: 'g' } },
      { key: '瓶装数量', change: 'changed', from: { value: '1', unit: '瓶' }, to: { value: '2', unit: '瓶' } },
      { key: '旧字段', change: 'removed', from: { value: 'x', unit: null }, to: null },
    ],
    category: null, sku: null,
    critical_text: { from: ['旧'], to: ['新'] },
    changed_asset_ids: ['asset_pack'],
    brand_kit_changed: true,
  };
  // 文案类 fact → text_recompose 免费
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'fact', ref: '容量', evidence: 'deterministic' } }).action, 'text_recompose');
  // 数量类 fact → text_recompose + visual_check=required
  const quantity = classifyImpact({ diff, dependencyEntry: { kind: 'fact', ref: '瓶装数量', evidence: 'deterministic' } });
  assert.equal(quantity.action, 'text_recompose');
  assert.equal(quantity.visual_check, 'required');
  // removed fact → needs_review
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'fact', ref: '旧字段', evidence: 'deterministic' } }).action, 'needs_review');
  // critical_text 变化 → needs_new_photo（包装关键文字等同实物变化）
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'fact', ref: 'critical_text', evidence: 'deterministic' } }).action, 'needs_new_photo');
  // ocr_candidate → needs_review
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'fact', ref: '容量', evidence: 'ocr_candidate' } }).action, 'needs_review');
  // 无 spec 快照 → needs_review
  assert.equal(classifyImpact({ diff, hasSpecSnapshot: false, dependencyEntry: { kind: 'fact', ref: '容量', evidence: 'deterministic' } }).action, 'needs_review');
  // 命中的更换素材 → needs_new_photo
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'asset', ref: 'asset_pack', evidence: 'deterministic' } }).action, 'needs_new_photo');
  // 品牌变化 → needs_review（不自动作用历史）
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'brand', ref: 'bk_1', evidence: 'deterministic' } }).action, 'needs_review');
  // SKU 命中 → needs_review
  assert.equal(classifyImpact({ diff, skuDiff: [{ sku_id: 'sku_1', change: 'changed' }], dependencyEntry: { kind: 'sku', ref: 'sku_1', evidence: 'deterministic' } }).action, 'needs_review');
  // 无匹配 → null（不进清单）
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'fact', ref: '无关字段', evidence: 'deterministic' } }), null);
  assert.equal(classifyImpact({ diff, dependencyEntry: { kind: 'asset', ref: 'asset_other', evidence: 'deterministic' } }), null);
});

test('E03 纯函数：quoteChange 只对 regenerate 计费；deriveChangeStatus 推导整单状态；unknown 进 needs_review', () => {
  const quote = quoteChange([
    { id: 'a', action: 'text_recompose' },
    { id: 'b', action: 'regenerate', run_id: 'r', deliverable_id: 'd' },
    { id: 'c', action: 'needs_new_photo' },
    { id: 'e', action: 'needs_review' },
  ], { priceOfItem: () => 1 });
  assert.equal(quote.estimated_credits, 1);
  assert.equal(quote.regenerate_count, 1);
  assert.equal(quote.recompose_count, 1);
  assert.equal(quote.new_photo_count, 1);
  assert.equal(quote.review_count, 1);

  assert.equal(deriveChangeStatus([{ status: 'running' }]).status, 'executing');
  assert.equal(deriveChangeStatus([{ status: 'done' }, { status: 'failed' }]).status, 'partial_failed');
  assert.equal(deriveChangeStatus([{ status: 'done', visual_check: 'required' }]).status, 'partial_failed',
    '数量视觉核对未确认前不允许 completed');
  assert.equal(deriveChangeStatus([{ status: 'done' }, { status: 'skipped' }]).status, 'completed');
  // 跳过≠完成：待补实拍 / 待人工核对的跳过项必须把整单留在 awaiting_*，商家主动跳过才不阻塞
  assert.equal(deriveChangeStatus([{ status: 'skipped', awaiting: 'material' }]).status, 'awaiting_material');
  assert.equal(deriveChangeStatus([{ status: 'done' }, { status: 'skipped', awaiting: 'review' }]).status, 'awaiting_review');
  assert.equal(deriveChangeStatus([{ status: 'done' }, { status: 'skipped', awaiting: 'user' }]).status, 'completed');
  // computeImpactList：无依赖记录的版本进 needs_review（unknown），不显示「无影响」
  const impact = computeImpactList(
    {
      runs: {
        run_1: {
          id: 'run_1', tenant_id: 't', project_id: 'p', created_at: '2026-01-01',
          deliverables: [{ deliverable_id: 'd1', label: '主图' }],
          versions: [{ id: 'v1', deliverable_id: 'd1', active: true }],
          spec_ref: { version: 1 },
        },
      },
      image_dependencies: {},
    },
    { id: 'p', tenant_id: 't' },
    { facts: [{ key: '容量', change: 'changed', from: { value: '50', unit: 'g' }, to: { value: '70', unit: 'g' } }] },
    [],
  );
  assert.equal(impact.length, 1);
  assert.equal(impact[0].evidence, 'unknown');
  assert.equal(impact[0].action, 'needs_review');
});

// ---------- Provider fixture（与 m13 同型；失败/挂起在 poll 时按真实请求上下文动态判定） ----------

function createFixture() {
  let submitCount = 0;
  const calls = new Map();
  // 提交时只落存完整请求（含 run_id / scenario）；poll 时才按当前 control 判定失败/挂起。
  // 这样支持确定性的时序编排：先 holdIf 断言「执行响应返回时子任务仍在运行」，
  // 再改挂 failIf 让下一次轮询失败，互不干扰。
  const control = { failIf: null, holdIf: null };
  const provider = {
    capabilities: () => ({ id: 'e03-fixture', version: '1', image: true, video: false,
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
      const request = entry?.request;
      const seed = entry?.seed ?? 0;
      if (typeof control.failIf === 'function' && control.failIf(request) === true) {
        // 与 jobs 的失败约定一致：失败码/消息在顶层（嵌套 error 不会被读取）
        return { status: 'failed', code: 'FIXTURE_FAIL', message: 'fixture 模拟本次生成失败', retryable: false };
      }
      if (typeof control.holdIf === 'function' && control.holdIf(request) === true) {
        return { status: 'running' };
      }
      const width = request?.target_width ?? 1024;
      const height = request?.target_height ?? 1024;
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
        provider: 'e03-fixture', model: 'fixture/image', model_version: '1',
        provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ cancelled: true }),
  };
  provider.control = control;
  return provider;
}

/** OCR fixture：识别结果覆盖测试用关键文字，使文字检查可判 pass（仅测试，不证明真实 OCR 效果）。 */
const fixtureOcr = {
  recognize: async () => ({ status: 'ok', engine: 'fixture-ocr', lines: [{ text: '月光舒缓', confidence: 0.99 }] }),
};

/** 模拟支付 Provider：让 plan_taster_10 订单走 demo 结算到账（不产生真实收款）。 */
const demoPayment = {
  capabilities: () => ({ simulated: true, real_money: false, supports_refunds: false }),
};

/** 走订单流程给当前会话充值 10 点：体验额度（3 点）不够含可选交付物的报价时使用。 */
async function topUp(req) {
  const created = await req('/api/billing/orders', { method: 'POST', body: { plan_id: 'plan_taster_10' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const order = created.json.order;
  if (order.status === 'pending_demo_settlement') {
    const settled = await req(`/api/billing/orders/${order.id}/settle`, { method: 'POST' });
    assert.equal(settled.status, 200, JSON.stringify(settled.json));
  }
  return order;
}

// ---------- 会话脚手架 ----------

async function setup(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e03-'));
  const app = createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 0,
    tickMs: 5, attemptTimeoutMs: 30_000, ocr: fixtureOcr, ...options,
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
    return { status: response.status, json, buffer, contentType };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'E03Account2026!', display_name: 'E03', tenant_name: tenantName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return { req };
}

async function sharpImage(width = 1200, height = 1200) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#dde5dd' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 600, channels: 3, background: '#335577' } }).png().toBuffer(), left: 400, top: 300 }])
    .png().toBuffer();
}

const BASE_FACTS = [
  { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '瓶装数量', value: '1', unit: '瓶', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '成分', value: '积雪草提取物', critical: false, confirmed: true, source_type: 'user_input' },
];

/** 核心卖点 舒缓维稳→修护焕亮（文案类）+ 瓶装数量 1→2（数量类，需视觉核对）。 */
const NEW_FACTS = [
  { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '修护焕亮', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '瓶装数量', value: '2', unit: '瓶', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '成分', value: '积雪草提取物', critical: false, confirmed: true, source_type: 'user_input' },
];

/** 建项目 → 主体素材 → SKU 档案 → 事实 → 品牌套件 → 冻结 spec → 报价 → 任务。 */
async function startRun(req, key, { facts = BASE_FACTS, includeOptional = false } = {}) {
  const created = await req('/api/projects', {
    method: 'POST',
    body: { name: 'E03 面霜', sku: 'E03-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;

  const image = await sharpImage();
  const asset = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: image, headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));

  const profile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT',
    body: { base_version: 0, confirm: true, skus: [{ sku_code: 'E03-01', label: '标准装', confirmed: true }] },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.json));

  const truth = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: { base_version: 0, confirm: true, facts, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));

  const kit = await req('/api/brand-kits', {
    method: 'POST',
    body: {
      name: 'E03 品牌套件', palette: { primary: '#2F6B4F', secondary: ['#F8FAFC'] },
      logo: { present: false },
      fonts: [{ name: '思源黑体', license: 'licensed', license_ref: 'LIC-2026-01' }],
      tone: '克制、可信', banned_expressions: [],
    },
  });
  assert.equal(kit.status, 201, JSON.stringify(kit.json));

  const preview = await req(`/api/projects/${projectId}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await req(`/api/projects/${projectId}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id, conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));

  const quote = await req('/api/quotes', { method: 'POST', body: { project_id: projectId, include_optional: includeOptional } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const run = await req('/api/runs', {
    method: 'POST',
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
    headers: { 'Idempotency-Key': key },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  return { projectId, run: run.json.run, subjectAssetId: asset.json.asset.id };
}

async function waitTerminal(req, runId, timeoutMs = 60_000) {
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
    .map(item => ({ code: item.code, decision: 'pass', reason: 'E03 测试样本人工检查通过', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await req(`/api/quality-reports/${reportId}/reviews`, {
    method: 'POST', body: { decisions, note: '仅测试 fixture，不证明真实模型效果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  return reviewed.json.report;
}

async function publishAllVersions(req, runId) {
  const versions = (await req(`/api/runs/${runId}/versions`)).json.versions;
  for (const item of versions.filter(v => v.current)) await reviewToPublishable(req, item.report_id);
}

async function getBalance(req) {
  const result = await req('/api/credits');
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.balance.available;
}

/** 等待变更单到达终态（子任务结果在读取变更单时回写）。 */
async function waitChangeSettled(req, changeId, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const result = await req(`/api/changes/${changeId}`);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const change = result.json.change;
    if (['completed', 'partial_failed'].includes(change.status)) return change;
    if (Date.now() - started > timeoutMs) throw new Error(`变更单未收口，最后状态 ${change?.status}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * 逐项完成变更单的人工视觉核对并返回最终变更单。
 * 重合成质检 needs_review 的项（pending_adoption）在核对通过时一并选用新版本；
 * 数量类固有核对项只确认视觉结论。无待核对项时直接返回当前状态。
 */
async function passAllVisualChecks(req, changeId, { reason = '已人工核对画面与新事实一致' } = {}) {
  for (;;) {
    const result = await req(`/api/changes/${changeId}`);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const pending = result.json.change.impact_items
      .filter(item => item.status === 'done' && item.visual_check === 'required');
    if (pending.length === 0) return result.json.change;
    for (const item of pending) {
      const checked = await req(`/api/changes/${changeId}/items/${item.id}/visual-check`, {
        method: 'POST', body: { reason },
      });
      assert.equal(checked.status, 200, JSON.stringify(checked.json));
    }
  }
}

/**
 * 重生成质检 needs_review 的结果不自动选用（M13：未通过不能自动放行）：
 * 人工复核报告后，在源任务显式选用登记的新版本；已选用（publishable 自动选用）时幂等跳过。
 */
async function adoptRegenerationIfNeeded(req, sourceRunId, childRunId) {
  const source = (await req(`/api/runs/${sourceRunId}`)).json.run;
  const registration = (source.regenerations ?? []).find(item => item.run_id === childRunId);
  assert.ok(registration?.adopted_version_id, '重生成结果应已登记回源任务');
  const target = source.deliverables.find(item => item.deliverable_id === registration.deliverable_id);
  if (target?.active_version_id === registration.adopted_version_id) return;
  const activated = await req(`/api/runs/${sourceRunId}/versions/${registration.adopted_version_id}/activate`, { method: 'POST' });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));
}

/** 账本流水断言：按 job_id（run）统计 reserve/release/capture 次数。 */
async function ledgerOfRun(dir, tenantId, runId) {
  const raw = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
  const entries = Object.values(raw.credit_entries ?? {})
    .filter(item => item.tenant_id === tenantId && item.job_id === runId);
  return {
    reserve: entries.filter(item => item.type === 'reserve').length,
    release: entries.filter(item => item.type === 'release').length,
    capture: entries.filter(item => item.type === 'capture').length,
    entries,
  };
}

// ---------- 集成 ----------

test('E03 集成：预览/确认/执行/视觉核对/替换待办全链路', async (t) => {
  const { port } = await setup(t, { provider: createFixture() });
  const owner = await registerClient(port, { email: 'e03-a@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'e03-b@example.test', tenantName: '乙店' });
  const { req } = owner;
  const { projectId, run, subjectAssetId } = await startRun(req, 'e03-main');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 400));
  await publishAllVersions(req, run.id);

  // 导出一次（含渠道标签），供后续替换待办匹配
  const exported = await req(`/api/runs/${run.id}/exports`, { method: 'POST', body: { scope: 'complete' } });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const exportId = exported.json.export.id;
  const channels = await req(`/api/exports/${exportId}/channels`, { method: 'PUT', body: { labels: ['天猫'] } });
  assert.equal(channels.status, 200, JSON.stringify(channels.json));

  // 模板文字层只引用「核心卖点/成分」；「瓶装数量」靠商家人工关联进依赖（E02 manual 条目的设计用途），
  // 这样数量类变化才能命中卖点图版本并要求视觉核对
  const versions = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  const benefitVersion = versions.find(item => item.current && item.deliverable_id === 'benefit');
  assert.ok(benefitVersion, '卖点图应有当前版本');
  const manualLink = await req(`/api/runs/${run.id}/deliverables/${benefitVersion.deliverable_id}/dependencies`, {
    method: 'POST',
    body: { version_id: benefitVersion.id, reason: '商家确认卖点图上标注了瓶装数量', entries: [{ kind: 'fact', ref: '瓶装数量' }] },
  });
  assert.equal(manualLink.status, 201, JSON.stringify(manualLink.json));

  // 1. 预览：差异 + 影响清单 + 预算；不落库
  const preview = await req(`/api/projects/${projectId}/changes/preview`, {
    method: 'POST',
    body: { facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.base_truth_version, 1);
  assert.equal(preview.json.empty, false);
  assert.deepEqual(preview.json.diff.facts.map(item => item.key).sort(), ['核心卖点', '瓶装数量']);
  assert.ok(preview.json.impact_items.length > 0, '应有受影响的图片版本');
  const quantityPreview = preview.json.impact_items.find(item => (item.matched ?? []).includes('fact:瓶装数量'));
  assert.ok(quantityPreview, '数量变化应命中依赖瓶装数量的版本');
  assert.equal(quantityPreview.action, 'text_recompose');
  assert.equal(quantityPreview.visual_check, 'required', '数量类变化必须人工视觉核对');
  assert.equal(preview.json.quote.estimated_credits, 0, '默认无 regenerate 项，预算 0 额度');
  assert.equal((await req(`/api/projects/${projectId}/changes`)).json.total, 0, '预览不得落库');
  assert.equal((await req(`/api/projects/${projectId}/truth-versions`)).json.head_version, 1, '预览不得推进事实版本');

  // 2. 确认闸口：缺幂等键 400；非法 base（0）422；无差异 409；合法但过期 base 的 409 见「旧变更单不覆盖新 head」
  const noKey = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST', body: { base_truth_version: 1, facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.error, 'MISSING_IDEMPOTENCY_KEY');

  const stale = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-stale' },
    body: { base_truth_version: 0, facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(stale.status, 422, 'base_truth_version=0 是非法输入，必须先被参数校验拦下');
  assert.equal(stale.json.error, 'INVALID_FIELD');

  const noChange = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-nochange' },
    body: { base_truth_version: 1, facts: BASE_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(noChange.status, 409);
  assert.equal(noChange.json.error, 'NO_CHANGES');

  // 正常确认：同一事务内建事实 v2 + 变更单
  const confirmed = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-confirm-1' },
    body: { base_truth_version: 1, facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  const change = confirmed.json.change;
  assert.equal(change.status, 'confirmed');
  assert.equal(change.base_truth_version, 1);
  assert.equal(change.new_truth_version, 2, '同一事务内应已创建事实 v2');
  assert.ok(change.confirmed_at);
  assert.ok(change.impact_items.length > 0);
  assert.equal((await req(`/api/projects/${projectId}/truth-versions`)).json.head_version, 2);

  // 幂等重放：同键同体返回同一单；同键不同体 409
  const replay = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-confirm-1' },
    body: { base_truth_version: 1, facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.change.id, change.id);
  assert.equal((await req(`/api/projects/${projectId}/truth-versions`)).json.head_version, 2, '重放不得再建版本');
  const conflict = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-confirm-1' },
    body: { base_truth_version: 1, facts: BASE_FACTS, critical_text: [] },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'IDEMPOTENCY_KEY_CONFLICT');

  // 跨租户：读变更单 / 列他人项目变更 / 确认他人替换待办 一律 404
  assert.equal((await outsider.req(`/api/changes/${change.id}`)).status, 404);
  assert.equal((await outsider.req(`/api/projects/${projectId}/changes`)).status, 404);
  assert.equal((await outsider.req(`/api/projects/${projectId}/changes/preview`, {
    method: 'POST', body: { facts: NEW_FACTS },
  })).status, 404);

  // 3. 执行：文字重合成免费（账本零流水）；数量项 done 但视觉核对待确认 → 整单不 completed
  const beforeBalance = await getBalance(req);
  const executed = await req(`/api/changes/${change.id}/execute`, { method: 'POST', body: {} });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  let current = executed.json.change;
  const recomposeItems = current.impact_items.filter(item => item.action === 'text_recompose');
  assert.ok(recomposeItems.length > 0);
  for (const item of recomposeItems) {
    assert.equal(item.status, 'done', JSON.stringify(item));
    assert.ok(item.result_version_id, '重合成应产生新版本');
  }
  assert.equal(await getBalance(req), beforeBalance, '文字重合成免费，不得产生额度流水');
  assert.equal(current.status, 'partial_failed', '数量视觉核对未确认前整单不允许 completed');
  assert.ok(current.counts.pending_visual_checks > 0);

  // 替换待办：完成项的旧版本在导出 included 中 → 生成待办，带渠道标签快照
  const todos = await req(`/api/replacement-todos?project_id=${projectId}`);
  assert.equal(todos.status, 200, JSON.stringify(todos.json));
  assert.ok(todos.json.replacement_todos.length > 0, '完成项的旧版本出现在历史导出中，应生成替换待办');
  const todo = todos.json.replacement_todos[0];
  assert.equal(todo.status, 'pending');
  assert.equal(todo.export_id, exportId);
  assert.deepEqual(todo.channel_labels, ['天猫']);
  assert.ok(todo.old_version_id && todo.new_version_id && todo.old_version_id !== todo.new_version_id);

  // 4. 视觉核对：缺 reason 422；全部核对通过后整单 completed。
  // 重合成质检 needs_review 的项（如 jpg 有损编码下主体像素核对需人工裁决）：
  // 该项 done 但 visual_check=required 且 pending_adoption，核对通过时一并选用新版本。
  const pendingVisual = current.impact_items.find(item => item.status === 'done' && item.visual_check === 'required');
  assert.ok(pendingVisual);
  const checkNoReason = await req(`/api/changes/${change.id}/items/${pendingVisual.id}/visual-check`, {
    method: 'POST', body: {},
  });
  assert.equal(checkNoReason.status, 422);
  current = await passAllVisualChecks(req, change.id, { reason: '已核对画面数量表达为 2 瓶，与新事实一致' });
  assert.equal(current.status, 'completed', JSON.stringify(current.counts));
  assert.equal(current.counts.pending_visual_checks, 0);
  for (const item of current.impact_items.filter(entry => entry.action === 'text_recompose')) {
    assert.equal(item.visual_check, 'passed', JSON.stringify(item));
    assert.ok(item.visual_check_by && item.visual_check_at);
    assert.equal(item.pending_adoption ?? false, false, '核对通过后不再有待选用标记');
  }
  // 核对通过即选用：重合成产生的新版本已成为对应交付物的当前选用版本
  const versionsAfter = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  for (const item of current.impact_items.filter(entry => entry.result_version_id)) {
    const adopted = versionsAfter.find(entry => entry.id === item.result_version_id);
    assert.ok(adopted?.current, `重合成新版本 ${item.result_version_id} 应已选用`);
  }

  // completed 单不允许重试
  const earlyRetry = await req(`/api/changes/${change.id}/retry`, { method: 'POST', body: {} });
  assert.equal(earlyRetry.status, 409);
  assert.equal(earlyRetry.json.error, 'CHANGE_NOT_RETRYABLE');

  // 5. 替换待办确认：只记商家确认已替换，重复确认幂等；跨租户 404
  const confirmTodo = await req(`/api/replacement-todos/${todo.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(confirmTodo.status, 200, JSON.stringify(confirmTodo.json));
  assert.equal(confirmTodo.json.replacement_todo.status, 'replaced');
  assert.ok(confirmTodo.json.replacement_todo.confirmed_by && confirmTodo.json.replacement_todo.confirmed_at);
  const confirmAgain = await req(`/api/replacement-todos/${todo.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(confirmAgain.status, 200);
  assert.equal(confirmAgain.json.replacement_todo.status, 'replaced');
  assert.equal((await outsider.req(`/api/replacement-todos/${todo.id}/confirm`, { method: 'POST', body: {} })).status, 404);

  assert.ok(subjectAssetId, '素材上下文完整（供换包装用例对照）');
});

test('E03 集成：重生成失败 → 部分失败保留成功项 → 重试成功且不重复扣费（账本断言）', async (t) => {
  // 失败注入按真实提交上下文判定：主任务 run_id 之外的提交（即变更单重生成子任务）失败
  const provider = createFixture();
  // 含可选交付物（细节图）报价 4 点，体验额度只有 3 点 → 注入 demo 支付并充值
  const { port, dir } = await setup(t, { provider, paymentProvider: demoPayment });
  const { req } = await registerClient(port, { email: 'e03-fail@example.test', tenantName: '丙店' });
  await topUp(req);
  const { projectId, run } = await startRun(req, 'e03-fail-main', { includeOptional: true });
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 400));
  await publishAllVersions(req, run.id);
  // 主任务已完成；先挂起变更子任务（run_id ≠ 主任务）的轮询，保证执行响应返回时子任务仍在运行
  provider.control.holdIf = request => request.run_id !== run.id;

  // 本次变更改核心卖点 + 成分（均为文案类）：卖点图与细节图各命中一项 text_recompose，
  // 便于验证「部分失败保留其余待处理项」
  const confirmed = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-fail-1' },
    body: {
      base_truth_version: 1,
      facts: [
        { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '修护焕亮', critical: false, confirmed: true, source_type: 'user_input' },
        { key: '瓶装数量', value: '1', unit: '瓶', critical: false, confirmed: true, source_type: 'user_input' },
        { key: '成分', value: '积雪草+神经酰胺', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  const change = confirmed.json.change;
  const regenItem = change.impact_items.find(item => item.action === 'text_recompose' && item.deliverable_id === 'benefit')
    ?? change.impact_items.find(item => item.action === 'text_recompose');
  assert.ok(regenItem, '应有文字重合成项供动作覆盖');
  assert.ok(change.impact_items.filter(item => item.action === 'text_recompose').length >= 2,
    '核心卖点与成分变化应分别命中卖点图与细节图');

  const balanceBefore = await getBalance(req);
  // 商家明确选定该项重生成（动作覆盖）；其余项本次不执行（item_ids 限定）。
  // 重生成扣费：必须先按服务端当前口径确认报价（quote_confirm）
  const executed = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: {
      item_ids: [regenItem.id],
      actions: { [regenItem.id]: 'regenerate' },
      quote_confirm: { price_version: 'finished-image.1', estimated_credits: 1 },
    },
  });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  const runningItem = executed.json.change.impact_items.find(item => item.id === regenItem.id);
  assert.equal(runningItem.status, 'running', '重生成项异步执行');
  assert.ok(runningItem.child_run_id);
  assert.equal(runningItem.charged_credits, 1, '单张成品 1 额度');
  assert.equal(await getBalance(req), balanceBefore - 1, '重生成预留 1 额度');

  // running 断言完成后改挂失败：poll 动态判定，下一次轮询子任务即失败
  provider.control.holdIf = null;
  provider.control.failIf = request => request.run_id !== run.id;

  // 子任务失败 → 预留释放 → 变更项 failed，整单 partial_failed，其余 pending 项保留
  const child = await waitTerminal(req, runningItem.child_run_id);
  assert.equal(child.status, 'failed', JSON.stringify(child).slice(0, 300));
  const settled1 = await waitChangeSettled(req, change.id);
  const failedItem = settled1.impact_items.find(item => item.id === regenItem.id);
  assert.equal(failedItem.status, 'failed');
  assert.equal(failedItem.error_code, 'REGENERATION_FAILED');
  assert.equal(settled1.status, 'partial_failed');
  assert.ok(settled1.counts.pending > 0, '未执行的项保留待处理');
  assert.equal(await getBalance(req), balanceBefore, '供应商技术失败不收费，预留已释放');
  const tenantId = (await req('/api/tenant')).json.tenant_id;
  const ledger1 = await ledgerOfRun(dir, tenantId, runningItem.child_run_id);
  assert.deepEqual([ledger1.reserve, ledger1.release, ledger1.capture], [1, 1, 0],
    '失败子任务：预留一次、释放一次、零捕获');

  // 重试：fixture 恢复成功；先挂起轮询保证 running 断言确定，:r1 新幂等键产生新预留
  provider.control.failIf = null;
  provider.control.holdIf = request => request.run_id !== run.id;
  const retried = await req(`/api/changes/${change.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  const retryItem = retried.json.change.impact_items.find(item => item.id === regenItem.id);
  assert.equal(retryItem.status, 'running');
  assert.equal(retryItem.retry_count, 1);
  assert.ok(retryItem.child_run_id !== runningItem.child_run_id, '重试应发起新的子任务');
  assert.equal(await getBalance(req), balanceBefore - 1, '重试重新预留 1 额度（旧预留已释放，不重复扣费）');
  provider.control.holdIf = null; // 放开轮询，让重试子任务正常跑完

  const child2 = await waitTerminal(req, retryItem.child_run_id);
  assert.equal(child2.status, 'completed', JSON.stringify(child2).slice(0, 300));
  // 新版本质检若仍待人工复核则放行（fixture OCR 覆盖关键文字，正常应直接 publishable）
  const child2Versions = (await req(`/api/runs/${retryItem.child_run_id}/versions`)).json.versions;
  for (const item of child2Versions) await reviewToPublishable(req, item.report_id);
  // 复核放行后在源任务选用重生成版本（needs_review 不自动选用），变更单据此收口为 done
  await adoptRegenerationIfNeeded(req, run.id, retryItem.child_run_id);
  const settled2 = await waitChangeSettled(req, change.id);
  const doneItem = settled2.impact_items.find(item => item.id === regenItem.id);
  assert.equal(doneItem.status, 'done', JSON.stringify(doneItem));
  assert.ok(doneItem.result_version_id && doneItem.result_version_id !== doneItem.version_id);
  assert.equal(await getBalance(req), balanceBefore - 1, '成功只捕获一次预留，不加收');
  const ledger2 = await ledgerOfRun(dir, tenantId, retryItem.child_run_id);
  assert.deepEqual([ledger2.reserve, ledger2.capture], [1, 1], '重试子任务：预留一次、捕获一次');

  // 新事实一致性：子任务必须按变更单冻结的新事实快照运行（不复用源任务旧 spec），
  // 产物版本的依赖记录指向变更单的新事实版本
  assert.ok(doneItem.spec_version, '重生成项应记录本次冻结的 spec 版本');
  const childRun = (await req(`/api/runs/${retryItem.child_run_id}`)).json.run;
  assert.equal(childRun.spec_ref?.version, doneItem.spec_version, '子任务必须使用变更单冻结的新 spec 快照');
  const childSpec = (await req(`/api/projects/${projectId}/specs/${doneItem.spec_version}`)).json;
  assert.equal(childSpec.spec?.product_truth?.version, change.new_truth_version,
    '变更重生成快照的事实来源必须是变更单的新事实版本');
  const deps = await req(`/api/runs/${run.id}/deliverables/${doneItem.deliverable_id}/dependencies`);
  assert.equal(deps.status, 200, JSON.stringify(deps.json));
  const newVersionDeps = deps.json.versions.find(item => item.version_id === doneItem.result_version_id);
  assert.ok(newVersionDeps, '新选用版本应有依赖记录');
  const factEntries = newVersionDeps.entries.filter(item => item.kind === 'fact' && item.source_version);
  assert.ok(factEntries.length > 0, '新版本应有带事实来源版本的依赖条目');
  for (const entry of factEntries) {
    assert.equal(entry.source_version.truth_version, change.new_truth_version,
      '依赖条目的事实来源必须对齐变更单的新事实版本');
  }

  // 其余待处理项继续执行（文字重合成免费）；质检 needs_review 的项经人工视觉核对后整单才完成
  const rest = await req(`/api/changes/${change.id}/execute`, { method: 'POST', body: {} });
  assert.equal(rest.status, 200, JSON.stringify(rest.json));
  assert.equal(rest.json.change.counts.failed, 0);
  assert.equal(await getBalance(req), balanceBefore - 1, '文字重合成免费，总费用仍为 1 额度');
  const settledRest = await passAllVisualChecks(req, change.id);
  assert.equal(settledRest.status, 'completed', JSON.stringify(settledRest.counts));

  // 已 done 项不能再执行
  const reExecute = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST', body: { item_ids: [regenItem.id] },
  });
  assert.equal(reExecute.status, 409);
  assert.equal(reExecute.json.error, 'NO_EXECUTABLE_ITEMS');
});

test('E03 集成：换包装素材 → needs_new_photo 不冒充完成；补拍素材登记后续做到 completed', async (t) => {
  const { port } = await setup(t, { provider: createFixture() });
  const { req } = await registerClient(port, { email: 'e03-photo@example.test', tenantName: '丁店' });
  const { projectId, run, subjectAssetId } = await startRun(req, 'e03-photo');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed');
  await publishAllVersions(req, run.id);

  // 换包装：changed_asset_ids 指向主体素材 → 依赖该素材的版本全部 needs_new_photo
  const preview = await req(`/api/projects/${projectId}/changes/preview`, {
    method: 'POST',
    body: { facts: BASE_FACTS, critical_text: [{ text: '月光舒缓' }], changed_asset_ids: [subjectAssetId] },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.ok(preview.json.impact_items.length > 0);
  for (const item of preview.json.impact_items) {
    assert.equal(item.action, 'needs_new_photo', `换包装应要求新实拍：${JSON.stringify(item)}`);
  }

  // 补拍底图用当前选用版本的成品图（模拟「按原构图新实拍」）：掩码区像素与去背图一致
  // （含掩码 512 缩放的边缘出血环，由 compositeSubject 写入），才能过逐像素保留核对；
  // 且必须在确认变更单之前下载——确认会推进事实版本，旧报告随之 stale，
  // 之后再读版本内容只能拿到 draftPreview（768 内带水印），尺寸不符会导致 BASE_SIZE_MISMATCH
  const targetVersionId = preview.json.impact_items[0].version_id;
  const content = await req(`/api/runs/${run.id}/versions/${targetVersionId}/content`);
  assert.equal(content.status, 200, JSON.stringify(content.json ?? content.contentType));
  assert.ok(content.buffer.length > 0);

  const confirmed = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-photo-1' },
    body: { base_truth_version: 1, facts: BASE_FACTS, critical_text: [{ text: '月光舒缓' }], changed_asset_ids: [subjectAssetId] },
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  const change = confirmed.json.change;

  // 硬阻断：必须新实拍的项没有补素材时，不能用「改文字/重生成」冒充实物变化
  const first = change.impact_items[0];
  const hardOverride = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: { item_ids: [first.id], actions: { [first.id]: 'regenerate' } },
  });
  assert.equal(hardOverride.status, 409);
  assert.equal(hardOverride.json.error, 'HARD_OVERRIDE_BLOCKED');

  // 执行：全部新实拍项跳过并标注待补素材；整单 awaiting_material（跳过 ≠ 更新完成）
  const executed = await req(`/api/changes/${change.id}/execute`, { method: 'POST', body: {} });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  for (const item of executed.json.change.impact_items) {
    assert.equal(item.status, 'skipped', '新实拍项不自动生成新图');
    assert.equal(item.awaiting, 'material');
    assert.ok(item.skip_reason?.includes('实拍'), JSON.stringify(item));
  }
  assert.equal(executed.json.change.status, 'awaiting_material',
    '有待补实拍的跳过项时整单必须显示待补素材，不能显示更新完成');
  assert.ok(executed.json.change.counts.awaiting_material > 0);

  // 反例：登记不存在的素材 → 404
  const targetItem = executed.json.change.impact_items[0];
  const missing = await req(`/api/changes/${change.id}/items/${targetItem.id}/material`, {
    method: 'POST', body: { asset_id: 'asset_nonexistent' },
  });
  assert.equal(missing.status, 404, '不存在的素材按 404 处理');

  // 补拍素材续做：以确认前下载的成品图作为补拍新实拍底本（像素级同尺寸同构图）。
  // 真实新实拍不可能与旧图逐字节相同，且 RISK_CONTENT 会把「输出与来源素材完全一致」当硬失败，
  // 因此在掩码区与文字区之外的左上角叠加一块微差异，模拟新实拍的自然差异
  const { default: sharp } = await import('sharp');
  const cornerMarker = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#dce4dc' } }).png().toBuffer();
  const reshootBytes = await sharp(content.buffer).composite([{ input: cornerMarker, left: 0, top: 0 }]).png().toBuffer();
  const reshoot = await req(`/api/projects/${projectId}/assets?role=packaging&filename=reshoot.png`, {
    method: 'POST', body: reshootBytes,
    headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(reshoot.status, 201, JSON.stringify(reshoot.json));
  const attached = await req(`/api/changes/${change.id}/items/${targetItem.id}/material`, {
    method: 'POST', body: { asset_id: reshoot.json.asset.id },
  });
  assert.equal(attached.status, 200, JSON.stringify(attached.json));
  const recovered = attached.json.change.impact_items.find(item => item.id === targetItem.id);
  assert.equal(recovered.status, 'pending', '登记补拍素材后该项恢复可执行');
  assert.equal(recovered.action, 'text_recompose', '补拍后以新素材为底图做文字重合成');
  assert.equal(recovered.material_asset_id, reshoot.json.asset.id);

  // 反例：已恢复 pending 的项不在待补素材状态，重复登记 → 409
  const duplicate = await req(`/api/changes/${change.id}/items/${targetItem.id}/material`, {
    method: 'POST', body: { asset_id: reshoot.json.asset.id },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'ITEM_NOT_AWAITING_MATERIAL');

  // 执行恢复项：以补拍素材为底图重合成 → done；其余仍待补素材。
  // 重合成质检 needs_review 时该项要求人工视觉核对（核对通过即选用新版本），未核对前整单不完成
  const resumed = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST', body: { item_ids: [targetItem.id] },
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
  const doneItem = resumed.json.change.impact_items.find(item => item.id === targetItem.id);
  assert.equal(doneItem.status, 'done', JSON.stringify(doneItem));
  assert.ok(doneItem.result_version_id && doneItem.result_version_id !== doneItem.version_id);
  if (doneItem.visual_check === 'required') {
    assert.equal(resumed.json.change.status, 'partial_failed', '视觉核对未确认前整单不得完成');
    const checked = await req(`/api/changes/${change.id}/items/${targetItem.id}/visual-check`, {
      method: 'POST', body: { reason: '已核对补拍新实拍的文字合成效果与数量表达' },
    });
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
  }
  const afterResume = (await req(`/api/changes/${change.id}`)).json.change;
  assert.equal(afterResume.status, 'awaiting_material', '其余项仍待补素材，整单不得提前完成');

  // 新版本依赖记录应包含补拍素材的人工关联（含依据）
  const deps = await req(`/api/runs/${run.id}/deliverables/${targetItem.deliverable_id}/dependencies`);
  const newDeps = deps.json.versions.find(item => item.version_id === doneItem.result_version_id);
  assert.ok(newDeps, '新版本应有依赖记录');
  const materialEntry = newDeps.entries.find(item => item.kind === 'asset' && item.ref === reshoot.json.asset.id);
  assert.ok(materialEntry, '补拍素材应进入新版本依赖记录');
  assert.equal(materialEntry.evidence, 'manual');
  assert.ok(materialEntry.reason?.includes('补拍'), JSON.stringify(materialEntry));

  // 其余项商家明确跳过（知情放弃 → user 跳过，不阻塞）→ 整单 completed；无导出历史 → 不产生替换待办
  const skipRest = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: {
      actions: Object.fromEntries(executed.json.change.impact_items
        .filter(item => item.id !== targetItem.id)
        .map(item => [item.id, 'skip'])),
    },
  });
  assert.equal(skipRest.status, 200, JSON.stringify(skipRest.json));
  assert.equal(skipRest.json.change.status, 'completed', JSON.stringify(skipRest.json.change.counts));
  const todos = await req(`/api/replacement-todos?project_id=${projectId}`);
  assert.equal(todos.json.total, 0, '没有导出历史时不产生替换待办');
});

test('E03 集成：旧变更单不覆盖新 head（确认后 head 前进，再按旧 base 提交 409）', async (t) => {
  const { port } = await setup(t, { provider: createFixture() });
  const { req } = await registerClient(port, { email: 'e03-head@example.test', tenantName: '戊店' });
  const { projectId, run } = await startRun(req, 'e03-head');
  await waitTerminal(req, run.id);

  const first = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-head-1' },
    body: { base_truth_version: 1, facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.change.new_truth_version, 2);

  // 旧页面仍按 base=1 提交 → 409，不覆盖 v2 head；被拒的变更不落库
  const stale = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-head-2' },
    body: {
      base_truth_version: 1,
      facts: [
        { key: '容量', value: '90', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
        { key: '瓶装数量', value: '1', unit: '瓶', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'VERSION_CONFLICT');
  const list = await req(`/api/projects/${projectId}/changes`);
  assert.equal(list.json.total, 1, '被拒的变更不落库');
  assert.equal((await req(`/api/projects/${projectId}/truth-versions`)).json.head_version, 2, '事实 head 不被旧单改动');
});

/** 只改文案类事实（不动数量）：核心卖点 + 成分。 */
const TEXT_ONLY_FACTS = [
  { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '修护焕亮', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '瓶装数量', value: '1', unit: '瓶', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '成分', value: '积雪草+神经酰胺', critical: false, confirmed: true, source_type: 'user_input' },
];

test('E03 集成：重生成执行闸口——报价确认缺失 409 / 报价过期 409 / 余额不足 402（均不预留不扣费）', async (t) => {
  // 不充值：体验 3 点恰好被主任务（3 个必选交付物）用尽，余额 0，确定性验证 402
  const { port } = await setup(t, { provider: createFixture() });
  const { req } = await registerClient(port, { email: 'e03-quote@example.test', tenantName: '己店' });
  const { projectId, run } = await startRun(req, 'e03-quote');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed');
  await publishAllVersions(req, run.id);
  const balance = await getBalance(req);
  assert.equal(balance, 0, `主任务应用尽体验额度（实际余额 ${balance}），402 才能确定性成立`);

  const confirmed = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-quote-1' },
    body: { base_truth_version: 1, facts: TEXT_ONLY_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  const change = confirmed.json.change;
  const item = change.impact_items.find(entry => entry.action === 'text_recompose');
  assert.ok(item, '应有文字重合成项供动作覆盖');

  // 缺报价确认 → 409，响应携带服务端当前报价
  const noConfirm = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: { item_ids: [item.id], actions: { [item.id]: 'regenerate' } },
  });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.json.error, 'QUOTE_CONFIRMATION_REQUIRED');
  const serverQuote = noConfirm.json.details?.quote;
  assert.ok(serverQuote, '409 响应应携带服务端当前报价');
  assert.equal(serverQuote.price_version, 'finished-image.1');
  assert.ok(serverQuote.estimated_credits > 0);

  // 报价与服务端不一致 → 409 QUOTE_STALE
  const staleQuote = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: {
      item_ids: [item.id],
      actions: { [item.id]: 'regenerate' },
      quote_confirm: { price_version: 'finished-image.1', estimated_credits: serverQuote.estimated_credits + 1 },
    },
  });
  assert.equal(staleQuote.status, 409);
  assert.equal(staleQuote.json.error, 'QUOTE_STALE');

  // 报价一致但余额不足 → 402，且不产生任何预留、不认领任何项
  const insufficient = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: { item_ids: [item.id], actions: { [item.id]: 'regenerate' }, quote_confirm: serverQuote },
  });
  assert.equal(insufficient.status, 402);
  assert.equal(insufficient.json.error, 'INSUFFICIENT_CREDITS');
  assert.equal(await getBalance(req), 0, '被拒的执行不得产生预留或扣费');
  const after = await req(`/api/changes/${change.id}`);
  const unchanged = after.json.change.impact_items.find(entry => entry.id === item.id);
  assert.equal(unchanged.status, 'pending', '被拒的项保持待处理，不被认领');
  assert.equal(unchanged.child_run_id ?? null, null, '被拒的项不产生子任务');

  // 默认文字重合成路径不受报价闸口影响：免费执行；质检 needs_review 的项经人工视觉核对后整单完成
  const executed = await req(`/api/changes/${change.id}/execute`, { method: 'POST', body: {} });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  assert.equal(await getBalance(req), 0, '文字重合成免费');
  const settled = await passAllVisualChecks(req, change.id);
  assert.equal(settled.status, 'completed', JSON.stringify(settled.counts));
});

test('E03 集成：取消——确认后取消幂等；运行中取消一并取消子任务并释放预留', async (t) => {
  const provider = createFixture();
  const { port } = await setup(t, { provider, paymentProvider: demoPayment });
  const { req } = await registerClient(port, { email: 'e03-cancel@example.test', tenantName: '庚店' });
  await topUp(req);
  const { projectId, run } = await startRun(req, 'e03-cancel');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed');
  await publishAllVersions(req, run.id);

  // A. 确认后未执行即取消：项全部转为「已随变更单取消」，重复取消幂等，取消后不可执行/重试
  const changeA = (await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-cancel-1' },
    body: { base_truth_version: 1, facts: TEXT_ONLY_FACTS, critical_text: [{ text: '月光舒缓' }] },
  })).json.change;
  const cancelledA = await req(`/api/changes/${changeA.id}/cancel`, {
    method: 'POST', body: { reason: '商家决定本次不更新' },
  });
  assert.equal(cancelledA.status, 200, JSON.stringify(cancelledA.json));
  assert.equal(cancelledA.json.change.status, 'cancelled');
  assert.ok(cancelledA.json.change.cancelled_at && cancelledA.json.change.cancelled_by);
  for (const item of cancelledA.json.change.impact_items) {
    assert.equal(item.status, 'skipped');
    assert.equal(item.skip_reason, '已随变更单取消');
  }
  const cancelAgain = await req(`/api/changes/${changeA.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelAgain.status, 200, '重复取消幂等');
  assert.equal(cancelAgain.json.change.status, 'cancelled');
  const executeCancelled = await req(`/api/changes/${changeA.id}/execute`, { method: 'POST', body: {} });
  assert.equal(executeCancelled.status, 409);
  assert.equal(executeCancelled.json.error, 'CHANGE_CANCELLED');
  const retryCancelled = await req(`/api/changes/${changeA.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retryCancelled.status, 409);
  assert.equal(retryCancelled.json.error, 'CHANGE_NOT_RETRYABLE');

  // B. 运行中取消：重生成子任务挂起（hold），取消后子任务终态 cancelled、预留释放、余额恢复
  const changeB = (await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-cancel-2' },
    body: {
      base_truth_version: 2,
      facts: TEXT_ONLY_FACTS.map(fact => fact.key === '核心卖点' ? { ...fact, value: '植萃舒缓焕亮' } : fact),
      critical_text: [{ text: '月光舒缓' }],
    },
  })).json.change;
  const regenItem = changeB.impact_items.find(entry => entry.action === 'text_recompose');
  assert.ok(regenItem);
  const balanceBefore = await getBalance(req);
  // 子任务提交即挂起：保证取消时它仍在运行
  provider.control.holdIf = request => request.run_id !== run.id;
  const executed = await req(`/api/changes/${changeB.id}/execute`, {
    method: 'POST',
    body: {
      item_ids: [regenItem.id],
      actions: { [regenItem.id]: 'regenerate' },
      quote_confirm: { price_version: 'finished-image.1', estimated_credits: 1 },
    },
  });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  const runningItem = executed.json.change.impact_items.find(entry => entry.id === regenItem.id);
  assert.equal(runningItem.status, 'running', JSON.stringify(runningItem));
  assert.ok(runningItem.child_run_id);
  assert.equal(await getBalance(req), balanceBefore - 1, '重生成已预留 1 额度');

  const cancelledB = await req(`/api/changes/${changeB.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelledB.status, 200, JSON.stringify(cancelledB.json));
  assert.equal(cancelledB.json.change.status, 'cancelled');
  const child = await waitTerminal(req, runningItem.child_run_id);
  assert.equal(child.status, 'cancelled', '运行中的重生成子任务应被一并取消');
  assert.equal(await getBalance(req), balanceBefore, '子任务取消后预留释放，余额恢复');
});

test('E03 集成：并发认领互斥；中断恢复（running 无子任务）标记 EXECUTION_INTERRUPTED 后可重试', async (t) => {
  const provider = createFixture();
  const { port, app } = await setup(t, { provider, paymentProvider: demoPayment });
  const { req } = await registerClient(port, { email: 'e03-claim@example.test', tenantName: '辛店' });
  await topUp(req);
  const { projectId, run } = await startRun(req, 'e03-claim');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed');
  await publishAllVersions(req, run.id);

  // 并发执行同一变更单：认领在同一 mutate 内原子完成，只有一个请求能认领成功
  const changeA = (await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-claim-1' },
    body: { base_truth_version: 1, facts: TEXT_ONLY_FACTS, critical_text: [{ text: '月光舒缓' }] },
  })).json.change;
  const [r1, r2] = await Promise.all([
    req(`/api/changes/${changeA.id}/execute`, { method: 'POST', body: {} }),
    req(`/api/changes/${changeA.id}/execute`, { method: 'POST', body: {} }),
  ]);
  const outcomes = [r1, r2].map(item => item.status).sort();
  assert.deepEqual(outcomes, [200, 409], `并发认领必须互斥，实际 ${JSON.stringify(outcomes)}`);
  assert.equal([r1, r2].find(item => item.status === 409).json.error, 'NO_EXECUTABLE_ITEMS');
  // 重合成项同步执行完成；质检 needs_review 的项经人工视觉核对后整单 completed
  const finalA = await passAllVisualChecks(req, changeA.id);
  assert.equal(finalA.status, 'completed', JSON.stringify(finalA.counts));

  // 中断恢复：模拟「认领后、子任务落库前进程崩溃」——项为 running 但子任务不存在
  const changeB = (await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-claim-2' },
    body: {
      base_truth_version: 2,
      facts: TEXT_ONLY_FACTS.map(fact => fact.key === '核心卖点' ? { ...fact, value: '水光沁润修护' } : fact),
      critical_text: [{ text: '月光舒缓' }],
    },
  })).json.change;
  const itemCount = changeB.impact_items.length;
  assert.ok(itemCount > 0);
  const crashedItemId = changeB.impact_items[0].id;
  await app.store.mutate(data => {
    const order = data.change_orders[changeB.id];
    const item = order.impact_items.find(entry => entry.id === crashedItemId);
    item.status = 'running';
    item.executed_action = 'regenerate';
    item.child_run_id = 'run_missing_after_crash';
    item.claimed_at = new Date().toISOString();
  });
  const reconciled = await req(`/api/changes/${changeB.id}`);
  const crashed = reconciled.json.change.impact_items.find(entry => entry.id === crashedItemId);
  assert.equal(crashed.status, 'failed', '中断项按失败收口，不挂在 running');
  assert.equal(crashed.error_code, 'EXECUTION_INTERRUPTED');
  assert.equal(reconciled.json.change.status, 'partial_failed');

  // 中断项可安全重试：新幂等键（:r1）发起新子任务，成功只结算一次
  const balanceBefore = await getBalance(req);
  const retried = await req(`/api/changes/${changeB.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  const retryItem = retried.json.change.impact_items.find(entry => entry.id === crashedItemId);
  assert.equal(retryItem.status, 'running');
  assert.equal(retryItem.retry_count, 1);
  assert.ok(retryItem.child_run_id && retryItem.child_run_id !== 'run_missing_after_crash');
  const child = await waitTerminal(req, retryItem.child_run_id);
  assert.equal(child.status, 'completed', JSON.stringify(child).slice(0, 300));
  const childVersions = (await req(`/api/runs/${retryItem.child_run_id}/versions`)).json.versions;
  for (const item of childVersions) await reviewToPublishable(req, item.report_id);
  // 复核放行后在源任务选用重生成版本（needs_review 不自动选用），变更单据此收口为 done
  await adoptRegenerationIfNeeded(req, run.id, retryItem.child_run_id);
  const settledB = await waitChangeSettled(req, changeB.id);
  const recoveredItem = settledB.impact_items.find(entry => entry.id === crashedItemId);
  assert.equal(recoveredItem.status, 'done', JSON.stringify(recoveredItem));
  assert.equal(await getBalance(req), balanceBefore - 1, '中断项此前未产生预留，重试只结算一次');

  // 其余项继续执行（文字重合成免费）；needs_review 项核对通过后整单 completed。
  // 本次变更可能只命中一个交付物（无待处理余项），此时重试成功即收口，跳过执行
  const pendingRest = settledB.impact_items.filter(entry => entry.status === 'pending');
  if (pendingRest.length > 0) {
    const rest = await req(`/api/changes/${changeB.id}/execute`, { method: 'POST', body: {} });
    assert.equal(rest.status, 200, JSON.stringify(rest.json));
  }
  const finalB = await passAllVisualChecks(req, changeB.id);
  assert.equal(finalB.status, 'completed', JSON.stringify(finalB.counts));
});

test('E03 集成：needs_review 覆盖必须有确切依据（422）；依据留痕；skip 不需要依据', async (t) => {
  const { port } = await setup(t, { provider: createFixture() });
  const { req } = await registerClient(port, { email: 'e03-review@example.test', tenantName: '壬店' });
  const { projectId, run } = await startRun(req, 'e03-review');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed');
  await publishAllVersions(req, run.id);

  // 品牌更新 + 文案变化：带品牌依赖的版本全部 needs_review（品牌变化不自动作用历史图片）
  const confirmed = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'e03-review-1' },
    body: {
      base_truth_version: 1,
      facts: TEXT_ONLY_FACTS,
      critical_text: [{ text: '月光舒缓' }],
      brand_kit_changed: true,
    },
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  const change = confirmed.json.change;
  assert.ok(change.impact_items.length > 0);
  for (const item of change.impact_items) {
    assert.equal(item.action, 'needs_review', `品牌更新命中应需人工核对：${JSON.stringify(item)}`);
  }

  // 选一个同时带事实依赖的项覆盖为文字重合成：缺依据 → 422
  const factItem = change.impact_items.find(item => (item.matched ?? []).includes('fact:核心卖点'));
  assert.ok(factItem, '应有同时命中事实变化的待核对项');
  const noReason = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: { item_ids: [factItem.id], actions: { [factItem.id]: 'text_recompose' } },
  });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.json.error, 'OVERRIDE_REASON_REQUIRED');

  // 给出确切依据 → 允许覆盖执行，依据留痕（谁、何时、什么依据）
  const withReason = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: {
      item_ids: [factItem.id],
      actions: { [factItem.id]: 'text_recompose' },
      override_reasons: { [factItem.id]: '已人工核对：该图卖点文字来自事实字段，品牌更新不影响此图' },
    },
  });
  assert.equal(withReason.status, 200, JSON.stringify(withReason.json));
  const overridden = withReason.json.change.impact_items.find(item => item.id === factItem.id);
  assert.equal(overridden.status, 'done', JSON.stringify(overridden));
  assert.ok(overridden.override_reason && overridden.override_by && overridden.override_at, '覆盖依据必须留痕');
  // 覆盖为重合成的项若质检 needs_review，仍需人工视觉核对（核对通过即选用新版本）
  if (overridden.visual_check === 'required') {
    const checked = await req(`/api/changes/${change.id}/items/${factItem.id}/visual-check`, {
      method: 'POST', body: { reason: '已人工核对覆盖重合成的画面效果' },
    });
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
  }

  // 其余待核对项商家明确跳过（skip 不要求依据）→ 整单 completed
  const skipRest = await req(`/api/changes/${change.id}/execute`, {
    method: 'POST',
    body: {
      actions: Object.fromEntries(change.impact_items
        .filter(item => item.id !== factItem.id)
        .map(item => [item.id, 'skip'])),
    },
  });
  assert.equal(skipRest.status, 200, JSON.stringify(skipRest.json));
  assert.equal(skipRest.json.change.status, 'completed', JSON.stringify(skipRest.json.change.counts));
  for (const item of skipRest.json.change.impact_items) {
    if (item.id === factItem.id) continue;
    assert.equal(item.status, 'skipped');
    assert.equal(item.awaiting, 'user', '商家知情跳过记为 user，不阻塞整单完成');
  }
});
