/**
 * M03 真实数据 API 客户端。
 * 只调用本机同源 /api/*，不使用 localStorage 伪装持久化，
 * 服务端错误按 code 透传给界面，避免把失败渲染成成功。
 */
const ACTOR_ID = 'demo_operator';
// 当前工作区的租户标识：普通请求走请求头，SSE 订阅必须走 query
// （浏览器 EventSource 不能自定义请求头，服务端因此在 SSE 路由上接受 tenant_id 参数）
let currentTenant = null;

export function currentTenantId() {
  return currentTenant;
}

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
      ...(currentTenant ? { 'x-tenant-id': currentTenant } : {}),
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
  async tenant() {
    const result = await call('/api/tenant');
    if (result?.tenant_id) currentTenant = result.tenant_id;
    return result;
  },
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
  // M04：目录、品牌套件与生产配置
  listTemplates: () => call('/api/catalog/templates'),
  getTemplate: id => call(`/api/catalog/templates/${encodeURIComponent(id)}`),
  listChannelRules: () => call('/api/catalog/channel-rules'),
  listBrandKits: () => call('/api/brand-kits'),
  getBrandKit: id => call(`/api/brand-kits/${encodeURIComponent(id)}`),
  createBrandKit: body => call('/api/brand-kits', { method: 'POST', json: body }),
  createBrandKitVersion: (id, body) => call(`/api/brand-kits/${encodeURIComponent(id)}/versions`, { method: 'POST', json: body }),
  previewSpec: (id, body) => call(`/api/projects/${encodeURIComponent(id)}/specs/preview`, { method: 'POST', json: body }),
  createSpec: (id, body) => call(`/api/projects/${encodeURIComponent(id)}/specs`, { method: 'POST', json: body }),
  listSpecs: id => call(`/api/projects/${encodeURIComponent(id)}/specs`),
  getSpec: (id, version) => call(`/api/projects/${encodeURIComponent(id)}/specs/${encodeURIComponent(version)}`),
  // M05：额度账本、报价、任务执行与事件流
  credits: () => call('/api/credits'),
  // 报价/任务列表暂不按项目过滤：后端未提供 project_id 参数，前端取回后本地过滤，
  // 不把"看似筛选"的假参数传给后端
  listQuotes: () => call('/api/quotes'),
  createQuote: body => call('/api/quotes', { method: 'POST', json: body }),
  getQuote: id => call(`/api/quotes/${encodeURIComponent(id)}`),
  listRuns: () => call('/api/runs'),
  getRun: id => call(`/api/runs/${encodeURIComponent(id)}`),
  /** 创建任务必须带 Idempotency-Key：同名重复点击不会重复扣费。 */
  createRun: (body, idempotencyKey) => call('/api/runs', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    json: body,
  }),
  cancelRun: (id, body = {}) => call(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', json: body }),
  /** 预算超出初始预留时，用户确认追加额度后继续执行。 */
  confirmRunBudget: (id, body = {}) => call(`/api/runs/${encodeURIComponent(id)}/budget-confirmation`, { method: 'POST', json: body }),
  /**
   * SSE 事件流：返回 EventSource，调用方负责关闭。
   * EventSource 不能自定义请求头，所以租户必须走 query 参数（服务端仅在 SSE 路由放开）。
   * lastEventId 用于断线续传：只取该序号之后的事件，不重放已消费的部分。
   */
  runEvents: (id, { lastEventId = 0 } = {}) => {
    const query = new URLSearchParams();
    if (currentTenant) query.set('tenant_id', currentTenant);
    if (lastEventId > 0) query.set('last_event_id', String(lastEventId));
    const suffix = query.toString() ? `?${query}` : '';
    return new EventSource(`/api/runs/${encodeURIComponent(id)}/events${suffix}`);
  },
};
