/**
 * M12 结果回流、商业化收口、可观测性与备份恢复。
 *
 * 边界（接手包 M12 与 PRD 验收口径）：
 * 1. 采用/驳回必须落在具体结果版本上；"采用"只接受当前可发布且报告未失效的版本，
 *    不能把 blocked、needs_review 或 stale 的结果标成已采用。
 * 2. 授权效果数据必须显式声明授权与来源；未授权、无来源的导入一律拒绝，
 *    缺失或非法指标逐行报错，不用一行错误吞掉整批。
 * 3. 实验口径只给可比指标与差值，不做显著性检验；样本不足时标记 insufficient_sample，
 *    不把观测差异说成因果。
 * 4. 套餐可以展示，真实支付与退款必须有真实支付 Provider 能力；没有能力时
 *    明确阻断，绝不用演示订单冒充真实收款。
 * 5. 备份按租户隔离，恢复前必须校验清单哈希与引用文件；校验失败不得覆盖现有数据。
 *
 * 本文件只做纯计算与规则判定，I/O 与编排在 API 层。
 */
import { createHash } from 'node:crypto';

export const M12_VERSION = 'm12.1';
export const BACKUP_FORMAT_VERSION = 1;

export const FEEDBACK_DECISIONS = Object.freeze(['adopted', 'rejected']);
export const FEEDBACK_REASON_CODES = Object.freeze([
  'QUALITY_DEFECT', 'SUBJECT_DISTORTION', 'TEXT_ERROR', 'STYLE_MISMATCH',
  'PLATFORM_RULE', 'CLIENT_REQUEST', 'COST_TOO_HIGH', 'OTHER',
]);

export const OUTCOME_MAX_ROWS = 500;
export const EXPERIMENT_ARMS = Object.freeze(['control', 'variant']);
export const MIN_EXPERIMENT_IMPRESSIONS = 100;
export const MIN_EXPERIMENT_FEEDBACK = 10;

