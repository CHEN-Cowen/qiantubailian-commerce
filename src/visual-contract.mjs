/**
 * 商品图评审 / 修订协议的应用侧校验（无外部依赖、不调用模型）。
 *
 * 对应 docs/ai-development/RUNTIME-CONTRACT.md 与
 * skills/commerce-image-reviewer|commerce-image-refiner/references/output.schema.json。
 * 这里先只做纯函数校验，供离线评测与后续 P2/P3 Adapter 复用；
 * 不负责读取素材、调用模型、保存报告。
 */
export const REVIEW_SCHEMA_VERSION = 'commerce-review.1';
export const REVIEW_SKILL_VERSION = 'commerce-image-reviewer.1';
export const REVISION_SCHEMA_VERSION = 'commerce-revision.1';
export const REVISION_SKILL_VERSION = 'commerce-image-refiner.1';

export const REVIEW_CHECK_CODES = Object.freeze([
  'PRODUCT_IDENTITY', 'SKU_MATCH', 'PRODUCT_COLOR', 'PACKAGE_TEXT',
  'INCLUDED_ITEMS', 'BRAND_LAYOUT', 'COMPOSITION', 'COMPOSITE_QUALITY',
]);
export const REVIEW_STATUSES = Object.freeze(['pass', 'fail', 'unknown', 'not_applicable']);
export const OBSERVATION_STATUSES = Object.freeze(['complete', 'partial', 'unavailable']);
export const REVISION_DECISIONS = Object.freeze(['propose_action', 'no_change', 'needs_material', 'needs_review', 'stop']);
export const REVISION_ACTIONS = Object.freeze([
  'convert_format', 'resize_canvas', 'recompose_text', 'recompose_subject',
  'regenerate_background', 'regenerate_image', 'masked_edit',
]);

const REVIEW_ROOT_KEYS = Object.freeze([
  'schema_version', 'skill_version', 'context_hash', 'artifact_version_id',
  'artifact_hash', 'observation_status', 'checks', 'unknown_reasons',
]);
const REVIEW_CHECK_KEYS = Object.freeze([
  'code', 'status', 'evidence', 'region', 'reference_image_ids', 'suggested_fix',
]);
const REVISION_ROOT_KEYS = Object.freeze([
  'schema_version', 'skill_version', 'context_hash', 'source_version_id',
  'based_on_report_id', 'decision', 'action', 'target_check_codes',
  'locked_constraints', 'parameters', 'instruction', 'reason', 'material_requests',
]);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function fail(errors, code, path, message) {
  errors.push({ code, path, message });
}

function requireObject(errors, value, path, code) {
  if (!isPlainObject(value)) {
    fail(errors, code, path, '必须为对象');
    return false;
  }
  return true;
}

function requireKeys(errors, value, path, required, allowed = required) {
  for (const key of required) {
    if (!hasOwn(value, key)) fail(errors, 'MISSING_FIELD', `${path}.${key}`, '缺少必填字段');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(errors, 'EXTRA_FIELD', `${path}.${key}`, '不允许的额外字段');
  }
}

function requireString(errors, value, path, { nonEmpty = true } = {}) {
  if (typeof value !== 'string') {
    fail(errors, 'INVALID_TYPE', path, '必须为字符串');
    return false;
  }
  if (nonEmpty && !isNonEmptyString(value)) {
    fail(errors, 'EMPTY_STRING', path, '不能为空字符串');
    return false;
  }
  return true;
}

function requireNullableString(errors, value, path) {
  if (value === null) return true;
  return requireString(errors, value, path);
}

function requireUniqueStrings(errors, value, path, { minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    fail(errors, 'INVALID_TYPE', path, '必须为数组');
    return false;
  }
  if (value.length < minItems) fail(errors, 'MIN_ITEMS', path, `至少需要 ${minItems} 项`);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isNonEmptyString(item)) {
      fail(errors, 'INVALID_ITEM', `${path}[${index}]`, '必须为非空字符串');
      continue;
    }
    if (seen.has(item)) fail(errors, 'DUPLICATE_ITEM', `${path}[${index}]`, `重复项：${item}`);
    seen.add(item);
  }
  return true;
}

