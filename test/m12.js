/**
 * M12 测试：采用/驳回回流、授权效果导入与实验口径、套餐与支付能力闸口、
 * 可观测性、租户级备份校验与恢复。
 *
 * 端到端用真实 HTTP 与任务状态机；模拟 Provider 与"未接入真实支付"的事实
 * 在断言里明确区分，不把演示订单或模拟结果写成生产完成。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  buildBackupManifest, buildExperimentReport, buildObservabilitySnapshot, evaluateFeedbackEligibility,
  evaluatePaymentCapability, listBillingPlans, mergeTenantSnapshot, previewOutcomeRows,
  resolveLatestFeedback, summarizeFeedback, summarizeOutcomeMetrics, tenantSnapshot,
  validateFeedbackInput, validateOutcomeImportInput, verifyBackupManifest,
} from '../src/m12.mjs';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'owner_m12') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

function subjectPng(width = 128, height = 128) {
  const pixels = Buffer.alloc(width * height * 3, 240);
  for (let y = 32; y < 96; y += 1) {
    for (let x = 32; x < 96; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = 190; pixels[index + 1] = 40; pixels[index + 2] = 50;
    }
  }
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm12-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 400, tickMs: 8, attemptTimeoutMs: 3_000,
    allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

/** 按清单要求尺寸出图的测试 Provider；simulated 标记保持为真，不是真实模型。 */
function createSizeFixture() {
  const capabilities = () => ({
    id: 'm12-fixture', version: 'fixture.1', image: true, video: false,
    max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
    supports_seed: true, supports_revision: false, max_side: 2048, formats: ['jpg', 'png'],
    simulated: true, acceptance: 'simulated_only',
  });
  const jobs = new Map();
  const cache = new Map();
  let sequence = 0;
  function normalizeResult(job) {
    const { request: body } = job;
    const width = body.target_width;
    const height = body.target_height;
    const format = (body.formats ?? ['png']).includes('png') ? 'png' : 'jpg';
    const key = `${format}:${width}x${height}`;
    if (!cache.has(key)) {
      let bytes;
      if (format === 'png') {
        const pixels = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 3;
            pixels[index] = (x * 3 + y * 2) % 256;
            pixels[index + 1] = (y * 5 + x) % 256;
            pixels[index + 2] = (x * 7 + y * 3) % 256;
          }
        }
        bytes = encodeRgbPng(width, height, pixels);
      } else {
        bytes = Buffer.alloc(23);
        bytes[0] = 0xFF; bytes[1] = 0xD8; bytes[2] = 0xFF; bytes[3] = 0xC0;
        bytes.writeUInt16BE(17, 4); bytes[6] = 8;
        bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
        bytes[11] = 3; bytes[12] = 1; bytes[13] = 0x11; bytes[14] = 0;
        bytes[15] = 2; bytes[16] = 0x11; bytes[17] = 1;
        bytes[18] = 3; bytes[19] = 0x11; bytes[20] = 1;
        bytes[21] = 0xFF; bytes[22] = 0xD9;
      }
      cache.set(key, bytes);
    }
    const bytes = cache.get(key);
    return {
      provider: 'm12-fixture', model: 'fixture/image', model_version: 'fixture.1',
      provider_job_id: body.idempotency_key,
      provider_request_id: `req_${body.request_hash.slice(0, 12)}`,
      usage: { images: 1, unit: 'image' },
      cost: { amount: 0, currency: 'internal_demo' },
      latency_ms: 8,
      output: { format, bytes, width, height, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
  }
  return {
    capabilities,
    validate: () => ({ ok: true }),
    estimate: body => {
      const side = Math.max(body.target_width ?? 1024, body.target_height ?? 1024);
      return { price_version: 'fixture.1', estimated_credits: Math.max(1, Math.round(side * side * 0.0000045)), max_credits: null };
    },
    submit: body => {
      sequence += 1;
      const providerJobId = `fx_${sequence}`;
      jobs.set(providerJobId, { request: body });
      return {
        provider_job_id: providerJobId, status: 'queued',
        request_hash: body.request_hash, idempotency_key: body.idempotency_key,
        provider_meta: { id: 'm12-fixture', version: 'fixture.1', simulated: true },
      };
    },
    poll: handle => {
      const job = jobs.get(handle.provider_job_id);
      if (!job) return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
      return { status: 'succeeded', result: normalizeResult(job) };
    },
    cancel: () => ({ status: 'cancelled' }),
    normalizeResult,
  };
}

