/**
 * P3 修订规划：把可信的 QA / 视觉报告整理成 issue_catalog，按真实能力生成可用动作，
 * 再由规划器（可选模型）产出单步方案，最后由服务端校验并转换为用户可读计划。
 *
 * 本模块刻意只做"建议"：
 * - 不提交供应商请求、不扣费、不写版本；
 * - 任何决策都必须带人工确认标记；
 * - 没有合法动作或证据不足时明确 needs_review / needs_material / stop，不用"再试一次"糊弄。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { contentHash } from './domain.mjs';

export const REVISION_PLANNER_VERSION = 'revision-planner.1';
export const REVISION_SCHEMA_VERSION = 'commerce-revision.1';
export const REVISION_SKILL_VERSION = 'commerce-image-refiner.1';
export const REVISION_TIMEOUT_MS = 20_000;

const ACTIONS = Object.freeze([
  'convert_format', 'resize_canvas', 'recompose_text', 'recompose_subject',
  'regenerate_background', 'regenerate_image', 'masked_edit',
]);

const DECISIONS = Object.freeze(['propose_action', 'no_change', 'needs_material', 'needs_review', 'stop']);

/** 动作需要的真实能力；没有能力就不能出现在 available_actions。 */
const ACTION_REQUIREMENTS = Object.freeze({
  convert_format: 'local_raster',
  resize_canvas: 'local_raster',
  recompose_text: 'text_layers',
  recompose_subject: 'subject_protection',
  regenerate_background: 'provider_generation',
  regenerate_image: 'provider_generation',
  masked_edit: 'provider_mask',
});

export const ACTION_TITLES = Object.freeze({
  convert_format: '转为目标格式',
  resize_canvas: '调整尺寸与画布',
  recompose_text: '重排营销文字与 Logo',
  recompose_subject: '恢复原始商品主体',
  regenerate_background: '重绘背景与光影',
  regenerate_image: '按原参考重新生成',
  masked_edit: '局部掩码编辑',
});

/** 检查项到候选动作的映射；只是候选，最终还要看能力与问题级权限。 */
const ISSUE_ACTIONS = Object.freeze({
  FILE_INTEGRITY: ['regenerate_image'],
  FILE_FORMAT: ['convert_format', 'regenerate_image'],
  SIZE: ['resize_canvas', 'regenerate_image'],
  RISK_CONTENT: ['regenerate_image'],
  VISUAL_QUALITY: ['regenerate_image'],
  BRAND_COMPLIANCE: ['recompose_text', 'regenerate_image'],
  PLATFORM_RULES: ['resize_canvas', 'regenerate_image'],
  TEXT_ACCURACY: ['recompose_text', 'regenerate_image'],
  OCR_TEXT: ['recompose_text', 'regenerate_image'],
  SUBJECT_PIXEL_PRESERVATION: ['recompose_subject', 'regenerate_image'],
  SUBJECT_PROTECTION: ['recompose_subject', 'regenerate_image'],
  SUBJECT_ALIGNMENT: ['recompose_subject', 'regenerate_image'],
  REVIEW_PRODUCT_IDENTITY: ['recompose_subject', 'regenerate_image'],
  REVIEW_PRODUCT_COLOR: ['recompose_subject', 'regenerate_image'],
  REVIEW_COMPOSITE_QUALITY: ['recompose_subject', 'regenerate_image'],
  REVIEW_COMPOSITION: ['regenerate_background', 'regenerate_image'],
  REVIEW_BRAND_LAYOUT: ['recompose_text', 'regenerate_image'],
  // 商品身份类事实缺失/不一致，不允许靠重绘掩盖：只能补素材或人工复核
  REVIEW_PACKAGE_TEXT: [],
  REVIEW_INCLUDED_ITEMS: [],
  REVIEW_SKU_MATCH: [],
});

