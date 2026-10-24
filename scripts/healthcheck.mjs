import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { SERVICE } from '../src/server.mjs';

export function validateBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('健康检查仅允许 loopback HTTP 根地址');
  }
  return url;
}

export function probe(base, route, expectedStatus, timeoutMs = 2_000) {
  const url = new URL(route, validateBase(base));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => request.destroy(new Error('健康检查超时')), timeoutMs);
    const request = http.get(url, { agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16_384) request.destroy(new Error('健康检查响应过大'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')) throw new Error('健康检查响应无效');
          const data = JSON.parse(body);
          if (data.status !== expectedStatus || ['service', 'version', 'module'].some(key => data[key] !== SERVICE[key])) throw new Error('健康检查内容无效');
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.once('close', () => clearTimeout(timer));
  });
}

export async function healthcheck(base, timeoutMs) {
  validateBase(base);
  await probe(base, '/healthz', 'ok', timeoutMs);
  await probe(base, '/readyz', 'ready', timeoutMs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await healthcheck(process.argv[2] ?? 'http://127.0.0.1:3000');
    console.log('healthz 与 readyz 检查通过');
  } catch { console.error('健康检查失败'); process.exitCode = 1; }
}
