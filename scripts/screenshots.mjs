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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) { this.socket = socket; this.id = 0; this.pending = new Map(); this.onEvent = null; }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    const client = new Cdp(socket);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method && client.onEvent) { client.onEvent(message); return; }
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

/**
 * 每次用全新的临时 profile 和空闲调试端口。
 * 固定 profile 时，上一次异常退出残留的 Chrome 会占住端口与单例锁，
 * 新进程把调试请求交接给旧浏览器，后续 Page.navigate 会挂起（曾出现 CDP 超时）。
 */
async function launchChrome() {
  const profile = await mkdtemp(path.join(ROOT, 'runtime', 'chrome-07-'));
  const port = await findDebugPort(9400);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--hide-scrollbars', '--force-device-scale-factor=1',
    // 无 GPU 时合成器容易卡住，截图会停在旧帧（曾出现多张截图 sha256 相同）
    '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1440,1080', 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise(resolve => chrome.once('exit', resolve));
  let target = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(item => item.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* 等待调试端口 */ }
    await sleep(250);
  }
  if (!target) { chrome.kill(); throw new Error('Chrome 未在 20 秒内提供页面调试目标'); }
  return { chrome, exited, target, profile };
}

/** 找一个没有服务监听的本地端口，避免接上残留浏览器。 */
async function findDebugPort(start) {
  for (let port = start; port < start + 40; port += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) });
    } catch {
      return port;
    }
  }
  throw new Error('找不到可用的 Chrome 调试端口');
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

