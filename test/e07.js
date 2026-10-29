/**
 * E07 测试：跨模块待办聚合（首页「检查与更新」的数据源）。
 *
 * 覆盖：
 * 1. 空工作区：四组都存在且为空，限制与额度字段如实返回；
 * 2. 未知 / 待复核 / 已采用分开：售前问题 open → unknown，确认后 → adopted；
 *    说明图创建 → awaiting_review，复核通过 → adopted；
 * 3. 每条待办都带真实入口（action=truth/workbench + section）与项目名；
 * 4. 跨租户隔离：乙店看不到甲店的任何待办；
 * 5. 服务限制（并发/规模/修订轮数）与额度摘要来自服务配置，不是前端写死。
 *
 * 运行：node --test test/e07.js（Node 22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

async function setup(t) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e07-'));
  const app = createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 0,
    tickMs: 5, attemptTimeoutMs: 30_000,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

async function registerClient(port, { email, tenantName }) {
  let cookie = '';
  let csrf = '';
  const req = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie, 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const json = contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null;
    if (json?.csrf_token) csrf = json.csrf_token;
    return { status: response.status, json, buffer, contentType, headers: response.headers };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'E07Account2026!', display_name: 'E07', tenant_name: tenantName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return { req };
}

async function sharpImage(width = 1200, height = 1200) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#dde5dd' } })
    .composite([{ input: await sharp({ create: { width: 360, height: 540, channels: 3, background: '#335577' } }).png().toBuffer(), left: 420, top: 330 }])
    .png().toBuffer();
}

/** 建项目 → 主体素材 → SKU 档案 → 确认事实（说明图与待办都需要真实来源）。 */
async function createProject(req) {
  const created = await req('/api/projects', {
    method: 'POST',
    body: { name: 'E07 面霜', sku: 'E07-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;
  const subject = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: await sharpImage(), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(subject.status, 201, JSON.stringify(subject.json));
  const profile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT',
    body: {
      base_version: 0,
      confirm: true,
      skus: [{
        sku_code: 'E07-01', label: '标准装', confirmed: true,
        attributes: [
          { key: '容量', value: '50', unit: 'g' },
          { key: '长', value: '30', unit: 'cm' },
          { key: '宽', value: '20', unit: 'cm' },
          { key: '高', value: '10', unit: 'cm' },
        ],
        contents: [{ item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' }],
      }],
    },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.json));
  const skuId = profile.json.sku_profile.skus[0].id;
  const truth = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: {
      base_version: 0, confirm: true, critical_text: [{ text: '月光舒缓' }],
      facts: [
        { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '长', value: '30', unit: 'cm', critical: false, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  return { projectId, skuId };
}

const groupsOf = payload => Object.fromEntries(payload.groups.map(group => [group.key, group]));

test('E07 集成：待办按未知/失败/待复核/已采用分开，并返回真实入口与服务限制', async (t) => {
  const { port } = await setup(t);
  const owner = await registerClient(port, { email: 'e07-a@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'e07-b@example.test', tenantName: '乙店' });
  const { req } = owner;
  const { projectId, skuId } = await createProject(req);

  // 1. 空工作区：四组都存在且为空；限制与额度来自服务配置
  const empty = await req('/api/todos');
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.deepEqual(empty.json.groups.map(group => group.key), ['unknown', 'failed', 'awaiting_review', 'adopted']);
  assert.equal(empty.json.summary.total, 0);
  for (const group of empty.json.groups) assert.equal(group.items.length, 0);
  assert.equal(empty.json.limits.max_assets_per_project, 6);
  assert.equal(empty.json.limits.worker_concurrency, 2);
  assert.equal(empty.json.limits.tenant_concurrency, 2);
  assert.match(empty.json.limits.note, /重试只处理未成功项/);
  assert.ok(Number.isInteger(empty.json.budget.available), '额度必须来自服务端账本');

  // 2. 售前问题：open → unknown；确认后 → adopted（不再算待复核）
  const question = await req(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e07-q-1' },
    body: { text: '这个瓶子有多大' },
  });
  assert.equal(question.status, 201, JSON.stringify(question.json));
  const questionId = question.json.group.id;

  let todos = await req('/api/todos');
  let groups = groupsOf(todos.json);
  assert.equal(groups.unknown.total, 1, '未确认的售前问题属于未知，不是待复核');
  const questionItem = groups.unknown.items[0];
  assert.equal(questionItem.kind, 'question');
  assert.equal(questionItem.project_id, projectId);
  assert.equal(questionItem.project_name, 'E07 面霜');
  assert.equal(questionItem.action, 'truth');
  assert.equal(questionItem.section, 'question-section');

  const confirmedQuestion = await req(`/api/question-groups/${questionId}/review`, {
    method: 'POST', body: { action: 'confirm' },
  });
  assert.equal(confirmedQuestion.status, 200, JSON.stringify(confirmedQuestion.json));
  groups = groupsOf((await req('/api/todos')).json);
  assert.equal(groups.unknown.total, 0);
  assert.equal(groups.adopted.total, 1);
  assert.equal(groups.adopted.items[0].kind, 'question');

  // 3. 说明图：创建后待复核；复核通过后进入已采用
  const explainer = await req(`/api/projects/${projectId}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'e07-ex-1' },
    body: { kind: 'packing_list', sku_id: skuId },
  });
  assert.equal(explainer.status, 201, JSON.stringify(explainer.json));
  const explainerId = explainer.json.explainer.id;

  groups = groupsOf((await req('/api/todos')).json);
  assert.equal(groups.awaiting_review.total, 1);
  const explainerItem = groups.awaiting_review.items[0];
  assert.equal(explainerItem.kind, 'explainer');
  assert.equal(explainerItem.section, 'explainer-section');
  assert.match(explainerItem.title, /说明图待复核/);

  const reviewed = await req(`/api/explainers/${explainerId}/review`, {
    method: 'POST', body: { action: 'confirm', reason: '逐项核对数量与单位一致' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  groups = groupsOf((await req('/api/todos')).json);
  assert.equal(groups.awaiting_review.total, 0, '复核通过后不应继续占待复核');
  assert.equal(groups.adopted.total, 2, '已采用的分开统计（售前问题 + 说明图）');
  assert.ok(groups.adopted.items.some(item => item.kind === 'explainer'));

  // 4. 每条待办都有真实入口，不允许出现空按钮
  const all = (await req('/api/todos')).json;
  for (const group of all.groups) {
    for (const item of group.items) {
      assert.ok(['truth', 'workbench'].includes(item.action), `待办缺少真实入口：${JSON.stringify(item)}`);
      assert.ok(item.project_id && item.project_name);
      assert.equal(typeof item.title, 'string');
    }
  }

  // 5. 跨租户隔离：乙店看不到甲店的任何待办
  const foreign = await outsider.req('/api/todos');
  assert.equal(foreign.status, 200);
  assert.equal(foreign.json.summary.total, 0);
  assert.ok(foreign.json.groups.every(group => group.items.length === 0));
});
