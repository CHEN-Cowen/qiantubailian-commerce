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
 *
 * 模块03：支持 qb:open-wizard 复用入口——E1 同商品再做一套（reuse，沿用项目/素材/事实，可改后重确认）、
 * E2 用此风格制作新品（style，仅预选模板/品牌，事实与素材一律重新确认）、E3 品牌入口（brand，只预选品牌）。
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STORAGE_KEY = 'qtb.wizard.draft';
// 项目草稿的内部标识前缀：明确是系统自动生成的 SKU，不伪造商品事实
const AUTO_SKU_PREFIX = 'AUTO-';
const AUTO_CATEGORY = '待补充';

// M04：按商品类型给出可理解的问题与示例；关键项必须用户核对，照片可见不等于已确认。
const CATEGORY_PROFILES = {
  '食品/饮品': [
    { key: '净含量', question: '一袋或一瓶有多少？', example: '500g / 500ml', critical: true },
    { key: '保质期', question: '包装上写的保质期是多久？', example: '12 个月', critical: true },
    { key: '配料', question: '主要配料有哪些？', example: '水、燕麦、乳粉', critical: false },
    { key: '储存方式', question: '平时怎么存放？', example: '阴凉干燥处保存', critical: false },
  ],
  '美妆/护肤': [
    { key: '净含量', question: '一瓶或一支有多少？', example: '50ml / 30g', critical: true },
    { key: '适用肤质', question: '适合什么肤质使用？', example: '干性、中性肤质', critical: false },
    { key: '核心功效', question: '商品页上写的功效是什么？', example: '保湿、舒缓（需与资料一致）', critical: false },
    { key: '使用方法', question: '怎么使用？', example: '洁面后取适量涂抹', critical: false },
  ],
  '家居/日用': [
    { key: '材质', question: '主体是什么材质？', example: '304 不锈钢 / 食品级硅胶', critical: true },
    { key: '尺寸', question: '长宽高或容量是多少？', example: '20 × 8 × 8cm / 500ml', critical: true },
    { key: '颜色', question: '这个 SKU 的颜色是什么？', example: '雾白', critical: false },
    { key: '适用场景', question: '主要用在哪里？', example: '厨房台面、浴室', critical: false },
  ],
  '服饰/鞋包': [
    { key: '材质', question: '面料或里料是什么？', example: '棉 95%、氨纶 5%', critical: true },
    { key: '尺码', question: '这个 SKU 是什么尺码？', example: 'M / 38', critical: true },
    { key: '颜色', question: '这个 SKU 的颜色是什么？', example: '燕麦色', critical: false },
    { key: '版型', question: '版型或剪裁是什么？', example: '宽松直筒', critical: false },
  ],
  '其他': [
    { key: '规格', question: '这个 SKU 的规格是什么？', example: '单件 / 500ml', critical: true },
    { key: '材质', question: '主体材质是什么？', example: '不锈钢、硅胶', critical: false },
    { key: '用途', question: '主要用来做什么？', example: '日常收纳', critical: false },
  ],
};

// 功效/绝对化/比较性表达：命中后不允许直接进入成图文案，必须先有可核验依据。
const CLAIM_PATTERNS = [
  /美白/, /祛斑/, /祛痘/, /抗皱/, /抗衰/, /修复/, /消炎/, /杀菌/, /治疗/, /防脱/, /生发/,
  /减肥/, /降血糖/, /降血压/, /增强免疫/, /无副作用/, /纯天然/, /零添加/, /绝对/, /全网/,
  /国家级/, /顶级/, /第一/, /最[好佳强优]/, /100%/, /永久/, /立刻/, /瞬间/,
];
const NUMBER_TOKEN = /(\d+(?:\.\d+)?)\s*(ml|g|kg|cm|mm|寸|片|支|包|袋|瓶|粒|%|小时|天|年)/gi;

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

const copyText = async text => {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    showToast('浏览器未允许复制，请手动选中文字复制');
  }
};

// 把服务端拦截码翻译成用户能执行的下一步
const BLOCKER_TEXT = {
  NO_ASSETS: () => '还没有可用的商品原图，请回到第一步上传。',
  NO_SUBJECT_ASSET: () => '还没有把上传的图标记为「商品主体」，无法锁定商品外形。',
  REFERENCE_CONFLICT: () => '有重复的参考素材（例如两张主体图），需要先决定保留哪一张。',
  NO_TRUTH_VERSION: () => '还没有保存过商品信息，请填写后再确认。',
  NO_CRITICAL_FACT: () => '至少要有 1 项关键信息被核对，例如净含量或材质。',
  UNCONFIRMED_CRITICAL_FACTS: item => `还有 ${item.details?.keys?.length ?? 1} 项关键信息没核对：${(item.details?.keys ?? []).join('、') || '见上方卡片'}。`,
  SKU_MISMATCH: () => '商品信息里的编码与项目不一致，请重新打开项目后再试。',
  TRUTH_DRAFT: () => '商品信息还是草稿状态，需要先确认一次。',
  TRUTH_SOURCE_SUPERSEDED: item => `这些信息引用的图片已被替换，需要基于新图重新核对：${(item.details?.keys ?? []).join('、') || '见上方卡片'}。`,
};
const blockerText = item => (BLOCKER_TEXT[item.code]?.(item) ?? item.message ?? item.code);

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
  uploadTimer: null,
  uploadStartedAt: 0,
  project: null,
  asset: null,
  assets: [],
  ocr: null,
  category: '其他',
  factCards: [],
  sellingPoints: '',
  sellingResults: [],
  templates: [],
  brandKits: [],
  templateId: '',
  brandKitId: '',
  bgFilter: '',
  recommendedTemplateId: '',
  resolutions: {},
  preview: null,
  specVersion: null,
  quote: null,
  phase: 'idle', // idle | freezing | quoting | creating | done
  idempotencyKey: '',
  runId: '',
  run: null,
  runSource: null,
  runPoll: null,
  lastRunEventId: 0,
  // 模块03：商品与品牌复用（E1 同商品再做一套 / E2 用此风格制作新品 / E3 品牌入口）
  entry: null,          // 待应用的 qb:open-wizard 请求（进入 create 视图并重置后消费）
  entryKind: '',        // '' | 'reuse' | 'style'
  styleTemplateId: '',  // E2/E3 预选模板（进入第 3 步且目录中存在时套用）
  styleBrandKitId: '',  // E2/E3 预选品牌（进入第 3 步且目录中存在时套用）
  reuseSpec: null,      // E1 沿用 spec 冻结快照（模板/品牌/平台），快照不随品牌 head 漂移
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

// ---------- 模块03：商品与品牌复用（E1 再做一套 / E2 用此风格做新品 / E3 品牌入口） ----------
function renderEntryBanner(title, note = '') {
  const banner = $('#wiz-reuse');
  if (!banner) return;
  if (!title) { banner.hidden = true; return; }
  $('#wiz-reuse-title').textContent = title;
  $('#wiz-reuse-note').textContent = note;
  banner.hidden = false;
}

/** 入口统一收口：real-data/m04 抛 qb:open-wizard，这里切到 create 视图（经 hash 路由走 app.js 的 setView）。 */
function requestEntry(detail = {}) {
  state.entry = detail && typeof detail === 'object' ? detail : {};
  if (location.hash === '#create') { resetForEntry(); applyEntry(); }
  else location.hash = 'create';
}

function applyEntry() {
  const entry = state.entry;
  state.entry = null;
  if (!entry) return;
  // 未带 detail 的普通打开（新建按钮）不经过这里，保持全新制作行为不变
  if (entry.mode === 'reuse' && entry.projectId) void enterReuse(String(entry.projectId));
  else if (entry.mode === 'style') enterStyle({ templateId: entry.templateId ?? '', brandKitId: entry.brandKitId ?? '' });
  else if (entry.mode === 'brand') enterStyle({ templateId: '', brandKitId: entry.brandKitId ?? '' });
}

