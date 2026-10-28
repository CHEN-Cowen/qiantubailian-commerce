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
  const files = ['app.js', 'real-data.js', 'workbench.js', 'm04.js', 'm05.js'];
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