function validateRegion(errors, region, path) {
  if (region === null) return;
  if (!Array.isArray(region) || region.length !== 4) {
    fail(errors, 'INVALID_REGION', path, '必须为 null 或 4 个数值');
    return;
  }
  const [x1, y1, x2, y2] = region;
  if (!region.every(item => typeof item === 'number' && Number.isFinite(item))) {
    fail(errors, 'INVALID_REGION', path, '坐标必须为有限数值');
    return;
  }
  if (region.some(item => item < 0 || item > 1)) {
    fail(errors, 'INVALID_REGION', path, '坐标必须位于 0—1');
  }
  if (!(x1 < x2) || !(y1 < y2)) {
    fail(errors, 'INVALID_REGION', path, '坐标必须满足 0≤x1<x2≤1、0≤y1<y2≤1');
  }
}

/**
 * 校验评审输出。request 可选；提供时必须同时核对请求绑定与参考图归属。
 * 返回 { ok, errors }，errors 为 [{ code, path, message }]。
 */
export function validateReviewOutput(output, { request = null } = {}) {
  const errors = [];
  if (!requireObject(errors, output, '$', 'INVALID_ROOT')) return { ok: false, errors };
  requireKeys(errors, output, '$', REVIEW_ROOT_KEYS);
  if (output.schema_version !== REVIEW_SCHEMA_VERSION) {
    fail(errors, 'VERSION_MISMATCH', '$.schema_version', `必须为 ${REVIEW_SCHEMA_VERSION}`);
  }
  if (output.skill_version !== REVIEW_SKILL_VERSION) {
    fail(errors, 'VERSION_MISMATCH', '$.skill_version', `必须为 ${REVIEW_SKILL_VERSION}`);
  }
  for (const key of ['context_hash', 'artifact_version_id', 'artifact_hash']) {
    requireString(errors, output[key], `$.${key}`);
  }
  if (!OBSERVATION_STATUSES.includes(output.observation_status)) {
    fail(errors, 'INVALID_ENUM', '$.observation_status', 'observation_status 非法');
  }
  requireUniqueStrings(errors, output.unknown_reasons, '$.unknown_reasons');

  if (!Array.isArray(output.checks)) {
    fail(errors, 'INVALID_TYPE', '$.checks', '必须为数组');
  } else {
    if (output.checks.length !== REVIEW_CHECK_CODES.length) {
      fail(errors, 'CHECK_COUNT', '$.checks', `必须恰好 ${REVIEW_CHECK_CODES.length} 项`);
    }
    const seenCodes = new Set();
    for (let index = 0; index < output.checks.length; index += 1) {
      const check = output.checks[index];
      const path = `$.checks[${index}]`;
      if (!requireObject(errors, check, path, 'INVALID_CHECK')) continue;
      requireKeys(errors, check, path, REVIEW_CHECK_KEYS);
      if (!REVIEW_CHECK_CODES.includes(check.code)) {
        fail(errors, 'INVALID_ENUM', `${path}.code`, '检查代码不在固定注册表内');
      } else {
        if (seenCodes.has(check.code)) fail(errors, 'DUPLICATE_CHECK', `${path}.code`, `检查项重复：${check.code}`);
        seenCodes.add(check.code);
      }
      if (!REVIEW_STATUSES.includes(check.status)) {
        fail(errors, 'INVALID_ENUM', `${path}.status`, '检查状态非法');
      }
      requireString(errors, check.evidence, `${path}.evidence`);
      validateRegion(errors, check.region, `${path}.region`);
      requireUniqueStrings(errors, check.reference_image_ids, `${path}.reference_image_ids`);
      requireNullableString(errors, check.suggested_fix, `${path}.suggested_fix`);
      if (['fail', 'unknown'].includes(check.status) && !isNonEmptyString(check.suggested_fix)) {
        fail(errors, 'MISSING_FIX', `${path}.suggested_fix`, `${check.status} 必须给出修复目标或补证据建议`);
      }
      if (output.observation_status === 'unavailable' && check.status !== 'unknown') {
        fail(errors, 'UNAVAILABLE_JUDGED', `${path}.status`, '未收到候选图时八项必须为 unknown');
      }
    }
    for (const code of REVIEW_CHECK_CODES) {
      if (!seenCodes.has(code)) fail(errors, 'MISSING_CHECK', '$.checks', `缺少检查项：${code}`);
    }
  }

  const hasUnknown = Array.isArray(output.checks) && output.checks.some(item => item?.status === 'unknown');
  if ((hasUnknown || output.observation_status !== 'complete') && output.unknown_reasons?.length === 0) {
    fail(errors, 'MISSING_UNKNOWN_REASONS', '$.unknown_reasons', '存在未知项或观察不完整时必须说明原因');
  }

  if (request) validateReviewBinding(errors, output, request);
  return { ok: errors.length === 0, errors };
}