export const PLANS = Object.freeze([
  Object.freeze({
    id: 'plan_trial', name: '体验版', seats: 1, credits: 200,
    price_cents: null, currency: 'CNY', billable: false,
    note: '内部演示额度，未接入真实支付',
  }),
  Object.freeze({
    id: 'plan_starter', name: '基础版', seats: 3, credits: 2_000,
    price_cents: null, currency: 'CNY', billable: false,
    note: '内部演示额度，未接入真实支付',
  }),
  Object.freeze({
    id: 'plan_team', name: '团队版', seats: 10, credits: 10_000,
    price_cents: null, currency: 'CNY', billable: false,
    note: '内部演示额度，未接入真实支付',
  }),
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalizeText = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const issue = (code, message, evidence = null) => ({ code, message, evidence });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonNegativeInteger = value => Number.isInteger(value) && value >= 0;
const nonNegativeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ratio = (top, bottom) => (bottom > 0 ? top / bottom : null);

// ---------- 结果回流：采用 / 驳回 ----------

/** 校验采用/驳回输入；理由只接受登记过的代码，备注不承载业务规则。 */
export function validateFeedbackInput(body = {}) {
  const issues = [];
  const decision = normalizeText(body.decision);
  if (!FEEDBACK_DECISIONS.includes(decision)) {
    issues.push(issue('FEEDBACK_DECISION_INVALID', `decision 必须是 ${FEEDBACK_DECISIONS.join(' / ')} 之一`));
  }
  const reasonCode = body.reason_code === undefined || body.reason_code === null || body.reason_code === ''
    ? null : normalizeText(body.reason_code);
  if (decision === 'rejected' && !reasonCode) {
    issues.push(issue('FEEDBACK_REASON_REQUIRED', '驳回必须给 reason_code'));
  }
  if (reasonCode && !FEEDBACK_REASON_CODES.includes(reasonCode)) {
    issues.push(issue('FEEDBACK_REASON_INVALID', `reason_code 必须是 ${FEEDBACK_REASON_CODES.join(' / ')} 之一`));
  }
  const note = body.note === undefined || body.note === null ? null : normalizeText(body.note);
  if (note && note.length > 500) issues.push(issue('FEEDBACK_NOTE_TOO_LONG', '备注不能超过 500 字'));
  const experimentId = body.experiment_id === undefined || body.experiment_id === null || body.experiment_id === ''
    ? null : normalizeText(body.experiment_id);
  const arm = body.arm === undefined || body.arm === null || body.arm === '' ? null : normalizeText(body.arm);
  if (arm && !EXPERIMENT_ARMS.includes(arm)) {
    issues.push(issue('FEEDBACK_ARM_INVALID', `arm 必须是 ${EXPERIMENT_ARMS.join(' / ')} 之一`));
  }
  if (arm && !experimentId) issues.push(issue('FEEDBACK_EXPERIMENT_REQUIRED', '声明 arm 时必须同时给 experiment_id'));
  return {
    ok: issues.length === 0,
    issues,
    value: { decision, reason_code: reasonCode, note, experiment_id: experimentId, arm },
  };
}

/**
 * 采用资格。adopted 只能落在"当前选用、报告可发布且未失效"的版本上；
 * rejected 可以落在任意已完成/失败的版本上，用于记录真实业务判断。
 */
export function evaluateFeedbackEligibility({
  decision, run = null, version = null, report = null, reportValidity = null,
} = {}) {
  const blockers = [];
  if (!run) {
    blockers.push(issue('FEEDBACK_RUN_MISSING', '任务不存在'));
  } else if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
    blockers.push(issue('FEEDBACK_RUN_NOT_TERMINAL', `任务尚未结束（${run.status}）`));
  }
  if (!version) {
    blockers.push(issue('FEEDBACK_VERSION_MISSING', '需要指明结果版本'));
  }
  if (decision === 'adopted') {
    if (version && version.active !== true) {
      blockers.push(issue('FEEDBACK_VERSION_INACTIVE', '只能采用当前选用的版本'));
    }
    if (!report) {
      blockers.push(issue('FEEDBACK_REPORT_MISSING', '缺少质量报告，不能采用'));
    } else {
      if (report.decision !== 'publishable') {
        blockers.push(issue('FEEDBACK_NOT_PUBLISHABLE', `报告结论为 ${report.decision}，不能采用`));
      }
      const validity = reportValidity ?? report.validity ?? null;
      if (validity !== 'current') {
        blockers.push(issue('FEEDBACK_REPORT_STALE', `报告有效性为 ${validity ?? 'unknown'}，需重新检查`));
      }
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/** 同一版本多次反馈时以最新一条为准；历史保留但不再影响当前采用状态。 */
export function resolveLatestFeedback(items = []) {
  const latest = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = `${item.run_id}:${item.version_id}`;
    const current = latest.get(key);
    if (!current || String(item.created_at).localeCompare(String(current.created_at)) >= 0) latest.set(key, item);
  }
  return [...latest.values()];
}

export function summarizeFeedback(items = []) {
  const latest = resolveLatestFeedback(items);
  const byDecision = { adopted: 0, rejected: 0 };
  const byReason = {};
  for (const item of latest) {
    if (Object.hasOwn(byDecision, item.decision)) byDecision[item.decision] += 1;
    if (item.decision === 'rejected' && item.reason_code) {
      byReason[item.reason_code] = (byReason[item.reason_code] ?? 0) + 1;
    }
  }
  const total = latest.length;
  return {
    total,
    adopted: byDecision.adopted,
    rejected: byDecision.rejected,
    adoption_rate: total > 0 ? byDecision.adopted / total : null,
    rejection_reasons: byReason,
  };
}

// ---------- 授权效果导入与实验口径 ----------

/** 导入前置条件：必须显式授权并给出来源，授权不是默认值。 */
export function validateOutcomeImportInput(body = {}) {
  const issues = [];
  if (body.authorized !== true) {
    issues.push(issue('OUTCOME_AUTHORIZATION_REQUIRED', '效果数据必须显式声明 authorized: true'));
  }
  const reference = normalizeText(body.authorization_reference);
  if (!reference) issues.push(issue('OUTCOME_PROVENANCE_REQUIRED', '必须提供授权来源（authorization_reference）'));
  const source = normalizeText(body.source);
  if (!source) issues.push(issue('OUTCOME_SOURCE_REQUIRED', '必须说明数据来源（source）'));
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) issues.push(issue('OUTCOME_ROWS_INVALID', 'rows 必须是数组'));
  else if (rows.length === 0) issues.push(issue('OUTCOME_ROWS_EMPTY', 'rows 不能为空'));
  else if (rows.length > OUTCOME_MAX_ROWS) {
    issues.push(issue('OUTCOME_ROWS_TOO_MANY', `单次导入不能超过 ${OUTCOME_MAX_ROWS} 行`));
  }
  const experimentId = body.experiment_id === undefined || body.experiment_id === null || body.experiment_id === ''
    ? null : normalizeText(body.experiment_id);
  const arm = body.arm === undefined || body.arm === null || body.arm === '' ? null : normalizeText(body.arm);
  if (arm && !EXPERIMENT_ARMS.includes(arm)) issues.push(issue('OUTCOME_ARM_INVALID', 'arm 必须是 control / variant'));
  if (arm && !experimentId) issues.push(issue('OUTCOME_EXPERIMENT_REQUIRED', '声明 arm 时必须同时给 experiment_id'));
  return {
    ok: issues.length === 0,
    issues,
    value: { source, authorization_reference: reference, experiment_id: experimentId, arm },
  };
}

function validateOutcomeRow(row, index, seen) {
  const errors = [];
  if (!isObject(row)) return { index, valid: false, errors: [issue('OUTCOME_ROW_INVALID', '行必须是对象')] };
  const sku = normalizeText(row.sku);
  if (!sku) errors.push(issue('OUTCOME_SKU_EMPTY', 'SKU 不能为空'));
  const metrics = {
    impressions: row.impressions, clicks: row.clicks, orders: row.orders,
    revenue_cents: row.revenue_cents, cost_credits: row.cost_credits,
  };
  for (const [key, value] of Object.entries(metrics)) {
    if (!nonNegativeInteger(value)) errors.push(issue('OUTCOME_METRIC_INVALID', `${key} 必须是非负整数`, { key, value }));
  }
  if (Number.isInteger(metrics.clicks) && Number.isInteger(metrics.impressions) && metrics.clicks > metrics.impressions) {
    errors.push(issue('OUTCOME_CLICKS_EXCEED_IMPRESSIONS', '点击不能大于曝光'));
  }
  if (Number.isInteger(metrics.orders) && Number.isInteger(metrics.clicks) && metrics.orders > metrics.clicks) {
    errors.push(issue('OUTCOME_ORDERS_EXCEED_CLICKS', '订单不能大于点击'));
  }
  const key = `${sku}:${normalizeText(row.period ?? '')}`;
  if (sku && seen.has(key)) errors.push(issue('OUTCOME_DUPLICATE_ROW', `同一周期内 SKU ${sku} 重复`));
  if (sku) seen.add(key);
  return {
    index,
    sku,
    valid: errors.length === 0,
    errors,
    row: errors.length === 0 ? { ...metrics, sku, period: normalizeText(row.period) || null } : null,
  };
}

/** 逐行校验效果数据；非法行只影响自身，正确行仍可用于统计。 */
export function previewOutcomeRows({ rows = [], existingSkus = null } = {}) {
  const seen = new Set();
  const known = existingSkus ? new Set(existingSkus.map(item => String(item).toLowerCase())) : null;
  const results = (Array.isArray(rows) ? rows : []).map((row, index) => {
    const checked = validateOutcomeRow(row, index, seen);
    if (checked.valid && known && !known.has(checked.sku.toLowerCase())) {
      checked.errors = [issue('OUTCOME_SKU_UNKNOWN', `SKU ${checked.sku} 不在当前项目库中`)];
      checked.valid = false;
      checked.row = null;
    }
    return checked;
  });
  const valid = results.filter(item => item.valid);
  return {
    ok: true,
    rows: results,
    accepted: valid.map(item => item.row),
    summary: { total: results.length, valid: valid.length, invalid: results.length - valid.length },
  };
}

/** 汇总指标；除数为 0 时返回 null，不写成 0 制造"零成本"假象。 */
export function summarizeOutcomeMetrics(rows = []) {
  const totals = { impressions: 0, clicks: 0, orders: 0, revenue_cents: 0, cost_credits: 0 };
  for (const row of rows) {
    for (const key of Object.keys(totals)) totals[key] += Number(row[key] ?? 0);
  }
  return {
    sample_rows: rows.length,
    totals,
    ctr: ratio(totals.clicks, totals.impressions),
    cvr: ratio(totals.orders, totals.clicks),
    revenue_per_order_cents: ratio(totals.revenue_cents, totals.orders),
    cost_per_order: ratio(totals.cost_credits, totals.orders),
    statistical_significance: 'not_computed',
  };
}

/**
 * 实验报告按 control/variant 分组比较。没有真实显著性与因果推断：
 * 样本不足时直接标 insufficient_sample，样本足够也只说"观测到差异"。
 */
export function buildExperimentReport({ experiment = null, outcomes = [], feedback = [] } = {}) {
  const experimentId = experiment?.id ?? null;
  const armRows = { control: [], variant: [] };
  for (const row of outcomes) {
    if (experimentId && row.experiment_id !== experimentId) continue;
    if (Object.hasOwn(armRows, row.arm)) armRows[row.arm].push(row);
  }
  const armFeedback = { control: [], variant: [] };
  for (const item of resolveLatestFeedback(feedback)) {
    if (experimentId && item.experiment_id !== experimentId) continue;
    if (Object.hasOwn(armFeedback, item.arm)) armFeedback[item.arm].push(item);
  }
  const arms = {};
  for (const arm of EXPERIMENT_ARMS) {
    arms[arm] = {
      ...summarizeOutcomeMetrics(armRows[arm]),
      feedback: summarizeFeedback(armFeedback[arm]),
    };
  }
  const insufficient = EXPERIMENT_ARMS.some(arm =>
    arms[arm].totals.impressions < MIN_EXPERIMENT_IMPRESSIONS
    || arms[arm].feedback.total < MIN_EXPERIMENT_FEEDBACK);
  const delta = key => (arms.control[key] === null || arms.variant[key] === null
    ? null : arms.variant[key] - arms.control[key]);
  return {
    experiment_id: experimentId,
    name: experiment?.name ?? null,
    status: insufficient ? 'insufficient_sample' : 'observed_difference',
    minimums: { impressions_per_arm: MIN_EXPERIMENT_IMPRESSIONS, feedback_per_arm: MIN_EXPERIMENT_FEEDBACK },
    arms,
    delta: {
      ctr: delta('ctr'),
      cvr: delta('cvr'),
      cost_per_order: delta('cost_per_order'),
      adoption_rate: delta('adoption_rate'),
    },
    statement: insufficient
      ? '样本不足，只能作为内部观察，不能据此判断效果'
      : '仅表示观测到组间差异，未做显著性检验，不能宣称因果或保证收益',
    statistical_significance: 'not_computed',
  };
}

// ---------- 商业化：套餐与支付能力 ----------

export function listBillingPlans() {
  return { plans: PLANS.map(plan => ({ ...plan })), currency: 'CNY', price_source: 'unset' };
}

export function planById(planId) {
  return PLANS.find(item => item.id === planId) ?? null;
}

/**
 * 支付能力闸口。根据 Provider 的 capabilities 决定能做什么：
 *   - 未配置 → can_checkout=false（阻断）
 *   - mock provider → can_checkout=true（演示）, can_settle=true（手动）
 *   - 真实 wechat provider → can_checkout=true（Native 下单已实现）, can_settle=true（回调自动结算）
 *                          can_refund=false（R09 实现）
 */
export function evaluatePaymentCapability({ provider = null } = {}) {
  const capabilities = typeof provider?.capabilities === 'function' ? provider.capabilities() : null;
  const blockers = [];
  if (!capabilities) {
    blockers.push(issue('PAYMENT_PROVIDER_UNCONFIGURED', '未配置支付 Provider，不能下单或退款'));
    return {
      mode: 'unconfigured',
      real_money: false,
      can_checkout: false,
      can_settle: false,
      can_refund: false,
      supports_native_qr: false,
      supports_query: false,
      supports_close: false,
      blockers,
    };
  }
  const realMoney = capabilities.real_money === true;
  const simulated = capabilities.simulated === true;
  const supportsRefunds = capabilities.supports_refunds === true;
  const supportsNativeQr = capabilities.supports_native_qr === true;
  const supportsQuery = capabilities.supports_query === true;
  const supportsClose = capabilities.supports_close === true;

  if (realMoney && !supportsNativeQr) {
    // 旧版兼容性：当 real_money=true 但没有 supports_native_qr 时，沿用旧 blocker 代码
    // PAYMENT_CHARGE_UNIMPLEMENTED 表示"真实扣款通道未接入"
    blockers.push(issue('PAYMENT_CHARGE_UNIMPLEMENTED', '真实扣款通道尚未接入，不能发起真实收款'));
  }
  if (simulated && realMoney) {
    // 矛盾：同时声明模拟和真实，拦截
    blockers.push(issue('PAYMENT_PROVIDER_CONFLICT', 'Provider 不能同时声明 simulated 和 real_money'));
  }
  // 模拟 Provider 不支持真实货币：作为 blockers 如实标注
  if (simulated && !realMoney) {
    blockers.push(issue('PAYMENT_REAL_MONEY_UNSUPPORTED', '当前支付 Provider 为模拟模式，不支持真实货币结算'));
  }

  return {
    mode: realMoney ? 'live' : simulated ? 'demo' : 'unknown',
    real_money: realMoney,
    simulated,
    can_checkout: simulated || (realMoney && supportsNativeQr),
    can_settle: simulated || realMoney,  // 真实支付通过回调结算
    can_refund: realMoney && supportsRefunds,
    supports_native_qr: supportsNativeQr,
    supports_query: supportsQuery,
    supports_close: supportsClose,
    acceptance: capabilities.acceptance ?? 'unknown',
    blockers,
  };
}

// ---------- 可观测性 ----------

export function countStoreTables(snapshot = {}) {
  const counts = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'schema_version') continue;
    counts[key] = value && typeof value === 'object' ? Object.keys(value).length : 0;
  }
  return counts;
}