const demoPayment = {
  capabilities: () => ({ simulated: true, real_money: false, supports_refunds: false }),
};

// ---------- 纯函数 ----------

test('M12 采用/驳回：决策合法、驳回必须带理由、备注有上限、arm 必须挂在实验上', () => {
  const adopted = validateFeedbackInput({ decision: 'adopted' });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.value.reason_code, null);

  const rejectMissing = validateFeedbackInput({ decision: 'rejected' });
  assert.equal(rejectMissing.ok, false);
  assert.ok(rejectMissing.issues.some(item => item.code === 'FEEDBACK_REASON_REQUIRED'));

  const badDecision = validateFeedbackInput({ decision: 'approved' });
  assert.ok(badDecision.issues.some(item => item.code === 'FEEDBACK_DECISION_INVALID'));

  const badReason = validateFeedbackInput({ decision: 'rejected', reason_code: 'LOOKS_BAD' });
  assert.ok(badReason.issues.some(item => item.code === 'FEEDBACK_REASON_INVALID'));

  const longNote = validateFeedbackInput({ decision: 'adopted', note: '长'.repeat(501) });
  assert.ok(longNote.issues.some(item => item.code === 'FEEDBACK_NOTE_TOO_LONG'));

  const armOnly = validateFeedbackInput({ decision: 'adopted', arm: 'variant' });
  assert.ok(armOnly.issues.some(item => item.code === 'FEEDBACK_EXPERIMENT_REQUIRED'));
});

test('M12 采用资格：必须当前选用、可发布且未失效；驳回允许落在失败任务上', () => {
  const base = {
    run: { status: 'completed' }, version: { id: 'ver_1', active: true },
    report: { decision: 'publishable' }, reportValidity: 'current',
  };
  assert.equal(evaluateFeedbackEligibility({ decision: 'adopted', ...base }).ok, true);

  const inactive = evaluateFeedbackEligibility({ decision: 'adopted', ...base, version: { id: 'ver_1', active: false } });
  assert.ok(inactive.blockers.some(item => item.code === 'FEEDBACK_VERSION_INACTIVE'));

  const blocked = evaluateFeedbackEligibility({ decision: 'adopted', ...base, report: { decision: 'blocked' } });
  assert.ok(blocked.blockers.some(item => item.code === 'FEEDBACK_NOT_PUBLISHABLE'));

  const stale = evaluateFeedbackEligibility({ decision: 'adopted', ...base, reportValidity: 'stale' });
  assert.ok(stale.blockers.some(item => item.code === 'FEEDBACK_REPORT_STALE'));

  const running = evaluateFeedbackEligibility({ decision: 'adopted', ...base, run: { status: 'running' } });
  assert.ok(running.blockers.some(item => item.code === 'FEEDBACK_RUN_NOT_TERMINAL'));

  const rejected = evaluateFeedbackEligibility({
    decision: 'rejected', run: { status: 'failed' }, version: { id: 'ver_2', active: false }, report: null,
  });
  assert.equal(rejected.ok, true);
});

test('M12 反馈统计：同一版本以最新一条为准，历史保留但不重复计数', () => {
  const items = [
    { run_id: 'r1', version_id: 'v1', decision: 'rejected', reason_code: 'QUALITY_DEFECT', created_at: '2026-10-01T00:00:00.000Z' },
    { run_id: 'r1', version_id: 'v1', decision: 'adopted', reason_code: null, created_at: '2026-10-02T00:00:00.000Z' },
    { run_id: 'r2', version_id: 'v2', decision: 'rejected', reason_code: 'COST_TOO_HIGH', created_at: '2026-10-03T00:00:00.000Z' },
  ];
  assert.equal(resolveLatestFeedback(items).length, 2);
  const summary = summarizeFeedback(items);
  assert.equal(summary.total, 2);
  assert.equal(summary.adopted, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.adoption_rate, 0.5);
  assert.equal(summary.rejection_reasons.COST_TOO_HIGH, 1);
  assert.equal(summary.rejection_reasons.QUALITY_DEFECT, undefined, '被后一条覆盖的驳回不计入');
});

