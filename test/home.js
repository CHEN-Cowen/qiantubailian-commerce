import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function read(rel) { return readFile(path.join(ROOT, rel), 'utf8'); }

test('首页分流：未登录新用户首页与已登录工作首页同时存在', async () => {
  const html = await read('frontend/index.html');
  assert.match(html, /data-view="home">首页/);
  assert.match(html, /id="guest-home"/);
  assert.match(html, /id="work-home"/);
  assert.match(html, /id="home-loading"/);
  const home = await read('frontend/home.js');
  assert.match(home, /__qtbAuthStateReady/);
  assert.match(home, /guest.*hidden/);
  assert.match(home, /work.*hidden/);
});

test('首页提供正式工作台入口和独立的静态香薰样片', async () => {
  const html = await read('frontend/index.html');
  assert.match(html, /data-hp-workspace>进入工作台/);
  // V0.2 主标题分两行渲染（用商品实拍，<br>做一套上架图），完整主张仍须在页面上
  assert.match(html, /用商品实拍，[\s\S]{0,120}做一套上架图/);
  assert.match(html, /柑橘藤条香薰 · 全套上架图/);
  const server = await read('src/server.mjs');
  const photos = [...new Set([...html.matchAll(/src="(assets\/demo\/diffuser-[a-z]+\.jpg)"/g)].map(match => match[1]))];
  assert.equal(photos.length, 4);
  for (const photo of photos) {
    assert.ok(server.includes(`'${photo}'`));
    const bytes = await readFile(path.join(ROOT, 'frontend', photo));
    assert.deepEqual([...bytes.subarray(0, 3)], [255, 216, 255]);
  }
});