/**
 * 可观测性快照：只给聚合数字，不含素材内容、提示词与操作者明文之外的隐私字段。
 * 任务积压按真实状态统计，不把"未开始"算进在途。
 */
export function buildObservabilitySnapshot({
  data = {}, tenantId = '', counters = {}, startedAt = null, at = null, provider = null, balance = null,
} = {}) {
  const scoped = rows => Object.values(rows ?? {}).filter(item => item.tenant_id === tenantId);
  const runs = scoped(data.runs);
  const states = {};
  for (const run of runs) states[run.status] = (states[run.status] ?? 0) + 1;
  const active = runs.filter(run => ['queued', 'running', 'budget_hold', 'awaiting_confirmation', 'revising'].includes(run.status));
  const batches = scoped(data.batches);
  const exports = scoped(data.exports);
  const feedback = scoped(data.feedback);
  return {
    tenant_id: tenantId,
    generated_at: at ?? new Date().toISOString(),
    uptime_ms: startedAt ? Date.parse(at ?? new Date().toISOString()) - Date.parse(startedAt) : null,
    http: {
      total: counters.total ?? 0,
      by_status: { ...(counters.by_status ?? {}) },
      errors: counters.errors ?? 0,
      by_error: { ...(counters.by_error ?? {}) },
    },
    work: {
      projects: scoped(data.projects).length,
      runs: runs.length,
      runs_active: active.length,
      runs_by_status: states,
      batches: batches.length,
      batches_running: batches.filter(item => item.status === 'running').length,
      exports: exports.length,
      feedback: feedback.length,
    },
    credits: balance ? { available: balance.available, reserved: balance.reserved ?? null } : null,
    provider: provider ? {
      mode: provider.mode ?? null,
      acceptance: provider.acceptance ?? 'not_verified',
      simulated: typeof provider.capabilities === 'function' ? provider.capabilities().simulated ?? null : null,
    } : null,
    storage: { tables: countStoreTables(data) },
  };
}

