#!/usr/bin/env node
/**
 * 阶段 6 三臂候选生成器（不计算效果指标）。
 *
 * A 通用模型直接生成：Seedream + 简单提示词，不经工作流。
 * B 现有流程：真实 Seedream + 现有确定性检查，视觉评审关闭。
 * C 新评审修订流程：真实 Seedream + 真实视觉评审 + 最多 1 次人工确认式修订。
 *
 * 产物写入 runtime/stage6-candidates/<stamp>/：
 * - blind/<blind_id>.jpg：去掉臂标识的候选图；
 * - blind-key.json：盲号与臂/案例映射，评分人不得看到；
 * - rating-sheet.csv：待人工填写；
 * - candidates.json：真实调用、用量、时延、修订轨迹。
 *
 * 用法：
 *   node scripts/stage6-candidates.mjs --products 09 --arms A,B,C
 *   node scripts/stage6-candidates.mjs --products 09,10,11,12
 *   node scripts/stage6-candidates.mjs --dry-run --products 09   # 使用 fixture，不产生供应商费用
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../src/server.mjs';
import { createMockWechatPaymentProvider } from '../src/providers/wechat.mjs';
import { createSeedreamProvider } from '../src/providers/seedream.mjs';
import { createVisualReviewerFromEnv } from '../src/visual-review.mjs';
import { createRevisionPlannerFromEnv } from '../src/revision-planner.mjs';
import { createProviderFromEnv } from '../src/providers/index.mjs';
import { createFixtureProvider } from './fixture-provider.mjs';
import { appendEntry } from '../src/credits.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATERIALS = path.resolve(ROOT, '../商品测试素材-12款');
const MANIFEST = JSON.parse(await readFile(path.join(MATERIALS, '素材清单.json'), 'utf8'));
const SCENARIOS = Object.freeze([
  {
    id: 'clean_bg', deliverable: 'main', width: 1200, height: 1200,
    prompt: '纯白干净背景，商品主体完整居中，电商主图；严格保持商品的形状、颜色、数量、把手与瓶口结构不变',
  },
  {
    id: 'scene', deliverable: 'scene', width: 1200, height: 1500,
    prompt: '生活场景背景，自然光线，保留商品主体完整与结构不变，电商场景图；不得补造或遮挡商品',
  },
  {
    id: 'layout', deliverable: 'benefit', width: 1200, height: 1500,
    prompt: '在商品图空白区域叠加测试文字「版面测试文字」，文字不得遮挡商品；保留商品主体与结构不变',
  },
]);

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const PRODUCTS = valueOf('--products', '09,10,11,12').split(',').map(item => item.trim()).filter(Boolean);
const ARMS = valueOf('--arms', 'A,B,C').split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
const DRY_RUN = flag('--dry-run');
const NO_REVISION = flag('--no-revision');
const STAMP = valueOf('--stamp', new Date().toISOString().replace(/[:.]/gu, '-'));

function fail(message, extra = {}) {
  const error = new Error(message);
  error.details = extra;
  return error;
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
    if (!response.ok) {
      throw fail(`${route} HTTP ${response.status}：${json?.error ?? buffer.toString('utf8').slice(0, 200)}`, json ?? {});
    }
    return { status: response.status, headers: response.headers, json, body: buffer };
  };
  return { request, state };
}

async function waitTerminal(request, runId, timeoutMs = 25 * 60 * 1000) {
  const started = Date.now();
  let last = null;
  let lastError = null;
  for (;;) {
    let run = null;
    try {
      run = (await request(`/api/runs/${runId}`)).json.run;
      lastError = null;
    } catch (error) {
      // 视觉评审在 store 写锁内执行时，读请求会等待锁并可能被服务的 requestTimeout 断开；
      // 这是可恢复的轮询失败，继续重试直到任务进入终态。
      lastError = error;
    }
    if (run) last = run;
    if (run && ['completed', 'limit_reached', 'failed', 'cancelled', 'needs_attention'].includes(run.status)) return run;
    if (Date.now() - started > timeoutMs) {
      throw fail(`任务 ${runId} 超时，最后状态 ${last?.status ?? 'unknown'}${lastError ? `，最后错误 ${lastError.message}` : ''}`, { run_id: runId });
    }
    await new Promise(resolve => setTimeout(resolve, lastError ? 1_000 : 400));
  }
}

function buildProvider() {
  if (DRY_RUN) return createFixtureProvider();
  const apiKey = process.env.PARATERA_API_KEY?.trim() || process.env.PILOTDECK_SEEDREAM_API_KEY?.trim();
  if (!apiKey) throw fail('缺少 PARATERA_API_KEY 或 PILOTDECK_SEEDREAM_API_KEY');
  return createSeedreamProvider({
    apiKey,
    baseUrl: process.env.PILOTDECK_SEEDREAM_BASE_URL?.trim() || undefined,
    model: process.env.PILOTDECK_SEEDREAM_MODEL?.trim() || undefined,
    // 本地像素合成在非纯色背景素材上会把桌面/背景一起贴回，已关闭；
    // 改用真实参考图保护，并如实记录为 reference 模式，主体一致性交给评审与人工复核。
    supportsPostComposite: false,
    supportsReferenceProtection: true,
    timeoutMs: 180_000,
  });
}

function buildReviewer(arm) {
  if (DRY_RUN || arm === 'B') return createVisualReviewerFromEnv({});
  const env = {
    QTB_VISUAL_REVIEW_ENDPOINT: process.env.QTB_VISUAL_REVIEW_ENDPOINT,
    QTB_VISUAL_REVIEW_API_KEY: process.env.QTB_VISUAL_REVIEW_API_KEY,
    QTB_VISUAL_REVIEW_MODEL: process.env.QTB_VISUAL_REVIEW_MODEL || 'GLM-4.5V',
    QTB_VISUAL_REVIEW_TIMEOUT_MS: process.env.QTB_VISUAL_REVIEW_TIMEOUT_MS || '180000',
  };
  if (!env.QTB_VISUAL_REVIEW_ENDPOINT) throw fail('C 臂需要 QTB_VISUAL_REVIEW_ENDPOINT');
  return createVisualReviewerFromEnv(env);
}

function buildPlanner(arm) {
  if (DRY_RUN || arm === 'B') return createRevisionPlannerFromEnv({});
  const env = {
    QTB_REVISION_PLANNER_ENDPOINT: process.env.QTB_REVISION_PLANNER_ENDPOINT,
    QTB_REVISION_PLANNER_API_KEY: process.env.QTB_REVISION_PLANNER_API_KEY,
    QTB_REVISION_PLANNER_MODEL: process.env.QTB_REVISION_PLANNER_MODEL || 'GLM-4.5V',
    QTB_REVISION_PLANNER_TIMEOUT_MS: process.env.QTB_REVISION_PLANNER_TIMEOUT_MS || '180000',
  };
  if (!env.QTB_REVISION_PLANNER_ENDPOINT) throw fail('C 臂需要 QTB_REVISION_PLANNER_ENDPOINT');
  return createRevisionPlannerFromEnv(env);
}

async function startArmServer(arm, storeDir) {
  const app = createApp({
    port: 0,
    storeDir,
    demoMode: false,
    initialCredits: 1000,
    tickMs: 200,
    attemptTimeoutMs: 900_000,
    // 真实评审/规划是同步长调用，默认 20 秒空闲超时会把浏览器/脚本连接提前断开
    socketTimeoutMs: 300_000,
    maxConcurrency: 2,
    revisionMaxRounds: 1,
    provider: buildProvider(),
    visualReviewer: buildReviewer(arm),
    revisionPlanner: buildPlanner(arm),
    paymentProvider: createMockWechatPaymentProvider(),
  });
  const address = await app.listen();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

async function createProjectCase(request, product, stamp) {
  const email = `stage6-${stamp}-${product.id}@example.test`;
  const registered = (await request('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'Stage6Account2026!', display_name: `阶段6-${product.id}` },
  })).json;
  const project = (await request('/api/projects', {
    method: 'POST',
    body: {
      name: product.name,
      sku: `SKU-${product.id}-UNVERIFIED`,
      category: '家居',
      platform: '天猫',
    },
  })).json.project;
  const uploadBytes = await readFile(path.join(MATERIALS, product.upload_file));
  const uploaded = (await request(`/api/projects/${project.id}/assets?role=subject&filename=${product.id}.jpg`, {
    method: 'POST',
    body: uploadBytes,
    headers: { 'Content-Type': 'image/jpeg' },
  })).json;
  const assetId = uploaded.asset?.id ?? null;
  const truth = (await request(`/api/projects/${project.id}/truth-versions`, {
    method: 'POST',
    body: {
      base_version: 0,
      confirm: true,
      facts: [{
        key: '外观观察',
        value: '商品外观以原始素材为准；不新增未确认的品牌、材质、尺寸、容量、性能与卖点',
        critical: true,
        confirmed: true,
        source_type: 'asset',
        source_asset_id: assetId,
      }],
      critical_text: [{ text: '版面测试文字' }],
    },
  })).json.truth_version;
  const preview = (await request(`/api/projects/${project.id}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  })).json.payload;
  const resolutions = {};
  for (const conflict of [...(preview.conflicts?.pending ?? []), ...(preview.conflicts?.unresolvable ?? [])]) {
    if (Array.isArray(conflict.options) && conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const spec = (await request(`/api/projects/${project.id}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  })).json.spec_version;
  const quote = (await request('/api/quotes', {
    method: 'POST', body: { project_id: project.id },
  })).json.quote;
  return {
    project, truth, spec, quote, assetId, resolutionCount: Object.keys(resolutions).length,
    tenantId: registered.tenant.id,
  };
}

/**
 * 三臂候选只用于评估工作流差异，修订执行需要额外额度。
 * 这里直接给测试租户记一笔“测试额度”（kind=grant，非真实支付、不入真实账单），
 * 保证 C 臂能真的跑完修订执行，而不是用额度不足冒充“无需修订”。
 */
