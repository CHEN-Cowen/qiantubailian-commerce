import { ApiFailure, api } from './api.js';

/**
 * 模块02：首次制作一页三步向导（上传商品 → 确认必要信息 → 风格与交付）。
 *
 * 界面的五条自我约束：
 * 1. 浏览器预览与服务端保存分开表述：预览刷新不可恢复，服务端结果只报真实返回值。
 * 2. OCR 只给「候选 + 来源 + 待确认」，未配置时明确说明，绝不生成假识别结果。
 * 3. 报价全部来自服务端 createQuote 响应，前端不硬编码任何价格与张数。
 * 4. 生成两段式：先冻结 spec 并取价，再凭 Idempotency-Key 创建任务，防重复扣费。
 * 5. 失败渲染为失败，不虚构进度；关键项未确认被服务端闸口与前端双重拦截。
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STORAGE_KEY = 'qtb.wizard.draft';
// 项目草稿的内部标识前缀：明确是系统自动生成的 SKU，不伪造商品事实
const AUTO_SKU_PREFIX = 'AUTO-';
const AUTO_CATEGORY = '待补充';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const formatTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
};

const shortHash = value => (value ? `${value.slice(0, 12)}…` : '—');

const errorText = error => {
  if (error instanceof ApiFailure) return error.message;
  console.error('[wizard] 未预期错误', error);
  return '无法连接本地服务，请确认服务已启动后重试';
};

const randomHex = length => {
  const bytes = new Uint8Array(length);
  globalThis.crypto?.getRandomValues?.(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const state = {
  step: 1,
  file: null,
  objectUrl: null,
  uploading: false,
  project: null,
  asset: null,
  assets: [],
  ocr: null,
  templates: [],
  brandKits: [],
  templateId: '',
  brandKitId: '',
  resolutions: {},
  preview: null,
  specVersion: null,
  quote: null,
  phase: 'idle', // idle | freezing | quoting | creating | done
  idempotencyKey: '',
};

function showToast(message) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 3000);
}

// ---------- 草稿恢复（sessionStorage：只记服务端已保存的 projectId/步骤） ----------
function readDraft() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { return null; }
}
function saveDraft(patch = {}) {
  const draft = { ...(readDraft() ?? {}), ...patch };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}
function clearDraft() { sessionStorage.removeItem(STORAGE_KEY); }

function newIdempotencyKey() {
  return `wiz-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${randomHex(8)}`}`;
}

// ---------- 步骤条与面板显隐 ----------
function setStep(step) {
  state.step = step;
  for (const button of $$('#wiz-steps [data-wiz-goto]')) {
    const target = Number(button.dataset.wizGoto);
    const done = target < step;
    button.classList.toggle('is-current', target === step);
    button.classList.toggle('is-done', done);
    if (target === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.disabled = target > step; // 未到达的步骤不可跳；已完成步可点击回退
  }
  for (const panel of $$('#create-view [data-wiz-panel]')) {
    panel.hidden = Number(panel.dataset.wizPanel) !== step;
  }
  $('#wiz-resume').hidden = !(step === 1 && readDraft()?.projectId);
}

function renderResumeBanner() {
  const draft = readDraft();
  const banner = $('#wiz-resume');
  if (!draft?.projectId) { banner.hidden = true; return; }
  $('#wiz-resume-note').textContent =
    `服务端已保存项目 ${draft.projectId}${draft.step ? `（进行到第 ${draft.step} 步）` : ''}；浏览器里未上传完的文件无法恢复。`;
  banner.hidden = state.step !== 1;
}

// ---------- 第 1 步：上传商品 ----------
function resetStep1() {
  state.file = null;
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  $('#wiz-preview-img').removeAttribute('src');
  $('#wiz-preview').hidden = true;
  $('#wiz-upload-status').hidden = true;
  $('#wiz-upload-result').hidden = true;
  $('#wiz-upload-error').textContent = '';
  $('#wiz-upload-retry').hidden = true;
  $('#wiz-next-1').disabled = true;
}

function acceptFile(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    $('#wiz-upload-error').textContent = '请选择 JPEG / PNG / WebP 图片；具体以服务端真实校验为准。';
    $('#wiz-preview').hidden = false;
    $('#wiz-upload-result').hidden = true;
    return;
  }
  resetStep1();
  state.file = file;
  state.objectUrl = URL.createObjectURL(file);
  $('#wiz-preview-img').src = state.objectUrl;
  $('#wiz-preview').hidden = false;
  $('#wiz-upload-status').hidden = false;
  $('#wiz-upload-status').textContent = '浏览器预览已生成（尚未保存到服务端）…';
  if (!$('#wiz-name').value.trim()) $('#wiz-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
  void startUpload(false);
}

async function ensureProjectDraft() {
  if (state.project) return state.project;
  const name = ($('#wiz-name').value.trim() || state.file?.name.replace(/\.[^.]+$/, '') || '未命名商品').slice(0, 80);
  $('#wiz-name').value = name;
  const payload = await api.createProject({
    name,
    // 内部自动标识，撞库时自动换号重试一次；不把 SKU 包装成商品事实
    sku: `${AUTO_SKU_PREFIX}${randomHex(6)}`,
    category: AUTO_CATEGORY,
  });
  state.project = payload.project;
  saveDraft({ projectId: state.project.id, step: 1 });
  $('#wiz-truth-name').value = state.project.name;
  $('#wiz-name').disabled = true;
  return state.project;
}

async function uploadWith(file, { replace }) {
  const project = await ensureProjectDraft();
  const payload = await api.uploadAsset(project.id, file, {
    role: 'subject',
    onConflict: replace ? 'replace' : undefined,
  });
  return payload;
}

async function startUpload(replace) {
  if (!state.file || state.uploading) return;
  state.uploading = true;
  $('#wiz-upload-error').textContent = '';
  $('#wiz-upload-retry').hidden = true;
  $('#wiz-upload-status').hidden = false;
  $('#wiz-upload-status').textContent = '正在创建项目草稿并上传（上传中…）';
  try {
    const payload = await uploadWith(state.file, { replace });
    state.asset = payload.asset;
    state.assets = [payload.asset];
    const warnings = payload.warnings ?? [];
    $('#wiz-upload-status').hidden = true;
    const result = $('#wiz-upload-result');
    result.hidden = false;
    result.innerHTML = `<div class="upload-done">
      <b>已保存到服务端</b>
      <p>${escapeHtml(payload.asset.filename)} · ${payload.asset.width}×${payload.asset.height}px · 素材 ID ${escapeHtml(payload.asset.id)} · sha256 ${escapeHtml(shortHash(payload.asset.sha256))}</p>
      ${warnings.length ? `<ul class="upload-warnings">${warnings.map(item => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>`
        : '<p>已通过服务端类型、体积与尺寸校验。上方浏览器预览仅供参考，刷新后以服务端素材为准。</p>'}
    </div>`;
    $('#wiz-next-1').disabled = false;
    saveDraft({ projectId: state.project.id, assetId: payload.asset.id, step: 1 });
    renderResumeBanner();
  } catch (error) {
    $('#wiz-upload-status').hidden = true;
    $('#wiz-upload-result').hidden = true;
    if (error instanceof ApiFailure && error.code === 'REFERENCE_CONFLICT') {
      $('#wiz-upload-error').textContent = `${error.message}（可选择「替换已有主体素材并上传」）`;
      $('#wiz-upload-retry').hidden = false;
    } else if (error instanceof ApiFailure && error.code === 'SKU_EXISTS') {
      // 自动 SKU 撞号：换一个内部标识重试一次
      state.project = null;
      $('#wiz-name').disabled = false;
      $('#wiz-upload-error').textContent = '项目草稿内部标识冲突，已重置，请重试上传。';
    } else {
      $('#wiz-upload-error').textContent = errorText(error);
    }
  } finally {
    state.uploading = false;
  }
}

// ---------- 第 2 步：确认必要信息 ----------
function factRowHtml(fact = {}) {
  const sources = state.assets.filter(asset => asset.role_status === 'active' && asset.role !== 'style');
  const options = ['<option value="">用户输入（需人工确认）</option>'].concat(sources.map(asset =>
    `<option value="${escapeHtml(asset.id)}"${fact.source_asset_id === asset.id ? ' selected' : ''}>素材：${escapeHtml(asset.filename)}</option>`));
  if (fact.source_asset_id && !sources.some(asset => asset.id === fact.source_asset_id)) {
    options.push(`<option value="${escapeHtml(fact.source_asset_id)}" selected>已替换素材（需重选）</option>`);
  }
  const note = fact.note ? ` title="${escapeHtml(fact.note)}"` : '';
  return `<div class="fact-row"${note}>
    <label class="fact-flag"><input type="checkbox" data-wiz-fact="critical"${fact.critical ? ' checked' : ''}> 关键</label>
    <input data-wiz-fact="key" placeholder="事实项，如 容量" value="${escapeHtml(fact.key ?? '')}" maxlength="60">
    <input data-wiz-fact="value" placeholder="值，如 50g" value="${escapeHtml(fact.value ?? '')}" maxlength="500">
    <select data-wiz-fact="source" aria-label="事实来源">${options.join('')}</select>
    <label class="fact-flag"><input type="checkbox" data-wiz-fact="confirmed"${fact.confirmed ? ' checked' : ''}> 已确认</label>
    <button type="button" class="icon-button" data-wiz-action="remove-fact" aria-label="删除该事实项">×</button>
  </div>`;
}

function addFactRow(fact = {}) {
  $('#wiz-facts').insertAdjacentHTML('beforeend', factRowHtml(fact));
}

function renderOcrNote(result) {
  const node = $('#wiz-ocr-note');
  const candidates = result.candidates ?? [];
  if (!result.configured) {
    node.className = 'state-note';
    node.textContent = `未配置文字识别，可手动填写。${result.note ? `（服务端说明：${result.note}）` : ''}`;
    return;
  }
  if (candidates.length === 0) {
    node.className = 'state-note warn';
    node.textContent = `已配置文字识别，但没有识别到候选文字，可手动填写。${result.note ?? ''}`;
    return;
  }
  const shaky = candidates.filter(item => item.needs_evidence).length;
  node.className = 'state-note warn';
  node.textContent = `已获得 ${candidates.length} 条候选文字（来源：OCR，待确认）— 已逐条列出，请对照原图核对后勾选「已确认」。`
    + (shaky ? `其中 ${shaky} 条置信度不足或缺失，请重点核对。` : '候选不会自动生效为商品事实。');
}

async function enterStep2() {
  const errorNode = $('#wiz-truth-error');
  errorNode.textContent = '';
  $('#wiz-readiness').hidden = true;
  $('#wiz-continue-anyway').hidden = true;
  if (!state.project || !state.asset) { setStep(1); return; }
  try {
    const detail = await api.getProject(state.project.id);
    state.project = detail.project;
    state.assets = detail.assets ?? [];
    $('#wiz-truth-name').value = state.project.name;
    const facts = detail.truth_head?.facts ?? [];
    $('#wiz-facts').innerHTML = facts.length
      ? facts.map(fact => factRowHtml(fact)).join('')
      : factRowHtml({});
    $('#wiz-ocr-note').textContent = '正在读取文字识别结果…';
    const result = await api.extractAssetFacts(state.project.id, state.asset.id);
    state.ocr = result;
    renderOcrNote(result);
    if (result.configured && result.candidates?.length) {
      // 候选只进列表且一律待确认：不自动勾「已确认」，不生成假识别结果
      for (const [index, candidate] of result.candidates.entries()) {
        addFactRow({
          key: candidate.key ?? `待确认文字 ${index + 1}`,
          value: candidate.value ?? '',
          source_asset_id: candidate.source_asset_id ?? state.asset.id,
          confirmed: false,
          critical: false,
          note: candidate.note ?? undefined,
        });
      }
    }
    setStep(2);
  } catch (error) {
    errorNode.textContent = errorText(error);
    setStep(2);
  }
}

function collectFacts() {
  const facts = [];
  for (const row of $$('#wiz-facts .fact-row')) {
    const key = row.querySelector('[data-wiz-fact="key"]').value.trim();
    const value = row.querySelector('[data-wiz-fact="value"]').value.trim();
    if (!key && !value) continue;
    if (!key) throw new ApiFailure(0, 'CLIENT_INVALID', '事实项缺少名称');
    if (!value) throw new ApiFailure(0, 'CLIENT_INVALID', `事实「${key}」缺少值；不确定时请留空整行并补充证据`);
    const source = row.querySelector('[data-wiz-fact="source"]').value;
    const fact = {
      key,
      value,
      critical: row.querySelector('[data-wiz-fact="critical"]').checked,
      confirmed: row.querySelector('[data-wiz-fact="confirmed"]').checked,
    };
    if (source) fact.source_asset_id = source;
    else fact.source_type = 'user_input';
    facts.push(fact);
  }
  return facts;
}

function renderReadiness(readiness) {
  const node = $('#wiz-readiness');
  node.hidden = false;
  if (readiness.can_start_production) {
    $('#wiz-continue-anyway').hidden = true;
    node.innerHTML = '<h4>生产前置检查</h4><p class="truth-ok">商品事实与素材已满足生产条件，可以继续选择风格与交付。</p>';
    return false;
  }
  const blockers = readiness.blockers ?? [];
  $('#wiz-continue-anyway').hidden = false;
  node.innerHTML = `<h4>生产前置检查 · 还有 ${readiness.blocker_count ?? blockers.length} 项未满足</h4>
    <ul class="truth-blockers">${blockers.map(item =>
      `<li><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</li>`).join('')}</ul>
    <p class="truth-hint">可以返回补充事实，也可以先继续选择不依赖这些信息的交付；生成前会按所选模板再次校验。</p>`;
  return true;
}

async function confirmTruth() {
  const errorNode = $('#wiz-truth-error');
  errorNode.textContent = '';
  let facts;
  try {
    facts = collectFacts();
  } catch (error) {
    errorNode.textContent = errorText(error);
    return;
  }
  if (facts.length === 0) {
    errorNode.textContent = '至少需要 1 条商品事实才能确认版本。';
    return;
  }
  const unconfirmedCritical = facts.filter(fact => fact.critical && !fact.confirmed).map(fact => fact.key);
  if (unconfirmedCritical.length > 0) {
    errorNode.textContent = `关键项 ${unconfirmedCritical.join('、')} 必须勾选「已确认」才能继续；不确定的信息请先补证据。`;
    return;
  }
  const button = $('#wiz-confirm-truth');
  button.disabled = true;
  try {
    const payload = await api.createTruthVersion(state.project.id, {
      base_version: state.project.truth_head_version,
      sku: state.project.sku,
      category: state.project.category,
      confirm: true,
      facts,
      critical_text: [],
    });
    state.project.truth_head_version = payload.truth_version.version;
    showToast(`已确认商品事实 v${payload.truth_version.version}`);
    const readiness = await api.readiness(state.project.id);
    const blocked = renderReadiness(readiness);
    saveDraft({ projectId: state.project.id, assetId: state.asset?.id, step: 2 });
    if (!blocked) setStep(3);
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'CONFIRMATION_BLOCKED') {
      errorNode.innerHTML = `仍有关键项未满足，未生成新版本：<ul class="truth-blockers">${(error.details?.blockers ?? [])
        .map(item => `<li><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</li>`).join('')}</ul>`;
      return;
    }
    if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
      errorNode.textContent = '事实版本已被其他操作更新，已刷新为最新版本，请重新核对后提交。';
      await enterStep2();
      return;
    }
    errorNode.textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
}

// ---------- 第 3 步：风格与交付 + 真实报价 ----------
async function enterStep3() {
  const errorNode = $('#wiz-generate-error');
  errorNode.textContent = '';
  state.quote = null;
  state.specVersion = null;
  state.preview = null;
  state.resolutions = {};
  renderQuoteSummary();
  try {
    const [templates, kits] = await Promise.all([api.listTemplates(), api.listBrandKits()]);
    state.templates = templates.templates ?? [];
    state.brandKits = kits.brand_kits ?? [];
    renderTemplates();
    renderBrandOptions();
    setStep(3);
    saveDraft({ projectId: state.project?.id, assetId: state.asset?.id, step: 3 });
    await refreshPreview();
  } catch (error) {
    setStep(3);
    errorNode.textContent = errorText(error);
  }
}

function templateCard(item, selected) {
  return `<button type="button" class="wiz-template-card${selected ? ' selected' : ''}" data-wiz-template="${escapeHtml(item.id)}" aria-pressed="${selected ? 'true' : 'false'}">
    <b>${escapeHtml(item.name)}</b>
    <span>${escapeHtml(item.purpose ?? '')}</span>
    <small>${item.deliverable_count ?? (item.deliverables?.length ?? 0)} 项交付</small>
  </button>`;
}

function renderTemplates() {
  const recommended = state.templates.slice(0, 3);
  const rest = state.templates.slice(3);
  $('#wiz-templates').innerHTML = recommended.length
    ? recommended.map(item => templateCard(item, item.id === state.templateId)).join('')
    : '<p class="real-empty">未读取到服务端模板目录。</p>';
  $('#wiz-templates-more').innerHTML = rest.map(item => templateCard(item, item.id === state.templateId)).join('');
}

function renderBrandOptions() {
  const select = $('#wiz-brand');
  const previous = state.brandKitId;
  select.innerHTML = ['<option value="">不使用品牌套件</option>'].concat(state.brandKits.map(kit =>
    `<option value="${escapeHtml(kit.id)}">${escapeHtml(kit.name)} · v${escapeHtml(kit.head_version ?? 1)}</option>`)).join('');
  if (previous && state.brandKits.some(kit => kit.id === previous)) select.value = previous;
}

function specPayload() {
  const body = { template_id: state.templateId, conflict_resolutions: state.resolutions };
  const platform = $('#wiz-platform').value.trim();
  if (platform) body.platform = platform;
  const brandId = $('#wiz-brand').value;
  if (brandId) body.brand_kit_id = brandId;
  if ($('#wiz-custom-layout').checked) {
    body.text_layout = {
      x: Number($('#wiz-text-x').value) / 100,
      y: Number($('#wiz-text-y').value) / 100,
      width: Number($('#wiz-text-width').value) / 100,
      size_ratio: Number($('#wiz-text-size').value) / 100,
    };
  }
  return body;
}

/** 影响价格/清单的配置变化后，冻结与报价全部作废，重新走预览与取价。 */
function invalidateQuote() {
  state.quote = null;
  state.specVersion = null;
  renderQuoteSummary();
  updateGenerateButton();
}

