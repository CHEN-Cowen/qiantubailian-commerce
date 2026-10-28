import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createCipheriv, generateKeyPairSync, sign } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { fileURLToPath } from 'node:url';
import { createMockWechatPaymentProvider, createWechatPaymentProvider, decryptApiV3Resource } from '../src/providers/wechat.mjs';
import sharp from 'sharp';
import { encodeRgbPng } from '../src/m06.mjs';
import { renderLayers } from '../src/raster.mjs';

async function setup(t, options = {}) {
  const root = new URL('../runtime/test-tmp/', import.meta.url);
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(fileURLToPath(new URL('fix-', root)));
  const provider = createMockWechatPaymentProvider({ realMoney: true });
  const config = { port: 0, storeDir: dir, initialCredits: 0, demoMode: false, paymentProvider: provider, ...options };
  let app = createApp(config);
  let { port } = await app.listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const req = async (route, body, authenticated = true, extraHeaders = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie, 'x-csrf-token': csrf } : {}), ...extraHeaders },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const data = r.headers.get('content-type')?.includes('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    if (data.csrf_token) csrf = data.csrf_token;
    return { status: r.status, data, headers: r.headers };
  };
  assert.equal((await req('/api/auth/register', { email: 'fix@example.test', password: 'FixAccount2026!', display_name: 'Fix' })).status, 201);
  return { req, provider, restart: async () => { await app.close(); app = createApp(config); ({ port } = await app.listen()); }, snapshot: async () => JSON.parse(await readFile(`${dir}/data.json`, 'utf8')) };
}

test('修复：正式形状的微信 AES-GCM 通知使用独立 nonce/AAD 与原始密钥', () => {
  const key = '0123456789abcdef0123456789abcdef', nonce = '0123456789ab', associated_data = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated_data));
  const expected = { out_trade_no: 'T1', trade_state: 'SUCCESS' };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(expected)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const result = decryptApiV3Resource({ ciphertext, apiv3Key: key, nonce, associated_data });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, expected);
  assert.equal(decryptApiV3Resource({ ciphertext, apiv3Key: key, nonce, associated_data: 'wrong' }).ok, false);
});

test('修复：体验只发一次，真实通知不需要会话且校验金额，付费批次带购买快照和到期', async t => {
  const { req, provider, snapshot } = await setup(t);
  const before = (await req('/api/credits')).data.balance.available;
  await req('/api/billing/orders', { plan_id: 'plan_first_trial' });
  await req('/api/billing/orders', { plan_id: 'plan_first_trial' });
  assert.equal((await req('/api/credits')).data.balance.available, before);
  const order = (await req('/api/billing/orders', { plan_id: 'plan_taster_10' })).data.order;
  const notify = provider._mockNotify({ out_trade_no: order.out_trade_no });
  notify.data.amount.total = 1;
  assert.equal((await req('/api/billing/wechat/notify', notify, false)).status, 400);
  assert.equal((await req('/api/credits')).data.balance.available, before);
  notify.data.amount.total = order.price_cents;
  assert.equal((await req('/api/billing/wechat/notify', notify, false)).status, 200);
  await req('/api/billing/wechat/notify', notify, false);
  assert.equal((await req('/api/credits')).data.balance.available, before + 10);
  const lot = Object.values((await snapshot()).credit_lots).find(x => x.source_order_id === order.id);
  assert.ok(lot.expires_at);
  assert.equal(lot.version_snapshot.price_cents, 1900);
});

