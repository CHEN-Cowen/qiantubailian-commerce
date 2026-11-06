#!/usr/bin/env node
/**
 * 商品视觉评审 / 修订工作流的离线评测入口（阶段 0）。
 *
 * 不调用任何真实模型或外部接口，只做三件事：
 * 1. 校验样本标注表的结构、商品划分与「未人工确认不得当标签」约束；
 * 2. 校验 12 份授权素材的文件哈希、尺寸与解码状态；
 * 3. 用 src/visual-contract.mjs 跑 Skills 协议样例与拒绝分支。
 *
 * 用法：
 *   node scripts/ai-eval.mjs                          # 全量离线核查
 *   node scripts/ai-eval.mjs --json                   # 机器可读输出
 *   node scripts/ai-eval.mjs --skip-materials         # 无素材目录时跳过文件核查
 *   node scripts/ai-eval.mjs --export-labels <path>   # 生成待人工标注模板
 */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { validateReviewOutput, validateRevisionPlan } from '../src/visual-contract.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_DATASET = path.resolve(ROOT, 'docs/ai-development/eval/p0-cases.csv');
const DEFAULT_MATERIALS = path.resolve(ROOT, '../商品测试素材-12款');
const SKILLS = {
  reviewer: path.resolve(ROOT, 'skills/commerce-image-reviewer/references/examples.json'),
  refiner: path.resolve(ROOT, 'skills/commerce-image-refiner/references/examples.json'),
};

const SCENARIOS = Object.freeze([
  {
    id: 'clean_bg',
    requirement: '干净背景主图：商品完整居中，保留轮廓、颜色、图案、数量与把手/瓶盖结构',
    risk: '主体轮廓、颜色与数量是否改变',
  },
  {
    id: 'scene',
    requirement: '生活场景图：在不改变商品事实与结构的前提下更换背景',
    risk: '场景合成是否遮挡、弯曲或补造商品结构',
  },
  {
    id: 'layout',
    requirement: '基础文案排版图：只叠加测试文字，不得覆盖商品关键细节',
    risk: '文字遮挡商品、错字或品牌布局冲突',
  },
]);

export const COLUMNS = Object.freeze([
  'case_id', 'product_id', 'product_name', 'sku_id', 'scenario',
  'asset_id', 'asset_role', 'candidate_version', 'fact_status', 'confirmed_facts',
  'requirement', 'expected_issues', 'visible_evidence', 'expected_status',
  'allowed_actions', 'missing_material_or_human', 'change_facts',
  'expected_affected_versions', 'annotator', 'review_result', 'split', 'label_status',
]);

