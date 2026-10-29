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
  assets: [],
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
  // 模块06：修改工作台状态（文字排版修改 / 前后对比 / 历史版本 / 指定图片重生成）
  edit: {
    open: false,
    deliverableId: null,
    layersPayload: null,     // GET text-layers 的返回 {version_id, layers, limits, ...}
    layersError: null,
    loading: false,
    result: null,            // POST text-edits 成功结果 {version, previous_version_id, report, issues, activated}
    beforeVersionId: null,   // 前后对比的“修改前”版本
    regen: null,             // {childRunId, sourceRunId, beforeActiveId}
    regenTimer: null,
  },
  // 新建 run 时的幂等键（工作台生命周期内固定，离开就重置）
  idempotencyKey: null,
  // E02：当前交付物的版本依赖（系统编译 + 人工关联）
  deps: { deliverableId: null, payload: null, error: null, loading: false },
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
  $('#wb-revise-btn')?.addEventListener('click', () => openSpec(state.projectId));
  $('#wb-download-active')?.addEventListener('click', () => void requestExport('partial'));
  // 模块06：修改工作台
  $('#wb-edit-open')?.addEventListener('click', () => enterEditMode());
  $('#wb-edit-close')?.addEventListener('click', closeEditMode);
  $('#wb-edit-apply')?.addEventListener('click', () => void applyTextEditsSubmit());
  $('#wb-regenerate')?.addEventListener('click', () => void requestRegenerate());
  $('#wb-edit-thumbs')?.addEventListener('click', event => {
    const btn = event.target.closest('[data-edit-thumb]');
    if (btn) switchEditDeliverable(btn.dataset.editThumb);
  });
  $('#wb-edit-versions')?.addEventListener('click', event => {
    const btn = event.target.closest('[data-edit-activate]');
    if (btn) void activateEditVersion(btn.dataset.editActivate);
  });
  $('#wb-edit-error')?.addEventListener('click', event => {
    if (event.target.closest('[data-edit-retry]')) {
      $('#wb-edit-error').textContent = '';
      void loadTextLayers();
    }
  });
  $('#wb-edit-layers')?.addEventListener('input', updateApplyState);
  // E02：作品依赖面板（人工增删都需 reason，系统依赖不可删）
  $('#wb-dep-body')?.addEventListener('submit', event => void onDependencySubmit(event));
  $('#wb-dep-body')?.addEventListener('click', onDependencyClick);
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
  closeEditMode();
  showWorkbench(true);
  $('#wb-project-title').textContent = '正在打开项目…';
  $('#wb-project-subtitle').textContent = '读取项目、任务与交付状态';
  $('#wb-deliverables').innerHTML = '<div class="loading-line"></div>';
  $('#wb-empty-hint').hidden = true;
  try {
    const [detail, specsPayload, runsPayload] = await Promise.all([
      api.getProject(projectId),
      api.listSpecs(projectId).catch(() => ({ specs: [] })),
      api.listRunsByProject(projectId).catch(() => ({ runs: [] })),
    ]);
    state.project = detail.project;
      state.assets = detail.assets ?? [];
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
      void loadDependencies();
    } else {
      // 没有 run：只渲染步骤引导
      renderDeliverables(true); // 显示空态引导
      renderCenter(true);
      renderQA(true);
      renderAdvanced(true);
      renderExport(true);
      renderDependencies(true);
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
    // 模块06：首屏错误带重试按钮，而不是只靠 toast 一闪而过
    const hint = $('#wb-empty-hint');
    if (hint) {
      hint.hidden = false;
      hint.innerHTML = `<div class="state-note danger"><div><b>打开工作台失败</b><br>${escapeHtml(error instanceof ApiFailure ? error.message : String(error))}
        <div class="state-actions"><button type="button" class="secondary" id="wb-retry-open">重试</button></div></div></div>`;
      $('#wb-retry-open')?.addEventListener('click', () => void openWorkbench(projectId));
    }
  }
}

