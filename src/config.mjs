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

/**
 * M05 起的可调参数：额度、调度节拍与场景注入开关。
 * 单独成函数，避免把 M05 的实验性开关塞进对外的最小配置契约。
 */
export function loadRuntimeConfig(env = process.env) {
  const initialCredits = Number(env.QTB_INITIAL_CREDITS ?? 240);
  const tickMs = Number(env.QTB_TICK_MS ?? 25);
  const attemptTimeoutMs = Number(env.QTB_ATTEMPT_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(initialCredits) || initialCredits < 0) throw new Error('初始额度配置无效');
  if (!Number.isInteger(tickMs) || tickMs < 1) throw new Error('调度节拍配置无效');
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) throw new Error('尝试超时配置无效');
  // 租户白名单：逗号分隔。默认值只有一个演示租户，显式配置才放开更多租户。
  const allowedTenants = (env.QTB_TENANTS ?? 'tenant_demo')
    .split(',').map(item => item.trim()).filter(Boolean);
  if (allowedTenants.length === 0) throw new Error('租户白名单配置无效');
  const defaultTenant = env.QTB_DEFAULT_TENANT ?? allowedTenants[0];
  if (!allowedTenants.includes(defaultTenant)) throw new Error('默认租户必须在白名单内');
  return Object.freeze({
    initialCredits,
    tickMs,
    attemptTimeoutMs,
    allowedTenants,
    defaultTenant,
    // 场景注入只用于本地演练与测试，默认关闭
    allowScenarioInjection: env.QTB_ALLOW_SCENARIO === '1',
  });
}

/**
 * R01 身份与会话配置。
 * 生产环境强制关闭演示身份；演示模式只在非生产环境可用，且必须由服务端配置。
 */
export function loadAuthConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV 配置无效');
  const explicitDemo = env.QTB_DEMO_MODE;
  if (nodeEnv === 'production' && explicitDemo === '1') {
    throw new Error('生产环境不允许开启演示身份');
  }
  const demoMode = nodeEnv !== 'production' && explicitDemo !== '0';
  const sessionTtlMs = Number(env.QTB_SESSION_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 90 * 24 * 60 * 60 * 1000) {
    throw new Error('会话有效期配置无效');
  }
  const secureCookies = nodeEnv === 'production' || env.QTB_SECURE_COOKIES === '1';
  return Object.freeze({
    demoMode,
    sessionTtlMs,
    secureCookies,
    // 邮件服务未接入时账户恢复能力显式关闭
    emailRecoveryConfigured: env.QTB_EMAIL_RECOVERY === '1',
  });
}
