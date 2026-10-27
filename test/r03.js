import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  EXPERIENCE_CREDITS, appendEntry, balanceOf, grantExperienceCredits, sweepExpiredLots,
} from '../src/credits.mjs';
import { createStore } from '../src/store.mjs';
import { grantFromPlan, listCommercePlans, commercePlanById } from '../src/plans.mjs';

const TENANT_A = 'tenant_a';
const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

const iso = value => new Date(value).toISOString();
const days = (from, count) => new Date(new Date(from).getTime() + count * 24 * 60 * 60 * 1000);

function blankData() {
  return { credit_accounts: {}, credit_entries: {}, credit_lots: {}, credit_reservations: {} };
}

/** 上传用真实可解码 PNG：中心一块明显主体，保证掩码可识别。 */
function pngBuffer(width = 1200, height = 1200) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const subject = x >= width * 0.3 && x < width * 0.7 && y >= height * 0.25 && y < height * 0.75;
      pixels[index] = subject ? 198 : 246;
      pixels[index + 1] = subject ? 36 : 246;
      pixels[index + 2] = subject ? 44 : 246;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

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

/** 只含 SOF0 头的 JPEG，足够通过签名与尺寸校验；用于格式契约，不是可用图片。 */
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
 * R03 下载核验用的确定性 Provider：按请求尺寸与格式输出合规文件。
 * 目的只是拿到"可交付"的版本去打导出/下载，不参与真实效果验收。
 */
