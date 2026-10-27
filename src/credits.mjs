/**
 * M05 额度账本 + R03 成品额度批次。
 *
 * 账本硬规则（沿用 M05）：
 * 1. 台账只追加，条目不可修改、不可删除；每次变动必须带唯一操作键（BILL-03）。
 * 2. 同一操作键重复到达时重放已有条目，**不重复扣费**；同一键但内容不同直接报错。
 * 3. 可用额度不得为负：预留不足时不入队、不调供应商。
 * 4. 所有改动在调用方传入的 draft 上完成，由调用方包在同一个 store.mutate 里，
 *    因此"检查余额 + 预留"对并发提交是原子的。
 *
 * R03 批次规则：
 * 5. 每个 grant 生成一个批次（lot），带来源、有效期与权益快照；预留按最早到期优先（FEFO）。
 * 6. 预留记录把额度具体分配到批次；结算/释放都回到同一批批次，避免到期批次被"借"出去。
 * 7. 到期只回收"可用"部分；已被预留的部分保持冻结，待结算/释放后再回收，不产生负余额。
 * 8. 体验额度绑定第一个商品：一旦用于某商品，不能再给第二个商品使用。
 */
import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const LEDGER_TYPES = Object.freeze([
  'grant', 'reserve', 'capture', 'release', 'refund', 'expire',
]);

const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;
const nowAt = at => new Date(at).toISOString();

function ensureTables(data) {
  if (!data.credit_accounts) data.credit_accounts = {};
  if (!data.credit_entries) data.credit_entries = {};
  if (!data.credit_lots) data.credit_lots = {};
  if (!data.credit_reservations) data.credit_reservations = {};
}

function makeLot(data, {
  tenantId, amount, kind = 'grant', expiresAt = null, orderId = null, versionSnapshot = null, at = new Date(),
}) {
  const lot = {
    id: newId('lot'),
    tenant_id: tenantId,
    kind,
    source_order_id: orderId,
    version_snapshot: versionSnapshot ?? null,
    total: amount,
    consumed: 0,
    reserved: 0,
    expired: 0,
    expires_at: expiresAt,
    status: 'active',
    project_id: null,
    created_at: nowAt(at),
  };
  data.credit_lots[lot.id] = lot;
  return lot;
}

export function ensureAccount(data, tenantId, { initialCredits = 0, at = new Date() } = {}) {
  ensureTables(data);
  let account = data.credit_accounts[tenantId];
  if (!account) {
    account = {
      tenant_id: tenantId,
      available: 0,
      reserved: 0,
      consumed: 0,
      granted_total: 0,
      currency: '内部演示额度',
      testing: true,
      updated_at: nowAt(at),
      created_at: nowAt(at),
    };
    data.credit_accounts[tenantId] = account;
    if (initialCredits > 0) {
      account.available = initialCredits;
      account.granted_total = initialCredits;
      const entry = {
        id: newId('cre'),
        tenant_id: tenantId,
        type: 'grant',
        amount: initialCredits,
        available_delta: initialCredits,
        reserved_delta: 0,
        consumed_delta: 0,
        unique_operation_key: `initial-grant:${tenantId}`,
        job_id: null,
        attempt_id: null,
        lot_id: null,
        memo: '开通即到账的演示额度（测试用，不代表真实权益）',
        created_at: nowAt(at),
        created_by: 'system',
      };
      const lot = makeLot(data, {
        tenantId, amount: initialCredits, kind: 'demo_initial', at,
      });
      entry.lot_id = lot.id;
      data.credit_entries[entry.id] = entry;
    }
  }
  migrateLegacyLot(data, tenantId, account, at);
  return account;
}

/**
 * 旧数据兼容：R03 之前落盘的账户只有汇总数字，没有批次。
 * 首次访问时补一个"遗留"批次，让 available/reserved/consumed 与批次账面一致，
 * 避免对账时报"批次缺失"。这不是伪造新权益：总量恰好等于原账户数字。
 */
