import { ApiFailure, api } from './api.js';

/**
 * M03 真实数据界面：项目创建、素材上传与商品事实确认。
 * 与 M02 的 mock 演示区严格分开：这里的每个数字都来自服务端 /api，
 * 请求失败时显示可读原因，不把失败渲染成成功。
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ROLE_OPTIONS = [
  ['subject', '主体', '锁定商品形态，可作为事实来源'],
  ['packaging', '包装', '包装正面与文字，可作为事实来源'],
  ['detail', '细节', '材质、接口、纹理等局部'],
  ['style', '风格', '仅作为氛围参考，不作为商品事实'],
];
const ROLE_LABELS = Object.fromEntries(ROLE_OPTIONS.map(([value, label]) => [value, label]));

const state = { toast: () => {}, projects: [], detail: null, regions: new Map(), pendingProjectId: null, skuEditing: null, change: null, check: null, explainers: null };

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const formatTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
};

const shortHash = value => (value ? `${value.slice(0, 12)}…` : '—');

function errorText(error) {
  if (error instanceof ApiFailure) return error.message;
  return '无法连接本地服务，请确认服务已启动后重试';
}

function renderBlockers(blockers = []) {
  if (blockers.length === 0) return '<p class="truth-ok">当前没有阻断项。</p>';
  return `<ul class="truth-blockers">${blockers.map(item =>
    `<li><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</li>`).join('')}</ul>`;
}

export function initRealData({ toast } = {}) {
  if (typeof toast === 'function') state.toast = toast;
  // 模块02：新建项目入口（.js-new-project / #projects-new / #import-button）已统一改由 app.js 切换到 create 向导视图，
  // 这里不再绑定 openCreateDialog，避免双重处理；truth/spec/upload 弹窗仍保留给既有项目页。
  $('#upload-button')?.addEventListener('click', () => openUploadDialog());
  $('#upload-form')?.addEventListener('submit', event => { event.preventDefault(); void submitUpload(false); });
  $('#upload-replace')?.addEventListener('click', () => void submitUpload(true));
  $('#real-list')?.addEventListener('click', onRealListClick);
  $('#truth-body')?.addEventListener('click', onTruthClick);
  // E07：首页待办刷新（聚合未知/失败/待复核/已采用）
  $('#todo-refresh')?.addEventListener('click', () => void loadTodos());
  $('#home-todos')?.addEventListener('click', onTodoClick);
  // E06：切换说明图类型时重建表单（对比图才显示「对比 SKU」）
  $('#truth-body')?.addEventListener('change', event => {
    if (event.target?.id === 'ex-kind') rerenderExplainerSection();
  });
  $$('[data-close-dialog]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog)?.close());
  });
  document.addEventListener('qb:view-change', event => { if (['home', 'projects', 'assets'].includes(event.detail?.view)) void refresh(); });
  void refresh();
}

async function refresh() {
  const list = $('#real-list');
  try {
    const payload = await api.listProjects();
    state.projects = payload.projects;
    renderProjects();
    renderUploadOptions();
    renderHomeRealProjects();
    await renderAccountData();
  } catch (error) {
    state.projects = [];
    if (list) list.innerHTML = `<p class="real-empty real-error">${escapeHtml(errorText(error))}</p>`;
  }
}

// R06：首页"继续制作"区块的真实项目列表；当有项目时隐藏 demo
function renderHomeRealProjects() {
  const holder = $('#home-real-projects');
  const demo = $('#home-demo-projects');
  if (!holder) return;
  const projects = state.projects ?? [];
  if (projects.length === 0) {
    holder.innerHTML = '<p class="real-empty">还没有真实项目。点击「新建商品项目」开始你的第一个商品。</p>';
    if (demo) demo.hidden = true;
    return;
  }
  if (demo) demo.hidden = true;
  // 取最多 3 个最近更新的项目
  const recent = [...projects]
    .sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)))
    .slice(0, 3);
  holder.innerHTML = `<div class="project-list">${recent.map(project => {
    const readiness = project.readiness ?? { can_start_production: false };
    const ready = readiness.can_start_production;
    const statusText = ready ? '可开始生产' : `阻断 ${readiness.blocker_count ?? 1} 项`;
    const statusClass = ready ? 'status-pill green' : 'status-pill amber';
    return `<article class="project-card" data-project-id="${escapeHtml(project.id)}">
      <div class="project-cover real-cover"><div class="cover-product">${escapeHtml(project.name.slice(0, 2))}</div></div>
      <div class="project-info">
        <div class="project-line">
          <h3>${escapeHtml(project.name)}</h3>
          <span class="${statusClass}">${escapeHtml(statusText)}</span>
        </div>
        <p>${escapeHtml(project.category)}${project.platform ? ` · ${escapeHtml(project.platform)}` : ''} · 生效素材 ${project.active_asset_count ?? 0} · 事实 v${project.truth_head_version ?? 0}</p>
        <div class="project-foot">
          <button class="text-button" data-action="truth">商品事实</button>
          <button class="text-button" data-action="spec">生产配置</button>
          <button class="text-button" data-action="workbench">打开工作台 →</button>
          <button class="text-button" data-action="remake">再做一套</button>
        </div>
      </div>
    </article>`;
  }).join('')}</div>`;
  // home-real-projects 里的 data-action=workbench/truth/spec 复用 onRealListClick 已经监听的 data-action 机制——
  // 但项目卡片上没带 data-project-id，补一下
  holder.querySelectorAll('[data-project-id]').forEach(card => {
    card.addEventListener('click', event => {
      const trigger = event.target.closest('[data-action]');
      if (!trigger) {
        // 点击整张卡片 → 打开工作台
        window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: card.dataset.projectId } }));
        return;
      }
      const action = trigger.dataset.action;
      if (action === 'workbench') window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: card.dataset.projectId } }));
      if (action === 'spec') window.dispatchEvent(new CustomEvent('qb:open-spec', { detail: { projectId: card.dataset.projectId } }));
      if (action === 'remake') {
        // 模块03 E1：同商品再做一套 → 向导复用模式
        window.dispatchEvent(new CustomEvent('qb:open-wizard', { detail: { mode: 'reuse', projectId: card.dataset.projectId } }));
      }
      if (action === 'truth') void openTruthDialog(card.dataset.projectId);
    });
  });
}

function renderProjects() {
  const list = $('#real-list');
  if (!list) return;
  if (state.projects.length === 0) {
    list.innerHTML = '<p class="real-empty">尚未创建项目。点击「导入商品资料」或「新建项目」开始。</p>';
    return;
  }
  list.innerHTML = state.projects.map(project => {
    const readiness = project.readiness ?? { can_start_production: false, blocker_count: 0 };
    const pill = readiness.can_start_production
      ? '<span class="real-state ok">可开始生产</span>'
      : `<span class="real-state block">阻断 ${readiness.blocker_count} 项</span>`;
    return `<article class="real-card" data-project-id="${escapeHtml(project.id)}">
      <div class="real-card-main">
        <div class="real-card-title"><b>${escapeHtml(project.name)}</b><code>${escapeHtml(project.sku)}</code></div>
        <p>${escapeHtml(project.category)}${project.platform ? ` · ${escapeHtml(project.platform)}` : ''} · 生效素材 ${project.active_asset_count} 张 · 事实 v${project.truth_head_version}</p>
      </div>
      <div class="real-card-side">${pill}
        <button class="text-button" data-action="truth">商品事实</button>
        <button class="text-button" data-action="upload">上传素材</button>
        <button class="text-button" data-action="spec">生产配置</button>
        <button class="text-button" data-action="run">开始生产</button>
        <button class="text-button" data-action="remake">再做一套</button>
      </div>
    </article>`;
  }).join('');
}

function renderUploadOptions() {
  const select = $('#upload-project');
  if (!select) return;
  const previous = select.value || state.pendingProjectId;
  select.innerHTML = state.projects.length === 0
    ? '<option value="">请先创建真实项目</option>'
    : state.projects.map(project =>
      `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}（${escapeHtml(project.sku)}）</option>`).join('');
  if (previous && state.projects.some(project => project.id === previous)) select.value = previous;
}

// 模块02：openCreateDialog / submitCreate 已随 project-dialog 一并下线；
// 创建项目改走 create 视图的一页三步向导（见 wizard.js）。

function openUploadDialog(projectId) {
  $('#upload-form').reset();
  $('#upload-error').textContent = '';
  $('#upload-result').hidden = true;
  $('#upload-replace').hidden = true;
  renderUploadOptions();
  if (projectId) $('#upload-project').value = projectId;
  if (state.projects.length === 0) {
    $('#upload-error').textContent = '当前没有真实项目，请先创建项目。';
  }
  $('#upload-dialog').showModal();
}

async function submitUpload(replace) {
  const projectId = $('#upload-project').value;
  const role = $('#upload-role').value;
  const file = $('#upload-file').files?.[0];
  const submit = $('#upload-submit');
  $('#upload-error').textContent = '';
  $('#upload-replace').hidden = true;
  if (!projectId) { $('#upload-error').textContent = '请选择真实项目。'; return; }
  if (!file) { $('#upload-error').textContent = '请选择要上传的图片文件（JPEG / PNG / WebP）。'; return; }
  submit.disabled = true;
  try {
    const payload = await api.uploadAsset(projectId, file, { role, onConflict: replace ? 'replace' : undefined });
    const asset = payload.asset;
    const warnings = (payload.warnings ?? []).map(item => `<li>${escapeHtml(item.message)}</li>`).join('');
    $('#upload-result').hidden = false;
    $('#upload-result').innerHTML = `<div class="upload-done">
      <b>已保存真实素材</b>
      <p>${escapeHtml(asset.filename)} · ${asset.width}×${asset.height}px · ${ROLE_LABELS[asset.role] ?? asset.role}职责 · sha256 ${escapeHtml(shortHash(asset.sha256))}</p>
      ${warnings ? `<ul class="upload-warnings">${warnings}</ul>` : '<p>已通过类型、体积与尺寸校验。</p>'}
    </div>`;
    state.toast('素材已写入真实项目');
    await refresh();
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'REFERENCE_CONFLICT') {
      const candidates = (error.details?.candidates ?? []).map(item => item.filename).join('、');
      $('#upload-error').textContent = `${error.message}${candidates ? `（已有：${candidates}）` : ''}`;
      $('#upload-replace').hidden = false;
    } else {
      $('#upload-error').textContent = errorText(error);
    }
  } finally {
    submit.disabled = false;
  }
}

function onRealListClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const card = event.target.closest('[data-project-id]');
  const projectId = card?.dataset.projectId;
  if (!projectId) return;
  const action = trigger.dataset.action;
  if (action === 'truth') void openTruthDialog(projectId);
  if (action === 'upload') openUploadDialog(projectId);
  if (action === 'spec') {
    // openSpec 来自 m04.js（在 index.html 中已作为模块引入，window 上暂不挂），
    // 此处先抛出自定义事件让 workbench 或其它模块接住
    window.dispatchEvent(new CustomEvent('qb:open-spec', { detail: { projectId } }));
  }
  if (action === 'run' || action === 'workbench') {
    window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId } }));
  }
  if (action === 'remake') {
    // 模块03 E1：同商品再做一套 → 向导复用模式（沿用项目、素材与已确认事实）
    window.dispatchEvent(new CustomEvent('qb:open-wizard', { detail: { mode: 'reuse', projectId } }));
  }
}

// R05：导出给 workbench / 其它模块调用
export { openTruthDialog, openUploadDialog, refresh as refreshProjects };

async function openTruthDialog(projectId, { section } = {}) {
  try {
    const detail = await api.getProject(projectId);
    const versions = await api.listTruthVersions(projectId);
    const skuData = await api.getSkus(projectId);
    state.detail = { ...detail, versions: versions.versions, skuData };
    state.skuEditing = null;
    state.regions = new Map((detail.truth_head?.facts ?? [])
      .filter(fact => fact.region)
      .map(fact => [fact.key, fact.region]));
    renderTruth();
    const dialog = $('#truth-dialog');
    if (!dialog.open) dialog.showModal();
    // E07：从首页待办进入时直接定位到「变更 / SKU / 问题 / 说明图」区块
    if (section) document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    // 区分"接口失败"与"界面脚本异常"，避免把前端 bug 说成连不上服务
    if (error instanceof ApiFailure) state.toast(errorText(error));
    else { console.error('[M03] 打开商品事实失败', error); state.toast(`打开商品事实失败：${error.message}`); }
  }
}

function factRow(fact = {}) {
  const activeAssets = (state.detail?.assets ?? []).filter(asset => asset.role_status === 'active' && asset.role !== 'style');
  const known = (state.detail?.assets ?? []).find(asset => asset.id === fact.source_asset_id);
  const options = ['<option value="">用户输入（需人工确认）</option>'];
  for (const asset of activeAssets) {
    options.push(`<option value="${escapeHtml(asset.id)}"${fact.source_asset_id === asset.id ? ' selected' : ''}>素材：${escapeHtml(asset.filename)}</option>`);
  }
  if (known && !activeAssets.some(asset => asset.id === known.id)) {
    options.push(`<option value="${escapeHtml(known.id)}" selected>已替换素材：${escapeHtml(known.filename)}（需重选）</option>`);
  }
  return `<div class="fact-row">
    <label class="fact-flag"><input type="checkbox" data-fact="critical"${fact.critical ? ' checked' : ''}> 关键</label>
    <input data-fact="key" placeholder="事实项，如 容量" value="${escapeHtml(fact.key ?? '')}" maxlength="60">
    <input data-fact="value" placeholder="值，如 50g" value="${escapeHtml(fact.value ?? '')}" maxlength="500">
    <select data-fact="source" aria-label="事实来源">${options.join('')}</select>
    <label class="fact-flag"><input type="checkbox" data-fact="confirmed"${fact.confirmed ? ' checked' : ''}> 已确认</label>
    <button type="button" class="icon-button" data-action="remove-fact" aria-label="删除该事实项">×</button>
  </div>`;
}

function renderTruth() {
  const { project, assets, truth_head, readiness, versions } = state.detail;
  $('#truth-title').textContent = `${project.name} · 商品事实`;
  // 弹窗内的错误节点随 #truth-body 一起重建，这里只清空已存在的那一个
  const previousError = $('#truth-block-error');
  if (previousError) previousError.textContent = '';

  const assetsHtml = assets.length === 0
    ? '<p class="truth-empty">尚未上传素材。缺少素材时无法确认商品事实。</p>'
    : `<ul class="truth-asset-list">${assets.map(asset => `<li class="${asset.role_status === 'active' ? '' : 'is-superseded'}">
        <span class="real-state ${asset.role_status === 'active' ? 'ok' : 'muted'}">${asset.role_status === 'active' ? '生效' : '已替换'}</span>
        <b>${escapeHtml(asset.filename)}</b>
        <code>素材 ID：${escapeHtml(asset.id)}</code>
        <span>${ROLE_LABELS[asset.role] ?? asset.role} · ${asset.width}×${asset.height} · sha ${escapeHtml(shortHash(asset.sha256))}</span>
        ${asset.role_status === 'active' && asset.role !== 'style' ? `<button type="button" data-action="extract-facts" data-asset-id="${escapeHtml(asset.id)}">提取候选文字</button>` : ''}
        ${asset.role === 'subject' && asset.role_status === 'active' ? `<details><summary>调整商品主体框</summary><p>按画布比例填写 0～1；框内商品会被保护。</p>${['x','y','width','height'].map(k => `<label>${k}<input data-box="${k}" type="number" min="0" max="1" step="0.01" value="${asset.subject_box?.[k] ?? (k === 'width' || k === 'height' ? 0.8 : 0.1)}"></label>`).join('')}<button type="button" data-action="save-subject-box" data-asset-id="${escapeHtml(asset.id)}">保存主体框并预览</button><div data-mask-preview></div></details>` : ''}
      </li>`).join('')}</ul>`;

  const facts = truth_head?.facts?.length ? truth_head.facts : [{}];
  const criticalText = (truth_head?.critical_text ?? []).map(item => item.text).join('\n');
  const history = (versions ?? []).map(item => `<li>
      <b>v${item.version}</b>
      <span>${item.confirmation_status === 'confirmed' ? '已确认' : '草稿'} · ${escapeHtml(item.created_by)} · ${escapeHtml(formatTime(item.created_at))}</span>
      <code>${escapeHtml(shortHash(item.content_hash))}</code>
    </li>`).join('');

  $('#truth-body').innerHTML = `
    <div class="truth-head">
      <div>
        <p class="truth-meta">SKU ${escapeHtml(project.sku)} · ${escapeHtml(project.category)}${project.platform ? ` · ${escapeHtml(project.platform)}` : ''}</p>
        <p class="truth-meta">当前事实版本 v${project.truth_head_version} · 生效素材 ${assets.filter(asset => asset.role_status === 'active').length} 张</p>
      </div>
      <span class="real-state ${readiness.can_start_production ? 'ok' : 'block'}">${readiness.can_start_production ? '可开始生产' : `阻断 ${readiness.blocker_count} 项`}</span>
    </div>
    <nav class="truth-nav" aria-label="检查与更新">
      <b>检查与更新</b>
      <button type="button" class="text-button" data-action="jump" data-target="change-section">变更</button>
      <button type="button" class="text-button" data-action="jump" data-target="check-section">SKU 核对</button>
      <button type="button" class="text-button" data-action="jump" data-target="question-section">售前问题</button>
      <button type="button" class="text-button" data-action="jump" data-target="explainer-section">说明图</button>
    </nav>
    <section class="truth-section">
      <h3>生产闸口</h3>
      ${renderBlockers(readiness.blockers)}
      ${readiness.warnings?.length ? `<ul class="truth-warnings">${readiness.warnings.map(item => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>` : ''}
    </section>
    <section class="truth-section">
      <h3>素材与参考职责</h3>
      ${assetsHtml}
    </section>
    <section class="truth-section">
      <h3>商品事实</h3>
      <p class="truth-hint">关键项必须勾选「已确认」才能确认版本；风格图不能作为事实来源；不清晰的信息请留待补证据，不要凭猜写入。</p>
      <div class="fact-head"><span>标记</span><span>事实项</span><span>值</span><span>来源</span><span>确认</span><span></span></div>
      <div id="truth-facts">${facts.map(fact => factRow(fact)).join('')}</div>
      <button type="button" class="text-button" data-action="add-fact">＋ 添加事实项</button>
    </section>
    <section class="truth-section">
      <h3>关键文字</h3>
      <p class="truth-hint">每行一条需要在成品上保持一致的包装文字。</p>
      <textarea id="truth-text" rows="3" placeholder="例如：MOON CALM">${escapeHtml(criticalText)}</textarea>
    </section>
    <p class="truth-error" id="truth-block-error" role="alert"></p>
    <div class="truth-actions">
      <button type="button" class="secondary" data-action="save-draft">保存草稿</button>
      <button type="button" class="primary" data-action="confirm">确认事实并生成新版本</button>
    </div>
    <section class="truth-section" id="sku-section">
      ${renderSkuSection()}
    </section>
    <section class="truth-section" id="change-section">
      ${renderChangeSection()}
    </section>
    <section class="truth-section" id="check-section">
      ${renderCheckSection()}
    </section>
    <section class="truth-section" id="question-section">
      ${renderQuestionSection()}
    </section>
    <section class="truth-section" id="explainer-section">
      ${renderExplainerSection()}
    </section>
    <section class="truth-section">
      <h3>版本历史</h3>
      ${history ? `<ul class="truth-history">${history}</ul>` : '<p class="truth-empty">尚无事实版本。</p>'}
    </section>`;
  void loadChanges(project.id);
  void loadSkuChecks(project.id);
  void loadQuestions(project.id);
  void loadExplainers(project.id);
}

// ---------- E01：SKU 档案板块 ----------

function renderSkuSection() {
  const { skuData } = state.detail;
  if (state.skuEditing) return renderSkuEditor();
  const head = skuData?.profile ?? null;
  if (!head) {
    const derived = skuData?.view?.skus?.[0];
    return `<h3>SKU 档案</h3>
      <p class="truth-hint">当前为「单规格（未建档）」：${escapeHtml(derived?.sku_code ?? '')} · 派生自商品信息，尚未确认。多规格商品请先建档。</p>
      <button type="button" class="text-button" data-action="sku-edit">建立 SKU 档案</button>`;
  }
  const cards = head.skus.map(sku => `<div class="sku-card">
    <div class="sku-card-head">
      <b>${escapeHtml(sku.sku_code)}</b><span>${escapeHtml(sku.label)}</span>
      <span class="real-state ${sku.confirmed ? 'ok' : 'muted'}">${sku.confirmed ? '已确认' : '未确认'}</span>
    </div>
    ${(sku.attributes ?? []).length ? `<p class="sku-line">差异属性：${sku.attributes.map(attr => `${escapeHtml(attr.key)} ${escapeHtml(attr.value)}${attr.unit ? escapeHtml(attr.unit) : ''}`).join('；')}</p>` : ''}
    ${(sku.contents ?? []).length ? `<ul class="sku-contents">${sku.contents.map(item => `<li>
      ${escapeHtml(item.item)} ×${item.quantity}${escapeHtml(item.unit)}
      <span class="real-state ${item.included ? 'ok' : 'muted'}">${item.included ? '包含' : '不包含（展示道具）'}</span>
      ${item.note ? `<span class="sku-note">${escapeHtml(item.note)}</span>` : ''}
    </li>`).join('')}</ul>` : ''}
  </div>`).join('');
  return `<h3>SKU 档案</h3>
    <p class="truth-meta">档案版本 v${head.version} · ${head.confirmation_status === 'confirmed' ? '已确认' : '草稿'} · ${escapeHtml(head.created_by)} · ${escapeHtml(formatTime(head.created_at))}</p>
    ${cards}
    <div class="truth-actions">
      <button type="button" class="text-button" data-action="sku-edit">编辑档案</button>
      <button type="button" class="text-button" data-action="sku-history">版本历史</button>
    </div>
    <div id="sku-history"></div>`;
}

function skuAttrRow(attr = {}) {
  return `<div class="sku-edit-row">
    <input data-attr="key" placeholder="属性，如 颜色" value="${escapeHtml(attr.key ?? '')}" maxlength="60">
    <input data-attr="value" placeholder="值（必填）" value="${escapeHtml(attr.value ?? '')}" maxlength="200">
    <input data-attr="unit" placeholder="单位（可选）" value="${escapeHtml(attr.unit ?? '')}" maxlength="20">
    <button type="button" class="icon-button" data-action="sku-remove-row" aria-label="删除该行">×</button>
  </div>`;
}

function skuContentRow(item = {}) {
  const activeAssets = (state.detail?.assets ?? []).filter(asset => asset.role_status === 'active' && asset.role !== 'style');
  const options = ['<option value="user_input">用户输入</option>']
    .concat(activeAssets.map(asset => `<option value="${escapeHtml(asset.id)}"${item.source_asset_id === asset.id ? ' selected' : ''}>素材：${escapeHtml(asset.filename)}</option>`));
  return `<div class="sku-edit-row sku-edit-content">
    <input data-ct="item" placeholder="物件，如 面霜瓶" value="${escapeHtml(item.item ?? '')}" maxlength="80">
    <input data-ct="quantity" type="number" min="0" step="any" placeholder="数量" value="${item.quantity ?? ''}">
    <input data-ct="unit" placeholder="单位，如 瓶/ml" value="${escapeHtml(item.unit ?? '')}" maxlength="20">
    <select data-ct="included" aria-label="是否包含">
      <option value="true"${item.included !== false ? ' selected' : ''}>包含</option>
      <option value="false"${item.included === false ? ' selected' : ''}>不包含（道具）</option>
    </select>
    <select data-ct="source" aria-label="来源">${options.join('')}</select>
    <input data-ct="note" placeholder="备注（可选）" value="${escapeHtml(item.note ?? '')}" maxlength="300">
    <button type="button" class="icon-button" data-action="sku-remove-row" aria-label="删除该行">×</button>
  </div>`;
}

function skuEditBlock(sku, index) {
  return `<div class="sku-edit" data-sku-index="${index}">
    <div class="sku-edit-row">
      <input data-sku="sku_code" placeholder="商家编号（必填）" value="${escapeHtml(sku.sku_code ?? '')}" maxlength="64">
      <input data-sku="label" placeholder="展示名（必填）" value="${escapeHtml(sku.label ?? '')}" maxlength="80">
      <label class="fact-flag"><input type="checkbox" data-sku="confirmed"${sku.confirmed ? ' checked' : ''}> 商家已确认</label>
      <button type="button" class="icon-button" data-action="sku-remove" aria-label="删除该 SKU">×</button>
    </div>
    <p class="truth-hint">差异属性（值不能为空；不确定的属性请删除该行）</p>
    <div data-sku-attrs>${(sku.attributes ?? []).map(skuAttrRow).join('')}</div>
    <button type="button" class="text-button" data-action="sku-add-attr">＋ 属性</button>
    <p class="truth-hint">包装包含物（数量与单位必填；单位仅支持 ml/L/g/kg/mg/mm/cm/m 与 件/个/条/包/瓶/盒/套 等标准计数单位）</p>
    <div data-sku-contents>${(sku.contents ?? []).map(skuContentRow).join('')}</div>
    <button type="button" class="text-button" data-action="sku-add-content">＋ 包含物</button>
  </div>`;
}

function renderSkuEditor() {
  const { skus, base_version: baseVersion } = state.skuEditing;
  return `<h3>SKU 档案 · 编辑中</h3>
    <p class="truth-meta">基于档案版本 v${baseVersion} 编辑；保存时若他人已更新会提示刷新。</p>
    ${skus.map((sku, index) => skuEditBlock(sku, index)).join('')}
    <button type="button" class="text-button" data-action="sku-add">＋ 添加 SKU</button>
    <p class="truth-error" id="sku-block-error" role="alert"></p>
    <div class="truth-actions">
      <button type="button" class="secondary" data-action="sku-cancel">取消</button>
      <button type="button" class="secondary" data-action="sku-save" data-confirm="false">保存草稿</button>
      <button type="button" class="primary" data-action="sku-save" data-confirm="true">全部确认并保存</button>
    </div>`;
}

function rerenderSkuSection() {
  const node = $('#sku-section');
  if (node) node.innerHTML = renderSkuSection();
}

/** 把当前编辑表单的 DOM 值收回到 state.skuEditing（加/删行前先收集，避免丢输入）。 */
function collectSkuEditor() {
  if (!state.skuEditing) return;
  const blocks = $$('#sku-section [data-sku-index]');
  state.skuEditing.skus = blocks.map((block, index) => {
    const previous = state.skuEditing.skus[index] ?? {};
    const read = selector => block.querySelector(selector)?.value.trim() ?? '';
    return {
      id: previous.id,
      sku_code: read('[data-sku="sku_code"]'),
      label: read('[data-sku="label"]'),
      confirmed: block.querySelector('[data-sku="confirmed"]')?.checked ?? false,
      attributes: $$('[data-sku-attrs] .sku-edit-row', block).map(row => ({
        key: row.querySelector('[data-attr="key"]').value.trim(),
        value: row.querySelector('[data-attr="value"]').value.trim(),
        unit: row.querySelector('[data-attr="unit"]').value.trim(),
      })).filter(attr => attr.key || attr.value),
      contents: $$('[data-sku-contents] .sku-edit-row', block).map(row => {
        const source = row.querySelector('[data-ct="source"]').value;
        const item = {
          item: row.querySelector('[data-ct="item"]').value.trim(),
          quantity: Number(row.querySelector('[data-ct="quantity"]').value),
          unit: row.querySelector('[data-ct="unit"]').value.trim(),
          included: row.querySelector('[data-ct="included"]').value === 'true',
          source: source === 'user_input' ? 'user_input' : 'asset',
        };
        if (item.source === 'asset') item.source_asset_id = source;
        const note = row.querySelector('[data-ct="note"]').value.trim();
        if (note) item.note = note;
        return item;
      }).filter(item => item.item),
    };
  });
}