/** E1 同商品再做一套：沿用同一项目与素材，不新建项目、不强制重新上传。 */
async function enterReuse(projectId) {
  clearDraft(); // 复用流程自带完整项目上下文，先清掉无关的向导草稿
  state.entryKind = 'reuse';
  state.reuseSpec = null;
  try {
    const detail = await api.getProject(projectId);
    state.project = detail.project;
    state.assets = detail.assets ?? [];
    state.asset = state.assets.find(asset => asset.role === 'subject' && asset.role_status === 'active')
      ?? state.assets.find(asset => asset.role_status === 'active' && asset.role !== 'style')
      ?? null;
    $('#wiz-name').value = state.project.name;
    $('#wiz-truth-name').value = state.project.name;
    $('#wiz-name').disabled = true; // 项目已存在，名称随项目带入，不在此处改名
    if (state.asset) {
      $('#wiz-preview').hidden = true;
      const result = $('#wiz-upload-result');
      result.hidden = false;
      result.innerHTML = `<div class="upload-done"><b>沿用已上传素材</b>
        <p>${escapeHtml(state.asset.filename)} · ${state.asset.width}×${state.asset.height}px · 素材 ID ${escapeHtml(state.asset.id)} · sha256 ${escapeHtml(shortHash(state.asset.sha256))}</p>
        <p>不重新上传也可直接进入下一步；如需换图请重新选择文件（同名图会提示替换并使旧来源事实失效）。</p></div>`;
      $('#wiz-upload-status').hidden = true;
      $('#wiz-next-1').disabled = false;
    } else {
      resetStep1();
    }
    refreshReuseBanner();
    setStep(1);
    renderResumeBanner();
    if (state.project.spec_head_version) void loadReuseSpec(state.project.spec_head_version);
  } catch (error) {
    showToast(`打开「再做一套」失败：${errorText(error)}`);
    location.hash = 'projects';
  }
}

function refreshReuseBanner() {
  if (state.entryKind !== 'reuse' || !state.project) return;
  let summary = `沿用：商品事实 v${state.project.truth_head_version}`;
  if (state.reuseSpec?.brandName) summary += ` · 品牌 ${state.reuseSpec.brandName}`;
  if (state.reuseSpec?.templateName) summary += ` · 模板 ${state.reuseSpec.templateName}`;
  renderEntryBanner(`${summary}，可修改`,
    '同商品再做一套：项目与已确认事实原样带入；修改任一事实行会自动取消该行「已确认」，需重新确认后才会生效。');
}

/** E1 第 3 步预选依据：读 spec 冻结快照（模板/品牌/平台），快照内容不随后续品牌或模板更新漂移。 */
async function loadReuseSpec(version) {
  try {
    const { spec } = await api.getSpec(state.project.id, version);
    state.reuseSpec = {
      templateId: spec.template?.id ?? '',
      templateName: spec.template?.name ?? '',
      brandKitId: spec.brand_kit?.id ?? '',
      brandName: spec.brand_kit?.name ?? '',
      platform: spec.channel?.platform ?? '',
    };
    refreshReuseBanner();
  } catch {
    // 快照读取失败不阻断复用：摘要只显示商品事实部分，第 3 步走默认推荐流程
  }
}

/** E2 用此风格制作新品 / E3 品牌入口：全新商品，只预选模板与品牌。 */
function enterStyle({ templateId = '', brandKitId = '' } = {}) {
  clearDraft(); // 新商品是新的制作会话，不接续旧向导草稿
  state.entryKind = 'style';
  state.styleTemplateId = templateId;
  state.styleBrandKitId = brandKitId;
  // 旧商品的素材、事实、卖点与确认状态已由 resetForEntry 清空，这里只做风格预选声明
  renderEntryBanner('沿用风格；新商品的事实与素材需重新确认，不沿用旧商品信息', '正在读取模板与品牌名称…');
  void applyStyleBannerNames(templateId, brandKitId);
}

async function applyStyleBannerNames(templateId, brandKitId) {
  const parts = [];
  if (templateId) {
    try { parts.push(`模板 ${(await api.getTemplate(templateId)).template?.name ?? templateId}`); }
    catch { parts.push(`模板 ${templateId}`); }
  }
  if (brandKitId) {
    try { parts.push(`品牌 ${(await api.getBrandKit(brandKitId)).brand_kit?.name ?? brandKitId}`); }
    catch { parts.push(`品牌 ${brandKitId}`); }
  }
  if (state.entryKind !== 'style') return; // 会话已被重置（用户重新进入向导）
  renderEntryBanner(
    `沿用风格：${parts.join(' · ') || '默认推荐模板'}；新商品的事实与素材需重新确认，不沿用旧商品信息`,
    parts.length ? '模板与品牌仅预选，进入第 3 步后可修改。' : '',
  );
}

/** 第 3 步目录加载后套用预选：只选目录中仍存在的项，失效项明确回落，不静默假装选上。 */
function applyStep3Preselect() {
  const reuse = state.reuseSpec;
  if (reuse) {
    if (reuse.templateId && state.templates.some(item => item.id === reuse.templateId)) {
      state.templateId = reuse.templateId;
    } else if (reuse.templateId) showToast('原模板已不在目录中，已改为默认推荐');
    if (reuse.brandKitId && state.brandKits.some(kit => kit.id === reuse.brandKitId)) state.brandKitId = reuse.brandKitId;
    if (reuse.platform) $('#wiz-platform').value = reuse.platform;
    return;
  }
  if (state.styleTemplateId) {
    if (state.templates.some(item => item.id === state.styleTemplateId)) state.templateId = state.styleTemplateId;
    else showToast('所选模板已不在目录中，已改为默认推荐');
    state.styleTemplateId = '';
  }
  if (state.styleBrandKitId) {
    if (state.brandKits.some(kit => kit.id === state.styleBrandKitId)) state.brandKitId = state.styleBrandKitId;
    else showToast('所选品牌配方不可用，已改为不使用品牌');
    state.styleBrandKitId = '';
  }
}

// ---------- 第 1 步：上传商品 ----------
function resetStep1() {
  state.file = null;
  stopUploadTimer();
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  $('#wiz-preview-img').removeAttribute('src');
  $('#wiz-preview').hidden = true;
  $('#wiz-upload-status').hidden = true;
  $('#wiz-upload-result').hidden = true;
  $('#wiz-upload-error').textContent = '';
  $('#wiz-upload-retry').hidden = true;
  $('#wiz-retry-replace').hidden = true;
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
  let project;
  try {
    project = await ensureProjectDraft();
  } catch (error) {
    error.uploadStage = 'project';
    throw error;
  }
  try {
    const payload = await api.uploadAsset(project.id, file, {
      role: 'subject',
      onConflict: replace ? 'replace' : undefined,
    });
    return payload;
  } catch (error) {
    error.uploadStage = 'asset';
    throw error;
  }
}

function stopUploadTimer() {
  if (state.uploadTimer) { clearInterval(state.uploadTimer); state.uploadTimer = null; }
  state.uploadStartedAt = 0;
}