test('未登录入口先保留意图并打开登录闸口，登录后继续', async () => {
  const home = await read('frontend/home.js');
  assert.match(home, /sessionStorage\.setItem\(INTENT_KEY/);
  assert.match(home, /openAuthGate\(/);
  assert.match(home, /takeIntent\(/);
  assert.match(home, /intent === 'update'/);
  assert.match(home, /intent === 'create'/);
  // 更新入口必须落到真实商品选择，没有商品时给出建立商品档案的入口
  assert.match(home, /openProjectPicker/);
  assert.match(home, /data-home-create/);
  const auth = await read('frontend/auth.js');
  assert.match(auth, /export function openAuthGate/);
  // 生产未登录不再自动弹闸口
  const bootBody = auth.slice(auth.indexOf('async function boot()'));
  assert.doesNotMatch(bootBody, /buildGate\(/);
});

test('四步演示只在内存中运行，不写真实商品、不调用模型', async () => {
  const home = await read('frontend/home.js');
  assert.match(home, /const DEMO_DATA = \[/);
  assert.match(home, /renderDemo/);
  // 演示区不得出现真实写入/生成/上传调用
  const demoSection = home.slice(home.indexOf('const DEMO_DATA'), home.indexOf('/* ---------- 入口意图'));
  assert.doesNotMatch(demoSection, /api\.(create|generate|upload|run|quote|export)/);
  assert.match(home, /不调用生成模型|不调用生图模型/);
});

test('工作首页指标使用真实口径，失败显示 — 而不是 0', async () => {
  const js = await read('frontend/real-data.js');
  assert.match(js, /async function loadChangeStats/);
  assert.match(js, /Promise\.allSettled/);
  assert.match(js, /受变更影响/);
  assert.match(js, /需要补实拍/);
  assert.match(js, /待人工复核/);
  assert.match(js, /待店铺替换/);
  assert.match(js, /读取失败，无法统计/);
  assert.match(js, /指标来自不同记录，可能重叠，不做合计/);
  // 不得写死原型演示数字 3/1/2/1
  assert.doesNotMatch(js, /\['受变更影响',\s*3/);
  // 待办与交付失败时不渲染空成功
  assert.match(js, /function workErrorMarkup/);
  assert.match(js, /function renderWorkFailure/);
  assert.match(js, /function renderDeliveries/);
  assert.match(js, /已导出 · 待你在店铺替换/);
  assert.match(js, /你已确认替换 · 非平台回执/);
  assert.match(js, /导出不完整/);
});

test('账户切换先清空旧数据，避免残留上一账户的指标', async () => {
  const js = await read('frontend/real-data.js');
  assert.match(js, /function resetWorkHome/);
  assert.match(js, /resetWorkHome\(\);[\s\S]{0,200}api\.listProjects/);
});

test('演示身份与深链不被弹回首页，生产未登录保留原 hash 再登录', async () => {
  const home = await read('frontend/home.js');
  const applyAuth = home.slice(home.indexOf('function applyAuth'), home.indexOf('async function boot'));
  // 演示身份（NODE_ENV≠production 默认开启）可直接进入 #projects / #create 等深链
  assert.match(applyAuth, /demoMode/, 'applyAuth 必须识别演示身份');
  assert.match(applyAuth, /if \(authenticated \|\| demoMode\) return;/);
  // 不得再无条件下改写 hash 弹回首页
  assert.doesNotMatch(applyAuth, /navigateHome\(\)/, 'applyAuth 不得强制弹回首页');
  assert.doesNotMatch(home, /function navigateHome\(\)/);
  // 生产未登录访问受保护深链：保留 hash，仅打开登录闸口，reload 后回到原页面
  assert.match(applyAuth, /location\.hash\.replace\(\/\^#\/, ''\)/);
  assert.match(applyAuth, /openAuthGate\(/);
});

test('访客态非首页视图保留容器内边距，首页样例仍可满宽', async () => {
  const css = await read('frontend/home.css');
  // 向导 / 项目 / 作品 / 工作台恢复与登录态一致的容器内边距，避免内容贴边、h1 被裁切
  assert.match(
    css,
    /body\.is-guest main > \.view:not\(#home-view\)[\s\S]{0,220}max-width: 1440px; margin: 0 auto; padding: 42px 42px 60px;/,
    '非首页视图必须有容器内边距',
  );
  assert.match(css, /body\.is-guest main > \.project-view[\s\S]{0,120}padding: 42px 42px 60px;/, '项目详情视图必须有容器内边距');
  assert.match(css, /@media \(max-width: 760px\) \{\s*body\.is-guest main > \.view:not\(#home-view\)[\s\S]{0,180}padding: 22px 16px 48px;/, '窄屏必须保留水平内边距');
});

test('静态资源白名单包含首页文件，且不包含原型文件', async () => {
  const server = await read('src/server.mjs');
  assert.match(server, /'home\.js'/);
  assert.match(server, /'home\.css'/);
  assert.doesNotMatch(server, /homepage-prototype\.html'/);
});

test('首页测试已加入 npm test 列表', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.match(pkg.scripts.test, /test\/home\.js/);
});

test('V0.2 首页：区块结构、常驻演示与可降级动效', async () => {
  const html = await read('frontend/index.html');
  // 六区块骨架与导航锚点
  for (const selector of ['class="v2-hero"', 'class="v2-samples"', 'class="v2-update"', 'class="v2-demo"', 'class="v2-band"', 'class="v2-footer"']) {
    assert.ok(html.includes(selector), `缺少 V0.2 区块 ${selector}`);
  }
  for (const anchor of ['id="scenes"', 'id="evidence"', 'id="start"']) assert.ok(html.includes(anchor));
  // 四步演示常驻展示（不再折叠在 <details> 里），诚实边界文案保留
  assert.ok(!html.includes('查看商品规格变更演示'), 'V0.2 演示必须常驻，不得折叠');
  // 商业化话术：不出现「示例」导航与免责小字；演示区直接写明四步名称
  assert.doesNotMatch(html, /样片示例|更新示例|示例项目/);
  assert.doesNotMatch(html, /不调用模型、不扣额度、不写真实商品/);
  assert.match(html, /确认变化 → 查看影响 → 按需处理 → 复核交付/);
  // 演示数据：底部推进按钮不带序号与箭头
  const home2 = await read('frontend/home.js');
  assert.doesNotMatch(home2, /next: '[①②③④]/);
  assert.doesNotMatch(home2, /next: '[^']*→'/);
  // 四步按钮严格等高等宽：四等列网格 + 固定高 + 统一边框/字重，选中态只换颜色
  const css2 = await read('frontend/home.css');
  assert.match(css2, /\.hp-steps \{[\s\S]{0,160}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css2, /\.hp-step \{[\s\S]{0,220}height: 36px;/);
  assert.match(css2, /\.v2-demo \.hp-step \{[\s\S]{0,160}font-weight: 600;[\s\S]{0,160}border-color: rgba\(255, 255, 255, \.16\)/);
  // 步骤标签不再带「1./2./3./4.」数字前缀，四个按钮内容等长
  assert.doesNotMatch(home2, /\$\{i \+ 1\}\. /);
  // 动效钩子：轮播、缩略、更新叙事影响卡
  assert.match(html, /id="hp-carousel"/);
  assert.match(html, /id="hp-carousel-badge"/);
  assert.match(html, /data-hp-scene="impact"/);

  const home = await read('frontend/home.js');
  // 轮播 crossfade + 徽标切换
  assert.match(home, /CAROUSEL_LABELS/);
  assert.match(home, /setInterval\(\(\) => show\(index \+ 1\), 3000\)/);
  // 四步自动播放 3s/步、循环推进
  assert.match(home, /renderDemo\(\(demo\.step \+ 1\) % DEMO_DATA\.length\), 3200\)/);
  // fade-up + 全部动效在 reduced-motion 下停用
  assert.match(home, /prefersReducedMotion/);
  assert.match(home, /IntersectionObserver/);
  assert.match(home, /classList\.add\('v2-anim'\)/);

  const css = await read('frontend/home.css');
  // V0.2 深紫渐变 Hero 与点缀黄同源令牌
  assert.match(css, /\.v2-hero \{[\s\S]{0,120}#1A0842 0%, #150736 54%, #2A0E66 100%/);
  assert.match(css, /\.v2-kicker \{[\s\S]{0,200}var\(--accent-yellow\)/);
  // reduced-motion 降级：入场动画停用、样片淡切停用
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\.v2-anim \[data-reveal\]/);
  // fade-up 必须由 JS 开启，脚本失败时内容默认可见
  assert.doesNotMatch(css, /^\[data-reveal\] \{ opacity: 0/m);
});