function migrateLegacyLot(data, tenantId, account, at) {
  const existing = Object.values(data.credit_lots)
    .some(lot => lot.tenant_id === tenantId);
  if (existing) return;
  const total = account.available + account.reserved + account.consumed;
  if (total <= 0) return;
  const lot = makeLot(data, { tenantId, amount: total, kind: 'legacy', at: account.created_at ?? at });
  lot.consumed = account.consumed;
  lot.reserved = account.reserved;
  lot.migrated_from = 'pre_r03_account';
}

/** 批次剩余可用量（不含已预留）。 */
export const lotAvailable = lot => Math.max(0, lot.total - lot.consumed - lot.reserved - lot.expired);

function activeLots(data, tenantId) {
  return Object.values(data.credit_lots ?? {})
    .filter(lot => lot.tenant_id === tenantId && ['active', 'expired_pending'].includes(lot.status));
}

/** FEFO：最早到期优先，无到期日排最后；同到期日按批次创建时间。 */
function compareLots(left, right) {
  const leftExpiry = left.expires_at ? new Date(left.expires_at).getTime() : Number.POSITIVE_INFINITY;
  const rightExpiry = right.expires_at ? new Date(right.expires_at).getTime() : Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  return String(left.created_at).localeCompare(String(right.created_at));
}

/** 分配批次用于预留；体验批次只能服务它绑定的那个商品。 */
function allocateLots(data, tenantId, amount, { at = new Date(), projectId = null } = {}) {
  const candidate = activeLots(data, tenantId)
    .filter(lot => lot.status === 'active')
    .filter(lot => !lot.expires_at || new Date(lot.expires_at).getTime() > new Date(at).getTime())
    .filter(lot => {
      if (lot.kind !== 'experience') return true;
      if (!lot.project_id) return Boolean(projectId);
      return projectId === null ? false : lot.project_id === projectId;
    })
    .filter(lot => lotAvailable(lot) > 0)
    .sort(compareLots);
  const allocations = [];
  let remaining = amount;
  for (const lot of candidate) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lotAvailable(lot));
    if (take <= 0) continue;
    const newlyBound = lot.kind === 'experience' && !lot.project_id && Boolean(projectId);
    if (lot.kind === 'experience' && !lot.project_id) lot.project_id = projectId;
    lot.reserved += take;
    allocations.push({ lot_id: lot.id, planned: take, consumed: 0, released: 0, newly_bound: newlyBound });
    remaining -= take;
  }
  return { allocations, shortfall: remaining };
}

/** 从指定任务的预留记录里取额度，供结算/释放复用同一批批次。 */
function jobReservations(data, tenantId, jobId) {
  return Object.values(data.credit_reservations ?? {})
    .filter(item => item.tenant_id === tenantId && item.job_id === jobId && item.status === 'reserved')
    .filter(item => item.remaining > 0)
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
}

function drawAllocations(data, tenantId, jobId, amount) {
  const reservations = jobReservations(data, tenantId, jobId);
  const draws = [];
  let remaining = amount;
  for (const reservation of reservations) {
    if (remaining <= 0) break;
    for (const allocation of reservation.allocations) {
      if (remaining <= 0) break;
      const outstanding = allocation.planned - allocation.consumed - allocation.released;
      if (outstanding <= 0) continue;
      const take = Math.min(remaining, outstanding);
      const lot = data.credit_lots[allocation.lot_id];
      if (!lot) throw new Error('额度批次缺失，已中止写入');
      if (lot.reserved < take) throw new Error('批次预留账面不一致，已中止写入');
      draws.push({ lot, allocation, reservation, amount: take });
      remaining -= take;
    }
  }
  if (remaining > 0 && draws.length === 0) {
    // 旧任务（R03 之前）没有批次级预留记录：按 FEFO 从有预留的批次里直接取，
    // 保证结算/释放仍然回到真实批次，而不是只改汇总数字。
    for (const lot of activeLots(data, tenantId).filter(item => item.reserved > 0).sort(compareLots)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.reserved);
      if (take <= 0) continue;
      draws.push({ lot, allocation: null, reservation: null, amount: take });
      remaining -= take;
    }
  }
  const shortage = remaining;
  return { draws, shortage };
}