async function startUpload(replace) {
  if (!state.file || state.uploading) return;
  state.uploading = true;
  state.uploadStartedAt = Date.now();
  $('#wiz-upload-error').textContent = '';
  $('#wiz-upload-retry').hidden = true;
  $('#wiz-retry-replace').hidden = true;
  $('#wiz-upload-status').hidden = false;
  $('#wiz-upload-status').textContent = '正在创建项目草稿并上传（上传中…）';
  stopUploadTimer();
  // 长耗时只提示“仍在上传”，不把等待时间当成网站失败，也不触发重复上传。
  state.uploadTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - state.uploadStartedAt) / 1000);
    if (seconds >= 20 && state.uploading) {
      $('#wiz-upload-status').textContent = `正在上传（已等待 ${seconds} 秒）；服务端可能仍在处理，超时不等于失败，请勿关闭页面。`;
    }
  }, 10_000);
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
    const stage = error?.uploadStage === 'project' ? '创建项目草稿失败' : '素材上传失败';
    if (error instanceof ApiFailure && error.code === 'REFERENCE_CONFLICT') {
      $('#wiz-upload-error').textContent = `${stage}：${error.message}（可选择「替换已有主体素材并上传」）`;
      $('#wiz-upload-retry').hidden = false;
      $('#wiz-retry-replace').hidden = false;
    } else if (error instanceof ApiFailure && error.code === 'SKU_EXISTS') {
      // 自动 SKU 撞号：换一个内部标识重试一次
      state.project = null;
      $('#wiz-name').disabled = false;
      $('#wiz-upload-error').textContent = '创建项目草稿失败：内部标识冲突，已重置，请重试上传。';
      $('#wiz-upload-retry').hidden = false;
    } else {
      $('#wiz-upload-error').textContent = `${stage}：${errorText(error)}`;
      $('#wiz-upload-retry').hidden = false;
    }
  } finally {
    stopUploadTimer();
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
    $('#wiz-critical-text').value = (detail.truth_head?.critical_text ?? [])
      .map(item => (typeof item === 'string' ? item : item.text))
      .filter(Boolean).join('\n');
    state.category = pickCategory(detail.truth_head?.category ?? state.project.category);
    $('#wiz-category').value = state.category;
    renderFactCards(facts);
    $('#wiz-selling-points').value = state.sellingPoints ?? '';
    renderSellingResults();
    if (state.entryKind === 'reuse') {
      // E1 复用：事实行已从 truth_head 原样带入（key/value/critical/confirmed）。
      // 不重复跑 OCR，避免候选行与沿用行重复；修改任一行内容会自动取消该行「已确认」。
      $('#wiz-ocr-note').className = 'state-note';
      $('#wiz-ocr-note').textContent = '已沿用现有商品事实（未重新运行文字识别）；请对照商品资料逐项核对，改动后需要重新点「已核对」。';
    } else {
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
        hydrateCardsFromRows();
      }
    }
    setStep(2);
  } catch (error) {
    errorNode.textContent = errorText(error);
    setStep(2);
  }
}

function pickCategory(value) {
  return CATEGORY_PROFILES[value] ? value : '其他';
}

function cardStatusText(card) {
  if (!card.value) return card.skipped ? '暂不提供' : '待填写';
  if (!card.confirmed) return '待核对';
  return '已核对 · 会作为商品事实进入成图';
}

function renderFactCards(facts = []) {
  const profile = CATEGORY_PROFILES[state.category] ?? CATEGORY_PROFILES['其他'];
  const byKey = new Map(facts.map(fact => [String(fact.key ?? '').trim(), fact]));
  state.factCards = profile.map(item => {
    const existing = byKey.get(item.key);
    return {
      key: item.key,
      question: item.question,
      example: item.example,
      critical: item.critical,
      value: existing?.value ?? '',
      confirmed: existing?.confirmed === true,
      skipped: false,
      note: existing?.note ?? '',
    };
  });
  renderFactCardDom();
}

function renderFactCardDom() {
  const node = $('#wiz-fact-cards');
  if (!node) return;
  node.innerHTML = state.factCards.map((card, index) => `
    <article class="wiz-fact-card${card.confirmed ? ' confirmed' : ''}${card.skipped ? ' skipped' : ''}" data-card-index="${index}">
      <div class="wfc-head">
        <b>${escapeHtml(card.key)}</b>
        ${card.critical ? '<span class="wfc-badge">关键</span>' : ''}
        <span class="wfc-status">${escapeHtml(cardStatusText(card))}</span>
      </div>
      <p class="wfc-question">${escapeHtml(card.question)}<span>例如：${escapeHtml(card.example)}</span></p>
      <input class="wfc-value" data-card-value maxlength="500" value="${escapeHtml(card.value)}"
        placeholder="按商品资料填写，不确定就留空" aria-label="${escapeHtml(card.key)}">
      <div class="wfc-foot">
        <button type="button" class="secondary" data-card-confirm>已核对，确认这条</button>
        <button type="button" class="text-button" data-card-skip>${card.skipped ? '重新填写' : '暂不提供'}</button>
      </div>
    </article>`).join('');
}

function updateCardStatus(cardNode, card) {
  cardNode.classList.toggle('confirmed', card.confirmed);
  cardNode.classList.toggle('skipped', card.skipped);
  const status = cardNode.querySelector('.wfc-status');
  if (status) status.textContent = cardStatusText(card);
  const skip = cardNode.querySelector('[data-card-skip]');
  if (skip) skip.textContent = card.skipped ? '重新填写' : '暂不提供';
}

/** 把 OCR/事实行里与分类问题同名的值回填到卡片，避免同一信息录两遍。 */
function hydrateCardsFromRows() {
  const cardKeys = new Set(state.factCards.map(card => card.key));
  let changed = false;
  for (const row of $$('#wiz-facts .fact-row')) {
    const key = row.querySelector('[data-wiz-fact="key"]').value.trim();
    if (!cardKeys.has(key)) continue;
    const card = state.factCards.find(item => item.key === key);
    const value = row.querySelector('[data-wiz-fact="value"]').value.trim();
    // 文字识别结果一律保持「待核对」，即使原行被标记过也不直接搬运确认状态
    if (value && !card.value) {
      card.value = value;
      card.confirmed = false;
      card.note = row.title || '';
      changed = true;
    }
    row.remove();
  }
  if (!$('#wiz-facts .fact-row')) addFactRow({});
  if (changed) renderFactCardDom();
}

function collectFacts() {
  const facts = [];
  const seen = new Map();
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
    seen.set(key, fact);
  }
  // 卡片是主要录入方式：只有填了值才成为事实；「已核对」才标记 confirmed。
  for (const card of state.factCards) {
    const value = String(card.value ?? '').trim();
    if (!value || card.skipped) continue;
    seen.set(card.key, {
      key: card.key,
      value,
      critical: card.critical,
      confirmed: card.confirmed === true,
      source_type: 'user_input',
      ...(card.note ? { note: card.note } : {}),
    });
  }
  facts.push(...seen.values());
  return facts;
}

function collectCriticalText() {
  return $('#wiz-critical-text').value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map(text => ({ text }));
}

// ---------- 卖点候选：确定性拆分 + 依据标注，不调用模型 ----------
function currentFactsSafe() {
  try { return collectFacts(); } catch { return []; }
}

function splitSellingText(raw) {
  return [...new Set(String(raw ?? '')
    .split(/[。；;\n]+/)
    .map(line => line.replace(/^[\s·•\-—、,，]+|[\s·•\-—、,，]+$/g, '').trim())
    .filter(line => line.length >= 2))].slice(0, 8);
}

function claimWordsOf(sentence) {
  return CLAIM_PATTERNS.map(pattern => sentence.match(pattern)?.[0]).filter(Boolean);
}

function rewriteWithoutClaims(sentence) {
  let output = sentence;
  for (const word of claimWordsOf(sentence)) output = output.split(word).join('');
  return output.replace(/[，、,]{2,}/g, '，').replace(/^[，、,。\s]+|[，、,。\s]+$/g, '').trim();
}