const FORBIDDEN_PARAM_KEYS = /^(path|file|url|uri|endpoint|api|api_key|token|secret|password|command|cmd|script|headers|auth)/i;
const FORBIDDEN_PARAM_VALUE = /(https?:\/\/|file:\/\/|\.\.\/|^[A-Za-z]:\\|\/etc\/|\/bin\/)/;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function stripFrontmatter(text) {
  return String(text).replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

let refinerRulesCache = null;

/** 装配修订规则：refiner-system + Skill + 动作规则 + 输出 Schema。 */
export async function loadRefinerRules({ root = new URL('..', import.meta.url) } = {}) {
  if (refinerRulesCache) return refinerRulesCache;
  const files = {
    system: 'docs/ai-development/runtime/refiner-system.md',
    skill: 'skills/commerce-image-refiner/SKILL.md',
    actions: 'skills/commerce-image-refiner/references/actions.md',
    schema: 'skills/commerce-image-refiner/references/output.schema.json',
  };
  const entries = {};
  for (const [name, relative] of Object.entries(files)) {
    entries[name] = await readFile(new URL(relative, root), 'utf8');
  }
  const system = [entries.system, stripFrontmatter(entries.skill), entries.actions]
    .map(item => String(item).trim()).filter(Boolean).join('\n\n');
  const rulesHash = sha256([entries.system, stripFrontmatter(entries.skill), entries.actions, entries.schema].join('\u0000'));
  refinerRulesCache = {
    system,
    output_schema: JSON.parse(entries.schema),
    rules_hash: `refiner_rules_${rulesHash}`,
    files: Object.fromEntries(Object.entries(files).map(([name, relative]) => [relative, sha256(entries[name])])),
    skill_version: REVISION_SKILL_VERSION,
    schema_version: REVISION_SCHEMA_VERSION,
  };
  return refinerRulesCache;
}

function unavailablePlanner(reason, note) {
  return {
    configured: false,
    mode: 'not_configured',
    acceptance: 'not_available',
    note,
    async plan() {
      return { status: 'unavailable', reason, output: null };
    },
  };
}

export function createRevisionPlanner({
  endpoint = null, apiKey = null, model = null, timeoutMs = REVISION_TIMEOUT_MS, fetchImpl = globalThis.fetch,
} = {}) {
  if (!endpoint) {
    return unavailablePlanner(
      'REVISION_PLANNER_NOT_CONFIGURED',
      '未配置 QTB_REVISION_PLANNER_ENDPOINT，仅使用确定性规则生成建议，不调用模型',
    );
  }
  if (typeof fetchImpl !== 'function') {
    return unavailablePlanner('REVISION_PLANNER_FETCH_UNAVAILABLE', '当前运行时没有可用的 fetch');
  }
  return {
    configured: true,
    mode: 'http',
    acceptance: 'not_verified',
    model,
    note: '外部注入的修订规划端点；真实规划质量需人工评估',
    async plan({ system, user, output_schema = null, timeoutMs: callTimeout = timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), callTimeout);
      const started = Date.now();
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model, system, user, output_schema }),
          signal: controller.signal,
        });
        const text = await response.text();
        const latencyMs = Date.now() - started;
        if (!response.ok) {
          return { status: 'http_error', reason: `修订规划端点返回 HTTP ${response.status}`, output: null, latency_ms: latencyMs };
        }
        let payload;
        try { payload = JSON.parse(text); } catch {
          return { status: 'invalid_json', reason: '修订规划端点返回的不是合法 JSON', output: null, latency_ms: latencyMs };
        }
        const output = isPlainObject(payload?.output) ? payload.output
          : isPlainObject(payload?.result?.output) ? payload.result.output
            : isPlainObject(payload?.result) ? payload.result : payload;
        return {
          status: 'ok', output, latency_ms: latencyMs,
          request_id: payload?.request_id ?? null, model: payload?.model ?? model,
        };
      } catch (error) {
        const latencyMs = Date.now() - started;
        if (error?.name === 'AbortError') {
          return { status: 'timeout', reason: `修订规划调用超过 ${callTimeout}ms 未返回`, output: null, latency_ms: latencyMs };
        }
        return { status: 'error', reason: `修订规划调用失败：${error?.message ?? 'UNKNOWN_ERROR'}`, output: null, latency_ms: latencyMs };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createRevisionPlannerFromEnv(env = process.env) {
  const endpoint = typeof env?.QTB_REVISION_PLANNER_ENDPOINT === 'string'
    ? env.QTB_REVISION_PLANNER_ENDPOINT.trim() : '';
  if (!endpoint) return createRevisionPlanner({});
  const timeout = Number(env.QTB_REVISION_PLANNER_TIMEOUT_MS);
  return createRevisionPlanner({
    endpoint,
    apiKey: env.QTB_REVISION_PLANNER_API_KEY?.trim() || null,
    model: env.QTB_REVISION_PLANNER_MODEL?.trim() || null,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}

/** 从真实能力推导 available_actions，不让文案扩大权限。 */
export function resolveAvailableActions({
  providerCapabilities = {}, hasTextLayers = false, hasSubjectProtection = false, compositeAvailable = false,
} = {}) {
  const supported = new Set(['local_raster']);
  if (hasTextLayers) supported.add('text_layers');
  if (hasSubjectProtection || compositeAvailable) supported.add('subject_protection');
  if (providerCapabilities.supports_seed === true || providerCapabilities.supports_revision === true) {
    supported.add('provider_generation');
  }
  if (providerCapabilities.supports_mask === true) supported.add('provider_mask');
  return ACTIONS.filter(action => supported.has(ACTION_REQUIREMENTS[action]));
}

function issueKindOf(check) {
  if (check.status === 'fail') return 'fail';
  if (check.status === 'unknown' && (check.required === true || check.hard_gate === true)) return 'unknown';
  return null;
}

function issueReason(check) {
  if (Array.isArray(check.reasons) && check.reasons.length > 0) return check.reasons.join('；');
  if (typeof check.evidence === 'string') return check.evidence;
  if (check.evidence && typeof check.evidence.reason === 'string') return check.evidence.reason;
  return check.label ?? check.code;
}

/**
 * 汇总 issue_catalog。只收录 fail 与"必需但未知"的检查；
 * 非必需的未知（如美学评分）不进入修订范围，避免为了"看起来更好"反复消耗预算。
 */
export function buildIssueCatalog({ report, availableActions = [] } = {}) {
  const available = new Set(availableActions);
  return (report?.checks ?? [])
    .map(check => {
      const kind = issueKindOf(check);
      if (!kind) return null;
      const candidates = (ISSUE_ACTIONS[check.code] ?? []).filter(action => available.has(action));
      return {
        code: check.code,
        label: check.label ?? check.code,
        kind,
        severity: check.severity ?? 'medium',
        source: check.source ?? 'deterministic',
        hard_gate: check.hard_gate === true,
        required: check.required === true,
        evidence: issueReason(check),
        allowed_actions: candidates,
        needs_material: kind === 'fail' && candidates.length === 0,
      };
    })
    .filter(Boolean);
}

function lockedConstraintsOf({ truth, brandKitVersion = null, report }) {
  const constraints = [
    'preserve_product_identity',
    'preserve_packaging_text_and_logo',
    'preserve_passed_checks',
    'no_path_url_or_script_in_parameters',
  ];
  if (brandKitVersion) constraints.push('preserve_brand_colors_and_logo');
  if ((truth?.facts ?? []).some(fact => fact.critical === true)) constraints.push('preserve_confirmed_critical_facts');
  const passed = (report?.checks ?? []).filter(check => check.status === 'pass').map(check => check.code);
  return constraints;
}

/**
 * 组装规划请求。issue_catalog、可用动作、锁定约束、轮次限制都在这里冻结，
 * 模型只能在这些边界内提方案。
 */
export function buildRevisionRequest({
  project = null,
  run = null,
  deliverable = null,
  report = null,
  truth = null,
  spec = null,
  brandKitVersion = null,
  providerCapabilities = {},
  hasTextLayers = false,
  hasSubjectProtection = false,
  compositeAvailable = false,
  maxRounds = 3,
} = {}) {
  if (!report?.id) throw new TypeError('修订规划需要质量报告');
  const availableActions = resolveAvailableActions({
    providerCapabilities, hasTextLayers, hasSubjectProtection, compositeAvailable,
  });
  const issues = buildIssueCatalog({ report, availableActions });
  const passed = (report.checks ?? []).filter(check => check.status === 'pass').map(check => check.code);
  const version = (run?.versions ?? []).find(item =>
    item.active && item.deliverable_id === deliverable?.deliverable_id) ?? null;
  const round = run?.revision?.round ?? 0;
  return {
    schema_version: REVISION_SCHEMA_VERSION,
    skill_version: REVISION_SKILL_VERSION,
    context_hash: run?.product_context?.context_hash ?? `ctx_${contentHash({
      project_id: project?.id ?? null, sku: project?.sku ?? null,
      spec: spec ? { version: spec.version ?? null, content_hash: spec.content_hash ?? null } : null,
    })}`,
    report_id: report.id,
    report_hash: `report_${contentHash({
      id: report.id, decision: report.decision ?? null,
      checks: (report.checks ?? []).map(check => [check.code, check.status]),
    })}`,
    source_version_id: version?.id ?? `artifact:${deliverable?.deliverable_id ?? 'unknown'}`,
    artifact_hash: version?.hash ?? report.output_file?.hash ?? null,
    deliverable: {
      deliverable_id: deliverable?.deliverable_id ?? null,
      label: deliverable?.label ?? null,
      type: deliverable?.type ?? null,
      width: deliverable?.width ?? null,
      height: deliverable?.height ?? null,
      ratio: deliverable?.ratio ?? null,
      formats: [...(deliverable?.formats ?? [])],
    },
    issue_catalog: issues,
    available_actions: availableActions,
    locked_constraints: lockedConstraintsOf({ truth, brandKitVersion, report }),
    preserve_check_codes: passed,
    limits: {
      max_rounds: maxRounds,
      round_used: round,
      remaining_rounds: Math.max(0, maxRounds - round),
      no_improvement_limit: 2,
    },
  };
}

function scanParameters(value, path = 'parameters') {
  const errors = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...scanParameters(item, `${path}[${index}]`)));
    return errors;
  }
  if (!isPlainObject(value)) return errors;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PARAM_KEYS.test(key)) {
      errors.push({ path: `${path}.${key}`, message: `参数键「${key}」不允许携带路径/地址/凭证或脚本` });
    }
    if (typeof item === 'string' && FORBIDDEN_PARAM_VALUE.test(item)) {
      errors.push({ path: `${path}.${key}`, message: `参数值包含路径、URL 或脚本片段，禁止传入` });
    }
    errors.push(...scanParameters(item, `${path}.${key}`));
  }
  return errors;
}

