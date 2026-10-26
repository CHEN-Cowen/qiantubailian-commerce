import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, STATIC_FILES } from '../src/server.mjs';
import { LEDGER_TYPES, appendEntry, balanceOf, ledgerEntries } from '../src/credits.mjs';
import { DEFAULT_MAX_ATTEMPTS, PRICE_VERSION, quoteFromSpec, quoteStatus } from '../src/pricing.mjs';
import { MAX_SYNTHETIC_SIDE } from '../src/provider.mjs';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';
const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];

function pngBuffer(width = 1200, height = 1200, headerExtra = 0) {
  const header = Buffer.alloc(33 + headerExtra);
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

// 测试目录放在工作区内：系统临时目录对本进程高频写入不稳定（会出现 EPERM）
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

async function start(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm05-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 240, tickMs: 8, attemptTimeoutMs: 2_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    // close() 会先排空写队列；此处再清理临时目录。
    // 清理失败（Windows 上文件被占用时走回收站可能失败）只记录，不掩盖测试结论。
    await app.close();
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.error('[m05] 临时目录清理失败（不影响测试结论）', dir, error?.message ?? error);
    }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

const as = (tenant = TENANT_A, actor = 'tester_a') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

async function createProject(port, overrides = {}, tenant = TENANT_A) {
  const response = await request(port, '/api/projects', {
    method: 'POST', headers: as(tenant),
    body: { name: 'M05 面霜', sku: 'MC-05', category: '面霜', platform: '天猫', ...overrides },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.project;
}

async function uploadSubject(port, projectId, tenant = TENANT_A) {
  const response = await request(port, `/api/projects/${projectId}/assets?role=subject&filename=shot.png`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': 'image/png' }, body: pngBuffer(),
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.asset;
}

async function confirmTruth(port, projectId, { sourceAssetId = null, tenant = TENANT_A } = {}) {
  const response = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers: as(tenant),
    body: {
      base_version: 0, confirm: true,
      facts: [
        {
          key: '容量', value: '50g', critical: true, confirmed: true,
          source_type: sourceAssetId ? 'asset' : 'user_input',
          ...(sourceAssetId ? { source_asset_id: sourceAssetId } : {}),
        },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.truth_version;
}

/** 冻结一份 spec：自动选择第一个可接受的处理方式，保证进入 sane 状态。 */
async function freezeSpec(port, projectId, { templateId = 'tpl_listing_pack', platform = '天猫' } = {}, tenant = TENANT_A) {
  const preview = await request(port, `/api/projects/${projectId}/specs/preview`, {
    method: 'POST', headers: as(tenant), body: { template_id: templateId, platform },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${projectId}/specs`, {
    method: 'POST', headers: as(tenant),
    body: { template_id: templateId, platform, conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  return frozen.json.spec;
}

async function readyProject(port, { templateId } = {}) {
  const project = await createProject(port);
  await uploadSubject(port, project.id);
  await confirmTruth(port, project.id);
  const spec = await freezeSpec(port, project.id, { templateId });
  return { project, spec };
}

const createQuote = (port, projectId, body = {}, tenant = TENANT_A) => request(port, '/api/quotes', {
  method: 'POST', headers: as(tenant), body: { project_id: projectId, ...body },
});

const startRun = (port, { projectId, quoteId, key = `key-${Math.random()}`, scenario, tenant = TENANT_A } = {}) =>
  request(port, '/api/runs', {
    method: 'POST',
    headers: { ...as(tenant), 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quoteId, ...(scenario ? { scenario } : {}) },
  });

/** 等待任务进入某个终态，返回最终快照。 */
async function waitTerminal(port, runId, tenant = TENANT_A, timeoutMs = 15_000) {
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

/** 等到至少有一个 attempt 已提交（用于取消测试）。 */
async function waitSubmitted(port, runId, tenant = TENANT_A, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await request(port, `/api/runs/${runId}`, { headers: as(tenant) });
    const run = response.json.run;
    if (run.attempts.some(attempt => attempt.status === 'submitted')) return run;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('等待 attempt 提交超时');
}

// ---------- 1. 报价 ----------
test('M05 报价：按清单结构计价、带价格版本与有效期，且声明为演示额度', async t => {
  const { port } = await start(t);
  const { project, spec } = await readyProject(port);
  const created = await createQuote(port, project.id);
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const quote = created.json.quote;
  assert.equal(quote.price_version, PRICE_VERSION);
  assert.equal(quote.spec_ref.version, spec.version, '报价必须指回冻结快照');
  assert.equal(quote.spec_ref.content_hash, spec.content_hash);
  assert.ok(quote.expires_at > quote.created_at, '报价必须有有效期');
  assert.ok(quote.max_attempts <= DEFAULT_MAX_ATTEMPTS, '默认最多 3 轮');
  const sum = quote.lines.reduce((total, line) => total + line.credits, 0);
  assert.equal(quote.estimated_credits, sum, '估算额度等于清单明细之和');
  assert.ok(quote.max_credits <= quote.estimated_credits * quote.max_attempts);
  assert.ok(quote.notes.some(note => note.includes('内部演示积分')), '必须声明为内部演示额度');
  assert.equal(created.json.status, 'current');

  const fetched = await request(port, `/api/quotes/${quote.quote_id}`, { headers: as() });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.quote.max_credits, quote.max_credits);
});

test('M05 报价过期：必须重新取价，不允许用旧报价执行', async t => {
  let base = new Date('2026-10-26T10:00:00.000Z');
  const { port } = await start(t, { clock: () => base });
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;

  base = new Date(new Date(base).getTime() + 16 * 60 * 1000);
  const expired = await request(port, `/api/quotes/${quote.quote_id}`, { headers: as() });
  assert.equal(expired.json.status, 'expired');

  const run = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'expired-quote' });
  assert.equal(run.status, 409);
  assert.equal(run.json.error, 'QUOTE_EXPIRED');

  // 重新取价后可以执行，证明不是把过期报价放宽处理
  const fresh = (await createQuote(port, project.id)).json.quote;
  const retried = await startRun(port, { projectId: project.id, quoteId: fresh.quote_id, key: 'fresh-quote' });
  assert.equal(retried.status, 201);
});

test('M05 报价与快照不一致：冻结新版本后旧报价不得执行', async t => {
  const { port } = await start(t);
  const { project, spec } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  assert.equal(spec.version, 1);

  await request(port, `/api/projects/${project.id}/specs`, {
    method: 'POST', headers: as(),
    body: {
      template_id: 'tpl_listing_pack', platform: '天猫', base_version: 1,
      conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
    },
  });
  const mismatched = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'mismatch' });
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.json.error, 'QUOTE_SPEC_MISMATCH');
});

// ---------- 2. 额度：原子预留与并发不超卖 ----------
test('M05 并发提交：余额只够一次任务时只成功一个，且不调用供应商', async t => {
  // listing 模板报价上限 24；额度给 24，只允许一个任务完成预留
  const { port } = await start(t, { initialCredits: 24 });
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  assert.equal(quote.max_credits, 24);

  const attempts = await Promise.all([
    startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'race-1' }),
    startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'race-2' }),
    startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'race-3' }),
  ]);
  const created = attempts.filter(item => item.status === 201);
  const refused = attempts.filter(item => item.status === 402);
  assert.equal(created.length, 1, '只允许一个任务预留成功');
  assert.equal(refused.length, 2, '其余必须被拒绝');
  assert.equal(refused[0].json.error, 'INSUFFICIENT_CREDITS');
  assert.equal(refused[0].json.details.shortfall, quote.max_credits, '缺口必须说清楚');

  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.reserved, 24, '只预留了一份');
  assert.equal(balance.available, 0, '可用额度不得为负');

  const runs = await request(port, '/api/runs', { headers: as() });
  assert.equal(runs.json.runs.length, 1, '被拒绝的请求不得留下任务');
});

test('M05 幂等：同一键重复提交返回同一任务且不重复预留', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;

  const first = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'idem-1' });
  assert.equal(first.status, 201);
  const balanceAfterFirst = (await request(port, '/api/credits', { headers: as() })).json.balance;

  const second = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'idem-1' });
  assert.equal(second.status, 200, '重复提交返回已有任务');
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.run.id, first.json.run.id);

  const balanceAfterSecond = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balanceAfterSecond.reserved, balanceAfterFirst.reserved, '不得重复预留');

  const conflict = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'idem-1', scenario: 'timeout' });
  assert.equal(conflict.status, 409, '同一键换请求体必须报错');
  assert.equal(conflict.json.error, 'IDEMPOTENCY_KEY_CONFLICT');
});

test('M05 缺失幂等键：直接拒绝，避免重复提交产生重复费用', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const response = await request(port, '/api/runs', {
    method: 'POST', headers: as(), body: { project_id: project.id, quote_id: quote.quote_id },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'MISSING_IDEMPOTENCY_KEY');
});

// ---------- 3. 账本：唯一操作键 ----------
test('M05 账本：只增、余额不为负、同一操作键不重复扣费', () => {
  const data = { credit_accounts: {}, credit_entries: {} };
  const tenant = TENANT_A;
  balanceOf(data, tenant, { initialCredits: 100 });

  assert.ok(ledgerEntries(data, tenant).some(entry => entry.type === 'grant'));

  const reserve = appendEntry(data, {
    type: 'reserve', amount: 40, tenantId: tenant, jobId: 'job_1',
    uniqueOperationKey: 'reserve:job_1', memo: '预留', actor: 'tester',
  });
  assert.equal(reserve.applied, true);
  assert.equal(balanceOf(data, tenant).available, 60);

  const duplicate = appendEntry(data, {
    type: 'reserve', amount: 40, tenantId: tenant, jobId: 'job_1',
    uniqueOperationKey: 'reserve:job_1', memo: '重复到达', actor: 'tester',
  });
  assert.equal(duplicate.applied, false, '重复回调不得重复扣费');
  assert.equal(balanceOf(data, tenant).available, 60);
  assert.equal(duplicate.entry.id, reserve.entry.id, '返回同一条目');

  const capture = appendEntry(data, {
    type: 'capture', amount: 25, tenantId: tenant, jobId: 'job_1', attemptId: 'atp_1',
    uniqueOperationKey: 'capture:atp_1', actor: 'system',
  });
  assert.equal(capture.applied, true);
  const captureAgain = appendEntry(data, {
    type: 'capture', amount: 25, tenantId: tenant, jobId: 'job_1', attemptId: 'atp_1',
    uniqueOperationKey: 'capture:atp_1', actor: 'system',
  });
  assert.equal(captureAgain.applied, false);
  assert.equal(balanceOf(data, tenant).consumed, 25);

  assert.throws(() => appendEntry(data, {
    type: 'capture', amount: 30, tenantId: tenant, jobId: 'job_1', attemptId: 'atp_1',
    uniqueOperationKey: 'capture:atp_1', actor: 'system',
  }), error => error.code === 'OPERATION_KEY_CONFLICT');

  assert.throws(() => appendEntry(data, {
    type: 'reserve', amount: 1_000, tenantId: tenant, jobId: 'job_2',
    uniqueOperationKey: 'reserve:job_2', actor: 'tester',
  }), error => error.code === 'INSUFFICIENT_CREDITS');
  assert.equal(balanceOf(data, tenant).available, 60, '失败的预留必须不留痕迹');
  assert.equal(balanceOf(data, tenant).reserved, 15, '预留 40 已结算 25');
  assert.ok(LEDGER_TYPES.includes('refund'));
});

// ---------- 4. 正常成功：按已发生阶段结算 ----------
test('M05 成功任务：全部交付成功、只结算成功尝试、余量释放、产出可测', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'ok-run' });
  assert.equal(created.status, 201);

  const run = await waitTerminal(port, created.json.run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.quality_status, 'not_checked', '完成不等于质量通过');
  assert.equal(run.deliverables.length, quote.lines.length);
  assert.ok(run.deliverables.every(item => item.status === 'succeeded'));
  for (const attempt of run.attempts) {
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.charged_credits, attempt.planned_credits);
    assert.match(attempt.result.output_hash, /^[0-9a-f]{64}$/);
    assert.ok(attempt.output_file.bytes > 0);
  }
  const expected = quote.lines.reduce((sum, line) => sum + line.credits, 0);
  assert.equal(run.budget.captured_credits, expected, '只结算已发生且成功的部分');
  assert.equal(run.budget.released_credits, quote.max_credits - expected, '未发生部分释放');

  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.reserved, 0);
  assert.equal(balance.consumed, expected);
  assert.equal(balance.available, 240 - expected);
});

test('M05 产出文件真实可用：落盘产物能通过服务端图片头解析', async t => {
  const { port, dir } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'png-run' });
  const run = await waitTerminal(port, created.json.run.id);
  assert.equal(run.status, 'completed');

  const { inspectImage } = await import('../src/images.mjs');
  for (const attempt of run.attempts) {
    const bytes = await readFile(path.join(dir, 'blobs', `${attempt.result.output_hash}.png`));
    assert.equal(bytes.length, attempt.output_file.bytes, '产物大小与记录一致');
    const info = inspectImage(bytes);
    assert.equal(info.mime, 'image/png', '必须是能被服务端识别的真实 PNG');
    assert.equal(info.ext, 'png');
    assert.ok(info.width > 0 && info.width <= MAX_SYNTHETIC_SIDE, '模拟 Provider 的输出尺寸上限要说明');
    assert.ok(attempt.result.model.includes('synthetic'), '必须标明这是模拟产出，M06 才接真实模型');
  }
});

// ---------- 5. 供应商失败：不可向用户收费 ----------
test('M05 不可恢复失败：任务失败、捕获为 0、全部释放', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'rejected-run', scenario: 'content_rejected',
  });
  assert.equal(created.status, 201);
  const run = await waitTerminal(port, created.json.run.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.terminal_reason, 'unrecoverable_generation_failure');
  assert.equal(run.budget.captured_credits, 0, '供应商拒绝不得向用户收费');
  assert.equal(run.budget.released_credits, quote.max_credits);
  assert.ok(run.attempts.some(attempt => attempt.error?.code === 'CONTENT_REJECTED'));

  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.consumed, 0);
  assert.equal(balance.available, 240);
});

test('M05 限流重试：轮数上限触达后 limit_reached，不自动改资金也不收费', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'rate-run', scenario: 'rate_limited',
  });
  const run = await waitTerminal(port, created.json.run.id);
  assert.equal(run.status, 'limit_reached');
  assert.equal(run.budget.captured_credits, 0);
  for (const deliverable of run.deliverables) {
    assert.ok(deliverable.attempts_used <= quote.max_attempts, '不得超过最大轮数');
  }
  const totalAttempts = run.attempts.length;
  assert.ok(totalAttempts <= quote.lines.length * quote.max_attempts);
  assert.ok(run.attempts.every(attempt => attempt.charged_credits === 0));
});

test('M05 超时：本地超时判定后回到可重试失败，不无限等待', async t => {
  const { port } = await start(t, { attemptTimeoutMs: 200 });
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'timeout-run', scenario: 'timeout',
  });
  const run = await waitTerminal(port, created.json.run.id, TENANT_A, 20_000);
  assert.equal(run.status, 'limit_reached');
  assert.ok(run.attempts.some(attempt => attempt.error?.code === 'PROVIDER_TIMEOUT'));
  assert.equal(run.budget.captured_credits, 0, '超时未产生成果不得收费');
});

// ---------- 6. unknown 不重复提交 ----------
test('M05 unknown 轮询：不重复提交、不额外收费，最终仍成功', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'unknown-run', scenario: 'unknown_once',
  });
  const run = await waitTerminal(port, created.json.run.id);
  assert.equal(run.status, 'completed');
  for (const deliverable of run.deliverables) {
    const attempts = run.attempts.filter(item => item.deliverable_id === deliverable.deliverable_id);
    assert.equal(attempts.length, 1, 'unknown 不得触发重复提交');
  }
  const expected = quote.lines.reduce((sum, line) => sum + line.credits, 0);
  assert.equal(run.budget.captured_credits, expected, 'unknown 不得产生额外费用');
});

// ---------- 7. 取消与迟到结果 ----------
test('M05 取消：重复取消幂等，迟到结果不复活也不扣费', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, {
    projectId: project.id, quoteId: quote.quote_id, key: 'cancel-run', scenario: 'late_success',
  });
  await waitSubmitted(port, created.json.run.id);
  const cancelled = await request(port, `/api/runs/${created.json.run.id}/cancel`, {
    method: 'POST', headers: as(), body: { reason: 'changed_mind' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.run.cancel_requested, true);

  const again = await request(port, `/api/runs/${created.json.run.id}/cancel`, {
    method: 'POST', headers: as(), body: { reason: 'changed_mind' },
  });
  assert.equal(again.status, 200, '重复取消幂等');

  const run = await waitTerminal(port, created.json.run.id, TENANT_A, 20_000);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.cancel_reason, 'changed_mind');
  assert.equal(run.budget.captured_credits, 0, '取消前没有已结算的成功阶段就不得收费');
  const ignored = run.attempts.filter(attempt => attempt.status === 'late_result_ignored');
  for (const attempt of ignored) {
    assert.equal(attempt.charged_credits, 0, '迟到结果不结算');
    assert.equal(attempt.result, null, '迟到结果不得写成可交付产物');
    assert.equal(attempt.output_file, undefined, '取消后不落盘成果');
  }

  // 迟到结果即使到达，也不写产物、不产生费用
  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.consumed, 0);
  assert.equal(balance.reserved, 0);
  assert.ok(ignored.length === 0 || ignored.every(attempt => attempt.charged_credits === 0));
});

// ---------- 8. 预算需确认 ----------
test('M05 预算不足：进入 awaiting_confirmation 且不自动扩大预算', async t => {
  const { port } = await start(t);
  // 社交图文模板：单轮所需额度大于模板预算上限，必然触发等待确认
  const { project, spec } = await readyProject(port, { templateId: 'tpl_social_note' });
  const quote = (await createQuote(port, project.id)).json.quote;
  assert.ok(quote.max_credits < quote.estimated_credits, '该模板专门用于验证预算封顶场景');

  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'await-run' });
  assert.equal(created.status, 201);
  const runId = created.json.run.id;

  let pending = null;
  for (let attempt = 0; attempt < 200 && pending === null; attempt += 1) {
    const snapshot = await request(port, `/api/runs/${runId}`, { headers: as() });
    if (snapshot.json.run.status === 'awaiting_confirmation') pending = snapshot.json.run;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(pending, '应当进入等待确认状态');
  assert.ok(pending.pending_confirmation.needed_credits > 0);
  assert.ok(pending.pending_confirmation.note.includes('不会自动扩大'));
  const balanceWhileWaiting = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balanceWhileWaiting.reserved, quote.max_credits, '等待期间不偷偷多留');

  const confirmed = await request(port, `/api/runs/${runId}/budget-confirmation`, {
    method: 'POST', headers: as(), body: { confirm: true, extra_credits: 20 },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.run.status !== 'awaiting_confirmation', true);

  const run = await waitTerminal(port, runId, TENANT_A, 20_000);
  assert.equal(run.status, 'completed');
  assert.ok(run.budget.captured_credits > 0);
  assert.ok(run.budget.reserved_credits === quote.max_credits + 20);
  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.available, 240 - run.budget.captured_credits);
});

test('M05 拒绝追加预算：任务按取消处理，未发生部分释放', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port, { templateId: 'tpl_social_note' });
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'await-decline' });
  const runId = created.json.run.id;
  let awaiting = false;
  for (let attempt = 0; attempt < 200 && !awaiting; attempt += 1) {
    const snapshot = await request(port, `/api/runs/${runId}`, { headers: as() });
    awaiting = snapshot.json.run.status === 'awaiting_confirmation';
    if (!awaiting) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(awaiting);
  const declined = await request(port, `/api/runs/${runId}/budget-confirmation`, {
    method: 'POST', headers: as(), body: { confirm: false },
  });
  assert.equal(declined.status, 200);
  const run = await waitTerminal(port, runId, TENANT_A, 15_000);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.cancel_reason, 'budget_not_confirmed');
  assert.equal(run.budget.reserved_credits - run.budget.captured_credits - run.budget.released_credits, 0);
});

// ---------- 9. SSE 与事件 ----------
test('M05 SSE：事件流可按 Last-Event-ID 续传且不重放旧事件', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'sse-run' });
  const runId = created.json.run.id;
  await waitTerminal(port, runId);

  const first = await collectSse(port, `/api/runs/${runId}/events`);
  assert.match(first.headers['content-type'], /text\/event-stream/);
  const sequences = first.sequences();
  assert.ok(sequences.length > 0, '应当拿到事件');
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right), '事件必须按 sequence 单调');

  const since = sequences[Math.floor(sequences.length / 2)];
  const resumed = await collectSse(port, `/api/runs/${runId}/events?last_event_id=${since}`);
  assert.ok(resumed.sequences().every(value => value > since), '续传只返回之后的事件');
  assert.ok(resumed.sequences().length < sequences.length, '续传不重放旧事件');
  const repeatedId = new Set();
  for (const line of first.raw.split('\n')) {
    if (!line.startsWith('id: ')) continue;
    const value = line.slice(4);
    assert.ok(!repeatedId.has(value), `event_id 重复：${value}`);
    repeatedId.add(value);
  }
});

test('M05 SSE 契约：事件名统一为 message，终态标记不携带 id', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'sse-contract-run' });
  const runId = created.json.run.id;
  await waitTerminal(port, runId);

  const stream = await collectSse(port, `/api/runs/${runId}/events`);
  const blocks = stream.raw.split('\n\n').filter(block => block.trim().length > 0);
  assert.ok(blocks.length > 0, '应当拿到至少一条 SSE 消息');

  const namedEvents = blocks.map(block => /^event:\s*(.+)$/m.exec(block)?.[1]).filter(Boolean);
  assert.ok(namedEvents.length > 0, '每条消息都应显式声明事件名');
  assert.ok(namedEvents.every(name => name === 'message'),
    `EventSource 只把 message 映射到 onmessage，其他事件名收不到：${namedEvents.join(',')}`);

  // 终态标记是收尾信号而非领域事件：不能带 id，否则会占用 Last-Event-ID 游标
  const terminalBlock = blocks.find(block => /"terminal"/.test(block));
  assert.ok(terminalBlock, '终态必须以消息形式送达');
  assert.ok(!/^id:\s/m.test(terminalBlock), '终态标记不得携带 id，避免污染续传游标');
  const terminalPayload = JSON.parse(/^data:\s*(.+)$/m.exec(terminalBlock)[1]);
  assert.ok(typeof terminalPayload.terminal === 'string', '终态标记需带 terminal 字段');
  assert.equal(terminalPayload.sequence, undefined, '终态标记不是领域事件，不应有 sequence');

  // 真实领域事件必须带 id，且 id 就是 sequence
  const domainBlock = blocks.find(block => /"sequence":\s*\d+/.test(block));
  assert.ok(domainBlock, '应当有领域事件');
  const domainId = Number(/^id:\s*(\d+)$/m.exec(domainBlock)[1]);
  const domainPayload = JSON.parse(/^data:\s*(.+)$/m.exec(domainBlock)[1]);
  assert.equal(domainId, domainPayload.sequence, '领域事件的 id 必须等于 sequence');
});

// ---------- 10. 恢复与跨租户 ----------
test('M05 重启恢复：已提交的任务按幂等键重挂，继续完成后不重复结算', async t => {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm05-restart-'));
  // tick 设大：确保关闭时 attempt 仍在供应商侧飞行，恢复路径必然被走到
  const scenario = { allowScenarioInjection: true, initialCredits: 240, tickMs: 2_000 };
  const firstApp = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS, ...scenario });
  const { port: portA } = await firstApp.listen();
  const { project } = await readyProject(portA);
  const quote = (await createQuote(portA, project.id)).json.quote;
  const created = await startRun(portA, { projectId: project.id, quoteId: quote.quote_id, key: 'restart-run' });
  const runId = created.json.run.id;
  await waitSubmitted(portA, runId);
  await firstApp.close();

  const secondApp = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS, ...scenario });
  const { port: portB } = await secondApp.listen();
  try {
    const run = await waitTerminal(portB, runId, TENANT_A, 25_000);
    assert.equal(run.status, 'completed', '恢复后应当继续并正常完成');
    const expected = quote.lines.reduce((sum, line) => sum + line.credits, 0);
    assert.equal(run.budget.captured_credits, expected, '不得重复结算');
    // 事件尾部只保留最近若干条，恢复痕迹要用完整事件流确认
    const stream = await collectSse(portB, `/api/runs/${runId}/events`, { timeoutMs: 5_000 });
    const statuses = [...stream.raw.matchAll(/"status":"([a-z_]+)"/g)].map(match => match[1]);
    assert.ok(statuses.includes('recovered'), '恢复过程必须留痕');
    assert.equal(
      statuses.filter(status => status === 'attempt_submitted').length,
      quote.lines.length,
      '恢复后不得为每个交付项重复提交调用',
    );

    const balance = (await request(portB, '/api/credits', { headers: as() })).json.balance;
    assert.equal(balance.consumed, expected, '重启不应产生第二笔费用');
  } finally {
    await secondApp.close();
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.error('[m05] 临时目录清理失败（不影响测试结论）', dir, error?.message ?? error);
    }
  }
});

test('M05 跨租户：他人任务的读取与取消一律按不存在处理', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const quote = (await createQuote(port, project.id)).json.quote;
  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'tenant-run' });
  const runId = created.json.run.id;

  const read = await request(port, `/api/runs/${runId}`, { headers: as(TENANT_B) });
  assert.equal(read.status, 404);
  assert.equal(read.json.error, 'NOT_FOUND');

  const cancel = await request(port, `/api/runs/${runId}/cancel`, {
    method: 'POST', headers: as(TENANT_B), body: { reason: 'other' },
  });
  assert.equal(cancel.status, 404);

  const list = await request(port, '/api/runs', { headers: as(TENANT_B) });
  assert.equal(list.json.runs.length, 0);

  const own = await request(port, `/api/runs/${runId}`, { headers: as() });
  assert.equal(own.status, 200);
  await waitTerminal(port, runId);
});

test('M05 生产前置未满足：不允许绕过闸口直接开跑', async t => {
  const { port } = await start(t);
  const project = await createProject(port, { sku: 'MC-BLOCKED' });
  // 先正常走通闸口并冻结配置；随后替换主体素材，使已确认事实的来源素材失效
  const asset = await uploadSubject(port, project.id);
  await confirmTruth(port, project.id, { sourceAssetId: asset.id });
  await freezeSpec(port, project.id);
  const replaced = await request(port, `/api/projects/${project.id}/assets?role=subject&filename=shot2.png&on_conflict=replace`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' }, body: pngBuffer(),
  });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.json));
  const blocked = await request(port, `/api/projects/${project.id}/readiness`, { headers: as() });
  assert.equal(blocked.json.can_start_production, false, '事实来源素材被替换后闸口必须重新阻断');
  assert.ok(blocked.json.blockers.some(item => item.code === 'TRUTH_SOURCE_SUPERSEDED'),
    JSON.stringify(blocked.json.blockers));
  const quote = (await createQuote(port, project.id)).json.quote;
  const run = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'blocked-run' });
  assert.equal(run.status, 409);
  assert.equal(run.json.error, 'READINESS_BLOCKED');
  const balance = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.reserved, 0, '闸口拦截时不得预留额度');
});

// ---------- 11. 前端接线契约 ----------
test('M05 前端契约：静态白名单与任务面板元素齐备', async t => {
  for (const file of ['m05.js', 'm05.css']) {
    assert.ok(STATIC_FILES.includes(file), `STATIC_FILES 缺少 ${file}`);
  }
  const root = path.dirname(fileURLToPath(import.meta.url));
  const html = await readFile(path.join(root, '..', 'frontend', 'index.html'), 'utf8');
  for (const id of ['run-dialog', 'run-body', 'run-quote', 'run-start', 'run-cancel', 'run-events']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.ok(html.includes('m05.js'), 'index.html 未引入 m05.js');

  const script = await readFile(path.join(root, '..', 'frontend', 'm05.js'), 'utf8');
  assert.match(script, /EventSource/, '必须接到 SSE 事件流');
  assert.match(script, /last_event_id|Last-Event-ID|idempotency/i, '必须处理续传或幂等');
  assert.match(script, /取消|cancel/, '必须提供取消入口');
  // 服务端统一发 event: message，前端只能监听 message；监听自定义事件名会永远收不到
  assert.ok(!/addEventListener\(\s*['"]terminal['"]/.test(script), '前端不得监听不存在的 terminal 事件名');
  assert.match(script, /addEventListener\(\s*['"]message['"]/, '前端必须监听 message 事件');
  assert.match(script, /payload\.terminal|\.terminal\b/, '前端必须从消息载荷里识别终态标记');

  const api = await readFile(path.join(root, '..', 'frontend', 'api.js'), 'utf8');
  for (const method of ['createQuote', 'getQuote', 'credits', 'createRun', 'getRun', 'cancelRun', 'confirmRunBudget']) {
    assert.ok(api.includes(`${method}:`), `api.js 缺少 ${method}`);
  }
});

/** 收集一段 SSE 输出（读到 terminal 或超时即停）。 */
async function collectSse(port, route, { timeoutMs = 3_000, tenant = TENANT_A } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers: as(tenant) }, res => {
      let raw = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          headers: res.headers,
          raw,
          sequences: () => raw.split('\n').filter(line => line.startsWith('id: ')).map(line => Number(line.slice(4))),
        });
      };
      const timer = setTimeout(() => { finish(); req.destroy(); }, timeoutMs);
      res.on('data', chunk => { raw += chunk.toString('utf8'); });
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('error', reject);
    req.end();
  });
}
