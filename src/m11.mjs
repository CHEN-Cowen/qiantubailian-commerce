/**
 * M11 批量、团队与品牌配方。
 *
 * 边界（PRD BAT-01—BAT-04、TEAM-01—TEAM-03、RCP-01—RCP-03）：
 * 1. 导入必须先映射字段再逐行预览；非法行、重复 SKU、跨租户重名都要单独报错，
 *    不因为一行出错就静默丢弃整批，也不在没有确认预算时开始生产。
 * 2. 单 SKU 失败必须隔离在自身：批量继续推进，失败原因逐项列出，不用抽检替代硬检查。
 * 3. 成员权限只按角色矩阵判定；未登记的租户默认当前操作者为 owner，避免历史流程被一刀切断。
 * 4. 配方（品牌配方）私有归创建者，共享需审批；共享配方出现新审批版本后，
 *    引用旧版本的记录必须失效，不能继续以旧版本结果交付。
 *
 * 本文件只做纯计算与规则判定，I/O 与任务编排在 API/Jobs 层。
 */
import { contentHash } from './domain.mjs';

export const M11_VERSION = 'm11.1';
export const BATCH_SCHEMA_VERSION = 1;
export const IMPORT_MAX_ROWS = 200;
export const RECIPE_SCHEMA_VERSION = 1;

/** 导入可映射字段。事实列必须显式声明为 fact:<key>，避免把任意表头当成事实。 */
export const IMPORT_TARGETS = Object.freeze([
  { key: 'sku', required: true, label: 'SKU' },
  { key: 'name', required: true, label: '商品名称' },
  { key: 'category', required: true, label: '类目' },
  { key: 'platform', required: false, label: '平台' },
  { key: 'template_id', required: false, label: '模板' },
  { key: 'brand_kit_id', required: false, label: '品牌套件' },
]);
const REQUIRED_TARGETS = IMPORT_TARGETS.filter(item => item.required).map(item => item.key);

export const ROLES = Object.freeze(['owner', 'editor', 'reviewer', 'viewer']);

export const PERMISSIONS = Object.freeze({
  owner: Object.freeze([
    'batch:read', 'batch:create', 'batch:preview', 'batch:start', 'batch:export',
    'recipe:read', 'recipe:write', 'recipe:approve', 'member:manage', 'project:read',
    // M12：结果回流、效果导入、套餐与备份
    'feedback:read', 'feedback:write', 'outcome:read', 'outcome:write',
    'billing:read', 'billing:manage', 'backup:manage', 'metrics:read',
  ]),
  editor: Object.freeze([
    'batch:read', 'batch:create', 'batch:preview', 'batch:start', 'batch:export',
    'recipe:read', 'recipe:write', 'project:read',
    'feedback:read', 'feedback:write', 'outcome:read', 'outcome:write', 'billing:read', 'metrics:read',
  ]),
  reviewer: Object.freeze([
    'batch:read', 'recipe:read', 'project:read',
    'feedback:read', 'feedback:write', 'outcome:read', 'billing:read', 'metrics:read',
  ]),
  viewer: Object.freeze([
    'batch:read', 'recipe:read', 'project:read',
    'feedback:read', 'outcome:read', 'billing:read', 'metrics:read',
  ]),
});

export const BATCH_ITEM_STATES = Object.freeze([
  'imported', 'invalid', 'blocked', 'ready', 'running', 'completed', 'failed', 'cancelled',
]);

const normalizeText = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const reason = (code, message, evidence = null) => ({ code, message, evidence });

// ---------- 团队成员与权限 ----------

/**
 * 解析操作者角色。租户没有任何成员记录时，当前操作者视为 owner：
 * 这是历史租户与首次使用的引导路径，一旦登记过成员就不再兜底。
 */
export function resolveRole({ members = [], actorId = '' } = {}) {
  const rows = Array.isArray(members) ? members : [];
  if (rows.length === 0) return { role: 'owner', bootstrap: true };
  const found = rows.find(item => item.actor_id === actorId) ?? null;
  if (!found) return { role: null, bootstrap: false };
  if (!ROLES.includes(found.role)) return { role: null, bootstrap: false, reason: 'MEMBER_ROLE_INVALID' };
  return { role: found.role, bootstrap: false, member: found };
}

