/**
 * E01 测试：共用商品 SKU 与包装包含物档案服务。
 *
 * 覆盖：
 * 1. 纯函数：合法输入通过；sku_code 大小写不敏感重复 422；差异属性留空值 422；
 *    未知单位 422 UNKNOWN_UNIT；单位换算与归一（500ml≡0.5L、1kg≡1000g、个/件归一、ml≠g）；
 *    source=asset 指向风格图或已替换素材 422；diffSkuProfiles 逐 SKU 字段级差异。
 * 2. HTTP 集成：建档 → 查询 → 编辑（正确 base_version）→ 版本历史与单版本读取；
 *    base_version 过期 409 VERSION_CONFLICT；confirm 但未全 confirmed 409 CONFIRMATION_BLOCKED；
 *    两个租户互相读/写对方项目 404；无档案项目返回 derived 简化视图。
 * 3. 兼容旧数据：data.json 缺少 sku_profiles 表时读取正常（按空表迁移）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import {
  diffSkuProfiles, normalizeQuantity, simplifiedSkuView, unitsEquivalent, validateSkuProfilesInput,
} from '../src/sku.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 纯函数 ----------

const PROJECT = { id: 'proj_pure', sku: 'DEMO-01', name: '演示商品' };
const ACTIVE_ASSET = { id: 'asset_active', project_id: 'proj_pure', role: 'packaging', role_status: 'active' };

function validBody(overrides = {}) {
  return {
    base_version: 0,
    confirm: true,
    skus: [{
      sku_code: 'RED-500',
      label: '红色 500ml',
      attributes: [{ key: '颜色', value: '红色' }, { key: '容量', value: '500', unit: 'ml' }],
      contents: [
        { item: '瓶子', quantity: 1, unit: '个', included: true, source: 'user_input' },
        { item: '展示用干花', quantity: 2, unit: '支', included: false, source: 'asset', source_asset_id: 'asset_active', note: '拍照道具' },
      ],
      confirmed: true,
    }],
    ...overrides,
  };
}

test('E01 纯函数：合法输入通过并归一化单位与别名', () => {
  const payload = validateSkuProfilesInput(validBody(), { project: PROJECT, assets: [ACTIVE_ASSET] });
  assert.equal(payload.base_version, 0);
  assert.equal(payload.confirm, true);
  assert.equal(payload.skus.length, 1);
  const [sku] = payload.skus;
  assert.equal(sku.sku_code, 'RED-500');
  assert.equal(sku.contents[0].unit, '件'); // 「个」归一为「件」
  assert.equal(sku.contents[1].source_asset_id, 'asset_active');
});

test('E01 纯函数：sku_code 同项目内大小写不敏感重复 422', () => {
  const body = validBody({
    skus: [
      { sku_code: 'RED-500', label: '甲', confirmed: true },
      { sku_code: 'red-500', label: '乙', confirmed: true },
    ],
  });
  assert.throws(
    () => validateSkuProfilesInput(body, { project: PROJECT }),
    error => error.status === 422 && error.code === 'INVALID_FIELD',
  );
});

test('E01 纯函数：差异属性 value 留空 422（禁止留空冒充未知）', () => {
  const body = validBody();
  body.skus[0].attributes = [{ key: '材质', value: '  ' }];
  assert.throws(
    () => validateSkuProfilesInput(body, { project: PROJECT }),
    error => error.status === 422 && error.code === 'INVALID_FIELD',
  );
});

test('E01 纯函数：未知单位 422 UNKNOWN_UNIT，缺失单位 422', () => {
  const unknown = validBody();
  unknown.skus[0].contents = [{ item: '瓶子', quantity: 1, unit: '打', included: true, source: 'user_input' }];
  assert.throws(
    () => validateSkuProfilesInput(unknown, { project: PROJECT }),
    error => error.status === 422 && error.code === 'UNKNOWN_UNIT',
  );
  const missing = validBody();
  missing.skus[0].contents = [{ item: '瓶子', quantity: 1, included: true, source: 'user_input' }];
  assert.throws(
    () => validateSkuProfilesInput(missing, { project: PROJECT }),
    error => error.status === 422 && error.code === 'INVALID_FIELD',
  );
});

test('E01 纯函数：单位换算与等价规则（显式表，不靠模型判断）', () => {
  assert.deepEqual(normalizeQuantity(500, 'ml'), normalizeQuantity(0.5, 'L'));
  assert.deepEqual(normalizeQuantity(1, 'kg'), normalizeQuantity(1000, 'g'));
  assert.deepEqual(normalizeQuantity(2, '个'), normalizeQuantity(2, '件'));
  assert.equal(unitsEquivalent('ml', 'L'), true);
  assert.equal(unitsEquivalent('个', '件'), true);
  assert.equal(unitsEquivalent('ml', 'g'), false);
  assert.equal(unitsEquivalent('包', '盒'), false); // 计数单位之间不换算
  assert.equal(unitsEquivalent({ quantity: 500, unit: 'ml' }, { quantity: 0.5, unit: 'L' }), true);
  assert.equal(unitsEquivalent({ quantity: 500, unit: 'ml' }, { quantity: 0.6, unit: 'L' }), false);
});

test('E01 纯函数：source=asset 指向风格图或已替换素材 422', () => {
  const styleAsset = { id: 'asset_style', project_id: 'proj_pure', role: 'style', role_status: 'active' };
  const superseded = { id: 'asset_old', project_id: 'proj_pure', role: 'subject', role_status: 'superseded' };
  for (const asset of [styleAsset, superseded]) {
    const body = validBody();
    body.skus[0].contents = [{ item: '瓶子', quantity: 1, unit: '件', included: true, source: 'asset', source_asset_id: asset.id }];
    assert.throws(
      () => validateSkuProfilesInput(body, { project: PROJECT, assets: [asset] }),
      error => error.status === 422 && error.code === 'INVALID_FIELD',
    );
  }
  // 指向其他项目的素材同样拒绝
  const foreign = { id: 'asset_foreign', project_id: 'proj_other', role: 'subject', role_status: 'active' };
  const body = validBody();
  body.skus[0].contents = [{ item: '瓶子', quantity: 1, unit: '件', included: true, source: 'asset', source_asset_id: foreign.id }];
  assert.throws(
    () => validateSkuProfilesInput(body, { project: PROJECT, assets: [ACTIVE_ASSET] }),
    error => error.status === 422,
  );
});

test('E01 纯函数：diffSkuProfiles 给出逐 SKU 新增/删除/字段级差异', () => {
  const before = [
    { id: 'sku_a', sku_code: 'A', label: '甲', attributes: [{ key: '颜色', value: '红' }], contents: [], confirmed: true },
    { id: 'sku_b', sku_code: 'B', label: '乙', attributes: [], contents: [], confirmed: true },
  ];
  const after = [
    { id: 'sku_a', sku_code: 'A', label: '甲改', attributes: [{ key: '颜色', value: '蓝' }], contents: [], confirmed: true },
    { id: 'sku_c', sku_code: 'C', label: '丙', attributes: [], contents: [], confirmed: false },
  ];
  const diff = diffSkuProfiles(before, after);
  const changed = diff.find(item => item.change === 'changed');
  assert.equal(changed.sku_id, 'sku_a');
  assert.deepEqual(changed.fields.label, { from: '甲', to: '甲改' });
  assert.equal(changed.fields.attributes.from[0].value, '红');
  assert.equal(diff.find(item => item.change === 'added').sku_id, 'sku_c');
  assert.equal(diff.find(item => item.change === 'removed').sku_id, 'sku_b');
});

test('E01 纯函数：无档案项目返回 derived 简化视图，不伪造确认', () => {
  const view = simplifiedSkuView({ sku: 'SOLO-01', name: '单品' });
  assert.equal(view.derived, true);
  assert.equal(view.skus.length, 1);
  assert.equal(view.skus[0].sku_code, 'SOLO-01');
  assert.equal(view.skus[0].derived, true);
  assert.equal(view.skus[0].confirmed, false);
});

// ---------- HTTP 集成 ----------

async function setup(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e01-'));
  const app = createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 0,
    tickMs: 5, attemptTimeoutMs: 30_000, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

/** 每个账户独立的会话客户端（Cookie + CSRF 各自持有）。 */
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
    return { status: response.status, json };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'E01Account2026!', display_name: 'E01', tenant_name: tenantName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return { req };
}