const REQUIRED_KEYS = Object.freeze([
  'schema_version', 'skill_version', 'context_hash', 'source_version_id', 'based_on_report_id',
  'decision', 'action', 'target_check_codes', 'locked_constraints', 'parameters', 'instruction', 'reason',
  'material_requests',
]);

/** 校验规划输出：结构与绑定、动作权限、目标检查范围、参数洁净度、锁定约束。 */
export function validateRevisionPlan(output, request) {
  const errors = [];
  const push = (code, message, path = null) => errors.push({ code, message, path });
  if (!isPlainObject(output)) {
    return { ok: false, errors: [{ code: 'INVALID_OUTPUT_TYPE', message: '输出必须是 JSON 对象', path: null }] };
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in output)) push('MISSING_FIELD', `缺少字段 ${key}`, key);
  }
  for (const key of Object.keys(output)) {
    if (!REQUIRED_KEYS.includes(key)) push('UNEXPECTED_FIELD', `不允许的字段 ${key}`, key);
  }
  if (output.schema_version !== REVISION_SCHEMA_VERSION) push('SKILL_VERSION_MISMATCH', 'schema_version 不符', 'schema_version');
  if (output.skill_version !== REVISION_SKILL_VERSION) push('SKILL_VERSION_MISMATCH', 'skill_version 不符', 'skill_version');
  if (output.context_hash !== request.context_hash) push('BINDING_MISMATCH', 'context_hash 与请求不一致', 'context_hash');
  if (output.source_version_id !== request.source_version_id) push('BINDING_MISMATCH', 'source_version_id 与请求不一致', 'source_version_id');
  if (output.based_on_report_id !== request.report_id) push('BINDING_MISMATCH', 'based_on_report_id 与请求不一致', 'based_on_report_id');

  const decision = output.decision;
  if (!DECISIONS.includes(decision)) push('INVALID_DECISION', 'decision 不在允许集合内', 'decision');
  const action = output.action;
  if (action !== null && !ACTIONS.includes(action)) push('INVALID_ACTION', `未知动作：${action}`, 'action');
  if (!Array.isArray(output.target_check_codes)) push('INVALID_TARGETS', 'target_check_codes 必须为数组', 'target_check_codes');
  if (!Array.isArray(output.locked_constraints)) push('INVALID_CONSTRAINTS', 'locked_constraints 必须为数组', 'locked_constraints');
  if (!Array.isArray(output.material_requests)) push('INVALID_MATERIALS', 'material_requests 必须为数组', 'material_requests');
  if (!isPlainObject(output.parameters)) push('INVALID_PARAMETERS', 'parameters 必须为对象', 'parameters');
  if (typeof output.reason !== 'string' || !output.reason.trim()) push('REASON_REQUIRED', 'reason 不能为空', 'reason');
  if (output.instruction !== null && typeof output.instruction !== 'string') {
    push('INVALID_INSTRUCTION', 'instruction 必须为字符串或 null', 'instruction');
  }

  const issues = request.issue_catalog ?? [];
  const issueCodes = new Set(issues.map(issue => issue.code));
  const issuable = issues.filter(issue => issue.allowed_actions.length > 0);

  if (decision === 'propose_action') {
    if (typeof action !== 'string' || action === null) push('ACTION_REQUIRED', 'propose_action 必须给出动作', 'action');
    else if (!request.available_actions.includes(action)) push('ACTION_NOT_AVAILABLE', `当前能力不支持动作 ${action}`, 'action');
    else {
      const permitted = new Set(issuable.flatMap(issue => issue.allowed_actions));
      if (!permitted.has(action)) push('ACTION_NOT_PERMITTED', `该动作不在任何问题的允许范围内：${action}`, 'action');
    }
    const targets = Array.isArray(output.target_check_codes) ? output.target_check_codes : [];
    if (targets.length === 0) push('TARGET_REQUIRED', 'propose_action 必须指定要修复的检查项', 'target_check_codes');
    for (const code of targets) {
      if (!issueCodes.has(code)) {
        push('TARGET_NOT_FAILED', `检查项 ${code} 不在失败/待复核问题中，不能作为修订目标`, 'target_check_codes');
      } else {
        const issue = issues.find(item => item.code === code);
        if (!issue.allowed_actions.includes(action)) {
          push('TARGET_ACTION_MISMATCH', `检查项 ${code} 不允许动作 ${action}`, 'target_check_codes');
        }
      }
    }
    if (typeof output.instruction !== 'string' || !output.instruction.trim()) {
      push('INSTRUCTION_REQUIRED', 'propose_action 必须给出可执行说明', 'instruction');
    }
    if (Array.isArray(output.material_requests) && output.material_requests.length > 0) {
      push('MATERIAL_NOT_ALLOWED', 'propose_action 不能同时要求补素材', 'material_requests');
    }
    if (issues.length === 0) push('NOTHING_TO_FIX', '没有失败或待复核问题，不能 propose_action', 'decision');
    errors.push(...scanParameters(output.parameters));
  } else if (decision === 'no_change') {
    if (issuable.length > 0) push('NO_CHANGE_INVALID', '仍有可修复问题，不能声明 no_change', 'decision');
  } else if (decision === 'needs_material') {
    if (!Array.isArray(output.material_requests) || output.material_requests.length === 0) {
      push('MATERIAL_REQUIRED', 'needs_material 必须列出需要的素材', 'material_requests');
    }
    if (!issues.some(issue => issue.needs_material || issue.kind === 'unknown')) {
      push('MATERIAL_NOT_JUSTIFIED', '没有证据表明缺少素材', 'decision');
    }
  } else if (decision === 'needs_review') {
    if (!issues.some(issue => issue.allowed_actions.length === 0)) {
      push('REVIEW_NOT_JUSTIFIED', '仍有合法动作，不能直接转人工复核', 'decision');
    }
  } else if (decision === 'stop') {
    const limits = request.limits ?? {};
    if ((limits.remaining_rounds ?? 0) > 0) push('STOP_NOT_ALLOWED', '轮次未用尽，不能用 stop 结束', 'decision');
  }

  if (decision !== 'propose_action') {
    if (action !== null) push('ACTION_MUST_BE_NULL', '非 propose_action 时 action 必须为 null', 'action');
    if (output.instruction !== null) push('INSTRUCTION_MUST_BE_NULL', '非 propose_action 时 instruction 必须为 null', 'instruction');
    if (isPlainObject(output.parameters) && Object.keys(output.parameters).length > 0) {
      push('PARAMETERS_MUST_BE_EMPTY', '非 propose_action 时 parameters 必须为空', 'parameters');
    }
    if (Array.isArray(output.target_check_codes) && output.target_check_codes.length > 0) {
      push('TARGETS_MUST_BE_EMPTY', '非 propose_action 时 target_check_codes 必须为空', 'target_check_codes');
    }
  }

  if (Array.isArray(output.locked_constraints)) {
    for (const constraint of request.locked_constraints ?? []) {
      if (!output.locked_constraints.includes(constraint)) {
        push('MISSING_LOCKED_CONSTRAINT', `缺少必须保留的约束：${constraint}`, 'locked_constraints');
      }
    }
  }

  const maxRounds = request.limits?.max_rounds ?? 0;
  if (decision === 'propose_action' && (request.limits?.remaining_rounds ?? 0) <= 0 && maxRounds > 0) {
    push('ROUND_LIMIT_REACHED', '修订轮次已用尽，不能再提出动作', 'decision');
  }

  return { ok: errors.length === 0, errors };
}