export function can(role, action) {
  if (!role || !Object.hasOwn(PERMISSIONS, role)) return false;
  return PERMISSIONS[role].includes(action);
}

export function describePermissions(role) {
  return { role: role ?? null, permissions: role && PERMISSIONS[role] ? [...PERMISSIONS[role]] : [] };
}

/** 成员变更只允许 owner；不能移除最后一个 owner。 */
export function planMemberChange({ members = [], targetActorId = '', nextRole = null, actorRole = null } = {}) {
  if (actorRole !== 'owner') return { ok: false, code: 'MEMBER_MANAGE_FORBIDDEN', message: '只有 owner 可以管理成员' };
  if (nextRole !== null && !ROLES.includes(nextRole)) {
    return { ok: false, code: 'MEMBER_ROLE_INVALID', message: `角色必须是 ${ROLES.join(' / ')} 之一` };
  }
  const rows = Array.isArray(members) ? members : [];
  const target = rows.find(item => item.actor_id === targetActorId) ?? null;
  if (nextRole === null) {
    if (!target) return { ok: false, code: 'MEMBER_NOT_FOUND', message: '成员不存在' };
    const owners = rows.filter(item => item.role === 'owner');
    if (target.role === 'owner' && owners.length <= 1) {
      return { ok: false, code: 'MEMBER_LAST_OWNER', message: '不能移除最后一个 owner' };
    }
    return { ok: true, code: null, message: '', action: 'remove' };
  }
  return { ok: true, code: null, message: '', action: target ? 'update' : 'add' };
}

// ---------- SKU 导入 ----------

const ALLOWED_TARGETS = new Set([...IMPORT_TARGETS.map(item => item.key), 'facts']);

/**
 * 校验字段映射。facts 用 [{key, column}] 声明，列名必须在表头里。
 * 未声明的目标字段不会从"同名表头"猜出来——猜错比报错代价更高。
 */
export function validateMapping({ columns = [], mapping = {} } = {}) {
  const header = Array.isArray(columns) ? columns.map(normalizeText) : [];
  const issues = [];
  if (header.length === 0) issues.push(reason('IMPORT_COLUMNS_EMPTY', '表头为空'));
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { ok: false, issues: [...issues, reason('IMPORT_MAPPING_INVALID', 'mapping 必须是对象')], mapping: {}, factColumns: [] };
  }
  const normalized = {};
  const factColumns = [];
  const usedColumns = new Set();
  for (const [target, rawColumn] of Object.entries(mapping)) {
    if (target === 'facts') continue;
    if (!ALLOWED_TARGETS.has(target)) {
      issues.push(reason('IMPORT_TARGET_UNKNOWN', `不支持的映射字段「${target}」`));
      continue;
    }
    const column = normalizeText(rawColumn);
    if (!column) {
      issues.push(reason('IMPORT_COLUMN_EMPTY', `字段「${target}」未指定列名`));
      continue;
    }
    if (!header.includes(column)) {
      issues.push(reason('IMPORT_COLUMN_MISSING', `字段「${target}」映射的列「${column}」不在表头中`));
      continue;
    }
    if (usedColumns.has(column)) {
      issues.push(reason('IMPORT_COLUMN_REUSED', `列「${column}」被多个字段重复使用`));
      continue;
    }
    usedColumns.add(column);
    normalized[target] = column;
  }
  for (const key of REQUIRED_TARGETS) {
    if (!normalized[key]) issues.push(reason('IMPORT_REQUIRED_TARGET', `缺少必填映射「${key}」`));
  }
  const facts = Array.isArray(mapping.facts) ? mapping.facts : [];
  for (const item of facts) {
    const key2 = normalizeText(item?.key);
    const column = normalizeText(item?.column);
    if (!key2) { issues.push(reason('IMPORT_FACT_KEY_EMPTY', '事实映射缺少 key')); continue; }
    if (!column || !header.includes(column)) {
      issues.push(reason('IMPORT_FACT_COLUMN_MISSING', `事实「${key2}」映射的列「${column || '(空)'}」不在表头中`));
      continue;
    }
    factColumns.push({ key: key2, column });
  }
  return { ok: issues.length === 0, issues, mapping: normalized, factColumns };
}

