/**
 * 模块 07：整体端到端自测。
 *
 * 通过真实 HTTP 走完一条完整用户链路：
 * 注册登录 → 建项目 → 上传主体素材 → 商品事实 → 冻结 spec → 单张报价（1 点）
 * → 生成任务 → 人工复核结算 → 免费文字排版修改 → 指定图片重生成（1 点）
 * → 选用新版本 → 导出 ZIP。
 *
 * 同时验证安全与边界：未登录 401、缺 CSRF 403、缺幂等键 400、跨租户 404。
 *
 * 关于图片 Provider：外部真实模型未验收（无 PARATERA_API_KEY），本脚本注入
 * 尺寸准确的确定性 fixture，只验证流程、计价与权限；产物不是真实模型图。
 * 服务启动与静态资源由 scripts/smoke.mjs 单独覆盖。
 *
 * 运行：node scripts/e2e.mjs（需 Node 22.22.x）
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/server.mjs';
import { createMockWechatPaymentProvider } from '../src/providers/wechat.mjs';
import { createFixtureProvider } from './fixture-provider.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMP_ROOT = path.join(ROOT, 'runtime', 'e2e-tmp');

function readZip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset = start + compressedSize;
  }
  return files;
}

async function startServer(storeDir) {
  const app = createApp({
    port: 0,
    storeDir,
    // 会话模式（不接受演示身份）：新账户先拿到 3 点体验额度；
    // 支付 Provider 使用 mock（real_money=false），走真实订单状态机与 demo 结算，
    // 只为验证"充值 → 消耗"链路，不能作为真实收款证据，真实收款保持关闭。
    demoMode: false,
    initialCredits: 0,
    tickMs: 10,
    provider: createFixtureProvider(),
    paymentProvider: createMockWechatPaymentProvider(),
  });
  const address = await app.listen();
  return {
    port: address.port,
    stop: () => app.close(),
  };
}

function createClient(base) {
  const state = { cookie: '', csrf: '' };
  const request = async (route, { method = 'GET', body, headers = {}, useCsrf = true, useCookie = true } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(useCookie && state.cookie ? { Cookie: state.cookie } : {}),
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
    return { status: response.status, headers: response.headers, json, body: buffer };
  };
  return { request, state };
}

const capturesOf = entries => entries.filter(item => item.type === 'capture');
const availableOf = payload => payload?.balance?.available ?? null;

/** 与前端"人工复核"动作一致：把必要且可裁决的未知项判为通过。 */
async function reviewToPublishable(request, reportId) {
  const report = (await request(`/api/quality-reports/${reportId}`)).json.report;
  if (report.decision === 'publishable') return report;
  const decisions = (report.checks ?? [])
    .filter(check => check.required && check.status === 'unknown' && check.adjudicable)
    .map(check => ({ code: check.code, decision: 'pass', reason: '端到端自测人工检查通过', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await request(`/api/quality-reports/${reportId}/reviews`, {
    method: 'POST', body: { decisions, note: '模拟人工复核；不证明真实模型效果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  return reviewed.json.report;
}

async function waitTerminal(request, runId, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    const run = (await request(`/api/runs/${runId}`)).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() - started > timeoutMs) throw new Error(`任务未进入终态，当前状态 ${run?.status}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function subjectPng() {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#f2f0e8' } })
    .composite([{
      input: await sharp({ create: { width: 360, height: 540, channels: 3, background: '#7a4a3a' } }).png().toBuffer(),
      left: 360, top: 450,
    }])
    .png().toBuffer();
}

async function main() {
  await mkdir(TEMP_ROOT, { recursive: true });
  const storeDir = await mkdtemp(path.join(TEMP_ROOT, 'run-'));
  const server = await startServer(storeDir);
  const base = `http://127.0.0.1:${server.port}`;
  const steps = [];
  const step = async (name, work) => {
    const startedAt = Date.now();
    try {
      const detail = typeof work === 'function' ? await work() : work;
      steps.push({ name, ok: true });
      console.log(`✓ ${name}${detail ? `：${detail}` : ''}（${Date.now() - startedAt}ms）`);
    } catch (error) {
      steps.push({ name, ok: false, error: error.message });
      console.log(`✗ ${name}：${error.message}`);
      throw error;
    }
  };

  try {
    const client = createClient(base);
    const request = client.request;
    const anon = await request('/api/runs', { useCookie: false, useCsrf: false });
    assert.equal(anon.status, 401, JSON.stringify(anon.json));

    await step('未登录访问被拒绝（生产式会话模式）', () => `${anon.json.error}`);

    const email = `e2e-${Date.now()}@example.test`;
    const registered = await request('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'E2eAccount2026!', display_name: '端到端' },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.json));
    assert.equal(registered.json.experience_credits, 3);
    assert.ok(client.state.cookie && client.state.csrf, '注册后必须拿到会话与 CSRF 令牌');

    const credits0 = (await request('/api/credits')).json;
    assert.equal(availableOf(credits0), 3, JSON.stringify(credits0));
    await step('注册登录与体验额度', `余额 ${availableOf(credits0)} 点`);

    // 演示充值：走真实订单状态机，但 Provider 声明 simulated，不产生任何真实扣款
    const order = await request('/api/billing/orders', { method: 'POST', body: { plan_id: 'plan_taster_10' } });
    assert.equal(order.status, 201, JSON.stringify(order.json));
    assert.equal(order.json.order.real_money, false, '真实收款必须保持关闭');
    const settled = await request(`/api/billing/orders/${order.json.order.id}/settle`, { method: 'POST' });
    assert.equal(settled.status, 200, JSON.stringify(settled.json));
    const credits1 = (await request('/api/credits')).json;
    assert.equal(availableOf(credits1), 13, JSON.stringify(credits1));
    await step('演示充值到账（真实收款关闭）', `+10 点，余额 13`);

    const project = (await request('/api/projects', {
      method: 'POST',
      body: { name: 'E2E 面霜', sku: 'E2E-01', category: '面霜', platform: '天猫' },
    })).json.project;
    assert.ok(project?.id);

    const uploaded = await request(`/api/projects/${project.id}/assets?role=subject&filename=subject.png`, {
      method: 'POST', body: await subjectPng(), headers: { 'Content-Type': 'image/png' },
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));

    const truth = await request(`/api/projects/${project.id}/truth-versions`, {
      method: 'POST',
      body: {
        base_version: 0, confirm: true,
        facts: [
          { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
          { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
        ],
        critical_text: [{ text: '月光舒缓' }],
      },
    });
    assert.equal(truth.status, 201, JSON.stringify(truth.json));
    await step('商品、主体素材与商品事实', `项目 ${project.id}`);

    // 新品上架包：3 个必选交付物（主图 / 卖点图 / 场景图），按成品计价 3 点
    const preview = await request(`/api/projects/${project.id}/specs/preview`, {
      method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫' },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    const resolutions = {};
    for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
      if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
    }
    const frozen = await request(`/api/projects/${project.id}/specs`, {
      method: 'POST',
      body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
    });
    assert.equal(frozen.status, 201, JSON.stringify(frozen.json));

    const quote = await request('/api/quotes', { method: 'POST', body: { project_id: project.id } });
    assert.equal(quote.status, 201, JSON.stringify(quote.json));
    assert.equal(quote.json.quote.billing_mode, 'finished_image');
    assert.equal(quote.json.quote.estimated_credits, 3, JSON.stringify(quote.json.quote.lines));
    await step('冻结规格与成品报价', `3 张 / ${quote.json.quote.estimated_credits} 点`);

    const missingCsrf = await request('/api/runs', {
      method: 'POST',
      useCsrf: false,
      body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
      headers: { 'Idempotency-Key': 'e2e-first-run' },
    });
    assert.equal(missingCsrf.status, 403, JSON.stringify(missingCsrf.json));
    assert.equal(missingCsrf.json.error, 'CSRF_REQUIRED');

    const missingKey = await request('/api/runs', {
      method: 'POST', body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
    });
    assert.equal(missingKey.status, 400, JSON.stringify(missingKey.json));
    assert.equal(missingKey.json.error, 'MISSING_IDEMPOTENCY_KEY');
    await step('CSRF 与幂等键拦截', '403 / 400');

    const created = await request('/api/runs', {
      method: 'POST',
      body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
      headers: { 'Idempotency-Key': 'e2e-first-run' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.balance?.available, 10, '首轮按成品预留 3 点');
    const run = created.json.run;

    const replay = await request('/api/runs', {
      method: 'POST',
      body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
      headers: { 'Idempotency-Key': 'e2e-first-run' },
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.run.id, run.id, '同幂等键必须返回同一任务');
    assert.equal(replay.json.balance?.available, 10, '幂等重放不得重复预留');
    await step('首轮任务创建与幂等重放', `任务 ${run.id}，余额 13 → 10`);

    const done = await waitTerminal(request, run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    const benefit = done.deliverables.find(item => item.deliverable_id === 'benefit');
    const mainBefore = done.deliverables.find(item => item.deliverable_id === 'main');
    const sceneBefore = done.deliverables.find(item => item.deliverable_id === 'scene');
    assert.ok(benefit?.active_version_id && mainBefore?.active_version_id && sceneBefore?.active_version_id);

    for (const item of done.deliverables.filter(deliverable => deliverable.active_version_id)) {
      const report = await reviewToPublishable(request, item.quality_report_id);
      assert.equal(report.decision, 'publishable', JSON.stringify(report.decision_reasons));
    }
    const creditsAfterRun = (await request('/api/credits')).json;
    assert.equal(availableOf(creditsAfterRun), 10, '复核结算后余额仍为 10（预留转结算）');
    assert.ok(capturesOf(creditsAfterRun.recent ?? []).length >= 3, '三张成品各自结算一次');
    await step('生成完成与人工复核结算', '3 张全部可发布，余额 10');

    const layers = (await request(`/api/runs/${run.id}/deliverables/benefit/text-layers`)).json;
    assert.equal(layers.version_id, benefit.active_version_id);
    const editable = layers.layers.find(item => item.editable_text === true);
    const readonlyLayer = layers.layers.find(item => item.editable_text === false && item.logo !== true);
    assert.ok(editable, '卖点图必须有可编辑文案');
    assert.ok(readonlyLayer, '卖点图必须有不可改写的包装关键文字');

    const beforeEdit = (await request('/api/credits')).json.recent;
    const readonlyAttempt = await request(`/api/runs/${run.id}/deliverables/benefit/text-edits`, {
      method: 'POST',
      body: { base_version_id: benefit.active_version_id, edits: [{ id: readonlyLayer.id, text: '仿冒包装' }] },
    });
    assert.equal(readonlyAttempt.status, 422, JSON.stringify(readonlyAttempt.json));
    assert.ok(readonlyAttempt.json.details.issues.some(item => item.code === 'PACKAGING_TEXT_READONLY'));

    const edited = await request(`/api/runs/${run.id}/deliverables/benefit/text-edits`, {
      method: 'POST',
      body: { base_version_id: benefit.active_version_id, edits: [{ id: editable.id, text: '舒缓维稳 持久水润' }] },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.previous_version_id, benefit.active_version_id);
    assert.equal(edited.json.version.text_layers.find(item => item.id === editable.id).text, '舒缓维稳 持久水润');
    assert.equal(edited.json.version.overlay_base_hash,
      (await request(`/api/runs/${run.id}/versions`)).json.versions
        .find(item => item.id === benefit.active_version_id).overlay_base_hash,
      '文字修改必须沿用同一底图来源');
    const afterEdit = (await request('/api/credits')).json.recent;
    assert.equal(afterEdit.length, beforeEdit.length, '文字修改不得产生额度流水');
    const balanceAfterEdit = availableOf((await request('/api/credits')).json);
    assert.equal(balanceAfterEdit, 10);

    await reviewToPublishable(request, edited.json.report.id);
    const activatedText = await request(`/api/runs/${run.id}/versions/${edited.json.version.id}/activate`, { method: 'POST' });
    assert.equal(activatedText.status, 200, JSON.stringify(activatedText.json));
    await step('文字排版修改（免费）并选用新版本', `版本 #${edited.json.version.number}，余额 10`);

    const versionsBeforeRegen = (await request(`/api/runs/${run.id}/versions`)).json.versions;
    const regen = await request(`/api/runs/${run.id}/regenerate`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'e2e-regen-1' },
      body: { deliverable_id: 'benefit' },
    });
    assert.equal(regen.status, 201, JSON.stringify(regen.json));
    const regenBalance = availableOf((await request('/api/credits')).json);
    assert.equal(regenBalance, 9, '重生成必须单独预留 1 点');
    const child = regen.json.run;
    const childDone = await waitTerminal(request, child.id);
    assert.equal(childDone.status, 'completed', JSON.stringify(childDone));

    const versionsAfterRegen = (await request(`/api/runs/${run.id}/versions`)).json.versions;
    assert.equal(versionsAfterRegen.length, versionsBeforeRegen.length + 1, '版本只增不改');
    const adopted = versionsAfterRegen.find(item => item.adopted_from?.run_id === child.id);
    assert.ok(adopted, '重生成产物必须登记回源任务');
    assert.equal(adopted.active, false, '未复核的新图不得自动替换选用版本');
    const runAfterRegen = (await request(`/api/runs/${run.id}`)).json.run;
    assert.equal(runAfterRegen.deliverables.find(item => item.deliverable_id === 'main').active_version_id,
      mainBefore.active_version_id, '其他交付物的选用版本不得被波及');
    assert.equal(runAfterRegen.deliverables.find(item => item.deliverable_id === 'scene').active_version_id,
      sceneBefore.active_version_id, '其他交付物的选用版本不得被波及');

    const childReportId = childDone.deliverables.find(item => item.deliverable_id === 'benefit').quality_report_id;
    await reviewToPublishable(request, childReportId);
    const regenBalanceSettled = availableOf((await request('/api/credits')).json);
    assert.equal(regenBalanceSettled, 9, '重生成结算后余额为 9');
    const activatedRegen = await request(`/api/runs/${run.id}/versions/${adopted.id}/activate`, { method: 'POST' });
    assert.equal(activatedRegen.status, 200, JSON.stringify(activatedRegen.json));
    await step('指定图片重生成（1 点）与人工选用', `子任务 ${child.id}，余额 10 → 9`);

    const exported = await request(`/api/runs/${run.id}/exports`, { method: 'POST', body: { scope: 'complete' } });
    assert.equal(exported.status, 201, JSON.stringify(exported.json));
    const download = await request(exported.json.export.download_url);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/zip');
    assert.ok(download.body.length > 0);
    const files = readZip(download.body);
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    const benefitAsset = manifest.assets.find(item => item.deliverable_id === 'benefit');
    const mainAsset = manifest.assets.find(item => item.deliverable_id === 'main');
    assert.equal(benefitAsset.version_id, adopted.id, '导出必须引用刚选用的重生成版本');
    assert.equal(createHash('sha256').update(files.get(benefitAsset.file)).digest('hex'), adopted.hash);
    assert.equal(mainAsset.version_id, mainBefore.active_version_id, '主图保持原版本');
    const mainVersion = (await request(`/api/runs/${run.id}/versions`)).json.versions
      .find(item => item.id === mainBefore.active_version_id);
    assert.equal(createHash('sha256').update(files.get(mainAsset.file)).digest('hex'), mainVersion.hash,
      '主图文件必须与选用版本字节一致');
    await step('导出 ZIP 与清单校验', `${files.size} 个文件，卖点图取新版本、主图保持原版本`);

    // 跨租户：另一个账户看不到也不需要能操作这个任务
    const other = createClient(base);
    const otherRegister = await other.request('/api/auth/register', {
      method: 'POST',
      body: {
        email: `e2e-other-${Date.now()}@example.test`,
        password: 'E2eAccount2026!', display_name: '其他账户',
      },
    });
    assert.equal(otherRegister.status, 201, JSON.stringify(otherRegister.json));
    const crossGet = await other.request(`/api/runs/${run.id}`);
    assert.equal(crossGet.status, 404, JSON.stringify(crossGet.json));
    const crossRegen = await other.request(`/api/runs/${run.id}/regenerate`, {
      method: 'POST', headers: { 'Idempotency-Key': 'e2e-cross' }, body: { deliverable_id: 'benefit' },
    });
    assert.equal(crossRegen.status, 404, JSON.stringify(crossRegen.json));
    const crossCredits = (await other.request('/api/credits')).json;
    assert.equal(availableOf(crossCredits), 3, '别人的任务不得消耗当前租户额度');
    await step('跨租户隔离', 'GET/重生成均 404');

    const page = await request('/', { useCookie: false, useCsrf: false });
    assert.equal(page.status, 200);
    assert.ok(page.body.toString('utf8').includes('<meta name="viewport"'), '首页必须声明移动端 viewport');
    const style = await request('/style.css', { useCookie: false, useCsrf: false });
    assert.equal(style.status, 200);
    assert.ok(style.body.toString('utf8').includes('#365F49'), '必须使用绿色设计系统主色');
    const viewport = await request('/viewport.css', { useCookie: false, useCsrf: false });
    assert.equal(viewport.status, 200);
    await step('静态资源与绿色设计系统', 'index.html / style.css / viewport.css');

    const provider = (await request('/api/provider/capabilities')).json;
    console.log(`  当前 Provider：${provider.mode}（验收状态 ${provider.acceptance}）`);

    console.log(`\n端到端自测通过：${steps.length} 个步骤，全部断言成立。`);
  } finally {
    try { await server.stop(); } catch (error) { console.error(`服务关闭异常：${error.message}`); }
    try { await rm(storeDir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`\n端到端自测失败：${error.message}`);
    process.exitCode = 1;
  });
}
