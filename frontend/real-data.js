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

const state = { toast: () => {}, projects: [], detail: null, regions: new Map(), pendingProjectId: null };

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
  $('#import-button')?.addEventListener('click', () => openCreateDialog('导入商品资料'));
  $$('.js-new-project').forEach(button => button.addEventListener('click', () => openCreateDialog('创建商品项目')));
  $('#projects-new')?.addEventListener('click', () => openCreateDialog('创建商品项目'));
  $('#upload-button')?.addEventListener('click', () => openUploadDialog());
  $('#project-form')?.addEventListener('submit', submitCreate);
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

function openCreateDialog(title) {
  $('#project-dialog-title').textContent = title;
  $('#project-error').textContent = '';
  $('#project-form').reset();
  $('#project-dialog').showModal();
  $('#project-form [name="name"]')?.focus();
}

async function submitCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('#project-submit');
  const data = Object.fromEntries(new FormData(form));
  $('#project-error').textContent = '';
  submit.disabled = true;
  try {
    const payload = await api.createProject(data);
    form.reset();
    $('#project-dialog').close();
    state.toast(`已创建真实项目：${payload.project.name}（${payload.project.sku}），请上传素材并确认事实`);
    await refresh();
    openUploadDialog(payload.project.id);
  } catch (error) {
    $('#project-error').textContent = errorText(error);
  } finally {
    submit.disabled = false;
  }
}

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
}

// R05：导出给 workbench / 其它模块调用
export { openTruthDialog, openUploadDialog, refresh as refreshProjects };

async function openTruthDialog(projectId) {
  try {
    const detail = await api.getProject(projectId);
    const versions = await api.listTruthVersions(projectId);
    state.detail = { ...detail, versions: versions.versions };
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
    <section class="truth-section">
      <h3>版本历史</h3>
      ${history ? `<ul class="truth-history">${history}</ul>` : '<p class="truth-empty">尚无事实版本。</p>'}
    </section>`;
}

function onTruthClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
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
  const assets = $('#assets-view .asset-layout');
  if (assets) assets.hidden = false;
  if (assets) assets.innerHTML = '<div class="real-list">'+state.projects.map(p => '<article class="real-card"><b>'+escapeHtml(p.name)+'</b><span>'+p.asset_count+' 张素材</span><button class="text-button" data-real-workbench="'+escapeHtml(p.id)+'">查看版本与交付</button></article>').join('')+'</div>';
  document.querySelectorAll('[data-real-workbench]').forEach(button => button.onclick = () => window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: button.dataset.realWorkbench } })));
  // 搜索只筛当前账户真实项目；演示表保留在源码供独立示例使用。
  const table = $('.project-table'); if (table) table.hidden = true;
  const search = $('.search input');
  if (search) search.oninput = () => $$('#real-list .real-card').forEach(card => card.hidden = !card.textContent.toLowerCase().includes(search.value.trim().toLowerCase()));
  const segmented = document.querySelector('.segmented'); if (segmented) segmented.hidden = true;
}
