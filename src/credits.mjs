/**
 * M05 额度账本：统一由服务端判定能否生产，不信任前端余额（BILL-01/02/03）。
 *
 * 四条硬规则：
 * 1. 台账只追加，条目不可修改、不可删除；每次 capture/release/refund 必须带唯一操作键（BILL-03）。
 * 2. 同一操作键重复到达时重放已有条目，**不重复扣费**；同一键但内容不同直接报错，避免静默分叉。
 * 3. 可用额度不得为负：预留不足时不入队、不调供应商（第 6 节"提交生成"不变量）。
 * 4. 所有改动在调用方传入的 draft 上完成，由调用方包在同一个 store.mutate 里，
 *    因此"检查余额 + 预留"对并发提交是原子的，不会超卖。
 */
import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const LEDGER_TYPES = Object.freeze(['grant', 'reserve', 'capture', 'release', 'refund']);

const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;
const now = () => new Date().toISOString();

export function ensureAccount(data, tenantId, { initialCredits = 0 } = {}) {
  if (!data.credit_accounts) data.credit_accounts = {};
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
      updated_at: now(),
      created_at: now(),
    };
    data.credit_accounts[tenantId] = account;
    if (initialCredits > 0) {
      account.available = initialCredits;
      account.granted_total = initialCredits;
      if (!data.credit_entries) data.credit_entries = {};
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
        memo: '开通即到账的演示额度（测试用，不代表真实权益）',
        created_at: now(),
        created_by: 'system',
      };
      data.credit_entries[entry.id] = entry;
    }
  }
  return account;
}

export function balanceOf(data, tenantId, { initialCredits = 0 } = {}) {
  const account = ensureAccount(data, tenantId, { initialCredits });
  return {
    tenant_id: tenantId,
    available: account.available,
    reserved: account.reserved,
    consumed: account.consumed,
    granted_total: account.granted_total,
    currency: account.currency,
    testing: account.testing,
  };
}

export function ledgerEntries(data, tenantId, { limit = 50 } = {}) {
  return Object.values(data.credit_entries ?? {})
    .filter(entry => entry.tenant_id === tenantId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
    .slice(0, limit)
    .map(entry => ({ ...entry }));
}

/** 同一操作键只生效一次：命中已有条目即重放，不做第二次账面变动。 */
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
 * @returns {{entry: object, applied: boolean, balance: object}} applied=false 表示重复到达的重放
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
}) {
  if (!LEDGER_TYPES.includes(type)) throw new Error(`不支持的账本类型：${type}`);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('额度变动金额必须为正整数');
  if (typeof uniqueOperationKey !== 'string' || uniqueOperationKey.trim() === '') {
    throw new Error('额度变动必须带唯一操作键');
  }
  const operationKey = uniqueOperationKey.trim();
  const payload = { type, amount, job_id: jobId, attempt_id: attemptId };

  if (!data.credit_entries) data.credit_entries = {};
  const replay = replayCollision(data, tenantId, operationKey, payload);
  if (replay) return { ...replay, balance: balanceOf(data, tenantId, { initialCredits }) };

  const account = ensureAccount(data, tenantId, { initialCredits });
  const delta = { available: 0, reserved: 0, consumed: 0 };
  if (type === 'grant') { delta.available = amount; account.granted_total += amount; }
  if (type === 'reserve') {
    if (account.available < amount) {
      throw new ApiError(402, 'INSUFFICIENT_CREDITS',
        `可用额度 ${account.available}，需要 ${amount}，未预留任何额度也没有调用供应商`, {
          available: account.available, required: amount, shortfall: amount - account.available,
        });
    }
    delta.available = -amount; delta.reserved = amount;
  }
  if (type === 'capture') {
    if (account.reserved < amount) {
      throw new ApiError(409, 'RESERVE_EXHAUSTED',
        `可结算的预留额度 ${account.reserved}，无法结算 ${amount}`, { reserved: account.reserved, requested: amount });
    }
    delta.reserved = -amount; delta.consumed = amount;
  }
  if (type === 'release') {
    if (account.reserved < amount) {
      throw new ApiError(409, 'RESERVE_EXHAUSTED',
        `可释放的预留额度 ${account.reserved}，无法释放 ${amount}`, { reserved: account.reserved, requested: amount });
    }
    delta.reserved = -amount; delta.available = amount;
  }
  if (type === 'refund') {
    if (account.consumed < amount) {
      throw new ApiError(409, 'REFUND_EXHAUSTED',
        `已结算额度 ${account.consumed}，无法退款 ${amount}`, { consumed: account.consumed, requested: amount });
    }
    delta.consumed = -amount; delta.available = amount;
  }

  account.available += delta.available;
  account.reserved += delta.reserved;
  account.consumed += delta.consumed;
  account.updated_at = new Date(at).toISOString();
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
    memo,
    created_at: account.updated_at,
    created_by: actor,
  };
  data.credit_entries[entry.id] = entry;
  return { entry: { ...entry }, applied: true, balance: balanceOf(data, tenantId, { initialCredits }) };
}

/** 让 delete/未知类型在编译层面无处藏身：导出一个显式校验（供测试兜底）。 */
export function isLedgerType(value) {
  return LEDGER_TYPES.includes(value);
}