// ---------- 备份与恢复 ----------

const TENANT_TABLES = Object.freeze([
  'projects', 'assets', 'truth_versions', 'brand_kits', 'brand_kit_versions', 'specs',
  'quotes', 'runs', 'events', 'credit_accounts', 'credit_entries', 'generation_records',
  'quality_reports', 'exports', 'eval_dataset_items', 'eval_reports', 'model_candidates',
  'model_routing', 'detail_pages', 'video_plans', 'batches', 'batch_items', 'members',
  'recipes', 'recipe_versions', 'recipe_usages', 'feedback', 'outcome_imports',
  'experiments', 'billing_orders', 'payment_events',
]);

/** 按租户裁剪快照：备份与恢复都不触碰其他租户的数据。 */
export function tenantSnapshot(data = {}, tenantId = '') {
  const snapshot = { schema_version: data.schema_version ?? 1 };
  for (const table of TENANT_TABLES) {
    const rows = data[table];
    snapshot[table] = isObject(rows)
      ? Object.fromEntries(Object.entries(rows).filter(([, row]) => row?.tenant_id === tenantId))
      : {};
  }
  return snapshot;
}

/** 把备份写回草稿：只替换该租户的行，其他租户保持原样；恢复不是全库覆盖。 */
export function mergeTenantSnapshot(draft = {}, snapshot = {}, tenantId = '') {
  for (const table of TENANT_TABLES) {
    if (!isObject(draft[table])) draft[table] = {};
    for (const [id, row] of Object.entries(draft[table])) {
      if (row?.tenant_id === tenantId) delete draft[table][id];
    }
    for (const [id, row] of Object.entries(snapshot[table] ?? {})) {
      if (row?.tenant_id === tenantId) draft[table][id] = row;
    }
  }
  return draft;
}

