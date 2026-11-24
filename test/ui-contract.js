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
  for (const text of ['用商品实拍', '做一套上架图', '我的商品', '我的作品', '商品事实已确认', '质量检查', '专业模式', '演示项目 · 刷新重置']) {
    assert.match(html, new RegExp(text));
  }
  assert.match(html, /图片为设计示例，不代表实际生成结果/);

  assert.ok(!html.includes('以下为演示数据'), '正式「我的商品」区不得再展示演示数据分隔与表格');
  assert.ok(!html.includes('data-open-project="skin"'), '正式商品列表不得挂演示项目入口');
  assert.match(app, /function setView\(view\)/);
  assert.match(app, /function openDrawer\(\)/);
  assert.match(app, /project !== 'skin'/);
  assert.match(app, /addEventListener\('keydown', activateProject\)/);
  // V0.2 电紫主题：主行动 #5A00D6 / 强调 #7C3AED（原低饱和绿已退役）
  assert.match(style, /--primary:#5A00D6/);
  assert.match(style, /--accent:#7C3AED/);
  assert.match(viewport, /@media\(max-width:760px\)/);
  assert.match(style, /\.view,\.project-view\{display:none\}/);
  assert.match(html, /刷新后重置/);
  // UI04 真实样例图：白名单同步、页面引用与诚实标注
  const samples = ['sample-cream-original', 'sample-cream-hero', 'sample-cream-scene', 'sample-cream-benefit', 'sample-cream-detail', 'sample-lamp-hero'];
  for (const name of samples) {
    assert.ok(STATIC_FILES.includes(`assets/demo/${name}.jpg`), `STATIC_FILES 缺少 assets/demo/${name}.jpg`);
  }
  // 正式商品区已去演示化；示例图片只保留在明确标注、默认隐藏的旧展示区
  assert.ok(html.includes('./assets/demo/sample-cream-hero.jpg'), '示例图引用丢失');
  assert.match(style, /\.sample-photo\{[^}]*object-fit:cover/);
  assert.match(html, /真实模型生成样例/);
});

