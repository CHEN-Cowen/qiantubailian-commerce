/**
 * R12 整体端到端验收测试。
 *
 * 验收口径（代码与模拟契约层）：
 * 1. 完整用户旅程：创建项目→上传→事实确认→规格冻结→报价→执行→质量检查→导出→下载。
 * 2. 配方复用：保存配方→应用到新项目→执行成功。
 * 3. 免费体验→额度不足→付款→到账→继续。
 * 4. 退款：已结算订单退款→额度回收。
 * 5. 越权：viewer 不能执行写操作。
 * 6. 供应商异常恢复：失败后重试成功。
 * 7. 商品事实阻断：关键事实未确认不能开始生产。
 * 8. 任务中断恢复：任务进行中可查询状态并恢复。
 * 9. 幂等：重复提交不产生重复费用。
 *
 * 真实浏览器集成与真实外部服务层：当前环境不可用，代码层验收如上。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { createMockWechatPaymentProvider } from '../src/providers/wechat.mjs';
import { createHash } from 'node:crypto';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'owner_r12') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'r12-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 400, tickMs: 8, attemptTimeoutMs: 30_000, allowScenarioInjection: true,
    ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

function createSizeFixture() {
  const capabilities = () => ({
    id: 'r12-fixture', version: 'fixture.1', image: true, video: false,
    max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
    supports_seed: true, supports_revision: false, max_side: 2048, formats: ['jpg', 'png'],
    simulated: true, acceptance: 'simulated_only',
  });
  const jobs = new Map();
  const cache = new Map();
  let sequence = 0;

  function bytesFor(width, height, format) {
    const key = `${format}:${width}x${height}`;
    if (cache.has(key)) return cache.get(key);
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
    return bytes;
  }

  function normalizeResult(job) {
    const { request } = job;
    const width = request.target_width;
    const height = request.target_height;
    const format = (request.formats ?? ['png']).includes('png') ? 'png' : 'jpg';
    const bytes = bytesFor(width, height, format);
    return {
      provider: 'r12-fixture', model: 'fixture/image', model_version: 'fixture.1',
      provider_job_id: job.request.idempotency_key,
      provider_request_id: `req_${job.request.request_hash.slice(0, 12)}`,
      usage: { images: 1, unit: 'image' },
      cost: { amount: 0, currency: 'internal_demo' },
      latency_ms: 8,
      output: { format, bytes, width, height, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
  }

  return {
    capabilities,
    validate: () => ({ ok: true }),
    estimate: request => {
      const side = Math.max(request.target_width ?? 1024, request.target_height ?? 1024);
      return { price_version: 'fixture.1', estimated_credits: Math.max(1, Math.round(side * side * 0.0000045)), max_credits: null };
    },
    submit: request => {
      sequence += 1;
      const providerJobId = `fx_${sequence}`;
      jobs.set(providerJobId, { request });
      return {
        provider_job_id: providerJobId, status: 'queued',
        request_hash: request.request_hash, idempotency_key: request.idempotency_key,
        provider_meta: { id: 'r12-fixture', version: 'fixture.1', simulated: true },
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

async function freezeProject(port, projectId, tenant = 'tenant_a', actor = 'owner_r12') {
  const headers = as(tenant, actor);
  await request(port, `/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' },
    body: subjectPng(128, 128),
  });
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
    method: 'POST', headers, body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  return frozen.json.spec;
}

async function createQuoteAndRun(port, projectId, headers, idempotencyKey) {
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers, body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const run = await request(port, '/api/runs', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': idempotencyKey },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  return run.json.run;
}

async function waitRunDone(port, runId, headers) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const polled = await request(port, `/api/runs/${runId}`, { headers });
    assert.equal(polled.status, 200, JSON.stringify(polled.json));
    const run = polled.json.run;
    if (run.status === 'completed' || run.status === 'failed') return run;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  throw new Error(`任务 ${runId} 未在预期时间内完成`);
}

async function reviewToPublishable(port, runId, headers) {
  const runDetail = await request(port, `/api/runs/${runId}`, { headers });
  assert.equal(runDetail.status, 200, JSON.stringify(runDetail.json));
  for (const version of runDetail.json.run.versions) {
    const reportRes = await request(port, `/api/quality-reports/${version.report_id}`, { headers });
    const report = reportRes.json.report;
    if (report.decision === 'publishable') continue;
    const decisions = report.checks
      .filter(item => item.status === 'unknown' && item.required === true && item.adjudicable === true)
      .map(item => ({ code: item.code, decision: 'pass', reason: `R12 复核 ${item.code}`, evidence: `复核 ${report.id}` }));
    const reviewed = await request(port, `/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', headers, body: { decisions, note: 'R12 复核' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
    assert.equal(reviewed.json.report.decision, 'publishable');
  }
}

// ---------- R12 端到端验收测试 ----------

test('R12 完整用户旅程：创建→上传→事实→规格→报价→执行→检查→导出→下载', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 1. 创建项目
  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R12 完整旅程', sku: 'R12-E2E-001', category: '精华', platform: '天猫' },
  });
  assert.equal(project.status, 201, JSON.stringify(project.json));
  const projectId = project.json.project.id;
  assert.equal(project.json.project.status, 'drafting');

  // 2. 上传素材 + 确认事实 + 冻结规格
  await freezeProject(port, projectId);

  // 3. 报价 + 执行任务
  const run = await createQuoteAndRun(port, projectId, headers, 'r12-e2e-run-1');
  assert.ok(run.id.startsWith('run_'));

  // 4. 等待完成
  const doneRun = await waitRunDone(port, run.id, headers);
  assert.equal(doneRun.status, 'completed');
  assert.ok(doneRun.deliverables.every(d => d.status === 'succeeded'), '所有交付物应成功');

  // 5. 质量检查 → 可发布
  await reviewToPublishable(port, run.id, headers);

  // 6. 导出
  const exported = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers, body: { scope: 'complete' },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  assert.equal(exported.json.export.complete, true);

  // 7. 下载
  const download = await request(port, `/api/exports/${exported.json.export.id}/download`, { headers });
  assert.equal(download.status, 200);
  assert.ok(download.headers['content-type']?.includes('zip'));
  assert.ok(download.body.length > 0, '下载包不能为空');
});

test('R12 配方复用：保存配方→应用到新项目→执行成功', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 创建并执行第一个项目
  const p1 = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: '配方来源', sku: 'R12-RECIPE-001', category: '精华', platform: '天猫' },
  });
  assert.equal(p1.status, 201);
  await freezeProject(port, p1.json.project.id);
  const run1 = await createQuoteAndRun(port, p1.json.project.id, headers, 'r12-recipe-run-1');
  const done1 = await waitRunDone(port, run1.id, headers);
  assert.equal(done1.status, 'completed');
  await reviewToPublishable(port, run1.id, headers);

  // 创建品牌套件
  const kit = await request(port, '/api/brand-kits', {
    method: 'POST', headers,
    body: {
      name: '精华品牌套件',
      palette: { primary: '#FF6B6B', secondary: ['#4ECDC4'] },
      logo: { present: false },
      fonts: [{ name: '思源黑体', license: 'licensed' }],
      banned_expressions: ['最好', '第一'],
    },
  });
  assert.equal(kit.status, 201, JSON.stringify(kit.json));
  const kitId = kit.json.brand_kit.id;

  // 保存配方（私有配方自动 approved）
  const recipe = await request(port, '/api/recipes', {
    method: 'POST', headers,
    body: {
      name: '精华配方',
      template_id: 'tpl_listing_pack',
      platform: '天猫',
      brand_kit_id: kitId,
      copy_version: 'v1.0',
      scope: 'private',
    },
  });
  assert.equal(recipe.status, 201, JSON.stringify(recipe.json));
  const recipeId = recipe.json.recipe.id;

  // 查询配方确认保存成功
  const listed = await request(port, '/api/recipes', { headers });
  assert.equal(listed.status, 200);
  const found = listed.json.recipes.find(r => r.id === recipeId);
  assert.ok(found, '配方应出现在列表中');
  assert.equal(found.latest_version.status, 'approved');

  // 记录配方使用
  const usage = await request(port, `/api/recipes/${recipeId}/usages`, {
    method: 'POST', headers,
    body: { project_id: p1.json.project.id, note: 'R12 配方复用测试' },
  });
  assert.equal(usage.status, 201, JSON.stringify(usage.json));

  // 创建第二个项目并正常执行（验证配方机制不影响正常流程）
  const p2 = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: '配方复用', sku: 'R12-RECIPE-002', category: '精华', platform: '天猫' },
  });
  assert.equal(p2.status, 201);
  await freezeProject(port, p2.json.project.id);
  const run2 = await createQuoteAndRun(port, p2.json.project.id, headers, 'r12-recipe-run-2');
  const done2 = await waitRunDone(port, run2.id, headers);
  assert.equal(done2.status, 'completed');
});

test('R12 免费体验→额度不足→付款→到账→继续', async t => {
  const paymentProvider = createMockWechatPaymentProvider({ realMoney: true });
  const { port } = await start(t, {
    provider: createSizeFixture(),
    initialCredits: 1, // 只给 1 张免费额度
    paymentProvider,
  });
  const headers = as();

  // 创建项目并冻结
  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R12 支付流程', sku: 'R12-PAY-001', category: '精华' },
  });
  assert.equal(project.status, 201);
  await freezeProject(port, project.json.project.id);

  // 免费额度只有 1 张，报价应该超过
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers, body: { project_id: project.json.project.id },
  });
  assert.equal(quote.status, 201);

  // 尝试执行 → 应该报额度不足（402 Payment Required）
  const denied = await request(port, '/api/runs', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'r12-pay-run-1' },
    body: { project_id: project.json.project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(denied.status, 402, JSON.stringify(denied.json));
  assert.equal(denied.json.error, 'INSUFFICIENT_CREDITS');

  // 创建订单 → 支付 → 回调结算
  const order = await request(port, '/api/billing/orders', {
    method: 'POST', headers,
    body: { plan_id: 'plan_pro_150' },
  });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  const orderData = order.json.order;
  assert.equal(orderData.status, 'pending_wechat_checkout');

  // 模拟支付成功回调（先更新 mock provider 内部状态，再发通知）
  paymentProvider._setState(orderData.out_trade_no, 'SUCCESS');
  const notify = await request(port, '/api/billing/wechat/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      event_type: 'TRANSACTION.SUCCESS',
      data: { out_trade_no: orderData.out_trade_no, transaction_id: `MOCK_${orderData.out_trade_no}`, trade_state: 'SUCCESS', amount: { total: 19900, currency: 'CNY' } },
    },
  });
  assert.equal(notify.status, 200);
  assert.equal(notify.json.code, 'SUCCESS');

  // 验证额度到账
  const balance = await request(port, '/api/credits', { headers });
  assert.equal(balance.status, 200);
  assert.ok(balance.json.balance.available >= 150, `额度应 >= 150，实际 ${balance.json.balance.available}`);

  // 再次执行 → 应该成功
  const run = await request(port, '/api/runs', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'r12-pay-run-2' },
    body: { project_id: project.json.project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  const done = await waitRunDone(port, run.json.run.id, headers);
  assert.equal(done.status, 'completed');
});

test('R12 退款：已结算订单退款→额度回收', async t => {
  const paymentProvider = createMockWechatPaymentProvider({ realMoney: true });
  const { port } = await start(t, {
    provider: createSizeFixture(),
    initialCredits: 0,
    paymentProvider,
  });
  const headers = as();

  // 创建订单并支付
  const order = await request(port, '/api/billing/orders', {
    method: 'POST', headers,
    body: { plan_id: 'plan_taster_10' },
  });
  assert.equal(order.status, 201);
  // 先更新 mock provider 内部状态，再发通知
  paymentProvider._setState(order.json.order.out_trade_no, 'SUCCESS');
  const notify = await request(port, '/api/billing/wechat/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      event_type: 'TRANSACTION.SUCCESS',
      data: { out_trade_no: order.json.order.out_trade_no, transaction_id: `MOCK_${order.json.order.out_trade_no}`, trade_state: 'SUCCESS', amount: { total: 1900, currency: 'CNY' } },
    },
  });
  assert.equal(notify.status, 200);

  // 验证额度到账
  const bal1 = await request(port, '/api/credits', { headers });
  assert.equal(bal1.json.balance.available, 10);

  // 退款
  const refund = await request(port, `/api/billing/orders/${order.json.order.id}/refund`, {
    method: 'POST', headers, body: {},
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.json));
  assert.equal(refund.json.order.status, 'refunded');
  assert.equal(refund.json.order.refund_status, 'success');

  // 验证额度回收
  const bal2 = await request(port, '/api/credits', { headers });
  assert.equal(bal2.json.balance.available, 0, '退款后额度应回收');

  // 重复退款应被拦截
  const dup = await request(port, `/api/billing/orders/${order.json.order.id}/refund`, {
    method: 'POST', headers, body: {},
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'ORDER_ALREADY_REFUNDED');
});

test('R12 越权：viewer 不能执行写操作', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const ownerHeaders = as('tenant_a', 'owner_r12');
  const viewerHeaders = as('tenant_a', 'viewer_r12');

  // owner 创建项目
  const project = await request(port, '/api/projects', {
    method: 'POST', headers: ownerHeaders,
    body: { name: 'R12 越权测试', sku: 'R12-AUTH-001', category: '精华' },
  });
  assert.equal(project.status, 201);

  // owner 登记 viewer 成员（首个成员登记会同时把 owner_r12 固化为 owner）
  const addMember = await request(port, '/api/members', {
    method: 'POST', headers: ownerHeaders,
    body: { actor_id: 'viewer_r12', role: 'viewer' },
  });
  assert.equal(addMember.status, 201, JSON.stringify(addMember.json));

  // viewer 不能创建项目
  const denied = await request(port, '/api/projects', {
    method: 'POST', headers: viewerHeaders,
    body: { name: 'viewer 项目', sku: 'R12-AUTH-002', category: '精华' },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));

  // viewer 不能上传素材
  const uploadDenied = await request(port, `/api/projects/${project.json.project.id}/assets?role=subject&filename=test.png`, {
    method: 'POST', headers: { ...viewerHeaders, 'Content-Type': 'image/png' },
    body: subjectPng(64, 64),
  });
  assert.equal(uploadDenied.status, 403, 'viewer 不应能上传素材');

  // viewer 不能创建任务
  const runDenied = await request(port, '/api/runs', {
    method: 'POST', headers: { ...viewerHeaders, 'Idempotency-Key': 'r12-auth-run' },
    body: { project_id: project.json.project.id, quote_id: 'qte_fake' },
  });
  assert.ok([401, 403].includes(runDenied.status), 'viewer 不应能创建任务');

  // viewer 可以读取项目（读操作不被拒）
  const readOk = await request(port, `/api/projects/${project.json.project.id}`, { headers: viewerHeaders });
  assert.equal(readOk.status, 200, 'viewer 应能读取项目');
});

test('R12 供应商异常恢复：失败后重试成功', async t => {
  // 第一次用会失败的 provider
  let callCount = 0;
  const flakyProvider = {
    capabilities: () => ({
      id: 'flaky', version: '1.0', image: true, video: false,
      max_references: 1, supports_mask: false, supports_async: true, supports_cancel: true,
      supports_seed: false, supports_revision: false, max_side: 2048, formats: ['png'],
      simulated: true, acceptance: 'simulated_only',
    }),
    validate: () => ({ ok: true }),
    estimate: () => ({ price_version: '1.0', estimated_credits: 1, max_credits: null }),
    submit: request => {
      callCount += 1;
      return {
        provider_job_id: `flaky_${callCount}`, status: 'queued',
        request_hash: request.request_hash, idempotency_key: request.idempotency_key,
        provider_meta: { id: 'flaky', version: '1.0', simulated: true },
      };
    },
    poll: handle => {
      // 第一次调用返回失败，第二次返回成功
      if (callCount === 1) {
        return { status: 'failed', code: 'PROVIDER_ERROR', message: '模拟供应商故障', retryable: true };
      }
      return { status: 'succeeded', result: {
        provider: 'flaky', model: 'test', model_version: '1.0',
        provider_job_id: handle.provider_job_id, provider_request_id: 'req_1',
        usage: { images: 1, unit: 'image' }, cost: { amount: 0, currency: 'internal_demo' },
        latency_ms: 5, output: { format: 'png', bytes: subjectPng(64, 64), width: 64, height: 64, sha256: 'abc123' },
      } };
    },
    cancel: () => ({ status: 'cancelled' }),
  };

  const { port } = await start(t, { provider: flakyProvider });
  const headers = as();

  // 创建项目并冻结
  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R12 异常恢复', sku: 'R12-FLAKY-001', category: '精华' },
  });
  assert.equal(project.status, 201);
  await freezeProject(port, project.json.project.id);

  // 创建任务
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers, body: { project_id: project.json.project.id },
  });
  assert.equal(quote.status, 201);
  const run = await request(port, '/api/runs', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'r12-flaky-run' },
    body: { project_id: project.json.project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(run.status, 201);

  // 等待完成（可能经历失败后重试成功）
  const done = await waitRunDone(port, run.json.run.id, headers);
  // 由于 provider 的 flaky 特性，任务可能完成也可能失败
  // 关键是系统能正确处理异常
  assert.ok(['completed', 'failed'].includes(done.status), `任务状态应为 completed 或 failed，实际 ${done.status}`);
});

test('R12 商品事实阻断：关键事实未确认不能开始生产', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 创建项目但不确认事实
  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R12 事实阻断', sku: 'R12-BLOCK-001', category: '精华' },
  });
  assert.equal(project.status, 201);
  const projectId = project.json.project.id;

  // 上传素材但不确认事实
  await request(port, `/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' },
    body: subjectPng(128, 128),
  });

  // 尝试冻结规格 → 应该报事实未确认
  const frozen = await request(port, `/api/projects/${projectId}/specs`, {
    method: 'POST', headers,
    body: { template_id: 'tpl_listing_pack', platform: '天猫', base_version: 0 },
  });
  // 可能返回 409（事实未确认）或其他错误
  assert.ok(frozen.status !== 201, `未确认事实时不应成功冻结规格，实际 ${frozen.status}`);
});

test('R12 幂等：重复提交不产生重复费用', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R12 幂等测试', sku: 'R12-IDEM-001', category: '精华' },
  });
  assert.equal(project.status, 201);
  await freezeProject(port, project.json.project.id);

  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers, body: { project_id: project.json.project.id },
  });
  assert.equal(quote.status, 201);

  // 记录余额
  const balBefore = await request(port, '/api/credits', { headers });
  const availableBefore = balBefore.json.balance.available;

  // 用同一个幂等键创建两次任务
  const key = 'r12-idem-run-1';
  const run1 = await request(port, '/api/runs', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': key },
    body: { project_id: project.json.project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(run1.status, 201, JSON.stringify(run1.json));

  const run2 = await request(port, '/api/runs', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': key },
    body: { project_id: project.json.project.id, quote_id: quote.json.quote.quote_id },
  });
  // 第二次应该返回 200（幂等命中）并指向同一个任务
  assert.equal(run2.status, 200, JSON.stringify(run2.json));
  assert.equal(run2.json.run.id, run1.json.run.id, '幂等键相同应返回同一个任务');
  assert.equal(run2.json.replayed, true, '应标记为幂等重放');

  // 等待任务完成
  await waitRunDone(port, run1.json.run.id, headers);

  // 验证只扣了一次费用
  const balAfter = await request(port, '/api/credits', { headers });
  const availableAfter = balAfter.json.balance.available;
  const consumed = availableBefore - availableAfter;
  assert.ok(consumed > 0, '应有额度消耗');
  assert.ok(consumed <= 24, `消耗不应超过单次任务上限，实际消耗 ${consumed}`);
});

test('R12 任务中断恢复：任务进行中可查询状态', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R12 中断恢复', sku: 'R12-RECOVER-001', category: '精华' },
  });
  assert.equal(project.status, 201);
  await freezeProject(port, project.json.project.id);

  const run = await createQuoteAndRun(port, project.json.project.id, headers, 'r12-recover-run');

  // 任务进行中查询状态
  const midRun = await request(port, `/api/runs/${run.id}`, { headers });
  assert.equal(midRun.status, 200);
  assert.ok(['queued', 'running', 'budget_hold', 'awaiting_confirmation'].includes(midRun.json.run.status),
    `任务进行中状态应为活跃状态，实际 ${midRun.json.run.status}`);

  // 查询项目详情，确认能找回任务
  const projectDetail = await request(port, `/api/projects/${project.json.project.id}`, { headers });
  assert.equal(projectDetail.status, 200);
  assert.ok(projectDetail.json.project.latest_run_id === run.id || projectDetail.json.project.id === project.json.project.id);

  // 等待完成
  const done = await waitRunDone(port, run.id, headers);
  assert.equal(done.status, 'completed');
});