/**
 * 逐行预览。行内错误只影响该行；重复 SKU（批内或已有项目）整行 invalid。
 * 不创建任何项目、不产生费用，调用方确认后才会落库。
 */
export function previewImportRows({
  rows = [], columns = [], mapping = {}, existingSkus = [], templateIds = null, brandKitIds = null,
} = {}) {
  const mappingCheck = validateMapping({ columns, mapping });
  if (!mappingCheck.ok) {
    return {
      ok: false, mapping: mappingCheck.mapping, issues: mappingCheck.issues,
      rows: [], summary: { total: 0, valid: 0, invalid: 0, duplicate_sku: 0 },
    };
  }
  const list = Array.isArray(rows) ? rows.slice(0, IMPORT_MAX_ROWS) : [];
  const overflow = Array.isArray(rows) && rows.length > IMPORT_MAX_ROWS;
  const existing = new Set((existingSkus ?? []).map(item => normalizeText(item).toUpperCase()));
  const seen = new Map();
  const output = [];
  for (const [index, raw] of list.entries()) {
    const errors = [];
    const warnings = [];
    const get = target => {
      const column = mappingCheck.mapping[target];
      return column ? normalizeText(raw?.[column]) : '';
    };
    const sku = get('sku');
    const name = get('name');
    const category = get('category');
    const platform = get('platform');
    const templateId = get('template_id');
    const brandKitId = get('brand_kit_id');
    const facts = [];
    for (const item of mappingCheck.factColumns) {
      const value = normalizeText(raw?.[item.column]);
      if (value) facts.push({ key: item.key, value });
    }

    if (!sku) errors.push(reason('IMPORT_SKU_EMPTY', 'SKU 不能为空'));
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sku)) errors.push(reason('IMPORT_SKU_INVALID', `SKU「${sku}」格式不合法`));
    if (!name) errors.push(reason('IMPORT_NAME_EMPTY', '商品名称不能为空'));
    if (!category) errors.push(reason('IMPORT_CATEGORY_EMPTY', '类目不能为空'));
    if (templateId && Array.isArray(templateIds) && !templateIds.includes(templateId)) {
      errors.push(reason('IMPORT_TEMPLATE_UNKNOWN', `模板「${templateId}」不存在`));
    }
    if (brandKitId && Array.isArray(brandKitIds) && !brandKitIds.includes(brandKitId)) {
      errors.push(reason('IMPORT_BRAND_KIT_UNKNOWN', `品牌套件「${brandKitId}」不存在`));
    }

    const skuKey = sku.toUpperCase();
    let duplicate = false;
    if (skuKey) {
      if (existing.has(skuKey)) {
        duplicate = true;
        errors.push(reason('IMPORT_SKU_EXISTS', `SKU「${sku}」已存在于当前租户`));
      } else if (seen.has(skuKey)) {
        duplicate = true;
        errors.push(reason('IMPORT_SKU_DUPLICATE_ROW', `SKU「${sku}」与第 ${seen.get(skuKey) + 1} 行重复`));
      } else {
        seen.set(skuKey, index);
      }
    }
    if (facts.length === 0) warnings.push(reason('IMPORT_NO_FACTS', '未导入事实，导入后需要人工确认商品事实'));

    output.push({
      index,
      sku: sku || null,
      name: name || null,
      category: category || null,
      platform: platform || null,
      template_id: templateId || null,
      brand_kit_id: brandKitId || null,
      facts,
      valid: errors.length === 0,
      duplicate_sku: duplicate,
      errors,
      warnings,
    });
  }
  const valid = output.filter(item => item.valid);
  return {
    ok: valid.length > 0,
    mapping: mappingCheck.mapping,
    issues: overflow ? [reason('IMPORT_ROW_LIMIT', `一次最多导入 ${IMPORT_MAX_ROWS} 行，超出部分已忽略`)] : [],
    rows: output,
    summary: {
      total: output.length,
      valid: valid.length,
      invalid: output.length - valid.length,
      duplicate_sku: output.filter(item => item.duplicate_sku).length,
    },
  };
}

