import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

function request(port, route, { method = 'GET', headers = {}, body, query } = {}) {
  const fullPath = route + (query ? `?${query}` : '');
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: fullPath, method,
      headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: data, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const shared = { port: null, app: null, cleanup: null };
async function setupShared() {
  const runtimeDir = await mkdtemp(path.join(TEST_ROOT, 'r07-'));
  const app = createApp({
    port: 0, storeDir: runtimeDir,
    allowedTenants: ['tenant_demo', 'tenant_r07'],
    initialCredits: 240, attemptTimeoutMs: 30_000,
  });
  const { port } = await app.listen();
  shared.port = port;
  shared.app = app;
  shared.cleanup = async () => {
    await app.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  };
}

test('R07 共享 server 启动', async () => {
  await setupShared();
  const health = await request(shared.port, '/healthz');
  assert.equal(health.status, 200);
});

test('R07 /api/plans 返回套餐、价格与有效期全部来自后端', async () => {
  const port = shared.port;
  const headers = { 'x-tenant-id': 'tenant_demo', 'x-actor-id': 'demo_operator' };
  const resp = await request(port, '/api/plans', { headers });
  assert.equal(resp.status, 200, `plans 失败: ${resp.text}`);
  const body = resp.body;
  assert.ok(body.plans && body.plans.length >= 3, `应至少 3 个套餐，实际 ${body.plans?.length ?? 0}`);
  // 核心付费套餐必须存在
  const ids = body.plans.map(p => p.id);
  for (const expected of ['plan_taster_10', 'plan_daily_40', 'plan_pro_150']) {
    assert.ok(ids.includes(expected), `缺少核心付费套餐 ${expected}`);
  }
  // 价格一致
  const fresh = body.plans.find(p => p.id === 'plan_taster_10');
  assert.equal(fresh.price_cents, 1900, '尝鲜包 ¥19 = 1900 分');
  assert.equal(fresh.credits, 10, '尝鲜包 10 张');
  assert.equal(fresh.validity_days, 90, '尝鲜包 90 天');

  const daily = body.plans.find(p => p.id === 'plan_daily_40');
  assert.equal(daily.price_cents, 6900, '日常上新 ¥69 = 6900 分');
  assert.equal(daily.credits, 40);
  assert.equal(daily.validity_days, 30);

  // 月包 30 天、尝鲜包 90 天的规则应该一致
  assert.ok(body.rules?.monthly_validity_days === 30, `规则应 monthly 30 天，实际 ${body.rules?.monthly_validity_days}`);
  assert.ok(body.rules?.one_time_validity_days === 90, `规则应 one_time 90 天，实际 ${body.rules?.one_time_validity_days}`);
});

test('R07 /api/plans payment 能力闸口：未配置真实支付 can_checkout=false', async () => {
  const port = shared.port;
  const headers = { 'x-tenant-id': 'tenant_demo', 'x-actor-id': 'demo_operator' };
  const resp = await request(port, '/api/plans', { headers });
  assert.equal(resp.status, 200);
  const payment = resp.body.payment;
  assert.strictEqual(payment.can_checkout, false, `默认应不可 checkout，实际 can_checkout=${payment.can_checkout}`);
  assert.strictEqual(payment.real_money, false, `默认应不支持真实货币，实际 real_money=${payment.real_money}`);
  assert.ok(payment.mode, 'payment.mode 应存在');
  assert.ok(payment.blockers && payment.blockers.length > 0, 'blockers 应列出原因');
});

test('R07 UI 契约：价格页必需 DOM 节点存在', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const html = await (await import('node:fs/promises')).readFile(path.join(root, 'frontend/index.html'), 'utf8');
  const js = await (await import('node:fs/promises')).readFile(path.join(root, 'frontend/pricing.js'), 'utf8');
  const api = await (await import('node:fs/promises')).readFile(path.join(root, 'frontend/api.js'), 'utf8');

  assert.match(html, /id="pricing-dialog"/);
  assert.match(html, /id="pricing-body"/);
  assert.match(html, /data-open="pricing"/);
  assert.match(html, /pricing\.js/);
  assert.match(html, /pricing\.css/);

  assert.match(js, /function openPricing/);
  assert.match(js, /function render/);
  assert.match(js, /yuan\(.*price_cents\)/); // 前端用 price_cents 除以 100 显示，不能自己定价
  assert.match(js, /state\.payment\?\.can_checkout|can_checkout.*real_money/); // 闸口判断
  assert.match(js, /plan\.validity_days/); // 有效期展示来自后端
  assert.match(js, /plan\.credits/); // 包含次数来自后端

  assert.match(api, /listPlans.*\/api\/plans/);
  assert.match(api, /createBillingOrder/);
});

test('R07 共享 server 清理', async () => {
  if (shared.cleanup) await shared.cleanup();
  assert.ok(1);
});
