/**
 * R05 真实商品制作工作台
 *
 * 三条自我约束：
 * 1. 恢复优先：打开项目先查已有 run，不自动创建新任务或扣新额度；历史结果只展示，不扣费。
 * 2. SSE + 轮询双保险：SSE 断线后切 15s 轮询兜底，终态时两者都停；重连按 last_event_id 去重。
 * 3. 展示全是真实数据：版本、QA checks、过期报告状态都来自后端，前端不粉饰。
 */
import { api, ApiFailure } from './api.js';
import { openSpec } from './m04.js';
import { openTruthDialog, openUploadDialog, refreshProjects } from './real-data.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatTime = v => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
};
const runStatusLabel = {
  queued: '排队中', running: '生成中', evaluating: '质检中',
  awaiting_confirmation: '待确认额度', completed: '已完成',
  limit_reached: '已达重试上限', failed: '失败', cancelled: '已取消', needs_attention: '待关注',
};
const runTerminal = new Set(['completed', 'limit_reached', 'failed', 'cancelled', 'needs_attention']);
const qualityStatusLabel = {
  publishable: '可发布', needs_review: '待复核', blocked: '阻断', not_checked: '未检查',
};
const checkStatusLabel = { pass: '通过', fail: '失败', unknown: '未知 / 待确认' };

const LS_KEY = 'qb.workbench';

const state = {
  toast: () => {},
  projectId: null,
  project: null,
  specs: [],
  runs: [],
  activeRun: null,           // 最近一个进行中的 run，或最新 completed
  selectedDeliverableId: null,
  selectedVersionId: null,
  selectedReportId: null,
  versions: [],
  reports: [],
  exports: [],
  generationRecords: [],
  // 事件流
  source: null,
  lastEventId: 0,
  pollTimer: null,
  pollIntervalMs: 15000,
  sseReconnectAttempts: 0,
  compareMode: false,
  // 新建 run 时的幂等键（工作台生命周期内固定，离开就重置）
  idempotencyKey: null,
};

// ---------- 初始化 ----------
export function initWorkbench({ toast } = {}) {
  if (typeof toast === 'function') state.toast = toast;
  window.addEventListener('qb:open-workbench', handleOpenFromEvent);
  window.addEventListener('qb:open-spec', handleOpenSpec);
  $('#wb-back')?.addEventListener('click', closeWorkbench);
  $('#wb-btn-upload')?.addEventListener('click', () => openUploadDialog(state.projectId));
  $('#wb-btn-truth')?.addEventListener('click', () => openTruthDialog(state.projectId));
  $('#wb-btn-spec')?.addEventListener('click', () => openSpec(state.projectId));
  $('#wb-btn-start')?.addEventListener('click', () => void handleStartOrContinue());
  $('#wb-btn-start')?.addEventListener('dblclick', e => e.preventDefault());
  $('#wb-compare-toggle')?.addEventListener('click', toggleCompare);
  $('#wb-version-prev')?.addEventListener('click', () => shiftVersion(-1));
  $('#wb-version-next')?.addEventListener('click', () => shiftVersion(+1));
  $('#wb-version-activate')?.addEventListener('click', () => void activateSelectedVersion());
  $('#wb-export-complete')?.addEventListener('click', () => void requestExport('complete'));
  $('#wb-export-partial')?.addEventListener('click', () => void requestExport('partial'));
  document.addEventListener('click', onDeliverableClick);
  document.addEventListener('click', onReviewDecisionClick);
  window.addEventListener('beforeunload', () => persistSelection());
  // 浏览器刷新后：如果 LS 里还有未关闭的 run，自动恢复（SSE + polling）
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed?.projectId) {
        // 不阻塞 init，等待用户点击"商品项目"时再恢复
        state.projectId = parsed.projectId;
      }
    } catch { /* ignore */ }
  }
}

function handleOpenFromEvent(event) {
  const projectId = event?.detail?.projectId;
  if (!projectId) return;
  void openWorkbench(projectId);
}
function handleOpenSpec(event) {
  const projectId = event?.detail?.projectId;
  if (!projectId) return;
  void openSpec(projectId);
}

