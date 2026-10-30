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

test('首屏两个入口同级，规格与文案符合原型', async () => {
  const html = await read('frontend/index.html');
  assert.match(html, /id="hp-update"[^>]*>更新商品图</);
  assert.match(html, /id="hp-create"[^>]*>首次制作商品图</);
  const css = await read('frontend/home.css');
  assert.match(css, /\.hp-entry[^}]*width:\s*180px/s);
  assert.match(css, /\.hp-entry[^}]*height:\s*48px/s);
  assert.match(css, /#DEECA6/);
  assert.match(css, /#213D2B/);
  assert.match(css, /#D0E48C/);
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