async function saveSkus(confirm) {
  const errorNode = $('#sku-block-error');
  errorNode.textContent = '';
  collectSkuEditor();
  const { skus, base_version: baseVersion } = state.skuEditing;
  // 客户端先做一次基本检查，把明显的漏填拦截在请求之前
  if (skus.length === 0 || skus.some(sku => !sku.sku_code || !sku.label)) {
    errorNode.textContent = '每个 SKU 都需要填写商家编号与展示名。';
    return;
  }
  if (skus.some(sku => sku.contents.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0 || !item.unit))) {
    errorNode.textContent = '包含物的数量必须大于 0，单位必填。';
    return;
  }
  try {
    const payload = await api.putSkus(state.detail.project.id, { base_version: baseVersion, confirm, skus });
    state.toast(`SKU 档案已保存 v${payload.sku_profile.version}${confirm ? '（已确认）' : '（草稿）'}`);
    state.skuEditing = null;
    await openTruthDialog(state.detail.project.id);
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
      errorNode.textContent = '档案已被他人更新，请取消后重新打开编辑。';
      return;
    }
    if (error instanceof ApiFailure && error.code === 'CONFIRMATION_BLOCKED') {
      errorNode.textContent = `${error.message}（${(error.details?.unconfirmed ?? []).join('、')}）`;
      return;
    }
    errorNode.textContent = errorText(error);
  }
}

async function onSkuClick(action, trigger) {
  const { skuData } = state.detail;
  if (action === 'sku-edit') {
    const head = skuData?.profile ?? null;
    state.skuEditing = {
      base_version: head?.version ?? 0,
      skus: head
        ? head.skus.map(sku => ({ ...sku, attributes: [...(sku.attributes ?? [])], contents: [...(sku.contents ?? [])] }))
        : [{ sku_code: skuData?.view?.skus?.[0]?.sku_code ?? '', label: state.detail.project.name, attributes: [], contents: [], confirmed: false }],
    };
    rerenderSkuSection();
    return;
  }
  if (action === 'sku-cancel') { state.skuEditing = null; rerenderSkuSection(); return; }
  if (action === 'sku-save') { await saveSkus(trigger.dataset.confirm === 'true'); return; }
  if (action === 'sku-history') {
    const holder = $('#sku-history');
    if (holder.dataset.loaded) { holder.innerHTML = ''; delete holder.dataset.loaded; return; }
    const versions = await api.listSkuVersions(state.detail.project.id);
    holder.dataset.loaded = '1';
    holder.innerHTML = versions.versions.length
      ? `<ul class="truth-history">${versions.versions.map(item => `<li><b>v${item.version}</b><span>${item.confirmation_status === 'confirmed' ? '已确认' : '草稿'} · ${item.sku_count} 个 SKU · ${escapeHtml(item.created_by)} · ${escapeHtml(formatTime(item.created_at))}</span><code>${escapeHtml(shortHash(item.content_hash))}</code></li>`).join('')}</ul>`
      : '<p class="truth-empty">尚无档案版本。</p>';
    return;
  }
  if (!state.skuEditing) return;
  collectSkuEditor();
  const block = trigger.closest('[data-sku-index]');
  const index = block ? Number(block.dataset.skuIndex) : -1;
  if (action === 'sku-add') state.skuEditing.skus.push({ sku_code: '', label: '', attributes: [], contents: [], confirmed: false });
  if (action === 'sku-remove' && index >= 0) {
    if (state.skuEditing.skus.length <= 1) { state.skuEditing.skus[0] = { sku_code: '', label: '', attributes: [], contents: [], confirmed: false }; }
    else state.skuEditing.skus.splice(index, 1);
  }
  if (action === 'sku-add-attr' && index >= 0) state.skuEditing.skus[index].attributes.push({ key: '', value: '', unit: '' });
  if (action === 'sku-add-content' && index >= 0) state.skuEditing.skus[index].contents.push({ item: '', quantity: 1, unit: '', included: true, source: 'user_input' });
  if (action === 'sku-remove-row' && index >= 0) {
    const row = trigger.closest('.sku-edit-row');
    const inAttrs = row.parentElement.hasAttribute('data-sku-attrs');
    const rows = [...row.parentElement.children];
    const rowIndex = rows.indexOf(row);
    if (inAttrs) state.skuEditing.skus[index].attributes.splice(rowIndex, 1);
    else state.skuEditing.skus[index].contents.splice(rowIndex, 1);
  }
  rerenderSkuSection();
}

// ---------- E03：商品变更更新助手 ----------
// 数据流：preview（不落库）→ confirm（Idempotency-Key + base_truth_version 乐观锁）→
// 逐项执行（重合成免费/重生成按张计费需报价确认）→ 数量类人工视觉核对 →
// 失败项重试 / 待补实拍登记素材续做 → 结果版本人工选用 → 导出 + 旧导出替换待办登记。
// 所有状态都来自服务端变更单，前端不本地伪造进度。

const CHANGE_STATUS_META = {
  draft: ['草稿', 'neutral'],
  confirmed: ['已确认待执行', 'blue'],
  executing: ['执行中', 'blue'],
  completed: ['已完成', 'ok'],
  partial_failed: ['部分失败', 'red'],
  awaiting_material: ['待补实拍素材', 'amber'],
  awaiting_review: ['待人工核对', 'amber'],
  cancelled: ['已取消', 'neutral'],
};
const CHANGE_ACTION_LABEL = {
  text_recompose: '文字重合成（免费）',
  regenerate: '重生成（按张计费）',
  needs_new_photo: '需新实拍',
  needs_review: '需人工核对',
  skip: '跳过',
};
const CHANGE_ITEM_STATUS_META = {
  pending: ['待处理', 'neutral'],
  running: ['执行中', 'blue'],
  done: ['已完成', 'ok'],
  failed: ['失败', 'red'],
  skipped: ['已跳过', 'neutral'],
};
const CHANGE_AWAITING_LABEL = { material: '待补实拍', review: '待人工核对', user: '商家已主动跳过' };
const CHANGE_COUNT_LABELS = [
  ['pending', '待处理'], ['running', '执行中'], ['done', '已完成'], ['failed', '失败'],
  ['skipped', '已跳过'], ['pending_visual_checks', '待视觉核对'],
  ['awaiting_material', '待补实拍'], ['awaiting_review', '待人工核对'],
];
const CHANGE_CANCELLABLE = ['confirmed', 'partial_failed', 'awaiting_material', 'awaiting_review', 'executing'];