// ---------- 入口：打开工作台 ----------
export async function openWorkbench(projectId) {
  if (!projectId) return;
  state.projectId = projectId;
  state.idempotencyKey = null;
  clearPolling();
  closeSSE();
  showWorkbench(true);
  $('#wb-project-title').textContent = '正在打开项目…';
  $('#wb-project-subtitle').textContent = '读取项目、任务与交付状态';
  try {
    const [detail, specsPayload, runsPayload] = await Promise.all([
      api.getProject(projectId),
      api.listSpecs(projectId).catch(() => ({ specs: [] })),
      api.listRunsByProject(projectId).catch(() => ({ runs: [] })),
    ]);
    state.project = detail.project;
    state.specs = specsPayload.specs ?? [];
    state.runs = runsPayload.runs ?? [];
    const saved = safeReadLS();
    // 恢复选中的交付项（优先从该 run）
    state.selectedDeliverableId = saved?.projectId === projectId && saved.deliverableId
      ? saved.deliverableId : null;

    // 找 active run：优先进行中的任务，否则最新终态
    state.activeRun = findActiveRun(state.runs);

    renderHeader();
    renderSteps();

    // 如果有 run，加载它的详情（versions / reports / exports），并启动 SSE/polling
    if (state.activeRun) {
      await loadRunExtras(state.activeRun.id);
      if (!runTerminal.has(state.activeRun.status)) {
        startEventLoop(state.activeRun.id);
      }
      restoreSelectedDeliverable();
      renderDeliverables();
      renderCenter();
      renderQA();
      renderAdvanced();
      renderExport();
    } else {
      // 没有 run：只渲染步骤引导
      renderDeliverables(true); // 显示空态引导
      renderCenter(true);
      renderQA(true);
      renderAdvanced(true);
      renderExport(true);
    }

    $('#wb-project-subtitle').textContent = state.activeRun
      ? `${state.project.name} · ${state.project.sku} · 当前任务 ${state.activeRun.id}`
      : `${state.project.name} · ${state.project.sku} · 还没有生产任务`;
    persistSelection();
  } catch (error) {
    if (error instanceof ApiFailure) {
      state.toast(`打开工作台失败：${error.message}`);
    } else {
      console.error('[workbench] 打开失败', error);
      state.toast(`打开失败：${error.message ?? error}`);
    }
    $('#wb-project-title').textContent = '打开失败';
    $('#wb-project-subtitle').textContent = '点击"← 商品项目"返回列表';
  }
}

function closeWorkbench() {
  clearPolling();
  closeSSE();
  persistSelection();
  state.activeRun = null;
  showWorkbench(false);
}

function showWorkbench(show) {
  const panel = $('#workbench-view');
  if (!panel) return;
  panel.hidden = !show;
  // 隐藏 demo project-view
  const demo = $('#project-view');
  if (demo) demo.hidden = true;
  // 切回 projects
  if (show) {
    // 标记 view-panel 为 workbench
    document.querySelectorAll('.view[data-view-panel], .project-view').forEach(el => {
      el.classList.remove('active');
      el.hidden = true;
    });
    panel.classList.add('active');
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => btn.classList.remove('active'));
  } else {
    document.querySelectorAll('.view[data-view-panel]').forEach(el => el.hidden = false);
  }
}

function findActiveRun(runs) {
  if (!runs?.length) return null;
  // 先找进行中
  const active = runs.find(r => !runTerminal.has(r.status));
  if (active) return active;
  // 否则拿更新时间最近的终态
  return [...runs].sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)))[0];
}