// ---------- 批量计划与预算 ----------

/**
 * 批量计划。items 由 API 层补齐 status / quote / blockers 后传入。
 * 已阻断项不进入预算；总预算按"可能的最大消耗"计算，必须显式确认后才允许开始。
 */
export function planBatch({ items = [], availableCredits = 0, confirmed = false } = {}) {
  const rows = (Array.isArray(items) ? items : []).map(item => {
    const blockers = Array.isArray(item.blockers) ? item.blockers : [];
    const ready = item.status === 'ready' && blockers.length === 0;
    return {
      item_id: item.item_id,
      sku: item.sku ?? null,
      status: ready ? 'ready' : 'blocked',
      decision: ready ? 'ready' : 'blocked',
      blockers,
      estimated_credits: item.estimated_credits ?? 0,
      max_credits: item.max_credits ?? 0,
    };
  });
  const ready = rows.filter(item => item.decision === 'ready');
  const estimated = ready.reduce((sum, item) => sum + (item.estimated_credits || 0), 0);
  const max = ready.reduce((sum, item) => sum + (item.max_credits || 0), 0);
  const overBudget = max > availableCredits;
  const canStart = ready.length > 0 && !overBudget && confirmed === true;
  const reasons = [];
  if (ready.length === 0) reasons.push(reason('BATCH_NO_READY_ITEM', '没有可开始的条目'));
  if (overBudget) reasons.push(reason('BATCH_BUDGET_EXCEEDED', `预计最大消耗 ${max} 超过可用额度 ${availableCredits}`));
  if (confirmed !== true) reasons.push(reason('BATCH_BUDGET_UNCONFIRMED', '开始批量前必须确认预算'));
  return {
    schema_version: BATCH_SCHEMA_VERSION,
    planner_version: M11_VERSION,
    items: rows,
    available_credits: availableCredits,
    estimated_credits: estimated,
    max_credits: max,
    over_budget: overBudget,
    confirmed: confirmed === true,
    can_start: canStart,
    reasons,
    summary: batchSummary(rows),
  };
}

export function batchSummary(items = []) {
  const counts = {};
  for (const state of BATCH_ITEM_STATES) counts[state] = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const state = item?.status ?? item?.decision ?? 'invalid';
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return {
    total: (Array.isArray(items) ? items : []).length,
    ready: (counts.ready ?? 0),
    blocked: (counts.blocked ?? 0) + (counts.invalid ?? 0),
    running: counts.running ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    cancelled: counts.cancelled ?? 0,
  };
}

/**
 * 批量导出资格：只收 completed 且报告可发布且有效的条目；
 * 失败、阻断、缺失都要逐项列出，不能因为"大部分成功"就忽略个别失败（不抽检替代硬检查）。
 */
export function planBatchExport({ items = [], scope = 'partial' } = {}) {
  const rows = Array.isArray(items) ? items : [];
  const exported = [];
  const missing = [];
  for (const item of rows) {
    if (item.status === 'completed' && item.exportable === true) {
      exported.push(item);
      continue;
    }
    missing.push({
      item_id: item.item_id,
      sku: item.sku ?? null,
      status: item.status ?? 'unknown',
      reason: item.status === 'completed' ? 'NOT_PUBLISHABLE' : String(item.status ?? 'UNKNOWN').toUpperCase(),
      detail: item.reason ?? null,
    });
  }
  if (scope === 'complete') {
    if (missing.length > 0) {
      return {
        ok: false, code: 'BATCH_EXPORT_INCOMPLETE', scope,
        message: `完整批量包要求全部条目可发布，当前仍有 ${missing.length} 项未达成`,
        included: [], missing,
      };
    }
    return { ok: true, code: 'BATCH_PACKAGE_COMPLETE', scope, message: '完整批量包：全部条目可发布', included: exported, missing: [] };
  }
  if (exported.length === 0) {
    return { ok: false, code: 'BATCH_EXPORT_EMPTY', scope, message: '没有可导出的条目', included: [], missing };
  }
  return {
    ok: true, code: 'BATCH_PACKAGE_PARTIAL', scope,
    message: `部分批量包：${exported.length} 项可导出，${missing.length} 项缺失`,
    included: exported, missing,
  };
}