function replayCollision(data, tenantId, operationKey, payload) {
  const existing = Object.values(data.credit_entries ?? {})
    .find(entry => entry.tenant_id === tenantId && entry.unique_operation_key === operationKey);
  if (!existing) return null;
  const same = existing.type === payload.type && existing.amount === payload.amount
    && existing.job_id === payload.job_id && existing.attempt_id === payload.attempt_id;
  if (!same) {
    throw new ApiError(409, 'OPERATION_KEY_CONFLICT',
      `操作键 ${operationKey} 已用于另一笔不同的额度变动，请更换操作键`, {
        existing_type: existing.type, existing_amount: existing.amount,
      });
  }
  return { entry: { ...existing }, applied: false };
}

/**
 * 记一笔额度变动。
 * @returns {{entry: object, applied: boolean, balance: object}}
 */
export function appendEntry(data, {
  type,
  amount,
  tenantId,
  jobId = null,
  attemptId = null,
  uniqueOperationKey,
  memo = '',
  actor = 'system',
  initialCredits = 0,
  at = new Date(),
  // R03：批次元数据
  lot = null,
  projectId = null,
}) {
  if (!LEDGER_TYPES.includes(type)) throw new Error(`不支持的账本类型：${type}`);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('额度变动金额必须为正整数');
  if (typeof uniqueOperationKey !== 'string' || uniqueOperationKey.trim() === '') {
    throw new Error('额度变动必须带唯一操作键');
  }
  ensureTables(data);
  const operationKey = uniqueOperationKey.trim();
  const payload = { type, amount, job_id: jobId, attempt_id: attemptId };

  const replay = replayCollision(data, tenantId, operationKey, payload);
  if (replay) return { ...replay, balance: balanceOf(data, tenantId, { initialCredits }) };

  sweepExpiredLots(data, tenantId, at, { initialCredits });
  const account = ensureAccount(data, tenantId, { initialCredits, at });
  const delta = { available: 0, reserved: 0, consumed: 0 };
  let lotId = null;

  if (type === 'grant') {
    const created = makeLot(data, {
      tenantId,
      amount,
      kind: lot?.kind ?? 'grant',
      expiresAt: lot?.expires_at ?? null,
      orderId: lot?.order_id ?? null,
      versionSnapshot: lot?.version_snapshot ?? null,
      at,
    });
    lotId = created.id;
    delta.available = amount;
    account.granted_total += amount;
  }

  if (type === 'reserve') {
    if (account.available < amount) {
      throw new ApiError(402, 'INSUFFICIENT_CREDITS',
        `可用额度 ${account.available}，需要 ${amount}，未预留任何额度也没有调用供应商`, {
          available: account.available, required: amount, shortfall: amount - account.available,
        });
    }
    const { allocations, shortfall } = allocateLots(data, tenantId, amount, { at, projectId });
    if (shortfall > 0 || allocations.length === 0) {
      // 回滚刚分配的批次预留，保证失败时账面不动
      for (const allocation of allocations) {
        const target = data.credit_lots[allocation.lot_id];
        if (target) target.reserved -= allocation.planned;
        if (allocation.newly_bound && target) target.project_id = null;
      }
      const boundElsewhere = activeLots(data, tenantId).some(lot =>
        lot.kind === 'experience' && lot.project_id && lot.project_id !== projectId && lotAvailable(lot) > 0);
      if (boundElsewhere) {
        throw new ApiError(409, 'EXPERIENCE_SCOPE_LIMIT',
          '体验额度已绑定其他商品，不能用于当前商品；请购买套餐后再生成', {
            project_id: projectId,
          });
      }
      throw new ApiError(402, 'INSUFFICIENT_CREDITS',
        `可用额度 ${account.available}，需要 ${amount}，未预留任何额度也没有调用供应商`, {
          available: account.available, required: amount, shortfall: amount - account.available,
        });
    }
    data.credit_reservations[operationKey] = {
      id: newId('res'),
      tenant_id: tenantId,
      job_id: jobId,
      operation_key: operationKey,
      allocations,
      remaining: amount,
      status: 'reserved',
      created_at: nowAt(at),
    };
    delta.available = -amount;
    delta.reserved = amount;
  }

  if (type === 'capture') {
    if (account.reserved < amount) {
      throw new ApiError(409, 'RESERVE_EXHAUSTED',
        `可结算的预留额度 ${account.reserved}，无法结算 ${amount}`, { reserved: account.reserved, requested: amount });
    }
    const { draws, shortage } = drawAllocations(data, tenantId, jobId, amount);
    if (shortage > 0) {
      throw new Error('预留记录不足，已中止写入');
    }
    for (const draw of draws) {
      draw.lot.reserved -= draw.amount;
      draw.lot.consumed += draw.amount;
      if (draw.allocation) draw.allocation.consumed += draw.amount;
      if (draw.reservation) {
        draw.reservation.remaining -= draw.amount;
        if (draw.reservation.remaining === 0) draw.reservation.status = 'settled';
      }
    }
    delta.reserved = -amount;
    delta.consumed = amount;
  }

  if (type === 'release') {
    if (account.reserved < amount) {
      throw new ApiError(409, 'RESERVE_EXHAUSTED',
        `可释放的预留额度 ${account.reserved}，无法释放 ${amount}`, { reserved: account.reserved, requested: amount });
    }
    const { draws, shortage } = drawAllocations(data, tenantId, jobId, amount);
    if (shortage > 0) throw new Error('预留记录不足，已中止写入');
    for (const draw of draws) {
      draw.lot.reserved -= draw.amount;
      if (draw.allocation) draw.allocation.released += draw.amount;
      if (draw.reservation) {
        draw.reservation.remaining -= draw.amount;
        if (draw.reservation.remaining === 0) draw.reservation.status = 'released';
      }
    }
    delta.reserved = -amount;
    delta.available = amount;
  }

  if (type === 'refund') {
    if (account.consumed < amount) {
      throw new ApiError(409, 'REFUND_EXHAUSTED',
        `已结算额度 ${account.consumed}，无法退款 ${amount}`, { consumed: account.consumed, requested: amount });
    }
    const created = makeLot(data, {
      tenantId,
      amount,
      kind: lot?.kind ?? 'refund',
      expiresAt: lot?.expires_at ?? null,
      orderId: lot?.order_id ?? null,
      versionSnapshot: lot?.version_snapshot ?? null,
      at,
    });
    lotId = created.id;
    delta.consumed = -amount;
    delta.available = amount;
  }

  if (type === 'expire') {
    if (account.available < amount) {
      throw new Error('可用额度不足，无法过期回收');
    }
    delta.available = -amount;
  }

  account.available += delta.available;
  account.reserved += delta.reserved;
  account.consumed += delta.consumed;
  account.updated_at = nowAt(at);
  if (account.available < 0 || account.reserved < 0 || account.consumed < 0) {
    throw new Error('额度账面不一致，已中止写入');
  }

  const entry = {
    id: newId('cre'),
    tenant_id: tenantId,
    type,
    amount,
    available_delta: delta.available,
    reserved_delta: delta.reserved,
    consumed_delta: delta.consumed,
    unique_operation_key: operationKey,
    job_id: jobId,
    attempt_id: attemptId,
    lot_id: lotId,
    memo,
    created_at: account.updated_at,
    created_by: actor,
  };
  data.credit_entries[entry.id] = entry;
  // 释放后可能立刻又有批次到期，再扫一次，避免"释放回可用"绕过有效期
  if (type === 'release') sweepExpiredLots(data, tenantId, at, { initialCredits });
  return { entry: { ...entry }, applied: true, balance: balanceOf(data, tenantId, { initialCredits }) };
}

