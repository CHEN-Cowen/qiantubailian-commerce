/**
 * E04 SKU 防串图与包含物核对：三层检查、人工复核语义与按 SKU 导出计划（纯函数，不含 IO）。
 *
 * 业务规则（MASTER-PROMPT 第 5 节 / MODULE-PROMPTS E04）：
 * 1. 三层分开：
 *    - ownership（确定归属）：图/素材是否属于正确商品/SKU；确定错配是 blocker；
 *    - structure（结构内容）：文字层引用的颜色/规格/数量/尺寸单位/包含物与确认档案是否冲突；
 *      确定矛盾是 blocker；
 *    - visual（视觉候选）：OCR/视觉缺失或不可读时保持未知（review），不把推测当硬结论。
 * 2. 人工复核绑定图片版本、事实版本、操作者、理由与证据；复核只作用于被绑定版本，
 *    新版本必须重核。「满意/保留」不能解除 blocker；归属 blocker 只能走有依据的
 *    更正归属（reassign）或产生新版本，删除关联不解除阻断。
 * 3. 按 SKU 导出：只含生效归属该 SKU 的当前选用版本；排除失效、未通过、有未解除
 *    硬阻断、无权益的版本；归属不明的版本单列（OWNERSHIP_UNKNOWN），不混入任何 SKU。
 */
import { ApiError } from './errors.mjs';
import { contentHash } from './domain.mjs';
import { normalizeQuantity } from './sku.mjs';

export const CHECK_LAYERS = Object.freeze(['ownership', 'structure', 'visual']);
export const ISSUE_SEVERITIES = Object.freeze(['blocker', 'review']);
export const ISSUE_STATUSES = Object.freeze(['open', 'resolved']);
export const RESOLVE_ACTIONS = Object.freeze(['confirm', 'reassign']);
// 复核时条件已不存在（记录已修正）的自动收口动作；归属 blocker 永不自动收口
export const AUTO_CLEAR_ACTION = 'recheck_clear';

/** 数量类事实判定：与 E03 change.mjs 同语义（计数单位或字段名含数量语义）。 */
const QUANTITY_KEY_PATTERN = /数量|件数|个数|支数|片数|粒数|颗数|枚数|套装|件装|净含量|含量|规格|装量/;
/** 包含物条目与数量类事实的名称对齐后缀：fact「瓶装数量」可命中 contents item「瓶装」。 */
const QUANTITY_NAME_SUFFIXES = ['数量', '件数', '个数', '支数', '片数', '粒数', '颗数', '枚数', '净含量', '含量', '装量'];

const TERMINAL_RUN_STATES = new Set(['completed', 'limit_reached', 'failed', 'cancelled', 'needs_attention']);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeQuietly(quantity, unit) {
  try {
    return normalizeQuantity(quantity, unit);
  } catch {
    return null; // 表外单位/非法数值：不能据此判定，按未知处理（不伪造结论）
  }
}

function isQuantityFact(fact) {
  if (!fact) return false;
  const normalized = normalizeQuietly(1, fact.unit);
  if (normalized) return String(normalized.dimension).startsWith('count:');
  return QUANTITY_KEY_PATTERN.test(String(fact.key ?? ''));
}

/** 数量类 fact key 与包含物 item 名称对齐：相等，或剥掉数量后缀后相等。 */
function contentItemMatchesFactKey(itemName, factKey) {
  const item = String(itemName ?? '').trim();
  const key = String(factKey ?? '').trim();
  if (!item || !key) return false;
  if (item === key) return true;
  for (const suffix of QUANTITY_NAME_SUFFIXES) {
    if (key.endsWith(suffix) && key.slice(0, -suffix.length) === item) return true;
    if (item.endsWith(suffix) && item.slice(0, -suffix.length) === key) return true;
  }
  return false;
}

function issue(layer, code, severity, message, evidence = {}) {
  return { layer, code, severity, message, evidence };
}

