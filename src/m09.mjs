/**
 * M09 模型精修与质量基准。
 *
 * 目标不是"把某个新模型设成默认"，而是让模型晋级有可核对的证据：
 * 1. 评测集必须是授权素材：没有授权、数量不足或留出集不足时，评测结论只能是
 *    insufficient_dataset，不能写成"已完成评测"。
 * 2. 指标固定为真实性、未知率、人工接受率与合格成本；未知不当作正确。
 * 3. 候选必须在不劣于冠军的前提下，至少有一项严格更优，才允许晋级。
 * 4. 灰度最多 5%，且只有在候选确实胜出、并且宿主注册了该候选 Adapter 时才启用；
 *    当前环境没有第二模型 Adapter，因此灰度与晋级都只能返回阻断原因。
 */

export const M09_VERSION = 'm09.1';
export const EVAL_SCHEMA_VERSION = 1;

/** 授权评测集与留出集的最低要求，来自剩余开发接手包 M09。 */
export const MIN_EVAL_SKUS = 100;
export const MIN_HOLDOUT_SKUS = 20;

/** 灰度上限硬编码为 5%，调用方只能往下调，不能往上放。 */
export const MAX_CANARY_PERCENT = 5;
export const MIN_CANARY_PERCENT = 1;

export const DATASET_SPLITS = Object.freeze(['eval', 'holdout']);
export const EVALUATION_STATUSES = Object.freeze([
  'not_run', 'insufficient_dataset', 'insufficient_samples', 'invalid_report', 'completed',
]);

