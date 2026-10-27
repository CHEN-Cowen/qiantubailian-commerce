import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { evaluatePaymentCapability } from '../src/m12.mjs';
import { createMockWechatPaymentProvider, createWechatPaymentProvider } from '../src/providers/wechat.mjs';
import { createPaymentProviderFromEnv } from '../src/providers/payment.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

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
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, json: data, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const headers = () => ({ 'x-tenant-id': 'tenant_demo', 'x-actor-id': 'demo_operator' });

// ---------- evaluatePaymentCapability & Provider 工厂 ----------

test('R08 evaluatePaymentCapability：mock provider 默认 → can_checkout=true, can_settle=true, can_refund=false', () => {
  const mock = createMockWechatPaymentProvider();
  const caps = evaluatePaymentCapability({ provider: mock });
  assert.equal(caps.mode, 'demo');
  assert.equal(caps.real_money, false);
  assert.equal(caps.can_checkout, true);
  assert.equal(caps.can_settle, true);
  assert.equal(caps.can_refund, false);
  assert.ok(caps.blockers.some(b => b.code === 'PAYMENT_REAL_MONEY_UNSUPPORTED'));
});

test('R08 evaluatePaymentCapability：mock provider 模拟 realMoney → can_checkout=true, can_refund=true', () => {
  const mock = createMockWechatPaymentProvider({ realMoney: true });
  const caps = evaluatePaymentCapability({ provider: mock });
  assert.equal(caps.mode, 'live');
  assert.equal(caps.real_money, true);
  assert.equal(caps.can_checkout, true);
  assert.equal(caps.can_settle, true);
  assert.equal(caps.can_refund, true);
  assert.equal(caps.blockers.length, 0, 'realMoney+supports_native_qr+supports_refunds 不应有 blockers');
});

test('R08 evaluatePaymentCapability：真实 wechat provider → can_checkout=true, can_settle=true', () => {
  const provider = { capabilities: () => ({
    real_money: true, simulated: false, supports_refunds: true,
    supports_native_qr: true, supports_query: true, supports_close: true,
  }) };
  const caps = evaluatePaymentCapability({ provider });
  assert.equal(caps.mode, 'live');
  assert.equal(caps.real_money, true);
  assert.equal(caps.can_checkout, true);
  assert.equal(caps.can_settle, true);
  assert.equal(caps.can_refund, true);
  // supports_native_qr=true + real_money=true 时不应有 PAYMENT_CHARGE_UNIMPLEMENTED
  assert.ok(!caps.blockers.some(b => b.code === 'PAYMENT_CHARGE_UNIMPLEMENTED'));
});

test('R08 createPaymentProviderFromEnv：wechat_native 缺配置即抛，不回落到 mock', () => {
  assert.throws(() => createPaymentProviderFromEnv({ QTB_PAYMENT_PROVIDER: 'wechat_native' }),
    /缺少必需配置/);
});

test('R08 createPaymentProviderFromEnv：mock 无配置也能构造', () => {
  const { provider, mode } = createPaymentProviderFromEnv({ QTB_PAYMENT_PROVIDER: 'mock' });
  assert.equal(mode, 'mock');
  assert.equal(typeof provider.capabilities, 'function');
});

test('R08 createWechatPaymentProvider：真实密钥正确时能构造（仅检查字段存在）', () => {
  const provider = createWechatPaymentProvider({
    mchid: '1900000001',
    appid: 'wx_demo_appid',
    apiv3Key: Buffer.alloc(32, 'a').toString('base64'),
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDR\n-----END PRIVATE KEY-----',
    platformCertPem: '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----',
    notifyUrl: 'https://example.com/api/billing/wechat/notify',
  });
  const caps = provider.capabilities();
  assert.equal(caps.real_money, true);
  assert.equal(caps.simulated, false);
  assert.equal(caps.supports_native_qr, true);
});

// ---------- 支付路由（mock provider） ----------

const shared = { port: null, app: null, runtimeDir: null, provider: null };

async function setupShared() {
  if (shared.port) return;  // 已经启动过
  const runtimeDir = await mkdtemp(path.join(TEST_ROOT, 'r08-'));
  // realMoney=true 让 mock provider 模拟真实支付链路（Native 下单、回调结算）
  const mockProvider = createMockWechatPaymentProvider({ realMoney: true });
  const app = createApp({
    port: 0, storeDir: runtimeDir,
    allowedTenants: ['tenant_demo', 'tenant_r08'],
    initialCredits: 240, attemptTimeoutMs: 30_000,
    paymentProvider: mockProvider,
  });
  const { port } = await app.listen();
  shared.port = port;
  shared.app = app;
  shared.runtimeDir = runtimeDir;
  shared.provider = mockProvider;
  shared.cleanup = async () => {
    await app.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  };
}