function numberTokensOf(sentence) {
  return [...String(sentence).matchAll(NUMBER_TOKEN)].map(match => `${match[1]}${match[2].toLowerCase()}`);
}

function analyzeSellingPoint(sentence, facts) {
  const confirmedValues = facts.filter(fact => fact.confirmed).map(fact => `${fact.value}`);
  const allValues = facts.map(fact => `${fact.key} ${fact.value}`);
  const claims = claimWordsOf(sentence);
  const numbers = numberTokensOf(sentence);
  const unmatchedNumbers = numbers.filter(token => !confirmedValues.some(value =>
    value.toLowerCase().replace(/\s+/g, '').includes(token.replace(/\s+/g, ''))));
  if (claims.length > 0) {
    return {
      text: sentence,
      level: 'claim',
      reasons: [`「${claims.join('、')}」属于功效或绝对化表达，必须有可核验依据才能用`],
      rewrite: rewriteWithoutClaims(sentence),
      numbers,
    };
  }
  if (unmatchedNumbers.length > 0) {
    const knownInDraft = unmatchedNumbers
      .filter(token => allValues.some(value => value.toLowerCase().includes(token)));
    return {
      text: sentence,
      level: 'unverified',
      reasons: knownInDraft.length > 0
        ? [`「${knownInDraft.join('、')}」出现在还未核对的商品信息里，先核对再使用`]
        : [`「${unmatchedNumbers.join('、')}」没有出现在已核对的信息里，不能直接写进图`],
      rewrite: '',
      numbers,
    };
  }
  return { text: sentence, level: 'ready', reasons: [], rewrite: '', numbers };
}

const SELL_LEVEL_LABEL = { ready: '可以直接使用', unverified: '含未确认信息', claim: '缺依据的功效表达' };