test('修复：退款处理中冻结原订单权益，重启后查询最终结果只回收一次', async t => {
  const { req, provider, snapshot, restart } = await setup(t);
  const order = (await req('/api/billing/orders', { plan_id: 'plan_taster_10' })).data.order;
  provider._setState(order.out_trade_no, 'SUCCESS');
  await req(`/api/billing/orders/${order.id}/query`);
  provider.refund = async () => ({ status: 'PROCESSING', refund_id: 'REF1' });
  const pending = await req(`/api/billing/orders/${order.id}/refund`, {});
  assert.equal(pending.data.order.refund_status, 'processing');
  assert.notEqual(pending.data.order.status, 'refunded');
  assert.equal((await req('/api/credits')).data.balance.available, 3);
  await restart();
  assert.equal((await req('/api/credits')).data.balance.available, 3);
  provider.queryRefund = async () => ({ status: 'SUCCESS', refund_id: 'REF1' });
  const settled = await req(`/api/billing/orders/${order.id}/query`);
  assert.equal(settled.data.order.status, 'refunded');
  await req(`/api/billing/orders/${order.id}/query`);
  assert.equal((await req('/api/credits')).data.balance.available, 3);
  const lot = Object.values((await snapshot()).credit_lots).find(x => x.source_order_id === order.id);
  assert.equal(lot.revoked, 10);
  assert.equal(lot.refund_frozen, 0);
});

test('修复：真实 Native HTTP 请求已签名，并验证微信响应签名', async () => {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const provider = createWechatPaymentProvider({
    mchid: 'M1', appid: 'APP1', apiv3Key: '0123456789abcdef0123456789abcdef',
    privateKeyPem: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    platformCertPem: platform.publicKey.export({ type: 'spki', format: 'pem' }),
    serialNo: 'MERCHANT1', platformSerial: 'PLATFORM1', notifyUrl: 'https://example.test/notify',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/native');
      assert.match(options.headers.Authorization, /serial_no="MERCHANT1"/);
      assert.equal(JSON.parse(options.body).amount.total, 1900);
      const body = JSON.stringify({ code_url: 'weixin://test' });
      const ts = String(Math.floor(Date.now() / 1000)), nonce = 'N1';
      return new Response(body, { headers: {
        'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-serial': 'PLATFORM1',
        'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${ts}\n${nonce}\n${body}\n`), platform.privateKey).toString('base64'),
      } });
    },
  });
  assert.equal((await provider.createNativeOrder({ out_trade_no: 'T1', description: '商品图额度', amount_cents: 1900 })).code_url, 'weixin://test');
});


