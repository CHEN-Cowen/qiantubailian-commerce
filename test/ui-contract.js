import { test } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { STATIC_FILES } from '../src/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFile(`${root}frontend/${name}`, 'utf8');

test('M02 商业化 UI 保留明确演示边界与核心页面', async () => {
  const [html, app, style, viewport] = await Promise.all([
    read('index.html'), read('app.js'), read('style.css'), read('viewport.css'),
  ]);
  for (const text of ['快捷创意', '我的商品', '我的作品', '商品事实已确认', '质量检查', '专业模式', '演示项目 · 刷新重置']) {
    assert.match(html, new RegExp(text));
  }
  assert.match(html, /短视频首帧[\s\S]*后续阶段/);
  assert.match(html, /详情页模块[\s\S]*后续阶段/);
  assert.match(html, /data-open-project="skin" role="button" tabindex="0"/);
  assert.match(html, /data-open-project="lamp" role="button" tabindex="0"/);
  assert.match(app, /function setView\(view\)/);
  assert.match(app, /function openDrawer\(\)/);
  assert.match(app, /project !== 'skin'/);
  assert.match(app, /addEventListener\('keydown', activateProject\)/);
  // 体验优化模块 01：主色切换为低饱和绿（F1 建议色 #365F49 / #6E8F79）
  assert.match(style, /--primary:#365F49/);
  assert.match(style, /--accent:#6E8F79/);
  assert.match(viewport, /@media\(max-width:760px\)/);
  assert.match(style, /\.view,\.project-view\{display:none\}/);
  assert.match(html, /刷新后重置/);
  // UI04 真实样例图：白名单同步、页面引用与诚实标注
  const samples = ['sample-cream-original', 'sample-cream-hero', 'sample-cream-scene', 'sample-cream-benefit', 'sample-cream-detail', 'sample-lamp-hero'];
  for (const name of samples) {
    assert.ok(STATIC_FILES.includes(`assets/demo/${name}.jpg`), `STATIC_FILES 缺少 assets/demo/${name}.jpg`);
    assert.ok(html.includes(`./assets/demo/${name}.jpg`), `index.html 未引用 ${name}.jpg`);
  }
  assert.match(style, /\.sample-photo\{[^}]*object-fit:cover/);
  assert.match(html, /真实模型生成样例/);
});

// 模块02：首次制作一页三步向导（create 视图）契约
test('M02-wizard create 视图存在、脚本接线、三步步骤条与诚实边界文案', async () => {
  const [html, app, style, wizard, server] = await Promise.all([
    read('index.html'), read('app.js'), read('style.css'), read('wizard.js'),
    readFile(`${root}src/server.mjs`, 'utf8'),
  ]);
  // create 视图作为独立 view 面板接入 setView 机制
  assert.match(html, /id="create-view" data-view-panel="create"/);
  assert.match(app, /setView\('create'\)/, '旧新建入口必须切换到 create 视图');
  assert.match(app, /'home', 'projects', 'create', 'assets', 'library'/, 'create 必须是合法路由');
  // 旧 project-dialog 弹窗下线，truth/spec/upload 弹窗保留
  assert.ok(!html.includes('id="project-dialog"'), 'project-dialog 应已由 create 向导取代');
  for (const id of ['truth-dialog', 'spec-dialog', 'upload-dialog']) {
    assert.ok(html.includes(`id="${id}"`), `既有项目页弹窗 #${id} 应保留`);
  }
  // 向导脚本在 real-data 之后以 module 方式加载，且进入静态白名单可被服务
  const scripts = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('wizard.js') > scripts.indexOf('real-data.js'), 'wizard.js 必须在 real-data.js 之后加载');
  assert.ok(STATIC_FILES.includes('wizard.js'), 'STATIC_FILES 缺少 wizard.js');
  assert.match(server, /'wizard\.js'/);
  assert.match(wizard, /if \(typeof document !== 'undefined'\) initWizard\(\)/, 'wizard.js 需自启动');
  // 步骤条三步文案
  for (const text of ['上传商品', '确认必要信息', '风格与交付']) {
    assert.ok(html.includes(text), `步骤条缺少「${text}」`);
  }
  // 浏览器预览与「已保存到服务端」两类状态明确区分，并写明刷新不可恢复
  assert.match(html, /浏览器预览（尚未保存到服务端）/);
  assert.match(wizard, /已保存到服务端/);
  assert.match(wizard, /刷新|不可恢复/);
  // 报价摘要容器存在；报价数值必须来自服务端响应，禁止硬编码
  assert.match(html, /id="wiz-quote"/);
  assert.match(wizard, /生成 \$\{imageCount\} 张图片 · 最多使用 \$\{quote\.max_credits\} 点/);
  assert.match(wizard, /api\.createQuote\(/);
  assert.match(wizard, /api\.createRun\(/);
  assert.match(wizard, /randomUUID|Idempotency/i, '生成必须携带 Idempotency-Key');
  assert.match(wizard, /qb:open-workbench/, '生成成功后必须跳转工作台');
  // OCR 诚实边界：未配置要明说，候选一律待确认
  assert.match(wizard, /未配置文字识别，可手动填写/);
  assert.match(wizard, /来源：OCR，待确认/);
  // 向导样式使用现有绿色设计系统变量，不引入新调色板
  assert.match(style, /\.wiz-drop[^{]*\{[^}]*--brand/);
  assert.match(style, /\.wiz-template-card\.selected\{[^}]*var\(--brand\)/);
  assert.match(style, /\.wiz-quote-bar\{[^}]*--brand-line/);
});

test('M02 向导真实函数分支：确认拦截、失败重试、成功进入项目', async () => {
  const app = await read('app.js');
  const nodes = new Map();
  const node = key => { if (!nodes.has(key)) nodes.set(key, { textContent: '', hidden: false, value: 'success', checked: false }); return nodes.get(key); };
  let rendered = 0; let closed = 0; let opened = '';
  const context = vm.createContext({
    $: selector => selector === '#flow-confirm' ? (context.hasConfirmation ? node(selector) : null) : node(selector),
    hasConfirmation: true,
    flowMode: 'wizard', flowStep: 0,
    flow: { close() { closed++; } },
    renderFlow() { rendered++; }, openProject(id) { opened = id; },
  });
  const fn = app.slice(app.indexOf('function advanceFlow()'), app.indexOf("$('#flow-next').addEventListener"));
  vm.runInContext(fn, context);
  vm.runInContext('advanceFlow()', context);
  assert.equal(context.flowStep, 0);
  assert.match(node('#flow-error').textContent, /请先确认/);
  node('#flow-confirm').checked = true;
  vm.runInContext('advanceFlow()', context);
  assert.equal(context.flowStep, 1); assert.equal(rendered, 1);
  context.hasConfirmation = false; context.flowStep = 4;
  node('#flow-outcome').value = 'failure';
  vm.runInContext('advanceFlow()', context);
  assert.equal(context.flowStep, 4); assert.match(node('#flow-error').textContent, /未扣费/);
  node('#flow-outcome').value = 'success';
  vm.runInContext('advanceFlow()', context);
  assert.equal(context.flowStep, 5);
  vm.runInContext('advanceFlow()', context);
  assert.equal(closed, 1); assert.equal(opened, 'skin');
});

test('M02 项目搜索无结果与分类筛选执行真实函数', async () => {
  const app = await read('app.js');
  const rows = [{ textContent: '月光 MC-50', hidden: false }, { textContent: '台灯 WL-08', hidden: false }];
  const search = { value: '不存在' }; const empty = { hidden: true };
  const context = vm.createContext({ $: () => search, $$: () => rows, projectEmpty: empty, projectFilter: 0 });
  vm.runInContext(app.slice(app.indexOf('function filterProjects()'), app.indexOf("$('.search input').addEventListener")), context);
  vm.runInContext('filterProjects()', context);
  assert.ok(rows.every(row => row.hidden)); assert.equal(empty.hidden, false);
  search.value = ''; context.projectFilter = 1;
  vm.runInContext('filterProjects()', context);
  assert.equal(rows[0].hidden, true); assert.equal(rows[1].hidden, false); assert.equal(empty.hidden, true);
});

test('前端脚本不得引用已被删除的 DOM 节点（防止首屏 addEventListener 崩溃）', async () => {
  const html = await read('index.html');
  const files = ['app.js', 'real-data.js', 'workbench.js', 'm04.js', 'm05.js', 'wizard.js'];
  for (const file of files) {
    const src = await read(file);
    // 直接链式调用（无 ?. 保护）会在节点缺失时抛错，必须存在于 index.html
    const chained = [...src.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)\.(addEventListener|classList|showModal|close)/g)];
    for (const [, id] of chained) {
      assert.ok(html.includes(`id="${id}"`), `${file} 直接引用了不存在的 #${id}`);
    }
    // 全部 #id 引用：要么写在 index.html，要么由同一脚本运行时注入
    const all = [...new Set([...src.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map(m => m[1]))];
    for (const id of all) {
      assert.ok(html.includes(`id="${id}"`) || src.includes(`id="${id}"`),
        `${file} 引用了既不在 index.html 也未运行时注入的 #${id}`);
    }
  }
});

// 模块03：商品与品牌复用（E1 同商品再做一套 / E2 用此风格制作新品 / E3 品牌入口）契约
test('M03-复用 qb:open-wizard 事件、复用入口、向导复用模式与不沿用声明', async () => {
  const [html, wizard, realData, m04] = await Promise.all([
    read('index.html'), read('wizard.js'), read('real-data.js'), read('m04.js'),
  ]);
  // 事件接线：入口 dispatch，wizard 在 window 上监听，视图切换仍走 app.js 的 setView（hash 路由）
  assert.match(wizard, /addEventListener\('qb:open-wizard'/, 'wizard 必须监听 qb:open-wizard');
  assert.match(realData, /qb:open-wizard/, 'real-data 项目入口必须派发 qb:open-wizard');
  assert.match(m04, /qb:open-wizard/, 'm04 模板/品牌入口必须派发 qb:open-wizard');
  // E1 入口：项目卡片与首页卡片的「再做一套」按钮（remake）
  assert.match(realData, /data-action="remake"/);
  assert.match(realData, /再做一套/);
  assert.match(realData, /mode: 'reuse'/);
  // E2/E3 入口：模板卡「用此风格制作新品」、品牌卡 brand-use 接上
  assert.match(m04, /data-action="style-use"/);
  assert.match(m04, /用此风格制作新品/);
  assert.match(m04, /data-action="brand-use"/);
  assert.match(m04, /mode: 'style'/);
  assert.match(m04, /mode: 'brand'/);
  // 向导三种复用模式
  assert.match(wizard, /mode === 'reuse'/);
  assert.match(wizard, /mode === 'style'/);
  assert.match(wizard, /mode === 'brand'/);
  // E1：沿用已上传素材 + 沿用摘要「沿用：商品事实 vN · 品牌 X · 模板 Y，可修改」
  assert.match(wizard, /沿用已上传素材/);
  assert.match(wizard, /沿用：商品事实 v/);
  assert.match(wizard, /· 品牌 \$\{state\.reuseSpec\.brandName\}/);
  assert.match(wizard, /· 模板 \$\{state\.reuseSpec\.templateName\}/);
  assert.match(wizard, /，可修改/);
  assert.match(wizard, /api\.getSpec\(/, 'E1 第 3 步应按 spec 冻结快照预选模板/品牌/平台');
  // E1：修改事实行内容自动取消该行「已确认」
  assert.match(wizard, /confirmed\.checked = false/, '修改事实行必须自动取消已确认');
  // E2/E3：沿用风格声明，明确不沿用旧商品信息
  assert.match(wizard, /沿用风格：/);
  assert.match(wizard, /新商品的事实与素材需重新确认，不沿用旧商品信息/);
  // 复用摘要横幅容器接入 create 视图
  assert.ok(html.includes('id="wiz-reuse"'), 'index.html 缺少复用摘要横幅 #wiz-reuse');
  assert.ok(html.includes('id="wiz-reuse-title"'), 'index.html 缺少 #wiz-reuse-title');
  assert.ok(html.includes('id="wiz-reuse-note"'), 'index.html 缺少 #wiz-reuse-note');
});
