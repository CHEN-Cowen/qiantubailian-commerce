/**
 * 阶段 0：商品图评审 / 修订协议与离线评测入口。
 *
 * 约束：
 * 1. Skills 样例全部为 synthetic，只能证明协议可被程序校验，不能当作真实模型结果。
 * 2. 未人工确认的真实标签不得计入效果指标；本轮标注数必须为 0。
 * 3. 拒绝分支必须被拦截，避免宽松通过。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateReviewOutput, validateRevisionPlan } from '../src/visual-contract.mjs';
import { COLUMNS, evaluate, parseCsv, serializeCsv } from '../scripts/ai-eval.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function skills(name) {
  return JSON.parse(await readFile(`${root}skills/${name}/references/examples.json`, 'utf8'));
}

test('评审协议：四个合成样例全部通过结构与语义校验', async () => {
  const reviewer = await skills('commerce-image-reviewer');
  assert.equal(reviewer.synthetic, true);
  for (const item of reviewer.cases) {
    const result = validateReviewOutput(item.output, { request: item.input });
    assert.equal(result.ok, true, `${item.id}: ${JSON.stringify(result.errors)}`);
  }
});

test('评审协议：缺候选图、未知与证据边界被正确区分', async () => {
  const reviewer = await skills('commerce-image-reviewer');
  const unavailable = reviewer.cases.find(item => item.id === 'review_image_unavailable');
  const unknown = reviewer.cases.find(item => item.id === 'review_small_text_unknown');
  const colorFail = reviewer.cases.find(item => item.id === 'review_color_fail');
  assert.equal(validateReviewOutput(unavailable.output, { request: unavailable.input }).ok, true);
  assert.equal(validateReviewOutput(unknown.output, { request: unknown.input }).ok, true);
  assert.equal(validateReviewOutput(colorFail.output, { request: colorFail.input }).ok, true);

  const tampered = structuredClone(colorFail.output);
  tampered.checks.find(check => check.code === 'PRODUCT_COLOR').region = [0.6, 0.1, 0.3, 0.3];
  const reversed = validateReviewOutput(tampered, { request: colorFail.input });
  assert.equal(reversed.ok, false);
  assert.ok(reversed.errors.some(error => error.code === 'INVALID_REGION'));

  const noReason = structuredClone(unknown.output);
  noReason.unknown_reasons = [];
  const reasonMissing = validateReviewOutput(noReason, { request: unknown.input });
  assert.equal(reasonMissing.ok, false);
  assert.ok(reasonMissing.errors.some(error => error.code === 'MISSING_UNKNOWN_REASONS'));
});

test('修订协议：六个合成样例全部通过，覆盖动作/停止/补素材/复核/无需修改', async () => {
  const refiner = await skills('commerce-image-refiner');
  assert.equal(refiner.synthetic, true);
  const expected = ['propose_action', 'needs_review', 'stop', 'needs_material', 'no_change', 'needs_review'];
  assert.deepEqual(refiner.cases.map(item => item.output.decision), expected);
  for (const item of refiner.cases) {
    const result = validateRevisionPlan(item.output, { request: item.input });
    assert.equal(result.ok, true, `${item.id}: ${JSON.stringify(result.errors)}`);
  }
});

test('修订协议：过期报告、越权动作、越预算、未授权素材与未解决必需项均被拦截', async () => {
  const refiner = await skills('commerce-image-refiner');
  const action = refiner.cases.find(item => item.id === 'refiner_action');
  const stale = refiner.cases.find(item => item.id === 'refiner_stale');
  const noChange = refiner.cases.find(item => item.id === 'refiner_no_change');

  const staleAction = structuredClone(action);
  staleAction.input.report_valid = false;
  staleAction.output.based_on_report_id = stale.output.based_on_report_id;
  let result = validateRevisionPlan(staleAction.output, { request: staleAction.input });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'STALE_REPORT'));

  const unavailable = structuredClone(action);
  unavailable.output.action = 'masked_edit';
  result = validateRevisionPlan(unavailable.output, { request: unavailable.input });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'ACTION_NOT_AVAILABLE'));

  const overBudget = structuredClone(action);
  overBudget.input.limits.budget_remaining = 0;
  result = validateRevisionPlan(overBudget.output, { request: overBudget.input });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'LIMITS_EXCEEDED'));

  const asset = structuredClone(action);
  asset.output.parameters.subject_asset_id = 'asset_other';
  result = validateRevisionPlan(asset.output, { request: asset.input });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'ASSET_NOT_ALLOWED'));

  const unresolved = structuredClone(noChange);
  unresolved.input.issue_catalog.find(issue => issue.code === 'PRODUCT_COLOR').status = 'fail';
  result = validateRevisionPlan(unresolved.output, { request: unresolved.input });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'UNRESOLVED_ISSUES'));
});

test('离线评测：36 条计划案例按商品划分，全部标签待人工确认且指标不可计算', async () => {
  const report = await evaluate({ skipMaterials: true });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.dataset.rows, 36);
  assert.equal(report.dataset.products, 12);
  assert.equal(report.dataset.devProducts, 8);
  assert.equal(report.dataset.holdoutProducts, 4);
  assert.equal(report.dataset.labeled, 0);
  assert.equal(report.dataset.labelsPending, 36);
  assert.equal(report.effect_metrics.available, false);
  assert.match(report.effect_metrics.reason, /没有任何人工确认标签/);
  assert.equal(report.protocol.reviewerFixturesOk, report.protocol.reviewerFixtures);
  assert.equal(report.protocol.refinerFixturesOk, report.protocol.refinerFixtures);
  assert.equal(report.protocol.negativeRejected, report.protocol.negativeCases);
});

test('CSV 解析与序列化保持列顺序与中文内容', () => {
  const rows = parseCsv(serializeCsv([{
    case_id: 'P01-CLEAN-BG',
    product_id: 'P01',
    product_name: '陶瓷马克杯',
    sku_id: 'SKU-01-UNVERIFIED',
    scenario: 'clean_bg',
  }]));
  assert.deepEqual(rows[0], COLUMNS);
  assert.equal(rows[1][COLUMNS.indexOf('product_name')], '陶瓷马克杯');
});
