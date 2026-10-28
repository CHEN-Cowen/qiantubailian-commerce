import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { createApp, STATIC_FILES, SERVICE } from '../src/server.mjs';
import { healthcheck, validateBase } from '../scripts/healthcheck.mjs';
import { runSmoke } from '../scripts/smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function request(port, route, method = 'GET', agent = false) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function running(t, options = {}) {
  const app = createApp({ port: 0, ...options });
  t.after(() => app.close());
  const address = await app.listen();
  return { app, port: address.port };
}
async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'm01-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('配置默认值、合法边界及非法输入', () => {
  assert.deepEqual(loadConfig({}), { nodeEnv: 'development', host: '127.0.0.1', port: 3000 });
  for (const nodeEnv of ['development', 'test', 'production']) {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      for (const port of ['1', '65535']) assert.equal(loadConfig({ NODE_ENV: nodeEnv, HOST: host, PORT: port }).port, Number(port));
    }
  }
  for (const NODE_ENV of ['', 'staging', 'TEST']) assert.throws(() => loadConfig({ NODE_ENV }));
  for (const HOST of ['', '0.0.0.0', '::', 'example.com', '127.0.0.2']) {
    assert.throws(() => loadConfig({ HOST }));
    assert.throws(() => createApp({ host: HOST }));
  }
  for (const PORT of ['', '0', '-1', '65536', '1.2', ' 3000', '3e3', 'abc']) assert.throws(() => loadConfig({ PORT }));
  for (const port of [-1, 65536, NaN, 1.5, '3000']) assert.throws(() => createApp({ port }));
  assert.equal(createApp({ port: 0 }).server.listening, false);
});

test('静态白名单、HEAD、响应安全头与健康状态', async t => {
  const { app, port } = await running(t);
  assert.equal(app.server.requestTimeout, 15_000);
  assert.equal(app.server.headersTimeout, 10_000);
  assert.equal(app.server.keepAliveTimeout, 1_000);
  assert.equal(app.server.timeout, 20_000);
  for (const name of STATIC_FILES) {
    const response = await request(port, `/${name}`);
    assert.equal(response.status, 200, name);
    assert.deepEqual(response.body, await readFile(path.join(root, 'frontend', name)));
    assert.ok(response.headers['content-type']);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const head = await request(port, `/${name}`, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  }
  assert.equal((await request(port, '/')).status, 200);
  assert.equal((await request(port, '/app.js?v=1')).status, 200);
  assert.deepEqual(JSON.parse((await request(port, '/healthz')).body), SERVICE);
  assert.equal(JSON.parse((await request(port, '/readyz')).body).status, 'ready');
  for (const route of ['/healthz', '/readyz', '/missing']) assert.equal((await request(port, route, 'HEAD')).body.length, 0);
  await healthcheck(`http://127.0.0.1:${port}`);
});

test('API 路由语义：未知接口 404、已实现路由按方法判定、静态路由非 GET/HEAD 为 405', async t => {
  const { port } = await running(t);
  const connectStatus = route => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'CONNECT', agent: false });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  for (const route of ['/api', '/api/', '/api/test']) {
    const response = await request(port, route);
    assert.equal(response.status, 404, route);
    assert.equal(JSON.parse(response.body).error, 'NOT_FOUND', route);
    assert.equal(await connectStatus(route), 404, route);
  }
  // M05 后 /api/runs 与 /api/quotes 已实现：GET 正常、DELETE 走方法判定
  for (const route of ['/api/runs', '/api/quotes']) {
    const allowed = await request(port, route);
    assert.ok([200, 201].includes(allowed.status), `${route} 应可读`);
    const rejected = await request(port, route, 'DELETE');
    assert.equal(rejected.status, 405, `${route} DELETE 应 405`);
    assert.ok(rejected.headers.allow?.includes('GET'), '应回 Allow 头');
  }
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    if (!['GET', 'HEAD'].includes(method)) {
      for (const route of ['/', '/healthz', '/readyz', '/missing']) {
        const response = await request(port, route, method);
        assert.equal(response.status, 405);
        assert.equal(response.headers.allow, 'GET, HEAD');
      }
    }
  }
  assert.equal(await connectStatus('/healthz'), 405);
});

test('严格解码与路径安全：拒绝穿越、双编码、反斜线及非白名单', async t => {
  const { port } = await running(t);
  for (const route of ['/../package.json', '/%2e%2e/package.json', '/data/../app.js', '/%252e%252e/package.json', '/%ZZ', '/%E0%A4', '/%00', '/%5cpackage.json', '//app.js', '/app.js%3f', '/app.js#x']) {
    assert.equal((await request(port, route)).status, 400, route);
  }
  for (const route of ['/package.json', '/.env', '/src/server.mjs', '/README.md', '/frontend/app.js', '/data/', '/assets/', '/app.js/extra', '/apiary', '/not-found']) {
    const response = await request(port, route);
    assert.equal(response.status, 404, route);
    assert.deepEqual(JSON.parse(response.body), { error: 'NOT_FOUND' });
  }
});

