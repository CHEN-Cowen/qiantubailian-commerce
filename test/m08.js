/**
 * M08 测试：自动修订、版本与正式导出。
 *
 * 覆盖三类证据：
 * 1. 纯函数：修订计划、修订结果对比、导出资格（完整/部分/失效）、ZIP 结构。
 * 2. 端到端：模拟 Provider 首轮产出损坏文件 → 自动修订修复 → 报告变为可复核 →
 *    人工复核后导出完整包 → 事实变化后导出被拒（stale）→ 版本回退与再激活。
 * 3. 停止条件：轮数触顶与连续无改善必须停，且不得把失败包装成通过。
 *
 * 注意：测试用的 JPEG 只有合法头部（用于尺寸与签名校验），没有实际扫描数据；
 * 生产环境仍只对 PNG 做像素级检查，JPEG 的颜色与内容检查会如实报 unknown。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  buildZip, compareRevisionOutcome, planExport, planRevision,
} from '../src/m08.mjs';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'tester_m08') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 测试素材 ----------

function gradientPng(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = (x * 3 + y * 2) % 256;
      pixels[index + 1] = (y * 5 + x) % 256;
      pixels[index + 2] = (x * 7 + y * 3) % 256;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

function solidPng(width, height) {
  return encodeRgbPng(width, height, Buffer.alloc(width * height * 3, 200));
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

/** 只含 SOF0 头的 JPEG，足够通过签名与尺寸校验；用于测试格式契约，不是可用图片。 */
function headerOnlyJpeg(width, height) {
  const buffer = Buffer.alloc(23);
  buffer[0] = 0xFF; buffer[1] = 0xD8;
  buffer[2] = 0xFF; buffer[3] = 0xC0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[11] = 3;
  buffer[12] = 1; buffer[13] = 0x11; buffer[14] = 0;
  buffer[15] = 2; buffer[16] = 0x11; buffer[17] = 1;
  buffer[18] = 3; buffer[19] = 0x11; buffer[20] = 1;
  buffer[21] = 0xFF; buffer[22] = 0xD9;
  return buffer;
}

/**
 * 测试专用 Provider：指定的交付物首轮返回损坏文件（触发可修复硬失败），后续返回合格图。
 * 声明 supports_revision，让 M08 的修订编排真正跑起来。
 * 默认只让一个交付物失败——报价预算有限，修订不得靠自动扩预算来完成全部重试。
 */
