/**
 * E04 测试：SKU 防串图与包含物核对（三层：ownership / structure / visual）。
 *
 * 覆盖：
 * 1. 纯函数 ownership：认领集含预期外已知 SKU → SKU_MISMATCH blocker；已裁决 reassign 不重报；
 *    无任何归属证据 → OWNERSHIP_UNKNOWN review；其他 SKU 专属素材串用 → ASSET_CROSS_SKU（风格素材共享除外）；
 * 2. 纯函数 structure：无文字层 → STRUCTURE_UNKNOWN；引用已删事实 → FACT_REMOVED；
 *    数量值/单位与档案包含物矛盾 → QUANTITY_CONFLICT / UNIT_CONFLICT；SKU 属性矛盾 → SPEC_CONFLICT；
 *    归一化等价（500ml≡0.5L）不误报；
 * 3. 纯函数 visual：未配置/识别失败保持 VISUAL_UNAVAILABLE（review，不阻断、不伪造已核对）；
 *    OCR 数量 token 与展示事实不一致 → VISUAL_QUANTITY_SUSPECT；一致不报；
 * 4. 纯函数 effectiveSkuOf 优先级（reassign > 依赖 sku 条目 > truth.sku）与 validateResolveInput 全部闸口；
 * 5. 纯函数 planSkuExport：归属其他 SKU 不混入也不罗列；归属不明/报告缺失/失效/未通过/未解除阻断/未结算逐项排除；
 *    全排除 → SKU_EXPORT_EMPTY；路径按 sku_code 组织；
 * 6. 集成：两 SKU 项目——干净核对幂等；人工错配关联 → SKU_MISMATCH → confirm 409（满意不覆盖硬错误）
 *    → reassign 收口 + 依赖 manual 留痕 → 重核不重报；复核绑定版本（新版本重新开单）；
 * 7. 集成：SPEC_CONFLICT 修档后 recheck_clear 自动收口；FACT_REMOVED 与导出 STALE 闸口；
 * 8. 集成：按 SKU 导出（zip 内含 sku_code 目录与 sku-manifest.json；归属其他 SKU 的图不混入；
 *    OPEN_BLOCKER 排除）；NO_SKU_PROFILE 409 / SKU_EXPORT_EMPTY 409 / sku_id 缺失 422 / SKU_NOT_FOUND 404；
 * 9. 跨租户：sku-checks / resolve / sku-exports / 版本内容 / 导出下载 一律 404。
 * 运行：node --test test/e04.js（Node 22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  AUTO_CLEAR_ACTION, effectiveSkuOf, evaluateSkuChecks, planSkuExport, validateResolveInput,
} from '../src/skucheck.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 纯函数 ----------

const PROFILE = {
  version: 1,
  skus: [
    {
      id: 'sku_a', sku_code: 'E04-01', label: '标准装', confirmed: true,
      attributes: [{ key: '容量', value: '50', unit: 'g' }],
      contents: [{ item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' }],
    },
    {
      id: 'sku_b', sku_code: 'E04-02', label: '双支装', confirmed: true,
      attributes: [{ key: '容量', value: '100', unit: 'g' }],
      contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
    },
  ],
};
const PROJECT = { id: 'proj_1', tenant_id: 't1', sku: 'E04-01' };
const TRUTH = {
  version: 1, sku: 'E04-01',
  facts: [
    { key: '容量', value: '50', unit: 'g' },
    { key: '瓶装数量', value: '1', unit: '瓶' },
    { key: '核心卖点', value: '舒缓维稳', unit: null },
  ],
};
const RUN = { id: 'run_1', tenant_id: 't1', project_id: 'proj_1', status: 'completed' };
const VERSION = { id: 'ver_1', deliverable_id: 'benefit', active: true, number: 1 };

function ownershipDrafts({ dependencyRecord, priorIssues = [], truth = TRUTH, profile = PROFILE, assetsById = new Map() }) {
  return evaluateSkuChecks({
    run: RUN, version: VERSION, dependencyRecord, skuProfile: profile, truth,
    project: PROJECT, assetsById, textLayers: [], ocr: { status: 'ok', lines: [] }, priorIssues,
  }).filter(item => item.layer === 'ownership');
}

test('E04 纯函数 ownership：错配/未知/跨 SKU 素材/裁决不重报', () => {
  // 依赖 sku 条目命中预期 → 无问题
  assert.deepEqual(ownershipDrafts({ dependencyRecord: { entries: [{ kind: 'sku', ref: 'sku_a', evidence: 'deterministic' }] } }), []);
  // 认领集混入其他已知 SKU → SKU_MISMATCH blocker
  const mismatch = ownershipDrafts({
    dependencyRecord: { entries: [
      { kind: 'sku', ref: 'sku_a', evidence: 'deterministic' },
      { kind: 'sku', ref: 'sku_b', evidence: 'manual' },
    ] },
  });
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].code, 'SKU_MISMATCH');
  assert.equal(mismatch[0].severity, 'blocker');
  assert.deepEqual(mismatch[0].evidence.wrong_sku_ids, ['sku_b']);
  // 缺预期 SKU（只有其他 SKU 的认领）→ SKU_MISMATCH
  assert.equal(ownershipDrafts({
    dependencyRecord: { entries: [{ kind: 'sku', ref: 'sku_b', evidence: 'manual' }] },
  })[0]?.code, 'SKU_MISMATCH');
  // 同一认领集已被 reassign 裁决（目标在认领集内）→ 不重报
  const adjudicated = ownershipDrafts({
    dependencyRecord: { entries: [
      { kind: 'sku', ref: 'sku_a', evidence: 'deterministic' },
      { kind: 'sku', ref: 'sku_b', evidence: 'manual' },
    ] },
    priorIssues: [{
      version_id: 'ver_1', status: 'resolved',
      resolution: { action: 'reassign', target_sku_id: 'sku_b', at: '2026-01-01T00:00:00Z' },
    }],
  });
  assert.deepEqual(adjudicated, [], '已裁决的认领集不应重复开单');
  // 裁决目标不在认领集内（裁决针对另一归属）→ 仍报
  assert.equal(ownershipDrafts({
    dependencyRecord: { entries: [{ kind: 'sku', ref: 'sku_b', evidence: 'manual' }] },
    priorIssues: [{
      version_id: 'ver_1', status: 'resolved',
      resolution: { action: 'reassign', target_sku_id: 'sku_a', at: '2026-01-01T00:00:00Z' },
    }],
  })[0]?.code, 'SKU_MISMATCH');
  // 多规格但无任何归属证据 → OWNERSHIP_UNKNOWN review
  const unknown = ownershipDrafts({ dependencyRecord: null });
  assert.equal(unknown[0]?.code, 'OWNERSHIP_UNKNOWN');
  assert.equal(unknown[0]?.severity, 'review');
  // 单规格档案：没有可串对象，不适用
  assert.deepEqual(ownershipDrafts({
    dependencyRecord: null,
    profile: { version: 1, skus: [PROFILE.skus[0]] },
  }), []);
  // 其他 SKU 的专属素材（source=asset 且 included）出现在依赖里 → ASSET_CROSS_SKU blocker
  const profileWithAsset = {
    version: 2,
    skus: [
      PROFILE.skus[0],
      {
        ...PROFILE.skus[1],
        contents: [{ item: '替换装实拍', quantity: 1, unit: '件', included: true, source: 'asset', source_asset_id: 'asset_x' }],
      },
    ],
  };
  const cross = ownershipDrafts({
    dependencyRecord: { entries: [
      { kind: 'sku', ref: 'sku_a', evidence: 'deterministic' },
      { kind: 'asset', ref: 'asset_x', evidence: 'deterministic' },
    ] },
    profile: profileWithAsset,
    assetsById: new Map([['asset_x', { id: 'asset_x', role: 'detail', filename: 'x.png' }]]),
  });
  assert.equal(cross[0]?.code, 'ASSET_CROSS_SKU');
  assert.equal(cross[0]?.severity, 'blocker');
  // 风格素材明确共享，不报
  assert.deepEqual(ownershipDrafts({
    dependencyRecord: { entries: [
      { kind: 'sku', ref: 'sku_a', evidence: 'deterministic' },
      { kind: 'asset', ref: 'asset_x', evidence: 'deterministic' },
    ] },
    profile: profileWithAsset,
    assetsById: new Map([['asset_x', { id: 'asset_x', role: 'style', filename: 'x.png' }]]),
  }), []);
});

test('E04 纯函数 structure：无层未知/事实删除/数量单位冲突/规格冲突与归一化等价', () => {
  const base = { run: RUN, version: VERSION, skuProfile: PROFILE, truth: TRUTH, project: PROJECT, ocr: { status: 'ok', lines: [] } };
  const structureOf = input => evaluateSkuChecks(input).filter(item => item.layer === 'structure');
  // 无文字层依据 → STRUCTURE_UNKNOWN review
  const unknown = structureOf({ ...base, textLayers: null });
  assert.equal(unknown[0]?.code, 'STRUCTURE_UNKNOWN');
  assert.equal(unknown[0]?.severity, 'review');
  // 引用已删除的事实 → FACT_REMOVED blocker
  const removed = structureOf({ ...base, textLayers: [{ source: 'fact', fact_key: '已删字段' }] });
  assert.equal(removed[0]?.code, 'FACT_REMOVED');
  assert.equal(removed[0]?.severity, 'blocker');
  // 数量值与档案包含物不一致 → QUANTITY_CONFLICT；单位维度不同 → UNIT_CONFLICT
  const truthTwo = { ...TRUTH, facts: [{ key: '瓶装数量', value: '2', unit: '瓶' }] };
  assert.equal(structureOf({ ...base, truth: truthTwo, textLayers: [{ source: 'fact', fact_key: '瓶装数量' }] })[0]?.code,
    'QUANTITY_CONFLICT', '「瓶装数量」后缀剥离后应命中包含物「瓶装」');
  const truthBox = { ...TRUTH, facts: [{ key: '瓶装数量', value: '1', unit: '盒' }] };
  assert.equal(structureOf({ ...base, truth: truthBox, textLayers: [{ source: 'fact', fact_key: '瓶装数量' }] })[0]?.code, 'UNIT_CONFLICT');
  // 一致（1瓶≡1瓶）不报
  assert.deepEqual(structureOf({ ...base, textLayers: [{ source: 'fact', fact_key: '瓶装数量' }] }), []);
  // SKU 属性与同名事实矛盾 → SPEC_CONFLICT；500ml≡0.5L 归一化等价不误报
  assert.equal(structureOf({ ...base, truth: { ...TRUTH, facts: [{ key: '容量', value: '70', unit: 'g' }] },
    textLayers: [{ source: 'fact', fact_key: '容量' }] })[0]?.code, 'SPEC_CONFLICT');
  const profileMl = {
    version: 3,
    skus: [{ ...PROFILE.skus[0], attributes: [{ key: '容量', value: '500', unit: 'ml' }] }, PROFILE.skus[1]],
  };
  assert.deepEqual(structureOf({ ...base, skuProfile: profileMl,
    truth: { ...TRUTH, facts: [{ key: '容量', value: '0.5', unit: 'L' }] },
    textLayers: [{ source: 'fact', fact_key: '容量' }] }), []);
});

test('E04 纯函数 visual：未配置/失败保持未知；OCR 数量疑点为候选证据', () => {
  const base = {
    run: RUN, version: VERSION, skuProfile: PROFILE, truth: TRUTH, project: PROJECT,
    textLayers: [{ source: 'fact', fact_key: '瓶装数量' }],
  };
  const visualOf = input => evaluateSkuChecks(input).filter(item => item.layer === 'visual');
  // 未配置 OCR → VISUAL_UNAVAILABLE（OCR_NOT_CONFIGURED），review 不阻断
  const missing = visualOf({ ...base, ocr: null });
  assert.equal(missing[0]?.code, 'VISUAL_UNAVAILABLE');
  assert.equal(missing[0]?.severity, 'review');
  assert.equal(missing[0]?.evidence.reason, 'OCR_NOT_CONFIGURED');
  // 识别失败/超预算 → 保持未知，原因透传
  assert.equal(visualOf({ ...base, ocr: { status: 'error', reason: 'BUDGET_LIMIT' } })[0]?.evidence.reason, 'BUDGET_LIMIT');
  // OCR 数量 token 与展示事实不一致 → VISUAL_QUANTITY_SUSPECT（候选证据，不伪造硬结论）
  const suspect = visualOf({ ...base, ocr: { status: 'ok', lines: [{ text: '双支装 2瓶' }] } });
  assert.equal(suspect[0]?.code, 'VISUAL_QUANTITY_SUSPECT');
  assert.equal(suspect[0]?.severity, 'review');
  assert.equal(suspect[0]?.evidence.ocr_token, '2瓶');
  // 一致（1瓶）不报
  assert.deepEqual(visualOf({ ...base, ocr: { status: 'ok', lines: [{ text: '标准装 1瓶' }] } }), []);
});

test('E04 纯函数 effectiveSkuOf 优先级与 validateResolveInput 闸口', () => {
  // reassign 裁决 > 依赖 sku 条目 > truth.sku
  assert.equal(effectiveSkuOf({
    version: VERSION, skuProfile: PROFILE, project: PROJECT,
    dependencyRecord: { entries: [{ kind: 'sku', ref: 'sku_a', evidence: 'deterministic' }] },
    issues: [{ version_id: 'ver_1', status: 'resolved', resolution: { action: 'reassign', target_sku_id: 'sku_b', at: '2026-01-02' } }],
  }), 'sku_b');
  assert.equal(effectiveSkuOf({
    version: VERSION, skuProfile: PROFILE, project: PROJECT,
    dependencyRecord: { entries: [{ kind: 'sku', ref: 'sku_b', evidence: 'manual' }] },
  }), 'sku_b');
  assert.equal(effectiveSkuOf({ version: VERSION, skuProfile: PROFILE, truth: TRUTH, project: PROJECT }), 'sku_a');
  assert.equal(effectiveSkuOf({
    version: VERSION, skuProfile: PROFILE, truth: { ...TRUTH, sku: 'UNKNOWN' }, project: { ...PROJECT, sku: 'UNKNOWN' },
  }), null, '全部依据无效时归属不明');

  const openBlocker = { status: 'open', severity: 'blocker', layer: 'ownership' };
  const openReview = { status: 'open', severity: 'review', layer: 'visual' };
  assert.throws(() => validateResolveInput({ action: 'noop', reason: 'x' }, openReview, PROFILE), /action 必须为/);
  assert.throws(() => validateResolveInput({ action: 'confirm', reason: '' }, openReview, PROFILE), /reason 必填/);
  assert.throws(() => validateResolveInput({ action: 'confirm', reason: 'x' }, { ...openReview, status: 'resolved' }, PROFILE),
    error => error.code === 'ISSUE_ALREADY_RESOLVED');
  assert.throws(() => validateResolveInput({ action: 'confirm', reason: '看着没问题' }, openBlocker, PROFILE),
    error => error.code === 'ISSUE_HARD_BLOCK', '满意不能覆盖阻断级问题');
  assert.throws(() => validateResolveInput({ action: 'reassign', reason: 'x', target_sku_id: 'sku_b' }, openReview, PROFILE),
    error => error.code === 'REASSIGN_NOT_APPLICABLE', '更正归属只适用于归属层');
  assert.throws(() => validateResolveInput({ action: 'reassign', reason: 'x', target_sku_id: 'ghost' }, openBlocker, PROFILE),
    /不在该项目当前 SKU 档案内/);
  assert.deepEqual(validateResolveInput({ action: 'confirm', reason: '人工核对画面一致' }, openReview, PROFILE),
    { action: 'confirm', reason: '人工核对画面一致' });
  assert.deepEqual(validateResolveInput({ action: 'reassign', reason: '商家确认该图属双支装', target_sku_id: 'sku_b' }, openBlocker, PROFILE),
    { action: 'reassign', reason: '商家确认该图属双支装', target_sku_id: 'sku_b' });
});

test('E04 纯函数 planSkuExport：归属过滤与各闸口逐项排除', () => {
  const versionOf = (id, deliverable) => ({
    id, deliverable_id: deliverable, active: true, number: 1, hash: `hash_${id}`, format: 'png', report_id: `rep_${id}`,
  });
  const runOf = (id, deliverables, extra = {}) => ({
    id, tenant_id: 't1', project_id: 'proj_1', status: 'completed',
    deliverables: deliverables.map(d => ({ deliverable_id: d, label: d })),
    versions: deliverables.map(d => versionOf(`${id}_${d}`, d)),
    ...extra,
  });
  const publishableReports = ids => Object.fromEntries(ids.map(id => [`rep_${id}`, { id: `rep_${id}`, decision: 'publishable' }]));
  const currentValidities = ids => Object.fromEntries(ids.map(id => [`rep_${id}`, { validity: 'current' }]));
  const depFor = (runId, deliverable, skuRef) => ({
    run_id: runId, deliverable_id: deliverable, version_id: `${runId}_${deliverable}`,
    entries: [{ kind: 'sku', ref: skuRef, evidence: 'deterministic' }],
  });

  // SKU 不存在
  assert.equal(planSkuExport({ project: PROJECT, skuId: 'ghost', skuProfile: PROFILE }).code, 'SKU_NOT_FOUND');

  // 归属其他 SKU 的版本：不混入 included，也不进 excluded
  const run = runOf('run_1', ['main', 'benefit']);
  const planB = planSkuExport({
    project: PROJECT, skuId: 'sku_b', skuProfile: PROFILE,
    runs: [run],
    dependencies: [depFor('run_1', 'main', 'sku_a'), depFor('run_1', 'benefit', 'sku_b')],
    reports: publishableReports(['run_1_main', 'run_1_benefit']),
    validities: currentValidities(['run_1_main', 'run_1_benefit']),
  });
  assert.equal(planB.ok, true);
  assert.deepEqual(planB.included.map(item => item.deliverable_id), ['benefit']);
  assert.equal(planB.excluded.length, 0, '归属其他 SKU 的图不混入也不罗列');
  assert.match(planB.included[0].path, /^images\/E04-02\/benefit\.png$/, '路径按 sku_code 组织');
  // sku_a 侧只见 main
  const planA = planSkuExport({
    project: PROJECT, skuId: 'sku_a', skuProfile: PROFILE,
    runs: [run],
    dependencies: [depFor('run_1', 'main', 'sku_a'), depFor('run_1', 'benefit', 'sku_b')],
    reports: publishableReports(['run_1_main', 'run_1_benefit']),
    validities: currentValidities(['run_1_main', 'run_1_benefit']),
  });
  assert.deepEqual(planA.included.map(item => item.deliverable_id), ['main']);

  // 闸口逐项：归属不明 / 报告缺失 / 失效 / 未通过 / 未解除阻断 / 权益未结算
  const gateRun = runOf('run_2', ['main'], { billing_mode: 'finished_image' });
  const gates = planSkuExport({
    project: PROJECT, skuId: 'sku_a', skuProfile: PROFILE,
    runs: [runOf('run_3', ['main']), gateRun],
    dependencies: [depFor('run_3', 'main', 'sku_a'), depFor('run_2', 'main', 'sku_a')],
    issues: [{
      version_id: 'run_3_main', layer: 'ownership', code: 'SKU_MISMATCH', severity: 'blocker', status: 'open',
    }],
    reports: { rep_run_3_main: { id: 'rep_run_3_main', decision: 'publishable' } }, // run_2_main 无报告
    validities: { rep_run_3_main: { validity: 'current' } },
  });
  assert.equal(gates.ok, false);
  assert.equal(gates.code, 'SKU_EXPORT_EMPTY');
  const reasons = Object.fromEntries(gates.excluded.map(item => [item.version_id, item.reason]));
  assert.equal(reasons.run_3_main, 'OPEN_BLOCKER');
  assert.equal(reasons.run_2_main, 'REPORT_MISSING', '报告缺失先于权益闸口');

  const stale = planSkuExport({
    project: PROJECT, skuId: 'sku_a', skuProfile: PROFILE,
    runs: [runOf('run_4', ['main'])], dependencies: [depFor('run_4', 'main', 'sku_a')],
    reports: { rep_run_4_main: { id: 'rep_run_4_main', decision: 'publishable' } },
    validities: { rep_run_4_main: { validity: 'stale', reasons: ['事实已更新'] } },
  });
  assert.equal(stale.excluded[0]?.reason, 'STALE');

  const review = planSkuExport({
    project: PROJECT, skuId: 'sku_a', skuProfile: PROFILE,
    runs: [runOf('run_5', ['main'])], dependencies: [depFor('run_5', 'main', 'sku_a')],
    reports: { rep_run_5_main: { id: 'rep_run_5_main', decision: 'needs_review' } },
    validities: { rep_run_5_main: { validity: 'current' } },
  });
  assert.equal(review.excluded[0]?.reason, 'NEEDS_REVIEW');

  const unsettled = planSkuExport({
    project: PROJECT, skuId: 'sku_a', skuProfile: PROFILE,
    runs: [runOf('run_6', ['main'], { billing_mode: 'finished_image' })],
    dependencies: [depFor('run_6', 'main', 'sku_a')],
    reports: publishableReports(['run_6_main']),
    validities: currentValidities(['run_6_main']),
  });
  assert.equal(unsettled.excluded[0]?.reason, 'ENTITLEMENT_NOT_SETTLED', '未付费版本不能正式导出');

  // 归属不明单列 OWNERSHIP_UNKNOWN；执行中的任务不参与
  // （project.sku 不命中档案、且无依赖与裁决依据时，归属才为不明）
  const unknownPlan = planSkuExport({
    project: { ...PROJECT, sku: 'E04-99' }, skuId: 'sku_a', skuProfile: PROFILE,
    runs: [runOf('run_7', ['main']), runOf('run_8', ['main'], { status: 'running' })],
    dependencies: [],
    reports: publishableReports(['run_7_main']),
    validities: currentValidities(['run_7_main']),
  });
  assert.equal(unknownPlan.excluded[0]?.reason, 'OWNERSHIP_UNKNOWN');
  assert.equal(unknownPlan.excluded.length, 1, '执行中的任务没有可导出版本');
});

// ---------- Provider / OCR fixture ----------

function createFixture() {
  let submitCount = 0;
  const calls = new Map();
  const provider = {
    capabilities: () => ({ id: 'e04-fixture', version: '1', image: true, video: false,
      max_references: 6, supports_mask: false, supports_post_composite: true, supports_async: true,
      supports_revision: false, supports_cancel: true, max_side: 4096, formats: ['png', 'jpg'],
      simulated: true, acceptance: 'simulated_only' }),
    validate: () => ({ ok: true }),
    estimate: () => ({ estimated_credits: 1, max_credits: 1 }),
    submit(request) {
      submitCount += 1;
      calls.set(request.idempotency_key, { request, seed: submitCount });
      return { provider_job_id: request.idempotency_key, status: 'queued' };
    },
    poll(handle) {
      const entry = calls.get(handle.provider_job_id);
      const seed = entry?.seed ?? 0;
      const width = entry?.request?.target_width ?? 1024;
      const height = entry?.request?.target_height ?? 1024;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 3;
          rgb[index] = (x * 3 + y * 2 + seed * 17) % 256;
          rgb[index + 1] = (y * 5 + x + seed * 29) % 256;
          rgb[index + 2] = (x * 7 + y * 3 + seed * 53) % 256;
        }
      }
      const bytes = encodeRgbPng(width, height, rgb);
      return { status: 'succeeded', result: {
        provider: 'e04-fixture', model: 'fixture/image', model_version: '1',
        provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ cancelled: true }),
  };
  return provider;
}

/** OCR fixture：按给定文字行返回识别结果（仅测试，不证明真实 OCR 效果）。 */
const makeOcr = lines => ({
  recognize: async () => ({ status: 'ok', engine: 'fixture-ocr', lines: lines.map(text => ({ text, confidence: 0.99 })) }),
});