async function grantTestCredits(app, tenantId, { amount, key }) {
  const result = await app.store.mutate(data => appendEntry(data, {
    type: 'grant',
    amount,
    tenantId,
    uniqueOperationKey: key,
    memo: '阶段 6 候选生成测试额度（非真实支付）',
    actor: 'stage6_harness',
    at: new Date(),
  }));
  return result.balance.available;
}

function checkMap(report) {
  const map = new Map();
  for (const check of report?.checks ?? []) map.set(check.code, check.status);
  return map;
}

function improvementOf(before, after, targetCodes) {
  const beforeMap = checkMap(before);
  const afterMap = checkMap(after);
  const stillOpen = targetCodes.filter(code => ['fail', 'unknown'].includes(afterMap.get(code)));
  const regressions = [...beforeMap.entries()]
    .filter(([code, status]) => status === 'pass' && afterMap.get(code) === 'fail')
    .map(([code]) => code);
  return {
    improved: stillOpen.length === 0 && regressions.length === 0,
    still_open: stillOpen,
    regressions,
    before: Object.fromEntries(beforeMap),
    after: Object.fromEntries(afterMap),
  };
}

async function runRevisionRound(request, run, reportIndex, product, stamp) {
  const traces = [];
  for (const deliverable of run.deliverables ?? []) {
    if (!deliverable.active_version_id || !deliverable.quality_report_id) continue;
    const before = (await request(`/api/quality-reports/${deliverable.quality_report_id}`)).json.report;
    if (before.decision === 'publishable') continue;
    let plan;
    try {
      plan = (await request(`/api/runs/${run.id}/revision-plans`, {
        method: 'POST', body: { report_id: before.id },
      })).json;
    } catch (error) {
      traces.push({ deliverable_id: deliverable.deliverable_id, stage: 'plan_failed', error: error.message });
      continue;
    }
    if (!plan.execution?.available) {
      traces.push({
        deliverable_id: deliverable.deliverable_id, stage: 'not_executable',
        plan_id: plan.plan_id, action: plan.action, reason: plan.execution?.reason ?? null,
        target_check_codes: plan.plan?.target_check_codes ?? [],
      });
      continue;
    }
    let executed;
    try {
      executed = (await request(`/api/runs/${run.id}/revision-plans/${plan.plan_id}/execute`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `stage6-${stamp}-${product.id}-${deliverable.deliverable_id}-rev1` },
        body: { confirm: true },
      })).json;
    } catch (error) {
      traces.push({
        deliverable_id: deliverable.deliverable_id, stage: 'execute_failed',
        plan_id: plan.plan_id, error: error.message,
      });
      continue;
    }
    const child = await waitTerminal(request, executed.child_run_id, 15 * 60 * 1000);
    const childDeliverable = child.deliverables.find(item => item.deliverable_id === deliverable.deliverable_id);
    const after = childDeliverable?.quality_report_id
      ? (await request(`/api/quality-reports/${childDeliverable.quality_report_id}`)).json.report
      : null;
    const targetCodes = plan.plan?.target_check_codes ?? [];
    const comparison = after
      ? improvementOf(before, after, targetCodes)
      : { improved: false, still_open: targetCodes, regressions: [], after: null };
    let activatedVersionId = null;
    if (comparison.improved) {
      const versions = (await request(`/api/runs/${run.id}/versions`)).json.versions;
      const adopted = versions.find(item => item.deliverable_id === deliverable.deliverable_id
        && item.adopted_from?.run_id === executed.child_run_id);
      if (adopted) {
        try {
          await request(`/api/runs/${run.id}/versions/${adopted.id}/activate`, { method: 'POST' });
          activatedVersionId = adopted.id;
        } catch (error) {
          traces.push({
            deliverable_id: deliverable.deliverable_id, stage: 'activate_failed',
            child_run_id: executed.child_run_id, version_id: adopted.id, error: error.message,
          });
        }
      }
    }
    traces.push({
      deliverable_id: deliverable.deliverable_id,
      stage: 'revision_executed',
      plan_id: plan.plan_id,
      action: plan.action,
      target_check_codes: targetCodes,
      child_run_id: executed.child_run_id,
      child_status: child.status,
      comparison,
      activated_version_id: activatedVersionId,
    });
  }
  return traces;
}