function validateReviewBinding(errors, output, request) {
  if (!requireObject(errors, request, 'request', 'INVALID_REQUEST')) return;
  for (const key of ['context_hash', 'artifact_version_id', 'artifact_hash']) {
    if (!isNonEmptyString(request[key])) {
      fail(errors, 'INVALID_REQUEST', `request.${key}`, '请求字段缺失');
    } else if (request[key] !== output[key]) {
      fail(errors, 'BINDING_MISMATCH', `$.${key}`, '输出绑定字段与本次请求不一致');
    }
  }
  if (Array.isArray(request.required_check_codes) &&
    (request.required_check_codes.length !== REVIEW_CHECK_CODES.length ||
      !REVIEW_CHECK_CODES.every(code => request.required_check_codes.includes(code)))) {
    fail(errors, 'INVALID_REQUEST', 'request.required_check_codes', '请求必须固定要求八项检查');
  }
  const bindings = request.image_bindings;
  if (!Array.isArray(bindings)) {
    fail(errors, 'INVALID_REQUEST', 'request.image_bindings', '缺少图片绑定');
    return;
  }
  const ids = new Set();
  const referenceIds = new Set();
  let candidates = 0;
  let candidateId = null;
  for (const binding of bindings) {
    if (!isPlainObject(binding) || !isNonEmptyString(binding.image_id)) {
      fail(errors, 'INVALID_REQUEST', 'request.image_bindings', '图片绑定结构无效');
      continue;
    }
    if (ids.has(binding.image_id)) {
      fail(errors, 'DUPLICATE_IMAGE_ID', 'request.image_bindings', `重复 image_id：${binding.image_id}`);
    }
    ids.add(binding.image_id);
    if (binding.role === 'candidate') {
      candidates += 1;
      candidateId = binding.image_id;
      if (binding.attached === false && output.observation_status !== 'unavailable') {
        fail(errors, 'CANDIDATE_MISSING', '$.observation_status', '候选图未实际送入时必须为 unavailable');
      }
    } else if (binding.attached === true) {
      referenceIds.add(binding.image_id);
    }
  }
  if (candidates !== 1) {
    fail(errors, 'INVALID_REQUEST', 'request.image_bindings', '必须恰有一个 candidate');
  }
  for (let index = 0; index < (output.checks?.length ?? 0); index += 1) {
    const check = output.checks[index];
    if (!isPlainObject(check) || !Array.isArray(check.reference_image_ids)) continue;
    if (candidateId && check.reference_image_ids.includes(candidateId)) {
      fail(errors, 'SELF_REFERENCE', `$.checks[${index}].reference_image_ids`, '候选图不能作为自身商品一致性依据');
    }
    for (const id of check.reference_image_ids) {
      if (!referenceIds.has(id)) {
        fail(errors, 'UNKNOWN_REFERENCE', `$.checks[${index}].reference_image_ids`, `未授权的参考图 ID：${id}`);
      }
    }
  }
  if (referenceIds.size === 0) {
    const productCodes = ['PRODUCT_IDENTITY', 'SKU_MATCH', 'PRODUCT_COLOR'];
    for (let index = 0; index < (output.checks?.length ?? 0); index += 1) {
      const check = output.checks[index];
      if (productCodes.includes(check?.code) && check.status === 'pass') {
        fail(errors, 'NO_REFERENCE_PASS', `$.checks[${index}].status`, '缺少参考图时商品对照检查不能 pass');
      }
    }
  }
}

/**
 * 校验修订输出。request 可选；提供时核对报告有效性、动作白名单、目标失败项、
 * 参数 Schema、素材归属与轮次/预算限制。
 */
