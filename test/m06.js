/**
 * M06 测试：主体掩码与本地合成、参考图职责、能力闸口、真实 Adapter 契约与生成记录。
 *
 * 两类证据分开：
 * - 纯函数/Adapter 单测：确定性，不依赖任何外部服务；
 * - 端到端：模拟 Provider 跑通"掩码 → 调用 → 记录"，注入真实 Adapter 只验证
 *   契约、拒绝路径与记录字段，**不代表真实模型已验收**。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import {
  MASK_VERSION, buildReferencePlan, checkReferenceCapacity, checkSubjectProtection,
  compositeSubject, createSubjectMask, decodePng, encodeMaskPng, encodeRgbPng,
} from '../src/m06.mjs';
import {
  createSeedreamProvider, SEEDREAM_ADAPTER_VERSION, SEEDREAM_PROVIDER_ID,
} from '../src/providers/seedream.mjs';
import { createProviderFromEnv } from '../src/providers/index.mjs';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'tester_m06') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 测试用图：真实可解码 PNG（不是只有头的假 PNG） ----------

const isSubjectPixel = (x, y, width, height) =>
  x >= width * 0.3 && x < width * 0.7 && y >= height * 0.25 && y < height * 0.75;

/** 白底 + 中央色块的"商品照"，边界颜色与主体色差足够大。 */
function subjectPng(width = 160, height = 160) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const subject = isSubjectPixel(x, y, width, height);
      pixels[index] = subject ? 198 : 246;
      pixels[index + 1] = subject ? 36 : 246;
      pixels[index + 2] = subject ? 44 : 246;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

/** 纯色 PNG：主体占比为 100%，用于验证退化检测。 */
function solidPng(width = 64, height = 64) {
  const pixels = Buffer.alloc(width * height * 3, 128);
  return encodeRgbPng(width, height, pixels);
}

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
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