/** 问题指纹：同版本同层同代码同对象的重复核对不重复开立。 */
export function issueFingerprint(draft) {
  return contentHash({
    layer: draft.layer,
    code: draft.code,
    refs: {
      fact: draft.evidence?.fact_key ?? null,
      asset: draft.evidence?.asset_id ?? null,
      found_skus: draft.evidence?.found_sku_ids ?? null,
      token: draft.evidence?.ocr_token ?? null,
    },
  });
}

// ---------- 第一层：确定归属 ----------

/**
 * 依赖 sku 条目解析到当前档案的 sku id：id 直接命中优先；E01 档案更新会重生成 id，
 * 旧 id 失效后按条目留痕的商家编号（code）回落映射到同编号 SKU。
 * 都解析不出（旧数据无 code 且档案已更新）返回 null——不算有效归属证据，不伪造错配。
 */
function resolveSkuEntryId(entry, skuProfile) {
  const skus = skuProfile?.skus ?? [];
  if (skus.some(sku => sku.id === entry?.ref)) return entry.ref;
  const code = String(entry?.code ?? '').toLowerCase();
  if (!code) return null;
  return skus.find(sku => String(sku.sku_code ?? '').toLowerCase() === code)?.id ?? null;
}

function evaluateOwnership({ run, version, dependencyRecord, skuProfile, truth, project, assetsById, priorIssues = [] }) {
  // 单规格未建档项目没有可串的对象：归属层不适用（derived 视图不是已确认档案）
  if (!skuProfile || !Array.isArray(skuProfile.skus) || skuProfile.skus.length === 0) return [];
  const issues = [];
  const skuCode = String(truth?.sku ?? project?.sku ?? '').toLowerCase();
  const expectedSku = skuProfile.skus.find(sku =>
    String(sku.sku_code ?? '').toLowerCase() === skuCode) ?? null;

  const skuEntries = (dependencyRecord?.entries ?? []).filter(entry => entry.kind === 'sku');
  // 认领集只计能解析到当前档案的条目；解析不出的（旧引用失效）按无证据处理
  const foundIds = [...new Set(skuEntries.map(entry => resolveSkuEntryId(entry, skuProfile)).filter(Boolean))];
  // 该版本若已有「更正归属」的人工裁决且裁决目标仍在当前认领集内，归属以裁决为准，
  // 不再重复开单（复核绑定版本：裁决只覆盖本版本，新版本没有该裁决会重新核对）
  const adjudicated = (priorIssues ?? []).some(item =>
    item.version_id === version.id && item.status === 'resolved'
    && item.resolution?.action === 'reassign'
    && foundIds.includes(item.resolution?.target_sku_id));
  if (foundIds.length > 0 && !adjudicated) {
    // 确定错配：认领集中出现预期以外的已知 SKU（如人工关联把别的 SKU 挂了进来），
    // 或预期 SKU 完全不在认领集内
    const wrongIds = expectedSku ? foundIds.filter(id => id !== expectedSku.id) : [];
    if (expectedSku && (wrongIds.length > 0 || !foundIds.includes(expectedSku.id))) {
      issues.push(issue('ownership', 'SKU_MISMATCH', 'blocker',
        `图片归属与任务事实不符：该图属于「${expectedSku.sku_code}」的生产任务，依赖记录却指向其他 SKU`,
        {
          expected_sku_id: expectedSku.id,
          expected_sku_code: expectedSku.sku_code,
          found_sku_ids: foundIds,
          wrong_sku_ids: wrongIds,
          entries: skuEntries.map(entry => ({ ref: entry.ref, evidence: entry.evidence, note: entry.note ?? null })),
        }));
    } else if (!expectedSku && skuProfile.skus.length > 1) {
      // 任务事实的 SKU 不在档案内且依赖也未指向任何已知 SKU：不能断定归属
      issues.push(issue('ownership', 'OWNERSHIP_UNKNOWN', 'review',
        '任务事实的商家编号不在 SKU 档案内，且没有依赖记录能确定该图归属，需人工核对',
        { truth_sku: truth?.sku ?? project?.sku ?? null, found_sku_ids: foundIds }));
    }
  } else if (foundIds.length === 0 && skuProfile.skus.length > 1) {
    // 多规格项目里没有任何有效 SKU 归属证据：保持未知，不默认为正确
    issues.push(issue('ownership', 'OWNERSHIP_UNKNOWN', 'review',
      '该版本没有可用的 SKU 归属证据（无编译依赖、无人工关联，或档案更新后旧引用已失效），多规格商品不能默认为正确归属，需人工核对',
      { truth_sku: truth?.sku ?? project?.sku ?? null }));
  }

  // SKU 专属素材串用：素材被其他 SKU 的包含物（source=asset 且 included）独占引用，
  // 却出现在本 SKU 的图片依赖里。公共 Logo/风格图与未被引用的素材可共享。
  if (expectedSku) {
    const ownerOfAsset = assetId => skuProfile.skus.filter(sku =>
      (sku.contents ?? []).some(content =>
        content.source === 'asset' && content.source_asset_id === assetId && content.included === true));
    const cross = [];
    for (const entry of (dependencyRecord?.entries ?? []).filter(item => item.kind === 'asset')) {
      const asset = assetsById?.get(entry.ref);
      if (!asset || asset.role === 'style') continue; // 风格/Logo 类素材明确共享
      const owners = ownerOfAsset(entry.ref);
      if (owners.length > 0 && !owners.some(sku => sku.id === expectedSku.id)) {
        cross.push({
          asset_id: entry.ref,
          filename: asset.filename ?? null,
          owner_sku_ids: owners.map(sku => sku.id),
          owner_sku_codes: owners.map(sku => sku.sku_code),
        });
      }
    }
    if (cross.length > 0) {
      issues.push(issue('ownership', 'ASSET_CROSS_SKU', 'blocker',
        `该图引用了其他 SKU 的专属实拍素材（${cross.map(item => item.owner_sku_codes.join('/')).join('、')}），确定串用`,
        { expected_sku_id: expectedSku.id, expected_sku_code: expectedSku.sku_code, assets: cross }));
    }
  }
  return issues;
}

