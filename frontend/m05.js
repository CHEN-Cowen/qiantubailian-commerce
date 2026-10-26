import { ApiFailure, api } from './api.js';

/**
 * M05 生产任务界面：额度账本、报价、任务执行、事件流与取消。
 *
 * 界面的五条自我约束：
 * 1. 额度只读展示服务端账本，前端不自行加减余额；能否生成由服务端判定。
 * 2. 报价必须来自服务端返回的报价单，界面不本地估算金额。
 * 3. 开始按钮携带 Idempotency-Key：重复点击不会重复扣费。
 * 4. 事件流断线后按 last_event_id 续传，不重复渲染已消费的事件。
 * 5. 任务状态如实呈现，失败/限额/取消都显示服务端给出的原因，不粉饰。
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const formatTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
};

const RUN_STATUS_LABEL = {
  queued: '排队中', running: '生成中', evaluating: '质检中',
  awaiting_confirmation: '待确认额度', completed: '已完成',
  limit_reached: '已达重试上限', failed: '失败', cancelled: '已取消',
};
const TERMINAL_STATUS = new Set(['completed', 'limit_reached', 'failed', 'cancelled']);
const EVENT_LABEL = {
  budget_reserved: '预留额度', queued: '进入队列', generation: '生成',
  hard_check: '硬校验', revision: '修订', settled: '结算', cancelled: '取消',
};
const EVENT_STATUS_LABEL = {
  reserved: '已预留', queued: '已排队', attempt_submitted: '已提交',
  attempt_succeeded: '已完成', attempt_failed: '失败', recovered: '已恢复',
  released: '已释放', completed: '已完成', cancel_requested: '已请求取消',
  cancelled: '已取消',
};

const state = {
  toast: () => {},
  project: null,
  specs: [],
  quote: null,
  balance: null,
  run: null,
  events: [],
  lastEventId: 0,
  source: null,
  idempotencyKey: '',
};

const errorText = error => {
  if (error instanceof ApiFailure) return error.message;
  console.error('[M05] 未预期错误', error);
  return `操作失败：${error.message}`;
};

export function initM05({ toast } = {}) {
  if (typeof toast === 'function') state.toast = toast;
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action="run"]');
    if (!trigger) return;
    const card = trigger.closest('[data-project-id]');
    if (!card) return;
    void openRun(card.dataset.projectId);
  });
  $('#run-start')?.addEventListener('click', event => { event.preventDefault(); void startRun(); });
  $('#run-cancel')?.addEventListener('click', event => { event.preventDefault(); void cancelRun(); });
  $('#run-dialog')?.addEventListener('close', () => { closeStream(); });
}

async function openRun(projectId) {
  try {
    // 先确认租户上下文：SSE 订阅的租户必须经 query 传递
    await api.tenant();
    const [detail, specs, credits] = await Promise.all([
      api.getProject(projectId),
      api.listSpecs(projectId),
      api.credits(),
    ]);
    state.project = detail.project;
    state.specs = specs.specs ?? [];
    state.balance = credits.balance;
    state.quote = null;
    state.run = null;
    state.events = [];
    state.lastEventId = 0;
    state.idempotencyKey = newKey();
    $('#run-title').textContent = `${state.project.name} · 生产任务`;
    renderBody();
    renderQuote();
    renderEvents();
    const dialog = $('#run-dialog');
    if (!dialog.open) dialog.showModal();
    await refreshQuote();
  } catch (error) {
    state.toast(errorText(error));
  }
}

function newKey() {
  // 幂等键在一次打开面板期间固定：重复点击"开始"不会产生第二笔费用
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `ui-${random}`;
}

async function refreshQuote() {
  const holder = $('#run-quote');
  if (!holder) return;
  holder.innerHTML = '<p class="truth-hint">正在按冻结快照报价…</p>';
  try {
    const result = await api.createQuote({ project_id: state.project.id });
    state.quote = result.quote;
    renderQuote();
  } catch (error) {
    state.quote = null;
    holder.innerHTML = `<p class="form-error" role="alert">${escapeHtml(errorText(error))}</p>`;
    updateStartAvailability();
  }
}

function renderBody() {
  const body = $('#run-body');
  if (!body) return;
  const balance = state.balance ?? {};
  const specs = state.specs;
  const specRows = specs.length === 0
    ? '<p class="truth-hint">该项目还没有冻结的生产配置。请先在「生产配置」里冻结一个快照。</p>'
    : `<ul class="run-specs">${specs.map(spec => `
        <li><b>v${spec.version}</b><span>${escapeHtml(spec.template?.name ?? spec.template_id ?? '模板')} · ${escapeHtml(spec.platform ?? '未指定平台')}</span>
        <span class="run-spec-state ${spec.stale ? 'stale' : 'fresh'}">${spec.stale ? '已过期' : '可用'}</span></li>`).join('')}</ul>`;

  body.innerHTML = `
    <section class="run-section">
      <h3>额度账本<span class="run-note">服务端账本，前端不可改写</span></h3>
      <div class="run-balance">
        <div><span>可用</span><b>${balance.available ?? 0}</b></div>
        <div><span>已预留</span><b>${balance.reserved ?? 0}</b></div>
        <div><span>已消耗</span><b>${balance.consumed ?? 0}</b></div>
        <div><span>总额</span><b>${balance.granted_total ?? 0}</b></div>
      </div>
      <p class="real-note">${escapeHtml(balance.currency ?? '内部演示额度')}：这是演示额度，不代表真实货币或可计费权益。</p>
    </section>
    <section class="run-section">
      <h3>冻结快照</h3>
      ${specRows}
    </section>`;
  updateStartAvailability();
}

function renderQuote() {
  const holder = $('#run-quote');
  if (!holder) return;
  const quote = state.quote;
  if (!quote) { holder.innerHTML = ''; updateStartAvailability(); return; }
  const lines = quote.lines ?? [];
  holder.innerHTML = `
    <section class="run-section">
      <h3>报价<span class="run-note">价格版本 ${escapeHtml(quote.price_version ?? '')}</span></h3>
      <table class="run-quote-table">
        <thead><tr><th>交付项</th><th>规格</th><th>额度</th></tr></thead>
        <tbody>${lines.map(line => `
          <tr><td>${escapeHtml(line.label ?? line.deliverable_id)}</td>
          <td>${escapeHtml(line.spec ?? line.ratio ?? '')}</td>
          <td>${line.credits}</td></tr>`).join('')}</tbody>
      </table>
      <div class="run-quote-total">
        <span>估算 ${quote.estimated_credits}</span>
        <span>上限 ${quote.max_credits}</span>
        <span>最多 ${quote.max_attempts} 轮</span>
        <span>有效期至 ${formatTime(quote.expires_at)}</span>
      </div>
      <p class="real-note">开始时按上限预留额度；未发生的部分在任务结束后释放。报价过期或与快照不一致时必须重新取价。</p>
    </section>`;
  updateStartAvailability();
}

function updateStartAvailability() {
  const start = $('#run-start');
  if (!start) return;
  const spec = state.specs.find(item => !item.stale) ?? state.specs[0];
  const ready = Boolean(state.project && state.quote && spec);
  start.disabled = !ready;
  start.textContent = state.run ? '任务进行中' : (ready ? '确认并开始' : '缺少可用的冻结快照或报价');
}

async function startRun() {
  if (!state.project || !state.quote) return;
  const start = $('#run-start');
  start.disabled = true;
  try {
    const spec = state.specs.find(item => !item.stale) ?? state.specs[0];
    const result = await api.createRun({
      project_id: state.project.id,
      quote_id: state.quote.quote_id,
      spec_version: spec?.version,
    }, state.idempotencyKey);
    state.run = result.run;
    state.balance = result.balance ?? state.balance;
    renderBody();
    renderEvents();
    updateStartAvailability();
    openStream(state.run.id);
  } catch (error) {
    state.toast(errorText(error));
    start.disabled = false;
    if (error instanceof ApiFailure && ['QUOTE_EXPIRED', 'QUOTE_SPEC_MISMATCH'].includes(error.code)) {
      await refreshQuote();
    }
  }
}

async function cancelRun() {
  if (!state.run) return;
  try {
    const result = await api.cancelRun(state.run.id, { reason: 'user_cancelled' });
    state.run = result.run;
    renderEvents();
  } catch (error) {
    state.toast(errorText(error));
  }
}

function openStream(runId) {
  closeStream();
  // EventSource 由浏览器自带断线重连；续传游标 last_event_id 由服务端按 sequence 过滤，
  // 保证不重放已消费的事件。租户经 query 传递（EventSource 不能自定义请求头）。
  if (typeof EventSource !== 'function') {
    state.toast('当前浏览器不支持 EventSource，事件流不可用');
    return;
  }
  const source = api.runEvents(runId, { lastEventId: state.lastEventId });
  state.source = source;
  source.addEventListener('message', event => {
    let payload = null;
    try { payload = JSON.parse(event.data); } catch { return; }
    // 终态标记是收尾信号，不是领域事件：它没有 sequence，只用来通知客户端收流并刷新快照
    if (payload && payload.terminal) {
      void refreshRun(runId);
      closeStream();
      return;
    }
    if (!payload || typeof payload.sequence !== 'number') return;
    if (payload.sequence <= state.lastEventId) return; // 已消费过的事件不再渲染
    state.lastEventId = payload.sequence;
    state.events.push(payload);
    renderEvents();
  });
  source.addEventListener('error', () => { closeStream(); void refreshRun(runId); });
}

function closeStream() {
  if (state.source) { state.source.close(); state.source = null; }
}

async function refreshRun(runId) {
  try {
    const result = await api.getRun(runId);
    state.run = result.run;
    state.balance = (await api.credits()).balance;
    renderBody();
    renderEvents();
  } catch (error) {
    console.error('[M05] 刷新任务失败', error);
  }
}

function renderEvents() {
  const holder = $('#run-events');
  if (!holder) return;
  const run = state.run;
  if (!run) { holder.innerHTML = ''; return; }
  const status = run.status ?? 'queued';
  const budget = run.budget ?? {};
  const deliverables = run.deliverables ?? [];
  const deliverableRows = deliverables.length === 0 ? '' : `<ul class="run-deliverables">${deliverables.map(item => `
    <li><b>${escapeHtml(item.label ?? item.deliverable_id)}</b>
    <span class="run-chip ${escapeHtml(item.status ?? 'pending')}">${escapeHtml(item.status ?? 'pending')}</span>
    ${item.credits ? `<span>${item.credits} 额度</span>` : ''}</li>`).join('')}</ul>`;

  holder.innerHTML = `
    <section class="run-section">
      <h3>任务状态
        <span class="run-status ${escapeHtml(status)}">${escapeHtml(RUN_STATUS_LABEL[status] ?? status)}</span>
      </h3>
      <div class="run-meta">
        <span>预留 ${budget.reserved_credits ?? 0}</span>
        <span>已结算 ${budget.captured_credits ?? 0}</span>
        <span>已释放 ${budget.released_credits ?? 0}</span>
        <span>轮次 ${run.iteration ?? 1}/${run.max_attempts ?? '-'}</span>
      </div>
      ${run.terminal_reason ? `<p class="real-note">终态原因：${escapeHtml(run.terminal_reason)}</p>` : ''}
      ${deliverableRows}
    </section>
    <section class="run-section">
      <h3>事件流<span class="run-note">按 sequence 单调递增</span></h3>
      <ol class="run-timeline">${state.events.map(event => `
        <li>
          <span class="run-timeline-seq">#${event.sequence}</span>
          <b>${escapeHtml(EVENT_LABEL[event.stage] ?? event.stage)}</b>
          <span class="run-chip ${escapeHtml(event.status)}">${escapeHtml(EVENT_STATUS_LABEL[event.status] ?? event.status)}</span>
          <span class="run-timeline-time">${formatTime(event.timestamp)}</span>
        </li>`).join('')}</ol>
    </section>`;
  const cancel = $('#run-cancel');
  if (cancel) cancel.disabled = TERMINAL_STATUS.has(status) || run.cancel_requested === true;
}

export const m05state = state;

// 作为独立模块脚本加载时自启动：与 m04.js 保持同一套 toast 行为。
function showToast(message) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 3000);
}

if (typeof document !== 'undefined') initM05({ toast: showToast });