function renderSellingResults() {
  const node = $('#wiz-sell-results');
  const note = $('#wiz-sell-note');
  if (!node || !note) return;
  if (!state.sellingResults.length) {
    node.innerHTML = '';
    note.textContent = '';
    return;
  }
  node.innerHTML = state.sellingResults.map((item, index) => `
    <article class="wiz-sell-item ${item.level}" data-sell-index="${index}">
      <div class="wsi-head"><span class="wsi-level">${escapeHtml(SELL_LEVEL_LABEL[item.level])}</span>
        <p>${escapeHtml(item.text)}</p></div>
      ${item.reasons.length ? `<ul class="wsi-reasons">${item.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
      ${item.rewrite ? `<p class="wsi-rewrite">去掉功效词后的版本：<b>${escapeHtml(item.rewrite)}</b></p>` : ''}
      <div class="wsi-actions">
        ${item.level === 'ready' ? '<button type="button" class="secondary" data-sell-add>作为卖点事实加入</button>' : ''}
        ${item.level === 'unverified' ? '<button type="button" class="secondary" data-sell-fix>去核对商品信息</button>' : ''}
        ${item.level === 'claim' && item.rewrite ? '<button type="button" class="secondary" data-sell-add-rewrite>使用改写版本加入事实</button>' : ''}
        <button type="button" class="text-button" data-sell-copy>复制这句</button>
      </div>
    </article>`).join('');
  const ready = state.sellingResults.filter(item => item.level === 'ready').length;
  const blocked = state.sellingResults.length - ready;
  note.className = blocked ? 'state-note warn' : 'state-note';
  note.textContent = `共 ${state.sellingResults.length} 句：${ready} 句可直接使用，${blocked} 句需要补信息或改写法。只有你点「作为卖点事实加入」的句子才会写入商品事实。`;
}

function analyzeSelling() {
  const raw = $('#wiz-selling-points').value;
  state.sellingPoints = raw;
  const sentences = splitSellingText(raw);
  if (!sentences.length) {
    state.sellingResults = [];
    renderSellingResults();
    $('#wiz-sell-note').textContent = '先写下想表达的卖点，再用句号、分号或换行分隔。';
    return;
  }
  const facts = currentFactsSafe();
  state.sellingResults = sentences.map(sentence => analyzeSellingPoint(sentence, facts));
  renderSellingResults();
}

function addSellingFact(text) {
  const value = String(text ?? '').trim();
  if (!value) return;
  let row = null;
  for (const candidate of $$('#wiz-facts .fact-row')) {
    if (candidate.querySelector('[data-wiz-fact="key"]').value.trim() === '核心卖点') { row = candidate; break; }
  }
  if (!row) {
    addFactRow({ key: '核心卖点', value, confirmed: true, critical: false, note: '来自卖点候选，已由用户确认' });
  } else {
    row.querySelector('[data-wiz-fact="value"]').value = value;
    row.querySelector('[data-wiz-fact="confirmed"]').checked = true;
  }
  $('#wiz-fact-more').open = true;
  showToast('已加入商品事实「核心卖点」，生成时只会逐字引用这句话');
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
      `<li>${escapeHtml(blockerText(item))}</li>`).join('')}</ul>
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
    errorNode.textContent = `关键项 ${unconfirmedCritical.join('、')} 必须核对后才能继续；不确定的信息请先查商品资料，或改为「暂不提供」。`;
    return;
  }
  const button = $('#wiz-confirm-truth');
  button.disabled = true;
  try {
    const payload = await api.createTruthVersion(state.project.id, {
      base_version: state.project.truth_head_version,
      sku: state.project.sku,
      category: state.category,
      confirm: true,
      facts,
      critical_text: collectCriticalText(),
    });
    state.project.truth_head_version = payload.truth_version.version;
    showToast(`已确认商品事实 v${payload.truth_version.version}`);
    const readiness = await api.readiness(state.project.id);
    const blocked = renderReadiness(readiness);
    saveDraft({ projectId: state.project.id, assetId: state.asset?.id, step: 2 });
    if (!blocked) await enterStep3();
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'CONFIRMATION_BLOCKED') {
      errorNode.innerHTML = `仍有关键项未满足，未生成新版本：<ul class="truth-blockers">${(error.details?.blockers ?? [])
        .map(item => `<li>${escapeHtml(blockerText(item))}</li>`).join('')}</ul>`;
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

// ---------- 第 3 步：用途/方案 + 背景建议；第 4 步：交付与费用 ----------
const BACKGROUND_LABEL = {
  plain_white: '纯白背景',
  scene: '真实场景',
  gradient_studio: '渐变影棚',
  lifestyle: '生活方式',
};
const PURPOSE_LABEL = { listing: '上架主图与详情', advertising: '投放素材', social: '社媒笔记' };
const PURPOSE_REASON = {
  listing: '覆盖主图、卖点、场景与细节，适合首次上架',
  advertising: '方图/竖版/横版三件套，适合信息流与开屏',
  social: '封面与内页，适合内容种草',
};
const backgroundLabel = value => BACKGROUND_LABEL[value] ?? value ?? '未标注';

/** 模板缩略图是排版示意，不是生成结果；用背景方向和文字块位置表达方案差异。 */
function templateArt(item) {
  const background = item.creative_direction?.background ?? 'scene';
  const ratio = item.deliverables?.[0]?.ratio ?? '1:1';
  const tall = ratio === '3:4' || ratio === '9:16';
  const hasCopy = (item.deliverables ?? []).some(deliverable => (deliverable.text_blocks ?? []).length > 0);
  const fill = {
    plain_white: '#ffffff',
    scene: '#e7eee7',
    gradient_studio: '#e8e9f3',
    lifestyle: '#f3ece1',
  }[background] ?? '#eef1ee';
  const stroke = background === 'plain_white' ? '#c9d2c9' : 'transparent';
  return `<svg class="wiz-art" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
    <defs><linearGradient id="g-${escapeHtml(item.id)}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${fill}"/><stop offset="1" stop-color="#ffffff"/>
    </linearGradient></defs>
    <rect x="4" y="4" width="88" height="88" rx="8" fill="url(#g-${escapeHtml(item.id)})" stroke="${stroke}"/>
    ${background === 'scene' ? '<path d="M4 70h88" stroke="#cdd9cd" stroke-width="2"/><circle cx="72" cy="30" r="9" fill="#dbe7db"/>' : ''}
    ${background === 'lifestyle' ? '<rect x="62" y="14" width="18" height="26" rx="3" fill="#e6d8c3"/>' : ''}
    ${background === 'gradient_studio' ? '<circle cx="24" cy="28" r="14" fill="#ffffff88"/>' : ''}
    <rect x="${tall ? 34 : 28}" y="${tall ? 20 : 30}" width="${tall ? 28 : 40}" height="${tall ? 46 : 36}" rx="5" fill="#ffffff" stroke="#93a893"/>
    <rect x="${tall ? 40 : 35}" y="${tall ? 30 : 38}" width="${tall ? 16 : 26}" height="6" rx="2" fill="#b9cdb9"/>
    ${hasCopy ? `<rect x="14" y="${tall ? 74 : 72}" width="42" height="4" rx="2" fill="#5d7a5d"/><rect x="14" y="${tall ? 82 : 80}" width="28" height="4" rx="2" fill="#9bb09b"/>` : ''}
  </svg>`;
}

function templateCard(item, selected) {
  const reason = state.recommendedTemplateId === item.id ? purposeReason(item) : '';
  return `<button type="button" class="wiz-template-card${selected ? ' selected' : ''}" data-wiz-template="${escapeHtml(item.id)}" aria-pressed="${selected ? 'true' : 'false'}">
    ${templateArt(item)}
    <span class="wiz-card-body">
      <b>${escapeHtml(item.name)}${state.recommendedTemplateId === item.id ? '<em class="wiz-recommend">推荐</em>' : ''}</b>
      <small>${escapeHtml(PURPOSE_LABEL[item.purpose] ?? item.purpose ?? '交付方案')} · ${item.deliverable_count ?? (item.deliverables?.length ?? 0)} 项交付</small>
      <small class="wiz-card-bg">背景：${escapeHtml(backgroundLabel(item.creative_direction?.background))}</small>
      ${reason ? `<small class="wiz-card-reason">${escapeHtml(reason)}</small>` : ''}
    </span>
  </button>`;
}

function purposeReason(item) {
  return PURPOSE_REASON[item.purpose] ?? '按当前商品信息可用';
}

/** 推荐规则是确定性的用途规则：优先上架包；不做视觉理解，也不假装已分析图片。 */
function recommendTemplate(templates) {
  if (!templates.length) return '';
  return (templates.find(item => item.purpose === 'listing') ?? templates[0]).id;
}

function visibleTemplates() {
  const filter = state.bgFilter;
  return filter ? state.templates.filter(item => item.creative_direction?.background === filter) : state.templates;
}

function renderTemplates() {
  const list = visibleTemplates();
  const recommended = list.slice(0, 3);
  const rest = list.slice(3);
  $('#wiz-templates').innerHTML = recommended.length
    ? recommended.map(item => templateCard(item, item.id === state.templateId)).join('')
    : '<p class="real-empty">这个背景方向下没有可用方案，已保留原方案；可切回「跟随方案」。</p>';
  $('#wiz-templates-more').innerHTML = rest.map(item => templateCard(item, item.id === state.templateId)).join('');
  $('#wiz-templates-more').closest('details').hidden = rest.length === 0;
  renderBackgroundNote();
  updateToPayButton();
}

function renderBackgroundNote() {
  const note = $('#wiz-bg-note');
  if (!note) return;
  const item = state.templates.find(template => template.id === state.templateId);
  if (!item) { note.textContent = '选一个方案后，这里会显示它的背景方向。'; return; }
  const direction = item.creative_direction ?? {};
  const parts = [
    `背景：${backgroundLabel(direction.background)}`,
    direction.lighting ? `光线：${direction.lighting}` : '',
    direction.camera ? `视角：${direction.camera}` : '',
  ].filter(Boolean);
  note.textContent = `${parts.join(' · ')}。不需要手写背景提示词；主图若受平台纯白要求限制，下方会给出可直接执行的处理。`;
}

function applyTemplateChoice(id) {
  state.templateId = id;
  saveDraft({ templateId: id });
  state.resolutions = {};
  invalidateQuote();
  renderTemplates();
  void refreshPreview();
}

function backgroundFixList(result) {
  const conflicts = [...(result?.payload?.conflicts?.pending ?? []), ...(result?.payload?.conflicts?.unresolvable ?? [])];
  const holder = $('#wiz-bg-fixes');
  if (!holder) return;
  const targets = conflicts.filter(item => (item.options ?? []).length > 0);
  holder.innerHTML = targets.length === 0
    ? '<p class="real-note">当前方案的背景没有被平台规则阻断，不需要额外填写。</p>'
    : targets.map(item => `<div class="wiz-bg-fix"><p>${escapeHtml(item.message)}</p><span class="wiz-bg-fix-actions">
        ${item.options.slice(0, 2).map(option => `<button type="button" class="secondary" data-bg-fix="${escapeHtml(item.key)}" data-bg-fix-option="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`).join('')}
      </span></div>`).join('');
}

async function enterStep3() {
  const errorNode = $('#wiz-plan-error');
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
    applyStep3Preselect(); // 模块03：E1 沿用 spec 快照 / E2·E3 预选风格（仅目录中仍存在的项）
    state.recommendedTemplateId = recommendTemplate(state.templates);
    if (!state.templateId) state.templateId = state.recommendedTemplateId;
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

function updateToPayButton() {
  const button = $('#wiz-to-pay');
  if (!button) return;
  button.disabled = !state.templateId;
}

async function enterStep4() {
  if (!state.templateId) return;
  const errorNode = $('#wiz-generate-error');
  errorNode.textContent = '';
  setStep(4);
  saveDraft({ projectId: state.project?.id, assetId: state.asset?.id, step: 4 });
  renderPaySummary();
  renderPayBlockers();
  updateGenerateButton();
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
  const errorNode = $('#wiz-plan-error');
  errorNode.textContent = '';
  if (!state.project || !state.templateId) { $('#wiz-delivery').innerHTML = ''; $('#wiz-spec-notes').innerHTML = ''; backgroundFixList(null); updateGenerateButton(); return; }
  $('#wiz-delivery').innerHTML = '<p class="truth-hint">正在按当前选择推导交付清单与冲突…</p>';
  try {
    const result = await api.previewSpec(state.project.id, specPayload());
    // 快速切换方案时，旧请求可能后返回；只接受当前模板的结果，避免覆盖新输入
    if (result.payload?.template?.id && result.payload.template.id !== state.templateId) return;
    state.preview = result;
    renderPreview(result);
    backgroundFixList(result);
  } catch (error) {
    state.preview = null;
    $('#wiz-delivery').innerHTML = '';
    backgroundFixList(null);
    if (error instanceof ApiFailure && error.details?.conflicts) {
      $('#wiz-spec-notes').innerHTML = `<section class="wiz-notes"><h4>未处理的冲突</h4><ul class="truth-blockers">${error.details.conflicts
        .map(item => `<li><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</li>`).join('')}</ul></section>`;
    } else {
      $('#wiz-spec-notes').innerHTML = '';
      errorNode.textContent = errorText(error);
    }
  }
  updateGenerateButton();
  if (state.step === 4) { renderPaySummary(); renderPayBlockers(); }
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
      .map(item => `<li>${escapeHtml(blockerText(item))}</li>`).join('')}</ul></section>`}`;
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

// ---------- 第 4 步：交付摘要 + 阻塞修复入口 + 真实费用 ----------
function payFixActions(blocker) {
  switch (blocker.code) {
    case 'NO_CRITICAL_FACT':
    case 'UNCONFIRMED_CRITICAL_FACTS':
    case 'NO_TRUTH_VERSION':
    case 'TRUTH_DRAFT':
    case 'TRUTH_SOURCE_SUPERSEDED':
      return '<button type="button" class="secondary" data-pay-fix="facts">去补商品信息 →</button>';
    case 'NO_ASSETS':
    case 'NO_SUBJECT_ASSET':
    case 'REFERENCE_CONFLICT':
      return '<button type="button" class="secondary" data-pay-fix="workbench">去工作台处理素材 →</button>';
    default:
      return '';
  }
}

function renderPayBlockers() {
  const holder = $('#wiz-pay-blockers');
  if (!holder) return;
  const preview = state.preview;
  if (!preview) {
    holder.innerHTML = '<section class="wiz-notes"><h4>还没有拿到交付清单</h4><p>请先返回方案页确认交付清单；如果一直加载失败，检查服务是否在线后重试。</p><button type="button" class="secondary" data-pay-fix="plan">返回方案重试 →</button></section>';
    return;
  }
  const conflicts = [...preview.payload.conflicts.pending, ...preview.payload.conflicts.unresolvable];
  const blockers = preview.readiness.can_start_production ? [] : preview.readiness.blockers;
  if (blockers.length === 0 && conflicts.length === 0) {
    holder.innerHTML = '<p class="truth-ok">当前配置满足生成前置，没有需要先处理的问题。</p>';
    return;
  }
  holder.innerHTML = `<section class="wiz-notes"><h4>生成前还需要处理 ${blockers.length + conflicts.length} 项</h4>
    <ul class="pay-blockers">
      ${blockers.map(item => `<li><span>${escapeHtml(blockerText(item))}</span>${payFixActions(item)}</li>`).join('')}
      ${conflicts.map(item => `<li><span>${escapeHtml(item.message)}</span>${
        item.options.length === 0
          ? '<span class="pay-noway">平台硬约束没有可接受的处理方式</span>'
          : '<button type="button" class="secondary" data-pay-fix="plan">去方案页处理 →</button>'}</li>`).join('')}
    </ul></section>`;
}

function renderPaySummary() {
  const holder = $('#wiz-pay-summary');
  if (!holder) return;
  const item = state.templates.find(template => template.id === state.templateId);
  const preview = state.preview;
  const payload = preview?.payload;
  const deliverables = payload?.deliverables ?? item?.deliverables ?? [];
  const required = deliverables.filter(deliverable => deliverable.required);
  const optional = deliverables.filter(deliverable => !deliverable.required);
  const imageCount = required.reduce((sum, deliverable) => sum + (Number(deliverable.count) || 1), 0);
  const brandId = $('#wiz-brand')?.value ?? '';
  const brandName = state.brandKits.find(kit => kit.id === brandId)?.name;
  const platform = ($('#wiz-platform')?.value ?? '').trim() || state.project?.platform || '未指定';
  const direction = item?.creative_direction ?? {};
  holder.innerHTML = `<section class="wiz-pay-card">
    <div class="wiz-pay-main">
      <h4>${escapeHtml(item?.name ?? '交付方案')}<span>${escapeHtml(PURPOSE_LABEL[item?.purpose] ?? '')}</span></h4>
      <ul class="wiz-pay-facts">
        <li><b>背景</b><span>${escapeHtml(backgroundLabel(direction.background))}</span></li>
        <li><b>光线</b><span>${escapeHtml(direction.lighting ?? '跟随方案')}</span></li>
        <li><b>交付</b><span>默认制作 ${required.length} 项必需交付，约 ${imageCount} 张图${optional.length ? `；另有 ${optional.length} 项可选` : ''}</span></li>
        <li><b>品牌</b><span>${brandName ? escapeHtml(brandName) : '不使用品牌配方'}</span></li>
        <li><b>平台</b><span>${escapeHtml(platform)}</span></li>
      </ul>
    </div>
    <p class="real-note">可选交付与数量会改变费用：上下方清单勾选/数量调整后会重新取价。费用以服务端报价为准，本页不做估算。</p>
  </section>`;
}

function updateGenerateButton() {
  const button = $('#wiz-generate');
  if (!button) return;
  if (state.phase === 'done') { button.disabled = true; button.textContent = '任务已提交'; return; }
  if (state.phase !== 'idle') { button.disabled = true; return; } // 文案由调用方给出
  if (!state.templateId) { button.disabled = true; button.textContent = '生成'; return; }
  const blocked = generateBlocked();
  button.disabled = blocked;
  if (blocked) {
    const preview = state.preview;
    const count = preview
      ? preview.payload.conflicts.pending.length + preview.payload.conflicts.unresolvable.length
        + (preview.readiness.can_start_production ? 0 : preview.readiness.blockers.length)
      : 0;
    button.textContent = preview ? `先处理上方 ${count} 项` : '正在加载交付清单…';
    return;
  }
  button.textContent = state.quote
    ? `确认生成 · 最多 ${state.quote.max_credits} 点`
    : '获取真实报价';
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

// ---------- 提交后的同上下文追踪：只显示服务端状态 ----------
const RUN_STATUS_TEXT = {
  queued: '排队中', running: '生成中', evaluating: '质检中',
  awaiting_confirmation: '待确认额度', completed: '已完成',
  limit_reached: '已达重试上限', failed: '失败', cancelled: '已取消',
};
const RUN_TERMINAL = new Set(['completed', 'limit_reached', 'failed', 'cancelled']);
const RUN_EVENT_TEXT = {
  budget_reserved: '预留额度', queued: '进入队列', generation: '生成',
  hard_check: '硬校验', revision: '修订', settled: '结算', cancelled: '取消',
};

function stopRunTracking() {
  if (state.runSource) { state.runSource.close(); state.runSource = null; }
  if (state.runPoll) { clearInterval(state.runPoll); state.runPoll = null; }
}

function renderRunTracking(run) {
  const status = run.status ?? 'queued';
  const budget = run.budget ?? {};
  const deliverables = run.deliverables ?? [];
  const statusNode = $('#wiz-run-status');
  statusNode.textContent = RUN_STATUS_TEXT[status] ?? status;
  statusNode.className = `run-status ${status}`;
  const terminal = RUN_TERMINAL.has(status);
  $('#wiz-done-note').textContent = run.id
    ? `任务 ${run.id}${run.terminal_reason ? ` · 结束原因：${run.terminal_reason}` : ''}`
    : '任务已提交，正在读取任务编号。';
  $('#wiz-run-deliverables').innerHTML = deliverables.length === 0
    ? '<li class="real-empty">交付清单尚未返回，稍后刷新可见。</li>'
    : deliverables.map(item => `<li>
        <b>${escapeHtml(item.label ?? item.deliverable_id ?? '交付项')}</b>
        <span class="run-chip ${escapeHtml(item.status ?? 'pending')}">${escapeHtml(item.status ?? 'pending')}</span>
        ${item.credits ? `<span>${escapeHtml(String(item.credits))} 额度</span>` : ''}
      </li>`).join('');
  $('#wiz-run-budget').textContent = budget.reserved_credits === undefined
    ? '额度以账面记录为准，正在读取…'
    : `本任务额度：预留 ${budget.reserved_credits ?? 0} · 已结算 ${budget.captured_credits ?? 0} · 已释放 ${budget.released_credits ?? 0}`;
  const cancel = $('#wiz-run-cancel');
  cancel.hidden = terminal || run.cancel_requested === true;
  cancel.disabled = terminal || run.cancel_requested === true;
  const refresh = $('#wiz-run-refresh');
  refresh.hidden = terminal;
  if (terminal) {
    $('#wiz-run-note').textContent = status === 'completed'
      ? '任务已完成，可前往工作台逐张查看、修改与下载。未发生部分已按账本释放。'
      : `任务已结束（${RUN_STATUS_TEXT[status] ?? status}），可在工作台查看原因并决定是否重试；重试会重新取价。`;
  }
}

async function refreshRunState() {
  if (!state.runId) return;
  try {
    const result = await api.getRun(state.runId);
    state.run = result.run;
    renderRunTracking(result.run);
  } catch (error) {
    // 网络或服务超时只说明“状态待确认”，不能直接判定任务失败
    $('#wiz-run-note').textContent = `暂时取不到最新状态（${errorText(error)}）。这不代表任务失败，可点「立即刷新状态」重试。`;
  }
}

function startRunTracking(runId) {
  stopRunTracking();
  if (!runId) return;
  state.runId = runId;
  try {
    state.runSource = api.runEvents(runId);
    state.runSource.addEventListener('message', event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload.sequence !== 'number') return;
      if (payload.sequence <= state.lastRunEventId) return;
      state.lastRunEventId = payload.sequence;
      const timeline = $('#wiz-run-note');
      const stage = RUN_EVENT_TEXT[payload.stage] ?? payload.stage ?? '';
      timeline.textContent = `最新事件 #${payload.sequence} · ${stage} · ${payload.status ?? ''} · ${formatTime(payload.timestamp)}；状态来自服务端，不推算百分比。`;
      void refreshRunState();
    });
    state.runSource.addEventListener('error', () => {
      // SSE 断开不代表任务失败，退化为轮询；轮询同样只读
      if (state.runSource) { state.runSource.close(); state.runSource = null; }
      if (!state.runPoll) state.runPoll = setInterval(() => void refreshRunState(), 8000);
    });
  } catch {
    state.runPoll = setInterval(() => void refreshRunState(), 8000);
  }
  // 首帧用创建返回的状态，随后立刻拉一次完整状态（含交付项与账本）
  void refreshRunState();
}

