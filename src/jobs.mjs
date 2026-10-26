/**
 * M05 任务执行骨架：GenerationJob 状态机、Attempt、事件流水、取消、超时与恢复。
 *
 * 状态机照 PRD 第 6 节：queued—running—evaluating，终态 completed / limit_reached / failed / cancelled，
 * 预算需要用户另行确认时进入 awaiting_confirmation，**不自动扩大预算**。
 * 另有一条独立事实：completed 只表示流程结束，质量另算（这里恒为 not_checked，QA 属 M07）。
 *
 * 本文件刻意守住的五条不变量：
 * 1. 预留失败不调用供应商；额度判定与预留在同一 store.mutate 内完成，并发提交不超卖。
 * 2. 同一 attempt 只会提交一次供应商调用；轮询返回 unknown 不重提、不加收费用。
 * 3. 取消后的迟到结果只入事件审计，**不写产物、不捕获费用、不让任务复活**。
 * 4. 供应商技术失败不向用户收费（释放），成功的一次 attempt 才捕获（BILL-04/05）。
 * 5. 进程异常退出后可从持久状态恢复： unknow n 的 attempt 先按幂等键重挂，再决定继续还是释放，
 *    绝不重复结算。
 */
import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { appendEntry, balanceOf } from './credits.mjs';
import { isRetryable } from './provider.mjs';

export const RUN_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
export const QUALITY_NOT_CHECKED = 'not_checked';

const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const ACTIVE_STATES = new Set(['queued', 'running', 'evaluating', 'awaiting_confirmation']);
export const TERMINAL_STATES = new Set(['completed', 'limit_reached', 'failed', 'cancelled']);

const RUN_STAGES = new Set([
  'spec_confirmed', 'budget_reserved', 'queued', 'generation',
  'hard_check', 'revision', 'settled', 'cancelled',
]);

function pushEvent(data, run, { stage, status, payload = {}, attemptId = null, iteration = run.iteration, at }) {
  if (!RUN_STAGES.has(stage)) throw new Error(`未知阶段：${stage}`);
  run.last_sequence += 1;
  const event = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: `evt_${randomBytes(10).toString('hex')}`,
    sequence: run.last_sequence,
    run_id: run.id,
    project_id: run.project_id,
    attempt_id: attemptId,
    iteration,
    stage,
    status,
    payload,
    timestamp: new Date(at).toISOString(),
  };
  // 事件主键用 event_id：对象里没有 id 字段，写入 data.events[event.id] 会把
  // 所有事件都落到同一个 undefined 键上，导致每次落盘只保留最后一条
  data.events[event.event_id] = event;
  return event;
}