async function collectArmCandidates({ app, request, run, product, arm }) {
  const versions = (await request(`/api/runs/${run.id}/versions`)).json.versions;
  const reports = (await request(`/api/runs/${run.id}/quality-reports`)).json.reports;
  const output = [];
  for (const scenario of SCENARIOS) {
    const deliverable = run.deliverables.find(item => item.deliverable_id === scenario.deliverable);
    if (!deliverable?.active_version_id) {
      output.push({ scenario: scenario.id, deliverable: scenario.deliverable, error: 'NO_ACTIVE_VERSION' });
      continue;
    }
    const version = versions.find(item => item.id === deliverable.active_version_id);
    if (!version?.hash) {
      output.push({ scenario: scenario.id, deliverable: scenario.deliverable, error: 'VERSION_HASH_MISSING' });
      continue;
    }
    let bytes;
    try { bytes = await app.store.readBlob(version.hash, version.format); }
    catch (error) {
      output.push({ scenario: scenario.id, deliverable: scenario.deliverable, error: `BLOB_READ_FAILED：${error.message}` });
      continue;
    }
    if (!bytes) {
      output.push({ scenario: scenario.id, deliverable: scenario.deliverable, error: `BLOB_MISSING：${version.hash}.${version.format}` });
      continue;
    }
    // 修订后选用的版本可能来自子任务，其报告不在源任务的报告列表里，按 report_id 直接取
    let report = reports.find(item => item.id === version.report_id) ?? null;
    if (!report && version.report_id) {
      report = (await request(`/api/quality-reports/${version.report_id}`).catch(() => ({ json: {} })))?.json?.report ?? null;
    }
    output.push({
      scenario: scenario.id,
      deliverable: scenario.deliverable,
      version_id: version.id,
      run_id: run.id,
      bytes,
      format: version.format,
      width: version.width,
      height: version.height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      report: report ? { decision: report.decision, checks: report.checks } : null,
      selected_reason: arm === 'C' ? '初始版本或修订后按“无回归且目标检查关闭”规则选用' : '现有流程活动版本',
    });
  }
  return output;
}