// ---------- 会话脚手架（与 e03 同型） ----------

async function setup(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e04-'));
  const app = createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 0,
    tickMs: 5, attemptTimeoutMs: 30_000, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

async function registerClient(port, { email, tenantName }) {
  let cookie = '';
  let csrf = '';
  const req = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie, 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const json = contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null;
    if (json?.csrf_token) csrf = json.csrf_token;
    return { status: response.status, json, buffer, contentType };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'E04Account2026!', display_name: 'E04', tenant_name: tenantName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return { req };
}

async function sharpImage(width = 1200, height = 1200) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#dde5dd' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 600, channels: 3, background: '#335577' } }).png().toBuffer(), left: 400, top: 300 }])
    .png().toBuffer();
}

const BASE_FACTS = [
  { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '瓶装数量', value: '1', unit: '瓶', critical: false, confirmed: true, source_type: 'user_input' },
];

/** 两 SKU 档案：E04-01 标准装（50g×1瓶）/ E04-02 双支装（100g×2瓶）；项目事实归属 E04-01。 */
function skuPayload({ sellingPoint = '舒缓维稳' } = {}) {
  return {
    confirm: true,
    skus: [
      {
        sku_code: 'E04-01', label: '标准装', confirmed: true,
        attributes: [{ key: '容量', value: '50', unit: 'g' }, { key: '核心卖点', value: sellingPoint }],
        contents: [{ item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' }],
      },
      {
        sku_code: 'E04-02', label: '双支装', confirmed: true,
        attributes: [{ key: '容量', value: '100', unit: 'g' }],
        contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
      },
    ],
  };
}

/** 建项目 → 主体素材 → 两 SKU 档案 → 事实 → 品牌套件 → 冻结 spec → 报价 → 任务。 */
async function startRun(req, key) {
  const created = await req('/api/projects', {
    method: 'POST',
    body: { name: 'E04 面霜', sku: 'E04-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;

  const asset = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: await sharpImage(), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));

  const profile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT', body: { base_version: 0, ...skuPayload() },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.json));
  const skuIds = Object.fromEntries(profile.json.sku_profile.skus.map(item => [item.sku_code, item.id]));

  const truth = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: { base_version: 0, confirm: true, facts: BASE_FACTS, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));

  const kit = await req('/api/brand-kits', {
    method: 'POST',
    body: {
      name: 'E04 品牌套件', palette: { primary: '#2F6B4F', secondary: ['#F8FAFC'] },
      logo: { present: false },
      fonts: [{ name: '思源黑体', license: 'licensed', license_ref: 'LIC-2026-01' }],
      tone: '克制、可信', banned_expressions: [],
    },
  });
  assert.equal(kit.status, 201, JSON.stringify(kit.json));

  const preview = await req(`/api/projects/${projectId}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await req(`/api/projects/${projectId}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id, conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));

  const quote = await req('/api/quotes', { method: 'POST', body: { project_id: projectId } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const run = await req('/api/runs', {
    method: 'POST',
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
    headers: { 'Idempotency-Key': key },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  return { projectId, run: run.json.run, skuIds };
}

async function waitTerminal(req, runId, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const run = (await req(`/api/runs/${runId}`)).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() - started > timeoutMs) throw new Error(`任务未进入终态，最后状态 ${run?.status}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function reviewToPublishable(req, reportId) {
  const report = (await req(`/api/quality-reports/${reportId}`)).json.report;
  if (!report || report.decision === 'publishable') return report;
  const decisions = (report.checks ?? [])
    .filter(item => item.required && item.status === 'unknown' && item.adjudicable)
    .map(item => ({ code: item.code, decision: 'pass', reason: 'E04 测试样本人工检查通过', evidence: report.id }));
  if (decisions.length === 0) return report;
  const reviewed = await req(`/api/quality-reports/${reportId}/reviews`, {
    method: 'POST', body: { decisions, note: '仅测试 fixture，不证明真实模型效果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  return reviewed.json.report;
}

async function publishAllVersions(req, runId) {
  const versions = (await req(`/api/runs/${runId}/versions`)).json.versions;
  for (const item of versions.filter(v => v.current)) await reviewToPublishable(req, item.report_id);
}

async function runChecks(req, projectId) {
  const result = await req(`/api/projects/${projectId}/sku-checks`, { method: 'POST', body: {} });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json;
}

// ---------- 集成 ----------

test('E04 集成：干净核对幂等 + 未配置 OCR 保持未知 + 按 SKU 导出与鉴权', async (t) => {
  const { port } = await setup(t, { provider: createFixture() }); // 不注入 OCR：视觉层保持未知
  const owner = await registerClient(port, { email: 'e04-a@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'e04-b@example.test', tenantName: '乙店' });
  const { req } = owner;
  const { projectId, run, skuIds } = await startRun(req, 'e04-main');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 400));
  await publishAllVersions(req, run.id);
  const deliverableCount = finished.deliverables.length;
  assert.ok(deliverableCount >= 3, `默认报价应含至少 3 个交付物，实际 ${deliverableCount}`);

  // 1. 首次核对：归属/结构干净；未配置 OCR → 每个选用版本一项 VISUAL_UNAVAILABLE（review，不阻断）
  const first = await runChecks(req, projectId);
  assert.equal(first.checked, deliverableCount);
  assert.equal(first.ocr_configured, false);
  assert.equal(first.created, deliverableCount);
  assert.ok(first.issues.every(item => item.code === 'VISUAL_UNAVAILABLE' && item.severity === 'review'));
  assert.equal(first.summary.visual.open, deliverableCount);
  assert.equal(first.summary.ownership.blocker, 0);
  // 2. 幂等：同版本同指纹不重复开立
  const second = await runChecks(req, projectId);
  assert.equal(second.created, 0);
  assert.equal(second.issues.length, deliverableCount);

  // 3. 人工确认一项视觉未知（依据必填；绑定版本）
  const target = first.issues[0];
  assert.equal((await req(`/api/check-issues/${target.id}/resolve`, {
    method: 'POST', body: { action: 'confirm', reason: '' },
  })).status, 422, '依据为空必须 422');
  const resolved = await req(`/api/check-issues/${target.id}/resolve`, {
    method: 'POST', body: { action: 'confirm', reason: '已人工核对画面与事实一致' },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.issue.status, 'resolved');
  assert.equal(resolved.json.issue.resolution.action, 'confirm');
  assert.equal(resolved.json.issue.resolution.version_id, target.version_id, '复核必须绑定版本');
  // 已收口不重开、不重复处理
  assert.equal((await req(`/api/check-issues/${target.id}/resolve`, {
    method: 'POST', body: { action: 'confirm', reason: '重复处理' },
  })).status, 409);
  const third = await runChecks(req, projectId);
  const reopened = third.issues.find(item => item.id === target.id);
  assert.equal(reopened.status, 'resolved', '已复核问题不随重核复开');

  // 4. 按 SKU 导出：E04-01 含全部 3 项，路径按 sku_code 组织
  const exported = await req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: skuIds['E04-01'] },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const exportRecord = exported.json.export;
  assert.equal(exportRecord.kind, 'sku_export');
  assert.equal(exportRecord.sku_code, 'E04-01');
  assert.equal(exportRecord.status, 'SKU_EXPORT_COMPLETE');
  assert.equal(exportRecord.included.length, deliverableCount);
  for (const item of exportRecord.included) {
    assert.match(item.path, new RegExp(`^images/E04-01/${item.deliverable_id}\\.(png|jpg)$`));
  }
  // 包内容：zip 内含 sku_code 目录与清单
  const download = await req(`/api/exports/${exportRecord.id}/download`);
  assert.equal(download.status, 200);
  const zipText = download.buffer.toString('latin1');
  assert.ok(zipText.includes('images/E04-01/'), 'zip 内应有 sku_code 目录');
  assert.ok(zipText.includes('sku-manifest.json'), 'zip 内应有 SKU 清单');
  // 清单如实列出排除项（本例无排除）
  assert.deepEqual(exportRecord.manifest.excluded, []);
  // 5. 另一 SKU 无可导出项 → 409 SKU_EXPORT_EMPTY
  const empty = await req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: skuIds['E04-02'] },
  });
  assert.equal(empty.status, 409);
  assert.equal(empty.json.error, 'SKU_EXPORT_EMPTY');
  // 6. 参数闸口：sku_id 缺失 422；不在档案内 404
  assert.equal((await req(`/api/projects/${projectId}/sku-exports`, { method: 'POST', body: {} })).status, 422);
  const ghost = await req(`/api/projects/${projectId}/sku-exports`, { method: 'POST', body: { sku_id: 'sku_ghost' } });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.error, 'SKU_NOT_FOUND');
  // 7. 列表只含 sku_export 类型
  const list = await req(`/api/projects/${projectId}/sku-exports`);
  assert.equal(list.status, 200);
  assert.ok(list.json.exports.length === 1 && list.json.exports[0].kind === 'sku_export');

  // 8. 跨租户一律 404（不泄漏对象是否存在）
  assert.equal((await outsider.req(`/api/projects/${projectId}/sku-checks`)).status, 404);
  assert.equal((await outsider.req(`/api/projects/${projectId}/sku-checks`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await outsider.req(`/api/check-issues/${target.id}/resolve`, {
    method: 'POST', body: { action: 'confirm', reason: '越权' },
  })).status, 404);
  assert.equal((await outsider.req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: skuIds['E04-01'] },
  })).status, 404);
  assert.equal((await outsider.req(`/api/exports/${exportRecord.id}/download`)).status, 404, '导出包下载必须鉴权');
  const versionContent = await req(`/api/runs/${run.id}/versions/${target.version_id}/content`);
  assert.equal(versionContent.status, 200);
  assert.equal((await outsider.req(`/api/runs/${run.id}/versions/${target.version_id}/content`)).status, 404,
    '版本图片内容必须鉴权');
});

test('E04 集成：人工错配关联 → 阻断 → 满意不可覆盖 → 更正归属留痕 → 新版本重核', async (t) => {
  const { port } = await setup(t, { provider: createFixture(), ocr: makeOcr(['月光舒缓']) });
  const { req } = await registerClient(port, { email: 'e04-c@example.test', tenantName: '丙店' });
  const { projectId, run, skuIds } = await startRun(req, 'e04-mismatch');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed');
  await publishAllVersions(req, run.id);
  const scene = finished.deliverables.find(item => item.deliverable_id === 'scene');
  const sceneVersion = finished.versions.find(item => item.deliverable_id === 'scene' && item.active);
  assert.ok(scene && sceneVersion, '场景图交付物与选用版本应存在');

  // 1. 人工把另一 SKU 关联进依赖（模拟真实串图来源：商家/运营误操作留痕为 manual 条目）
  const attached = await req(`/api/runs/${run.id}/deliverables/scene/dependencies`, {
    method: 'POST',
    body: { version_id: sceneVersion.id, reason: '运营误将该图关联到双支装', entries: [{ kind: 'sku', ref: skuIds['E04-02'] }] },
  });
  assert.equal(attached.status, 201, JSON.stringify(attached.json));

  // 2. 核对开出 SKU_MISMATCH blocker（认领集混入预期外已知 SKU）
  const checked = await runChecks(req, projectId);
  const mismatch = checked.issues.find(item => item.code === 'SKU_MISMATCH' && item.version_id === sceneVersion.id);
  assert.ok(mismatch, '应开出 SKU_MISMATCH');
  assert.equal(mismatch.layer, 'ownership');
  assert.equal(mismatch.severity, 'blocker');
  assert.equal(checked.summary.ownership.blocker, 1);
  // 3. 满意不能覆盖硬错误
  const hardBlock = await req(`/api/check-issues/${mismatch.id}/resolve`, {
    method: 'POST', body: { action: 'confirm', reason: '看着图没问题' },
  });
  assert.equal(hardBlock.status, 409);
  assert.equal(hardBlock.json.error, 'ISSUE_HARD_BLOCK');
  // 4. 更正归属到错误目标（E04-02）：收口 + 依赖并入 manual 条目留痕
  const reassigned = await req(`/api/check-issues/${mismatch.id}/resolve`, {
    method: 'POST', body: { action: 'reassign', reason: '商家确认该场景图实际属于双支装', target_sku_id: skuIds['E04-02'] },
  });
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.json));
  assert.equal(reassigned.json.issue.resolution.action, 'reassign');
  const deps = await req(`/api/runs/${run.id}/deliverables/scene/dependencies`);
  assert.equal(deps.status, 200);
  const record = deps.json.versions.find(item => item.version_id === sceneVersion.id);
  const manualSkuEntries = record.entries.filter(item => item.kind === 'sku' && item.evidence === 'manual');
  assert.ok(manualSkuEntries.some(item => item.ref === skuIds['E04-02'] && item.reason), '更正归属必须在依赖记录留 manual 痕迹');
  // 5. 重核不重报（裁决目标仍在认领集内）
  const rechecked = await runChecks(req, projectId);
  assert.equal(rechecked.issues.filter(item => item.code === 'SKU_MISMATCH' && item.status === 'open').length, 0);
  assert.equal(rechecked.created, 0, '无新问题（其余版本本就干净）');

  // 6. 生效归属已指向 E04-02：E04-02 导出含 scene；E04-01 导出不混入
  const exportB = await req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: skuIds['E04-02'] },
  });
  assert.equal(exportB.status, 201, JSON.stringify(exportB.json));
  assert.deepEqual(exportB.json.export.included.map(item => item.deliverable_id), ['scene']);
  assert.match(exportB.json.export.included[0].path, /^images\/E04-02\/scene\.(png|jpg)$/, 'scene 版本格式以交付物规格为准（jpg）');
  const exportA = await req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: skuIds['E04-01'] },
  });
  assert.equal(exportA.status, 201, JSON.stringify(exportA.json));
  assert.ok(!exportA.json.export.included.some(item => item.deliverable_id === 'scene'), '归属其他 SKU 的图绝不混入');
  assert.ok(!exportA.json.export.manifest.excluded.some(item => item.deliverable_id === 'scene'), '归属其他 SKU 的图也不罗列');
  const zipA = (await req(`/api/exports/${exportA.json.export.id}/download`)).buffer.toString('latin1');
  assert.ok(!/scene\.(png|jpg)/.test(zipA), 'E04-01 包内不应出现 scene 图');

  // 7. 复核绑定版本：文字修改产生新版本后，旧裁决不覆盖新版本
  const layers = await req(`/api/runs/${run.id}/deliverables/benefit/text-layers`);
  assert.equal(layers.status, 200);
  const editable = layers.json.layers.find(item => item.editable_text === true);
  assert.ok(editable, '卖点图应有可编辑文字层');
  const benefitVersion = finished.versions.find(item => item.deliverable_id === 'benefit' && item.active);
  // 先给 benefit 也挂上错配关联并核对开单、裁决
  await req(`/api/runs/${run.id}/deliverables/benefit/dependencies`, {
    method: 'POST',
    body: { version_id: benefitVersion.id, reason: '运营误关联', entries: [{ kind: 'sku', ref: skuIds['E04-02'] }] },
  });
  const before = await runChecks(req, projectId);
  const benefitMismatch = before.issues.find(item => item.code === 'SKU_MISMATCH' && item.version_id === benefitVersion.id);
  assert.ok(benefitMismatch, 'benefit 旧版本应开出 SKU_MISMATCH');
  const fixed = await req(`/api/check-issues/${benefitMismatch.id}/resolve`, {
    method: 'POST', body: { action: 'reassign', reason: '确认该图属双支装', target_sku_id: skuIds['E04-02'] },
  });
  assert.equal(fixed.status, 200);
  const edited = await req(`/api/runs/${run.id}/deliverables/benefit/text-edits`, {
    method: 'POST',
    body: { base_version_id: benefitVersion.id, edits: [{ id: editable.id, text: '舒缓维稳 持久水润' }] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const newVersionId = edited.json.version.id;
  await reviewToPublishable(req, edited.json.version.report_id);
  const activated = await req(`/api/runs/${run.id}/versions/${newVersionId}/activate`, { method: 'POST' });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));
  const after = await runChecks(req, projectId);
  const newMismatch = after.issues.find(item => item.code === 'SKU_MISMATCH' && item.version_id === newVersionId);
  assert.ok(newMismatch && newMismatch.status === 'open', '新版本必须重新开单：一次人工确认不能永久放行后续版本');
  const oldIssue = after.issues.find(item => item.id === benefitMismatch.id);
  assert.equal(oldIssue.status, 'resolved', '旧版本的裁决保持收口');

  // 8. 新版本有未解除阻断：E04-02 导出 benefit 被 OPEN_BLOCKER 闸口排除
  const exportBlocked = await req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: skuIds['E04-02'] },
  });
  assert.equal(exportBlocked.status, 201, JSON.stringify(exportBlocked.json));
  const blockedRow = exportBlocked.json.export.manifest.excluded.find(item => item.deliverable_id === 'benefit');
  assert.equal(blockedRow?.reason, 'OPEN_BLOCKER');
  assert.ok(exportBlocked.json.export.included.some(item => item.deliverable_id === 'scene'));
});

test('E04 集成：SPEC_CONFLICT 修档后自动收口；FACT_REMOVED 与报告失效闸口', async (t) => {
  const { port } = await setup(t, { provider: createFixture(), ocr: makeOcr(['月光舒缓']) });
  const { req } = await registerClient(port, { email: 'e04-d@example.test', tenantName: '丁店' });
  const { projectId, run, skuIds } = await startRun(req, 'e04-structure');
  const finished = await waitTerminal(req, run.id);
  assert.equal(finished.status, 'completed');
  await publishAllVersions(req, run.id);

  // 1. 档案改出矛盾（核心卖点 舒缓维稳 → 修护焕亮，与事实不一致）→ SPEC_CONFLICT blocker
  const conflictProfile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT', body: { base_version: 1, ...skuPayload({ sellingPoint: '修护焕亮' }) },
  });
  assert.equal(conflictProfile.status, 201, JSON.stringify(conflictProfile.json));
  const checked = await runChecks(req, projectId);
  const specConflict = checked.issues.find(item => item.code === 'SPEC_CONFLICT');
  assert.ok(specConflict, '档案属性与图上事实矛盾应开出 SPEC_CONFLICT');
  assert.equal(specConflict.severity, 'blocker');
  // 阻断不能用「满意」放行
  assert.equal((await req(`/api/check-issues/${specConflict.id}/resolve`, {
    method: 'POST', body: { action: 'confirm', reason: '先这样' },
  })).status, 409);

  // 2. 修档恢复一致 → 复核自动收口（structure blocker 走 recheck_clear，不需要人工逐条确认）
  const fixedProfile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT', body: { base_version: 2, ...skuPayload() },
  });
  assert.equal(fixedProfile.status, 201, JSON.stringify(fixedProfile.json));
  // PUT 更新档案会重新生成 sku id，后续导出必须用最新档案里的 id
  const latestSkuIds = Object.fromEntries(fixedProfile.json.sku_profile.skus.map(item => [item.sku_code, item.id]));
  const rechecked = await runChecks(req, projectId);
  const cleared = rechecked.issues.find(item => item.id === specConflict.id);
  assert.equal(cleared.status, 'resolved');
  assert.equal(cleared.resolution.action, AUTO_CLEAR_ACTION, '条件已不存在应自动收口');
  assert.equal(rechecked.auto_cleared >= 1, true);

  // 3. 事实删除被引用的字段 → FACT_REMOVED blocker；报告随之失效 → 导出 STALE
  const truthRemoved = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: {
      base_version: 1, confirm: true,
      facts: BASE_FACTS.filter(item => item.key !== '核心卖点'),
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(truthRemoved.status, 201, JSON.stringify(truthRemoved.json));
  const afterRemoval = await runChecks(req, projectId);
  const factRemoved = afterRemoval.issues.find(item => item.code === 'FACT_REMOVED');
  assert.ok(factRemoved, '图上文字引用的事实已删除应开出 FACT_REMOVED');
  assert.equal(factRemoved.severity, 'blocker');
  const staleExport = await req(`/api/projects/${projectId}/sku-exports`, {
    method: 'POST', body: { sku_id: latestSkuIds['E04-01'] },
  });
  assert.equal(staleExport.status, 409, JSON.stringify(staleExport.json));
  assert.equal(staleExport.json.error, 'SKU_EXPORT_EMPTY');
  assert.ok(staleExport.json.details?.excluded?.some(item => item.reason === 'STALE'), '事实已更新：报告失效应走 STALE 闸口');
});

test('E04 集成：无 SKU 档案项目导出 409；归属不明版本单列不导出', async (t) => {
  const { port } = await setup(t, { provider: createFixture(), ocr: makeOcr(['月光舒缓']) });
  const { req } = await registerClient(port, { email: 'e04-e@example.test', tenantName: '戊店' });
  // 无档案项目
  const created = await req('/api/projects', {
    method: 'POST', body: { name: 'E04 无档案', sku: 'E04-99', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201);
  const bare = created.json.project.id;
  const noProfile = await req(`/api/projects/${bare}/sku-exports`, {
    method: 'POST', body: { sku_id: 'any' },
  });
  assert.equal(noProfile.status, 409);
  assert.equal(noProfile.json.error, 'NO_SKU_PROFILE');

  // 有档案但归属不明：把版本依赖里的 sku 条目抽掉不可行（deterministic 不可删），
  // 改用纯函数已覆盖 OWNERSHIP_UNKNOWN；这里验证「无依赖记录」的 unknown 分支不落导出
  // —— 集成侧用另一个未生成过的 SKU 触发 SKU_EXPORT_EMPTY 即可（已在主集成覆盖）。
});