async function createProject(req, name = 'E01 面霜', sku = 'E01-01') {
  const created = await req('/api/projects', {
    method: 'POST',
    body: { name, sku, category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.project.id;
}

const skuBody = (baseVersion, { confirm = true, confirmed = true } = {}) => ({
  base_version: baseVersion,
  confirm,
  skus: [
    {
      sku_code: 'CRM-50', label: '标准装 50g', confirmed,
      attributes: [{ key: '规格', value: '50', unit: 'g' }],
      contents: [
        { item: '面霜瓶', quantity: 1, unit: '瓶', included: true, source: 'user_input' },
        { item: '说明书', quantity: 1, unit: '张', included: true, source: 'user_input', note: '' },
      ],
    },
    { sku_code: 'CRM-50X2', label: '两件装', confirmed, attributes: [], contents: [
      { item: '面霜瓶', quantity: 2, unit: '瓶', included: true, source: 'user_input' },
    ] },
  ],
});

test('E01 HTTP：建档 → 查询 → 编辑 → 版本历史，乐观锁与确认闸口生效', async (t) => {
  const { port } = await setup(t);
  const { req } = await registerClient(port, { email: 'e01-a@example.test', tenantName: '甲店' });
  const projectId = await createProject(req);

  // 无档案：derived 简化视图 + profile 为 null
  const empty = await req(`/api/projects/${projectId}/skus`);
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.equal(empty.json.profile, null);
  assert.equal(empty.json.head_version, 0);
  assert.equal(empty.json.view.derived, true);
  assert.equal(empty.json.view.skus[0].sku_code, 'E01-01');
  assert.equal(empty.json.view.skus[0].confirmed, false);

  // confirm 但存在未确认 SKU → 409
  const blocked = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: skuBody(0, { confirmed: false }) });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'CONFIRMATION_BLOCKED');

  // 正常建档 → 201，版本 1
  const created = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: skuBody(0) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const v1 = created.json.sku_profile;
  assert.equal(v1.version, 1);
  assert.equal(v1.confirmation_status, 'confirmed');
  assert.equal(v1.skus.length, 2);
  assert.ok(v1.skus.every(sku => sku.id && sku.confirmed_by && sku.confirmed_at));
  assert.match(v1.content_hash, /^[0-9a-f]{64}$/);

  // 查询当前档案
  const current = await req(`/api/projects/${projectId}/skus`);
  assert.equal(current.json.head_version, 1);
  assert.equal(current.json.view, null);
  assert.equal(current.json.profile.id, v1.id);

  // 过期 base_version → 409
  const stale = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: skuBody(0) });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'VERSION_CONFLICT');
  assert.equal(stale.json.details.current_version, 1);

  // 基于最新版本编辑（沿用稳定内部 ID）→ 版本 2 草稿
  const editBody = skuBody(1, { confirm: false });
  editBody.skus[0].id = v1.skus[0].id;
  editBody.skus[0].attributes = [{ key: '规格', value: '60', unit: 'g' }];
  editBody.skus[1].id = v1.skus[1].id;
  const edited = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: editBody });
  assert.equal(edited.status, 201, JSON.stringify(edited.json));
  assert.equal(edited.json.sku_profile.version, 2);
  assert.equal(edited.json.sku_profile.confirmation_status, 'draft');
  assert.equal(edited.json.sku_profile.skus[0].id, v1.skus[0].id);

  // 版本历史与单版本读取
  const versions = await req(`/api/projects/${projectId}/skus/versions`);
  assert.equal(versions.status, 200);
  assert.equal(versions.json.head_version, 2);
  assert.deepEqual(versions.json.versions.map(item => item.version), [1, 2]);
  const one = await req(`/api/projects/${projectId}/skus/versions/1`);
  assert.equal(one.status, 200);
  assert.equal(one.json.sku_profile.skus[0].attributes[0].value, '50');
  const missing = await req(`/api/projects/${projectId}/skus/versions/9`);
  assert.equal(missing.status, 404);
});