// ---------- 第二层：结构内容 ----------

function evaluateStructure({ version, textLayers, truth, skuProfile, expectedSku, dependencyRecord = null }) {
  const layers = Array.isArray(textLayers) ? textLayers : null;
  if (layers === null) {
    // 交付物按规格本就没有文字层（编译依赖里没有任何 text_layer 条目）：结构层不适用，
    // 不能把「无层可核」误报成「拿不到层」
    if (dependencyRecord
      && (dependencyRecord.entries ?? []).filter(entry => entry.kind === 'text_layer').length === 0) {
      return [];
    }
    // 旧链路版本没有冻结文字层：结构核对无依据，保持未知（不伪造「无冲突」）
    return [issue('structure', 'STRUCTURE_UNKNOWN', 'review',
      '该版本没有冻结文字层记录，无法核对图上文字与确认档案是否一致，需人工核对',
      { version_id: version.id })];
  }
  const issues = [];
  const factKeys = [...new Set(layers
    .filter(layer => layer?.source === 'fact' && layer?.fact_key)
    .map(layer => String(layer.fact_key)))];
  const facts = new Map((truth?.facts ?? []).map(fact => [fact.key, fact]));
  const contents = expectedSku?.contents ?? [];
  const attributes = expectedSku?.attributes ?? [];

  for (const factKey of factKeys) {
    const fact = facts.get(factKey) ?? null;
    if (!fact) {
      issues.push(issue('structure', 'FACT_REMOVED', 'blocker',
        `图上文字引用的商品事实「${factKey}」在当前确认事实中已不存在，必须更正或撤下该图`,
        { fact_key: factKey }));
      continue;
    }
    // 数量/包含物冲突：图上展示的数量类事实与确认档案的同条目包含物归一比对
    if (isQuantityFact(fact)) {
      const content = contents.find(item => contentItemMatchesFactKey(item.item, factKey)) ?? null;
      if (content) {
        const factNorm = normalizeQuietly(Number(fact.value), fact.unit);
        const contentNorm = normalizeQuietly(content.quantity, content.unit);
        if (factNorm && contentNorm) {
          if (factNorm.dimension !== contentNorm.dimension) {
            issues.push(issue('structure', 'UNIT_CONFLICT', 'blocker',
              `图上「${factKey}」的单位（${fact.unit ?? '无'}）与档案包含物「${content.item}」的单位（${content.unit}）维度不同，确定矛盾`,
              {
                fact_key: factKey, fact: { value: fact.value, unit: fact.unit ?? null },
                content: { item: content.item, quantity: content.quantity, unit: content.unit },
              }));
          } else if (Math.abs(factNorm.value - contentNorm.value) > 1e-9) {
            issues.push(issue('structure', 'QUANTITY_CONFLICT', 'blocker',
              `图上「${factKey}」为 ${fact.value}${fact.unit ?? ''}，与档案包含物「${content.item}」${content.quantity}${content.unit} 不一致，确定矛盾`,
              {
                fact_key: factKey, fact: { value: fact.value, unit: fact.unit ?? null },
                content: { item: content.item, quantity: content.quantity, unit: content.unit },
              }));
          }
        }
      }
    }
    // 规格/颜色标签冲突：SKU 差异属性与图上展示的同名字事实值不一致
    const attribute = attributes.find(item => String(item.key) === factKey) ?? null;
    if (attribute) {
      const attrValue = String(attribute.value ?? '').trim();
      const factValue = String(fact.value ?? '').trim();
      let conflict = attrValue !== factValue;
      // 两侧都带单位时用归一化数值比对（如 500ml≡0.5L 不算冲突）
      if (conflict && attribute.unit && fact.unit) {
        const left = normalizeQuietly(Number(attribute.value), attribute.unit);
        const right = normalizeQuietly(Number(fact.value), fact.unit);
        if (left && right) conflict = !(left.dimension === right.dimension && Math.abs(left.value - right.value) < 1e-9);
      }
      if (conflict) {
        issues.push(issue('structure', 'SPEC_CONFLICT', 'blocker',
          `图上「${factKey}」为「${factValue}${fact.unit ?? ''}」，与 SKU「${expectedSku.sku_code}」差异属性「${attrValue}${attribute.unit ?? ''}」矛盾`,
          {
            fact_key: factKey, sku_code: expectedSku.sku_code,
            fact: { value: fact.value, unit: fact.unit ?? null },
            attribute: { key: attribute.key, value: attribute.value, unit: attribute.unit ?? null },
          }));
      }
    }
  }
  return issues;
}