function emptyChangeState(projectId) {
  return {
    projectId, loading: true, error: '', notice: '',
    changes: [], todos: [], draft: null, detailId: null, detail: null, quoteConfirm: null,
  };
}

async function loadChanges(projectId) {
  if (!state.change || state.change.projectId !== projectId) state.change = emptyChangeState(projectId);
  const area = state.change;
  area.loading = true;
  area.error = '';
  rerenderChangeSection();
  try {
    const [changesRes, todosRes] = await Promise.all([
      api.listChanges(projectId),
      api.listReplacementTodos({ projectId }),
    ]);
    if (state.change !== area) return; // 已切换到其它项目，丢弃过期结果
    area.changes = changesRes.changes ?? [];
    area.todos = todosRes.replacement_todos ?? [];
    area.loading = false;
    if (area.detailId) {
      try {
        const detail = await api.getChange(area.detailId);
        if (state.change !== area) return;
        area.detail = detail.change;
      } catch (error) {
        if (state.change !== area) return;
        area.detail = null;
        area.detailId = null;
        area.error = errorText(error);
      }
    }
  } catch (error) {
    if (state.change !== area) return;
    area.loading = false;
    area.error = errorText(error);
  }
  rerenderChangeSection();
}

function rerenderChangeSection() {
  const node = $('#change-section');
  if (node) node.innerHTML = renderChangeSection();
}

function renderChangeSection() {
  const area = state.change;
  if (!area || area.projectId !== state.detail?.project?.id) {
    return '<h3>商品变更</h3><p class="truth-hint">正在读取变更记录…</p>';
  }
  const parts = ['<h3>商品变更</h3>'];
  parts.push('<p class="truth-hint">商品事实、素材或品牌有更新时，在这里计算差异并逐项更新已生成的图片；数量类变化与质检待复核的新版本必须人工核对后才算完成。</p>');
  if (area.error) parts.push(`<p class="truth-error" role="alert">${escapeHtml(area.error)}</p>`);
  if (area.notice) parts.push(`<p class="truth-hint chg-notice">${escapeHtml(area.notice)}</p>`);
  if (area.loading) {
    parts.push('<div class="loading-line"></div>');
    return parts.join('');
  }
  parts.push(area.draft ? renderChangeDraft(area) : '<button type="button" class="text-button" data-action="chg-new">＋ 发起商品变更</button>');
  parts.push(renderChangeDetail(area));
  parts.push(renderChangeList(area));
  parts.push(renderChangeTodos(area));
  return parts.join('');
}

/** 变更单列表：整单状态由服务端 deriveChangeStatus 推导，如实展示，不把 awaiting 渲染成完成。 */
function renderChangeList(area) {
  if (area.changes.length === 0) return '<p class="truth-empty">尚无变更单。商品信息更新后可在这里发起变更。</p>';
  return `<ul class="chg-list">${area.changes.map(change => {
    const [label, tone] = CHANGE_STATUS_META[change.status] ?? [change.status, 'neutral'];
    return `<li class="chg-row">
      <span class="wb-status ${tone}">${escapeHtml(label)}</span>
      <span class="chg-meta">事实 v${change.base_truth_version} → v${change.new_truth_version} · ${change.impact_items?.length ?? 0} 项 · ${escapeHtml(formatTime(change.created_at))}</span>
      <button type="button" class="text-button" data-action="chg-open" data-change-id="${escapeHtml(change.id)}">${area.detailId === change.id ? '收起' : '查看 / 处理'}</button>
    </li>`;
  }).join('')}</ul>`;
}

/** 旧导出替换待办：只登记「商家已手动替换」，不暗示平台已同步。 */
function renderChangeTodos(area) {
  const note = '<p class="truth-hint">以下待办仅在商家确认已手动到各渠道替换旧图后登记，不代表平台已同步。</p>';
  if (area.todos.length === 0) {
    return `<div class="chg-todos"><h4>旧导出替换待办</h4>${note}<p class="truth-empty">当前没有待替换的旧导出。</p></div>`;
  }
  return `<div class="chg-todos"><h4>旧导出替换待办</h4>${note}<ul class="chg-list">${area.todos.map(todo => {
    const done = todo.status === 'replaced';
    return `<li class="chg-row">
      <span class="wb-status ${done ? 'ok' : 'amber'}">${done ? '已确认替换' : '待替换'}</span>
      <span class="chg-meta">导出 ${escapeHtml(String(todo.export_id).slice(0, 14))}…（渠道：${escapeHtml((todo.channel_labels ?? []).join('、') || '未标注')}） · ${escapeHtml(todo.deliverable_id)} · 旧版本 → 新版本 ${escapeHtml(String(todo.new_version_id).slice(0, 12))}…</span>
      ${done
        ? `<span class="chg-meta">${escapeHtml(todo.confirmed_by ?? '')} · ${escapeHtml(formatTime(todo.confirmed_at))}</span>`
        : `<button type="button" class="text-button" data-action="chg-todo-confirm" data-todo-id="${escapeHtml(todo.id)}">确认已手动替换</button>`}
    </li>`;
  }).join('')}</ul></div>`;
}

function chgFactRow(fact, index) {
  return `<div class="fact-row chg-fact-row" data-chg-fact="${index}">
    <label class="fact-flag"><input type="checkbox" data-chg-fact-field="critical"${fact.critical ? ' checked' : ''}> 关键</label>
    <input data-chg-fact-field="key" placeholder="事实项，如 容量" value="${escapeHtml(fact.key ?? '')}" maxlength="60">
    <input data-chg-fact-field="value" placeholder="值，如 50g" value="${escapeHtml(fact.value ?? '')}" maxlength="500">
    <label class="fact-flag"><input type="checkbox" data-chg-fact-field="confirmed"${fact.confirmed ? ' checked' : ''}> 已确认</label>
  </div>`;
}

/** 变更编辑区：新事实/关键文字/已更换素材；预览结果（差异 + 影响清单 + 预算）来自服务端。 */
function renderChangeDraft(area) {
  const { draft } = area;
  const parts = ['<div class="chg-draft">'];
  parts.push('<h4>发起商品变更</h4>');
  parts.push(`<p class="truth-hint">基于当前事实版本 v${state.detail.project.truth_head_version} 编辑；确认后生成新事实版本与变更单，预览本身不落库。</p>`);
  parts.push('<p class="truth-hint">商品事实（与当前版本逐项比对差异；关键项需勾选已确认）</p>');
  parts.push(draft.facts.map((fact, index) => chgFactRow(fact, index)).join(''));
  parts.push('<button type="button" class="text-button" data-action="chg-add-fact">＋ 添加事实项</button>');
  parts.push('<p class="truth-hint">关键文字（每行一条包装文字；变化等同实物包装变化，需新实拍）</p>');
  parts.push(`<textarea class="chg-text" rows="3" data-chg-field="critical_text">${escapeHtml(draft.criticalText)}</textarea>`);
  const assets = (state.detail?.assets ?? []).filter(asset => asset.role_status === 'active' && asset.role !== 'style');
  if (assets.length > 0) {
    parts.push('<p class="truth-hint">已更换的素材（如换包装；依赖该素材的图片会被标记为需新实拍）</p>');
    parts.push(`<div class="chg-assets">${assets.map(asset => `<label class="fact-flag">
      <input type="checkbox" data-chg-asset="${escapeHtml(asset.id)}"${draft.changedAssetIds.includes(asset.id) ? ' checked' : ''}> ${escapeHtml(asset.filename)}（${ROLE_LABELS[asset.role] ?? asset.role}）
    </label>`).join('')}</div>`);
  }
  parts.push(`<label class="fact-flag"><input type="checkbox" data-chg-field="brand_kit_changed"${draft.brandKitChanged ? ' checked' : ''}> 品牌套件已更新（不自动作用于历史图片，相关版本进入人工核对）</label>`);
  parts.push('<p class="truth-error" id="change-error" role="alert"></p>');
  parts.push(`<div class="truth-actions">
    <button type="button" class="secondary" data-action="chg-draft-cancel">取消</button>
    <button type="button" class="secondary" data-action="chg-preview">预览差异与影响</button>
    ${draft.preview && !draft.preview.empty ? '<button type="button" class="primary" data-action="chg-confirm">确认变更</button>' : ''}
  </div>`);
  if (draft.preview) parts.push(renderChangePreview(draft.preview));
  parts.push('</div>');
  return parts.join('');
}

function renderChangePreview(preview) {
  if (preview.empty) {
    return '<div class="state-note"><div><b>与当前版本没有差异</b><br>请修改事实、关键文字或素材后再预览；无差异不会创建变更单。</div></div>';
  }
  const diff = preview.diff ?? {};
  const factLines = (diff.facts ?? []).map(item => {
    const label = { added: '新增', removed: '删除', changed: '修改' }[item.change] ?? item.change;
    const from = item.from ? `${item.from.value ?? ''}${item.from.unit ?? ''}` : '—';
    const to = item.to ? `${item.to.value ?? ''}${item.to.unit ?? ''}` : '—';
    return `<li>${escapeHtml(item.key)}（${label}）：${escapeHtml(from)} → ${escapeHtml(to)}</li>`;
  });
  if (diff.critical_text) factLines.push(`<li>关键文字：${escapeHtml((diff.critical_text.from ?? []).join('、') || '—')} → ${escapeHtml((diff.critical_text.to ?? []).join('、') || '—')}</li>`);
  if (diff.category) factLines.push(`<li>类目：${escapeHtml(diff.category.from ?? '—')} → ${escapeHtml(diff.category.to ?? '—')}</li>`);
  for (const assetId of diff.changed_asset_ids ?? []) factLines.push(`<li>素材已更换：${escapeHtml(assetId)}</li>`);
  if (diff.brand_kit_changed) factLines.push('<li>品牌套件已更新</li>');
  const items = preview.impact_items ?? [];
  const quote = preview.quote ?? {};
  return `<div class="chg-preview">
    <h4>差异与影响预览（未落库）</h4>
    <ul class="chg-diff">${factLines.join('')}</ul>
    ${items.length === 0
      ? '<p class="truth-hint">当前没有匹配到受影响的图片版本。</p>'
      : `<ul class="chg-impact">${items.map(item => `<li>
          <b>${escapeHtml(item.deliverable_label ?? item.deliverable_id)}</b>
          <span class="wb-status ${item.action === 'needs_new_photo' ? 'amber' : item.action === 'needs_review' ? 'amber' : 'blue'}">${escapeHtml(CHANGE_ACTION_LABEL[item.action] ?? item.action)}</span>
          ${item.visual_check === 'required' ? '<span class="wb-status amber">完成后需人工视觉核对</span>' : ''}
          <span class="chg-meta">当前版本 ${escapeHtml(String(item.version_id).slice(0, 12))}… · 命中 ${escapeHtml((item.matched ?? []).join('、') || '依赖记录不足')}</span>
          ${item.reason ? `<span class="chg-reason">${escapeHtml(item.reason)}</span>` : ''}
        </li>`).join('')}</ul>`}
    <p class="chg-quote">预算：预计消耗 ${quote.estimated_credits ?? 0} 点（重生成 ${quote.regenerate_count ?? 0} 项计费 · 文字重合成 ${quote.recompose_count ?? 0} 项免费 · 需新实拍 ${quote.new_photo_count ?? 0} 项 · 需人工核对 ${quote.review_count ?? 0} 项）</p>
    ${(quote.notes ?? []).map(line => `<p class="truth-hint">${escapeHtml(line)}</p>`).join('')}
  </div>`;
}

/** 变更单详情：逐项状态 + 执行/核对/补拍/选用/重试/取消/导出入口。 */
function renderChangeDetail(area) {
  const detail = area.detail;
  if (!detail) return '';
  const [statusLabel, statusTone] = CHANGE_STATUS_META[detail.status] ?? [detail.status, 'neutral'];
  const counts = detail.counts ?? {};
  const parts = [`<div class="chg-detail" data-change-id="${escapeHtml(detail.id)}">
    <div class="chg-detail-head">
      <span class="wb-status ${statusTone}">${escapeHtml(statusLabel)}</span>
      <span class="chg-meta">变更单 ${escapeHtml(detail.id)} · 事实 v${detail.base_truth_version} → v${detail.new_truth_version}</span>
      <button type="button" class="text-button" data-action="chg-refresh">刷新状态</button>
    </div>
    <div class="chg-counts">${CHANGE_COUNT_LABELS
      .filter(([key]) => (counts[key] ?? 0) > 0)
      .map(([key, label]) => `<span class="wb-chip">${label} ${counts[key]}</span>`).join('')}</div>`];
  if (detail.status === 'awaiting_material') {
    parts.push('<div class="state-note warn"><div><b>待补实拍素材</b><br>有图片需要新实拍照片才能更新；跳过不等于更新完成。请在对应项上传补拍素材后继续处理。</div></div>');
  }
  if (detail.status === 'awaiting_review') {
    parts.push('<div class="state-note warn"><div><b>待人工核对</b><br>有图片证据不足，需人工核对处理方式（撤下/改文案/重拍）；未核对前不算更新完成。</div></div>');
  }
  if ((counts.pending_visual_checks ?? 0) > 0) {
    parts.push('<div class="state-note warn"><div><b>待人工视觉核对</b><br>数量/套装类变化不能只换字就放行：请逐项核对画面数量表达后提交核对结论，未核对前整单不完成。</div></div>');
  }
  if (detail.status === 'partial_failed') {
    parts.push('<div class="state-note danger"><div><b>部分失败</b><br>成功项已保留；失败项可单独重试（重试才产生新预留，不重复扣费）。</div></div>');
  }
  if (area.quoteConfirm) {
    const quote = area.quoteConfirm.quote;
    parts.push(`<div class="state-note warn chg-quote-confirm"><div><b>确认重生成报价</b><br>本次执行含重生成项，按服务端当前报价预计消耗 ${quote.estimated_credits} 点（价格口径 ${escapeHtml(quote.price_version)}）。确认后才会预留额度并执行。
      <div class="state-actions"><button type="button" class="primary" data-action="chg-quote-confirm">确认报价并执行</button><button type="button" class="secondary" data-action="chg-quote-cancel">放弃本次执行</button></div></div></div>`);
  }
  parts.push(`<ul class="chg-items">${(detail.impact_items ?? []).map(item => renderChangeItem(item, detail)).join('')}</ul>`);
  const actions = [];
  if ((counts.pending ?? 0) > 0 && detail.status !== 'cancelled') {
    actions.push('<button type="button" class="primary" data-action="chg-execute-all">执行全部待处理项</button>');
  }
  if (detail.status === 'partial_failed') {
    actions.push('<button type="button" class="secondary" data-action="chg-retry">只重试失败项</button>');
  }
  if (CHANGE_CANCELLABLE.includes(detail.status)) {
    actions.push('<button type="button" class="secondary" data-action="chg-cancel">取消变更单</button>');
  }
  if (actions.length > 0) parts.push(`<div class="truth-actions">${actions.join('')}</div>`);
  if (detail.status === 'completed') parts.push(renderChangeExports(detail, area));
  parts.push('</div>');
  return parts.join('');
}