test('E01 HTTP：跨租户读/写对方项目 SKU 档案一律 404', async (t) => {
  const { port } = await setup(t);
  const owner = await registerClient(port, { email: 'e01-owner@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'e01-outsider@example.test', tenantName: '乙店' });
  const projectId = await createProject(owner.req);
  const created = await owner.req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: skuBody(0) });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  for (const route of [
    `/api/projects/${projectId}/skus`,
    `/api/projects/${projectId}/skus/versions`,
    `/api/projects/${projectId}/skus/versions/1`,
  ]) {
    const result = await outsider.req(route);
    assert.equal(result.status, 404, route);
  }
  const write = await outsider.req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: skuBody(0) });
  assert.equal(write.status, 404);
});

test('E01 HTTP：source=asset 经接口校验（风格图 422），单位未知 422', async (t) => {
  const { port } = await setup(t);
  const { req } = await registerClient(port, { email: 'e01-asset@example.test', tenantName: '丙店' });
  const projectId = await createProject(req);

  // 上传一张风格素材（来源不合法）与一张主体素材（合法来源）
  const sharp = (await import('sharp')).default;
  const image = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#889977' } }).png().toBuffer();
  const style = await req(`/api/projects/${projectId}/assets?role=style&filename=style.png`, {
    method: 'POST', body: image, headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(style.status, 201, JSON.stringify(style.json));
  const subject = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: image, headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(subject.status, 201, JSON.stringify(subject.json));

  const withAsset = (assetId) => {
    const body = skuBody(0);
    body.skus = [body.skus[0]];
    body.skus[0].contents = [{ item: '面霜瓶', quantity: 1, unit: '瓶', included: true, source: 'asset', source_asset_id: assetId }];
    return body;
  };
  const badStyle = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: withAsset(style.json.asset.id) });
  assert.equal(badStyle.status, 422);
  assert.equal(badStyle.json.error, 'INVALID_FIELD');

  const badUnit = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: (() => {
    const body = skuBody(0);
    body.skus[0].contents[0].unit = '打';
    return body;
  })() });
  assert.equal(badUnit.status, 422);
  assert.equal(badUnit.json.error, 'UNKNOWN_UNIT');

  const ok = await req(`/api/projects/${projectId}/skus`, { method: 'PUT', body: withAsset(subject.json.asset.id) });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.sku_profile.skus[0].contents[0].source_asset_id, subject.json.asset.id);
});

