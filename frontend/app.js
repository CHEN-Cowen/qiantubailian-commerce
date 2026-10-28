import { initRealData } from './real-data.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = { view: 'home', drawer: false, selectedAsset: 'scene', previousFocus: null };

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 3000);
}

function setView(view) {
  state.view = view;
  $$('.view').forEach(panel => {
    const match = panel.dataset.viewPanel === view;
    panel.classList.toggle('active', match);
    panel.hidden = !match;
  });
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#project-view').classList.remove('active');
  if (location.hash !== '#' + view) location.hash = view;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // R06：派发 view-change 事件，让模块（m04/workbench 等）收到视图切换通知
  window.dispatchEvent(new CustomEvent('qb:view-change', { detail: { view } }));
}

function openProject(project = 'skin') {
  // R06 起旧演示项目详情页已下线，这里只做引导，不再切换视图（否则会落到空白页）
  if (project !== 'skin') {
    toast('演示项目不接入真实商品事实与生产闸口；请在「商品项目」页创建真实项目并确认事实');
    return;
  }
  toast('示例项目仅作演示；请在「商品项目」中选择真实项目进入工作台');
}

function activateProject(event) {
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
  if (event.type === 'keydown') event.preventDefault();
  openProject(event.currentTarget.dataset.openProject);
}

function closeProject() { setView('projects'); }

function openDrawer() {
  state.previousFocus = document.activeElement;
  $('.app-shell').inert = true;
  state.drawer = true;
  const drawer = $('#professional-drawer');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.classList.add('open');
  document.body.classList.add('drawer-open');
  $('button[data-close-drawer]').focus();
}

function closeDrawer() {
  state.drawer = false;
  const drawer = $('#professional-drawer');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.classList.remove('open');
  document.body.classList.remove('drawer-open');
  $('.app-shell').inert = false;
  state.previousFocus?.focus();
}

function showHelp() { $('#help-dialog').showModal(); }

$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-open-project]').forEach(card => {
  card.addEventListener('click', activateProject);
  card.addEventListener('keydown', activateProject);
});
$('#quick-start').addEventListener('click', () => document.querySelector('#import-button')?.click());
$('#background-task').addEventListener('click', () => toast('此为演示入口；请在「商品项目」中打开真实项目使用仅换背景'));
$('#back-home').addEventListener('click', closeProject);
$('#start-generation').addEventListener('click', startWizard);
$('#project-settings').addEventListener('click', () => toast('此页为演示项目，不会保存；真实项目请在「商品项目」页打开'));
$('#professional-button').addEventListener('click', openDrawer);
$('#drawer-button').addEventListener('click', openDrawer);
$('#help-button').addEventListener('click', showHelp);
$('#data-note-button').addEventListener('click', showHelp);
$('#data-note-button').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showHelp(); } });
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
$('#help-ok').addEventListener('click', () => $('#help-dialog').close());
$$('[data-close-drawer]').forEach(button => button.addEventListener('click', closeDrawer));

$$('.asset-card').forEach(card => card.addEventListener('click', () => {
  $$('.asset-card').forEach(item => item.classList.remove('selected'));
  card.classList.add('selected');
  state.selectedAsset = card.dataset.asset;
  showAsset(card.dataset.asset);
}));

$$('.drawer-tabs button').forEach(button => button.addEventListener('click', () => {
  $$('.drawer-tabs button').forEach(item => item.classList.remove('selected'));
  button.classList.add('selected');
  if (button.textContent === 'Prompt') toast('演示数据，仅供查看');
  if (button.textContent === '模型参数') toast('演示数据，仅供查看');
}));

$('#sort-assets').addEventListener('click', () => toast('已按最近更新时间排序'));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.drawer) closeDrawer(); });

