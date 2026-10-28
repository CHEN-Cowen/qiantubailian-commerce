/**
 * M13 测试：文字排版修改与版本选择。
 *
 * 覆盖四类证据：
 * 1. 纯函数：只读层（包装关键文字 / Logo）、超长与越界问题码、重复编辑、未知层、正常修改。
 * 2. 端到端（会话模式 + 成品计价）：任务完成后免费改文字——不重新调用模型、不产生额度流水、
 *    新版本携带新报告与同一底图来源；未通过检查不自动选用；复核后可激活；
 *    导出清单使用版本内冻结的文字层；旧版本可随时恢复。
 * 3. 错误路径：跨租户 404、非终态 409、base_version 过期 409、未知层 422。
 * 4. 评估不通过（OCR 硬失败）：新版本只进历史，active 保持旧版本，且硬失败不能被人工复核放行。
 * 5. legacy 版本（演示计价）：没有文字层/底图来源时明确返回 TEXT_LAYER_MISSING，不假装支持。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { applyTextEdits, describeTextEdits, presentTextLayers } from '../src/text-edits.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- Provider fixtures ----------

/** 合格成品 Provider：返回真实可解码 PNG（本地会按交付格式重合成），并统计提交次数用于"免费"断言。 */
function createSizeFixture() {
  let submitCount = 0;
  const calls = new Map();
  const provider = {
    capabilities: () => ({ id: 'm13-fixture', version: '1', image: true, video: false,
      max_references: 6, supports_mask: false, supports_post_composite: true, supports_async: true,
      supports_revision: false, supports_cancel: true, max_side: 4096, formats: ['png', 'jpg'],
      simulated: true, acceptance: 'simulated_only' }),
    validate: () => ({ ok: true }),
    estimate: () => ({ estimated_credits: 1, max_credits: 1 }),
    submit(request) {
      submitCount += 1;
      calls.set(request.idempotency_key, request);
      return { provider_job_id: request.idempotency_key, status: 'queued' };
    },
    poll(handle) {
      const request = calls.get(handle.provider_job_id);
      const width = request?.target_width ?? 1024;
      const height = request?.target_height ?? 1024;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 3;
          rgb[index] = (x * 3 + y * 2) % 256;
          rgb[index + 1] = (y * 5 + x) % 256;
          rgb[index + 2] = (x * 7 + y * 3) % 256;
        }
      }
      const bytes = encodeRgbPng(width, height, rgb);
      return { status: 'succeeded', result: {
        provider: 'm13-fixture', model: 'fixture/image', model_version: '1',
        provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ cancelled: true }),
    _submitCount: () => submitCount,
  };
  return provider;
}