const SPLIT_BY_PRODUCT = products => (products <= 8 ? 'dev' : 'holdout');

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) lines.push(COLUMNS.map(column => csvEscape(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(item => item.length > 0 && item.some(value => value.trim().length > 0));
}

async function readManifest(materialsRoot) {
  const manifestPath = path.join(materialsRoot, '素材清单.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest) || manifest.length !== 12) {
    throw new Error(`素材清单必须恰好 12 项，实际 ${manifest.length}`);
  }
  return manifest;
}

export async function buildRows(materialsRoot = DEFAULT_MATERIALS) {
  const manifest = await readManifest(materialsRoot);
  const rows = [];
  for (const item of manifest) {
    const split = SPLIT_BY_PRODUCT(Number(item.id));
    for (const scenario of SCENARIOS) {
      rows.push({
        case_id: `P${item.id}-${scenario.id.toUpperCase().replaceAll('_', '-')}`,
        product_id: `P${item.id}`,
        product_name: item.name,
        sku_id: `SKU-${item.id}-UNVERIFIED`,
        scenario: scenario.id,
        asset_id: `ASSET-${item.id}-UPLOAD`,
        asset_role: 'subject',
        candidate_version: 'pending_generation',
        fact_status: 'unconfirmed',
        confirmed_facts: '品牌/材质/尺寸/容量/性能与卖点均未确认',
        requirement: scenario.requirement,
        expected_issues: `待人工标注；样本观察重点：${item.test}；${scenario.risk}`,
        visible_evidence: '待人工观察原始素材',
        expected_status: 'pending_human_confirmation',
        allowed_actions: 'pending_p3',
        missing_material_or_human: '缺侧面/背面素材或未确认事实时必须转补拍或人工复核',
        change_facts: '无（本轮不执行事实变更）',
        expected_affected_versions: '无',
        annotator: 'AI 预标（待人工确认）',
        review_result: 'pending_human_confirmation',
        split,
        label_status: 'pending_human',
      });
    }
  }
  return rows;
}

function validateDataset(rows, errors) {
  const header = rows[0];
  if (!header || header.length !== COLUMNS.length) {
    errors.push(`样本表表头必须为 ${COLUMNS.length} 列，实际 ${header?.length ?? 0} 列`);
    return [];
  }
  COLUMNS.forEach((column, index) => {
    if (header[index] !== column) errors.push(`第 ${index + 1} 列表头应为 ${column}，实际 ${header[index]}`);
  });
  const records = rows.slice(1).map((cells, index) => {
    const record = Object.fromEntries(COLUMNS.map((column, position) => [column, (cells[position] ?? '').trim()]));
    if (cells.length !== COLUMNS.length) errors.push(`第 ${index + 2} 行列数不符：${cells.length}`);
    return record;
  });

  const ids = new Set();
  const products = new Map();
  for (const record of records) {
    if (ids.has(record.case_id)) errors.push(`重复 case_id：${record.case_id}`);
    ids.add(record.case_id);
    if (!products.has(record.product_id)) products.set(record.product_id, { name: record.product_name, split: record.split, scenarios: [] });
    const product = products.get(record.product_id);
    if (product.split !== record.split) errors.push(`${record.product_id} 同时出现在开发集与保留集`);
    product.scenarios.push(record.scenario);
    if (record.fact_status !== 'unconfirmed') errors.push(`${record.case_id} 事实状态必须为 unconfirmed，禁止把未确认事实当标签`);
    if (!['pending_human', 'confirmed'].includes(record.label_status)) errors.push(`${record.case_id} label_status 非法`);
    if (record.label_status === 'pending_human' && record.review_result !== 'pending_human_confirmation') {
      errors.push(`${record.case_id} 未人工确认时复核结果必须为 pending_human_confirmation`);
    }
    if (record.expected_status !== 'pending_human_confirmation' && record.label_status !== 'confirmed') {
      errors.push(`${record.case_id} 未人工确认时不得填写预期状态`);
    }
  }

  const expected = 12 * SCENARIOS.length;
  if (records.length !== expected) errors.push(`样本行数应为 ${expected}（12 商品 × ${SCENARIOS.length} 场景），实际 ${records.length}`);
  const productSplit = { dev: [], holdout: [] };
  for (const [productId, product] of products) {
    const uniqueScenarios = new Set(product.scenarios);
    if (uniqueScenarios.size !== SCENARIOS.length) {
      errors.push(`${productId} 场景不完整：${[...uniqueScenarios].join(', ')}`);
    }
    if (productSplit[product.split]) productSplit[product.split].push(productId);
  }
  for (const split of ['dev', 'holdout']) {
    if (productSplit[split].length === 0) errors.push(`${split} 集为空`);
  }
  const labeled = records.filter(record => record.label_status === 'confirmed').length;
  return { records, products, productSplit, labeled, labelsPending: records.length - labeled };
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function checkMaterials(materialsRoot, records, errors) {
  const manifest = await readManifest(materialsRoot);
  const byId = new Map(manifest.map(item => [`P${item.id}`, item]));
  const checked = new Set();
  const summary = { products: 0, sha256Ok: 0, decodableOk: 0, sizeOk: 0, licenseOk: 0 };
  for (const record of records) {
    if (checked.has(record.product_id)) continue;
    checked.add(record.product_id);
    summary.products += 1;
    const item = byId.get(record.product_id);
    if (!item) { errors.push(`${record.product_id} 在素材清单中不存在`); continue; }
    if (!Array.isArray(item.licenses) || item.licenses.length === 0 || !item.author) {
      errors.push(`${record.product_id} 缺少授权或作者信息`);
    } else summary.licenseOk += 1;
    for (const relative of [item.original_file, item.upload_file, item.preview_file]) {
      try { await stat(path.join(materialsRoot, relative)); }
      catch { errors.push(`${record.product_id} 缺少素材文件：${relative}`); }
    }
    try {
      const actual = await sha256(path.join(materialsRoot, item.original_file));
      if (actual !== item.sha256) errors.push(`${record.product_id} 原始图哈希与清单不符`);
      else summary.sha256Ok += 1;
    } catch (error) { errors.push(`${record.product_id} 原始图读取失败：${error.message}`); }
    try {
      const metadata = await sharp(path.join(materialsRoot, item.upload_file)).metadata();
      if (!metadata.width || !metadata.height) errors.push(`${record.product_id} 上传图无法解码`);
      else summary.decodableOk += 1;
      if (!metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > 2048) {
        errors.push(`${record.product_id} 上传图最长边超过 2048`);
      } else summary.sizeOk += 1;
      if (metadata.format !== 'jpeg') errors.push(`${record.product_id} 上传图必须为 JPEG，实际 ${metadata.format}`);
    } catch (error) { errors.push(`${record.product_id} 上传图解码失败：${error.message}`); }
  }
  return summary;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function caseById(cases, id) {
  return cases.find(item => item.id === id);
}

function negativeCases(reviewer, refiner) {
  const reviewPass = caseById(reviewer.cases, 'review_pass');
  const reviewColor = caseById(reviewer.cases, 'review_color_fail');
  const reviewUnknown = caseById(reviewer.cases, 'review_small_text_unknown');
  const reviewUnavailable = caseById(reviewer.cases, 'review_image_unavailable');
  const revAction = caseById(refiner.cases, 'refiner_action');
  const revStale = caseById(refiner.cases, 'refiner_stale');
  const revNoChange = caseById(refiner.cases, 'refiner_no_change');
  const revMaterial = caseById(refiner.cases, 'refiner_material');
  const mutations = [];
  const add = (id, kind, mutate) => {
    const base = kind === 'review' ? reviewPass : revAction;
    const copy = clone(base);
    mutate(copy);
    mutations.push({ id, kind, request: copy.input, output: copy.output });
  };

  add('review-duplicate-code', 'review', test => { test.output.checks[7].code = 'PRODUCT_IDENTITY'; });
  add('review-binding-mismatch', 'review', test => { test.output.artifact_hash = 'tampered'; });
  add('review-region-reversed', 'review', test => {
    const source = clone(reviewColor);
    test.output = clone(source.output);
    test.input = source.input;
    test.output.checks.find(check => check.code === 'PRODUCT_COLOR').region = [0.6, 0.1, 0.3, 0.3];
  });
  add('review-unavailable-pass', 'review', test => {
    const source = clone(reviewUnavailable);
    test.output = clone(source.output);
    test.input = source.input;
    test.output.checks[0].status = 'pass';
    test.output.checks[0].suggested_fix = null;
  });
  add('review-fail-no-fix', 'review', test => {
    const source = clone(reviewColor);
    test.output = clone(source.output);
    test.input = source.input;
    test.output.checks.find(check => check.code === 'PRODUCT_COLOR').suggested_fix = null;
  });
  add('review-unknown-no-reason', 'review', test => {
    const source = clone(reviewUnknown);
    test.output = clone(source.output);
    test.input = source.input;
    test.output.unknown_reasons = [];
  });
  add('review-reference-candidate', 'review', test => {
    test.output.checks[0].reference_image_ids = ['candidate_01'];
  });
  add('review-no-reference-pass', 'review', test => {
    test.input.image_bindings = test.input.image_bindings.filter(item => item.role !== 'subject');
    test.output.checks.forEach(check => { check.reference_image_ids = []; });
  });
  add('review-missing-check', 'review', test => { test.output.checks.pop(); });
  add('review-extra-field', 'review', test => { test.output.verdict = 'ok'; });

  add('revision-stale-action', 'revision', test => {
    const source = clone(revStale);
    test.input = clone(source.input);
    test.output = clone(source.output);
    test.output.decision = 'propose_action';
    test.output.action = 'recompose_subject';
    test.output.target_check_codes = ['PRODUCT_COLOR'];
    test.output.parameters = { subject_asset_id: 'asset_subject' };
    test.output.instruction = '恢复白色瓶盖';
  });
  add('revision-action-unavailable', 'revision', test => { test.output.action = 'masked_edit'; });
  add('revision-target-pass', 'revision', test => { test.output.target_check_codes = ['PRODUCT_IDENTITY']; });
  add('revision-unauthorized-asset', 'revision', test => { test.output.parameters.subject_asset_id = 'asset_other'; });
  add('revision-over-budget', 'revision', test => { test.input.limits.budget_remaining = 0; });
  add('revision-no-change-unresolved', 'revision', test => {
    const source = clone(revNoChange);
    test.input = clone(source.input);
    test.output = clone(source.output);
    test.input.issue_catalog.find(issue => issue.code === 'PRODUCT_COLOR').status = 'fail';
  });
  add('revision-material-missing', 'revision', test => {
    const source = clone(revMaterial);
    test.input = clone(source.input);
    test.output = clone(source.output);
    test.output.material_requests = [];
  });
  add('revision-action-with-material', 'revision', test => { test.output.material_requests = ['补充侧面图']; });
  add('revision-binding-mismatch', 'revision', test => { test.output.based_on_report_id = 'stale_report'; });
  add('revision-extra-field', 'revision', test => { test.output.confidence = 0.9; });
  return mutations;
}

async function runProtocol(errors) {
  const reviewer = JSON.parse(await readFile(SKILLS.reviewer, 'utf8'));
  const refiner = JSON.parse(await readFile(SKILLS.refiner, 'utf8'));
  if (reviewer.synthetic !== true || refiner.synthetic !== true) {
    errors.push('Skills 样例必须声明 synthetic=true，避免被当成真实模型结果');
  }
  let reviewOk = 0;
  for (const item of reviewer.cases) {
    const result = validateReviewOutput(item.output, { request: item.input });
    if (!result.ok) errors.push(`评审样例 ${item.id} 未通过协议：${result.errors.map(error => error.code).join(', ')}`);
    else reviewOk += 1;
  }
  let revisionOk = 0;
  for (const item of refiner.cases) {
    const result = validateRevisionPlan(item.output, { request: item.input });
    if (!result.ok) errors.push(`修订样例 ${item.id} 未通过协议：${result.errors.map(error => error.code).join(', ')}`);
    else revisionOk += 1;
  }
  const mutations = negativeCases(reviewer, refiner);
  let rejected = 0;
  for (const item of mutations) {
    const result = item.kind === 'review'
      ? validateReviewOutput(item.output, { request: item.request })
      : validateRevisionPlan(item.output, { request: item.request });
    if (result.ok) errors.push(`拒绝用例未被拦截：${item.id}`);
    else rejected += 1;
  }
  return {
    reviewerFixtures: reviewer.cases.length,
    reviewerFixturesOk: reviewOk,
    refinerFixtures: refiner.cases.length,
    refinerFixturesOk: revisionOk,
    negativeCases: mutations.length,
    negativeRejected: rejected,
  };
}

async function pathExists(file) {
  try { await stat(file); return true; } catch { return false; }
}

export async function evaluate({ dataset = DEFAULT_DATASET, materials = DEFAULT_MATERIALS, skipMaterials = false } = {}) {
  const errors = [];
  const text = await readFile(dataset, 'utf8');
  const table = parseCsv(text);
  const datasetInfo = validateDataset(table, errors);

  let materialsInfo = { skipped: true, reason: '未执行素材文件核查' };
  if (!skipMaterials) {
    if (!await pathExists(materials)) {
      errors.push(`素材目录不存在：${materials}；如确实不可用请显式传 --skip-materials`);
    } else {
      materialsInfo = await checkMaterials(materials, datasetInfo.records, errors);
    }
  }

  const protocolInfo = await runProtocol(errors);

  const effectMetrics = {
    available: datasetInfo.labeled > 0,
    reason: datasetInfo.labeled > 0 ? '' : '没有任何人工确认标签，本轮不得计算漏检率、误拦截或净改善',
    denominators: {
      labeledCases: datasetInfo.labeled,
      pendingHumanConfirmation: datasetInfo.labelsPending,
      totalCases: datasetInfo.records.length,
    },
  };

  return {
    schema_version: 'qtb-offline-eval.1',
    ok: errors.length === 0,
    errors,
    dataset: {
      path: path.relative(ROOT, dataset).replaceAll('\\', '/'),
      rows: datasetInfo.records.length,
      products: datasetInfo.products.size,
      devProducts: datasetInfo.productSplit.dev.length,
      holdoutProducts: datasetInfo.productSplit.holdout.length,
      labeled: datasetInfo.labeled,
      labelsPending: datasetInfo.labelsPending,
    },
    materials: materialsInfo,
    protocol: protocolInfo,
    effect_metrics: effectMetrics,
  };
}

function printHuman(report) {
  console.log(`离线评测：${report.ok ? '通过' : '失败'}`);
  console.log(`样本表 ${report.dataset.rows} 行 / ${report.dataset.products} 商品 / 开发集 ${report.dataset.devProducts} / 保留集 ${report.dataset.holdoutProducts}`);
  console.log(`人工确认标签 ${report.dataset.labeled}，待确认 ${report.dataset.labelsPending}`);
  if (report.materials.skipped) console.log(`素材文件：跳过（${report.materials.reason}）`);
  else console.log(`素材文件：${report.materials.products} 商品，哈希 ${report.materials.sha256Ok}，可解码 ${report.materials.decodableOk}，尺寸合规 ${report.materials.sizeOk}，授权信息 ${report.materials.licenseOk}`);
  console.log(`协议样例：评审 ${report.protocol.reviewerFixturesOk}/${report.protocol.reviewerFixtures}，修订 ${report.protocol.refinerFixturesOk}/${report.protocol.refinerFixtures}，拒绝分支 ${report.protocol.negativeRejected}/${report.protocol.negativeCases}`);
  console.log(`效果指标：${report.effect_metrics.available ? '可计算' : report.effect_metrics.reason}`);
  for (const error of report.errors) console.error(`- ${error}`);
}

function parseArgs(argv) {
  const options = { json: false, skipMaterials: false, exportLabels: null, dataset: DEFAULT_DATASET, materials: DEFAULT_MATERIALS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--skip-materials') options.skipMaterials = true;
    else if (arg === '--export-labels') options.exportLabels = path.resolve(argv[++index]);
    else if (arg === '--dataset') options.dataset = path.resolve(argv[++index]);
    else if (arg === '--materials') options.materials = path.resolve(argv[++index]);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.exportLabels) {
    const rows = await buildRows(options.materials);
    await writeFile(options.exportLabels, serializeCsv(rows), 'utf8');
    console.log(`已生成待人工标注模板：${options.exportLabels}（${rows.length} 行）`);
    return;
  }
  const report = await evaluate(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