/**
 * 到期回收：只回收批次里"可用"的部分。
 * 已预留的部分保留在批次里，等结算或释放后由下一次扫描回收，绝不产生负余额。
 */
export function sweepExpiredLots(data, tenantId, at = new Date(), { initialCredits = 0 } = {}) {
  ensureTables(data);
  const applied = [];
  for (const lot of Object.values(data.credit_lots)) {
    if (lot.tenant_id !== tenantId) continue;
    if (!lot.expires_at) continue;
    if (new Date(lot.expires_at).getTime() > new Date(at).getTime()) continue;
    if (lot.status === 'expired') continue;
    const expirable = lotAvailable(lot);
    lot.status = lot.reserved > 0 ? 'expired_pending' : 'expired';
    if (expirable <= 0) continue;
    const sequence = (lot.expire_sequence ?? 0) + 1;
    lot.expire_sequence = sequence;
    lot.expired += expirable;
    lot.expired_at = nowAt(at);
    try {
      const result = appendExpiry(data, tenantId, lot, expirable, at, initialCredits);
      if (result) applied.push(result.entry);
    } catch (error) {
      lot.expired -= expirable;
      throw error;
    }
  }
  return applied;
}

/** 单独写入过期条目，避免和业务变动共用入口造成递归扫描。 */
function appendExpiry(data, tenantId, lot, amount, at, initialCredits) {
  const account = ensureAccount(data, tenantId, { initialCredits, at });
  if (account.available < amount) throw new Error('可用额度不足，无法过期回收');
  account.available -= amount;
  account.updated_at = nowAt(at);
  if (account.available < 0) throw new Error('额度账面不一致，已中止写入');
  const entry = {
    id: newId('cre'),
    tenant_id: tenantId,
    type: 'expire',
    amount,
    available_delta: -amount,
    reserved_delta: 0,
    consumed_delta: 0,
    unique_operation_key: `expire:${lot.id}:${lot.expire_sequence}`,
    job_id: null,
    attempt_id: null,
    lot_id: lot.id,
    memo: `批次到期回收 ${amount}（${lot.kind}）`,
    created_at: account.updated_at,
    created_by: 'system',
  };
  data.credit_entries[entry.id] = entry;
  return { entry, applied: true };
}

