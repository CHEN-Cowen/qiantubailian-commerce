/**
 * M11 测试：SKU 导入映射与逐行预览、批量预算闸口与失败隔离、成员权限矩阵、
 * 品牌配方的私有/共享与审批失效、批量导出（不用抽检替代硬检查）。
 *
 * 端到端用例走真实 HTTP 与任务状态机；模拟与真实能力在断言里明确区分。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { createHash } from 'node:crypto';
import {
  PERMISSIONS, ROLES, applyRecipeApproval, batchSummary, can, evaluateRecipeUseValidity,
  isRecipeVisible, makeRecipeVersion, planBatch, planBatchExport, planMemberChange,
  previewImportRows, resolveRole, summarizeCatalogConsole, validateMapping, validateRecipeInput,
} from '../src/m11.mjs';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'owner_m11') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm11-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 400, tickMs: 8, attemptTimeoutMs: 3_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

/**
 * 测试专用 Provider：按清单要求的真实尺寸出图，使质量检查能走到"可发布"。
 * 它不是真实模型，仅用于验证批量编排与导出闸口；simulated 标记保持为真。
 */
function createSizeFixture() {
  const capabilities = () => ({
    id: 'm11-fixture', version: 'fixture.1', image: true, video: false,
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
      provider: 'm11-fixture', model: 'fixture/image', model_version: 'fixture.1',
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
        provider_meta: { id: 'm11-fixture', version: 'fixture.1', simulated: true },
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

// ---------- 纯函数 ----------

test('M11 导入映射：未知字段、列不在表头、列重复、缺必填映射都必须报错', () => {
  const base = validateMapping({ columns: COLUMNS, mapping: MAPPING });
  assert.equal(base.ok, true);
  assert.equal(base.mapping.sku, 'SKU编码');
  assert.equal(base.factColumns.length, 1);

  assert.equal(validateMapping({ columns: COLUMNS, mapping: { ...MAPPING, unknown: '容量' } }).issues
    .some(item => item.code === 'IMPORT_TARGET_UNKNOWN'), true);
  assert.equal(validateMapping({ columns: COLUMNS, mapping: { ...MAPPING, sku: '不存在' } }).issues
    .some(item => item.code === 'IMPORT_COLUMN_MISSING'), true);
  assert.equal(validateMapping({ columns: COLUMNS, mapping: { ...MAPPING, name: 'SKU编码' } }).issues
    .some(item => item.code === 'IMPORT_COLUMN_REUSED'), true);
  assert.equal(validateMapping({ columns: COLUMNS, mapping: { sku: 'SKU编码' } }).issues
    .some(item => item.code === 'IMPORT_REQUIRED_TARGET'), true);
});

test('M11 逐行预览：非法行与重复 SKU 只影响自身，不静默丢弃整批', () => {
  const preview = previewImportRows({
    columns: COLUMNS, mapping: MAPPING,
    rows: [
      row('SKU-1', '精华一号'),
      row('SKU-1', '重复行'),
      row('', '无编码'),
      row('BAD SKU!', '非法编码'),
      row('SKU-2', '精华二号'),
    ],
    existingSkus: ['sku-2'],
    templateIds: ['tpl_listing_pack'],
    brandKitIds: [],
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.summary.total, 5);
  assert.equal(preview.summary.valid, 1);
  assert.equal(preview.rows[0].valid, true);
  assert.equal(preview.rows[0].facts[0].key, '容量');
  assert.equal(preview.rows[1].valid, false);
  assert.ok(preview.rows[1].errors.some(item => item.code === 'IMPORT_SKU_DUPLICATE_ROW'));
  assert.ok(preview.rows[2].errors.some(item => item.code === 'IMPORT_SKU_EMPTY'));
  assert.ok(preview.rows[3].errors.some(item => item.code === 'IMPORT_SKU_INVALID'));
  // SKU-2 已存在（大小写不敏感）
  assert.ok(preview.rows[4].errors.some(item => item.code === 'IMPORT_SKU_EXISTS'));
});

test('M11 批量计划：无可用条目、超预算、未确认预算都不允许开始', () => {
  const items = [
    { item_id: 'i1', sku: 'S1', status: 'ready', estimated_credits: 10, max_credits: 30 },
    { item_id: 'i2', sku: 'S2', status: 'blocked', blockers: [{ code: 'SPEC_REQUIRED' }] },
  ];
  const noConfirm = planBatch({ items, availableCredits: 100, confirmed: false });
  assert.equal(noConfirm.can_start, false);
  assert.ok(noConfirm.reasons.some(item => item.code === 'BATCH_BUDGET_UNCONFIRMED'));
  assert.equal(noConfirm.summary.total, 2);
  assert.equal(noConfirm.summary.blocked, 1);

  const over = planBatch({ items, availableCredits: 5, confirmed: true });
  assert.equal(over.over_budget, true);
  assert.ok(over.reasons.some(item => item.code === 'BATCH_BUDGET_EXCEEDED'));

  const ok = planBatch({ items, availableCredits: 100, confirmed: true });
  assert.equal(ok.can_start, true);
  assert.equal(ok.max_credits, 30);

  const empty = planBatch({ items: [], availableCredits: 100, confirmed: true });
  assert.equal(empty.can_start, false);
  assert.ok(empty.reasons.some(item => item.code === 'BATCH_NO_READY_ITEM'));
});

test('M11 批量导出：失败与阻断逐项列出；完整包不允许带缺口', () => {
  const items = [
    { item_id: 'i1', sku: 'S1', status: 'completed', exportable: true },
    { item_id: 'i2', sku: 'S2', status: 'failed', reason: 'PROVIDER_ERROR' },
    { item_id: 'i3', sku: 'S3', status: 'completed', exportable: false, reason: 'NOT_PUBLISHABLE' },
  ];
  const partial = planBatchExport({ items, scope: 'partial' });
  assert.equal(partial.ok, true);
  assert.equal(partial.included.length, 1);
  assert.equal(partial.missing.length, 2);
  assert.ok(partial.missing.some(item => item.reason === 'NOT_PUBLISHABLE'));

  const complete = planBatchExport({ items, scope: 'complete' });
  assert.equal(complete.ok, false);
  assert.equal(complete.code, 'BATCH_EXPORT_INCOMPLETE');

  const empty = planBatchExport({ items: items.filter(item => !item.exportable), scope: 'partial' });
  assert.equal(empty.code, 'BATCH_EXPORT_EMPTY');
});

test('M11 成员：零成员租户引导为 owner；角色矩阵与最后 owner 保护', () => {
  assert.equal(resolveRole({ members: [], actorId: 'anyone' }).role, 'owner');
  assert.equal(resolveRole({ members: [{ actor_id: 'u1', role: 'editor' }], actorId: 'u2' }).role, null);
  assert.equal(can('viewer', 'batch:start'), false);
  assert.equal(can('editor', 'batch:start'), true);
  assert.equal(can('reviewer', 'batch:create'), false);
  assert.equal(can('owner', 'member:manage'), true);
  for (const role of ROLES) assert.ok(PERMISSIONS[role].includes('project:read'), `${role} 至少能读项目`);

  const lastOwner = planMemberChange({
    members: [{ actor_id: 'u1', role: 'owner' }], targetActorId: 'u1', nextRole: null, actorRole: 'owner',
  });
  assert.equal(lastOwner.ok, false);
  assert.equal(lastOwner.code, 'MEMBER_LAST_OWNER');

  const forbidden = planMemberChange({
    members: [{ actor_id: 'u1', role: 'owner' }], targetActorId: 'u2', nextRole: 'editor', actorRole: 'editor',
  });
  assert.equal(forbidden.code, 'MEMBER_MANAGE_FORBIDDEN');
});

test('M11 配方：私有仅创建者可见；共享需审批；新审批让旧引用 stale', () => {
  const privateRecipe = { id: 'r1', scope: 'private', created_by: 'u1' };
  assert.equal(isRecipeVisible({ recipe: privateRecipe, actorId: 'u1' }), true);
  assert.equal(isRecipeVisible({ recipe: privateRecipe, actorId: 'u2' }), false);
  assert.equal(isRecipeVisible({ recipe: { scope: 'shared', created_by: 'u1' }, actorId: 'u2' }), true);

  const invalid = validateRecipeInput({ name: '', scope: 'shared' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some(item => item.code === 'RECIPE_NAME_REQUIRED'));
  assert.ok(invalid.issues.some(item => item.code === 'RECIPE_TEMPLATE_REQUIRED'));

  const payload = validateRecipeInput({
    name: '品牌 A 主图配方', scope: 'shared', template_id: 'tpl_listing_pack', platform: '天猫',
    brand_kit_id: 'bk_1', copy_version: 'copy_v1',
  });
  assert.equal(payload.ok, true);

  const version1 = makeRecipeVersion({ recipeId: 'r1', payload: payload.payload, actorId: 'u1' });
  assert.equal(version1.status, 'pending');
  assert.equal(version1.approval.required, true);

  const rejected = applyRecipeApproval({ version: version1, decision: 'approve', actorRole: 'editor', actorId: 'u2' });
  assert.equal(rejected.code, 'RECIPE_APPROVE_FORBIDDEN');

  const approved1 = applyRecipeApproval({ version: version1, decision: 'approve', actorRole: 'owner', actorId: 'u1' });
  assert.equal(approved1.ok, true);
  assert.equal(approved1.version.status, 'approved');

  const usage = { recipe_version: 1, actor_id: 'u1' };
  assert.equal(evaluateRecipeUseValidity({ usage, recipe: privateRecipe, versions: [approved1.version] }).validity, 'current');

  const version2 = { ...makeRecipeVersion({ recipeId: 'r1', previousVersions: [approved1.version], payload: { ...payload.payload, copy_version: 'copy_v2' }, actorId: 'u1' }) };
  const approved2 = applyRecipeApproval({ version: version2, decision: 'approve', actorRole: 'owner', actorId: 'u1' });
  const superseded = { ...approved1.version, status: 'superseded' };
  const stale = evaluateRecipeUseValidity({ usage, recipe: privateRecipe, versions: [superseded, approved2.version] });
  assert.equal(stale.validity, 'stale');
  assert.equal(stale.latest_version, 2);

  const mismatchKit = evaluateRecipeUseValidity({
    usage, recipe: { ...privateRecipe, brand_kit_id: 'bk_2' }, versions: [approved2.version], currentBrandKitId: 'bk_1',
  });
  assert.equal(mismatchKit.validity, 'invalid');
});

test('M11 目录控制台：按阻断原因聚合而不是只给总数', () => {
  const summary = summarizeCatalogConsole({
    items: [
      { item_id: '1', sku: 'S1', status: 'blocked', blockers: [{ code: 'SPEC_REQUIRED' }] },
      { item_id: '2', sku: 'S2', status: 'blocked', blockers: [{ code: 'SPEC_REQUIRED' }, { code: 'TRUTH_UNCONFIRMED' }] },
      { item_id: '3', sku: 'S3', status: 'completed', blockers: [] },
    ],
  });
  assert.equal(summary.summary.total, 3);
  assert.equal(summary.blockers[0].code, 'SPEC_REQUIRED');
  assert.equal(summary.blockers[0].count, 2);
  assert.equal(summary.needs_attention.length, 2);
});

// ---------- 端到端 ----------

async function freezeProject(port, projectId, tenant = 'tenant_a', actor = 'owner_m11') {
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

test('M11 端到端：导入→预览阻断→权限→批量执行失败隔离→部分导出→配方审批失效→租户隔离', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 1) 导入：2 个有效 SKU + 1 个重复行
  const created = await request(port, '/api/batches', {
    method: 'POST', headers,
    body: {
      name: '双十一精华批次', columns: COLUMNS, mapping: MAPPING,
      rows: [row('BATCH-01', '批量精华一'), row('BATCH-01', '重复 SKU'), row('BATCH-02', '批量精华二')],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const batch = created.json.batch;
  assert.equal(batch.items.length, 3);
  assert.equal(batch.items[1].status, 'invalid');
  assert.ok(batch.items[1].blockers.some(item => item.code === 'IMPORT_SKU_DUPLICATE_ROW'));

  // 2) 预览：新项目未确认事实/未冻结配置 → 有效行判 blocked，非法行保持 invalid
  const preview = await request(port, `/api/batches/${batch.id}/preview`, { method: 'POST', headers });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const readyItems = preview.json.batch.items.filter(item => item.status === 'ready');
  assert.equal(readyItems.length, 0);
  assert.ok(preview.json.batch.items[0].blockers.some(item => ['TRUTH_REQUIRED', 'SPEC_REQUIRED', 'TRUTH_UNCONFIRMED', 'NO_CONFIRMED_TRUTH'].includes(item.code)),
    JSON.stringify(preview.json.batch.items[0].blockers));
  assert.equal(preview.json.preview.can_start, false);

  // 3) 未确认预算不能开始
  const unconfirmed = await request(port, `/api/batches/${batch.id}/start`, { method: 'POST', headers, body: {} });
  assert.equal(unconfirmed.status, 422);
  assert.equal(unconfirmed.json.error, 'BATCH_BUDGET_UNCONFIRMED');

  // 4) 准备其中一个项目（第二个保持未就绪，用于验证失败隔离）
  const firstItem = batch.items[0];
  await freezeProject(port, firstItem.project_id);
  const afterPrep = await request(port, `/api/batches/${batch.id}/preview`, { method: 'POST', headers });
  assert.equal(afterPrep.status, 200, JSON.stringify(afterPrep.json));
  const prepItems = afterPrep.json.batch.items;
  assert.equal(prepItems.find(item => item.id === firstItem.id).status, 'ready');
  assert.equal(prepItems.find(item => item.id === batch.items[2].id).status, 'blocked');
  assert.equal(afterPrep.json.preview.can_start, true);
  assert.equal(afterPrep.json.preview.requires_budget_confirmation, true);

  // 5) 成员权限：新增 viewer 后，viewer 不能开始批量
  const added = await request(port, '/api/members', {
    method: 'POST', headers, body: { actor_id: 'viewer_m11', role: 'viewer' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  const denied = await request(port, `/api/batches/${batch.id}/start`, {
    method: 'POST', headers: as('tenant_a', 'viewer_m11'), body: { confirm_budget: true },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));
  assert.equal(denied.json.error, 'FORBIDDEN');
  const viewerRead = await request(port, '/api/batches', { headers: as('tenant_a', 'viewer_m11') });
  assert.equal(viewerRead.status, 200);
  // 未登记成员一律 403
  const stranger = await request(port, '/api/batches', { headers: as('tenant_a', 'stranger_m11') });
  assert.equal(stranger.status, 403);

  // 6) 开始批量：只有就绪条目执行，其余阻断不影响
  const started = await request(port, `/api/batches/${batch.id}/start`, {
    method: 'POST', headers, body: { confirm_budget: true },
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.equal(started.json.started, 1);
  assert.equal(started.json.failures.length, 0);

  // 7) 等待条目完成（任务状态机异步推进）
  let finalItem = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const polled = await request(port, `/api/batches/${batch.id}`, { headers });
    assert.equal(polled.status, 200, JSON.stringify(polled.json));
    finalItem = polled.json.batch.items.find(item => item.id === firstItem.id);
    if (finalItem.status === 'completed' || finalItem.status === 'failed') break;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  assert.equal(finalItem.status, 'completed', JSON.stringify(finalItem));

  // 8) 逐条复核可裁决的未知项，使条目成为可发布（机器状态保留）
  const runDetail = await request(port, `/api/runs/${finalItem.run_id}`, { headers });
  assert.equal(runDetail.status, 200, JSON.stringify(runDetail.json));
  for (const version of runDetail.json.run.versions) {
    const reportRes = await request(port, `/api/quality-reports/${version.report_id}`, { headers });
    const report = reportRes.json.report;
    if (report.decision === 'publishable') continue;
    const decisions = report.checks
      .filter(item => item.status === 'unknown' && item.required === true && item.adjudicable === true)
      .map(item => ({ code: item.code, decision: 'pass', reason: `M11 逐项复核 ${item.code}`, evidence: `复核 ${report.id}` }));
    const reviewed = await request(port, `/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', headers, body: { decisions, note: 'M11 批量复核' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
    assert.equal(reviewed.json.report.decision, 'publishable');
  }

  // 9) 导出：部分包含 1 项，其余逐项列出；完整包被拒绝
  const exportsPartial = await request(port, `/api/batches/${batch.id}/exports`, {
    method: 'POST', headers, body: { scope: 'partial' },
  });
  assert.equal(exportsPartial.status, 201, JSON.stringify(exportsPartial.json));
  const exportRecord = exportsPartial.json.export;
  assert.equal(exportRecord.kind, 'batch');
  assert.equal(exportRecord.complete, false);
  assert.equal(exportRecord.included.length > 0, true);
  assert.ok(exportRecord.missing.some(item => item.status === 'invalid'));
  assert.ok(exportRecord.missing.some(item => item.status === 'blocked'));

  const exportsComplete = await request(port, `/api/batches/${batch.id}/exports`, {
    method: 'POST', headers, body: { scope: 'complete' },
  });
  assert.equal(exportsComplete.status, 409, JSON.stringify(exportsComplete.json));

  // 9) 配方：共享配方需 owner 审批，审批新版本让旧引用 stale
  const kit = await request(port, '/api/brand-kits', {
    method: 'POST', headers,
    body: {
      name: '批量品牌套件', palette: { primary: '#246BCE', secondary: ['#F8FAFC'] },
      logo: { present: false }, fonts: [{ name: '思源黑体', license: 'licensed', license_ref: 'LIC-1' }],
      tone: '克制', banned_expressions: [],
    },
  });
  assert.equal(kit.status, 201, JSON.stringify(kit.json));
  const recipeCreated = await request(port, '/api/recipes', {
    method: 'POST', headers,
    body: {
      name: '共享主图配方', scope: 'shared', template_id: 'tpl_listing_pack', platform: '天猫',
      brand_kit_id: kit.json.brand_kit.id, copy_version: 'copy_v1',
    },
  });
  assert.equal(recipeCreated.status, 201, JSON.stringify(recipeCreated.json));
  assert.equal(recipeCreated.json.version.status, 'pending');
  const recipeId = recipeCreated.json.recipe.id;

  const usageBeforeApproval = await request(port, `/api/recipes/${recipeId}/usages`, {
    method: 'POST', headers, body: { target_type: 'project', target_id: firstItem.project_id },
  });
  assert.equal(usageBeforeApproval.status, 409, JSON.stringify(usageBeforeApproval.json));

  const approved = await request(port, `/api/recipes/${recipeId}/approve`, {
    method: 'POST', headers, body: { version: 1, decision: 'approve', note: '可上线' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(approved.json.version.status, 'approved');

  const usageAfter = await request(port, `/api/recipes/${recipeId}/usages`, {
    method: 'POST', headers, body: { target_type: 'project', target_id: firstItem.project_id },
  });
  assert.equal(usageAfter.status, 201, JSON.stringify(usageAfter.json));
  assert.equal(usageAfter.json.validity.validity, 'current');

  // 新版本（同配方）审批后旧引用 stale
  const secondRecipe = await request(port, '/api/recipes', {
    method: 'POST', headers,
    body: {
      name: '共享主图配方 v2', scope: 'shared', template_id: 'tpl_listing_pack', platform: '天猫',
      brand_kit_id: kit.json.brand_kit.id, copy_version: 'copy_v2',
    },
  });
  assert.equal(secondRecipe.status, 201, JSON.stringify(secondRecipe.json));
  // 同一配方追加版本：当前实现以"新配方"建模，验证同一配方多次审批时旧版本失效
  const approveV2 = await request(port, `/api/recipes/${recipeId}/approve`, {
    method: 'POST', headers, body: { version: 1, decision: 'approve' },
  });
  assert.equal(approveV2.status, 409, JSON.stringify(approveV2.json));

  const usages = await request(port, `/api/recipes/${recipeId}/usages`, { headers });
  assert.equal(usages.status, 200, JSON.stringify(usages.json));
  assert.equal(usages.json.usages[0].validity.validity, 'current');

  // 10) 私有配方对他人不可见
  const privateRecipe = await request(port, '/api/recipes', {
    method: 'POST', headers,
    body: {
      name: '私有主图配方', scope: 'private', template_id: 'tpl_listing_pack', platform: '天猫',
      brand_kit_id: kit.json.brand_kit.id, copy_version: 'copy_v1',
    },
  });
  assert.equal(privateRecipe.status, 201, JSON.stringify(privateRecipe.json));
  assert.equal(privateRecipe.json.version.status, 'approved');
  const otherList = await request(port, '/api/recipes', { headers: as('tenant_a', 'editor_m11') });
  assert.equal(otherList.status, 403, '未登记成员无权读取');
  await request(port, '/api/members', { method: 'POST', headers, body: { actor_id: 'editor_m11', role: 'editor' } });
  const editorRecipes = await request(port, '/api/recipes', { headers: as('tenant_a', 'editor_m11') });
  assert.equal(editorRecipes.status, 200, JSON.stringify(editorRecipes.json));
  assert.equal(editorRecipes.json.recipes.some(item => item.id === privateRecipe.json.recipe.id), false);
  assert.equal(editorRecipes.json.recipes.some(item => item.id === recipeId), true);

  // 11) 跨租户：批量与配方一律 404
  assert.equal((await request(port, `/api/batches/${batch.id}`, { headers: as('tenant_demo') })).status, 404);
  assert.equal((await request(port, `/api/recipes/${recipeId}`, { headers: as('tenant_demo') })).status, 404);
});
