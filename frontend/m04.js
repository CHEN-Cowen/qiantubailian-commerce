import { ApiFailure, api } from './api.js';

/**
 * M04 生产配置界面：模板、品牌套件、平台规则与 CommerceSpec 冻结。
 *
 * 界面的三条自我约束：
 * 1. 冲突必须逐条显示并让用户选处理方式，不提供"忽略平台"的按钮。
 * 2. 覆盖不足只写"无法声称平台通过"，不把 unknown 画成通过。
 * 3. 无依据的卖点/规格只提示补证据，界面不代写任何文案。
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

const COVERAGE_LABEL = {
  covered: '规则已覆盖',
  expired: '规则已过复核期',
  not_effective: '规则尚未生效',
  category_missing: '该类目无规则',
  missing: '未收录平台规则',
};
const RULE_STATUS_LABEL = { current: '有效', review_due: '临近复核', expired: '已过期', not_effective: '未生效' };

const state = {
  toast: () => {},
  templates: [],
  brandKits: [],
  project: null,
  specs: [],
  preview: null,
  resolutions: {},
  frozen: 0,
  viewing: null,
};

const errorText = error => {
  if (error instanceof ApiFailure) return error.message;
  console.error('[M04] 未预期错误', error);
  return `操作失败：${error.message}`;
};

export function initM04({ toast } = {}) {
  if (typeof toast === 'function') state.toast = toast;
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action="spec"]');
    if (!trigger) return;
    const card = trigger.closest('[data-project-id]');
    if (!card) return;
    void openSpec(card.dataset.projectId);
  });
  $('#spec-form')?.addEventListener('submit', event => { event.preventDefault(); void freezeSpec(); });
  $('#spec-template')?.addEventListener('change', () => { state.resolutions = {}; void refreshPreview(); });
  $('#spec-brand')?.addEventListener('change', () => { state.resolutions = {}; void refreshPreview(); });
  $('#spec-platform')?.addEventListener('change', () => { state.resolutions = {}; void refreshPreview(); });
  $('#spec-body')?.addEventListener('change', event => {
    const select = event.target.closest('[data-conflict-key]');
    if (!select) return;
    state.resolutions[select.dataset.conflictKey] = select.value;
    void refreshPreview();
  });
  $('#spec-body')?.addEventListener('click', event => {
    const view = event.target.closest('[data-action="spec-view"]');
    if (view) { void viewSpec(Number(view.dataset.specVersion)); return; }
    if (event.target.closest('[data-action="spec-back"]')) { state.viewing = null; void refreshPreview(); }
  });
  $('#spec-brand-new')?.addEventListener('click', openBrandDialog);
  $('#brand-form')?.addEventListener('submit', submitBrand);
  // R06：library-view 的品牌配方 + 模板渲染（按 setView('library') 触发）
  document.addEventListener('qb:view-change', async event => {
    const view = event?.detail?.view;
    if (view === 'library') { await renderLibraryView(); }
  });
  $('#brand-kit-new')?.addEventListener('click', () => openBrandDialog());
}

async function renderLibraryView() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const list = $('#brand-kit-list');
  const tplList = $('#library-template-list');
  if (!list || !tplList) return;
  list.innerHTML = '<p class="real-empty">正在读取品牌配方…</p>';
  tplList.innerHTML = '<p class="real-empty">正在读取模板…</p>';
  try {
    if (state.brandKits === null) await loadCatalog();
    // 品牌配方
    if (!state.brandKits || state.brandKits.length === 0) {
      list.innerHTML = `<p class="real-empty">还没有品牌配方。<button class="text-button" id="brand-kit-new-inline">新建一个</button></p>`;
      $('#brand-kit-new-inline')?.addEventListener('click', openBrandDialog);
    } else {
      list.innerHTML = state.brandKits.map(kit => `
        <article class="brand-kit-card" data-brand-kit-id="${kit.id}">
          <div class="bk-head">
            <b>${escapeHtml(kit.name)}</b>
            <span class="real-badge">v${kit.version}${kit.is_published ? ' · 已发布' : ''}</span>
          </div>
          <p class="bk-note">${escapeHtml(kit.description ?? '未填描述')}</p>
          <div class="bk-tags">
            ${kit.background_color ? `<span>背景 ${escapeHtml(kit.background_color)}</span>` : ''}
            ${kit.lighting_preset ? `<span>光线 ${escapeHtml(kit.lighting_preset)}</span>` : ''}
            ${kit.composition_hint ? `<span>构图 ${escapeHtml(kit.composition_hint)}</span>` : ''}
            ${kit.text_style_hint ? `<span>文字 ${escapeHtml(kit.text_style_hint)}</span>` : ''}
          </div>
          <div class="bk-actions">
            <button class="text-button" data-action="brand-use">用于新项目</button>
            <button class="text-button" data-action="brand-edit">编辑</button>
          </div>
        </article>`).join('');
    }
    // 模板（简化列表）
    const templates = state.templates ?? [];
    if (!templates.length) {
      tplList.innerHTML = '<p class="real-empty">系统预置模板未加载</p>';
    } else {
      tplList.innerHTML = templates.map(tpl => `
        <article class="template-card">
          <b>${escapeHtml(tpl.name)}</b>
          <small>${escapeHtml(tpl.description ?? tpl.id)} · ${(tpl.deliverables ?? []).length} 个交付物</small>
        </article>`).join('');
    }
  } catch (error) {
    list.innerHTML = `<p class="real-error">读取失败：${errorText(error)}</p>`;
    tplList.innerHTML = `<p class="real-error">读取失败：${errorText(error)}</p>`;
  }
}

async function loadCatalog() {
  const [templates, kits] = await Promise.all([api.listTemplates(), api.listBrandKits()]);
  state.templates = templates.templates;
  state.brandKits = kits.brand_kits;
}

async function openSpec(projectId) {
  try {
    const [detail, specs] = await Promise.all([api.getProject(projectId), api.listSpecs(projectId)]);
    state.project = detail.project;
    state.specs = specs.specs;
    state.preview = null;
    state.resolutions = {};
    if (state.templates.length === 0 || state.brandKits === null) await loadCatalog();
    renderControls();
    const dialog = $('#spec-dialog');
    if (!dialog.open) dialog.showModal();
    await refreshPreview();
  } catch (error) {
    state.toast(errorText(error));
  }
}

export { openSpec };

function renderControls() {
  $('#spec-title').textContent = `${state.project.name} · 生产配置`;
  const template = $('#spec-template');
  const selectedTemplate = template.value;
  template.innerHTML = state.templates.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.purpose)}（${item.deliverable_count} 项交付）</option>`).join('');
  if (selectedTemplate && state.templates.some(item => item.id === selectedTemplate)) template.value = selectedTemplate;

  const brand = $('#spec-brand');
  const selectedBrand = brand.value;
  brand.innerHTML = ['<option value="">不使用品牌套件</option>', ...state.brandKits.map(kit =>
    `<option value="${escapeHtml(kit.id)}">${escapeHtml(kit.name)} · v${kit.head_version}</option>`)].join('');
  if (selectedBrand && state.brandKits.some(kit => kit.id === selectedBrand)) brand.value = selectedBrand;

  const platform = $('#spec-platform');
  if (!platform.value) platform.value = state.project.platform ?? '';
}

function specPayload() {
  const body = {
    template_id: $('#spec-template').value,
    platform: $('#spec-platform').value.trim() || undefined,
    conflict_resolutions: state.resolutions,
  };
  const brandId = $('#spec-brand').value;
  if (brandId) body.brand_kit_id = brandId;
  return body;
}

async function refreshPreview() {
  if (!state.project) return;
  const body = $('#spec-body');
  const errorNode = $('#spec-error');
  errorNode.textContent = '';
  if (!body) return;
  body.innerHTML = '<p class="truth-hint">正在按当前选择推导交付清单与冲突…</p>';
  try {
    const result = await api.previewSpec(state.project.id, specPayload());
    state.preview = result;
    renderPreview(result);
  } catch (error) {
    state.preview = null;
    if (error instanceof ApiFailure && error.details?.conflicts) {
      body.innerHTML = renderConflictBlock(error.details.conflicts);
      errorNode.textContent = error.message;
      return;
    }
    body.innerHTML = '';
    errorNode.textContent = errorText(error);
  }
}

function renderConflictBlock(conflicts) {
  return `<section class="spec-section"><h3>未处理的冲突</h3>
    <ul class="spec-conflicts">${conflicts.map(item => `
      <li class="spec-conflict hard">
        <div class="spec-conflict-head"><b>${escapeHtml(item.code)}</b><span>${item.options.length === 0 ? '无法满足' : '需要选择处理方式'}</span></div>
        <p>${escapeHtml(item.message)}</p>
        ${item.options.length === 0 ? '<p class="spec-noway">平台硬约束不提供忽略选项，请先修改商品事实或更换模板。</p>' : ''}
      </li>`).join('')}</ul></section>`;
}

function renderPreview(result) {
  const payload = result.payload;
  const channel = payload.channel;
  const readiness = result.readiness;
  const coverageClass = channel.platform_coverage === 'verified' ? 'ok' : 'block';
  const deliverableRows = payload.deliverables.map(item => `
    <tr>
      <td><b>${escapeHtml(item.label)}</b><span class="spec-chip">${escapeHtml(item.type)}</span></td>
      <td>${item.required ? '<b class="spec-req">必需</b>' : '可选'}${item.count > 1 ? ` ×${item.count}` : ''}</td>
      <td>${escapeHtml(item.ratio)} · ${item.width}×${item.height}</td>
      <td>${item.formats.map(format => escapeHtml(format)).join(' / ')}</td>
      <td>${item.text_blocks.length === 0 ? '无文字' : item.text_blocks.map(block => `<code>${escapeHtml(block)}</code>`).join(' ')}</td>
      <td>${item.channel_adjusted.length === 0 ? '保持模板' : `<b class="spec-chip">已按平台调整</b>`}</td>
    </tr>`).join('');

  const conflicts = [...payload.conflicts.pending, ...payload.conflicts.unresolvable];
  const conflictHtml = conflicts.length === 0
    ? '<p class="truth-ok">当前没有未处理的规则冲突。</p>'
    : `<ul class="spec-conflicts">${conflicts.map(item => `
      <li class="spec-conflict ${item.options.length === 0 ? 'blocked' : 'hard'}">
        <div class="spec-conflict-head">
          <b>${escapeHtml(item.code)}</b>
          <span>优先方：${escapeHtml(priorityLabel(item))}</span>
        </div>
        <p>${escapeHtml(item.message)}</p>
        ${item.options.length === 0
          ? '<p class="spec-noway">没有可接受的处理方式，请先修改商品事实或更换模板。</p>'
          : `<label class="spec-resolution">处理方式
              <select data-conflict-key="${escapeHtml(item.key)}">
                <option value="">请选择（不选不能冻结）</option>
                ${item.options.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join('')}
              </select>
            </label>`}
      </li>`).join('')}</ul>`;

  const warnings = payload.gaps.warnings ?? [];
  const claims = payload.gaps.claims_without_evidence ?? [];
  const missingRefs = payload.gaps.missing_references ?? [];

  const history = historyHtml();

  $('#spec-body').innerHTML = `
    <section class="spec-section">
      <div class="spec-status">
        <span class="real-state ${coverageClass}">${channel.platform_coverage === 'verified' ? '规则已核验' : '规则覆盖不足'}</span>
        <span class="real-state ${channel.status === 'current' ? 'ok' : channel.status === 'review_due' ? 'muted' : 'block'}">规则 ${RULE_STATUS_LABEL[channel.status] ?? channel.status}</span>
        <span class="spec-meta">${channel.rule_id ? `${escapeHtml(channel.rule_id)} v${escapeHtml(channel.version)} · 生效 ${escapeHtml((channel.effective_at ?? '').slice(0, 10))} · 复核 ${escapeHtml((channel.review_due_at ?? '').slice(0, 10))}` : '未匹配到平台规则'}</span>
      </div>
      <p class="spec-source">来源：${escapeHtml(channel.source?.name ?? '无')}${channel.source?.verified === false ? '（未核验官方条款，结论不能声称平台通过）' : ''}</p>
      <ul class="spec-reasons">${channel.coverage_reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>
    </section>

    <section class="spec-section">
      <h3>生产前置</h3>
      <p class="spec-meta">${readiness.can_start_production ? '商品事实与素材已满足生产条件' : `仍有 ${readiness.blocker_count} 项阻断，无法冻结`}</p>
      ${readiness.can_start_production ? '' : `<ul class="truth-blockers">${readiness.blockers.map(item => `<li><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</li>`).join('')}</ul>`}
    </section>

    <section class="spec-section">
      <h3>交付清单 <span class="spec-meta">共 ${payload.deliverables.length} 项，必需 ${payload.deliverables.filter(item => item.required).length} 项</span></h3>
      <div class="spec-table-wrap">
        <table class="spec-table">
          <thead><tr><th>交付物</th><th>必需</th><th>比例 · 尺寸</th><th>格式</th><th>文字块</th><th>规则调整</th></tr></thead>
          <tbody>${deliverableRows}</tbody>
        </table>
      </div>
      <p class="spec-meta">参考预算 ${payload.budget.max_credits} 额度 / 最多 ${payload.budget.max_attempts} 轮 · ${escapeHtml(payload.budget.note)}</p>
    </section>

    <section class="spec-section">
      <h3>规则冲突</h3>
      <p class="truth-hint">优先级：平台硬约束 &gt; 商品事实 &gt; 品牌约束 &gt; 模板 &gt; 用户创意。冲突不会被静默覆盖。</p>
      ${conflictHtml}
    </section>

    ${claims.length > 0 ? `<section class="spec-section">
      <h3>需要补证据的内容</h3>
      <ul class="truth-warnings">${claims.map(item => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>
      <p class="spec-meta">界面不会替这些内容补写文案，也不会据此自动扩写功效。</p>
    </section>` : ''}

    ${missingRefs.length + warnings.length > 0 ? `<section class="spec-section">
      <h3>规则与模板提示</h3>
      <ul class="truth-warnings">${[...missingRefs, ...warnings].map(item => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>
    </section>` : ''}

    <section class="spec-section">
      <h3>版本历史</h3>
      ${history}
    </section>`;

  // 已选过的处理方式回填，避免刷新预览后选择丢失
  for (const select of $$('#spec-body [data-conflict-key]')) {
    const chosen = state.resolutions[select.dataset.conflictKey];
    if (chosen && [...select.options].some(option => option.value === chosen)) select.value = chosen;
  }
  const freezeButton = $('#spec-freeze');
  if (freezeButton) {
    const blocked = !readiness.can_start_production || payload.conflicts.pending.length > 0
      || payload.conflicts.unresolvable.length > 0;
    freezeButton.disabled = blocked;
    freezeButton.textContent = blocked ? '存在未处理冲突，暂不能冻结' : '冻结生产配置';
  }
}

const priorityLabel = conflict => ({ platform: '平台规则', product_truth: '商品事实', brand: '品牌套件' }[conflict.priority_winner] ?? conflict.priority_winner);

async function freezeSpec() {
  if (!state.project) return;
  const errorNode = $('#spec-error');
  const button = $('#spec-freeze');
  errorNode.textContent = '';
  button.disabled = true;
  try {
    const payload = await api.createSpec(state.project.id, {
      ...specPayload(),
      base_version: state.project.spec_head_version,
    });
    state.frozen += 1;
    state.specs = (await api.listSpecs(state.project.id)).specs;
    state.project.spec_head_version = payload.spec.version;
    state.toast(`已冻结生产配置 v${payload.spec.version}（${payload.spec.deliverables.length} 项交付）`);
    await refreshPreview();
    renderHistoryOnly();
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'SPEC_CONFLICTS_PENDING') {
      errorNode.innerHTML = `仍有 ${error.details.conflicts.length} 项冲突未处理，未生成快照。`;
      await refreshPreview();
      return;
    }
    if (error instanceof ApiFailure && error.code === 'SPEC_CONFLICT_UNRESOLVABLE') {
      errorNode.textContent = '存在无法满足的平台硬约束，请先修改商品事实或更换模板。';
      await refreshPreview();
      return;
    }
    if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
      state.toast('配置已被更新，已刷新为最新版本，请重新选择后再冻结');
      await openSpec(state.project.id);
      return;
    }
    if (error instanceof ApiFailure && error.code === 'READINESS_BLOCKED') {
      errorNode.textContent = error.message;
      await refreshPreview();
      return;
    }
    errorNode.textContent = errorText(error);
  } finally {
    if (button) button.disabled = false;
  }
}

/** 冻结成功后只重画版本历史，避免整块重渲染把用户选择冲掉。 */
function renderHistoryOnly() {
  const history = $('.spec-history');
  if (!history) { if (state.preview) renderPreview(state.preview); return; }
  const list = $('.spec-section:last-child');
  if (!list) return;
  list.innerHTML = `<h3>版本历史</h3>${historyHtml()}`;
}

