/**
 * E02 图片依赖、版本与导出追踪：确定依赖编译（纯函数，不含 IO）。
 *
 * 依赖证据分三档（PRD 6.2）：
 * - deterministic：由系统编译文字/排版或明确引用素材产生，带来源版本快照；
 * - ocr_candidate：OCR 推测候选（带 confidence），只能提示不能断言；
 * - manual：商家人工关联，带操作者与时间。
 * 本模块只负责 deterministic 的编译；manual 由路由层校验后并入，ocr_candidate 由后续识别流程写入。
 * 编译不出依据（legacy 版本、无 spec 快照）时返回 null，由调用方决定不写记录——
 * 查询侧无记录即 unknown，绝不展示成"无需更新"。
 */

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const DEPENDENCY_KINDS = Object.freeze(['fact', 'asset', 'brand', 'sku', 'text_layer']);
export const DEPENDENCY_EVIDENCE = Object.freeze(['deterministic', 'ocr_candidate', 'manual']);

function entry(kind, ref, extra = {}) {
  return { kind, ref, evidence: 'deterministic', ...extra };
}

/**
 * 从冻结 spec 快照与事实版本编译某个交付物版本的确定依赖。
 *
 * @param spec     冻结快照（含 product_truth.version、brand_kit{id,version}）
 * @param truth    事实版本记录（facts[]、critical_text[]、sku）
 * @param deliverable  该交付物的编译结果或版本冻结文字层：{ text_layers, text_blocks }；
 *                     文字层 source 为 fact 时 fact_key 指向事实字段，brand_logo 时 asset_ref 指向 Logo 素材
 * @param references   （可选）任务参考图列表（subject_context.references，含 asset_id 与 role）
 * @param skuProfile   （可选）项目当前 SKU 档案版本记录，按 sku_code 命中即登记 sku 依赖
 * @returns entries 数组；无任何编译依据（无 spec 且无 deliverable）时返回 null
 */
export function compileDependencies({ spec, truth, deliverable, references = [], skuProfile = null } = {}) {
  if (!spec && !deliverable) return null;
  const entries = [];
  const seen = new Set();
  const push = item => {
    const key = `${item.kind}:${item.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(item);
  };

  const truthVersion = truth?.version ?? spec?.product_truth?.version ?? null;
  const layers = Array.isArray(deliverable?.text_layers) ? deliverable.text_layers : [];
  for (const layer of layers) {
    if (layer?.id) push(entry('text_layer', layer.id, { note: layer.source ?? null }));
    if (layer?.source === 'fact' && layer.fact_key) {
      push(entry('fact', layer.fact_key, { source_version: { truth_version: truthVersion } }));
    }
    if (layer?.source === 'brand_logo' && layer.asset_ref) {
      push(entry('asset', layer.asset_ref, { note: '品牌 Logo 原图叠加' }));
    }
  }
  // 关键文字层：来自事实版本 critical_text，逐条登记为 fact 级依赖（key 为约定字段名）
  for (const item of truth?.critical_text ?? []) {
    if (item?.text) push(entry('fact', 'critical_text', { source_version: { truth_version: truthVersion }, note: '包装关键文字' }));
  }

  for (const reference of references ?? []) {
    if (reference?.asset_id) {
      push(entry('asset', reference.asset_id, { note: reference.role ? `参考图（${reference.role}）` : '参考图' }));
    }
  }

  if (spec?.brand_kit?.id) {
    push(entry('brand', spec.brand_kit.id, {
      source_version: { brand_kit_version: spec.brand_kit.version ?? null },
    }));
  }

  const skuCode = truth?.sku ?? null;
  if (skuProfile && skuCode) {
    const hit = (skuProfile.skus ?? []).find(sku =>
      String(sku.sku_code ?? '').toLowerCase() === String(skuCode).toLowerCase());
    if (hit?.id) {
      // code 随条目留痕：E01 档案更新会重生成 sku id，旧 id 失效后
      // 归属核对（E04）可按商家编号把条目回落映射到当前档案的同编号 SKU
      push(entry('sku', hit.id, {
        code: hit.sku_code,
        source_version: { sku_profile_version: skuProfile.version ?? null },
        note: `命中商家编号 ${hit.sku_code}`,
      }));
    }
  }
  return entries;
}

/**
 * 人工关联条目并入：同 (kind, ref) 去重；deterministic 条目不得被人工覆盖。
 * 返回新的 entries 数组（不改动入参）。
 */
export function mergeManualEntries(entries, manualEntries) {
  const result = [...(entries ?? [])];
  const keys = new Set(result.map(item => `${item.kind}:${item.ref}`));
  for (const item of manualEntries) {
    const key = `${item.kind}:${item.ref}`;
    if (keys.has(key)) continue;
    keys.add(key);
    result.push(item);
  }
  return result;
}

/** 依赖记录查询用的扁平化呈现：无记录时调用方负责标 unknown。 */
export function presentDependency(record) {
  if (!isPlainObject(record)) return null;
  return {
    id: record.id,
    run_id: record.run_id,
    deliverable_id: record.deliverable_id,
    version_id: record.version_id,
    status: record.status,
    entries: (record.entries ?? []).map(item => ({ ...item })),
    created_by: record.created_by,
    created_at: record.created_at,
  };
}