test('M12 效果导入：未授权与无来源拒绝；非法行逐行报错，正确行仍可用', () => {
  const unauthorized = validateOutcomeImportInput({
    rows: [{ sku: 'S1', impressions: 1, clicks: 1, orders: 0, revenue_cents: 0, cost_credits: 0 }],
    source: 'tmall_export', authorization_reference: 'AUTH-1',
  });
  assert.equal(unauthorized.ok, false);
  assert.ok(unauthorized.issues.some(item => item.code === 'OUTCOME_AUTHORIZATION_REQUIRED'));

  const noSource = validateOutcomeImportInput({
    authorized: true, rows: [{ sku: 'S1' }], source: 'tmall_export',
  });
  assert.ok(noSource.issues.some(item => item.code === 'OUTCOME_PROVENANCE_REQUIRED'));

  const preview = previewOutcomeRows({
    rows: [
      { sku: 'S1', impressions: 100, clicks: 10, orders: 2, revenue_cents: 2000, cost_credits: 5 },
      { sku: 'S1', impressions: 100, clicks: 10, orders: 2, revenue_cents: 2000, cost_credits: 5 },
      { sku: '', impressions: 10, clicks: 1, orders: 0, revenue_cents: 0, cost_credits: 0 },
      { sku: 'S2', impressions: 10, clicks: 20, orders: 0, revenue_cents: 0, cost_credits: 0 },
      { sku: 'S3', impressions: 10, clicks: 5, orders: 9, revenue_cents: 0, cost_credits: 0 },
      { sku: 'S4', impressions: -1, clicks: 0, orders: 0, revenue_cents: 0, cost_credits: 0 },
    ],
  });
  assert.equal(preview.summary.total, 6);
  assert.equal(preview.summary.valid, 1);
  assert.ok(preview.rows[1].errors.some(item => item.code === 'OUTCOME_DUPLICATE_ROW'));
  assert.ok(preview.rows[2].errors.some(item => item.code === 'OUTCOME_SKU_EMPTY'));
  assert.ok(preview.rows[3].errors.some(item => item.code === 'OUTCOME_CLICKS_EXCEED_IMPRESSIONS'));
  assert.ok(preview.rows[4].errors.some(item => item.code === 'OUTCOME_ORDERS_EXCEED_CLICKS'));
  assert.ok(preview.rows[5].errors.some(item => item.code === 'OUTCOME_METRIC_INVALID'));
});