/** 调用规划器（已配置时），并始终返回可展示的计划。 */
export async function planRevisionAction({ planner, rules = null, request, timeoutMs } = {}) {
  if (!request) throw new TypeError('planRevisionAction 需要请求');
  if (!planner?.configured) {
    return {
      status: 'not_configured', reason: 'REVISION_PLANNER_NOT_CONFIGURED',
      note: '未配置修订规划模型，仅展示确定性建议', request, rules_hash: null,
    };
  }
  const resolvedRules = rules ?? await loadRefinerRules();
  const result = await planner.plan({
    system: resolvedRules.system,
    user: JSON.stringify({ revision_request: request }),
    output_schema: resolvedRules.output_schema,
    ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
  if (result.status !== 'ok') {
    return {
      status: result.status, reason: result.reason ?? result.status,
      request, rules_hash: resolvedRules.rules_hash, output: null,
      latency_ms: result.latency_ms ?? null, model: result.model ?? null,
    };
  }
  const validation = validateRevisionPlan(result.output, request);
  return {
    status: validation.ok ? 'ok' : 'invalid_output',
    output: result.output, validation, request, rules_hash: resolvedRules.rules_hash,
    latency_ms: result.latency_ms ?? null, model: result.model ?? null,
    request_id: result.request_id ?? null,
    reason: validation.ok ? null : '修订建议未通过结构、权限或参数校验',
  };
}

/** 确定性兜底：没有模型时，用第一个有合法动作的问题生成最小建议。 */
export function deterministicPlan({ request }) {
  const issues = request.issue_catalog ?? [];
  const actionable = issues.filter(issue => issue.allowed_actions.length > 0);
  const materials = issues.filter(issue => issue.needs_material || issue.kind === 'unknown');
  const base = {
    schema_version: REVISION_SCHEMA_VERSION,
    skill_version: REVISION_SKILL_VERSION,
    context_hash: request.context_hash,
    source_version_id: request.source_version_id,
    based_on_report_id: request.report_id,
    action: null,
    target_check_codes: [],
    locked_constraints: [...request.locked_constraints],
    parameters: {},
    instruction: null,
    material_requests: [],
  };
  if ((request.limits?.remaining_rounds ?? 0) <= 0 && (request.limits?.max_rounds ?? 0) > 0) {
    return {
      ...base, decision: 'stop', reason: '修订轮次已用尽，需要人工决定是否继续并追加预算',
      material_requests: [],
    };
  }
  if (issues.length === 0) {
    return { ...base, decision: 'no_change', reason: '没有失败或必需但未知的检查项' };
  }
  if (actionable.length === 0) {
    if (materials.length > 0) {
      return {
        ...base, decision: 'needs_material',
        reason: '当前问题没有合法工具路径，需要补充实拍素材或明确资料',
        material_requests: materials.map(issue => `${issue.code}：${issue.evidence}`),
      };
    }
    return { ...base, decision: 'needs_review', reason: '问题只能人工判断' };
  }
  const head = actionable.sort((left, right) => {
    const rank = issue => (issue.kind === 'fail' ? 0 : 1);
    return rank(left) - rank(right) || left.code.localeCompare(right.code);
  })[0];
  const action = head.allowed_actions[0];
  return {
    ...base,
    decision: 'propose_action',
    action,
    target_check_codes: [head.code],
    instruction: `仅修复 ${head.code}（${head.label}）：${head.evidence}。保持其他通过项与已确认事实不变。`,
    reason: `确定性问题与合法动作匹配：${head.code} → ${action}`,
  };
}

const STATUS_TITLES = Object.freeze({
  ok: '修订建议',
  not_configured: '确定性修订建议（未配置规划模型）',
  invalid_output: '修订建议未通过校验',
  timeout: '修订规划超时',
  error: '修订规划失败',
  invalid_json: '修订规划返回非 JSON',
  http_error: '修订规划端点报错',
  unavailable: '修订规划不可用',
});

/**
 * 转换为用户可读计划。阶段 3 只到"建议 + 人工确认"这一步：
 * executable 固定 false，真正执行由人工在后续流程触发，绝不自动扣费或改图。
 */
export function presentRevisionPlan({ plan, report = null } = {}) {
  if (!plan?.request) throw new TypeError('presentRevisionPlan 需要 planning 结果');
  const request = plan.request;
  const output = plan.status === 'ok' || plan.status === 'not_configured'
    ? (plan.output ?? deterministicPlan({ request }))
    : deterministicPlan({ request });
  // 只有模型校验通过的计划或确定性兜底可以被人工确认执行；超时/非法输出等只能人工重试或处理
  const trustedPlan = plan.status === 'ok' || plan.status === 'not_configured';
  const decision = output.decision;
  const steps = [];
  if (decision === 'propose_action') {
    steps.push(`动作：${ACTION_TITLES[output.action] ?? output.action}`);
    steps.push(`目标检查项：${output.target_check_codes.join('、')}`);
    steps.push(`执行说明：${output.instruction}`);
    steps.push(`必须保留：${output.locked_constraints.join('、')}`);
    steps.push('执行后必须重新评审；仅生成建议不算执行成功');
  } else if (decision === 'needs_material') {
    steps.push('补齐素材：');
    steps.push(...output.material_requests.map(item => `- ${item}`));
    steps.push('补齐后重新生成并全量复检');
  } else if (decision === 'needs_review') {
    steps.push('转人工复核：现有证据不足或没有安全的工具路径');
    steps.push(`原因：${output.reason}`);
  } else if (decision === 'no_change') {
    steps.push('无需修订：没有失败或必需但未知的检查项');
  } else if (decision === 'stop') {
    steps.push(`停止：${output.reason}`);
    steps.push('如需继续，必须由人工追加预算或轮次，不自动扩大');
  }
  const invalid = plan.status === 'invalid_output';
  if (invalid) {
    steps.push('校验失败原因：');
    steps.push(...plan.validation.errors.slice(0, 8).map(error => `- ${error.code}：${error.message}`));
    steps.push('服务端不会执行未经校验的方案');
  }
  return {
    version: REVISION_PLANNER_VERSION,
    status: invalid ? 'invalid_output' : (plan.status === 'ok' ? 'proposed' : plan.status === 'not_configured' ? 'deterministic' : plan.status),
    title: STATUS_TITLES[plan.status] ?? '修订建议',
    report_id: request.report_id,
    report_hash: request.report_hash,
    context_hash: request.context_hash,
    source_version_id: request.source_version_id,
    deliverable_id: request.deliverable?.deliverable_id ?? null,
    decision,
    action: output.action,
    target_check_codes: [...output.target_check_codes],
    locked_constraints: [...output.locked_constraints],
    material_requests: [...output.material_requests],
    instruction: output.instruction,
    reason: output.reason,
    steps,
    issues: request.issue_catalog,
    available_actions: [...request.available_actions],
    preserve_check_codes: [...request.preserve_check_codes],
    limits: request.limits,
    rules_hash: plan.rules_hash ?? null,
    model: plan.model ?? null,
    latency_ms: plan.latency_ms ?? null,
    request_id: plan.request_id ?? null,
    // 阶段 3 的边界：只生成建议，不自动执行；执行需人工确认并复用既有任务/版本系统
    requires_confirmation: decision === 'propose_action' && trustedPlan,
    executable: false,
    executed: false,
    note: decision === 'propose_action'
      ? '该计划尚未执行；确认后会以单步修订提交，执行后必须重新评审并核对通过项未退步'
      : '未产生可执行动作，不消耗预算',
    checked_at: new Date().toISOString(),
    report_decision: report?.decision ?? null,
  };
}
