/**
 * R03/R07 套餐目录：把"卖什么、给多少、多久有效"集中成可版本化的配置。
 *
 * 这里的数字是**可调整的产品假设**，不是盈利承诺；改动只影响新订单，
 * 已购订单按购买时的快照执行（见 `planSnapshot`）。
 *
 * 规则口径：
 * - 全部套餐为单次购买，不自动续费、不委托扣费。
 * - "月度有效"落为到账起 30 天；一次性尝鲜包默认到账起 90 天（可调整的产品默认值）。
 * - 未用额度默认不结转；到期回收只回收可用部分，已预留部分结算/释放后再回收。
 * - 体验额度：每个租户一次、最多 3 张、仅限 1 个商品。
 * - 1 个商品的"1 张主图 + 2 张场景图"消耗 3 张额度。
 */
import { ApiError } from './errors.mjs';
import { appendEntry, grantExperienceCredits } from './credits.mjs';

export const PLANS_VERSION = 'plans-2026-10-r03';

export const USAGE_EXAMPLE = Object.freeze({
  description: '1 个商品 = 1 张主图 + 2 张场景图 = 3 张额度',
  credits_per_product: 3,
});

export const DELIVERY_DEFINITION = Object.freeze({
  summary: '达成约定检查条件并完成交付后结算；系统失败按规则释放对应额度',
  revision_scope: '仅针对具体硬错误的自动修订，默认每个交付项初始候选上限 2 次（可在配置中调整）',
  note: '纯审美变更与新需求按新任务确认，不包含在修订单价内',
});

export const COMMERCE_PLANS = Object.freeze([
  Object.freeze({
    id: 'plan_first_trial',
    name: '首次体验',
    kind: 'experience',
    credits: 3,
    products: 1,
    price_cents: 0,
    currency: 'CNY',
    validity_days: 90,
    auto_renew: false,
    rollover: false,
    includes_batch: false,
    priority_queue: false,
    note: '每个账户一次，仅限 1 个商品；不发现金等价物，不能转让',
    terms: '免费体验 3 张，90 天内有效，仅限 1 个商品',
  }),
  Object.freeze({
    id: 'plan_taster_10',
    name: '尝鲜包',
    kind: 'one_time',
    credits: 10,
    products: null,
    price_cents: 1900,
    currency: 'CNY',
    validity_days: 90,
    auto_renew: false,
    rollover: false,
    includes_batch: false,
    priority_queue: false,
    note: '一次性购买，默认到账起 90 天有效（可调整的产品默认值）',
    terms: '¥19 / 10 张，到账起 90 天内有效，未用不结转',
  }),
  Object.freeze({
    id: 'plan_daily_40',
    name: '日常上新',
    kind: 'monthly',
    credits: 40,
    products: null,
    price_cents: 6900,
    currency: 'CNY',
    validity_days: 30,
    auto_renew: false,
    rollover: false,
    includes_batch: false,
    priority_queue: false,
    note: '月包按到账起 30 天计算，不自动续费',
    terms: '¥69 / 40 张，到账起 30 天内有效，未用不结转',
  }),
  Object.freeze({
    id: 'plan_pro_150',
    name: '高频上新',
    kind: 'monthly',
    credits: 150,
    products: null,
    price_cents: 19900,
    currency: 'CNY',
    validity_days: 30,
    auto_renew: false,
    rollover: false,
    includes_batch: false,
    priority_queue: false,
    note: '月包按到账起 30 天计算，不自动续费；当前未承诺批量或优先队列权益',
    terms: '¥199 / 150 张，到账起 30 天内有效，未用不结转',
  }),
]);

export function listCommercePlans() {
  return {
    version: PLANS_VERSION,
    currency: 'CNY',
    plans: COMMERCE_PLANS.map(plan => ({ ...plan })),
    usage_example: { ...USAGE_EXAMPLE },
    delivery_definition: { ...DELIVERY_DEFINITION },
    rules: {
      auto_renew: false,
      rollover: false,
      expiry_from: 'delivery',
      monthly_validity_days: 30,
      one_time_validity_days: 90,
      note: '价格与额度为可调整的产品假设；调整后只影响新订单，旧订单沿用购买快照',
    },
  };
}

export function commercePlanById(planId) {
  return COMMERCE_PLANS.find(plan => plan.id === planId) ?? null;
}

/** 购买快照：订单只认购买时的权益，不随之后的目录调整变化。 */
export function planSnapshot(plan) {
  return {
    plan_id: plan.id,
    plans_version: PLANS_VERSION,
    name: plan.name,
    kind: plan.kind,
    credits: plan.credits,
    products: plan.products,
    price_cents: plan.price_cents,
    currency: plan.currency,
    validity_days: plan.validity_days,
    auto_renew: plan.auto_renew,
    rollover: plan.rollover,
    includes_batch: plan.includes_batch,
    priority_queue: plan.priority_queue,
    terms: plan.terms,
  };
}

export function expiryFromSnapshot(snapshot, at = new Date()) {
  const days = Number(snapshot?.validity_days);
  if (!Number.isInteger(days) || days <= 0) throw new Error('套餐有效期快照无效');
  return new Date(new Date(at).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 把套餐权益发放到账户。必须带订单号（体验套餐除外），
 * 用订单号做幂等键：重复回调/重试都不会重复发放。
 */
export function grantFromPlan(data, {
  tenantId,
  planId,
  orderId,
  actor = 'system',
  at = new Date(),
  initialCredits = 0,
} = {}) {
  const plan = commercePlanById(planId);
  if (!plan) throw new ApiError(404, 'PLAN_NOT_FOUND', `套餐 ${planId} 不存在`);
  if (plan.kind === 'experience') {
    return grantExperienceCredits(data, { tenantId, actor, at, initialCredits });
  }
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    throw new Error('套餐发放必须带订单号，用于幂等');
  }
  const snapshot = planSnapshot(plan);
  const expiresAt = expiryFromSnapshot(snapshot, at);
  return appendEntry(data, {
    type: 'grant',
    amount: snapshot.credits,
    tenantId,
    uniqueOperationKey: `plan-order:${orderId}`,
    memo: `${snapshot.name} 订单到账 ${snapshot.credits} 张，至 ${expiresAt}`,
    actor,
    initialCredits,
    at,
    lot: {
      kind: snapshot.kind,
      expires_at: expiresAt,
      order_id: orderId,
      version_snapshot: snapshot,
    },
  });
}
