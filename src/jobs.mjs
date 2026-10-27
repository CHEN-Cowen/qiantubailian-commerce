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
import { EXTRA_COPY_CREDITS } from './pricing.mjs';
import { matchChannelRule, listChannelRules, ruleStatus } from './catalog.mjs';
import {
  MASK_VERSION, buildReferencePlan, checkReferenceCapacity, checkSubjectProtection, compositeSubject,
  createSubjectMask, makeFailedGenerationRecord, makeGenerationRecord, makeRejectedGenerationRecord,
} from './m06.mjs';
import {
  aggregateQualityStatus, applyHumanReview, computeReportValidity, evaluateGenerationQuality,
  makeQaFailureReport, presentReport,
} from './m07.mjs';
import {
  EXPORT_SCHEMA_VERSION, PACKAGE_FORMAT_VERSION, REVISION_MAX_NO_IMPROVEMENT, REVISION_MAX_ROUNDS,
  buildManifest, buildQaSummary, buildZip, compareRevisionOutcome, exportBundleName, exportRecordId,
  makeVersionRecord, planExport, planRevision, zipSha256,
} from './m08.mjs';
import {
  buildJointManifest, checkDetailPageValidity, evaluateVideoFrames, planPlatformDelivery, planVideo,
} from './m10.mjs';
import {
  buildOverlaySvg, compileExecutionPlan, compileRevisionInstruction, executionForDeliverable,
} from './execution.mjs';

export const RUN_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
export const QUALITY_NOT_CHECKED = 'not_checked';

const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const ACTIVE_STATES = new Set(['queued', 'running', 'evaluating', 'awaiting_confirmation']);
export const TERMINAL_STATES = new Set(['completed', 'limit_reached', 'failed', 'cancelled', 'needs_attention']);

/**
 * R02：attempt 的终态集合。
 * `unknown` 表示本地已超时/供应商查不到，但**不是**确认失败：保留 provider_job_id 继续查询，
 * 不换新请求、不释放预算、不标记交付失败。只有人工核对或供应商确认后才落 failed/succeeded。
 */
export const CONFIRMED_FAILURE_STATES = new Set(['failed']);