function renderChangeItem(item, detail) {
  const [statusLabel, statusTone] = CHANGE_ITEM_STATUS_META[item.status] ?? [item.status, 'neutral'];
  const parts = [`<li class="chg-item" data-item-id="${escapeHtml(item.id)}">
    <div class="chg-item-head">
      <b>${escapeHtml(item.deliverable_label ?? item.deliverable_id)}</b>
      <span class="wb-status ${statusTone}">${escapeHtml(statusLabel)}</span>
      <span class="chg-meta">建议：${escapeHtml(CHANGE_ACTION_LABEL[item.action] ?? item.action)} · 当前版本 ${escapeHtml(String(item.version_id ?? '').slice(0, 12))}…</span>
    </div>`];
  if (item.reason) parts.push(`<p class="chg-reason">${escapeHtml(item.reason)}</p>`);
  if ((item.matched ?? []).length > 0) parts.push(`<p class="chg-meta">命中：${escapeHtml(item.matched.join('、'))}</p>`);
  if (item.status === 'running') {
    parts.push(`<p class="chg-meta">执行中${item.child_run_id ? `（子任务 ${escapeHtml(String(item.child_run_id).slice(0, 14))}…）` : ''}，请稍后刷新。</p>`);
  }
  if (item.status === 'failed') {
    parts.push(`<p class="truth-error" role="alert">${escapeHtml(item.error ?? '执行失败')}${item.error_code ? `（${escapeHtml(item.error_code)}）` : ''}</p>`);
    if (item.error_code === 'REGENERATION_NEEDS_REVIEW') {
      parts.push(`<p class="truth-hint">重生成结果质检待人工复核，未自动选用：请到源任务详情复核放行并人工选用新版本，不要在变更单里重复重试扣费。</p>
        <button type="button" class="text-button" data-action="chg-open-source">打开工作台复核源任务</button>`);
    }
  }
  if (item.status === 'skipped') {
    parts.push(`<p class="chg-meta">${escapeHtml(item.skip_reason ?? '已跳过')} · ${escapeHtml(CHANGE_AWAITING_LABEL[item.awaiting] ?? '已跳过')}</p>`);
    if (item.awaiting === 'material') {
      parts.push(`<div class="chg-material">
        <p class="truth-hint">该项实物已变化，需要新实拍照片：上传补拍素材并登记后，该项恢复为可执行的文字重合成（以新素材为底图）。</p>
        <input type="file" accept="image/jpeg,image/png,image/webp" data-chg-material-file aria-label="补拍素材文件">
        <button type="button" class="secondary" data-action="chg-material" data-item-id="${escapeHtml(item.id)}">上传并登记补拍素材</button>
      </div>`);
    }
    if (item.awaiting === 'review') {
      parts.push(renderItemActionPicker(item));
    }
  }
  if (item.status === 'pending') {
    if (item.action === 'needs_new_photo' && !item.material_asset_id) {
      parts.push('<p class="truth-hint">该项需新实拍：登记补拍素材前不能选择文字重合成或重生成（服务端会拒绝，避免用换字冒充实物变化）。</p>');
    }
    parts.push(renderItemActionPicker(item));
  }
  if (item.status === 'done') {
    if (item.charged_credits > 0) parts.push(`<p class="chg-meta">已按张结算 ${item.charged_credits} 点。</p>`);
    if (item.pending_adoption) parts.push('<p class="wb-chip warn">新版本未自动选用：核对通过后将一并选用</p>');
    if (item.visual_check === 'required') {
      parts.push(`<div class="chg-visual-check">
        <p class="truth-hint">需人工视觉核对（数量表达/重合成效果）：请填写核对结论后提交。${item.pending_adoption ? '核对通过会同时选用新版本。' : ''}</p>
        <input type="text" data-chg-check-reason maxlength="300" placeholder="核对结论（必填，≤300 字），如：已核对画面数量表达为 2 瓶，与新事实一致">
        <button type="button" class="secondary" data-action="chg-visual-check" data-item-id="${escapeHtml(item.id)}">提交核对结论</button>
      </div>`);
    }
    if (item.visual_check === 'passed') {
      parts.push(`<p class="chg-meta">视觉核对已通过：${escapeHtml(item.visual_check_reason ?? '')}（${escapeHtml(item.visual_check_by ?? '')} · ${escapeHtml(formatTime(item.visual_check_at))}）</p>`);
    }
    if (item.result_version_id) {
      parts.push(`<button type="button" class="text-button" data-action="chg-activate" data-run-id="${escapeHtml(item.run_id)}" data-version-id="${escapeHtml(item.result_version_id)}">选用此版本</button>`);
    }
  }
  parts.push('</li>');
  return parts.join('');
}

/** 单项动作选择：text_recompose / regenerate / skip；needs_review 覆盖必须附确切依据。 */
function renderItemActionPicker(item) {
  const options = [];
  const allowText = item.action === 'text_recompose' || item.action === 'needs_review' || Boolean(item.material_asset_id);
  const allowRegen = item.action !== 'needs_new_photo' || Boolean(item.material_asset_id);
  if (allowText) options.push(['text_recompose', '文字重合成（免费）']);
  if (allowRegen) options.push(['regenerate', '重生成（按张计费）']);
  options.push(['skip', '跳过（知情放弃，不阻塞整单完成）']);
  const selected = options.some(([value]) => value === item.action) ? item.action : 'skip';
  return `<div class="chg-item-actions">
    <select data-chg-action-select aria-label="处理动作">${options.map(([value, label]) =>
      `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('')}</select>
    ${item.action === 'needs_review'
      ? '<input type="text" data-chg-override-reason maxlength="300" placeholder="覆盖为处理动作时的确切依据（必填），如：已人工核对品牌更新不影响此图">'
      : ''}
    <button type="button" class="secondary" data-action="chg-execute-item" data-item-id="${escapeHtml(item.id)}">按所选动作执行</button>
  </div>`;
}

/** 完成后导出入口：按受影响的源任务导出更新后的套图。 */
function renderChangeExports(detail, area) {
  const runIds = [...new Set((detail.impact_items ?? [])
    .filter(item => item.result_version_id)
    .map(item => item.run_id))];
  if (runIds.length === 0) return '';
  return `<div class="chg-exports">
    <h4>导出更新后的套图</h4>
    <p class="truth-hint">导出后如有旧导出包含被替换的旧版本，会在下方「旧导出替换待办」登记；替换动作由商家在各渠道手动完成。</p>
    ${runIds.map(runId => {
      const exportedId = area.exportedByRun?.[runId];
      return `<div class="chg-row">
        <button type="button" class="secondary" data-action="chg-export" data-run-id="${escapeHtml(runId)}">导出任务 ${escapeHtml(String(runId).slice(0, 14))}… 的更新套图</button>
        ${exportedId ? `<a class="text-button" href="${escapeHtml(api.downloadExportUrl(exportedId))}">下载导出包</a>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

/** 把编辑区 DOM 值收回 draft（预览/确认前先收集，避免丢输入）。 */
function collectChangeDraft(draft) {
  const root = $('#change-section');
  if (!root) return;
  $$('.chg-fact-row', root).forEach(row => {
    const index = Number(row.dataset.chgFact);
    const fact = draft.facts[index];
    if (!fact) return;
    fact.key = row.querySelector('[data-chg-fact-field="key"]').value.trim();
    fact.value = row.querySelector('[data-chg-fact-field="value"]').value.trim();
    fact.critical = row.querySelector('[data-chg-fact-field="critical"]').checked;
    fact.confirmed = row.querySelector('[data-chg-fact-field="confirmed"]').checked;
  });
  const textArea = root.querySelector('[data-chg-field="critical_text"]');
  if (textArea) draft.criticalText = textArea.value;
  draft.changedAssetIds = $$('[data-chg-asset]:checked', root).map(input => input.dataset.chgAsset);
  const brand = root.querySelector('[data-chg-field="brand_kit_changed"]');
  if (brand) draft.brandKitChanged = brand.checked;
}

function changeDraftPayload(draft) {
  return {
    sku: state.detail.project.sku,
    category: state.detail.project.category,
    facts: draft.facts.filter(fact => fact.key && fact.value),
    critical_text: draft.criticalText.split('\n').map(line => line.trim()).filter(Boolean)
      .map(text => ({ text, case_sensitive: true, normalization: 'trim' })),
    changed_asset_ids: draft.changedAssetIds,
    brand_kit_changed: draft.brandKitChanged,
  };
}

function changeError(message) {
  const node = $('#change-error');
  if (node) node.textContent = message ?? '';
  else if (state.change) state.change.error = message ?? '';
}

function newChangeIdempotencyKey() {
  return `chg-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

async function submitChangePreview() {
  const area = state.change;
  const draft = area?.draft;
  if (!draft) return;
  collectChangeDraft(draft);
  draft.preview = null;
  changeError('');
  try {
    draft.preview = await api.previewChange(area.projectId, changeDraftPayload(draft));
    if (draft.preview.empty) changeError('');
  } catch (error) {
    changeError(errorText(error));
  }
  rerenderChangeSection();
}

async function confirmChangeOrder() {
  const area = state.change;
  const draft = area?.draft;
  if (!draft?.preview || draft.preview.empty) return;
  collectChangeDraft(draft);
  changeError('');
  try {
    const payload = await api.confirmChange(area.projectId, {
      ...changeDraftPayload(draft),
      base_truth_version: draft.preview.base_truth_version,
    }, draft.idempotencyKey);
    state.toast(payload.replayed ? '该变更已提交过，已为你打开原变更单' : `变更单已创建（事实 v${payload.change.new_truth_version}）`);
    area.draft = null;
    area.detailId = payload.change.id;
    area.detail = payload.change;
    await refresh();
    await loadChanges(area.projectId);
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
      changeError(`商品事实已有新变更（服务端当前为 v${error.details?.current_version ?? '？'}），请刷新后重新预检，本次未创建变更单`);
    } else if (error instanceof ApiFailure && error.code === 'IDEMPOTENCY_KEY_CONFLICT') {
      draft.idempotencyKey = newChangeIdempotencyKey();
      changeError('提交标识冲突，已为你生成新标识，请重新点击「确认变更」');
    } else if (error instanceof ApiFailure && error.code === 'NO_CHANGES') {
      changeError('与当前版本没有差异，未创建变更单');
    } else {
      changeError(errorText(error));
    }
  }
  rerenderChangeSection();
}

/** 执行入口：整单待处理或单项。重生成项被报价闸口拦截时，展示服务端当前报价供确认后重发。 */
async function executeChangeOrder(itemId) {
  const area = state.change;
  const detail = area?.detail;
  if (!detail) return;
  const body = {};
  if (itemId) {
    const row = $(`#change-section .chg-item[data-item-id="${CSS.escape(itemId)}"]`);
    const action = row?.querySelector('[data-chg-action-select]')?.value;
    const item = detail.impact_items.find(entry => entry.id === itemId);
    body.item_ids = [itemId];
    if (action) body.actions = { [itemId]: action };
    if (item?.action === 'needs_review' && action && action !== 'skip' && action !== item.action) {
      const reason = row?.querySelector('[data-chg-override-reason]')?.value.trim() ?? '';
      if (reason === '') {
        area.error = '该项证据不足（需人工核对）：选择处理动作时必须填写确切依据，不能靠选择动作绕过人工判断';
        rerenderChangeSection();
        return;
      }
      body.override_reasons = { [itemId]: reason };
    }
  }
  await runChangeExecution(area, body);
}

async function runChangeExecution(area, body, { quoteConfirmed = false } = {}) {
  area.error = '';
  try {
    const payload = await api.executeChange(area.detail.id, body);
    area.detail = payload.change;
    area.quoteConfirm = null;
    area.notice = '执行请求已受理；异步重生成项请刷新查看进度';
    await loadChanges(area.projectId);
  } catch (error) {
    if (error instanceof ApiFailure && (error.code === 'QUOTE_CONFIRMATION_REQUIRED' || error.code === 'QUOTE_STALE')) {
      // 报价闸口：如实展示服务端当前报价，商家确认后带 quote_confirm 重发同一请求
      area.quoteConfirm = { body, quote: error.details?.quote ?? null };
      area.error = error.code === 'QUOTE_STALE' ? '报价已变化，请按最新报价重新确认' : '';
    } else if (error instanceof ApiFailure && error.code === 'HARD_OVERRIDE_BLOCKED') {
      area.error = `${error.message}（不能用换字或重绘冒充实物变化）`;
    } else if (error instanceof ApiFailure && error.code === 'INSUFFICIENT_CREDITS') {
      area.error = error.message;
    } else {
      area.error = errorText(error);
    }
    rerenderChangeSection();
    return;
  }
  if (quoteConfirmed) state.toast('已按确认报价执行');
}

async function retryChangeOrder() {
  const area = state.change;
  if (!area?.detail) return;
  area.error = '';
  try {
    const payload = await api.retryChange(area.detail.id);
    area.detail = payload.change;
    area.notice = '已重试失败项（新子任务单独预留，成功只结算一次）';
    await loadChanges(area.projectId);
  } catch (error) {
    area.error = errorText(error);
    rerenderChangeSection();
  }
}

async function cancelChangeOrder() {
  const area = state.change;
  if (!area?.detail) return;
  if (!window.confirm('确认取消该变更单？运行中的重生成子任务会一并请求取消，已预留额度随子任务终态释放，不会重复扣费。')) return;
  area.error = '';
  try {
    const payload = await api.cancelChange(area.detail.id, { reason: '商家在界面取消' });
    area.detail = payload.change;
    area.quoteConfirm = null;
    state.toast('变更单已取消');
    await loadChanges(area.projectId);
  } catch (error) {
    area.error = errorText(error);
    rerenderChangeSection();
  }
}

/** 数量/重合成结果的人工视觉核对：核对通过时服务端一并选用待选用的新版本。 */
async function submitVisualCheck(itemId) {
  const area = state.change;
  if (!area?.detail) return;
  const row = $(`#change-section .chg-item[data-item-id="${CSS.escape(itemId)}"]`);
  const reason = row?.querySelector('[data-chg-check-reason]')?.value.trim() ?? '';
  if (reason === '') {
    area.error = '请填写核对结论（reason 必填，说明画面与新事实是否一致）';
    rerenderChangeSection();
    return;
  }
  area.error = '';
  try {
    const payload = await api.visualCheckItem(area.detail.id, itemId, { reason });
    area.detail = payload.change;
    area.notice = '核对结论已登记';
    await loadChanges(area.projectId);
  } catch (error) {
    area.error = errorText(error);
    rerenderChangeSection();
  }
}

/** 补拍素材登记：上传（role=packaging）→ 登记到变更项 → 项恢复为可执行的文字重合成。 */
async function attachChangeMaterial(itemId, trigger) {
  const area = state.change;
  if (!area?.detail) return;
  const row = trigger.closest('.chg-item');
  const file = row?.querySelector('[data-chg-material-file]')?.files?.[0];
  if (!file) {
    area.error = '请先选择补拍素材图片文件（JPEG / PNG / WebP）';
    rerenderChangeSection();
    return;
  }
  trigger.disabled = true;
  area.error = '';
  try {
    const uploaded = await api.uploadAsset(area.projectId, file, { role: 'packaging' });
    const payload = await api.attachChangeItemMaterial(area.detail.id, itemId, { asset_id: uploaded.asset.id });
    area.detail = payload.change;
    area.notice = '补拍素材已登记，该项恢复为可执行的文字重合成（以新素材为底图）';
    await loadChanges(area.projectId);
  } catch (error) {
    area.error = errorText(error);
    rerenderChangeSection();
  }
}

/** 选用/恢复结果版本：复用既有版本选用接口，不绕过任务详情的人工复核。 */
async function activateChangeVersion(runId, versionId) {
  const area = state.change;
  if (!area) return;
  area.error = '';
  try {
    await api.activateVersion(runId, versionId);
    state.toast('已选用该版本');
    await loadChanges(area.projectId);
  } catch (error) {
    area.error = errorText(error);
    rerenderChangeSection();
  }
}

async function exportChangeRun(runId, trigger) {
  const area = state.change;
  if (!area) return;
  trigger.disabled = true;
  area.error = '';
  try {
    const payload = await api.createExport(runId);
    area.exportedByRun = { ...(area.exportedByRun ?? {}), [runId]: payload.export.id };
    state.toast('导出包已生成');
    await loadChanges(area.projectId);
    area.exportedByRun = { ...(area.exportedByRun ?? {}), [runId]: payload.export.id };
    rerenderChangeSection();
  } catch (error) {
    area.error = errorText(error);
    rerenderChangeSection();
  }
}

async function confirmReplacementTodoItem(todoId) {
  const area = state.change;
  if (!area) return;
  area.error = '';
  try {
    await api.confirmReplacementTodo(todoId, {});
    state.toast('已登记：商家确认已在各渠道手动替换旧图（不代表平台已同步）');
    await loadChanges(area.projectId);
  } catch (error) {
    area.error = errorText(error);
    rerenderChangeSection();
  }
}

async function onChangeClick(action, trigger) {
  const area = state.change;
  const project = state.detail?.project;
  if (!project) return;
  if (!area || area.projectId !== project.id) state.change = emptyChangeState(project.id);
  if (action === 'chg-new') {
    const truth = state.detail.truth_head;
    state.change.draft = {
      facts: (truth?.facts ?? []).map(fact => ({ ...fact })),
      criticalText: (truth?.critical_text ?? []).map(item => item.text).join('\n'),
      changedAssetIds: [],
      brandKitChanged: false,
      preview: null,
      idempotencyKey: newChangeIdempotencyKey(),
    };
    rerenderChangeSection();
    return;
  }
  if (action === 'chg-draft-cancel') {
    state.change.draft = null;
    rerenderChangeSection();
    return;
  }
  if (action === 'chg-add-fact') {
    collectChangeDraft(state.change.draft);
    state.change.draft.facts.push({ key: '', value: '', critical: false, confirmed: false, source_type: 'user_input' });
    rerenderChangeSection();
    return;
  }
  if (action === 'chg-preview') { await submitChangePreview(); return; }
  if (action === 'chg-confirm') { await confirmChangeOrder(); return; }
  if (action === 'chg-open') {
    const changeId = trigger.dataset.changeId;
    if (state.change.detailId === changeId) {
      state.change.detailId = null;
      state.change.detail = null;
      state.change.quoteConfirm = null;
      rerenderChangeSection();
      return;
    }
    state.change.detailId = changeId;
    state.change.detail = null;
    state.change.quoteConfirm = null;
    state.change.error = '';
    rerenderChangeSection();
    try {
      const payload = await api.getChange(changeId);
      state.change.detail = payload.change;
    } catch (error) {
      state.change.error = errorText(error);
    }
    rerenderChangeSection();
    return;
  }
  if (action === 'chg-refresh') { await loadChanges(state.change.projectId); return; }
  if (action === 'chg-execute-all') { await executeChangeOrder(null); return; }
  if (action === 'chg-execute-item') { await executeChangeOrder(trigger.dataset.itemId); return; }
  if (action === 'chg-retry') { await retryChangeOrder(); return; }
  if (action === 'chg-cancel') { await cancelChangeOrder(); return; }
  if (action === 'chg-quote-confirm') {
    const pending = state.change.quoteConfirm;
    if (pending?.quote) await runChangeExecution(state.change, { ...pending.body, quote_confirm: pending.quote }, { quoteConfirmed: true });
    return;
  }
  if (action === 'chg-quote-cancel') {
    state.change.quoteConfirm = null;
    rerenderChangeSection();
    return;
  }
  if (action === 'chg-visual-check') { await submitVisualCheck(trigger.dataset.itemId); return; }
  if (action === 'chg-material') { await attachChangeMaterial(trigger.dataset.itemId, trigger); return; }
  if (action === 'chg-activate') { await activateChangeVersion(trigger.dataset.runId, trigger.dataset.versionId); return; }
  if (action === 'chg-export') { await exportChangeRun(trigger.dataset.runId, trigger); return; }
  if (action === 'chg-todo-confirm') { await confirmReplacementTodoItem(trigger.dataset.todoId); return; }
  if (action === 'chg-open-source') {
    window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: project.id } }));
  }
}

