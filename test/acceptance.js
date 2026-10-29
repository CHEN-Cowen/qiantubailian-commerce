/**
 * E08 整体验收：两个租户、多个 SKU、旧/新事实、跨模块真实 HTTP 链路。
 *
 * 覆盖总提示词第 10 节中可自动化验证的核心场景：
 * 1. 建立商品与两个 SKU（属性/包含物），关联实拍，生成并导出完整包与按 SKU 导出；
 * 2. 商品事实变更走变更单：只改文字不扣费、其他选用版本不被波及、旧导出生成替换待办；
 * 3. 修一个 SKU 不影响另一个 SKU（档案版本推进后另一 SKU 属性不变）；
 * 4. SKU 核对：未配置 OCR 时视觉项保持未知（review），人工复核必须留依据且绑定版本；
 * 5. 售前问题：物流类正确分流、数量类给包装清单提纲、无频次不写高频；
 * 6. 说明图：确定性排版、复核依据必填、确认后可下载、采用反馈不承诺平台效果；
 * 7. 首页待办聚合：未知/失败/待复核/已采用分开，条目带真实入口与项目名；
 * 8. 重启恢复：同一 storeDir 重新启动后项目、版本、待办与额度仍在；
 * 9. 跨租户隔离：项目、问题、说明图、核对问题、导出下载一律 404。
 *
 * 图片 Provider 为确定性 fixture（capabilities.simulated=true），
 * 只验证流程、计价、权限与状态；真实模型效果、OCR、支付与平台同步未验收。
 *
 * 运行：node --test test/acceptance.js（Node 22.22.2）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/server.mjs';
import { createMockWechatPaymentProvider } from '../src/providers/wechat.mjs';
import { createFixtureProvider } from '../scripts/fixture-provider.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

const BASE_FACTS = [
  { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '瓶装数量', value: '1', unit: '瓶', critical: false, confirmed: true, source_type: 'user_input' },
];

function skuPayload({ sellingPoint = '舒缓维稳' } = {}) {
  return {
    confirm: true,
    skus: [
      {
        sku_code: 'ACC-01', label: '标准装', confirmed: true,
        attributes: [{ key: '容量', value: '50', unit: 'g' }, { key: '核心卖点', value: '舒缓维稳' }],
        contents: [{ item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' }],
      },
      {
        sku_code: 'ACC-02', label: '双支装', confirmed: true,
        attributes: [{ key: '容量', value: '100', unit: 'g' }, { key: '核心卖点', value: sellingPoint }],
        contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
      },
    ],
  };
}

function readZip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset = start + compressedSize;
  }
  return files;
}

async function sharpImage() {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#dde5dd' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 600, channels: 3, background: '#335577' } }).png().toBuffer(), left: 400, top: 300 }])
    .png().toBuffer();
}

function makeReq(port, state) {
  return async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(state.cookie ? { Cookie: state.cookie, 'x-csrf-token': state.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) state.cookie = setCookie.split(';')[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const json = contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null;
    if (json?.csrf_token) state.csrf = json.csrf_token;
    return { status: response.status, json, buffer, headers: response.headers };
  };
}

async function registerClient(port, { email, tenantName }) {
  const state = { cookie: '', csrf: '' };
  const req = makeReq(port, state);
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'Acceptance2026!', display_name: '验收', tenant_name: tenantName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return { req, state };
}

async function loginClient(port, state, email) {
  const req = makeReq(port, state);
  const logged = await req('/api/auth/login', { method: 'POST', body: { email, password: 'Acceptance2026!' } });
  assert.equal(logged.status, 200, JSON.stringify(logged.json));
  return req;
}

async function waitTerminal(req, runId, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    const run = (await req(`/api/runs/${runId}`)).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() - started > timeoutMs) throw new Error(`任务未进入终态，当前 ${run?.status}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function reviewToPublishable(req, reportId) {
  const report = (await req(`/api/quality-reports/${reportId}`)).json.report;
  if (!report || report.decision === 'publishable') return report;
  const decisions = (report.checks ?? [])
    .filter(item => item.required && item.status === 'unknown' && item.adjudicable)
    .map(item => ({ code: item.code, decision: 'pass', reason: '验收样本人工检查通过', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await req(`/api/quality-reports/${reportId}/reviews`, {
    method: 'POST', body: { decisions, note: '仅 fixture 验收，不证明真实模型效果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  return reviewed.json.report;
}

async function publishAllVersions(req, runId) {
  const versions = (await req(`/api/runs/${runId}/versions`)).json.versions;
  for (const item of versions.filter(version => version.current)) await reviewToPublishable(req, item.report_id);
}

async function balanceOf(req) {
  return (await req('/api/credits')).json.balance?.available ?? null;
}

test('E08 验收：两租户多 SKU 全链路（生成/导出/变更/核对/问题/说明图/待办/重启/隔离）', async t => {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e08-'));
  const boot = () => createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 0, tickMs: 5,
    attemptTimeoutMs: 30_000, provider: createFixtureProvider(),
    paymentProvider: createMockWechatPaymentProvider(),
  });
  let app = boot();
  t.after(async () => {
    await app.close().catch(() => {});
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  let port = (await app.listen()).port;

  const owner = await registerClient(port, { email: 'accept-a@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'accept-b@example.test', tenantName: '乙店' });
  const { req } = owner;

  // 体验额度 + 演示充值（Provider 声明 simulated，真实收款关闭）
  const order = await req('/api/billing/orders', { method: 'POST', body: { plan_id: 'plan_taster_10' } });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  assert.equal(order.json.order.real_money, false);
  const settled = await req(`/api/billing/orders/${order.json.order.id}/settle`, { method: 'POST' });
  assert.equal(settled.status, 200, JSON.stringify(settled.json));
  assert.equal(await balanceOf(req), 13);

  // 1. 商品 + 两个 SKU + 实拍 + 事实
  const created = await req('/api/projects', {
    method: 'POST', body: { name: 'E08 面霜', sku: 'ACC-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;
  const asset = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: await sharpImage(), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));
  const profileV1 = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: { base_version: 0, ...skuPayload() } });
  assert.equal(profileV1.status, 201, JSON.stringify(profileV1.json));

  // 修一个 SKU 不影响另一个：只改 ACC-02 卖点，ACC-01 属性保持原值
  const profileV2 = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT', body: { base_version: 1, ...skuPayload({ sellingPoint: '修护焕亮' }) },
  });
  assert.equal(profileV2.status, 201, JSON.stringify(profileV2.json));
  assert.equal(profileV2.json.sku_profile.version, 2);
  const skus = Object.fromEntries(profileV2.json.sku_profile.skus.map(item => [item.sku_code, item]));
  assert.equal(skus['ACC-01'].attributes.find(item => item.key === '核心卖点').value, '舒缓维稳');
  assert.equal(skus['ACC-02'].attributes.find(item => item.key === '核心卖点').value, '修护焕亮');
  const skuIds = Object.fromEntries(Object.entries(skus).map(([code, item]) => [code, item.id]));

  const truth = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST', body: { base_version: 0, confirm: true, facts: BASE_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  const kit = await req('/api/brand-kits', {
    method: 'POST',
    body: {
      name: 'E08 品牌套件', palette: { primary: '#2F6B4F', secondary: ['#F8FAFC'] }, logo: { present: false },
      fonts: [{ name: '思源黑体', license: 'licensed', license_ref: 'LIC-2026-01' }],
      tone: '克制、可信', banned_expressions: [],
    },
  });
  assert.equal(kit.status, 201, JSON.stringify(kit.json));
  const preview = await req(`/api/projects/${projectId}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id },
  });
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await req(`/api/projects/${projectId}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id, conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));

  // 2. 报价与首轮任务（3 张成品，预留 3 点）
  const quote = await req('/api/quotes', { method: 'POST', body: { project_id: projectId } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  assert.equal(quote.json.quote.estimated_credits, 3);
  const run = await req('/api/runs', {
    method: 'POST', body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
    headers: { 'Idempotency-Key': 'e08-main' },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  const runId = run.json.run.id;
  const finished = await waitTerminal(req, runId);
  assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 400));
  await publishAllVersions(req, runId);
  const deliverables = finished.deliverables.length;
  assert.ok(deliverables >= 3, `默认报价至少 3 个交付物，实际 ${deliverables}`);
  assert.equal(await balanceOf(req), 10, '3 张成品结算后 13 → 10');

  // 3. 完整导出 + 按 SKU 导出（路径按 sku_code 组织）
  const exported = await req(`/api/runs/${runId}/exports`, { method: 'POST', body: { scope: 'complete' } });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const download = await req(exported.json.export.download_url);
  assert.equal(download.status, 200);
  const zip = readZip(download.buffer);
  assert.ok(zip.has('manifest.json'), '完整包必须含 manifest.json');
  assert.ok([...zip.keys()].filter(name => /\.(png|jpg)$/i.test(name)).length >= 3, '完整包应含至少 3 张成品图');
  const skuExport = await req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: skuIds['ACC-01'] },
  });
  assert.equal(skuExport.status, 201, JSON.stringify(skuExport.json));
  assert.equal(skuExport.json.export.sku_code, 'ACC-01');
  assert.equal(skuExport.json.export.included.length, deliverables);
  assert.ok(skuExport.json.export.included.every(item => item.path.startsWith('images/ACC-01/')));

  // 4. E02/E07 人工依赖：系统编译不可删；人工关联必须写明依据
  const versions = (await req(`/api/runs/${runId}/versions`)).json.versions;
  const benefit = versions.find(item => item.current && item.deliverable_id === 'benefit');
  const deps = await req(`/api/runs/${runId}/deliverables/${benefit.deliverable_id}/dependencies`);
  assert.equal(deps.status, 200, JSON.stringify(deps.json));
  assert.ok(deps.json.versions.some(item => item.evidence === 'deterministic' && item.entries.length > 0), '系统应编译事实/素材依赖');
  const manual = await req(`/api/runs/${runId}/deliverables/${benefit.deliverable_id}/dependencies`, {
    method: 'POST', body: { version_id: benefit.id, reason: '卖点图人工确认沿用了瓶装数量', entries: [{ kind: 'fact', ref: '瓶装数量' }] },
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.json));
  const lockedRef = deps.json.versions.find(item => item.evidence === 'deterministic').entries[0];
  const locked = await req(`/api/runs/${runId}/deliverables/${benefit.deliverable_id}/dependencies/${encodeURIComponent(`${lockedRef.kind}:${lockedRef.ref}`)}?reason=误删测试`, { method: 'DELETE' });
  assert.equal(locked.status, 409, '系统编译依赖不可删除');
  assert.equal(locked.json.error, 'DEPENDENCY_LOCKED');

  // 5. 变更单：只改文字 → 0 额度、其他交付物不受影响；旧导出生成替换待办
  const NEW_FACTS = BASE_FACTS.map(item => item.key === '核心卖点' ? { ...item, value: '舒缓维稳 持久水润' } : item);
  const changePreview = await req(`/api/projects/${projectId}/changes/preview`, {
    method: 'POST', body: { facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(changePreview.status, 200, JSON.stringify(changePreview.json));
  assert.equal(changePreview.json.quote.estimated_credits, 0, '纯文字变更不得产生生图预算');
  assert.ok(changePreview.json.impact_items.length > 0);
  assert.ok(!changePreview.json.impact_items.some(item => item.action === 'regenerate'), '纯文字变更不得调用生图');
  const mainBefore = versions.find(item => item.current && item.deliverable_id === 'main');
  const change = await req(`/api/projects/${projectId}/changes`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e08-change' },
    body: { base_truth_version: 1, facts: NEW_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(change.status, 201, JSON.stringify(change.json));
  const balanceBeforeChange = await balanceOf(req);
  const executed = await req(`/api/changes/${change.json.change.id}/execute`, { method: 'POST', body: {} });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  assert.equal(await balanceOf(req), balanceBeforeChange, '文字重合成免费，不得扣费');
  const pendingVisual = executed.json.change.impact_items.filter(item => item.status === 'done' && item.visual_check === 'required');
  for (const item of pendingVisual) {
    const checked = await req(`/api/changes/${change.json.change.id}/items/${item.id}/visual-check`, {
      method: 'POST', body: { reason: '已核对画面与更新后事实一致' },
    });
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
  }
  const changeAfter = (await req(`/api/changes/${change.json.change.id}`)).json.change;
  assert.equal(changeAfter.status, 'completed', JSON.stringify(changeAfter.counts));
  const runAfterChange = (await req(`/api/runs/${runId}`)).json.run;
  assert.equal(runAfterChange.deliverables.find(item => item.deliverable_id === 'main').active_version_id,
    mainBefore.id, '只改文字不得波及其他交付物的选用版本');
  const todosReplace = await req(`/api/replacement-todos?project_id=${projectId}`);
  assert.ok(todosReplace.json.replacement_todos.length > 0, '旧导出应生成替换待办');
  const confirmedTodo = await req(`/api/replacement-todos/${todosReplace.json.replacement_todos[0].id}/confirm`, { method: 'POST', body: {} });
  assert.equal(confirmedTodo.status, 200, JSON.stringify(confirmedTodo.json));
  assert.equal(confirmedTodo.json.replacement_todo.status, 'replaced');
  assert.ok(!JSON.stringify(confirmedTodo.json).includes('published'), '替换确认不得伪造平台发布成功');

  // 6. SKU 核对：未配置 OCR 保持未知；人工复核必须留依据且绑定版本
  const checks = await req(`/api/projects/${projectId}/sku-checks`, { method: 'POST', body: {} });
  assert.equal(checks.status, 200, JSON.stringify(checks.json));
  assert.equal(checks.json.ocr_configured, false);
  assert.ok(checks.json.issues.length > 0);
  // 未配置 OCR：视觉项保持未知；卖点事实与旧 SKU 属性不一致会如实开立结构问题，不伪装通过
  assert.ok(checks.json.issues.some(item => item.code === 'VISUAL_UNAVAILABLE' && item.severity === 'review'));
  assert.ok(checks.json.issues.every(item => ['review', 'blocker'].includes(item.severity) && item.status === 'open'));
  const issue = checks.json.issues.find(item => item.severity === 'review');
  const noReason = await req(`/api/check-issues/${issue.id}/resolve`, { method: 'POST', body: { action: 'confirm' } });
  assert.equal(noReason.status, 422);
  const resolved = await req(`/api/check-issues/${issue.id}/resolve`, {
    method: 'POST', body: { action: 'confirm', reason: '已人工核对画面与编号一致' },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.issue.resolution.version_id, issue.version_id, '复核绑定具体版本');

  // 7. 售前问题：物流分流、数量提纲、无频次不写高频
  const shipping = await req(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e08-q-ship' }, body: { text: '什么时候发货，快递几天到' },
  });
  assert.equal(shipping.status, 201, JSON.stringify(shipping.json));
  assert.equal(shipping.json.group.result, 'out_of_scope');
  assert.equal(shipping.json.group.category_final, 'logistics');
  assert.equal(shipping.json.group.frequency_label, '输入的问题（未提供频次）');
  assert.ok(!shipping.json.group.frequency_label.includes('高频'));
  const quantity = await req(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e08-q-count' },
    body: { text: '收到之后有几个，配件包含哪些', sku_id: skuIds['ACC-01'] },
  });
  assert.equal(quantity.status, 201, JSON.stringify(quantity.json));
  assert.equal(quantity.json.group.result, 'needs_explainer');
  assert.equal(quantity.json.group.detail.explainer_kind, 'packing_list');
  const confirmedQuestion = await req(`/api/question-groups/${quantity.json.group.id}/review`, {
    method: 'POST', body: { action: 'confirm' },
  });
  assert.equal(confirmedQuestion.status, 200, JSON.stringify(confirmedQuestion.json));
  assert.equal(confirmedQuestion.json.group.status, 'confirmed');

  // 8. 说明图：确定性排版、复核依据必填、下载哈希一致
  const explainer = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e08-explainer' },
    body: { kind: 'packing_list', sku_id: skuIds['ACC-01'] },
  });
  assert.equal(explainer.status, 201, JSON.stringify(explainer.json));
  assert.equal(explainer.json.explainer.status, 'awaiting_review');
  assert.equal(explainer.json.explainer.active_version.width, 1080);
  const explainerNoReason = await req(`/api/explainers/${explainer.json.explainer.id}/review`, {
    method: 'POST', body: { action: 'confirm' },
  });
  assert.equal(explainerNoReason.status, 422);
  const explainerConfirmed = await req(`/api/explainers/${explainer.json.explainer.id}/review`, {
    method: 'POST', body: { action: 'confirm', reason: '逐项核对数量与单位一致' },
  });
  assert.equal(explainerConfirmed.status, 200, JSON.stringify(explainerConfirmed.json));
  const content = await req(`/api/explainers/${explainer.json.explainer.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('x-content-sha256'), explainer.json.explainer.active_version.hash);

  // 9. 首页待办：四组分开、条目带真实入口
  const todos = await req('/api/todos');
  assert.equal(todos.status, 200, JSON.stringify(todos.json));
  assert.deepEqual(todos.json.groups.map(group => group.key), ['unknown', 'failed', 'awaiting_review', 'adopted']);
  // 未解决的 blocker（卖点事实与 SKU 档案不一致）必须留在失败组，不能混进已采用
  assert.ok(todos.json.summary.failed >= 1, `未解决 blocker 应进入失败组，实际 ${JSON.stringify(todos.json.summary)}`);
  assert.ok(todos.json.groups.find(group => group.key === 'failed').items.some(item => item.kind === 'check'));
  assert.ok(todos.json.summary.adopted >= 3, `已采用应含说明图/问题/替换待办，实际 ${JSON.stringify(todos.json.summary)}`);
  assert.ok(todos.json.summary.unknown >= 1, '未配置 OCR 的视觉未知项应留在未知组');
  for (const group of todos.json.groups) {
    for (const item of group.items) {
      assert.ok(['truth', 'workbench'].includes(item.action), JSON.stringify(item));
      assert.ok(item.project_id && item.project_name && item.title);
    }
  }
  const adoptedKinds = new Set(todos.json.groups.find(group => group.key === 'adopted').items.map(item => item.kind));
  assert.ok(adoptedKinds.has('question') && adoptedKinds.has('explainer') && adoptedKinds.has('replacement'));

  // 10. 重启恢复：同一 storeDir 重新启动后数据与待办仍在
  await app.close();
  app = boot();
  port = (await app.listen()).port;
  const reqAfter = await loginClient(port, owner.state, 'accept-a@example.test');
  const projectAfter = await reqAfter(`/api/projects/${projectId}`);
  assert.equal(projectAfter.status, 200, JSON.stringify(projectAfter.json));
  assert.equal(projectAfter.json.project.name, 'E08 面霜');
  const headAfter = await reqAfter(`/api/projects/${projectId}/truth-versions`);
  assert.equal(headAfter.json.head_version, 2, '变更后的新事实版本必须持久化');
  assert.equal(await balanceOf(reqAfter), balanceBeforeChange, '额度账本不得因重启丢失');
  const todosAfter = await reqAfter('/api/todos');
  assert.deepEqual(todosAfter.json.summary, todos.json.summary, '重启后待办分组计数不变');

  // 11. 跨租户隔离：猜测 ID 一律 404，乙方待办为空
  const other = await loginClient(port, outsider.state, 'accept-b@example.test');
  assert.equal((await other(`/api/projects/${projectId}`)).status, 404);
  assert.equal((await other(`/api/runs/${runId}`)).status, 404);
  assert.equal((await other(`/api/projects/${projectId}/question-groups`)).status, 404);
  assert.equal((await other(`/api/explainers/${explainer.json.explainer.id}`)).status, 404);
  assert.equal((await other(`/api/check-issues/${issue.id}`)).status, 404);
  assert.equal((await other(`/api/exports/${skuExport.json.export.id}/download`)).status, 404);
  assert.equal((await other(`/api/projects/${projectId}/sku-checks`, { method: 'POST', body: {} })).status, 404);
  const otherTodos = await other('/api/todos');
  assert.equal(otherTodos.status, 200);
  assert.equal(otherTodos.json.summary.total, 0);
  assert.equal(await balanceOf(other), 3, '他人项目不得消耗当前租户额度');

  // 12. 外部服务边界：Provider 声明为模拟，不得冒充真实模型
  const capabilities = (await reqAfter('/api/provider/capabilities')).json;
  assert.equal(capabilities.capabilities.simulated, true);
  assert.equal(capabilities.acceptance, 'simulated_only');
  assert.equal(createHash('sha256').update(content.buffer).digest('hex'), explainer.json.explainer.active_version.hash,
    '说明图下载内容必须与登记哈希一致');
});