function closeWorkbench() {
  clearPolling();
  closeSSE();
  closeEditMode();
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
      if (el === panel) return;
      el.classList.remove('active');
      el.hidden = true;
    });
    panel.classList.add('active');
    panel.hidden = false;
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
  const assetsDone = state.assets.some(a => a.role_status === 'active');
  const specDone = specs.some(s => (s.validity?.validity ?? 'current') === 'current');
  const runDone = state.activeRun && runTerminal.has(state.activeRun.status);

  const steps = [
    { id: 'upload', label: '上传素材', done: assetsDone },
    { id: 'truth', label: '核对商品事实', done: truthDone && readiness.can_start_production !== false },
    { id: 'spec', label: '选效果/生产配置', done: specDone },
    { id: 'generate', label: '确认报价 → 生成', done: Boolean(state.activeRun) },
    { id: 'qa', label: '检查与修订', done: runDone },
    { id: 'export', label: '下载套图', done: state.exports.length > 0 },
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
  $('#wb-qa-status').textContent = qualityStatusLabel[state.activeRun.quality_status] ?? '待检查';
  $('#wb-qa-note').textContent = '生成完成后仍需通过各项检查才能交付';
  const expected = state.activeRun.delivery_completeness?.expected_units ?? deliverables.reduce((s, d) => s + (d.count || 1), 0);
  const produced = state.activeRun.delivery_completeness?.produced_units ?? deliverables.filter(d => d.status === 'succeeded').reduce((s, d) => s + (d.count || 1), 0);
  progress.textContent = `${produced}/${expected}`;

  holder.innerHTML = deliverables.map(item => {
    const version = state.versions.find(v => v.deliverable_id === item.deliverable_id && v.id === item.active_version_id)
      ?? state.versions.find(v => v.deliverable_id === item.deliverable_id);
    const report = state.reports.find(r => r.id === version?.report_id) ?? null;
    const qual = report?.decision ?? report?.human_decision ?? item.status;
    const qualLabel = qual === 'publishable' ? '已通过'
      : qual === 'succeeded' ? '待检查'
      : qual === 'needs_review' ? '待复核'
      : qual === 'blocked' || qual === 'failed' ? '阻断'
      : qual === 'running' || qual === 'queued' ? '生成中'
      : '待开始';
    const statusClass = qual === 'publishable' ? 'done'
      : qual === 'succeeded' ? 'review'
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
  if (state.selectedDeliverableId && ids.includes(state.selectedDeliverableId)) {
    const selected = state.versions.find(v => v.id === state.selectedVersionId && v.deliverable_id === state.selectedDeliverableId)
      ?? state.versions.find(v => v.deliverable_id === state.selectedDeliverableId && v.active);
    state.selectedVersionId = selected?.id ?? null; state.selectedReportId = selected?.report_id ?? null;
    return;
  }
  // 自动选第一个有 active_version 的
  const first = state.activeRun.deliverables?.find(d => d.active_version_id) ?? state.activeRun.deliverables?.[0];
  if (first) {
    state.selectedDeliverableId = first.deliverable_id;
    const version = state.versions.find(v => v.id === first.active_version_id);
    state.selectedVersionId = version?.id ?? null; state.selectedReportId = version?.report_id ?? null;
  }
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
  void loadDependencies();
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
  const editOpenBtn = $('#wb-edit-open');

  reviseBtn.hidden = true;
  downloadActive.hidden = true;
  editOpenBtn.hidden = true;
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
  $('#wb-original').style.display = state.compareMode && originalAsset ? '' : 'none';
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
    reviseBtn.hidden = false; reviseBtn.textContent = '调整排版后重新制作';
    downloadActive.hidden = qual !== 'publishable'; downloadActive.textContent = '创建已通过图片的下载包';
    // 模块06：任务终态且有版本时提供「修改此张」入口
    editOpenBtn.hidden = versionsOfThis.length === 0;
  }
}

function versionImageUrl(runId, versionId) {
  return `/api/runs/${encodeURIComponent(runId)}/versions/${encodeURIComponent(versionId)}/content`;
}

function buildVersionImageUrl(version) {
  // version 字段来自 jobs.activateVersion / listRunVersions，包含 hash/format
  // 服务端生成的文件通常存储在 store 里：/api/assets/<id>/content
  // 这里简化：若 version 有 url 直接用，否则按 hash 猜（真实实现需 store 提供读接口）
  if (version?.url) return version.url;
  // fallback：如果这是 demo/mock provider，run.deliverables 里的 attempt 可能给了 output_file
  return versionImageUrl(state.activeRun.id, version.id);
}

function findOriginalAsset(deliverable) {
  // 原始素材来自 project.assets；deliverable 里没有直接关联，这里返回 null
  // 真实实现需从 run.subject_context.reference_images 或 project.active_assets 映射
  const asset = state.assets.find(a => a.role === 'subject' && a.role_status === 'active');
  return asset ? { ...asset, url: `/api/projects/${encodeURIComponent(state.projectId)}/assets/${encodeURIComponent(asset.id)}/content` } : null;
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
  state.selectedReportId = report?.id ?? null;

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
  check = { ...check, status: check.effective_status ?? check.status };
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
      ${check.status === 'unknown' && check.adjudicable ? `<label><input type="checkbox" data-review-check="${escapeHtml(check.code)}">我已对照素材核对这一项</label>` : ''}
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
  const evidence = $('#wb-review-evidence')?.value?.trim() || '';
  if (decision === 'needs_review') { state.toast('保留待复核，不改变检查结论'); return; }
  const selected = [...document.querySelectorAll('[data-review-check]:checked')];
  if (!selected.length || !note || !evidence) { state.toast('请勾选已核对的检查项，并填写复核理由和对照依据'); return; }
  const decisions = selected.map(input => ({ code: input.dataset.reviewCheck,
    decision: decision === 'blocked' ? 'fail' : 'pass', reason: note, evidence }));
  try {
    const result = await api.reviewQualityReport(state.selectedReportId, { decisions, note });
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
    renderExport();
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
      <ol style="margin:4px 0 0 18px;padding:0;font-size:12px;color:#263A32">
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

// ---------- E02：作品依赖 ----------
const DEP_KIND_LABELS = {
  fact: '事实', asset: '素材', sku: 'SKU', brand: '品牌套件', text_layer: '文字层',
};

async function loadDependencies() {
  const run = state.activeRun;
  const deliverableId = state.selectedDeliverableId;
  if (!run || !deliverableId) {
    state.deps = { deliverableId: null, payload: null, error: null, loading: false };
    renderDependencies(true);
    return;
  }
  const keepPayload = state.deps.deliverableId === deliverableId ? state.deps.payload : null;
  state.deps = { deliverableId, payload: keepPayload, error: null, loading: true };
  renderDependencies();
  try {
    const payload = await api.listDeliverableDependencies(run.id, deliverableId);
    if (state.activeRun?.id !== run.id || state.selectedDeliverableId !== deliverableId) return;
    state.deps = { deliverableId, payload, error: null, loading: false };
  } catch (error) {
    if (state.selectedDeliverableId !== deliverableId) return;
    state.deps = {
      deliverableId, payload: null, loading: false,
      error: { code: error?.code ?? 'REQUEST_FAILED', message: error instanceof ApiFailure ? error.message : String(error) },
    };
  }
  renderDependencies();
}

function renderDependencies(empty = false) {
  const holder = $('#wb-dep-body');
  if (!holder) return;
  if (empty || !state.activeRun || !state.selectedDeliverableId) {
    holder.innerHTML = '<p class="real-hint">选中交付项后，这里显示该图版本的依赖来源与人工关联。</p>';
    return;
  }
  const deps = state.deps;
  if (deps.deliverableId !== state.selectedDeliverableId) {
    holder.innerHTML = '<div class="loading-line"></div><p class="real-hint">正在读取依赖…</p>';
    return;
  }
  if (deps.error) {
    holder.innerHTML = `<div class="state-note danger"><div><b>无法读取依赖</b><br>${escapeHtml(deps.error.message ?? '')}
      <div class="state-actions"><button type="button" class="secondary" data-dep-reload>重试</button></div></div></div>`;
    return;
  }
  if (deps.loading && !deps.payload) {
    holder.innerHTML = '<div class="loading-line"></div><p class="real-hint">正在读取依赖…</p>';
    return;
  }
  const payload = deps.payload;
  if (!payload) {
    holder.innerHTML = '<p class="real-hint">还没有读取到依赖记录。</p>';
    return;
  }
  const versions = payload.versions ?? [];
  if (versions.length === 0) {
    holder.innerHTML = '<p class="real-hint">该交付物还没有版本，暂无依赖记录。</p>';
    return;
  }
  const options = versions.map(version =>
    `<option value="${escapeHtml(version.version_id)}"${version.version_id === payload.active_version_id ? ' selected' : ''}>V${version.number}${version.active ? '（当前选用）' : ''}</option>`).join('');
  holder.innerHTML = `${versions.map(version => renderDependencyVersion(version)).join('')}
    <form class="dep-form" data-dep-form>
      <div class="dep-form-row">
        <label>版本<select name="version_id">${options}</select></label>
        <label>类型<select name="kind">${Object.entries(DEP_KIND_LABELS).map(([value, label]) =>
          `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select></label>
        <label>引用<input name="ref" maxlength="200" placeholder="事实键 / 素材ID / SKU ID / 品牌套件ID / 文字层ID"></label>
      </div>
      <label>依据（必填）<input name="reason" maxlength="300" placeholder="为什么这张图与它有关，例如：包装同色系需沿用同一素材"></label>
      <label>备注<input name="note" maxlength="300" placeholder="可选"></label>
      <div class="dep-form-actions">
        <button type="submit" class="secondary">添加人工关联</button>
        <span class="real-hint">只登记关联，不改图、不扣费</span>
      </div>
    </form>
    <p class="dep-error" id="wb-dep-error" role="alert"></p>`;
}

function renderDependencyVersion(version) {
  const evidenceLabel = version.evidence === 'deterministic' ? '系统编译'
    : version.evidence === 'manual' ? '人工关联' : '未记录';
  const entries = (version.entries ?? []).map(entry => `<li class="dep-entry">
      <span class="dep-kind">${escapeHtml(DEP_KIND_LABELS[entry.kind] ?? entry.kind)}</span>
      <code>${escapeHtml(entry.ref)}</code>
      <span class="dep-evidence ${entry.evidence === 'deterministic' ? 'system' : 'manual'}">${entry.evidence === 'deterministic' ? '系统' : '人工'}</span>
      ${entry.note ? `<small>${escapeHtml(entry.note)}</small>` : ''}
      ${entry.reason ? `<small class="dep-reason">依据：${escapeHtml(entry.reason)}</small>` : ''}
      ${entry.evidence === 'manual'
        ? `<button type="button" class="text-button" data-dep-remove="${escapeHtml(`${entry.kind}:${entry.ref}`)}">移除</button>`
        : '<small class="dep-locked">系统编译，不可删除</small>'}
    </li>`).join('');
  return `<div class="dep-version${version.active ? ' active' : ''}">
    <div class="dep-version-head">
      <b>V${version.number}${version.active ? ' · 当前选用' : ''}</b>
      <span class="dep-evidence ${version.evidence === 'deterministic' ? 'system' : 'manual'}">${escapeHtml(evidenceLabel)}</span>
      <small>${formatTime(version.created_at)}</small>
    </div>
    ${entries ? `<ul class="dep-entries">${entries}</ul>` : '<p class="real-hint">该版本没有依赖记录（生成路径未提供）。</p>'}
  </div>`;
}

function onDependencyClick(event) {
  if (event.target.closest('[data-dep-reload]')) { void loadDependencies(); return; }
  const btn = event.target.closest('[data-dep-remove]');
  if (!btn) return;
  void removeManualDependency(btn);
}

async function removeManualDependency(btn) {
  const run = state.activeRun;
  const deliverableId = state.selectedDeliverableId;
  if (!run || !deliverableId) return;
  const raw = String(btn.dataset.depRemove ?? '');
  const sep = raw.indexOf(':');
  const kind = sep >= 0 ? raw.slice(0, sep) : raw;
  const ref = sep >= 0 ? raw.slice(sep + 1) : '';
  const reason = window.prompt('移除这条人工关联必须写明依据（不超过 300 字）：')?.trim();
  if (!reason) return;
  btn.disabled = true;
  try {
    await api.removeManualDependency(run.id, deliverableId, kind, ref, reason);
    state.toast('已移除人工关联；移除记录会保留');
    await loadDependencies();
  } catch (error) {
    const node = $('#wb-dep-error');
    if (node) node.textContent = error instanceof ApiFailure ? error.message : String(error);
    btn.disabled = false;
  }
}

async function onDependencySubmit(event) {
  const form = event.target;
  if (!form.matches?.('[data-dep-form]')) return;
  event.preventDefault();
  const run = state.activeRun;
  const deliverableId = state.selectedDeliverableId;
  if (!run || !deliverableId) return;
  const node = $('#wb-dep-error');
  if (node) node.textContent = '';
  const versionId = form.version_id.value;
  const kind = form.kind.value;
  const ref = form.ref.value.trim();
  const reason = form.reason.value.trim();
  const note = form.note.value.trim();
  if (!versionId || !ref) { if (node) node.textContent = '请选择版本并填写引用对象。'; return; }
  if (!reason) { if (node) node.textContent = '人工关联必须写明依据（reason）。'; return; }
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    await api.addManualDependency(run.id, deliverableId, {
      version_id: versionId,
      reason,
      entries: [{ kind, ref, ...(note ? { note } : {}) }],
    });
    state.toast('已添加人工关联');
    await loadDependencies();
  } catch (error) {
    if (node) node.textContent = error instanceof ApiFailure ? error.message : String(error);
    if (btn) btn.disabled = false;
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
  const passed = (run.deliverables ?? []).filter(d => {
    const version = state.versions.find(v => v.id === d.active_version_id);
    const report = state.reports.find(r => r.id === version?.report_id);
    return report?.decision === 'publishable' && report.validity === 'current';
  }).length;
  if (dc.complete && passed === run.deliverables.length) {
    chip.textContent = `检查通过 · ${passed}/${dc.expected_units}`;
    chip.className = 'wb-chip ok';
  } else {
    chip.textContent = `检查通过 ${passed}/${dc.expected_units ?? run.deliverables.length} · 其余待处理`;
    chip.className = 'wb-chip warn';
  }
  const terminal = runTerminal.has(run.status);
  // 完整包按钮：必须 complete=true 且 terminal
  completeBtn.hidden = !(terminal && dc.complete && passed === run.deliverables.length);
  // 部分包按钮：terminal 就可以
  partialBtn.hidden = !terminal || passed === 0;
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

// ---------- 模块06：修改工作台 ----------
// 数据流：进入修改态 → GET text-layers（可编辑层+安全边界）→ 本地 diff 出 edits →
// POST text-edits（免费，不调生成模型）→ 刷新版本/报告 → 前后对比 + 结果如实渲染；
// 历史版本可 activate 恢复；「仅重做此张」走 POST regenerate 子任务并轮询到终态。
const DECISION_META = {
  publishable: ['检查通过', 'ok'],
  needs_review: ['待复核', 'warn'],
  blocked: ['检查未通过', 'bad'],
};
const ISSUE_LABELS = {
  PACKAGING_TEXT_READONLY: '包装关键文字只读，不可改写',
  TEXT_TOO_LONG: '文字过长',
  TEXT_EMPTY: '文字不能为空',
  LAYOUT_OUT_OF_RANGE: '排版参数超出安全范围',
  LAYOUT_INVALID: '排版参数必须是数字',
  LAYER_NOT_FOUND: '文字层不存在',
  DUPLICATE_LAYER_EDIT: '同一文字层被重复修改',
};
const CREATED_BY_LABEL = {
  user_text_edit: '文字排版修改',
  regeneration: '指定图片重生成',
  system: '系统生成',
};

function enterEditMode(deliverableId = null) {
  const run = state.activeRun;
  if (!run) return;
  state.edit.open = true;
  state.edit.deliverableId = deliverableId
    ?? state.selectedDeliverableId
    ?? run.deliverables?.[0]?.deliverable_id ?? null;
  state.edit.layersPayload = null;
  state.edit.layersError = null;
  state.edit.result = null;
  state.edit.beforeVersionId = null;
  $('#wb-edit-panel').hidden = false;
  // 与主视图选中项保持一致，退出修改后仍停留在该交付物
  if (state.edit.deliverableId && state.edit.deliverableId !== state.selectedDeliverableId) {
    selectDeliverable(state.edit.deliverableId);
  }
  renderEditPanel();
  void loadTextLayers();
  $('#wb-edit-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeEditMode() {
  stopRegenPolling();
  state.edit.open = false;
  state.edit.regen = null;
  const panel = $('#wb-edit-panel');
  if (panel) panel.hidden = true;
}

function switchEditDeliverable(deliverableId) {
  if (!deliverableId || !state.edit.open || deliverableId === state.edit.deliverableId) return;
  state.edit.deliverableId = deliverableId;
  state.edit.layersPayload = null;
  state.edit.layersError = null;
  state.edit.result = null;
  state.edit.beforeVersionId = null;
  selectDeliverable(deliverableId);
  renderEditPanel();
  void loadTextLayers();
}

async function loadTextLayers() {
  const run = state.activeRun;
  const deliverableId = state.edit.deliverableId;
  if (!run || !deliverableId || !state.edit.open) return;
  state.edit.loading = true;
  state.edit.layersError = null;
  renderEditLayersArea();
  if (run.status !== 'completed') {
    state.edit.loading = false;
    state.edit.layersError = {
      code: 'RUN_NOT_TERMINAL',
      message: '任务尚未完成，生成结束后才能修改文字排版；进行中的任务请等待终态。',
    };
    renderEditLayersArea();
    return;
  }
  try {
    const payload = await api.listTextLayers(run.id, deliverableId);
    if (!state.edit.open || state.edit.deliverableId !== deliverableId) return;
    state.edit.layersPayload = payload;
    state.edit.loading = false;
    renderEditLayersArea();
    updateApplyState();
  } catch (error) {
    if (!state.edit.open || state.edit.deliverableId !== deliverableId) return;
    state.edit.loading = false;
    state.edit.layersError = {
      code: error.code ?? 'REQUEST_FAILED',
      message: error instanceof ApiFailure ? error.message : String(error),
    };
    renderEditLayersArea();
  }
}

function renderEditPanel() {
  const deliverable = state.activeRun?.deliverables?.find(d => d.deliverable_id === state.edit.deliverableId);
  $('#wb-edit-deliverable-label').textContent = deliverable?.label ?? state.edit.deliverableId ?? '—';
  renderEditThumbs();
  renderEditPreview();
  renderEditLayersArea();
  renderEditVersions();
  renderEditResult();
  renderEditCompare();
}

function renderEditThumbs() {
  const holder = $('#wb-edit-thumbs');
  const run = state.activeRun;
  const items = (run?.deliverables ?? []).filter(d => state.versions.some(v => v.deliverable_id === d.deliverable_id));
  if (!run || items.length === 0) {
    holder.innerHTML = '<p class="real-hint">还没有可修改的图片。</p>';
    return;
  }
  holder.innerHTML = items.map(item => {
    const version = state.versions.find(v => v.id === item.active_version_id)
      ?? state.versions.find(v => v.deliverable_id === item.deliverable_id);
    const label = item.label ?? item.deliverable_id;
    const active = item.deliverable_id === state.edit.deliverableId;
    return `<button type="button" class="wb-edit-thumb${active ? ' active' : ''}" data-edit-thumb="${escapeHtml(item.deliverable_id)}" title="${escapeHtml(label)}">
      <img src="${escapeHtml(versionImageUrl(run.id, version.id))}" alt="${escapeHtml(label)} 缩略图" loading="lazy">
      <span>${escapeHtml(label)}</span>
    </button>`;
  }).join('');
}

function renderEditPreview() {
  const holder = $('#wb-edit-preview-holder');
  const run = state.activeRun;
  const deliverable = run?.deliverables?.find(d => d.deliverable_id === state.edit.deliverableId);
  const version = state.versions.find(v => v.deliverable_id === state.edit.deliverableId && v.id === deliverable?.active_version_id)
    ?? state.versions.find(v => v.deliverable_id === state.edit.deliverableId);
  if (!run || !version) {
    holder.innerHTML = '<p class="real-hint">该交付物还没有可用版本。</p>';
    $('#wb-edit-preview-caption').textContent = '当前选用版本';
    return;
  }
  holder.innerHTML = `<img src="${escapeHtml(versionImageUrl(run.id, version.id))}" alt="${escapeHtml(deliverable?.label ?? '')} 当前选用版本">`;
  $('#wb-edit-preview-caption').textContent = `当前选用版本 · V${version.number}`;
}

function renderEditLayersArea() {
  const holder = $('#wb-edit-layers');
  const limitsNote = $('#wb-edit-limits-note');
  if (state.edit.loading) {
    holder.innerHTML = '<div class="loading-line"></div><p class="real-hint">正在读取文字层与安全边界…</p>';
    limitsNote.textContent = '';
    return;
  }
  if (state.edit.layersError) {
    holder.innerHTML = `<div class="state-note danger"><div><b>无法读取文字层</b><br>${escapeHtml(state.edit.layersError.message)}
      <div class="state-actions"><button type="button" class="secondary" data-edit-retry>重试</button></div></div></div>`;
    limitsNote.textContent = '';
    return;
  }
  const payload = state.edit.layersPayload;
  if (!payload) {
    holder.innerHTML = '<p class="real-hint">正在读取文字层…</p>';
    return;
  }
  const limits = payload.limits ?? {};
  limitsNote.textContent = limits.text_max_length ? `文案 ≤ ${limits.text_max_length} 字` : '';
  const layers = payload.layers ?? [];
  if (layers.length === 0) {
    holder.innerHTML = '<p class="real-hint">该版本没有文字层（来自不支持文字层的生成路径），不能做文字排版修改；可使用「仅重做此张」。</p>';
    return;
  }
  holder.innerHTML = layers.map(layer => {
    // 只读层：包装关键文字 / Logo —— 明确标注不可编辑与原因
    if (layer.logo === true || layer.readonly_reason) {
      const reason = layer.logo === true
        ? '品牌 Logo 使用品牌原图叠加，不可编辑（LOGO_USES_ORIGINAL_PIXEL）'
        : '包装关键文字必须与原始包装一致，不可改写（PACKAGING_TEXT_READONLY）';
      return `<div class="wb-layer readonly">
        <div class="wb-layer-head"><b>${escapeHtml(layer.label ?? layer.id)}</b><span class="wb-layer-tag">只读</span></div>
        <p class="real-note">${escapeHtml(reason)}</p>
        <p class="wb-layer-text-preview" title="${escapeHtml(layer.text ?? '')}">${escapeHtml(layer.text ?? '')}</p>
      </div>`;
    }
    const numberField = (field, value, min, max, label) => `<label>${label}（${min}–${max}）<input type="number" data-layer-id="${escapeHtml(layer.id)}" data-layer-field="${field}" min="${min}" max="${max}" step="0.001" value="${escapeHtml(value)}"></label>`;
    return `<div class="wb-layer" data-layer-row="${escapeHtml(layer.id)}">
      <div class="wb-layer-head"><b>${escapeHtml(layer.label ?? layer.id)}</b><span class="wb-layer-tag">可编辑</span></div>
      <label class="wb-layer-text">文案<input type="text" data-layer-id="${escapeHtml(layer.id)}" data-layer-field="text" maxlength="${escapeHtml(limits.text_max_length ?? 60)}" value="${escapeHtml(layer.text ?? '')}"></label>
      ${layer.editable_layout === true ? `<div class="wb-layer-fields">
        ${numberField('x', layer.x, limits.min_x ?? 0, limits.max_x ?? 0.95, 'X 位置')}
        ${numberField('y', layer.y, limits.min_y ?? 0.02, limits.max_y ?? 0.98, 'Y 位置')}
        ${numberField('width', layer.width, limits.min_width ?? 0.15, limits.max_width ?? 0.96, '宽度')}
        ${numberField('size_ratio', layer.size_ratio, limits.min_size_ratio ?? 0.018, limits.max_size_ratio ?? 0.16, '字号')}
      </div>` : ''}
    </div>`;
  }).join('');
}

/** 与服务端 applyTextEdits 相同的 diff 口径：只有实际变化才进 edits，避免“保存一下”就出新版本。 */
function collectEdits() {
  const payload = state.edit.layersPayload;
  if (!payload) return null;
  const fieldsByLayer = new Map();
  for (const input of document.querySelectorAll('#wb-edit-layers input[data-layer-id]')) {
    const id = input.dataset.layerId;
    if (!fieldsByLayer.has(id)) fieldsByLayer.set(id, {});
    fieldsByLayer.get(id)[input.dataset.layerField] = input;
  }
  const edits = [];
  for (const layer of payload.layers ?? []) {
    if (layer.logo === true || (layer.editable_text !== true && layer.editable_layout !== true)) continue;
    const fields = fieldsByLayer.get(layer.id) ?? {};
    const edit = { id: layer.id };
    let changed = false;
    if (layer.editable_text === true && fields.text && fields.text.value !== layer.text) {
      edit.text = fields.text.value;
      changed = true;
    }
    if (layer.editable_layout === true) {
      for (const field of ['x', 'y', 'width', 'size_ratio']) {
        const input = fields[field];
        if (!input || input.value === '') continue;
        const value = Number(input.value);
        if (!Number.isFinite(value)) continue;
        if (Math.abs(value - Number(layer[field])) > 1e-6) { edit[field] = value; changed = true; }
      }
    }
    if (changed) edits.push(edit);
  }
  return edits;
}

function updateApplyState() {
  const btn = $('#wb-edit-apply');
  if (!btn) return;
  const edits = state.edit.layersPayload ? collectEdits() : [];
  btn.disabled = state.edit.loading || !edits || edits.length === 0 || Boolean(state.edit.regenTimer);
}

async function applyTextEditsSubmit() {
  const run = state.activeRun;
  const payload = state.edit.layersPayload;
  if (!run || !payload || !state.edit.open) return;
  if (state.edit.regenTimer) { state.toast('该交付物有进行中的重生成，完成前不能修改文字排版'); return; }
  const edits = collectEdits() ?? [];
  if (edits.length === 0) { state.toast('没有实际修改：改动任意文案或排版后再应用'); return; }
  const btn = $('#wb-edit-apply');
  btn.disabled = true;
  btn.textContent = '正在应用修改…';
  $('#wb-edit-error').textContent = '';
  try {
    const result = await api.applyTextEdits(run.id, state.edit.deliverableId, {
      base_version_id: payload.version_id,
      edits,
    });
    state.edit.result = result;
    state.edit.beforeVersionId = result.previous_version_id;
    state.edit.layersPayload = null; // 新版本已选用，需基于它重新读取文字层
    const runRes = await api.getRun(run.id).catch(() => null);
    if (runRes?.run) {
      state.activeRun = runRes.run;
      state.runs = state.runs.map(item => item.id === run.id ? runRes.run : item);
    }
    await loadRunExtras(run.id);
    renderDeliverables();
    renderCenter();
    renderQA();
    renderExport();
    renderEditPanel();
    void loadTextLayers();
    state.toast(result.activated
      ? '修改已应用并通过检查，已自动选用新版本'
      : '修改已应用：新版本已保存，因检查未全部通过未自动选用');
  } catch (error) {
    if (error instanceof ApiFailure) showEditError(error);
    else $('#wb-edit-error').textContent = String(error);
  } finally {
    btn.textContent = '应用修改（免费）';
    updateApplyState();
  }
}

function showEditError(error) {
  const node = $('#wb-edit-error');
  const issues = error.details?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    node.innerHTML = `<b>${escapeHtml(error.message)}</b><ul class="wb-issue-list">${issues.map(item =>
      `<li><b>${escapeHtml(ISSUE_LABELS[item.code] ?? item.code)}</b>${escapeHtml(item.message ?? '')}${item.id ? `（${escapeHtml(layerLabelOf(item.id))}）` : ''}</li>`).join('')}</ul>`;
    return;
  }
  if (error.code === 'VERSION_CONFLICT') {
    node.innerHTML = `<b>当前选用版本已变化</b>（可能有其他修改或重生成）。请基于最新版本重试：
      <button type="button" class="text-button" data-edit-retry>刷新最新版本</button>`;
    return;
  }
  node.textContent = error.message ?? String(error);
}

function layerLabelOf(layerId) {
  const layer = state.edit.layersPayload?.layers?.find(item => item.id === layerId);
  return layer?.label ?? layerId;
}

function renderEditResult() {
  const holder = $('#wb-edit-result');
  const result = state.edit.result;
  if (!result) { holder.hidden = true; holder.innerHTML = ''; return; }
  const decision = result.report?.decision ?? null;
  const [decisionLabel, decisionCls] = DECISION_META[decision] ?? ['状态未知', 'warn'];
  const lines = [
    `<div class="wb-chip ${decisionCls}">新版本 V${result.version?.number ?? '—'} · ${escapeHtml(decisionLabel)}</div>`,
  ];
  if (result.activated) {
    lines.push('<p class="real-note">检查通过：新版本已自动选用为当前版本，旧版本保留在历史中可随时恢复。</p>');
  } else if (decision === 'needs_review') {
    lines.push('<p class="real-note warn">待复核：新版本只登记为历史版本，当前选用版本保持不变；人工复核通过后才能交付。</p>');
  } else {
    lines.push('<p class="real-note warn">检查未通过：新版本只登记为历史版本，当前选用版本保持不变，不会被放行。</p>');
  }
  holder.innerHTML = lines.join('');
  holder.hidden = false;
}

function renderEditCompare() {
  const holder = $('#wb-edit-compare');
  const run = state.activeRun;
  const before = state.edit.beforeVersionId;
  const after = state.edit.result?.version?.id;
  if (!run || !before || !after) { holder.hidden = true; return; }
  $('#wb-edit-before-holder').innerHTML = `<img src="${escapeHtml(versionImageUrl(run.id, before))}" alt="修改前版本" loading="lazy">`;
  $('#wb-edit-after-holder').innerHTML = `<img src="${escapeHtml(versionImageUrl(run.id, after))}" alt="修改后版本" loading="lazy">`;
  $('#wb-edit-before-caption').textContent = `修改前 · V${state.versions.find(v => v.id === before)?.number ?? '—'}`;
  $('#wb-edit-after-caption').textContent = `修改后 · V${state.edit.result.version.number}`;
  holder.hidden = false;
}

function renderEditVersions() {
  const holder = $('#wb-edit-versions');
  const deliverableId = state.edit.deliverableId;
  const versions = state.versions.filter(v => v.deliverable_id === deliverableId).sort((a, b) => b.number - a.number);
  $('#wb-edit-version-count').textContent = versions.length > 0 ? `${versions.length} 个版本` : '';
  if (!state.activeRun || versions.length === 0) {
    holder.innerHTML = '<p class="real-hint">该交付物还没有版本。</p>';
    return;
  }
  const deliverable = state.activeRun.deliverables?.find(d => d.deliverable_id === deliverableId);
  holder.innerHTML = versions.map(version => {
    const report = state.reports.find(r => r.id === version.report_id) ?? null;
    const decision = report?.decision ?? null;
    const [decisionLabel, decisionCls] = decision
      ? (DECISION_META[decision] ?? [decision, 'warn'])
      : ['无报告', 'warn'];
    const isActive = deliverable?.active_version_id === version.id;
    return `<div class="wb-version-row${isActive ? ' active' : ''}">
      <div class="wb-version-main">
        <b>V${version.number}${isActive ? ' · 当前选用' : ''}</b>
        <small title="${escapeHtml(version.note ?? '')}">${escapeHtml(version.note ?? '—')}</small>
        <small>${formatTime(version.created_at)} · ${escapeHtml(CREATED_BY_LABEL[version.created_by] ?? version.created_by ?? '—')}</small>
      </div>
      <div class="wb-version-side">
        <span class="wb-chip ${decisionCls}">${escapeHtml(decisionLabel)}</span>
        ${isActive ? '' : `<button type="button" class="text-button" data-edit-activate="${escapeHtml(version.id)}">选用此版本</button>`}
      </div>
    </div>`;
  }).join('');
}

async function activateEditVersion(versionId) {
  const run = state.activeRun;
  if (!run || !versionId) return;
  try {
    const result = await api.activateVersion(run.id, versionId);
    state.activeRun = result.run;
    state.runs = state.runs.map(item => item.id === run.id ? result.run : item);
    await loadRunExtras(run.id);
    state.toast('已切换选用版本；被替代版本保留在历史中，可随时恢复');
    renderDeliverables();
    renderCenter();
    renderQA();
    renderExport();
    renderEditPanel();
  } catch (error) {
    state.toast(error instanceof ApiFailure ? error.message : String(error));
  }
}

// ---------- 指定图片重生成（模块05 后端 + 模块06 界面） ----------
function stopRegenPolling() {
  if (state.edit.regenTimer) {
    clearInterval(state.edit.regenTimer);
    state.edit.regenTimer = null;
  }
}

async function requestRegenerate() {
  const run = state.activeRun;
  const deliverable = run?.deliverables?.find(d => d.deliverable_id === state.edit.deliverableId);
  if (!run || !deliverable) return;
  if (state.edit.regenTimer) { state.toast('该交付物已有进行中的重生成，请等待完成后再试'); return; }
  if (run.status !== 'completed') { state.toast('任务尚未完成，不能重生成'); return; }
  const confirmed = window.confirm(
    `仅重做这一张「${deliverable.label ?? deliverable.deliverable_id}」：按张结算，预计消耗 1 点额度（以服务端实际报价为准），失败或取消会释放预留。其他交付物与当前选用版本不受影响。是否继续？`);
  if (!confirmed) return;
  const status = $('#wb-edit-regen-status');
  const btn = $('#wb-regenerate');
  btn.disabled = true;
  status.hidden = false;
  status.innerHTML = '<p class="real-note">正在创建重生成子任务…</p>';
  const idempotencyKey = `regen-${run.id}-${deliverable.deliverable_id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const result = await api.regenerateDeliverable(run.id, { deliverable_id: deliverable.deliverable_id }, idempotencyKey);
    state.edit.regen = {
      childRunId: result.run.id,
      sourceRunId: run.id,
      beforeActiveId: deliverable.active_version_id ?? null,
    };
    status.innerHTML = `<p class="real-note">子任务 <b>${escapeHtml(result.run.id)}</b> 已创建 · ${escapeHtml(runStatusLabel[result.run.status] ?? result.run.status)}。完成后会自动刷新本页。</p>`;
    stopRegenPolling();
    state.edit.regenTimer = globalThis.setInterval(() => void pollRegen(), 2500);
    void pollRegen();
  } catch (error) {
    status.hidden = false;
    if (error instanceof ApiFailure) {
      // REGENERATION_IN_PROGRESS / REGENERATION_UNSUPPORTED 等错误码的服务端文案本身可读，如实透出
      status.innerHTML = `<div class="state-note danger"><div><b>无法发起重生成</b><br>${escapeHtml(error.message)}</div></div>`;
    } else {
      status.hidden = true;
      state.toast(String(error));
    }
  } finally {
    btn.disabled = false;
  }
}

async function pollRegen() {
  const regen = state.edit.regen;
  if (!regen) { stopRegenPolling(); return; }
  const status = $('#wb-edit-regen-status');
  try {
    const result = await api.getRun(regen.childRunId);
    const child = result.run;
    if (!runTerminal.has(child.status)) {
      status.hidden = false;
      status.innerHTML = `<p class="real-note">重生成进行中：子任务 <b>${escapeHtml(child.id)}</b> · ${escapeHtml(runStatusLabel[child.status] ?? child.status)}。只影响这一张，完成后自动刷新。</p>`;
      return;
    }
    stopRegenPolling();
    const sourceRes = await api.getRun(regen.sourceRunId).catch(() => null);
    if (sourceRes?.run) {
      state.activeRun = sourceRes.run;
      state.runs = state.runs.map(item => item.id === regen.sourceRunId ? sourceRes.run : item);
    }
    await loadRunExtras(regen.sourceRunId);
    renderDeliverables();
    renderCenter();
    renderQA();
    renderExport();
    renderEditPanel();
    status.hidden = false;
    if (child.status === 'completed') {
      const deliverable = state.activeRun?.deliverables?.find(d => d.deliverable_id === state.edit.deliverableId);
      const activated = Boolean(deliverable) && deliverable.active_version_id !== regen.beforeActiveId;
      status.innerHTML = activated
        ? '<div class="state-note ok">重生成完成：新图已通过检查并自动选用；旧版本保留在历史版本中。</div>'
        : '<div class="state-note warn">重生成完成：新图未通过检查或待复核，已保留为历史版本，当前选用版本未变。</div>';
    } else if (child.status === 'cancelled') {
      status.innerHTML = '<div class="state-note warn">重生成已取消：预留额度已释放，未产生扣费。</div>';
    } else {
      status.innerHTML = `<div class="state-note danger">重生成未成功（${escapeHtml(runStatusLabel[child.status] ?? child.status)}）：按张预留已释放/未结算，可继续修改文字或再次重做。</div>`;
    }
    state.edit.regen = null;
    updateApplyState();
  } catch (error) {
    console.warn('[workbench] 重生成轮询失败', error?.message ?? error);
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
  closeEditMode();
  const spec = (state.specs || []).find(s => (s.validity?.validity ?? 'current') === 'current') ?? state.specs?.[0];
  if (!spec) { state.toast('请先在"生产配置"里冻结一个快照'); return; }
  const btn = $('#wb-btn-start');
  btn.disabled = true;
  btn.textContent = '正在生成报价…';
  try {
    const { quote } = await api.createQuote({ project_id: state.project.id });
    if (!window.confirm(`本次制作 ${quote.estimated_credits} 张，最多消耗 ${quote.max_credits} 张额度。失败退回，待复核保留预留，包含最多两次修复。是否开始？`)) return;
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
    restoreSelectedDeliverable();
    renderHeader();
    renderSteps();
    renderDeliverables();
    renderCenter();
    renderQA();
    renderAdvanced();
    renderExport();
    void loadDependencies();
    // 模块06：修改面板打开时同步缩略条/预览/历史版本（不重画文字层输入，避免清掉未应用的编辑）
    if (state.edit.open) {
      renderEditThumbs();
      renderEditPreview();
      renderEditVersions();
    }
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