// ---------- E04：SKU 核对与按 SKU 导出 ----------

const CHECK_LAYER_META = {
  ownership: '归属核对',
  structure: '结构核对',
  visual: '视觉候选',
};
const CHECK_RESOLVE_LABEL = {
  confirm: '确认无误',
  reassign: '更正归属',
  recheck_clear: '复核自动收口',
};

function emptyCheckState(projectId) {
  return { projectId, loading: true, error: '', notice: '', issues: [], summary: {}, exports: [], running: false };
}

async function loadSkuChecks(projectId) {
  if (!state.check || state.check.projectId !== projectId) state.check = emptyCheckState(projectId);
  const area = state.check;
  area.loading = true;
  area.error = '';
  rerenderCheckSection();
  try {
    const [checksRes, exportsRes] = await Promise.all([
      api.listSkuChecks(projectId),
      api.listSkuExports(projectId),
    ]);
    if (state.check !== area) return; // 已切换到其它项目，丢弃过期结果
    area.issues = checksRes.issues ?? [];
    area.summary = checksRes.summary ?? {};
    area.exports = exportsRes.exports ?? [];
    area.loading = false;
  } catch (error) {
    if (state.check !== area) return;
    area.loading = false;
    area.error = errorText(error);
  }
  rerenderCheckSection();
}

function rerenderCheckSection() {
  const node = $('#check-section');
  if (node) node.innerHTML = renderCheckSection();
}

function renderCheckSection() {
  const area = state.check;
  if (!area || area.projectId !== state.detail?.project?.id) {
    return '<h3>SKU 核对与导出</h3><p class="truth-hint">正在读取核对结果…</p>';
  }
  const parts = ['<h3>SKU 核对与导出</h3>'];
  parts.push('<p class="truth-hint">三层核对：归属（图是否属于对应 SKU）、结构（包含物数量/规格与档案是否一致）、视觉（OCR 候选，仅作提示不作硬结论）。阻断级问题不能用「满意」覆盖；人工复核绑定版本，新版本需重新核对。</p>');
  if (area.error) parts.push(`<p class="truth-error" role="alert">${escapeHtml(area.error)}</p>`);
  if (area.notice) parts.push(`<p class="truth-hint chg-notice">${escapeHtml(area.notice)}</p>`);
  if (area.loading) {
    parts.push('<div class="loading-line"></div>');
    return parts.join('');
  }
  const summaryLine = Object.entries(CHECK_LAYER_META).map(([layer, label]) => {
    const stat = area.summary?.[layer] ?? { open: 0, blocker: 0 };
    const tone = stat.blocker > 0 ? 'bad' : (stat.open > 0 ? 'amber' : 'ok');
    return `<span class="wb-status ${tone}">${label}：未处理 ${stat.open}${stat.blocker > 0 ? `（阻断 ${stat.blocker}）` : ''}</span>`;
  }).join('');
  parts.push(`<div class="skc-summary">${summaryLine}</div>`);
  parts.push(`<div class="truth-actions">
    <button type="button" class="text-button" data-action="skc-run"${area.running ? ' disabled' : ''}>${area.running ? '核对中…' : '发起三层核对'}</button>
    <button type="button" class="text-button" data-action="skc-refresh">刷新</button>
  </div>`);
  parts.push(renderCheckIssues(area));
  parts.push(renderCheckExports(area));
  return parts.join('');
}

function skcEvidenceLine(evidence) {
  const entries = Object.entries(evidence ?? {});
  if (entries.length === 0) return '';
  return entries.map(([key, value]) =>
    `${escapeHtml(key)}：${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : String(value))}`).join('；');
}

function renderCheckIssues(area) {
  if (area.issues.length === 0) {
    return '<p class="truth-empty">尚无核对问题。生成图片后点击「发起三层核对」。</p>';
  }
  const skus = state.detail?.skuData?.profile?.skus ?? [];
  const rows = area.issues.map(issue => {
    const open = issue.status === 'open';
    const blocker = issue.severity === 'blocker';
    const versionText = issue.version_number
      ? `版本 v${issue.version_number}${issue.version_active === true ? '（当前选用）' : issue.version_active === false ? '（历史版本）' : ''}`
      : '版本未知';
    const head = `<div class="skc-issue-head">
      <span class="wb-status ${open ? (blocker ? 'bad' : 'amber') : 'ok'}">${open ? (blocker ? '阻断' : '待复核') : '已收口'}</span>
      <span class="wb-status neutral">${escapeHtml(CHECK_LAYER_META[issue.layer] ?? issue.layer)}</span>
      <b>${escapeHtml(issue.code)}</b>
      <span class="chg-meta">${escapeHtml(issue.deliverable_label ?? issue.deliverable_id)} · ${escapeHtml(versionText)} · ${escapeHtml(formatTime(issue.created_at))}</span>
    </div>`;
    const evidence = skcEvidenceLine(issue.evidence);
    const detail = `<details class="skc-detail"><summary>图片与证据</summary>
      <img class="skc-preview" src="${workVersionImageUrl(issue.run_id, issue.version_id)}" alt="问题版本图（服务端按结算状态加水印）" loading="lazy">
      ${evidence ? `<p class="skc-evidence">${evidence}</p>` : ''}
      <p class="chg-meta">事实 v${issue.truth_version ?? '—'} · 档案 v${issue.sku_profile_version ?? '—'}</p>
    </details>`;
    let body;
    if (open) {
      const actions = [`<input type="text" class="skc-reason" placeholder="依据/理由（必填，随复核记录留存）" maxlength="300">`];
      if (issue.layer === 'ownership' && skus.length > 0) {
        actions.push(`<select class="skc-target">${skus.map(sku =>
          `<option value="${escapeHtml(sku.id)}">${escapeHtml(sku.sku_code)} ${escapeHtml(sku.label)}</option>`).join('')}</select>`);
        actions.push(`<button type="button" class="text-button" data-action="skc-reassign" data-issue-id="${escapeHtml(issue.id)}">更正归属</button>`);
      }
      actions.push(blocker
        ? `<button type="button" class="text-button" data-action="skc-confirm" data-issue-id="${escapeHtml(issue.id)}">确认无误（阻断项不可用）</button>`
        : `<button type="button" class="text-button" data-action="skc-confirm" data-issue-id="${escapeHtml(issue.id)}">确认无误</button>`);
      actions.push(`<button type="button" class="text-button" data-action="skc-open-workbench" data-run-id="${escapeHtml(issue.run_id)}">改文字 / 重做</button>`);
      body = `<p class="skc-message">${escapeHtml(issue.message)}</p>${detail}
        <div class="skc-form">${actions.join('')}</div>
        ${blocker ? '<p class="truth-hint">阻断级问题：满意不能覆盖确定错误。可更正归属（有依据）、修正档案/事实后重新核对自动收口，或生成新版本。</p>' : ''}`;
    } else {
      const resolution = issue.resolution ?? {};
      body = `<p class="skc-message">${escapeHtml(issue.message)}</p>${detail}
        <p class="chg-meta">收口：${escapeHtml(CHECK_RESOLVE_LABEL[resolution.action] ?? resolution.action ?? '—')} · ${escapeHtml(resolution.actor ?? '')} · ${escapeHtml(formatTime(resolution.at))}${resolution.reason ? ` · 依据：${escapeHtml(resolution.reason)}` : ''}</p>`;
    }
    return `<li class="chg-item skc-issue" data-issue-id="${escapeHtml(issue.id)}">${head}${body}</li>`;
  }).join('');
  return `<ul class="chg-items skc-list">${rows}</ul>`;
}

function renderCheckExports(area) {
  const skus = state.detail?.skuData?.profile?.skus ?? [];
  const parts = ['<div class="skc-exports"><h4>按 SKU 导出</h4>'];
  if (skus.length === 0) {
    parts.push('<p class="truth-hint">尚未建立 SKU 档案：先在上方「SKU 档案」建档并确认后，才能按 SKU 组织交付目录。</p>');
  } else {
    parts.push(`<div class="skc-form">
      <select id="skc-sku">${skus.map(sku => `<option value="${escapeHtml(sku.id)}">${escapeHtml(sku.sku_code)} ${escapeHtml(sku.label)}</option>`).join('')}</select>
      <button type="button" class="text-button" data-action="skc-export">生成该 SKU 导出包</button>
    </div>
    <p class="truth-hint">导出只含生效归属该 SKU、当前选用、检查通过且未失效、权益已结算的版本；归属其他 SKU 的图不会混入，被排除的版本在包内清单逐项列明原因。</p>`);
  }
  if (area.exports.length > 0) {
    parts.push(`<ul class="chg-list">${area.exports.map(item => {
      const excluded = Array.isArray(item.missing) ? item.missing : [];
      return `<li class="chg-row">
        <span class="wb-status ${item.complete ? 'ok' : 'amber'}">${item.complete ? '完整' : '部分'}</span>
        <span class="chg-meta">SKU ${escapeHtml(item.sku_code ?? '')} · 含 ${item.included?.length ?? 0} 项 · 排除 ${excluded.length} 项 · ${escapeHtml(formatTime(item.created_at))}</span>
        <a class="text-button" href="${api.downloadExportUrl(item.id)}" download>下载</a>
        ${excluded.length > 0 ? `<details class="skc-detail"><summary>排除清单（${excluded.length}）</summary><ul class="chg-diff">${excluded.map(row =>
          `<li>${escapeHtml(row.deliverable_label ?? row.deliverable_id)}：${escapeHtml(row.reason)} — ${escapeHtml(row.message ?? '')}</li>`).join('')}</ul></details>` : ''}
      </li>`;
    }).join('')}</ul>`);
  }
  parts.push('</div>');
  return parts.join('');
}

async function onCheckClick(action, trigger) {
  const project = state.detail?.project;
  if (!project) return;
  if (!state.check || state.check.projectId !== project.id) state.check = emptyCheckState(project.id);
  const area = state.check;
  if (action === 'skc-refresh') { await loadSkuChecks(project.id); return; }
  if (action === 'skc-run') {
    area.running = true;
    area.error = '';
    area.notice = '';
    rerenderCheckSection();
    try {
      const result = await api.runSkuChecks(project.id);
      if (state.check !== area) return;
      area.issues = result.issues ?? [];
      area.summary = result.summary ?? {};
      area.notice = `核对完成：检查 ${result.checked ?? 0} 个版本，新开 ${result.created ?? 0} 项，自动收口 ${result.auto_cleared ?? 0} 项${result.ocr_configured ? '' : '；未配置视觉核对（OCR），视觉项保持未知，不作为通过依据'}`;
    } catch (error) {
      if (state.check === area) area.error = errorText(error);
    }
    if (state.check !== area) return;
    area.running = false;
    rerenderCheckSection();
    return;
  }
  if (action === 'skc-confirm' || action === 'skc-reassign') {
    const row = trigger.closest('.skc-issue');
    const reason = row?.querySelector('.skc-reason')?.value.trim() ?? '';
    const body = { action: action === 'skc-confirm' ? 'confirm' : 'reassign', reason };
    if (action === 'skc-reassign') body.target_sku_id = row?.querySelector('.skc-target')?.value ?? '';
    area.error = '';
    try {
      await api.resolveCheckIssue(trigger.dataset.issueId, body);
      state.toast(action === 'skc-confirm' ? '已确认无误（仅对该版本生效）' : '已更正归属并留痕');
      await loadSkuChecks(project.id);
    } catch (error) {
      if (state.check !== area) return;
      area.error = errorText(error); // 如实展示 ISSUE_HARD_BLOCK / ISSUE_ALREADY_RESOLVED / REASSIGN_NOT_APPLICABLE 等
      rerenderCheckSection();
    }
    return;
  }
  if (action === 'skc-export') {
    const skuId = $('#skc-sku')?.value ?? '';
    trigger.disabled = true;
    area.error = '';
    try {
      const payload = await api.createSkuExport(project.id, { sku_id: skuId });
      state.toast(payload.export?.message ?? 'SKU 导出包已生成');
      await loadSkuChecks(project.id);
    } catch (error) {
      if (state.check !== area) return;
      area.error = errorText(error); // 如实展示 SKU_EXPORT_EMPTY / ENTITLEMENT_NOT_SETTLED / NO_SKU_PROFILE 等
      rerenderCheckSection();
    } finally {
      trigger.disabled = false;
    }
    return;
  }
  if (action === 'skc-open-workbench') {
    window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: project.id, runId: trigger.dataset.runId } }));
  }
}

// ---------- E05：售前问题分流与补图建议 ----------

const QUESTION_CATEGORY_LABELS = {
  quantity: '数量/包含物', size: '尺寸', spec_diff: '规格差别', usage: '使用方式', other: '其他',
  logistics: '物流/配送', payment: '支付/退款', inventory: '库存/缺货', theme: '店铺主题/页面',
};
const QUESTION_CATEGORY_OPTIONS = [
  'quantity', 'size', 'spec_diff', 'usage', 'other', 'logistics', 'payment', 'inventory', 'theme',
];
const QUESTION_RESULT_META = {
  reuse_existing: { label: '已有内容可复用', tone: 'ok' },
  missing_facts: { label: '缺少依据', tone: 'amber' },
  text_suggestion: { label: '文字/位置建议', tone: 'neutral' },
  needs_explainer: { label: '需要补图', tone: 'amber' },
  out_of_scope: { label: '不属于商品图问题', tone: 'neutral' },
};

function emptyQuestionState(projectId) {
  return {
    projectId, loading: true, error: '', notice: '', groups: [], summary: {},
    submitting: false, busyId: '',
    draft: { text: '', skuId: '', count: '', source: '' },
  };
}