test('缺失或非普通静态资源导致 404 与 readiness 503，但存活检查正常', async t => {
  const dir = await temporary(t);
  const { port } = await running(t, { staticRoot: dir });
  assert.equal((await request(port, '/')).status, 404);
  assert.equal((await request(port, '/healthz')).status, 200);
  assert.equal((await request(port, '/readyz')).status, 503);
  await assert.rejects(healthcheck(`http://127.0.0.1:${port}`));
  await mkdir(path.join(dir, 'index.html'));
  assert.equal((await request(port, '/')).status, 404);
  for (const name of STATIC_FILES.filter(name => name !== 'index.html')) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), 'test');
  }
  assert.equal((await request(port, '/readyz')).status, 503);
  await rm(path.join(dir, 'index.html'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), 'ok');
  assert.equal((await request(port, '/readyz')).status, 200);
  await rm(path.join(dir, 'app.js'));
  assert.equal((await request(port, '/readyz')).status, 503);
});

test('符号链接文件、目录和根目录均不能越界', async t => {
  const dir = await temporary(t);
  const outside = path.join(dir, 'outside');
  const frontend = path.join(dir, 'frontend');
  await mkdir(outside);
  await mkdir(frontend);
  await writeFile(path.join(outside, 'index.html'), 'secret');
  try { await symlink(path.join(outside, 'index.html'), path.join(frontend, 'index.html'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('系统无文件符号链接权限'); return; }
    throw error;
  }
  const { port } = await running(t, { staticRoot: frontend });
  assert.equal((await request(port, '/')).status, 404);
  assert.equal((await request(port, '/readyz')).status, 503);
  await symlink(outside, path.join(frontend, 'data'), 'junction');
  assert.equal((await request(port, '/data/demo.json')).status, 404);
  const alias = path.join(dir, 'alias');
  await symlink(outside, alias, 'junction');
  const linked = await running(t, { staticRoot: alias });
  assert.equal((await request(linked.port, '/')).status, 404);
});

test('健康检查拒绝外部地址、重定向、错误内容及超时', async t => {
  for (const value of ['https://localhost', 'http://example.com', 'http://0.0.0.0', 'http://127.0.0.2', 'http://localhost/x', 'http://user:pass@localhost', 'http://localhost/?x', 'http://localhost/#x']) assert.throws(() => validateBase(value));
  for (const value of ['http://127.0.0.1', 'http://localhost', 'http://[::1]:3000']) assert.ok(validateBase(value));
  let mode = 'redirect';
  const server = http.createServer((req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://example.com/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...SERVICE, module: 'wrong' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(healthcheck(base));
  mode = 'invalid';
  await assert.rejects(healthcheck(base));
  mode = 'timeout';
  await assert.rejects(healthcheck(base, 50), /超时/);
});

test('优雅关闭空闲与正在处理的连接，close 可重复调用', async t => {
  const { app, port } = await running(t);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  await request(port, '/healthz', 'GET', agent);
  const start = Date.now();
  await app.close({ deadlineMs: 100 });
  assert.ok(Date.now() - start < 2_000);
  await app.close();
  const active = await running(t);
  const req = http.request({ host: '127.0.0.1', port: active.port, method: 'POST', headers: { 'Content-Length': '100' } });
  req.on('error', () => {});
  req.flushHeaders();
  await once(req, 'socket');
  await active.app.close({ deadlineMs: 50 });
  req.destroy();
  const partial = await running(t);
  const socket = net.connect(partial.port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
  const closed = once(socket, 'close');
  await partial.app.close({ deadlineMs: 50 });
  await closed;
});

async function startFailure(env) {
  const child = fork(path.join(root, 'scripts/start.mjs'), [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(output, /启动失败/);
  assert.doesNotMatch(output, /Error:| at |secret|EADDRINUSE/);
}

test('导入服务模块不自动启动，loadEnvFile 保留外部环境值', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, '.env');
  await writeFile(file, 'M01_EXISTING=from_file\nM01_NEW=loaded\n');
  const moduleURL = new URL('../src/server.mjs', import.meta.url).href;
  // 全量套件并行运行时，子进程导入（含 sharp 原生绑定）可能超过 3 秒；
  // 这里放宽到 15 秒只覆盖导入耗时，仍然保持"未自动启动就必须退出"的断言。
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'await import(process.argv[1]); process.loadEnvFile(process.argv[2]); if (process.env.M01_EXISTING !== "external" || process.env.M01_NEW !== "loaded") process.exitCode = 1;',
    moduleURL, file], { env: { ...process.env, M01_EXISTING: 'external' }, timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
});

test('真实启动失败脱敏：非法环境与端口冲突', async t => {
  await startFailure({ HOST: 'secret.example.com', PORT: '3000' });
  await startFailure({ HOST: '127.0.0.1', PORT: '0' });
  const { port } = await running(t);
  await startFailure({ HOST: '127.0.0.1', PORT: String(port) });
  await assert.rejects(runSmoke({ ...process.env, PORT: String(port) }));
});

test('真实子进程启动、IPC 就绪、HTTP 健康检查与 SIGTERM 正常退出', async () => {
  const env = { ...process.env };
  delete env.PORT;
  const result = await runSmoke(env);
  assert.equal(result.code, 0);
  assert.ok(result.port > 0);
});