// 模块02：首次制作一页三步向导（create 视图）契约
test('M02-wizard create 视图存在、脚本接线、三步步骤条与诚实边界文案', async () => {
  const [html, app, style, wizard, api, server] = await Promise.all([
    read('index.html'), read('app.js'), read('style.css'), read('wizard.js'), read('api.js'),
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
  // 步骤条文案（与工作台六步词汇统一：上传素材/确认商品信息/选效果与场景/确认报价与生成）
  for (const text of ['上传素材', '确认商品信息', '选效果与场景', '确认报价与生成']) {
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
  // 进入 create 视图必须真正触发 resetForEntry（幂等键在这里生成）：
  // 派发方与监听方必须使用同一个事件目标，否则 key 一直为空、创建任务被 400 拦截
  assert.match(app, /document\.dispatchEvent\(new CustomEvent\('qb:view-change'/, 'view-change 必须在 document 上派发');
  assert.doesNotMatch(app, /window\.dispatchEvent\(new CustomEvent\('qb:view-change'/);
  assert.match(wizard, /document\.addEventListener\('qb:view-change'/, '向导必须监听 document 上的 view-change');
  assert.match(wizard, /state\.idempotencyKey = newIdempotencyKey\(\)/, '进入向导必须生成幂等键');
  assert.match(wizard, /if \(!state\.idempotencyKey\) state\.idempotencyKey = newIdempotencyKey\(\)/, '创建任务前必须兜底补齐幂等键');
  assert.match(api, /headers: \{ 'Idempotency-Key': idempotencyKey \}/, 'createRun 必须携带幂等键请求头');
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

test('M01 正式工作区不保留演示项目搜索与筛选', async () => {
  const app = await read('app.js');
  const html = await read('index.html');
  // 演示项目表已下线；对应的搜索/筛选逻辑必须一并移除，避免引用已删除节点
  assert.doesNotMatch(app, /filterProjects|projectEmpty/u);
  assert.doesNotMatch(html, /project-table/u);
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

test('M04 商品信息卡与卖点候选：问题/示例、核对状态与依据识别真实执行', async () => {
  const [html, wizard, style] = await Promise.all([
    read('index.html'), read('wizard.js'), read('style.css'),
  ]);
  assert.match(html, /id="wiz-fact-cards"/, '第 2 步必须有商品信息问题卡片容器');
  assert.match(html, /id="wiz-category"/, '必须可选择商品类型以匹配问题');
  assert.match(html, /id="wiz-selling-points"/, '必须提供卖点填写入口');
  assert.match(html, /id="wiz-sell-analyze"/, '卖点候选必须由用户主动生成');
  assert.match(html, /id="wiz-critical-text"/, '包装关键文字必须可填写');
  assert.match(wizard, /CATEGORY_PROFILES/, '问题清单必须按品类定义');
  assert.match(wizard, /例如：\$\{escapeHtml\(card\.example\)\}/, '每个问题必须给示例');
  assert.match(wizard, /已核对 · 会作为商品信息进入成图/, '核对后必须说明结果去向');
  assert.match(wizard, /card\.confirmed = false/, '修改内容必须自动取消核对状态');
  assert.match(wizard, /critical_text: collectCriticalText\(\)/, '关键文字必须真实提交到事实版本');
  assert.match(wizard, /category: state\.category/, '商品类型必须随事实版本提交');
  assert.match(style, /\.wiz-fact-card\.confirmed\{[^}]*--brand/);

  // 卖点分析是纯函数：直接执行真实实现，而不是只看源码字符串
  const slice = wizard.slice(wizard.indexOf('const CLAIM_PATTERNS'), wizard.indexOf('const SELL_LEVEL_LABEL'));
  const context = vm.createContext({});
  vm.runInContext(`${slice}\nglobalThis.__a = (s, f) => analyzeSellingPoint(s, f); globalThis.__split = splitSellingText;`, context);
  const facts = [
    { key: '净含量', value: '500ml', confirmed: true },
    { key: '材质', value: '不锈钢', confirmed: false },
  ];
  assert.equal(context.__a('500ml 大容量', facts).level, 'ready', '已核对数字可直接使用');
  assert.equal(context.__a('一瓶用一个月', facts).level, 'ready', '无数字无功效可直接使用');
  assert.equal(context.__a('750ml 更划算', facts).level, 'unverified', '未核对数字必须拦截');
  const claim = context.__a('美白提亮肤色', facts);
  assert.equal(claim.level, 'claim', '功效词必须标为缺依据');
  assert.equal(claim.rewrite, '提亮肤色', '改写只能删除功效词，不新增表达');
  assert.equal(context.__a('采用不锈钢材质', facts).text, '采用不锈钢材质', '原句保持不变');
  assert.equal(context.__a('采用不锈钢材质', facts).level, 'ready', '未确认事实不冒充已确认');
  assert.equal(JSON.stringify(context.__split('大容量。便携；送礼')), JSON.stringify(['大容量', '便携', '送礼']));
});

test('M05 用途/背景与步骤拆分：可视化方案、默认背景、阻塞映射到按钮附近', async () => {
  const [html, wizard, style] = await Promise.all([
    read('index.html'), read('wizard.js'), read('style.css'),
  ]);
  assert.match(html, /data-wiz-panel="3"/);
  assert.match(html, /data-wiz-panel="4"/, '交付与费用必须拆成独立第 4 步');
  assert.match(html, /id="wiz-bg-filter"/, '背景必须有可执行的偏好选择');
  assert.match(html, /data-bg-filter="plain_white"/);
  assert.match(html, /id="wiz-to-pay"/, '第 3 步只负责选方案，费用与生成在第 4 步');
  assert.match(html, /id="wiz-pay-blockers"/, '阻塞项必须显示在生成按钮附近');
  assert.match(wizard, /function templateArt/, '方案卡必须有可视化示意');
  assert.match(wizard, /排版示意，不是生成结果/, '示意必须声明不是生成结果');
  assert.match(wizard, /BACKGROUND_LABEL/, '背景方向必须翻译成人能读的名称');
  assert.match(wizard, /data-pay-fix="facts"/, '事实阻塞必须能直接跳到补充入口');
  assert.match(wizard, /data-pay-fix="workbench"/, '素材阻塞必须能直接跳到工作台');
  assert.match(wizard, /先处理上方 \$\{count\} 项/, '按钮本身要说明还不能生成');
  assert.match(style, /\.wiz-pay-facts/);

  // 背景不是生成前置：generateBlocked 只看交付冲突与生产前置，多个背景偏好不会被当成阻塞
  const body = wizard.slice(wizard.indexOf('function generateBlocked()'), wizard.indexOf('// ---------- 第 4 步'));
  assert.ok(!/background|bgFilter/.test(body), '背景偏好不得成为生成阻塞条件');
  assert.match(body, /conflicts\.pending/);
  assert.match(body, /can_start_production/);
});

test('M06 提交后同上下文追踪：真实状态、真实费用、取消与超时边界', async () => {
  const [html, wizard] = await Promise.all([read('index.html'), read('wizard.js')]);
  assert.match(html, /id="wiz-run-status"/);
  assert.match(html, /id="wiz-run-deliverables"/);
  assert.match(html, /id="wiz-run-budget"/, '必须显示本任务真实额度');
  assert.match(html, /id="wiz-run-refresh"/);
  assert.match(html, /id="wiz-run-cancel"/);
  assert.match(wizard, /api\.runEvents\(runId\)/, '进度必须来自服务端事件流');
  assert.match(wizard, /api\.getRun\(state\.runId\)/, 'SSE 断开时退化为只读轮询');
  assert.match(wizard, /不推算百分比/, '不得用计时器伪造进度');
  assert.match(wizard, /这不代表任务失败/, '超时不能直接归因网站故障');
  assert.match(wizard, /reason: 'user_cancelled'/, '取消必须走真实取消接口');
  assert.match(wizard, /budget\.captured_credits/, '费用必须取账本实际结算值');
  // 提交成功后不再立刻跳走：先在本页展示任务，再提供进入工作台的按钮
  const submit = wizard.slice(wizard.indexOf('const run = result.run ?? {};'), wizard.indexOf("showToast(`任务已提交"));
  assert.ok(!/dispatchEvent\(new CustomEvent\('qb:open-workbench'/.test(submit), '提交后不得用跳转代替结果追踪');
});

test('M07 结果编辑/版本/下载闭环与存量功能入口保持可用', async () => {
  const [wizard, workbench, realData, api] = await Promise.all([
    read('wizard.js'), read('workbench.js'), read('real-data.js'), read('api.js'),
  ]);
  assert.match(api, /downloadExportUrl: exportId => `\/api\/exports\//, '下载必须指向真实导出接口');
  assert.match(workbench, /api\.downloadExportUrl\(exp\.id\)/, '工作台交付清单必须可下载');
  assert.match(workbench, /修改|修订|revision/i, '工作台必须保留修改入口');
  assert.match(workbench, /历史版本/);
  assert.match(realData, /历史版本/, '我的作品必须能看到版本');
  assert.match(realData, /api\.downloadExportUrl\(deliveredExport\.id\)/, '作品下载必须走真实导出');
  // 提交后进入工作台时定位到本次任务，直接看编辑、版本与下载
  assert.match(wizard, /runId: state\.runId \|\| undefined/, '工作台入口需携带本次任务');
  // 存量维护入口（商品信息/SKU/品牌模板）继续由真实数据区提供
  assert.match(realData, /qb:open-workbench/, '商品维护仍进入同一工作台');
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
  // E1：沿用已上传素材 + 沿用摘要「沿用：商品信息 vN · 品牌 X · 模板 Y，可修改」
  assert.match(wizard, /沿用已上传素材/);
  assert.match(wizard, /沿用：商品信息 v/);
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
  assert.match(realData, /商品信息已有新变更/);
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

// 模块E04：SKU 防串图核对与按 SKU 导出前端契约（区块同样挂在 #truth-dialog 内，由 real-data.js 注入）
test('E04 SKU 核对：项目页核对区块、api 端点方法、三层分列与诚实文案', async () => {
  const [html, realData, api, workbenchCss] = await Promise.all([
    read('index.html'), read('real-data.js'), read('api.js'), read('workbench.css'),
  ]);
  assert.ok(html.includes('id="truth-dialog"'), 'index.html 缺少项目详情弹窗 #truth-dialog');
  assert.match(realData, /id="check-section"/, 'real-data.js 缺少 SKU 核对区块 #check-section');
  // api.js：E04 端点方法
  for (const fn of ['runSkuChecks', 'listSkuChecks', 'resolveCheckIssue', 'createSkuExport', 'listSkuExports']) {
    assert.match(api, new RegExp(`${fn}`), `api.js 缺少方法 ${fn}`);
  }
  assert.match(api, /\/sku-checks/);
  assert.match(api, /\/check-issues\//);
  assert.match(api, /\/resolve/);
  assert.match(api, /\/sku-exports/);
  // real-data.js：关键函数与真实 API 接线
  for (const fn of ['loadSkuChecks', 'renderCheckSection', 'renderCheckIssues', 'renderCheckExports', 'onCheckClick']) {
    assert.match(realData, new RegExp(`function ${fn}\\(`), `real-data.js 缺少函数 ${fn}`);
  }
  assert.match(realData, /api\.runSkuChecks\(/);
  assert.match(realData, /api\.listSkuChecks\(/);
  assert.match(realData, /api\.resolveCheckIssue\(/);
  assert.match(realData, /api\.createSkuExport\(/);
  assert.match(realData, /api\.listSkuExports\(/);
  // 三层分列与操作
  assert.match(realData, /归属核对/);
  assert.match(realData, /结构核对/);
  assert.match(realData, /视觉候选/);
  assert.match(realData, /data-action="skc-run"/);
  assert.match(realData, /data-action="skc-confirm"/);
  assert.match(realData, /data-action="skc-reassign"/);
  assert.match(realData, /data-action="skc-export"/);
  assert.match(realData, /data-action="skc-open-workbench"/, '改文字/重做必须跳工作台');
  assert.match(realData, /qb:open-workbench/);
  // 版本图预览走服务端内容路由（未结算自带水印），不直接读文件
  assert.match(realData, /workVersionImageUrl\(issue\.run_id, issue\.version_id\)/);
  // 诚实文案：阻断不可被满意覆盖、复核绑定版本、视觉未知不作通过依据、不混入其他 SKU
  assert.match(realData, /满意不能覆盖确定错误/);
  assert.match(realData, /新版本需重新核对/);
  assert.match(realData, /保持未知/);
  assert.match(realData, /归属其他 SKU 的图不会混入/);
  assert.match(realData, /ISSUE_HARD_BLOCK/);
  assert.match(realData, /SKU_EXPORT_EMPTY/);
  // 导出下载复用既有 downloadExportUrl
  assert.match(realData, /api\.downloadExportUrl\(/);
  // 区块样式
  assert.match(workbenchCss, /\.skc-list\s*\{/);
  assert.match(workbenchCss, /\.skc-form\s*\{/);
  assert.match(workbenchCss, /\.skc-exports\s*\{/);
});

// 模块E05：售前问题分流前端契约（输入脱敏提示、五类结果、归类改正、频次来源）
test('E05 售前问题：项目页区块、api 端点、五类结果与诚实文案', async () => {
  const [realData, api, workbenchCss] = await Promise.all([
    read('real-data.js'), read('api.js'), read('workbench.css'),
  ]);
  assert.match(realData, /id="question-section"/, 'real-data.js 缺少售前问题区块 #question-section');
  // api.js：E05 端点方法
  for (const fn of ['analyzeQuestion', 'listQuestionGroups', 'getQuestionGroup', 'reviewQuestionGroup']) {
    assert.match(api, new RegExp(`${fn}`), `api.js 缺少方法 ${fn}`);
  }
  assert.match(api, /\/questions\/analyze/);
  assert.match(api, /\/question-groups/);
  assert.match(api, /Idempotency-Key/);
  // real-data.js：关键函数与真实 API 接线
  for (const fn of ['loadQuestions', 'renderQuestionSection', 'renderQuestionGroups', 'renderQuestionDetail', 'onQuestionClick']) {
    assert.match(realData, new RegExp(`function ${fn}\\(`), `real-data.js 缺少函数 ${fn}`);
  }
  assert.match(realData, /api\.analyzeQuestion\(/);
  assert.match(realData, /api\.listQuestionGroups\(/);
  assert.match(realData, /api\.reviewQuestionGroup\(/);
  assert.match(realData, /data-action="q-analyze"/);
  assert.match(realData, /data-action="q-correct"/);
  assert.match(realData, /data-action="q-confirm"/);
  // 五类结果与归类
  for (const text of ['已有内容可复用', '缺少依据', '文字/位置建议', '需要补图', '不属于商品图问题']) {
    assert.match(realData, new RegExp(text), `缺少结果类型文案：${text}`);
  }
  for (const text of ['数量/包含物', '尺寸', '规格差别', '使用方式', '物流/配送', '支付/退款', '库存/缺货', '店铺主题/页面']) {
    assert.match(realData, new RegExp(text), `缺少归类文案：${text}`);
  }
  // 诚实文案：脱敏提示、不伪造高频、不推测、确认绑定版本
  assert.match(realData, /不接客服账号/);
  assert.match(realData, /不会标注高频/);
  assert.match(realData, /不消耗生图额度/);
  assert.match(realData, /不会替你推测尺寸、用法或适配结论/);
  assert.match(realData, /PII_DETECTED/);
  assert.match(realData, /QUESTION_STALE/);
  assert.match(realData, /逐字引用已确认事实/);
  // 区块样式
  assert.match(workbenchCss, /\.q-form\s*\{/);
  assert.match(workbenchCss, /\.q-head\s*\{/);
  assert.match(workbenchCss, /\.q-block\s*\{/);
});

// 模块E06：说明图（确定性排版 + 复核/选版/替换包/采用反馈）前端契约
test('E06 说明图：项目页区块、api 端点方法、三种图种与诚实文案', async () => {
  const [realData, api, workbenchCss] = await Promise.all([
    read('real-data.js'), read('api.js'), read('workbench.css'),
  ]);
  assert.match(realData, /id="explainer-section"/, 'real-data.js 缺少说明图区块 #explainer-section');
  assert.match(realData, /void loadExplainers\(/);
  // api.js：E06 端点方法（创建带 Idempotency-Key）
  for (const fn of ['previewExplainer', 'createExplainer', 'listExplainers', 'getExplainer',
    'explainerContentUrl', 'editExplainer', 'reviewExplainer', 'selectExplainer',
    'explainerFeedback', 'explainerPackage']) {
    assert.match(api, new RegExp(`${fn}`), `api.js 缺少方法 ${fn}`);
  }
  assert.match(api, /\/explainers\/plan/);
  assert.match(api, /\/explainers`/, 'api.js 缺少项目说明图列表端点');
  assert.match(api, /\/content/, '说明图原图必须走内容路由');
  assert.match(api, /\/edits/);
  assert.match(api, /\/review/);
  assert.match(api, /\/select/);
  assert.match(api, /\/feedback/);
  assert.match(api, /\/package/);
  assert.match(api, /Idempotency-Key/, '创建说明图必须携带 Idempotency-Key 头');
  // real-data.js：关键函数与真实 API 接线
  for (const fn of ['loadExplainers', 'renderExplainerSection', 'renderExplainerPreview',
    'renderExplainerList', 'onExplainerClick', 'explainerErrorText']) {
    assert.match(realData, new RegExp(`function ${fn}\\(`), `real-data.js 缺少函数 ${fn}`);
  }
  assert.match(realData, /api\.previewExplainer\(/);
  assert.match(realData, /api\.createExplainer\(/);
  assert.match(realData, /api\.listExplainers\(/);
  assert.match(realData, /api\.reviewExplainer\(/);
  assert.match(realData, /api\.selectExplainer\(/);
  assert.match(realData, /api\.editExplainer\(/);
  assert.match(realData, /api\.explainerFeedback\(/);
  assert.match(realData, /api\.explainerPackage\(/);
  assert.match(realData, /api\.explainerContentUrl\(/);
  assert.match(realData, /api\.downloadExportUrl\(/, '替换包下载复用 downloadExportUrl');
  // 三种图种与操作入口
  for (const text of ['包装内容清单图', '尺寸说明图', 'SKU 对比图']) {
    assert.match(realData, new RegExp(text), `缺少图种文案：${text}`);
  }
  for (const action of ['ex-preview', 'ex-create', 'ex-confirm', 'ex-reject', 'ex-select',
    'ex-package', 'ex-edit', 'ex-used', 'ex-unused']) {
    assert.match(realData, new RegExp(`data-action="${action}"`), `缺少操作入口 ${action}`);
  }
  assert.match(realData, /randomUUID/, '创建说明图的幂等键由 crypto 生成');
  // 图种枚举已 map+join 成字符串，模板里再调 .join 会抛 TypeError，
  // 导致整个说明图区块退化为「正在读取说明图…」（真实浏览器验收时发现）。
  assert.match(realData, /\$\{kindOptions\}/, '图种选项应直接插入已拼接好的字符串');
  assert.doesNotMatch(realData, /kindOptions\.join\(/, 'kindOptions 已是字符串，不能再调用 join');
  // 诚实文案：确定性排版免费、不推测、底图权益、复核依据、替换需手工、反馈不换算收益
  assert.match(realData, /排版免费/);
  assert.match(realData, /不调用生图模型/);
  assert.match(realData, /不替你推测尺寸或适配结论/);
  assert.match(realData, /没过闸口的图不能免费当底图/);
  assert.match(realData, /复核必须留下依据/);
  assert.match(realData, /数量\/单位\/条目名不可改/);
  assert.match(realData, /不会自动同步平台/);
  assert.match(realData, /不代表店铺曝光、点击或转化收益/);
  // 闸口错误如实提示，不显示成成功
  for (const code of ['FACT_CONFLICT', 'REVIEW_REQUIRED', 'EXPLAINER_STALE', 'SOURCE_NOT_ENTITLED',
    'PHOTO_SOURCE_REQUIRED', 'AUDIT_FAILED']) {
    assert.match(realData, new RegExp(code), `缺少错误码处理：${code}`);
  }
  // 区块样式与移动端
  assert.match(workbenchCss, /\.ex-form\s*\{/);
  assert.match(workbenchCss, /\.ex-preview\s*\{/);
  assert.match(workbenchCss, /\.ex-rows\s*\{/);
  assert.match(workbenchCss, /\.ex-item\s*\{/);
  assert.match(workbenchCss, /\.ex-op-row\s*\{/);
  assert.match(workbenchCss, /\.ex-form, \.ex-op-row \{ flex-direction: column/);
});

// 模块E07：跨模块待办聚合（未知/失败/待复核/已采用分开）与作品依赖前端契约
test('E07 待办与依赖：首页待办四分组、检查导航、依赖面板与诚实文案', async () => {
  const [html, realData, api, workbench, workbenchCss] = await Promise.all([
    read('index.html'), read('real-data.js'), read('api.js'), read('workbench.js'), read('workbench.css'),
  ]);
  // 首页待办区块与刷新入口
  assert.match(html, /id="home-todos"/, '首页缺少待办容器 #home-todos');
  assert.match(html, /id="todo-refresh"/, '首页缺少待办刷新入口 #todo-refresh');
  assert.match(html, /id="wb-dep-body"/, '工作台缺少依赖面板容器 #wb-dep-body');
  // real-data.js：加载、渲染、点击入口
  for (const fn of ['loadTodos', 'renderTodos', 'onTodoClick']) {
    assert.match(realData, new RegExp(`function ${fn}\\(`), `real-data.js 缺少函数 ${fn}`);
  }
  assert.match(realData, /api\.todos\(\)/);
  assert.match(realData, /data-group="\$\{escapeHtml\(group\.key\)\}"/);
  assert.match(realData, /data-proj="\$\{escapeHtml\(item\.project_id\)\}"/);
  assert.match(realData, /qb:open-workbench/, '工作台类待办必须复用真实工作台入口');
  assert.match(realData, /openTruthDialog\(projectId, \{ section:/, '事实类待办必须带分组锚点');
  // 四组标签与"分开显示"语义
  for (const text of ['未知', '失败', '待复核', '已采用']) {
    assert.match(realData, new RegExp(text), `缺少待办分组文案：${text}`);
  }
  // 商品事实弹窗的「检查与更新」导航，四个区块可达
  assert.match(realData, /class="truth-nav"/);
  for (const target of ['change-section', 'check-section', 'question-section', 'explainer-section']) {
    assert.match(realData, new RegExp(`data-action="jump" data-target="${target}"`), `缺少导航入口 ${target}`);
  }
  assert.ok(realData.includes("action === 'jump'"), '导航跳转必须落在 onTruthClick 的 jump 分支');
  // 服务限制与额度如实来自服务端，不前端硬编码
  assert.match(realData, /const limits = payload\.limits \?\? \{\};/);
  assert.match(realData, /tenant_concurrency/);
  assert.match(realData, /revision_max_rounds/);
  assert.match(realData, /const budget = payload\.budget \?\? \{\};/);
  // 诚实文案：不伪装通过、重试不重复扣费、采用不代表平台曝光
  assert.match(realData, /不伪装已通过/);
  assert.match(realData, /重试只处理未成功项，不重复扣费/);
  assert.match(realData, /不代表平台曝光或转化/);
  // api.js：待办与依赖端点方法
  for (const fn of ['todos', 'listRunDependencies', 'listDeliverableDependencies',
    'addManualDependency', 'removeManualDependency']) {
    assert.match(api, new RegExp(`${fn}`), `api.js 缺少方法 ${fn}`);
  }
  assert.match(api, /\/api\/todos/);
  assert.match(api, /\/dependencies/);
  // workbench.js：依赖面板加载/渲染/人工增删
  for (const fn of ['loadDependencies', 'renderDependencies', 'renderDependencyVersion',
    'onDependencyClick', 'onDependencySubmit', 'removeManualDependency']) {
    assert.match(workbench, new RegExp(`(async )?function ${fn}\\(`), `workbench.js 缺少函数 ${fn}`);
  }
  assert.match(workbench, /api\.listDeliverableDependencies\(/);
  assert.match(workbench, /api\.addManualDependency\(/);
  assert.match(workbench, /api\.removeManualDependency\(/);
  assert.match(workbench, /data-dep-form/);
  assert.match(workbench, /data-dep-remove=/);
  assert.match(workbench, /data-dep-reload/);
  // 系统依赖不可删由服务端拒绝（DEPENDENCY_LOCKED），前端如实显示服务端错误
  assert.match(api, /DEPENDENCY_LOCKED/);
  assert.match(workbench, /系统编译，不可删除/);
  assert.match(workbench, /只登记关联，不改图、不扣费/);
  assert.match(workbench, /移除这条人工关联必须写明依据/);
  // 区块样式与 720px 移动端适配
  for (const selector of ['todo-block', 'todo-summary', 'todo-group', 'todo-item', 'truth-nav',
    'dep-version', 'dep-entry', 'dep-form', 'dep-error']) {
    assert.match(workbenchCss, new RegExp(`\\.${selector}\\s*\\{`), `缺少样式 .${selector}`);
  }
  assert.match(workbenchCss, /@media \(max-width: 720px\) \{[\s\S]*\.todo-groups \{ grid-template-columns: 1fr; \}/);
  assert.match(workbenchCss, /@media \(max-width: 720px\) \{[\s\S]*\.dep-form-row \{ flex-direction: column; \}/);
});

// ===== 批次3：L4 交互状态细化 + L3 文案收尾契约 =====
test('批次3 L4：下划线滑动标签页、状态签成因 tooltip、loading 态、44px 触达与 reduced-motion', async () => {
  const [style, workbench, wizard, m04] = await Promise.all([
    read('style.css'), read('workbench.js'), read('wizard.js'), read('m04.js'),
  ]);
  // 标签页下划线滑动（顶栏导航 + 抽屉标签）
  assert.match(style, /\.nav-item::after\{[^}]*transform:scaleX\(0\)/);
  assert.match(style, /\.nav-item\.active::after\{transform:scaleX\(1\)\}/);
  assert.match(style, /\.drawer-tabs button::after\{[^}]*transform:scaleX\(0\)/);
  assert.match(style, /\.drawer-tabs button\.selected::after\{transform:scaleX\(1\)\}/);
  // 状态签悬停显成因（data-reason 自绘 tooltip；交付项在 overflow 容器内用 title）
  assert.match(style, /\[data-reason\]:hover::after/);
  assert.match(style, /\[data-reason\]:focus-visible::after/);
  assert.match(workbench, /pill\.dataset\.reason/, '工作台状态签必须写入成因');
  assert.match(workbench, /data-reason="\$\{escapeHtml\(rowReason\)\}"/, '检查行必须带成因 tooltip');
  assert.match(workbench, /title="\$\{escapeHtml\(reason\)\}"/, '交付项必须带成因 title');
  // loading 七态：生成/锁定按钮 is-loading（spinner + finally 清理）
  assert.match(style, /\.is-loading::after\{[^}]*l4-spin/);
  assert.match(wizard, /classList\.add\('is-loading'\)/);
  assert.match(wizard, /classList\.remove\('is-loading'\)/);
  assert.match(m04, /classList\.add\('is-loading'\)/);
  assert.match(m04, /classList\.remove\('is-loading'\)/);
  // 触达面积：主按钮 44px、次按钮 40px
  assert.match(style, /\.primary\{min-height:44px\}/);
  assert.match(style, /\.secondary\{min-height:40px\}/);
  // 弹窗入场动画与分级宽度
  assert.match(style, /dialog\[open\]\{animation:l4-dialog-in/);
  assert.match(style, /\.real-dialog-wide\{width:min\(720px,94vw\)/);
  // reduced-motion 全局降级
  assert.match(style, /@media\(prefers-reduced-motion:reduce\)\{[\s\S]*transition-duration:/);
});

test('批次3 L3：概念内部化收尾（工作台/制作页/弹窗不再外露技术名词与重复说明）', async () => {
  const [html, wizard, workbench] = await Promise.all([
    read('index.html'), read('wizard.js'), read('workbench.js'),
  ]);
  for (const banned of ['事件流（SSE', '供应商成本', '额度账本', 'unknown，不能声称', 'unknown 项']) {
    assert.ok(!html.includes(banned), `index.html 不得再外露「${banned}」`);
  }
  assert.ok(html.includes('任务动态'), '「事件流」应内部化为「任务动态」');
  assert.ok(html.includes('锁定生产配置'), '「冻结生产配置」应内部化为「锁定生产配置」');
  assert.ok(html.includes('覆盖不足时结论只能标为未知'), '诚实边界保留，只是不再使用技术词 unknown');
  assert.doesNotMatch(wizard, /正在冻结配置|已冻结配置/);
  assert.doesNotMatch(wizard, /费用以服务端报价为准，本页不做估算/, '与报价条重复的费用说明应删除');
  assert.doesNotMatch(workbench, /核对商品事实/);
});

// ===== 批次4：剩余三页（我的商品/我的作品/品牌与模板）L3 收尾 + L4 状态细化契约 =====
test('批次4 L3：三页概念内部化收尾（不再外露「真实项目/真实作品/商品事实」等内部词）', async () => {
  const [html, realData] = await Promise.all([read('index.html'), read('real-data.js')]);
  for (const banned of ['正在读取真实项目', '正在读取真实作品', '真实作品 · 按商品与任务',
    '以下项目与商品事实自动保存', '请先创建真实项目', '请选择真实项目', '素材已写入真实项目']) {
    assert.ok(!html.includes(banned) && !realData.includes(banned), `不得再外露「${banned}」`);
  }
  assert.ok(html.includes('商品项目'), '「我的项目」应内部化为「商品项目」');
  assert.ok(html.includes('id="truth-title"'), '商品信息弹窗标题锚点保留');
  assert.doesNotMatch(realData, /打开商品事实失败/);
  // 演示边界横幅「商品事实已确认」按 M02 契约保留（上方 M02 测试已断言）
});

test('批次4 L4：三页卡片七态与状态签成因接线（成因来自服务端真实数据）', async () => {
  const [m03css, m04css, realData] = await Promise.all([read('m03.css'), read('m04.css'), read('real-data.js')]);
  // 项目卡/作品卡按压与触达
  assert.match(m03css, /\.real-card\{min-height:44px/);
  assert.match(m03css, /\.real-card:active\{transform:scale\(\.995\)\}/);
  assert.match(m03css, /\.real-shot:hover img\{transform:scale\(1\.02\)\}/);
  assert.match(m03css, /\.real-shot-actions \.text-button\{min-height:44px\}/);
  // 品牌与模板卡片必须有样式（此前裸奔）且带 hover/按压/焦点
  assert.match(m04css, /\.brand-kit-card:hover/);
  assert.match(m04css, /\.brand-kit-card:active/);
  assert.match(m04css, /\.brand-kit-card:focus-within/);
  assert.match(m04css, /\.template-card:hover/);
  // 状态签成因：项目卡 readiness.blockers 真实消息、作品卡 decision_reasons
  assert.match(realData, /pillReason/, '项目卡状态签必须写成因');
  assert.match(realData, /data-reason="\$\{escapeHtml\(pillReason\)\}"/);
  assert.match(realData, /decisionReason/, '作品卡检查签必须写成因');
  assert.match(realData, /data-reason="\$\{escapeHtml\(decisionReason\)\}"/);
  assert.match(realData, /readiness\.blockers/, '成因必须来自服务端 blockers，不得虚构');
});

test('M-V1 感知方向面板：结构、诚实文案、白名单与「规则不上前端」', async () => {
  const [html, wizard, style] = await Promise.all([read('index.html'), read('wizard.js'), read('style.css')]);
  assert.ok(html.includes('id="wiz-perception"'), '第 3 步缺少感知方向面板');
  assert.ok(html.includes('id="wiz-perception-cards"'), '缺少方向卡片容器');
  // 诚实边界：不得声称分析过图片
  assert.match(html, /按你填的品类和卖点匹配，不分析图片/);
  // 品类没选定（默认「其他」）时三张卡都会说「没匹配到」，必须就地给出改善路径
  assert.match(wizard, /category_unrecognized/, '缺少品类未识别时的就地引导');
  assert.match(wizard, /还没选定商品类型/, '缺少「回到上一步选商品类型」的具体指引');
  assert.match(html, /不管选哪个，商品永远是主角/);
  assert.match(wizard, /function renderPerceptionPanel/);
  assert.match(wizard, /function choosePerception/);
  assert.match(wizard, /function applyBackgroundFilter/);
  assert.match(wizard, /api\.recommendPerceptions/);
  // 推荐规则只在服务端：前端出现规则表就说明复制了一份
  assert.ok(!wizard.includes('CATEGORY_HINTS'), '前端不得复制品类倾向规则');
  assert.ok(!wizard.includes('KEYWORD_HINTS'), '前端不得复制卖点关键词规则');
  assert.match(style, /\.wiz-perception-card/);
  // AI 参考图必须带「示意图」角标，否则用户会以为自己的商品做出来就是这样
  assert.match(wizard, /wiz-perception-ai/, '缺少 AI 参考图的示意图角标');
  assert.match(style, /\.wiz-perception-ai\{/, '缺少示意图角标样式');
  assert.ok(STATIC_FILES.includes('assets/style-refs/manifest.json'), 'STATIC_FILES 缺少 manifest');
  // 白名单跟着 manifest 走：录了图却漏加白名单，线上就是 404，这里必须拦住。
  const manifest = JSON.parse(await read('assets/style-refs/manifest.json'));
  for (const item of manifest.items) {
    assert.ok(STATIC_FILES.includes(`assets/style-refs/${item.file}`), `STATIC_FILES 缺少 ${item.file}`);
  }
});

test('风格参考图清单必须满足规范：字段齐全、尺寸合规、来源如实', async () => {
  const { default: sharp } = await import('sharp');
  const { stat } = await import('node:fs/promises');
  const { PERCEPTION_KEYS } = await import('../src/perception.mjs');
  const manifest = JSON.parse(await read('assets/style-refs/manifest.json'));
  assert.equal(manifest.version, 'style-ref.1');
  assert.ok(Array.isArray(manifest.items) && manifest.items.length > 0);

  for (const item of manifest.items) {
    assert.ok(PERCEPTION_KEYS.includes(item.perception), `方向 key 非法：${item.perception}`);
    for (const field of ['category', 'file', 'source', 'license', 'added_at']) {
      assert.ok(typeof item[field] === 'string' && item[field].trim(), `${item.file} 缺少字段 ${field}`);
    }
    assert.equal(typeof item.verified, 'boolean', `${item.file} 的 verified 必须是布尔`);
    // AI 生成图与来源未核实的图都不得标成已确认可商用
    if (/AI\s*生成|未核实|未确认/.test(item.source)) {
      assert.equal(item.verified, false, `${item.file} 来源未核实却标了 verified:true`);
    }
    const path = `frontend/assets/style-refs/${item.file}`;
    const meta = await sharp(`${root}${path}`).metadata();
    const shortSide = Math.min(meta.width, meta.height);
    const ratio = meta.width / meta.height;
    assert.ok(shortSide >= 800, `${item.file} 短边 ${shortSide} < 800`);
    assert.ok(Math.abs(ratio - 1) < 0.01 || Math.abs(ratio - 0.75) < 0.01,
      `${item.file} 比例 ${ratio.toFixed(2)} 既不是 1:1 也不是 3:4`);
    const { size } = await stat(`${root}${path}`);
    assert.ok(size <= 300 * 1024, `${item.file} 体积 ${Math.round(size / 1024)}KB 超过 300KB`);
  }
});

test('M-V2 感知方向随 spec 冻结下发：specPayload 带 perception，未选时不发', async () => {
  const wizard = await read('wizard.js');
  assert.match(wizard, /if \(state\.perceptionKey\) body\.perception = state\.perceptionKey;/);
});

test('M-V3 方案卡对比与追问：结构、诚实文案、策略确认与方案随 spec 下发', async () => {
  const [html, wizard] = await Promise.all([read('index.html'), read('wizard.js')]);
  // 方案面板与追问结构
  assert.ok(html.includes('id="wiz-scheme"'), '缺少方案卡面板');
  assert.ok(html.includes('id="wiz-scheme-cards"'), '缺少方案卡容器');
  assert.ok(html.includes('id="wiz-scheme-reject-options"'), '缺少追问选项容器');
  assert.ok(html.includes('id="wiz-strategy"'), '缺少第 4 步策略确认区');
  // 诚实边界：参考图是示意不是用户的商品；反馈不冒充已执行
  assert.match(html, /参考图只是方向示意，不是你的商品/);
  assert.match(wizard, /未自动改方案/);
  assert.match(wizard, /未选视觉方向，将按模板默认风格执行/);
  // 六项追问固定选项
  for (const label of ['背景太复杂', '色彩不喜欢', '光线不自然', '商品不够突出', '整体不够高级']) {
    assert.ok(wizard.includes(`'${label}'`) || wizard.includes(`"${label}"`), `缺少追问选项「${label}」`);
  }
  // 交互函数与 spec 下发
  assert.match(wizard, /function renderSchemePanel/);
  assert.match(wizard, /function chooseScheme/);
  assert.match(wizard, /function confirmSchemeReject/);
  assert.match(wizard, /function renderStrategySummary/);
  assert.match(wizard, /if \(state\.schemeId\) body\.scheme = state\.schemeId;/);
});
