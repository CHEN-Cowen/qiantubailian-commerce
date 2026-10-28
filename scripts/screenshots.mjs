/**
 * 模块 06/07：关键页面截图（真实 Chrome + CDP，零依赖）。
 *
 * 生成桌面与移动端截图，保存到 docs/experience-optimization/screenshots/。
 * 数据由脚本通过真实 HTTP 预置（注册、商品、任务、文字修改），
 * 图片来自 scripts/fixture-provider.mjs：不是真实模型出图，仅用于界面验收。
 *
 * 运行：node scripts/screenshots.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { createMockWechatPaymentProvider } from '../src/providers/wechat.mjs';
import { createFixtureProvider } from './fixture-provider.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = path.join(ROOT, 'docs', 'experience-optimization', 'screenshots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9337;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) { this.socket = socket; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    const client = new Cdp(socket);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = message.id && client.pending.get(message.id);
      if (!pending) return;
      client.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
    });
    return client;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`)); }, 30_000);
    });
  }
  close() { this.socket.close(); }
}

async function launchChrome() {
  const profile = path.join(ROOT, 'runtime', 'chrome-profile-07');
  await mkdir(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1440,1080', 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise(resolve => chrome.once('exit', resolve));
  let target = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find(item => item.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* 等待调试端口 */ }
    await sleep(250);
  }
  if (!target) { chrome.kill(); throw new Error('Chrome 未在 20 秒内提供页面调试目标'); }
  return { chrome, exited, target };
}