function newQuestionIdempotencyKey() {
  return `q-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

async function loadQuestions(projectId) {
  if (!state.questions || state.questions.projectId !== projectId) {
    state.questions = emptyQuestionState(projectId);
  }
  const area = state.questions;
  area.loading = true;
  area.error = '';
  rerenderQuestionSection();
  try {
    const result = await api.listQuestionGroups(projectId);
    if (state.questions !== area) return; // 已切换项目，丢弃过期结果
    area.groups = result.groups ?? [];
    area.summary = result.summary ?? {};
    area.loading = false;
  } catch (error) {
    if (state.questions !== area) return;
    area.loading = false;
    area.error = errorText(error);
  }
  rerenderQuestionSection();
}

/** 重渲染前把输入中的内容收回草稿，避免刷新结果时丢掉商家正在填的问题。 */
function collectQuestionDraft() {
  const area = state.questions;
  if (!area) return;
  const text = $('#q-text');
  if (text) area.draft.text = text.value;
  const sku = $('#q-sku');
  if (sku) area.draft.skuId = sku.value;
  const count = $('#q-count');
  if (count) area.draft.count = count.value;
  const source = $('#q-source');
  if (source) area.draft.source = source.value;
}

function rerenderQuestionSection() {
  const node = $('#question-section');
  if (!node) return;
  collectQuestionDraft();
  node.innerHTML = renderQuestionSection();
}

function renderQuestionSection() {
  const area = state.questions;
  if (!area || area.projectId !== state.detail?.project?.id) {
    return '<h3>售前问题与补图建议</h3><p class="truth-hint">正在读取售前问题…</p>';
  }
  const parts = ['<h3>售前问题与补图建议</h3>'];
  parts.push('<p class="truth-hint">只支持手动填写/粘贴已脱敏的问题；不接客服账号、不导入聊天记录。请输入前去掉姓名、电话、地址与订单号。没有真实频次就留空：系统只显示「输入的问题」，不会标注高频。分析不消耗生图额度，也不会替你补事实。</p>');
  if (area.error) parts.push(`<p class="truth-error" role="alert">${escapeHtml(area.error)}</p>`);
  if (area.notice) parts.push(`<p class="truth-hint chg-notice">${escapeHtml(area.notice)}</p>`);
  parts.push(renderQuestionForm(area));
  if (area.loading) parts.push('<div class="loading-line"></div>');
  else parts.push(renderQuestionGroups(area));
  return parts.join('');
}

function renderQuestionForm(area) {
  const skus = state.detail?.skuData?.profile?.skus ?? [];
  const draft = area.draft ?? {};
  const skuOptions = ['<option value="">不指定 SKU（数量/尺寸/规格问题需指定）</option>']
    .concat(skus.map(sku => `<option value="${escapeHtml(sku.id)}"${draft.skuId === sku.id ? ' selected' : ''}>${escapeHtml(sku.sku_code)} ${escapeHtml(sku.label)}</option>`));
  return `<div class="q-form">
    <textarea id="q-text" rows="3" maxlength="500" placeholder="例如：收到之后到底有几个？配件都包含哪些？">${escapeHtml(draft.text ?? '')}</textarea>
    <div class="q-form-row">
      <select id="q-sku">${skuOptions.join('')}</select>
      <details class="q-freq"><summary>人工频次（可选）</summary>
        <p class="chg-meta">仅在你有真实来源时填写；系统会标注「人工提供」，不猜测频率。</p>
        <label>次数<input id="q-count" type="number" min="1" max="9999" step="1" value="${escapeHtml(String(draft.count ?? ''))}"></label>
        <label>来源<input id="q-source" type="text" maxlength="50" placeholder="如：人工翻看客服记录" value="${escapeHtml(draft.source ?? '')}"></label>
      </details>
      <button type="button" class="text-button" data-action="q-analyze"${area.submitting ? ' disabled' : ''}>${area.submitting ? '分析中…' : '分析问题'}</button>
      <button type="button" class="text-button" data-action="q-refresh">刷新</button>
    </div>
  </div>`;
}

function renderQuestionGroups(area) {
  if (area.groups.length === 0) return '<p class="truth-empty">尚无售前问题。输入一条顾客反复问到的问题，看看能否用现有图或已确认事实回答。</p>';
  const summary = area.summary ?? {};
  const summaryLine = Object.entries(QUESTION_RESULT_META).map(([key, meta]) =>
    `<span class="wb-status ${meta.tone}">${escapeHtml(meta.label)}：${summary.by_result?.[key] ?? 0}</span>`).join('');
  const rows = area.groups.map(group => renderQuestionGroup(area, group)).join('');
  return `<div class="skc-summary">${summaryLine}</div><ul class="chg-items q-list">${rows}</ul>`;
}

function renderQuestionGroup(area, group) {
  const meta = QUESTION_RESULT_META[group.result] ?? { label: group.result, tone: 'neutral' };
  const confirmed = group.status === 'confirmed';
  const stale = group.facts_stale === true;
  const statusTone = confirmed ? 'ok' : (stale ? 'bad' : 'amber');
  const statusLabel = confirmed ? '已确认' : (stale ? '分析已过期' : '待确认');
  const categoryOptions = QUESTION_CATEGORY_OPTIONS.map(key =>
    `<option value="${key}"${key === group.category_final ? ' selected' : ''}>${escapeHtml(QUESTION_CATEGORY_LABELS[key] ?? key)}</option>`).join('');
  const head = `<div class="q-head">
    <span class="wb-status ${statusTone}">${statusLabel}</span>
    <span class="wb-status ${meta.tone}">${escapeHtml(group.result_label ?? meta.label)}</span>
    <span class="wb-status neutral">${escapeHtml(group.category_label ?? QUESTION_CATEGORY_LABELS[group.category_final] ?? group.category_final)}</span>
    <span class="chg-meta">${escapeHtml(group.frequency_label ?? '')}${group.sku_code ? ` · SKU ${escapeHtml(group.sku_code)}` : ''} · ${escapeHtml(formatTime(group.created_at))}</span>
  </div>
  <p class="q-text-line">${escapeHtml(group.text)}</p>`;
  const detail = renderQuestionDetail(group);
  const actions = `<div class="q-form-row">
    <select class="q-cat">${categoryOptions}</select>
    <button type="button" class="text-button" data-action="q-correct" data-group-id="${escapeHtml(group.id)}"${area.busyId === group.id ? ' disabled' : ''}>改正归类并重新分析</button>
    <button type="button" class="text-button" data-action="q-confirm" data-group-id="${escapeHtml(group.id)}"${(confirmed || stale) ? ' disabled' : ''}>${confirmed ? '已确认' : (stale ? '需先重新分析' : '确认图种与提纲')}</button>
  </div>`;
  const dup = group.duplicate_of
    ? `<p class="truth-hint">该问题此前出现过（${escapeHtml(group.duplicate_of)}）：先看现有适用图，再决定是否重复补图。</p>`
    : '';
  return `<li class="chg-item q-group" data-group-id="${escapeHtml(group.id)}">${head}${dup}${detail}${actions}</li>`;
}

function renderQuestionDetail(group) {
  const detail = group.detail ?? {};
  if (group.result === 'out_of_scope') {
    return `<p class="skc-message">${escapeHtml(detail.scope_note ?? '该问题不属于商品图范围。')}</p>`;
  }
  if (group.result === 'missing_facts') {
    const items = (detail.missing ?? []).map(item => `<li>${escapeHtml(item.message ?? item.code)}</li>`).join('');
    return `<div class="q-block"><b>需要先补齐的资料</b><ul class="truth-warnings">${items}</ul>
      <p class="chg-meta">补齐后请改正归类触发重新分析；系统不会替你推测尺寸、用法或适配结论。</p></div>`;
  }
  if (group.result === 'reuse_existing') {
    const cards = (detail.reusable ?? []).map(item => `<li>
      <button type="button" class="text-button" data-action="q-open-workbench" data-run-id="${escapeHtml(item.run_id ?? '')}">${escapeHtml(item.deliverable_label ?? item.deliverable_id)} · v${escapeHtml(String(item.version_number ?? '—'))}</button>
      ${item.run_id && item.version_id ? `<img class="skc-preview" src="${workVersionImageUrl(item.run_id, item.version_id)}" alt="可复用版本图（服务端按结算状态加水印）" loading="lazy">` : ''}
    </li>`).join('');
    return `<div class="q-block"><b>现有可用图片</b><ul class="q-reuse">${cards}</ul>
      <p class="chg-meta">${escapeHtml(detail.note ?? '')}</p></div>`;
  }
  if (group.result === 'text_suggestion') {
    const texts = (detail.suggestion?.texts ?? []).map(text => `<li>${escapeHtml(text)}</li>`).join('');
    return `<div class="q-block"><b>可直接使用的文字（逐字引用已确认事实）</b><ul>${texts}</ul>
      <p class="chg-meta">位置建议：${escapeHtml(detail.suggestion?.position ?? '')}</p>
      <p class="chg-meta">${escapeHtml(detail.suggestion?.note ?? '')}</p></div>`;
  }
  if (group.result === 'needs_explainer') {
    const outline = (detail.outline ?? []).map(line => `<li>${escapeHtml(line)}</li>`).join('');
    return `<div class="q-block"><b>建议补图：${escapeHtml(detail.explainer_kind_label ?? detail.explainer_kind ?? '说明图')}</b>
      <ul>${outline || '<li>暂无可引用的档案条目</li>'}</ul>
      <p class="chg-meta">${escapeHtml(detail.note ?? '')}</p></div>`;
  }
  return '';
}

async function onQuestionClick(action, trigger) {
  const project = state.detail?.project;
  if (!project) return;
  if (!state.questions || state.questions.projectId !== project.id) state.questions = emptyQuestionState(project.id);
  const area = state.questions;
  if (action === 'q-refresh') { await loadQuestions(project.id); return; }
  if (action === 'q-open-workbench') {
    window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: project.id, runId: trigger.dataset.runId } }));
    return;
  }
  if (action === 'q-analyze') {
    collectQuestionDraft();
    const text = String(area.draft.text ?? '').trim();
    if (!text) { area.error = '请先输入一条顾客问题'; rerenderQuestionSection(); return; }
    const count = String(area.draft.count ?? '').trim();
    const source = String(area.draft.source ?? '').trim();
    if (Boolean(count) !== Boolean(source)) {
      area.error = '人工频次需要同时填写次数与来源；没有真实频次请全部留空，系统会如实标注「未提供频次」';
      rerenderQuestionSection();
      return;
    }
    const body = { text };
    if (area.draft.skuId) body.sku_id = area.draft.skuId;
    if (count && source) body.frequency = { count: Number(count), source };
    area.submitting = true;
    area.error = '';
    area.notice = '';
    rerenderQuestionSection();
    try {
      const result = await api.analyzeQuestion(project.id, body, newQuestionIdempotencyKey());
      if (state.questions !== area) return;
      area.draft = { text: '', skuId: area.draft.skuId, count: '', source: '' };
      area.notice = `已分析：${result.group?.result_label ?? ''}`;
      await loadQuestions(project.id);
    } catch (error) {
      if (state.questions !== area) return;
      area.error = errorText(error); // 如实展示 PII_DETECTED / INVALID_FIELD / MISSING_IDEMPOTENCY_KEY 等
    }
    if (state.questions !== area) return;
    area.submitting = false;
    rerenderQuestionSection();
    return;
  }
  if (action === 'q-correct') {
    const row = trigger.closest('.q-group');
    const category = row?.querySelector('.q-cat')?.value ?? '';
    area.busyId = trigger.dataset.groupId;
    area.error = '';
    try {
      await api.reviewQuestionGroup(trigger.dataset.groupId, { action: 'correct', category });
      state.toast('已按改正后的归类重新分析');
      await loadQuestions(project.id);
    } catch (error) {
      if (state.questions !== area) return;
      area.error = errorText(error);
      rerenderQuestionSection();
    }
    if (state.questions === area) area.busyId = '';
    return;
  }
  if (action === 'q-confirm') {
    area.busyId = trigger.dataset.groupId;
    area.error = '';
    try {
      await api.reviewQuestionGroup(trigger.dataset.groupId, { action: 'confirm' });
      state.toast('已确认（绑定当前档案与事实版本）');
      await loadQuestions(project.id);
    } catch (error) {
      if (state.questions !== area) return;
      area.error = errorText(error); // 如实展示 QUESTION_STALE 等
      rerenderQuestionSection();
    }
    if (state.questions === area) area.busyId = '';
  }
}

function onTruthClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
  if (action === 'jump') {
    document.getElementById(trigger.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action.startsWith('chg-')) {
    void onChangeClick(action, trigger);
    return;
  }
  if (action.startsWith('skc-')) {
    void onCheckClick(action, trigger);
    return;
  }
  if (action.startsWith('q-')) {
    void onQuestionClick(action, trigger);
    return;
  }
  if (action.startsWith('ex-')) {
    void onExplainerClick(action, trigger);
    return;
  }
  if (action.startsWith('sku-')) {
    void onSkuClick(action, trigger);
    return;
  }
  if (action === 'extract-facts' || action === 'save-subject-box') {
    void handleAssetAction(trigger, action);
    return;
  }
  if (action === 'add-fact') {
    $('#truth-facts').insertAdjacentHTML('beforeend', factRow({}));
    return;
  }
  if (action === 'remove-fact') {
    const row = trigger.closest('.fact-row');
    if ($$('#truth-facts .fact-row').length <= 1) { row.querySelector('[data-fact="key"]').value = ''; row.querySelector('[data-fact="value"]').value = ''; return; }
    row.remove();
    return;
  }
  if (action === 'save-draft') void saveTruth(false);
  if (action === 'confirm') void saveTruth(true);
}

async function handleAssetAction(button, action) {
  button.disabled = true;
  const project = state.detail.project.id, asset = button.dataset.assetId;
  try {
    if (action === 'extract-facts') {
      const result = await api.extractAssetFacts(project, asset);
      if (!result.configured || !result.candidates?.length) throw new Error(result.note ?? '未提取到文字，请手动填写');
      for (const [index, candidate] of result.candidates.entries()) {
        $('#truth-facts').insertAdjacentHTML('beforeend', factRow({ ...candidate, key: `待确认文字 ${index + 1}`, confirmed: false }));
      }
      $('#truth-block-error').textContent = '候选文字已加入，请修改事实项名称、核对文字后逐项确认。';
    } else {
      const section = button.closest('details');
      const box = Object.fromEntries($$('[data-box]', section).map(input => [input.dataset.box, Number(input.value)]));
      await api.updateSubjectBox(project, asset, box);
      const item = state.detail.assets.find(a => a.id === asset); if (item) item.subject_box = box;
      const url = `/api/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}/mask-preview`;
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) { const error = await response.json(); throw new Error(error.message); }
      const preview = section.querySelector('[data-mask-preview]');
      const old = preview.querySelector('img'); if (old) URL.revokeObjectURL(old.src);
      const img = document.createElement('img'); img.alt = '商品保护区域掩码'; img.style.maxWidth = '240px'; img.src = URL.createObjectURL(await response.blob()); preview.replaceChildren(img);
    }
  } catch (error) { $('#truth-block-error').textContent = error.message; }
  finally { button.disabled = false; }
}

function collectFacts() {
  const rows = $$('#truth-facts .fact-row');
  const facts = [];
  for (const row of rows) {
    const key = row.querySelector('[data-fact="key"]').value.trim();
    const value = row.querySelector('[data-fact="value"]').value.trim();
    if (!key && !value) continue;
    if (!key) throw new ApiFailure(0, 'CLIENT_INVALID', '事实项缺少名称');
    if (!value) throw new ApiFailure(0, 'CLIENT_INVALID', `事实「${key}」缺少值；不确定时请先留空整行并补充证据`);
    const source = row.querySelector('[data-fact="source"]').value;
    const fact = {
      key,
      value,
      critical: row.querySelector('[data-fact="critical"]').checked,
      confirmed: row.querySelector('[data-fact="confirmed"]').checked,
    };
    if (source) fact.source_asset_id = source;
    else fact.source_type = 'user_input';
    const region = state.regions.get(key);
    if (region) fact.region = region;
    facts.push(fact);
  }
  return facts;
}

async function saveTruth(confirm) {
  const { project } = state.detail;
  const errorNode = $('#truth-block-error');
  errorNode.textContent = '';
  let facts;
  try {
    facts = collectFacts();
  } catch (error) {
    errorNode.textContent = errorText(error);
    return;
  }
  if (confirm && facts.length === 0) {
    errorNode.textContent = '至少需要 1 项商品事实才能确认版本。';
    return;
  }
  const criticalText = $('#truth-text').value.split('\n').map(line => line.trim()).filter(Boolean)
    .map(text => ({ text, case_sensitive: true, normalization: 'trim' }));
  try {
    const payload = await api.createTruthVersion(project.id, {
      base_version: project.truth_head_version,
      sku: project.sku,
      category: project.category,
      confirm,
      facts,
      critical_text: criticalText,
    });
    state.toast(confirm
      ? `已确认商品事实 v${payload.truth_version.version}`
      : `已保存事实草稿 v${payload.truth_version.version}`);
    await refresh();
    await openTruthDialog(project.id);
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'CONFIRMATION_BLOCKED') {
      errorNode.innerHTML = `仍有关键项未满足，未生成新版本：${renderBlockers(error.details?.blockers ?? [])}`;
      return;
    }
    if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
      state.toast('事实版本已被更新，已刷新为最新版本，请重新提交');
      await openTruthDialog(project.id);
      return;
    }
    errorNode.textContent = errorText(error);
  }
}

// ---------- E06：说明图（包装内容清单 / 尺寸说明 / SKU 对比） ----------

const EXPLAINER_KIND_OPTIONS = [
  ['packing_list', '包装内容清单图'],
  ['size', '尺寸说明图'],
  ['sku_compare', 'SKU 对比图'],
];
const EXPLAINER_STATUS_META = {
  draft: { label: '草稿', tone: 'neutral' },
  needs_review: { label: '待人工核对', tone: 'bad' },
  awaiting_review: { label: '待复核', tone: 'amber' },
  checked: { label: '已复核（未选版）', tone: 'neutral' },
  active: { label: '已选版', tone: 'ok' },
  stale: { label: '已过期', tone: 'bad' },
};
const EXPLAINER_REVIEW_LABELS = { pending: '待复核', confirmed: '已复核通过', rejected: '已退回' };

function emptyExplainerState(projectId) {
  return {
    projectId, loading: true, error: '', notice: '', items: [], summary: {},
    previewing: false, creating: false, busyId: '', preview: null, packages: {},
    draft: { kind: 'packing_list', skuId: '', peerSkuId: '', baseMode: 'none', baseAssetId: '' },
  };
}

function newExplainerIdempotencyKey() {
  return `ex-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

async function loadExplainers(projectId) {
  if (!state.explainers || state.explainers.projectId !== projectId) {
    state.explainers = emptyExplainerState(projectId);
  }
  const area = state.explainers;
  area.loading = true;
  area.error = '';
  rerenderExplainerSection();
  try {
    const result = await api.listExplainers(projectId);
    if (state.explainers !== area) return; // 已切换项目，丢弃过期结果
    area.items = result.explainers ?? [];
    area.summary = result.summary ?? {};
    area.loading = false;
  } catch (error) {
    if (state.explainers !== area) return;
    area.loading = false;
    area.error = errorText(error);
  }
  rerenderExplainerSection();
}

/** 重渲染前把表单里正在选的内容收回草稿，避免刷新列表时丢掉选择。 */
function collectExplainerDraft() {
  const area = state.explainers;
  if (!area) return;
  const kind = $('#ex-kind');
  if (kind) area.draft.kind = kind.value;
  const sku = $('#ex-sku');
  if (sku) area.draft.skuId = sku.value;
  const peer = $('#ex-peer');
  if (peer) area.draft.peerSkuId = peer.value;
  const base = $('#ex-base');
  if (base) {
    // 下拉值形如 none / asset:<id>，避免再维护一个隐藏字段
    const [mode, id = ''] = String(base.value).split(':');
    area.draft.baseMode = mode;
    area.draft.baseAssetId = id;
  }
}