// ---------- 步骤条 ----------
function renderHeader() {
  if (!state.project) return;
  $('#wb-project-title').textContent = `${state.project.name}（${state.project.sku}）`;
  const pill = $('#wb-status-pill');
  if (state.activeRun) {
    const s = state.activeRun.status;
    const cls = runTerminal.has(s)
      ? (s === 'completed' ? 'ok' : (s === 'failed' || s === 'cancelled' ? 'red' : 'amber'))
      : 'blue';
    pill.className = `wb-status ${cls}`;
    pill.textContent = runStatusLabel[s] ?? s;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

function renderSteps() {
  const project = state.project;
  const specs = state.specs;
  const readiness = project?.readiness ?? {};
  const truthDone = (project?.truth_head_version ?? 0) > 0;
  const assetsDone = (project?.active_asset_count ?? 0) > 0;
  const specDone = specs.some(s => (s.validity?.validity ?? 'current') === 'current');
  const runDone = state.activeRun && runTerminal.has(state.activeRun.status);

  const steps = [
    { id: 'upload', label: '上传素材', done: assetsDone },
    { id: 'truth', label: '核对商品事实', done: truthDone && readiness.can_start_production !== false },
    { id: 'spec', label: '选效果/生产配置', done: specDone },
    { id: 'generate', label: '确认报价 → 生成', done: Boolean(state.activeRun) },
    { id: 'qa', label: '检查与修订', done: runDone },
    { id: 'export', label: '下载套图', done: runDone && (state.activeRun?.delivery_completeness?.complete ?? false) },
  ];
  // 找出当前步骤：第一个未 done 的
  const currentIdx = Math.max(0, steps.findIndex(s => !s.done));
  $('#wb-steps').innerHTML = steps.map((step, i) => `
    <div class="wb-step ${step.done ? 'done' : (i === currentIdx ? 'current' : '')}">
      <span class="wb-step-icon">${step.done ? '✓' : i + 1}</span>
      ${escapeHtml(step.label)}
    </div>`).join('');
}

// ---------- 加载 run 附加详情 ----------
async function loadRunExtras(runId) {
  try {
    const [versions, reports, exports, records] = await Promise.all([
      api.listRunVersions(runId).catch(() => ({ versions: [] })),
      api.listQualityReports(runId).catch(() => ({ reports: [] })),
      api.listExports({ runId }).catch(() => ({ exports: [] })),
      api.listGenerationRecords(runId).catch(() => ({ records: [] })),
    ]);
    state.versions = versions.versions ?? [];
    state.reports = reports.reports ?? [];
    state.exports = exports.exports ?? [];
    state.generationRecords = records.records ?? [];
  } catch (error) {
    console.error('[workbench] 加载 run 附加失败', error);
  }
}

// ---------- 交付项渲染 ----------
function renderDeliverables(empty = false) {
  const holder = $('#wb-deliverables');
  const progress = $('#wb-delivery-progress');
  if (empty || !state.activeRun) {
    holder.innerHTML = '<p class="real-hint">还没有生产任务。点击右上「生成/继续制作」开始。</p>';
    progress.textContent = '';
    return;
  }
  const deliverables = state.activeRun.deliverables ?? [];
  const expected = state.activeRun.delivery_completeness?.expected_units ?? deliverables.reduce((s, d) => s + (d.count || 1), 0);
  const produced = state.activeRun.delivery_completeness?.produced_units ?? deliverables.filter(d => d.status === 'succeeded').reduce((s, d) => s + (d.count || 1), 0);
  progress.textContent = `${produced}/${expected}`;

  holder.innerHTML = deliverables.map(item => {
    const version = state.versions.find(v => v.deliverable_id === item.deliverable_id && v.id === item.active_version_id)
      ?? state.versions.find(v => v.deliverable_id === item.deliverable_id);
    const report = state.reports.find(r => r.id === version?.report_id) ?? null;
    const qual = report?.decision ?? report?.human_decision ?? item.status;
    const qualLabel = qual === 'succeeded' || qual === 'publishable' ? '已通过'
      : qual === 'needs_review' ? '待复核'
      : qual === 'blocked' || qual === 'failed' ? '阻断'
      : qual === 'running' || qual === 'queued' ? '生成中'
      : '待开始';
    const statusClass = qual === 'succeeded' || qual === 'publishable' ? 'done'
      : qual === 'needs_review' ? 'review'
      : qual === 'blocked' || qual === 'failed' ? 'fail'
      : qual === 'running' || qual === 'evaluating' ? 'running'
      : 'wait';
    const active = state.selectedDeliverableId === item.deliverable_id ? ' active' : '';
    const count = (item.count || 1) > 1 ? ` ×${item.count}` : '';
    return `<button class="wb-deliverable${active}" data-deliverable-id="${escapeHtml(item.deliverable_id)}">
      <span class="wb-deliverable-status ${statusClass}">${statusClass === 'done' ? '✓' : statusClass === 'fail' ? '×' : statusClass === 'review' ? '!' : statusClass === 'running' ? '…' : '○'}</span>
      <span class="wb-deliverable-info">
        <b>${escapeHtml(item.label ?? item.deliverable_id)}${escapeHtml(count)}</b>
        <small>${escapeHtml(qualLabel)}${item.width ? ` · ${item.width}×${item.height}` : ''}</small>
      </span>
    </button>`;
  }).join('');
}

function onDeliverableClick(event) {
  const btn = event.target.closest('.wb-deliverable');
  if (!btn) return;
  const deliverableId = btn.dataset.deliverableId;
  selectDeliverable(deliverableId);
}

function restoreSelectedDeliverable() {
  if (!state.activeRun) return;
  const ids = state.activeRun.deliverables?.map(d => d.deliverable_id) ?? [];
  if (state.selectedDeliverableId && ids.includes(state.selectedDeliverableId)) return;
  // 自动选第一个有 active_version 的
  const first = state.activeRun.deliverables?.find(d => d.active_version_id) ?? state.activeRun.deliverables?.[0];
  if (first) state.selectedDeliverableId = first.deliverable_id;
}

function selectDeliverable(deliverableId) {
  state.selectedDeliverableId = deliverableId;
  state.selectedVersionId = null; // 每次选新交付项重置版本
  const deliverable = state.activeRun?.deliverables?.find(d => d.deliverable_id === deliverableId);
  if (deliverable?.active_version_id) {
    state.selectedVersionId = deliverable.active_version_id;
  } else {
    const firstVersion = state.versions.find(v => v.deliverable_id === deliverableId);
    if (firstVersion) state.selectedVersionId = firstVersion.id;
  }
  const version = state.versions.find(v => v.id === state.selectedVersionId);
  state.selectedReportId = version?.report_id ?? null;
  renderDeliverables();
  renderCenter();
  renderQA();
  persistSelection();
}

// ---------- 中央画布 ----------
function renderCenter(empty = false) {
  const emptyHint = $('#wb-empty-hint');
  const dual = $('#wb-dual');
  const toolbar = $('#wb-canvas-title');
  const versionSwitch = $('#wb-version-switch');
  const meta = $('#wb-canvas-meta');
  const reviseBtn = $('#wb-revise-btn');
  const downloadActive = $('#wb-download-active');

  reviseBtn.hidden = true;
  downloadActive.hidden = true;
  versionSwitch.hidden = true;
  dual.hidden = true;

  if (empty || !state.activeRun || !state.selectedDeliverableId) {
    emptyHint.hidden = false;
    toolbar.textContent = '选择一个交付项查看';
    meta.innerHTML = '';
    return;
  }
  emptyHint.hidden = true;

  const deliverable = state.activeRun.deliverables.find(d => d.deliverable_id === state.selectedDeliverableId);
  const versionsOfThis = state.versions.filter(v => v.deliverable_id === state.selectedDeliverableId);
  if (versionsOfThis.length === 0) {
    toolbar.textContent = deliverable?.label ?? state.selectedDeliverableId;
    meta.innerHTML = `<div><b>${escapeHtml(deliverable?.label)}</b> 还没有版本产物（${escapeHtml(deliverable?.status ?? 'pending')}）</div>`;
    return;
  }

  // 渲染版本切换器
  const currentIdx = Math.max(0, versionsOfThis.findIndex(v => v.id === state.selectedVersionId));
  $('#wb-version-label').textContent = `${currentIdx + 1} / ${versionsOfThis.length}`;
  const currentVersion = versionsOfThis[currentIdx];
  const isActive = deliverable?.active_version_id === currentVersion.id;
  $('#wb-version-activate').hidden = isActive;
  versionSwitch.hidden = false;

  toolbar.textContent = `${deliverable.label} · V${currentIdx + 1} ${isActive ? '（当前选用）' : ''}`;

  // 渲染图片（用服务端存储路径，mock provider 返回 data URI 或 blob）
  const imageUrl = buildVersionImageUrl(currentVersion);
  $('#wb-current .wb-image-holder').innerHTML = `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(deliverable.label)}">`;
  $('#wb-current-caption').textContent = isActive ? '当前选用版本' : '历史版本';

  // 原图对比
  const originalAsset = findOriginalAsset(deliverable);
  if (state.compareMode && originalAsset) {
    $('#wb-original .wb-image-holder').innerHTML = `<img src="${escapeHtml(originalAsset.url)}" alt="原图">`;
    $('#wb-original figcaption').textContent = `原图 · ${originalAsset.filename ?? '参考素材'}`;
    dual.hidden = false;
  } else {
    $('#wb-original .wb-image-holder').innerHTML = '';
    dual.hidden = false; // 但只显示 current 一侧 → 简化：单时显示 current 全屏
    // 单图模式：让 dual 里只有 current 可见
    $('#wb-original').style.display = state.compareMode ? '' : 'none';
    $('#wb-current').style.flex = state.compareMode ? '1' : '1';
  }

  const report = state.reports.find(r => r.id === currentVersion.report_id);
  const qual = report?.decision ?? '—';
  meta.innerHTML = `
    <div><b>${escapeHtml(deliverable.label)}</b> · ${deliverable.width}×${deliverable.height}${deliverable.ratio ? ` · ${deliverable.ratio}` : ''}</div>
    <div>版本 <b>${currentIdx + 1}/${versionsOfThis.length}</b> · 质量 <b>${escapeHtml(qualityStatusLabel[qual] ?? qual)}</b>${isActive ? ' · 当前选用' : ''}</div>
  `;

  if (runTerminal.has(state.activeRun.status)) {
    // 修订按钮只在任务终态后才不会被新扣费覆盖；这里保留"局部修订"入口引导到重新执行 run
    reviseBtn.hidden = false;
    downloadActive.hidden = false;
  }
}

function buildVersionImageUrl(version) {
  // version 字段来自 jobs.activateVersion / listRunVersions，包含 hash/format
  // 服务端生成的文件通常存储在 store 里：/api/assets/<id>/content
  // 这里简化：若 version 有 url 直接用，否则按 hash 猜（真实实现需 store 提供读接口）
  if (version?.url) return version.url;
  // fallback：如果这是 demo/mock provider，run.deliverables 里的 attempt 可能给了 output_file
  return '';
}

function findOriginalAsset(deliverable) {
  // 原始素材来自 project.assets；deliverable 里没有直接关联，这里返回 null
  // 真实实现需从 run.subject_context.reference_images 或 project.active_assets 映射
  return null;
}

function toggleCompare() {
  state.compareMode = !state.compareMode;
  renderCenter();
}

function shiftVersion(delta) {
  const versions = state.versions.filter(v => v.deliverable_id === state.selectedDeliverableId);
  if (!versions.length) return;
  const currentIdx = Math.max(0, versions.findIndex(v => v.id === state.selectedVersionId));
  const next = Math.max(0, Math.min(versions.length - 1, currentIdx + delta));
  state.selectedVersionId = versions[next].id;
  const report = state.reports.find(r => r.id === versions[next].report_id);
  state.selectedReportId = report?.id ?? null;
  renderCenter();
  renderQA();
  persistSelection();
}

async function activateSelectedVersion() {
  if (!state.activeRun || !state.selectedVersionId) return;
  try {
    const result = await api.activateVersion(state.activeRun.id, state.selectedVersionId);
    state.activeRun = result.run;
    // 更新 versions：前端也反映 isActive
    state.versions = state.versions.map(v => ({
      ...v, active: v.id === state.selectedVersionId,
    }));
    state.toast('已切换选用版本');
    renderDeliverables();
    renderCenter();
  } catch (error) {
    state.toast(error instanceof ApiFailure ? error.message : String(error));
  }
}

// ---------- QA ----------
function renderQA(empty = false) {
  const holder = $('#wb-qa-checks');
  const reviewBlock = $('#wb-human-review');
  reviewBlock.hidden = true;

  if (empty || !state.activeRun || !state.selectedDeliverableId) {
    holder.innerHTML = '<p class="real-hint">选中交付项后这里会显示各项检查结果，包括需要你确认的 unknown 项。</p>';
    return;
  }
  const deliverable = state.activeRun.deliverables.find(d => d.deliverable_id === state.selectedDeliverableId);
  const version = state.versions.find(v => v.id === state.selectedVersionId);
  const report = state.reports.find(r => r.id === version?.report_id) ?? null;

  // 优先显示 report.checks；没有 report 时根据 deliverable.status 构造一条占位
  const checks = report?.checks ?? buildFallbackChecks(deliverable);
  holder.innerHTML = `<div class="wb-qa-summary">
      <b>质量判定</b>：${escapeHtml(qualityStatusLabel[report?.decision ?? deliverable?.status] ?? (report ? '无报告' : '待生成'))}
      ${report?.can_claim_platform_compliance === true ? ' · 已覆盖平台规则' : ''}
      ${report?.can_claim_platform_compliance === false ? ' · 平台规则未核验' : ''}
    </div>
    <div class="wb-qa-checks">${checks.map(c => renderCheckRow(c)).join('')}</div>`;

  // 人工复核入口：当 decision 是 needs_review 时显示
  if (report?.decision === 'needs_review' || report?.human_decision === 'needs_review') {
    reviewBlock.hidden = false;
    $('#wb-review-note').value = report?.human_review?.note ?? '';
  }
}

function renderCheckRow(check) {
  const icon = check.status === 'pass' ? '✓' : check.status === 'fail' ? '×' : '?';
  const cls = check.status === 'pass' ? 'pass' : check.status === 'fail' ? 'fail' : (check.status === 'unknown' ? 'unknown' : 'review');
  const hardGate = check.hard_gate === true ? ' hard-gate' : '';
  return `<div class="wb-qa-row ${cls}${hardGate}">
    <span class="wb-check-icon">${icon}</span>
    <div class="wb-check-body">
      <b>${escapeHtml(check.label ?? check.code ?? '未命名检查')}</b>
      <small>
        ${escapeHtml(check.status_label ?? checkStatusLabel[check.status] ?? check.status)}
        ${check.severity ? ` · 严重度 ${escapeHtml(check.severity)}` : ''}
        ${check.required ? ' · 必过' : ''}
      </small>
      ${check.evidence ? `<small class="wb-check-evidence">证据：${escapeHtml(typeof check.evidence === 'string' ? check.evidence : JSON.stringify(check.evidence))}</small>` : ''}
      ${check.suggested_action ? `<small>建议：${escapeHtml(check.suggested_action)}</small>` : ''}
    </div>
  </div>`;
}

function buildFallbackChecks(deliverable) {
  if (!deliverable) return [];
  return [{ code: 'NO_REPORT', label: '质量报告', status: 'unknown', severity: 'info', hard_gate: false,
    evidence: deliverable.status, suggested_action: deliverable.status === 'pending' ? '等待生成后自动出报告' : '刷新任务看报告' }];
}

function onReviewDecisionClick(event) {
  const btn = event.target.closest('[data-review-decision]');
  if (!btn) return;
  const decision = btn.dataset.reviewDecision;
  void submitReview(decision);
}
async function submitReview(decision) {
  if (!state.selectedReportId) { state.toast('没有可复核的报告'); return; }
  const note = $('#wb-review-note')?.value?.trim() || null;
  try {
    const result = await api.reviewQualityReport(state.selectedReportId, { decisions: [decision], note });
    // 更新本地 reports
    const updated = result?.report ?? null;
    if (updated) {
      state.reports = state.reports.map(r => r.id === updated.id ? updated : r);
      // 同时刷新 run
      if (state.activeRun) {
        const run = await api.getRun(state.activeRun.id).then(r => r.run).catch(() => null);
        if (run) {
          state.activeRun = run;
          // 刷新 versions / reports / deliverables
          await loadRunExtras(state.activeRun.id);
        }
      }
    }
    state.toast('已提交复核');
    renderDeliverables();
    renderCenter();
    renderQA();
  } catch (error) {
    state.toast(error instanceof ApiFailure ? error.message : String(error));
  }
}

// ---------- 高级信息 ----------
function renderAdvanced(empty = false) {
  const runMeta = $('#wb-run-meta');
  const budgetMeta = $('#wb-budget-meta');
  const supplierMeta = $('#wb-supplier-meta');
  const eventLog = $('#wb-event-log');
  if (empty || !state.activeRun) {
    runMeta.innerHTML = '<div>还没有任务。</div>';
    budgetMeta.innerHTML = '<div>—</div>';
    supplierMeta.innerHTML = '<div>—</div>';
    eventLog.innerHTML = '';
    return;
  }
  const run = state.activeRun;
  runMeta.innerHTML = `
    <div>任务 ID：<b>${escapeHtml(run.id)}</b></div>
    <div>状态：<b>${escapeHtml(runStatusLabel[run.status] ?? run.status)}</b></div>
    <div>当前轮次：${run.iteration ?? 1} / ${run.max_attempts ?? '—'}</div>
    <div>创建：${formatTime(run.created_at)} · 更新：${formatTime(run.updated_at)}</div>
    ${run.terminal_reason ? `<div>终态原因：<b>${escapeHtml(run.terminal_reason)}</b></div>` : ''}
    <div>完整交付：${run.delivery_completeness?.complete ? '✓ 是' : `✗ 否（${run.delivery_completeness?.produced_units ?? 0}/${run.delivery_completeness?.expected_units ?? 0}）`}</div>
  `;
  const budget = run.budget ?? {};
  budgetMeta.innerHTML = `
    <div>预留额度：<b>${budget.reserved_credits ?? 0}</b></div>
    <div>已结算：<b>${budget.captured_credits ?? 0}</b></div>
    <div>已释放：<b>${budget.released_credits ?? 0}</b></div>
  `;
  const supplier = run.supplier_cost ?? {};
  supplierMeta.innerHTML = `
    <div>供应商调用：${supplier.records ?? 0} 条（成功 ${supplier.succeeded ?? 0} · 失败 ${supplier.failed ?? 0}）</div>
    <div>内部消耗：<b>${supplier.internal_credits_charged ?? 0}</b> 额度</div>
    <div>是否回传供应商成本：${supplier.provider_cost_reported ? '是' : '未回传'}</div>
    ${supplier.note ? `<div class="real-note">${escapeHtml(supplier.note)}</div>` : ''}
    ${state.generationRecords.length > 0 ? `<div class="real-note">最近记录：</div>
      <ol style="margin:4px 0 0 18px;padding:0;font-size:12px;color:#2A2420">
        ${state.generationRecords.slice(0, 5).map(r => `
          <li>attempt_id=${escapeHtml(r.attempt_id ?? r.id)} · ${escapeHtml(r.status)} · 内部 ${escapeHtml(r.cost?.internal_credits ?? 0)} · ${formatTime(r.created_at)}</li>
        `).join('')}
      </ol>` : ''}
  `;
  const tail = run.events_tail ?? [];
  eventLog.innerHTML = tail.map(e => `<li>#${e.sequence ?? '—'} <b>${escapeHtml(e.stage)}</b> · ${escapeHtml(e.status)} · ${formatTime(e.timestamp)}</li>`).join('');
  if (state.eventsInProgress?.length) {
    eventLog.innerHTML += state.eventsInProgress.map(e => `<li class="running">#${e.sequence} <b>${escapeHtml(e.stage)}</b> · ${escapeHtml(e.status)}</li>`).join('');
  }
}

// ---------- 导出 ----------
function renderExport(empty = false) {
  const chip = $('#wb-completeness');
  const completeBtn = $('#wb-export-complete');
  const partialBtn = $('#wb-export-partial');
  const history = $('#wb-export-history');
  if (empty || !state.activeRun) {
    chip.textContent = '还没有任务';
    chip.className = 'wb-chip';
    completeBtn.hidden = true;
    partialBtn.hidden = true;
    history.innerHTML = '';
    return;
  }
  const run = state.activeRun;
  const dc = run.delivery_completeness ?? {};
  if (dc.complete) {
    chip.textContent = `完整交付 · ${dc.produced_units}/${dc.expected_units}`;
    chip.className = 'wb-chip ok';
  } else {
    chip.textContent = `部分交付 · ${dc.produced_units}/${dc.expected_units}（缺 ${dc.missing_units ?? 0} 项）`;
    chip.className = 'wb-chip warn';
  }
  const terminal = runTerminal.has(run.status);
  // 完整包按钮：必须 complete=true 且 terminal
  completeBtn.hidden = !(terminal && dc.complete);
  // 部分包按钮：terminal 就可以
  partialBtn.hidden = !terminal;
  history.innerHTML = state.exports.length === 0
    ? '<p class="real-hint">暂无导出记录</p>'
    : `<ul>${state.exports.map(exp => `
        <li>
          <a href="${api.downloadExportUrl(exp.id)}" download="${escapeHtml(exp.package_filename)}">${escapeHtml(exp.package_filename)}</a>
          · ${escapeHtml(exp.scope)} · ${formatTime(exp.created_at)}
          ${exp.missing?.length ? ` · <b>缺项 ${exp.missing.length}</b>` : ''}
        </li>`).join('')}</ul>`;
}

async function requestExport(scope) {
  if (!state.activeRun) return;
  try {
    const result = await api.createExport(state.activeRun.id, { scope });
    state.toast(`已创建导出：${result.export.package_filename}`);
    await loadRunExtras(state.activeRun.id);
    renderExport();
  } catch (error) {
    state.toast(error instanceof ApiFailure ? error.message : String(error));
  }
}

// ---------- 创建/继续 run ----------
async function handleStartOrContinue() {
  // 如果已有非终态 run，直接恢复 SSE 即可
  if (state.activeRun && !runTerminal.has(state.activeRun.status)) {
    state.toast('正在恢复任务…');
    await loadRunExtras(state.activeRun.id);
    startEventLoop(state.activeRun.id);
    return;
  }
  // 否则尝试创建新 run
  if (!state.project) { state.toast('没有项目'); return; }
  const spec = (state.specs || []).find(s => (s.validity?.validity ?? 'current') === 'current') ?? state.specs?.[0];
  if (!spec) { state.toast('请先在"生产配置"里冻结一个快照'); return; }
  const btn = $('#wb-btn-start');
  btn.disabled = true;
  btn.textContent = '正在生成报价…';
  try {
    const quote = await api.createQuote({ project_id: state.project.id });
    state.idempotencyKey = `workbench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    btn.textContent = '正在启动任务…';
    const result = await api.createRun({
      project_id: state.project.id,
      quote_id: quote.quote_id,
      spec_version: spec.version,
    }, state.idempotencyKey);
    state.activeRun = result.run;
    state.runs = [state.activeRun, ...state.runs.filter(r => r.id !== state.activeRun.id)];
    btn.textContent = '任务已启动';
    state.toast('任务已启动，正在恢复实时状态…');
    await loadRunExtras(state.activeRun.id);
    restoreSelectedDeliverable();
    renderHeader();
    renderSteps();
    renderDeliverables();
    renderCenter();
    renderQA();
    renderAdvanced();
    renderExport();
    startEventLoop(state.activeRun.id);
  } catch (error) {
    state.toast(error instanceof ApiFailure ? error.message : String(error));
    btn.textContent = '生成/继续制作';
  } finally {
    btn.disabled = false;
  }
}

// ---------- 事件流：SSE + 轮询双保险 ----------
function startEventLoop(runId) {
  closeSSE();
  clearPolling();
  state.lastEventId = 0;
  state.sseReconnectAttempts = 0;
  tryStartSSE(runId);
  // 兜底：不管 SSE 连没连，都启动一个 15s 轮询
  state.pollTimer = globalThis.setInterval(() => pollRun(runId), state.pollIntervalMs);
}

function tryStartSSE(runId) {
  if (typeof EventSource !== 'function') return;
  const source = api.runEvents(runId, { lastEventId: state.lastEventId });
  state.source = source;
  source.addEventListener('message', event => {
    let payload = null;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload?.terminal) {
      // 终态：停掉 SSE 和 轮询
      closeSSE();
      clearPolling();
      void refreshRun(runId);
      return;
    }
    if (!payload || typeof payload.sequence !== 'number') return;
    if (payload.sequence <= state.lastEventId) return; // 去重
    state.lastEventId = payload.sequence;
    // 追加到内存缓存
    state.eventsInProgress = state.eventsInProgress ?? [];
    state.eventsInProgress.push(payload);
    // 事件触发后也拉一次 run 快照，保证 deliverables/versions 最新
    void refreshRun(runId, { keepSSE: true });
  });
  source.addEventListener('error', () => {
    closeSSE();
    // 轮询兜底已开；每 45s 尝试重连一次 SSE
    state.sseReconnectAttempts += 1;
    if (state.sseReconnectAttempts % 3 === 0) {
      // 重连用当前 lastEventId
      globalThis.setTimeout(() => {
        if (state.activeRun?.id === runId) tryStartSSE(runId);
      }, 500);
    }
  });
}

function closeSSE() {
  if (state.source) { try { state.source.close(); } catch { /* ignore */ } state.source = null; }
}

function clearPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function pollRun(runId) {
  if (!state.activeRun || state.activeRun.id !== runId) return;
  try {
    await refreshRun(runId, { keepSSE: true });
  } catch (error) {
    console.warn('[workbench] 轮询失败', error?.message ?? error);
  }
}

async function refreshRun(runId, { keepSSE = false } = {}) {
  try {
    const result = await api.getRun(runId);
    state.activeRun = result.run;
    state.runs = state.runs.map(r => r.id === runId ? result.run : r);
    await loadRunExtras(runId);
    renderHeader();
    renderSteps();
    renderDeliverables();
    renderCenter();
    renderQA();
    renderAdvanced();
    renderExport();
    if (runTerminal.has(state.activeRun.status)) {
      closeSSE();
      clearPolling();
    }
  } catch (error) {
    console.warn('[workbench] refreshRun 失败', error?.message ?? error);
  } finally {
    if (!keepSSE) closeSSE();
  }
}

// ---------- 持久化 ----------
function persistSelection() {
  if (!state.projectId) return;
  const payload = {
    projectId: state.projectId,
    deliverableId: state.selectedDeliverableId ?? null,
    versionId: state.selectedVersionId ?? null,
    lastRunId: state.activeRun?.id ?? null,
    ts: Date.now(),
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); } catch { /* ignore */ }
}
function safeReadLS() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); } catch { return null; }
}

// ---------- 自启动 ----------
function showToast(msg) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = msg;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 3000);
}

if (typeof document !== 'undefined') initWorkbench({ toast: showToast });
