import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function read(rel) { return readFile(path.join(ROOT, rel), 'utf8'); }

test('R06 首页文案：移除绝对承诺', async () => {
  const html = await read('frontend/index.html');
  // 不应再出现这些绝对词
  assert.doesNotMatch(html, /杜绝.*乱码/, '"杜绝 AI 乱码字" 已移除，避免误导');
  assert.doesNotMatch(html, /不合规不放行/, '"不合规不放行" 已移除');
  assert.doesNotMatch(html, /生成不变形/, '"生成不变形" 已移除');
  // 新文案应诚实
  assert.match(html, /主体区域检查与本地合成/);
  assert.match(html, /实际效果需验收/);
  assert.match(html, /未核验项如实说明/);
  assert.match(html, /不强求.*一定能上架/);
});

test('R06 导航清晰：我的商品 / 品牌与模板 / 我的作品', async () => {
  const html = await read('frontend/index.html');
  assert.match(html, /data-view="home">首页/);
  assert.match(html, /data-view="projects">我的商品/);
  assert.match(html, /data-view="assets">我的作品/);
  assert.match(html, /data-view="library">品牌与模板/);
});

test('R06 品牌配方 + 模板库页面真实渲染容器存在', async () => {
  const html = await read('frontend/index.html');
  // library-view 不再是"规划中"
  assert.doesNotMatch(html, /<span class="status-pill neutral">规划中<\/span>/);
  assert.match(html, /id="brand-kit-list"/);
  assert.match(html, /id="library-template-list"/);
  assert.match(html, /id="brand-kit-new"/);
  // m04.js 里必须有 renderLibraryView
  const js = await read('frontend/m04.js');
  assert.match(js, /function renderLibraryView/);
  assert.match(js, /qb:view-change/);
});

test('R06 首页分流：真实项目容器存在', async () => {
  const html = await read('frontend/index.html');
  assert.match(html, /id="home-real-projects"/);
  assert.match(html, /id="home-demo-projects"/);
  // real-data.js 有 renderHomeRealProjects
  const js = await read('frontend/real-data.js');
  assert.match(js, /function renderHomeRealProjects/);
  assert.match(js, /open-workbench/);
});

test('R06 workbench 窄屏规则', async () => {
  const css = await read('frontend/workbench.css');
  // 至少一个窄屏媒体查询
  assert.match(css, /@media\s*\(max-width/);
});

test('R06 setView 派发 qb:view-change', async () => {
  const js = await read('frontend/app.js');
  assert.match(js, /qb:view-change/);
  assert.match(js, /CustomEvent.*view-change/);
});