test('R08 共享 server 启动（mock 支付 Provider）', async () => {
  await setupShared();
  const health = await request(shared.port, '/healthz');
  assert.equal(health.status, 200);
});

test('R08 免单套餐（plan_first_trial）：直接发放额度，不走支付', async () => {
  await setupShared();
  const port = shared.port;
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_first_trial' },
  });
  assert.equal(created.status, 201);
  const order = created.json.order;
  assert.equal(order.status, 'settled_real');  // 免单直接到账
  assert.equal(order.price_cents, 0);
  assert.equal(order.real_money, true);
  assert.equal(order.simulated, false);
  assert.ok(order.settled_at);
  // 额度已发放
  const settled = await request(port, '/api/billing/orders', { headers: headers() });
  assert.equal(settled.status, 200);
  const balance = settled.json.orders;  // 列表里能看到这个已结算订单
  assert.ok(balance.length >= 1);
});

test('R08 mock 真实支付下单（plan_taster_10）：pending_wechat_checkout，返回 code_url', async () => {
  await setupShared();
  const port = shared.port;
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_taster_10' },  // ¥19 / 10 张
  });
  assert.equal(created.status, 201);
  const order = created.json.order;
  assert.equal(order.status, 'pending_wechat_checkout');
  assert.equal(order.real_money, true);
  assert.equal(order.simulated, false);
  assert.equal(order.pay_provider, 'wechat_native');
  assert.ok(order.out_trade_no);
  assert.ok(order.code_url);
  assert.ok(order.pay_qr);
  assert.equal(order.price_cents, 1900);

  // 查单：当前状态是 NOTPAY（mock provider 默认）
  const query = await request(port, `/api/billing/orders/${order.id}/query`, { headers: headers() });
  assert.equal(query.status, 200);
  assert.equal(query.json.provider_state.trade_state, 'NOTPAY');
});

test('R08 手动 settle 真实支付订单被拦截', async () => {
  await setupShared();
  const port = shared.port;
  // 先建一个真实支付订单
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_daily_40' },
  });
  assert.equal(created.status, 201);
  const orderId = created.json.order.id;
  // 手动 settle 应被拦截
  const settled = await request(port, `/api/billing/orders/${orderId}/settle`, {
    method: 'POST', headers: headers(),
  });
  assert.equal(settled.status, 409);
  assert.equal(settled.json.error, 'ORDER_SETTLE_VIA_CALLBACK');
});

test('R08 关单：pending_wechat_checkout → wechat_closed', async () => {
  await setupShared();
  const port = shared.port;
  // 先建一个真实支付订单
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_daily_40' },
  });
  assert.equal(created.status, 201);
  const order = created.json.order;
  const outTradeNo = order.out_trade_no;

  // 关单
  const closed = await request(port, `/api/billing/orders/${order.id}/close`, {
    method: 'POST', headers: headers(),
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.order.status, 'wechat_closed');

  // 已关单的 out_trade_no 再查 provider 确认
  const query = await request(port, `/api/billing/orders/${order.id}/query`, { headers: headers() });
  assert.equal(query.status, 200);
  assert.equal(query.json.provider_state.trade_state, 'CLOSED');
});

test('R08 查单同步：provider 变 SUCCESS → 自动 settled_real', async () => {
  await setupShared();
  const port = shared.port;
  // 先建真实支付订单
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_pro_150' },
  });
  assert.equal(created.status, 201);
  const order = created.json.order;
  // 注入 provider 状态变 SUCCESS
  shared.provider._setState(order.out_trade_no, 'SUCCESS');
  // 查单 → 自动结算
  const query = await request(port, `/api/billing/orders/${order.id}/query`, { headers: headers() });
  assert.equal(query.status, 200);
  assert.equal(query.json.provider_state.trade_state, 'SUCCESS');
  assert.equal(query.json.order.status, 'settled_real');
  // 再查订单列表确认额度已发
  const list = await request(port, '/api/billing/orders', { headers: headers() });
  assert.equal(list.status, 200);
  const updated = list.json.orders.find(o => o.id === order.id);
  assert.equal(updated.status, 'settled_real');
});

