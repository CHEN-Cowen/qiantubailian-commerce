import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';
const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

function pngBuffer(width = 1200, height = 1200) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'r02-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 240, tickMs: 8, attemptTimeoutMs: 30_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

const as = (tenant = TENANT_A, actor = 'tester_r02') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

async function readyProject(port, { templateId = 'tpl_listing_pack', tenant = TENANT_A } = {}) {
  const projectResponse = await request(port, '/api/projects', {
    method: 'POST', headers: as(tenant),
    body: { name: 'R02 香薰', sku: `SKU-${Math.random()}`, category: '香薰', platform: '天猫' },
  });
  assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.json));
  const project = projectResponse.json.project;
  const asset = await request(port, `/api/projects/${project.id}/assets?role=subject&filename=shot.png`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': 'image/png' }, body: pngBuffer(),
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));
  const truth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(tenant),
    body: {
      base_version: 0, confirm: true,
      facts: [
        {
          key: '容量', value: '120g', critical: true, confirmed: true,
          source_type: 'asset', source_asset_id: asset.json.asset.id,
        },
        { key: '核心卖点', value: '木质香调', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '暮光香薰' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  const preview = await request(port, `/api/projects/${project.id}/specs/preview`, {
    method: 'POST', headers: as(tenant), body: { template_id: templateId, platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${project.id}/specs`, {
    method: 'POST', headers: as(tenant),
    body: { template_id: templateId, platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(tenant), body: { project_id: project.id },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  return { project, quote: quote.json.quote, tenant };
}

function startRun(port, { projectId, quoteId, key = `r02-${Math.random()}`, scenario, tenant = TENANT_A }) {
  return request(port, '/api/runs', {
    method: 'POST',
    headers: { ...as(tenant), 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quoteId, ...(scenario ? { scenario } : {}) },
  });
}

async function waitStatus(port, runId, statuses, tenant = TENANT_A, timeoutMs = 25_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const snapshot = await request(port, `/api/runs/${runId}`, { headers: as(tenant) });
    last = snapshot.json?.run ?? null;
    if (last && statuses.includes(last.status)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`任务未进入 ${statuses.join('/')}，最后状态 ${last?.status}`);
}

test('R02 交付数量展开：封面 1 张 + 内页 2 张确有 3 个可追踪产物', async t => {
  const { port } = await start(t);
  const { project, quote } = await readyProject(port, { templateId: 'tpl_social_note' });
  // 模板：cover count=1，inner count=2；报价总额必须与三张一一对应
  const lineTotals = quote.lines.reduce((sum, line) => sum + line.credits, 0);
  assert.equal(quote.estimated_credits, lineTotals);

  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'count-expand' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  let run = await waitStatus(port, created.json.run.id, ['awaiting_confirmation']);
  // 该模板预算上限低于轮数需求，先按既有规则确认追加预算
  const confirmed = await request(port, `/api/runs/${created.json.run.id}/budget-confirmation`, {
    method: 'POST', headers: as(), body: { confirm: true, extra_credits: 20 },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  run = await waitStatus(port, created.json.run.id, ['completed', 'limit_reached', 'failed']);
  assert.equal(run.status, 'completed');

  assert.equal(run.deliverables.length, 3, '数量必须展开为独立图片项，不能只交一张');
  const inner = run.deliverables.filter(item => item.template_deliverable_id === 'inner');
  assert.equal(inner.length, 2);
  assert.deepEqual(inner.map(item => item.unit_index).sort(), [1, 2]);
  assert.equal(new Set(run.deliverables.map(item => item.deliverable_id)).size, 3, '每个图片项 ID 必须唯一');
  assert.equal(run.deliverables.every(item => item.status === 'succeeded'), true);
  assert.equal(run.delivery_completeness.expected_units, 3);
  assert.equal(run.delivery_completeness.produced_units, 3);
  assert.equal(run.delivery_completeness.complete, true);
  assert.equal(run.versions.filter(version => version.active).length, 3, '每张都要有独立的活动版本与产物');
  const captured = run.attempts.reduce((sum, attempt) => sum + attempt.charged_credits, 0);
  assert.equal(captured, run.budget.captured_credits);
});

test('R02 未知结果长期存在：不重复提交、预算继续冻结、转人工核对', async t => {
  const { port } = await start(t, { attemptTimeoutMs: 150, unknownReconcileMs: 400 });
  const { project, quote } = await readyProject(port);
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'unknown-hold', scenario: 'timeout',
  });
  assert.equal(created.status, 201);
  const run = await waitStatus(port, created.json.run.id, ['needs_attention']);
  assert.equal(run.terminal_reason, 'provider_result_unknown');
  assert.equal(run.attention.reason, 'PROVIDER_RESULT_UNKNOWN');
  assert.equal(run.attention.reserved_credits, quote.max_credits);
  assert.equal(run.budget.captured_credits, 0);
  // 每个交付项仅有 1 次调用，说明本地超时没有换新请求盲重试
  for (const deliverable of run.deliverables) {
    const attempts = run.attempts.filter(item => item.deliverable_id === deliverable.deliverable_id);
    assert.ok(attempts.length <= 1, `${deliverable.label} 不得重复提交`);
  }
  assert.ok(run.attempts.some(attempt => attempt.status === 'unknown'), '超时调用必须保留为未知');
  // 任务停在待核对后，再次推进也不会产生新的外部调用
  const before = run.attempts.length;
  await new Promise(resolve => setTimeout(resolve, 300));
  const still = await request(port, `/api/runs/${run.id}`, { headers: as() });
  assert.equal(still.json.run.status, 'needs_attention');
  assert.equal(still.json.run.attempts.length, before);

  // 人工核对：供应商确认无结果 → 失败并释放未发生额度
  const reconciled = await request(port, `/api/runs/${run.id}/reconcile`, {
    method: 'POST', headers: as(), body: { outcome: 'provider_failed', note: '后台核对无产出' },
  });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.json));
  assert.equal(reconciled.json.run.status, 'failed');
  assert.equal(reconciled.json.run.attention.resolved_by, 'tester_r02');
  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.reserved, 0);
  assert.equal(balance.consumed, 0);
});

test('R02 未知但已产出：按已发生阶段结算并记录供应商成本，交付仍不完整', async t => {
  const { port } = await start(t, { attemptTimeoutMs: 150, unknownReconcileMs: 400 });
  const { project, quote } = await readyProject(port);
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'unknown-unavailable', scenario: 'timeout',
  });
  const run = await waitStatus(port, created.json.run.id, ['needs_attention']);

  const reconciled = await request(port, `/api/runs/${run.id}/reconcile`, {
    method: 'POST', headers: as(), body: { outcome: 'provider_succeeded_unavailable', note: '供应商后台显示已完成但结果不可下载' },
  });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.json));
  const after = reconciled.json.run;
  assert.equal(after.status, 'failed');
  assert.equal(after.terminal_reason, 'provider_result_unavailable');
  assert.ok(after.budget.captured_credits > 0, '结果不可取回但成本已发生，必须结算，不能伪装免费');
  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.consumed, after.budget.captured_credits);
  assert.equal(balance.reserved, 0);
  assert.equal(after.delivery_completeness.complete, false);
  assert.ok(after.delivery_completeness.missing_units > 0);
  assert.equal(after.supplier_cost.internal_credits_charged, after.budget.captured_credits);
  assert.equal(after.supplier_cost.provider_cost_reported, false, '未回传真实金额时不得编造成本');
});

test('R02 取消后迟到结果不复活，未知调用同样可取消', async t => {
  const { port } = await start(t, { attemptTimeoutMs: 150 });
  const { project, quote } = await readyProject(port);
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'cancel-unknown', scenario: 'timeout',
  });
  await waitStatus(port, created.json.run.id, ['running', 'queued']);
  await new Promise(resolve => setTimeout(resolve, 250));
  const cancelled = await request(port, `/api/runs/${created.json.run.id}/cancel`, {
    method: 'POST', headers: as(), body: { reason: '改主意了' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const run = await waitStatus(port, created.json.run.id, ['cancelled']);
  assert.equal(run.budget.captured_credits, 0);
  assert.equal(run.attempts.every(attempt => attempt.status !== 'unknown' || attempt.charged_credits === 0), true);
  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.reserved, 0, '取消后必须释放未发生额度');
  assert.equal(balance.consumed, 0);
  // 取消后继续推进，不得产生新调用或复活任务
  const before = run.attempts.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  const still = await request(port, `/api/runs/${run.id}`, { headers: as() });
  assert.equal(still.json.run.status, 'cancelled');
  assert.equal(still.json.run.attempts.length, before);
});

test('R02 供应商级并发上限：单任务上限不等于全局上限', async t => {
  const { port } = await start(t, {
    tickMs: 5, maxConcurrency: 2, providerMaxConcurrency: 1, tenantMaxConcurrency: 10,
  });
  const first = await readyProject(port);
  const second = await readyProject(port);
  const key = `provider-cap-${Math.random()}`;
  const runA = await startRun(port, { projectId: first.project.id, quoteId: first.quote.quote_id, key: `${key}-a` });
  const runB = await startRun(port, { projectId: second.project.id, quoteId: second.quote.quote_id, key: `${key}-b` });
  assert.equal(runA.status, 201);
  assert.equal(runB.status, 201);

  let maxSimultaneous = 0;
  let runAState = null;
  let runBState = null;
  const started = Date.now();
  while (Date.now() - started < 25_000) {
    const [a, b] = await Promise.all([
      request(port, `/api/runs/${runA.json.run.id}`, { headers: as() }),
      request(port, `/api/runs/${runB.json.run.id}`, { headers: as() }),
    ]);
    runAState = a.json.run;
    runBState = b.json.run;
    const flying = [...runAState.attempts, ...runBState.attempts]
      .filter(attempt => attempt.status === 'submitted').length;
    maxSimultaneous = Math.max(maxSimultaneous, flying);
    if (['completed', 'failed', 'limit_reached'].includes(runAState.status)
      && ['completed', 'failed', 'limit_reached'].includes(runBState.status)) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(maxSimultaneous <= 1, `供应商级并发不得超过 1，实际观察到 ${maxSimultaneous}`);
  assert.ok((runAState.rate_limited_count ?? 0) + (runBState.rate_limited_count ?? 0) > 0,
    '触达上限必须留事件，不能静默排队');
  assert.equal(runAState.status, 'completed');
  assert.equal(runBState.status, 'completed');
});