async function runPipelineProduct(arm, product, stamp) {
  const storeDir = await mkdtemp(path.resolve(ROOT, `runtime/stage6-candidates/${stamp}/store-${arm}-${product.id}-`));
  const { app, base } = await startArmServer(arm, storeDir);
  const client = createClient(base);
  const started = Date.now();
  try {
    const context = await createProjectCase(client.request, product, stamp);
    let grantedCredits = 0;
    if (arm === 'C') {
      grantedCredits = await grantTestCredits(app, context.tenantId, {
        amount: 12, key: `stage6-credits-${stamp}-${product.id}`,
      });
    }
    const created = (await client.request('/api/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': `stage6-${stamp}-${arm}-${product.id}` },
      body: { project_id: context.project.id, quote_id: context.quote.quote_id },
    })).json;
    let run = await waitTerminal(client.request, created.run.id);
    const trace = {
      arm, product_id: `P${product.id}`, run_id: run.id, status: run.status,
      project_id: context.project.id, quote_credits: context.quote.estimated_credits,
      spec_version: context.spec?.version ?? context.spec?.id ?? null,
      truth_version: context.truth?.version ?? context.truth?.id ?? null,
      conflict_resolutions: context.resolutionCount,
      credits_granted: grantedCredits,
      wall_ms: Date.now() - started,
      revision_traces: [],
    };
    if (arm === 'C' && !NO_REVISION) {
      trace.revision_traces = await runRevisionRound(client.request, run, null, product, stamp);
      run = (await client.request(`/api/runs/${run.id}`)).json.run;
    }
    const candidates = await collectArmCandidates({ app, request: client.request, run, product, arm });
    trace.finished_ms = Date.now() - started;
    return { candidates, trace };
  } finally {
    await app.close({ deadlineMs: 5_000 });
  }
}