export function validateRevisionPlan(output, { request = null } = {}) {
  const errors = [];
  if (!requireObject(errors, output, '$', 'INVALID_ROOT')) return { ok: false, errors };
  requireKeys(errors, output, '$', REVISION_ROOT_KEYS);
  if (output.schema_version !== REVISION_SCHEMA_VERSION) {
    fail(errors, 'VERSION_MISMATCH', '$.schema_version', `必须为 ${REVISION_SCHEMA_VERSION}`);
  }
  if (output.skill_version !== REVISION_SKILL_VERSION) {
    fail(errors, 'VERSION_MISMATCH', '$.skill_version', `必须为 ${REVISION_SKILL_VERSION}`);
  }
  for (const key of ['context_hash', 'source_version_id', 'based_on_report_id']) {
    requireString(errors, output[key], `$.${key}`);
  }
  if (!REVISION_DECISIONS.includes(output.decision)) {
    fail(errors, 'INVALID_ENUM', '$.decision', 'decision 非法');
  }
  if (output.action !== null && !REVISION_ACTIONS.includes(output.action)) {
    fail(errors, 'INVALID_ENUM', '$.action', 'action 不在动作表内');
  }
  requireUniqueStrings(errors, output.target_check_codes, '$.target_check_codes');
  requireUniqueStrings(errors, output.locked_constraints, '$.locked_constraints');
  requireObject(errors, output.parameters, '$.parameters', 'INVALID_PARAMETERS');
  requireNullableString(errors, output.instruction, '$.instruction');
  requireString(errors, output.reason, '$.reason');
  requireUniqueStrings(errors, output.material_requests, '$.material_requests');

  const isAction = output.decision === 'propose_action';
  if (isAction) {
    if (output.action === null) fail(errors, 'ACTION_REQUIRED', '$.action', 'propose_action 必须给出动作');
    if (output.target_check_codes.length === 0) fail(errors, 'TARGET_REQUIRED', '$.target_check_codes', 'propose_action 必须给出目标检查项');
    if (!isNonEmptyString(output.instruction)) fail(errors, 'INSTRUCTION_REQUIRED', '$.instruction', 'propose_action 必须给出修复目标');
    if (output.material_requests.length > 0) fail(errors, 'MATERIAL_ON_ACTION', '$.material_requests', 'propose_action 不能同时请求补素材');
  } else {
    if (output.action !== null) fail(errors, 'ACTION_ON_NON_ACTION', '$.action', '非执行分支不能包含动作');
    if (output.instruction !== null) fail(errors, 'INSTRUCTION_ON_NON_ACTION', '$.instruction', '非执行分支不能包含修复指令');
    if (output.target_check_codes.length > 0) fail(errors, 'TARGET_ON_NON_ACTION', '$.target_check_codes', '非执行分支不能包含目标检查项');
    if (isPlainObject(output.parameters) && Object.keys(output.parameters).length > 0) {
      fail(errors, 'PARAMETERS_ON_NON_ACTION', '$.parameters', '非执行分支参数必须为空');
    }
  }
  if (output.decision === 'needs_material' && output.material_requests.length === 0) {
    fail(errors, 'MATERIAL_REQUIRED', '$.material_requests', 'needs_material 必须说明缺少的素材');
  }

  if (request) validateRevisionBinding(errors, output, request);
  return { ok: errors.length === 0, errors };
}

function validateRevisionBinding(errors, output, request) {
  if (!requireObject(errors, request, 'request', 'INVALID_REQUEST')) return;
  for (const key of ['context_hash', 'source_version_id', 'based_on_report_id']) {
    if (!isNonEmptyString(request[key])) {
      fail(errors, 'INVALID_REQUEST', `request.${key}`, '请求字段缺失');
    } else if (request[key] !== output[key]) {
      fail(errors, 'BINDING_MISMATCH', `$.${key}`, '输出绑定字段与本次请求不一致');
    }
  }

  if (request.report_valid !== true && output.decision !== 'needs_review') {
    fail(errors, 'STALE_REPORT', '$.decision', '报告无效时必须 needs_review，不能执行或声明无需修改');
  }

  const catalog = Array.isArray(request.issue_catalog) ? request.issue_catalog : [];
  const actions = Array.isArray(request.available_actions) ? request.available_actions : [];

  if (output.decision === 'no_change') {
    const unresolved = catalog.filter(issue => issue?.required === true && ['fail', 'unknown'].includes(issue.status));
    if (unresolved.length > 0) {
      fail(errors, 'UNRESOLVED_ISSUES', '$.decision', `仍有必需问题未解决：${unresolved.map(item => item.code).join(', ')}`);
    }
  }

  if (output.decision !== 'propose_action') return;

  const limits = request.limits;
  if (!isPlainObject(limits) ||
    !Number.isInteger(limits.remaining_rounds) || limits.remaining_rounds <= 0 ||
    typeof limits.budget_remaining !== 'number' || typeof limits.minimum_action_cost !== 'number' ||
    limits.budget_remaining < limits.minimum_action_cost || limits.deadline_reached === true) {
    fail(errors, 'LIMITS_EXCEEDED', '$.decision', '轮次、预算或截止时间不满足执行条件');
  }

  const tool = actions.find(item => item?.action === output.action);
  if (!tool) {
    fail(errors, 'ACTION_NOT_AVAILABLE', '$.action', `动作未注册或不支持：${output.action}`);
    return;
  }

  for (const code of output.target_check_codes) {
    const matches = catalog.filter(item => item?.code === code);
    if (matches.length !== 1) {
      fail(errors, 'TARGET_UNKNOWN', '$.target_check_codes', `目标检查项不存在或重复：${code}`);
      continue;
    }
    const issue = matches[0];
    if (issue.status !== 'fail') {
      fail(errors, 'TARGET_NOT_FAIL', '$.target_check_codes', `目标检查项不是 fail：${code}`);
    }
    if (!Array.isArray(issue.allowed_actions) || !issue.allowed_actions.includes(output.action)) {
      fail(errors, 'ACTION_NOT_ALLOWED', '$.target_check_codes', `该问题不允许此动作：${code} / ${output.action}`);
    }
  }

  if (tool.parameter_schema) {
    validateSchemaValue(output.parameters, tool.parameter_schema, '$.parameters', errors);
  }
  validateParameterAssets(output.parameters, tool.allowed_asset_ids, errors);
}

