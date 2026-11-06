/**
 * 阶段 4：受控 Agent Loop（自动修订控制面）。
 *
 * 边界：真实视觉评审/规划尚未验收，因此不启用模型驱动的自动循环。
 * 本文件验证的是控制面事实：轮次上限、版本选择、停止原因、上下文变化闸口，
 * 以及取消迟到、未知不重提、重启恢复、并发预留与修订无改善的实际行为。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { computeRevisionMetrics, selectRevisionVersion } from '../src/m08.mjs';

const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const as = (tenant = 'tenant_a') => ({ 'x-tenant-id': tenant, 'x-actor-id': 'tester_ai05' });

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

/**
 * 阶段 4 测试 Provider：
 * - 按 idempotency_key 复用同一个 provider_job_id，重启恢复不会变成新调用；
 * - 用 releaseGate 控制"结果迟到"，用于取消场景；
 * - mode=unknown 时查单始终未知，用于验证不重复提交；
 * - mode/alwaysBroken 控制首轮损坏与后续是否修复。
 */
function createStage4Provider({
  alwaysBroken = false, brokenFirst = true, brokenDeliverables = ['main'], mode = 'normal',
  released = true, successAfter = 2,
} = {}) {
  const capabilities = () => ({
    id: 'p4-fixture', version: 'fixture.1', image: true, video: false,
    max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
    supports_seed: true, supports_revision: true, max_side: 2048, formats: ['jpg', 'png'],
    simulated: true, acceptance: 'simulated_only',
  });
  const jobs = new Map();
  const byDeliverable = new Map();
  const submissions = [];
  const cache = new Map();
  let sequence = 0;
  let releaseGate = released;

  function submit(request) {
    const key = request.idempotency_key;
    submissions.push({
      key,
      deliverable_id: request.deliverable_id,
      iteration: request.iteration,
      revision_round: request.revision?.round ?? 0,
    });
    if (jobs.has(key)) return handle(jobs.get(key)); // 恢复重挂：同一个 job，不是新调用
    const round = (byDeliverable.get(request.deliverable_id) ?? 0) + 1;
    byDeliverable.set(request.deliverable_id, round);
    sequence += 1;
    const job = { request, round, polls: 0, provider_job_id: `p4_${sequence}` };
    jobs.set(key, job);
    return handle(job);
  }

  function handle(job) {
    return {
      provider_job_id: job.provider_job_id,
      status: 'queued',
      request_hash: job.request.request_hash,
      idempotency_key: job.request.idempotency_key,
      provider_meta: { id: 'p4-fixture', version: 'fixture.1', simulated: true, round: job.round },
    };
  }

  function poll(handleArg) {
    const job = [...jobs.values()].find(item => item.provider_job_id === handleArg.provider_job_id) ?? null;
    if (!job) return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
    if (!releaseGate) return { status: 'queued' };
    job.polls += 1;
    if (mode === 'unknown') return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
    if (job.polls < successAfter) return { status: 'queued' };
    return { status: 'succeeded', result: normalizeResult(job) };
  }

  function normalizeResult(job) {
    const { request, round } = job;
    const width = request.target_width;
    const height = request.target_height;
    const format = (request.formats ?? ['png']).includes('png') ? 'png' : 'jpg';
    const shouldBreak = alwaysBroken
      || (brokenFirst && round === 1
        && (brokenDeliverables.length === 0 || brokenDeliverables.includes(request.deliverable_id)));
    let bytes;
    if (shouldBreak) {
      bytes = Buffer.from(`p4-broken-${round}-${width}x${height}-${format}`, 'utf8');
    } else if (format === 'png') {
      const cacheKey = `png:${width}x${height}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, gradientPng(width, height));
      bytes = cache.get(cacheKey);
    } else {
      bytes = brokenPngJpeg(width, height);
    }
    return {
      provider: 'p4-fixture',
      model: 'fixture/image',
      model_version: 'fixture.1',
      provider_job_id: request.idempotency_key,
      provider_request_id: `req_${request.request_hash.slice(0, 12)}`,
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

  /** 只含 SOF0 头的 JPEG，足够通过签名与尺寸校验。 */
  function brokenPngJpeg(width, height) {
    const buffer = Buffer.alloc(23);
    buffer[0] = 0xFF; buffer[1] = 0xD8; buffer[2] = 0xFF; buffer[3] = 0xC0;
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

  return {
    capabilities,
    validate: () => ({ ok: true }),
    estimate: () => ({ price_version: 'fixture.1', estimated_credits: 1, max_credits: null }),
    submit,
    poll,
    cancel: () => ({ status: 'cancelled' }),
    normalizeResult,
    release(value = true) { releaseGate = value; },
    get released() { return releaseGate; },
    submissions,
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
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function start(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai05-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS, initialCredits: 240,
    tickMs: 5, attemptTimeoutMs: 30_000, revisionMaxRounds: 4,
    allowScenarioInjection: false, ...options,
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
    body: { name: 'P4 面霜', sku: 'P4-01', category: '面霜', platform: '天猫' },
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
  return { project, truthVersion: truth.json.truth_version.version };
}

async function quoteRun(port, { projectId, key, tenant = 'tenant_a' }) {
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(tenant), body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  return request(port, '/api/runs', {
    method: 'POST', headers: { ...as(tenant), 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
}

async function readRun(port, runId, tenant = 'tenant_a') {
  const response = await request(port, `/api/runs/${runId}`, { headers: as(tenant) });
  return response.json?.run ?? null;
}

/** 事件流接口是 SSE；终态任务会关闭连接，测试直接解析 data 行做断言。 */
async function readRunEvents(port, runId, tenant = 'tenant_a') {
  const response = await request(port, `/api/runs/${runId}/events?since=0`, { headers: as(tenant) });
  const events = [];
  for (const block of (response.text ?? '').split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.sequence !== undefined) events.push(payload);
      } catch { /* 终态标记或无数据行忽略 */ }
    }
  }
  return events;
}

async function waitFor(port, runId, predicate, { tenant = 'tenant_a', timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  let run = null;
  while (Date.now() - started < timeoutMs) {
    run = await readRun(port, runId, tenant);
    if (run && predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待条件超时，最后状态：${JSON.stringify({
    status: run?.status, revision: run?.revision?.stop_reason,
    attempts: run?.attempts?.map(item => item.status),
  })}`);
}

const TERMINAL = ['completed', 'limit_reached', 'failed', 'cancelled', 'needs_attention'];
const waitTerminal = (port, runId, options) =>
  waitFor(port, runId, run => TERMINAL.includes(run.status), options);

// ---------- 1. 纯函数：版本选择与指标 ----------

test('P4 版本选择：只有净改善才自动替换选用版本，退步/无改善保留原版本', () => {
  const improved = selectRevisionVersion({
    outcome: { improved: true, regressions: [] },
    previousVersionId: 'ver_old', newVersionId: 'ver_new',
  });
  assert.equal(improved.active_version_id, 'ver_new');
  assert.equal(improved.supersede_previous, true);
  assert.equal(improved.reason, 'IMPROVED');

  const regressed = selectRevisionVersion({
    outcome: { improved: false, regressions: ['SUBJECT_PROTECTION'] },
    previousVersionId: 'ver_old', newVersionId: 'ver_new',
  });
  assert.equal(regressed.active_version_id, 'ver_old');
  assert.equal(regressed.new_version_active, false);
  assert.equal(regressed.reason, 'REGRESSION');

  const noImprovement = selectRevisionVersion({
    outcome: { improved: false, regressions: [] },
    previousVersionId: 'ver_old', newVersionId: 'ver_new',
  });
  assert.equal(noImprovement.active_version_id, 'ver_old');
  assert.equal(noImprovement.reason, 'NO_IMPROVEMENT');

  const first = selectRevisionVersion({ outcome: null, previousVersionId: null, newVersionId: 'ver_new' });
  assert.equal(first.active_version_id, 'ver_new');
  assert.equal(first.reason, 'NO_PREVIOUS_VERSION');
});

test('P4 修订指标：净改善率、成本与延时都来自真实轨迹，没有轨迹时不用 0 冒充', () => {
  const empty = computeRevisionMetrics({ revision: { history: [], spent_credits: 0 } });
  assert.equal(empty.rounds, 0);
  assert.equal(empty.net_improvement_rate, null);
  assert.equal(empty.avg_latency_ms, null);

  const metrics = computeRevisionMetrics({
    revision: {
      spent_credits: 12,
      history: [
        { credits: 6, latency_ms: 800, outcome: { improved: true, regressions: [] } },
        { credits: 6, latency_ms: 1200, outcome: { improved: false, regressions: ['SIZE'], still_failing: [] } },
      ],
    },
  });
  assert.equal(metrics.rounds, 2);
  assert.equal(metrics.improved_rounds, 1);
  assert.equal(metrics.regressed_rounds, 1);
  assert.equal(metrics.net_improvement_rate, 0.5);
  assert.equal(metrics.credits_spent, 12);
  assert.equal(metrics.avg_latency_ms, 1000);
  assert.equal(metrics.max_latency_ms, 1200);
});

// ---------- 2. 控制面暴露 ----------

test('P4 控制面：能力接口如实标注自动修订模式与视觉闸口，不宣称未验收能力', async t => {
  const provider = createStage4Provider();
  const { port } = await start(t, { provider });
  const caps = await request(port, '/api/provider/capabilities', { headers: as() });
  assert.equal(caps.status, 200);
  assert.equal(caps.json.revision_control.mode, 'hard_failure_only');
  assert.equal(caps.json.revision_control.visual_auto_loop, false);
  assert.equal(caps.json.revision_control.visual_max_rounds, 1);
  assert.equal(caps.json.revision_control.visual_gate, 'visual_review_not_configured');
  assert.equal(caps.json.revision_planner.auto_loop, false);

  const { project } = await readyProject(port);
  const startRun = await quoteRun(port, { projectId: project.id, key: 'p4-control' });
  assert.equal(startRun.status, 201, JSON.stringify(startRun.json));
  const run = await waitTerminal(port, startRun.json.run.id);
  assert.equal(run.revision.mode, 'hard_failure_only');
  assert.equal(run.revision.permission.automatic, true);
  assert.equal(run.revision.capability.visual_review_configured, false);
  assert.equal(run.revision.visual.enabled, false);
  assert.equal(run.revision.visual.stop_reason, 'visual_review_not_configured');
  assert.equal(run.revision.visual.max_rounds, 1);
  assert.equal(run.revision.visual.rounds_used, 0);
  assert.equal(run.revision.metrics.rounds, 1, '首轮损坏应触发一次可修复硬失败修订');
  assert.ok(run.revision.history[0].latency_ms >= 0, '轨迹必须记录真实延时');
  assert.equal(run.revision.history[0].selection_reason, 'IMPROVED');

  const metrics = await request(port, '/api/metrics', { headers: as() });
  assert.equal(metrics.status, 200, JSON.stringify(metrics.json));
  assert.equal(metrics.json.business.revision.rounds, 1);
  assert.equal(metrics.json.business.revision.net_improvement_rate, 1);
  assert.equal(metrics.json.business.revision.visual_auto_runs, 0, '视觉自动修订未启用');
  assert.equal(metrics.json.business.revision.more_rounds_decision, 'eligible_for_review');
});

// ---------- 3. 修订无改善：不替换选用版本 ----------

test('P4 修订无改善：新版本只留历史，原选用版本保持 active，停止原因可追溯', async t => {
  const provider = createStage4Provider({ alwaysBroken: true, brokenFirst: true });
  const { port } = await start(t, { provider, initialCredits: 400 });
  const { project } = await readyProject(port);
  const created = await quoteRun(port, { projectId: project.id, key: 'p4-no-improvement' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const run = await waitTerminal(port, created.json.run.id);

  assert.equal(run.status, 'completed');
  assert.ok(run.revision.history.length >= 1);
  for (const entry of run.revision.history) {
    assert.equal(entry.outcome.improved, false, JSON.stringify(entry.outcome));
    assert.equal(entry.selection_reason, 'NO_IMPROVEMENT');
    assert.equal(entry.selected_version_id, entry.before_version_id, '未改善不得替换选用版本');
  }
  assert.ok(['no_improvement', 'revision_budget', 'budget_exhausted', 'max_rounds'].includes(run.revision.stop_reason));

  const versions = await request(port, `/api/runs/${run.id}/versions`, { headers: as() });
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  for (const deliverable of run.deliverables.filter(item => item.status === 'succeeded')) {
    const list = versions.json.versions.filter(item => item.deliverable_id === deliverable.deliverable_id);
    assert.equal(list.filter(item => item.active).length, 1, '同一交付物只能有一个选用版本');
    assert.equal(deliverable.active_version_id, list.find(item => item.number === 1)?.id,
      '未改善时仍选用首轮版本');
    const revised = list.filter(item => item.revision_round > 0);
    assert.ok(revised.every(item => item.active === false), '无改善的修订版本不得自动选用');
  }
});

// ---------- 4. 上下文变化：停止修订 ----------

test('P4 上下文变化：事实更新后旧报告失效，自动修订停止且不提交新请求', async t => {
  const provider = createStage4Provider({ brokenFirst: true, successAfter: 4 });
  const { port } = await start(t, { provider, revisionMaxRounds: 3 });
  const { project, truthVersion } = await readyProject(port);
  const created = await quoteRun(port, { projectId: project.id, key: 'p4-context' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;

  // 首次生成仍在途时更新事实版本，制造真实的上下文变化
  await waitFor(port, runId, run => run.attempts.some(item => item.status === 'submitted'));
  const updated = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: truthVersion, confirm: true,
      facts: [
        { key: '容量', value: '60g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(updated.status, 201, JSON.stringify(updated.json));

  provider.release(true);
  const run = await waitTerminal(port, runId);
  assert.equal(run.revision.stop_reason, 'context_changed', JSON.stringify(run.revision.context_check));
  assert.equal(run.revision.round, 0, '上下文变化后不得再提交修订');
  assert.ok(run.revision.context_check.reasons.length > 0);
  assert.ok(run.revision.context_check.reasons.some(item => item.includes('事实')));
  const events = await readRunEvents(port, runId);
  assert.ok(events.some(item =>
    item.stage === 'revision' && item.status === 'stopped'
    && item.payload?.stop_reason === 'context_changed'));
});

// ---------- 5. 取消后的迟到结果 ----------

test('P4 取消迟到：取消后返回的结果只入审计，不写产物、不复活任务', async t => {
  const provider = createStage4Provider({ released: false, brokenFirst: false });
  const { port } = await start(t, { provider });
  const { project } = await readyProject(port);
  const created = await quoteRun(port, { projectId: project.id, key: 'p4-cancel' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;
  await waitFor(port, runId, run => run.attempts.some(item => item.status === 'submitted'));

  // 先放行供应商结果，再取消：取消时正好能取到"迟到成功"
  provider.release(true);
  const cancelled = await request(port, `/api/runs/${runId}/cancel`, {
    method: 'POST', headers: as(), body: { reason: 'user_cancelled_ai05' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const run = await waitFor(port, runId, item => item.status === 'cancelled');
  assert.equal(run.terminal_reason, 'user_cancelled_ai05');
  assert.ok(run.attempts.every(item => !['submitted', 'succeeded'].includes(item.status)));
  const versions = await request(port, `/api/runs/${runId}/versions`, { headers: as() });
  assert.equal(versions.json.versions.length, 0, '取消后的迟到结果不得产生版本');
  const events = await readRunEvents(port, runId);
  assert.ok(events.some(item =>
    item.stage === 'cancelled' && item.status === 'provider_late_result_ignored'));
});

// ---------- 6. 未知结果不重复提交 ----------

test('P4 未知请求：查单未知不重复提交、不加收费用，窗口后转人工核对', async t => {
  const provider = createStage4Provider({ mode: 'unknown' });
  const { port } = await start(t, { provider, unknownReconcileMs: 80 });
  const { project } = await readyProject(port);
  const created = await quoteRun(port, { projectId: project.id, key: 'p4-unknown' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;

  const run = await waitFor(port, runId, item => item.status === 'needs_attention', { timeoutMs: 30_000 });
  assert.equal(run.attention.reason, 'PROVIDER_RESULT_UNKNOWN');
  const submissionsForDeliverable = provider.submissions
    .filter(item => item.deliverable_id === run.deliverables[0].deliverable_id);
  assert.equal(submissionsForDeliverable.length, 1, '未知不等于失败，不得重复提交');
  assert.equal(provider.submissions.filter(item => item.revision_round > 0).length, 0);
  const events = await readRunEvents(port, runId);
  assert.ok(events.some(item =>
    item.stage === 'generation' && item.status === 'provider_unknown'));
});

// ---------- 7. 重启恢复 ----------

test('P4 重启恢复：进程重启后按幂等键重挂，不新增调用、不重复结算', async t => {
  const provider = createStage4Provider({ released: false, brokenFirst: false });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai05-restart-'));
  const first = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS, initialCredits: 240,
    tickMs: 5, attemptTimeoutMs: 30_000, provider, allowScenarioInjection: false,
  });
  const { port } = await first.listen();
  const { project } = await readyProject(port);
  const created = await quoteRun(port, { projectId: project.id, key: 'p4-restart' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;
  await waitFor(port, runId, run => run.attempts.some(item => item.status === 'submitted'));
  await first.close();

  const second = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS, initialCredits: 240,
    tickMs: 5, attemptTimeoutMs: 30_000, provider, allowScenarioInjection: false,
  });
  t.after(async () => {
    await second.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port: port2 } = await second.listen();
  provider.release(true);
  const run = await waitTerminal(port2, runId);
  assert.equal(run.status, 'completed');

  const recoveredSubmits = provider.submissions.filter(item =>
    item.deliverable_id === run.deliverables[0].deliverable_id);
  assert.equal(recoveredSubmits.length, 2, '恢复只按原幂等键重挂一次');
  assert.equal(new Set(recoveredSubmits.map(item => item.key)).size, 1, '重挂必须复用同一幂等键');
  assert.equal(run.budget.captured_credits, run.attempts
    .filter(item => item.status === 'succeeded')
    .reduce((sum, item) => sum + (Number(item.charged_credits) || 0), 0), '不得重复结算');
});

// ---------- 8. 并发预留 ----------

test('P4 并发预留：两个任务同时提交，额度只够一份时不得超卖', async t => {
  const provider = createStage4Provider({ brokenFirst: false });
  const { port } = await start(t, { provider, initialCredits: 24 });
  const { project } = await readyProject(port);
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(), body: { project_id: project.id },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const quoteId = quote.json.quote.quote_id;
  const [first, second] = await Promise.all([
    request(port, '/api/runs', {
      method: 'POST', headers: { ...as(), 'Idempotency-Key': 'p4-concurrent-1' },
      body: { project_id: project.id, quote_id: quoteId },
    }),
    request(port, '/api/runs', {
      method: 'POST', headers: { ...as(), 'Idempotency-Key': 'p4-concurrent-2' },
      body: { project_id: project.id, quote_id: quoteId },
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 402], `并发预约结果异常：${JSON.stringify([first.json, second.json])}`);
  const runId = (first.status === 201 ? first : second).json.run.id;
  const run = await waitTerminal(port, runId);
  assert.equal(run.status, 'completed');
  assert.ok(run.budget.captured_credits <= run.budget.reserved_credits, '扣费不得超过预留');
  const metrics = await request(port, '/api/metrics', { headers: as() });
  assert.equal(metrics.status, 200, JSON.stringify(metrics.json));
  assert.ok(metrics.json.credits.available >= 0, '可用额度不得为负');
});
