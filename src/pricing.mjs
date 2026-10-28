/**
 * M05 报价：把已冻结的 CommerceSpec 变成一份可核对、可过期的报价。
 *
 * 三条自我约束：
 * 1. 报价只由交付清单**结构**驱动（项数/数量/类型/文字块），与背景、Logo 等执行细节无关，
 *    与 M04 的 requote 判定同源：换品牌套件不改清单就不该要求重新报价。
 * 2. 额度是**内部演示积分**，不是真实货币，也不承诺任何实际服务能力；价格版本必须随报价一起留存。
 * 3. 报价有有效期。过期后不得直接执行，必须重新取价（BILL-01）。
 */
import { createHash, randomBytes } from 'node:crypto';

export const PRICE_VERSION = 'demo-price.1';
export const DEFAULT_QUOTE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/** 演示价格表：单位为内部演示额度。真实价格需接入时按价格版本替换。 */
const BASE_BY_TYPE = Object.freeze({
  main_image: 4,
  selling_point: 4,
  scene_image: 5,
  detail_image: 3,
  ad_vertical: 5,
  ad_horizontal: 5,
});
const FALLBACK_BASE = 6;
const PER_TEXT_BLOCK = 1;
const PER_EXTRA_COPY = 3; // 同一交付物多于 1 张时，第 2 张起按此价计，避免数量线性放大预算
export const EXTRA_COPY_CREDITS = PER_EXTRA_COPY;

/** 把尺寸/比例/格式拼成前端可读的规格字符串，如 "1200×1200 · 1:1 · PNG"。 */
export function formatDeliverableSpec(item) {
  const parts = [];
  if (Number(item.width) && Number(item.height)) parts.push(`${item.width}×${item.height}`);
  if (item.ratio) parts.push(String(item.ratio));
  if (Array.isArray(item.formats) && item.formats.length > 0) parts.push(item.formats.map(f => String(f).toUpperCase()).join('/'));
  return parts.join(' · ');
}

export const priceOfDeliverable = item => {
  const base = BASE_BY_TYPE[item.type] ?? FALLBACK_BASE;
  const units = Math.max(1, Number(item.count) || 1);
  const withText = base + (Array.isArray(item.text_blocks) ? item.text_blocks.length : 0) * PER_TEXT_BLOCK;
  return units === 1 ? withText : withText + (units - 1) * PER_EXTRA_COPY;
};

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * 由已冻结 spec 生成报价。
 * 注意：传入的 spec 必须是 store 中已存在的版本，不允许按当前配置重算，
 * 否则任务引用的依据与预算会漂移（FR-020）。
 */