async function start(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm06-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 240, tickMs: 8, attemptTimeoutMs: 30_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

async function readyProject(port, tenant = 'tenant_a') {
  const created = await request(port, '/api/projects', {
    method: 'POST', headers: as(tenant),
    body: { name: 'M06 面霜', sku: 'M06-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const project = created.json.project;

  const asset = await request(port, `/api/projects/${project.id}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': 'image/png' }, body: subjectPng(),
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));

  const truth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(tenant),
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

  const preview = await request(port, `/api/projects/${project.id}/specs/preview`, {
    method: 'POST', headers: as(tenant), body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${project.id}/specs`, {
    method: 'POST', headers: as(tenant),
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  return { project, spec: frozen.json.spec };
}

async function startRun(port, { projectId, key, tenant = 'tenant_a' }) {
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(tenant), body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  return request(port, '/api/runs', {
    method: 'POST',
    headers: { ...as(tenant), 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
}

async function waitTerminal(port, runId, tenant = 'tenant_a', timeoutMs = 15_000) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeoutMs) {
    const response = await request(port, `/api/runs/${runId}`, { headers: as(tenant) });
    snapshot = response.json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`任务未进入终态，最后状态 ${snapshot?.status}`);
}

/** 假 fetch：按需返回成功或内容拒绝，验证 Adapter 的解析与错误映射。 */
function fakeFetch({ mode = 'success', imageBytes, requestId = 'req_fake_001' } = {}) {
  return async (url, options) => {
    if (mode === 'reject') {
      return {
        ok: false,
        status: 400,
        headers: { get: () => requestId },
        text: async () => JSON.stringify({ error: { message: 'content policy violation: sensitive logo' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: name => (name.toLowerCase() === 'x-request-id' ? requestId : null) },
      text: async () => JSON.stringify({
        id: 'resp_fake_001',
        data: [{ b64_json: imageBytes.toString('base64') }],
        usage: { generated_images: 1, output_tokens: 4160, total_tokens: 4160 },
      }),
      arrayBuffer: async () => imageBytes,
    };
  };
}

// ---------- 1. PNG 解码与掩码 ----------

test('M06 PNG：自产 PNG 可解码，掩码与去背图可还原，主体占比合理', () => {
  const source = subjectPng(160, 160);
  const decoded = decodePng(source);
  assert.ok(decoded, '自产 PNG 必须可解码');
  assert.equal(decoded.width, 160);
  assert.equal(decoded.height, 160);
  assert.equal(decoded.pixels.length, 160 * 160 * 4);

  const mask = createSubjectMask({ bytes: source, mime: 'image/png' });
  assert.equal(mask.available, true, JSON.stringify(mask));
  assert.equal(mask.method, 'border_color_keying');
  assert.ok(mask.coverage > 0.1 && mask.coverage < 0.3, `主体占比异常：${mask.coverage}`);
  assert.match(mask.sha256, /^[0-9a-f]{64}$/);
  assert.match(mask.cutout_sha256, /^[0-9a-f]{64}$/);

  const decodedMask = decodePng(mask.maskBytes);
  assert.ok(decodedMask);
  assert.equal(decodedMask.pixels[0], 0, '左上角应为背景');
  const center = (80 * 160 + 80) * 4;
  assert.equal(decodedMask.pixels[center], 255, '中心应为主体');
});

test('M06 掩码不可用：非 PNG、损坏 PNG、纯色退化都必须明确返回原因', () => {
  assert.equal(createSubjectMask({ bytes: subjectPng(), mime: 'image/jpeg' }).reason, 'MASK_SOURCE_UNSUPPORTED_FORMAT');
  const broken = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(broken, 0);
  assert.equal(createSubjectMask({ bytes: broken, mime: 'image/png' }).reason, 'MASK_SOURCE_UNDECODABLE');
  const degenerate = createSubjectMask({ bytes: solidPng(), mime: 'image/png' });
  assert.equal(degenerate.available, false);
  assert.equal(degenerate.reason, 'MASK_DEGENERATE');
});

// ---------- 2. 本地合成 ----------

test('M06 本地合成：只替换掩码内像素，掩码外保持生成图原样', () => {
  const width = 120;
  const height = 120;
  const outputPixels = Buffer.alloc(width * height * 3, 90);
  const output = encodeRgbPng(width, height, outputPixels);
  const cutoutPixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    cutoutPixels[index * 3] = 10; cutoutPixels[index * 3 + 1] = 200; cutoutPixels[index * 3 + 2] = 30;
  }
  const cutout = encodeRgbPng(width, height, cutoutPixels);
  const maskBytes = encodeMaskPng(width, height, index => {
    const x = index % width;
    const y = Math.floor(index / width);
    return x >= 40 && x < 80 && y >= 40 && y < 80;
  });

  const composed = compositeSubject({ outputBytes: output, cutoutBytes: cutout, maskBytes });
  assert.equal(composed.available, true);
  assert.equal(composed.applied, true, JSON.stringify(composed));
  assert.equal(composed.meta.replaced_pixels, 40 * 40);
  assert.equal(composed.meta.alignment_verified, false, '未做检测配准，必须如实标 false');

  const decoded = decodePng(composed.bytes);
  const outside = (10 * width + 10) * 4;
  assert.deepEqual([decoded.pixels[outside], decoded.pixels[outside + 1], decoded.pixels[outside + 2]], [90, 90, 90]);
  const inside = (60 * width + 60) * 4;
  assert.deepEqual([decoded.pixels[inside], decoded.pixels[inside + 1], decoded.pixels[inside + 2]], [10, 200, 30]);
});

test('M06 本地合成拒绝非 PNG 输出，不猜测像素', () => {
  const result = compositeSubject({
    outputBytes: Buffer.from('not-a-png'),
    cutoutBytes: subjectPng(), maskBytes: encodeMaskPng(8, 8, () => true),
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'OUTPUT_NOT_PNG');
});

// ---------- 3. 参考图职责与能力闸口 ----------

test('M06 参考图职责：顺序固定、主体与包装优先、超出容量明确记录 dropped', () => {
  const subject = { id: 'ast_1', sha256: 'a'.repeat(64), ext: 'png', mime: 'image/png', width: 10, height: 10 };
  const packaging = { id: 'ast_2', sha256: 'b'.repeat(64), ext: 'png', mime: 'image/png', width: 10, height: 10 };
  const styles = [
    { id: 'ast_3', sha256: 'c'.repeat(64), ext: 'png', mime: 'image/png', width: 10, height: 10 },
    { id: 'ast_4', sha256: 'd'.repeat(64), ext: 'png', mime: 'image/png', width: 10, height: 10 },
  ];
  const plan = buildReferencePlan({ subjectAsset: subject, packagingAsset: packaging, styleAssets: styles, cutoutSha256: 'e'.repeat(64), maxReferences: 3 });
  assert.deepEqual(plan.references.map(item => item.role), ['product_subject', 'product_packaging', 'style_reference', 'subject_cutout']);
  assert.deepEqual(plan.references.map(item => item.index), [1, 2, 3, 4]);
  assert.equal(plan.references.at(-1).sent_to_provider, false, '去背图只用于本地合成，不得发送给供应商');
  assert.equal(plan.dropped.length, 1);
  assert.equal(plan.capacity_exceeded, false);
  assert.equal(checkReferenceCapacity({ capabilities: { max_references: 3 }, plan }).ok, true);

  const tight = buildReferencePlan({ subjectAsset: subject, packagingAsset: packaging, styleAssets: styles, maxReferences: 1 });
  assert.equal(tight.capacity_exceeded, true);
  const gate = checkReferenceCapacity({ capabilities: { max_references: 1 }, plan: tight });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'UNSUPPORTED_CAPABILITY');
});

test('M06 主体保护闸口：真实 Provider 无能力必须拒绝，模拟可降级但必须带警告', () => {
  const mask = createSubjectMask({ bytes: subjectPng(), mime: 'image/png' });
  const realNoCap = { id: 'seedream', simulated: false, supports_mask: false, supports_post_composite: false };
  const rejected = checkSubjectProtection({ capabilities: realNoCap, protection: mask, required: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'UNSUPPORTED_CAPABILITY');

  const realMask = checkSubjectProtection({
    capabilities: { ...realNoCap, supports_mask: true }, protection: mask, required: true,
  });
  assert.equal(realMask.ok, true);
  assert.equal(realMask.mode, 'mask');

  const realComposite = checkSubjectProtection({
    capabilities: { ...realNoCap, supports_post_composite: true }, protection: mask, required: true,
  });
  assert.equal(realComposite.ok, true);
  assert.equal(realComposite.mode, 'composite');

  const missing = { available: false, reason: 'MASK_DEGENERATE' };
  const simulated = checkSubjectProtection({
    capabilities: { id: 'deterministic-mock', simulated: true, supports_mask: true },
    protection: missing, required: true,
  });
  assert.equal(simulated.ok, true);
  assert.equal(simulated.mode, 'simulated_fallback');
  assert.match(simulated.warning, /降级/u);

  const realMissing = checkSubjectProtection({ capabilities: realNoCap, protection: missing, required: true });
  assert.equal(realMissing.ok, false);
  const realMissingWithMask = checkSubjectProtection({
    capabilities: { ...realNoCap, supports_mask: true }, protection: missing, required: true,
  });
  assert.equal(realMissingWithMask.ok, false, '掩码不可用时即使声明支持掩码也必须拒绝');
});

// ---------- 4. 真实 Adapter 契约 ----------

test('M06 Seedream Adapter：缺密钥构造即失败，绝不回落到模拟', () => {
  assert.throws(() => createSeedreamProvider({ apiKey: '' }), /缺少密钥/u);
  assert.throws(() => createSeedreamProvider({}), /缺少密钥/u);
  const resolved = createProviderFromEnv({ QTB_PROVIDER: 'mock' });
  assert.equal(resolved.mode, 'mock');
  assert.equal(resolved.acceptance, 'simulated_only');
  assert.throws(() => createProviderFromEnv({ QTB_PROVIDER: 'seedream' }), /缺少 PARATERA_API_KEY/u);
  assert.throws(() => createProviderFromEnv({ QTB_PROVIDER: 'unknown' }), /配置无效/u);
});

test('M06 Seedream Adapter：能力如实声明，主体保护校验拒绝无掩码请求', () => {
  const provider = createSeedreamProvider({ apiKey: 'test-key', fetchImpl: fakeFetch({ imageBytes: subjectPng() }) });
  const capabilities = provider.capabilities();
  assert.equal(capabilities.id, SEEDREAM_PROVIDER_ID);
  assert.equal(capabilities.version, SEEDREAM_ADAPTER_VERSION);
  assert.equal(capabilities.simulated, false);
  assert.equal(capabilities.acceptance, 'not_verified');
  assert.equal(capabilities.supports_mask, false);
  assert.equal(capabilities.supports_post_composite, false);

  const request = {
    request_hash: 'hash-1', target_width: 1024, target_height: 1024, references: 1,
    requires_subject_protection: true, mask_ref: 'mask:verified:abc',
  };
  assert.equal(provider.validate(request).ok, false, '未声明能力时必须拒绝');
  assert.equal(provider.validate(request).code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(provider.validate({ ...request, mask_ref: null }).ok, false);
  assert.equal(provider.validate({ ...request, target_width: 9000, mask_ref: null, requires_subject_protection: false }).code, 'UNSUPPORTED_CAPABILITY');

  const capable = createSeedreamProvider({
    apiKey: 'test-key', fetchImpl: fakeFetch({ imageBytes: subjectPng() }), supportsPostComposite: true,
  });
  assert.equal(capable.validate(request).ok, true);
});

test('M06 Seedream Adapter：真实调用解析模型、用量、时延、请求 id 与输出哈希', async () => {
  const imageBytes = subjectPng(96, 96);
  const provider = createSeedreamProvider({
    apiKey: 'test-key', model: 'Doubao-Seedream-4.0', fetchImpl: fakeFetch({ imageBytes, requestId: 'req_ok_9' }),
  });
  const request = {
    request_hash: 'hash-2', idempotency_key: 'sub:run:item:1',
    target_width: 96, target_height: 96, references: 0, prompt: '生成商品图',
  };
  const handle = provider.submit(request);
  assert.equal(handle.provider_meta.simulated, false);
  const state = provider._jobs.get('sub:run:item:1');
  await state.settled;

  const polled = provider.poll(handle);
  assert.equal(polled.status, 'succeeded', JSON.stringify(polled));
  const result = polled.result;
  assert.equal(result.model, 'Doubao-Seedream-4.0');
  assert.equal(result.provider_request_id, 'req_ok_9');
  assert.equal(result.usage.output_tokens, 4160);
  assert.equal(result.output.format, 'png');
  assert.equal(result.output.width, 96);
  assert.match(result.output.sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.latency_ms >= 0);
  assert.equal(result.provider_meta.acceptance, 'not_verified');
});

test('M06 Seedream Adapter：内容策略拒绝映射为 CONTENT_REJECTED 且不可重试', async () => {
  const provider = createSeedreamProvider({ apiKey: 'test-key', fetchImpl: fakeFetch({ mode: 'reject' }) });
  const request = { request_hash: 'hash-3', idempotency_key: 'sub:run:item:reject', target_width: 512, target_height: 512, references: 0 };
  const handle = provider.submit(request);
  await provider._jobs.get('sub:run:item:reject').settled;
  const polled = provider.poll(handle);
  assert.equal(polled.status, 'failed');
  assert.equal(polled.code, 'CONTENT_REJECTED');
  assert.equal(polled.retryable, false);
});

// ---------- 5. 端到端：模拟 Provider 走完整主体保护与记录 ----------

test('M06 端到端（模拟）：掩码生成、参考职责、能力查询与生成记录齐全', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);

  const created = await startRun(port, { projectId: project.id, key: 'm06-mock-1' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;
  const terminal = await waitTerminal(port, runId);
  assert.equal(terminal.status, 'completed', JSON.stringify(terminal.terminal_reason));
  assert.equal(terminal.subject_protection.mode, 'mask');
  assert.match(terminal.subject_context.mask_ref, /^mask:verified:[0-9a-f]{64}$/);
  assert.equal(terminal.subject_context.references[0].role, 'product_subject');

  const capabilities = await request(port, '/api/provider/capabilities', { headers: as() });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.json.mode, 'mock');
  assert.equal(capabilities.json.acceptance, 'simulated_only');

  const records = await request(port, `/api/runs/${runId}/generation-records`, { headers: as() });
  assert.equal(records.status, 200, JSON.stringify(records.json));
  assert.ok(records.json.records.length >= 1);
  const record = records.json.records[0];
  assert.equal(record.status, 'succeeded');
  assert.equal(record.provider, 'deterministic-mock');
  assert.equal(record.provider_meta.simulated, true);
  assert.equal(record.provider_meta.acceptance, 'simulated_only');
  assert.equal(record.mask_version, MASK_VERSION);
  assert.ok(record.mask_version);
  assert.equal(record.subject_protection.mode, 'mask');
  assert.equal(record.subject_protection.mask.verified, true);
  assert.match(record.subject_protection.mask.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.subject_protection.references[0].role, 'product_subject');
  assert.equal(record.usage.images, 1);
  assert.equal(record.cost.billing_unit, 'internal_credit');
  assert.ok(Number.isFinite(record.latency_ms));
  assert.match(record.output.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.format_contract.satisfied, record.format_contract.requested.includes(record.format_contract.actual));
  assert.ok(['png', 'jpg', 'webp'].includes(record.format_contract.actual));

  const single = await request(port, `/api/generation-records/${record.id}`, { headers: as() });
  assert.equal(single.status, 200);
  assert.equal(single.json.record.run_id, runId);

  // 跨租户必须 404，绝不暴露记录是否存在
  const cross = await request(port, `/api/generation-records/${record.id}`, { headers: as('tenant_demo') });
  assert.equal(cross.status, 404);
});

// ---------- 6. 端到端：真实 Adapter 能力拒绝与真实调用记录 ----------

test('M06 端到端（真实 Adapter）：未声明能力时创建阶段 422 拒绝，不入队也不收费', async t => {
  const provider = createSeedreamProvider({ apiKey: 'test-key', fetchImpl: fakeFetch({ imageBytes: subjectPng() }) });
  const { port } = await start(t, { provider });
  const { project } = await readyProject(port);

  const before = await request(port, '/api/credits', { headers: as() });
  const balanceBefore = before.json.balance.available;
  const rejected = await startRun(port, { projectId: project.id, key: 'm06-real-reject' });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.json));
  assert.equal(rejected.json.error, 'UNSUPPORTED_CAPABILITY');

  const after = await request(port, '/api/credits', { headers: as() });
  assert.equal(after.json.balance.available, balanceBefore, '拒绝发生在预留之前，余额不得变化');

  const runs = await request(port, `/api/runs?project_id=${project.id}`, { headers: as() });
  assert.equal(runs.json.runs.length, 0, '被拒绝的请求不得留下任务');

  const capabilities = await request(port, '/api/provider/capabilities', { headers: as() });
  assert.equal(capabilities.json.mode, 'injected');
  assert.equal(capabilities.json.capabilities.acceptance, 'not_verified');
});

test('M06 端到端（真实 Adapter）：通过本地主体合成走真实契约，记录明确标未验收', async t => {
  const imageBytes = subjectPng(96, 96);
  const provider = createSeedreamProvider({
    apiKey: 'test-key', model: 'Doubao-Seedream-4.0', supportsPostComposite: true,
    fetchImpl: fakeFetch({ imageBytes, requestId: 'req_e2e_7' }),
  });
  const { port } = await start(t, { provider });
  const { project } = await readyProject(port);

  const created = await startRun(port, { projectId: project.id, key: 'm06-real-ok' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;
  const terminal = await waitTerminal(port, runId, 'tenant_a', 25_000);
  assert.equal(terminal.status, 'completed', JSON.stringify(terminal));

  const records = await request(port, `/api/runs/${runId}/generation-records`, { headers: as() });
  const record = records.json.records[0];
  assert.equal(record.provider, 'seedream');
  assert.equal(record.provider_meta.simulated, false);
  assert.equal(record.provider_meta.acceptance, 'not_verified');
  assert.equal(record.model, 'Doubao-Seedream-4.0');
  assert.equal(record.provider_request_id, 'req_e2e_7');
  assert.equal(record.usage.output_tokens, 4160);
  assert.equal(record.cost.billing_unit, 'provider_token');
  assert.match(record.output.sha256, /^[0-9a-f]{64}$/);
});