test('M12 实验口径：样本不足只标不足，样本足够也只说观测差异、不做显著性', () => {
  const small = buildExperimentReport({
    experiment: { id: 'exp_1', name: '主图改版' },
    outcomes: [
      { experiment_id: 'exp_1', arm: 'control', impressions: 10, clicks: 1, orders: 0, revenue_cents: 0, cost_credits: 2 },
      { experiment_id: 'exp_1', arm: 'variant', impressions: 12, clicks: 2, orders: 1, revenue_cents: 100, cost_credits: 3 },
    ],
    feedback: [],
  });
  assert.equal(small.status, 'insufficient_sample');
  assert.equal(small.statistical_significance, 'not_computed');
  assert.match(small.statement, /样本不足/);

  const feedback = [];
  for (let index = 0; index < 10; index += 1) {
    const day = String(index + 1).padStart(2, '0');
    feedback.push({
      run_id: `run_c_${index}`, version_id: `ver_c_${index}`, experiment_id: 'exp_1', arm: 'control',
      decision: 'adopted', created_at: `2026-10-${day}T00:00:00.000Z`,
    });
    feedback.push({
      run_id: `run_v_${index}`, version_id: `ver_v_${index}`, experiment_id: 'exp_1', arm: 'variant',
      decision: 'adopted', created_at: `2026-10-${day}T00:00:01.000Z`,
    });
  }
  const large = buildExperimentReport({
    experiment: { id: 'exp_1', name: '主图改版' },
    outcomes: [
      { experiment_id: 'exp_1', arm: 'control', impressions: 200, clicks: 10, orders: 2, revenue_cents: 2000, cost_credits: 20 },
      { experiment_id: 'exp_1', arm: 'variant', impressions: 200, clicks: 20, orders: 4, revenue_cents: 4000, cost_credits: 16 },
    ],
    feedback,
  });
  assert.equal(large.status, 'observed_difference');
  assert.equal(large.arms.control.ctr, 0.05);
  assert.equal(large.arms.variant.ctr, 0.1);
  assert.equal(large.delta.ctr, 0.05);
  assert.match(large.statement, /未做显著性检验/);
  assert.match(large.statement, /不能宣称因果/);

  const zeroOrders = summarizeOutcomeMetrics([
    { impressions: 10, clicks: 1, orders: 0, revenue_cents: 0, cost_credits: 5 },
  ]);
  assert.equal(zeroOrders.cost_per_order, null, '零订单时不能把成本/单写成 0');
  assert.equal(zeroOrders.cvr, 0);
});

test('M12 商业化：套餐不可计费；无支付 Provider 阻断；模拟 Provider 只能演示；真实 Provider 缺退款能力也要报', () => {
  const plans = listBillingPlans();
  assert.equal(plans.plans.length >= 3, true);
  assert.ok(plans.plans.every(item => item.billable === false && item.price_cents === null));

  const unconfigured = evaluatePaymentCapability({ provider: null });
  assert.equal(unconfigured.mode, 'unconfigured');
  assert.equal(unconfigured.can_checkout, false);
  assert.ok(unconfigured.blockers.some(item => item.code === 'PAYMENT_PROVIDER_UNCONFIGURED'));

  const demo = evaluatePaymentCapability({ provider: demoPayment });
  assert.equal(demo.mode, 'demo');
  assert.equal(demo.real_money, false);
  assert.equal(demo.can_checkout, true);
  assert.equal(demo.can_refund, false);
  assert.ok(demo.blockers.some(item => item.code === 'PAYMENT_REAL_MONEY_UNSUPPORTED'));

  const liveNoRefund = evaluatePaymentCapability({
    provider: { capabilities: () => ({ real_money: true, simulated: false, supports_refunds: false }) },
  });
  assert.equal(liveNoRefund.mode, 'live');
  assert.equal(liveNoRefund.real_money, true);
  assert.equal(liveNoRefund.can_checkout, false, '真实扣款通道未接入前不允许下单');
  assert.equal(liveNoRefund.can_refund, false);
  assert.ok(liveNoRefund.blockers.some(item => item.code === 'PAYMENT_CHARGE_UNIMPLEMENTED'));

  const liveWithRefund = evaluatePaymentCapability({
    provider: { capabilities: () => ({ real_money: true, simulated: false, supports_refunds: true }) },
  });
  assert.equal(liveWithRefund.can_refund, true);
});