async function directGenerate(product, scenario) {
  const apiKey = process.env.PARATERA_API_KEY?.trim() || process.env.PILOTDECK_SEEDREAM_API_KEY?.trim();
  if (!apiKey) throw fail('A 臂缺少 PARATERA_API_KEY');
  const base = (process.env.PILOTDECK_SEEDREAM_BASE_URL?.trim() || 'https://llmapi.paratera.com/v1').replace(/\/+$/u, '');
  const model = process.env.PILOTDECK_SEEDREAM_MODEL?.trim() || 'Doubao-Seedream-4.0';
  const reference = await readFile(path.join(MATERIALS, product.upload_file));
  const started = Date.now();
  const response = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: scenario.prompt,
      image: `data:image/jpeg;base64,${reference.toString('base64')}`,
      size: `${scenario.width}x${scenario.height}`,
      response_format: 'b64_json',
      watermark: false,
      sequential_image_generation: 'disabled',
    }),
  });
  const raw = await response.text();
  const latencyMs = Date.now() - started;
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!response.ok) throw fail(`A 臂生图 HTTP ${response.status}：${(payload?.error?.message ?? raw).slice(0, 400)}`);
  const item = payload?.data?.[0];
  const b64 = item?.b64_json;
  if (!b64 && typeof item?.url !== 'string') throw fail('A 臂供应商未返回图片');
  const bytes = b64
    ? Buffer.from(b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, ''), 'base64')
    : Buffer.from(await (await fetch(item.url)).arrayBuffer());
  const info = await sharp(bytes).metadata();
  return {
    bytes,
    format: info.format === 'jpeg' ? 'jpg' : (info.format ?? 'jpg'),
    width: info.width,
    height: info.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    latency_ms: latencyMs,
    usage: payload?.usage ?? null,
    provider_request_id: payload?.id ?? response.headers.get('x-request-id') ?? null,
    model,
  };
}

