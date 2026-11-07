/**
 * M08：产品重构端到端界面验收（真实 Chrome + CDP，零依赖）。
 *
 * 走完整的新向导链路：上传原图 → 商品信息问题卡与卖点候选 → 方案/背景 → 交付与费用
 * → 真实报价 → 提交 → 同页任务追踪 → 工作台编辑/下载入口。
 *
 * 图片与生成使用 scripts/fixture-provider.mjs（不是真实模型出图），
 * 只验证界面、接口、账本与权限闭环，不冒充真实模型效果。
 *
 * 运行：node scripts/verify-rebuild-ui.mjs
 * 证据：docs/product-rebuild/evidence/
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { createMockWechatPaymentProvider } from '../src/providers/wechat.mjs';
import { createFixtureProvider } from './fixture-provider.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE = path.join(ROOT, 'docs', 'product-rebuild', 'evidence');
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
    const type = response.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const json = type.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null;
    if (json?.csrf_token) state.csrf = json.csrf_token;
    return { status: response.status, json, body: buffer };
  };
  return { request, state };
}

async function findDebugPort(start) {
  for (let port = start; port < start + 40; port += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) });
    } catch { return port; }
  }
  throw new Error('找不到可用的 Chrome 调试端口');
}

async function launchChrome() {
  const profile = await mkdtemp(path.join(ROOT, 'runtime', 'chrome-rebuild-'));
  const port = await findDebugPort(9410);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,1200', 'about:blank',
  ], { stdio: 'ignore' });
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
  return { chrome, target, profile };
}

async function subjectPng() {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#eef1ea' } })
    .composite([{
      input: await sharp({ create: { width: 380, height: 560, channels: 3, background: '#8b6a55' } }).png().toBuffer(),
      left: 350, top: 440,
    }])
    .png()
    .toBuffer();
}

async function main() {
  await mkdir(EVIDENCE, { recursive: true });
  const storeDir = await mkdtemp(path.join(ROOT, 'runtime', 'rebuild-ui-'));
  // Node 的 fetch（undici）拒绝部分“bad port”（如 6666/6000），port:0 可能随机命中；
  // 因此显式挑高端口并在占用时换一个重试。
  let app = null;
  let address = null;
  for (let attempt = 0; attempt < 12 && !address; attempt += 1) {
    const candidate = createApp({
      port: 38000 + Math.floor(Math.random() * 900),
      storeDir,
      demoMode: false,
      initialCredits: 0,
      tickMs: 10,
      provider: createFixtureProvider(),
      paymentProvider: createMockWechatPaymentProvider(),
    });
    try { address = await candidate.listen(); app = candidate; }
    catch { await candidate.close().catch(() => {}); }
  }
  if (!address) throw new Error('找不到可用端口启动验收服务');
  const base = `http://127.0.0.1:${address.port}`;
  const client = createClient(base);

  const email = `rebuild-${Date.now()}@example.test`;
  const registered = await client.request('/api/auth/register', {
    method: 'POST', body: { email, password: 'RebuildUi2026!', display_name: '重构验收' },
  });
  if (registered.status !== 201) throw new Error(`注册失败：${JSON.stringify(registered.json)}`);
  const order = await client.request('/api/billing/orders', { method: 'POST', body: { plan_id: 'plan_taster_10' } });
  if (order.status !== 201) throw new Error(`创建订单失败：${JSON.stringify(order.json)}`);
  await client.request(`/api/billing/orders/${order.json.order.id}/settle`, { method: 'POST' });
  const sessionToken = client.state.cookie.split('=')[1];

  const { chrome, target, profile } = await launchChrome();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  cdp.onEvent = message => {
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    }
  };
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCookie', { name: 'qtb_session', value: sessionToken, domain: '127.0.0.1', path: '/', httpOnly: true });

  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`页面脚本异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value;
  };
  const waitFor = async (expression, { timeout = 20_000, label = expression } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { if (await evaluate(expression)) return true; } catch { /* 页面可能还没加载完 */ }
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click(); true`);
  const shot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(EVIDENCE, name), Buffer.from(data, 'base64'));
  };

  const checks = [];
  const check = (name, okay, detail = '') => { checks.push({ name, okay, detail }); if (!okay) throw new Error(`检查失败：${name} ${detail}`); };

  try {
    await cdp.send('Page.navigate', { url: `${base}/#create` });
    await waitFor(`!!document.querySelector('#wiz-file') && !document.querySelector('[data-wiz-panel="1"]').hidden`, { label: '向导第 1 步' });

    // 上传原图：走真实 input，触发前端真实上传
    const pngPath = path.join(storeDir, 'e2e-cream.png');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(pngPath, await subjectPng());
    const inputHandle = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#wiz-file')` });
    // setFileInputFiles 是否自动派发 change 因环境而异：先观察上传是否已开始，
    // 只有确实没开始时才补一次 change（避免同一文件被上传两次触发主体冲突）。
    const uploadStarted = () => evaluate(`(() => {
      const status = document.querySelector('#wiz-upload-status');
      return (!status.hidden && status.textContent.length > 0) || !document.querySelector('#wiz-next-1').disabled;
    })()`);
    await cdp.send('DOM.setFileInputFiles', { objectId: inputHandle.result.objectId, files: [pngPath] });
    let started = false;
    for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
      started = await uploadStarted();
      if (!started) await sleep(200);
    }
    if (!started) {
      const dispatched = await evaluate(`(() => {
        const input = document.querySelector('#wiz-file');
        if (!input.files.length) return false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!dispatched) throw new Error('无法把测试图片附加到上传输入框');
    }
    await waitFor(`!document.querySelector('#wiz-next-1').disabled`, { timeout: 30_000, label: '上传完成且可继续' });
    checks.push({ name: 'M03 上传：真实上传后按钮可用', okay: true });
    await click('#wiz-next-1');

    // 第 2 步：问题卡 + 卖点候选
    await waitFor(`document.querySelectorAll('.wiz-fact-card').length >= 3`, { label: '商品信息问题卡' });
    const cardInfo = await evaluate(`(() => {
      const card = document.querySelector('.wiz-fact-card');
      const input = card.querySelector('[data-card-value]');
      input.value = '500ml';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      card.querySelector('[data-card-confirm]').click();
      const selling = document.querySelector('#wiz-selling-points');
      selling.value = '500ml 大容量，一瓶用一个月。美白提亮肤色';
      selling.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#wiz-sell-analyze').click();
      return {
        question: card.querySelector('.wfc-question').textContent,
        status: card.querySelector('.wfc-status').textContent,
        cards: document.querySelectorAll('.wiz-fact-card').length,
      };
    })()`);
    check('M04 商品信息：问题卡有示例', /例如：/.test(cardInfo.question), cardInfo.question);
    check('M04 商品信息：核对后状态明确', /已核对/.test(cardInfo.status), cardInfo.status);
    await waitFor(`document.querySelectorAll('.wiz-sell-item').length === 2`, { label: '卖点候选' });
    const sellInfo = await evaluate(`({
      ready: document.querySelectorAll('.wiz-sell-item.ready').length,
      claim: document.querySelectorAll('.wiz-sell-item.claim').length,
      rewrite: document.querySelector('.wiz-sell-item.claim .wsi-rewrite')?.textContent ?? '',
    })`);
    check('M04 卖点：已核对规格的句子放行', sellInfo.ready >= 1, JSON.stringify(sellInfo));
    check('M04 卖点：功效句标为缺依据', sellInfo.claim === 1, JSON.stringify(sellInfo));
    check('M04 卖点：功效句给出只删不增的改写', /提亮肤色/.test(sellInfo.rewrite) && !/美白/.test(sellInfo.rewrite), sellInfo.rewrite);
    await click('#wiz-confirm-truth');

    // 第 3 步：可视化方案 + 背景建议
    await waitFor(`!document.querySelector('[data-wiz-panel="3"]').hidden && document.querySelectorAll('.wiz-template-card').length > 0`, { label: '第 3 步方案' });
    const planInfo = await evaluate(`({
      art: document.querySelectorAll('.wiz-template-card .wiz-art').length,
      recommend: document.querySelectorAll('.wiz-recommend').length,
      bg: document.querySelector('#wiz-bg-note').textContent,
      delivery: document.querySelector('#wiz-delivery').textContent.length,
    })`);
    check('M05 方案：有可视化排版示意', planInfo.art >= 3, String(planInfo.art));
    check('M05 方案：默认推荐已标注', planInfo.recommend >= 1);
    check('M05 背景：给出方案默认建议', /背景：/.test(planInfo.bg), planInfo.bg);
    check('M05 交付：清单已推导', planInfo.delivery > 20, String(planInfo.delivery));
    // 平台规则是真实质量门禁的一部分：留空会保持“平台规则未核验”，成品不能标记为可发布
    await evaluate(`(() => {
      const input = document.querySelector('#wiz-platform');
      input.value = '天猫';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(800);
    await waitFor(`!document.querySelector('#wiz-to-pay').disabled`, { label: '可进入交付与费用' });
    await click('#wiz-to-pay');

    // 第 4 步：交付摘要 + 阻塞处理 + 真实报价
    await waitFor(`!document.querySelector('[data-wiz-panel="4"]').hidden && document.querySelector('#wiz-pay-summary').textContent.length > 10`, { label: '第 4 步摘要' });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const blockedText = await evaluate(`document.querySelector('[data-wiz-panel="4"]').textContent`);
      if (!/生成前还需要处理/.test(blockedText)) break;
      const acted = await evaluate(`(() => {
        const fix = document.querySelector('#wiz-bg-fixes [data-bg-fix]');
        if (fix) { fix.click(); return 'bg'; }
        const select = [...document.querySelectorAll('#wiz-spec-notes select[data-wiz-conflict]')]
          .find(node => !node.value && node.options.length > 1);
        if (select) {
          select.value = select.options[1].value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return 'select';
        }
        return '';
      })()`);
      if (!acted) break;
      await sleep(900);
    }
    await waitFor(`!document.querySelector('#wiz-generate').disabled`, { timeout: 30_000, label: '生成按钮可用' });
    const preQuote = await evaluate(`document.querySelector('#wiz-generate').textContent`);
    check('M06 报价：先请求真实报价', /获取真实报价/.test(preQuote), preQuote);
    await click('#wiz-generate');
    await waitFor(`/确认生成/.test(document.querySelector('#wiz-generate').textContent)`, { timeout: 30_000, label: '服务端报价返回' });
    const quoteText = await evaluate(`document.querySelector('#wiz-quote').textContent`);
    check('M06 报价：显示服务端费用', /点|额度/.test(quoteText), quoteText.slice(0, 80));
    await click('#wiz-generate');

    // 同上下文追踪
    await waitFor(`!document.querySelector('#wiz-done').hidden`, { timeout: 30_000, label: '任务已提交并留在本页' });
    await waitFor(`/已完成|失败|已取消|部分完成/.test(document.querySelector('#wiz-run-status').textContent)`, { timeout: 120_000, label: '任务到达终态' });
    const runInfo = await evaluate(`({
      status: document.querySelector('#wiz-run-status').textContent,
      deliverables: document.querySelectorAll('#wiz-run-deliverables li').length,
      budget: document.querySelector('#wiz-run-budget').textContent,
      note: document.querySelector('#wiz-run-note').textContent,
      url: location.hash,
    })`);
    check('M06 追踪：任务完成', runInfo.status.includes('已完成'), runInfo.status);
    check('M06 追踪：逐项交付可见', runInfo.deliverables >= 3, String(runInfo.deliverables));
    check('M06 追踪：真实额度可见', /预留 \d+/.test(runInfo.budget), runInfo.budget);
    check('M06 追踪：未跳离当前上下文', runInfo.url === '#create', runInfo.url);
    await shot('m08-wizard-run-tracking.png');

    // 工作台：编辑、版本与下载入口
    await click('#wiz-open-workbench');
    await waitFor(`!!document.querySelector('#workbench-view') && !document.querySelector('#workbench-view').hidden`, { timeout: 20_000, label: '进入工作台' });
    await waitFor(`document.body.textContent.includes('下载')`, { timeout: 20_000, label: '工作台出现下载入口' });
    // 下载闭环必须经过真实质量门禁：unknown 项由用户逐项核对后提交复核，再创建导出包
    await waitFor(`document.querySelectorAll('.wb-deliverable').length > 0`, { timeout: 20_000, label: '工作台交付清单' });
    const firstDeliverable = await evaluate(`(() => {
      const item = document.querySelector('.wb-deliverable');
      if (!item) return false;
      item.click();
      return true;
    })()`);
    check('M07 结果：交付项可选', firstDeliverable);
    await sleep(600);
    if (await evaluate(`!document.querySelector('#wb-human-review').hidden`)) {
      const submitted = await evaluate(`(() => {
        const boxes = [...document.querySelectorAll('[data-review-check]')];
        boxes.forEach(box => { box.checked = true; });
        document.querySelector('#wb-review-note').value = '端到端验收：已对照原图核对包装文字与主体';
        document.querySelector('#wb-review-evidence').value = '上传原图 e2e-cream.png 的主体区域';
        document.querySelector('[data-review-decision="publishable"]').click();
        return boxes.length;
      })()`);
      check('M07 结果：人工复核可提交', submitted >= 1, String(submitted));
      await waitFor(`!document.querySelector('#wb-export-partial').hidden`, { timeout: 30_000, label: '复核后出现部分包按钮' });
    }
    await waitFor(`!document.querySelector('#wb-export-partial').hidden`, { timeout: 20_000, label: '可创建导出包' });
    await click('#wb-export-partial');
    await waitFor(`document.querySelectorAll('#wb-export-history a[href*="/api/exports/"]').length > 0`, { timeout: 30_000, label: '导出包已创建' });
    const workbenchInfo = await evaluate(`({
      download: [...document.querySelectorAll('a[href*="/api/exports/"]')].length,
      revision: /修改|修订/.test(document.body.textContent),
      versions: /历史版本|版本/.test(document.body.textContent),
    })`);
    check('M07 结果：下载入口指向真实导出', workbenchInfo.download >= 1, String(workbenchInfo.download));
    check('M07 结果：编辑入口保留', workbenchInfo.revision);
    check('M07 结果：版本信息保留', workbenchInfo.versions);
    await shot('m08-workbench-results.png');

    // 下载闭环：真实 GET 返回 ZIP
    const exportHref = await evaluate(`document.querySelector('a[href*="/api/exports/"]')?.getAttribute('href')`);
    const download = await client.request(exportHref.replace(/^\/api/, '/api'));
    check('M07 下载：导出包真实可下载', download.status === 200 && download.body.slice(0, 2).toString() === 'PK', String(download.status));

    check('运行期无前端异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    console.log('\nM08 界面验收全部通过：');
    for (const item of checks) console.log(`  ✓ ${item.name}${item.detail ? ` · ${item.detail}` : ''}`);
    console.log(`\n证据目录：${EVIDENCE}`);
  } catch (error) {
    await shot('m08-failure.png').catch(() => {});
    const diagnostics = await evaluate(`({
      uploadStatus: document.querySelector('#wiz-upload-status')?.textContent ?? '',
      uploadError: document.querySelector('#wiz-upload-error')?.textContent ?? '',
      uploadResult: document.querySelector('#wiz-upload-result')?.textContent ?? '',
      step: [...document.querySelectorAll('[data-wiz-panel]')].find(panel => !panel.hidden)?.dataset.wizPanel ?? '',
      toast: document.querySelector('#toast')?.textContent ?? '',
      planError: document.querySelector('#wiz-plan-error')?.textContent ?? '',
      templateCount: document.querySelectorAll('.wiz-template-card').length,
      generateError: document.querySelector('#wiz-generate-error')?.textContent ?? '',
      workbench: {
        completeness: document.querySelector('#wb-completeness')?.textContent ?? '',
        completeHidden: document.querySelector('#wb-export-complete')?.hidden ?? null,
        partialHidden: document.querySelector('#wb-export-partial')?.hidden ?? null,
        exportHistory: document.querySelector('#wb-export-history')?.textContent ?? '',
        reviewHidden: document.querySelector('#wb-human-review')?.hidden ?? null,
        qa: document.querySelector('#wb-qa-checks')?.textContent?.slice(0, 300) ?? '',
        deliverables: document.querySelectorAll('.wb-deliverable').length,
      },
    })`).catch(() => null);
    console.error('\nM08 界面验收失败：', error.message);
    console.error('页面诊断：', JSON.stringify(diagnostics));
    try {
      const runs = (await client.request('/api/runs')).json.runs ?? [];
      const runId = runs[0]?.id;
      const detail = (await client.request(`/api/runs/${runId}`)).json.run;
      const versions = (await client.request(`/api/runs/${runId}/versions`)).json.versions ?? [];
      const reports = [];
      for (const version of versions) {
        if (!version.report_id) continue;
        const report = (await client.request(`/api/quality-reports/${version.report_id}`)).json.report;
        reports.push({
          id: report.id, decision: report.decision, validity: report.validity,
          unknown: (report.checks ?? []).filter(check => check.status === 'unknown')
            .map(check => ({ code: check.code, adjudicable: check.adjudicable, required: check.required,
              effective: check.effective_status ?? null })),
        });
      }
      console.error('运行数据：', JSON.stringify({ runId, status: detail?.status,
        deliverables: detail?.deliverables?.map(item => ({ id: item.deliverable_id, active: item.active_version_id, status: item.status })),
        versions: versions.map(item => ({ id: item.id, deliverable: item.deliverable_id, report: item.report_id })), reports }));
    } catch (debugError) { console.error('运行数据读取失败：', debugError.message); }
    if (consoleErrors.length) console.error('前端异常：', consoleErrors.slice(0, 5));
    throw error;
  } finally {
    cdp.close();
    chrome.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await app.close().catch(() => {});
    await rm(storeDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exit(1); });