// ---------- 第三层：视觉候选 ----------

const OCR_QUANTITY_TOKEN = /(\d+(?:\.\d+)?)\s*(毫升|升|毫克|克|千克|公斤|个|件|条|包|瓶|盒|套|罐|支|片|张|袋|箱|ml|l|g|kg|mg|mm|cm|m)/gi;

function evaluateVisual({ version, textLayers, truth, ocr }) {
  // ocr === null：未配置视觉/OCR 服务——保持未知，绝不伪造「已核对」
  if (ocr === null || ocr === undefined) {
    return [issue('visual', 'VISUAL_UNAVAILABLE', 'review',
      '未配置视觉/OCR 服务，画面中的颜色、物件与数量表达保持未知，需人工核对',
      { reason: 'OCR_NOT_CONFIGURED' })];
  }
  if (ocr.status !== 'ok') {
    return [issue('visual', 'VISUAL_UNAVAILABLE', 'review',
      '视觉/OCR 识别失败或不可用，画面内容保持未知，需人工核对',
      { reason: ocr.reason ?? 'OCR_ERROR' })];
  }
  const lines = (ocr.lines ?? []).map(line => String(line?.text ?? '')).filter(Boolean);
  const tokens = [];
  for (const line of lines) {
    for (const match of line.matchAll(OCR_QUANTITY_TOKEN)) {
      const normalized = normalizeQuietly(Number(match[1]), match[2]);
      if (normalized) tokens.push({ raw: match[0], line, ...normalized });
    }
  }
  // 只对「图上文字层展示了数量类事实」的版本做候选比对；疑点必须有 OCR 证据，不推测
  const layers = Array.isArray(textLayers) ? textLayers : [];
  const factKeys = [...new Set(layers
    .filter(layer => layer?.source === 'fact' && layer?.fact_key)
    .map(layer => String(layer.fact_key)))];
  const facts = new Map((truth?.facts ?? []).map(fact => [fact.key, fact]));
  const issues = [];
  for (const factKey of factKeys) {
    const fact = facts.get(factKey);
    if (!fact || !isQuantityFact(fact)) continue;
    const factNorm = normalizeQuietly(Number(fact.value), fact.unit);
    if (!factNorm) continue;
    const suspect = tokens.find(token =>
      token.dimension === factNorm.dimension && Math.abs(token.value - factNorm.value) > 1e-9) ?? null;
    if (suspect) {
      issues.push(issue('visual', 'VISUAL_QUANTITY_SUSPECT', 'review',
        `OCR 在画面中识别到「${suspect.raw}」，与确认事实「${factKey}=${fact.value}${fact.unit ?? ''}」不一致；识别是候选证据，需人工核对画面`,
        {
          fact_key: factKey, fact: { value: fact.value, unit: fact.unit ?? null },
          ocr_token: suspect.raw, ocr_line: suspect.line,
        }));
    }
  }
  return issues;
}