export const DEFAULT_CANARY_THRESHOLDS = Object.freeze({
  max_unknown_rate: 0.2,
  max_blocked_rate: 0.1,
  min_truthfulness: 0.95,
  min_canary_samples: 30,
});

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
const round = (value, digits = 4) =>
  (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

const normalizeSplit = value => (String(value ?? '').trim() === 'holdout' ? 'holdout' : 'eval');

/**
 * 数据集摘要：只统计**授权**样本；未授权样本保留计数但不进入评测集。
 * 不足 100 个授权 SKU、留出集不足 20 个或出现重复 SKU 时不得放行评测。
 */
export function summarizeDataset(items = []) {
  const seen = new Map();
  const duplicates = [];
  for (const item of items) {
    const sku = String(item?.sku_id ?? '').trim();
    if (!sku) continue;
    if (seen.has(sku)) {
      duplicates.push(sku);
      continue;
    }
    seen.set(sku, item);
  }
  const all = [...seen.values()];
  const licensed = all.filter(item => item?.licensed === true && String(item?.license_ref ?? '').trim() !== '');
  const unlicensed = all.length - licensed.length;
  const evalItems = licensed.filter(item => normalizeSplit(item.split) === 'eval');
  const holdoutItems = licensed.filter(item => normalizeSplit(item.split) === 'holdout');

  const blockers = [];
  if (duplicates.length > 0) blockers.push({ code: 'DUPLICATE_SKU', detail: [...new Set(duplicates)] });
  if (licensed.length < MIN_EVAL_SKUS) {
    blockers.push({
      code: 'DATASET_TOO_SMALL',
      detail: { licensed: licensed.length, required: MIN_EVAL_SKUS },
    });
  }
  if (holdoutItems.length < MIN_HOLDOUT_SKUS) {
    blockers.push({
      code: 'HOLDOUT_TOO_SMALL',
      detail: { holdout: holdoutItems.length, required: MIN_HOLDOUT_SKUS },
    });
  }

  return {
    schema_version: EVAL_SCHEMA_VERSION,
    total: all.length,
    licensed: licensed.length,
    unlicensed,
    duplicates: duplicates.length,
    eval_count: evalItems.length,
    holdout_count: holdoutItems.length,
    holdout_ratio: round(ratio(holdoutItems.length, licensed.length)),
    ready: blockers.length === 0,
    blockers,
  };
}

function modelMetrics(samples) {
  const truthOk = samples.filter(item => item.truth === 'ok').length;
  const truthMismatch = samples.filter(item => item.truth === 'mismatch').length;
  const truthUnknown = samples.filter(item => item.truth === 'unknown').length;
  const accepted = samples.filter(item => item.human === 'accepted').length;
  const rejected = samples.filter(item => item.human === 'rejected').length;
  const qualified = samples.filter(item => item.qualified === true);
  const totalCost = samples.reduce((sum, item) => sum + (Number(item.cost_credits) || 0), 0);
  const skus = new Set(samples.map(item => item.sku_id));
  const holdoutSkus = new Set(samples.filter(item => item.split === 'holdout').map(item => item.sku_id));
  return {
    samples: samples.length,
    skus: skus.size,
    holdout_skus: holdoutSkus.size,
    truth_ok: truthOk,
    truth_mismatch: truthMismatch,
    truth_unknown: truthUnknown,
    truthfulness: round(ratio(truthOk, truthOk + truthMismatch)),
    unknown_rate: round(ratio(truthUnknown, samples.length)),
    human_acceptance_rate: round(ratio(accepted, accepted + rejected)),
    qualified_rate: round(ratio(qualified.length, samples.length)),
    qualified_count: qualified.length,
    total_cost: round(totalCost, 2),
    // 合格成本 = 该模型全部花费 / 合格产物数；没有合格产物时不能编造为 0
    cost_per_qualified: qualified.length > 0 ? round(totalCost / qualified.length, 2) : null,
  };
}

/**
 * 冠军—挑战者对比：候选在所有可比指标上不劣于冠军，且至少一项严格更优。
 * 任何一项指标缺失或样本不足都不能算胜出。
 */
export function compareModels({ champion = null, candidate = null } = {}) {
  const reasons = [];
  const improvements = [];
  if (!champion) reasons.push('CHAMPION_NO_BASELINE');
  if (!candidate) reasons.push('CANDIDATE_NOT_EVALUATED');
  if (reasons.length > 0) {
    return { promote: false, reasons, improvements, deltas: null };
  }
  if (candidate.skus < MIN_EVAL_SKUS || candidate.holdout_skus < MIN_HOLDOUT_SKUS) {
    reasons.push('CANDIDATE_INSUFFICIENT_SAMPLES');
  }
  if (champion.skus < MIN_EVAL_SKUS || champion.holdout_skus < MIN_HOLDOUT_SKUS) {
    reasons.push('CHAMPION_INSUFFICIENT_SAMPLES');
  }
  for (const key of ['truthfulness', 'unknown_rate', 'human_acceptance_rate', 'cost_per_qualified']) {
    if (champion[key] === null || candidate[key] === null) reasons.push(`${key.toUpperCase()}_UNAVAILABLE`);
  }

  const delta = (left, right, digits = 4) =>
    (left === null || right === null ? null : round(left - right, digits));
  const deltas = {
    truthfulness: delta(candidate.truthfulness, champion.truthfulness),
    unknown_rate: delta(candidate.unknown_rate, champion.unknown_rate),
    human_acceptance_rate: delta(candidate.human_acceptance_rate, champion.human_acceptance_rate),
    cost_per_qualified: delta(candidate.cost_per_qualified, champion.cost_per_qualified, 2),
  };

  if (candidate.truthfulness !== null && champion.truthfulness !== null) {
    if (candidate.truthfulness < champion.truthfulness) reasons.push('TRUTHFULNESS_REGRESSION');
    else if (candidate.truthfulness > champion.truthfulness) improvements.push('truthfulness');
  }
  if (candidate.unknown_rate !== null && champion.unknown_rate !== null) {
    if (candidate.unknown_rate > champion.unknown_rate) reasons.push('UNKNOWN_RATE_REGRESSION');
    else if (candidate.unknown_rate < champion.unknown_rate) improvements.push('unknown_rate');
  }
  if (candidate.human_acceptance_rate !== null && champion.human_acceptance_rate !== null) {
    if (candidate.human_acceptance_rate < champion.human_acceptance_rate) {
      reasons.push('HUMAN_ACCEPTANCE_REGRESSION');
    } else if (candidate.human_acceptance_rate > champion.human_acceptance_rate) {
      improvements.push('human_acceptance_rate');
    }
  }
  if (candidate.cost_per_qualified !== null && champion.cost_per_qualified !== null) {
    if (candidate.cost_per_qualified > champion.cost_per_qualified) reasons.push('QUALIFIED_COST_REGRESSION');
    else if (candidate.cost_per_qualified < champion.cost_per_qualified) improvements.push('cost_per_qualified');
  }
  const promote = reasons.length === 0 && improvements.length > 0;
  if (reasons.length === 0 && improvements.length === 0) reasons.push('NO_STRICT_IMPROVEMENT');
  return { promote, reasons, improvements, deltas };
}

/**
 * 计算评测结论。授权样本不足时状态固定为 insufficient_dataset，
 * 即使调用方塞了样本也不能把评测说成完成。
 */
export function summarizeEvaluation({
  datasetItems = [], samples = [], championModelId, candidateModelId,
} = {}) {
  const dataset = summarizeDataset(datasetItems);
  const licensedSkus = new Set(datasetItems
    .filter(item => item?.licensed === true && String(item?.license_ref ?? '').trim() !== '')
    .map(item => String(item.sku_id)));
  const normalized = samples.map(item => ({
    sample_id: item?.sample_id ?? null,
    sku_id: String(item?.sku_id ?? ''),
    model_id: String(item?.model_id ?? ''),
    split: normalizeSplit(item?.split),
    truth: ['ok', 'mismatch'].includes(item?.truth) ? item.truth : 'unknown',
    human: ['accepted', 'rejected'].includes(item?.human) ? item.human : 'unknown',
    qualified: item?.qualified === true,
    cost_credits: Math.max(0, Number(item?.cost_credits) || 0),
    qa_status: item?.qa_status ?? null,
  }));
  const excluded = normalized.filter(item => !licensedSkus.has(item.sku_id));
  const included = normalized.filter(item => licensedSkus.has(item.sku_id));
  // 数据集里的留出标记优先于样本自报，避免样本把留出集"改成"评测集
  const splitOf = new Map(datasetItems.map(item => [String(item.sku_id), normalizeSplit(item.split)]));
  for (const item of included) item.split = splitOf.get(item.sku_id) ?? item.split;

  const championSamples = included.filter(item => item.model_id === championModelId);
  const candidateSamples = included.filter(item => item.model_id === candidateModelId);
  const champion = championModelId && championSamples.length > 0 ? modelMetrics(championSamples) : null;
  const candidate = candidateModelId && candidateSamples.length > 0 ? modelMetrics(candidateSamples) : null;

  let status = 'completed';
  if (!dataset.ready) status = 'insufficient_dataset';
  else if (included.length === 0) status = 'not_run';
  else if (!candidate) status = 'invalid_report';
  else if (candidate.skus < MIN_EVAL_SKUS || candidate.holdout_skus < MIN_HOLDOUT_SKUS) {
    status = 'insufficient_samples';
  }

  const decision = status === 'completed'
    ? compareModels({ champion, candidate })
    : {
      promote: false,
      reasons: [`EVALUATION_${status.toUpperCase()}`],
      improvements: [],
      deltas: null,
    };

  return {
    schema_version: EVAL_SCHEMA_VERSION,
    evaluator_version: M09_VERSION,
    status,
    dataset,
    champion_model_id: championModelId ?? null,
    candidate_model_id: candidateModelId ?? null,
    excluded_unlicensed: excluded.length,
    sample_count: included.length,
    metrics: { champion, candidate },
    decision,
    note: '未知样本不计为正确；合格成本 = 全部花费 / 合格产物数；授权素材不足时不得声称评测完成。',
  };
}

/**
 * 灰度计划：最多 5%。只有在候选胜出、且宿主确实注册了候选 Adapter 时才可能启用；
 * 当前环境没有第二模型 Adapter，因此会给出明确的阻断原因而不是假装在灰度。
 */
export function planCanary({
  decision = null, adapterAvailable = false, requestedPercent = MAX_CANARY_PERCENT,
  thresholds = DEFAULT_CANARY_THRESHOLDS,
} = {}) {
  const requested = Number(requestedPercent);
  const percent = Number.isFinite(requested)
    ? Math.max(MIN_CANARY_PERCENT, Math.min(MAX_CANARY_PERCENT, Math.round(requested)))
    : MAX_CANARY_PERCENT;
  let blockedReason = null;
  if (decision?.promote !== true) blockedReason = 'CANDIDATE_NOT_WINNING';
  else if (adapterAvailable !== true) blockedReason = 'CANDIDATE_ADAPTER_UNAVAILABLE';
  const active = blockedReason === null;
  return {
    active,
    percent: active ? percent : 0,
    requested_percent: percent,
    max_percent: MAX_CANARY_PERCENT,
    blocked_reason: blockedReason,
    rollback_thresholds: { ...thresholds },
    sampled_runs: 0,
    note: active
      ? '候选已胜出且 Adapter 可用；按设定比例灰度，触达回滚阈值立即停止。'
      : '候选未胜出或缺少可用 Adapter，灰度不启用；不得把未灰度的候选当作默认模型。',
  };
}

/** 灰度健康检查：任一阈值触达即要求回滚。 */
export function evaluateCanaryHealth({ samples = [], thresholds = DEFAULT_CANARY_THRESHOLDS } = {}) {
  const total = samples.length;
  const unknown = samples.filter(item => item?.unknown === true).length;
  const blocked = samples.filter(item => item?.qa_status === 'blocked').length;
  const truthKnown = samples.filter(item => item?.truth !== 'unknown');
  const truthOk = truthKnown.filter(item => item?.truth === 'ok').length;
  const truthfulness = ratio(truthOk, truthKnown.length);
  const unknownRate = ratio(unknown, total);
  const blockedRate = ratio(blocked, total);
  const breaches = [];
  if (total < thresholds.min_canary_samples) breaches.push('INSUFFICIENT_CANARY_SAMPLES');
  if (unknownRate !== null && unknownRate > thresholds.max_unknown_rate) breaches.push('UNKNOWN_RATE_ABOVE_THRESHOLD');
  if (blockedRate !== null && blockedRate > thresholds.max_blocked_rate) breaches.push('BLOCKED_RATE_ABOVE_THRESHOLD');
  if (truthfulness !== null && truthfulness < thresholds.min_truthfulness) {
    breaches.push('TRUTHFULNESS_BELOW_THRESHOLD');
  }
  return {
    healthy: breaches.length === 0,
    samples: total,
    unknown_rate: round(unknownRate),
    blocked_rate: round(blockedRate),
    truthfulness: round(truthfulness),
    breaches,
  };
}
