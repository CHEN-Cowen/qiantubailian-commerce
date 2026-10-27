/**
 * R01 真实身份与会话。
 *
 * 设计约束：
 * 1. 生产环境默认拒绝未认证访问；演示模式只在非生产环境生效，且演示身份由服务端配置，
 *    不接受客户端自报的 actor 作为授权依据。
 * 2. 密码使用 Node 内置 scrypt 加盐存储，仓库不引入第三方依赖；比较使用定时安全比较。
 * 3. 会话令牌只以 SHA-256 哈希落盘，Cookie 为 HttpOnly；状态变更要求 CSRF 头与 Origin 校验。
 * 4. 登录失败按「来源 + 邮箱」限流，达到阈值锁定一段时间，成功登录清除计数。
 * 5. 账户恢复依赖邮件服务；未配置时能力显式关闭（503），不假装可用。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const SESSION_COOKIE = 'qtb_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
export const PBKDF = Object.freeze({ N: 16_384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });

const nowIso = at => new Date(at).toISOString();
const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > 254) return { ok: false, message: '邮箱格式无效' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: '邮箱格式无效' };
  return { ok: true, email };
}

export function validatePassword(password, email = '') {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN_LENGTH) return { ok: false, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` };
  if (value.length > PASSWORD_MAX_LENGTH) return { ok: false, message: `密码最多 ${PASSWORD_MAX_LENGTH} 位` };
  if (normalizeEmail(email) && value.toLowerCase() === normalizeEmail(email)) {
    return { ok: false, message: '密码不能与邮箱相同' };
  }
  return { ok: true };
}

export function validateDisplayName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 40) return { ok: false, message: '昵称需为 1—40 个字符' };
  return { ok: true, name };
}

export function validateTenantName(value, fallback = '') {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { ok: true, name: fallback };
  if (name.length > 60) return { ok: false, message: '工作区名称最多 60 个字符' };
  return { ok: true, name };
}

export function validateRegistration(body = {}) {
  const email = validateEmail(body.email);
  if (!email.ok) return { ok: false, code: 'EMAIL_INVALID', message: email.message };
  const password = validatePassword(body.password, email.email);
  if (!password.ok) return { ok: false, code: 'PASSWORD_INVALID', message: password.message };
  const displayName = validateDisplayName(body.display_name ?? body.displayName ?? email.email.split('@')[0]);
  if (!displayName.ok) return { ok: false, code: 'DISPLAY_NAME_INVALID', message: displayName.message };
  const tenantName = validateTenantName(body.tenant_name ?? body.tenantName, `${displayName.name}的工作区`);
  if (!tenantName.ok) return { ok: false, code: 'TENANT_NAME_INVALID', message: tenantName.message };
  return {
    ok: true,
    payload: { email: email.email, password: String(body.password), displayName: displayName.name, tenantName: tenantName.name },
  };
}

function derive(password, salt) {
  return scryptSync(password, salt, PBKDF.keylen, {
    N: PBKDF.N, r: PBKDF.r, p: PBKDF.p, maxmem: PBKDF.maxmem,
  }).toString('hex');
}

export function makePasswordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return {
    password_salt: salt,
    password_hash: derive(password, salt),
    password_algorithm: 'scrypt-n16384-r8-p1',
  };
}

export function verifyPassword(password, account) {
  if (!account?.password_salt || !account?.password_hash) return false;
  let candidate;
  try {
    candidate = Buffer.from(derive(String(password ?? ''), account.password_salt), 'hex');
  } catch {
    return false;
  }
  const expected = Buffer.from(account.password_hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function makeAccountRecord({ email, password, displayName, at = new Date() }) {
  const timestamp = nowIso(at);
  return {
    id: newId('acc'),
    email: String(email).trim().toLowerCase(),
    email_normalized: normalizeEmail(email),
    display_name: displayName,
    status: 'active',
    ...makePasswordRecord(password),
    created_at: timestamp,
    updated_at: timestamp,
    last_login_at: null,
  };
}

export function makeTenantRecord({ name, accountId, at = new Date() }) {
  const timestamp = nowIso(at);
  return {
    id: newId('tnt'),
    name,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp,
    created_by: accountId,
  };
}

export function makeOwnerMember({ tenantId, accountId, at = new Date() }) {
  const timestamp = nowIso(at);
  return {
    id: newId('mbr'),
    tenant_id: tenantId,
    actor_id: accountId,
    role: 'owner',
    created_by: accountId,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function createSession(data, {
  accountId, tenantId, ttlMs = SESSION_TTL_MS, at = new Date(), ip = null, userAgent = null,
} = {}) {
  if (!data.sessions) data.sessions = {};
  const token = randomBytes(32).toString('hex');
  const sessionId = sha256(token);
  const createdAt = nowIso(at);
  const session = {
    id: sessionId,
    account_id: accountId,
    tenant_id: tenantId,
    csrf_token: randomBytes(24).toString('hex'),
    created_at: createdAt,
    last_seen_at: createdAt,
    expires_at: new Date(new Date(at).getTime() + ttlMs).toISOString(),
    revoked_at: null,
    ip_hash: ip ? sha256(`ip:${ip}`) : null,
    user_agent: userAgent ? String(userAgent).slice(0, 200) : null,
  };
  data.sessions[sessionId] = session;
  return { token, session: { ...session } };
}

export function findSession(data, token, at = new Date()) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const session = data.sessions?.[sha256(token)] ?? null;
  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= new Date(at).getTime()) return null;
  return session;
}

export function touchSession(data, session, at = new Date()) {
  const record = data.sessions?.[session.id];
  if (!record || record.revoked_at) return;
  record.last_seen_at = nowIso(at);
}

export function revokeSession(data, sessionId, at = new Date()) {
  const record = data.sessions?.[sessionId];
  if (!record || record.revoked_at) return false;
  record.revoked_at = nowIso(at);
  return true;
}

export function sessionView({ account, tenant, role, permissions = [], demoMode = false } = {}) {
  return {
    authenticated: Boolean(account),
    demo_mode: demoMode,
    account: account ? {
      id: account.id,
      email: account.email,
      display_name: account.display_name,
    } : null,
    tenant: tenant ? { id: tenant.id, name: tenant.name } : null,
    role: role ?? null,
    permissions: [...permissions],
  };
}

export function parseCookies(header) {
  const result = {};
  if (typeof header !== 'string' || header === '') return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    result[name] = value;
  }
  return result;
}

export function sessionCookie(token, { maxAgeSeconds = SESSION_TTL_MS / 1000, secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie({ secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function throttleKey(ip, email) {
  return sha256(`${String(ip ?? 'unknown')}|${normalizeEmail(email)}`);
}

export function throttleStatus(data, key, at = new Date(), {
  maxFailures = LOGIN_MAX_FAILURES, lockMs = LOGIN_LOCK_MS,
} = {}) {
  const entry = data.auth_throttle?.[key] ?? null;
  if (!entry) return { locked: false, failures: 0, retry_after_ms: 0 };
  const lockedUntil = entry.locked_until ? new Date(entry.locked_until).getTime() : 0;
  if (lockedUntil > new Date(at).getTime()) {
    return { locked: true, failures: entry.failures ?? maxFailures, retry_after_ms: lockedUntil - new Date(at).getTime() };
  }
  return { locked: false, failures: entry.failures ?? 0, retry_after_ms: 0 };
}

export function recordAuthFailure(data, key, at = new Date(), {
  maxFailures = LOGIN_MAX_FAILURES, windowMs = LOGIN_WINDOW_MS, lockMs = LOGIN_LOCK_MS,
} = {}) {
  if (!data.auth_throttle) data.auth_throttle = {};
  const timestamp = nowIso(at);
  const entry = data.auth_throttle[key] ?? {
    key, failures: 0, first_failure_at: timestamp, locked_until: null, updated_at: timestamp,
  };
  const windowStart = new Date(entry.first_failure_at).getTime();
  if (new Date(at).getTime() - windowStart > windowMs) {
    entry.failures = 0;
    entry.first_failure_at = timestamp;
  }
  entry.failures += 1;
  entry.updated_at = timestamp;
  if (entry.failures >= maxFailures) {
    entry.locked_until = new Date(new Date(at).getTime() + lockMs).toISOString();
  }
  data.auth_throttle[key] = entry;
  return { ...entry };
}

export function clearAuthFailures(data, key) {
  if (data.auth_throttle?.[key]) delete data.auth_throttle[key];
}

export function pruneAuthState(data, at = new Date()) {
  const cutoff = new Date(at).getTime() - 24 * 60 * 60 * 1000;
  for (const [id, session] of Object.entries(data.sessions ?? {})) {
    const expired = new Date(session.expires_at).getTime() <= new Date(at).getTime();
    if (session.revoked_at && new Date(session.revoked_at).getTime() < cutoff) delete data.sessions[id];
    else if (expired && !session.revoked_at) delete data.sessions[id];
  }
  for (const [key, entry] of Object.entries(data.auth_throttle ?? {})) {
    if (new Date(entry.updated_at).getTime() < cutoff) delete data.auth_throttle[key];
  }
}

export function assertLoginAllowed(status) {
  if (status.locked) {
    throw new ApiError(429, 'LOGIN_LOCKED', '登录尝试过于频繁，请稍后再试', {
      retry_after_ms: status.retry_after_ms,
    });
  }
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}