export function quoteFromSpec({
  spec,
  priceVersion = PRICE_VERSION,
  ttlMs = DEFAULT_QUOTE_TTL_MS,
  at = new Date(),
  finishedImages = false,
  includeOptional = false,
  // 指定图片重生成只对单张报价：交付清单收窄到这一项，避免顺带重做其它图片
  onlyDeliverableIds = null,
} = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('报价需要已冻结的 spec');
  const onlyIds = Array.isArray(onlyDeliverableIds) && onlyDeliverableIds.length > 0
    ? new Set(onlyDeliverableIds.map(String)) : null;
  const deliverables = (Array.isArray(spec.deliverables) ? spec.deliverables : [])
    .filter(item => !finishedImages || includeOptional || item.required)
    .filter(item => !onlyIds || onlyIds.has(item.id));
  if (deliverables.length === 0) throw new Error('交付清单为空，无法报价');

  const lines = deliverables.map(item => ({
    deliverable_id: item.id,
    label: item.label,
    type: item.type,
    required: Boolean(item.required),
    count: Math.max(1, Number(item.count) || 1),
    credits: finishedImages ? Math.max(1, Number(item.count) || 1) : priceOfDeliverable(item),
    // 规格字段来自冻结快照（由 spec 层按平台规则计算好），不再硬编码
    width: Number(item.width) || null,
    height: Number(item.height) || null,
    ratio: item.ratio ?? null,
    formats: Array.isArray(item.formats) ? [...item.formats] : null,
    spec: formatDeliverableSpec(item),
    note: item.text_blocks?.length ? `含 ${item.text_blocks.length} 处需核对的文字块` : '无文字块',
  }));

  const estimated = lines.reduce((sum, line) => sum + line.credits, 0);
  const budget = spec.budget ?? {};
  const requestedAttempts = Number(budget.max_attempts) || DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Math.max(1, Math.min(requestedAttempts, DEFAULT_MAX_ATTEMPTS));
  const budgetCap = Number.isFinite(budget.max_credits) ? budget.max_credits : null;
  const requestedCeiling = estimated * maxAttempts;
  const ceiling = finishedImages ? estimated : budgetCap === null ? requestedCeiling : Math.min(requestedCeiling, budgetCap);

  const notes = [finishedImages ? '按可交付成品计价，每张 1 点；含最多两次修复，失败释放，待复核保留预留。' : '额度为内部演示积分，不代表真实货币或可计费承诺。'];
  notes.push(`默认最多 ${DEFAULT_MAX_ATTEMPTS} 轮（含首轮），任一上限触达即停止。`);
  if (budgetCap !== null && requestedCeiling > budgetCap) {
    notes.push(`模板推荐轮数所需 ${requestedCeiling} 额度超过预算上限 ${budgetCap}，已按上限封顶，触达后停止不再自动扩大预算。`);
  }
  if (spec.channel?.platform_coverage && spec.channel.platform_coverage !== 'verified') {
    notes.push('平台规则覆盖不足，本次报价不含任何平台合规性承诺。');
  }

  const createdAt = new Date(at).toISOString();
  const expiresAt = new Date(new Date(at).getTime() + ttlMs).toISOString();
  const contentHash = sha({
    price_version: finishedImages ? 'finished-image.1' : priceVersion,
    spec_version: spec.version ?? null,
    deliverable_hash: spec.deliverable_hash ?? null,
    lines,
    max_attempts: maxAttempts,
    estimated_credits: estimated,
    max_credits: ceiling,
  });

  return {
    billing_mode: finishedImages ? 'finished_image' : 'legacy_demo',
    quote_id: `qte_${randomBytes(8).toString('hex')}`,
    price_version: finishedImages ? 'finished-image.1' : priceVersion,
    content_hash: contentHash,
    spec_version: spec.version ?? null,
    deliverable_hash: spec.deliverable_hash ?? null,
    // 报价必须能指回它依据的那份冻结快照，否则"报价一致"无从判断
    spec_ref: {
      spec_id: spec.id ?? spec.spec_id ?? null,
      version: spec.version ?? null,
      content_hash: spec.content_hash ?? null,
      deliverable_hash: spec.deliverable_hash ?? null,
      template_id: spec.template?.id ?? null,
      template_version: spec.template?.version ?? null,
    },
    created_at: createdAt,
    expires_at: expiresAt,
    estimated_credits: estimated,
    max_credits: ceiling,
    max_attempts: maxAttempts,
    lines,
    notes,
    settlement_policy: finishedImages ? '每张可交付图片结算一次；包含最多两次修复，待复核保留预留，失败释放。' : '内部演示按尝试阶段结算。',
  };
}

/** 报价状态：只有 current 才能用于创建任务。 */
export function quoteStatus(quote, at = new Date()) {
  if (!quote) return 'missing';
  if (new Date(quote.expires_at).getTime() <= new Date(at).getTime()) return 'expired';
  return 'current';
}

/** 报价是否与某个 spec 快照一致：防止用旧报价执行新 spec。 */
export function quoteMatchesSpec(quote, spec) {
  if (!quote?.spec_ref || !spec) return false;
  return quote.spec_ref.version === spec.version
    && quote.spec_ref.content_hash === spec.content_hash
    && quote.spec_ref.deliverable_hash === spec.deliverable_hash;
}