/** 永远排队的 Provider：用于制造"任务未结束"的状态。 */
function createPendingFixture() {
  const fixture = createSizeFixture();
  return {
    ...fixture,
    poll: () => ({ status: 'queued' }),
    _submitCount: fixture._submitCount,
  };
}
/** 演示模式 fixture：与 M08 相同（legacy_demo 计价，版本不携带文字层）。 */
function createDemoFixture() {
  let sequence = 0;
  const jobs = new Map();
  return {
    capabilities: () => ({ id: 'm13-demo', version: 'fixture.1', image: true, video: false,
      max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
      supports_seed: true, supports_revision: true, max_side: 2048, formats: ['jpg', 'png'],
      simulated: true, acceptance: 'simulated_only' }),
    validate: () => ({ ok: true }),
    estimate: request => {
      const side = Math.max(request.target_width ?? 1024, request.target_height ?? 1024);
      return { price_version: 'fixture.1', estimated_credits: Math.max(1, Math.round(side * side * 0.0000045)), max_credits: null };
    },
    submit(request) {
      sequence += 1;
      jobs.set(`fx_${sequence}`, { request, polls: 0 });
      return { provider_job_id: `fx_${sequence}`, status: 'queued' };
    },
    poll(handle) {
      const job = jobs.get(handle.provider_job_id);
      if (!job) return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
      job.polls += 1;
      if (job.polls < 2) return { status: 'queued' };
      const width = job.request.target_width;
      const height = job.request.target_height;
      const bytes = encodeRgbPng(width, height, Buffer.alloc(width * height * 3, 200));
      return { status: 'succeeded', result: {
        provider: 'm13-demo', model: 'fixture/image', model_version: 'fixture.1',
        provider_job_id: job.request.idempotency_key,
        provider_request_id: `req_${job.request.request_hash.slice(0, 12)}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ status: 'cancelled' }),
  };
}

// ---------- 会话模式（成品计价）脚手架 ----------

async function setupSession(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm13-'));
  const app = createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 0,
    tickMs: 5, attemptTimeoutMs: 30_000, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
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
    return { status: response.status, headers: response.headers, json, body: buffer };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email: 'm13@example.test', password: 'M13Account2026!', display_name: 'M13' },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return {
    port, req,
    snapshot: async () => JSON.parse(await readFile(`${dir}/data.json`, 'utf8')),
    loginAs: async ({ email, password }) => {
      const loggedIn = await req('/api/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.json));
      return loggedIn;
    },
  };
}

/** 建项目 → 主体素材 → 事实 → 冻结 spec → 成品报价 → 启动任务。 */
async function startFinishedRun(req, key, { email = 'm13@example.test' } = {}) {
  const created = await req('/api/projects', {
    method: 'POST',
    body: { name: 'M13 面霜', sku: 'M13-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;

  const base = await sharpImage(1200, 1200);
  const asset = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: base, headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));

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

  const preview = await req(`/api/projects/${projectId}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await req(`/api/projects/${projectId}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));

  const quote = await req('/api/quotes', { method: 'POST', body: { project_id: projectId } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  assert.equal(quote.json.quote.billing_mode, 'finished_image');

  const run = await req('/api/runs', {
    method: 'POST',
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
    headers: { 'Idempotency-Key': key },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  return run.json.run;
}

async function sharpImage(width, height) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#eeeeee' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 600, channels: 3, background: '#aa3322' } }).png().toBuffer(), left: 400, top: 300 }])
    .png().toBuffer();
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

async function waitRunning(req, runId, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const run = (await req(`/api/runs/${runId}`)).json.run;
    if (['running', 'evaluating'].includes(run.status)) return run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) {
      throw new Error(`任务意外进入终态 ${run.status}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`任务未开始执行，最后状态 ${run?.status}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** 把报告中所有"原始状态为 unknown 且可裁决"的必要项人工复核为通过（与前端复核动作一致）。 */
async function reviewToPublishable(req, reportId) {
  const report = (await req(`/api/quality-reports/${reportId}`)).json.report;
  if (!report) throw new Error(`报告不存在 ${reportId}`);
  if (report.decision === 'publishable') return report;
  const decisions = (report.checks ?? [])
    .filter(item => item.required && item.status === 'unknown' && item.adjudicable)
    .map(item => ({ code: item.code, decision: 'pass', reason: 'M13 测试样本人工检查通过', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await req(`/api/quality-reports/${reportId}/reviews`, {
    method: 'POST',
    body: { decisions, note: '仅测试 fixture，不证明真实模型效果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  return reviewed.json.report;
}

function readZip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset = dataStart + compressedSize;
  }
  return files;
}

const textEditsRoute = (runId, deliverableId = 'benefit') =>
  `/api/runs/${runId}/deliverables/${deliverableId}/text-edits`;
const textLayersRoute = (runId, deliverableId = 'benefit') =>
  `/api/runs/${runId}/deliverables/${deliverableId}/text-layers`;

// ---------- 1. 纯函数 ----------

test('M13 纯函数：包装文字与 Logo 只读，未知层/重复编辑返回问题码，正常修改产生变更', () => {
  const layers = [
    { id: 'layer_1', source: 'fact', fact_key: '核心卖点', text: '舒缓维稳', editable_text: true,
      x: 0.08, y: 0.82, width: 0.84, size_ratio: 0.04, align: 'left' },
    { id: 'layer_2', source: 'critical_text', text: '月光舒缓', must_match_source_pixels: true,
      x: 0.1, y: 0.9, width: 0.5, size_ratio: 0.05 },
    { id: 'layer_3', source: 'brand_logo', logo: true, asset_ref: 'ast_1',
      x: 0.8, y: 0.08, width: 0.12, size_ratio: 0.1 },
  ];

  // 展示层：只读层必须明确不可编辑
  const presented = presentTextLayers(layers);
  assert.equal(presented.find(item => item.id === 'layer_1').editable_text, true);
  assert.equal(presented.find(item => item.id === 'layer_2').editable_text, false);
  assert.equal(presented.find(item => item.id === 'layer_2').editable_layout, false);
  assert.equal(presented.find(item => item.id === 'layer_3').editable_text, false);
  assert.equal(presented.find(item => item.id === 'layer_2').readonly_reason, 'PACKAGING_TEXT_MUST_MATCH_PIXELS');

  // 包装关键文字不可改写
  const readonly = applyTextEdits({ layers, edits: [{ id: 'layer_2', text: '仿冒包装' }] });
  assert.deepEqual(readonly.issues.map(item => ({ id: item.id, code: item.code })),
    [{ id: 'layer_2', code: 'PACKAGING_TEXT_READONLY' }]);
  assert.equal(readonly.changed, false);
  assert.equal(readonly.layers.find(item => item.id === 'layer_2').text, '月光舒缓');

  // Logo 只能用原图
  const logoEdit = applyTextEdits({ layers, edits: [{ id: 'layer_3', x: 0.2 }] });
  assert.deepEqual(logoEdit.issues.map(item => item.code), ['LAYER_NOT_EDITABLE']);

  // 未知层与重复编辑
  const unknown = applyTextEdits({ layers, edits: [{ id: 'layer_9', text: 'x' }] });
  assert.deepEqual(unknown.issues.map(item => item.code), ['LAYER_NOT_FOUND']);
  const duplicated = applyTextEdits({ layers, edits: [{ id: 'layer_1', text: 'A' }, { id: 'layer_1', text: 'B' }] });
  assert.deepEqual(duplicated.issues.map(item => item.code), ['DUPLICATE_LAYER_EDIT']);

  // 空文案 / 超长 / 越界 / 非数字
  assert.deepEqual(applyTextEdits({ layers, edits: [{ id: 'layer_1', text: '   ' }] }).issues.map(item => item.code), ['TEXT_EMPTY']);
  assert.deepEqual(applyTextEdits({ layers, edits: [{ id: 'layer_1', text: '超'.repeat(61) }] }).issues.map(item => item.code), ['TEXT_TOO_LONG']);
  const outOfRange = applyTextEdits({ layers, edits: [{ id: 'layer_1', x: 0.9, y: 0.5, width: 0.1, size_ratio: 0.5 }] });
  assert.deepEqual(outOfRange.issues.map(item => `${item.id}:${item.code}`), [
    'layer_1:LAYOUT_OUT_OF_RANGE', 'layer_1:LAYOUT_OUT_OF_RANGE',
  ], 'width 与 size_ratio 越界，x/y 在范围内不报');
  assert.deepEqual(applyTextEdits({ layers, edits: [{ id: 'layer_1', x: 'abc' }] }).issues.map(item => item.code), ['LAYOUT_INVALID']);

  // 正常修改：文字 + 位置，changed=true 且保留只读层原样
  const applied = applyTextEdits({
    layers,
    edits: [{ id: 'layer_1', text: '  舒缓维稳   持久水润 ', y: 0.86 }],
  });
  assert.deepEqual(applied.issues, []);
  assert.equal(applied.changed, true);
  assert.equal(applied.layers.find(item => item.id === 'layer_1').text, '舒缓维稳 持久水润');
  assert.equal(applied.layers.find(item => item.id === 'layer_1').y, 0.86);
  assert.equal(applied.layers.find(item => item.id === 'layer_2').text, '月光舒缓');
  assert.equal(applied.layers.find(item => item.id === 'layer_3').x, 0.8);

  // 相同内容重复提交不算变更
  const same = applyTextEdits({ layers, edits: [{ id: 'layer_1', text: '舒缓维稳', y: 0.82 }] });
  assert.equal(same.changed, false);

  // 变更摘要只包含实际变化的字段
  const changes = describeTextEdits({ before: layers, after: applied.layers });
  assert.deepEqual(changes.map(item => `${item.id}:${item.field}`), ['layer_1:text', 'layer_1:y']);
});

// ---------- 2. 端到端：免费修改 → 复核 → 激活 → 导出 → 恢复 ----------

test('M13 端到端：不重调模型、新版本带新报告与同一底图、复核后可选用、导出用版本文字层、旧版本可恢复', async t => {
  const provider = createSizeFixture();
  const { req, snapshot } = await setupSession(t, { provider });
  const run = await startFinishedRun(req, 'm13-main');
  const done = await waitTerminal(req, run.id);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  const submitsAfterRun = provider._submitCount();
  assert.ok(submitsAfterRun > 0);

  const benefit = done.deliverables.find(item => item.deliverable_id === 'benefit');
  const versions = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  const oldVersion = versions.find(item => item.id === benefit.active_version_id);
  assert.ok(oldVersion, '成品计价任务必须有选用版本');
  assert.ok(Array.isArray(oldVersion.text_layers) && oldVersion.text_layers.length >= 2,
    '版本必须冻结文字层');
  assert.ok(oldVersion.overlay_base_hash, '版本必须冻结底图来源');

  // 只读预览接口
  const previewResponse = await req(textLayersRoute(run.id));
  assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.json));
  assert.equal(previewResponse.json.version_id, oldVersion.id);
  assert.equal(previewResponse.json.overlay_base_hash, oldVersion.overlay_base_hash);
  assert.equal(previewResponse.json.text_edit_version, 'm13.text-edit.1');
  assert.equal(previewResponse.json.limits.text_max_length, 60);
  const editable = previewResponse.json.layers.find(item => item.editable_text === true);
  const readonlyLayer = previewResponse.json.layers.find(item =>
    item.editable_text === false && item.editable_layout === false);
  assert.ok(editable && readonlyLayer, '卖点图必须有可编辑文案与只读包装文字');

  // 真实流程：先复核当前选用版本（放行原图、结算成品额度），再做文字修改
  const activeVersions = (await req(`/api/runs/${run.id}/versions`)).json.versions.filter(item => item.current);
  for (const item of activeVersions) {
    const reviewed = await reviewToPublishable(req, item.report_id);
    assert.equal(reviewed.decision, 'publishable', `${item.deliverable_id} 报告复核后应可发布`);
  }

  // 422：包装关键文字不可改写
  const readonlyAttempt = await req(textEditsRoute(run.id), {
    method: 'POST',
    body: { base_version_id: oldVersion.id, edits: [{ id: readonlyLayer.id, text: '仿冒包装' }] },
  });
  assert.equal(readonlyAttempt.status, 422, JSON.stringify(readonlyAttempt.json));
  assert.equal(readonlyAttempt.json.error, 'TEXT_EDIT_INVALID');
  assert.ok(readonlyAttempt.json.details.issues.some(item => item.code === 'PACKAGING_TEXT_READONLY'));

  // 422：未知文字层
  const unknownLayer = await req(textEditsRoute(run.id), {
    method: 'POST', body: { edits: [{ id: 'layer_99', text: 'x' }] },
  });
  assert.equal(unknownLayer.status, 422, JSON.stringify(unknownLayer.json));
  assert.ok(unknownLayer.json.details.issues.some(item => item.code === 'LAYER_NOT_FOUND'));

  // 409：base_version 已过期（防并发编辑互相覆盖）
  const stale = await req(textEditsRoute(run.id), {
    method: 'POST',
    body: { base_version_id: 'ver_does_not_exist', edits: [{ id: editable.id, text: '舒缓维稳 持久水润' }] },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.equal(stale.json.error, 'VERSION_CONFLICT');

  // 额度账本基线：原图复核后已有 capture 流水
  const entriesBefore = Object.values((await snapshot()).credit_entries ?? {});
  const capturesBefore = entriesBefore.filter(item => item.type === 'capture').length;
  assert.ok(capturesBefore > 0, '原图复核结算后必须已有额度流水');

  // 正常修改
  const edited = await req(textEditsRoute(run.id), {
    method: 'POST',
    body: { base_version_id: oldVersion.id, edits: [{ id: editable.id, text: '  舒缓维稳   持久水润 ' }] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const result = edited.json;
  assert.equal(result.previous_version_id, oldVersion.id);
  assert.equal(result.version.number, oldVersion.number + 1);
  assert.equal(result.version.created_by, 'user_text_edit');
  assert.equal(result.version.note, '文字排版修改');
  assert.equal(result.version.overlay_base_hash, oldVersion.overlay_base_hash, '底图来源必须不变');
  assert.notEqual(result.version.hash, oldVersion.hash, '重合成后的图片哈希必须不同');
  assert.equal(result.version.text_layers.find(item => item.id === editable.id).text, '舒缓维稳 持久水润');
  assert.equal(result.version.text_layers.find(item => item.id === readonlyLayer.id).text, '月光舒缓');

  // 事实核对未复核 → 报告 needs_review，新版本不自动选用（未通过不能被放行）
  assert.equal(result.report.decision, 'needs_review');
  assert.equal(result.activated, false);
  assert.equal(result.version.active, false);
  const midRun = (await req(`/api/runs/${run.id}`)).json.run;
  assert.equal(midRun.deliverables.find(item => item.deliverable_id === 'benefit').active_version_id,
    oldVersion.id, '评估未通过时 active 必须保持旧版本');

  // 硬验收：未重新调用生图模型 + 免费不产生额度流水
  assert.equal(provider._submitCount(), submitsAfterRun);
  const entriesAfter = Object.values((await snapshot()).credit_entries ?? {});
  assert.equal(entriesAfter.length, entriesBefore.length, '文字修改不得产生任何额度流水');

  // 事件：stage=revision, status=text_edit_applied
  const events = Object.values((await snapshot()).events ?? {})
    .filter(item => item.run_id === run.id && item.status === 'text_edit_applied');
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'revision');
  assert.equal(events[0].payload.from_version, oldVersion.id);
  assert.equal(events[0].payload.to_version, result.version.id);
  assert.equal(events[0].payload.report_decision, 'needs_review');

  // 409：没有实际变化——注意上一轮编辑因 needs_review 未被选用，active 仍是旧版本，
  // 因此与"当前选用版本"完全一致的文案才算无变化
  const noChange = await req(textEditsRoute(run.id), {
    method: 'POST',
    body: { edits: [{ id: editable.id, text: '舒缓维稳' }] },
  });
  assert.equal(noChange.status, 409, JSON.stringify(noChange.json));
  assert.equal(noChange.json.error, 'NO_CHANGES');

  // 复核新报告 → 激活新版本
  const reviewedNew = await reviewToPublishable(req, result.report.id);
  assert.equal(reviewedNew.decision, 'publishable');

  const activated = await req(`/api/runs/${run.id}/versions/${result.version.id}/activate`, { method: 'POST' });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));
  const afterActivate = (await req(`/api/runs/${run.id}`)).json.run;
  assert.equal(afterActivate.deliverables.find(item => item.deliverable_id === 'benefit').active_version_id,
    result.version.id);
  assert.equal(afterActivate.quality_status, 'publishable');
  assert.equal(provider._submitCount(), submitsAfterRun, '版本选用不得触发模型调用');

  // 正式导出：manifest 使用版本内冻结的文字层（含编辑后的文案与原样包装文字）
  const exported = await req(`/api/runs/${run.id}/exports`, { method: 'POST', body: { scope: 'complete' } });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const download = await req(exported.json.export.download_url);
  assert.equal(download.status, 200);
  const files = readZip(download.body);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const benefitAsset = manifest.assets.find(item => item.deliverable_id === 'benefit');
  assert.ok(benefitAsset, 'manifest 必须包含卖点图');
  assert.ok(Array.isArray(benefitAsset.text_layers) && benefitAsset.text_layers.length >= 2);
  assert.equal(benefitAsset.text_layers.find(item => item.id === editable.id).text, '舒缓维稳 持久水润');
  assert.equal(benefitAsset.text_layers.find(item => item.id === readonlyLayer.id).text, '月光舒缓');
  assert.equal(benefitAsset.overlay_file, 'overlays/benefit.svg');
  assert.ok(files.has('overlays/benefit.svg'), '编辑后的版本必须导出可编辑排版层');
  assert.equal(createHash('sha256').update(files.get(benefitAsset.file)).digest('hex'), result.version.hash,
    '包内图片必须是重合成后的新图');

  // 旧版本可随时恢复；整条链路都未重调模型
  const restored = await req(`/api/runs/${run.id}/versions/${oldVersion.id}/activate`, { method: 'POST' });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  const afterRestore = (await req(`/api/runs/${run.id}`)).json.run;
  assert.equal(afterRestore.deliverables.find(item => item.deliverable_id === 'benefit').active_version_id,
    oldVersion.id);
  assert.equal(provider._submitCount(), submitsAfterRun);
});

// ---------- 3. 错误路径 ----------

test('M13 错误路径：非终态 409、跨租户 404、未知层 422', async t => {
  const provider = createPendingFixture();
  const { req } = await setupSession(t, { provider });
  const run = await startFinishedRun(req, 'm13-pending');
  await waitRunning(req, run.id);

  const tooEarly = await req(textEditsRoute(run.id), {
    method: 'POST', body: { edits: [{ id: 'layer_1', text: 'x' }] },
  });
  assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.json));
  assert.equal(tooEarly.json.error, 'RUN_NOT_TERMINAL');
  const previewTooEarly = await req(textLayersRoute(run.id));
  assert.equal(previewTooEarly.status, 409);
  assert.equal(previewTooEarly.json.error, 'RUN_NOT_TERMINAL');

  // 跨租户 404：另一个账户是另一个租户
  await req('/api/auth/register', {
    method: 'POST',
    body: { email: 'm13-other@example.test', password: 'M13Other2026!', display_name: 'Other' },
  });
  const crossRead = await req(textLayersRoute(run.id));
  assert.equal(crossRead.status, 404, JSON.stringify(crossRead.json));
  const crossEdit = await req(textEditsRoute(run.id), {
    method: 'POST', body: { edits: [{ id: 'layer_1', text: 'x' }] },
  });
  assert.equal(crossEdit.status, 404, JSON.stringify(crossEdit.json));
});

// ---------- 4. 评估不通过：blocked 只进历史，且不能被复核放行 ----------

test('M13 评估不通过：OCR 硬失败时新版本只登记历史，active 保持旧版本，复核不能放行硬失败', async t => {
  const provider = createSizeFixture();
  const ocr = { recognize: async () => ({ status: 'ok', engine: 'test-fixture', lines: [] }) };
  const { req } = await setupSession(t, { provider, ocr });
  const run = await startFinishedRun(req, 'm13-blocked');
  const done = await waitTerminal(req, run.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.quality_status, 'blocked', 'OCR 未检出包装关键文字必须硬失败');
  const submits = provider._submitCount();

  const preview = await req(textLayersRoute(run.id));
  assert.equal(preview.status, 200);
  const editable = preview.json.layers.find(item => item.editable_text === true);
  const benefit = done.deliverables.find(item => item.deliverable_id === 'benefit');
  const oldVersionId = benefit.active_version_id;

  const edited = await req(textEditsRoute(run.id), {
    method: 'POST', body: { edits: [{ id: editable.id, text: '舒缓维稳 持久水润' }] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.report.decision, 'blocked');
  assert.equal(edited.json.activated, false);
  assert.equal(edited.json.version.active, false);
  assert.equal(provider._submitCount(), submits, '评估不通过也不得重调模型');

  const after = (await req(`/api/runs/${run.id}`)).json.run;
  assert.equal(after.deliverables.find(item => item.deliverable_id === 'benefit').active_version_id,
    oldVersionId, 'blocked 修改不得替换当前选用版本');
  assert.equal(after.quality_status, 'blocked');

  // 未通过不能被"满意标记"放行：硬失败不是 unknown，人工复核直接拒绝
  const bypass = await req(`/api/quality-reports/${edited.json.report.id}/reviews`, {
    method: 'POST',
    body: { decisions: [{ code: 'OCR_CRITICAL_TEXT', decision: 'pass', reason: '尝试直接放行', evidence: edited.json.report.id }] },
  });
  assert.equal(bypass.status, 422, JSON.stringify(bypass.json));
  assert.equal(bypass.json.error, 'REVIEW_NOT_ADJUDICABLE');

  const exported = await req(`/api/runs/${run.id}/exports`, { method: 'POST', body: { scope: 'complete' } });
  assert.equal(exported.status, 409, '存在硬失败版本时导出必须被拦截');
});

// ---------- 5. legacy 版本：没有文字层时明确不支持 ----------

const DEMO_TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'tester_m13') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

function demoRequest(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buffer.toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: buffer, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function setupDemo(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm13-demo-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: DEMO_TENANTS,
    initialCredits: 400, tickMs: 5, attemptTimeoutMs: 30_000, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return port;
}

test('M13 legacy 版本：演示计价产物没有文字层，修改被明确拒绝（TEXT_LAYER_MISSING）', async t => {
  const port = await setupDemo(t, { provider: createDemoFixture() });

  const project = (await demoRequest(port, '/api/projects', {
    method: 'POST', headers: as(), body: { name: 'M13 演示', sku: 'M13-D', category: '面霜', platform: '天猫' },
  })).json.project;
  const asset = await demoRequest(port, `/api/projects/${project.id}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' },
    body: encodeRgbPng(64, 64, Buffer.alloc(64 * 64 * 3, 200)),
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));
  const truth = await demoRequest(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(),
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
  const preview = await demoRequest(port, `/api/projects/${project.id}/specs/preview`, {
    method: 'POST', headers: as(), body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await demoRequest(port, `/api/projects/${project.id}/specs`, {
    method: 'POST', headers: as(),
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  const quote = await demoRequest(port, '/api/quotes', {
    method: 'POST', headers: as(), body: { project_id: project.id },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const created = await demoRequest(port, '/api/runs', {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'm13-legacy' },
    body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;

  let done = null;
  for (let i = 0; i < 600; i += 1) {
    done = (await demoRequest(port, `/api/runs/${runId}`, { headers: as() })).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(done.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(done.status, 'completed', JSON.stringify(done));

  // 演示计价走 legacy 路径：版本没有冻结文字层
  const previewResponse = await demoRequest(port, textLayersRoute(runId), { headers: as() });
  assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.json));
  assert.equal(previewResponse.json.overlay_base_hash, null);
  assert.deepEqual(previewResponse.json.layers, []);

  const attempt = await demoRequest(port, textEditsRoute(runId), {
    method: 'POST', headers: as(), body: { edits: [{ id: 'layer_1', text: 'x' }] },
  });
  assert.equal(attempt.status, 409, JSON.stringify(attempt.json));
  assert.equal(attempt.json.error, 'TEXT_LAYER_MISSING');

  // 跨租户 404
  const cross = await demoRequest(port, textLayersRoute(runId), { headers: as('tenant_demo') });
  assert.equal(cross.status, 404);
  const crossEdit = await demoRequest(port, textEditsRoute(runId), {
    method: 'POST', headers: as('tenant_demo'), body: { edits: [{ id: 'layer_1', text: 'x' }] },
  });
  assert.equal(crossEdit.status, 404);
});

// 供临时探针脚本复用（测试文件本身不导入）
export { createSizeFixture, setupSession, startFinishedRun, waitTerminal };