function createClient(base) {
  const state = { cookie: '', csrf: '' };
  const request = async (route, { method = 'GET', body, headers = {}, useCsrf = true } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(state.cookie ? { Cookie: state.cookie } : {}),
        ...(useCsrf && state.csrf ? { 'x-csrf-token': state.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) state.cookie = setCookie.split(';')[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') ?? '';
    const json = type.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null;
    if (json?.csrf_token) state.csrf = json.csrf_token;
    return { status: response.status, json, body: buffer };
  };
  return { request, state };
}

async function waitTerminal(request, runId) {
  for (let attempt = 0; attempt < 1_800; attempt += 1) {
    const run = (await request(`/api/runs/${runId}`)).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) {
      if (run.status !== 'completed') throw new Error(`任务未完成：${run.status}`);
      return run;
    }
    await sleep(50);
  }
  throw new Error('任务等待超时');
}

async function reviewToPublishable(request, reportId) {
  const report = (await request(`/api/quality-reports/${reportId}`)).json.report;
  if (report.decision === 'publishable') return report;
  const decisions = (report.checks ?? [])
    .filter(check => check.required && check.status === 'unknown' && check.adjudicable)
    .map(check => ({ code: check.code, decision: 'pass', reason: '界面截图预置数据的人工复核', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await request(`/api/quality-reports/${reportId}/reviews`, { method: 'POST', body: { decisions } });
  if (reviewed.status !== 200) throw new Error(`人工复核失败：${JSON.stringify(reviewed.json)}`);
  return reviewed.json.report;
}

async function subjectPng() {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#eef1ea' } })
    .composite([{
      input: await sharp({ create: { width: 380, height: 560, channels: 3, background: '#8b6a55' } }).png().toBuffer(),
      left: 350, top: 440,
    }])
    .png().toBuffer();
}

/** 预置一个完整商品项目：3 张成品、一次文字修改与版本历史。 */
async function seed(request) {
  const email = `shots-${Date.now()}@example.test`;
  const registered = await request('/api/auth/register', {
    method: 'POST', body: { email, password: 'ShotsAccount2026!', display_name: '视觉验收' },
  });
  if (registered.status !== 201) throw new Error(`注册失败：${JSON.stringify(registered.json)}`);
  const order = await request('/api/billing/orders', { method: 'POST', body: { plan_id: 'plan_taster_10' } });
  if (order.status !== 201) throw new Error(`演示订单失败：${JSON.stringify(order.json)}`);
  await request(`/api/billing/orders/${order.json.order.id}/settle`, { method: 'POST' });

  const project = (await request('/api/projects', {
    method: 'POST',
    body: { name: '月光舒缓面霜', sku: 'YC-2026-01', category: '面霜', platform: '天猫' },
  })).json.project;
  const uploaded = await request(`/api/projects/${project.id}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: await subjectPng(), headers: { 'Content-Type': 'image/png' },
  });
  if (uploaded.status !== 201) throw new Error(`素材上传失败：${JSON.stringify(uploaded.json)}`);
  const truth = await request(`/api/projects/${project.id}/truth-versions`, {
    method: 'POST',
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
        { key: '适用肤质', value: '干敏肌', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  if (truth.status !== 201) throw new Error(`商品事实写入失败：${JSON.stringify(truth.json)}`);

  const preview = await request(`/api/projects/${project.id}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  await request(`/api/projects/${project.id}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  const quote = await request('/api/quotes', { method: 'POST', body: { project_id: project.id } });
  const created = await request('/api/runs', {
    method: 'POST',
    body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
    headers: { 'Idempotency-Key': 'seed-run' },
  });
  const runId = created.json?.run?.id;
  if (!runId) throw new Error(`任务创建失败：${JSON.stringify(created.json)}`);
  const run = await waitTerminal(request, runId);
  for (const deliverable of run.deliverables.filter(item => item.active_version_id)) {
    await reviewToPublishable(request, deliverable.quality_report_id);
  }

  const benefit = run.deliverables.find(item => item.deliverable_id === 'benefit');
  const layers = (await request(`/api/runs/${run.id}/deliverables/benefit/text-layers`)).json;
  const editable = layers.layers.find(item => item.editable_text === true);
  if (editable) {
    const edited = await request(`/api/runs/${run.id}/deliverables/benefit/text-edits`, {
      method: 'POST',
      body: { base_version_id: benefit.active_version_id, edits: [{ id: editable.id, text: '舒缓维稳 · 持久水润' }] },
    });
    if (edited.status === 200) {
      await reviewToPublishable(request, edited.json.report.id);
      await request(`/api/runs/${run.id}/versions/${edited.json.version.id}/activate`, { method: 'POST' });
    }
  }
  return { projectId: project.id, runId: run.id };
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const storeDir = await mkdtemp(path.join(ROOT, 'runtime', 'shots-07-'));
  const app = createApp({
    port: 0, storeDir, demoMode: false, initialCredits: 0, tickMs: 10,
    provider: createFixtureProvider(), paymentProvider: createMockWechatPaymentProvider(),
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  let chromeHandle;
  let cdp;
  try {
    const client = createClient(base);
    const seeded = await seed(client.request);
    const session = client.state.cookie;

    chromeHandle = await launchChrome();
    cdp = await Cdp.connect(chromeHandle.target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    const [name, value] = session.split('=');
    await cdp.send('Network.setCookie', { name, value, url: base, path: '/', httpOnly: true, sameSite: 'Lax' });

    // 同一 #hash 的导航不会触发重载，先回空白页强制整页重开，截图状态才干净
    const navigate = async target => {
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await sleep(200);
      await cdp.send('Page.navigate', { url: target });
      await sleep(600);
    };

    const shoot = async (file, { view, mobile = false, script, settle = 1_400 }) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: mobile ? 390 : 1440, height: mobile ? 844 : 1_080,
        deviceScaleFactor: 1, mobile,
      });
      await navigate(`${base}/#${view}`);
      if (script) await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true });
      await sleep(settle);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(shot.data, 'base64');
      await writeFile(path.join(SHOTS, file), bytes);
      console.log(`已截图 ${file}（${bytes.length} 字节，sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}）`);
    };

    await shoot('01-home-desktop.png', { view: 'home' });
    await shoot('02-create-wizard.png', { view: 'create' });
    await shoot('03-projects.png', { view: 'projects' });
    await shoot('04-workspace.png', { view: 'assets' });
    await shoot('05-brand-and-templates.png', { view: 'library' });
    await shoot('06-workbench.png', {
      view: 'home',
      script: `window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: '${seeded.projectId}' } }))`,
      settle: 2_000,
    });
    // 文字修改面板需要工作台已渲染完成后再点击，单独补一张
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1_080, deviceScaleFactor: 1, mobile: false });
    await navigate(`${base}/#home`);
    await cdp.send('Runtime.evaluate', {
      expression: `window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: '${seeded.projectId}' } }))`,
    });
    await sleep(2_000);
    // 卖点图才有可编辑文案与只读包装文字，先选中它再打开修改面板
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-deliverable-id="benefit"]')?.click()`,
    });
    await sleep(800);
    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#wb-edit-open')?.click()` });
    await sleep(1_400);
    const editShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(SHOTS, '07-workbench-text-edit.png'), Buffer.from(editShot.data, 'base64'));
    console.log('已截图 07-workbench-text-edit.png');

    await shoot('08-home-mobile.png', { view: 'home', mobile: true });
    await shoot('09-workbench-mobile.png', { view: 'home', mobile: true, settle: 2_000, script: `window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: '${seeded.projectId}' } }))` });

    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1_080, deviceScaleFactor: 1, mobile: false });
    await navigate(`${base}/#assets`);
    await sleep(1_600);
    const authShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(SHOTS, '10-auth-required.png'), Buffer.from(authShot.data, 'base64'));
    console.log('已截图 10-auth-required.png');

    console.log(`\n截图完成：${SHOTS}`);
    console.log(`预览入口（截图时使用的本地地址，服务已关闭）：${base}/#home`);
  } finally {
    cdp?.close();
    if (chromeHandle) {
      chromeHandle.chrome.kill('SIGKILL');
      await Promise.race([chromeHandle.exited, sleep(2_000)]);
    }
    try { await app.close(); } catch { /* 忽略关闭异常 */ }
    try { await rm(storeDir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  }
}

main().catch(error => {
  console.error(`截图失败：${error.message}`);
  process.exitCode = 1;
});