test('M12 备份：按租户裁剪、清单校验、篡改与缺文件都能发现，恢复不覆盖其他租户', () => {
  const hashA = 'a'.repeat(64);
  const hashE = 'b'.repeat(64);
  const data = {
    schema_version: 1,
    projects: {
      p1: { id: 'p1', tenant_id: 'tenant_a', name: 'A 项目' },
      p2: { id: 'p2', tenant_id: 'tenant_b', name: 'B 项目' },
    },
    assets: { a1: { id: 'a1', tenant_id: 'tenant_a', sha256: hashA, ext: 'png' } },
    exports: { e1: { id: 'e1', tenant_id: 'tenant_a', package_sha256: hashE } },
    runs: { r1: { id: 'r1', tenant_id: 'tenant_a', status: 'completed' } },
  };
  const snapshot = tenantSnapshot(data, 'tenant_a');
  assert.equal(Object.keys(snapshot.projects).length, 1);
  assert.equal(snapshot.projects.p1.name, 'A 项目');
  assert.equal(Object.keys(snapshot.assets).length, 1);
  assert.equal(Object.keys(snapshot.exports).length, 1);

  const manifest = buildBackupManifest({
    backupId: 'bkp_1', tenantId: 'tenant_a', snapshot, createdAt: '2026-10-26T00:00:00.000Z', createdBy: 'owner',
  });
  const present = [`${hashA}.png`, `${hashE}.zip`];
  const ok = verifyBackupManifest({ manifest, snapshot, tenantId: 'tenant_a', presentBlobs: present });
  assert.equal(ok.ok, true);

  const tampered = structuredClone(snapshot);
  tampered.projects.p1.name = '被改过的名字';
  const tamperedResult = verifyBackupManifest({ manifest, snapshot: tampered, tenantId: 'tenant_a', presentBlobs: present });
  assert.equal(tamperedResult.ok, false);
  assert.ok(tamperedResult.issues.some(item => item.code === 'BACKUP_DATA_HASH_MISMATCH'));

  const missing = verifyBackupManifest({ manifest, snapshot, tenantId: 'tenant_a', presentBlobs: [`${hashA}.png`] });
  assert.ok(missing.issues.some(item => item.code === 'BACKUP_BLOB_MISSING'));

  const crossTenant = verifyBackupManifest({ manifest, snapshot, tenantId: 'tenant_b', presentBlobs: present });
  assert.ok(crossTenant.issues.some(item => item.code === 'BACKUP_TENANT_MISMATCH'));

  const draft = structuredClone(data);
  draft.projects.p3 = { id: 'p3', tenant_id: 'tenant_a', name: '备份后新增的项目' };
  mergeTenantSnapshot(draft, snapshot, 'tenant_a');
  assert.equal(draft.projects.p3, undefined, '恢复会移除备份之后新增的本租户记录');
  assert.equal(draft.projects.p2.name, 'B 项目', '其他租户不受影响');
});

test('M12 可观测性快照：只统计本租户、在途按真实状态算、计数不含内容', () => {
  const data = {
    schema_version: 1,
    projects: { p1: { tenant_id: 'tenant_a' }, p2: { tenant_id: 'tenant_b' } },
    runs: {
      r1: { tenant_id: 'tenant_a', status: 'running' },
      r2: { tenant_id: 'tenant_a', status: 'completed' },
      r3: { tenant_id: 'tenant_b', status: 'running' },
    },
    batches: { b1: { tenant_id: 'tenant_a', status: 'running' } },
    exports: { e1: { tenant_id: 'tenant_a' } },
    feedback: { f1: { tenant_id: 'tenant_a' } },
  };
  const snapshot = buildObservabilitySnapshot({
    data, tenantId: 'tenant_a',
    counters: { total: 5, by_status: { 200: 4, 409: 1 }, errors: 1, by_error: { CONFLICT: 1 } },
    startedAt: '2026-10-26T00:00:00.000Z', at: '2026-10-26T00:00:10.000Z',
    provider: { mode: 'mock', acceptance: 'simulated_only', capabilities: () => ({ simulated: true }) },
    balance: { available: 10, reserved: 0 },
  });
  assert.equal(snapshot.work.projects, 1);
  assert.equal(snapshot.work.runs, 2);
  assert.equal(snapshot.work.runs_active, 1);
  assert.equal(snapshot.work.runs_by_status.completed, 1);
  assert.equal(snapshot.work.batches_running, 1);
  assert.equal(snapshot.http.errors, 1);
  assert.equal(snapshot.http.by_error.CONFLICT, 1);
  assert.equal(snapshot.uptime_ms, 10_000);
  assert.equal(snapshot.provider.simulated, true);
  assert.equal(snapshot.credits.available, 10);
  assert.equal(snapshot.storage.tables.projects, 2, '存储计数是整库聚合，不按租户裁剪');
  assert.equal(snapshot.work.projects, 1);
});

