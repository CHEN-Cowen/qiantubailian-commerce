export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const host = env.HOST ?? '127.0.0.1';
  const rawPort = env.PORT ?? '3000';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV 配置无效');
  }
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error('HOST 必须为 loopback 地址');
  if (!/^\d+$/.test(String(rawPort))) throw new Error('PORT 配置无效');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 配置无效');
  return Object.freeze({ nodeEnv, host, port });
}