function rerenderExplainerSection() {
  const node = $('#explainer-section');
  if (!node) return;
  collectExplainerDraft();
  node.innerHTML = renderExplainerSection();
}

function renderExplainerSection() {
  const area = state.explainers;
  if (!area || area.projectId !== state.detail?.project?.id) {
    return '<h3>说明图</h3><p class="truth-hint">正在读取说明图…</p>';
  }
  const parts = ['<h3>说明图（包装内容清单 / 尺寸说明 / SKU 对比）</h3>'];
  parts.push('<p class="truth-hint">说明图是可编辑的确定性排版：文字、数量、单位逐行取自 SKU 档案与已确认事实，排版免费、不调用生图模型。缺依据时只列出缺什么，不替你推测尺寸或适配结论。底图只复用你已上传且生效的素材，或已通过导出闸口的图片版本；没付费/没过闸口的图不能免费当底图。系统不会自动同步店铺，替换清单需你手工替换。</p>');
  if (area.error) parts.push(`<p class="truth-error" role="alert">${escapeHtml(area.error)}</p>`);
  if (area.notice) parts.push(`<p class="truth-hint ex-notice">${escapeHtml(area.notice)}</p>`);
  parts.push(renderExplainerForm(area));
  if (area.preview) parts.push(renderExplainerPreview(area));
  if (area.loading) parts.push('<div class="loading-line"></div>');
  else parts.push(renderExplainerList(area));
  return parts.join('');
}

function renderExplainerForm(area) {
  const skus = state.detail?.skuData?.profile?.skus ?? [];
  const assets = (state.detail?.assets ?? []).filter(asset => asset.role_status === 'active' && asset.role !== 'style');
  const draft = area.draft ?? {};
  const kindOptions = EXPLAINER_KIND_OPTIONS.map(([value, label]) =>
    `<option value="${value}"${draft.kind === value ? ' selected' : ''}>${label}</option>`).join('');
  const skuOptions = ['<option value="">选择 SKU（必选）</option>']
    .concat(skus.map(sku => `<option value="${escapeHtml(sku.id)}"${draft.skuId === sku.id ? ' selected' : ''}>${escapeHtml(sku.sku_code)} ${escapeHtml(sku.label)}</option>`));
  const peerOptions = ['<option value="">选择对比 SKU（必选）</option>']
    .concat(skus.map(sku => `<option value="${escapeHtml(sku.id)}"${draft.peerSkuId === sku.id ? ' selected' : ''}>${escapeHtml(sku.sku_code)} ${escapeHtml(sku.label)}</option>`));
  const baseValue = draft.baseMode === 'asset' && draft.baseAssetId ? `asset:${draft.baseAssetId}` : 'none';
  const baseOptions = ['<option value="none">不带底图（纯排版）</option>']
    .concat(assets.map(asset => `<option value="asset:${escapeHtml(asset.id)}"${baseValue === `asset:${asset.id}` ? ' selected' : ''}>底图：${escapeHtml(asset.filename)}（${ROLE_LABELS[asset.role] ?? asset.role}）</option>`));
  return `<div class="ex-form">
    <select id="ex-kind" aria-label="说明图类型">${kindOptions.join('')}</select>
    <select id="ex-sku" aria-label="项目 SKU">${skuOptions.join('')}</select>
    ${draft.kind === 'sku_compare' ? `<select id="ex-peer" aria-label="对比 SKU">${peerOptions.join('')}</select>` : ''}
    <select id="ex-base" aria-label="底图">${baseOptions.join('')}</select>
    <button type="button" class="text-button" data-action="ex-preview"${area.previewing ? ' disabled' : ''}>${area.previewing ? '预览中…' : '预览排版（不落库）'}</button>
    <button type="button" class="text-button" data-action="ex-refresh">刷新列表</button>
  </div>`;
}

function renderExplainerPreview(area) {
  const preview = area.preview;
  const plan = preview.plan ?? null;
  const parts = ['<div class="ex-preview">'];
  if (!plan || plan.ok !== true) {
    parts.push('<p class="truth-error" role="alert">这份内容还不够出图，未生成任何图片。</p>');
    parts.push(`<ul class="ex-issues">${(preview.issues ?? []).length === 0 && plan?.message
      ? `<li><b>${escapeHtml(plan.code ?? '')}</b>${escapeHtml(plan.message)}</li>`
      : (preview.issues ?? []).map(issue => `<li><b>${escapeHtml(issue.code ?? '')}</b>${escapeHtml(issue.message ?? '')}</li>`).join('')}</ul>`);
    if (plan?.missing?.length) {
      parts.push(`<p class="chg-meta">缺少：${plan.missing.map(item => escapeHtml(item)).join('；')}</p>`);
    }
    parts.push('</div>');
    return parts.join('');
  }
  parts.push(`<p class="chg-meta">基于 SKU 档案 v${escapeHtml(String(plan.sources?.sku_profile_version ?? '—'))} · 事实 v${escapeHtml(String(plan.sources?.truth_version ?? '—'))} · 排版免费（0 额度）</p>`);
  parts.push(`<table class="ex-rows"><thead><tr><th>条目</th><th colspan="2">内容（逐行取自档案/事实）</th></tr></thead><tbody>`);
  for (const row of plan.rows ?? []) {
    if (plan.kind === 'sku_compare') {
      parts.push(`<tr${row.diff ? ' class="is-diff"' : ''}><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.a)}</td><td>${escapeHtml(row.b)}</td></tr>`);
    } else {
      const excluded = row.section === 'excluded';
      parts.push(`<tr${excluded ? ' class="is-excluded"' : ''}><td>${escapeHtml(row.label)}</td><td colspan="2">${escapeHtml(row.value)}${excluded ? '（不随包装交付）' : ''}</td></tr>`);
    }
  }
  parts.push('</tbody></table>');
  if (plan.disclaimer) parts.push(`<p class="chg-meta">${escapeHtml(plan.disclaimer)}</p>`);
  if (preview.duplicate) parts.push(`<p class="truth-hint">${escapeHtml(preview.duplicate.message ?? '')}</p>`);
  if (preview.audit && preview.audit.ok !== true) {
    const mismatches = (preview.audit.mismatches ?? []).map(item =>
      `<li>${escapeHtml(item.field)}：应为 ${escapeHtml(item.expected)}，计划里是 ${escapeHtml(item.actual)}</li>`).join('');
    parts.push(`<ul class="ex-issues"><li><b>事实一致性审计未通过</b>（${escapeHtml('FACT_CONFLICT')}）</li>${mismatches}</ul>`);
  }
  if (preview.photo_quote) {
    parts.push(`<p class="truth-hint">需要新底图时才生图：预计 ${escapeHtml(String(preview.photo_quote.estimated_credits))} 额度，本步不会自动扣费。</p>`);
  }
  parts.push(`<div class="ex-actions">
    <button type="button" class="text-button" data-action="ex-create"${area.creating ? ' disabled' : ''}>${area.creating ? '生成中…' : '按此排版生成说明图'}</button>
  </div>`);
  parts.push('</div>');
  return parts.join('');
}

function renderExplainerList(area) {
  if (area.items.length === 0) return '<p class="truth-empty">尚无说明图。先选类型与 SKU 预览排版，再生成；数量/单位以档案与已确认事实为准。</p>';
  const summary = area.summary ?? {};
  const summaryLine = `<div class="skc-summary">
    <span class="wb-status neutral">共 ${summary.total ?? 0} 张</span>
    <span class="wb-status ok">已选版：${summary.active ?? 0}</span>
    <span class="wb-status amber">待复核：${summary.awaiting_review ?? 0}</span>
    <span class="wb-status bad">已过期：${summary.stale ?? 0}</span>
  </div>`;
  return `${summaryLine}<ul class="chg-items ex-list">${area.items.map(item => renderExplainerItem(area, item)).join('')}</ul>`;
}