const RUN_STAGES = new Set([
  'spec_confirmed', 'budget_reserved', 'queued', 'generation',
  'hard_check', 'revision', 'human_review', 'export', 'settled', 'cancelled',
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
  // R04：OCR 适配器由宿主注入；未注入即"未配置"，文字检查保持 unknown
  ocr: ocrAdapter = null,
  clock = () => new Date(),
  initialCredits = 0,
  attemptTimeoutMs = 30_000,
  maxConcurrency = 2,
  tickMs = 25,
  revisionMaxRounds = REVISION_MAX_ROUNDS,
  // R02：未知调用的对账窗口。超过窗口仍未确认的调用转人工核对，不自动重提。
  unknownReconcileMs = null,
  // R02：供应商级与租户级并发上限。单任务并发上限不等于全局上限。
  providerMaxConcurrency = 4,
  tenantMaxConcurrency = 2,
} = {}) {
  if (!store) throw new Error('jobs 缺少存储实例');
  if (!provider) throw new Error('jobs 缺少 Provider');
  if (!Number.isInteger(providerMaxConcurrency) || providerMaxConcurrency < 1) throw new Error('供应商并发上限无效');
  if (!Number.isInteger(tenantMaxConcurrency) || tenantMaxConcurrency < 1) throw new Error('租户并发上限无效');
  const reconcileWindowMs = Number.isInteger(unknownReconcileMs) && unknownReconcileMs > 0
    ? unknownReconcileMs
    : attemptTimeoutMs * 6;
  const timers = new Set();
  let running = false;
  const wake = new Set();
  let idleWaiters = [];
  // M06：参考图 data URI 只在内存里用于提交，绝不写入 runs.json（体积过大）。
  // 进程重启后缓存为空；真实 Provider 会因此明确拒绝本轮提交，而不是静默少发参考图。
  const referenceCache = new Map();

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

  // ---------- M06：主体上下文（素材 → 掩码 → 参考图职责） ----------
  /**
   * 在创建任务时一次性准备好主体上下文：掩码、去背图、参考图职责与图序。
   * 任何一步不能确认就返回 available=false，由能力闸口决定拒绝还是模拟降级。
   * 去背图只落盘用于本地合成，不进入发送给供应商的参考列表。
   */
  async function prepareSubjectContext({ ctx, project }) {
    const assets = await store.read(data => Object.values(data.assets ?? {})
      .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id && item.role_status === 'active'));
    const subject = assets.find(item => item.role === 'subject') ?? null;
    const packaging = assets.find(item => item.role === 'packaging') ?? null;
    const styles = assets.filter(item => item.role === 'style');
    const capabilities = provider.capabilities();
    const maxReferences = Number.isFinite(capabilities.max_references) ? capabilities.max_references : Infinity;

    if (!subject) {
      return {
        protection: { available: false, reason: 'MISSING_SUBJECT_ASSET', message: '项目没有生效的主体素材，无法保证商品主体不被改写' },
        references: [], reference_images: [], dropped: [],
        // 模拟 Provider 允许降级演练，掩码引用会明确标注 simulated，绝不含糊成已验证
        mask_ref: capabilities.simulated === true ? 'mask:simulated:MISSING_SUBJECT_ASSET' : null,
      };
    }
    const subjectBytes = await store.readBlob(subject.sha256, subject.ext);
    if (!subjectBytes) {
      return {
        protection: { available: false, reason: 'SUBJECT_BLOB_MISSING', message: '主体素材文件已不可用，请重新上传后再生成' },
        references: [], reference_images: [], dropped: [],
        mask_ref: capabilities.simulated === true ? 'mask:simulated:SUBJECT_BLOB_MISSING' : null,
      };
    }
    const mask = createSubjectMask({ bytes: subjectBytes, mime: subject.mime, box: subject.subject_box ?? null });
    const plan = buildReferencePlan({
      subjectAsset: subject, packagingAsset: packaging, styleAssets: styles,
      cutoutSha256: mask.available && mask.cutout_sha256 ? mask.cutout_sha256 : null, maxReferences,
    });
    if (!mask.available) {
      return {
        protection: mask,
        references: plan.references,
        reference_images: [],
        dropped: plan.dropped,
        capacity_exceeded: plan.capacity_exceeded,
        required_count: plan.required_count,
        mask_ref: capabilities.simulated === true ? `mask:simulated:${mask.reason}` : null,
      };
    }

    const maskFile = await store.putBlob(mask.maskBytes, mask.sha256, 'png');
    const cutoutFile = mask.cutoutBytes
      ? await store.putBlob(mask.cutoutBytes, mask.cutout_sha256, 'png')
      : null;

    // 参考图按职责顺序转成 data URI；只有 sent_to_provider 的才编码，去背图永远不发送
    const referenceImages = [];
    for (const reference of plan.references) {
      if (reference.sent_to_provider === false || !reference.asset_id) continue;
      const asset = assets.find(item => item.id === reference.asset_id);
      if (!asset) continue;
      const bytes = await store.readBlob(asset.sha256, asset.ext);
      if (!bytes) continue;
      referenceImages.push({
        index: reference.index,
        role: reference.role,
        asset_id: reference.asset_id,
        mime: asset.mime,
        data_uri: `data:${asset.mime};base64,${bytes.toString('base64')}`,
      });
    }

    return {
      protection: {
        ...mask,
        ref: `mask:verified:${mask.sha256}`,
        mask_file: maskFile,
        cutout_file: cutoutFile,
      },
      mask_ref: `mask:verified:${mask.sha256}`,
      mask_sha256: mask.sha256,
      mask_coverage: mask.coverage,
      mask_method: mask.method,
      cutout_sha256: mask.cutout_sha256,
      cutout_file: cutoutFile,
      references: plan.references,
      reference_images: referenceImages,
      dropped: plan.dropped,
      capacity_exceeded: plan.capacity_exceeded,
      required_count: plan.required_count,
    };
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

    // M06：创建时只记录 Provider 能力声明；真正的请求级能力校验在每次提交前做，
    // 因为尺寸、参考图与掩码要等具体交付物确定后才能比对。
    const capabilities = provider.capabilities();
    const validation = {
      ok: true,
      checked_at: new Date(clock()).toISOString(),
      capabilities,
    };

    // M06：先备好主体上下文再做能力闸口。真实 Provider 如果既不能接掩码、
    // 也不能做已验收的本地合成，就在创建阶段直接拒绝（422），不入队、不收费。
    const subjectContext = await prepareSubjectContext({ ctx, project });
    const protectionGate = checkSubjectProtection({
      capabilities, protection: subjectContext.protection, required: true,
    });
    if (!protectionGate.ok) {
      throw new ApiError(422, protectionGate.code, protectionGate.message, protectionGate.details);
    }
    const capacityGate = checkReferenceCapacity({ capabilities, plan: subjectContext });
    if (!capacityGate.ok) {
      throw new ApiError(422, capacityGate.code, capacityGate.message, capacityGate.details);
    }

    // data URI 只在内存里保留给本轮提交使用，不进持久化
    referenceCache.set(run.id, subjectContext.reference_images ?? []);
    // R04：把冻结快照编译成执行计划。配置若没进入请求，生成结果就无法解释，
    // 因此计划与请求哈希都绑定这份编译结果，而不是复制一句静态提示词。
    const compileInputs = await store.read(data => ({
      truth: Object.values(data.truth_versions ?? {}).find(item =>
        item.tenant_id === ctx.tenantId && item.project_id === project.id
        && item.version === spec.product_truth?.version) ?? null,
      brandKitVersion: spec.brand_kit
        ? Object.values(data.brand_kit_versions ?? {}).find(item =>
          item.tenant_id === ctx.tenantId && item.brand_kit_id === spec.brand_kit.id
          && item.version === spec.brand_kit.version) ?? null
        : null,
    }));
    const executionPlan = compileExecutionPlan({
      project, spec, truth: compileInputs.truth, brandKitVersion: compileInputs.brandKitVersion,
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
        // R03：体验额度只能服务它绑定的第一个商品
        projectId: project.id,
      });
      if (!reserve.applied) throw new Error('预算预留未生效');

      const specDeliverables = new Map((spec.deliverables ?? []).map(item => [item.id, item]));
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
        // M08：导出清单要能追到任务创建时的平台规则版本；来源未核验的状态一并保留
        rule_ref: (() => {
          const matched = spec.channel?.platform
            ? matchChannelRule({ platform: spec.channel.platform, category: project.category ?? '', at: clock() })
            : { rule: null, status: 'missing' };
          return {
            platform: spec.channel?.platform ?? null,
            rule_id: matched.rule?.id ?? null,
            version: matched.rule?.version ?? null,
            status: matched.status ?? null,
            source_verified: matched.rule?.source?.verified === true,
          };
        })(),
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
        // R04：执行计划随任务冻结，导出文字层、复核与重放都以它为准
        execution: {
          version: executionPlan.version,
          content_hash: executionPlan.content_hash,
          text_policy: executionPlan.text_policy,
          plan: executionPlan,
        },
        deliverables: quote.lines.flatMap(line => {
          const detail = specDeliverables.get(line.deliverable_id) ?? null;
          // R02：交付数量必须展开成可单独追踪的图片项，报价、生成、检查、导出核对同一张数。
          // 第 1 张沿用原 deliverable_id（版本/导出契约不变），其余按 #2…#n 追加。
          const units = Math.max(1, Number(line.count) || 1);
          return Array.from({ length: units }, (_, index) => {
            const unit = index + 1;
            return {
              deliverable_id: units === 1 ? line.deliverable_id : `${line.deliverable_id}#${unit}`,
              template_deliverable_id: line.deliverable_id,
              label: units === 1 ? line.label : `${line.label}（第 ${unit}/${units} 张）`,
              type: line.type ?? detail?.type ?? null,
              // 每一张都按 1 张交付，数量不再藏在单条记录里
              count: 1,
              unit_index: unit,
              unit_total: units,
              // 报价总额不变：第 1 张含基础价与文字块，后续每张按追加价计
              credits: unit === 1 ? line.credits - (units - 1) * EXTRA_COPY_CREDITS : EXTRA_COPY_CREDITS,
              // M06：实际尺寸与格式取自冻结快照，不再硬编码 1024×1024
              width: detail?.width ?? 1024,
              height: detail?.height ?? 1024,
              ratio: detail?.ratio ?? null,
              formats: Array.isArray(detail?.formats) ? [...detail.formats] : ['png'],
              // R04：提示词来自编译结果（事实、品牌、构图、平台、文字层），不是静态模板
              prompt: (() => {
                const compiled = executionForDeliverable(executionPlan, { deliverableId: line.deliverable_id });
                const base = compiled?.prompt ?? `生成「${line.label}」；商品主体必须与参考图完全一致，不得改变形状、文字、Logo 与颜色。`;
                return units === 1
                  ? base
                  : `${base}\n【同组一致】这是第 ${unit}/${units} 张，必须与同组其他图片保持一致的风格、光线与构图语言。`;
              })(),
              execution_ref: {
                version: executionPlan.version,
                content_hash: executionPlan.content_hash,
                template_deliverable_id: line.deliverable_id,
              },
              status: 'pending',
              attempts_used: 0,
              succeeded_attempt_id: null,
              // M08：当前选用的版本，回退时只改这里与 versions[].active
              active_version_id: null,
              revision: null,
            };
          });
        }),
        // M06：主体保护要求与允许的变换（区域与变换版本随任务冻结，后续可追溯）
        subject_protection: {
          required: true,
          mode: protectionGate.mode,
          mask_version: MASK_VERSION,
          protected_regions: ['shape', 'text', 'logo', 'color'],
          allowed_transforms: ['lighting', 'shadow'],
          warning: protectionGate.warning ?? null,
          note: '商品主体、包装文字与 Logo 优先保留原始像素；允许的光照/阴影变换会被记录',
        },
        // 掩码哈希、参考图职责与图序随任务冻结；去背图只用于本地合成，不发送给供应商
        subject_context: {
          mode: protectionGate.mode,
          warning: protectionGate.warning ?? null,
          available: subjectContext.protection?.available === true,
          reason: subjectContext.protection?.available === true ? null : subjectContext.protection?.reason ?? null,
          message: subjectContext.protection?.available === true ? null : subjectContext.protection?.message ?? null,
          mask_ref: subjectContext.mask_ref ?? null,
          mask_sha256: subjectContext.mask_sha256 ?? null,
          mask_coverage: subjectContext.mask_coverage ?? null,
          mask_method: subjectContext.mask_method ?? null,
          cutout_sha256: subjectContext.cutout_sha256 ?? null,
          references: subjectContext.references ?? [],
          // 只落盘载荷元信息；base64 留在 referenceCache，避免把 runs.json 撑大
          reference_images: (subjectContext.reference_images ?? []).map(({ data_uri, ...rest }) => rest),
          reference_payload_ready: (subjectContext.reference_images ?? []).length > 0,
          dropped: subjectContext.dropped ?? [],
          required_count: subjectContext.required_count ?? 0,
        },
        generation_record_ids: [],
        attempts: [],
        // M08：版本只增不改；active 标记决定当前选用版，回退只切标记
        versions: [],
        // M08：自动修订受轮数、预算与"连续无改善"三重限制，绝不自动扩大预算
        revision: {
          enabled: capabilities.supports_revision === true,
          provider_support: capabilities.supports_revision === true,
          max_rounds: Math.max(1, Number(revisionMaxRounds) || REVISION_MAX_ROUNDS),
          max_credits: Math.max(0, Math.floor(quote.max_credits * 0.6)),
          round: 0,
          spent_credits: 0,
          no_improvement_streak: 0,
          history: [],
          stop_reason: capabilities.supports_revision === true ? null : 'provider_unsupported',
          note: capabilities.supports_revision === true
            ? '仅修订机器可判断的硬失败，一次一个关键项；通过项保留'
            : '当前 Provider 未声明修订能力，不会假装自动修订；阻断项需人工处理或更换 Provider',
        },
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
      // 未知调用也要尝试撤销，避免恢复后又被供应商执行
      for (const attempt of run.attempts.filter(item =>
        item.status === 'submitted' || item.status === 'unknown')) {
        let outcome;
        try { outcome = provider.cancel({ provider_job_id: attempt.provider_job_id }); } catch { outcome = { status: 'cannot_cancel' }; }
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

  /**
   * R02：未知调用的人工收口入口。
   * 只有任务处于 needs_attention，或存在未知 attempt 时可用；结果写入事件与账本，可追溯。
   */
  async function reconcileRun({ ctx, runId, outcome, note = '' }) {
    if (!['provider_failed', 'provider_succeeded_unavailable', 'cancelled'].includes(outcome)) {
      throw new ApiError(422, 'INVALID_RECONCILE_OUTCOME', '核对结论必须是 provider_failed、provider_succeeded_unavailable 或 cancelled');
    }
    const result = await store.mutate(async data => {
      const run = findRun(data, ctx, runId);
      const events = [];
      const unknown = run.attempts.filter(attempt => attempt.status === 'unknown');
      if (run.status !== 'needs_attention' && unknown.length === 0) {
        throw new ApiError(409, 'RUN_NOT_NEEDS_ATTENTION', '任务不存在待核对的未知调用');
      }
      if (outcome === 'cancelled') {
        // 取消路径复用统一收尾：释放未发生额度，迟到结果不再复活
        return { run, events, cancel: true };
      }
      for (const attempt of unknown) {
        if (outcome === 'provider_failed') {
          attempt.status = 'failed';
          attempt.ended_at = new Date(clock()).toISOString();
          attempt.error = {
            code: 'PROVIDER_FAILED_CONFIRMED',
            message: note || '人工核对确认供应商未产生结果',
            retryable: false,
            confirmed_by: ctx.actorId,
          };
          const target = run.deliverables.find(item => item.deliverable_id === attempt.deliverable_id);
          if (target && target.status !== 'succeeded') target.status = 'failed';
          events.push(pushEvent(data, run, {
            stage: 'generation', status: 'reconciled_failed', at: clock(), attemptId: attempt.id,
            payload: { note: note || '人工核对确认供应商未产生结果，按失败释放额度', actor: ctx.actorId },
          }));
          continue;
        }
        // 供应商确认已产出但结果无法取回：成本真实发生，内部额度按已发生阶段结算
        attempt.status = 'succeeded_unavailable';
        attempt.ended_at = new Date(clock()).toISOString();
        const capture = appendEntry(data, {
          type: 'capture',
          amount: attempt.planned_credits,
          tenantId: run.tenant_id,
          jobId: run.id,
          attemptId: attempt.id,
          uniqueOperationKey: `capture:${attempt.id}`,
          memo: '人工核对确认供应商已产出但结果不可取回，按已发生阶段结算',
          actor: ctx.actorId,
          initialCredits,
          at: clock(),
        });
        run.budget.captured_credits += capture.applied ? attempt.planned_credits : 0;
        const target = run.deliverables.find(item => item.deliverable_id === attempt.deliverable_id);
        if (target && target.status !== 'succeeded') target.status = 'failed';
        const record = makeFailedGenerationRecord({
          run, attempt, request: attempt.provider_request ?? {}, provider: attempt.provider_meta ?? {},
          error: {
            code: 'RESULT_UNAVAILABLE',
            message: note || '人工核对确认供应商已产出但结果不可取回',
            retryable: false,
          },
          at: clock(),
        });
        record.cost = {
          billing_unit: 'internal_credit',
          internal_credits: attempt.planned_credits,
          provider_cost: null,
          note: '供应商成本已发生；真实账单金额待供应商结算单核对',
        };
        data.generation_records[record.id] = record;
        run.generation_record_ids.push(record.id);
        events.push(pushEvent(data, run, {
          stage: 'generation', status: 'reconciled_result_unavailable', at: clock(), attemptId: attempt.id,
          payload: {
            note: note || '人工核对确认已产出但结果不可取回，按已发生阶段结算',
            actor: ctx.actorId, charged: attempt.planned_credits, generation_record_id: record.id,
          },
        }));
      }
      refreshRunQuality(data, run);
      await releaseRemaining(data, run, events, clock(), '人工核对后释放未发生的额度');
      run.status = 'failed';
      run.terminal_reason = outcome === 'provider_failed' ? 'provider_failed_confirmed' : 'provider_result_unavailable';
      run.attention = { ...(run.attention ?? {}), resolved_at: new Date(clock()).toISOString(), resolved_by: ctx.actorId, outcome };
      referenceCache.delete(run.id);
      events.push(pushEvent(data, run, {
        stage: 'settled', status: 'reconciled', at: clock(),
        payload: {
          terminal_reason: run.terminal_reason,
          outcome,
          captured_credits: run.budget.captured_credits,
          released_credits: run.budget.released_credits,
        },
      }));
      return { run: serializeRun(run, data), events };
    });
    for (const event of result.events ?? []) emit(event);
    if (result.cancel) return cancelRun({ ctx, runId, reason: 'attention_reconciled_cancelled' });
    return { run: result.run };
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
        projectId: run.project_id,
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

      const inflight = run.attempts.filter(attempt =>
        attempt.status === 'submitted' || attempt.status === 'unknown');
      for (const attempt of inflight) {
        const startedAt = new Date(attempt.started_at).getTime();
        const ageMs = new Date(at).getTime() - startedAt;
        const timedOut = ageMs > attemptTimeoutMs;
        let polled;
        try {
          polled = provider.poll({ provider_job_id: attempt.provider_job_id });
        } catch (error) {
          // 供应商查单不可用时不能当作免费失败：保留原调用，转入未知等待人工核对
          polled = {
            status: 'unknown',
            code: error?.code ?? 'PROVIDER_POLL_ERROR',
            message: error?.message ?? '供应商查单失败',
          };
        }
        if (polled.status === 'succeeded') {
          await settleAttemptSuccess(data, run, attempt, polled.result, events, at);
        } else if (polled.status === 'failed') {
          await settleAttemptFailure(data, run, attempt, { code: polled.code, message: polled.message, retryable: Boolean(polled.retryable) }, events, at);
        } else if (attempt.status === 'submitted' && timedOut) {
          // R02：本地超时只把调用标记为未知，保留 provider_job_id 继续查询；
          // 不释放预算、不标记失败、不换新请求重提。
          attempt.status = 'unknown';
          attempt.unknown_since = new Date(at).toISOString();
          attempt.unknown_reason = 'LOCAL_TIMEOUT';
          attempt.provider_job_id = attempt.provider_job_id ?? null;
          events.push(pushEvent(data, run, {
            stage: 'generation', status: 'provider_timeout_unknown', at, attemptId: attempt.id,
            payload: {
              code: 'PROVIDER_TIMEOUT_UNKNOWN',
              provider_job_id: attempt.provider_job_id,
              note: '本地超时，原供应商调用仍在查询；未确认失败前不重复提交、不释放预算、不标记交付失败',
            },
          }));
        } else if (polled.status === 'unknown') {
          // 供应商明确查不到或查单失败：同样保留原调用，累计窗口后转人工
          if (attempt.status === 'submitted') {
            attempt.status = 'unknown';
            attempt.unknown_since = new Date(at).toISOString();
            attempt.unknown_reason = polled.code ?? 'PROVIDER_UNKNOWN';
          }
          events.push(pushEvent(data, run, {
            stage: 'generation', status: 'provider_unknown', at, attemptId: attempt.id,
            payload: {
              code: polled.code ?? 'PROVIDER_UNKNOWN',
              provider_job_id: attempt.provider_job_id,
              note: '未知不等于失败，不重复提交也不额外收费',
            },
          }));
        }
        // 未知调用超过对账窗口仍未确认：停止自动推进，转人工核对，预算保持冻结。
        // 窗口从"进入未知"算起（而不是提交时刻），避免本地超时本身就吃掉大半个窗口。
        const unknownAgeMs = new Date(at).getTime() - new Date(attempt.unknown_since ?? attempt.started_at).getTime();
        if (attempt.status === 'unknown' && unknownAgeMs > reconcileWindowMs) {
          await requireAttention(data, run, attempt, events, at);
          return { changed: true, events };
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
    const target = run.deliverables.find(item => item.deliverable_id === attempt.deliverable_id);

    // M06：声明本地合成能力时，用掩码把原始商品像素贴回生成图；否则保持供应商原图
    let outputBytes = result.output.bytes;
    let composite = null;
    if (run.subject_context?.mode === 'composite' && run.subject_context.cutout_sha256) {
      const cutout = await store.readBlob(run.subject_context.cutout_sha256, 'png');
      const mask = run.subject_context.mask_sha256
        ? await store.readBlob(run.subject_context.mask_sha256, 'png') : null;
      const composed = compositeSubject({ outputBytes, cutoutBytes: cutout, maskBytes: mask });
      composite = {
        available: composed.available,
        applied: composed.applied === true,
        reason: composed.reason ?? null,
        sha256: composed.sha256 ?? null,
        meta: composed.meta ?? null,
      };
      if (composed.applied) outputBytes = composed.bytes;
    }

    // 扩展名以供应商实际格式为准；只有本地合成或供应商未声明格式时才回落 png
    const ext = composite?.applied ? 'png' : (result.output.format ?? 'png');
    const outputHash = composite?.applied ? composite.sha256 : result.output.sha256;
    const requestedFormats = target?.formats ?? ['png'];
    const formatContract = {
      requested: [...requestedFormats],
      actual: ext,
      satisfied: requestedFormats.includes(ext),
      note: '以实际输出格式为准；不一致时记录但不篡改供应商产物',
    };

    attempt.result = {
      provider: result.provider ?? attempt.provider_meta?.id ?? null,
      model: result.model,
      model_version: result.model_version,
      provider_request_id: result.provider_request_id,
      provider_job_id: attempt.provider_job_id,
      latency_ms: result.latency_ms,
      usage: result.usage ?? null,
      cost: result.cost ?? null,
      provider_meta: attempt.provider_meta,
      output: { ...result.output, bytes: undefined, format: ext, sha256: outputHash },
      output_hash: outputHash,
      format_contract: formatContract,
      subject_protection: attempt.subject_protection,
      composite,
    };
    attempt.charged_credits = attempt.planned_credits;
    const file = await store.putBlob(outputBytes, outputHash, ext);
    attempt.output_file = { path: file, bytes: outputBytes.length, hash: outputHash, format: ext };

    // M06：每次真实/模拟调用都留一条可追溯生成记录
    const record = makeGenerationRecord({
      run, attempt, request: attempt.provider_request, provider: attempt.provider_meta,
      result: { ...result, model: result.model, model_version: result.model_version },
      output: { format: ext, width: result.output.width, height: result.output.height, bytes: outputBytes, sha256: outputHash },
      protection: attempt.subject_protection,
      composite: composite ? { applied: composite.applied, sha256: composite.sha256, ...(composite.meta ?? {}) } : null,
      at,
    });
    record.format_contract = formatContract;
    data.generation_records[record.id] = record;
    run.generation_record_ids.push(record.id);

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
    if (target) { target.status = 'succeeded'; target.succeeded_attempt_id = attempt.id; }
    events.push(pushEvent(data, run, {
      stage: 'generation', status: 'attempt_succeeded', at, attemptId: attempt.id, iteration: attempt.iteration,
      payload: {
        deliverable_id: attempt.deliverable_id, credits: attempt.planned_credits,
        output_hash: outputHash, generation_record_id: record.id,
        provider: record.provider, simulated: record.provider_meta.simulated,
        subject_protection: record.subject_protection.mode,
        format_satisfied: formatContract.satisfied,
      },
    }));

    // M07：产出文件立刻做 Commerce QA；质量结论独立于"生成成功"，
    // 检查结果写入 quality_reports 并驱动 run.quality_status。
    const report = await evaluateAttemptQuality(data, run, attempt, target, {
      outputBytes, ext, outputHash, composite, recordId: record.id,
    }, events, at);

    // M08：每个成功产物都留版本；同交付物的旧版本转为历史，不删除、不覆盖
    const version = makeVersionRecord({
      run, attempt, deliverable: target, report,
      output: {
        sha256: outputHash, format: ext,
        width: result.output?.width ?? null, height: result.output?.height ?? null,
        bytes: outputBytes.length,
      },
      at,
    });
    for (const previous of run.versions) {
      if (previous.deliverable_id !== version.deliverable_id || !previous.active) continue;
      previous.active = false;
      previous.superseded_at = version.created_at;
    }
    run.versions.push(version);
    if (target) {
      target.active_version_id = version.id;
      target.revision = null;
    }
    events.push(pushEvent(data, run, {
      stage: 'generation', status: 'version_created', at, attemptId: attempt.id, iteration: attempt.iteration,
      payload: {
        deliverable_id: version.deliverable_id, version_id: version.id, number: version.number,
        report_id: report.id, hash: outputHash,
      },
    }));

    if (attempt.revision && run.revision) {
      const before = data.quality_reports?.[attempt.revision.based_on_report_id] ?? null;
      const outcome = compareRevisionOutcome({
        beforeReport: before, afterReport: report, actions: attempt.revision.actions ?? [],
      });
      run.revision.spent_credits += capture.applied ? attempt.planned_credits : 0;
      run.revision.history.push({
        round: attempt.revision.round,
        deliverable_id: attempt.deliverable_id,
        actions: attempt.revision.actions ?? [],
        preserve_checks: attempt.revision.preserve_checks ?? [],
        before_version_id: attempt.revision.based_on_version_id ?? null,
        before_report_id: attempt.revision.based_on_report_id ?? null,
        after_version_id: version.id,
        after_report_id: report.id,
        credits: attempt.planned_credits,
        reason: attempt.revision.reason ?? null,
        outcome: {
          improved: outcome.improved,
          resolved: outcome.resolved,
          still_failing: outcome.still_failing,
          regressions: outcome.regressions,
          retained: outcome.retained,
          before_decision: outcome.before_decision,
          after_decision: outcome.after_decision,
        },
        at: new Date(at).toISOString(),
      });
      run.revision.no_improvement_streak = outcome.improved ? 0 : run.revision.no_improvement_streak + 1;
      events.push(pushEvent(data, run, {
        stage: 'revision', status: outcome.improved ? 'improved' : 'no_improvement', at,
        attemptId: attempt.id, iteration: attempt.iteration,
        payload: {
          round: attempt.revision.round,
          deliverable_id: attempt.deliverable_id,
          actions: (attempt.revision.actions ?? []).map(item => item.code),
          resolved: outcome.resolved,
          still_failing: outcome.still_failing,
          regressions: outcome.regressions,
          retained_count: outcome.retained.length,
          no_improvement_streak: run.revision.no_improvement_streak,
        },
      }));
      if (run.revision.no_improvement_streak >= REVISION_MAX_NO_IMPROVEMENT) {
        run.revision.stop_reason = 'no_improvement';
      }
    }
    refreshRunQuality(data, run);
  }

  // ---------- M07：生成后 Commerce QA 与人工复核 ----------
  // QA 只读冻结快照和真实输出文件；不信任供应商"已完成"之类的口头状态。

  function specOfRun(data, run) {
    if (!run) return null;
    return Object.values(data.specs ?? {}).find(item =>
      item.tenant_id === run.tenant_id && item.project_id === run.project_id
      && item.version === run.spec_ref?.version) ?? null;
  }

  function truthOfRun(data, run, spec) {
    if (!run) return null;
    const version = spec?.product_truth?.version ?? null;
    if (!version) return null;
    return Object.values(data.truth_versions ?? {}).find(item =>
      item.tenant_id === run.tenant_id && item.project_id === run.project_id
      && item.version === version) ?? null;
  }

  function channelOfRun(data, run, spec, at) {
    const project = data.projects?.[run?.project_id] ?? null;
    if (!spec?.channel?.platform) {
      return { rule: null, status: 'missing', reasons: ['未选择目标平台，无法匹配平台规则'] };
    }
    return matchChannelRule({ platform: spec.channel.platform, category: project?.category ?? '', at });
  }

  function activeAssetsOf(data, run) {
    return Object.values(data.assets ?? {}).filter(item =>
      item.tenant_id === run.tenant_id && item.project_id === run.project_id
      && item.role_status === 'active');
  }

  /** 任务级质量只汇总"当前选用版本"的最新报告，并区分"还没有报告"与"检查通过"。 */
  function refreshRunQuality(data, run) {
    const activeReportIds = new Set((run.versions ?? []).filter(item => item.active).map(item => item.report_id));
    const reports = Object.values(data.quality_reports ?? {}).filter(item =>
      item.tenant_id === run.tenant_id && item.run_id === run.id && activeReportIds.has(item.id));
    const succeeded = run.deliverables.filter(item => item.status === 'succeeded').length;
    run.quality_status = aggregateQualityStatus(reports, {
      requireAllDeliverables: true,
      deliverableCount: succeeded,
    });
  }

  async function evaluateAttemptQuality(data, run, attempt, target, {
    outputBytes, ext, outputHash, composite, recordId,
  }, events, at) {
    const spec = specOfRun(data, run);
    const truth = truthOfRun(data, run, spec);
    const channel = channelOfRun(data, run, spec, at);
    const maskBytes = run.subject_context?.mask_sha256
      ? await store.readBlob(run.subject_context.mask_sha256, 'png') : null;
    const cutoutBytes = run.subject_context?.cutout_sha256
      ? await store.readBlob(run.subject_context.cutout_sha256, 'png') : null;
    // R04：OCR 已配置时对成品做真实文字核对；未配置则为 unknown，不伪造识别结果。
    // OCR 失败不能阻断交付流程本身，只能把该项标记为 unknown 等待人工复核。
    let ocr = null;
    if ((truth?.critical_text ?? []).length > 0 && ocrAdapter) {
      try {
        ocr = await ocrAdapter.recognize({ bytes: outputBytes, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` });
      } catch (error) {
        ocr = { status: 'error', reason: error?.message ?? 'OCR_CALL_FAILED', lines: [] };
      }
    }
    let report;
    try {
      report = evaluateGenerationQuality({
        run, deliverable: target, attempt, spec, truth, channel,
        output: {
          bytes: outputBytes,
          format: ext,
          sha256: outputHash,
          width: attempt.result?.output?.width,
          height: attempt.result?.output?.height,
        },
        subject: { maskBytes, cutoutBytes, composite },
        assets: activeAssetsOf(data, run),
        ocr,
        now: at,
      });
    } catch (error) {
      // 检查器自身异常同样不能算通过：落一条"待复核"，并由人工在修复后重检
      report = makeQaFailureReport({ run, deliverable: target, attempt, spec, truth, error, now: at });
    }
    report.generation_record_id = recordId ?? null;
    data.quality_reports[report.id] = report;
    attempt.quality_report_id = report.id;
    if (target) target.quality_report_id = report.id;
    if (recordId && data.generation_records[recordId]) data.generation_records[recordId].qa_report_id = report.id;
    refreshRunQuality(data, run);
    events.push(pushEvent(data, run, {
      stage: 'hard_check', status: report.decision, at, attemptId: attempt.id, iteration: attempt.iteration,
      payload: {
        deliverable_id: attempt.deliverable_id,
        report_id: report.id,
        machine_decision: report.machine_decision,
        decision: report.decision,
        blocked_codes: (report.decision_reasons?.blocked ?? []).map(item => item.code),
        review_required: (report.decision_reasons?.review_required ?? []).map(item => item.code),
        platform_compliance: report.platform_compliance,
        quality_status: run.quality_status,
      },
    }));
    return report;
  }

  async function settleAttemptFailure(data, run, attempt, error, events, at) {
    attempt.status = 'failed';
    attempt.ended_at = new Date(at).toISOString();
    attempt.error = error;
    attempt.charged_credits = 0;
    const target = run.deliverables.find(item => item.deliverable_id === attempt.deliverable_id);
    if (target) target.status = 'failed';
    // M06：供应商失败也留生成记录（未产生输出、不收费），便于后续对账与复盘
    const providerMeta = attempt.provider_meta ?? { id: 'unknown', version: null, simulated: false, acceptance: 'not_verified' };
    const record = makeFailedGenerationRecord({
      run, attempt, request: attempt.provider_request ?? {}, provider: providerMeta, error, at,
    });
    data.generation_records[record.id] = record;
    run.generation_record_ids.push(record.id);
    // 供应商技术失败不向用户收费：该 attempt 的预算留在池里，终态时整体释放
    events.push(pushEvent(data, run, {
      stage: 'generation', status: 'attempt_failed', at, attemptId: attempt.id, iteration: attempt.iteration,
      payload: {
        deliverable_id: attempt.deliverable_id, ...error, charged: 0,
        generation_record_id: record.id, simulated: providerMeta.simulated === true,
      },
    }));
  }

  async function scheduleAttempts(data, run, events, at) {
    // R02：并发上限分三层。单任务上限只约束本任务，供应商与租户上限约束全局。
    let providerInFlight = 0;
    let tenantInFlight = 0;
    for (const other of Object.values(data.runs ?? {})) {
      const flying = other.attempts.filter(attempt => attempt.status === 'submitted').length;
      providerInFlight += flying;
      if (other.tenant_id === run.tenant_id) tenantInFlight += flying;
    }
    if (providerInFlight >= providerMaxConcurrency || tenantInFlight >= tenantMaxConcurrency) {
      // 触达上限只是延后，不是失败：保持 queued/running，下一 tick 继续
      if (run.queued_reason !== 'provider_rate_limit') {
        run.queued_reason = 'provider_rate_limit';
        run.rate_limited_count = (run.rate_limited_count ?? 0) + 1;
        events.push(pushEvent(data, run, {
          stage: 'generation', status: 'rate_limited', at,
          payload: {
            provider_in_flight: providerInFlight,
            provider_max_concurrency: providerMaxConcurrency,
            tenant_in_flight: tenantInFlight,
            tenant_max_concurrency: tenantMaxConcurrency,
            note: '触达供应商或租户并发上限，本 tick 不再提交新调用',
          },
        }));
      }
      return;
    }
    delete run.queued_reason;
    const inflight = run.attempts.filter(attempt => attempt.status === 'submitted').length;
    let slots = Math.max(0, maxConcurrency - inflight);
    const pending = run.deliverables.filter(item => item.status === 'pending' || item.status === 'failed');
    for (const target of pending) {
      if (slots === 0) break;
      if (providerInFlight >= providerMaxConcurrency || tenantInFlight >= tenantMaxConcurrency) break;
      const attemptsUsed = run.attempts.filter(attempt => attempt.deliverable_id === target.deliverable_id).length;
      if (target.status === 'failed') {
        const last = [...run.attempts].reverse().find(attempt => attempt.deliverable_id === target.deliverable_id);
        if (!last || !isRetryable(last.error?.code)) continue;
        if (attemptsUsed >= run.budget.max_attempts) continue;
      }
      // 已提交但尚未结算的 attempt 也占用预算，否则并发回填可能超出预留额度
      const committed = run.attempts
        .filter(attempt => attempt.status === 'submitted' || attempt.status === 'unknown')
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
      const capabilities = provider.capabilities();
      const referenceImages = referenceCache.get(run.id) ?? [];
      const sentReferenceCount = run.subject_context?.references?.filter(item => item.sent_to_provider !== false).length ?? 0;
      const request = {
        request_hash: sha({
          run_id: run.id, deliverable_id: target.deliverable_id, iteration,
          spec_content_hash: run.spec_ref.content_hash,
          width: target.width, height: target.height,
          // R04：执行计划哈希进入请求哈希，配置变化必须产生不同请求
          execution_hash: run.execution?.content_hash ?? null,
        }),
        idempotency_key: `sub:${run.id}:${target.deliverable_id}:${iteration}`,
        deliverable_id: target.deliverable_id,
        // M06：尺寸与格式来自交付清单，参考图数量来自职责计划，掩码引用来自真实掩码校验
        target_width: target.width,
        target_height: target.height,
        formats: [...target.formats],
        prompt: target.prompt,
        // R04：结构化执行指令与文字层一起下发，Provider 可按能力使用或拒绝
        execution: (() => {
          const compiled = executionForDeliverable(run.execution?.plan, { deliverableId: target.deliverable_id });
          return compiled
            ? {
              version: run.execution.version,
              content_hash: run.execution.content_hash,
              instruction: compiled,
              text_policy: run.execution.text_policy,
            }
            : null;
        })(),
        references: sentReferenceCount,
        reference_plan: run.subject_context?.references ?? [],
        reference_images: referenceImages,
        reference_payload_ready: referenceImages.length >= sentReferenceCount,
        requires_subject_protection: run.subject_protection?.required === true,
        mask_ref: run.subject_context?.mask_ref ?? null,
        mask_version: MASK_VERSION,
        subject_cutout_sha256: run.subject_context?.cutout_sha256 ?? null,
        composite_ratio: run.subject_context?.composite_ratio ?? null,
        scenario: run.scenario,
        run_id: run.id,
      };

      // 能力闸口：Provider 声明不接受这份请求就明确拒绝，不提交、不收费、留拒绝记录
      const validation = provider.validate(request);
      if (!validation?.ok) {
        const gate = {
          code: validation?.code ?? 'UNSUPPORTED_CAPABILITY',
          message: validation?.message ?? 'Provider 拒绝了该请求',
          details: validation?.details ?? null,
        };
        const record = makeRejectedGenerationRecord({
          run, attempt: { id: newId('atp'), deliverable_id: target.deliverable_id, iteration }, request,
          provider: { id: capabilities.id, version: capabilities.version, simulated: capabilities.simulated === true, acceptance: capabilities.acceptance },
          gate, at,
        });
        data.generation_records[record.id] = record;
        run.generation_record_ids.push(record.id);
        target.status = 'failed';
        events.push(pushEvent(data, run, {
          stage: 'generation', status: 'request_rejected', at, iteration,
          payload: {
            deliverable_id: target.deliverable_id, code: gate.code, message: gate.message,
            generation_record_id: record.id, provider: capabilities.id, charged: 0,
          },
        }));
        return;
      }

      const handle = provider.submit(request);
      const providerMeta = handle.provider_meta ?? {
        id: capabilities.id, version: capabilities.version,
        simulated: capabilities.simulated === true, acceptance: capabilities.acceptance ?? 'not_verified',
      };
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
        // 请求体落盘时剔除 base64 载荷，只保留职责、哈希与就绪标记
        provider_request: {
          ...request,
          reference_images: request.reference_images.map(({ data_uri, ...rest }) => rest),
        },
        // M06：每次调用都写明用哪个 Provider 版本、主体保护走哪条路径
        provider_meta: providerMeta,
        subject_protection: {
          mode: run.subject_context?.mode ?? 'not_required',
          mask: run.subject_context?.mask_ref
            ? {
              ref: run.subject_context.mask_ref,
              sha256: run.subject_context.mask_sha256 ?? null,
              version: MASK_VERSION,
              coverage: run.subject_context.mask_coverage ?? null,
              method: run.subject_context.mask_method ?? null,
              verified: run.subject_context.mask_ref.startsWith('mask:verified:'),
            }
            : null,
          warning: run.subject_context?.warning ?? null,
        },
       };
      run.attempts.push(attempt);
      target.attempts_used = iteration;
      slots -= 1;
      providerInFlight += 1;
      tenantInFlight += 1;
      events.push(pushEvent(data, run, {
        stage: 'generation', status: 'attempt_submitted', at, attemptId: attempt.id, iteration,
        payload: {
          deliverable_id: attempt.deliverable_id, provider_job_id: handle.provider_job_id,
          idempotency_key: request.idempotency_key, provider: providerMeta.id,
          subject_protection: attempt.subject_protection.mode,
        },
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

  /**
   * M08 自动修订：只处理机器可判断的硬失败，一次只提交一个关键项。
   * 三重闸口：Provider 能力、修订轮数/额度、连续无改善。任何一项触发都停，不扩预算。
   * 返回状态供 settleIfDone 决定是否进入终态。
   */
  async function scheduleRevisions(data, run, events, at) {
    const revision = run.revision;
    if (!revision || revision.enabled !== true || revision.stop_reason) return 'none';
    if (revision.no_improvement_streak >= REVISION_MAX_NO_IMPROVEMENT) {
      revision.stop_reason = 'no_improvement';
      return 'none';
    }

    for (const target of run.deliverables) {
      if (target.status !== 'succeeded') continue;
      const version = run.versions.find(item =>
        item.active && item.deliverable_id === target.deliverable_id) ?? null;
      if (!version) continue;
      const report = data.quality_reports?.[version.report_id] ?? null;
      if (!report || report.decision !== 'blocked') continue;
      const plan = planRevision({ report, deliverable: target });
      if (!plan.revise) continue;

      if (revision.round >= revision.max_rounds) {
        revision.stop_reason = 'max_rounds';
        events.push(pushEvent(data, run, {
          stage: 'revision', status: 'stopped', at,
          payload: { stop_reason: 'max_rounds', round: revision.round, max_rounds: revision.max_rounds },
        }));
        return 'none';
      }
      const attemptsUsed = run.attempts.filter(attempt => attempt.deliverable_id === target.deliverable_id).length;
      const creditsNeeded = target.credits;
      if (run.budget.captured_credits + run.budget.released_credits + creditsNeeded > run.budget.reserved_credits) {
        revision.stop_reason = 'budget_exhausted';
        events.push(pushEvent(data, run, {
          stage: 'revision', status: 'stopped', at,
          payload: {
            stop_reason: 'budget_exhausted', deliverable_id: target.deliverable_id,
            captured_credits: run.budget.captured_credits, reserved_credits: run.budget.reserved_credits,
          },
        }));
        return 'none';
      }
      if (revision.spent_credits + creditsNeeded > revision.max_credits) {
        revision.stop_reason = 'revision_budget';
        events.push(pushEvent(data, run, {
          stage: 'revision', status: 'stopped', at,
          payload: {
            stop_reason: 'revision_budget', spent_credits: revision.spent_credits,
            max_credits: revision.max_credits, deliverable_id: target.deliverable_id,
          },
        }));
        return 'none';
      }

      // 修订同样要遵守尝试上限，且不自动扩预算；预算不足时进入待确认而不是偷偷扣
      const committed = run.attempts.filter(attempt => attempt.status === 'submitted')
        .reduce((sum, attempt) => sum + attempt.planned_credits, 0);
      const remaining = run.budget.reserved_credits - run.budget.captured_credits
        - run.budget.released_credits - committed;
      if (remaining < creditsNeeded) {
        run.status = 'awaiting_confirmation';
        run.pending_confirmation = {
          deliverable_id: target.deliverable_id,
          needed_credits: creditsNeeded - remaining,
          remaining_credits: remaining,
          round: revision.round + 1,
          kind: 'revision',
          note: '修订预算不足，不会自动扩大；需用户确认追加或接受当前结果',
        };
        events.push(pushEvent(data, run, {
          stage: 'revision', status: 'awaiting_confirmation', at,
          payload: { ...run.pending_confirmation, action: plan.actions.map(item => item.code) },
        }));
        return 'needs_confirmation';
      }

      revision.round += 1;
      const iteration = attemptsUsed + 1;
      if (iteration > run.iteration) run.iteration = iteration;
      const capabilities = provider.capabilities();
      const sentReferenceCount = run.subject_context?.references
        ?.filter(item => item.sent_to_provider !== false).length ?? 0;
      // R04：修订指令具体到错误码与必须保留项；Provider 拿到的是可执行的修订要求，不是"再试一次"
      const revisionInstruction = compileRevisionInstruction({
        actions: plan.actions, preserveChecks: plan.preserve_checks, round: revision.round + 1,
      });
      const request = {
        request_hash: sha({
          run_id: run.id, deliverable_id: target.deliverable_id, iteration,
          spec_content_hash: run.spec_ref.content_hash,
          width: target.width, height: target.height,
          execution_hash: run.execution?.content_hash ?? null,
          revision_round: revision.round, revision_action: plan.actions[0].code,
          revision_instruction_hash: revisionInstruction.hash,
        }),
        idempotency_key: `sub:${run.id}:${target.deliverable_id}:${iteration}`,
        deliverable_id: target.deliverable_id,
        target_width: target.width,
        target_height: target.height,
        formats: [...target.formats],
        prompt: target.prompt,
        references: sentReferenceCount,
        reference_plan: run.subject_context?.references ?? [],
        reference_images: referenceCache.get(run.id) ?? [],
        reference_payload_ready: (referenceCache.get(run.id) ?? []).length >= sentReferenceCount,
        requires_subject_protection: run.subject_protection?.required === true,
        mask_ref: run.subject_context?.mask_ref ?? null,
        mask_version: MASK_VERSION,
        subject_cutout_sha256: run.subject_context?.cutout_sha256 ?? null,
        composite_ratio: run.subject_context?.composite_ratio ?? null,
        scenario: run.scenario,
        run_id: run.id,
        // M08：修订请求显式带上要解决的问题与必须保留的通过项
        revision: {
          round: revision.round,
          actions: plan.actions,
          preserve_checks: plan.preserve_checks,
          based_on_report_id: report.id,
          based_on_version_id: version.id,
          instruction: revisionInstruction,
        },
      };
      const validation = provider.validate(request);
      if (!validation?.ok) {
        revision.stop_reason = 'provider_unsupported';
        events.push(pushEvent(data, run, {
          stage: 'revision', status: 'request_rejected', at,
          payload: {
            code: validation?.code ?? 'UNSUPPORTED_CAPABILITY',
            message: validation?.message ?? 'Provider 拒绝修订请求',
          },
        }));
        return 'none';
      }

      const handle = provider.submit(request);
      const providerMeta = handle.provider_meta ?? {
        id: capabilities.id, version: capabilities.version,
        simulated: capabilities.simulated === true, acceptance: capabilities.acceptance ?? 'not_verified',
      };
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
        provider_request: {
          ...request,
          reference_images: request.reference_images.map(({ data_uri, ...rest }) => rest),
        },
        provider_meta: providerMeta,
        subject_protection: {
          mode: run.subject_context?.mode ?? 'not_required',
          mask: run.subject_context?.mask_ref
            ? {
              ref: run.subject_context.mask_ref,
              sha256: run.subject_context.mask_sha256 ?? null,
              version: MASK_VERSION,
              coverage: run.subject_context.mask_coverage ?? null,
              method: run.subject_context.mask_method ?? null,
              verified: run.subject_context.mask_ref.startsWith('mask:verified:'),
            }
            : null,
          warning: run.subject_context?.warning ?? null,
        },
        revision: {
          round: revision.round,
          actions: plan.actions,
          preserve_checks: plan.preserve_checks,
          based_on_report_id: report.id,
          based_on_version_id: version.id,
          reason: plan.reason,
        },
      };
      run.attempts.push(attempt);
      target.attempts_used = iteration;
      target.status = 'running';
      target.revision = {
        round: revision.round,
        actions: plan.actions,
        preserve_checks: plan.preserve_checks,
        based_on_report_id: report.id,
        based_on_version_id: version.id,
        reason: plan.reason,
      };
      if (run.status === 'queued') run.status = 'running';
      events.push(pushEvent(data, run, {
        stage: 'revision', status: 'requested', at, attemptId: attempt.id, iteration,
        payload: {
          round: revision.round,
          deliverable_id: target.deliverable_id,
          actions: plan.actions.map(item => ({ code: item.code, parameters: item.parameters })),
          preserve_checks: plan.preserve_checks,
          based_on_report_id: report.id,
          based_on_version_id: version.id,
          credits: target.credits,
          provider: providerMeta.id,
        },
      }));
      return 'queued';
    }
    return 'none';
  }

  async function settleIfDone(data, run, events, at) {
    if (run.cancel_requested) { await finishCancelled(data, run, events, at); return; }
    const inflight = run.attempts.some(attempt =>
      attempt.status === 'submitted' || attempt.status === 'unknown');
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

    // M08：所有交付物都有结果后，先尝试自动修订可修复的硬失败，再落终态
    const revised = await scheduleRevisions(data, run, events, at);
    if (revised === 'queued' || revised === 'needs_confirmation') return;

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
    // M07：终态前按最新报告重算质量结论，避免报告与任务状态不一致
    refreshRunQuality(data, run);
    await releaseRemaining(data, run, events, at, '任务终态，释放未发生的额度');
    referenceCache.delete(run.id);
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

  /** 未知调用超过对账窗口：任务停在待核对，预算继续冻结，等待人工出口。 */
  async function requireAttention(data, run, attempt, events, at) {
    if (run.status === 'needs_attention') return;
    run.status = 'needs_attention';
    run.terminal_reason = 'provider_result_unknown';
    run.attention = {
      reason: 'PROVIDER_RESULT_UNKNOWN',
      attempt_id: attempt.id,
      deliverable_id: attempt.deliverable_id,
      provider_job_id: attempt.provider_job_id ?? null,
      unknown_since: attempt.unknown_since ?? null,
      reconcile_window_ms: reconcileWindowMs,
      reserved_credits: run.budget.reserved_credits,
      options: ['provider_failed', 'provider_succeeded_unavailable'],
      note: '供应商结果长期未知：不自动重提、不释放预算、不标记交付完成；核对后由有权限成员人工收口',
      at: new Date(at).toISOString(),
    };
    referenceCache.delete(run.id);
    events.push(pushEvent(data, run, {
      stage: 'generation', status: 'needs_attention', at, attemptId: attempt.id,
      payload: { ...run.attention },
    }));
    events.push(pushEvent(data, run, {
      stage: 'settled', status: 'needs_attention', at,
      payload: {
        terminal_reason: run.terminal_reason,
        captured_credits: run.budget.captured_credits,
        reserved_credits: run.budget.reserved_credits,
        note: '未知调用占用预算直到人工核对，避免把未知伪装成免费失败',
      },
    }));
  }

  async function finishCancelled(data, run, events, at) {
    const stillFlying = run.attempts.filter(attempt =>
      attempt.status === 'submitted' || attempt.status === 'unknown');
    if (stillFlying.length > 0) {
      // 先给供应商一次机会，把"取消后才返回的结果"审计掉，再落终态
      for (const attempt of stillFlying) {
        let polled;
        try { polled = provider.poll({ provider_job_id: attempt.provider_job_id }); } catch { polled = { status: 'unknown' }; }
        if (polled.status === 'succeeded') await settleAttemptSuccess(data, run, attempt, polled.result, events, at);
        else attempt.status = 'abandoned';
      }
    }
    run.status = 'cancelled';
    run.terminal_reason = run.cancel_reason ?? 'user_cancelled';
    await releaseRemaining(data, run, events, at, '任务已取消，释放未发生的额度');
    referenceCache.delete(run.id);
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
    // 参考图的 data URI 只在提交时用，返回给前端只会撑大响应；保留职责与哈希即可
    if (clone.subject_context?.reference_images) {
      clone.subject_context.reference_images = clone.subject_context.reference_images
        .map(({ data_uri, ...rest }) => rest);
    }
    const records = (run.generation_record_ids ?? [])
      .map(id => data.generation_records?.[id]).filter(Boolean);
    // R02：供应商成本与用户额度分账展示。真实账单未接入时如实标记为未上报。
    const internalCharged = records.reduce((sum, record) =>
      sum + (Number(record.cost?.internal_credits) || 0), 0);
    const providerCosts = records
      .map(record => record.cost?.provider_cost).filter(value => value !== null && value !== undefined);
    const supplierCost = {
      records: records.length,
      succeeded: records.filter(record => record.status === 'succeeded').length,
      failed: records.filter(record => record.status === 'failed').length,
      rejected: records.filter(record => record.status === 'rejected').length,
      revision_calls: records.filter(record => Boolean(record.request_hash && record.revision_round)).length,
      internal_credits_charged: internalCharged,
      provider_cost_reported: providerCosts.length > 0,
      provider_cost_records: providerCosts.length,
      note: providerCosts.length > 0
        ? '供应商成本按供应商回传字段记录，真实金额以结算单为准'
        : '供应商成本未回传金额，仅记录用量；真实账单以结算单为准',
    };
    const expectedUnits = run.deliverables.reduce((sum, item) => sum + (Number(item.count) || 1), 0);
    const producedUnits = run.deliverables
      .filter(item => item.status === 'succeeded')
      .reduce((sum, item) => sum + (Number(item.count) || 1), 0);
    return {
      ...clone,
      supplier_cost: supplierCost,
      // 交付完整性独立于任务状态：少图不能算完整交付
      delivery_completeness: {
        expected_units: expectedUnits,
        produced_units: producedUnits,
        missing_units: Math.max(0, expectedUnits - producedUnits),
        complete: producedUnits >= expectedUnits && expectedUnits > 0,
        note: producedUnits >= expectedUnits && expectedUnits > 0
          ? '全部交付项均已产出'
          : '存在缺项，导出只能按部分交付标注',
      },
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

  // ---------- M06：生成记录 ----------
  async function listGenerationRecords(ctx, { runId = null, projectId = null } = {}) {
    return store.read(data => {
      if (runId) findRun(data, ctx, runId);
      return {
        records: Object.values(data.generation_records ?? {})
          .filter(record => record.tenant_id === ctx.tenantId)
          .filter(record => !runId || record.run_id === runId)
          .filter(record => !projectId || record.project_id === projectId)
          .sort((left, right) => right.created_at.localeCompare(left.created_at)),
      };
    });
  }

  async function getGenerationRecord(ctx, recordId) {
    return store.read(data => {
      const record = data.generation_records?.[recordId];
      if (!record || record.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '生成记录不存在');
      // 记录只增不改；这里顺带带上所属任务的当前状态，便于前端同屏展示
      const run = data.runs?.[record.run_id] ?? null;
      return {
        record,
        run: run && run.tenant_id === ctx.tenantId
          ? { id: run.id, status: run.status, project_id: run.project_id, deliverables: run.deliverables }
          : null,
      };
    });
  }

  // ---------- M07：质量报告读取与人工复核 ----------
  function latestTruthOfProject(data, tenantId, projectId) {
    let latest = null;
    for (const item of Object.values(data.truth_versions ?? {})) {
      if (item.tenant_id !== tenantId || item.project_id !== projectId) continue;
      if (!latest || item.version > latest.version) latest = item;
    }
    return latest;
  }

  function reportSnapshotContext(data, report) {
    const spec = Object.values(data.specs ?? {}).find(item =>
      item.tenant_id === report.tenant_id && item.project_id === report.project_id
      && item.version === report.spec_ref?.version) ?? null;
    // 有效性判断必须对照*当前*事实与套件；报告里的 truth_ref 只是生成时的冻结证据。
    const truth = latestTruthOfProject(data, report.tenant_id, report.project_id);
    const project = data.projects?.[report.project_id] ?? null;
    const channel = spec?.channel?.platform
      ? matchChannelRule({ platform: spec.channel.platform, category: project?.category ?? '', at: clock() })
      : { rule: null, status: 'missing', reasons: ['未选择目标平台，无法匹配平台规则'] };
    const kit = report.brand_kit_ref ? data.brand_kits?.[report.brand_kit_ref.id] ?? null : null;
    return {
      spec,
      truth,
      channel,
      brandKitVersion: kit?.version ?? null,
      run: data.runs?.[report.run_id] ?? null,
    };
  }

  async function buildQualityReportView(report) {
    const context = await store.read(data => reportSnapshotContext(data, report));
    let outputExists = false;
    if (report.output_file?.hash) {
      const blob = await store.readBlob(report.output_file.hash, report.output_file.format ?? 'png');
      outputExists = Boolean(blob);
    }
    const validity = computeReportValidity({
      report,
      spec: context.spec,
      truth: context.truth,
      brandKitVersion: context.brandKitVersion,
      channel: context.channel,
      outputExists,
    });
    return {
      report: presentReport(report, validity),
      run: context.run
        ? {
          id: context.run.id,
          status: context.run.status,
          quality_status: context.run.quality_status,
          terminal_reason: context.run.terminal_reason ?? null,
        }
        : null,
    };
  }

  async function listQualityReports(ctx, { runId = null, projectId = null } = {}) {
    const reports = await store.read(data => {
      if (runId) findRun(data, ctx, runId);
      return Object.values(data.quality_reports ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .filter(item => !runId || item.run_id === runId)
        .filter(item => !projectId || item.project_id === projectId)
        .sort((left, right) => String(right.checked_at).localeCompare(String(left.checked_at)));
    });
    const views = await Promise.all(reports.map(report => buildQualityReportView(report)));
    return { reports: views.map(view => view.report), total: views.length };
  }

  async function getQualityReport(ctx, reportId) {
    const report = await store.read(data => {
      const found = data.quality_reports?.[reportId];
      if (!found || found.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '质量报告不存在');
      }
      return found;
    });
    return buildQualityReportView(report);
  }

  /**
   * 人工复核：只允许裁决"unknown 且可裁决"的检查项，并记录人、理由与证据。
   * 报告若已失效（事实/规则/文件变化）必须先重新检查，不能对旧报告做确认。
   */
  async function reviewQualityReport(ctx, reportId, { decisions = [], note = null } = {}) {
    const outcome = await store.mutate(async data => {
      const report = data.quality_reports?.[reportId];
      if (!report || report.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '质量报告不存在');
      }
      const context = reportSnapshotContext(data, report);
      let outputExists = false;
      if (report.output_file?.hash) {
        outputExists = Boolean(await store.readBlob(report.output_file.hash, report.output_file.format ?? 'png'));
      }
      const validity = computeReportValidity({
        report,
        spec: context.spec,
        truth: context.truth,
        brandKitVersion: context.brandKitVersion,
        channel: context.channel,
        outputExists,
      });
      if (validity.validity !== 'current') {
        throw new ApiError(409, 'REPORT_STALE', '质量报告已失效，需重新检查后再复核', { reasons: validity.reasons });
      }
      applyHumanReview(report, { reviewer: ctx.actorId, decisions, note, now: clock() });
      const run = context.run;
      if (run) {
        refreshRunQuality(data, run);
        pushEvent(data, run, {
          stage: 'human_review', status: 'reviewed', at: clock(),
          payload: {
            report_id: report.id,
            reviewer: ctx.actorId,
            codes: decisions.map(item => item.code),
            decision: report.decision,
            quality_status: run.quality_status,
          },
        });
      }
      return { report_id: report.id };
    });
    return getQualityReport(ctx, outcome.report_id);
  }

  // ---------- M08：版本、回退与正式导出 ----------

  async function reportValidityIn(data, report) {
    if (!report) return { validity: 'unknown', reasons: ['报告不存在'] };
    const context = reportSnapshotContext(data, report);
    let outputExists = false;
    if (report.output_file?.hash) {
      outputExists = Boolean(await store.readBlob(report.output_file.hash, report.output_file.format ?? 'png'));
    }
    return computeReportValidity({
      report,
      spec: context.spec,
      truth: context.truth,
      brandKitVersion: context.brandKitVersion,
      channel: context.channel,
      outputExists,
    });
  }

  async function listRunVersions(ctx, runId) {
    const payload = await store.read(data => {
      const run = findRun(data, ctx, runId);
      return {
        run_id: run.id,
        quality_status: run.quality_status,
        revision: run.revision ?? null,
        versions: [...(run.versions ?? [])]
          .sort((left, right) => left.number - right.number)
          .map(item => ({
            ...item,
            current: item.deliverable_id
              ? run.deliverables.find(target => target.deliverable_id === item.deliverable_id)?.active_version_id === item.id
              : item.active,
          })),
      };
    });
    return payload;
  }

  /**
   * 回退：只切换 active 标记，不删除旧版本、不改写旧报告。
   * 回退后质量结论按被选中版本的报告重算；旧报告若已失效则任务质量立即降级。
   */
  async function activateVersion(ctx, runId, versionId) {
    const outcome = await store.mutate(data => {
      const run = findRun(data, ctx, runId);
      const version = (run.versions ?? []).find(item => item.id === versionId);
      if (!version) throw new ApiError(404, 'NOT_FOUND', '版本不存在');
      const target = run.deliverables.find(item => item.deliverable_id === version.deliverable_id);
      if (!target) throw new ApiError(404, 'NOT_FOUND', '版本对应的交付物不存在');
      const previousId = target.active_version_id;
      if (previousId === version.id) {
        throw new ApiError(409, 'VERSION_ALREADY_ACTIVE', '该版本已经是当前选用版本');
      }
      const at = clock();
      for (const item of run.versions) {
        if (item.deliverable_id !== version.deliverable_id) continue;
        item.active = item.id === version.id;
        if (item.active) item.superseded_at = null;
        else if (!item.superseded_at) item.superseded_at = new Date(at).toISOString();
      }
      target.active_version_id = version.id;
      target.succeeded_attempt_id = version.attempt_id ?? target.succeeded_attempt_id;
      refreshRunQuality(data, run);
      pushEvent(data, run, {
        stage: 'revision', status: 'version_activated', at,
        payload: {
          deliverable_id: version.deliverable_id,
          version_id: version.id,
          previous_version_id: previousId,
          report_id: version.report_id,
          quality_status: run.quality_status,
        },
      });
      return { version: version.id, deliverable_id: version.deliverable_id };
    });
    return getRun(ctx, runId).then(run => ({ run, activated: outcome }));
  }

  async function createExport(ctx, runId, { scope = 'complete' } = {}) {
    if (scope !== 'complete' && scope !== 'partial') {
      throw new ApiError(422, 'INVALID_SCOPE', '导出范围只能是 complete 或 partial');
    }
    const record = await store.mutate(async data => {
      const run = findRun(data, ctx, runId);
      // 没有产物或仍在执行的任务不允许导出，避免把半成品当正式包
      if (ACTIVE_STATES.has(run.status)) {
        throw new ApiError(409, 'RUN_NOT_TERMINAL', '任务尚未结束，不能导出');
      }
      const reports = Object.fromEntries((run.versions ?? [])
        .map(item => [item.id, data.quality_reports?.[item.report_id] ?? null])
        .filter(([, value]) => Boolean(value)));
      const validities = {};
      for (const version of run.versions ?? []) {
        const report = data.quality_reports?.[version.report_id] ?? null;
        validities[version.report_id] = await reportValidityIn(data, report);
      }
      const spec = specOfRun(data, run);
      const plan = planExport({
        run,
        versions: run.versions ?? [],
        reports: Object.fromEntries(Object.entries(reports).map(([id, report]) => [report.id, report])),
        validities,
        scope,
      });
      if (!plan.ok) {
        throw new ApiError(409, plan.code, plan.message, {
          missing: plan.missing, stale: plan.stale, scope,
        });
      }

      const at = clock();
      const manifest = buildManifest({ run, spec, plan, provider: provider.capabilities(), now: at });
      // R04：文字与 Logo 用可编辑排版层交付；生成图不负责绘制精确文字
      manifest.text_policy = run.execution?.text_policy ?? null;
      manifest.execution = run.execution
        ? { version: run.execution.version, content_hash: run.execution.content_hash }
        : null;
      const summary = buildQaSummary({ run, plan, now: at });
      const entries = [];
      for (const { version, deliverable } of plan.included) {
        const bytes = await store.readBlob(version.hash, version.format ?? 'png');
        if (!bytes) {
          throw new ApiError(409, 'EXPORT_FILE_MISSING', `交付物 ${deliverable.deliverable_id} 的文件已不可读取`);
        }
        entries.push({ name: `images/${deliverable.deliverable_id}.${version.format ?? 'png'}`, bytes });
        const compiled = executionForDeliverable(run.execution?.plan, { deliverableId: deliverable.deliverable_id });
        const layers = compiled?.text_layers ?? [];
        const manifestEntry = manifest.assets.find(item => item.deliverable_id === deliverable.deliverable_id);
        if (manifestEntry) {
          manifestEntry.text_layers = layers;
          manifestEntry.missing_text = compiled?.missing_text ?? [];
        }
        if (layers.length > 0) {
          const mime = version.format === 'jpg' ? 'image/jpeg' : `image/${version.format ?? 'png'}`;
          const svg = buildOverlaySvg({
            width: version.width, height: version.height, mime, bytes,
            layers, title: deliverable.label ?? deliverable.deliverable_id,
          });
          entries.push({ name: `overlays/${deliverable.deliverable_id}.svg`, bytes: Buffer.from(svg) });
          if (manifestEntry) manifestEntry.overlay_file = `overlays/${deliverable.deliverable_id}.svg`;
        }
      }
      entries.push({ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) });
      entries.push({ name: 'qa-summary.json', bytes: Buffer.from(JSON.stringify(summary, null, 2)) });
      const zip = buildZip(entries, { now: at });
      const packageHash = zipSha256(zip);
      const file = await store.putBlob(zip, packageHash, 'zip');
      const exportRecord = {
        id: exportRecordId(),
        schema_version: EXPORT_SCHEMA_VERSION,
        package_format: PACKAGE_FORMAT_VERSION,
        tenant_id: run.tenant_id,
        project_id: run.project_id,
        run_id: run.id,
        scope,
        complete: plan.complete === true,
        status: plan.code,
        message: plan.message,
        package_filename: exportBundleName(run, scope, at),
        package_sha256: packageHash,
        package_bytes: zip.length,
        package_path: file,
        manifest,
        qa_summary: summary,
        included: plan.included.map(item => ({
          deliverable_id: item.deliverable.deliverable_id,
          version_id: item.version.id,
          hash: item.version.hash,
          format: item.version.format,
        })),
        missing: plan.missing ?? [],
        platform_compliance: 'not_claimed',
        content_hash_scope: manifest.content_hash_scope,
        created_by: ctx.actorId,
        created_at: new Date(at).toISOString(),
      };
      data.exports[exportRecord.id] = exportRecord;
      pushEvent(data, run, {
        stage: 'export', status: scope, at,
        payload: {
          export_id: exportRecord.id, scope, complete: exportRecord.complete,
          package_sha256: packageHash, included: exportRecord.included.length,
          missing: exportRecord.missing.length,
        },
      });
      return { id: exportRecord.id };
    });
    return getExport(ctx, record.id);
  }

  async function listExports(ctx, { runId = null, projectId = null } = {}) {
    const items = await store.read(data => {
      if (runId) findRun(data, ctx, runId);
      return Object.values(data.exports ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .filter(item => !runId || item.run_id === runId)
        .filter(item => !projectId || item.project_id === projectId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .map(item => ({
          id: item.id,
          kind: item.kind ?? 'images',
          run_id: item.run_id,
          scope: item.scope,
          complete: item.complete,
          status: item.status,
          package_filename: item.package_filename,
          package_sha256: item.package_sha256,
          package_bytes: item.package_bytes,
          included: item.included,
          missing: item.missing,
          platform_compliance: item.platform_compliance,
          created_at: item.created_at,
        }));
    });
    return { exports: items, total: items.length };
  }

  async function getExport(ctx, exportId) {
    const item = await store.read(data => {
      const found = data.exports?.[exportId];
      if (!found || found.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '导出记录不存在');
      }
      return { ...found, package_path: undefined };
    });
    return { export: { ...item, download_url: `/api/exports/${item.id}/download` } };
  }

  async function readExportPackage(ctx, exportId) {
    const item = await store.read(data => {
      const found = data.exports?.[exportId];
      if (!found || found.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '导出记录不存在');
      }
      return found;
    });
    const bytes = await store.readBlob(item.package_sha256, 'zip');
    if (!bytes) throw new ApiError(410, 'EXPORT_FILE_GONE', '导出包文件已不可读取');
    return { bytes, filename: item.package_filename, sha256: item.package_sha256 };
  }

  // ---------- M10：首帧视频、帧检查与联合导出 ----------

  const PROJECT_SHOT_ROLES = new Set(['subject', 'packaging', 'detail']);

  function findProjectIn(data, ctx, projectId) {
    const project = data.projects?.[projectId] ?? null;
    if (!project || project.tenant_id !== ctx.tenantId) {
      throw new ApiError(404, 'NOT_FOUND', '项目不存在');
    }
    return project;
  }

  function projectSnapshot(data, project) {
    const newest = (items, key) => (items ?? [])
      .filter(item => item.tenant_id === project.tenant_id && item.project_id === project.id)
      .sort((left, right) => right[key] - left[key])[0] ?? null;
    const spec = newest(Object.values(data.specs ?? {}), 'version');
    const truth = newest(Object.values(data.truth_versions ?? {}), 'version');
    const brandKit = spec?.brand_kit
      ? Object.values(data.brand_kit_versions ?? {})
        .filter(item => item.brand_kit_id === spec.brand_kit.id)
        .sort((left, right) => right.version - left.version)[0] ?? null
      : null;
    const assets = Object.values(data.assets ?? {})
      .filter(item => item.tenant_id === project.tenant_id && item.project_id === project.id);
    const channel = matchChannelRule({
      platform: spec?.channel?.platform ?? project.platform ?? '',
      category: project.category ?? '',
      at: clock(),
    });
    return { spec, truth, brandKit, assets, channel };
  }

  /**
   * 首帧归一化。只有"已发布且有效"的图片版本，或生效的主体/包装/细节素材，才算有效首帧。
   * 风格图、待复核版本、失效素材都返回 available=false，由 planVideo 阻断。
   */
  async function resolveFirstFrame(data, ctx, project, input = {}) {
    const kind = String(input?.kind ?? '').trim();
    if (kind === 'asset') {
      const asset = data.assets?.[String(input.asset_id ?? '')] ?? null;
      if (!asset || asset.tenant_id !== ctx.tenantId || asset.project_id !== project.id) {
        return { available: false, kind, reason: 'FIRST_FRAME_ASSET_NOT_FOUND' };
      }
      if (!PROJECT_SHOT_ROLES.has(asset.role)) {
        return { available: false, kind, ref_id: asset.id, reason: 'FIRST_FRAME_ASSET_ROLE_INVALID' };
      }
      if (asset.role_status !== 'active') {
        return { available: false, kind, ref_id: asset.id, reason: 'FIRST_FRAME_ASSET_STALE' };
      }
      const bytes = asset.sha256 ? await store.readBlob(asset.sha256, asset.ext ?? 'png') : null;
      if (!bytes) {
        return { available: false, kind, ref_id: asset.id, reason: 'FIRST_FRAME_FILE_MISSING' };
      }
      return {
        available: true, kind, ref_id: asset.id, label: asset.filename ?? asset.id,
        sha256: asset.sha256, width: asset.width ?? null, height: asset.height ?? null,
        publishable: true, decision: 'source_asset', validity: 'current',
      };
    }

    if (kind === 'version') {
      const run = findRun(data, ctx, String(input.run_id ?? ''));
      if (run.project_id !== project.id) throw new ApiError(404, 'NOT_FOUND', '任务不属于该项目');
      let version = input.version_id
        ? (run.versions ?? []).find(item => item.id === String(input.version_id)) ?? null
        : null;
      if (!version && input.deliverable_id) {
        const target = run.deliverables.find(item => item.deliverable_id === String(input.deliverable_id)) ?? null;
        version = target?.active_version_id
          ? (run.versions ?? []).find(item => item.id === target.active_version_id) ?? null
          : null;
      }
      if (!version) return { available: false, kind, reason: 'FIRST_FRAME_VERSION_NOT_FOUND' };
      const target = run.deliverables.find(item => item.deliverable_id === version.deliverable_id) ?? null;
      if (target?.active_version_id !== version.id) {
        return { available: false, kind, ref_id: version.id, reason: 'FIRST_FRAME_VERSION_NOT_ACTIVE' };
      }
      const report = data.quality_reports?.[version.report_id] ?? null;
      const validity = await reportValidityIn(data, report);
      const decision = report?.decision ?? 'unknown';
      const bytes = version.hash ? await store.readBlob(version.hash, version.format ?? 'png') : null;
      const publishable = validity.validity === 'current' && decision === 'publishable' && Boolean(bytes);
      return {
        available: true, kind, ref_id: version.id, label: target?.label ?? version.deliverable_label ?? version.id,
        run_id: run.id, deliverable_id: version.deliverable_id, report_id: report?.id ?? null,
        sha256: version.hash ?? null, width: version.width ?? null, height: version.height ?? null,
        publishable, decision, validity: validity.validity, validity_reasons: validity.reasons ?? [],
      };
    }

    return { available: false, kind: kind || null, reason: 'FIRST_FRAME_KIND_INVALID' };
  }

  async function buildDetailPageViewIn(data, page, snapshot) {
    const validity = checkDetailPageValidity({ page, ...snapshot });
    return { ...page, validity };
  }

  function requireDetailPage(data, ctx, project, detailPageId) {
    const page = data.detail_pages?.[String(detailPageId ?? '')] ?? null;
    if (!page || page.tenant_id !== ctx.tenantId || page.project_id !== project.id) {
      throw new ApiError(404, 'NOT_FOUND', '详情页不存在');
    }
    return page;
  }

  async function createVideoPlan(ctx, projectId, input = {}) {
    const outcome = await store.mutate(async data => {
      const project = findProjectIn(data, ctx, projectId);
      const snapshot = projectSnapshot(data, project);
      const firstFrame = await resolveFirstFrame(data, ctx, project, input.first_frame ?? {});
      let detailPage = null;
      if (input.detail_page_id) {
        const page = requireDetailPage(data, ctx, project, input.detail_page_id);
        detailPage = await buildDetailPageViewIn(data, page, snapshot);
      }
      const plan = planVideo({
        tenantId: ctx.tenantId,
        projectId: project.id,
        firstFrame,
        detailPage,
        capabilities: provider.capabilities(),
        durationSeconds: input.duration_seconds,
        motion: input.motion ?? {},
        audio: input.audio ?? {},
        storyboard: input.storyboard ?? null,
        at: clock(),
      });
      const record = {
        id: newId('vpl'),
        tenant_id: ctx.tenantId,
        project_id: project.id,
        ...plan,
        frame_reports: [],
        latest_frame_report: null,
        created_by: ctx.actorId,
        created_at: new Date(clock()).toISOString(),
      };
      data.video_plans[record.id] = record;
      return { id: record.id };
    });
    return getVideoPlan(ctx, outcome.id);
  }

  function videoView(record) {
    const latest = record.latest_frame_report ?? null;
    let status = record.decision;
    if (record.decision === 'publishable') {
      if (!latest) status = 'needs_review';
      else status = latest.decision;
    }
    return {
      ...record,
      video_status: status,
      has_video_file: false,
      note: '没有真实视频文件；当前 Provider 不支持视频时只能得到分镜与检查计划。',
    };
  }

  async function listVideoPlans(ctx, { projectId = null } = {}) {
    if (projectId) await store.read(data => findProjectIn(data, ctx, projectId));
    const items = await store.read(data => Object.values(data.video_plans ?? {})
      .filter(item => item.tenant_id === ctx.tenantId)
      .filter(item => !projectId || item.project_id === projectId)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .map(videoView));
    return { video_plans: items, total: items.length };
  }

  async function getVideoPlan(ctx, planId) {
    const record = await store.read(data => {
      const found = data.video_plans?.[planId] ?? null;
      if (!found || found.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '视频计划不存在');
      }
      return found;
    });
    return { video_plan: videoView(record) };
  }

  async function evaluateVideoPlanFrames(ctx, planId, input = {}) {
    const frames = input.frames;
    if (!Array.isArray(frames)) throw new ApiError(422, 'VIDEO_FRAMES_REQUIRED', '需要提供帧检查结果');
    if (frames.length > 200) throw new ApiError(422, 'VIDEO_FRAMES_TOO_LARGE', '单次最多 200 帧检查结果');
    const report = evaluateVideoFrames({ frames });
    const outcome = await store.mutate(data => {
      const plan = data.video_plans?.[planId] ?? null;
      if (!plan || plan.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '视频计划不存在');
      }
      const entry = {
        id: newId('vfr'),
        created_at: new Date(clock()).toISOString(),
        created_by: ctx.actorId,
        ...report,
      };
      plan.frame_reports = [...(plan.frame_reports ?? []), entry];
      plan.latest_frame_report = entry;
      return { plan_id: plan.id, report_id: entry.id };
    });
    const view = await getVideoPlan(ctx, outcome.plan_id);
    return { ...view, frame_report: view.video_plan.latest_frame_report };
  }

  /**
   * 生成视频：当前 Provider 没有视频能力时必须明确拒绝，不写任何视频文件；
   * 即使宿主自建 Adapter 声明了 video=true，没有真实实现也不能假装生成。
   */
  async function generateVideo(ctx, planId) {
    const record = await store.read(data => {
      const found = data.video_plans?.[planId] ?? null;
      if (!found || found.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '视频计划不存在');
      }
      return found;
    });
    const capabilities = provider.capabilities();
    if (capabilities.video !== true) {
      throw new ApiError(409, 'VIDEO_PROVIDER_UNSUPPORTED', `当前 Provider「${capabilities.id ?? 'unknown'}」不支持视频，未生成任何视频文件`, {
        provider: capabilities.id ?? null,
        simulated: capabilities.simulated === true,
        acceptance: capabilities.acceptance ?? null,
      });
    }
    if (record.decision !== 'publishable') {
      throw new ApiError(409, 'VIDEO_PLAN_BLOCKED', '视频计划存在阻断项，不能生成', {
        blockers: record.blockers,
      });
    }
    if (record.latest_frame_report?.decision !== 'publishable' && record.latest_frame_report) {
      throw new ApiError(409, 'VIDEO_FRAME_REPORT_BLOCKED', '帧级检查未通过，不能生成视频');
    }
    throw new ApiError(501, 'VIDEO_ADAPTER_NOT_IMPLEMENTED', 'Provider 声明了视频能力，但仓库尚未接入真实视频 Adapter，不能假装生成');
  }

  async function createJointExport(ctx, projectId, options = {}) {
    const scope = options.scope ?? 'partial';
    if (scope !== 'complete' && scope !== 'partial') {
      throw new ApiError(422, 'INVALID_SCOPE', '导出范围只能是 complete 或 partial');
    }
    const result = await store.mutate(async data => {
      const project = findProjectIn(data, ctx, projectId);
      const snapshot = projectSnapshot(data, project);
      const at = clock();
      const run = options.run_id ? findRun(data, ctx, String(options.run_id)) : null;
      if (run && run.project_id !== project.id) throw new ApiError(404, 'NOT_FOUND', '任务不属于该项目');
      if (!run && !options.detail_page_id && !options.video_plan_id) {
        throw new ApiError(422, 'JOINT_EXPORT_EMPTY', '需要至少选择图片任务、详情页或视频计划之一');
      }
      if (scope === 'complete' && !run) {
        throw new ApiError(409, 'JOINT_EXPORT_RUN_REQUIRED', '完整联合包必须包含图片任务');
      }
      if (run && ACTIVE_STATES.has(run.status)) {
        throw new ApiError(409, 'RUN_NOT_TERMINAL', '任务尚未结束，不能导出');
      }

      const imageValidities = {};
      const imageReports = {};
      for (const version of run?.versions ?? []) {
        const report = data.quality_reports?.[version.report_id] ?? null;
        if (report) imageReports[report.id] = report;
        imageValidities[version.report_id] = await reportValidityIn(data, report);
      }
      const imagePlan = run
        ? planExport({
          run,
          versions: run.versions ?? [],
          reports: imageReports,
          validities: imageValidities,
          scope: scope === 'complete' ? 'complete' : 'partial',
        })
        : { ok: false, code: 'PACKAGE_EMPTY', message: '未选择图片任务', included: [], missing: [], stale: 0, complete: false };

      const detailPage = options.detail_page_id
        ? await buildDetailPageViewIn(data, requireDetailPage(data, ctx, project, options.detail_page_id), snapshot)
        : null;
      const videoPlanRecord = options.video_plan_id
        ? (() => {
          const found = data.video_plans?.[String(options.video_plan_id)] ?? null;
          if (!found || found.tenant_id !== ctx.tenantId || found.project_id !== project.id) {
            throw new ApiError(404, 'NOT_FOUND', '视频计划不存在');
          }
          return found;
        })()
        : null;
      const frameReport = videoPlanRecord?.latest_frame_report ?? null;
      const delivery = planPlatformDelivery({ channel: snapshot.channel });

      const detailPublishable = detailPage?.decision === 'publishable' && detailPage.validity.validity === 'current';
      const videoPublishable = videoPlanRecord?.decision === 'publishable'
        && frameReport?.decision === 'publishable';

      if (scope === 'complete') {
        if (!imagePlan.ok) {
          throw new ApiError(409, imagePlan.code, imagePlan.message, { missing: imagePlan.missing, stale: imagePlan.stale });
        }
        if (!detailPage || !detailPublishable) {
          throw new ApiError(409, 'JOINT_EXPORT_DETAIL_PAGE_NOT_READY', '完整联合包要求详情页可发布且未失效');
        }
        if (!videoPlanRecord || !videoPublishable) {
          throw new ApiError(409, 'JOINT_EXPORT_VIDEO_NOT_READY', '完整联合包要求视频计划与帧级检查均可发布');
        }
        // 当前仓库没有真实视频 Adapter：即使计划通过，也不存在视频文件，必须拒绝完整包
        throw new ApiError(409, 'JOINT_EXPORT_VIDEO_FILE_MISSING', '视频计划已通过，但仓库没有真实视频 Adapter，缺少视频文件，不能生成完整联合包');
      }

      const entries = [];
      const images = [];
      const missing = [];
      for (const { version, report, deliverable } of imagePlan.included ?? []) {
        const bytes = await store.readBlob(version.hash, version.format ?? 'png');
        if (!bytes) throw new ApiError(409, 'EXPORT_FILE_MISSING', `交付物 ${deliverable.deliverable_id} 的文件已不可读取`);
        const file = `images/${deliverable.deliverable_id}.${version.format ?? 'png'}`;
        entries.push({ name: file, bytes });
        images.push({
          deliverable_id: deliverable.deliverable_id, label: deliverable.label, file,
          sha256: version.hash, format: version.format, width: version.width, height: version.height,
          bytes: version.bytes, version_id: version.id, report_id: report.id, decision: report.decision,
        });
      }
      for (const item of imagePlan.missing ?? []) missing.push({ artifact: 'image', ...item });
      if (!run) missing.push({ artifact: 'image', deliverable_id: null, label: '商品图片', reason: 'RUN_NOT_SELECTED' });
      else if (!imagePlan.ok) missing.push({ artifact: 'image', deliverable_id: null, label: '商品图片', reason: imagePlan.code, message: imagePlan.message });

      if (detailPage) {
        if (detailPublishable) {
          entries.push({ name: 'detail-page.json', bytes: Buffer.from(JSON.stringify(detailPage, null, 2)) });
        } else {
          missing.push({
            artifact: 'detail_page', deliverable_id: 'detail_page', label: '结构化详情页',
            reason: detailPage.decision !== 'publishable' ? 'BLOCKED' : 'STALE',
          });
        }
      } else {
        missing.push({ artifact: 'detail_page', deliverable_id: 'detail_page', label: '结构化详情页', reason: 'NOT_PROVIDED' });
      }

      if (videoPlanRecord) {
        entries.push({ name: 'video-plan.json', bytes: Buffer.from(JSON.stringify(videoPlanRecord, null, 2)) });
        if (frameReport) {
          entries.push({ name: 'video-frames.json', bytes: Buffer.from(JSON.stringify(frameReport, null, 2)) });
        }
        missing.push({
          artifact: 'video', deliverable_id: 'video', label: '商品短视频',
          reason: videoPlanRecord.generation?.blocker_code ?? 'VIDEO_NOT_RENDERED',
          detail: '当前仓库没有真实视频 Adapter；分镜与帧检查不等于已有视频文件',
        });
      } else {
        missing.push({ artifact: 'video', deliverable_id: 'video', label: '商品短视频', reason: 'NOT_PROVIDED' });
      }

      entries.push({ name: 'platform-delivery.json', bytes: Buffer.from(JSON.stringify(delivery, null, 2)) });
      const manifest = buildJointManifest({
        project, run, spec: snapshot.spec, truth: snapshot.truth, provider: provider.capabilities(),
        images, detailPage, videoPlan: videoPlanRecord, frameReport, delivery, missing, now: at,
      });
      entries.push({ name: 'joint-manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) });
      if (run) {
        entries.push({
          name: 'qa-summary.json',
          bytes: Buffer.from(JSON.stringify(buildQaSummary({ run, plan: imagePlan, now: at }), null, 2)),
        });
      }

      const zip = buildZip(entries, { now: at });
      const packageHash = zipSha256(zip);
      const file = await store.putBlob(zip, packageHash, 'zip');
      const record = {
        id: exportRecordId(),
        schema_version: EXPORT_SCHEMA_VERSION,
        package_format: 'qtb-joint-package.1',
        kind: 'joint',
        tenant_id: run?.tenant_id ?? ctx.tenantId,
        project_id: project.id,
        run_id: run?.id ?? null,
        detail_page_id: detailPage?.id ?? null,
        video_plan_id: videoPlanRecord?.id ?? null,
        scope,
        complete: false,
        status: 'PACKAGE_PARTIAL',
        message: `联合包：图片 ${images.length} 项，详情页 ${detailPublishable ? '已包含' : '缺失'}，视频缺失（Provider 无视频能力）`,
        package_filename: `qtb-joint-${project.id}-${scope}-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}.zip`,
        package_sha256: packageHash,
        package_bytes: zip.length,
        package_path: file,
        manifest,
        qa_summary: null,
        included: images,
        missing,
        platform_compliance: 'not_claimed',
        content_hash_scope: '清单与文件哈希；不含图片二进制',
        created_by: ctx.actorId,
        created_at: new Date(at).toISOString(),
      };
      data.exports[record.id] = record;
      if (run) {
        pushEvent(data, run, {
          stage: 'export', status: scope, at,
          payload: {
            export_id: record.id, kind: 'joint', complete: false,
            package_sha256: packageHash, included: images.length, missing: missing.length,
          },
        });
      }
      return { id: record.id };
    });
    return getExport(ctx, result.id);
  }

  // ---------- M11：批量导出（逐项隔离，失败不静默省略） ----------

  async function createBatchExport(ctx, batchId, { scope = 'partial' } = {}) {
    if (scope !== 'complete' && scope !== 'partial') {
      throw new ApiError(422, 'INVALID_SCOPE', '导出范围只能是 complete 或 partial');
    }
    const result = await store.mutate(async data => {
      const batch = data.batches?.[String(batchId ?? '')] ?? null;
      if (!batch || batch.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '批量任务不存在');
      }
      const at = clock();
      const items = Object.values(data.batch_items ?? {})
        .filter(item => item.batch_id === batch.id && item.tenant_id === ctx.tenantId)
        .sort((left, right) => left.index - right.index);
      const entries = [];
      const images = [];
      const included = [];
      const missing = [];

      for (const item of items) {
        // 条目状态以真实任务状态为准：任务结束但条目还是 running 会造成"已完成却导不出"
        const linked = item.run_id ? data.runs?.[item.run_id] ?? null : null;
        if (linked) {
          item.status = linked.status === 'completed'
            ? 'completed'
            : linked.status === 'cancelled'
              ? 'cancelled'
              : ACTIVE_STATES.has(linked.status) ? 'running' : 'failed';
        }
        if (item.status !== 'completed' || !item.run_id) {
          missing.push({
            item_id: item.id, sku: item.sku, status: item.status,
            reason: item.status === 'completed' ? 'RETRY_NEEDED' : `ITEM_${String(item.status).toUpperCase()}`,
            detail: item.last_error ?? null, blockers: item.blockers ?? [],
          });
          continue;
        }
        const run = data.runs?.[item.run_id] ?? null;
        if (!run || run.tenant_id !== ctx.tenantId) {
          missing.push({ item_id: item.id, sku: item.sku, status: item.status, reason: 'RUN_MISSING', detail: null });
          continue;
        }
        const reports = {};
        const validities = {};
        for (const version of run.versions ?? []) {
          const report = data.quality_reports?.[version.report_id] ?? null;
          if (report) reports[report.id] = report;
          validities[version.report_id] = await reportValidityIn(data, report);
        }
        const plan = planExport({ run, versions: run.versions ?? [], reports, validities, scope: 'partial' });
        if (!plan.ok) {
          missing.push({
            item_id: item.id, sku: item.sku, status: item.status, reason: plan.code,
            detail: plan.message, missing: plan.missing ?? [],
          });
          continue;
        }
        const itemImages = [];
        for (const { version, report, deliverable } of plan.included) {
          const bytes = await store.readBlob(version.hash, version.format ?? 'png');
          if (!bytes) {
            throw new ApiError(409, 'EXPORT_FILE_MISSING', `条目 ${item.sku} 的交付物 ${deliverable.deliverable_id} 文件不可读取`);
          }
          const file = `images/${item.sku}/${deliverable.deliverable_id}.${version.format ?? 'png'}`;
          entries.push({ name: file, bytes });
          const row = {
            item_id: item.id, sku: item.sku, run_id: run.id,
            deliverable_id: deliverable.deliverable_id, label: deliverable.label, file,
            sha256: version.hash, format: version.format, width: version.width, height: version.height,
            bytes: version.bytes, version_id: version.id, report_id: report.id, decision: report.decision,
          };
          itemImages.push(row);
          images.push(row);
        }
        // R10：导出清单必须可核对——张数、尺寸与任务冻结的规格一致；平台规则带来源与核验日期
        const expectedDeliverables = run.deliverables ?? [];
        const dimensionCheck = itemImages.map(img => {
          const expected = expectedDeliverables.find(d => d.deliverable_id === img.deliverable_id) ?? null;
          if (!expected) return { deliverable_id: img.deliverable_id, match: false, reason: 'DELIVERABLE_NOT_IN_SPEC' };
          const match = img.width === expected.width && img.height === expected.height;
          return {
            deliverable_id: img.deliverable_id,
            expected: { width: expected.width, height: expected.height },
            actual: { width: img.width, height: img.height },
            match,
          };
        });
        const countCheck = {
          expected: expectedDeliverables.length,
          exported: itemImages.length,
          match: itemImages.length === expectedDeliverables.length,
        };
        // 规则溯源：任务冻结时的 rule_ref + 目录中的来源与核验日期
        const ruleRef = run.rule_ref ?? null;
        let enrichedRuleRef = null;
        if (ruleRef?.rule_id) {
          const catalogRule = listChannelRules().find(r => r.id === ruleRef.rule_id) ?? null;
          const currentStatus = catalogRule ? ruleStatus(catalogRule, at) : null;
          enrichedRuleRef = {
            ...ruleRef,
            source_name: catalogRule?.source?.name ?? null,
            source_url: catalogRule?.source?.url ?? null,
            effective_at: catalogRule?.effective_at ?? null,
            review_due_at: catalogRule?.review_due_at ?? null,
            current_status: currentStatus?.status ?? null,
            days_to_review: currentStatus?.days_to_review ?? null,
          };
        } else if (ruleRef) {
          enrichedRuleRef = { ...ruleRef };
        }
        included.push({
          item_id: item.id, sku: item.sku, run_id: run.id, images: itemImages,
          rule_ref: enrichedRuleRef, dimension_check: dimensionCheck, count_check: countCheck,
        });
      }

      if (scope === 'complete' && missing.length > 0) {
        throw new ApiError(409, 'BATCH_EXPORT_INCOMPLETE', `完整批量包要求全部条目可发布，当前仍有 ${missing.length} 项未达成`, {
          missing: missing.map(item => ({ sku: item.sku, reason: item.reason })),
        });
      }
      if (included.length === 0) {
        throw new ApiError(409, 'BATCH_EXPORT_EMPTY', '没有可导出的条目，逐项原因见 missing', { missing });
      }

      const manifest = {
        package_format: 'qtb-batch-package.1',
        schema_version: 1,
        generated_at: new Date(at).toISOString(),
        batch_id: batch.id,
        batch_name: batch.name,
        scope,
        tenant_id: ctx.tenantId,
        provider: {
          id: provider.capabilities().id ?? null,
          simulated: provider.capabilities().simulated === true,
          acceptance: provider.capabilities().acceptance ?? null,
        },
        items: included.map(item => ({
          item_id: item.item_id, sku: item.sku, run_id: item.run_id,
          rule_ref: item.rule_ref ?? null,
          count_check: item.count_check ?? null,
          dimension_check: item.dimension_check ?? [],
          images: item.images.map(row => ({
            deliverable_id: row.deliverable_id, label: row.label, file: row.file,
            sha256: row.sha256, format: row.format, width: row.width, height: row.height,
            version_id: row.version_id, report_id: row.report_id, decision: row.decision,
          })),
        })),
        missing,
        platform_compliance: 'not_claimed',
        note: '失败与阻断条目在 missing 中逐项列出；批量导出不使用抽检替代硬检查。',
      };
      entries.push({ name: 'batch-manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) });
      const zip = buildZip(entries, { now: at });
      const packageHash = zipSha256(zip);
      const file = await store.putBlob(zip, packageHash, 'zip');
      const record = {
        id: exportRecordId(),
        schema_version: EXPORT_SCHEMA_VERSION,
        package_format: 'qtb-batch-package.1',
        kind: 'batch',
        tenant_id: ctx.tenantId,
        project_id: null,
        run_id: null,
        batch_id: batch.id,
        scope,
        complete: missing.length === 0,
        status: missing.length === 0 ? 'PACKAGE_COMPLETE' : 'PACKAGE_PARTIAL',
        message: missing.length === 0
          ? `完整批量包：${included.length} 项`
          : `部分批量包：${included.length} 项可导出，${missing.length} 项缺失`,
        package_filename: `qtb-batch-${batch.id}-${scope}.zip`,
        package_sha256: packageHash,
        package_bytes: zip.length,
        package_path: file,
        manifest,
        qa_summary: null,
        included: images,
        missing,
        platform_compliance: 'not_claimed',
        content_hash_scope: '清单与文件哈希；不含图片二进制',
        created_by: ctx.actorId,
        created_at: new Date(at).toISOString(),
      };
      data.exports[record.id] = record;
      batch.export_ids = [...(batch.export_ids ?? []), record.id];
      batch.updated_at = new Date(at).toISOString();
      return { id: record.id };
    });
    return getExport(ctx, result.id);
  }

  return {
    start, stop, createRun, cancelRun, confirmBudget, reconcileRun, getRun, listRuns, eventsSince, recover, advance, subscribe, waitIdle,
    listGenerationRecords, getGenerationRecord,
    listQualityReports, getQualityReport, reviewQualityReport,
    listRunVersions, activateVersion, createExport, listExports, getExport, readExportPackage,
    createVideoPlan, listVideoPlans, getVideoPlan, evaluateVideoPlanFrames, generateVideo,
    createJointExport, createBatchExport,
    get activeSubscriptions() { return listeners.size; },
  };
}