export function createJobs({
  store,
  provider,
  clock = () => new Date(),
  initialCredits = 0,
  attemptTimeoutMs = 30_000,
  maxConcurrency = 2,
  tickMs = 25,
} = {}) {
  if (!store) throw new Error('jobs 缺少存储实例');
  if (!provider) throw new Error('jobs 缺少 Provider');
  const timers = new Set();
  let running = false;
  const wake = new Set();
  let idleWaiters = [];

  // ---------- 事件订阅：仅内存，用于 SSE；断线由 sequence 续传兜底 ----------
  const listeners = new Map(); // listenerId -> { runId, handler }
  function emit(event) {
    for (const listener of [...listeners.values()]) {
      if (listener.runId !== event.run_id) continue;
      try { listener.handler(event); } catch { /* 单个订阅者出错不影响其他人 */ }
    }
  }
  function subscribe(runId, handler) {
    const id = newId('sub');
    listeners.set(id, { runId, handler });
    return () => listeners.delete(id);
  }
  function notifyIdle() {
    if (activeCount > 0 || waiters.length === 0) return;
    const pending = waiters; waiters = [];
    for (const resolve of pending) resolve();
  }

  // ---------- 创建任务：先预留，再入队 ----------
  async function createRun({ ctx, run, project, spec, quote, idempotencyKey, scenario = 'success', fingerprint = null }) {
    const existing = await store.read(data => Object.values(data.runs ?? {})
      .find(item => item.tenant_id === ctx.tenantId && item.idempotency_key === idempotencyKey) ?? null);
    if (existing) {
      if (fingerprint && existing.idempotency_fingerprint && existing.idempotency_fingerprint !== fingerprint) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT',
          '该 Idempotency-Key 已用于另一份不同的请求，请更换后再提交', { run_id: existing.id });
      }
      return { run: existing, replayed: true };
    }

    const validation = provider.validate({
      request_hash: 'capability-check', target_width: 0, target_height: 0, references: 0,
    });

    const created = await store.mutate(data => {
      const duplicated = Object.values(data.runs ?? {})
        .find(item => item.tenant_id === ctx.tenantId && item.idempotency_key === idempotencyKey);
      if (duplicated) {
        if (fingerprint && duplicated.idempotency_fingerprint && duplicated.idempotency_fingerprint !== fingerprint) {
          throw new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT',
            '该 Idempotency-Key 已用于另一份不同的请求，请更换后再提交', { run_id: duplicated.id });
        }
        return { run: duplicated, replayed: true };
      }

      const reserve = appendEntry(data, {
        type: 'reserve',
        amount: quote.max_credits,
        tenantId: ctx.tenantId,
        jobId: run.id,
        uniqueOperationKey: `reserve:${run.id}`,
        memo: `冻结生产配置 v${spec.version} 的预算上限`,
        actor: ctx.actorId,
        initialCredits,
        at: clock(),
      });
      if (!reserve.applied) throw new Error('预算预留未生效');

      const record = {
        id: run.id,
        tenant_id: ctx.tenantId,
        project_id: project.id,
        idempotency_key: idempotencyKey,
        idempotency_fingerprint: fingerprint,
        schema_version: RUN_SCHEMA_VERSION,
        status: 'queued',
        cancel_requested: false,
        cancel_reason: null,
        quality_status: QUALITY_NOT_CHECKED,
        iteration: 1,
        last_sequence: 0,
        created_at: run.created_at,
        updated_at: run.created_at,
        created_by: ctx.actorId,
        spec_ref: {
          version: spec.version,
          content_hash: spec.content_hash,
          deliverable_hash: spec.deliverable_hash,
          template_id: spec.template?.id ?? null,
          template_version: spec.template?.version ?? null,
        },
        quote: { quote_id: quote.quote_id, price_version: quote.price_version, content_hash: quote.content_hash },
        budget: {
          estimated_credits: quote.estimated_credits,
          max_credits: quote.max_credits,
          max_attempts: quote.max_attempts,
          reserved_credits: quote.max_credits,
          captured_credits: 0,
          released_credits: 0,
        },
        provider_validation: validation,
        scenario,
        deliverables: quote.lines.map(line => ({
          deliverable_id: line.deliverable_id,
          label: line.label,
          count: line.count,
          credits: line.credits,
          status: 'pending',
          attempts_used: 0,
          succeeded_attempt_id: null,
        })),
        attempts: [],
        terminal_reason: null,
        pending_confirmation: null,
      };
      data.runs[run.id] = record;
      pushEvent(data, record, { stage: 'budget_reserved', status: 'reserved', at: clock(), payload: { amount: quote.max_credits, balance: balanceOf(data, ctx.tenantId, { initialCredits }) } });
      pushEvent(data, record, { stage: 'queued', status: 'queued', at: clock(), payload: { max_attempts: quote.max_attempts } });
      return { run: structuredClone(record), replayed: false, events: eventsOf(data, record.id) };
    });
    for (const event of created.events ?? []) emit(event);
    kick();
    return created;
  }

  function eventsOf(data, runId, sinceSequence = 0) {
    return Object.values(data.events ?? {})
      .filter(event => event.run_id === runId && event.sequence > sinceSequence)
      .sort((left, right) => left.sequence - right.sequence);
  }

  // ---------- 取消 ----------
  async function cancelRun({ ctx, runId, reason = 'user_cancelled' }) {
    return store.mutate(data => {
      const run = findRun(data, ctx, runId);
      const events = [];
      if (run.cancel_requested === false) {
        run.cancel_requested = true;
        run.cancel_reason = reason;
        run.updated_at = new Date(clock()).toISOString();
        events.push(pushEvent(data, run, { stage: 'cancelled', status: 'cancel_requested', at: clock(), payload: { reason } }));
      }
      // 重复请求幂等：返回同一份快照，不重复处理
      for (const attempt of run.attempts.filter(item => item.status === 'submitted')) {
        const outcome = provider.cancel({ provider_job_id: attempt.provider_job_id });
        attempt.provider_cancel = outcome.status;
        events.push(pushEvent(data, run, {
          stage: 'cancelled', status: 'provider_cancel', at: clock(), attemptId: attempt.id,
          payload: { provider_status: outcome.status, note: '本地停止无论如何都生效' },
        }));
      }
      return { run: serializeRun(run, data), events };
    }).then(result => {
      for (const event of result.events) emit(event);
      kick();
      return { run: result.run };
    });
  }

  // ---------- 需要用户确认追加预算时 ----------
  async function confirmBudget({ ctx, runId, extraCredits, confirm = true }) {
    if (!confirm) return cancelRun({ ctx, runId, reason: 'budget_not_confirmed' });
    if (!Number.isInteger(extraCredits) || extraCredits <= 0) {
      throw new ApiError(422, 'INVALID_CREDITS', '追加额度必须为正整数');
    }
    return store.mutate(data => {
      const run = findRun(data, ctx, runId);
      if (run.status !== 'awaiting_confirmation') {
        throw new ApiError(409, 'RUN_NOT_AWAITING', '任务当前不处于等待确认预算状态');
      }
      const additional = appendEntry(data, {
        type: 'reserve',
        amount: extraCredits,
        tenantId: ctx.tenantId,
        jobId: run.id,
        uniqueOperationKey: `reserve:${run.id}:extra:${run.pending_confirmation?.round ?? run.iteration}`,
        memo: '用户确认后追加的预算',
        actor: ctx.actorId,
        initialCredits,
        at: clock(),
      });
      if (additional.applied) run.budget.reserved_credits += extraCredits;
      run.pending_confirmation = null;
      run.status = 'running';
      pushEvent(data, run, { stage: 'budget_reserved', status: 'reserved_extra', at: clock(), payload: { amount: extraCredits } });
      return { run: serializeRun(run, data), events: eventsOf(data, run.id) };
    }).then(result => {
      for (const event of result.events) emit(event);
      kick();
      return result;
    });
  }

  // ---------- 单步推进（调度器每次 tick 调用一次） ----------
  async function advance(context = {}) {
    const at = context.at ?? clock();
    const activeIds = await store.read(data => Object.values(data.runs ?? {})
      .filter(run => ACTIVE_STATES.has(run.status))
      .map(run => run.id));
    let progressed = false;
    for (const runId of activeIds) {
      const changed = await stepRun(runId, at);
      if (changed) progressed = true;
    }
    notifyIdle();
    return progressed;
  }

  async function stepRun(runId, at) {
    const prepared = await store.read(data => {
      const run = data.runs?.[runId];
      return run && ACTIVE_STATES.has(run.status) ? { tenantId: run.tenant_id, uuid: run.id } : null;
    });
    if (!prepared) return false;

    const outcome = await store.mutate(async data => {
      const run = data.runs[runId];
      const events = [];
      const before = JSON.stringify(run);

      if (run.cancel_requested && run.status !== 'cancelled') {
        await finishCancelled(data, run, events, at);
        return { changed: JSON.stringify(run) !== before, events };
      }

      if (run.status === 'awaiting_confirmation') return { changed: false, events };

      const inflight = run.attempts.filter(attempt => attempt.status === 'submitted');
      for (const attempt of inflight) {
        const timedOut = new Date(at).getTime() - new Date(attempt.started_at).getTime() > attemptTimeoutMs;
        const polled = provider.poll({ provider_job_id: attempt.provider_job_id });
        if (polled.status === 'succeeded') {
          await settleAttemptSuccess(data, run, attempt, polled.result, events, at);
        } else if (polled.status === 'failed') {
          await settleAttemptFailure(data, run, attempt, { code: polled.code, message: polled.message, retryable: Boolean(polled.retryable) }, events, at);
        } else if (timedOut) {
          await settleAttemptFailure(data, run, attempt, { code: 'PROVIDER_TIMEOUT', message: '本地超时，未知调用不再等待', retryable: true }, events, at);
        } else {
          // queued / running / unknown：都不改变账面，unknown 绝不触发重提
          if (polled.status === 'unknown') {
            events.push(pushEvent(data, run, {
              stage: 'generation', status: 'provider_unknown', at, attemptId: attempt.id,
              payload: { code: polled.code, note: '未知不等于失败，不重复提交也不额外收费' },
            }));
          }
        }
      }

      if (run.attempts.length === 0) run.status = 'running';

      if (!run.cancel_requested) {
        await scheduleAttempts(data, run, events, at);
        await settleIfDone(data, run, events, at);
      }
      return { changed: JSON.stringify(run) !== before || events.length > 0, events };
    });
    for (const event of outcome.events) emit(event);
    return outcome.changed;
  }

  // 关键：缺 width/height etc.

  async function settleAttemptSuccess(data, run, attempt, result, events, at) {
    // 迟到结果：任务已请求取消后，供应商才返回成功 —— 只审计，不复活、不收费、不写产物
    if (run.cancel_requested) {
      attempt.status = 'late_result_ignored';
      attempt.ended_at = new Date(at).toISOString();
      events.push(pushEvent(data, run, {
        stage: 'cancelled', status: 'provider_late_result_ignored', at, attemptId: attempt.id,
        payload: { note: '取消后的迟到结果只进审计日志，不捕获费用也不产生可交付产物' },
      }));
      return;
    }
    attempt.status = 'succeeded';
    attempt.ended_at = new Date(at).toISOString();
    attempt.result = {
      provider: result.provider,
      model: result.model,
      model_version: result.model_version,
      provider_request_id: result.provider_request_id,
      latency_ms: result.latency_ms,
      output: { ...result.output, bytes: undefined },
      output_hash: result.output.sha256,
    };
    attempt.charged_credits = attempt.planned_credits;
    const file = await store.putBlob(result.output.bytes, result.output.sha256, 'png');
    attempt.output_file = { path: file, bytes: result.output.bytes.length, hash: result.output.sha256 };

    const capture = appendEntry(data, {
      type: 'capture',
      amount: attempt.planned_credits,
      tenantId: run.tenant_id,
      jobId: run.id,
      attemptId: attempt.id,
      uniqueOperationKey: `capture:${attempt.id}`,
      memo: `${attempt.deliverable_id} 第 ${attempt.iteration} 轮生成成功，按已发生阶段结算`,
      actor: 'system',
      initialCredits,
      at,
    });
    run.budget.captured_credits += capture.applied ? attempt.planned_credits : 0;
    const target = run.deliverables.find(item => item.deliverable_id === attempt.deliverable_id);
    if (target) { target.status = 'succeeded'; target.succeeded_attempt_id = attempt.id; }
    events.push(pushEvent(data, run, {
      stage: 'generation', status: 'attempt_succeeded', at, attemptId: attempt.id, iteration: attempt.iteration,
      payload: { deliverable_id: attempt.deliverable_id, credits: attempt.planned_credits, output_hash: result.output.sha256 },
    }));
  }

  async function settleAttemptFailure(data, run, attempt, error, events, at) {
    attempt.status = 'failed';
    attempt.ended_at = new Date(at).toISOString();
    attempt.error = error;
    attempt.charged_credits = 0;
    const target = run.deliverables.find(item => item.deliverable_id === attempt.deliverable_id);
    if (target) target.status = 'failed';
    // 供应商技术失败不向用户收费：该 attempt 的预算留在池里，终态时整体释放
    events.push(pushEvent(data, run, {
      stage: 'generation', status: 'attempt_failed', at, attemptId: attempt.id, iteration: attempt.iteration,
      payload: { deliverable_id: attempt.deliverable_id, ...error, charged: 0 },
    }));
  }

  async function scheduleAttempts(data, run, events, at) {
    const inflight = run.attempts.filter(attempt => attempt.status === 'submitted').length;
    let slots = Math.max(0, maxConcurrency - inflight);
    const pending = run.deliverables.filter(item => item.status === 'pending' || item.status === 'failed');
    for (const target of pending) {
      if (slots === 0) break;
      const attemptsUsed = run.attempts.filter(attempt => attempt.deliverable_id === target.deliverable_id).length;
      if (target.status === 'failed') {
        const last = [...run.attempts].reverse().find(attempt => attempt.deliverable_id === target.deliverable_id);
        if (!last || !isRetryable(last.error?.code)) continue;
        if (attemptsUsed >= run.budget.max_attempts) continue;
      }
      // 已提交但尚未结算的 attempt 也占用预算，否则并发回填可能超出预留额度
      const committed = run.attempts
        .filter(attempt => attempt.status === 'submitted')
        .reduce((sum, attempt) => sum + attempt.planned_credits, 0);
      const remaining = run.budget.reserved_credits - run.budget.captured_credits - run.budget.released_credits - committed;
      if (remaining < target.credits) {
        if (run.status !== 'awaiting_confirmation') {
          run.status = 'awaiting_confirmation';
          run.pending_confirmation = {
            deliverable_id: target.deliverable_id,
            needed_credits: target.credits - remaining,
            remaining_credits: remaining,
            round: attemptsUsed + 1,
            note: '预算不足且不会自动扩大，需用户确认追加或取消',
          };
          events.push(pushEvent(data, run, {
            stage: 'budget_reserved', status: 'awaiting_confirmation', at,
            payload: { ...run.pending_confirmation },
          }));
        }
        return;
      }

      const iteration = attemptsUsed + 1;
      if (iteration > run.iteration) run.iteration = iteration;
      target.status = 'running';
      const request = {
        request_hash: sha({
          run_id: run.id, deliverable_id: target.deliverable_id, iteration,
          spec_content_hash: run.spec_ref.content_hash,
        }),
        idempotency_key: `sub:${run.id}:${target.deliverable_id}:${iteration}`,
        deliverable_id: target.deliverable_id,
        target_width: 1024,
        target_height: 1024,
        references: 1,
        requires_subject_protection: true,
        mask_ref: `mask:${target.deliverable_id}`,
        scenario: run.scenario,
        run_id: run.id,
      };
      const handle = provider.submit(request);
      const attempt = {
        id: newId('atp'),
        run_id: run.id,
        deliverable_id: target.deliverable_id,
        iteration,
        status: 'submitted',
        provider_job_id: handle.provider_job_id,
        idempotency_key: request.idempotency_key,
        request_hash: request.request_hash,
        planned_credits: target.credits,
        charged_credits: 0,
        started_at: new Date(at).toISOString(),
        ended_at: null,
        result: null,
        error: null,
        scenario: run.scenario,
        provider_request: request,
      };
      run.attempts.push(attempt);
      target.attempts_used = iteration;
      slots -= 1;
      events.push(pushEvent(data, run, {
        stage: 'generation', status: 'attempt_submitted', at, attemptId: attempt.id, iteration,
        payload: { deliverable_id: attempt.deliverable_id, provider_job_id: handle.provider_job_id, idempotency_key: request.idempotency_key },
      }));
    }
    if (run.status === 'queued' && run.attempts.length > 0) {
      run.status = 'running';
      events.push(pushEvent(data, run, { stage: 'queued', status: 'running', at }));
    }
  }

  async function releaseRemaining(data, run, events, at, memo) {
    const remaining = run.budget.reserved_credits - run.budget.captured_credits - run.budget.released_credits;
    if (remaining <= 0) return;
    const released = appendEntry(data, {
      type: 'release',
      amount: remaining,
      tenantId: run.tenant_id,
      jobId: run.id,
      uniqueOperationKey: `release:${run.id}`,
      memo,
      actor: 'system',
      initialCredits,
      at,
    });
    if (released.applied) {
      run.budget.released_credits += remaining;
      events.push(pushEvent(data, run, {
        stage: 'settled', status: 'released', at,
        payload: { amount: remaining, balance: balanceOf(data, run.tenant_id, { initialCredits }) },
      }));
    }
  }

  async function settleIfDone(data, run, events, at) {
    if (run.cancel_requested) { await finishCancelled(data, run, events, at); return; }
    const inflight = run.attempts.some(attempt => attempt.status === 'submitted');
    if (run.status === 'awaiting_confirmation') return;
    if (inflight) return;

    // 还有可以开工的交付项就继续；否则必须落到明确终态，不允许任务悬着
    const lastAttemptOf = deliverableId => [...run.attempts].reverse()
      .find(attempt => attempt.deliverable_id === deliverableId);
    const actionable = run.deliverables.filter(item => {
      if (item.status === 'running') return true;
      if (item.status === 'pending') return true;
      if (item.status !== 'failed') return false;
      const last = lastAttemptOf(item.deliverable_id);
      return Boolean(last && isRetryable(last.error?.code) && item.attempts_used < run.budget.max_attempts);
    });
    if (actionable.length > 0) return;

    const pending = run.deliverables.filter(item => item.status === 'pending' || item.status === 'running');
    const failed = run.deliverables.filter(item => item.status === 'failed');
    const succeeded = run.deliverables.filter(item => item.status === 'succeeded');
    if (failed.length === 0) {
      run.status = 'completed';
      run.terminal_reason = 'all_deliverables_succeeded';
    } else if (failed.some(item => {
      const last = lastAttemptOf(item.deliverable_id);
      return last && !isRetryable(last.error?.code);
    })) {
      run.status = 'failed';
      run.terminal_reason = 'unrecoverable_generation_failure';
    } else {
      run.status = 'limit_reached';
      run.terminal_reason = 'attempt_or_budget_limit_reached';
    }
    run.pending_best = succeeded.map(item => item.deliverable_id);
    await releaseRemaining(data, run, events, at, '任务终态，释放未发生的额度');
    events.push(pushEvent(data, run, {
      stage: 'settled', status: run.status, at,
      payload: {
        terminal_reason: run.terminal_reason,
        succeeded: succeeded.map(item => item.deliverable_id),
        failed: failed.map(item => item.deliverable_id),
        captured_credits: run.budget.captured_credits,
        released_credits: run.budget.released_credits,
        quality_status: run.quality_status,
      },
    }));
  }

  async function finishCancelled(data, run, events, at) {
    const stillFlying = run.attempts.filter(attempt => attempt.status === 'submitted');
    if (stillFlying.length > 0) {
      // 先给供应商一次机会，把"取消后才返回的结果"审计掉，再落终态
      for (const attempt of stillFlying) {
        const polled = provider.poll({ provider_job_id: attempt.provider_job_id });
        if (polled.status === 'succeeded') await settleAttemptSuccess(data, run, attempt, polled.result, events, at);
        else attempt.status = 'abandoned';
      }
    }
    run.status = 'cancelled';
    run.terminal_reason = run.cancel_reason ?? 'user_cancelled';
    await releaseRemaining(data, run, events, at, '任务已取消，释放未发生的额度');
    events.push(pushEvent(data, run, {
      stage: 'cancelled', status: 'cancelled', at,
      payload: {
        reason: run.terminal_reason,
        captured_credits: run.budget.captured_credits,
        note: '已发生阶段照常结算，未发生部分已释放；迟到结果不会复活任务',
      },
    }));
  }

  // ---------- 启动恢复 ----------
  async function recover(at = clock()) {
    const interrupted = await store.read(data => Object.values(data.runs ?? {})
      .filter(run => ACTIVE_STATES.has(run.status))
      .map(run => ({ id: run.id, tenant_id: run.tenant_id, attempts: run.attempts.map(item => item.status) })));
    for (const summary of interrupted) {
      await store.mutate(data => {
        const run = data.runs[summary.id];
        const events = [];
        for (const attempt of run.attempts.filter(item => item.status === 'submitted')) {
          // 按幂等键重挂：不是新调用，也不会新增费用
          const handle = provider.submit(attempt.provider_request);
          attempt.provider_job_id = handle.provider_job_id;
          events.push(pushEvent(data, run, {
            stage: 'generation', status: 'recovered', at, attemptId: attempt.id,
            payload: { note: '进程恢复后按幂等键重挂供应商调用，未新增提交或费用' },
          }));
        }
        const hasSubmitted = run.attempts.some(item => item.status === 'submitted');
        if (!hasSubmitted && run.status === 'running') run.status = 'queued';
        return { events };
      }).then(result => { for (const event of result.events) emit(event); });
    }
    kick();
    return { recovered: interrupted.length };
  }

  // ---------- 调度器 ----------
  let timer = null;
  let waiters = [];
  let activeCount = 0;
  // 所有飞行中的异步任务（tick 与恢复流程）：停止时必须逐一等它们收尾，
  // 否则它们会在调用方清理数据目录后继续写盘
  const inFlight = new Set();

  function track(task) {
    const settled = task.then(() => inFlight.delete(settled), () => inFlight.delete(settled));
    inFlight.add(settled);
    return task;
  }

  function kick() {
    if (!running) return;
    if (activeCount > 0) return;
    scheduleTick();
  }

  function scheduleTick() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      activeCount += 1;
      void track((async () => {
        try {
          await advance();
        } catch { /* 调度异常不应击穿服务，下一 tick 继续 */ }
        activeCount -= 1;
        const hasActive = await store.read(data => Object.values(data.runs ?? {}).some(run => ACTIVE_STATES.has(run.status)));
        if (hasActive && running) scheduleTick();
        else notifyIdle();
        notifyIdle();
      })());
    }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    running = true;
    kick();
    void track(recover()); // 恢复流程可能长时间待在飞行中，同样需要被等住
  }

  /**
   * 停止调度器。返回的 Promise 会在所有飞行中的 tick 与恢复流程收尾后 resolve，
   * 调用方必须 await 它，之后才能安全清理数据目录。
   */
  async function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    await Promise.allSettled([...inFlight]);
  }

  async function waitIdle({ timeoutMs = 5_000 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const busy = await store.read(data => Object.values(data.runs ?? {}).some(run => ACTIVE_STATES.has(run.status)));
      if (!busy && !timer) return true;
      await new Promise(resolve => setTimeout(resolve, Math.max(5, Math.floor(tickMs / 2))));
    }
    return false;
  }

  function serializeRun(run, data) {
    const clone = structuredClone(run);
    for (const attempt of clone.attempts) {
      if (attempt.output_file) attempt.output_file = { bytes: attempt.output_file.bytes, hash: attempt.output_file.hash };
    }
    return {
      ...clone,
      events_tail: eventsOf(data, run.id, Math.max(0, run.last_sequence - 20)).map(event => ({
        sequence: event.sequence, event_id: event.event_id, stage: event.stage, status: event.status, timestamp: event.timestamp,
      })),
    };
  }

  function findRun(data, ctx, runId) {
    const run = data.runs?.[runId];
    if (!run || run.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
    return run;
  }

  async function getRun(ctx, runId) {
    return store.read(data => {
      const run = findRun(data, ctx, runId);
      return { run: serializeRun(run, data) };
    });
  }

  async function listRuns(ctx, projectId) {
    return store.read(data => ({
      runs: Object.values(data.runs ?? {})
        .filter(run => run.tenant_id === ctx.tenantId && (!projectId || run.project_id === projectId))
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .map(run => ({
          id: run.id,
          project_id: run.project_id,
          status: run.status,
          quality_status: run.quality_status,
          iteration: run.iteration,
          spec_version: run.spec_ref.version,
          cancel_requested: run.cancel_requested,
          created_at: run.created_at,
          updated_at: run.updated_at,
          terminal_reason: run.terminal_reason,
          last_sequence: run.last_sequence,
          budget: run.budget,
          deliverables: run.deliverables,
        })),
    }));
  }

  async function eventsSince(ctx, runId, sinceSequence = 0) {
    return store.read(data => {
      findRun(data, ctx, runId);
      return eventsOf(data, runId, sinceSequence);
    });
  }

  return {
    start, stop, createRun, cancelRun, confirmBudget, getRun, listRuns, eventsSince, recover, advance, subscribe, waitIdle,
    get activeSubscriptions() { return listeners.size; },
  };
}