function renderExplainerItem(area, item) {
  const meta = EXPLAINER_STATUS_META[item.status] ?? { label: item.status, tone: 'neutral' };
  const version = item.active_version;
  const peer = item.peer_sku ? ` ⇄ ${escapeHtml(item.peer_sku.sku_code)}` : '';
  const baseLabel = version?.base_photo?.type === 'asset' ? '商家素材'
    : (version?.base_photo?.type === 'version' ? '已过闸口版本' : '无底图');
  const rows = (version?.plan?.rows ?? []).slice(0, 6).map(row => (item.kind === 'sku_compare'
    ? `<li><b>${escapeHtml(row.label)}</b>${escapeHtml(row.a)} ⇄ ${escapeHtml(row.b)}${row.diff ? '（差异）' : ''}</li>`
    : `<li><b>${escapeHtml(row.label)}</b>${escapeHtml(row.value)}${row.section === 'excluded' ? '（不随包装交付）' : ''}</li>`)).join('');
  const stale = item.stale
    ? `<p class="truth-error">已过期：${(item.stale_reasons ?? []).map(reason => escapeHtml(reason.message ?? reason.code)).join('；')}。导出前需按最新档案/事实重排（可在变更单里免费重排）。</p>`
    : '';
  const reviewLabel = version ? (EXPLAINER_REVIEW_LABELS[version.review?.decision] ?? '待复核') : '—';
  const replacement = (item.replacement_list ?? []).map(row => `<li><code>${escapeHtml(row.path)}</code>
    <span class="chg-meta">新 ${escapeHtml(shortHash(row.new_sha256))} · 上一版 ${escapeHtml(row.previous_sha256 ? shortHash(row.previous_sha256) : '无')}${row.change_note?.length ? ` · 改动 ${row.change_note.map(change => escapeHtml(change.field)).join('/')}` : ''}</span></li>`).join('');
  const adoption = (item.adoption ?? []).slice(-3).map(entry =>
    `<li class="chg-meta">${entry.used ? '已采用' : '未采用'}${entry.channel ? ` · ${escapeHtml(entry.channel)}` : ''}${entry.reason ? ` · ${escapeHtml(entry.reason)}` : ''} · ${escapeHtml(formatTime(entry.at))}</li>`).join('');
  const pkg = area.packages[item.id];
  const downloadUrl = version ? api.explainerContentUrl(item.id, version.id) : null;
  const downloadName = `explainer-${item.kind}-v${version?.number ?? 1}.png`;
  return `<li class="chg-item ex-item" data-explainer-id="${escapeHtml(item.id)}">
    <div class="ex-head">
      <span class="wb-status ${meta.tone}">${escapeHtml(meta.label)}</span>
      <span class="wb-status neutral">${escapeHtml(item.kind_label)}</span>
      <span class="chg-meta">SKU ${escapeHtml(item.sku?.sku_code ?? '')}${peer} · v${version?.number ?? 0}（共 ${item.version_count ?? 0} 版） · 复核：${reviewLabel} · 底图：${baseLabel} · ${escapeHtml(formatTime(item.updated_at))}</span>
    </div>
    ${stale}
    ${rows ? `<ul class="ex-lines">${rows}</ul>` : ''}
    <div class="ex-actions">
      ${downloadUrl ? `<a class="text-button" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(downloadName)}">下载 PNG（v${version.number}）</a>` : ''}
      <button type="button" class="text-button" data-action="ex-select" data-version-id="${escapeHtml(version?.id ?? '')}"${version ? '' : ' disabled'}>选为采用版</button>
      <button type="button" class="text-button" data-action="ex-package">生成替换包（需已复核）</button>
      ${pkg ? `<a class="text-button" href="${escapeHtml(api.downloadExportUrl(pkg.export_id))}" download="${escapeHtml(pkg.filename)}">下载替换包</a>` : ''}
    </div>
    <details class="ex-ops"><summary>复核 / 文案微调 / 采用反馈</summary>
      <p class="chg-meta">复核必须留下依据；只允许改标题、副标题、脚注，数量/单位/条目名不可改。新版本需重新复核。</p>
      <div class="ex-op-row">
        <input class="ex-reason" maxlength="300" placeholder="复核依据（必填）：核对过哪些行与来源">
        <button type="button" class="text-button" data-action="ex-confirm">复核通过</button>
        <button type="button" class="text-button" data-action="ex-reject">退回</button>
      </div>
      <div class="ex-op-row">
        <input class="ex-title" maxlength="40" placeholder="新的标题（只改文案，不改事实值）">
        <input class="ex-footnote" maxlength="80" placeholder="新的脚注（可选）">
        <button type="button" class="text-button" data-action="ex-edit">生成新版本</button>
      </div>
      <div class="ex-op-row">
        <input class="ex-channel" maxlength="40" placeholder="用在哪个渠道/页面（可选）">
        <button type="button" class="text-button" data-action="ex-used">已采用</button>
        <button type="button" class="text-button" data-action="ex-unused">未采用</button>
      </div>
      <p class="chg-meta">采用反馈只记录你的自述，不代表店铺曝光、点击或转化收益；未付费/未过闸口的版本不能免费导出。</p>
    </details>
    ${replacement ? `<details class="ex-replace"><summary>旧文件替换清单</summary><ul>${replacement}</ul>
      <p class="chg-meta">${escapeHtml('系统不会自动同步平台，请手工替换并自行核对。')}</p></details>` : ''}
    ${adoption ? `<ul class="ex-adoption">${adoption}</ul>` : ''}
  </li>`;
}

async function submitExplainerPreview(area) {
  collectExplainerDraft();
  if (!area.draft.skuId) { area.error = '请先选择 SKU。'; rerenderExplainerSection(); return; }
  if (area.draft.kind === 'sku_compare' && !area.draft.peerSkuId) {
    area.error = 'SKU 对比图必须选择对比 SKU。'; rerenderExplainerSection(); return;
  }
  const body = explainerDraftBody(area);
  area.previewing = true;
  area.error = '';
  area.notice = '';
  rerenderExplainerSection();
  try {
    const result = await api.previewExplainer(area.projectId, body);
    if (state.explainers !== area) return;
    area.preview = { ...result, body };
  } catch (error) {
    if (state.explainers !== area) return;
    area.error = explainerErrorText(error); // 如实展示 NO_SKU_PROFILE / PEER_* / FACT_CONFLICT 等
    area.preview = null;
  }
  if (state.explainers !== area) return;
  area.previewing = false;
  rerenderExplainerSection();
}

async function createExplainerFromPreview(area) {
  if (!area.preview?.body) return;
  area.creating = true;
  area.error = '';
  rerenderExplainerSection();
  try {
    const result = await api.createExplainer(area.projectId, area.preview.body, newExplainerIdempotencyKey());
    if (state.explainers !== area) return;
    const number = result.explainer?.active_version?.number ?? 1;
    area.notice = result.duplicate
      ? (result.message ?? '已有同排版说明图，未重复制作')
      : `已生成说明图 v${number}（排版免费；请复核后再选版/导出）`;
    area.preview = null;
    await loadExplainers(area.projectId);
  } catch (error) {
    if (state.explainers !== area) return;
    area.error = explainerErrorText(error);
  }
  if (state.explainers !== area) return;
  area.creating = false;
  rerenderExplainerSection();
}

/** 说明图错误码→可执行提示：不把闸口拒绝显示成成功。 */
function explainerErrorText(error) {
  if (!(error instanceof ApiFailure)) return errorText(error);
  if (error.code === 'FACT_CONFLICT') return `SKU 档案与已确认事实存在矛盾：先更新档案或人工核对后再重排。${errorText(error)}`;
  if (error.code === 'SOURCE_NOT_ENTITLED') return `这张底图还没通过导出闸口/未付费，不能免费当底图。${errorText(error)}`;
  if (error.code === 'PHOTO_SOURCE_REQUIRED') {
    const quote = error.details?.quote;
    return `${errorText(error)}${quote ? `（预计 ${quote.estimated_credits} 额度，未自动扣费）` : ''}`;
  }
  if (error.code === 'REVIEW_REQUIRED') return `${errorText(error)}：先复核通过，再选版或导出。`;
  if (error.code === 'EXPLAINER_STALE') return `${errorText(error)}：基于旧档案/事实，请先重排。`;
  if (error.code === 'AUDIT_FAILED') return `${errorText(error)}：逐行核对数量/单位/对照值后再试。`;
  if (error.code === 'MISSING_IDEMPOTENCY_KEY') return '创建请求缺少幂等键，已阻止重复制作，请重试。';
  return errorText(error);
}

function explainerDraftBody(area) {
  const draft = area.draft;
  const body = { kind: draft.kind, sku_id: draft.skuId };
  if (draft.kind === 'sku_compare' && draft.peerSkuId) body.peer_sku_id = draft.peerSkuId;
  if (draft.baseMode === 'asset' && draft.baseAssetId) body.base_photo = { type: 'asset', asset_id: draft.baseAssetId };
  return body;
}

async function onExplainerClick(action, trigger) {
  const area = state.explainers;
  if (!area) return;
  if (action === 'ex-preview') { await submitExplainerPreview(area); return; }
  if (action === 'ex-refresh') { await loadExplainers(area.projectId); return; }
  if (action === 'ex-create') { await createExplainerFromPreview(area); return; }
  const item = trigger.closest('.ex-item');
  const explainerId = item?.dataset.explainerId ?? '';
  if (!explainerId) return;
  const reason = item.querySelector('.ex-reason')?.value?.trim() ?? '';
  area.error = '';
  area.notice = '';
  area.busyId = explainerId;
  try {
    if (action === 'ex-confirm' || action === 'ex-reject') {
      if (!reason) throw new ApiFailure(0, 'CLIENT_INVALID', '复核必须填写依据，不能空着点通过');
      await api.reviewExplainer(explainerId, { action: action === 'ex-confirm' ? 'confirm' : 'reject', reason });
      state.toast(action === 'ex-confirm' ? '已复核通过' : '已退回该版本');
    } else if (action === 'ex-select') {
      const versionId = trigger.dataset.versionId ?? '';
      await api.selectExplainer(explainerId, { version_id: versionId });
      state.toast('已选为采用版本');
    } else if (action === 'ex-package') {
      const result = await api.explainerPackage(explainerId);
      area.packages = { ...area.packages, [explainerId]: result };
      state.toast('替换包已生成，需你手工替换到店铺');
    } else if (action === 'ex-edit') {
      const title = item.querySelector('.ex-title')?.value?.trim() ?? '';
      const footnote = item.querySelector('.ex-footnote')?.value?.trim() ?? '';
      const versionId = item.querySelector('[data-action="ex-select"]')?.dataset.versionId ?? '';
      if (!title && !footnote) throw new ApiFailure(0, 'CLIENT_INVALID', '请先填写新的标题或脚注');
      const edits = {};
      if (title) edits.title = title;
      if (footnote) edits.footnote = footnote;
      const result = await api.editExplainer(explainerId, { base_version_id: versionId, edits });
      area.notice = `已生成新版本 v${result.number}，需重新复核后才可导出`;
    } else if (action === 'ex-used' || action === 'ex-unused') {
      const channel = item.querySelector('.ex-channel')?.value?.trim() ?? '';
      const body = { used: action === 'ex-used' };
      if (channel) body.channel = channel;
      await api.explainerFeedback(explainerId, body);
      state.toast('已记录采用反馈（仅你的自述，不换算成收益）');
    }
    await loadExplainers(area.projectId);
  } catch (error) {
    if (state.explainers !== area) return;
    area.error = explainerErrorText(error);
    rerenderExplainerSection();
  }
  if (state.explainers === area) area.busyId = '';
}

// ---------- E07：首页待办（跨模块聚合） ----------

const TODO_GROUP_HINT = {
  unknown: '未知、待补资料或进行中；不确定的一律留在这里，不伪装已通过',
  failed: '失败与部分失败；重试只处理未成功项，不重复扣费',
  awaiting_review: '需要你复核或确认；通过后才会进入采用',
  adopted: '已采用与已完成；仅代表本服务内状态，不代表平台曝光或转化',
};

async function loadTodos() {
  const holder = $('#home-todos');
  if (!holder) return;
  try {
    renderTodos(await api.todos());
  } catch (error) {
    holder.innerHTML = `<p class="real-empty real-error">${escapeHtml(errorText(error))}</p>`;
  }
}

function renderTodos(payload) {
  const holder = $('#home-todos');
  if (!holder) return;
  const summary = payload.summary ?? {};
  const chips = `<div class="todo-summary">
    <span class="todo-chip unknown">未知 ${summary.unknown ?? 0}</span>
    <span class="todo-chip failed">失败 ${summary.failed ?? 0}</span>
    <span class="todo-chip review">待复核 ${summary.awaiting_review ?? 0}</span>
    <span class="todo-chip adopted">已采用 ${summary.adopted ?? 0}</span>
  </div>`;
  const limits = payload.limits ?? {};
  const budget = payload.budget ?? {};
  const limitsHtml = `<details class="todo-limits">
    <summary>服务限制、并发与额度（如实来自当前服务配置）</summary>
    <p>上传单张 ≤ ${Math.round((limits.max_upload_bytes ?? 0) / 1024 / 1024)} MB · 每项目素材 ≤ ${limits.max_assets_per_project ?? '—'} · 每版本事实 ≤ ${limits.max_facts ?? '—'}</p>
    <p>并发上限：工作线程 ${limits.worker_concurrency ?? '—'} · 单租户 ${limits.tenant_concurrency ?? '—'} · 供应商 ${limits.provider_concurrency ?? '—'}；自动修订最多 ${limits.revision_max_rounds ?? '—'} 轮</p>
    <p>${escapeHtml(limits.note ?? '')}</p>
    <p>可用额度 ${budget.available ?? 0} 张（预留 ${budget.reserved ?? 0} 张）。额度不足时不会入队，也不调用供应商。</p>
  </details>`;
  const groups = (payload.groups ?? []).filter(group => group.total > 0);
  if (groups.length === 0) {
    holder.innerHTML = `${chips}<p class="real-empty">当前没有待办。未知、失败与待复核都是 0；新任务可从「开始制作」或项目页进入。</p>${limitsHtml}`;
    return;
  }
  holder.innerHTML = `${chips}<div class="todo-groups">${groups.map(group => `
    <div class="todo-group" data-group="${escapeHtml(group.key)}">
      <div class="todo-group-head"><h3>${escapeHtml(group.label)}</h3><span>${group.total}</span></div>
      <p class="todo-group-hint">${escapeHtml(TODO_GROUP_HINT[group.key] ?? '')}</p>
      <ul class="todo-items">${group.items.map(item => `<li>
        <button type="button" class="todo-item" data-proj="${escapeHtml(item.project_id)}" data-action="${escapeHtml(item.action)}" data-section="${escapeHtml(item.section ?? '')}">
          <b>${escapeHtml(item.title)}</b>
          <span>${escapeHtml(item.project_name)}</span>
          <small>${escapeHtml(item.detail ?? '')}</small>
        </button>
      </li>`).join('')}</ul>
    </div>`).join('')}</div>${limitsHtml}`;
}

function onTodoClick(event) {
  const item = event.target.closest('.todo-item');
  if (!item) return;
  const projectId = item.dataset.proj;
  if (!projectId) return;
  if (item.dataset.action === 'workbench') {
    window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId } }));
    return;
  }
  void openTruthDialog(projectId, { section: item.dataset.section || undefined });
}

async function renderAccountData() {
  const [runs, credits, exported] = await Promise.all([api.listRuns(), api.credits(), api.listExports({})]);
  const list = runs.runs ?? [], balance = credits.balance ?? {};
  const summaries = [
    ['商品项目', state.projects.length, '当前工作区'],
    ['待复核任务', list.filter(r => r.quality_status === 'needs_review').length, '按任务统计'],
    ['导出记录', (exported.exports ?? []).length, '当前工作区累计'],
    ['可用额度', balance.available ?? 0, '预留 ' + (balance.reserved ?? 0) + ' 张'],
  ];
  $('.metric-strip').innerHTML = summaries.map(([label, value, note]) => '<div class="metric"><span>'+label+'</span><strong>'+value+'</strong><small>'+note+'</small></div>').join('');
  // E07：首页待办聚合；失败时如实显示原因，不用空数据冒充“没有待办”
  void loadTodos();
  // 顶栏额度常驻：与额度弹窗同源（服务端账本），不写死也不四舍五入成好看的数字
  const creditValue = $('#topbar-credit-value');
  if (creditValue) creditValue.textContent = String(balance.available ?? 0);
  const delivery = $('.delivery-table');
  if (delivery) delivery.hidden = false;
  if (delivery) delivery.innerHTML = (exported.exports ?? []).slice(0, 5).map(e => '<p>'+escapeHtml(e.package_filename ?? e.id)+' · '+escapeHtml(e.created_at)+'</p>').join('') || '<p class="real-empty">尚无真实交付记录。</p>';
  // 模块06：我的作品页。真实作品渲染进 #real-works；.asset-layout 是 r06 契约保留的演示样例区，
  // 不再被真实数据覆盖/展开（演示边界不抢真实功能的显眼位置）。
  const assets = $('#assets-view .asset-layout');
  if (assets) assets.hidden = true;
  const worksBody = $('#real-works-body');
  if (worksBody) {
    worksBody.innerHTML = '<div class="loading-line"></div><p class="real-hint">正在读取真实作品…</p>';
    void renderRealWorks();
  }
  document.querySelectorAll('[data-real-workbench]').forEach(button => button.onclick = () => window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: button.dataset.realWorkbench } })));
  bindRealWorksActions();
  // 搜索只筛当前账户真实项目；演示表保留在源码供独立示例使用。
  const table = $('.project-table'); if (table) table.hidden = true;
  const search = $('.search input');
  if (search) search.oninput = () => {
    const keyword = search.value.trim().toLowerCase();
    $$('#real-list .real-card').forEach(card => card.hidden = !card.textContent.toLowerCase().includes(keyword));
    $$('#real-works-body .real-work-group').forEach(group => group.hidden = keyword !== '' && !group.textContent.toLowerCase().includes(keyword));
  };
  const segmented = document.querySelector('.segmented'); if (segmented) segmented.hidden = true;
}

/* ---------- 模块06：我的作品（按商品/任务展示套图） ----------
   数据流：listRunsByProject(每个商品) → 取最近 1 个 run → getRun（交付物+选用版本）
   + listRunVersions + listQualityReports + listExports(projectId) →
   每张图渲染：选用(active)/检查(decision)/交付(export)/历史版本数；已交付可下载，
   未结算/待复核的预览服务端自带水印，如实标注。 */
const WORK_DECISION_META = {
  publishable: ['检查通过', 'ok'],
  needs_review: ['待复核', 'warn'],
  blocked: ['检查未通过', 'bad'],
};
const WORK_RUN_STATUS_LABEL = {
  pending: '排队中', preparing: '准备中', generating: '生成中', qa: '检查中',
  needs_review: '待复核', budget_confirmation: '待确认额度', completed: '已完成',
  failed: '失败', cancelled: '已取消',
};

function workVersionImageUrl(runId, versionId) {
  return `/api/runs/${encodeURIComponent(runId)}/versions/${encodeURIComponent(versionId)}/content`;
}

async function renderRealWorks() {
  const body = $('#real-works-body');
  if (!body) return;
  const projects = state.projects ?? [];
  if (projects.length === 0) {
    body.innerHTML = `<div class="empty-state"><p>还没有作品：先在「商品项目」创建商品并完成一次生成，图片会按商品归类展示在这里。</p>
      <div class="state-actions"><button type="button" class="primary" data-works-start>开始第一套图</button></div></div>`;
    return;
  }
  const results = await Promise.all(projects.map(async project => {
    try {
      const runsRes = await api.listRunsByProject(project.id);
      const runs = (runsRes.runs ?? []).slice().sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      const latest = runs[0] ?? null;
      const [runDetail, versions, reports, exportList] = latest ? await Promise.all([
        api.getRun(latest.id).catch(() => null),
        api.listRunVersions(latest.id),
        api.listQualityReports(latest.id),
        api.listExports({ projectId: project.id }),
      ]) : [null, { versions: [] }, { reports: [] }, { exports: [] }];
      return { project, runs, run: runDetail?.run ?? latest, versions: versions.versions ?? [], reports: reports.reports ?? [], exports: exportList.exports ?? [], error: null };
    } catch (error) {
      return { project, runs: [], run: null, versions: [], reports: [], exports: [], error };
    }
  }));
  if ($('#real-works-body') !== body) return; // 视图已重渲染，丢弃过期结果
  body.innerHTML = results.map(item => renderRealWorkGroup(item)).join('');
}

function renderRealWorkGroup({ project, runs, run, versions, reports, exports, error }) {
  const head = `<button type="button" class="real-work-head" data-works-toggle>
      <span class="real-product" title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</span>
      <span class="real-meta"><span>${runs.length} 个任务</span><i>›</i></span>
    </button>`;
  if (error) {
    return `<article class="real-work-group">${head}
      <div class="real-work-body"><div class="state-note danger"><div><b>读取「${escapeHtml(project.name)}」的作品失败</b><br>${escapeHtml(errorText(error))}
        <div class="state-actions"><button type="button" class="secondary" data-works-retry>重试</button></div></div></div></div>
    </article>`;
  }
  if (!run) {
    return `<article class="real-work-group">${head}
      <div class="real-work-body"><p class="real-hint">该商品还没有生成任务。</p>
        <div class="state-actions"><button type="button" class="primary" data-works-open="${escapeHtml(project.id)}">打开工作台开始生成</button></div></div>
    </article>`;
  }
  const statusLabel = WORK_RUN_STATUS_LABEL[run.status] ?? run.status;
  const runExports = exports.filter(e => e.run_id === run.id);
  const deliveredExport = runExports.find(e => (e.status ?? '') === 'delivered') ?? runExports[0] ?? null;
  const runHead = `<div class="real-work-run-head">
      <b title="${escapeHtml(run.id)}">任务 ${escapeHtml(run.id.slice(0, 12))}…</b>
      <span>${escapeHtml(statusLabel)} · 更新 ${escapeHtml(formatWorkTime(run.updated_at))} · ${deliveredExport ? '已交付' : '未交付'}</span>
    </div>`;
  const deliverables = run.deliverables ?? [];
  const shots = deliverables.map(deliverable => {
    const active = versions.find(v => v.id === deliverable.active_version_id)
      ?? versions.filter(v => v.deliverable_id === deliverable.deliverable_id).sort((a, b) => b.number - a.number)[0] ?? null;
    const versionCount = versions.filter(v => v.deliverable_id === deliverable.deliverable_id).length;
    const report = active?.report_id ? reports.find(r => r.id === active.report_id) ?? null : null;
    const decision = report?.decision ?? null;
    const [decisionLabel, decisionCls] = decision
      ? (WORK_DECISION_META[decision] ?? [decision, 'warn'])
      : ['未检查', 'warn'];
    const tags = [
      active ? '<span class="wb-chip ok">选用</span>' : '<span class="wb-chip">无选用</span>',
      `<span class="wb-chip ${decisionCls}">${escapeHtml(decisionLabel)}</span>`,
      deliveredExport ? '<span class="wb-chip ok">已交付</span>' : `<span class="wb-chip">未交付</span>`,
      `<span class="wb-chip">${versionCount} 个版本</span>`,
    ];
    const action = deliveredExport
      ? `<a class="text-button" href="${escapeHtml(api.downloadExportUrl(deliveredExport.id))}">下载</a>`
      : (run.status === 'completed'
        ? `<button type="button" class="text-button" data-works-open="${escapeHtml(project.id)}">去交付</button>`
        : '');
    return `<figure class="real-shot">
      ${active
        ? `<img src="${escapeHtml(workVersionImageUrl(run.id, active.id))}" alt="${escapeHtml(deliverable.label ?? deliverable.deliverable_id)}" loading="lazy">`
        : '<div class="real-shot-info"><p class="real-hint">暂无可用版本</p></div>'}
      <figcaption class="real-shot-info">
        <b title="${escapeHtml(deliverable.label ?? deliverable.deliverable_id)}">${escapeHtml(deliverable.label ?? deliverable.deliverable_id)}</b>
        <span class="real-shot-tags">${tags.join('')}</span>
        ${deliveredExport ? '' : `<span class="real-watermark-note">未结算/待复核，预览带水印</span>`}
        <span class="real-shot-actions">${action}</span>
      </figcaption>
    </figure>`;
  }).join('');
  const olderRuns = runs.slice(1);
  const olderNote = olderRuns.length > 0
    ? `<details class="real-works-more"><summary>历史任务（${olderRuns.length} 个，默认只展示最近一次）</summary>
        <ul>${olderRuns.map(r => `<li title="${escapeHtml(r.id)}">${escapeHtml(r.id.slice(0, 12))}… · ${escapeHtml(WORK_RUN_STATUS_LABEL[r.status] ?? r.status)} · ${escapeHtml(formatWorkTime(r.created_at))}</li>`).join('')}</ul>
      </details>`
    : '';
  return `<article class="real-work-group">${head}
    <div class="real-work-body">
      <div class="real-work-run">
        ${runHead}
        ${shots
          ? `<div class="real-work-shots">${shots}</div>`
          : '<p class="real-hint">该任务还没有交付物。</p>'}
      </div>
      ${olderNote}
      <div class="state-actions"><button type="button" class="secondary" data-works-open="${escapeHtml(project.id)}">打开工作台查看全部版本与交付</button></div>
    </div>
  </article>`;
}

function bindRealWorksActions() {
  const body = $('#real-works-body');
  if (!body) return;
  body.onclick = event => {
    const open = event.target.closest('[data-works-open]');
    if (open) {
      window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: open.dataset.worksOpen } }));
      return;
    }
    if (event.target.closest('[data-works-start]')) {
      // 空状态直接开始：跳到「我的商品」视图（app.js 的 setView 由导航按钮触发）
      document.querySelector('.nav-item[data-view="projects"]')?.click();
      return;
    }
    if (event.target.closest('[data-works-retry]')) {
      body.innerHTML = '<div class="loading-line"></div>';
      void renderRealWorks();
      return;
    }
    const toggle = event.target.closest('[data-works-toggle]');
    if (toggle) {
      const groupBody = toggle.nextElementSibling;
      if (groupBody) groupBody.hidden = !groupBody.hidden;
    }
  };
}

function formatWorkTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