function createImageFixture() {
  const jobs = new Map();
  const cache = new Map();
  let sequence = 0;
  const capabilities = () => ({
    id: 'r03-fixture', version: 'fixture.1', image: true, video: false,
    max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
    supports_seed: true, supports_revision: false, max_side: 2048, formats: ['jpg', 'png'],
    simulated: true, acceptance: 'simulated_only',
  });
  return {
    capabilities,
    validate: () => ({ ok: true }),
    submit(request) {
      sequence += 1;
      const providerJobId = `r03fx_${sequence}`;
      jobs.set(providerJobId, { request, polls: 0 });
      return {
        provider_job_id: providerJobId,
        status: 'queued',
        request_hash: request.request_hash,
        idempotency_key: request.idempotency_key,
        provider_meta: { id: 'r03-fixture', version: 'fixture.1', simulated: true },
      };
    },
    poll(handle) {
      const job = jobs.get(handle.provider_job_id);
      if (!job) return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
      job.polls += 1;
      if (job.polls < 2) return { status: 'queued' };
      const { request } = job;
      const width = request.target_width;
      const height = request.target_height;
      const format = (request.formats ?? ['png']).includes('png') ? 'png' : 'jpg';
      let bytes;
      if (format === 'png') {
        const key = `${width}x${height}`;
        if (!cache.has(key)) cache.set(key, gradientPng(width, height));
        bytes = cache.get(key);
      } else {
        bytes = headerOnlyJpeg(width, height);
      }
      return {
        status: 'succeeded',
        result: {
          provider: 'r03-fixture',
          model: 'fixture/image',
          model_version: 'fixture.1',
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'r03-'));
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

const as = (tenant = TENANT_A, actor = 'tester_r03') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

async function readyProject(port, tenant = TENANT_A) {
  const projectResponse = await request(port, '/api/projects', {
    method: 'POST', headers: as(tenant),
    body: { name: 'R03 蜡烛', sku: `SKU-${Math.random()}`, category: '香薰', platform: '天猫' },
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
      ],
      critical_text: [{ text: '夜航蜡烛' }],
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
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(tenant), body: { project_id: project.id },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  return { project, quote: quote.json.quote };
}

function startRun(port, { projectId, quoteId, key = `r03-${Math.random()}`, scenario, tenant = TENANT_A }) {
  return request(port, '/api/runs', {
    method: 'POST',
    headers: { ...as(tenant), 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quoteId, ...(scenario ? { scenario } : {}) },
  });
}

async function waitTerminal(port, runId, timeoutMs = 25_000) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeoutMs) {
    snapshot = (await request(port, `/api/runs/${runId}`, { headers: as() })).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled', 'needs_attention'].includes(snapshot.status)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`任务未进入终态，最后状态 ${snapshot?.status}`);
}

// ---------- 1. 批次：优先消耗最早到期，到期只回收可用部分 ----------
test('R03 批次：先扣最早到期，到期只回收可用部分，释放后再回收且不出现负余额', () => {
  const data = blankData();
  const t0 = new Date('2026-10-01T00:00:00.000Z');
  const grant = (key, amount, expiresAt) => appendEntry(data, {
    type: 'grant', amount, tenantId: 't1', uniqueOperationKey: key,
    at: t0, lot: { kind: 'plan', expires_at: expiresAt },
  });

  grant('g-early', 10, iso(days(t0, 10)));
  grant('g-late', 10, iso(days(t0, 60)));
  grant('g-never', 10, null);

  const reserved = appendEntry(data, {
    type: 'reserve', amount: 15, tenantId: 't1', jobId: 'job_1', uniqueOperationKey: 'reserve:job_1', at: t0,
  });
  assert.equal(reserved.balance.available, 15);
  assert.equal(reserved.balance.reserved, 15);
  const lots = reserved.balance.lots.filter(lot => lot.kind === 'plan');
  assert.equal(lots[0].expires_at, iso(days(t0, 10)));
  assert.equal(lots[0].reserved, 10, '最早到期的批次先被预留');
  assert.equal(lots[1].reserved, 5, '不足部分才用后到期批次');

  const captured = appendEntry(data, {
    type: 'capture', amount: 15, tenantId: 't1', jobId: 'job_1', uniqueOperationKey: 'capture:job_1', at: t0,
  });
  assert.equal(captured.balance.consumed, 15);
  const afterCapture = captured.balance.lots.filter(lot => lot.kind === 'plan');
  assert.equal(afterCapture[0].consumed, 10, '结算必须落回最早到期批次');
  assert.equal(afterCapture[1].consumed, 5);
  assert.equal(afterCapture[2].available, 10, '无到期批次保持可用');

  // 新批次 1 天后到期，先预留 4 张；到期时只能回收未预留的 6 张
  appendEntry(data, {
    type: 'grant', amount: 10, tenantId: 't1', uniqueOperationKey: 'g-expiring',
    at: t0, lot: { kind: 'plan', expires_at: iso(days(t0, 1)) },
  });
  appendEntry(data, {
    type: 'reserve', amount: 4, tenantId: 't1', jobId: 'job_2', uniqueOperationKey: 'reserve:job_2', at: t0,
  });
  const before = balanceOf(data, 't1');
  assert.equal(before.available, 21);

  const atExpiry = days(t0, 2);
  const expiredEntries = sweepExpiredLots(data, 't1', atExpiry);
  assert.equal(expiredEntries.length, 1);
  assert.equal(expiredEntries[0].amount, 6, '已预留的 4 张不得被回收');
  const pending = balanceOf(data, 't1');
  assert.equal(pending.available, 15);
  assert.equal(pending.reserved, 4);
  assert.ok(pending.lots.some(lot => lot.status === 'expired_pending' && lot.expired === 6));

  // 释放后立刻再次扫描：把剩下的 4 张也回收，余额不为负
  appendEntry(data, {
    type: 'release', amount: 4, tenantId: 't1', jobId: 'job_2', uniqueOperationKey: 'release:job_2', at: atExpiry,
  });
  const settled = balanceOf(data, 't1', { initialCredits: 0 });
  assert.equal(settled.available, 15);
  assert.equal(settled.reserved, 0);
  assert.ok(settled.lots.every(lot => lot.available >= 0 && lot.reserved >= 0 && lot.expired >= 0));
  const entries = Object.values(data.credit_entries).filter(entry => entry.type === 'expire');
  assert.equal(entries.reduce((sum, entry) => sum + entry.amount, 0), 10);
});

// ---------- 2. 体验额度绑定商品、退款与幂等 ----------
test('R03 体验额度：绑定第一个商品后不能再给第二个商品；退款不重复、不超过已结算', () => {
  const data = blankData();
  const t0 = new Date('2026-10-01T00:00:00.000Z');
  const granted = grantExperienceCredits(data, { tenantId: 't1', at: t0 });
  assert.equal(granted.entry.amount, EXPERIENCE_CREDITS);
  assert.equal(granted.balance.available, 3);
  assert.equal(granted.balance.lots[0].kind, 'experience');
  assert.ok(granted.balance.lots[0].expires_at, '体验额度必须有到期时间');

  const again = grantExperienceCredits(data, { tenantId: 't1', at: t0 });
  assert.equal(again.applied, false, '同一租户只能发一次体验额度');
  assert.equal(again.balance.available, 3);

  appendEntry(data, {
    type: 'reserve', amount: 2, tenantId: 't1', jobId: 'job_a', uniqueOperationKey: 'reserve:job_a',
    at: t0, projectId: 'proj_1',
  });
  const bound = balanceOf(data, 't1');
  assert.equal(bound.lots[0].project_id, 'proj_1');

  assert.throws(() => appendEntry(data, {
    type: 'reserve', amount: 1, tenantId: 't1', jobId: 'job_b', uniqueOperationKey: 'reserve:job_b',
    at: t0, projectId: 'proj_2',
  }), error => error.code === 'EXPERIENCE_SCOPE_LIMIT' || error.code === 'INSUFFICIENT_CREDITS');

  // 退款：只能退已结算部分，同键重放不再退第二笔
  appendEntry(data, {
    type: 'capture', amount: 2, tenantId: 't1', jobId: 'job_a', uniqueOperationKey: 'capture:job_a', at: t0,
  });
  const refunded = appendEntry(data, {
    type: 'refund', amount: 1, tenantId: 't1', uniqueOperationKey: 'refund:order_1', at: t0,
    lot: { kind: 'refund', order_id: 'order_1' },
  });
  assert.equal(refunded.balance.consumed, 1);
  assert.equal(refunded.balance.available, 2);
  const replay = appendEntry(data, {
    type: 'refund', amount: 1, tenantId: 't1', uniqueOperationKey: 'refund:order_1', at: t0,
    lot: { kind: 'refund', order_id: 'order_1' },
  });
  assert.equal(replay.applied, false, '同一退款单号不得重复退款');
  assert.equal(replay.balance.available, 2);
  assert.throws(() => appendEntry(data, {
    type: 'refund', amount: 5, tenantId: 't1', uniqueOperationKey: 'refund:order_2', at: t0,
  }), error => error.code === 'REFUND_EXHAUSTED');
});

// ---------- 3. 套餐目录与到期快照 ----------
test('R03 套餐：体验 3 张/1 商品；付费包价格、有效期与不结转规则明确；订单发放幂等', () => {
  const catalog = listCommercePlans();
  assert.equal(catalog.plans.length, 4);
  const trial = commercePlanById('plan_first_trial');
  assert.equal(trial.credits, 3);
  assert.equal(trial.products, 1);
  assert.equal(trial.price_cents, 0);
  const taster = commercePlanById('plan_taster_10');
  assert.equal(taster.price_cents, 1900);
  assert.equal(taster.credits, 10);
  assert.equal(taster.validity_days, 90, '一次性尝鲜包默认 90 天');
  const daily = commercePlanById('plan_daily_40');
  assert.equal(daily.price_cents, 6900);
  assert.equal(daily.credits, 40);
  assert.equal(daily.validity_days, 30, '月度包按到账起 30 天');
  const pro = commercePlanById('plan_pro_150');
  assert.equal(pro.price_cents, 19900);
  assert.equal(pro.credits, 150);
  assert.equal(pro.validity_days, 30);
  for (const plan of catalog.plans) {
    assert.equal(plan.auto_renew, false, '全部套餐单次购买，不自动续费');
    assert.equal(plan.rollover, false, '未用额度默认不结转');
  }
  assert.equal(catalog.rules.expiry_from, 'delivery');

  const data = blankData();
  const at = new Date('2026-10-01T00:00:00.000Z');
  const first = grantFromPlan(data, { tenantId: 't1', planId: 'plan_daily_40', orderId: 'order_1', at });
  assert.equal(first.balance.available, 40);
  assert.equal(first.balance.lots[0].expires_at, iso(days(at, 30)));
  assert.equal(first.balance.lots[0].version_snapshot.plan_id, 'plan_daily_40');
  const replay = grantFromPlan(data, { tenantId: 't1', planId: 'plan_daily_40', orderId: 'order_1', at });
  assert.equal(replay.applied, false, '重复回调不得重复发放');
  assert.equal(replay.balance.available, 40);
});

// ---------- 4. 重启与旧数据迁移 ----------
test('R03 持久化：重启前后余额与批次一致；旧数据补遗留批次后可正常结算', async t => {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'r03-store-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const at = new Date('2026-10-01T00:00:00.000Z');

  const first = createStore({ dir });
  await first.mutate(data => {
    appendEntry(data, {
      type: 'grant', amount: 12, tenantId: 't1', uniqueOperationKey: 'g1', at,
      lot: { kind: 'plan', expires_at: iso(days(at, 30)) },
    });
    appendEntry(data, {
      type: 'reserve', amount: 5, tenantId: 't1', jobId: 'job_1', uniqueOperationKey: 'reserve:job_1', at,
    });
    appendEntry(data, {
      type: 'capture', amount: 2, tenantId: 't1', jobId: 'job_1', uniqueOperationKey: 'capture:1', at,
    });
  });
  const before = await first.read(data => balanceOf(data, 't1'));
  await first.drain();

  const second = createStore({ dir });
  await second.init();
  const after = await second.read(data => balanceOf(data, 't1'));
  assert.equal(after.available, before.available);
  assert.equal(after.reserved, before.reserved);
  assert.equal(after.consumed, before.consumed);
  assert.equal(after.lots.length, before.lots.length);
  assert.equal(after.lots[0].lot_id, before.lots[0].lot_id, '批次身份必须持久化');

  const released = await second.mutate(data => appendEntry(data, {
    type: 'release', amount: 3, tenantId: 't1', jobId: 'job_1', uniqueOperationKey: 'release:job_1', at,
  }));
  assert.equal(released.balance.reserved, 0);
  assert.equal(released.balance.available, 10);

  // 旧数据：只有账户汇总，没有批次；首次访问补遗留批次，结算不再报"批次缺失"
  const legacy = blankData();
  legacy.credit_accounts.t2 = {
    tenant_id: 't2', available: 7, reserved: 2, consumed: 1, granted_total: 10,
    currency: '内部演示额度', testing: true, created_at: iso(at), updated_at: iso(at),
  };
  const migrated = balanceOf(legacy, 't2');
  assert.equal(migrated.available, 7);
  assert.equal(migrated.lots.length, 1);
  assert.equal(migrated.lots[0].kind, 'legacy');
  const legacyRelease = appendEntry(legacy, {
    type: 'release', amount: 2, tenantId: 't2', jobId: 'legacy_job', uniqueOperationKey: 'release:legacy', at,
  });
  assert.equal(legacyRelease.balance.reserved, 0);
  assert.equal(legacyRelease.balance.available, 9);
});

// ---------- 5. HTTP：注册发体验额度；余额不足不调用模型；重复提交不重复预留 ----------
test('R03 账户：注册只发一次体验额度；余额不足在调用供应商前被拒绝；同键重复提交不重复预留', async t => {
  const { port } = await start(t, { initialCredits: 0 });
  const registered = await request(port, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { email: 'r03@example.com', password: 'r03-password-1', display_name: 'R03', tenant_name: 'R03 工作区' },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  assert.equal(registered.json.experience_credits, EXPERIENCE_CREDITS);
  const cookie = String(registered.headers['set-cookie'][0]).split(';')[0];
  const credits = await request(port, '/api/credits', { headers: { Cookie: cookie } });
  assert.equal(credits.status, 200, JSON.stringify(credits.json));
  assert.equal(credits.json.balance.available, EXPERIENCE_CREDITS);
  assert.equal(credits.json.balance.lots.length, 1);
  assert.equal(credits.json.balance.lots[0].kind, 'experience');
  assert.equal(credits.json.balance.lots[0].project_id, null, '未使用前不绑定商品');

  // 体验额度不足以支付完整套图：必须在调用供应商前被拒绝
  const limited = await start(t, { initialCredits: 1 });
  const { project, quote } = await readyProject(limited.port);
  assert.ok(quote.max_credits > 1);
  const rejected = await startRun(limited.port, { projectId: project.id, quoteId: quote.quote_id, key: 'poor-1' });
  assert.equal(rejected.status, 402, JSON.stringify(rejected.json));
  assert.equal(rejected.json.error, 'INSUFFICIENT_CREDITS');
  const runs = await request(limited.port, '/api/runs', { headers: as() });
  assert.equal(runs.json.runs.length, 0, '拒绝时不得创建任务');
  const records = await request(limited.port, '/api/generation-records', { headers: as() });
  assert.equal(records.json.records.length, 0, '拒绝时不得调用供应商');

  const funded = await start(t, { initialCredits: 240 });
  const ready = await readyProject(funded.port);
  const first = await startRun(funded.port, {
    projectId: ready.project.id, quoteId: ready.quote.quote_id, key: 'same-key',
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const replay = await startRun(funded.port, {
    projectId: ready.project.id, quoteId: ready.quote.quote_id, key: 'same-key',
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.run.id, first.json.run.id);
  const balance = (await request(funded.port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(balance.reserved, ready.quote.max_credits, '同键重复提交只应预留一次');
  await waitTerminal(funded.port, first.json.run.id);
});

// ---------- 6. HTTP：同版本重复下载不扣费 ----------
test('R03 下载：同一已付版本重复导出与下载不再扣费', async t => {
  const { port } = await start(t, { initialCredits: 240, provider: createImageFixture() });
  const { project, quote } = await readyProject(port);
  const created = await startRun(port, { projectId: project.id, quoteId: quote.quote_id, key: 'download-run' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const run = await waitTerminal(port, created.json.run.id);
  assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, reason: run.terminal_reason }));

  const versions = await request(port, `/api/runs/${run.id}/versions`, { headers: as() });
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  const early = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(early.status, 409, '未复核前不得导出完整包');
  assert.equal(early.json.error, 'EXPORT_NOT_READY');

  const activeIds = new Set(versions.json.versions.filter(item => item.active).map(item => item.report_id));
  const reports = await request(port, `/api/runs/${run.id}/quality-reports`, { headers: as() });
  assert.equal(reports.status, 200, JSON.stringify(reports.json));
  for (const report of reports.json.reports.filter(item => activeIds.has(item.id))) {
    const decisions = report.checks
      .filter(item => item.status === 'unknown' && item.required === true && item.adjudicable === true)
      .map(item => ({
        code: item.code, decision: 'pass',
        reason: `R03 重复下载核验 ${item.code}`, evidence: `复核记录 ${report.id}`,
      }));
    assert.ok(decisions.length > 0, `${report.id} 应有可裁决未知项`);
    const reviewed = await request(port, `/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', headers: as('tenant_a', 'reviewer_r03'), body: { decisions, note: 'R03 重复下载核验' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  }
  const exported = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));

  const before = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(before.available, 240 - before.consumed, '除已结算外不应再有冻结');
  const first = await request(port, exported.json.export.download_url, { headers: as() });
  assert.equal(first.status, 200);
  const second = await request(port, exported.json.export.download_url, { headers: as() });
  assert.equal(second.status, 200);
  const again = await request(port, `/api/runs/${run.id}/exports`, {
    method: 'POST', headers: as(), body: { scope: 'complete' },
  });
  assert.equal(again.status, 201, JSON.stringify(again.json));
  const secondDownload = await request(port, again.json.export.download_url, { headers: as() });
  assert.equal(secondDownload.status, 200);
  const after = (await request(port, '/api/credits', { headers: as() })).json.balance;
  assert.equal(after.available, before.available);
  assert.equal(after.reserved, before.reserved);
  assert.equal(after.consumed, before.consumed, '重复导出/下载不得再次扣费');
});
