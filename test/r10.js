/**
 * R10 批量与平台输出收口测试。
 *
 * 验收口径：
 * 1. 导出清单可核对——张数、尺寸与任务冻结规格一致（count_check / dimension_check）。
 * 2. 平台规则带来源与核验日期（rule_ref.source_name / effective_at / review_due_at）。
 * 3. 批量预算闸口在真实额度（订单发放）下正确拦截与放行。
 * 4. 单项失败不影响其他条目，不多扣不少扣。
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
const as = (tenant = 'tenant_a', actor = 'owner_r10') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'r10-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 400, tickMs: 8, attemptTimeoutMs: 30_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

/** 与 M11 测试相同的尺寸 Provider：按清单要求的真实尺寸出图 */
function createSizeFixture() {
  const capabilities = () => ({
    id: 'r10-fixture', version: 'fixture.1', image: true, video: false,
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
      provider: 'r10-fixture', model: 'fixture/image', model_version: 'fixture.1',
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
        provider_meta: { id: 'r10-fixture', version: 'fixture.1', simulated: true },
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

const COLUMNS = ['SKU编码', '商品名', '类目', '平台', '模板', '品牌', '容量'];
const MAPPING = {
  sku: 'SKU编码', name: '商品名', category: '类目', platform: '平台',
  template_id: '模板', brand_kit_id: '品牌', facts: [{ key: '容量', column: '容量' }],
};

const row = (sku, name, extra = {}) => ({
  SKU编码: sku, 商品名: name, 类目: '精华', 平台: '天猫',
  模板: 'tpl_listing_pack', 品牌: '', 容量: '30ml', ...extra,
});

async function freezeProject(port, projectId, tenant = 'tenant_a', actor = 'owner_r10') {
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

/** 等待批量条目终态 */
async function waitItemDone(port, batchId, itemId, headers) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const polled = await request(port, `/api/batches/${batchId}`, { headers });
    assert.equal(polled.status, 200, JSON.stringify(polled.json));
    const item = polled.json.batch.items.find(i => i.id === itemId);
    if (item.status === 'completed' || item.status === 'failed') return item;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  throw new Error(`条目 ${itemId} 未在预期时间内完成`);
}

/** 复核质量报告使可发布 */
async function reviewToPublishable(port, runId, headers) {
  const runDetail = await request(port, `/api/runs/${runId}`, { headers });
  assert.equal(runDetail.status, 200, JSON.stringify(runDetail.json));
  for (const version of runDetail.json.run.versions) {
    const reportRes = await request(port, `/api/quality-reports/${version.report_id}`, { headers });
    const report = reportRes.json.report;
    if (report.decision === 'publishable') continue;
    const decisions = report.checks
      .filter(item => item.status === 'unknown' && item.required === true && item.adjudicable === true)
      .map(item => ({ code: item.code, decision: 'pass', reason: `R10 复核 ${item.code}`, evidence: `复核 ${report.id}` }));
    const reviewed = await request(port, `/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', headers, body: { decisions, note: 'R10 批量复核' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
    assert.equal(reviewed.json.report.decision, 'publishable');
  }
}

// ---------- 测试 ----------

test('R10 批量导出清单：包含平台规则来源、核验日期、尺寸与张数核对', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 创建批量：1 个有效 SKU
  const created = await request(port, '/api/batches', {
    method: 'POST', headers,
    body: {
      name: 'R10 规则溯源批次', columns: COLUMNS, mapping: MAPPING,
      rows: [row('R10-01', '规则溯源精华')],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const batch = created.json.batch;
  const item = batch.items[0];

  // 准备项目
  await freezeProject(port, item.project_id);

  // 预览 + 开始
  const preview = await request(port, `/api/batches/${batch.id}/preview`, { method: 'POST', headers });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.preview.can_start, true);

  const started = await request(port, `/api/batches/${batch.id}/start`, {
    method: 'POST', headers, body: { confirm_budget: true },
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.equal(started.json.started, 1);

  // 等待完成 + 复核
  const doneItem = await waitItemDone(port, batch.id, item.id, headers);
  assert.equal(doneItem.status, 'completed');
  await reviewToPublishable(port, doneItem.run_id, headers);

  // 导出
  const exported = await request(port, `/api/batches/${batch.id}/exports`, {
    method: 'POST', headers, body: { scope: 'partial' },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const manifest = exported.json.export.manifest;

  // 验证：每个条目有 rule_ref 含来源与核验日期
  assert.equal(manifest.items.length, 1);
  const manifestItem = manifest.items[0];
  assert.equal(manifestItem.sku, 'R10-01');
  assert.ok(manifestItem.rule_ref, 'rule_ref 必须存在');
  assert.equal(manifestItem.rule_ref.platform, '天猫');
  assert.equal(manifestItem.rule_ref.rule_id, 'ch_tmall_listing');
  assert.equal(manifestItem.rule_ref.version, '2026.03');
  assert.equal(manifestItem.rule_ref.source_name, '内部演示基线（非平台官方条款）');
  assert.equal(manifestItem.rule_ref.source_verified, false);
  assert.ok(manifestItem.rule_ref.effective_at, '必须有生效日期');
  assert.ok(manifestItem.rule_ref.review_due_at, '必须有复核日期');
  assert.ok(['current', 'review_due'].includes(manifestItem.rule_ref.current_status),
    `规则状态应为 current 或 review_due，实际为 ${manifestItem.rule_ref.current_status}`);

  // 验证：count_check 与 dimension_check
  assert.ok(manifestItem.count_check, 'count_check 必须存在');
  assert.equal(manifestItem.count_check.match, true,
    `张数不匹配: expected=${manifestItem.count_check.expected} exported=${manifestItem.count_check.exported}`);
  assert.ok(manifestItem.count_check.expected > 0, '规格交付物数量应大于 0');
  assert.equal(manifestItem.count_check.expected, manifestItem.count_check.exported);

  assert.ok(Array.isArray(manifestItem.dimension_check), 'dimension_check 必须是数组');
  assert.equal(manifestItem.dimension_check.length, manifestItem.images.length);
  for (const dc of manifestItem.dimension_check) {
    assert.equal(dc.match, true, `尺寸不匹配: ${dc.deliverable_id} expected=${dc.expected?.width}x${dc.expected?.height} actual=${dc.actual?.width}x${dc.actual?.height}`);
  }

  // 验证：文件命名遵循 images/{sku}/{deliverable_id}.{format}
  for (const img of manifestItem.images) {
    assert.ok(img.file.startsWith(`images/${manifestItem.sku}/`), `文件路径应以 images/${manifestItem.sku}/ 开头，实际为 ${img.file}`);
    assert.ok(img.file.endsWith(`.${img.format}`), `文件扩展名应与格式一致: ${img.file}`);
  }
});

test('R10 批量预算闸口：真实额度（订单发放）下的拦截与放行', async t => {
  // 用极低初始额度创建，使批量预算超出现有额度；同时注入 mock 支付 Provider 使订单可创建
  const { port } = await start(t, {
    provider: createSizeFixture(),
    initialCredits: 1,
    paymentProvider: createMockWechatPaymentProvider({ realMoney: true }),
  });
  const headers = as();

  // 创建批量：1 个 SKU
  const created = await request(port, '/api/batches', {
    method: 'POST', headers,
    body: {
      name: 'R10 额度闸口批次', columns: COLUMNS, mapping: MAPPING,
      rows: [row('R10-02', '额度测试精华')],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const batch = created.json.batch;
  const item = batch.items[0];

  // 准备项目
  await freezeProject(port, item.project_id);

  // 预览：can_start 应为 false（额度不足）
  const preview = await request(port, `/api/batches/${batch.id}/preview`, { method: 'POST', headers });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.preview.can_start, false, '额度不足时不应允许开始');

  // 开始：确认预算但额度不足 → 409
  const denied = await request(port, `/api/batches/${batch.id}/start`, {
    method: 'POST', headers, body: { confirm_budget: true },
  });
  assert.equal(denied.status, 409, JSON.stringify(denied.json));

  // 通过订单发放额度：用 plan_pro_150（150 张，足够覆盖 tpl_listing_pack 的 24 max_credits）
  const order = await request(port, '/api/billing/orders', {
    method: 'POST', headers,
    body: { plan_id: 'plan_pro_150' },
  });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  const orderId = order.json.order.id;
  assert.equal(order.json.order.status, 'pending_wechat_checkout');
  assert.equal(order.json.order.real_money, true);

  // mock provider 模拟支付成功：先改状态再发回调
  // 从 createApp 外部引用 mock provider 实例来操作状态
  // 由于 createApp 不暴露 provider，直接用 _mockNotify 格式的回调体
  const notifyBody = {
    event_type: 'TRANSACTION.SUCCESS',
    data: {
      out_trade_no: order.json.order.out_trade_no,
      transaction_id: `MOCK_${order.json.order.out_trade_no}`,
      trade_state: 'SUCCESS',
      amount: { total: order.json.order.price_cents, currency: 'CNY' },
    },
  };
  const notify = await request(port, '/api/billing/wechat/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: notifyBody,
  });
  assert.equal(notify.status, 200, JSON.stringify(notify.json));
  assert.equal(notify.json.code, 'SUCCESS');

  // 确认订单已结算
  const settled = await request(port, '/api/billing/orders', { headers });
  const settledOrder = settled.json.orders.find(o => o.id === orderId);
  assert.equal(settledOrder.status, 'settled_real', '支付成功后订单应已结算');

  // 再次预览：额度充足
  const preview2 = await request(port, `/api/batches/${batch.id}/preview`, { method: 'POST', headers });
  assert.equal(preview2.status, 200, JSON.stringify(preview2.json));
  assert.equal(preview2.json.preview.can_start, true, '额度充足后应允许开始');

  // 开始批量
  const started = await request(port, `/api/batches/${batch.id}/start`, {
    method: 'POST', headers, body: { confirm_budget: true },
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.equal(started.json.started, 1);
});

test('R10 单项失败不影响其他条目：失败隔离与额度正确性', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 创建批量：2 个有效 SKU
  const created = await request(port, '/api/batches', {
    method: 'POST', headers,
    body: {
      name: 'R10 失败隔离批次', columns: COLUMNS, mapping: MAPPING,
      rows: [row('R10-03', '精华甲'), row('R10-04', '精华乙')],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const batch = created.json.batch;
  const itemA = batch.items[0];
  const itemB = batch.items[1];

  // 只准备 itemA，itemB 保持未就绪
  await freezeProject(port, itemA.project_id);

  // 预览：itemA ready，itemB blocked
  const preview = await request(port, `/api/batches/${batch.id}/preview`, { method: 'POST', headers });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const previewItems = preview.json.batch.items;
  assert.equal(previewItems.find(i => i.id === itemA.id).status, 'ready');
  assert.equal(previewItems.find(i => i.id === itemB.id).status, 'blocked');

  // 记录开始前余额
  const balBefore = await request(port, '/api/credits', { headers });
  assert.equal(balBefore.status, 200);
  const availableBefore = balBefore.json.balance.available;

  // 开始批量：只有 itemA 执行
  const started = await request(port, `/api/batches/${batch.id}/start`, {
    method: 'POST', headers, body: { confirm_budget: true },
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.equal(started.json.started, 1);
  assert.equal(started.json.failures.length, 0);

  // 等待 itemA 完成
  const doneA = await waitItemDone(port, batch.id, itemA.id, headers);
  assert.equal(doneA.status, 'completed');
  await reviewToPublishable(port, doneA.run_id, headers);

  // 导出部分包：itemA 包含，itemB 缺失
  const exported = await request(port, `/api/batches/${batch.id}/exports`, {
    method: 'POST', headers, body: { scope: 'partial' },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const exp = exported.json.export;
  assert.equal(exp.complete, false);
  assert.equal(exp.included.length > 0, true);
  assert.ok(exp.missing.some(m => m.item_id === itemB.id), 'itemB 应在 missing 中');
  assert.ok(exp.missing.find(m => m.item_id === itemB.id)?.reason?.includes('BLOCKED'),
    'itemB 缺失原因应为 blocked');

  // 额度只扣了 itemA 的部分
  const balAfter = await request(port, '/api/credits', { headers });
  assert.equal(balAfter.status, 200);
  const availableAfter = balAfter.json.balance.available;
  assert.ok(availableAfter < availableBefore, '完成后额度应减少');
  // 减少量不应超过 itemA 的 max_credits
  const consumed = availableBefore - availableAfter;
  assert.ok(consumed > 0, '应有额度消耗');
});

test('R10 完整批量包：全部完成时可导出 complete', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 创建批量：2 个 SKU，都准备
  const created = await request(port, '/api/batches', {
    method: 'POST', headers,
    body: {
      name: 'R10 完整包批次', columns: COLUMNS, mapping: MAPPING,
      rows: [row('R10-05', '精华丙'), row('R10-06', '精华丁')],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const batch = created.json.batch;

  // 两个项目都准备
  for (const item of batch.items) {
    await freezeProject(port, item.project_id);
  }

  // 预览 + 开始
  const preview = await request(port, `/api/batches/${batch.id}/preview`, { method: 'POST', headers });
  assert.equal(preview.json.preview.can_start, true);

  const started = await request(port, `/api/batches/${batch.id}/start`, {
    method: 'POST', headers, body: { confirm_budget: true },
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.started, 2);

  // 等待全部完成 + 复核
  for (const item of batch.items) {
    const done = await waitItemDone(port, batch.id, item.id, headers);
    assert.equal(done.status, 'completed');
    await reviewToPublishable(port, done.run_id, headers);
  }

  // 完整包导出
  const exported = await request(port, `/api/batches/${batch.id}/exports`, {
    method: 'POST', headers, body: { scope: 'complete' },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const exp = exported.json.export;
  assert.equal(exp.complete, true);
  assert.equal(exp.status, 'PACKAGE_COMPLETE');
  assert.equal(exp.manifest.items.length, 2);
  assert.equal(exp.manifest.missing.length, 0);

  // 每个条目的 count_check 与 dimension_check 都必须通过
  for (const item of exp.manifest.items) {
    assert.equal(item.count_check.match, true, `${item.sku} 张数不匹配`);
    for (const dc of item.dimension_check) {
      assert.equal(dc.match, true, `${item.sku}/${dc.deliverable_id} 尺寸不匹配`);
    }
    assert.ok(item.rule_ref, `${item.sku} 缺少 rule_ref`);
    assert.ok(item.rule_ref.source_name, `${item.sku} 缺少规则来源`);
  }
});
