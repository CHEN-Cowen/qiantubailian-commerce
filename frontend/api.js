/**
 * M03 真实数据 API 客户端。
 * 只调用本机同源 /api/*，不使用 localStorage 伪装持久化，
 * 服务端错误按 code 透传给界面，避免把失败渲染成成功。
 */
const ACTOR_ID = 'demo_operator';

export class ApiFailure extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function call(route, { json, headers = {}, ...rest } = {}) {
  const hasJson = json !== undefined;
  const response = await fetch(route, {
    ...rest,
    headers: {
      'x-actor-id': ACTOR_ID,
      ...(hasJson ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: rest.body ?? (hasJson ? JSON.stringify(json) : undefined),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    throw new ApiFailure(
      response.status,
      payload?.error ?? 'REQUEST_FAILED',
      payload?.message ?? `请求失败（HTTP ${response.status}）`,
      payload?.details,
    );
  }
  return payload;
}

export const api = {
  tenant: () => call('/api/tenant'),
  listProjects: () => call('/api/projects'),
  createProject: body => call('/api/projects', { method: 'POST', json: body }),
  getProject: id => call(`/api/projects/${encodeURIComponent(id)}`),
  uploadAsset(id, file, { role, onConflict } = {}) {
    const query = new URLSearchParams({ role: role ?? 'subject', filename: file.name || 'upload' });
    if (onConflict) query.set('on_conflict', onConflict);
    return call(`/api/projects/${encodeURIComponent(id)}/assets?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  },
  listTruthVersions: id => call(`/api/projects/${encodeURIComponent(id)}/truth-versions`),
  createTruthVersion: (id, body) => call(`/api/projects/${encodeURIComponent(id)}/truth-versions`, { method: 'POST', json: body }),
  readiness: id => call(`/api/projects/${encodeURIComponent(id)}/readiness`),
};
