/**
 * E03 商品变更更新助手：差异计算、影响分类、影响清单与预算（纯函数，不含 IO）。
 *
 * 业务规则（MASTER-PROMPT 第 4 节 / PRD 7.2）：
 * 1. 只改文字/规格文字 → text_recompose：基于既有底图免费重合成，不调用生图模型。
 * 2. 关联素材变化（如换包装）→ needs_new_photo：必须重新实拍，绝不能用换字/重绘冒充实物变化。
 * 3. 数量/套装类 fact 变化 → text_recompose 但 visual_check=required：
 *    不能只把「1」换成「2」就放行，需人工核对视觉数量表达。
 * 4. 证据不足（无依赖记录 / ocr_candidate / legacy 无 spec 快照）→ needs_review：
 *    需人工判断，不能默认为「无需处理」。
 * 5. 无匹配的版本不进清单（不受影响的不打扰）。
 */
import { normalizeQuantity } from './sku.mjs';

export const CHANGE_ACTIONS = Object.freeze(['text_recompose', 'needs_new_photo', 'regenerate', 'needs_review']);
// awaiting_material：执行已收口，但有「必须新实拍」项未补素材，商品内容并未更新完成；
// awaiting_review：有「证据不足需人工核对」项未处理。两者都不能显示为「更新完成」。
export const CHANGE_STATUSES = Object.freeze(['draft', 'confirmed', 'executing', 'completed', 'partial_failed', 'awaiting_material', 'awaiting_review', 'cancelled']);
export const IMPACT_ITEM_STATUS = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);
// 跳过项的待跟进类型：material=待补实拍素材；review=待人工核对；user=商家主动跳过（不阻塞整单完成）
export const SKIP_AWAITING = Object.freeze(['material', 'review', 'user']);

/** 数量类事实的判定：计数单位（件/个/瓶…），或字段名含数量语义。 */
const QUANTITY_KEY_PATTERN = /数量|件数|个数|支数|片数|粒数|颗数|枚数|套装|件装|净含量|含量|规格|装量/;

function isQuantityFact(factChange) {
  const unit = factChange?.to?.unit ?? factChange?.from?.unit ?? null;
  if (unit) {
    try {
      if (String(normalizeQuantity(1, unit).dimension).startsWith('count:')) return true;
    } catch { /* 表外单位不据此判断，回落到字段名 */ }
  }
  return QUANTITY_KEY_PATTERN.test(String(factChange?.key ?? ''));
}

const factView = fact => (fact ? { value: fact.value ?? null, unit: fact.unit ?? null } : null);

/**
 * 新旧事实版本的逐字段差异：
 * - facts 按 key 对齐：added / removed / changed（值或单位变化都算）；
 * - category / sku / critical_text 变化单列；
 * - changed_asset_ids / brand_kit_changed 由调用方显式传入（换包装、品牌更新不从这里推测）。
 */
export function diffTruth(oldTruth, newPayload = {}) {
  const before = new Map((oldTruth?.facts ?? []).map(fact => [fact.key, fact]));
  const after = new Map((newPayload?.facts ?? []).map(fact => [fact.key, fact]));
  const facts = [];
  for (const [key, next] of after) {
    const prev = before.get(key);
    if (!prev) {
      facts.push({ key, change: 'added', from: null, to: factView(next) });
      continue;
    }
    if (String(prev.value ?? '') !== String(next.value ?? '') || String(prev.unit ?? '') !== String(next.unit ?? '')) {
      facts.push({ key, change: 'changed', from: factView(prev), to: factView(next) });
    }
  }
  for (const [key, prev] of before) {
    if (!after.has(key)) facts.push({ key, change: 'removed', from: factView(prev), to: null });
  }
  const oldCritical = (oldTruth?.critical_text ?? []).map(item => String(item?.text ?? '')).filter(Boolean);
  const newCritical = (newPayload?.critical_text ?? []).map(item => String(item?.text ?? '')).filter(Boolean);
  return {
    facts,
    category: (oldTruth?.category ?? null) !== (newPayload?.category ?? oldTruth?.category ?? null)
      ? { from: oldTruth?.category ?? null, to: newPayload?.category ?? null }
      : null,
    sku: newPayload?.sku !== undefined && (oldTruth?.sku ?? null) !== newPayload.sku
      ? { from: oldTruth?.sku ?? null, to: newPayload.sku }
      : null,
    critical_text: JSON.stringify(oldCritical) !== JSON.stringify(newCritical)
      ? { from: oldCritical, to: newCritical }
      : null,
    changed_asset_ids: Array.isArray(newPayload?.changed_asset_ids)
      ? [...new Set(newPayload.changed_asset_ids.map(String))] : [],
    brand_kit_changed: newPayload?.brand_kit_changed === true,
  };
}

/** 差异是否为空（没有任何事实/类目/SKU/关键文字/素材/品牌变化）。 */
export function diffIsEmpty(diff, skuDiff = []) {
  return (diff?.facts ?? []).length === 0 && !diff?.category && !diff?.sku && !diff?.critical_text
    && (diff?.changed_asset_ids ?? []).length === 0 && diff?.brand_kit_changed !== true
    && (skuDiff ?? []).length === 0;
}