export function blobRefsOf(snapshot = {}) {
  const refs = new Map();
  for (const asset of Object.values(snapshot.assets ?? {})) {
    if (asset?.sha256 && asset?.ext) refs.set(`${asset.sha256}.${asset.ext}`, { hash: asset.sha256, ext: asset.ext });
  }
  for (const record of Object.values(snapshot.exports ?? {})) {
    if (record?.package_sha256) refs.set(`${record.package_sha256}.zip`, { hash: record.package_sha256, ext: 'zip' });
  }
  return [...refs.values()].sort((left, right) => `${left.hash}.${left.ext}`.localeCompare(`${right.hash}.${right.ext}`));
}

export function buildBackupManifest({
  backupId, tenantId, snapshot = {}, createdAt = null, createdBy = null, formatVersion = BACKUP_FORMAT_VERSION,
} = {}) {
  const refs = blobRefsOf(snapshot);
  return {
    format_version: formatVersion,
    backup_id: backupId,
    tenant_id: tenantId,
    created_at: createdAt,
    created_by: createdBy,
    schema_version: snapshot.schema_version ?? 1,
    data_sha256: sha256(JSON.stringify(snapshot)),
    counts: countStoreTables(snapshot),
    blob_refs: refs,
    blob_refs_sha256: sha256(JSON.stringify(refs)),
  };
}