export function balanceOf(data, tenantId, { initialCredits = 0 } = {}) {
  const account = ensureAccount(data, tenantId, { initialCredits });
  const lots = Object.values(data.credit_lots ?? {})
    .filter(lot => lot.tenant_id === tenantId)
    .sort(compareLots)
    .map(lot => ({
      lot_id: lot.id,
      kind: lot.kind,
      total: lot.total,
      available: lotAvailable(lot),
      reserved: lot.reserved,
      consumed: lot.consumed,
      expired: lot.expired,
      expires_at: lot.expires_at,
      status: lot.status,
      source_order_id: lot.source_order_id,
      version_snapshot: lot.version_snapshot,
      project_id: lot.project_id,
    }));
  const expiring = lots
    .filter(lot => lot.available > 0 && lot.expires_at)
    .sort((left, right) => new Date(left.expires_at) - new Date(right.expires_at));
  return {
    tenant_id: tenantId,
    available: account.available,
    reserved: account.reserved,
    consumed: account.consumed,
    granted_total: account.granted_total,
    currency: account.currency,
    testing: account.testing,
    lots,
    next_expiry_at: expiring[0]?.expires_at ?? null,
    // 优先消耗最早到期的额度，前端可直接解释"先扣快到期的"
    consumption_priority: 'earliest_expiry_first',
  };
}

export function ledgerEntries(data, tenantId, { limit = 50 } = {}) {
  return Object.values(data.credit_entries ?? {})
    .filter(entry => entry.tenant_id === tenantId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
    .slice(0, limit)
    .map(entry => ({ ...entry }));
}

/** 体验额度：每个租户只发一次，最多 3 张、绑定 1 个商品。 */
export const EXPERIENCE_CREDITS = 3;
export const EXPERIENCE_VALIDITY_DAYS = 90;

export function grantExperienceCredits(data, {
  tenantId, actor = 'system', at = new Date(), initialCredits = 0,
} = {}) {
  const expiresAt = new Date(new Date(at).getTime() + EXPERIENCE_VALIDITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return appendEntry(data, {
    type: 'grant',
    amount: EXPERIENCE_CREDITS,
    tenantId,
    uniqueOperationKey: `grant:experience:${tenantId}`,
    memo: `首次体验额度 ${EXPERIENCE_CREDITS} 张，${EXPERIENCE_VALIDITY_DAYS} 天有效，仅限 1 个商品`,
    actor,
    initialCredits,
    at,
    lot: {
      kind: 'experience',
      expires_at: expiresAt,
      version_snapshot: { credits: EXPERIENCE_CREDITS, products: 1, validity_days: EXPERIENCE_VALIDITY_DAYS },
    },
  });
}

export function isLedgerType(value) {
  return LEDGER_TYPES.includes(value);
}