test('R08 回调通知：SUCCESS → 自动 settled_real + 额度发放', async () => {
  await setupShared();
  const port = shared.port;
  // 先建真实支付订单
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_taster_10' },
  });
  assert.equal(created.status, 201);
  const order = created.json.order;
  const outTradeNo = order.out_trade_no;

  // 构造 mock 通知
  const notifyBody = shared.provider._mockNotify({ out_trade_no: outTradeNo });
  const notify = await request(port, '/api/billing/wechat/notify', {
    method: 'POST', body: JSON.stringify(notifyBody),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(notify.status, 200);
  assert.equal(notify.json.code, 'SUCCESS');

  // 确认订单已结算
  const query = await request(port, `/api/billing/orders/${order.id}/query`, { headers: headers() });
  assert.equal(query.json.order.status, 'settled_real');
});

test('R08 回调幂等：同一 out_trade_no 重复通知不重复发额度', async () => {
  await setupShared();
  const port = shared.port;
  // 先建真实支付订单
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_daily_40' },
  });
  assert.equal(created.status, 201);
  const order = created.json.order;
  const outTradeNo = order.out_trade_no;

  // 第一次通知
  const notifyBody = shared.provider._mockNotify({ out_trade_no: outTradeNo });
  await request(port, '/api/billing/wechat/notify', {
    method: 'POST', body: JSON.stringify(notifyBody),
  });
  assert.equal(created.status, 201);  // 保持
  // 第二次通知（重复）
  await request(port, '/api/billing/wechat/notify', {
    method: 'POST', body: JSON.stringify(notifyBody),
  });
  // 订单状态仍为 settled_real，没有报错
  const query = await request(port, `/api/billing/orders/${order.id}/query`, { headers: headers() });
  assert.equal(query.json.order.status, 'settled_real');
});

test('R08 回调：找不到订单（业务侧还没建完）返回 SUCCESS（让微信重试但不中断链路）', async () => {
  await setupShared();
  const port = shared.port;
  const notifyBody = shared.provider._mockNotify({ out_trade_no: 'TB_NOT_EXIST_123456' });
  const notify = await request(port, '/api/billing/wechat/notify', {
    method: 'POST', body: JSON.stringify(notifyBody),
  });
  assert.equal(notify.status, 200);
  assert.equal(notify.json.code, 'SUCCESS');  // 找不到订单也不返回 FAIL
});

test('R08 回调：关闭/撤销状态 → 订单状态跟随', async () => {
  await setupShared();
  const port = shared.port;
  // 先建真实支付订单
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_taster_10' },
  });
  assert.equal(created.status, 201);
  const order = created.json.order;
  const outTradeNo = order.out_trade_no;

  // CLOSED 通知
  const closedNotify = shared.provider._mockNotify({ out_trade_no: outTradeNo, trade_state: 'CLOSED' });
  const notify = await request(port, '/api/billing/wechat/notify', {
    method: 'POST', body: JSON.stringify(closedNotify),
  });
  assert.equal(notify.status, 200);

  const query = await request(port, `/api/billing/orders/${order.id}/query`, { headers: headers() });
  assert.equal(query.json.order.status, 'wechat_closed');
});

test('R08 createNativeOrder：out_trade_no 格式校验', () => {
  const provider = createMockWechatPaymentProvider();
  assert.throws(() => provider.createNativeOrder({ out_trade_no: '', amount_cents: 100 }), /无效/);
  // 33 字符超长（微信限制 32）
  assert.throws(() => provider.createNativeOrder({ out_trade_no: 'TB_'.padEnd(34, 'A'), amount_cents: 100 }), /无效/);
  assert.doesNotThrow(() => provider.createNativeOrder({ out_trade_no: 'TB_TEST_123', amount_cents: 100 }));
});

test('R08 退款：mock provider realMoney=true 下退款成功回收未使用额度（R09 实现）', async () => {
  await setupShared();
  const port = shared.port;
  const created = await request(port, '/api/billing/orders', {
    method: 'POST', headers: headers(),
    body: { plan_id: 'plan_pro_150' },
  });
  const order = created.json.order;
  // 让它结算（模拟 SUCCESS 回调）
  shared.provider._setState(order.out_trade_no, 'SUCCESS');
  const notifyBody = shared.provider._mockNotify({ out_trade_no: order.out_trade_no });
  await request(port, '/api/billing/wechat/notify', {
    method: 'POST', body: JSON.stringify(notifyBody),
  });
  // 退款：mock provider refund 会成功，回收该订单批次的可用额度
  const refund = await request(port, `/api/billing/orders/${order.id}/refund`, {
    method: 'POST', headers: headers(),
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.json));
  assert.equal(refund.json.order.status, 'refunded');
  assert.equal(refund.json.order.refund_status, 'success');
  assert.ok(refund.json.refunded_credits > 0);
});

test('R08 共享 server 清理', async () => {
  if (shared.cleanup) await shared.cleanup();
});