// ---------- 端到端 ----------

async function freezeProject(port, projectId, tenant = 'tenant_a', actor = 'owner_m12') {
  const headers = as(tenant, actor);
  const asset = await request(port, `/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' },
    body: subjectPng(128, 128),
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));
  const truth = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers,
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '30ml', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '温和修护', critical: true, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '润泽精华' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  const preview = await request(port, `/api/projects/${projectId}/specs/preview`, {
    method: 'POST', headers, body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${projectId}/specs`, {
    method: 'POST', headers,
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
}

async function completeRun(port, projectId, key = 'm12-run-1') {
  const headers = as();
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers, body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const created = await request(port, '/api/runs', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json.run.id;
  let run = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const polled = await request(port, `/api/runs/${runId}`, { headers });
    run = polled.json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  assert.equal(run.status, 'completed', JSON.stringify(run.terminal_reason ?? run.status));
  return run;
}

test('M12 端到端：采用回流→实验口径→支付阻断→可观测性→备份恢复→租户隔离', async t => {
  const { port, dir } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  const tenant = await request(port, '/api/tenant', { headers });
  assert.equal(tenant.json.module, 'M12');

  // 1) 跑通一条真实任务链，复核到可发布
  const projectRes = await request(port, '/api/projects', {
    method: 'POST', headers, body: { name: 'M12 面霜', sku: 'M12-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(projectRes.status, 201, JSON.stringify(projectRes.json));
  const project = projectRes.json.project;
  await freezeProject(port, project.id);
  const run = await completeRun(port, project.id);

  for (const version of run.versions) {
    if (!version.report_id) continue;
    const reportRes = await request(port, `/api/quality-reports/${version.report_id}`, { headers });
    const report = reportRes.json.report;
    if (report.decision === 'publishable') continue;
    const decisions = report.checks
      .filter(item => item.status === 'unknown' && item.required === true && item.adjudicable === true)
      .map(item => ({ code: item.code, decision: 'pass', reason: 'M12 逐项复核', evidence: `复核 ${report.id}` }));
    const reviewed = await request(port, `/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', headers, body: { decisions, note: 'M12 回流前复核' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  }

  // 2) 采用：默认取当前选用版本，证据里带上报告结论与有效性
  const adopted = await request(port, '/api/feedback', {
    method: 'POST', headers, body: { run_id: run.id, decision: 'adopted', note: '主图可直接上架' },
  });
  assert.equal(adopted.status, 201, JSON.stringify(adopted.json));
  assert.ok(adopted.json.feedback.version_id);
  assert.equal(adopted.json.feedback.evidence.report_decision, 'publishable');
  assert.equal(adopted.json.feedback.evidence.report_validity, 'current');

  // 3) 驳回必须给理由；给理由后记录成功，最新一条决定统计口径
  const noReason = await request(port, '/api/feedback', {
    method: 'POST', headers, body: { run_id: run.id, decision: 'rejected' },
  });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.json.error, 'FEEDBACK_INVALID');
  const rejected = await request(port, '/api/feedback', {
    method: 'POST', headers,
    body: { run_id: run.id, version_id: adopted.json.feedback.version_id, decision: 'rejected', reason_code: 'CLIENT_REQUEST' },
  });
  assert.equal(rejected.status, 201, JSON.stringify(rejected.json));

  const listed = await request(port, `/api/feedback?run_id=${run.id}`, { headers });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.summary.rejected, 1, '同一版本以最新一条为准');
  assert.equal(listed.json.summary.adopted, 0);

  // 4) 效果导入：未授权 403；全是坏行 422；好行与坏行分开落库
  const outcomeRows = [
    { sku: 'M12-01', impressions: 120, clicks: 12, orders: 3, revenue_cents: 9000, cost_credits: 30 },
  ];
  const unauthorized = await request(port, '/api/outcomes', {
    method: 'POST', headers,
    body: { source: 'tmall_export', authorization_reference: 'AUTH-M12', rows: outcomeRows },
  });
  assert.equal(unauthorized.status, 403);
  assert.equal(unauthorized.json.error, 'OUTCOME_AUTHORIZATION_REQUIRED');

  const experimentRes = await request(port, '/api/experiments', {
    method: 'POST', headers, body: { name: '主图改版实验', hypothesis: '新主图提升转化', primary_metric: 'cvr' },
  });
  assert.equal(experimentRes.status, 201, JSON.stringify(experimentRes.json));
  const experimentId = experimentRes.json.experiment.id;

  const badOnly = await request(port, '/api/outcomes', {
    method: 'POST', headers,
    body: {
      authorized: true, source: 'tmall_export', authorization_reference: 'AUTH-M12',
      experiment_id: experimentId, arm: 'control',
      rows: [{ sku: 'M12-01', impressions: -1, clicks: 0, orders: 0, revenue_cents: 0, cost_credits: 0 }],
    },
  });
  assert.equal(badOnly.status, 422);
  assert.equal(badOnly.json.error, 'OUTCOME_NO_VALID_ROWS');

  const imported = await request(port, '/api/outcomes', {
    method: 'POST', headers,
    body: {
      authorized: true, source: 'tmall_export', authorization_reference: 'AUTH-M12',
      experiment_id: experimentId, arm: 'control',
      rows: [
        ...outcomeRows,
        { sku: 'M12-01', impressions: 120, clicks: 999, orders: 0, revenue_cents: 0, cost_credits: 0 },
      ],
    },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  assert.equal(imported.json.import.summary.valid, 1);
  assert.equal(imported.json.import.summary.invalid, 1);

  const variantImported = await request(port, '/api/outcomes', {
    method: 'POST', headers,
    body: {
      authorized: true, source: 'tmall_export', authorization_reference: 'AUTH-M12',
      experiment_id: experimentId, arm: 'variant',
      rows: [{ sku: 'M12-01', impressions: 120, clicks: 18, orders: 5, revenue_cents: 15000, cost_credits: 28 }],
    },
  });
  assert.equal(variantImported.status, 201, JSON.stringify(variantImported.json));

  const experiment = await request(port, `/api/experiments/${experimentId}`, { headers });
  assert.equal(experiment.status, 200, JSON.stringify(experiment.json));
  assert.equal(experiment.json.report.status, 'insufficient_sample');
  assert.equal(experiment.json.report.statistical_significance, 'not_computed');
  assert.equal(experiment.json.provenance.authorization_references[0], 'AUTH-M12');
  assert.equal(experiment.json.report.arms.control.totals.impressions, 120);
  assert.equal(experiment.json.report.arms.variant.totals.orders, 5);

  // 5) 套餐与真实支付：没有支付 Provider 时明确阻断，不生成订单
  const plans = await request(port, '/api/plans', { headers });
  assert.equal(plans.status, 200);
  assert.equal(plans.json.payment.mode, 'unconfigured');
  assert.equal(plans.json.payment.can_checkout, false);
  const checkout = await request(port, '/api/billing/orders', {
    method: 'POST', headers, body: { plan_id: 'plan_starter' },
  });
  assert.equal(checkout.status, 409);
  assert.equal(checkout.json.error, 'PAYMENT_PROVIDER_UNCONFIGURED');

  // 6) 可观测性：只统计本租户，且不含请求内容
  const metrics = await request(port, '/api/metrics', { headers });
  assert.equal(metrics.status, 200, JSON.stringify(metrics.json));
  assert.equal(metrics.json.work.projects, 1);
  assert.equal(metrics.json.work.runs >= 1, true);
  assert.equal(metrics.json.http.total > 0, true);
  assert.equal(JSON.stringify(metrics.json).includes('润泽精华'), false, '指标不得泄漏事实与提示词内容');

  // 7) 备份：创建→校验→未确认拒绝恢复→恢复后回到备份时点；其他租户看不到
  const backup = await request(port, '/api/backups', { method: 'POST', headers });
  assert.equal(backup.status, 201, JSON.stringify(backup.json));
  const backupId = backup.json.backup.id;
  assert.equal(backup.json.backup.counts.projects, 1);
  const verified = await request(port, `/api/backups/${backupId}/verify`, { method: 'POST', headers });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.equal(verified.json.ok, true);

  const second = await request(port, '/api/projects', {
    method: 'POST', headers, body: { name: '备份后新增', sku: 'M12-02', category: '面霜', platform: '天猫' },
  });
  assert.equal(second.status, 201);
  const beforeRestore = await request(port, '/api/projects', { headers });
  assert.equal(beforeRestore.json.projects.length, 2);

  const noConfirm = await request(port, `/api/backups/${backupId}/restore`, { method: 'POST', headers, body: {} });
  assert.equal(noConfirm.status, 422);
  assert.equal(noConfirm.json.error, 'BACKUP_CONFIRM_REQUIRED');

  const restored = await request(port, `/api/backups/${backupId}/restore`, {
    method: 'POST', headers, body: { confirm: true },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.restored, true);
  const afterRestore = await request(port, '/api/projects', { headers });
  assert.equal(afterRestore.json.projects.length, 1);
  assert.equal(afterRestore.json.projects[0].sku, 'M12-01');

  // 恢复不清空备份历史，同一备份可以再次校验与恢复
  const backupsAfterRestore = await request(port, '/api/backups', { headers });
  assert.equal(backupsAfterRestore.json.backups.length, 1);
  assert.ok(backupsAfterRestore.json.backups[0].restored_at);

  const crossTenantBackup = await request(port, `/api/backups/${backupId}`, { headers: as('tenant_demo') });
  assert.equal(crossTenantBackup.status, 404);
  const crossTenantFeedback = await request(port, '/api/feedback', { headers: as('tenant_demo') });
  assert.equal(crossTenantFeedback.status, 200);
  assert.equal(crossTenantFeedback.json.total, 0);

  // 8) 备份目录确实落在数据目录内（真实文件，不是内存假象）
  const backupFiles = path.join(dir, 'backups', backupId, 'manifest.json');
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(backupFiles, 'utf8'));
  assert.equal(manifest.tenant_id, 'tenant_a');
  assert.equal(manifest.counts.projects, 1);
});

test('M12 端到端：演示订单只发内部演示额度，重复结算与退款都被阻断', async t => {
  const { port } = await start(t, { initialCredits: 10, paymentProvider: demoPayment });
  const headers = as();

  const plans = await request(port, '/api/plans', { headers });
  assert.equal(plans.status, 200);
  assert.equal(plans.json.payment.mode, 'demo');
  assert.equal(plans.json.payment.can_checkout, true);
  assert.equal(plans.json.payment.real_money, false);

  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers, body: { plan_id: 'plan_starter' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.order.real_money, false);
  assert.equal(created.json.order.simulated, true);
  assert.equal(created.json.order.settlement, 'internal_demo_credits');
  const orderId = created.json.order.id;

  const settled = await request(port, `/api/billing/orders/${orderId}/settle`, { method: 'POST', headers });
  assert.equal(settled.status, 200, JSON.stringify(settled.json));
  assert.equal(settled.json.order.status, 'settled_demo');
  assert.equal(settled.json.balance.available, 2_010);
  assert.match(settled.json.notice, /未发生真实收款/);

  const again = await request(port, `/api/billing/orders/${orderId}/settle`, { method: 'POST', headers });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'ORDER_STATE_INVALID');

  const refund = await request(port, `/api/billing/orders/${orderId}/refund`, { method: 'POST', headers });
  assert.equal(refund.status, 409);
  assert.equal(refund.json.details.payment.can_refund, false);

  // 成员权限：viewer 可以看套餐，不能下单或结算
  const added = await request(port, '/api/members', {
    method: 'POST', headers, body: { actor_id: 'viewer_m12', role: 'viewer' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  const viewerCheckout = await request(port, '/api/billing/orders', {
    method: 'POST', headers: as('tenant_a', 'viewer_m12'), body: { plan_id: 'plan_trial' },
  });
  assert.equal(viewerCheckout.status, 403);
  assert.equal(viewerCheckout.json.error, 'FORBIDDEN');
});
