#!/usr/bin/env node
/**
 * 阶段 6 就绪检查 + 保留集工作簿准备。
 *
 * 只做事实核对，不调用付费模型、不伪造标签：
 * 1. 规范样本表是否为 36 行、12 商品、8 开发 / 4 保留；
 * 2. 保留集工作簿是否为 P09—P12 × 3 场景，标签是否已人工确认；
 * 3. 保留集素材文件与哈希是否齐全；
 * 4. 真实生图、视觉评审、修订规划所需环境变量是否存在（不打印密钥）；
 * 5. 可选 --probe：只读校验供应商模型列表与本地桥接健康状态。
 *
 * 用法：
 *   node scripts/stage6-ready.mjs --prepare   # 生成保留集工作簿
 *   node scripts/stage6-ready.mjs             # 就绪检查
 *   node scripts/stage6-ready.mjs --probe     # 附加只读连通性检查
 *   node scripts/stage6-ready.mjs --json
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS, parseCsv, serializeCsv } from './ai-eval.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANONICAL = path.resolve(ROOT, 'docs/ai-development/eval/p0-cases.csv');
const STAGE6_DIR = path.resolve(ROOT, 'docs/ai-development/stage6');
const HOLDOUT = path.join(STAGE6_DIR, 'holdout-cases.csv');
const MATERIALS = path.resolve(ROOT, '../商品测试素材-12款');
const HOLDOUT_PRODUCTS = Object.freeze(['P09', 'P10', 'P11', 'P12']);

try { process.loadEnvFile(path.join(ROOT, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

function toRecords(table) {
  const header = table[0] ?? [];
  return table.slice(1).map(cells => Object.fromEntries(
    COLUMNS.map((column, index) => [column, (cells[index] ?? '').trim()]),
  ));
}

async function readRecords(file) {
  return toRecords(parseCsv(await readFile(file, 'utf8')));
}

export async function prepare() {
  const canonical = await readRecords(CANONICAL);
  if (canonical.length !== 36) throw new Error(`规范样本表应为 36 行，实际 ${canonical.length}`);
  const holdout = canonical.filter(row => row.split === 'holdout');
  if (holdout.length !== 12) throw new Error(`保留集应为 12 行，实际 ${holdout.length}`);
  await writeFile(HOLDOUT, serializeCsv(holdout), 'utf8');
  return { file: path.relative(ROOT, HOLDOUT).replaceAll('\\', '/'), rows: holdout.length };
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function checkFolder(file) {
  try { await readFile(file); return true; } catch { return false; }
}

export async function checkDataset() {
  const errors = [];
  const canonical = await readRecords(CANONICAL);
  const holdout = await readRecords(HOLDOUT).catch(() => []);
  const products = new Map();
  for (const row of canonical) {
    if (!products.has(row.product_id)) products.set(row.product_id, new Set());
    products.get(row.product_id).add(row.scenario);
  }
  const dev = canonical.filter(row => row.split === 'dev');
  const hold = canonical.filter(row => row.split === 'holdout');
  if (canonical.length !== 36) errors.push(`规范样本表应为 36 行，实际 ${canonical.length}`);
  if (products.size !== 12) errors.push(`规范样本表应有 12 个商品，实际 ${products.size}`);
  if (new Set(dev.map(row => row.product_id)).size !== 8) errors.push('开发集应为 8 个商品');
  if (new Set(hold.map(row => row.product_id)).size !== 4) errors.push('保留集应为 4 个商品');

  if (holdout.length !== 12) errors.push(`保留集工作簿应为 12 行（可用 --prepare 生成），实际 ${holdout.length}`);
  const holdoutProducts = new Map();
  for (const row of holdout) {
    if (!HOLDOUT_PRODUCTS.includes(row.product_id)) errors.push(`保留集工作簿出现非保留商品：${row.product_id}`);
    if (row.split !== 'holdout') errors.push(`${row.case_id} 的 split 不是 holdout`);
    if (!holdoutProducts.has(row.product_id)) holdoutProducts.set(row.product_id, new Set());
    holdoutProducts.get(row.product_id).add(row.scenario);
  }
  for (const productId of HOLDOUT_PRODUCTS) {
    const scenarios = holdoutProducts.get(productId) ?? new Set();
    if (scenarios.size !== 3) errors.push(`${productId} 场景不完整：${[...scenarios].join(', ') || '无'}`);
  }
  const confirmed = holdout.filter(row => row.label_status === 'confirmed').length;
  const pending = holdout.length - confirmed;
  return {
    errors,
    canonical: { rows: canonical.length, products: products.size, devRows: dev.length, holdoutRows: hold.length },
    holdout: { rows: holdout.length, products: holdoutProducts.size, confirmed, pending },
  };
}

export async function checkMaterials() {
  const errors = [];
  let manifest = [];
  try { manifest = JSON.parse(await readFile(path.join(MATERIALS, '素材清单.json'), 'utf8')); }
  catch (error) { errors.push(`素材清单不可读：${error.message}`); return { errors, products: 0, verified: 0 }; }
  const byId = new Map(manifest.map(item => [`P${item.id}`, item]));
  let verified = 0;
  for (const productId of HOLDOUT_PRODUCTS) {
    const item = byId.get(productId);
    if (!item) { errors.push(`${productId} 不在素材清单中`); continue; }
    let ok = true;
    for (const relative of [item.original_file, item.upload_file, item.preview_file]) {
      if (!await checkFolder(path.join(MATERIALS, relative))) {
        errors.push(`${productId} 缺少素材文件：${relative}`);
        ok = false;
      }
    }
    try {
      const actual = hash(await readFile(path.join(MATERIALS, item.original_file)));
      if (actual !== item.sha256) { errors.push(`${productId} 原始图哈希与清单不符`); ok = false; }
    } catch (error) { errors.push(`${productId} 原始图不可读：${error.message}`); ok = false; }
    if (!Array.isArray(item.licenses) || item.licenses.length === 0 || !item.author) {
      errors.push(`${productId} 缺少授权或作者信息`);
      ok = false;
    }
    if (ok) verified += 1;
  }
  return { errors, products: HOLDOUT_PRODUCTS.length, verified };
}

export function checkEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const mode = String(env.QTB_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock';
  const imageKey = Boolean(env.PARATERA_API_KEY?.trim() || env.PILOTDECK_SEEDREAM_API_KEY?.trim());
  const reviewEndpoint = env.QTB_VISUAL_REVIEW_ENDPOINT?.trim() || '';
  const plannerEndpoint = env.QTB_REVISION_PLANNER_ENDPOINT?.trim() || '';
  if (mode !== 'seedream') errors.push(`真实生图未启用：QTB_PROVIDER=${mode}`);
  if (!imageKey) errors.push('生图缺少 PARATERA_API_KEY 或 PILOTDECK_SEEDREAM_API_KEY');
  if (!reviewEndpoint) errors.push('缺少 QTB_VISUAL_REVIEW_ENDPOINT，视觉评审项只会是 unknown');
  if (!plannerEndpoint) errors.push('缺少 QTB_REVISION_PLANNER_ENDPOINT，修订只能走确定性规则');
  if (!env.QTB_OCR_ENDPOINT?.trim()) warnings.push('未配置 QTB_OCR_ENDPOINT，文字检查会按 unknown 计入');
  return {
    errors,
    warnings,
    mode,
    imageKey,
    review: { endpoint: reviewEndpoint, model: env.QTB_VISUAL_REVIEW_MODEL?.trim() || null },
    planner: { endpoint: plannerEndpoint, model: env.QTB_REVISION_PLANNER_MODEL?.trim() || null },
    ocr: { endpoint: env.QTB_OCR_ENDPOINT?.trim() || null },
  };
}

async function probeEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
      return { status: 'skipped', reason: '非 loopback 端点，未做主动探测' };
    }
    const health = new URL('/healthz', url.origin);
    const response = await fetch(health, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json().catch(() => null);
    return { status: response.ok ? 'ok' : 'failed', http_status: response.status, service: body?.service ?? null };
  } catch (error) {
    return { status: 'failed', reason: error?.message ?? 'UNKNOWN_ERROR' };
  }
}

export async function probe(env = process.env) {
  const result = { errors: [], image_model: null, review: null, planner: null };
  const key = env.PARATERA_API_KEY?.trim() || env.PILOTDECK_SEEDREAM_API_KEY?.trim();
  const base = (env.PILOTDECK_SEEDREAM_BASE_URL?.trim() || 'https://llmapi.paratera.com/v1').replace(/\/+$/u, '');
  if (key) {
    try {
      const response = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`模型列表 HTTP ${response.status}`);
      const payload = await response.json();
      const ids = new Set((payload?.data ?? []).map(item => item.id));
      const model = env.PILOTDECK_SEEDREAM_MODEL?.trim() || 'Doubao-Seedream-4.0';
      const reviewModel = env.QTB_VISUAL_REVIEW_MODEL?.trim() || env.QTB_STAGE6_DEFAULT_MODEL?.trim() || 'GLM-4.6V';
      result.image_model = { model, available: ids.has(model) };
      if (!ids.has(model)) result.errors.push(`生图模型 ${model} 不在供应商模型列表`);
      if (!ids.has(reviewModel)) result.errors.push(`评审模型 ${reviewModel} 不在供应商模型列表`);
    } catch (error) {
      result.errors.push(`供应商只读探测失败：${error?.message ?? error}`);
    }
  } else {
    result.errors.push('供应商探测缺少密钥');
  }
  const reviewEndpoint = env.QTB_VISUAL_REVIEW_ENDPOINT?.trim();
  const plannerEndpoint = env.QTB_REVISION_PLANNER_ENDPOINT?.trim();
  if (reviewEndpoint) {
    result.review = await probeEndpoint(reviewEndpoint);
    if (result.review.status === 'failed') result.errors.push('视觉评审端点不可达');
  }
  if (plannerEndpoint) {
    result.planner = await probeEndpoint(plannerEndpoint);
    if (result.planner.status === 'failed') result.errors.push('修订规划端点不可达');
  }
  return result;
}

export async function readiness({ doProbe = false, env = process.env } = {}) {
  const dataset = await checkDataset();
  const materials = await checkMaterials();
  const services = checkEnv(env);
  const probeInfo = doProbe ? await probe(env) : null;
  const blockers = [
    ...dataset.errors,
    ...materials.errors,
    ...services.errors,
    ...(probeInfo?.errors ?? []),
  ];
  if (dataset.holdout.pending > 0) {
    blockers.push(`保留集还有 ${dataset.holdout.pending} 条标签待人工确认，确认前不得计算漏检率、误判或净改善`);
  }
  return {
    schema_version: 'qtb-stage6-readiness.1',
    ready: blockers.length === 0,
    blockers,
    warnings: services.warnings,
    dataset,
    materials,
    services,
    probe: probeInfo,
  };
}

function printHuman(report) {
  console.log(`阶段 6 就绪：${report.ready ? '是' : '否'}`);
  console.log(`规范样本表 ${report.dataset.canonical.rows} 行 / ${report.dataset.canonical.products} 商品（开发 ${report.dataset.canonical.devRows} / 保留 ${report.dataset.canonical.holdoutRows}）`);
  console.log(`保留集 ${report.dataset.holdout.rows} 行 / ${report.dataset.holdout.products} 商品：已确认 ${report.dataset.holdout.confirmed}，待确认 ${report.dataset.holdout.pending}`);
  console.log(`保留集素材 ${report.materials.verified}/${report.materials.products} 通过`);
  console.log(`生图模式 ${report.services.mode}，密钥 ${report.services.imageKey ? '已配置' : '缺失'}，评审端点 ${report.services.review.endpoint || '缺失'}，规划端点 ${report.services.planner.endpoint || '缺失'}`);
  if (report.probe) {
    console.log(`只读探测：生图模型 ${report.probe.image_model?.model ?? '未检查'}，评审 ${report.probe.review?.status ?? '未检查'}，规划 ${report.probe.planner?.status ?? '未检查'}`);
  }
  for (const warning of report.warnings) console.warn(`- 警告：${warning}`);
  for (const blocker of report.blockers) console.error(`- 阻塞：${blocker}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--prepare')) {
    const result = await prepare();
    console.log(`已生成保留集工作簿：${result.file}（${result.rows} 行）`);
    if (!argv.includes('--json')) return;
  }
  const report = await readiness({ doProbe: argv.includes('--probe') });
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