/**
 * 版本历史：旧快照不改写，但必须把"为什么失效"写出来，
 * 否则用户只看到一个灰标签，无法判断该重新冻结还是补事实。
 */
function historyHtml() {
  if (state.specs.length === 0) return '<p class="truth-empty">尚无冻结版本。</p>';
  return `<ul class="spec-history">${state.specs.map(item => {
    const current = item.validity.validity === 'current';
    const reasons = item.validity.reasons ?? [];
    return `<li>
      <b>v${item.version}</b>
      <span>${escapeHtml(item.template.name)}${item.brand_kit ? ` · ${escapeHtml(item.brand_kit.name)} v${item.brand_kit.version}` : ' · 无品牌套件'}</span>
      <span class="real-state ${current ? 'ok' : 'muted'}">${current ? '生效中' : '已失效'}</span>
      <span>${item.deliverable_count} 项交付 · ${item.requires_requote ? '清单变更需重新报价' : '清单未变'}</span>
      <code>${escapeHtml(item.content_hash.slice(0, 12))}…</code>
      <button type="button" class="text-button" data-action="spec-view" data-spec-version="${item.version}">查看快照</button>
      ${!current && reasons.length > 0 ? `<ul class="spec-stale-reasons">${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

/** 只读回看某一版快照：证明任务可以重放当时的依据，且不受新配置影响。 */
async function viewSpec(version) {
  if (!state.project) return;
  const body = $('#spec-body');
  const errorNode = $('#spec-error');
  errorNode.textContent = '';
  body.innerHTML = '<p class="truth-hint">正在读取冻结快照…</p>';
  try {
    const { spec } = await api.getSpec(state.project.id, version);
    state.viewing = version;
    renderSpecDetail(spec);
  } catch (error) {
    state.viewing = null;
    body.innerHTML = '';
    errorNode.textContent = errorText(error);
  }
}

function renderSpecDetail(spec) {
  const stale = spec.validity.validity !== 'current';
  const channel = spec.channel;
  const rows = spec.deliverables.map(item => `
    <tr>
      <td><b>${escapeHtml(item.label)}</b><span class="spec-chip">${escapeHtml(item.type)}</span></td>
      <td>${item.required ? '<b class="spec-req">必需</b>' : '可选'}${item.count > 1 ? ` ×${item.count}` : ''}</td>
      <td>${escapeHtml(item.ratio)} · ${item.width}×${item.height}</td>
      <td>${item.formats.map(format => escapeHtml(format)).join(' / ')}</td>
      <td>${item.text_blocks.length === 0 ? '无文字' : item.text_blocks.map(block => `<code>${escapeHtml(block)}</code>`).join(' ')}</td>
    </tr>`).join('');
  const resolutions = spec.provenance.resolutions ?? [];
  const gaps = spec.gaps ?? {};

  $('#spec-body').innerHTML = `
    <section class="spec-section spec-detail-head">
      <div class="spec-status">
        <span class="real-state muted">只读快照</span>
        <span class="real-state ${stale ? 'block' : 'ok'}">${stale ? '已失效' : '生效中'}</span>
        <span class="spec-meta">v${spec.version} · 冻结于 ${formatTime(spec.created_at)} · ${escapeHtml(spec.created_by)}</span>
      </div>
      <p class="spec-meta">内容哈希 <code>${escapeHtml(spec.content_hash)}</code></p>
      ${stale ? `<ul class="spec-stale-reasons">${spec.validity.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>
        <p class="spec-meta">旧快照内容不会被修改；如需继续生产，请按当前事实与规则重新冻结，导出前必须复检。</p>` : ''}
      <div class="real-actions"><button type="button" class="secondary" data-action="spec-back">返回当前配置</button></div>
    </section>

    <section class="spec-section">
      <h3>冻结时的依据</h3>
      <ul class="spec-provenance">
        <li>模板：${escapeHtml(spec.template.name)} v${escapeHtml(spec.template.version)}<code>${escapeHtml(String(spec.template.hash ?? '').slice(0, 12))}…</code></li>
        <li>品牌套件：${spec.brand_kit ? `${escapeHtml(spec.brand_kit.name)} v${spec.brand_kit.version}` : '未使用'}</li>
        <li>平台规则：${channel.rule_id ? `${escapeHtml(channel.rule_id)} v${escapeHtml(channel.version)} · ${RULE_STATUS_LABEL[channel.status] ?? escapeHtml(channel.status)}` : '未匹配到规则'}${channel.platform_coverage === 'verified' ? '' : ' · 覆盖不足，不能声称平台通过'}</li>
        <li>商品事实：v${spec.product_truth.version}<code>${escapeHtml(spec.product_truth.content_hash.slice(0, 12))}…</code></li>
        <li>目录版本：${escapeHtml(spec.provenance.catalog_version)} · 装配器 ${escapeHtml(spec.provenance.spec_builder_version)}</li>
        <li>预算：${spec.budget.max_credits} 额度 / 最多 ${spec.budget.max_attempts} 轮<span class="spec-meta">（模板推荐值，正式报价以冻结的生产配置为准）</span></li>
      </ul>
      ${resolutions.length === 0 ? '' : `<h4>冲突处理记录</h4><ul class="truth-warnings">${resolutions.map(item => `<li><b>${escapeHtml(item.key)}</b> → ${escapeHtml(item.option)} · 优先方：${escapeHtml(priorityLabel(item))}</li>`).join('')}</ul>`}
      ${(gaps.warnings ?? []).length === 0 ? '' : `<h4>当时的提示</h4><ul class="truth-warnings">${gaps.warnings.map(item => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>`}
    </section>

    <section class="spec-section">
      <h3>该版交付清单 <span class="spec-meta">共 ${spec.deliverables.length} 项</span></h3>
      <div class="spec-table-wrap">
        <table class="spec-table">
          <thead><tr><th>交付物</th><th>必需</th><th>比例 · 尺寸</th><th>格式</th><th>文字块</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="spec-meta">${spec.requires_requote ? '该版本相对上一版清单结构有变化，需要重新报价。' : '清单结构未变。'}</p>
    </section>`;
}

// ---------- 品牌套件 ----------
function openBrandDialog() {
  $('#brand-form').reset();
  $('#brand-error').textContent = '';
  $('#brand-dialog').showModal();
}

async function submitBrand(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const errorNode = $('#brand-error');
  errorNode.textContent = '';
  const secondary = String(data.get('secondary') ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const banned = String(data.get('banned') ?? '').split('\n').map(item => item.trim()).filter(Boolean);
  const body = {
    name: String(data.get('name') ?? ''),
    palette: { primary: String(data.get('primary') ?? ''), secondary },
    logo: { present: data.get('logo_present') === 'on', description: String(data.get('logo_description') ?? '') || null },
    fonts: data.get('font_name')
      ? [{ name: String(data.get('font_name')), license: String(data.get('font_license') ?? 'unknown') }]
      : [],
    tone: String(data.get('tone') ?? '') || null,
    banned_expressions: banned,
  };
  try {
    const created = await api.createBrandKit(body);
    await loadCatalog();
    state.brandKits = (await api.listBrandKits()).brand_kits;
    renderControls();
    $('#spec-brand').value = created.brand_kit.id;
    $('#brand-dialog').close();
    state.toast(`品牌套件「${created.brand_kit.name}」v1 已保存`);
    state.resolutions = {};
    await refreshPreview();
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'BRAND_KIT_EXISTS') {
      errorNode.textContent = error.message;
      return;
    }
    errorNode.textContent = errorText(error);
  }
}

export const m04state = state;

// 作为独立模块脚本加载时自启动：与 app.js 的 toast 行为一致，但不依赖其内部作用域。
function showToast(message) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 3000);
}

if (typeof document !== 'undefined') initM04({ toast: showToast });