function validateParameterAssets(parameters, allowedAssetIds, errors) {
  if (!isPlainObject(parameters)) return;
  const allowed = Array.isArray(allowedAssetIds) ? allowedAssetIds : [];
  for (const [key, value] of Object.entries(parameters)) {
    if (/^[a-z_]*_asset_id$/.test(key) && typeof value === 'string' && !allowed.includes(value)) {
      fail(errors, 'ASSET_NOT_ALLOWED', `$.parameters.${key}`, `素材不属于允许范围：${value}`);
    }
    if (/^[a-z_]*_asset_ids$/.test(key) && Array.isArray(value)) {
      for (const id of value) {
        if (typeof id === 'string' && !allowed.includes(id)) {
          fail(errors, 'ASSET_NOT_ALLOWED', `$.parameters.${key}`, `素材不属于允许范围：${id}`);
        }
      }
    }
  }
}

const typeMatches = (value, type) => {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
};

/** 最小 JSON Schema 子集校验：覆盖 Action parameter_schema 用到的字段。 */
function validateSchemaValue(value, schema, path, errors) {
  if (schema === true || schema === undefined) return;
  if (!isPlainObject(schema)) return;
  if (hasOwn(schema, 'const') && value !== schema.const) {
    fail(errors, 'SCHEMA_CONST', path, `必须等于 ${schema.const}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(errors, 'SCHEMA_ENUM', path, `不在允许取值内：${JSON.stringify(value)}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) {
      fail(errors, 'SCHEMA_TYPE', path, `类型必须为 ${types.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some(item => {
      const nested = [];
      validateSchemaValue(value, item, path, nested);
      return nested.length === 0;
    });
    if (!matched) fail(errors, 'SCHEMA_ANY_OF', path, '不满足 anyOf 任一分支');
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!hasOwn(value, key)) fail(errors, 'SCHEMA_REQUIRED', `${path}.${key}`, '缺少必填参数');
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false && !hasOwn(properties, key)) {
        fail(errors, 'SCHEMA_EXTRA', `${path}.${key}`, '参数 Schema 不允许额外字段');
        continue;
      }
      if (hasOwn(properties, key)) validateSchemaValue(item, properties[key], `${path}.${key}`, errors);
    }
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) {
      fail(errors, 'SCHEMA_MAX_PROPERTIES', path, '参数数量超限');
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      fail(errors, 'SCHEMA_MIN_PROPERTIES', path, '参数数量不足');
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      fail(errors, 'SCHEMA_MIN_ITEMS', path, '数组项不足');
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      fail(errors, 'SCHEMA_MAX_ITEMS', path, '数组项超限');
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) fail(errors, 'SCHEMA_UNIQUE_ITEMS', path, '数组项必须唯一');
        seen.add(key);
      }
    }
    if (hasOwn(schema, 'items')) {
      value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}[${index}]`, errors));
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(errors, 'SCHEMA_MIN_LENGTH', path, '字符串过短');
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      fail(errors, 'SCHEMA_MAX_LENGTH', path, '字符串过长');
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      fail(errors, 'SCHEMA_MINIMUM', path, '数值低于下限');
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      fail(errors, 'SCHEMA_MAXIMUM', path, '数值超过上限');
    }
  }
}