function createRevisionFixture({ alwaysBroken = false, brokenDeliverables = ['main'] } = {}) {
  const capabilities = () => ({
    id: 'm08-fixture', version: 'fixture.1', image: true, video: false,
    max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
    supports_seed: true, supports_revision: true, max_side: 2048, formats: ['jpg', 'png'],
    simulated: true, acceptance: 'simulated_only',
  });
  const jobs = new Map();
  const rounds = new Map();
  const cache = new Map();
  let sequence = 0;

  function submit(request) {
    sequence += 1;
    const providerJobId = `fx_${sequence}`;
    const round = (rounds.get(request.deliverable_id) ?? 0) + 1;
    rounds.set(request.deliverable_id, round);
    jobs.set(providerJobId, { request, round, polls: 0 });
    return {
      provider_job_id: providerJobId,
      status: 'queued',
      request_hash: request.request_hash,
      idempotency_key: request.idempotency_key,
      provider_meta: { id: 'm08-fixture', version: 'fixture.1', simulated: true, round },
    };
  }

  function poll(handle) {
    const job = jobs.get(handle.provider_job_id);
    if (!job) return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
    job.polls += 1;
    if (job.polls < 2) return { status: 'queued' };
    return { status: 'succeeded', result: normalizeResult(job) };
  }

  function normalizeResult(job) {
    const { request, round } = job;
    const width = request.target_width;
    const height = request.target_height;
    const format = (request.formats ?? ['png']).includes('png') ? 'png' : 'jpg';
    const broken = alwaysBroken
      || (round === 1 && (brokenDeliverables === null || brokenDeliverables.includes(request.deliverable_id)));
    let bytes;
    if (broken) {
      bytes = Buffer.from(`broken-output-${round}-${width}x${height}-${format}`, 'utf8');
    } else if (format === 'png') {
      const key = `png:${width}x${height}`;
      if (!cache.has(key)) cache.set(key, gradientPng(width, height));
      bytes = cache.get(key);
    } else {
      bytes = headerOnlyJpeg(width, height);
    }
    return {
      provider: 'm08-fixture',
      model: 'fixture/image',
      model_version: 'fixture.1',
      provider_job_id: job.request.idempotency_key,
      provider_request_id: `req_${job.request.request_hash.slice(0, 12)}`,
      usage: { images: 1, unit: 'image' },
      cost: { amount: 0, currency: 'internal_demo' },
      latency_ms: 10,
      output: {
        format,
        bytes,
        width,
        height,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  }

  return {
    capabilities,
    validate: () => ({ ok: true }),
    estimate: request => {
      const side = Math.max(request.target_width ?? 1024, request.target_height ?? 1024);
      return { price_version: 'fixture.1', estimated_credits: Math.max(1, Math.round(side * side * 0.0000045)), max_credits: null };
    },
    submit,
    poll,
    cancel: () => ({ status: 'cancelled' }),
    normalizeResult,
    _rounds: rounds,
  };
}

// ---------- HTTP 辅助 ----------

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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm08-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    // 超时只作安全上限：测试用仿真 Provider 秒回，2s 在满负载并行跑测时会被误判成
    // PROVIDER_TIMEOUT，触发一次"非修订"重试，导致修订历史为空（偶发失败）。这里用产品默认值。
    initialCredits: 400, tickMs: 5, attemptTimeoutMs: 30_000,
    revisionMaxRounds: 6, allowScenarioInjection: false, ...options,
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
    body: { name: 'M08 面霜', sku: 'M08-01', category: '面霜', platform: '天猫' },
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
  return { project, spec: frozen.json.spec, truth: truth.json.truth };
}

async function startRun(port, { projectId, key, tenant = 'tenant_a' }) {
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(tenant), body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const created = await request(port, '/api/runs', {
    method: 'POST', headers: { ...as(tenant), 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.run;
}

async function waitTerminal(port, runId, tenant = 'tenant_a', timeoutMs = 60_000) {
  const started = Date.now();
  let run = null;
  while (Date.now() - started < timeoutMs) {
    const response = await request(port, `/api/runs/${runId}`, { headers: as(tenant) });
    run = response.json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`任务未进入终态，最后状态 ${run?.status}`);
}

/** 读取 ZIP 内容：测试里自己解析本地文件头，验证包是真 ZIP 且文件对得上。 */
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

// ---------- 1. 修订计划与结果对比 ----------

test('M08 修订计划：只挑可修复硬失败，一次一个关键项，并保留通过项', () => {
  const report = {
    decision: 'blocked',
    checks: [
      { code: 'SIZE', status: 'fail', hard_gate: true, evidence: {} },
      { code: 'FILE_INTEGRITY', status: 'fail', hard_gate: true, evidence: {} },
      { code: 'SUBJECT_PROTECTION', status: 'unknown', hard_gate: false, required: true },
      { code: 'FILE_FORMAT', status: 'pass', hard_gate: true },
    ],
  };
  const plan = planRevision({ report, deliverable: { width: 1200, height: 1200, ratio: '1:1', formats: ['jpg'] } });
  assert.equal(plan.revise, true);
  assert.equal(plan.actions.length, 1, '一次只允许一个关键动作');
  assert.equal(plan.actions[0].code, 'FILE_INTEGRITY', '完整性优先于尺寸');
  assert.deepEqual(plan.preserve_checks, ['FILE_FORMAT']);

  const unknownOnly = planRevision({
    report: {
      decision: 'needs_review',
      checks: [{ code: 'OCR_CRITICAL_TEXT', status: 'unknown', required: true }],
    },
    deliverable: {},
  });
  assert.equal(unknownOnly.revise, false, '未知项只能人工裁决，不自动重修');

  const platform = planRevision({
    report: {
      decision: 'blocked',
      checks: [{ code: 'PLATFORM_RULES', status: 'fail', hard_gate: true, required: true }],
    },
    deliverable: {},
  });
  assert.equal(platform.revise, false, '平台规则不是可自动修复项');
});

test('M08 修订对比：解决目标项且无退化才算改善', () => {
  const before = { decision: 'blocked', checks: [{ code: 'FILE_INTEGRITY', status: 'fail' }, { code: 'SIZE', status: 'pass' }] };
  const after = { decision: 'needs_review', checks: [{ code: 'FILE_INTEGRITY', status: 'pass' }, { code: 'SIZE', status: 'pass' }] };
  const outcome = compareRevisionOutcome({
    beforeReport: before, afterReport: after, actions: [{ code: 'FILE_INTEGRITY' }],
  });
  assert.equal(outcome.improved, true);
  assert.deepEqual(outcome.resolved, ['FILE_INTEGRITY']);
  assert.deepEqual(outcome.retained, ['SIZE']);

  const regressed = compareRevisionOutcome({
    beforeReport: before,
    afterReport: { checks: [{ code: 'FILE_INTEGRITY', status: 'pass' }, { code: 'SIZE', status: 'fail' }] },
    actions: [{ code: 'FILE_INTEGRITY' }],
  });
  assert.equal(regressed.improved, false);
  assert.deepEqual(regressed.regressions, ['SIZE']);
});

// ---------- 2. 导出资格 ----------

function exportFixture() {
  const run = {
    id: 'run_export', status: 'completed', quality_status: 'publishable',
    deliverables: [
      { deliverable_id: 'main', label: '主图', required: true },
      { deliverable_id: 'benefit', label: '卖点图', required: true },
    ],
  };
  const versions = [
    { id: 'v1', run_id: 'run_export', deliverable_id: 'main', number: 1, active: true, report_id: 'r1' },
    { id: 'v2', run_id: 'run_export', deliverable_id: 'benefit', number: 1, active: true, report_id: 'r2' },
  ];
  const reports = {
    r1: { id: 'r1', decision: 'publishable', checks: [] },
    r2: { id: 'r2', decision: 'publishable', checks: [] },
  };
  const validities = { r1: { validity: 'current', reasons: [] }, r2: { validity: 'current', reasons: [] } };
  return { run, versions, reports, validities };
}

test('M08 导出资格：完整包要求全部可发布且有效，部分包只带可发布项', () => {
  const { run, versions, reports, validities } = exportFixture();
  const complete = planExport({ run, versions, reports, validities, scope: 'complete' });
  assert.equal(complete.ok, true);
  assert.equal(complete.complete, true);
  assert.equal(complete.included.length, 2);

  const needsReview = { ...reports, r2: { ...reports.r2, decision: 'needs_review' } };
  const blockedComplete = planExport({ run, versions, reports: needsReview, validities, scope: 'complete' });
  assert.equal(blockedComplete.ok, false);
  assert.equal(blockedComplete.code, 'EXPORT_NOT_READY');
  assert.equal(blockedComplete.included.length, 0, '完整包失败时不得偷偷给部分内容');

  const partial = planExport({ run, versions, reports: needsReview, validities, scope: 'partial' });
  assert.equal(partial.ok, true);
  assert.equal(partial.code, 'PACKAGE_PARTIAL');
  assert.deepEqual(partial.included.map(item => item.deliverable.deliverable_id), ['main']);
  assert.deepEqual(partial.missing.map(item => item.reason), ['NEEDS_REVIEW']);

  const stale = { ...validities, r1: { validity: 'stale', reasons: ['事实已更新'] } };
  const staleComplete = planExport({ run, versions, reports, validities: stale, scope: 'complete' });
  assert.equal(staleComplete.code, 'EXPORT_STALE');
  const stalePartial = planExport({ run, versions, reports, validities: stale, scope: 'partial' });
  assert.equal(stalePartial.ok, true, '部分包可以导出仍有效的项');
  assert.equal(stalePartial.stale, 1);
});

test('M08 ZIP：零依赖打包可被标准解压读取，清单与摘要都在包内', () => {
  const files = new Map([
    ['images/main.png', Buffer.from('fake-png-bytes')],
    ['manifest.json', Buffer.from(JSON.stringify({ package_format: 'qtb-package.1' }))],
    ['qa-summary.json', Buffer.from(JSON.stringify({ deliverables: [] }))],
  ]);
  const zip = buildZip([...files.entries()].map(([name, bytes]) => ({ name, bytes })), {
    now: new Date('2026-10-26T12:00:00Z'),
  });
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  const parsed = readZip(zip);
  assert.deepEqual([...parsed.keys()], [...files.keys()]);
  for (const [name, bytes] of files) {
    assert.deepEqual(parsed.get(name), bytes);
  }
});

// ---------- 3. 端到端：修订 → 复核 → 导出 → 失效 → 回退 ----------

test('M08 端到端（模拟）：首轮硬失败自动修订，复核后可导出完整包，事实变化后拒绝导出', async t => {
  const fixture = createRevisionFixture();
  const { port } = await start(t, { provider: fixture, revisionMaxRounds: 6 });
  const { project } = await readyProject(port);
  const created = await startRun(port, { projectId: project.id, key: 'm08-run' });
  const run = await waitTerminal(port, created.id);

  // 首轮损坏文件被自动修订修复；生成结束不等于可发布
  assert.equal(run.status, 'completed', JSON.stringify(run.terminal_reason));
  assert.equal(run.quality_status, 'needs_review');
  assert.equal(run.revision.enabled, true);
  // 报价预算有限（24 演示额度，首轮已用 19），只允许对 1 个交付物做一次修订；
  // 这里刻意只让 main 首轮损坏，用来验证"修订只处理可修复硬失败"，而不是靠扩预算跑满全部。
  const revisionDump = JSON.stringify({
    round: run.revision.round, stop_reason: run.revision.stop_reason,
    history: run.revision.history.length, attempts: run.attempts.map(attempt => attempt.status),
  });
  assert.equal(run.revision.round, 1, revisionDump);
  assert.equal(run.revision.stop_reason, null, revisionDump);
  assert.equal(run.revision.history.length, 1, revisionDump);
  for (const entry of run.revision.history) {
    assert.equal(entry.actions.length, 1, '每次只处理一个关键项');
    assert.equal(entry.outcome.improved, true, JSON.stringify(entry.outcome));
    assert.ok(entry.outcome.retained.length > 0, '通过项必须保留');
  }

  const versions = await request(port, `/api/runs/${run.id}/versions`, { headers: as() });
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  const allVersions = versions.json.versions;
  // 只有 main 多了修订版本，其余交付物各自只有首轮版本；旧版本只转为历史，不删除
  assert.equal(allVersions.length, run.deliverables.length + 1);
  for (const deliverable of run.deliverables) {
    const list = allVersions.filter(item => item.deliverable_id === deliverable.deliverable_id);
    assert.equal(list.filter(item => item.active).length, 1, '同一交付物只能有一个当前版本');
    assert.equal(list.filter(item => item.current).length, 1);
  }
  const mainVersions = allVersions.filter(item => item.deliverable_id === 'main');
  assert.equal(mainVersions.length, 2, 'main 应有首轮与修订两个版本');

  const activeReportIds = new Set(allVersions.filter(item => item.active).map(item => item.report_id));
  const reports = await request(port, `/api/runs/${run.id}/quality-reports`, { headers: as() });
  assert.equal(reports.status, 200, JSON.stringify(reports.json));
  const activeReports = reports.json.reports.filter(item => activeReportIds.has(item.id));
  // 报告只增不改：首轮损坏版本的 blocked 报告仍然保留
  assert.ok(reports.json.total > activeReports.length, '历史报告必须保留');
  assert.ok(reports.json.reports.some(item => item.decision === 'blocked'), '首轮硬失败报告不得被改写');
  assert.equal(activeReports.length, run.deliverables.length);
  assert.ok(activeReports.every(item => item.decision === 'needs_review'));
  assert.ok(activeReports.every(item => item.validity === 'current'));

  const early = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(early.status, 409, JSON.stringify(early.json));
  assert.equal(early.json.error, 'EXPORT_NOT_READY');

  // 逐条复核可裁决的未知项；机器结论不被改写
  for (const report of activeReports) {
    const decisions = report.checks
      .filter(item => item.status === 'unknown' && item.required === true && item.adjudicable === true)
      .map(item => ({
        code: item.code, decision: 'pass',
        reason: `逐项人工核对 ${item.code}`, evidence: `复核记录 ${report.id}`,
      }));
    assert.ok(decisions.length > 0, `${report.id} 应有可裁决未知项`);
    const reviewed = await request(port, `/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', headers: as('tenant_a', 'reviewer_m08'), body: { decisions, note: 'M08 端到端复核' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
    assert.equal(reviewed.json.report.decision, 'publishable');
    const decided = new Set(decisions.map(item => item.code));
    const adjudicated = reviewed.json.report.checks.filter(item => decided.has(item.code));
    assert.equal(adjudicated.length, decisions.length);
    assert.ok(adjudicated.every(item => item.machine_status === 'unknown' && item.adjudication),
      '未知项必须保留机器状态并留下裁决记录');
  }

  const publishable = await request(port, `/api/runs/${run.id}`, { headers: as() });
  assert.equal(publishable.json.run.quality_status, 'publishable');

  // 完整包
  const exported = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const record = exported.json.export;
  assert.equal(record.complete, true);
  assert.equal(record.status, 'PACKAGE_COMPLETE');
  assert.equal(record.included.length, run.deliverables.length);
  assert.equal(record.missing.length, 0);
  assert.equal(record.platform_compliance, 'not_claimed');
  assert.match(record.download_url, /^\/api\/exports\/.+\/download$/);

  const download = await request(port, record.download_url, { headers: as() });
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'application/zip');
  assert.equal(createHash('sha256').update(download.body).digest('hex'), record.package_sha256);
  assert.match(download.headers['content-disposition'], /attachment; filename="qtb-/);

  const files = readZip(download.body);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const summary = JSON.parse(files.get('qa-summary.json').toString('utf8'));
  assert.equal(manifest.package_format, 'qtb-package.1');
  assert.equal(manifest.scope, 'complete');
  assert.equal(manifest.complete, true);
  assert.equal(manifest.assets.length, run.deliverables.length);
  assert.equal(manifest.rules.source_verified, false);
  assert.equal(summary.package_scope, 'complete');
  assert.equal(summary.deliverables.length, run.deliverables.length);
  assert.match(summary.note, /unknown/);
  for (const asset of manifest.assets) {
    assert.ok(files.has(asset.file), `${asset.file} 必须真实存在于包内`);
    assert.equal(createHash('sha256').update(files.get(asset.file)).digest('hex'), asset.sha256);
    assert.ok(asset.report_id);
    assert.ok(asset.version_id);
  }

  // 部分包：全部可发布时不应出现缺失项
  const partial = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'partial' },
  });
  assert.equal(partial.status, 201, JSON.stringify(partial.json));
  assert.equal(partial.json.export.complete, false);
  assert.equal(partial.json.export.status, 'PACKAGE_PARTIAL');
  assert.equal(partial.json.export.included.length, run.deliverables.length);

  const listedExports = await request(port, `/api/exports?run_id=${run.id}`, { headers: as() });
  assert.equal(listedExports.status, 200);
  assert.equal(listedExports.json.total, 2);

  // 跨租户一律不存在
  assert.equal((await request(port, `/api/exports/${record.id}`, { headers: as('tenant_demo') })).status, 404);
  assert.equal((await request(port, `/api/runs/${run.id}/versions`, { headers: as('tenant_demo') })).status, 404);

  // 回退到首轮损坏版本：质量立刻降级，导出被拒；再激活修订版恢复
  const first = mainVersions.find(item => item.number === 1);
  const second = mainVersions.find(item => item.number === 2);
  const rollback = await request(port, `/api/runs/${run.id}/versions/${first.id}/activate`, {
    method: 'POST', headers: as(),
  });
  assert.equal(rollback.status, 200, JSON.stringify(rollback.json));
  assert.equal(rollback.json.run.run.quality_status, 'blocked');
  const blockedExport = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(blockedExport.status, 409);
  assert.equal(blockedExport.json.error, 'EXPORT_NOT_READY');

  const again = await request(port, `/api/runs/${run.id}/versions/${first.id}/activate`, {
    method: 'POST', headers: as(),
  });
  assert.equal(again.status, 409, '重复激活当前版本应被拒绝');
  assert.equal(again.json.error, 'VERSION_ALREADY_ACTIVE');

  const restored = await request(port, `/api/runs/${run.id}/versions/${second.id}/activate`, {
    method: 'POST', headers: as(),
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.run.run.quality_status, 'publishable');

  // 商品事实出现新版本：全部旧报告失效，正式导出必须拒绝
  const nextTruth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: 1, confirm: true,
      facts: [
        { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(nextTruth.status, 201, JSON.stringify(nextTruth.json));

  const staleReport = await request(port, `/api/quality-reports/${activeReports[0].id}`, { headers: as() });
  assert.equal(staleReport.json.report.validity, 'stale');

  const staleComplete = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(staleComplete.status, 409, JSON.stringify(staleComplete.json));
  assert.equal(staleComplete.json.error, 'EXPORT_STALE');
  assert.ok(staleComplete.json.details.stale > 0);

  const stalePartial = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'partial' },
  });
  assert.equal(stalePartial.status, 409, '所有结果都失效时部分包也不允许导出');
  assert.equal(stalePartial.json.error, 'EXPORT_STALE');
});

// ---------- 4. 停止条件 ----------

test('M08 停止条件：预算触顶即停，不扩预算，也不把失败包装成通过', async t => {
  const broken = createRevisionFixture({ alwaysBroken: true });
  const { port } = await start(t, { provider: broken, revisionMaxRounds: 4 });
  const { project } = await readyProject(port);
  const created = await startRun(port, { projectId: project.id, key: 'm08-stop' });
  const run = await waitTerminal(port, created.id);

  assert.equal(run.status, 'completed');
  assert.equal(run.quality_status, 'blocked');
  // 每次修订都无改善，但首个修订之后报价预算已不足，必须在预算闸口停下：
  // 不允许自动扩预算，也不允许把 blocked 包装成通过。
  assert.equal(run.revision.round, 1);
  assert.equal(run.revision.no_improvement_streak, 1);
  assert.equal(run.revision.stop_reason, 'budget_exhausted');
  assert.equal(run.revision.max_credits, Math.floor(24 * 0.6));
  assert.ok(run.revision.spent_credits > 0);
  assert.equal(run.revision.history.length, 1);
  assert.ok(run.revision.history.every(entry => entry.outcome.improved === false));

  const out = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(out.status, 409);
  assert.equal(out.json.error, 'EXPORT_NOT_READY');
});
