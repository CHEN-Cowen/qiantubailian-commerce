/**
 * 阶段 5：套图 manifest 与跨图规则检查。
 *
 * 验证目标：单图质量门槛先行；跨图事实/品牌/重复/缺失可确定性判定；
 * 外观一致性无法确定性证明时保留 unknown，绝不冒充通过。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { buildSuiteManifest } from '../src/suite.mjs';

const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const as = (tenant = 'tenant_a') => ({ 'x-tenant-id': tenant, 'x-actor-id': 'tester_ai06' });

const report = (id, decision = 'publishable') => ({ id, decision, checks: [] });
const currentValidity = id => ({ [id]: { validity: 'current', reasons: [] } });

function versionRecord(id, deliverableId, hash, extra = {}) {
  return {
    id,
    deliverable_id: deliverableId,
    active: true,
    report_id: `rep_${id}`,
    hash,
    format: 'png',
    width: 800,
    height: 800,
    text_layers: [],
    ...extra,
  };
}

test('P5 套图：单图版本/报告齐全且无未知项时可判定可交付', () => {
  const manifest = buildSuiteManifest({
    run: { id: 'run_1', tenant_id: 'tenant_a', project_id: 'p1', deliverables: [{ deliverable_id: 'd1', label: '主图' }] },
    versions: [versionRecord('v1', 'd1', 'hash_a')],
    reports: { rep_v1: report('rep_v1') },
    validities: currentValidity('rep_v1'),
    dependencies: [{
      run_id: 'run_1', deliverable_id: 'd1', version_id: 'v1',
      entries: [
        { kind: 'fact', ref: '容量', evidence: 'deterministic' },
        { kind: 'brand', ref: 'brand_x', evidence: 'deterministic', source_version: { brand_kit_version: 1 } },
      ],
    }],
    truth: { version: 1, facts: [{ key: '容量', value: '50g', critical: true }] },
  });
  assert.equal(manifest.decision, 'publishable');
  assert.equal(manifest.counts.images, 1);
  assert.equal(manifest.counts.fail, 0);
  assert.equal(manifest.checks.filter(item => item.status === 'unknown').length, 0);
  assert.ok(manifest.suite_id.startsWith('suite_'));
});

test('P5 套图：重复输出直接阻断，不能把复制图当多图交付', () => {
  const manifest = buildSuiteManifest({
    run: { id: 'run_2', deliverables: [{ deliverable_id: 'd1' }, { deliverable_id: 'd2' }] },
    versions: [
      versionRecord('v1', 'd1', 'same_hash'),
      versionRecord('v2', 'd2', 'same_hash'),
    ],
    reports: { rep_v1: report('rep_v1'), rep_v2: report('rep_v2') },
    validities: { ...currentValidity('rep_v1'), ...currentValidity('rep_v2') },
  });
  assert.equal(manifest.decision, 'blocked');
  assert.ok(manifest.checks.some(item => item.code === 'SUITE_DUPLICATE_IMAGE' && item.status === 'fail'));
  assert.equal(manifest.missing.some(item => item.reason === 'DUPLICATE_IMAGE'), true);
});

test('P5 套图：同一事实在两张图上的文字不一致 → 跨图事实冲突阻断', () => {
  const manifest = buildSuiteManifest({
    run: { id: 'run_3', deliverables: [{ deliverable_id: 'd1' }, { deliverable_id: 'd2' }] },
    versions: [
      versionRecord('v1', 'd1', 'hash_a', {
        text_layers: [{ id: 't1', source: 'fact', fact_key: '容量', text: '50g' }],
      }),
      versionRecord('v2', 'd2', 'hash_b', {
        text_layers: [{ id: 't2', source: 'fact', fact_key: '容量', text: '60g' }],
      }),
    ],
    reports: { rep_v1: report('rep_v1'), rep_v2: report('rep_v2') },
    validities: { ...currentValidity('rep_v1'), ...currentValidity('rep_v2') },
  });
  assert.equal(manifest.decision, 'blocked');
  const conflict = manifest.checks.find(item => item.code === 'SUITE_FACT_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.fact_key, '容量');
  assert.deepEqual(conflict.values.sort(), ['50g', '60g']);
});

test('P5 套图：报告失效或缺报告的单图不得进入可交付套图', () => {
  const stale = buildSuiteManifest({
    run: { id: 'run_4', deliverables: [{ deliverable_id: 'd1' }] },
    versions: [versionRecord('v1', 'd1', 'hash_a')],
    reports: { rep_v1: report('rep_v1') },
    validities: { rep_v1: { validity: 'stale', reasons: ['事实版本已更新'] } },
  });
  assert.equal(stale.decision, 'blocked');
  assert.equal(stale.checks.find(item => item.code === 'SUITE_REPORT_STALE').status, 'fail');
  assert.equal(stale.missing.some(item => item.reason === 'REPORT_STALE'), true);

  const missing = buildSuiteManifest({
    run: { id: 'run_5', deliverables: [{ deliverable_id: 'd1' }] },
    versions: [versionRecord('v1', 'd1', 'hash_a')],
    reports: {},
    validities: {},
  });
  assert.equal(missing.decision, 'blocked');
  assert.equal(missing.checks.find(item => item.code === 'SUITE_REPORT_MISSING').status, 'fail');
});

test('P5 套图：缺图或缺选用版本 → 阻断并列出缺失项', () => {
  const manifest = buildSuiteManifest({
    run: {
      id: 'run_6',
      deliverables: [
        { deliverable_id: 'd1', label: '主图' },
        { deliverable_id: 'd2', label: '场景图' },
      ],
    },
    versions: [versionRecord('v1', 'd1', 'hash_a')],
    reports: { rep_v1: report('rep_v1') },
    validities: currentValidity('rep_v1'),
  });
  assert.equal(manifest.decision, 'blocked');
  assert.equal(manifest.counts.images, 1);
  assert.equal(manifest.missing[0].reason, 'NO_ACTIVE_VERSION');
  assert.equal(manifest.missing[0].deliverable_id, 'd2');
  assert.ok(manifest.checks.some(item => item.code === 'SUITE_IMAGE_MISSING'));
});

test('P5 套图：关键事实未出现在任何图 → 待人工确认，不算通过', () => {
  const manifest = buildSuiteManifest({
    run: { id: 'run_7', deliverables: [{ deliverable_id: 'd1' }] },
    versions: [versionRecord('v1', 'd1', 'hash_a')],
    reports: { rep_v1: report('rep_v1') },
    validities: currentValidity('rep_v1'),
    truth: { version: 2, facts: [{ key: '容量', value: '50g', critical: true }] },
  });
  assert.equal(manifest.decision, 'needs_review');
  const check = manifest.checks.find(item => item.code === 'SUITE_CRITICAL_FACT_MISSING');
  assert.equal(check.status, 'unknown');
  assert.deepEqual(check.fact_keys, ['容量']);
});

test('P5 套图：跨图外观一致性只能标 unknown，不能因为多图就自动通过', () => {
  const manifest = buildSuiteManifest({
    run: { id: 'run_8', deliverables: [{ deliverable_id: 'd1' }, { deliverable_id: 'd2' }] },
    versions: [
      versionRecord('v1', 'd1', 'hash_a'),
      versionRecord('v2', 'd2', 'hash_b'),
    ],
    reports: { rep_v1: report('rep_v1'), rep_v2: report('rep_v2') },
    validities: { ...currentValidity('rep_v1'), ...currentValidity('rep_v2') },
  });
  assert.equal(manifest.decision, 'needs_review');
  assert.equal(manifest.checks.find(item => item.code === 'SUITE_APPEARANCE_UNVERIFIED').status, 'unknown');
  assert.notEqual(manifest.decision, 'publishable');
});

// ---------- HTTP 集成 ----------

function gradientPng(width, height, seed = 0) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = (x * 3 + y * 2 + seed) % 256;
      pixels[index + 1] = (y * 5 + x + seed * 2) % 256;
      pixels[index + 2] = (x * 7 + y * 3 + seed * 3) % 256;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

const isSubjectPixel = (x, y, width, height) =>
  x >= width * 0.3 && x < width * 0.7 && y >= height * 0.25 && y < height * 0.75;

function subjectPng(width = 64, height = 64) {
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

function createValidProvider() {
  const capabilities = () => ({
    id: 'p5-fixture', version: 'fixture.1', image: true, video: false,
    max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
    supports_seed: true, supports_revision: true, max_side: 2048, formats: ['jpg', 'png'],
    simulated: true, acceptance: 'simulated_only',
  });
  const cache = new Map();
  const jobs = new Map();
  let sequence = 0;
  const submitted = [];
  function handle(job) {
    return {
      provider_job_id: job.provider_job_id, status: 'queued', request_hash: job.request.request_hash,
      idempotency_key: job.request.idempotency_key, provider_meta: { simulated: true },
    };
  }
  return {
    capabilities,
    validate: () => ({ ok: true }),
    estimate: () => ({ price_version: 'fixture.1', estimated_credits: 1, max_credits: null }),
    submit: request => {
      submitted.push(request.idempotency_key);
      if (jobs.has(request.idempotency_key)) return handle(jobs.get(request.idempotency_key));
      sequence += 1;
      const job = { request, provider_job_id: `p5_${sequence}`, polls: 0 };
      jobs.set(request.idempotency_key, job);
      return handle(job);
    },
    poll: handleArg => {
      const job = [...jobs.values()].find(item => item.provider_job_id === handleArg.provider_job_id);
      if (!job) return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
      job.polls += 1;
      if (job.polls < 2) return { status: 'queued' };
      const { request } = job;
      const width = request.target_width;
      const height = request.target_height;
      const format = (request.formats ?? ['png']).includes('png') ? 'png' : 'jpg';
      const key = `${width}x${height}:${format}:${request.deliverable_id}`;
      if (!cache.has(key)) {
        const seed = [...String(request.deliverable_id)]
          .reduce((sum, char) => sum + char.charCodeAt(0), 0) % 251;
        cache.set(key, gradientPng(width, height, seed));
      }
      const bytes = cache.get(key);
      return {
        status: 'succeeded',
        result: {
          provider: 'p5-fixture', model: 'fixture/image', model_version: 'fixture.1',
          provider_job_id: request.idempotency_key,
          provider_request_id: `req_${request.request_hash.slice(0, 12)}`,
          usage: { images: 1, unit: 'image' },
          cost: { amount: 0, currency: 'internal_demo' },
          latency_ms: 10,
          output: { format, bytes, width, height, sha256: createHash('sha256').update(bytes).digest('hex') },
        },
      };
    },
    cancel: () => ({ status: 'cancelled' }),
    normalizeResult: () => null,
    submitted,
  };
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
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readyProject(port) {
  const created = await request(port, '/api/projects', {
    method: 'POST', headers: as(),
    body: { name: 'P5 套图面霜', sku: 'P5-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const project = created.json.project;
  const asset = await request(port, `/api/projects/${project.id}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' }, body: subjectPng(),
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));
  const truth = await request(port, `/api/projects/${project.id}/truth-versions`, {
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
  const preview = await request(port, `/api/projects/${project.id}/specs/preview`, {
    method: 'POST', headers: as(), body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${project.id}/specs`, {
    method: 'POST', headers: as(),
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  return { project, truthVersion: truth.json.truth_version.version };
}

async function waitTerminal(port, runId, tenant = 'tenant_a') {
  const terminal = new Set(['completed', 'limit_reached', 'failed', 'cancelled', 'needs_attention']);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const response = await request(port, `/api/runs/${runId}`, { headers: as(tenant) });
    const run = response.json?.run ?? null;
    if (run && terminal.has(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('等待任务终态超时');
}

test('P5 套图 API：任务级 manifest 保留单图门槛与跨图未知项，跨租户不可见', async t => {
  const provider = createValidProvider();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai06-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS, initialCredits: 240,
    tickMs: 5, attemptTimeoutMs: 30_000, provider, allowScenarioInjection: false,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  const { project, truthVersion } = await readyProject(port);
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(), body: { project_id: project.id },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const created = await request(port, '/api/runs', {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'p5-suite' },
    body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const run = await waitTerminal(port, created.json.run.id);

  const suite = await request(port, `/api/runs/${run.id}/suite`, { headers: as() });
  assert.equal(suite.status, 200, JSON.stringify(suite.json));
  const manifest = suite.json;
  assert.equal(manifest.suite_format, 'qtb-suite-manifest.1');
  assert.equal(manifest.run_id, run.id);
  assert.equal(manifest.counts.images, run.deliverables.filter(item => item.status === 'succeeded').length);
  assert.ok(manifest.images.every(item => item.report_validity === 'current'));
  assert.equal(manifest.checks.some(item => item.code === 'SUITE_DUPLICATE_IMAGE'), false);
  assert.equal(manifest.checks.find(item => item.code === 'SUITE_APPEARANCE_UNVERIFIED').status, 'unknown');
  assert.notEqual(manifest.decision, 'publishable', '外观一致性未知时不得直接标可交付');

  const crossTenant = await request(port, `/api/runs/${run.id}/suite`, { headers: as('tenant_b') });
  assert.equal(crossTenant.status, 404, '跨租户不得读取套图清单');

  // P5：执行中再次变更 → 预览暴露阻塞单，确认硬拒，避免同一批图片被两份变更重复处理
  const changeBody = facts => ({
    base_truth_version: truthVersion, confirm: true,
    facts: [
      ...facts,
      { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
    ],
    critical_text: [{ text: '月光舒缓' }],
  });
  const firstChange = await request(port, `/api/projects/${project.id}/changes`, {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'p5-change-a' },
    body: changeBody([{ key: '容量', value: '60g', critical: true, confirmed: true, source_type: 'user_input' }]),
  });
  assert.equal(firstChange.status, 201, JSON.stringify(firstChange.json));
  assert.equal(firstChange.json.change.status, 'confirmed');

  const previewB = await request(port, `/api/projects/${project.id}/changes/preview`, {
    method: 'POST', headers: as(),
    body: changeBody([{ key: '容量', value: '70g', critical: true, confirmed: true, source_type: 'user_input' }]),
  });
  assert.equal(previewB.status, 200, JSON.stringify(previewB.json));
  assert.equal(previewB.json.can_confirm, false);
  assert.equal(previewB.json.blocking_change.id, firstChange.json.change.id);

  const secondChange = await request(port, `/api/projects/${project.id}/changes`, {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'p5-change-b' },
    body: {
      ...changeBody([{ key: '容量', value: '70g', critical: true, confirmed: true, source_type: 'user_input' }]),
      base_truth_version: truthVersion + 1,
    },
  });
  assert.equal(secondChange.status, 409, JSON.stringify(secondChange.json));
  assert.equal(secondChange.json.error, 'CHANGE_IN_PROGRESS');
  assert.equal(secondChange.json.details.change_id, firstChange.json.change.id);
});