/**
 * 对一个「当前选用版本」执行三层核对。返回问题草稿数组（不含落库字段）。
 * @param textLayers 版本冻结文字层；调用方在版本无冻结层时传编译计划层或 null
 * @param ocr null=未配置；{status:'ok',lines[]}|{status:'error',reason}
 * @param priorIssues 该版本已存在的核对问题（用于识别已裁决的更正归属，避免重复开单）
 */
export function evaluateSkuChecks({
  run, version, dependencyRecord = null, skuProfile = null, truth = null,
  project = null, assetsById = null, textLayers = undefined, ocr = null, priorIssues = [],
} = {}) {
  if (!run || !version) throw new ApiError(500, 'INTERNAL_ERROR', '缺少任务或版本上下文');
  const layers = textLayers === undefined ? version.text_layers : textLayers;
  const skuCode = String(truth?.sku ?? project?.sku ?? '').toLowerCase();
  const expectedSku = (skuProfile?.skus ?? []).find(sku =>
    String(sku.sku_code ?? '').toLowerCase() === skuCode) ?? null;
  return [
    ...evaluateOwnership({ run, version, dependencyRecord, skuProfile, truth, project, assetsById, priorIssues }),
    ...evaluateStructure({ version, textLayers: layers, truth, skuProfile, expectedSku, dependencyRecord }),
    ...evaluateVisual({ version, textLayers: layers, truth, ocr }),
  ].map(draft => ({ ...draft, fingerprint: issueFingerprint(draft) }));
}

/**
 * 版本的生效 SKU 归属：人工更正归属（reassign 复核）优先；其次依赖记录的 sku 条目——
 * 人工关联（manual）是商家的显式断言，优先于系统编译（deterministic），条目按 id 优先、
 * 商家编号回落解析到当前档案；最后回落任务事实的商家编号命中档案。
 * 都无效时返回 null（归属不明，导出排除并单列）。
 */
export function effectiveSkuOf({ version, dependencyRecord = null, issues = [], skuProfile = null, truth = null, project = null } = {}) {
  const reassigns = (issues ?? [])
    .filter(item => item.version_id === version?.id && item.status === 'resolved'
      && item.resolution?.action === 'reassign' && item.resolution?.target_sku_id)
    .sort((left, right) => String(right.resolution.at ?? '').localeCompare(String(left.resolution.at ?? '')));
  for (const item of reassigns) {
    const target = item.resolution.target_sku_id;
    if ((skuProfile?.skus ?? []).some(sku => sku.id === target)) return target;
  }
  const skuEntries = (dependencyRecord?.entries ?? []).filter(entry => entry.kind === 'sku');
  const ordered = [
    ...skuEntries.filter(entry => entry.evidence === 'manual'),
    ...skuEntries.filter(entry => entry.evidence !== 'manual'),
  ];
  for (const entry of ordered) {
    const resolved = resolveSkuEntryId(entry, skuProfile);
    if (resolved) return resolved;
  }
  const skuCode = String(truth?.sku ?? project?.sku ?? '').toLowerCase();
  const hit = (skuProfile?.skus ?? []).find(sku => String(sku.sku_code ?? '').toLowerCase() === skuCode);
  return hit?.id ?? null;
}