// ---------- 品牌配方 ----------

export const RECIPE_SCOPES = Object.freeze(['private', 'shared']);
export const RECIPE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'superseded']);

export function validateRecipeInput(body = {}) {
  const issues = [];
  const name = normalizeText(body.name);
  if (!name) issues.push(reason('RECIPE_NAME_REQUIRED', '配方名称不能为空'));
  if (name.length > 80) issues.push(reason('RECIPE_NAME_TOO_LONG', '配方名称不能超过 80 个字符'));
  const scope = normalizeText(body.scope) || 'private';
  if (!RECIPE_SCOPES.includes(scope)) issues.push(reason('RECIPE_SCOPE_INVALID', `范围必须是 ${RECIPE_SCOPES.join(' / ')}`));
  const templateId = normalizeText(body.template_id);
  if (!templateId) issues.push(reason('RECIPE_TEMPLATE_REQUIRED', '配方必须指定模板'));
  const platform = normalizeText(body.platform);
  if (!platform) issues.push(reason('RECIPE_PLATFORM_REQUIRED', '配方必须指定平台'));
  const brandKitId = normalizeText(body.brand_kit_id);
  if (!brandKitId) issues.push(reason('RECIPE_BRAND_KIT_REQUIRED', '共享与私有配方都必须绑定品牌套件，避免跨品牌串用'));
  const copyVersion = normalizeText(body.copy_version);
  if (!copyVersion) issues.push(reason('RECIPE_COPY_VERSION_REQUIRED', '配方必须固定文案版本'));
  if (issues.length > 0) return { ok: false, issues, payload: null };
  return {
    ok: true,
    issues: [],
    payload: {
      name, scope, template_id: templateId, platform, brand_kit_id: brandKitId,
      copy_version: copyVersion,
      style_defaults: body.style_defaults && typeof body.style_defaults === 'object' && !Array.isArray(body.style_defaults)
        ? { ...body.style_defaults }
        : {},
    },
  };
}

export function recipeContentHash(payload) {
  return contentHash({
    name: payload.name,
    scope: payload.scope,
    template_id: payload.template_id,
    platform: payload.platform,
    brand_kit_id: payload.brand_kit_id,
    copy_version: payload.copy_version,
    style_defaults: payload.style_defaults ?? {},
  });
}

/**
 * 新建配方版本。私有版本由创建者自行生效（approved），共享版本必须走审批。
 * 编号由该配方已有版本数决定，内容哈希用于识别"换汤不换药"的重复提交。
 */
export function makeRecipeVersion({ recipeId, previousVersions = [], payload, actorId, at = new Date() } = {}) {
  const versions = Array.isArray(previousVersions) ? previousVersions : [];
  const hash = recipeContentHash(payload);
  const overwrite = versions.find(item => item.content_hash === hash);
  return {
    schema_version: RECIPE_SCHEMA_VERSION,
    recipe_id: recipeId ?? null,
    version: versions.length + 1,
    content_hash: hash,
    status: payload.scope === 'private' ? 'approved' : 'pending',
    approval: payload.scope === 'private'
      ? { required: false, approved_by: actorId, approved_at: new Date(at).toISOString() }
      : { required: true, approved_by: null, approved_at: null },
    superseded_at: null,
    duplicate_of_version: overwrite?.version ?? null,
    payload: { ...payload },
    created_by: actorId,
    created_at: new Date(at).toISOString(),
  };
}

/**
 * 审批共享配方。owner 才能审批；新批准的版本会让更早的 approved 版本变成 superseded，
 * 因此引用旧版本的记录必须失效（见 evaluateRecipeUseValidity）。
 */