/**
 * 单条依赖条目的影响分类。返回 null 表示该条目与本次变更无关。
 * matched 用 `kind:ref` 表达命中的变更对象，方便前端与审计回放。
 */
export function classifyImpact({ diff, skuDiff = [], dependencyEntry, hasSpecSnapshot = true } = {}) {
  const entry = dependencyEntry;
  if (!entry?.kind || !entry?.ref) return null;

  if (entry.kind === 'fact') {
    if (entry.ref === 'critical_text') {
      if (!diff?.critical_text) return null;
      return {
        action: 'needs_new_photo',
        matched: ['fact:critical_text'],
        reason: '包装关键文字变化等同实物包装变化：必须重新实拍，不能用排版层改写冒充新包装',
      };
    }
    const factChange = (diff?.facts ?? []).find(item => item.key === entry.ref);
    if (!factChange) return null;
    if (factChange.change === 'removed') {
      return {
        action: 'needs_review',
        matched: [`fact:${entry.ref}`],
        reason: `事实「${entry.ref}」已被删除，图上文字如何处理需人工决定（撤下/改文案/重拍）`,
      };
    }
    if (entry.evidence === 'ocr_candidate') {
      return {
        action: 'needs_review',
        matched: [`fact:${entry.ref}`],
        reason: '该关联来自 OCR 识别候选，需人工确认图上确实包含该信息后再处理',
      };
    }
    if (!hasSpecSnapshot) {
      return {
        action: 'needs_review',
        matched: [`fact:${entry.ref}`],
        reason: '该版本来自无冻结快照的旧链路，无法断定文字层可安全重合成，需人工核对',
      };
    }
    const quantity = isQuantityFact(factChange);
    return {
      action: 'text_recompose',
      matched: [`fact:${entry.ref}`],
      visual_check: quantity ? 'required' : undefined,
      reason: quantity
        ? '数量/套装类变化：文字可免费重合成，但视觉数量表达必须人工核对，不能只换字就放行'
        : '文案类变化：可基于既有底图免费重合成文字层，不调用生图模型',
    };
  }

  if (entry.kind === 'asset') {
    if (!(diff?.changed_asset_ids ?? []).includes(entry.ref)) return null;
    return {
      action: 'needs_new_photo',
      matched: [`asset:${entry.ref}`],
      reason: '关联素材已被更换（如换包装）：需要新实拍照片，不能用换字或重绘冒充实物变化',
    };
  }

  if (entry.kind === 'sku') {
    const hit = (skuDiff ?? []).find(item => item.sku_id === entry.ref || item.sku_code === entry.ref);
    if (!hit) return null;
    return {
      action: 'needs_review',
      matched: [`sku:${entry.ref}`],
      reason: 'SKU 档案（规格/包含物）变化：画面中的规格与数量表达需人工核对',
    };
  }

  if (entry.kind === 'brand') {
    if (diff?.brand_kit_changed !== true) return null;
    return {
      action: 'needs_review',
      matched: [`brand:${entry.ref}`],
      reason: '品牌（Logo/品牌色）更新不自动作用于历史图片；如确需重做该图，请人工选择重生成',
    };
  }
  return null; // text_layer 条目是fact/asset 的载体，不单独构成变更原因
}

/** 依赖记录的证据档位：无记录 / 空记录 = unknown（绝不显示「无需更新」）。 */
function entriesEvidence(record) {
  if (!record || (record.entries ?? []).length === 0) return 'unknown';
  if (record.entries.some(item => item.evidence === 'deterministic')) return 'deterministic';
  if (record.entries.some(item => item.evidence === 'ocr_candidate')) return 'ocr_candidate';
  return 'manual';
}

/** 动作优先级：必须新实拍 > 需人工判断 > 免费文字重合成。 */
const ACTION_PRIORITY = { needs_new_photo: 3, needs_review: 2, text_recompose: 1, regenerate: 0 };

/**
 * 遍历项目所有 run 各交付物的「当前选用版本」，按 E02 依赖记录计算影响清单。
 * 无依赖记录的版本进 needs_review（unknown），不显示「无影响」；无匹配的不进清单。
 */
