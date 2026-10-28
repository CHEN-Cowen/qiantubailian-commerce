/**
 * M03 真实数据 API 客户端。
 * 只调用本机同源 /api/*，不使用 localStorage 伪装持久化，
 * 服务端错误按 code 透传给界面，避免把失败渲染成成功。
 */
const ACTOR_ID = 'demo_operator';
// 当前工作区的租户标识：普通请求走请求头，SSE 订阅必须走 query
// （浏览器 EventSource 不能自定义请求头，服务端因此在 SSE 路由上接受 tenant_id 参数）
let currentTenant = null;
// R01：会话模式下的 CSRF 令牌由登录/会话接口下发，所有写请求必须带上
let csrfToken = null;

export function currentTenantId() {
  return currentTenant;
}

export function setSession(session) {
  csrfToken = session?.csrf_token ?? null;
  if (session?.tenant?.id) currentTenant = session.tenant.id;
  // 会话模式下服务端只认 Cookie，不再发送可伪造的操作人头
  sessionBound = Boolean(session?.authenticated);
}

let sessionBound = false;

/** 认证接口不能等待“登录完成”这个 Promise，否则登录请求会自己把自己锁住。 */
async function authCall(route, { method = 'GET', json } = {}) {
  const response = await fetch(route, {
    method,
    credentials: 'same-origin',
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
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
  // R01：生产模式下登录闸口未通过前，业务请求一律等待，避免刷出一屏 401
  if (window.__qtbAuthReady) await window.__qtbAuthReady;
  const hasJson = json !== undefined;
  const method = (rest.method ?? 'GET').toUpperCase();
  const needsCsrf = csrfToken && !['GET', 'HEAD'].includes(method);
  const response = await fetch(route, {
    ...rest,
    credentials: 'same-origin',
    headers: {
      ...(sessionBound ? {} : { 'x-actor-id': ACTOR_ID }),
      ...(currentTenant ? { 'x-tenant-id': currentTenant } : {}),
      ...(hasJson ? { 'Content-Type': 'application/json' } : {}),
      ...(needsCsrf ? { 'X-CSRF-Token': csrfToken } : {}),
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
  // R01：认证与会话
  authConfig: () => authCall('/api/auth/config'),
  session: () => authCall('/api/auth/session'),
  login: body => authCall('/api/auth/login', { method: 'POST', json: body }),
  register: body => authCall('/api/auth/register', { method: 'POST', json: body }),
  logout: () => authCall('/api/auth/logout', { method: 'POST' }),
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
  extractAssetFacts: (project, asset) => call(`/api/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}/fact-extraction`, { method: 'POST', json: {} }),
  updateSubjectBox: (project, asset, subject_box) => call(`/api/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}/subject-box`, { method: 'PUT', json: { subject_box } }),
  createTruthVersion: (id, body) => call(`/api/projects/${encodeURIComponent(id)}/truth-versions`, { method: 'POST', json: body }),
  readiness: id => call(`/api/projects/${encodeURIComponent(id)}/readiness`),
  // E01：SKU 档案与包装包含物（版本化 + 乐观锁）
  getSkus: id => call(`/api/projects/${encodeURIComponent(id)}/skus`),
  putSkus: (id, body) => call(`/api/projects/${encodeURIComponent(id)}/skus`, { method: 'PUT', json: body }),
  listSkuVersions: id => call(`/api/projects/${encodeURIComponent(id)}/skus/versions`),
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
  // R05：任务相关的产物、版本、质量报告和导出
  listRunsByProject: projectId => {
    const query = new URLSearchParams();
    if (projectId) query.set('project_id', String(projectId));
    const suffix = query.toString() ? `?${query}` : '';
    return call(`/api/runs${suffix}`);
  },
  listRunVersions: runId => call(`/api/runs/${encodeURIComponent(runId)}/versions`),
  activateVersion: (runId, versionId) => call(
    `/api/runs/${encodeURIComponent(runId)}/versions/${encodeURIComponent(versionId)}/activate`,
    { method: 'POST' }),
  listQualityReports: runId => {
    const query = new URLSearchParams();
    if (runId) query.set('run_id', String(runId));
    const suffix = query.toString() ? `?${query}` : '';
    return call(`/api/quality-reports${suffix}`);
  },
  getQualityReport: reportId => call(`/api/quality-reports/${encodeURIComponent(reportId)}`),
  reviewQualityReport: (reportId, body = {}) => call(
    `/api/quality-reports/${encodeURIComponent(reportId)}/reviews`,
    { method: 'POST', json: body }),
  listExports: ({ runId, projectId } = {}) => {
    const query = new URLSearchParams();
    if (runId) query.set('run_id', String(runId));
    if (projectId) query.set('project_id', String(projectId));
    const suffix = query.toString() ? `?${query}` : '';
    return call(`/api/exports${suffix}`);
  },
  getExport: exportId => call(`/api/exports/${encodeURIComponent(exportId)}`),
  createExport: (runId, { scope = 'complete' } = {}) => call(
    `/api/runs/${encodeURIComponent(runId)}/exports`,
    { method: 'POST', json: { scope } }),
  // R07：价格与计费
  listPlans: () => call('/api/plans'),
  createBillingOrder: body => call('/api/billing/orders', { method: 'POST', json: body }),
  queryBillingOrder: id => call(`/api/billing/orders/${encodeURIComponent(id)}/query`),
  refundBillingOrder: id => call(`/api/billing/orders/${encodeURIComponent(id)}/refund`, { method: 'POST', json: {} }),
  closeBillingOrder: id => call(`/api/billing/orders/${encodeURIComponent(id)}/close`, { method: 'POST', json: {} }),
  listBillingOrders: ({ status } = {}) => {
    const query = new URLSearchParams();
    if (status) query.set('status', String(status));
    const suffix = query.toString() ? `?${query}` : '';
    return call(`/api/billing/orders${suffix}`);
  },
  cancelBillingOrder: orderId => call(`/api/billing/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' }),
  // M13 / 模块 05：修改工作台（文字排版修改 + 指定图片重生成）
  /** 只读预览：当前选用版本的可编辑文字层与安全边界（run:read）。 */
  listTextLayers: (runId, deliverableId) => call(
    `/api/runs/${encodeURIComponent(runId)}/deliverables/${encodeURIComponent(deliverableId)}/text-layers`),
  /** 免费文字排版修改：成功返回 {version, previous_version_id, report, issues, activated}。 */
  applyTextEdits: (runId, deliverableId, body) => call(
    `/api/runs/${encodeURIComponent(runId)}/deliverables/${encodeURIComponent(deliverableId)}/text-edits`,
    { method: 'POST', json: body }),
  /**
   * 指定图片重生成：必须带 Idempotency-Key（重复点击/刷新不会重复扣费）。
   * 返回 {run, source_run_id}，run 为子任务，需轮询到终态。
   */
  regenerateDeliverable: (runId, body, idempotencyKey) => call(
    `/api/runs/${encodeURIComponent(runId)}/regenerate`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, json: body }),
  // R05 追加：listGenerationRecords / reconcileRun
  /**
   * 下载导出包：走同源直接打开即可，后端已经设置 attachment。
   * 浏览器会处理跨域/CORS和文件保存对话框。
   */
  downloadExportUrl: exportId => `/api/exports/${encodeURIComponent(exportId)}/download`,
  listGenerationRecords: runId => call(`/api/runs/${encodeURIComponent(runId)}/generation-records`),
  reconcileRun: (runId, body) => call(`/api/runs/${encodeURIComponent(runId)}/reconcile`, { method: 'POST', json: body }),
};