/** 两个 SKU 档案：ACC-01 标准装 / ACC-02 双支装（含包含物，供核对与说明图截图）。 */
function skuPayload() {
  return {
    confirm: true,
    skus: [
      {
        sku_code: 'ACC-01', label: '标准装', confirmed: true,
        attributes: [{ key: '容量', value: '50', unit: 'g' }, { key: '核心卖点', value: '舒缓维稳' }],
        contents: [{ item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' }],
      },
      {
        sku_code: 'ACC-02', label: '双支装', confirmed: true,
        attributes: [{ key: '容量', value: '100', unit: 'g' }],
        contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
      },
    ],
  };
}

/** 变更单的视觉核对：与前端一致，逐项留依据。 */
async function passVisualChecks(request, change) {
  for (const item of change.impact_items.filter(entry => entry.status === 'done' && entry.visual_check === 'required')) {
    const checked = await request(`/api/changes/${change.id}/items/${item.id}/visual-check`, {
      method: 'POST', body: { reason: '界面截图预置：已核对画面与更新后事实一致' },
    });
    if (checked.status !== 200) throw new Error(`视觉核对失败：${JSON.stringify(checked.json)}`);
  }
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
  const profile = await request(`/api/projects/${project.id}/skus`, {
    method: 'PUT', body: { base_version: 0, ...skuPayload() },
  });
  if (profile.status !== 201) throw new Error(`SKU 档案失败：${JSON.stringify(profile.json)}`);
  const skuIds = Object.fromEntries(profile.json.sku_profile.skus.map(item => [item.sku_code, item.id]));
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

  // E02 人工依赖：给卖点图补一条人工关联，依赖面板同时展示系统编译与人工条目的区别
  const currentVersions = (await request(`/api/runs/${run.id}/versions`)).json.versions;
  const benefitCurrent = currentVersions.find(item => item.current && item.deliverable_id === 'benefit');
  await request(`/api/runs/${run.id}/deliverables/benefit/dependencies`, {
    method: 'POST',
    body: { version_id: benefitCurrent.id, reason: '截图预置：商家确认卖点图与适用肤质有关', entries: [{ kind: 'fact', ref: '适用肤质' }] },
  });

  // 先导出一次，供变更后生成替换待办
  const exported = await request(`/api/runs/${run.id}/exports`, { method: 'POST', body: { scope: 'complete' } });
  if (exported.status !== 201) throw new Error(`导出失败：${JSON.stringify(exported.json)}`);

  // E05 售前问题：数量类 → 需要包装清单图；确认后进入已采用
  const question = await request(`/api/projects/${project.id}/questions/analyze`, {
    method: 'POST', headers: { 'Idempotency-Key': 'shots-question' },
    body: { text: '收到之后有几个，配件包含哪些', sku_id: skuIds['ACC-01'] },
  });
  if (question.status !== 201) throw new Error(`问题分析失败：${JSON.stringify(question.json)}`);
  await request(`/api/question-groups/${question.json.group.id}/review`, { method: 'POST', body: { action: 'confirm' } });

  // E04 SKU 核对：未配置 OCR → 视觉未知待复核
  await request(`/api/projects/${project.id}/sku-checks`, { method: 'POST', body: {} });

  // E03 商品变更：只改文字，确定性重排免费；完成后旧导出生成替换待办
  const newFacts = [
    { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
    { key: '核心卖点', value: '舒缓维稳 持久水润', critical: false, confirmed: true, source_type: 'user_input' },
    { key: '适用肤质', value: '干敏肌', critical: false, confirmed: true, source_type: 'user_input' },
  ];
  const change = await request(`/api/projects/${project.id}/changes`, {
    method: 'POST', headers: { 'Idempotency-Key': 'shots-change' },
    body: { base_truth_version: 1, facts: newFacts, critical_text: [{ text: '月光舒缓' }] },
  });
  if (change.status !== 201) throw new Error(`变更确认失败：${JSON.stringify(change.json)}`);
  const executed = await request(`/api/changes/${change.json.change.id}/execute`, { method: 'POST', body: {} });
  if (executed.status !== 200) throw new Error(`变更执行失败：${JSON.stringify(executed.json)}`);
  await passVisualChecks(request, executed.json.change);

  // E06 说明图：在事实更新之后创建，避免一生成就过期；复核后即 active
  const explainer = await request(`/api/projects/${project.id}/explainers`, {
    method: 'POST', headers: { 'Idempotency-Key': 'shots-explainer' },
    body: { kind: 'packing_list', sku_id: skuIds['ACC-01'] },
  });
  if (explainer.status !== 201) throw new Error(`说明图失败：${JSON.stringify(explainer.json)}`);
  const reviewedExplainer = await request(`/api/explainers/${explainer.json.explainer.id}/review`, {
    method: 'POST', body: { action: 'confirm', reason: '截图预置：逐项核对数量与单位一致' },
  });
  if (reviewedExplainer.status !== 200) throw new Error(`说明图复核失败：${JSON.stringify(reviewedExplainer.json)}`);

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
    await cdp.send('Runtime.enable');
    cdp.onEvent = message => {
      if (message.method === 'Runtime.exceptionThrown') {
        console.log('页面异常', message.params.exceptionDetails?.exception?.description?.slice(0, 600));
      }
    };
    const [name, value] = session.split('=');
    await cdp.send('Network.setCookie', { name, value, url: base, path: '/', httpOnly: true, sameSite: 'Lax' });

    // 同一 #hash 的导航不会触发重载，先回空白页强制整页重开，截图状态才干净。
    // headless 偶发 Page.navigate 卡住（渲染进程忙于上一张截图），这里重试并中止加载。
    const navigate = async target => {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await cdp.send('Page.navigate', { url: 'about:blank' });
          await sleep(200);
          await cdp.send('Page.navigate', { url: target });
          // 模块脚本执行完才会绑定点击事件与渲染；只 sleep 会在负载高时点到空节点，
          // 截出与上一张完全相同（甚至没打开弹窗）的旧画面。
          for (let attempt = 0; attempt < 150; attempt += 1) {
            await sleep(100);
            const ready = await cdp.send('Runtime.evaluate', {
              expression: 'document.readyState === "complete"', returnByValue: true,
            });
            if (ready.result.value) break;
          }
          await sleep(400);
          return;
        } catch (error) {
          lastError = error;
          console.log(`导航重试 ${attempt + 1}：${target}`);
          try { await cdp.send('Page.stopLoading'); } catch { /* 连接已断时忽略 */ }
          await sleep(500);
        }
      }
      throw new Error(`导航失败：${target}（${lastError.message}）`);
    };

    const shoot = async (file, { view, mobile = false, width, height, script, settle = 1_400 }) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: width ?? (mobile ? 390 : 1440), height: height ?? (mobile ? 844 : 1_080),
        deviceScaleFactor: 1, mobile,
      });
      await navigate(`${base}/#${view}`);
      if (script) await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true });
      await sleep(settle);
      // 等两帧再截，避免合成器还没提交新画面（会出现整张图与上一张完全相同）
      await cdp.send('Runtime.evaluate', {
        expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        awaitPromise: true,
      });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(shot.data, 'base64');
      await writeFile(path.join(SHOTS, file), bytes);
      console.log(`已截图 ${file}（${bytes.length} 字节，sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}）`);
    };

    await shoot('01-home-desktop.png', { view: 'home' });
    await shoot('22-work-delivery.png', {
      view: 'home', settle: 1_800,
      script: `document.getElementById('work-delivery')?.scrollIntoView({ block: 'start' })`,
    });
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

    // E03—E07：商品事实弹窗的检查与更新分区（真实点击导航，非静态拼接）
    // 说明图区块是异步加载的：必须等它渲染完再定位，否则跳转落在"正在读取"的短内容上，
    // 四张分区截图会停在同一个最大滚动位置（曾出现 13/14 像素完全一致）。
    const truthScript = section => `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      // 商品卡片来自异步列表请求，先等真实按钮出现再点，避免空点
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await wait(100);
        if (document.querySelector('[data-action="truth"]')) break;
      }
      document.querySelector('[data-action="truth"]')?.click();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await wait(100);
        const area = document.querySelector('#explainer-section');
        if (area && area.querySelector('.ex-form') && !area.querySelector('.loading-line')) break;
      }
      await wait(300);
      const target = document.getElementById('${section}');
      target?.scrollIntoView({ behavior: 'auto', block: 'start' });
      await wait(400);
      target?.scrollIntoView({ behavior: 'auto', block: 'start' });
    })()`;
    await shoot('11-truth-change.png', { view: 'home', script: truthScript('change-section'), settle: 2_000 });
    await shoot('12-truth-sku-check.png', { view: 'home', script: truthScript('check-section'), settle: 2_000 });
    await shoot('13-truth-question.png', { view: 'home', script: truthScript('question-section'), settle: 2_000 });
    await shoot('14-truth-explainer.png', { view: 'home', script: truthScript('explainer-section'), settle: 2_000 });
    // E02/E07：作品依赖面板（系统编译 + 人工关联）
    await shoot('15-workbench-dependencies.png', {
      view: 'home', settle: 2_000,
      script: `(async () => {
        window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: '${seeded.projectId}' } }));
        await new Promise(resolve => setTimeout(resolve, 1600));
        document.querySelector('[data-deliverable-id="benefit"]')?.click();
        await new Promise(resolve => setTimeout(resolve, 1600));
        document.querySelector('#wb-dep-body')?.scrollIntoView({ block: 'start' });
      })()`,
    });
    // 手机：首页待办与说明图主路径
    await shoot('16-home-mobile.png', {
      view: 'home', mobile: true, settle: 1_400,
      script: `(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await wait(100);
          if (document.querySelector('#home-todos .todo-group')) break;
        }
        await wait(400);
        const node = document.getElementById('home-todos');
        if (node) {
          // 顶部有吸顶导航，留出高度，避免分组标题被遮住
          window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 70);
          await wait(300);
          window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 70);
        }
      })()`,
    });
    await shoot('17-truth-explainer-mobile.png', { view: 'home', mobile: true, script: truthScript('explainer-section'), settle: 2_200 });
    await shoot('08-home-mobile.png', { view: 'home', mobile: true });
    await shoot('09-workbench-mobile.png', { view: 'home', mobile: true, settle: 2_000, script: `window.dispatchEvent(new CustomEvent('qb:open-workbench', { detail: { projectId: '${seeded.projectId}' } }))` });

    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1_080, deviceScaleFactor: 1, mobile: false });
    await navigate(`${base}/#assets`);
    await sleep(1_600);
    const authShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(SHOTS, '10-auth-required.png'), Buffer.from(authShot.data, 'base64'));
    console.log('已截图 10-auth-required.png');

    // 未登录新用户首页：桌面、手机与 320px 窄屏，以及四步演示结束后的演示包弹窗
    await shoot('18-guest-home-desktop.png', { view: 'home' });
    await shoot('19-guest-home-mobile.png', { view: 'home', mobile: true });
    await shoot('20-guest-home-320.png', { view: 'home', mobile: true, width: 320, height: 844 });
    await shoot('21-guest-demo-package.png', {
      view: 'home',
      settle: 1_800,
      script: `(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 4; i += 1) { document.querySelector('#hp-next')?.click(); await wait(300); }
        await wait(400);
      })()`,
    });

    console.log(`\n截图完成：${SHOTS}`);
    console.log(`预览入口（截图时使用的本地地址，服务已关闭）：${base}/#home`);
  } finally {
    cdp?.close();
    if (chromeHandle) {
      chromeHandle.chrome.kill('SIGKILL');
      await Promise.race([chromeHandle.exited, sleep(2_000)]);
      await rm(chromeHandle.profile, { recursive: true, force: true }).catch(() => {});
    }
    try { await app.close(); } catch { /* 忽略关闭异常 */ }
    try { await rm(storeDir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  }
}

main().catch(error => {
  console.error(`截图失败：${error.message}`);
  process.exitCode = 1;
});