export function computeImpactList(data, project, diff, skuDiff = []) {
  const records = Object.values(data.image_dependencies ?? {})
    .filter(item => item.tenant_id === project.tenant_id && item.project_id === project.id);
  const recordOf = (runId, deliverableId, versionId) => records.find(item =>
    item.run_id === runId && item.deliverable_id === deliverableId && item.version_id === versionId) ?? null;

  const items = [];
  const runs = Object.values(data.runs ?? {})
    .filter(run => run.tenant_id === project.tenant_id && run.project_id === project.id)
    .sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')));
  for (const run of runs) {
    for (const target of run.deliverables ?? []) {
      const version = (run.versions ?? []).find(item =>
        item.deliverable_id === target.deliverable_id && item.active === true) ?? null;
      if (!version) continue; // 没有产出物的交付物不受影响
      const record = recordOf(run.id, target.deliverable_id, version.id);
      const evidence = entriesEvidence(record);
      if (evidence === 'unknown') {
        items.push({
          run_id: run.id,
          deliverable_id: target.deliverable_id,
          deliverable_label: target.label ?? target.deliverable_id,
          version_id: version.id,
          evidence: 'unknown',
          matched: [],
          action: 'needs_review',
          reason: '该版本没有依赖记录，关联信息不足：需人工核对是否受本次变更影响（不能视为无影响）',
        });
        continue;
      }
      const verdicts = (record.entries ?? [])
        .map(entry => classifyImpact({
          diff, skuDiff, dependencyEntry: entry,
          hasSpecSnapshot: Boolean(run.spec_ref?.version),
        }))
        .filter(Boolean);
      if (verdicts.length === 0) continue; // 无匹配：不受影响，不进清单
      const top = verdicts.reduce((a, b) =>
        ((ACTION_PRIORITY[b.action] ?? 0) > (ACTION_PRIORITY[a.action] ?? 0) ? b : a));
      items.push({
        run_id: run.id,
        deliverable_id: target.deliverable_id,
        deliverable_label: target.label ?? target.deliverable_id,
        version_id: version.id,
        evidence,
        matched: [...new Set(verdicts.flatMap(item => item.matched))],
        action: top.action,
        visual_check: verdicts.some(item => item.visual_check === 'required') ? 'required' : undefined,
        reason: verdicts.map(item => item.reason).filter(Boolean)[0] ?? null,
      });
    }
  }
  return items;
}

/**
 * 变更预算：只有 regenerate 项产生生图额度（复用单张成品计价逻辑，默认每张 1 点）；
 * text_recompose / needs_new_photo / needs_review 均为 0 额度。
 */
export function quoteChange(items, { priceOfItem = () => 1 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const regenerateItems = list.filter(item => item.action === 'regenerate');
  const lines = regenerateItems.map(item => ({
    item_id: item.id ?? null,
    run_id: item.run_id,
    deliverable_id: item.deliverable_id,
    credits: Math.max(0, Number(priceOfItem(item)) || 0),
  }));
  return {
    price_version: 'finished-image.1',
    estimated_credits: lines.reduce((sum, line) => sum + line.credits, 0),
    regenerate_count: regenerateItems.length,
    recompose_count: list.filter(item => item.action === 'text_recompose').length,
    new_photo_count: list.filter(item => item.action === 'needs_new_photo').length,
    review_count: list.filter(item => item.action === 'needs_review').length,
    lines,
    notes: [
      '文字重合成、新实拍提示与人工核对不消耗生图额度；只有确认重生成的项按单张成品计价。',
      '额度为内部演示积分，不代表真实货币或可计费承诺。',
    ],
  };
}

/**
 * 由逐项状态推导整单状态（「执行结束」≠「商品内容更新完成」）：
 * - 有 running → executing；
 * - 有 failed / 待视觉核对 / 有 pending → partial_failed（成功项保留，不能显示成整单完成）；
 * - 有待补实拍的跳过项（awaiting=material）→ awaiting_material：缺新照片，不算更新完成；
 * - 有待人工核对的跳过项（awaiting=review）→ awaiting_review：未知项未核，不算更新完成；
 * - 其余 → completed（商家主动跳过的项不阻塞完成，但保留记录）。
 */
export function deriveChangeStatus(items) {
  const list = Array.isArray(items) ? items : [];
  const pendingVisual = list.filter(item => item.status === 'done' && item.visual_check === 'required').length;
  const skipped = list.filter(item => item.status === 'skipped');
  const counts = {
    pending: list.filter(item => item.status === 'pending').length,
    running: list.filter(item => item.status === 'running').length,
    done: list.filter(item => item.status === 'done').length,
    failed: list.filter(item => item.status === 'failed').length,
    skipped: skipped.length,
    pending_visual_checks: pendingVisual,
    awaiting_material: skipped.filter(item => item.awaiting === 'material').length,
    awaiting_review: skipped.filter(item => item.awaiting === 'review').length,
  };
  let status = 'completed';
  if (counts.running > 0) status = 'executing';
  else if (counts.failed > 0 || counts.pending_visual_checks > 0 || counts.pending > 0) status = 'partial_failed';
  else if (counts.awaiting_material > 0) status = 'awaiting_material';
  else if (counts.awaiting_review > 0) status = 'awaiting_review';
  return { status, ...counts };
}

/** 变更单呈现：不改动存储结构，只补充派生计数。 */
export function presentChange(order) {
  if (!order || typeof order !== 'object') return null;
  const derived = deriveChangeStatus(order.impact_items);
  return {
    ...order,
    counts: {
      pending: derived.pending,
      running: derived.running,
      done: derived.done,
      failed: derived.failed,
      skipped: derived.skipped,
      pending_visual_checks: derived.pending_visual_checks,
      awaiting_material: derived.awaiting_material,
      awaiting_review: derived.awaiting_review,
    },
  };
}