/** 人工复核输入校验：复核/更正归属都必须有依据；blocker 不能用「确认无误」解除。 */
export function validateResolveInput(body, issue, skuProfile) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!RESOLVE_ACTIONS.includes(action)) {
    throw new ApiError(422, 'INVALID_FIELD', `action 必须为 ${RESOLVE_ACTIONS.join(' / ')}`);
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 300) {
    throw new ApiError(422, 'INVALID_FIELD', 'reason 必填且不超过 300 字符：人工复核必须留下依据');
  }
  if (!issue || issue.status !== 'open') {
    throw new ApiError(409, 'ISSUE_ALREADY_RESOLVED', '该问题已处理；如需重新核对请再次发起 SKU 核对');
  }
  if (action === 'confirm' && issue.severity === 'blocker') {
    // 满意/保留不能覆盖确定错误：硬阻断只能靠更正归属或产生新版本解除
    throw new ApiError(409, 'ISSUE_HARD_BLOCK',
      '这是确定错配/冲突（阻断级），不能用人工确认放行；请更正归属、修正文字/档案，或重做该图');
  }
  if (action === 'reassign') {
    if (issue.layer !== 'ownership') {
      throw new ApiError(422, 'REASSIGN_NOT_APPLICABLE', '更正归属只适用于归属层问题；结构/视觉问题请修正内容或核对画面');
    }
    const target = typeof body.target_sku_id === 'string' ? body.target_sku_id.trim() : '';
    if (!target) throw new ApiError(422, 'INVALID_FIELD', '更正归属必须指明 target_sku_id（目标 SKU）');
    if (!(skuProfile?.skus ?? []).some(sku => sku.id === target)) {
      throw new ApiError(422, 'INVALID_FIELD', 'target_sku_id 不在该项目当前 SKU 档案内');
    }
    return { action, reason, target_sku_id: target };
  }
  return { action, reason };
}

// ---------- 按 SKU 导出计划 ----------

