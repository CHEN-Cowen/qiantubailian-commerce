import http from 'node:http';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOPBACK_HOSTS } from './config.mjs';
import { createStore } from './store.mjs';
import { createApi } from './api.mjs';

export const SERVICE = Object.freeze({ status: 'ok', service: 'qiantubailian-commerce', version: '0.3.0', module: 'M03' });
export const STATIC_FILES = Object.freeze([
  'index.html', 'app.js', 'api.js', 'real-data.js', 'style.css', 'm03.css', 'viewport.css', 'icon.svg', 'architecture.svg',
  'data/demo.json', 'assets/demo/image-01.jpg', 'assets/demo/image-02.jpg', 'assets/demo/image-03.jpg',
]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg' };
const defaultRoot = fileURLToPath(new URL('../frontend/', import.meta.url));
const defaultDataDir = fileURLToPath(new URL('../runtime/', import.meta.url));

async function readAsset(root, name) {
  let current = root;
  for (const part of ['', ...name.split('/')]) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('资源不可用');
  }
  const base = await realpath(root);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(base) !== normalize(root)) throw new Error('资源不可用');
  const target = await realpath(current);
  if (!target.startsWith(base + path.sep)) throw new Error('资源不可用');
  const handle = await open(target, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('资源不可用');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function pathname(raw) {
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(raw)) throw new Error('路径无效');
  decodeURIComponent(raw);
  const decoded = decodeURIComponent(raw.split('?')[0]);
  if (/[\\%#?\u0000-\u0020\u007f]/.test(decoded) || decoded.startsWith('//')) throw new Error('路径无效');
  if (decoded.split('/').some(part => part === '.' || part === '..')) throw new Error('路径无效');
  return decoded;
}

export function createApp({
  host = '127.0.0.1',
  port = 3000,
  staticRoot = defaultRoot,
  storeDir = process.env.QTB_DATA_DIR || defaultDataDir,
  allowedTenants = ['tenant_demo'],
  defaultTenant = 'tenant_demo',
  defaultActor = 'demo_operator',
  maxUploadBytes,
} = {}) {
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error('HOST 必须为 loopback 地址');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 配置无效');
  const root = path.resolve(staticRoot);
  const store = createStore({ dir: storeDir });
  const api = createApi({ store, allowedTenants, defaultTenant, defaultActor, maxUploadBytes });
  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1_000 }, (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    const handle = async () => {
      let route;
      try { route = pathname(req.url); } catch { send(400, { error: 'BAD_REQUEST' }); return; }
      if (route === '/api' || route.startsWith('/api/')) {
        await api(req, res, route, send);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        send(405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      if (route === '/healthz') { send(200, SERVICE); return; }
      if (route === '/readyz') {
        try {
          await Promise.all(STATIC_FILES.map(name => readAsset(root, name)));
          send(200, { ...SERVICE, status: 'ready' });
        } catch { send(503, { ...SERVICE, status: 'not_ready' }); }
        return;
      }
      const name = route === '/' ? 'index.html' : route.slice(1);
      if (!STATIC_FILES.includes(name)) { send(404, { error: 'NOT_FOUND' }); return; }
      try { send(200, await readAsset(root, name), TYPES[path.extname(name)]); }
      catch { send(404, { error: 'NOT_FOUND' }); }
    };
    handle().catch(() => {
      if (!res.headersSent) send(500, { error: 'INTERNAL_ERROR' });
      else res.destroy();
    });
  });
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, socket) => {
    const res = new http.ServerResponse(req);
    res.shouldKeepAlive = false;
    res.assignSocket(socket);
    res.once('finish', () => socket.end());
    server.emit('request', req, res);
  });
  server.setTimeout(20_000, socket => socket.destroy());
  let closing;
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, host);
      });
    },
    close({ deadlineMs = 3_000 } = {}) {
      if (closing) return closing;
      closing = new Promise((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        const timer = setTimeout(() => {
          server.closeAllConnections();
          for (const socket of sockets) socket.destroy();
        }, deadlineMs);
        timer.unref();
        server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
