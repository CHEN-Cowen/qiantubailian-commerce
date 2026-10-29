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

// 模块06：修改工作台 + 我的作品页 + 全站一致性契约
test('M06 修改工作台节点、api 客户端方法、范围与免费文案、历史版本与重生成接线', async () => {
  const [html, workbench, api, workbenchCss] = await Promise.all([
    read('index.html'), read('workbench.js'), read('api.js'), read('workbench.css'),
  ]);
  // 关键节点：文字修改面板容器、重生成按钮、前后对比容器、历史版本容器、缩略切换
  for (const id of ['wb-edit-panel', 'wb-edit-layers', 'wb-edit-apply', 'wb-regenerate',
    'wb-edit-compare', 'wb-edit-compare-dual', 'wb-edit-versions', 'wb-edit-thumbs',
    'wb-edit-preview-holder', 'wb-edit-before-holder', 'wb-edit-after-holder']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少修改工作台节点 #${id}`);
  }
  // api.js 新方法：text-layers / text-edits / regenerate（幂等键头）
  assert.match(api, /listTextLayers/, 'api.js 缺少 listTextLayers');
  assert.match(api, /applyTextEdits/, 'api.js 缺少 applyTextEdits');
  assert.match(api, /regenerateDeliverable/, 'api.js 缺少 regenerateDeliverable');
  assert.match(api, /text-layers/);
  assert.match(api, /text-edits/);
  assert.match(api, /\/regenerate/);
  assert.match(api, /Idempotency-Key/, 'regenerate 必须携带 Idempotency-Key 头');
  // 范围与免费文案（F2：仅此一张受影响；文字修改不重调生成模型）
  assert.match(html, /仅此一张受影响/);
  assert.match(html, /本次未重新调用生成模型/);
  assert.match(html, /应用修改（免费）/);
  assert.match(html, /仅重做此张/);
  assert.match(workbench, /选用此版本/, '历史版本必须提供「选用此版本」恢复入口');
  // workbench.js 关键函数：进入修改态、读层、应用、diff、历史版本、切换、重生成轮询
  for (const fn of ['enterEditMode', 'closeEditMode', 'switchEditDeliverable', 'loadTextLayers',
    'collectEdits', 'applyTextEditsSubmit', 'renderEditVersions', 'activateEditVersion',
    'renderEditCompare', 'requestRegenerate', 'pollRegen']) {
    assert.match(workbench, new RegExp(`function ${fn}\\(`), `workbench.js 缺少函数 ${fn}`);
  }
  // 接线到模块05 API 客户端
  assert.match(workbench, /api\.listTextLayers\(/);
  assert.match(workbench, /api\.applyTextEdits\(/);
  assert.match(workbench, /api\.regenerateDeliverable\(/);
  // 重生成确认提示必须包含按张结算/预计消耗说明
  assert.match(workbench, /按张结算/);
  assert.match(workbench, /预计消耗 1 点/);
  // 检查结果如实渲染：blocked 不能画成绿色成功（DECISION_META 映射三种 decision）
  assert.match(workbench, /publishable: \['检查通过', 'ok'\]/);
  assert.match(workbench, /needs_review: \['待复核', 'warn'\]/);
  assert.match(workbench, /blocked: \['检查未通过', 'bad'\]/);
  // VERSION_CONFLICT 提供基于最新版本重试的路径
  assert.match(workbench, /VERSION_CONFLICT/);
  assert.match(workbench, /data-edit-retry/);
  // 只读层标注：包装文字只读 + Logo 不可编辑
  assert.match(workbench, /PACKAGING_TEXT_READONLY/);
  assert.match(workbench, /LOGO_USES_ORIGINAL_PIXEL/);
  // 历史版本行展示版本号、note、created_by、报告 decision
  assert.match(workbench, /wb-version-row/);
  assert.match(workbench, /CREATED_BY_LABEL/);
  // 修改工作台样式与窄屏（≤760px）单列
  assert.match(workbenchCss, /\.wb-edit-grid\s*\{[^}]*grid-template-columns/);
  assert.match(workbenchCss, /@media \(max-width: 760px\)/);
});

test('M06 我的作品页：真实作品区、选用/检查/交付/历史版本标识、下载与水印标注', async () => {
  const [html, realData, workbenchCss] = await Promise.all([
    read('index.html'), read('real-data.js'), read('workbench.css'),
  ]);
  // 真实作品区容器与演示样例区并存（演示边界保留、真实区在上）
  assert.ok(html.includes('id="real-works"'), 'index.html 缺少真实作品区 #real-works');
  assert.ok(html.includes('id="real-works-body"'), 'index.html 缺少 #real-works-body');
  assert.ok(html.includes('class="asset-layout" hidden'), '演示样例区 .asset-layout 应保持 hidden');
  // 数据源：按项目列任务 + 版本 + 报告 + 导出，单张下载走 downloadExportUrl
  assert.match(realData, /api\.listRunsByProject\(/);
  assert.match(realData, /api\.listRunVersions\(/);
  assert.match(realData, /api\.listQualityReports\(/);
  assert.match(realData, /api\.downloadExportUrl\(/);
  // 标识类名：套图卡片、标识条（选用/检查/交付/历史版本数）
  for (const cls of ['real-work-group', 'real-work-shots', 'real-shot', 'real-shot-tags']) {
    assert.match(realData, new RegExp(cls), `real-data.js 缺少作品页标识 ${cls}`);
  }
  assert.match(realData, /wb-chip ok">选用</);
  assert.match(realData, /已交付/);
  assert.match(realData, /个版本/);
  // 未结算/待复核的预览如实标注水印
  assert.match(realData, /未结算\/待复核，预览带水印/);
  // 每任务最多展示近期 1 个 run，其余可展开
  assert.match(realData, /默认只展示最近一次/);
  // 空状态可直接开始 + 错误带重试
  assert.match(realData, /data-works-start/);
  assert.match(realData, /data-works-retry/);
  assert.match(realData, /renderRealWorks/);
  // 作品页单列（≤760px）与卡片样式
  assert.match(workbenchCss, /\.real-work-shots/);
  assert.match(workbenchCss, /repeat\(2, minmax\(0, 1fr\)\)/);
});

test('M06 一致性：状态组件、长内容省略与断链清扫', async () => {
  const [style, html, workbench, realData, workbenchCss] = await Promise.all([
    read('style.css'), read('index.html'), read('workbench.js'), read('real-data.js'), read('workbench.css'),
  ]);
  // 模块01 状态组件被复用（style.css 定义 + workbench/real-data 使用）
  assert.match(style, /\.state-note/);
  assert.match(style, /\.loading-line/);
  assert.match(style, /\.empty-state/);
  assert.match(workbench, /state-note danger/);
  assert.match(workbench, /loading-line/);
  assert.match(realData, /empty-state/);
  // 长内容 ellipsis + title（缩略条、版本行、作品卡）
  assert.match(workbenchCss, /text-overflow: ellipsis/);
  // 演示边界文案仍在（r06 契约不被清扫误伤）
  assert.match(html, /演示项目 · 刷新重置/);
  assert.match(html, /真实模型生成样例/);
  // workbench 保留 r05 断言的关键 DOM id 与函数
  for (const id of ['wb-deliverables', 'wb-canvas', 'wb-qa-checks', 'wb-event-log', 'wb-export-complete']) {
    assert.ok(html.includes(`id="${id}"`), `r05 关键节点 #${id} 被误删`);
  }
});

// 模块E03：商品变更更新助手前端契约（区块挂在 real-data 管理的项目详情弹窗内，DOM 由 real-data.js 运行时注入）
test('E03 商品变更：项目页变更区块、api 端点方法、逐项处理与诚实文案', async () => {
  const [html, realData, api, workbenchCss] = await Promise.all([
    read('index.html'), read('real-data.js'), read('api.js'), read('workbench.css'),
  ]);
  // 入口：项目详情（商品事实）弹窗内注入 #change-section 区块
  assert.ok(html.includes('id="truth-dialog"'), 'index.html 缺少项目详情弹窗 #truth-dialog');
  assert.match(realData, /id="change-section"/, 'real-data.js 缺少商品变更区块 #change-section');
  assert.match(realData, /id="change-error"/, 'real-data.js 缺少区块错误节点 #change-error');
  // api.js：E03 端点方法（同源 /api，写请求经 call 自动带 CSRF；确认带 Idempotency-Key）
  for (const fn of ['previewChange', 'confirmChange', 'listChanges', 'getChange', 'executeChange',
    'retryChange', 'cancelChange', 'visualCheckItem', 'attachChangeItemMaterial',
    'listReplacementTodos', 'confirmReplacementTodo']) {
    assert.match(api, new RegExp(`${fn}`), `api.js 缺少方法 ${fn}`);
  }
  assert.match(api, /\/changes\/preview/);
  assert.match(api, /Idempotency-Key/, '确认变更必须携带 Idempotency-Key 头');
  assert.match(api, /\/execute/);
  assert.match(api, /\/retry/);
  assert.match(api, /\/cancel/);
  assert.match(api, /\/visual-check/);
  assert.match(api, /\/material/);
  assert.match(api, /\/replacement-todos/);
  // real-data.js：关键函数与真实 API 接线
  for (const fn of ['loadChanges', 'renderChangeSection', 'renderChangeDetail', 'renderChangeItem',
    'submitChangePreview', 'confirmChangeOrder', 'executeChangeOrder', 'retryChangeOrder',
    'cancelChangeOrder', 'submitVisualCheck', 'attachChangeMaterial', 'activateChangeVersion', 'onChangeClick']) {
    assert.match(realData, new RegExp(`function ${fn}\\(`), `real-data.js 缺少函数 ${fn}`);
  }
  assert.match(realData, /api\.previewChange\(/);
  assert.match(realData, /api\.confirmChange\(/);
  assert.match(realData, /api\.executeChange\(/);
  assert.match(realData, /api\.retryChange\(/);
  assert.match(realData, /api\.cancelChange\(/);
  assert.match(realData, /api\.visualCheckItem\(/);
  assert.match(realData, /api\.attachChangeItemMaterial\(/);
  assert.match(realData, /api\.listReplacementTodos\(/);
  assert.match(realData, /api\.confirmReplacementTodo\(/);
  assert.match(realData, /api\.activateVersion\(/, '结果版本选用/恢复复用 activateVersion');
  assert.match(realData, /api\.createExport\(/, '完成后导出入口复用 createExport');
  assert.match(realData, /api\.uploadAsset\(/, '补拍素材上传复用 uploadAsset');
  // 乐观锁与幂等：base_truth_version 随确认提交；幂等键由 crypto 生成
  assert.match(realData, /base_truth_version/);
  assert.match(realData, /randomUUID/);
  // 冲突如实提示「已有新变更，请刷新」，不假装成功
  assert.match(realData, /VERSION_CONFLICT/);
  assert.match(realData, /商品事实已有新变更/);
  assert.match(realData, /请刷新后重新预检/);
  // 执行闸口：报价确认、硬阻断、余额不足、重试限制的错误码如实处理
  assert.match(realData, /QUOTE_CONFIRMATION_REQUIRED/);
  assert.match(realData, /QUOTE_STALE/);
  assert.match(realData, /HARD_OVERRIDE_BLOCKED/);
  assert.match(realData, /INSUFFICIENT_CREDITS/);
  // REGENERATION_NEEDS_REVIEW：提示到源任务人工选用，不在变更单里重复扣费重试
  assert.match(realData, /REGENERATION_NEEDS_REVIEW/);
  assert.match(realData, /未自动选用/);
  assert.match(realData, /qb:open-workbench/, '复核入口必须跳回源任务工作台');
  // 待补实拍与数量人工核对文案（跳过≠完成；核对结论必填）
  assert.match(realData, /待补实拍/);
  assert.match(realData, /核对结论（必填/);
  assert.match(realData, /只重试失败项/);
  assert.match(realData, /取消变更单/);
  // 替换待办：只登记商家手动替换，不代表平台已同步
  assert.match(realData, /确认已手动替换/);
  assert.match(realData, /不代表平台已同步/);
  // 区块样式追加到 workbench.css
  assert.match(workbenchCss, /\.chg-item\s*\{/);
  assert.match(workbenchCss, /\.chg-detail\s*\{/);
  assert.match(workbenchCss, /\.chg-list\s*\{/);
});