async function cancelTrackedRun() {
  if (!state.runId) return;
  const button = $('#wiz-run-cancel');
  button.disabled = true;
  button.textContent = '正在请求取消…';
  try {
    const result = await api.cancelRun(state.runId, { reason: 'user_cancelled' });
    renderRunTracking(result.run);
    showToast('已请求取消；未发生的部分按账本释放，已发生的部分按实际结算');
  } catch (error) {
    showToast(`取消失败：${errorText(error)}`);
  } finally {
    button.textContent = '取消任务';
    button.disabled = false;
  }
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
      renderRunTracking(run);
      $('#wiz-done').hidden = false;
      updateGenerateButton();
      showToast(`任务已提交（${run.id ?? '—'}），进度显示在本页`);
      startRunTracking(run.id);
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
  state.bgFilter = '';
  state.recommendedTemplateId = '';
  state.entryKind = '';
  state.styleTemplateId = '';
  state.styleBrandKitId = '';
  state.reuseSpec = null;
  state.phase = 'idle';
  stopRunTracking();
  state.runId = '';
  state.run = null;
  state.lastRunEventId = 0;
  state.idempotencyKey = newIdempotencyKey(); // 每次打开向导重新生成幂等键
  resetStep1();
  $('#wiz-name').value = '';
  $('#wiz-name').disabled = false;
  $('#wiz-facts').innerHTML = '';
  $('#wiz-fact-cards').innerHTML = '';
  state.factCards = [];
  state.category = '其他';
  state.sellingPoints = '';
  state.sellingResults = [];
  $('#wiz-selling-points').value = '';
  $('#wiz-sell-results').innerHTML = '';
  $('#wiz-sell-note').textContent = '';
  $('#wiz-critical-text').value = '';
  $('#wiz-category').value = '其他';
  $('#wiz-platform').value = '';
  $('#wiz-brand').innerHTML = '<option value="">不使用品牌套件</option>';
  $('#wiz-custom-layout').checked = false;
  $('#wiz-delivery').innerHTML = '';
  $('#wiz-spec-notes').innerHTML = '';
  $('#wiz-plan-error').textContent = '';
  $('#wiz-pay-summary').innerHTML = '';
  $('#wiz-pay-blockers').innerHTML = '';
  $('#wiz-bg-fixes').innerHTML = '';
  $('#wiz-bg-note').textContent = '正在读取方案的背景方向…';
  for (const item of $$('#wiz-bg-filter [data-bg-filter]')) item.classList.toggle('selected', item.dataset.bgFilter === '');
  $('#wiz-to-pay').disabled = true;
  $('#wiz-quote').hidden = true;
  $('#wiz-quote').innerHTML = '';
  $('#wiz-done').hidden = true;
  $('#wiz-done-note').textContent = '';
  $('#wiz-run-deliverables').innerHTML = '';
  $('#wiz-run-budget').textContent = '';
  $('#wiz-run-status').textContent = '排队中';
  $('#wiz-run-status').className = 'run-status queued';
  $('#wiz-reuse').hidden = true;
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
    const step = Math.min(Math.max(Number(draft.step) || 1, 1), 4);
    if (step >= 3) {
      // 恢复上次选择：模板/品牌只在目录仍存在时预选，失效项由 applyStep3Preselect 明确回落
      state.styleTemplateId = draft.templateId ?? '';
      state.styleBrandKitId = draft.brandKitId ?? '';
      if (draft.platform) $('#wiz-platform').value = draft.platform;
      await enterStep3();
      if (step >= 4) await enterStep4();
    } else if (step === 2) await enterStep2();
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
  $('#wiz-retry-upload')?.addEventListener('click', () => void startUpload(false));
  $('#wiz-retry-replace')?.addEventListener('click', () => void startUpload(true));
  $('#wiz-retry-change')?.addEventListener('click', () => { fileInput?.click(); });
  $('#wiz-next-1')?.addEventListener('click', () => void enterStep2());
  $('#wiz-add-fact')?.addEventListener('click', () => addFactRow({}));
  $('#wiz-category')?.addEventListener('change', () => {
    // 切换商品类型只换问题清单，已填过的同名信息保留（确认状态一并保留，仍需用户点确认）
    const keep = state.factCards.filter(card => String(card.value ?? '').trim()).map(card => ({
      key: card.key, value: card.value, confirmed: card.confirmed, note: card.note,
    }));
    state.category = pickCategory($('#wiz-category').value);
    renderFactCards(keep);
  });
  $('#wiz-fact-cards')?.addEventListener('input', event => {
    const input = event.target.closest('[data-card-value]');
    if (!input) return;
    const node = input.closest('[data-card-index]');
    const card = state.factCards[Number(node.dataset.cardIndex)];
    if (input.value !== card.value) { card.confirmed = false; card.skipped = false; }
    card.value = input.value;
    updateCardStatus(node, card);
  });
  $('#wiz-fact-cards')?.addEventListener('click', event => {
    const node = event.target.closest('[data-card-index]');
    if (!node) return;
    const card = state.factCards[Number(node.dataset.cardIndex)];
    if (event.target.closest('[data-card-confirm]')) {
      const input = node.querySelector('[data-card-value]');
      const value = input.value.trim();
      if (!value) {
        showToast(`先填写「${card.key}」，例如 ${card.example}`);
        input.focus();
        return;
      }
      card.value = value;
      card.confirmed = true;
      card.skipped = false;
      updateCardStatus(node, card);
      return;
    }
    if (event.target.closest('[data-card-skip]')) {
      card.skipped = !card.skipped;
      // 「暂不提供」是明确的未确认状态，不允许沿用旧的确认结果
      if (card.skipped) card.confirmed = false;
      updateCardStatus(node, card);
      if (card.skipped && card.critical) {
        showToast(`「${card.key}」是关键信息：暂不提供将无法确认商品信息，可以先去商品资料查一下`);
      }
    }
  });
  $('#wiz-selling-points')?.addEventListener('input', () => { state.sellingPoints = $('#wiz-selling-points').value; });
  $('#wiz-sell-analyze')?.addEventListener('click', analyzeSelling);
  $('#wiz-sell-results')?.addEventListener('click', event => {
    const node = event.target.closest('[data-sell-index]');
    if (!node) return;
    const item = state.sellingResults[Number(node.dataset.sellIndex)];
    if (!item) return;
    if (event.target.closest('[data-sell-add]')) { addSellingFact(item.text); return; }
    if (event.target.closest('[data-sell-add-rewrite]')) {
      if (!item.rewrite) { showToast('这句去掉功效词后没有可用的表达，请换一种写法'); return; }
      addSellingFact(item.rewrite);
      return;
    }
    if (event.target.closest('[data-sell-fix]')) {
      $('#wiz-fact-cards').scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast('先核对上方商品信息，再回来重新生成卖点候选');
      return;
    }
    if (event.target.closest('[data-sell-copy]')) void copyText(item.text);
  });
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
    if (target === 4 && state.step === 3) { void enterStep4(); return; }
    if (target === 2 && state.step >= 3) { setStep(2); return; }
    setStep(target);
  }));
  $('#wiz-exit')?.addEventListener('click', () => { location.hash = 'projects'; });
  $('#wiz-brand')?.addEventListener('change', () => {
    state.brandKitId = $('#wiz-brand').value;
    saveDraft({ brandKitId: state.brandKitId });
    state.resolutions = {}; invalidateQuote(); void refreshPreview();
  });
  $('#wiz-platform')?.addEventListener('change', () => {
    saveDraft({ platform: $('#wiz-platform').value.trim() });
    state.resolutions = {}; invalidateQuote(); void refreshPreview();
  });
  for (const id of ['wiz-custom-layout', 'wiz-text-x', 'wiz-text-y', 'wiz-text-width', 'wiz-text-size']) {
    document.getElementById(id)?.addEventListener('change', () => { invalidateQuote(); void refreshPreview(); });
  }
  $('#wiz-templates')?.addEventListener('click', event => {
    const card = event.target.closest('[data-wiz-template]');
    if (!card) return;
    applyTemplateChoice(card.dataset.wizTemplate);
  });
  $('#wiz-templates-more')?.addEventListener('click', event => {
    const card = event.target.closest('[data-wiz-template]');
    if (!card) return;
    applyTemplateChoice(card.dataset.wizTemplate);
  });
  $('#wiz-bg-filter')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-bg-filter]');
    if (!chip) return;
    state.bgFilter = chip.dataset.bgFilter ?? '';
    for (const item of $$('#wiz-bg-filter [data-bg-filter]')) item.classList.toggle('selected', item === chip);
    const list = visibleTemplates();
    // 背景偏好只影响可选方案；当前方案不匹配时切到该背景下的推荐方案
    if (state.templateId && !list.some(item => item.id === state.templateId)) {
      const next = list.find(item => item.id === state.recommendedTemplateId) ?? list[0];
      if (next) { applyTemplateChoice(next.id); return; }
    }
    renderTemplates();
  });
  $('#wiz-bg-fixes')?.addEventListener('click', event => {
    const button = event.target.closest('[data-bg-fix]');
    if (!button) return;
    state.resolutions[button.dataset.bgFix] = button.dataset.bgFixOption;
    invalidateQuote();
    showToast('已按你的选择处理该规则冲突，正在刷新清单');
    void refreshPreview();
  });
  $('#wiz-to-pay')?.addEventListener('click', () => void enterStep4());
  $('#wiz-back-4')?.addEventListener('click', () => setStep(3));
  $('#wiz-pay-blockers')?.addEventListener('click', event => {
    const button = event.target.closest('[data-pay-fix]');
    if (!button) return;
    if (button.dataset.payFix === 'facts') { setStep(2); return; }
    if (button.dataset.payFix === 'plan') { setStep(3); return; }
    if (button.dataset.payFix === 'workbench' && state.project) {
      window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: state.project.id } }));
    }
  });
  $('#wiz-spec-notes')?.addEventListener('change', event => {
    const select = event.target.closest('[data-wiz-conflict]');
    if (!select) return;
    state.resolutions[select.dataset.wizConflict] = select.value;
    invalidateQuote();
    void refreshPreview();
  });
  $('#wiz-generate')?.addEventListener('click', () => void onGenerate());
  $('#wiz-run-refresh')?.addEventListener('click', () => void refreshRunState());
  $('#wiz-run-cancel')?.addEventListener('click', () => void cancelTrackedRun());
  $('#wiz-open-workbench')?.addEventListener('click', () => {
    if (state.project) {
      // 带上本次任务，工作台直接定位到该任务的结果、修改与下载
      window.dispatchEvent(new CustomEvent('qb:open-workbench', {
        detail: { projectId: state.project.id, runId: state.runId || undefined },
      }));
    }
  });
  $('#wiz-subject-link')?.addEventListener('click', () => {
    if (!state.project) return;
    showToast('主体框修正请在该项目工作台的「商品事实」里完成；此入口不重复实现');
    window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: state.project.id } }));
  });
  $('#wiz-resume-continue')?.addEventListener('click', () => void continueDraft());
  $('#wiz-resume-restart')?.addEventListener('click', () => { clearDraft(); resetForEntry(); });
  // 模块03 E1：修改任一事实行内容（名称/值/来源）时自动取消该行「已确认」——
  // 不能带着旧确认状态修改内容；关键项未确认由「确认并继续」的现有校验拦截
  const dropFactConfirmation = event => {
    const field = event.target.closest('[data-wiz-fact]');
    if (!field || field.dataset.wizFact === 'confirmed' || field.dataset.wizFact === 'critical') return;
    const confirmed = field.closest('.fact-row')?.querySelector('[data-wiz-fact="confirmed"]');
    if (confirmed?.checked) confirmed.checked = false;
  };
  $('#wiz-facts')?.addEventListener('input', dropFactConfirmation);
  $('#wiz-facts')?.addEventListener('change', dropFactConfirmation);
  // 模块03：复用入口事件（再做一套 / 用此风格制作新品 / 品牌用于新项目）统一从这里进向导
  window.addEventListener('qb:open-wizard', event => requestEntry(event.detail ?? {}));
  // 每次进入 create 视图都回到第 1 步并重新生成幂等键；服务端草稿通过「继续上次」恢复。
  // 重置完成后若有待应用的 qb:open-wizard 复用请求（E1/E2/E3），再应用预填与沿用摘要
  document.addEventListener('qb:view-change', event => {
    if (event.detail?.view === 'create') { resetForEntry(); applyEntry(); }
    else state.entry = null; // 用户中途改去其它视图时丢弃未消费的复用请求
  });
  // 直接打开 #create（或刷新）时 app.js 的首次路由事件早于本模块注册，
  // 这里补一次初始化，否则幂等键等入口状态会保持空值。
  if (location.hash === '#create') { resetForEntry(); applyEntry(); }
}

if (typeof document !== 'undefined') initWizard();