/**
 * 校验备份：结构、租户、数据哈希、记录数与引用文件都要对上。
 * 任何一项不符都返回 issue，调用方不得继续恢复。
 */
export function verifyBackupManifest({
  manifest = null, snapshot = null, tenantId = '', presentBlobs = [],
} = {}) {
  const issues = [];
  if (!manifest || !isObject(manifest)) {
    return { ok: false, issues: [issue('BACKUP_MANIFEST_INVALID', '备份清单不存在或格式错误')] };
  }
  if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
    issues.push(issue('BACKUP_FORMAT_UNSUPPORTED', `备份格式版本 ${manifest.format_version} 不受支持`));
  }
  if (manifest.tenant_id !== tenantId) {
    issues.push(issue('BACKUP_TENANT_MISMATCH', '备份属于其他租户，不能恢复'));
  }
  if (!snapshot) {
    issues.push(issue('BACKUP_SNAPSHOT_MISSING', '备份数据文件缺失'));
    return { ok: false, issues };
  }
  if (manifest.data_sha256 !== sha256(JSON.stringify(snapshot))) {
    issues.push(issue('BACKUP_DATA_HASH_MISMATCH', '备份数据哈希与清单不一致'));
  }
  const counts = countStoreTables(snapshot);
  for (const [table, expected] of Object.entries(manifest.counts ?? {})) {
    if ((counts[table] ?? 0) !== expected) {
      issues.push(issue('BACKUP_COUNT_MISMATCH', `表 ${table} 记录数不一致`, { expected, actual: counts[table] ?? 0 }));
    }
  }
  const refs = blobRefsOf(snapshot);
  if (manifest.blob_refs_sha256 !== sha256(JSON.stringify(refs))) {
    issues.push(issue('BACKUP_BLOB_SET_MISMATCH', '备份引用文件清单与数据不一致'));
  }
  const present = new Set(presentBlobs);
  for (const ref of refs) {
    if (!present.has(`${ref.hash}.${ref.ext}`)) {
      issues.push(issue('BACKUP_BLOB_MISSING', `引用文件缺失：${ref.hash}.${ref.ext}`));
    }
  }
  return { ok: issues.length === 0, issues };
}