export function applyRecipeApproval({ version, decision, actorRole, actorId, note = '', at = new Date() } = {}) {
  if (actorRole !== 'owner') {
    return { ok: false, code: 'RECIPE_APPROVE_FORBIDDEN', message: '只有 owner 可以审批共享配方' };
  }
  if (!['approve', 'reject'].includes(decision)) {
    return { ok: false, code: 'RECIPE_DECISION_INVALID', message: '审批决定只能是 approve 或 reject' };
  }
  if (!version) return { ok: false, code: 'RECIPE_VERSION_NOT_FOUND', message: '配方版本不存在' };
  if (version.status !== 'pending') {
    return { ok: false, code: 'RECIPE_NOT_PENDING', message: '只有待审批版本可以审批' };
  }
  const timestamp = new Date(at).toISOString();
  return {
    ok: true,
    code: null,
    message: '',
    version: {
      ...version,
      status: decision === 'approve' ? 'approved' : 'rejected',
      approval: {
        required: true,
        approved_by: actorId,
        approved_at: timestamp,
        decision,
        note: normalizeText(note) || null,
      },
    },
    supersede_previous_approved: decision === 'approve',
    at: timestamp,
  };
}

/** 共享配方的可见性：私有仅创建者可见，共享对同租户可见。 */
export function isRecipeVisible({ recipe, actorId } = {}) {
  if (!recipe) return false;
  if (recipe.scope === 'shared') return true;
  return recipe.created_by === actorId;
}

/**
 * 配方引用有效性。共享配方一旦有更新的 approved 版本，旧引用即 stale；
 * 私有配方被非创建者引用、审批被撤回、品牌套件不匹配都判为 invalid。
 */
export function evaluateRecipeUseValidity({ usage, recipe, versions = [], currentBrandKitId = null } = {}) {
  if (!usage || !recipe) return { validity: 'unknown', reasons: ['配方引用不存在'] };
  if (recipe.brand_kit_id && currentBrandKitId && recipe.brand_kit_id !== currentBrandKitId) {
    return { validity: 'invalid', reasons: [`配方绑定的品牌套件 ${recipe.brand_kit_id} 与当前品牌套件 ${currentBrandKitId} 不一致`] };
  }
  if (recipe.scope === 'private' && usage.actor_id !== recipe.created_by) {
    return { validity: 'invalid', reasons: ['私有配方不能跨成员引用'] };
  }
  const approved = (Array.isArray(versions) ? versions : [])
    .filter(item => item.status === 'approved')
    .sort((left, right) => right.version - left.version);
  const latest = approved[0] ?? null;
  if (!latest) return { validity: 'invalid', reasons: ['配方没有已批准版本'] };
  if (usage.recipe_version !== latest.version) {
    return {
      validity: 'stale',
      reasons: [`配方已审批到 v${latest.version}，当前引用仍是 v${usage.recipe_version}`],
      latest_version: latest.version,
    };
  }
  return { validity: 'current', reasons: [], latest_version: latest.version };
}

/** 目录生产控制台汇总：按状态与阻断原因聚合，便于运营逐项查看而不是只看总数。 */
export function summarizeCatalogConsole({ items = [] } = {}) {
  const rows = Array.isArray(items) ? items : [];
  const byReason = new Map();
  for (const item of rows) {
    for (const blocker of item.blockers ?? []) {
      const code = blocker.code ?? 'UNKNOWN';
      const entry = byReason.get(code) ?? { code, count: 0, skus: [] };
      entry.count += 1;
      if (item.sku) entry.skus.push(item.sku);
      byReason.set(code, entry);
    }
  }
  return {
    summary: batchSummary(rows),
    blockers: [...byReason.values()].sort((left, right) => right.count - left.count),
    needs_attention: rows
      .filter(item => item.status === 'blocked' || item.status === 'failed' || item.status === 'invalid')
      .map(item => ({ item_id: item.item_id, sku: item.sku, status: item.status, blockers: item.blockers ?? [] })),
  };
}
