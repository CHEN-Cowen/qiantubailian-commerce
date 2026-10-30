/**
 * 首页（新用户引导 + 工作首页）交互。
 *
 * 边界：
 * - 四步演示全部在内存里完成，不调用生成模型、不扣额度、不上传文件、
 *   不写真实商品，也不生成假的下载包。
 * - 未登录时的「更新 / 首次制作」入口只记录意图并打开登录闸口，登录后继续；
 *   没有商品时给出建立商品档案的入口，不把用户丢进空白页。
 * - 首页数字与交付状态由 real-data.js 从当前账户的真实数据渲染。
 */
import { api, ApiFailure } from './api.js';
import { openAuthGate } from './auth.js';
import { openTruthDialog, refreshProjects } from './real-data.js';

const INTENT_KEY = 'qtb:home-intent';
const INTENT_TTL_MS = 6 * 60 * 60 * 1000;
const DEMO_STEP_LABELS = ['确认变化', '查看影响', '按需处理', '复核交付'];

const DEMO_DATA = [
  {
    spec: '50g × 1 支',
    version: '当前图片 · v1',
    change: '这次商品变化：单支装 → 双支装，净含量 50g × 2 支。',
    rows: [['商品主图', '当前选用'], ['规格说明图', '引用：50g × 1'], ['品牌氛围图', '未引用规格']],
    note: '先看清变化，再决定怎么改',
    next: '① 模拟确认新规格 →',
  },
  {
    spec: '<s>50g × 1</s>50g × 2 支',
    version: '商品资料已更新 · 图片待处理',
    change: '发现 3 张关联图片待处理，1 张品牌氛围图不受影响。',
    rows: [['规格说明图', '免费改字'], ['包装清单图', '免费重排'], ['商品主图', '需补双支实拍'], ['品牌氛围图', '保留当前版本']],
    note: '免费排版 0 点 · 当前不调用生图',
    next: '② 查看处理方式 →',
  },
  {
    spec: '50g × 2 支',
    version: '处理预览 · 等待人工复核',
    change: '说明图已按新规格排版。主图仍待补实拍，不会只换字放行。',
    rows: [['规格说明图 v2', '已重排 · 待复核'], ['包装清单图 v2', '已重排 · 待复核'], ['商品主图', '待补实拍 · 未完成'], ['品牌氛围图', '原版本保留']],
    note: '真实照片不能由文字修改代替',
    next: '③ 模拟补拍并复核 →',
  },
  {
    spec: '50g × 2 支',
    version: '演示：补拍及人工复核已完成',
    change: '本步假设商家已补双支实拍并复核。可整理 3 张更新图片与替换清单。',
    rows: [['规格说明图 v2', '演示已复核'], ['包装清单图 v2', '演示已复核'], ['双支装商品主图', '演示已复核'], ['店铺图片', '需你手动替换']],
    note: '图形仅为示意，不代表 AI 生图效果',
    next: '查看演示更新包 ↗',
  },
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const demo = { step: 0 };

const bottle = () => '<div class="hp-bottle"><div class="hp-label">QINGHE<br>植萃护手霜<br>50g</div></div>';

const warnRow = value => /实拍|未完成|手动替换/.test(String(value));

function renderDemo(index) {
  const steps = $('#hp-steps');
  if (!steps) return;
  demo.step = index;
  const data = DEMO_DATA[index];
  steps.innerHTML = DEMO_STEP_LABELS.map((label, i) => `
    <button type="button" class="hp-step${i === index ? ' active' : ''}" data-demo-step="${i}" aria-pressed="${i === index}">${i + 1}. ${label}</button>`).join('');
  const pack = $('#hp-pack');
  if (pack) pack.innerHTML = bottle() + (index === 3 ? bottle() : '');
  const spec = $('#hp-spec');
  if (spec) spec.innerHTML = data.spec;
  const version = $('#hp-version');
  if (version) version.textContent = data.version;
  const change = $('#hp-change');
  if (change) change.textContent = data.change;
  const results = $('#hp-results');
  if (results) results.innerHTML = data.rows.map(([name, value]) => `
    <div class="hp-result">
      <span><i class="hp-result-dot${warnRow(value) ? ' is-warn' : ''}"></i>${escapeHtml(name)}</span>
      <span>${escapeHtml(value)}</span>
    </div>`).join('');
  const note = $('#hp-note');
  if (note) note.textContent = data.note;
  const next = $('#hp-next');
  if (next) next.textContent = data.next;
}

let dialogAction = null;

function showDialog({ kicker, title, body, note = '', actionText = '', onAction = null }) {
  const dialog = $('#hp-dialog');
  if (!dialog) return;
  const kickerNode = $('#hp-dialog-kicker');
  if (kickerNode) kickerNode.textContent = kicker;
  const titleNode = $('#hp-dialog-title');
  if (titleNode) titleNode.textContent = title;
  const bodyNode = $('#hp-dialog-body');
  if (bodyNode) bodyNode.innerHTML = body;
  const noteNode = $('#hp-dialog-note');
  if (noteNode) { noteNode.textContent = note; noteNode.hidden = !note; }
  const action = $('#hp-dialog-action');
  if (action) { action.hidden = !actionText; action.textContent = actionText; }
  dialogAction = onAction;
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  const dialog = $('#hp-dialog');
  if (dialog?.open) dialog.close();
  dialogAction = null;
}

function openDemoPackage() {
  showDialog({
    kicker: '示例演示',
    title: '演示更新包',
    body: '<p>包含：规格说明图 v2、包装清单图 v2、双支装商品主图，以及手动替换清单。</p><p>此处不生成真实下载包；全部状态仅用于解释首页视觉与流程，不调用生图模型、不扣额度、不写入真实商品。</p>',
    note: '受影响图始终 3 张，不受影响的品牌氛围图保留 1 张；主图未补实拍时不会显示完成。',
    actionText: '重新演示',
    onAction: () => { renderDemo(0); closeDialog(); },
  });
}

function showQuestionScene() {
  showDialog({
    kicker: '示例演示',
    title: '补一张说明图',
    body: '<p>演示场景：买家问「双支装是否含礼袋？」</p><p>已确认资料中没有礼袋信息 → 先补充包含物资料，确认后再制作清单图。</p><p>不会自动编造答案，也不会替你推测尺寸或适配结论。</p>',
    note: '示例说明 · 不读取真实商品，也不会生成图片。',
  });
}

function scrollToDemo() {
  const node = $('#hp-demo');
  node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- 入口意图：未登录先登录，登录后继续 ---------- */
function storeIntent(kind) {
  try { sessionStorage.setItem(INTENT_KEY, JSON.stringify({ kind, at: Date.now() })); } catch { /* 存储不可用时仍可登录，只是不保留意图 */ }
}

function takeIntent() {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(INTENT_KEY);
    const parsed = JSON.parse(raw);
    if (!['update', 'create'].includes(parsed?.kind)) return null;
    if (Date.now() - Number(parsed.at ?? 0) > INTENT_TTL_MS) return null;
    return parsed.kind;
  } catch { return null; }
}

function navigate(view) {
  window.dispatchEvent(new CustomEvent('qb:navigate', { detail: { view } }));
}

function isAuthFailure(error) {
  return error instanceof ApiFailure && error.status === 401;
}

function errorText(error) {
  if (error instanceof ApiFailure) return error.message;
  return '无法连接本地服务，请确认服务已启动后重试';
}

async function openProjectPicker() {
  showDialog({
    kicker: '更新已有商品图',
    title: '选择要更新的商品',
    body: '<p>正在读取你的商品…</p>',
    note: '选择后进入商品事实的「变更」区块，查看受影响的图片；没有商品时可以先建立商品档案。',
    actionText: '建立商品档案',
    onAction: () => { closeDialog(); navigate('create'); },
  });
  try {
    const payload = await api.listProjects();
    const projects = payload?.projects ?? [];
    const body = $('#hp-dialog-body');
    if (!body) return;
    if (projects.length === 0) {
      body.innerHTML = `<div class="empty-state">
        <h3>还没有商品</h3>
        <p>先建立商品资料并关联图片，才能查看变更影响。建立后可上传素材、确认商品事实，再回来更新。</p>
        <div class="state-actions"><button type="button" data-home-create>建立商品档案</button></div>
      </div>`;
      return;
    }
    body.innerHTML = `<div class="hp-project-list">${projects.map(project => `
      <button type="button" class="hp-project-item" data-hp-project="${escapeHtml(project.id)}">
        <span>
          <b>${escapeHtml(project.name)}</b>
          <small>${escapeHtml(project.sku ?? 'SKU 未记录')} · 更新于 ${escapeHtml(project.updated_at ?? project.created_at ?? '—')}</small>
        </span>
        <span>查看变更 →</span>
      </button>`).join('')}</div>`;
  } catch (error) {
    if (isAuthFailure(error)) {
      closeDialog();
      openAuthGate({ demoHint: '登录后会继续你刚才选择的「更新商品图」。' });
      return;
    }
    const body = $('#hp-dialog-body');
    if (body) {
      body.innerHTML = `<div class="empty-state">
        <h3>读取商品失败</h3>
        <p>${escapeHtml(errorText(error))}</p>
        <div class="state-actions"><button type="button" data-hp-retry-projects>重试</button></div>
      </div>`;
    }
  }
}

function startEntry(kind) {
  const auth = window.__qtbAuthState ?? {};
  if (!auth.authenticated && !auth.demoMode) {
    storeIntent(kind);
    openAuthGate({
      demoHint: kind === 'update'
        ? '登录后会继续你刚才选择的「更新商品图」。'
        : '登录后会继续你刚才选择的「首次制作商品图」。',
    });
    return;
  }
  if (kind === 'update') void openProjectPicker();
  else navigate('create');
}

/* ---------- 登录状态 ---------- */
function navigateHome() {
  if (location.hash && location.hash !== '#home') history.replaceState(null, '', '#home');
  navigate('home');
}

function applyAuth(auth) {
  const authenticated = Boolean(auth?.authenticated);
  document.body.classList.remove('auth-pending');
  document.body.classList.toggle('is-guest', !authenticated);
  const loading = $('#home-loading');
  if (loading) loading.hidden = true;
  const guest = $('#guest-home');
  if (guest) guest.hidden = authenticated;
  const work = $('#work-home');
  if (work) work.hidden = !authenticated;
  if (!authenticated) navigateHome();
}

async function boot() {
  const auth = await (window.__qtbAuthStateReady ?? Promise.resolve(window.__qtbAuthState ?? {}));
  applyAuth(auth);
  if (!auth?.authenticated) return;
  const intent = takeIntent();
  if (intent === 'update') void openProjectPicker();
  if (intent === 'create') navigate('create');
}

/* ---------- 交互接线 ---------- */
function bind() {
  $('#hp-steps')?.addEventListener('click', event => {
    const button = event.target.closest('[data-demo-step]');
    if (button) renderDemo(Number(button.dataset.demoStep));
  });
  $('#hp-next')?.addEventListener('click', () => {
    if (demo.step < DEMO_DATA.length - 1) renderDemo(demo.step + 1);
    else openDemoPackage();
  });
  $('#hp-update')?.addEventListener('click', () => startEntry('update'));
  $('#hp-create')?.addEventListener('click', () => startEntry('create'));
  $('#hp-cta-update')?.addEventListener('click', () => startEntry('update'));
  $('#hp-login')?.addEventListener('click', () => openAuthGate());
  $('#hp-footer-login')?.addEventListener('click', () => openAuthGate());
  $('#work-new-project')?.addEventListener('click', () => startEntry('create'));

  $('[data-hp-scene="impact"]')?.addEventListener('click', () => { renderDemo(1); scrollToDemo(); });
  $('[data-hp-scene="compare"]')?.addEventListener('click', () => { renderDemo(2); scrollToDemo(); });
  $('[data-hp-scene="question"]')?.addEventListener('click', showQuestionScene);

  $$('[data-hp-scroll]').forEach(button => button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.hpScroll);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const menu = $('#hp-mobile-menu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $('#hp-menu-toggle')?.setAttribute('aria-expanded', 'false');
    }
  }));

  const menuToggle = $('#hp-menu-toggle');
  const menu = $('#hp-mobile-menu');
  menuToggle?.addEventListener('click', () => {
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    menuToggle.setAttribute('aria-expanded', String(willOpen));
  });
  document.addEventListener('click', event => {
    if (!menu || menu.hidden) return;
    if (menu.contains(event.target) || menuToggle?.contains(event.target)) return;
    menu.hidden = true;
    menuToggle?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu && !menu.hidden) {
      menu.hidden = true;
      menuToggle?.setAttribute('aria-expanded', 'false');
    }
  });

  $$('[data-work-scroll]').forEach(button => button.addEventListener('click', () => {
    document.getElementById(button.dataset.workScroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  const dialog = $('#hp-dialog');
  dialog?.addEventListener('click', event => {
    if (event.target.closest('[data-hp-close]')) { closeDialog(); return; }
    const retry = event.target.closest('[data-hp-retry-projects]');
    if (retry) { void openProjectPicker(); return; }
    const item = event.target.closest('[data-hp-project]');
    if (item) {
      const projectId = item.dataset.hpProject;
      closeDialog();
      if (projectId) void openTruthDialog(projectId, { section: 'change-section' });
    }
  });
  $('#hp-dialog-action')?.addEventListener('click', () => {
    const action = dialogAction;
    dialogAction = null;
    if (typeof action === 'function') action();
  });

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-home-create], [data-home-projects], [data-home-assets], [data-retry-home], [data-home-login]');
    if (!target) return;
    if (target.matches('[data-home-create]')) navigate('create');
    if (target.matches('[data-home-projects]')) navigate('projects');
    if (target.matches('[data-home-assets]')) navigate('assets');
    if (target.matches('[data-retry-home]')) void refreshProjects();
    if (target.matches('[data-home-login]')) openAuthGate();
  });
}

if (typeof document !== 'undefined') {
  bind();
  renderDemo(0);
  void boot();
}
