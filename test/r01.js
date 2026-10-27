import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { loadAuthConfig } from '../src/config.mjs';

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: {
        ...(payload ? { 'Content-Length': payload.length, 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
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

async function running(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'r01-'));
  const app = createApp({ port: 0, storeDir: dir, demoMode: false, ...options });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const address = await app.listen();
  return { app, port: address.port, dir };
}

function cookieOf(response) {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const value = list.find(item => item.startsWith('qtb_session=')) ?? '';
  const match = /qtb_session=([^;]*)/.exec(value);
  return { header: value, token: match ? match[1] : '' };
}

async function register(port, { email, password = 'correct horse battery', displayName = '店主', tenantName = '我的小店' }) {
  const response = await request(port, '/api/auth/register', {
    method: 'POST',
    body: { email, password, display_name: displayName, tenant_name: tenantName },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const cookie = cookieOf(response);
  return { response, cookie, csrf: response.json.csrf_token, account: response.json.account, tenant: response.json.tenant };
}

async function login(port, { email, password = 'correct horse battery' }) {
  const response = await request(port, '/api/auth/login', { method: 'POST', body: { email, password } });
  return { response, cookie: cookieOf(response), csrf: response.json?.csrf_token ?? '' };
}

const authHeaders = (session, extra = {}) => ({
  Cookie: `qtb_session=${session.cookie.token}`,
  'X-CSRF-Token': session.csrf,
  ...extra,
});

test('R01 生产模式默认拒绝未认证访问，且演示头不能自授权', async t => {
  const { port } = await running(t);
  for (const route of ['/api/projects', '/api/credits', '/api/quotes', '/api/runs', '/api/exports', '/api/plans']) {
    const response = await request(port, route);
    assert.equal(response.status, 401, route);
    assert.equal(response.json.error, 'UNAUTHENTICATED', route);
  }
  // 伪造身份头在认证模式下无效
  const spoofed = await request(port, '/api/projects', {
    headers: { 'x-tenant-id': 'tenant_demo', 'x-actor-id': 'attacker' },
  });
  assert.equal(spoofed.status, 401);
  const config = await request(port, '/api/auth/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.demo_mode, false);
  assert.equal(config.json.email_recovery, false);
  const session = await request(port, '/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.json.authenticated, false);
  assert.equal(session.json.demo_identity, null);
  const reset = await request(port, '/api/auth/password-reset', { method: 'POST', body: { email: 'a@b.co' } });
  assert.equal(reset.status, 503);
  assert.equal(reset.json.error, 'EMAIL_SERVICE_NOT_CONFIGURED');
});

test('R01 注册、登录、会话与 CSRF 闸口', async t => {
  const { port, dir } = await running(t);
  const owner = await register(port, { email: 'owner@example.com' });
  assert.match(owner.cookie.header, /HttpOnly/);
  assert.match(owner.cookie.header, /SameSite=Lax/);
  assert.ok(owner.csrf.length >= 20);

  // 会话令牌只以哈希落盘
  const raw = await readFile(path.join(dir, 'data.json'), 'utf8');
  assert.equal(raw.includes(owner.cookie.token), false, '会话令牌不得明文落盘');

  const me = await request(port, '/api/auth/session', { headers: { Cookie: `qtb_session=${owner.cookie.token}` } });
  assert.equal(me.status, 200);
  assert.equal(me.json.authenticated, true);
  assert.equal(me.json.role, 'owner');
  assert.equal(me.json.account.email, 'owner@example.com');
  assert.equal(me.json.tenant.id, owner.tenant.id);
  assert.ok(me.json.permissions.includes('project:create'));

  // 伪造 actor 头不会改变可信身份
  const tenant = await request(port, '/api/tenant', {
    headers: { Cookie: `qtb_session=${owner.cookie.token}`, 'x-actor-id': 'someone_else' },
  });
  assert.equal(tenant.status, 200);
  assert.equal(tenant.json.actor_id, owner.account.id);
  assert.equal(tenant.json.authenticated, true);
  assert.equal(tenant.json.mode, 'session');

  // 状态变更缺少 CSRF 一律拒绝
  const noCsrf = await request(port, '/api/projects', {
    method: 'POST',
    headers: { Cookie: `qtb_session=${owner.cookie.token}` },
    body: { name: '香薰蜡烛', sku: 'CANDLE-001', category: '家居', platform: '淘宝' },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error, 'CSRF_REQUIRED');

  const badCsrf = await request(port, '/api/projects', {
    method: 'POST',
    headers: { Cookie: `qtb_session=${owner.cookie.token}`, 'X-CSRF-Token': 'wrong' },
    body: { name: '香薰蜡烛', sku: 'CANDLE-001', category: '家居', platform: '淘宝' },
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(badCsrf.json.error, 'CSRF_INVALID');

  const created = await request(port, '/api/projects', {
    method: 'POST',
    headers: authHeaders(owner),
    body: { name: '香薰蜡烛', sku: 'CANDLE-001', category: '家居', platform: '淘宝' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const list = await request(port, '/api/projects', { headers: authHeaders(owner) });
  assert.equal(list.status, 200);
  assert.equal(list.json.projects.length, 1);
  assert.equal(list.json.projects[0].id, created.json.project.id);

  // 切换到不属于自己的租户直接拒绝
  const forbiddenTenant = await request(port, '/api/projects', {
    headers: authHeaders(owner, { 'x-tenant-id': 'tenant_other' }),
  });
  assert.equal(forbiddenTenant.status, 403);
  assert.equal(forbiddenTenant.json.error, 'TENANT_FORBIDDEN');
});

test('R01 跨账户隔离、viewer 边界与最后 owner 保护', async t => {
  const { port } = await running(t);
  const owner = await register(port, { email: 'a-owner@example.com' });
  const viewer = await register(port, { email: 'b-viewer@example.com', tenantName: '另一个店' });
  const outsider = await register(port, { email: 'c-outsider@example.com', tenantName: '路人店' });

  const project = await request(port, '/api/projects', {
    method: 'POST', headers: authHeaders(owner),
    body: { name: '手工皂', sku: 'SOAP-001', category: '美妆', platform: '抖音' },
  });
  assert.equal(project.status, 201);

  // 非成员即使知道租户 ID 也读不到
  const outsiderRead = await request(port, `/api/projects/${project.json.project.id}`, {
    headers: authHeaders(outsider, { 'x-tenant-id': owner.tenant.id }),
  });
  assert.equal(outsiderRead.status, 403);
  assert.equal(outsiderRead.json.error, 'TENANT_FORBIDDEN');

  const outsiderOwnList = await request(port, '/api/projects', { headers: authHeaders(outsider) });
  assert.equal(outsiderOwnList.status, 200);
  assert.equal(outsiderOwnList.json.projects.length, 0);

  // 加入为 viewer
  const added = await request(port, '/api/members', {
    method: 'POST', headers: authHeaders(owner),
    body: { actor_id: viewer.account.id, role: 'viewer' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));

  const viewerHeaders = authHeaders(viewer, { 'x-tenant-id': owner.tenant.id });
  const viewerRead = await request(port, `/api/projects/${project.json.project.id}`, { headers: viewerHeaders });
  assert.equal(viewerRead.status, 200);

  const viewerCreate = await request(port, '/api/projects', {
    method: 'POST', headers: viewerHeaders,
    body: { name: '越权商品', sku: 'HACK-001', category: '家居' },
  });
  assert.equal(viewerCreate.status, 403);
  assert.equal(viewerCreate.json.error, 'FORBIDDEN');

  const viewerTruth = await request(port, `/api/projects/${project.json.project.id}/truth-versions`, {
    method: 'POST', headers: viewerHeaders,
    body: { facts: { product_name: '手工皂' } },
  });
  assert.equal(viewerTruth.status, 403);
  assert.equal(viewerTruth.json.error, 'FORBIDDEN');

  const viewerQuote = await request(port, '/api/quotes', {
    method: 'POST', headers: viewerHeaders, body: { project_id: project.json.project.id },
  });
  assert.equal(viewerQuote.status, 403);

  const viewerRun = await request(port, '/api/runs', {
    method: 'POST', headers: viewerHeaders,
    body: { project_id: project.json.project.id, quote_id: 'qte_missing' },
  });
  assert.equal(viewerRun.status, 403);

  // 不能移除最后一个 owner
  const removeOwner = await request(port, `/api/members/${owner.account.id}`, {
    method: 'DELETE', headers: authHeaders(owner),
  });
  assert.equal(removeOwner.status, 409);
  assert.equal(removeOwner.json.error, 'MEMBER_LAST_OWNER');

  // viewer 不能管理成员
  const viewerMember = await request(port, '/api/members', {
    method: 'POST', headers: viewerHeaders,
    body: { actor_id: outsider.account.id, role: 'viewer' },
  });
  assert.equal(viewerMember.status, 403);
});

test('R01 登录限流、退出登录与跨站写请求拒绝', async t => {
  const { port } = await running(t);
  const user = await register(port, { email: 'limit@example.com', password: 'long enough password' });

  const crossOrigin = await request(port, '/api/auth/login', {
    method: 'POST',
    headers: { Origin: 'http://evil.example' },
    body: { email: 'limit@example.com', password: 'long enough password' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.json.error, 'CROSS_ORIGIN_DENIED');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await request(port, '/api/auth/login', {
      method: 'POST', body: { email: 'limit@example.com', password: 'definitely wrong' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'INVALID_CREDENTIALS');
  }
  const locked = await request(port, '/api/auth/login', {
    method: 'POST', body: { email: 'limit@example.com', password: 'long enough password' },
  });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error, 'LOGIN_LOCKED');

  // 使用未被锁定的账户验证退出登录
  const logout = await request(port, '/api/auth/logout', { method: 'POST', headers: authHeaders(user) });
  assert.equal(logout.status, 200);
  const after = await request(port, '/api/projects', { headers: { Cookie: `qtb_session=${user.cookie.token}` } });
  assert.equal(after.status, 401);
  assert.equal(after.json.error, 'SESSION_INVALID');
});

test('R01 演示模式只在非生产可用，配置层强制隔离', async t => {
  assert.equal(loadAuthConfig({ NODE_ENV: 'development' }).demoMode, true);
  assert.equal(loadAuthConfig({ NODE_ENV: 'test' }).demoMode, true);
  assert.equal(loadAuthConfig({ NODE_ENV: 'production' }).demoMode, false);
  assert.equal(loadAuthConfig({ NODE_ENV: 'production', QTB_DEMO_MODE: '0' }).demoMode, false);
  assert.throws(() => loadAuthConfig({ NODE_ENV: 'production', QTB_DEMO_MODE: '1' }));
  assert.throws(() => loadAuthConfig({ NODE_ENV: 'production', QTB_SESSION_TTL_MS: '1000' }));
  assert.equal(loadAuthConfig({ NODE_ENV: 'production' }).secureCookies, true);

  const { port } = await running(t, { demoMode: true });
  const config = await request(port, '/api/auth/config');
  assert.equal(config.json.demo_mode, true);
  // 演示模式保留本地演练入口，但生产配置已被上层拒绝
  const list = await request(port, '/api/projects', { headers: { 'x-tenant-id': 'tenant_demo' } });
  assert.equal(list.status, 200);
});