async function fixtureDirect(product, scenario) {
  const seed = Number.parseInt(product.id, 10) || 0;
  const bytes = await sharp({
    create: {
      width: scenario.width,
      height: scenario.height,
      channels: 3,
      background: {
        r: 200 + (seed % 4) * 15,
        g: 210 + (scenario.id === 'scene' ? 12 : 0),
        b: 205 + (scenario.id === 'layout' ? 10 : 0),
      },
    },
  }).jpeg({ quality: 82 }).toBuffer();
  const info = await sharp(bytes).metadata();
  return {
    bytes,
    format: 'jpg',
    width: info.width,
    height: info.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    latency_ms: 0,
    usage: null,
    provider_request_id: null,
    model: 'fixture/direct',
  };
}

function blindId() {
  return `b_${randomBytes(4).toString('hex')}`;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function ratingCsv(entries) {
  const columns = ['blind_id', 'case_id', 'product_id', 'product_name', 'scenario', 'image_path',
    'rating_status', 'fact_error', 'missed_detection', 'false_alarm', 'unknown', 'quality_pass',
    'direct_adoption', 'severity', 'notes'];
  const lines = [columns.join(',')];
  for (const entry of entries) {
    lines.push(columns.map(column => csvEscape(entry[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

async function main() {
  if (DRY_RUN) console.log('DRY RUN：使用 fixture Provider，不调用供应商，产物不可用于效果验收');
  const outputDir = path.resolve(ROOT, `runtime/stage6-candidates/${STAMP}`);
  await mkdir(path.join(outputDir, 'blind'), { recursive: true });
  await writeFile(path.join(outputDir, '.gitignore'), '*\n', 'utf8').catch(() => {});
  const products = MANIFEST.filter(item => PRODUCTS.includes(String(item.id)));
  if (products.length === 0) throw fail(`没有匹配的商品：${PRODUCTS.join(',')}`);
  const all = [];
  const traces = [];
  const blindKey = {};
  const ratingEntries = [];

  for (const product of products) {
    console.log(`\n=== P${product.id} ${product.name} ===`);
    for (const arm of ARMS) {
      const started = Date.now();
      try {
        if (arm === 'A') {
          const candidates = [];
          for (const scenario of SCENARIOS) {
            const generated = DRY_RUN
              ? await fixtureDirect(product, scenario)
              : await directGenerate(product, scenario);
            candidates.push({ scenario: scenario.id, deliverable: scenario.deliverable, ...generated, selected_reason: DRY_RUN ? 'DRY RUN 占位图，不是模型效果' : '通用模型直接生成' });
          }
          const trace = { arm, product_id: `P${product.id}`, wall_ms: Date.now() - started, candidates: candidates.length };
          traces.push(trace);
          for (const candidate of candidates) all.push({ product, arm, ...candidate });
          console.log(`A ${product.id}：${candidates.length} 张，${Math.round((Date.now() - started) / 1000)}s`);
        } else {
          const result = await runPipelineProduct(arm, product, STAMP);
          traces.push(result.trace);
          for (const candidate of result.candidates) {
            if (candidate.error) { console.error(`  ${arm} ${candidate.scenario} 失败：${candidate.error}`); continue; }
            all.push({ product, arm, ...candidate });
          }
          console.log(`${arm} ${product.id}：${result.candidates.filter(item => !item.error).length} 张，任务 ${result.trace.run_id}，${Math.round((Date.now() - started) / 1000)}s`);
        }
      } catch (error) {
        if (DRY_RUN) throw error;
        const cause = error?.cause ? `${error.cause.code ?? ''} ${error.cause.message ?? ''}`.trim() : null;
        traces.push({
          arm, product_id: `P${product.id}`, error: error.message, cause,
          stack: String(error.stack ?? '').split('\n').slice(0, 3),
          details: error.details ?? null, wall_ms: Date.now() - started,
        });
        console.error(`${arm} ${product.id} 失败：${error.message}${cause ? `（${cause}）` : ''}`);
      }
    }
  }

  for (const candidate of all) {
    const id = blindId();
    blindKey[id] = { arm: candidate.arm, case_id: `P${candidate.product.id}-${candidate.scenario.toUpperCase().replaceAll('_', '-')}`, product_id: candidate.product.id, scenario: candidate.scenario };
    const filename = `${id}.${candidate.format === 'jpeg' ? 'jpg' : candidate.format}`;
    await writeFile(path.join(outputDir, 'blind', filename), candidate.bytes);
    ratingEntries.push({
      blind_id: id,
      case_id: blindKey[id].case_id,
      product_id: `P${candidate.product.id}`,
      product_name: candidate.product.name,
      scenario: candidate.scenario,
      image_path: `blind/${filename}`,
      rating_status: 'pending_human',
      fact_error: '', missed_detection: '', false_alarm: '', unknown: '', quality_pass: '',
      direct_adoption: '', severity: '', notes: '',
    });
  }

  const index = {
    schema_version: 'qtb-stage6-candidates.1',
    stamp: STAMP,
    dry_run: DRY_RUN,
    products: products.map(item => `P${item.id}`),
    arms: ARMS,
    scenarios: SCENARIOS.map(item => item.id),
    provider: DRY_RUN ? 'fixture' : (process.env.PILOTDECK_SEEDREAM_MODEL || 'Doubao-Seedream-4.0'),
    review_model: DRY_RUN ? null : (process.env.QTB_VISUAL_REVIEW_MODEL || 'GLM-4.5V'),
    acceptance: 'not_verified',
    count: all.length,
    candidates: all.map(item => ({
      arm: item.arm,
      case_id: `P${item.product.id}-${item.scenario.toUpperCase().replaceAll('_', '-')}`,
      product_id: `P${item.product.id}`,
      scenario: item.scenario,
      deliverable: item.deliverable,
      run_id: item.run_id ?? null,
      version_id: item.version_id ?? null,
      sha256: item.sha256,
      width: item.width,
      height: item.height,
      latency_ms: item.latency_ms ?? null,
      usage: item.usage ?? null,
      provider_request_id: item.provider_request_id ?? null,
      report: item.report ?? null,
      selected_reason: item.selected_reason,
    })),
    traces,
    note: '三臂候选只用于盲评；没有人工评分前不得计算漏检率、误判、净改善或成功率',
  };
  await writeFile(path.join(outputDir, 'candidates.json'), JSON.stringify(index, null, 2), 'utf8');
  await writeFile(path.join(outputDir, 'blind-key.json'), JSON.stringify(blindKey, null, 2), 'utf8');
  await writeFile(path.join(outputDir, 'rating-sheet.csv'), ratingCsv(ratingEntries), 'utf8');
  // 文档目录里的副本给评分人用，图片路径必须相对该目录可解析。
  // 已经有人工评分的数据不能被新批次覆盖：只有待评分或空表才写入 docs 副本。
  const docsSheet = path.resolve(ROOT, 'docs/ai-development/stage6/blind-rating-sheet.csv');
  const existing = await readFile(docsSheet, 'utf8').catch(() => '');
  const ratedInDocs = existing.split(/\r?\n/u).filter(line => line.includes(',rated,')).length;
  if (ratedInDocs > 0) {
    console.log(`\n已评分盲评表保留不动（${ratedInDocs} 条 rated）：docs/ai-development/stage6/blind-rating-sheet.csv`);
  } else {
    const imagePrefix = path.relative(path.dirname(docsSheet), path.join(outputDir, 'blind')).replaceAll('\\', '/');
    await writeFile(docsSheet, ratingCsv(ratingEntries.map(entry => ({
      ...entry, image_path: `${imagePrefix}/${path.basename(entry.image_path)}`,
    }))), 'utf8');
  }

  console.log(`\n候选 ${all.length} 张，已写入 ${path.relative(ROOT, outputDir).replaceAll('\\', '/')}`);
  console.log(`盲评表 docs/ai-development/stage6/blind-rating-sheet.csv；盲号映射同目录 blind-key.json（评分人不得看到）`);
  if (traces.some(item => item.error)) process.exitCode = 1;
}

main().catch(error => {
  console.error(`阶段 6 候选生成失败：${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details).slice(0, 800));
  process.exitCode = 1;
});
