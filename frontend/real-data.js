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

const state = { toast: () => {}, projects: [], detail: null, regions: new Map(), pendingProjectId: null, skuEditing: null };

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

async function openTruthDialog(projectId) {
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
    <section class="truth-section">
      <h3>版本历史</h3>
      ${history ? `<ul class="truth-history">${history}</ul>` : '<p class="truth-empty">尚无事实版本。</p>'}
    </section>`;
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

function onTruthClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
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