test('修复：真实账户三张体验可启动必需套图；不合格模拟结果释放全部额度', async t => {
  const { req, snapshot } = await setup(t);
  const run = await startTrialRun(req);
  let done;
  for (let i = 0; i < 200; i++) {
    done = (await req('/api/runs/' + run.data.run.id)).data.run;
    if (['completed', 'failed', 'cancelled'].includes(done.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(['completed', 'failed', 'cancelled'].includes(done.status), JSON.stringify(done));
  assert.equal(done.budget.captured_credits, 0, '模拟图未通过尺寸检查，不能收成品额度');
  assert.equal(done.budget.released_credits, 3);
  assert.equal((await req('/api/credits')).data.balance.available, 3);
  assert.equal(Object.values((await snapshot()).credit_entries).filter(e => e.type === 'capture').length, 0);
  const url = '/api/runs/' + run.data.run.id + '/versions/' + done.versions[0].id + '/content';
  const preview = await req(url);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('x-content-preview'), 'true');
  assert.ok((await sharp(preview.data).metadata()).width <= 768);
  assert.equal((await req(url, undefined, false)).status, 401);
});

test('修复：最终 PNG 包含真实 Logo 像素；JPEG 可解码进入栅格合成', async () => {
  const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const base = await sharp(jpeg).png().toBuffer();
  const logo = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const { bytes, svg } = await renderLayers({ bytes: base, width: 100, height: 100, logoBytes: logo,
    layers: [{ id: 'logo', logo: true, x: 0.1, y: 0.1, width: 0.2, size_ratio: 0.1 }] });
  assert.match(svg, /data-source="brand_logo"/);
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (15 * info.width + 15) * info.channels;
  assert.ok(data[offset] > 240 && data[offset + 1] < 20 && data[offset + 2] < 20, 'Logo 必须实际出现在最终图片像素里');
  await assert.rejects(renderLayers({ bytes: base, width: 100, height: 100, layers: [{ logo: true }] }), /缺少品牌 Logo/);
});


test('修复：退款跨过套餐到期日，原批次仍能准确回收', async t => {
  let now = Date.now();
  const { req, provider, snapshot } = await setup(t, { clock: () => new Date(now) });
  const order = (await req('/api/billing/orders', { plan_id: 'plan_taster_10' })).data.order;
  provider._setState(order.out_trade_no, 'SUCCESS');
  await req('/api/billing/orders/' + order.id + '/query');
  provider.refund = async () => ({ status: 'PROCESSING' });
  await req('/api/billing/orders/' + order.id + '/refund', {});
  now += 91 * 86400000;
  await req('/api/auth/login', { email: 'fix@example.test', password: 'FixAccount2026!' });
  assert.equal((await req('/api/credits')).data.balance.available, 0);
  provider.queryRefund = async () => ({ status: 'SUCCESS' });
  const refunded = await req('/api/billing/orders/' + order.id + '/query');
  assert.equal(refunded.status, 200, JSON.stringify(refunded.data));
  assert.equal(refunded.data.order.refund_status, 'success');
  const lot = Object.values((await snapshot()).credit_lots).find(l => l.source_order_id === order.id);
  assert.equal(lot.revoked, 10); assert.equal(lot.refund_frozen, 0);
});

test('修复：退款异常需要商户处理，不提前解冻；关单遇到已支付应查单入账', async t => {
  const { req, provider } = await setup(t);
  const order = (await req('/api/billing/orders', { plan_id: 'plan_taster_10' })).data.order;
  provider._setState(order.out_trade_no, 'SUCCESS');
  const closed = await req('/api/billing/orders/' + order.id + '/close', {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.order.status, 'settled_real');
  provider.refund = async () => ({ status: 'ABNORMAL' });
  const refund = await req('/api/billing/orders/' + order.id + '/refund', {});
  assert.equal(refund.data.order.refund_status, 'processing');
  assert.equal(refund.data.order.refund_requires_manual, true);
  assert.equal((await req('/api/credits')).data.balance.available, 3);
});

async function startTrialRun(req) {
  const p = await req('/api/projects', { name: '成品计价', sku: 'FIX-PRICE', category: '精华', platform: '天猫' });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const id = p.data.project.id;
  const png = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#eeeeee' } }).composite([{ input: await sharp({ create: { width: 400, height: 600, channels: 3, background: '#aa3322' } }).png().toBuffer(), left: 400, top: 300 }]).png().toBuffer();
  assert.equal((await req('/api/projects/' + id + '/assets?role=subject&filename=fixture.png', png, true, { 'Content-Type': 'image/png' })).status, 201);
  const truth = await req('/api/projects/' + id + '/truth-versions', { base_version: 0, confirm: true, facts: [
    { key: '容量', value: '30ml', critical: true, confirmed: true, source_type: 'user_input' },
    { key: '核心卖点', value: '温和修护', critical: true, confirmed: true, source_type: 'user_input' }
  ], critical_text: [] });
  assert.equal(truth.status, 201, JSON.stringify(truth.data));
  const body = { template_id: 'tpl_listing_pack', platform: '天猫', text_layout: { x: 0.08, y: 0.82, width: 0.84, size_ratio: 0.04 } };
  const invalid = await req('/api/projects/' + id + '/specs/preview', { ...body, text_layout: { ...body.text_layout, x: 0.9 } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.data.error, 'INVALID_TEXT_LAYOUT');
  const preview = await req('/api/projects/' + id + '/specs/preview', body);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  body.conflict_resolutions = Object.fromEntries([...preview.data.payload.conflicts.pending, ...preview.data.payload.conflicts.unresolvable].filter(c => c.options.length).map(c => [c.key, c.options[0].id]));
  const spec = await req('/api/projects/' + id + '/specs', { ...body, base_version: 0 });
  assert.equal(spec.status, 201, JSON.stringify(spec.data));
  const quote = await req('/api/quotes', { project_id: id });
  assert.equal(quote.status, 201, JSON.stringify(quote.data));
  assert.equal(quote.data.quote.billing_mode, 'finished_image');
  assert.equal(quote.data.quote.max_credits, 3);
  assert.equal(quote.data.quote.price_version, 'finished-image.1');
  const run = await req('/api/runs', { project_id: id, quote_id: quote.data.quote.quote_id }, true, { 'Idempotency-Key': 'fix-trial-run' });
  assert.equal(run.status, 201, JSON.stringify(run.data));
  return run;
}


test('修复：通过复核的真实账户成品仅扣一次；重复导出不额外收费', async t => {
  const calls = new Map();
  const provider = {
    capabilities: () => ({ id: 'fix-size-fixture', version: '1', image: true, max_references: 6, supports_mask: false,
      supports_post_composite: true, supports_async: true, supports_revision: false, supports_cancel: true,
      max_side: 4096, formats: ['png', 'jpg'], simulated: true, acceptance: 'simulated_only' }),
    validate: () => ({ ok: true }), estimate: () => ({ estimated_credits: 1, max_credits: 1 }),
    submit(request) { calls.set(request.idempotency_key, request); return { provider_job_id: request.idempotency_key, status: 'queued' }; },
    poll(handle) {
      const r = calls.get(handle.provider_job_id), w = r.target_width, h = r.target_height;
      const rgb = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3; rgb[i] = (x * 3 + y * 2) % 256; rgb[i + 1] = (y * 5 + x) % 256; rgb[i + 2] = (x * 7 + y * 3) % 256;
      }
      return { status: 'succeeded', result: { provider: 'fix-size-fixture', model: 'fixture', model_version: '1',
        output: { bytes: encodeRgbPng(w, h, rgb), width: w, height: h, format: 'png' },
        cost: { amount: 0, currency: 'internal_demo' }, usage: { images: 1 } } };
    }, cancel: () => ({ cancelled: true }),
  };
  const { req } = await setup(t, { provider, tickMs: 5 });
  const started = await startTrialRun(req), id = started.data.run.id;
  let run;
  for (let n = 0; n < 200; n++) {
    run = (await req('/api/runs/' + id)).data.run;
    if (['completed', 'failed'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(run.status, 'completed', JSON.stringify(run));
  for (const version of run.versions.filter(v => v.active)) {
    const report = (await req('/api/quality-reports/' + version.report_id)).data.report;
    const decisions = report.checks.filter(c => c.required && c.status === 'unknown' && c.adjudicable)
      .map(c => ({ code: c.code, decision: 'pass', reason: '测试样本人工检查', evidence: report.id }));
    if (report.decision !== 'publishable') {
      const review = await req('/api/quality-reports/' + report.id + '/reviews', { decisions, note: '仅测试 fixture，不证明真实模型效果' });
      assert.equal(review.status, 200, JSON.stringify(review.data));
      assert.equal(review.data.report.decision, 'publishable', JSON.stringify(review.data.report));
    }
  }
  const balance = (await req('/api/credits')).data.balance;
  assert.equal(balance.consumed, 3); assert.equal(balance.available, 0); assert.equal(balance.reserved, 0);
  const image = await req('/api/runs/' + id + '/versions/' + run.versions[0].id + '/content');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('x-content-preview'), 'false');
  assert.equal((await sharp(image.data).metadata()).width, 1200);
  assert.equal((await req('/api/runs/' + id + '/exports', {})).status, 201);
  assert.equal((await req('/api/runs/' + id + '/exports', {})).status, 201);
  assert.equal((await req('/api/credits')).data.balance.consumed, 3);
});