test('E01 兼容旧数据：data.json 缺少 sku_profiles 表时读取正常', async (t) => {
  const { port, dir, app } = await setup(t);
  const { req } = await registerClient(port, { email: 'e01-legacy@example.test', tenantName: '丁店' });
  const projectId = await createProject(req);
  await app.close();

  // 模拟旧版本数据文件：删除 sku_profiles 表
  const raw = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
  delete raw.sku_profiles;
  await writeFile(path.join(dir, 'data.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const app2 = createApp({ port: 0, storeDir: dir, demoMode: false, initialCredits: 0, tickMs: 5, attemptTimeoutMs: 30_000 });
  t.after(async () => { await app2.close(); });
  const { port: port2 } = await app2.listen();
  // 重新登录获取会话
  let cookie = '';
  let csrf = '';
  const login = await fetch(`http://127.0.0.1:${port2}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'e01-legacy@example.test', password: 'E01Account2026!' }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await login.json()).csrf_token;
  const result = await fetch(`http://127.0.0.1:${port2}/api/projects/${projectId}/skus`, { headers: { Cookie: cookie, 'x-csrf-token': csrf } });
  assert.equal(result.status, 200);
  const payload = await result.json();
  assert.equal(payload.profile, null);
  assert.equal(payload.view.derived, true);
  assert.equal(payload.view.skus[0].sku_code, 'E01-01');
});
