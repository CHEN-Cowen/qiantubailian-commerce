/**
 * E02 测试：图片依赖、版本与导出追踪服务。
 *
 * 覆盖：
 * 1. 新 run 完成后依赖可查（deterministic：fact 带 truth_version、asset 参考图、brand、命中的 sku、text_layer）；
 * 2. 文字修改产生的新版本有独立依赖记录；
 * 3. 旧数据（无依赖记录）查询返回 unknown，而不是"无影响"；
 * 4. 人工关联：写入与范围校验（ref 不属于项目 422、缺 reason 422）；deterministic 条目删除被拒、manual 可删；
 * 5. 导出渠道标签设置/读取/更新留历史、越权 404；
 * 6. 素材 dependents 查询（有依赖与空数组两种）；
 * 7. 跨租户读依赖 404。
 * 运行：node --test test/e02.js（Node 22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { compileDependencies, mergeManualEntries } from '../src/depgraph.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 纯函数 ----------

test('E02 纯函数：compileDependencies 编译 fact/asset/brand/sku/text_layer，无依据返回 null', () => {
  assert.equal(compileDependencies({}), null);
  const entries = compileDependencies({
    spec: { brand_kit: { id: 'bk_1', version: 2 }, product_truth: { version: 3 } },
    truth: { version: 3, sku: 'A-01', critical_text: [{ text: '净含量 50g' }], facts: [] },
    deliverable: {
      text_layers: [
        { id: 'layer_1', source: 'fact', fact_key: '容量' },
        { id: 'layer_2', source: 'brand_logo', asset_ref: 'asset_logo' },
      ],
    },
    references: [{ asset_id: 'asset_subject', role: 'subject' }],
    skuProfile: { version: 1, skus: [{ id: 'sku_1', sku_code: 'a-01' }] },
  });
  const byKind = kind => entries.filter(item => item.kind === kind);
  assert.deepEqual(byKind('fact').map(item => item.ref).sort(), ['critical_text', '容量']);
  assert.equal(byKind('fact').find(item => item.ref === '容量').source_version.truth_version, 3);
  assert.deepEqual(byKind('asset').map(item => item.ref).sort(), ['asset_logo', 'asset_subject']);
  assert.deepEqual(byKind('brand')[0].source_version, { brand_kit_version: 2 });
  assert.equal(byKind('sku')[0].ref, 'sku_1'); // 大小写不敏感命中
  assert.equal(byKind('text_layer').length, 2);
  // 重复引用去重
  const again = compileDependencies({
    deliverable: { text_layers: [{ id: 'layer_1', source: 'fact', fact_key: '容量' }, { id: 'layer_9', source: 'fact', fact_key: '容量' }] },
  });
  assert.equal(again.filter(item => item.kind === 'fact').length, 1);
  // mergeManualEntries：同 (kind,ref) 不重复并入
  const merged = mergeManualEntries(
    [{ kind: 'fact', ref: '容量', evidence: 'deterministic' }],
    [{ kind: 'fact', ref: '容量', evidence: 'manual' }, { kind: 'fact', ref: '产地', evidence: 'manual' }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].evidence, 'deterministic');
});

// ---------- Provider fixture（与 m13 同型：本地可解码 PNG，成品计价路径） ----------

function createFixture() {
  let submitCount = 0;
  const calls = new Map();
  return {
    capabilities: () => ({ id: 'e02-fixture', version: '1', image: true, video: false,
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
        provider: 'e02-fixture', model: 'fixture/image', model_version: '1',
        provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ cancelled: true }),
  };
}

// ---------- 会话脚手架 ----------

async function setup(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e02-'));
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
    return { status: response.status, json };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'E02Account2026!', display_name: 'E02', tenant_name: tenantName },
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

/** 建项目 → 主体素材 → SKU 档案 → 事实 → 品牌套件 → 冻结 spec → 报价 → 任务。 */
async function startRun(req, key) {
  const created = await req('/api/projects', {
    method: 'POST',
    body: { name: 'E02 面霜', sku: 'E02-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;

  const image = await sharpImage();
  const asset = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: image, headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));

  // E01：建档且商家编号与项目 SKU 一致，供确定依赖命中
  const profile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT',
    body: { base_version: 0, confirm: true, skus: [{ sku_code: 'E02-01', label: '标准装', confirmed: true }] },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.json));

  const truth = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));

  const kit = await req('/api/brand-kits', {
    method: 'POST',
    body: {
      name: 'E02 品牌套件', palette: { primary: '#2F6B4F', secondary: ['#F8FAFC'] },
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

  const quote = await req('/api/quotes', { method: 'POST', body: { project_id: projectId } });
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
    .map(item => ({ code: item.code, decision: 'pass', reason: 'E02 测试样本人工检查通过', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await req(`/api/quality-reports/${reportId}/reviews`, {
    method: 'POST', body: { decisions, note: '仅测试 fixture，不证明真实模型效果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  return reviewed.json.report;
}

// ---------- 集成 ----------

test('E02 集成：依赖编译/查询/人工关联/删除/渠道/dependents 全链路', async (t) => {
  const { port } = await setup(t, { provider: createFixture() });
  const owner = await registerClient(port, { email: 'e02-a@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'e02-b@example.test', tenantName: '乙店' });
  const { req } = owner;
  const { projectId, run, subjectAssetId } = await startRun(req, 'e02-main');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 400));

  // 1. run 依赖概览：每个交付物 deterministic，含 fact/asset/brand/sku/text_layer
  const overview = await req(`/api/runs/${run.id}/dependencies`);
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  assert.ok(overview.json.deliverables.length > 0);
  const allEntries = overview.json.deliverables.flatMap(item => item.entries);
  for (const target of overview.json.deliverables) {
    assert.equal(target.evidence, 'deterministic', `${target.deliverable_id} 应有确定依赖记录`);
    assert.ok(target.version_id, '应指向当前选用版本');
  }
  const kinds = new Set(allEntries.map(item => item.kind));
  for (const kind of ['fact', 'asset', 'brand', 'text_layer']) assert.ok(kinds.has(kind), `缺少 ${kind} 依赖`);
  assert.ok(kinds.has('sku'), 'SKU 档案命中后应有 sku 依赖');
  const factEntry = allEntries.find(item => item.kind === 'fact' && item.ref !== 'critical_text');
  assert.equal(factEntry.source_version.truth_version, 1);
  assert.ok(allEntries.some(item => item.kind === 'asset' && item.ref === subjectAssetId), '主体素材应进依赖');

  // 跨租户读取 → 404
  assert.equal((await outsider.req(`/api/runs/${run.id}/dependencies`)).status, 404);

  // 2. 文字修改产生的新版本有独立依赖记录（找一个带可编辑文字层的交付物）
  let target0 = null;
  let editable = null;
  for (const candidate of overview.json.deliverables) {
    const layers = await req(`/api/runs/${run.id}/deliverables/${candidate.deliverable_id}/text-layers`);
    if (layers.status !== 200) continue;
    const hit = layers.json.layers.find(item => item.editable_text === true);
    if (hit) { target0 = candidate; editable = hit; break; }
  }
  assert.ok(target0 && editable, '应有带可编辑文字层的交付物');
  // 放行原版本（检查通过才能修改不依赖它，但导出需要；先复核）
  const versionsBefore = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  for (const item of versionsBefore.filter(v => v.current)) await reviewToPublishable(req, item.report_id);
  const edited = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/text-edits`, {
    method: 'POST',
    body: { base_version_id: target0.version_id, edits: [{ id: editable.id, text: '舒缓维稳 持久水润' }] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const newVersionId = edited.json.version.id;
  const deliverableDeps = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies`);
  assert.equal(deliverableDeps.status, 200);
  assert.equal(deliverableDeps.json.versions.length, 2);
  const newRecord = deliverableDeps.json.versions.find(item => item.version_id === newVersionId);
  assert.ok(newRecord?.record_id, '文字修改的新版本应有独立依赖记录');
  assert.equal(newRecord.evidence, 'deterministic');

  // 3. 人工关联：写入（并入已有记录，去重）+ 范围校验
  // 关联目标是任务完成后新上传的素材：已编译进记录的 ref 会被 kind:ref 去重跳过，
  // 必须用全新 ref 才能观察到 manual 条目
  const extraAsset = await req(`/api/projects/${projectId}/assets?role=style&filename=extra.png`, {
    method: 'POST', body: await sharpImage(), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(extraAsset.status, 201, JSON.stringify(extraAsset.json));
  const extraAssetId = extraAsset.json.asset.id;
  const manual = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies`, {
    method: 'POST',
    body: { version_id: newVersionId, reason: '商家确认该图参考了新上传的 style 素材', entries: [
      { kind: 'asset', ref: extraAssetId, note: '新版画面参考' },
      { kind: 'asset', ref: extraAssetId }, // 同请求内重复，应去重不报错
    ] },
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.json));
  const manualEntries = manual.json.dependency.entries.filter(item => item.evidence === 'manual');
  assert.equal(manualEntries.length, 1);
  assert.equal(manualEntries[0].ref, extraAssetId);
  assert.ok(manualEntries[0].actor && manualEntries[0].at && manualEntries[0].reason);

  const noReason = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies`, {
    method: 'POST', body: { version_id: newVersionId, entries: [{ kind: 'fact', ref: '核心卖点' }] },
  });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.json.error, 'INVALID_FIELD');

  const badFact = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies`, {
    method: 'POST', body: { version_id: newVersionId, reason: '测试', entries: [{ kind: 'fact', ref: '不存在的事实' }] },
  });
  assert.equal(badFact.status, 422);

  // 别的项目的素材不能关联
  const otherProject = await req('/api/projects', { method: 'POST', body: { name: '干扰项', sku: 'E02-99', category: '面霜', platform: '天猫' } });
  const otherAsset = await req(`/api/projects/${otherProject.json.project.id}/assets?role=subject&filename=o.png`, {
    method: 'POST', body: await sharpImage(), headers: { 'Content-Type': 'image/png' },
  });
  const foreignAsset = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies`, {
    method: 'POST', body: { version_id: newVersionId, reason: '测试', entries: [{ kind: 'asset', ref: otherAsset.json.asset.id }] },
  });
  assert.equal(foreignAsset.status, 422);

  // 4. deterministic 不可删；manual 可删且需 reason
  const factRef = encodeURIComponent(`fact:${factEntry.ref}`);
  const delDeterministic = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies/${factRef}?reason=${encodeURIComponent('尝试删除系统依赖')}`, { method: 'DELETE' });
  assert.equal(delDeterministic.status, 409);
  assert.equal(delDeterministic.json.error, 'DEPENDENCY_LOCKED');

  const manualRef = encodeURIComponent(`asset:${extraAssetId}`);
  const delNoReason = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies/${manualRef}`, { method: 'DELETE' });
  assert.equal(delNoReason.status, 422);
  const delManual = await req(`/api/runs/${run.id}/deliverables/${target0.deliverable_id}/dependencies/${manualRef}?reason=${encodeURIComponent('改错了，撤回')}`, { method: 'DELETE' });
  assert.equal(delManual.status, 200, JSON.stringify(delManual.json));
  assert.ok(!delManual.json.dependency.entries.some(item => item.evidence === 'manual'));

  // 5. 素材 dependents：主体素材被依赖；未用素材返回空数组
  const deps = await req(`/api/projects/${projectId}/assets/${subjectAssetId}/dependents`);
  assert.equal(deps.status, 200, JSON.stringify(deps.json));
  assert.ok(deps.json.dependents.length > 0, '主体素材应被图片版本依赖');
  assert.ok(deps.json.dependents.every(item => item.run_id === run.id && item.evidence === 'deterministic'));
  const unused = await req(`/api/projects/${otherProject.json.project.id}/assets/${otherAsset.json.asset.id}/dependents`);
  assert.equal(unused.status, 200);
  assert.deepEqual(unused.json.dependents, []);
  assert.equal((await outsider.req(`/api/projects/${projectId}/assets/${subjectAssetId}/dependents`)).status, 404);

  // 6. 导出渠道标签：设置/读取/更新留历史/越权 404
  const exported = await req(`/api/runs/${run.id}/exports`, { method: 'POST', body: { scope: 'complete' } });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const exportId = exported.json.export.id;
  const put = await req(`/api/exports/${exportId}/channels`, {
    method: 'PUT', body: { labels: ['天猫', ' 天猫 ', '主图投放'], note: '首批主图' },
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual(put.json.channels.labels, ['天猫', '主图投放']); // 去重
  const got = await req(`/api/exports/${exportId}/channels`);
  assert.deepEqual(got.json.channels.labels, ['天猫', '主图投放']);
  const put2 = await req(`/api/exports/${exportId}/channels`, { method: 'PUT', body: { labels: ['抖音'] } });
  assert.deepEqual(put2.json.channels.labels, ['抖音']);
  const tooMany = await req(`/api/exports/${exportId}/channels`, { method: 'PUT', body: { labels: Array.from({ length: 9 }, (_, i) => `渠道${i}`) } });
  assert.equal(tooMany.status, 422);
  assert.equal((await outsider.req(`/api/exports/${exportId}/channels`)).status, 404);
  assert.equal((await outsider.req(`/api/exports/${exportId}/channels`, { method: 'PUT', body: { labels: ['x'] } })).status, 404);
});

test('E02 兼容旧数据：无依赖记录的版本查询返回 unknown 而非"无影响"', async (t) => {
  const { port, dir, app } = await setup(t, { provider: createFixture() });
  const { req } = await registerClient(port, { email: 'e02-legacy@example.test', tenantName: '丙店' });
  const { run } = await startRun(req, 'e02-legacy');
  await waitTerminal(req, run.id);
  await app.close();

  // 模拟旧版本数据：抹掉全部依赖记录（等同于旧系统从未写过）
  const raw = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
  raw.image_dependencies = {};
  await writeFile(path.join(dir, 'data.json'), `${JSON.stringify(raw)}\n`, 'utf8');

  const app2 = createApp({ port: 0, storeDir: dir, demoMode: false, initialCredits: 0, tickMs: 5, attemptTimeoutMs: 30_000, provider: createFixture() });
  t.after(async () => { await app2.close(); });
  const { port: port2 } = await app2.listen();
  const login = await fetch(`http://127.0.0.1:${port2}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'e02-legacy@example.test', password: 'E02Account2026!' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const overview = await fetch(`http://127.0.0.1:${port2}/api/runs/${run.id}/dependencies`, { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.ok(payload.deliverables.length > 0);
  for (const item of payload.deliverables) {
    assert.equal(item.evidence, 'unknown', '无记录的版本必须标 unknown（关联信息不足，待人工关联），不能显示"无需更新"');
    assert.deepEqual(item.entries, []);
  }
});