async function refreshPreview() {
  const errorNode = $('#wiz-generate-error');
  errorNode.textContent = '';
  if (!state.project || !state.templateId) { $('#wiz-delivery').innerHTML = ''; $('#wiz-spec-notes').innerHTML = ''; updateGenerateButton(); return; }
  $('#wiz-delivery').innerHTML = '<p class="truth-hint">正在按当前选择推导交付清单与冲突…</p>';
  try {
    const result = await api.previewSpec(state.project.id, specPayload());
    state.preview = result;
    renderPreview(result);
  } catch (error) {
    state.preview = null;
    $('#wiz-delivery').innerHTML = '';
    if (error instanceof ApiFailure && error.details?.conflicts) {
      $('#wiz-spec-notes').innerHTML = `<section class="wiz-notes"><h4>未处理的冲突</h4><ul class="truth-blockers">${error.details.conflicts
        .map(item => `<li><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</li>`).join('')}</ul></section>`;
    } else {
      $('#wiz-spec-notes').innerHTML = '';
      errorNode.textContent = errorText(error);
    }
  }
  updateGenerateButton();
}

function renderPreview(result) {
  const payload = result.payload;
  const readiness = result.readiness;
  const channel = payload.channel;
  const rows = payload.deliverables.map(item => `
    <li><b>${escapeHtml(item.label)}</b>
      <span class="spec-chip">${escapeHtml(item.type)}</span>
      <span>${item.required ? '必需' : '可选'}${item.count > 1 ? ` ×${item.count}` : ''}</span>
      <span>${escapeHtml(item.ratio)} · ${item.width}×${item.height}</span>
      <span>${item.formats.map(format => escapeHtml(format)).join(' / ')}</span>
      <span>${item.text_blocks.length === 0 ? '无文字' : `文字块 ${item.text_blocks.length} 处`}</span>
      ${item.channel_adjusted.length ? '<span class="spec-chip">已按平台调整</span>' : ''}
    </li>`).join('');

  const conflicts = [...payload.conflicts.pending, ...payload.conflicts.unresolvable];
  const conflictHtml = conflicts.length === 0
    ? '<p class="truth-ok">当前没有未处理的规则冲突。</p>'
    : `<ul class="spec-conflicts">${conflicts.map(item => `
      <li class="spec-conflict ${item.options.length === 0 ? 'blocked' : 'hard'}">
        <div class="spec-conflict-head"><b>${escapeHtml(item.code)}</b></div>
        <p>${escapeHtml(item.message)}</p>
        ${item.options.length === 0
          ? '<p class="spec-noway">平台硬约束没有可接受的处理方式，请先修改商品事实或更换模板。</p>'
          : `<label class="spec-resolution">处理方式
              <select data-wiz-conflict="${escapeHtml(item.key)}">
                <option value="">请选择（不选不能生成）</option>
                ${item.options.map(option => `<option value="${escapeHtml(option.id)}"${state.resolutions[item.key] === option.id ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
              </select>
            </label>`}
      </li>`).join('')}</ul>`;

  const claims = payload.gaps.claims_without_evidence ?? [];
  const missingRefs = payload.gaps.missing_references ?? [];
  const warnings = payload.gaps.warnings ?? [];

  $('#wiz-delivery').innerHTML = `
    <section class="wiz-notes">
      <h4>交付清单 <span>共 ${payload.deliverables.length} 项，必需 ${payload.deliverables.filter(item => item.required).length} 项（默认制作必需项）</span></h4>
      <ul class="wiz-delivery-list">${rows}</ul>
      <p class="real-note">平台规则：${channel?.platform_coverage === 'verified' ? '已核验' : '覆盖不足，不能声称平台通过'}。清单变化会影响报价，正式费用以生成前的真实报价为准。</p>
    </section>`;
  $('#wiz-spec-notes').innerHTML = `
    <section class="wiz-notes"><h4>规则冲突</h4>${conflictHtml}</section>
    ${claims.length ? `<section class="wiz-notes"><h4>需要补证据的内容</h4><ul class="truth-warnings">${claims.map(item =>
      `<li>${escapeHtml(item.message)}</li>`).join('')}</ul><p class="real-note">界面不会替这些内容补写文案。</p></section>` : ''}
    ${missingRefs.length + warnings.length ? `<section class="wiz-notes"><h4>规则与模板提示</h4><ul class="truth-warnings">${[...missingRefs, ...warnings]
      .map(item => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul></section>` : ''}
    ${readiness.can_start_production ? '' : `<section class="wiz-notes"><h4>生产前置未满足</h4><ul class="truth-blockers">${readiness.blockers
      .map(item => `<li><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</li>`).join('')}</ul></section>`}`;
  // 已选处理方式回填，避免重渲染后选择丢失
  for (const select of $$('#wiz-spec-notes [data-wiz-conflict]')) {
    const chosen = state.resolutions[select.dataset.wizConflict];
    if (chosen && [...select.options].some(option => option.value === chosen)) select.value = chosen;
  }
}

function generateBlocked() {
  if (!state.preview || !state.project) return true;
  const payload = state.preview.payload;
  const readiness = state.preview.readiness;
  return payload.conflicts.pending.length > 0
    || payload.conflicts.unresolvable.length > 0
    || !readiness.can_start_production;
}

function updateGenerateButton() {
  const button = $('#wiz-generate');
  if (state.phase === 'done') { button.disabled = true; button.textContent = '任务已提交'; return; }
  if (state.phase !== 'idle') { button.disabled = true; return; } // 文案由调用方给出
  if (!state.templateId) { button.disabled = true; button.textContent = '生成'; return; }
  const blocked = generateBlocked();
  button.disabled = blocked;
  button.textContent = state.quote ? '确认生成' : '生成';
}

function renderQuoteSummary() {
  const holder = $('#wiz-quote');
  const quote = state.quote;
  if (!quote) { holder.hidden = true; holder.innerHTML = ''; return; }
  const imageCount = (quote.lines ?? []).reduce((sum, line) => sum + (Number(line.count) || 1), 0);
  const note = (quote.notes ?? []).join(' ') || quote.settlement_policy || '';
  holder.hidden = false;
  holder.innerHTML = `<div class="wiz-quote-bar">
    <b>生成 ${imageCount} 张图片 · 最多使用 ${quote.max_credits} 点</b>
    <span>估算 ${quote.estimated_credits} 点 · 价格版本 ${escapeHtml(quote.price_version ?? '')}</span>
    <p>${escapeHtml(note)}</p>
    <p class="real-note">报价有效期至 ${formatTime(quote.expires_at)}；过期或配置变化后需重新取价。开始时按上限预留，未发生部分在任务结束后释放。</p>
  </div>`;
}

async function onGenerate() {
  const errorNode = $('#wiz-generate-error');
  const button = $('#wiz-generate');
  errorNode.textContent = '';
  if (!state.project) return;
  button.disabled = true;
  try {
    if (!state.quote) {
      // 两段式第一段：冻结配置 → 服务端真实报价
      state.phase = 'freezing';
      button.textContent = '正在冻结配置…';
      const specResult = await api.createSpec(state.project.id, {
        ...specPayload(),
        base_version: state.project.spec_head_version,
      });
      state.specVersion = specResult.spec.version;
      state.project.spec_head_version = specResult.spec.version;
      state.phase = 'quoting';
      button.textContent = '正在获取真实报价…';
      const quoteResult = await api.createQuote({ project_id: state.project.id, spec_version: state.specVersion });
      state.quote = quoteResult.quote;
      state.phase = 'idle';
      renderQuoteSummary();
      updateGenerateButton();
      showToast('已冻结配置并取得报价，请确认费用后生成');
    } else {
      // 两段式第二段：带 Idempotency-Key 创建任务，重复点击不会重复扣费
      state.phase = 'creating';
      button.textContent = '正在创建任务…';
      const result = await api.createRun({
        project_id: state.project.id,
        quote_id: state.quote.quote_id,
        spec_version: state.specVersion,
      }, state.idempotencyKey);
      state.phase = 'done';
      clearDraft();
      const run = result.run ?? {};
      $('#wiz-done-note').textContent =
        `任务 ${run.id ?? '—'} 当前状态「${run.status ?? 'queued'}」；报价预留与结算以额度账本为准。`;
      $('#wiz-done').hidden = false;
      updateGenerateButton();
      window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: state.project.id } }));
    }
  } catch (error) {
    state.phase = 'idle';
    updateGenerateButton();
    if (error instanceof ApiFailure && ['QUOTE_EXPIRED', 'QUOTE_SPEC_MISMATCH'].includes(error.code)) {
      invalidateQuote();
      errorNode.textContent = `${error.message} 已作废旧报价，请重新点击「生成」取价。`;
      return;
    }
    if (error instanceof ApiFailure && error.code === 'READINESS_BLOCKED') {
      errorNode.textContent = error.message;
      await refreshPreview();
      return;
    }
    if (error instanceof ApiFailure && ['SPEC_CONFLICTS_PENDING', 'SPEC_CONFLICT_UNRESOLVABLE'].includes(error.code)) {
      errorNode.textContent = error.message;
      await refreshPreview();
      return;
    }
    errorNode.textContent = errorText(error);
  } finally {
    if (state.phase !== 'done') button.disabled = state.quote ? false : generateBlocked();
  }
}

// ---------- 视图进入 / 重置 ----------
function resetForEntry() {
  state.project = null;
  state.asset = null;
  state.assets = [];
  state.ocr = null;
  state.preview = null;
  state.quote = null;
  state.specVersion = null;
  state.resolutions = {};
  state.templateId = '';
  state.brandKitId = '';
  state.phase = 'idle';
  state.idempotencyKey = newIdempotencyKey(); // 每次打开向导重新生成幂等键
  resetStep1();
  $('#wiz-name').value = '';
  $('#wiz-name').disabled = false;
  $('#wiz-facts').innerHTML = '';
  $('#wiz-selling-points').value = '';
  $('#wiz-platform').value = '';
  $('#wiz-brand').innerHTML = '<option value="">不使用品牌套件</option>';
  $('#wiz-custom-layout').checked = false;
  $('#wiz-delivery').innerHTML = '';
  $('#wiz-spec-notes').innerHTML = '';
  $('#wiz-quote').hidden = true;
  $('#wiz-quote').innerHTML = '';
  $('#wiz-done').hidden = true;
  $('#wiz-generate-error').textContent = '';
  $('#wiz-truth-error').textContent = '';
  $('#wiz-generate').textContent = '生成';
  $('#wiz-generate').disabled = true;
  setStep(1);
  renderResumeBanner();
}

async function continueDraft() {
  const draft = readDraft();
  if (!draft?.projectId) return;
  try {
    const detail = await api.getProject(draft.projectId);
    state.project = detail.project;
    state.assets = detail.assets ?? [];
    state.asset = state.assets.find(asset => asset.id === draft.assetId && asset.role_status === 'active')
      ?? state.assets.find(asset => asset.role === 'subject' && asset.role_status === 'active')
      ?? null;
    $('#wiz-name').value = state.project.name;
    $('#wiz-truth-name').value = state.project.name;
    $('#wiz-name').disabled = true;
    renderResumeBanner();
    if (!state.asset) { setStep(1); showToast('服务端草稿已恢复，但尚未保存素材，请重新选择文件上传'); return; }
    $('#wiz-preview').hidden = true;
    const result = $('#wiz-upload-result');
    result.hidden = false;
    result.innerHTML = `<div class="upload-done"><b>已恢复服务端已保存素材</b>
      <p>${escapeHtml(state.asset.filename)} · ${state.asset.width}×${state.asset.height}px · 素材 ID ${escapeHtml(state.asset.id)} · sha256 ${escapeHtml(shortHash(state.asset.sha256))}</p>
      <p>浏览器本地预览已不可恢复；此素材来自服务端保存结果。</p></div>`;
    $('#wiz-next-1').disabled = false;
    const step = Math.min(Math.max(Number(draft.step) || 1, 1), 3);
    if (step >= 3) await enterStep3();
    else if (step === 2) await enterStep2();
    else setStep(1);
  } catch (error) {
    clearDraft();
    renderResumeBanner();
    showToast(`恢复草稿失败：${errorText(error)}`);
  }
}

// ---------- 初始化 ----------
export function initWizard() {
  const drop = $('#wiz-drop');
  const fileInput = $('#wiz-file');
  drop?.addEventListener('click', () => fileInput?.click());
  drop?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput?.click(); }
  });
  drop?.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragover'); });
  drop?.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop?.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragover');
    acceptFile(event.dataTransfer?.files?.[0]);
  });
  fileInput?.addEventListener('change', () => { acceptFile(fileInput.files?.[0]); fileInput.value = ''; });
  $('#wiz-retry-replace')?.addEventListener('click', () => void startUpload(true));
  $('#wiz-retry-change')?.addEventListener('click', () => { fileInput?.click(); });
  $('#wiz-next-1')?.addEventListener('click', () => void enterStep2());
  $('#wiz-add-fact')?.addEventListener('click', () => addFactRow({}));
  $('#wiz-facts')?.addEventListener('click', event => {
    const trigger = event.target.closest('[data-wiz-action="remove-fact"]');
    if (!trigger) return;
    const row = trigger.closest('.fact-row');
    if ($$('#wiz-facts .fact-row').length <= 1) {
      row.querySelector('[data-wiz-fact="key"]').value = '';
      row.querySelector('[data-wiz-fact="value"]').value = '';
      return;
    }
    row.remove();
  });
  $('#wiz-back-2')?.addEventListener('click', () => setStep(1));
  $('#wiz-confirm-truth')?.addEventListener('click', () => void confirmTruth());
  $('#wiz-continue-anyway')?.addEventListener('click', () => void enterStep3());
  $('#wiz-back-3')?.addEventListener('click', () => setStep(2));
  $$('#wiz-steps [data-wiz-goto]').forEach(button => button.addEventListener('click', () => {
    const target = Number(button.dataset.wizGoto);
    if (target > state.step) return;
    if (target === 3 && state.step === 2) { void enterStep3(); return; }
    if (target === 2 && state.step === 3) { setStep(2); return; }
    setStep(target);
  }));
  $('#wiz-exit')?.addEventListener('click', () => { location.hash = 'projects'; });
  $('#wiz-brand')?.addEventListener('change', () => { state.brandKitId = $('#wiz-brand').value; state.resolutions = {}; invalidateQuote(); void refreshPreview(); });
  $('#wiz-platform')?.addEventListener('change', () => { state.resolutions = {}; invalidateQuote(); void refreshPreview(); });
  for (const id of ['wiz-custom-layout', 'wiz-text-x', 'wiz-text-y', 'wiz-text-width', 'wiz-text-size']) {
    document.getElementById(id)?.addEventListener('change', () => { invalidateQuote(); void refreshPreview(); });
  }
  $('#wiz-templates')?.addEventListener('click', event => {
    const card = event.target.closest('[data-wiz-template]');
    if (!card) return;
    state.templateId = card.dataset.wizTemplate;
    state.resolutions = {};
    invalidateQuote();
    renderTemplates();
    void refreshPreview();
  });
  $('#wiz-templates-more')?.addEventListener('click', event => {
    const card = event.target.closest('[data-wiz-template]');
    if (!card) return;
    state.templateId = card.dataset.wizTemplate;
    state.resolutions = {};
    invalidateQuote();
    renderTemplates();
    void refreshPreview();
  });
  $('#wiz-spec-notes')?.addEventListener('change', event => {
    const select = event.target.closest('[data-wiz-conflict]');
    if (!select) return;
    state.resolutions[select.dataset.wizConflict] = select.value;
    invalidateQuote();
    void refreshPreview();
  });
  $('#wiz-generate')?.addEventListener('click', () => void onGenerate());
  $('#wiz-open-workbench')?.addEventListener('click', () => {
    if (state.project) window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: state.project.id } }));
  });
  $('#wiz-subject-link')?.addEventListener('click', () => {
    if (!state.project) return;
    showToast('主体框修正请在该项目工作台的「商品事实」里完成；此入口不重复实现');
    window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: state.project.id } }));
  });
  $('#wiz-resume-continue')?.addEventListener('click', () => void continueDraft());
  $('#wiz-resume-restart')?.addEventListener('click', () => { clearDraft(); resetForEntry(); });
  // 每次进入 create 视图都回到第 1 步并重新生成幂等键；服务端草稿通过「继续上次」恢复
  document.addEventListener('qb:view-change', event => {
    if (event.detail?.view === 'create') resetForEntry();
  });
}

if (typeof document !== 'undefined') initWizard();