let flowStep = 0;
let flowMode = 'wizard';
const flow = $('#flow-dialog');
const flowContent = $('#flow-content');
const steps = [
  ['选择示例素材', '<p>使用虚构面霜的包装示意。没有上传、读取或保存真实文件。</p><label><input id="flow-confirm" type="checkbox"> 使用演示商品素材</label>'],
  ['确认商品事实', '<p>月光舒缓面霜 · 50g · 象牙白。商品与功效均为虚构，不能用于发布。</p><label><input id="flow-confirm" type="checkbox"> 已核对演示事实</label>'],
  ['选择目标', '<label>平台目标 <select id="flow-platform"><option>通用电商（模拟规则）</option><option>品牌展示（模拟规则）</option></select></label><p>品牌：月光示例品牌 · 浅色自然风格；未读取真实平台规则。</p>'],
  ['清单与模拟报价', '<p>1 张主图 + 2 张卖点图 + 2 张场景图。</p><p>演示预算：8 额度；不预留、不扣费。</p><label><input id="flow-confirm" type="checkbox"> 确认仅运行模拟任务</label>'],
  ['执行情景', '<p>选择确定性的模拟结果，验证成功和失败状态。</p><label>模拟结果 <select id="flow-outcome"><option value="success">成功</option><option value="failure">失败（可重试）</option></select></label>'],
  ['模拟结果', '<p>生成完成（模拟）。3 张通过、1 张待复核、1 张阻断；均不具备真实发布资格。</p><p>可进入工作台查看演示素材与 QA，不提供正式导出。</p>'],
];
function renderFlow() {
  $('#flow-title').textContent = `新品上架包 · ${flowStep + 1}/6 · ${steps[flowStep][0]}`;
  flowContent.innerHTML = steps[flowStep][1];
  $('#flow-error').textContent = '';
  $('#flow-back').hidden = flowStep === 0;
  $('#flow-next').hidden = false;
  $('#flow-next').textContent = flowStep === 5 ? '进入演示工作台' : flowStep === 4 ? '运行模拟' : '下一步';
}
function startWizard() {
  flowMode = 'wizard'; flowStep = 0; renderFlow(); flow.showModal();
}
function advanceFlow() {
  if (flowMode !== 'wizard') { flow.close(); return; }
  const confirmation = $('#flow-confirm');
  if (confirmation && !confirmation.checked) { $('#flow-error').textContent = '请先确认本步骤的演示选项。'; return; }
  if (flowStep === 4 && $('#flow-outcome').value === 'failure') {
    $('#flow-error').textContent = '模拟供应商失败；未扣费。选择成功后重试。';
    $('#flow-next').textContent = '重试模拟'; return;
  }
  if (flowStep === 5) { flow.close(); openProject('skin'); return; }
  flowStep++; renderFlow();
}
$('#flow-next').addEventListener('click', advanceFlow);
$('#flow-back').addEventListener('click', () => { if (flowStep > 0) { flowStep--; renderFlow(); } });
$('#close-flow').addEventListener('click', () => flow.close());
function showAsset(id) {
  const card = $(`[data-asset="${id}"]`) || $('[data-asset="scene"]');
  flowMode = 'asset';
  $('#flow-title').textContent = `${$('b', card).textContent} · 素材详情（模拟）`;
  flowContent.innerHTML = '<div class="asset-compare"><section><h3>源素材示意</h3><div class="skin-image comparison-image"><div class="jar"></div></div></section><section><h3>父版本示意</h3><div class="benefit-image comparison-image"><div class="jar"></div></div></section><section><h3>当前版示意</h3><div class="scene-image comparison-image"><div class="jar"></div></div></section></div>';
  const note = document.createElement('p');
  note.textContent = `生成：完成（模拟）；质量：${$('.asset-card-body span', card).textContent}（模拟）。原图和版本均为 CSS 示意；包装文字、颜色及事实必须在真实流程重新检查。`;
  flowContent.append(note);
  $('#flow-error').textContent = '';
  $('#flow-back').hidden = true; $('#flow-next').hidden = false; $('#flow-next').textContent = '关闭详情';
  flow.showModal();
}
$$('.asset-card').forEach(card => {
  card.tabIndex = 0; card.setAttribute('role', 'button');
  card.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); card.click(); } });
});
const projectEmpty = document.createElement('p');
projectEmpty.className = 'filter-empty'; projectEmpty.textContent = '没有匹配项目，请调整搜索词或筛选。'; projectEmpty.hidden = true;
$('.project-table').after(projectEmpty);
let projectFilter = 0;
function filterProjects() {
  const query = $('.search input').value.trim().toLowerCase();
  let count = 0;
  $$('.table-row').forEach((row, index) => {
    row.hidden = !row.textContent.toLowerCase().includes(query) || (projectFilter === 1 && index !== 1) || (projectFilter === 2 && index !== 0);
    if (!row.hidden) count++;
  });
  projectEmpty.hidden = count !== 0;
}
$('.search input').addEventListener('input', filterProjects);
$$('.segmented button').forEach((button, index) => button.addEventListener('click', () => {
  projectFilter = index; $$('.segmented button').forEach(item => item.classList.toggle('selected', item === button)); filterProjects();
}));
const assetEmpty = document.createElement('p'); assetEmpty.textContent = '此筛选下没有素材。'; assetEmpty.hidden = true; $('.asset-grid').after(assetEmpty);
$$('.check-row input').forEach((input, index) => input.addEventListener('change', () => {
  $$('.check-row input').forEach(other => { other.checked = other === input; });
  const statuses = ['', 'pass-text', 'review-text', 'block-text'];
  let count = 0;
  $$('.asset-card').forEach(card => { card.hidden = index > 0 && !$('.' + statuses[index], card); if (!card.hidden) count++; });
  assetEmpty.hidden = count !== 0;
}));
$$('.asset-project').forEach((button, index) => button.addEventListener('click', () => {
  if (index === 1) { toast('台灯项目暂无演示素材，当前列表仍为面霜。'); return; }
  toast('当前为月光舒缓面霜示例素材');
}));
$$('.work-item').forEach((button, index) => button.addEventListener('click', () => {
  const ids = ['hero', 'benefit', 'scene', 'detail'];
  if (index >= ids.length) { toast('午后场景图尚未生成（模拟空态）'); return; }
  state.selectedAsset = ids[index];
  $$('.work-item').forEach(item => item.classList.toggle('active', item === button));
}));
$('.drawer-panel').setAttribute('role', 'dialog');
$('.drawer-panel').setAttribute('aria-modal', 'true');
$('.drawer-panel').setAttribute('aria-label', '专业模式 · 演示生成记录');
document.addEventListener('keydown', event => {
  if (!state.drawer || event.key !== 'Tab') return;
  const buttons = $$('.drawer-panel button'); const first = buttons[0]; const last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function restoreRoute() {
  const route = location.hash.slice(1) || new URL(location.href).searchParams.get('view') || 'home';
  if (route === 'project') setView('projects');
  else setView(['home', 'projects', 'assets', 'library'].includes(route) ? route : 'home');
}
window.addEventListener('hashchange', restoreRoute);
restoreRoute();
initRealData({ toast });