const safePathPart = value => String(value ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'sku';

/**
 * 按 SKU 导出计划（纯函数）。
 * included：生效归属该 SKU、当前选用、报告可发布且有效、无未解除阻断、权益已结算的版本；
 * excluded：归属该 SKU 但被闸口排除的版本（附原因），以及归属不明的版本（OWNERSHIP_UNKNOWN）。
 * 归属其他 SKU 的版本直接不进入结果（不混入，也不罗列打扰）。
 */
export function planSkuExport({
  project, skuId, skuProfile, runs = [], dependencies = [], issues = [],
  reports = {}, validities = {},
} = {}) {
  const sku = (skuProfile?.skus ?? []).find(item => item.id === skuId) ?? null;
  if (!sku) {
    return { ok: false, code: 'SKU_NOT_FOUND', message: '指定的 SKU 不在当前档案内', included: [], excluded: [] };
  }
  const depOf = (runId, deliverableId, versionId) => (dependencies ?? []).find(item =>
    item.run_id === runId && item.deliverable_id === deliverableId && item.version_id === versionId) ?? null;
  const issuesOf = versionId => (issues ?? []).filter(item => item.version_id === versionId);

  const included = [];
  const excluded = [];
  for (const run of runs ?? []) {
    if (!TERMINAL_RUN_STATES.has(run?.status)) continue; // 执行中的任务没有可导出版本
    for (const deliverable of run.deliverables ?? []) {
      const version = (run.versions ?? []).find(item =>
        item.deliverable_id === deliverable.deliverable_id && item.active === true) ?? null;
      if (!version) continue; // 没有产出物的交付物不属于任何 SKU 的导出内容
      const base = {
        run_id: run.id, deliverable_id: deliverable.deliverable_id,
        deliverable_label: deliverable.label ?? deliverable.deliverable_id,
        version_id: version.id, number: version.number ?? null,
      };
      const dependencyRecord = depOf(run.id, deliverable.deliverable_id, version.id);
      const owner = effectiveSkuOf({
        version, dependencyRecord, issues: issuesOf(version.id),
        skuProfile, truth: null, project,
      });
      if (owner !== null && owner !== skuId) continue; // 属于其他 SKU：不混入、不罗列
      if (owner === null) {
        excluded.push({ ...base, reason: 'OWNERSHIP_UNKNOWN', message: '归属不明：需先完成归属核对或更正归属' });
        continue;
      }
      const report = reports[version.report_id] ?? null;
      if (!report) {
        excluded.push({ ...base, reason: 'REPORT_MISSING', message: '该版本没有质量报告' });
        continue;
      }
      const validity = validities[version.report_id] ?? { validity: 'unknown' };
      if (validity.validity !== 'current') {
        excluded.push({ ...base, reason: 'STALE', message: '检查报告已失效，需重新检查', validity_reasons: validity.reasons ?? [] });
        continue;
      }
      const decision = report.decision ?? report.machine_decision ?? 'unknown';
      if (decision !== 'publishable') {
        excluded.push({ ...base, reason: decision === 'blocked' ? 'BLOCKED' : 'NEEDS_REVIEW', message: '该版本未通过质量检查', report_id: report.id });
        continue;
      }
      const openBlockers = issuesOf(version.id).filter(item => item.status === 'open' && item.severity === 'blocker');
      if (openBlockers.length > 0) {
        excluded.push({
          ...base, reason: 'OPEN_BLOCKER',
          message: `存在 ${openBlockers.length} 项未解除的阻断级问题（${openBlockers.map(item => item.code).join('、')}），「满意/保留」不能覆盖`,
          issue_codes: openBlockers.map(item => item.code),
        });
        continue;
      }
      if (run.billing_mode === 'finished_image' && deliverable.entitlement_settled !== 'capture') {
        excluded.push({ ...base, reason: 'ENTITLEMENT_NOT_SETTLED', message: '成品额度尚未结算，未付费版本不能正式导出' });
        continue;
      }
      included.push({
        ...base,
        path: `images/${safePathPart(sku.sku_code)}/${deliverable.deliverable_id}.${version.format ?? 'png'}`,
        hash: version.hash, format: version.format ?? 'png',
        report_id: version.report_id ?? null,
      });
    }
  }
  if (included.length === 0) {
    return {
      ok: false, code: 'SKU_EXPORT_EMPTY',
      message: `SKU「${sku.sku_code}」没有可导出的版本（归属该 SKU 且通过全部闸口）`,
      sku: { id: sku.id, sku_code: sku.sku_code, label: sku.label },
      included, excluded,
    };
  }
  return {
    ok: true,
    code: excluded.length > 0 ? 'SKU_EXPORT_PARTIAL' : 'SKU_EXPORT_COMPLETE',
    message: excluded.length > 0
      ? `按 SKU「${sku.sku_code}」导出 ${included.length} 项；${excluded.length} 项被闸口排除（见清单）`
      : `按 SKU「${sku.sku_code}」导出 ${included.length} 项`,
    sku: { id: sku.id, sku_code: sku.sku_code, label: sku.label },
    included, excluded,
  };
}

/** 问题呈现：不改动存储结构，扁平化输出给前端/审计。 */
export function presentCheckIssue(issue) {
  if (!isPlainObject(issue)) return null;
  return {
    id: issue.id,
    project_id: issue.project_id,
    run_id: issue.run_id,
    deliverable_id: issue.deliverable_id,
    version_id: issue.version_id,
    layer: issue.layer,
    code: issue.code,
    severity: issue.severity,
    status: issue.status,
    message: issue.message,
    evidence: issue.evidence ?? {},
    truth_version: issue.truth_version ?? null,
    sku_profile_version: issue.sku_profile_version ?? null,
    created_by: issue.created_by,
    created_at: issue.created_at,
    resolution: issue.resolution ?? null,
    // 展示辅助（路由层填充）：deliverable_label / version_number / version_active
    deliverable_label: issue.deliverable_label ?? null,
    version_number: issue.version_number ?? null,
    version_active: issue.version_active ?? null,
  };
}
