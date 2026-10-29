import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, toApiError } from './errors.mjs';
import {
  SESSION_COOKIE, SESSION_TTL_MS, assertLoginAllowed, clearAuthFailures, clearedSessionCookie,
  clientIp, createSession, findSession, makeAccountRecord, makeOwnerMember, makeTenantRecord,
  normalizeEmail, parseCookies, pruneAuthState, recordAuthFailure, revokeSession, sessionCookie,
  sessionView, throttleKey, throttleStatus, touchSession, validateRegistration, verifyPassword,
} from './auth.mjs';
import { IMAGE_TYPES, inspectImage } from './images.mjs';
import { createSubjectMask, normalizeSubjectBox } from './m06.mjs';
import { createOcrFromEnv, extractionCandidates } from './ocr.mjs';
import { prepareSubjectMask } from './raster.mjs';
import {
  ASSET_ROLES, LIMITS, activeAssets, computeReadiness, sha256,
  truthContentHash, validateFilename, validateProjectInput, validateRole, validateTruthInput,
} from './domain.mjs';
import { getTemplate, listChannelRules, listTemplates, matchChannelRule } from './catalog.mjs';
import {
  simplifiedSkuView, skuProfileContentHash, validateSkuProfilesInput, diffSkuProfiles,
} from './sku.mjs';
import {
  computeImpactList, deriveChangeStatus, diffIsEmpty, diffTruth, presentChange, quoteChange,
} from './change.mjs';
import { DEPENDENCY_KINDS, mergeManualEntries, presentDependency } from './depgraph.mjs';
import {
  AUTO_CLEAR_ACTION, CHECK_LAYERS, evaluateSkuChecks, presentCheckIssue,
  validateResolveInput,
} from './skucheck.mjs';
import {
  OUT_OF_SCOPE_CATEGORIES, QUESTION_CATEGORIES, QUESTION_RESULTS, QUESTION_LIMITS,
  analyzeQuestion, presentQuestionGroup, suggestCategory, validateQuestionInput,
} from './question.mjs';
import {
  assembleSpec, brandKitContentHash, computeSpecValidity, specContentHash, validateBrandKitInput,
} from './spec.mjs';
import { PRICE_VERSION, quoteFromSpec, quoteMatchesSpec, quoteStatus } from './pricing.mjs';
import { listCommercePlans as _listCommercePlans, commercePlanById as _commercePlanById, planSnapshot, expiryFromSnapshot } from './plans.mjs';
import { planById as legacyPlanById } from './m12.mjs'; // 旧 M12 内部 planById 保留（演示模式）

// 统一的 plan 解析：先查商业化 plans，找不到再查 M12 内部 plans（兼容既有演示测试）
function resolvePlanById(planId) {
  const commercial = _commercePlanById(planId);
  if (commercial) return commercial;
  const legacy = legacyPlanById(planId);
  if (legacy) return {
    id: legacy.id,
    name: legacy.name,
    kind: legacy.billable ? 'billable_legacy' : 'legacy_demo',
    credits: legacy.credits,
    products: legacy.seats ?? null,
    price_cents: legacy.price_cents,
    currency: legacy.currency ?? 'CNY',
    validity_days: null,
    auto_renew: false,
    rollover: false,
    includes_batch: false,
    priority_queue: false,
    seats: legacy.seats,
    note: legacy.note,
    terms: legacy.note,
  };
  return null;
}
// /api/plans 同时返回商业化 + legacy 演示 plan（向后兼容）
function listAllPlans() {
  const commercial = _listCommercePlans();
  return commercial;
}
import { appendEntry, balanceOf, grantExperienceCredits, ledgerEntries, refundableCreditsForOrder, sweepExpiredLots } from './credits.mjs';
import { RETRYABLE_CODES } from './provider.mjs';
import { createProviderFromEnv } from './providers/index.mjs';
import { createJobs, ACTIVE_STATES, TERMINAL_STATES } from './jobs.mjs';
import {
  MAX_CANARY_PERCENT, MIN_CANARY_PERCENT, DEFAULT_CANARY_THRESHOLDS, summarizeDataset,
  summarizeEvaluation, evaluateCanaryHealth, planCanary,
} from './m09.mjs';
import {
  buildDetailPage, checkDetailPageValidity, planPlatformDelivery,
} from './m10.mjs';
import {
  applyRecipeApproval, batchSummary, can, describePermissions, evaluateRecipeUseValidity, isRecipeVisible,
  makeRecipeVersion, planBatch, planMemberChange, previewImportRows,
  resolveRole, summarizeCatalogConsole, validateRecipeInput,
} from './m11.mjs';
import {
  BACKUP_FORMAT_VERSION, buildBackupManifest, buildExperimentReport, buildObservabilitySnapshot,
  evaluateFeedbackEligibility, evaluatePaymentCapability, mergeTenantSnapshot,
  previewOutcomeRows, summarizeFeedback, summarizeOutcomeMetrics, tenantSnapshot,
  validateFeedbackInput, validateOutcomeImportInput, verifyBackupManifest,
} from './m12.mjs';

const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;
const now = () => new Date().toISOString();
const fingerprintOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * M03 项目、素材与商品事实 + M04 模板、品牌套件、平台规则与 CommerceSpec
 * + M05 报价、额度账本与任务执行骨架（Provider 为确定性模拟，真实 Adapter 属 M06）。
 * 约束：
 * - 所有查询强制带租户条件；跨租户对象一律按不存在处理，避免泄漏对象是否存在。
 * - 事实版本与 spec 版本都只追加，不原地覆盖；写入用 base_version 乐观锁。
 * - 额度由服务端判定：预留不足不入队、不调供应商；同一操作键不重复结算。
 */
export function createApi({
  store,
  allowedTenants = ['tenant_demo'],
  defaultTenant = 'tenant_demo',
  defaultActor = 'demo_operator',
  maxUploadBytes = LIMITS.maxBytes,
  clock = () => new Date(),
  initialCredits = 0,
  attemptTimeoutMs = 30_000,
  maxConcurrency = 2,
  tickMs = 25,
  allowScenarioInjection = false,
  // M08：自动修订轮数上限可在测试或宿主侧收紧/放宽，默认 3
  revisionMaxRounds = 3,
  providerMaxConcurrency = 4,
  tenantMaxConcurrency = 2,
  unknownReconcileMs = null,
  // M06：Provider 可注入（测试或宿主自建 Adapter）；不注入时按环境变量选择，默认 mock
  provider: injectedProvider = null,
  // R04：OCR 可注入；不注入时按环境变量判断是否已配置
  ocr: injectedOcr = null,
  providerOptions = {},
  // M12：支付 Provider 默认未配置；只有宿主显式注入真实能力时才允许真实收款
  paymentProvider = null,
  // R01：演示身份只在非生产环境可用；生产默认拒绝未认证访问
  demoMode = true,
  sessionTtlMs = SESSION_TTL_MS,
  secureCookies = false,
  emailRecoveryConfigured = false,
} = {}) {
  if (!store) throw new Error('API 缺少存储实例');
  if (!Array.isArray(allowedTenants) || allowedTenants.length === 0) throw new Error('API 租户配置无效');
  if (!Number.isInteger(initialCredits) || initialCredits < 0) throw new Error('初始额度配置无效');
  if (process.env.NODE_ENV === 'production' && demoMode === true) throw new Error('生产环境不允许开启演示身份');
  const resolvedProvider = injectedProvider
    ? {
      provider: injectedProvider,
      mode: 'injected',
      acceptance: injectedProvider.capabilities?.().acceptance ?? 'not_verified',
      note: '外部注入的 Provider；验收状态由注入方负责',
    }
    : createProviderFromEnv(process.env, providerOptions);
  const provider = resolvedProvider.provider;
  const providerInfo = {
    mode: resolvedProvider.mode,
    acceptance: resolvedProvider.acceptance,
    note: resolvedProvider.note,
  };
  // R04/E04：OCR 适配器在 api 作用域保留一份（E04 三层核对的视觉层直接调用），
  // 与注入 jobs 的是同一实例；未配置（null）时视觉项保持未知，绝不伪造已核对。
  const ocrAdapter = injectedOcr ?? createOcrFromEnv(process.env);
  const jobs = createJobs({
    store, provider, clock, initialCredits, attemptTimeoutMs, maxConcurrency, tickMs, revisionMaxRounds,
    providerMaxConcurrency, tenantMaxConcurrency, unknownReconcileMs,
    // R04：注入 OCR 时才会对成品做真实文字核对，否则文字项保持 unknown
    ocr: ocrAdapter,
  });
  // M12：进程内指标只保留聚合计数，不记录请求体、素材或提示词
  const metrics = { total: 0, by_status: {}, errors: 0, by_error: {} };
  const startedAt = new Date(clock()).toISOString();
  const recordMetric = (status, body) => {
    metrics.total += 1;
    metrics.by_status[status] = (metrics.by_status[status] ?? 0) + 1;
    if (status >= 400) {
      metrics.errors += 1;
      const code = body?.error ?? 'UNKNOWN';
      metrics.by_error[code] = (metrics.by_error[code] ?? 0) + 1;
    }
  };

  publish.jobs = jobs;
  publish.reconcilePayments = async () => {
    if (!paymentProvider) return;
    const orders = await store.read(data => Object.values(data.billing_orders).filter(o => o.real_money &&
      (o.status === 'pending_wechat_checkout' || o.refund_status === 'processing')).slice(0, 10));
    for (const order of orders) {
      try {
        if (order.refund_status === 'processing' && paymentProvider.queryRefund) {
          const result = await paymentProvider.queryRefund({ out_refund_no: order.refund_out_refund_no });
          await store.mutate(data => finishRefund(data, data.billing_orders[order.id], result));
        } else if (paymentProvider.queryOrder) {
          const result = await paymentProvider.queryOrder({ out_trade_no: order.out_trade_no });
          if (result.trade_state === 'SUCCESS') {
            await store.mutate(data => settlePayment(data, data.billing_orders[order.id], result, 'payment_recovery'));
          } else if (order.expires_at && Date.parse(order.expires_at) <= new Date(clock()).getTime() && paymentProvider.closeOrder) {
            let closed = await paymentProvider.closeOrder({ out_trade_no: order.out_trade_no });
            if (closed.trade_state === 'SUCCESS') closed = await paymentProvider.queryOrder({ out_trade_no: order.out_trade_no });
            await store.mutate(data => {
              const current = data.billing_orders[order.id];
              if (closed.trade_state === 'SUCCESS') return settlePayment(data, current, closed, 'payment_recovery');
              if (closed.closed !== false && current.status === 'pending_wechat_checkout') {
                current.status = 'wechat_closed'; current.wechat_trade_state = 'CLOSED';
              }
            });
          }
        }
      } catch (error) {
        await store.mutate(data => { data.billing_orders[order.id].reconcile_error = error.message; });
      }
    }
  };
  publish.provider = { ...providerInfo, capabilities: () => provider.capabilities() };
  publish.credits = { balanceOf: tenantId => store.read(data => balanceOf(data, tenantId, { initialCredits })) };
  // 暴露 drain：关闭服务时先排空写队列，再让调用方清理数据目录
  publish.drain = () => (typeof store.drain === 'function' ? store.drain() : Promise.resolve());
  const backupDirOf = backupId => path.join(store.dir, 'backups', backupId);
  // R01：状态变更方法集合。createApi 在下方提前 return publish，所有 const 声明必须在此之前，
  // 否则被提升的函数访问时会处于暂时性死区（ReferenceError）。
  const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  // E04：一次核对最多识别的版本数。OCR/视觉是有成本服务，超出预算的版本保持未知。
  // 声明必须位于上方提前 return publish 之前，否则处理器执行时处于暂时性死区。
  const SKU_CHECK_OCR_BUDGET = 8;

  return publish;

  async function publish(req, res, route, send) {
    const tracked = (status, body, type, extraHeaders) => {
      recordMetric(status, body);
      return send(status, body, type, extraHeaders);
    };
    try {
      await dispatch(req, res, route, tracked);
    } catch (error) {
      const failure = toApiError(error);
      // 非预期错误必须留痕但不外泄细节（NFR-05）；Apierror 属于业务分支，不打堆栈
      if (failure.status >= 500) {
        console.error('[api] 未预期错误', route, failure.code, error?.stack ?? error?.message ?? error);
      }
      if (res.headersSent) { res.destroy(); return; }
      if (failure.allow) res.setHeader('Allow', failure.allow);
      const body = { error: failure.code, message: failure.message };
      if (failure.details !== undefined) body.details = failure.details;
      tracked(failure.status, body);
    }
  }

  async function dispatch(req, res, route, send) {
    const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
    const rest = route.split('/').filter(part => part !== '').slice(1);
    const method = req.method;
    if (rest.length === 0) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    // R01：认证接口在解析身份之前处理（登录/注册本身还没有会话）
    if (rest[0] === 'auth') return handleAuth(req, res, rest, method, send);
    if (rest.join('/') === 'billing/wechat/notify') {
      requireMethod(method, ['POST']);
      return wechatNotifyRoute(null, req, send);
    }
    // SSE 订阅走 EventSource，浏览器无法带自定义头，因此允许用 query 传租户
    const isEventStream = rest.length === 3 && rest[0] === 'runs' && rest[2] === 'events';
    const ctx = await resolveContext(req, { allowQueryTenant: isEventStream, query });
    assertSameOrigin(req);
    assertCsrf(req, ctx);
    // 统一权限闸口：主链路与商业化接口都由服务端角色矩阵判定，前端不能自授权
    const action = actionForRoute(rest, method);
    if (action) await requireAction(ctx, action);
    const [resource, projectId, section, third] = rest;

    if (resource === 'tenant' && rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      return send(200, {
        tenant_id: ctx.tenantId,
        actor_id: ctx.actorId,
        mode: ctx.mode,
        module: 'R01',
        authenticated: ctx.mode === 'session',
      });
    }
    if (resource === 'credits' && rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      return getCredits(ctx, send);
    }
    if (resource === 'quotes') {
      if (rest.length === 1 && method === 'POST') return createQuote(ctx, req, send);
      if (rest.length === 1) { requireMethod(method, ['GET', 'HEAD', 'POST']); return listQuotes(ctx, send); }
      if (rest.length === 2) { requireMethod(method, ['GET', 'HEAD']); return getQuote(ctx, rest[1], send); }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'runs') {
      if (rest.length === 5 && rest[2] === 'versions' && rest[4] === 'content') {
        requireMethod(method, ['GET', 'HEAD']);
        const file = await jobs.readVersionContent(ctx, rest[1], rest[3]);
        return send(200, file.bytes, file.mime, { 'X-Content-Preview': String(file.preview) });
      }
      if (rest.length === 1 && method === 'POST') return createRun(ctx, req, send);
      if (rest.length === 1) { requireMethod(method, ['GET', 'HEAD', 'POST']); return listRunsRoute(ctx, query, send); }
      if (rest.length === 2) { requireMethod(method, ['GET', 'HEAD']); return jobs.getRun(ctx, rest[1]).then(result => send(200, result)); }
      if (rest.length === 5 && rest[2] === 'versions' && rest[4] === 'activate') {
        requireMethod(method, ['POST']);
        return activateVersionRoute(ctx, rest[1], rest[3], send);
      }
      // M13：文字排版修改（免费）与文字层只读预览
      if (rest.length === 5 && rest[2] === 'deliverables' && rest[4] === 'text-layers') {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.textLayersOfDeliverable(ctx, rest[1], rest[3]).then(result => send(200, result));
      }
      if (rest.length === 5 && rest[2] === 'deliverables' && rest[4] === 'text-edits') {
        requireMethod(method, ['POST']);
        return textEditRoute(ctx, req, rest[1], rest[3], send);
      }
      // E02：图片版本依赖（deterministic 由系统编译写入，manual 由商家补关联）
      if (rest.length === 5 && rest[2] === 'deliverables' && rest[4] === 'dependencies') {
        if (method === 'POST') return postManualDependency(ctx, req, rest[1], rest[3], send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return getDeliverableDependencies(ctx, rest[1], rest[3], send);
      }
      if (rest.length === 6 && rest[2] === 'deliverables' && rest[4] === 'dependencies') {
        requireMethod(method, ['DELETE']);
        return deleteManualDependency(ctx, req, rest[1], rest[3], rest[5], query, send);
      }
      if (rest.length !== 3) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
      if (rest[2] === 'dependencies') {
        requireMethod(method, ['GET', 'HEAD']);
        return getRunDependencies(ctx, rest[1], send);
      }
      if (rest[2] === 'regenerate') { requireMethod(method, ['POST']); return regenerateRunRoute(ctx, req, rest[1], send); }
      if (rest[2] === 'cancel') { requireMethod(method, ['POST']); return cancelRunRoute(ctx, req, rest[1], send); }
      if (rest[2] === 'budget-confirmation') { requireMethod(method, ['POST']); return confirmBudgetRoute(ctx, req, rest[1], send); }
      if (rest[2] === 'reconcile') { requireMethod(method, ['POST']); return reconcileRunRoute(ctx, req, rest[1], send); }
      if (rest[2] === 'events') {
        requireMethod(method, ['GET', 'HEAD']);
        return streamRunEvents(ctx, req, res, rest[1], query, send);
      }
      if (rest[2] === 'generation-records') {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.listGenerationRecords(ctx, { runId: rest[1] }).then(result => send(200, result));
      }
      if (rest[2] === 'quality-reports') {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.listQualityReports(ctx, { runId: rest[1] }).then(result => send(200, result));
      }
      if (rest[2] === 'versions') {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.listRunVersions(ctx, rest[1]).then(result => send(200, result));
      }
      if (rest[2] === 'exports') {
        if (method === 'POST') return createExportRoute(ctx, req, rest[1], send);
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.listExports(ctx, { runId: rest[1] }).then(result => send(200, result));
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'exports') {
      if (rest.length === 1) {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.listExports(ctx, {
          runId: String(query?.get('run_id') ?? '').trim() || null,
          projectId: String(query?.get('project_id') ?? '').trim() || null,
        }).then(result => send(200, result));
      }
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.getExport(ctx, rest[1]).then(result => send(200, result));
      }
      if (rest.length === 3 && rest[2] === 'download') return downloadExportRoute(ctx, rest[1], res, send);
      // E02：导出渠道标签（可更新，保留历史）
      if (rest.length === 3 && rest[2] === 'channels') {
        if (method === 'PUT') return putExportChannels(ctx, req, rest[1], send);
        requireMethod(method, ['GET', 'HEAD', 'PUT']);
        return getExportChannels(ctx, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'quality-reports') {
      if (rest.length === 1) {
        requireMethod(method, ['GET', 'HEAD']);
        return listQualityReportsRoute(ctx, query, send);
      }
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.getQualityReport(ctx, rest[1]).then(result => send(200, result));
      }
      if (rest.length === 3 && rest[2] === 'reviews') {
        requireMethod(method, ['POST']);
        return reviewQualityReportRoute(ctx, req, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'detail-pages') return handleDetailPages(ctx, method, rest, req, send);
    if (resource === 'video-plans') return handleVideoPlans(ctx, method, rest, req, send);
    if (resource === 'batches') {
      if (rest.length === 1) {
        if (method === 'POST') return createBatchRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listBatchesRoute(ctx, send);
      }
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return getBatchRoute(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'preview') {
        requireMethod(method, ['POST']);
        return previewBatchRoute(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'start') {
        requireMethod(method, ['POST']);
        return startBatchRoute(ctx, req, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'exports') {
        requireMethod(method, ['POST']);
        return batchExportRoute(ctx, rest[1], req, send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'members') {
      if (rest.length === 1) {
        if (method === 'POST') return upsertMemberRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listMembersRoute(ctx, send);
      }
      if (rest.length === 2 && method === 'DELETE') return removeMemberRoute(ctx, rest[1], send);
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'recipes') {
      if (rest.length === 1) {
        if (method === 'POST') return createRecipeRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listRecipesRoute(ctx, send);
      }
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return getRecipeRoute(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'approve') {
        requireMethod(method, ['POST']);
        return approveRecipeRoute(ctx, rest[1], req, send);
      }
      if (rest.length === 3 && rest[2] === 'usages') {
        if (method === 'POST') return recordRecipeUsageRoute(ctx, rest[1], req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listRecipeUsagesRoute(ctx, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'feedback') {
      if (rest.length === 1) {
        if (method === 'POST') return createFeedbackRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listFeedbackRoute(ctx, query, send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'outcomes') {
      if (rest.length === 1) {
        if (method === 'POST') return createOutcomeImportRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listOutcomesRoute(ctx, query, send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'experiments') {
      if (rest.length === 1) {
        if (method === 'POST') return createExperimentRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listExperimentsRoute(ctx, send);
      }
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return getExperimentRoute(ctx, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'plans' && rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      await requireAction(ctx, 'billing:read');
      return send(200, {
        ...listAllPlans(),
        payment: evaluatePaymentCapability({ provider: paymentProvider }),
      });
    }
    if (resource === 'billing') {
      // R08：微信支付回调——不走认证（微信不带凭证），签名验证是第一闸口
      if (rest.length === 3 && rest[1] === 'wechat' && rest[2] === 'notify') {
        requireMethod(method, ['POST']);
        return wechatNotifyRoute(ctx, req, send);
      }
      if (rest.length === 2 && rest[1] === 'orders') {
        if (method === 'POST') return createBillingOrderRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listBillingOrdersRoute(ctx, send);
      }
      if (rest.length === 4 && rest[1] === 'orders' && rest[3] === 'pay') {
        requireMethod(method, ['POST']);
        return payBillingOrderRoute(ctx, rest[2], send);
      }
      if (rest.length === 4 && rest[1] === 'orders' && rest[3] === 'query') {
        requireMethod(method, ['GET', 'HEAD']);
        return queryBillingOrderRoute(ctx, rest[2], send);
      }
      if (rest.length === 4 && rest[1] === 'orders' && rest[3] === 'close') {
        requireMethod(method, ['POST']);
        return closeBillingOrderRoute(ctx, rest[2], send);
      }
      if (rest.length === 4 && rest[1] === 'orders' && rest[3] === 'settle') {
        requireMethod(method, ['POST']);
        return settleBillingOrderRoute(ctx, rest[2], send);
      }
      if (rest.length === 4 && rest[1] === 'orders' && rest[3] === 'refund') {
        requireMethod(method, ['POST']);
        return refundBillingOrderRoute(ctx, rest[2], req, send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'backups') {
      if (rest.length === 1) {
        if (method === 'POST') return createBackupRoute(ctx, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listBackupsRoute(ctx, send);
      }
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return getBackupRoute(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'verify') {
        requireMethod(method, ['POST']);
        return verifyBackupRoute(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'restore') {
        requireMethod(method, ['POST']);
        return restoreBackupRoute(ctx, req, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'metrics' && rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      return metricsRoute(ctx, send);
    }
    if (resource === 'eval') return handleEval(ctx, method, rest, req, query, send);
    if (resource === 'models') {
      if (rest.length === 1) {
        requireMethod(method, ['GET', 'HEAD']);
        return getModelRouting(ctx, send);
      }
      if (rest.length === 3 && rest[1] === 'canary' && rest[2] === 'health') {
        requireMethod(method, ['POST']);
        return evaluateCanaryRoute(ctx, req, send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'provider' && rest.length === 2 && rest[1] === 'capabilities') {
      requireMethod(method, ['GET', 'HEAD']);
      return send(200, {
        mode: providerInfo.mode,
        acceptance: providerInfo.acceptance,
        note: providerInfo.note,
        capabilities: provider.capabilities(),
      });
    }
    if (resource === 'generation-records') {
      if (rest.length === 1) {
        requireMethod(method, ['GET', 'HEAD']);
        return listGenerationRecordsRoute(ctx, query, send);
      }
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return jobs.getGenerationRecord(ctx, rest[1]).then(result => send(200, result));
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource === 'catalog') return handleCatalog(method, rest, query, send);
    if (resource === 'brand-kits') return handleBrandKits(ctx, method, rest, req, send);
    // E03：商品变更更新助手（变更单详情/执行/重试/视觉核对）
    if (resource === 'changes') {
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return getChange(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'execute') {
        requireMethod(method, ['POST']);
        return executeChange(ctx, req, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'retry') {
        requireMethod(method, ['POST']);
        return retryChange(ctx, req, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'cancel') {
        requireMethod(method, ['POST']);
        return cancelChange(ctx, req, rest[1], send);
      }
      if (rest.length === 5 && rest[2] === 'items' && rest[4] === 'visual-check') {
        requireMethod(method, ['POST']);
        return visualCheckItem(ctx, req, rest[1], rest[3], send);
      }
      if (rest.length === 5 && rest[2] === 'items' && rest[4] === 'material') {
        requireMethod(method, ['POST']);
        return attachChangeItemMaterial(ctx, req, rest[1], rest[3], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    // E03：旧导出替换待办（只记商家确认已替换，不做平台同步）
    if (resource === 'replacement-todos') {
      if (rest.length === 1) {
        requireMethod(method, ['GET', 'HEAD']);
        return listReplacementTodos(ctx, query, send);
      }
      if (rest.length === 3 && rest[2] === 'confirm') {
        requireMethod(method, ['POST']);
        return confirmReplacementTodo(ctx, req, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    // E04：SKU 核对问题（人工复核/更正归属；复核绑定版本与依据）
    if (resource === 'check-issues') {
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return getCheckIssue(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'resolve') {
        requireMethod(method, ['POST']);
        return resolveCheckIssue(ctx, req, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    // E05：售前问题组（归类改正/确认；确认不等于事实已补齐）
    if (resource === 'question-groups') {
      if (rest.length === 2) {
        requireMethod(method, ['GET', 'HEAD']);
        return getQuestionGroup(ctx, rest[1], send);
      }
      if (rest.length === 3 && rest[2] === 'review') {
        requireMethod(method, ['POST']);
        return reviewQuestionGroup(ctx, req, rest[1], send);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (resource !== 'projects') throw new ApiError(404, 'NOT_FOUND', '接口不存在');

    if (rest.length === 1) {
      if (method === 'POST') return createProject(ctx, req, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listProjects(ctx, send);
    }
    if (rest.length === 2) {
      requireMethod(method, ['GET', 'HEAD']);
      return getProject(ctx, projectId, send);
    }
    if (rest.length === 3 && section === 'assets') {
      if (method === 'POST') return uploadAsset(ctx, req, projectId, query, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listAssets(ctx, projectId, send);
    }
    if (rest.length === 3 && section === 'truth-versions') {
      if (method === 'POST') return createTruthVersion(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listTruthVersions(ctx, projectId, send);
    }
    // E01：SKU 档案与包装包含物（版本化 + 乐观锁；权限走 projects 默认 project:read/write）
    if (rest.length === 3 && section === 'skus') {
      if (method === 'PUT') return putSkuProfiles(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'PUT']);
      return getSkuProfiles(ctx, projectId, send);
    }
    if (rest.length === 4 && section === 'skus' && third === 'versions') {
      requireMethod(method, ['GET', 'HEAD']);
      return listSkuVersions(ctx, projectId, send);
    }
    if (rest.length === 5 && section === 'skus' && third === 'versions') {
      requireMethod(method, ['GET', 'HEAD']);
      return getSkuVersion(ctx, projectId, rest[4], send);
    }
    // E03：商品变更更新助手（预览不落库；确认在同一事务内建事实版本+变更单）
    if (rest.length === 4 && section === 'changes' && third === 'preview') {
      requireMethod(method, ['POST']);
      return previewChange(ctx, req, projectId, send);
    }
    if (rest.length === 3 && section === 'changes') {
      if (method === 'POST') return confirmChange(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listChanges(ctx, projectId, send);
    }
    // E04：SKU 防串图三层核对（发起/查询）与按 SKU 导出
    if (rest.length === 3 && section === 'sku-checks') {
      if (method === 'POST') return runSkuChecks(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listSkuChecks(ctx, projectId, send);
    }
    if (rest.length === 3 && section === 'sku-exports') {
      if (method === 'POST') return createSkuExportRoute(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listSkuExportsRoute(ctx, projectId, send);
    }
    // E05：售前问题分析（幂等入库）与问题组列表
    if (rest.length === 4 && section === 'questions' && third === 'analyze') {
      requireMethod(method, ['POST']);
      return analyzeQuestionRoute(ctx, req, projectId, send);
    }
    if (rest.length === 3 && section === 'question-groups') {
      requireMethod(method, ['GET', 'HEAD']);
      return listQuestionGroups(ctx, projectId, query, send);
    }
    if (rest.length === 3 && section === 'readiness') {
      requireMethod(method, ['GET', 'HEAD']);
      return getReadiness(ctx, projectId, send);
    }
    if (rest.length === 3 && section === 'specs') {
      if (method === 'POST') return createSpec(ctx, projectId, req, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listSpecs(ctx, projectId, send);
    }
    if (rest.length === 4 && section === 'specs' && third === 'preview') {
      requireMethod(method, ['POST']);
      return previewSpec(ctx, projectId, req, send);
    }
    if (rest.length === 4 && section === 'specs') {
      requireMethod(method, ['GET', 'HEAD']);
      return getSpec(ctx, projectId, third, send);
    }
    if (rest.length === 4 && section === 'truth-versions') {
      requireMethod(method, ['GET', 'HEAD']);
      return getTruthVersion(ctx, projectId, third, send);
    }
    if (rest.length === 5 && section === 'assets' && rest[4] === 'content') {
      requireMethod(method, ['GET', 'HEAD']);
      return sendAssetContent(ctx, projectId, third, send);
    }
    if (rest.length === 5 && section === 'assets' && rest[4] === 'mask-preview') {
      requireMethod(method, ['GET', 'HEAD']);
      return sendSubjectMaskPreview(ctx, projectId, third, query, send);
    }
    if (rest.length === 5 && section === 'assets' && rest[4] === 'subject-box') {
      requireMethod(method, ['PUT', 'PATCH']);
      return updateAssetSubjectBox(ctx, req, projectId, third, send);
    }
    if (rest.length === 5 && section === 'assets' && rest[4] === 'fact-extraction') {
      requireMethod(method, ['POST']);
      return extractAssetFacts(ctx, req, projectId, third, send);
    }
    // E02：素材被哪些图片版本依赖（替换/删除前的影响可见性；空数组也要明确返回）
    if (rest.length === 5 && section === 'assets' && rest[4] === 'dependents') {
      requireMethod(method, ['GET', 'HEAD']);
      return getAssetDependents(ctx, projectId, third, send);
    }
    if (rest.length === 3 && section === 'detail-pages') {
      if (method === 'POST') return createDetailPage(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listDetailPages(ctx, projectId, send);
    }
    if (rest.length === 5 && section === 'detail-pages' && rest[4] === 'recheck') {
      requireMethod(method, ['POST']);
      return recheckDetailPage(ctx, rest[3], req, send);
    }
    if (rest.length === 3 && section === 'video-plans') {
      if (method === 'POST') return createVideoPlanRoute(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return jobs.listVideoPlans(ctx, { projectId }).then(result => send(200, result));
    }
    if (rest.length === 3 && section === 'joint-exports') {
      if (method === 'POST') return createJointExportRoute(ctx, req, projectId, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return jobs.listExports(ctx, { projectId }).then(result => send(200, result));
    }
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  /**
   * R01：身份只从可信来源解析。
   * - 有会话：账户与租户来自服务端会话；x-tenant-id 仅能在本人所属租户间切换。
   * - 无会话：非生产演示模式回落到服务端配置的演示身份；生产环境直接 401。
   * - 任何模式下 x-actor-id 都不能冒充他人（会话模式完全忽略，演示模式只用于本地角色演练）。
   */
  async function resolveContext(req, { allowQueryTenant = false, query = null } = {}) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = token
      ? await store.read(data => findSession(data, token, new Date(clock())))
      : null;
    if (token && !session) {
      throw new ApiError(401, 'SESSION_INVALID', '登录状态已失效，请重新登录');
    }
    if (session) {
      const account = await store.read(data => data.accounts?.[session.account_id] ?? null);
      if (!account || account.status !== 'active') {
        throw new ApiError(401, 'ACCOUNT_DISABLED', '账户不可用，请重新登录');
      }
      const requestedTenant = req.headers['x-tenant-id'] !== undefined
        ? String(req.headers['x-tenant-id']).trim()
        : allowQueryTenant && query?.get('tenant_id') ? String(query.get('tenant_id')).trim() : null;
      let tenantId = session.tenant_id;
      if (requestedTenant && requestedTenant !== tenantId) {
        const member = await store.read(data => Object.values(data.members ?? {}).some(item =>
          item.tenant_id === requestedTenant && item.actor_id === session.account_id));
        if (!member) throw new ApiError(403, 'TENANT_FORBIDDEN', '当前账户无权访问该工作区');
        tenantId = requestedTenant;
      }
      // 会话只读：每次请求都落盘 last_seen 会把整份数据重写，代价远高于收益
      return {
        tenantId,
        actorId: session.account_id,
        accountId: session.account_id,
        session,
        csrf: session.csrf_token,
        mode: 'session',
      };
    }
    if (!demoMode) {
      throw new ApiError(401, 'UNAUTHENTICATED', '请先登录后再访问工作区');
    }
    const tenantHeader = req.headers['x-tenant-id'];
    // 浏览器 EventSource 不能自定义请求头，SSE 订阅必须能通过 query 传租户。
    // 只在显式允许的路由上放宽，且请求头优先；租户白名单校验不变。
    const queryTenant = allowQueryTenant ? query?.get('tenant_id') : undefined;
    const rawTenant = tenantHeader !== undefined ? tenantHeader : queryTenant;
    const tenantId = rawTenant === undefined ? defaultTenant : String(rawTenant).trim();
    if (!allowedTenants.includes(tenantId)) {
      throw new ApiError(403, 'TENANT_FORBIDDEN', '当前租户无权访问该工作区');
    }
    const actorHeader = req.headers['x-actor-id'];
    const actorId = actorHeader === undefined ? defaultActor : String(actorHeader).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(actorId)) {
      throw new ApiError(400, 'INVALID_ACTOR', '操作人标识无效');
    }
    return { tenantId, actorId, accountId: null, session: null, csrf: null, mode: 'demo' };
  }

  /** 拒绝跨站写请求：浏览器带 Origin 时必须与当前 Host 一致。 */
  function assertSameOrigin(req) {
    if (!STATE_CHANGING.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin === undefined || origin === '') return;
    let host;
    try { host = new URL(origin).host; } catch { throw new ApiError(403, 'CROSS_ORIGIN_DENIED', '请求来源无效'); }
    if (!req.headers.host || host !== req.headers.host) {
      throw new ApiError(403, 'CROSS_ORIGIN_DENIED', '不接受跨站写请求');
    }
  }

  /** 会话模式的状态变更必须带 CSRF 令牌；演示模式保留本地演练行为。 */
  function assertCsrf(req, ctx) {
    if (ctx.mode !== 'session' || !STATE_CHANGING.has(req.method)) return;
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiError(403, 'CSRF_REQUIRED', '缺少 CSRF 令牌，请刷新页面后重试');
    }
    const provided = Buffer.from(token);
    const expected = Buffer.from(ctx.csrf ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ApiError(403, 'CSRF_INVALID', 'CSRF 令牌无效，请刷新页面后重试');
    }
  }

  /**
   * 路由到权限动作的集中映射。处理函数内的细粒度检查继续保留，
   * 这里保证主链路没有“漏挂权限”的接口。
   */
  function actionForRoute([resource, second, third, fourth, fifth], method) {
    const write = STATE_CHANGING.has(method);
    switch (resource) {
      case 'credits': return 'credits:read';
      case 'quotes': return write ? 'quote:create' : 'quote:read';
      case 'runs': {
        if (second === undefined) return write ? 'run:create' : 'run:read';
        if (third === 'regenerate') return write ? 'run:create' : 'run:read';
        if (third === 'cancel') return 'run:cancel';
        if (third === 'budget-confirmation') return 'run:budget';
        if (third === 'reconcile') return 'run:reconcile';
        if (third === 'exports' && write) return 'export:create';
        if (third === 'versions' && fourth === 'activate' && write) return 'version:activate';
        // M13：文字层预览是读动作；提交文字修改是内容写动作，复核/只读角色不可用
        if (third === 'deliverables' && fifth === 'text-layers') return 'run:read';
        if (third === 'deliverables' && fifth === 'text-edits') return write ? 'run:create' : 'run:read';
        // E02：依赖查询走 run:read；人工关联/删除是内容写操作
        if (third === 'dependencies') return write ? 'project:write' : 'run:read';
        if (third === 'deliverables' && fifth === 'dependencies') return write ? 'project:write' : 'run:read';
        return 'run:read';
      }
      case 'exports':
        // E02：渠道标签：写走 export:create，读走 export:read
        if (second !== undefined && third === 'channels') return write ? 'export:create' : 'export:read';
        return second !== undefined && third === 'download' ? 'export:download' : 'export:read';
      case 'quality-reports': return third === 'reviews' && write ? 'quality:review' : 'quality:read';
      case 'detail-pages':
      case 'video-plans':
      case 'brand-kits':
        return write ? 'project:write' : 'project:read';
      case 'members': return write ? 'member:manage' : 'member:read';
      case 'recipes':
        if (third === 'approve' && write) return 'recipe:approve';
        return write ? 'recipe:write' : 'recipe:read';
      case 'feedback': return write ? 'feedback:write' : 'feedback:read';
      case 'outcomes': case 'experiments': return write ? 'outcome:write' : 'outcome:read';
      case 'plans': return 'billing:read';
      case 'billing': return write ? 'billing:manage' : 'billing:read';
      case 'backups': return 'backup:manage';
      case 'metrics': return 'metrics:read';
      case 'eval': case 'models': case 'provider': return 'metrics:read';
      case 'generation-records': return 'run:read';
      case 'catalog': return 'project:read';
      // E03：变更单与替换待办走项目读写权限
      case 'changes':
      case 'replacement-todos':
        return write ? 'project:write' : 'project:read';
      // E04：核对问题查询走 project:read；人工复核/更正归属是内容写操作
      case 'check-issues': return write ? 'project:write' : 'project:read';
      // E05：售前问题组查询走 project:read；分析入库/归类改正/确认是内容写操作
      case 'question-groups': return write ? 'project:write' : 'project:read';
      case 'projects': {
        if (second === undefined) return write ? 'project:create' : 'project:read';
        if (third === 'assets') return write ? 'asset:write' : 'project:read';
        if (third === 'truth-versions') return write ? 'truth:write' : 'project:read';
        if (third === 'specs') return write ? 'spec:write' : 'project:read';
        if (third === 'changes') return write ? 'project:write' : 'project:read';
        // E04：SKU 核对是项目级读写；按 SKU 导出与正式导出同权（创建计费语义一致）
        if (third === 'sku-checks') return write ? 'project:write' : 'project:read';
        if (third === 'sku-exports') return write ? 'export:create' : 'export:read';
        if (third === 'joint-exports') return write ? 'export:create' : 'export:read';
        return write ? 'project:write' : 'project:read';
      }
      default: return null;
    }
  }

  // ---------- R01：账户、会话与登录 ----------

  async function handleAuth(req, res, rest, method, send) {
    const action = rest[1] ?? '';
    if (rest.length !== 2) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    if (action === 'config') {
      requireMethod(method, ['GET', 'HEAD']);
      return send(200, {
        demo_mode: demoMode,
        registration: true,
        email_recovery: emailRecoveryConfigured,
        session_ttl_seconds: Math.floor(sessionTtlMs / 1000),
        password_min_length: 10,
      });
    }
    if (action === 'register') {
      requireMethod(method, ['POST']);
      assertSameOrigin(req);
      return registerRoute(req, res, send);
    }
    if (action === 'login') {
      requireMethod(method, ['POST']);
      assertSameOrigin(req);
      return loginRoute(req, res, send);
    }
    if (action === 'logout') {
      requireMethod(method, ['POST']);
      assertSameOrigin(req);
      return logoutRoute(req, res, send);
    }
    if (action === 'session') {
      requireMethod(method, ['GET', 'HEAD']);
      return sessionRoute(req, send);
    }
    if (action === 'tenants') {
      requireMethod(method, ['GET', 'HEAD']);
      return tenantsRoute(req, send);
    }
    if (action === 'switch-tenant') {
      requireMethod(method, ['POST']);
      assertSameOrigin(req);
      return switchTenantRoute(req, res, send);
    }
    if (action === 'password-reset') {
      requireMethod(method, ['POST']);
      assertSameOrigin(req);
      if (!emailRecoveryConfigured) {
        throw new ApiError(503, 'EMAIL_SERVICE_NOT_CONFIGURED',
          '账户恢复依赖邮件服务，当前部署未配置，暂不可用；请联系管理员或使用本地账户重置流程');
      }
      throw new ApiError(501, 'EMAIL_RECOVERY_NOT_IMPLEMENTED', '邮件恢复通道已启用配置但尚未接通发送服务');
    }
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  async function currentSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
    if (!token) return { token: null, session: null };
    const session = await store.read(data => findSession(data, token, new Date(clock())));
    return { token, session };
  }

  function assertSessionCsrf(req, session) {
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiError(403, 'CSRF_REQUIRED', '缺少 CSRF 令牌，请刷新页面后重试');
    }
    const provided = Buffer.from(token);
    const expected = Buffer.from(session.csrf_token ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ApiError(403, 'CSRF_INVALID', 'CSRF 令牌无效，请刷新页面后重试');
    }
  }

  async function sessionPayload(session) {
    return store.read(data => {
      const account = data.accounts?.[session.account_id] ?? null;
      const tenant = data.tenants?.[session.tenant_id] ?? null;
      const member = Object.values(data.members ?? {}).find(item =>
        item.tenant_id === session.tenant_id && item.actor_id === session.account_id) ?? null;
      const role = member && ['owner', 'editor', 'reviewer', 'viewer'].includes(member.role) ? member.role : null;
      return {
        ...sessionView({
          account, tenant, role,
          permissions: role ? describePermissions(role).permissions : [],
          demoMode,
        }),
        csrf_token: session.csrf_token,
      };
    });
  }

  async function registerRoute(req, res, send) {
    const checked = validateRegistration(await readJson(req));
    if (!checked.ok) throw new ApiError(422, checked.code, checked.message);
    const ip = clientIp(req);
    const created = await store.mutate(data => {
      const duplicate = Object.values(data.accounts ?? {}).some(item =>
        item.email_normalized === checked.payload.email);
      if (duplicate) throw new ApiError(409, 'EMAIL_EXISTS', '该邮箱已注册，请直接登录');
      pruneAuthState(data, new Date(clock()));
      const account = makeAccountRecord({
        email: checked.payload.email,
        password: checked.payload.password,
        displayName: checked.payload.displayName,
        at: clock(),
      });
      const tenant = makeTenantRecord({ name: checked.payload.tenantName, accountId: account.id, at: clock() });
      data.accounts[account.id] = account;
      data.tenants[tenant.id] = tenant;
      const member = makeOwnerMember({ tenantId: tenant.id, accountId: account.id, at: clock() });
      data.members[member.id] = member;
      // R03：新账户发一次体验额度（3 张、90 天、仅限 1 个商品），不发现金等价物。
      // 不发放旧的"开通演示额度"；套餐权益只能通过订单流程到账（R07/R08）。
      const experience = grantExperienceCredits(data, {
        tenantId: tenant.id, actor: 'system', at: clock(),
      });
      const session = createSession(data, {
        accountId: account.id, tenantId: tenant.id, ttlMs: sessionTtlMs,
        at: clock(), ip, userAgent: req.headers['user-agent'],
      });
      return {
        account, tenant, role: 'owner', token: session.token, session: session.session,
        experience_credits: experience.entry.amount,
      };
    });
    res.setHeader('Set-Cookie', sessionCookie(created.token, {
      maxAgeSeconds: Math.floor(sessionTtlMs / 1000), secure: secureCookies,
    }));
    return send(201, {
      account: { id: created.account.id, email: created.account.email, display_name: created.account.display_name },
      tenant: { id: created.tenant.id, name: created.tenant.name },
      role: created.role,
      csrf_token: created.session.csrf_token,
      experience_credits: created.experience_credits,
      demo_mode: demoMode,
    });
  }

  async function loginRoute(req, res, send) {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(422, 'EMAIL_INVALID', '邮箱格式无效');
    }
    const ip = clientIp(req);
    const key = throttleKey(ip, email);
    await store.read(data => {
      assertLoginAllowed(throttleStatus(data, key, new Date(clock())));
      return true;
    });
    const account = await store.read(data =>
      Object.values(data.accounts ?? {}).find(item => item.email_normalized === email) ?? null);
    const valid = Boolean(account) && account.status === 'active' && verifyPassword(body.password, account);
    if (!valid) {
      await store.mutate(data => {
        recordAuthFailure(data, key, new Date(clock()));
        pruneAuthState(data, new Date(clock()));
      });
      throw new ApiError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
    }
    const membership = await store.read(data => Object.values(data.members ?? {})
      .filter(item => item.actor_id === account.id)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))[0] ?? null);
    if (!membership) throw new ApiError(403, 'NO_TENANT', '该账户尚未加入任何工作区');
    const created = await store.mutate(data => {
      clearAuthFailures(data, key);
      const current = data.accounts[account.id];
      current.last_login_at = new Date(clock()).toISOString();
      current.updated_at = current.last_login_at;
      const tenant = data.tenants?.[membership.tenant_id] ?? null;
      if (!tenant || tenant.status !== 'active') {
        throw new ApiError(403, 'TENANT_DISABLED', '所属工作区不可用');
      }
      const session = createSession(data, {
        accountId: account.id, tenantId: tenant.id, ttlMs: sessionTtlMs,
        at: clock(), ip, userAgent: req.headers['user-agent'],
      });
      return { token: session.token, session: session.session };
    });
    res.setHeader('Set-Cookie', sessionCookie(created.token, {
      maxAgeSeconds: Math.floor(sessionTtlMs / 1000), secure: secureCookies,
    }));
    const payload = await sessionPayload(created.session);
    return send(200, payload);
  }

  async function logoutRoute(req, res, send) {
    const { session } = await currentSession(req);
    if (session) {
      assertSessionCsrf(req, session);
      await store.mutate(data => revokeSession(data, session.id, new Date(clock())));
    }
    res.setHeader('Set-Cookie', clearedSessionCookie({ secure: secureCookies }));
    return send(200, { ok: true });
  }

  async function sessionRoute(req, send) {
    const { session } = await currentSession(req);
    if (session) return send(200, await sessionPayload(session));
    return send(200, {
      authenticated: false,
      demo_mode: demoMode,
      email_recovery: emailRecoveryConfigured,
      demo_identity: demoMode ? { tenant_id: defaultTenant, actor_id: defaultActor } : null,
      account: null,
      tenant: null,
      role: null,
      permissions: [],
    });
  }

  async function tenantsRoute(req, send) {
    const { session } = await currentSession(req);
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    const rows = await store.read(data => Object.values(data.members ?? {})
      .filter(item => item.actor_id === session.account_id)
      .map(item => ({
        tenant_id: item.tenant_id,
        role: item.role,
        name: data.tenants?.[item.tenant_id]?.name ?? item.tenant_id,
        active: item.tenant_id === session.tenant_id,
      })));
    return send(200, { tenants: rows });
  }

  async function switchTenantRoute(req, res, send) {
    const { session } = await currentSession(req);
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    assertSessionCsrf(req, session);
    const body = await readJson(req);
    const tenantId = String(body.tenant_id ?? '').trim();
    if (!tenantId) throw new ApiError(422, 'TENANT_REQUIRED', '需要提供 tenant_id');
    const updated = await store.mutate(data => {
      const member = Object.values(data.members ?? {}).find(item =>
        item.tenant_id === tenantId && item.actor_id === session.account_id) ?? null;
      if (!member) throw new ApiError(403, 'TENANT_FORBIDDEN', '当前账户无权访问该工作区');
      const tenant = data.tenants?.[tenantId] ?? null;
      if (!tenant || tenant.status !== 'active') throw new ApiError(403, 'TENANT_DISABLED', '该工作区不可用');
      const record = data.sessions[session.id];
      if (!record || record.revoked_at) throw new ApiError(401, 'SESSION_INVALID', '登录状态已失效');
      record.tenant_id = tenantId;
      return { ...record };
    });
    return send(200, await sessionPayload(updated));
  }

  async function createProject(ctx, req, send) {
    const input = validateProjectInput(await readJson(req));
    const project = await store.mutate(data => {
      const duplicate = Object.values(data.projects).find(item =>
        item.tenant_id === ctx.tenantId && item.sku.toLowerCase() === input.sku.toLowerCase());
      if (duplicate) {
        throw new ApiError(409, 'SKU_EXISTS', `SKU ${input.sku} 已存在于同租户项目「${duplicate.name}」，不会覆盖原项目`, {
          existing_project_id: duplicate.id,
        });
      }
      const timestamp = now();
      const record = {
        id: newId('prj'),
        tenant_id: ctx.tenantId,
        name: input.name,
        sku: input.sku,
        category: input.category,
        platform: input.platform,
        status: 'drafting',
        truth_head_version: 0,
        spec_head_version: 0,
        confirmation_status: null,
        created_at: timestamp,
        updated_at: timestamp,
        created_by: ctx.actorId,
      };
      data.projects[record.id] = record;
      return record;
    });
    send(201, { project: serializeProject(project), readiness: computeReadiness(project, [], null) });
  }

  async function listProjects(ctx, send) {
    const projects = await store.read(data => Object.values(data.projects)
      .filter(project => project.tenant_id === ctx.tenantId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map(project => {
        const assets = Object.values(data.assets).filter(asset => asset.project_id === project.id);
        const truth = latestTruth(data, project.id);
        return {
          ...serializeProject(project),
          asset_count: assets.length,
          active_asset_count: activeAssets(assets).length,
          readiness: computeReadiness(project, assets, truth),
        };
      }));
    send(200, { tenant_id: ctx.tenantId, projects });
  }

  async function getProject(ctx, projectId, send) {
    const detail = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const assets = Object.values(data.assets)
        .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
      const truth = latestTruth(data, project.id);
      return {
        project: serializeProject(project),
        assets: assets.map(asset => serializeAsset(asset, project.id)),
        truth_head: truth,
        readiness: computeReadiness(project, assets, truth),
      };
    });
    send(200, detail);
  }

  async function listAssets(ctx, projectId, send) {
    const assets = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      return Object.values(data.assets)
        .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map(asset => serializeAsset(asset, project.id));
    });
    send(200, { project_id: projectId, assets });
  }

  async function uploadAsset(ctx, req, projectId, query, send) {
    await store.read(data => findProject(data, ctx, projectId));
    const role = validateRole(query.get('role') ?? req.headers['x-asset-role']);
    const onConflict = String(query.get('on_conflict') ?? 'reject').trim().toLowerCase();
    if (!['reject', 'replace'].includes(onConflict)) {
      throw new ApiError(422, 'INVALID_CONFLICT_POLICY', 'on_conflict 仅支持 reject 或 replace');
    }
    const buffer = await readBody(req, maxUploadBytes);
    const info = inspectImage(buffer);
    const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream' && declared !== info.mime) {
      throw new ApiError(415, 'TYPE_MISMATCH', `声明的类型 ${declared} 与真实文件类型 ${info.mime} 不一致`);
    }
    const filename = validateFilename(
      query.get('filename') ?? req.headers['x-asset-filename'],
      `${role}-${Date.now()}.${info.ext}`,
    );
    const dotIndex = filename.lastIndexOf('.');
    const extension = dotIndex === -1 ? '' : filename.slice(dotIndex + 1).toLowerCase();
    const normalizedExtension = extension === 'jpeg' ? 'jpg' : extension;
    if (normalizedExtension && normalizedExtension !== info.ext) {
      throw new ApiError(415, 'EXTENSION_MISMATCH', `扩展名 .${extension} 与真实类型 ${IMAGE_TYPES[info.mime].label} 不一致`);
    }

    const hash = sha256(buffer);
    const warnings = [];
    const shortSide = Math.min(info.width, info.height);
    if (shortSide < LIMITS.minShortSide) {
      warnings.push({
        code: 'LOW_RESOLUTION',
        message: `最短边 ${shortSide}px 低于建议 ${LIMITS.minShortSide}px，可先保存但建议补图`,
      });
    }
    await store.putBlob(buffer, hash, info.ext);

    const result = await store.mutate(data => {
      const project = findProject(data, ctx, projectId);
      const siblings = Object.values(data.assets).filter(asset =>
        asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
      const active = siblings.filter(asset => asset.role_status === 'active');
      if (active.length >= LIMITS.maxAssetsPerProject) {
        throw new ApiError(409, 'ASSET_LIMIT', `每个项目最多 ${LIMITS.maxAssetsPerProject} 张生效素材，请先替换或调整职责`);
      }
      if (siblings.some(asset => asset.sha256 === hash)) {
        warnings.push({ code: 'DUPLICATE_CONTENT', message: '该项目已存在内容完全相同的素材' });
      }
      const conflicts = active.filter(asset => asset.role === role && ASSET_ROLES[role].exclusive);
      if (conflicts.length > 0 && onConflict !== 'replace') {
        throw new ApiError(409, 'REFERENCE_CONFLICT', `「${ASSET_ROLES[role].label}」职责已有素材，请确认保留哪一张，不能静默取一张`, {
          role,
          resolution: 'replace',
          candidates: conflicts.map(asset => ({ asset_id: asset.id, filename: asset.filename, created_at: asset.created_at })),
        });
      }
      const timestamp = now();
      const record = {
        id: newId('ast'),
        tenant_id: ctx.tenantId,
        project_id: project.id,
        filename,
        role,
        role_status: 'active',
        mime: info.mime,
        ext: info.ext,
        size_bytes: buffer.length,
        sha256: hash,
        content_hash: hash,
        width: info.width,
        height: info.height,
        warnings,
        source: 'upload',
        created_at: timestamp,
        updated_at: timestamp,
        created_by: ctx.actorId,
        superseded_by: null,
      };
      for (const conflict of conflicts) {
        conflict.role_status = 'superseded';
        conflict.superseded_by = record.id;
        conflict.updated_at = timestamp;
      }
      data.assets[record.id] = record;
      project.updated_at = timestamp;
      project.status = 'collecting_assets';
      const assets = Object.values(data.assets).filter(asset => asset.project_id === project.id);
      return {
        asset: record,
        readiness: computeReadiness(project, assets, latestTruth(data, project.id)),
        replaced: conflicts.map(asset => asset.id),
      };
    });

    send(201, {
      asset: serializeAsset(result.asset, projectId),
      warnings: result.asset.warnings,
      replaced_asset_ids: result.replaced,
      readiness: result.readiness,
    });
  }

  async function sendAssetContent(ctx, projectId, assetId, send) {
    const asset = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const item = data.assets[assetId];
      if (!item || item.project_id !== project.id || item.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '素材不存在');
      }
      return item;
    });
    const blob = await store.readBlob(asset.sha256, asset.ext);
    if (!blob) throw new ApiError(410, 'CONTENT_MISSING', '素材文件已不可用，请重新上传');
    send(200, blob, asset.mime);
  }

  /** R04：主体掩码预览。PNG 自动推导；JPEG/WebP 需要卖家确认的矩形，未给矩形时明确说明。 */
  async function sendSubjectMaskPreview(ctx, projectId, assetId, query, send) {
    const { asset, bytes } = await store.read(async data => {
      const project = findProject(data, ctx, projectId);
      const item = data.assets[assetId];
      if (!item || item.project_id !== project.id || item.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '素材不存在');
      }
      if (item.role !== 'subject') {
        throw new ApiError(422, 'NOT_SUBJECT_ASSET', '只有主体素材可以生成掩码预览');
      }
      return { asset: item, bytes: await store.readBlob(item.sha256, item.ext) };
    });
    if (!bytes) throw new ApiError(410, 'CONTENT_MISSING', '素材文件已不可用，请重新上传');
    const box = query?.get('x') !== null && query?.get('x') !== undefined
      ? {
        x: Number(query.get('x')), y: Number(query.get('y')),
        width: Number(query.get('width')), height: Number(query.get('height')),
      }
      : asset.subject_box ?? null;
    const mask = await prepareSubjectMask({ bytes, mime: asset.mime, box });
    if (!mask.available) {
      throw new ApiError(422, mask.reason ?? 'MASK_UNAVAILABLE', mask.message ?? '无法生成主体掩码', {
        method: mask.method ?? null,
        accepted_formats: ['image/png', 'image/jpeg', 'image/webp（需确认商品矩形）'],
      });
    }
    send(200, mask.maskBytes, 'image/png', {
      'X-Mask-Method': mask.method,
      'X-Mask-Coverage': String(mask.coverage),
      'X-Mask-Has-Cutout': mask.has_cutout === false ? 'false' : 'true',
    });
  }

  /** R04：卖家调整商品矩形。只存归一化坐标，不修改原始素材像素。 */
  async function updateAssetSubjectBox(ctx, req, projectId, assetId, send) {
    const body = await readJson(req);
    const box = normalizeSubjectBox(body?.subject_box ?? body);
    if (!box) {
      throw new ApiError(422, 'INVALID_SUBJECT_BOX', '商品矩形需为 0—1 的归一化坐标，且宽高不小于画布 2%');
    }
    const updated = await store.mutate(data => {
      const project = findProject(data, ctx, projectId);
      const asset = data.assets[assetId];
      if (!asset || asset.project_id !== project.id || asset.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '素材不存在');
      }
      if (asset.role !== 'subject') throw new ApiError(422, 'NOT_SUBJECT_ASSET', '只有主体素材可以设置商品矩形');
      if (asset.role_status !== 'active') throw new ApiError(409, 'ASSET_INACTIVE', '该素材已被替代，不能继续调整');
      asset.subject_box = box;
      asset.subject_box_updated_at = now();
      asset.subject_box_updated_by = ctx.actorId;
      project.updated_at = now();
      return serializeAsset(asset, project.id);
    });
    send(200, { asset: updated });
  }

  /**
   * R04：从素材提取候选事实。结果只是"候选"，一律 confirmed=false 交给用户逐项确认；
   * 未配置 OCR 时返回 configured=false 且不给任何候选，绝不用样例数据冒充识别。
   */
  async function extractAssetFacts(ctx, req, projectId, assetId, send) {
    await readJson(req).catch(() => ({}));
    const { asset, bytes } = await store.read(async data => {
      const project = findProject(data, ctx, projectId);
      const item = data.assets[assetId];
      if (!item || item.project_id !== project.id || item.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '素材不存在');
      }
      if (item.role === 'style') {
        throw new ApiError(422, 'STYLE_NOT_FACT_SOURCE', '风格图不作为商品事实来源');
      }
      if (item.role_status !== 'active') throw new ApiError(409, 'ASSET_INACTIVE', '该素材已被替换');
      return { asset: item, bytes: await store.readBlob(item.sha256, item.ext) };
    });
    if (!bytes) throw new ApiError(410, 'CONTENT_MISSING', '素材文件已不可用，请重新上传');
    const ocr = injectedOcr ?? createOcrFromEnv(process.env);
    if (!ocr.configured) {
      send(200, {
        configured: false,
        mode: ocr.mode,
        note: ocr.note,
        candidates: [],
        asset_id: asset.id,
        acceptance: 'not_available',
      });
      return;
    }
    const result = await ocr.recognize({
      bytes, mime: asset.mime,
    });
    const candidates = result.status === 'ok'
      ? extractionCandidates({ lines: result.lines, assetId: asset.id })
      : [];
    send(200, {
      configured: true,
      mode: ocr.mode,
      acceptance: ocr.acceptance,
      note: ocr.acceptance === 'contract_only'
        ? 'OCR 已配置但识别准确率尚未用授权样本验收；候选值需逐项确认'
        : ocr.note,
      status: result.status,
      reason: result.reason ?? null,
      engine: result.engine ?? null,
      asset_id: asset.id,
      candidates,
    });
  }

  /**
   * 在既有 mutate 内追加一个事实版本（E03 变更确认与 M03 提交共用同一核心）。
   * 调用方必须已完成 validateTruthInput；乐观锁与确认闸口都在这里判定。
   */
  function applyTruthVersionIn(data, ctx, project, payload) {
    const assets = Object.values(data.assets)
      .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
    if (payload.base_version !== project.truth_head_version) {
      throw new ApiError(409, 'VERSION_CONFLICT', `事实版本已更新到 v${project.truth_head_version}，请基于最新版本重新提交`, {
        current_version: project.truth_head_version,
      });
    }
    const timestamp = now();
    const facts = payload.facts.map(fact => ({
      ...fact,
      confirmed_by: fact.confirmed ? ctx.actorId : null,
      confirmed_at: fact.confirmed ? timestamp : null,
    }));
    const version = project.truth_head_version + 1;
    const provisional = {
      version,
      sku: payload.sku,
      category: payload.category,
      facts,
      immutable_regions: payload.immutable_regions,
      critical_text: payload.critical_text,
      confirmation_status: payload.confirm ? 'confirmed' : 'draft',
    };
    const readiness = computeReadiness(project, assets, provisional);
    if (payload.confirm && readiness.blockers.length > 0) {
      throw new ApiError(409, 'CONFIRMATION_BLOCKED', '关键项未全部确认，无法确认商品事实版本', {
        blockers: readiness.blockers,
      });
    }
    const record = {
      id: newId('tv'),
      tenant_id: ctx.tenantId,
      project_id: project.id,
      version,
      base_version: payload.base_version,
      sku: payload.sku,
      category: payload.category,
      facts,
      immutable_regions: payload.immutable_regions,
      critical_text: payload.critical_text,
      confirmation_status: provisional.confirmation_status,
      blockers: readiness.blockers,
      warnings: readiness.warnings,
      content_hash: truthContentHash(provisional),
      created_by: ctx.actorId,
      created_at: timestamp,
    };
    data.truth_versions[record.id] = record;
    project.truth_head_version = version;
    project.confirmation_status = record.confirmation_status;
    project.status = record.confirmation_status === 'confirmed' ? 'ready' : 'drafting';
    project.updated_at = timestamp;
    return { record, readiness };
  }

  async function createTruthVersion(ctx, req, projectId, send) {
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const project = findProject(data, ctx, projectId);
      const assets = Object.values(data.assets)
        .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
      const payload = validateTruthInput(body, { project, assets });
      return applyTruthVersionIn(data, ctx, project, payload);
    });
    send(201, { truth_version: result.record, readiness: result.readiness });
  }

  async function listTruthVersions(ctx, projectId, send) {
    const result = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const versions = Object.values(data.truth_versions)
        .filter(item => item.project_id === project.id && item.tenant_id === ctx.tenantId)
        .sort((left, right) => left.version - right.version)
        .map(item => ({
          version: item.version,
          base_version: item.base_version,
          confirmation_status: item.confirmation_status,
          content_hash: item.content_hash,
          created_by: item.created_by,
          created_at: item.created_at,
          blocker_count: item.blockers.length,
        }));
      return { project_id: project.id, head_version: project.truth_head_version, versions };
    });
    send(200, result);
  }

  async function getTruthVersion(ctx, projectId, rawVersion, send) {
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 1) throw new ApiError(404, 'NOT_FOUND', '事实版本不存在');
    const found = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const item = Object.values(data.truth_versions).find(candidate =>
        candidate.project_id === project.id && candidate.tenant_id === ctx.tenantId && candidate.version === version);
      return item ?? null;
    });
    if (!found) throw new ApiError(404, 'NOT_FOUND', '事实版本不存在');
    send(200, { truth_version: found });
  }

  // ---------- E01：SKU 档案与包装包含物 ----------

  function skuProfilesOf(data, project) {
    return Object.values(data.sku_profiles ?? {})
      .filter(item => item.project_id === project.id && item.tenant_id === project.tenant_id)
      .sort((left, right) => left.version - right.version);
  }

  async function getSkuProfiles(ctx, projectId, send) {
    const result = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const versions = skuProfilesOf(data, project);
      const head = versions[versions.length - 1] ?? null;
      if (!head) {
        // 单规格简化入口：无档案时返回派生视图，不伪造已确认档案
        return {
          project_id: project.id,
          head_version: 0,
          profile: null,
          view: simplifiedSkuView(project),
        };
      }
      return { project_id: project.id, head_version: head.version, profile: head, view: null };
    });
    send(200, result);
  }

  /** 在既有 mutate 内追加一个 SKU 档案版本（E01 提交与 E03 变更确认共用同一核心）。 */
  function applySkuProfilesIn(data, ctx, project, payload) {
    const head = project.sku_head_version ?? 0;
    if (payload.base_version !== head) {
      throw new ApiError(409, 'VERSION_CONFLICT', `SKU 档案已更新到 v${head}，请刷新后基于最新版本重新提交`, {
        current_version: head,
      });
    }
    if (payload.confirm && (payload.skus.length === 0 || payload.skus.some(sku => !sku.confirmed))) {
      throw new ApiError(409, 'CONFIRMATION_BLOCKED', '存在未确认的 SKU，无法确认档案：请逐项确认后再提交', {
        unconfirmed: payload.skus.filter(sku => !sku.confirmed).map(sku => sku.sku_code),
      });
    }
    const timestamp = now();
    const skus = payload.skus.map(sku => ({
      ...sku,
      id: sku.id ?? newId('sku'),
      confirmed_by: sku.confirmed ? ctx.actorId : null,
      confirmed_at: sku.confirmed ? timestamp : null,
    }));
    const version = head + 1;
    const entry = {
      id: newId('sp'),
      tenant_id: ctx.tenantId,
      project_id: project.id,
      version,
      base_version: payload.base_version,
      skus,
      confirmation_status: payload.confirm ? 'confirmed' : 'draft',
      content_hash: skuProfileContentHash({ skus }),
      created_by: ctx.actorId,
      created_at: timestamp,
    };
    data.sku_profiles[entry.id] = entry;
    project.sku_head_version = version;
    project.updated_at = timestamp;
    return entry;
  }

  async function putSkuProfiles(ctx, req, projectId, send) {
    const body = await readJson(req);
    const record = await store.mutate(data => {
      const project = findProject(data, ctx, projectId);
      const assets = Object.values(data.assets)
        .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
      const payload = validateSkuProfilesInput(body, { project, assets });
      return applySkuProfilesIn(data, ctx, project, payload);
    });
    send(201, { sku_profile: record });
  }

  async function listSkuVersions(ctx, projectId, send) {
    const result = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const versions = skuProfilesOf(data, project).map(item => ({
        version: item.version,
        base_version: item.base_version,
        confirmation_status: item.confirmation_status,
        sku_count: item.skus.length,
        content_hash: item.content_hash,
        created_by: item.created_by,
        created_at: item.created_at,
      }));
      return { project_id: project.id, head_version: project.sku_head_version ?? 0, versions };
    });
    send(200, result);
  }

  async function getSkuVersion(ctx, projectId, rawVersion, send) {
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 1) throw new ApiError(404, 'NOT_FOUND', 'SKU 档案版本不存在');
    const found = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      return skuProfilesOf(data, project).find(item => item.version === version) ?? null;
    });
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'SKU 档案版本不存在');
    send(200, { sku_profile: found });
  }

  // ---------- E04：SKU 防串图三层核对 ----------

  function headSkuProfileOf(data, project) {
    return skuProfilesOf(data, project).at(-1) ?? null;
  }

  function headTruthOf(data, project) {
    return Object.values(data.truth_versions ?? {})
      .filter(item => item.project_id === project.id && item.tenant_id === project.tenant_id)
      .sort((left, right) => left.version - right.version).at(-1) ?? null;
  }

  /**
   * 发起 SKU 三层核对（归属/结构/视觉）：
   * - 幂等：同版本同指纹的 open 问题不重复开立；已复核的问题不随重核复开（复核绑定版本持续有效）；
   * - 自动收口：复核时条件已不存在的 review 项与 structure blocker 记 recheck_clear；
   *   ownership blocker 永不自动收口（删除关联不能解除确定阻断）；
   * - 问题绑定 version_id：新版本必须重核，一次人工确认不能永久放行后续版本。
   */
  async function runSkuChecks(ctx, req, projectId, send) {
    const body = await readJson(req);
    const runIdFilter = typeof body?.run_id === 'string' && body.run_id.trim() !== ''
      ? body.run_id.trim() : null;
    const outcome = await store.mutate(async data => {
      const project = findProject(data, ctx, projectId);
      const profile = headSkuProfileOf(data, project);
      const truth = headTruthOf(data, project);
      const runs = Object.values(data.runs ?? {})
        .filter(run => run.tenant_id === ctx.tenantId && run.project_id === project.id)
        .filter(run => !runIdFilter || run.id === runIdFilter)
        .sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')));
      if (runIdFilter && runs.length === 0) throw new ApiError(404, 'NOT_FOUND', '指定的任务不存在');
      const assetsById = new Map(Object.values(data.assets ?? {})
        .filter(asset => asset.tenant_id === ctx.tenantId && asset.project_id === project.id)
        .map(asset => [asset.id, asset]));
      const dependencies = Object.values(data.image_dependencies ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id);
      const existingIssues = Object.values(data.check_issues ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id);
      const timestamp = now();
      // 未配置的适配器（createOcrFromEnv 的 not_configured 形态）不消耗预算、不发起调用：视觉层保持未知
      const ocrConfigured = Boolean(ocrAdapter) && ocrAdapter.configured !== false;
      let ocrBudget = SKU_CHECK_OCR_BUDGET;
      let checked = 0;
      let created = 0;
      let autoCleared = 0;
      for (const run of runs) {
        for (const deliverable of run.deliverables ?? []) {
          const version = (run.versions ?? []).find(item =>
            item.deliverable_id === deliverable.deliverable_id && item.active === true) ?? null;
          if (!version) continue;
          checked += 1;
          const dependencyRecord = dependencies.find(item =>
            item.run_id === run.id && item.deliverable_id === deliverable.deliverable_id
            && item.version_id === version.id) ?? null;
          // 版本冻结文字层优先；旧版本无冻结层时回落编译计划层；都没有 → 结构层保持未知
          let textLayers = Array.isArray(version.text_layers) && version.text_layers.length > 0
            ? version.text_layers : null;
          if (!textLayers) {
            const planTarget = (run.execution?.plan?.deliverables ?? [])
              .find(item => item.deliverable_id === deliverable.deliverable_id) ?? null;
            textLayers = Array.isArray(planTarget?.text_layers) && planTarget.text_layers.length > 0
              ? planTarget.text_layers : null;
          }
          // 视觉层：未配置 OCR 保持未知；配置了则在单次请求预算内识别，超预算同样保持未知
          let ocr = null;
          if (ocrConfigured) {
            if (ocrBudget > 0) {
              ocrBudget -= 1;
              try {
                const bytes = await store.readBlob(version.hash, version.format ?? 'png');
                ocr = bytes
                  ? await ocrAdapter.recognize({
                      bytes, mime: version.format === 'jpg' ? 'image/jpeg' : `image/${version.format ?? 'png'}` })
                  : { status: 'error', reason: 'FILE_MISSING' };
              } catch (error) {
                ocr = { status: 'error', reason: error?.message ?? 'OCR_CALL_FAILED' };
              }
            } else {
              ocr = { status: 'error', reason: 'BUDGET_LIMIT' };
            }
          }
          const drafts = evaluateSkuChecks({
            run, version, dependencyRecord, skuProfile: profile, truth,
            project, assetsById, textLayers, ocr,
            priorIssues: existingIssues.filter(item => item.version_id === version.id),
          });
          const fresh = new Map(drafts.map(draft => [draft.fingerprint, draft]));
          const ofVersion = existingIssues.filter(item => item.version_id === version.id);
          for (const old of ofVersion.filter(item => item.status === 'open' && !fresh.has(item.fingerprint))) {
            const clearable = old.severity === 'review' || old.layer === 'structure';
            if (!clearable) continue;
            old.status = 'resolved';
            old.resolution = {
              action: AUTO_CLEAR_ACTION, actor: ctx.actorId, at: timestamp,
              reason: '再次核对时该问题的条件已不存在（档案/事实已修正）',
              version_id: old.version_id,
              truth_version: truth?.version ?? null,
              sku_profile_version: profile?.version ?? null,
            };
            autoCleared += 1;
          }
          for (const [fingerprint, draft] of fresh) {
            if (ofVersion.some(item => item.fingerprint === fingerprint)) continue;
            const id = newId('chk');
            const record = {
              id, fingerprint,
              tenant_id: ctx.tenantId, project_id: project.id,
              run_id: run.id, deliverable_id: deliverable.deliverable_id, version_id: version.id,
              layer: draft.layer, code: draft.code, severity: draft.severity,
              message: draft.message, evidence: draft.evidence,
              truth_version: truth?.version ?? null,
              sku_profile_version: profile?.version ?? null,
              status: 'open', resolution: null,
              created_by: ctx.actorId, created_at: timestamp,
            };
            data.check_issues[id] = record;
            existingIssues.push(record);
            created += 1;
          }
        }
      }
      return { checked, created, auto_cleared: autoCleared, ocr_configured: ocrConfigured };
    });
    const listed = await readSkuChecks(ctx, projectId);
    send(200, { ...outcome, ...listed });
  }

  /** 项目核对问题查询：补展示辅助（交付物名、版本号、是否当前选用），按层分组计数。 */
  async function readSkuChecks(ctx, projectId) {
    return store.read(data => {
      const project = findProject(data, ctx, projectId);
      const runsById = new Map(Object.values(data.runs ?? {})
        .filter(run => run.tenant_id === ctx.tenantId && run.project_id === project.id)
        .map(run => [run.id, run]));
      const issues = Object.values(data.check_issues ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id)
        .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))
        .map(item => {
          const run = runsById.get(item.run_id) ?? null;
          const target = run?.deliverables?.find(d => d.deliverable_id === item.deliverable_id) ?? null;
          const version = run?.versions?.find(v => v.id === item.version_id) ?? null;
          return presentCheckIssue({
            ...item,
            deliverable_label: target?.label ?? item.deliverable_id,
            version_number: version?.number ?? null,
            version_active: version ? target?.active_version_id === version.id : null,
          });
        });
      const summary = Object.fromEntries(CHECK_LAYERS.map(layer => [layer, {
        open: issues.filter(item => item.layer === layer && item.status === 'open').length,
        blocker: issues.filter(item => item.layer === layer && item.status === 'open' && item.severity === 'blocker').length,
      }]));
      return { project_id: project.id, issues, summary };
    });
  }

  async function listSkuChecks(ctx, projectId, send) {
    send(200, await readSkuChecks(ctx, projectId));
  }

  async function getCheckIssue(ctx, issueId, send) {
    const found = await store.read(data => {
      const issue = data.check_issues?.[issueId] ?? null;
      if (!issue || issue.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '核对问题不存在');
      return presentCheckIssue(issue);
    });
    send(200, { issue: found });
  }

  /**
   * 人工复核/更正归属：依据必填；blocker 不能用「确认无误」放行（满意不覆盖硬错误）；
   * 更正归属（reassign）仅限归属层，目标 SKU 必须在当前档案内，并在依赖记录留 manual 痕迹。
   */
  async function resolveCheckIssue(ctx, req, issueId, send) {
    const body = await readJson(req);
    const outcome = await store.mutate(data => {
      const issue = data.check_issues?.[issueId] ?? null;
      if (!issue || issue.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '核对问题不存在');
      const project = data.projects?.[issue.project_id] ?? null;
      if (!project) throw new ApiError(404, 'NOT_FOUND', '核对问题所属项目不存在');
      const profile = headSkuProfileOf(data, project);
      const input = validateResolveInput(body, issue, profile);
      const timestamp = now();
      issue.status = 'resolved';
      issue.resolution = {
        action: input.action, actor: ctx.actorId, reason: input.reason, at: timestamp,
        version_id: issue.version_id,
        truth_version: issue.truth_version ?? null,
        sku_profile_version: profile?.version ?? null,
        target_sku_id: input.target_sku_id ?? null,
      };
      if (input.action === 'reassign') {
        // 可追溯：在依赖记录并入 manual sku 条目；deterministic 条目不删不动
        const entry = {
          kind: 'sku', ref: input.target_sku_id, evidence: 'manual',
          note: `E04 归属更正（原问题 ${issue.code}）`, reason: input.reason,
          actor: ctx.actorId, at: timestamp,
        };
        const record = Object.values(data.image_dependencies ?? {}).find(item =>
          item.run_id === issue.run_id && item.deliverable_id === issue.deliverable_id
          && item.version_id === issue.version_id) ?? null;
        if (record) {
          record.entries = mergeManualEntries(record.entries, [entry]);
        } else {
          const id = newId('dep');
          data.image_dependencies[id] = {
            id, tenant_id: ctx.tenantId, project_id: issue.project_id,
            run_id: issue.run_id, deliverable_id: issue.deliverable_id, version_id: issue.version_id,
            entries: [entry], status: 'active', created_by: ctx.actorId, created_at: timestamp,
          };
        }
      }
      return issue;
    });
    send(200, { issue: presentCheckIssue(outcome) });
  }

  // ---------- E04：按 SKU 导出 ----------

  async function createSkuExportRoute(ctx, req, projectId, send) {
    const body = await readJson(req);
    const skuId = typeof body?.sku_id === 'string' ? body.sku_id.trim() : '';
    if (!skuId) throw new ApiError(422, 'INVALID_FIELD', 'sku_id 必填：按 SKU 导出必须指明目标 SKU');
    const result = await jobs.createSkuExport(ctx, projectId, { skuId });
    send(201, result);
  }

  async function listSkuExportsRoute(ctx, projectId, send) {
    const result = await jobs.listExports(ctx, { projectId });
    send(200, { ...result, exports: result.exports.filter(item => item.kind === 'sku_export') });
  }

  // ---------- E05：售前问题分流 ----------

  /**
   * 问题组引用的 SKU 在当前档案里重新定位。档案更新会重生成 SKU id，
   * 因此 id 失效时按商家 SKU 编号回落；都找不到返回 null（不伪造归属）。
   */
  function resolveQuestionSku(profile, group) {
    const skus = profile?.skus ?? [];
    const byId = group.sku_id ? skus.find(item => item.id === group.sku_id) ?? null : null;
    if (byId) return byId;
    if (group.sku_code) return skus.find(item => item.sku_code === group.sku_code) ?? null;
    return null;
  }

  /** 复用候选只取当前通过全部导出闸口的版本；非商品图问题与无 SKU 问题不列。 */
  async function reusableVersionsFor(ctx, projectId, skuId, category) {
    if (!skuId || OUT_OF_SCOPE_CATEGORIES.includes(category)) return [];
    const plan = await jobs.planSkuAvailability(ctx, projectId, skuId);
    return plan.ok ? plan.included : [];
  }

  /** 分析结果绑定的档案/事实版本；之后任一版本更新都提示需要重新分析，旧确认不自动放行。 */
  function questionStale(data, project, group) {
    const truth = headTruthOf(data, project);
    if ((group.facts_snapshot?.truth_version ?? null) !== (truth?.version ?? null)) return true;
    if (!group.sku_id) return false;
    const profile = headSkuProfileOf(data, project);
    return (group.facts_snapshot?.sku_profile_version ?? null) !== (profile?.version ?? null);
  }

  /**
   * 分析售前问题：输入先脱敏校验（含个人信息直接拒绝入库），再按当前 SKU/事实做五类分流。
   * 幂等键必填：同一键重放返回原问题组；键被不同请求复用 → 409。
   * 分析入库不消耗生图额度，也不自动补事实。
   */
  async function analyzeQuestionRoute(ctx, req, projectId, send) {
    const body = await readJson(req);
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey === '') {
      throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', '分析售前问题必须带 Idempotency-Key，避免同一问题重复入库');
    }
    const input = validateQuestionInput(body);
    const fingerprint = fingerprintOf({ project_id: projectId, body });
    // 先只读确认项目与 SKU 身份，再用导出闸口算出「已有图可复用」候选
    const scoped = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const profile = headSkuProfileOf(data, project);
      let sku = null;
      if (input.skuId) {
        sku = (profile?.skus ?? []).find(item => item.id === input.skuId) ?? null;
        if (!sku) throw new ApiError(404, 'NOT_FOUND', '指定的 SKU 不在当前档案内');
      }
      return { projectId: project.id, sku };
    });
    const category = suggestCategory(input.text);
    const reusableVersions = await reusableVersionsFor(ctx, scoped.projectId, scoped.sku?.id ?? null, category);
    const outcome = await store.mutate(data => {
      const project = findProject(data, ctx, projectId);
      const existing = Object.values(data.question_groups ?? {}).find(item =>
        item.tenant_id === ctx.tenantId && item.idempotency_key === idempotencyKey) ?? null;
      if (existing) {
        if (existing.idempotency_fingerprint !== fingerprint) {
          throw new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT',
            '该 Idempotency-Key 已用于另一条不同的问题，请更换后再提交', { group_id: existing.id });
        }
        return { group: existing, replayed: true };
      }
      const profile = headSkuProfileOf(data, project);
      const truth = headTruthOf(data, project);
      const sku = input.skuId ? (profile?.skus ?? []).find(item => item.id === input.skuId) ?? null : null;
      if (input.skuId && !sku) throw new ApiError(404, 'NOT_FOUND', '指定的 SKU 不在当前档案内');
      const analysis = analyzeQuestion({ category, sku, skuProfile: profile, truth, reusableVersions });
      // 同一项目同一问题文本再次出现：关联到最近一条，提示先看现有适用图（不合并、不覆盖历史）
      const prior = Object.values(data.question_groups ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id
          && item.text.trim() === input.text)
        .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0] ?? null;
      const id = newId('qg');
      const timestamp = now();
      const record = {
        id,
        tenant_id: ctx.tenantId,
        project_id: project.id,
        text: input.text,
        sku_id: sku?.id ?? null,
        sku_code: sku?.sku_code ?? null,
        category_suggested: category,
        category_final: category,
        frequency: input.frequency,
        frequency_source: input.frequency ? 'manual' : null,
        result: analysis.result,
        detail: analysis.detail,
        duplicate_of: prior?.id ?? null,
        facts_snapshot: {
          truth_version: truth?.version ?? null,
          sku_profile_version: profile?.version ?? null,
        },
        status: 'open',
        confirmed_at: null,
        confirmed_by: null,
        review_history: [],
        idempotency_key: idempotencyKey,
        idempotency_fingerprint: fingerprint,
        created_by: ctx.actorId,
        created_at: timestamp,
        updated_at: timestamp,
      };
      data.question_groups[id] = record;
      return { group: record, replayed: false, stale: false };
    });
    send(outcome.replayed ? 200 : 201, {
      group: presentQuestionGroup(outcome.group),
      facts_stale: outcome.stale ?? false,
      replayed: outcome.replayed,
    });
  }

  async function listQuestionGroups(ctx, projectId, query, send) {
    const result = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const statusFilter = typeof query?.get === 'function' ? query.get('status') ?? null : null;
      const groups = Object.values(data.question_groups ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id)
        .filter(item => !statusFilter || item.status === statusFilter)
        .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))
        .map(item => ({
          ...presentQuestionGroup(item),
          facts_stale: questionStale(data, project, item),
        }));
      const summary = {
        total: groups.length,
        open: groups.filter(item => item.status === 'open').length,
        confirmed: groups.filter(item => item.status === 'confirmed').length,
        by_result: Object.fromEntries(QUESTION_RESULTS.map(key =>
          [key, groups.filter(item => item.result === key).length])),
      };
      return { project_id: project.id, groups, summary };
    });
    send(200, result);
  }

  async function getQuestionGroup(ctx, groupId, send) {
    const result = await store.read(data => {
      const group = data.question_groups?.[groupId] ?? null;
      if (!group || group.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '售前问题不存在');
      const project = data.projects?.[group.project_id] ?? null;
      if (!project) throw new ApiError(404, 'NOT_FOUND', '售前问题所属项目不存在');
      return {
        group: presentQuestionGroup(group),
        facts_stale: questionStale(data, project, group),
      };
    });
    send(200, result);
  }

  /**
   * 归类改正 / 确认结果：
   * - correct：按当前档案与事实重跑确定性分析（商家可改正系统归类），并清掉旧确认；
   * - confirm：确认推荐图种与提纲；分析所依据的档案/事实已更新（stale）时拒绝确认，要求重新分析。
   */
  async function reviewQuestionGroup(ctx, req, groupId, send) {
    const body = await readJson(req);
    const action = String(body?.action ?? '').trim();
    if (action !== 'confirm' && action !== 'correct') {
      throw new ApiError(422, 'INVALID_FIELD', 'action 必须为 confirm（确认结果）或 correct（改正归类）');
    }
    const allowed = [...QUESTION_CATEGORIES, ...OUT_OF_SCOPE_CATEGORIES];
    let category = null;
    if (action === 'correct') {
      category = String(body?.category ?? '').trim();
      if (!allowed.includes(category)) {
        throw new ApiError(422, 'INVALID_FIELD', `category 必须为 ${allowed.join(' / ')} 之一`, { allowed });
      }
    }
    const scoped = await store.read(data => {
      const group = data.question_groups?.[groupId] ?? null;
      if (!group || group.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '售前问题不存在');
      const project = data.projects?.[group.project_id] ?? null;
      if (!project) throw new ApiError(404, 'NOT_FOUND', '售前问题所属项目不存在');
      const sku = resolveQuestionSku(headSkuProfileOf(data, project), group);
      return { projectId: project.id, sku, group };
    });
    const reusableVersions = action === 'correct'
      ? await reusableVersionsFor(ctx, scoped.projectId, scoped.sku?.id ?? null, category)
      : [];
    const outcome = await store.mutate(data => {
      const group = data.question_groups?.[groupId] ?? null;
      if (!group || group.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '售前问题不存在');
      const project = findProject(data, ctx, group.project_id);
      if (action === 'confirm' && questionStale(data, project, group)) {
        throw new ApiError(409, 'QUESTION_STALE',
          '该问题的分析基于旧的档案/事实版本，确认已不可信；请改正归类以按当前版本重新分析', {
            facts_snapshot: group.facts_snapshot ?? null,
          });
      }
      const timestamp = now();
      if (action === 'correct') {
        const profile = headSkuProfileOf(data, project);
        const truth = headTruthOf(data, project);
        const sku = resolveQuestionSku(profile, group);
        const analysis = analyzeQuestion({ category, sku, skuProfile: profile, truth, reusableVersions });
        group.category_final = category;
        group.result = analysis.result;
        group.detail = analysis.detail;
        group.sku_id = sku?.id ?? group.sku_id ?? null;
        group.sku_code = sku?.sku_code ?? group.sku_code ?? null;
        group.facts_snapshot = {
          truth_version: truth?.version ?? null,
          sku_profile_version: profile?.version ?? null,
        };
        group.status = 'open';
        group.confirmed_at = null;
        group.confirmed_by = null;
      } else {
        group.status = 'confirmed';
        group.confirmed_at = timestamp;
        group.confirmed_by = ctx.actorId;
      }
      group.review_history = [...(group.review_history ?? []).slice(-9), {
        action, category, actor: ctx.actorId, at: timestamp, result: group.result,
      }];
      group.updated_at = timestamp;
      return { group: { ...group }, stale: questionStale(data, project, group) };
    });
    send(200, { group: presentQuestionGroup(outcome.group), facts_stale: outcome.stale });
  }

  // ---------- E02：图片版本依赖与导出渠道 ----------

  function findRun(data, ctx, runId) {
    const run = data.runs?.[runId] ?? null;
    if (!run || run.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
    return run;
  }

  function dependencyRecordsOf(data, run) {
    return Object.values(data.image_dependencies ?? {})
      .filter(item => item.run_id === run.id && item.tenant_id === run.tenant_id);
  }

  /** 版本依赖的证据档位：无记录 = unknown（前端只能提示"关联信息不足，待人工关联"，不得显示"无需更新"）。 */
  function recordEvidence(record) {
    if (!record || (record.entries ?? []).length === 0) return 'unknown';
    if (record.entries.some(item => item.evidence === 'deterministic')) return 'deterministic';
    return 'manual';
  }

  async function getRunDependencies(ctx, runId, send) {
    const result = await store.read(data => {
      const run = findRun(data, ctx, runId);
      const byVersion = new Map(dependencyRecordsOf(data, run).map(item => [item.version_id, item]));
      return {
        run_id: run.id,
        project_id: run.project_id,
        deliverables: (run.deliverables ?? []).map(target => {
          const versionId = target.active_version_id ?? null;
          const record = versionId ? byVersion.get(versionId) ?? null : null;
          return {
            deliverable_id: target.deliverable_id,
            label: target.label ?? target.deliverable_id,
            version_id: versionId,
            evidence: recordEvidence(record),
            entries: record ? record.entries.map(item => ({ ...item })) : [],
          };
        }),
      };
    });
    send(200, result);
  }

  async function getDeliverableDependencies(ctx, runId, deliverableId, send) {
    const result = await store.read(data => {
      const run = findRun(data, ctx, runId);
      const target = (run.deliverables ?? []).find(item => item.deliverable_id === deliverableId);
      if (!target) throw new ApiError(404, 'NOT_FOUND', '交付物不存在');
      const byVersion = new Map(
        dependencyRecordsOf(data, run)
          .filter(item => item.deliverable_id === deliverableId)
          .map(item => [item.version_id, item]),
      );
      return {
        run_id: run.id,
        deliverable_id: deliverableId,
        active_version_id: target.active_version_id ?? null,
        versions: (run.versions ?? [])
          .filter(item => item.deliverable_id === deliverableId)
          .map(version => {
            const record = byVersion.get(version.id) ?? null;
            return {
              version_id: version.id,
              number: version.number,
              active: version.active === true,
              created_at: version.created_at,
              evidence: recordEvidence(record),
              record_id: record?.id ?? null,
              entries: record ? record.entries.map(item => ({ ...item })) : [],
            };
          }),
      };
    });
    send(200, result);
  }

  async function postManualDependency(ctx, req, runId, deliverableId, send) {
    const body = await readJson(req);
    const record = await store.mutate(data => {
      const run = findRun(data, ctx, runId);
      const target = (run.deliverables ?? []).find(item => item.deliverable_id === deliverableId);
      if (!target) throw new ApiError(404, 'NOT_FOUND', '交付物不存在');
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
      }
      const versionId = typeof body.version_id === 'string' ? body.version_id.trim() : '';
      const version = (run.versions ?? []).find(item => item.id === versionId && item.deliverable_id === deliverableId);
      if (!version) throw new ApiError(404, 'NOT_FOUND', '指定的图片版本不存在或不属于该交付物');
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason || reason.length > 300) {
        throw new ApiError(422, 'INVALID_FIELD', 'reason 必填且不超过 300 字符：人工关联必须留下依据');
      }
      if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 20) {
        throw new ApiError(422, 'INVALID_FIELD', 'entries 必须为 1—20 项的数组');
      }
      // ref 范围校验：fact 在当前事实版本内；asset/sku 属于该项目；brand 属于该租户；text_layer 真实存在
      const truthHead = Object.values(data.truth_versions ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === run.project_id)
        .sort((left, right) => left.version - right.version).at(-1) ?? null;
      const skuHead = Object.values(data.sku_profiles ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === run.project_id)
        .sort((left, right) => left.version - right.version).at(-1) ?? null;
      const knownLayerIds = new Set();
      for (const item of run.versions ?? []) for (const layer of item.text_layers ?? []) knownLayerIds.add(layer.id);
      for (const item of run.execution?.plan?.deliverables ?? []) for (const layer of item.text_layers ?? []) knownLayerIds.add(layer.id);
      const timestamp = now();
      const manual = body.entries.map((item, index) => {
        const at = `entries[${index}]`;
        const kind = item?.kind;
        if (!DEPENDENCY_KINDS.includes(kind)) {
          throw new ApiError(422, 'INVALID_FIELD', `${at}.kind 必须是 ${DEPENDENCY_KINDS.join(' / ')} 之一`);
        }
        const ref = typeof item?.ref === 'string' ? item.ref.trim() : '';
        if (!ref) throw new ApiError(422, 'INVALID_FIELD', `${at}.ref 必填`);
        const note = item?.note === undefined || item?.note === null || item?.note === '' ? null : String(item.note).trim();
        if (note && note.length > 300) throw new ApiError(422, 'INVALID_FIELD', `${at}.note 不能超过 300 字符`);
        if (kind === 'fact') {
          const ok = ref === 'critical_text' || (truthHead?.facts ?? []).some(fact => fact.key === ref);
          if (!ok) throw new ApiError(422, 'INVALID_FIELD', `${at}.ref「${ref}」不在该项目当前事实版本内`);
        }
        if (kind === 'asset') {
          const asset = data.assets?.[ref];
          if (!asset || asset.tenant_id !== ctx.tenantId || asset.project_id !== run.project_id) {
            throw new ApiError(422, 'INVALID_FIELD', `${at}.ref 指向的素材不属于该项目`);
          }
        }
        if (kind === 'brand') {
          const kit = data.brand_kits?.[ref];
          if (!kit || kit.tenant_id !== ctx.tenantId) {
            throw new ApiError(422, 'INVALID_FIELD', `${at}.ref 指向的品牌套件不存在`);
          }
        }
        if (kind === 'sku') {
          const ok = (skuHead?.skus ?? []).some(sku => sku.id === ref);
          if (!ok) throw new ApiError(422, 'INVALID_FIELD', `${at}.ref 指向的 SKU 不在该项目当前档案内`);
        }
        if (kind === 'text_layer' && !knownLayerIds.has(ref)) {
          throw new ApiError(422, 'INVALID_FIELD', `${at}.ref 指向的文字层不存在`);
        }
        return { kind, ref, evidence: 'manual', note, reason, actor: ctx.actorId, at: timestamp };
      });
      const existing = Object.values(data.image_dependencies ?? {}).find(item =>
        item.run_id === run.id && item.deliverable_id === deliverableId && item.version_id === version.id) ?? null;
      if (existing) {
        existing.entries = mergeManualEntries(existing.entries, manual);
        return existing;
      }
      const id = newId('dep');
      const created = {
        id, tenant_id: ctx.tenantId, project_id: run.project_id,
        run_id: run.id, deliverable_id: deliverableId, version_id: version.id,
        entries: manual, status: 'active', created_by: ctx.actorId, created_at: timestamp,
      };
      data.image_dependencies[id] = created;
      return created;
    });
    send(201, { dependency: presentDependency(record) });
  }

  async function deleteManualDependency(ctx, req, runId, deliverableId, rawRef, query, send) {
    const decoded = decodeURIComponent(String(rawRef ?? ''));
    const sep = decoded.indexOf(':');
    const kind = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const ref = sep >= 0 ? decoded.slice(sep + 1) : '';
    let reason = String(query?.get('reason') ?? '').trim();
    if (!reason && Number(req.headers['content-length'] ?? 0) > 0) {
      const body = await readJson(req);
      reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    }
    if (!reason || reason.length > 300) {
      throw new ApiError(422, 'INVALID_FIELD', '删除人工关联必须带 reason（query 或请求体），且不超过 300 字符');
    }
    const record = await store.mutate(data => {
      const run = findRun(data, ctx, runId);
      const target = (run.deliverables ?? []).find(item => item.deliverable_id === deliverableId);
      if (!target) throw new ApiError(404, 'NOT_FOUND', '交付物不存在');
      const holders = dependencyRecordsOf(data, run).filter(item => item.deliverable_id === deliverableId);
      const holder = holders.find(item => (item.entries ?? []).some(entry => entry.kind === kind && entry.ref === ref)) ?? null;
      if (!holder) throw new ApiError(404, 'NOT_FOUND', '该依赖条目不存在');
      const entry = holder.entries.find(item => item.kind === kind && item.ref === ref);
      if (entry.evidence !== 'manual') {
        throw new ApiError(409, 'DEPENDENCY_LOCKED', '系统编译的确定依赖不可删除；如有异议请修正事实或素材后重新生成版本');
      }
      holder.entries = holder.entries.filter(item => !(item.kind === kind && item.ref === ref));
      // 删除也留痕：谁、何时、为什么移除了这条人工关联
      (holder.removals ??= []).push({ kind, ref, actor: ctx.actorId, at: now(), reason });
      return holder;
    });
    send(200, { dependency: presentDependency(record) });
  }

  function findExportRecord(data, ctx, exportId) {
    const found = data.exports?.[exportId] ?? null;
    if (!found || found.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '导出记录不存在');
    return found;
  }

  function presentChannels(record, exportId) {
    return {
      export_id: exportId,
      labels: record?.labels ?? [],
      note: record?.note ?? null,
      updated_by: record?.updated_by ?? null,
      updated_at: record?.updated_at ?? null,
    };
  }

  async function putExportChannels(ctx, req, exportId, send) {
    const body = await readJson(req);
    const record = await store.mutate(data => {
      findExportRecord(data, ctx, exportId);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
      }
      if (!Array.isArray(body.labels) || body.labels.length > 8) {
        throw new ApiError(422, 'INVALID_FIELD', 'labels 必须为不超过 8 个的数组');
      }
      const labels = [...new Set(body.labels.map((label, index) => {
        if (typeof label !== 'string' || label.trim() === '') {
          throw new ApiError(422, 'INVALID_FIELD', `labels[${index}] 不能为空`);
        }
        const trimmed = label.trim();
        if (trimmed.length > 40) throw new ApiError(422, 'INVALID_FIELD', `labels[${index}] 不能超过 40 个字符`);
        return trimmed;
      }))];
      const note = body.note === undefined || body.note === null || body.note === '' ? null : String(body.note).trim();
      if (note && note.length > 300) throw new ApiError(422, 'INVALID_FIELD', 'note 不能超过 300 字符');
      const timestamp = now();
      const existing = data.export_channels?.[exportId] ?? null;
      const record = existing ?? {
        id: newId('exc'), tenant_id: ctx.tenantId, export_id: exportId, history: [],
      };
      if (existing) {
        // 保留更新历史：labels/note/updated_by/at 每次都进 history
        record.history.push({
          labels: existing.labels, note: existing.note,
          updated_by: existing.updated_by, updated_at: existing.updated_at,
        });
      }
      record.labels = labels;
      record.note = note;
      record.updated_by = ctx.actorId;
      record.updated_at = timestamp;
      data.export_channels[exportId] = record;
      return record;
    });
    send(200, { channels: presentChannels(record, exportId) });
  }

  async function getExportChannels(ctx, exportId, send) {
    const result = await store.read(data => {
      findExportRecord(data, ctx, exportId);
      return presentChannels(data.export_channels?.[exportId] ?? null, exportId);
    });
    send(200, { channels: result });
  }

  async function getAssetDependents(ctx, projectId, assetId, send) {
    const result = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const asset = data.assets?.[assetId] ?? null;
      if (!asset || asset.tenant_id !== ctx.tenantId || asset.project_id !== project.id) {
        throw new ApiError(404, 'NOT_FOUND', '素材不存在');
      }
      const dependents = Object.values(data.image_dependencies ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id
          && (item.entries ?? []).some(entry => entry.kind === 'asset' && entry.ref === assetId))
        .map(item => ({
          run_id: item.run_id,
          deliverable_id: item.deliverable_id,
          version_id: item.version_id,
          evidence: item.entries.find(entry => entry.kind === 'asset' && entry.ref === assetId)?.evidence ?? 'unknown',
          status: item.status,
          created_at: item.created_at,
        }));
      // 空数组也明确返回：由前端区分"无依赖"与"未检查"
      return { asset_id: assetId, project_id: project.id, dependents };
    });
    send(200, result);
  }

  // ---------- E03：商品变更更新助手 ----------

  function findChangeOrder(data, ctx, changeId) {
    const order = data.change_orders?.[changeId] ?? null;
    if (!order || order.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '变更单不存在');
    return order;
  }

  function truthVersionOf(data, project, version) {
    return Object.values(data.truth_versions ?? {}).find(item =>
      item.tenant_id === project.tenant_id && item.project_id === project.id && item.version === version) ?? null;
  }

  function headSkuProfileOf(data, project) {
    const versions = Object.values(data.sku_profiles ?? {})
      .filter(item => item.project_id === project.id && item.tenant_id === project.tenant_id)
      .sort((left, right) => left.version - right.version);
    return versions[versions.length - 1] ?? null;
  }

  /** 单项重生成计价：按该项源任务冻结 spec 的单张成品报价；算不出来时回落 1 点。 */
  function changePriceOfItem(data, project) {
    return item => {
      const run = data.runs?.[item.run_id] ?? null;
      if (!run) return 1;
      try {
        const spec = resolveSpecRecord(data, project.id, run.spec_ref?.version);
        return quoteFromSpec({
          spec, finishedImages: true, includeOptional: true,
          onlyDeliverableIds: [item.deliverable_id], at: new Date(clock()),
        }).estimated_credits;
      } catch {
        return 1;
      }
    };
  }

  /**
   * 解析变更载荷：事实部分复用 validateTruthInput（含 SKU 一致性、素材依据校验），
   * SKU 档案部分（可选）复用 validateSkuProfilesInput。预览不传 confirm，落库才确认。
   */
  function parseChangePayload(data, ctx, project, body, { confirm }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
    }
    const assets = Object.values(data.assets)
      .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
    const baseTruth = Number.isInteger(body.base_truth_version) && body.base_truth_version >= 0
      ? body.base_truth_version : project.truth_head_version;
    const truthPayload = validateTruthInput({
      base_version: baseTruth,
      sku: body.sku,
      category: body.category,
      facts: body.facts,
      immutable_regions: body.immutable_regions,
      critical_text: body.critical_text,
      confirm,
    }, { project, assets });
    let skuPayload = null;
    if (body.skus !== undefined) {
      if (!Array.isArray(body.skus)) throw new ApiError(422, 'INVALID_FIELD', 'skus 必须为数组');
      skuPayload = validateSkuProfilesInput({
        base_version: project.sku_head_version ?? 0,
        confirm,
        skus: body.skus,
      }, { project, assets });
    }
    return { truthPayload, skuPayload };
  }

  function computeChangeImpactIn(data, project, diff, skuDiff) {
    const items = computeImpactList(data, project, diff, skuDiff)
      .map(item => ({ id: newId('itm'), ...item }));
    const quote = quoteChange(items, { priceOfItem: changePriceOfItem(data, project) });
    return { items, quote };
  }

  /** 预览：只算差异与影响，不落任何数据、不触发任何生成。 */
  async function previewChange(ctx, req, projectId, send) {
    const body = await readJson(req);
    const result = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const oldTruth = truthVersionOf(data, project, project.truth_head_version);
      if (!oldTruth) throw new ApiError(409, 'NO_TRUTH_VERSION', '项目尚无事实版本，无法做变更预检');
      const { truthPayload, skuPayload } = parseChangePayload(data, ctx, project, body, { confirm: false });
      const diff = diffTruth(oldTruth, { ...truthPayload, changed_asset_ids: body.changed_asset_ids, brand_kit_changed: body.brand_kit_changed });
      const skuDiff = skuPayload
        ? diffSkuProfiles(headSkuProfileOf(data, project)?.skus ?? [], skuPayload.skus)
        : [];
      const { items, quote } = computeChangeImpactIn(data, project, diff, skuDiff);
      return {
        project_id: project.id,
        base_truth_version: project.truth_head_version,
        diff,
        sku_diff: skuDiff,
        impact_items: items.map(item => ({ ...item, status: 'pending' })),
        quote,
        empty: diffIsEmpty(diff, skuDiff),
      };
    });
    send(200, result);
  }

  /**
   * 确认变更：同一 mutate 内创建新事实版本（可选同时创建新 SKU 档案版本）+ 变更单。
   * Idempotency-Key 必需；重放返回同一单；键被不同请求复用 → 409。
   */
  async function confirmChange(ctx, req, projectId, send) {
    const body = await readJson(req);
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey === '') {
      throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', '创建变更单必须带 Idempotency-Key，避免重复提交产生重复变更');
    }
    const fingerprint = fingerprintOf({ project_id: projectId, body });
    const outcome = await store.mutate(data => {
      const project = findProject(data, ctx, projectId);
      const existing = Object.values(data.change_orders ?? {})
        .find(item => item.tenant_id === ctx.tenantId && item.idempotency_key === idempotencyKey) ?? null;
      if (existing) {
        if (existing.idempotency_fingerprint && existing.idempotency_fingerprint !== fingerprint) {
          throw new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT',
            '该 Idempotency-Key 已用于另一份不同的变更请求，请更换后再提交', { change_id: existing.id });
        }
        return { order: existing, replayed: true };
      }
      if (!Number.isInteger(body?.base_truth_version) || body.base_truth_version < 1) {
        throw new ApiError(422, 'INVALID_FIELD', 'base_truth_version 必须为不小于 1 的整数（当前事实版本号）');
      }
      if (body.base_truth_version !== project.truth_head_version) {
        throw new ApiError(409, 'VERSION_CONFLICT',
          `事实版本已更新到 v${project.truth_head_version}，旧变更单不能覆盖新确认版本，请基于最新版本重新预检`, {
            current_version: project.truth_head_version,
          });
      }
      const oldTruth = truthVersionOf(data, project, body.base_truth_version);
      if (!oldTruth) throw new ApiError(404, 'NOT_FOUND', '基准事实版本不存在');
      const { truthPayload, skuPayload } = parseChangePayload(data, ctx, project, body, { confirm: true });
      const diff = diffTruth(oldTruth, { ...truthPayload, changed_asset_ids: body.changed_asset_ids, brand_kit_changed: body.brand_kit_changed });
      const oldSkus = headSkuProfileOf(data, project)?.skus ?? [];
      const skuDiff = skuPayload ? diffSkuProfiles(oldSkus, skuPayload.skus) : [];
      if (diffIsEmpty(diff, skuDiff)) {
        throw new ApiError(409, 'NO_CHANGES', '本次提交与当前版本没有差异，未创建变更单');
      }
      // 同一 mutate 内先落新事实版本（乐观锁在 applyTruthVersionIn 内），再按需落 SKU 档案版本
      const { record: truthRecord } = applyTruthVersionIn(data, ctx, project, truthPayload);
      const skuRecord = skuPayload ? applySkuProfilesIn(data, ctx, project, skuPayload) : null;
      const { items, quote } = computeChangeImpactIn(data, project, diff, skuDiff);
      const timestamp = now();
      const order = {
        id: newId('chg'),
        schema_version: 1,
        tenant_id: ctx.tenantId,
        project_id: project.id,
        base_truth_version: body.base_truth_version,
        new_truth_version: truthRecord.version,
        sku_profile_version: skuRecord?.version ?? null,
        diff,
        sku_diff: skuDiff,
        status: 'confirmed',
        impact_items: items.map(item => ({
          ...item, status: 'pending', result_version_id: null, error: null, charged_credits: 0,
        })),
        quote,
        idempotency_key: idempotencyKey,
        idempotency_fingerprint: fingerprint,
        created_by: ctx.actorId,
        created_at: timestamp,
        confirmed_at: timestamp,
        finished_at: null,
      };
      data.change_orders[order.id] = order;
      return { order, replayed: false };
    });
    send(outcome.replayed ? 200 : 201, {
      change: presentChange(outcome.order),
      replayed: outcome.replayed,
    });
  }

  async function listChanges(ctx, projectId, send) {
    const result = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const items = Object.values(data.change_orders ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === project.id)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .map(presentChange);
      return { changes: items, total: items.length };
    });
    send(200, result);
  }

  /**
   * 逐项状态回写（reconcile）：regenerate 项的异步子任务到终态后，把结果回写到变更项。
   * 结果绑定该子任务的实际产物（源任务 regenerations 登记中的 adopted_version_id），
   * 不以源交付物上任意 activeId 变化冒充本变更完成。
   * 子任务完成且其产物已被选用 → done；完成但未自动选用（质检待复核）→ failed 且明确不必重试；
   * 子任务失败/取消/超限 → failed（失败子任务已释放预留，重试才产生新预留）。
   * running 但子任务缺失（如重启中断在认领与子任务创建之间）→ failed，可安全重试。
   */
  function reconcileChangeOrder(data, order) {
    if (order.status === 'cancelled') return false;
    // 不按整单状态白名单跳过：confirmed 单也可能存在中断遗留的 running 认领项，
    // 只要读变更单就逐项核对子任务；收口后的整单状态由 finalizeChangeOrder 重算
    let touched = false;
    for (const item of order.impact_items ?? []) {
      if (item.status !== 'running') continue;
      const child = item.child_run_id ? data.runs?.[item.child_run_id] ?? null : null;
      if (!child) {
        // 已认领但子任务不存在：重启/中断恢复，按失败处理（预留未产生或已随子任务生命周期处理），可重试
        touched = true;
        item.status = 'failed';
        item.error = '执行中断（服务重启或子任务缺失），未产生有效生成；可重试，重试才产生新预留';
        item.error_code = 'EXECUTION_INTERRUPTED';
        continue;
      }
      if (!TERMINAL_STATES.has(child.status)) continue;
      touched = true;
      if (child.status === 'completed') {
        const sourceRun = data.runs?.[item.run_id] ?? null;
        const target = sourceRun?.deliverables?.find(entry => entry.deliverable_id === item.deliverable_id) ?? null;
        const registration = (sourceRun?.regenerations ?? []).find(entry => entry.run_id === child.id) ?? null;
        const adoptedId = registration?.adopted_version_id ?? null;
        if (adoptedId && target?.active_version_id === adoptedId) {
          item.status = 'done';
          item.result_version_id = adoptedId;
          item.error = null;
        } else {
          item.status = 'failed';
          item.error = '重生成完成但新版本质检待人工复核，未自动选用；请在任务详情复核放行，无需重试扣费';
          item.error_code = 'REGENERATION_NEEDS_REVIEW';
        }
      } else {
        item.status = 'failed';
        item.error = `重生成子任务终态为 ${child.status}，预留额度已释放，可重试`;
        item.error_code = 'REGENERATION_FAILED';
      }
    }
    if (touched) finalizeChangeOrder(data, order);
    return touched;
  }

  /** 按逐项状态推导整单状态；终态时生成替换待办（按旧版本匹配历史导出）。 */
  function finalizeChangeOrder(data, order) {
    if (order.status === 'cancelled') return order;
    const derived = deriveChangeStatus(order.impact_items);
    order.status = derived.status;
    if (derived.status === 'completed' || derived.status === 'partial_failed'
      || derived.status === 'awaiting_material' || derived.status === 'awaiting_review') {
      order.finished_at ??= now();
      createReplacementTodosIn(data, order);
    }
    return order;
  }

  function createReplacementTodosIn(data, order) {
    const exportsOfProject = Object.values(data.exports ?? {})
      .filter(item => item.tenant_id === order.tenant_id && item.project_id === order.project_id);
    const existing = new Set(Object.values(data.replacement_todos ?? {})
      .map(item => `${item.export_id}:${item.old_version_id}`));
    for (const item of order.impact_items ?? []) {
      if (item.status !== 'done' || !item.result_version_id) continue;
      for (const exported of exportsOfProject) {
        const hit = (exported.included ?? []).some(row =>
          row.deliverable_id === item.deliverable_id && row.version_id === item.version_id);
        if (!hit) continue;
        const key = `${exported.id}:${item.version_id}`;
        if (existing.has(key)) continue;
        existing.add(key);
        const todo = {
          id: newId('rt'),
          tenant_id: order.tenant_id,
          project_id: order.project_id,
          change_id: order.id,
          export_id: exported.id,
          channel_labels: [...(data.export_channels?.[exported.id]?.labels ?? [])],
          deliverable_id: item.deliverable_id,
          old_version_id: item.version_id,
          new_version_id: item.result_version_id,
          status: 'pending',
          confirmed_by: null,
          confirmed_at: null,
          created_at: now(),
        };
        data.replacement_todos[todo.id] = todo;
      }
    }
  }

  async function getChange(ctx, changeId, send) {
    const order = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      reconcileChangeOrder(data, found);
      return found;
    });
    send(200, { change: presentChange(order) });
  }

  function mutateChangeItem(data, ctx, changeId, itemId, updater) {
    const order = findChangeOrder(data, ctx, changeId);
    const item = (order.impact_items ?? []).find(entry => entry.id === itemId) ?? null;
    if (!item) throw new ApiError(404, 'NOT_FOUND', '变更项不存在');
    updater(item, order);
    return item;
  }

  /** 执行单个文字重合成项：免费路径，复用既有底图（或变更项登记的补拍新实拍）重合成 + 重跑质检。 */
  async function runRecomposeItem(ctx, order, item) {
    const factTexts = {};
    for (const change of order.diff?.facts ?? []) {
      if (change.change === 'removed' || !change.to) continue;
      factTexts[change.key] = String(change.to.value ?? '');
    }
    const result = await jobs.recomposeVersionFacts({
      ctx,
      runId: item.run_id,
      deliverableId: item.deliverable_id,
      baseVersionId: item.version_id,
      factTexts,
      truthVersion: order.new_truth_version,
      baseAssetId: item.material_asset_id ?? null,
      note: `变更单 ${order.id} 文字重合成`,
    });
    await store.mutate(data => {
      mutateChangeItem(data, ctx, order.id, item.id, target => {
        target.result_version_id = result.version.id;
        if (result.activated) {
          target.status = 'done';
          target.error = null;
        } else if (result.report?.decision === 'blocked') {
          // 硬失败：不能靠人工核对绕过，记为失败，可重试或改用重生成
          target.status = 'failed';
          target.error = '文字重合成后质检存在硬失败，新版本未选用且不能靠核对放行；请调整事实后重试或改用重生成';
          target.error_code = 'RECOMPOSE_QA_BLOCKED';
        } else {
          // needs_review：新版本已生成但未自动选用。不算失败（无需重试、未产生费用），
          // 改为要求人工视觉核对；核对通过时一并选用新版本（见 visualCheckItem）。
          target.status = 'done';
          target.error = null;
          target.visual_check = 'required';
          target.pending_adoption = true;
        }
        // 补拍素材作为新底图时，把素材关联写进新版本的依赖记录（人工关联档位，含依据）
        if (item.material_asset_id) {
          const depRecord = Object.values(data.image_dependencies ?? {}).find(entry =>
            entry.run_id === item.run_id && entry.deliverable_id === item.deliverable_id
            && entry.version_id === result.version.id) ?? null;
          if (depRecord) {
            depRecord.entries = mergeManualEntries(depRecord.entries ?? [], [{
              kind: 'asset', ref: item.material_asset_id, evidence: 'manual', note: null,
              reason: '变更单补拍新实拍素材作为底图', actor: ctx.actorId, at: now(),
            }]);
          }
        }
      });
    });
  }

  /**
   * 执行单个重生成项：幂等键绑定变更单项（重试加 :rN 后缀）。
   * 与 M13 普通单张重做的差别：变更单重生成按「变更单的新事实版本」单独冻结一份
   * 生产配置快照（新事实 / 当前 SKU 档案版本 / 品牌套件当前版本 / 模板平台沿用源 spec），
   * 不复用源任务旧 spec 的内容语义；子任务输出、依赖与质检因此对齐新事实。
   * 价格口径沿用源任务单张成品报价（changePriceOfItem）；新 spec 实际报价超出确认价时拒绝执行。
   */
  async function runRegenerateItem(ctx, order, item, retryNo, { expectedCredits = null } = {}) {
    const key = retryNo > 0
      ? `chg:${order.id}:${item.id}:r${retryNo}`
      : `chg:${order.id}:${item.id}`;
    // 同一 mutate 内冻结新事实快照 spec（版本只增，乐观锁沿用 spec_head_version）
    const specVersion = await store.mutate(data => {
      const project = findProject(data, ctx, order.project_id);
      const sourceRun = data.runs?.[item.run_id] ?? null;
      if (!sourceRun) throw new ApiError(404, 'NOT_FOUND', '源任务不存在');
      const sourceSpec = resolveSpecRecord(data, project.id, sourceRun.spec_ref?.version);
      // 沿用源 spec 已裁决的冲突处理（商家在源任务冻结时已做选择）；新事实若引入新冲突，
      // buildSpecDraft 会抛 SPEC_CONFLICTS_PENDING，该项如实失败并提示人工处理，不静默放行
      const sourceResolutions = Object.fromEntries(
        (sourceSpec.provenance?.resolutions ?? []).map(entry => [entry.key, entry.option]));
      const draft = buildSpecDraft(data, ctx, project.id, {
        template_id: sourceSpec.template?.id,
        platform: sourceSpec.channel?.platform ?? project.platform,
        brand_kit_id: sourceSpec.brand_kit?.id ?? null,
        conflict_resolutions: sourceResolutions,
        base_version: project.spec_head_version,
      }, { persist: true, truthVersion: order.new_truth_version });
      const timestamp = now();
      const version = project.spec_head_version + 1;
      const previous = resolveSpecRecord(data, project.id, project.spec_head_version);
      const record = {
        id: newId('spec'),
        tenant_id: ctx.tenantId,
        project_id: project.id,
        version,
        base_version: project.spec_head_version,
        ...draft.payload,
        requires_requote: previous ? previous.deliverable_hash !== draft.payload.deliverable_hash : false,
        deliverable_changes: previous ? diffDeliverables(previous.deliverables, draft.payload.deliverables) : [],
        content_hash: specContentHash(draft.payload),
        created_by: ctx.actorId,
        created_at: timestamp,
        change_id: order.id,
        change_item_id: item.id,
        note: `变更单 ${order.id} 按事实 v${order.new_truth_version} 冻结的重生成快照`,
      };
      data.specs[record.id] = record;
      project.spec_head_version = version;
      project.updated_at = timestamp;
      return record.version;
    });
    const { created, prepared } = await launchRegeneration({
      ctx,
      sourceRunId: item.run_id,
      deliverableId: item.deliverable_id,
      sourceVersionId: item.version_id,
      idempotencyKey: key,
      specVersion,
      expectedCredits,
    });
    await store.mutate(data => {
      mutateChangeItem(data, ctx, order.id, item.id, target => {
        target.status = 'running';
        target.child_run_id = created.run.id;
        target.charged_credits = prepared.quote.estimated_credits ?? 0;
        target.retry_count = retryNo;
        target.spec_version = specVersion;
        target.error = null;
        target.error_code = null;
      });
    });
  }

  async function markItemFailed(ctx, orderId, itemId, error) {
    await store.mutate(data => {
      mutateChangeItem(data, ctx, orderId, itemId, target => {
        target.status = 'failed';
        target.error = error instanceof ApiError ? error.message : `执行失败：${error?.message ?? '未知错误'}`;
        target.error_code = error instanceof ApiError ? error.code : null;
      });
    });
  }

  /**
   * 执行变更单。body: {
   *   item_ids?: [...],                                   // 限定本次执行的项
   *   actions?: { [item_id]: 'text_recompose'|'regenerate'|'skip' },  // 商家对单项动作的明确选定
   *   override_reasons?: { [item_id]: string },           // needs_review 项覆盖动作的确切依据（必填）
   *   quote_confirm?: { price_version, estimated_credits } // 含重生成项时必须与服务器当前报价一致
   * }
   * 原子性：认领在同一 mutate 内完成（pending→running / skipped），并发重复执行只会成功一次；
   * 重生成在扣费前校验确认报价，余额不足 402 在认领前拒绝，不产生任何预留。
   */
  async function executeChange(ctx, req, changeId, send) {
    const body = await readJson(req).catch(() => ({}));
    const itemIds = Array.isArray(body?.item_ids) ? body.item_ids.map(String) : null;
    const actionOverrides = body?.actions && typeof body.actions === 'object' && !Array.isArray(body.actions)
      ? body.actions : {};
    const overrideReasons = body?.override_reasons && typeof body.override_reasons === 'object' && !Array.isArray(body.override_reasons)
      ? body.override_reasons : {};

    const claim = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      reconcileChangeOrder(data, found);
      if (found.status === 'cancelled') {
        throw new ApiError(409, 'CHANGE_CANCELLED', '变更单已取消，不能执行');
      }
      if (!['confirmed', 'partial_failed', 'executing', 'awaiting_material', 'awaiting_review', 'completed'].includes(found.status)) {
        throw new ApiError(409, 'CHANGE_NOT_EXECUTABLE', `变更单当前状态为 ${found.status}，不能执行`, { status: found.status });
      }
      const items = found.impact_items ?? [];
      if (itemIds) {
        const known = new Set(items.map(item => item.id));
        const missing = itemIds.filter(id => !known.has(id));
        if (missing.length > 0) throw new ApiError(404, 'NOT_FOUND', `变更项不存在：${missing.join('、')}`);
      }
      for (const [itemId, action] of Object.entries(actionOverrides)) {
        if (!['text_recompose', 'regenerate', 'skip'].includes(action)) {
          throw new ApiError(422, 'INVALID_FIELD', `actions.${itemId} 只能是 text_recompose / regenerate / skip`);
        }
      }
      // 可执行候选：pending；或 awaiting 的跳过项且商家本次给出明确动作（补资料后继续处理）。
      // 商家看过原因后显式选 skip：转为 user 跳过（知情放弃），不再阻塞整单完成。
      const candidates = items.filter(item => {
        if (itemIds && !itemIds.includes(item.id)) return false;
        if (item.status === 'pending') return true;
        if (item.status === 'skipped' && (item.awaiting === 'material' || item.awaiting === 'review')
          && actionOverrides[item.id]) {
          if (actionOverrides[item.id] === 'skip') return true;
          if (item.awaiting === 'material' && !item.material_asset_id) return false; // 缺新实拍不能执行
          return true;
        }
        return false;
      });
      if (candidates.length === 0) {
        throw new ApiError(409, 'NO_EXECUTABLE_ITEMS', '没有可执行的待处理变更项（可能都已处理或不在本次选择内）');
      }

      // 覆盖守卫：硬冲突（必须新实拍）不能靠选「改文字/重生成」绕过；未知项覆盖必须有确切依据
      const timestamp = now();
      const plan = candidates.map(item => {
        const action = actionOverrides[item.id] ?? item.action;
        if (item.action === 'needs_new_photo' && (action === 'text_recompose' || action === 'regenerate') && !item.material_asset_id) {
          throw new ApiError(409, 'HARD_OVERRIDE_BLOCKED',
            '该项实物已变化（如换包装），必须先补新实拍素材；不能用改文字或重绘冒充实物变化', { item_id: item.id });
        }
        if (item.action === 'needs_review' && action !== item.action && action !== 'skip') {
          const reason = typeof overrideReasons[item.id] === 'string' ? overrideReasons[item.id].trim() : '';
          if (reason === '') {
            throw new ApiError(422, 'OVERRIDE_REASON_REQUIRED',
              '该项证据不足（未知/待核对）：选择处理动作时必须给出确切依据，不能靠选择动作绕过人工判断', { item_id: item.id });
          }
          if (reason.length > 300) throw new ApiError(422, 'INVALID_FIELD', 'override_reasons 每项不能超过 300 个字符');
        }
        return { item, action };
      });

      // 重生成报价确认：预览默认 0 额度，商家选定重生成后必须确认最终报价（冻结口径）
      const regenPlan = plan.filter(entry => entry.action === 'regenerate');
      if (regenPlan.length > 0) {
        const priceOfItem = changePriceOfItem(data, findProject(data, ctx, found.project_id));
        const lines = regenPlan.map(entry => ({
          item_id: entry.item.id,
          run_id: entry.item.run_id,
          deliverable_id: entry.item.deliverable_id,
          credits: Math.max(0, Number(priceOfItem(entry.item)) || 0),
        }));
        const estimated = lines.reduce((sum, line) => sum + line.credits, 0);
        const serverQuote = { price_version: 'finished-image.1', estimated_credits: estimated, lines };
        const confirmQuote = body?.quote_confirm;
        if (!confirmQuote || typeof confirmQuote !== 'object') {
          throw new ApiError(409, 'QUOTE_CONFIRMATION_REQUIRED',
            '本次执行包含重生成项：请先确认最终报价（quote_confirm）后再执行', { quote: serverQuote });
        }
        if (confirmQuote.price_version !== serverQuote.price_version
          || Number(confirmQuote.estimated_credits) !== serverQuote.estimated_credits) {
          throw new ApiError(409, 'QUOTE_STALE',
            '报价已变化或与服务端不一致，请按最新报价重新确认', { quote: serverQuote });
        }
        const balance = balanceOf(data, ctx.tenantId, { initialCredits });
        if (balance.available < estimated) {
          throw new ApiError(402, 'INSUFFICIENT_CREDITS',
            `可用额度 ${balance.available} 不足以支付本次重生成 ${estimated}，请先充值或调整执行范围`, {
              available: balance.available, required: estimated,
            });
        }
        found.quote_confirm = { ...serverQuote, confirmed_by: ctx.actorId, confirmed_at: timestamp };
      }

      // 原子认领：同一 mutate 内逐项落定状态，并发重复执行只会有一批认领成功
      const claimed = [];
      for (const { item, action } of plan) {
        const autoSkip = action === 'skip'
          || (action === item.action && (item.action === 'needs_new_photo' || item.action === 'needs_review'));
        if (autoSkip) {
          item.status = 'skipped';
          item.skip_reason = action === 'skip'
            ? '商家选择跳过该项'
            : item.action === 'needs_new_photo'
              ? '需要重新实拍照片：请上传新实拍素材后继续处理'
              : '证据不足需人工核对，本流程不自动执行';
          item.awaiting = action === 'skip' ? 'user' : item.action === 'needs_new_photo' ? 'material' : 'review';
          item.executed_action = null;
          continue;
        }
        item.status = 'running';
        item.executed_action = action;
        item.claimed_at = timestamp;
        item.claimed_by = ctx.actorId;
        if (item.action === 'needs_review' && action !== item.action) {
          item.override_reason = String(overrideReasons[item.id]).trim();
          item.override_by = ctx.actorId;
          item.override_at = timestamp;
        }
        item.error = null;
        item.error_code = null;
        claimed.push({ itemId: item.id, action, run_id: item.run_id, deliverable_id: item.deliverable_id, version_id: item.version_id });
      }
      finalizeChangeOrder(data, found);
      return { order: found, claimed };
    });

    // 认领成功后逐项执行（重合成同步、重生成异步子任务）；单项失败不拖垮其他项
    for (const entry of claim.claimed) {
      const item = claim.order.impact_items.find(candidate => candidate.id === entry.itemId);
      try {
        if (entry.action === 'text_recompose') await runRecomposeItem(ctx, claim.order, item);
        else if (entry.action === 'regenerate') {
          await runRegenerateItem(ctx, claim.order, item, item.retry_count ?? 0, {
            expectedCredits: claim.order.quote_confirm?.lines?.find(line => line.item_id === item.id)?.credits ?? null,
          });
        }
      } catch (error) {
        await markItemFailed(ctx, claim.order.id, entry.itemId, error);
      }
    }

    const finalOrder = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      reconcileChangeOrder(data, found);
      return finalizeChangeOrder(data, found);
    });
    send(200, {
      change: presentChange(finalOrder),
      balance: await store.read(data => balanceOf(data, ctx.tenantId, { initialCredits })),
    });
  }

  /** 只重试 failed 项：文字重合成不产生费用；重生成用 :rN 新幂等键，失败子任务已释放预留，成功只结算一次。 */
  async function retryChange(ctx, req, changeId, send) {
    await readJson(req).catch(() => ({}));
    // 原子认领失败项（failed→running），并发重复重试只会成功认领一次
    const claim = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      reconcileChangeOrder(data, found);
      if (found.status !== 'partial_failed') {
        throw new ApiError(409, 'CHANGE_NOT_RETRYABLE', `变更单当前状态为 ${found.status}，只有部分失败的变更单才能重试`, { status: found.status });
      }
      // 排除 REGENERATION_NEEDS_REVIEW：子任务已 completed 但版本未选用，其预留仍冻结待人工复核释放，
      // 若重试会按新幂等键再预留一次造成泄漏；该类项应走任务详情人重复核放行，不在这里重试扣费。
      const failed = found.impact_items.filter(item =>
        item.status === 'failed'
        && ['text_recompose', 'regenerate'].includes(item.executed_action ?? item.action)
        && item.error_code !== 'REGENERATION_NEEDS_REVIEW');
      if (failed.length === 0) {
        throw new ApiError(409, 'NO_RETRYABLE_ITEMS', '没有可重试的失败项（质检待复核的项请走人工复核，不要重试）');
      }
      const timestamp = now();
      for (const item of failed) {
        item.status = 'running';
        item.claimed_at = timestamp;
        item.claimed_by = ctx.actorId;
        item.error = null;
        item.error_code = null;
      }
      finalizeChangeOrder(data, found);
      return { order: found, items: failed.map(item => ({ id: item.id, action: item.executed_action ?? item.action })) };
    });
    for (const entry of claim.items) {
      const item = claim.order.impact_items.find(candidate => candidate.id === entry.id);
      try {
        if (entry.action === 'text_recompose') await runRecomposeItem(ctx, claim.order, item);
        else await runRegenerateItem(ctx, claim.order, item, (item.retry_count ?? 0) + 1, {
          // 仅对「已实际发生过预留」的项校验确认价；从未扣到费的项（如中断恢复）按当前报价重新预留
          expectedCredits: Number(item.charged_credits) > 0 ? item.charged_credits : null,
        });
      } catch (error) {
        await markItemFailed(ctx, claim.order.id, entry.id, error);
      }
    }
    const finalOrder = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      reconcileChangeOrder(data, found);
      return finalizeChangeOrder(data, found);
    });
    send(200, {
      change: presentChange(finalOrder),
      balance: await store.read(data => balanceOf(data, ctx.tenantId, { initialCredits })),
    });
  }

  /**
   * 取消变更单：仅 confirmed/partial_failed/awaiting_* 可取消；运行中的重生成子任务一并请求取消
   * （取消走 jobs.cancelRun，预留额度随子任务终态释放；重复取消幂等）。
   */
  async function cancelChange(ctx, req, changeId, send) {
    const body = await readJson(req).catch(() => ({}));
    const reason = typeof body?.reason === 'string' && body.reason.trim() !== ''
      ? body.reason.trim().slice(0, 300) : '商家取消';
    const order = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      reconcileChangeOrder(data, found);
      if (found.status === 'cancelled') return found; // 重复取消幂等
      if (!['confirmed', 'partial_failed', 'awaiting_material', 'awaiting_review', 'executing'].includes(found.status)) {
        throw new ApiError(409, 'CHANGE_NOT_CANCELLABLE', `变更单当前状态为 ${found.status}，不能取消`, { status: found.status });
      }
      if ((found.impact_items ?? []).some(item => item.status === 'running' && !item.child_run_id)) {
        throw new ApiError(409, 'CHANGE_ITEMS_CLAIMED', '存在正在同步执行的变更项，请稍后待其落定后再取消');
      }
      return found;
    });
    // 取消运行中的重生成子任务（在锁外逐个请求，取消结果由 reconcile 回收）
    for (const item of order.impact_items ?? []) {
      if (item.status !== 'running' || !item.child_run_id) continue;
      try {
        await jobs.cancelRun({ ctx, runId: item.child_run_id, reason: `change_order_cancelled:${order.id}` });
      } catch { /* 子任务可能已到终态，取消失败不阻断整单取消 */ }
    }
    const cancelled = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      if (found.status === 'cancelled') return found;
      const timestamp = now();
      for (const item of found.impact_items ?? []) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'skipped';
          item.skip_reason = '已随变更单取消';
          item.awaiting = null;
          item.executed_action = null;
        }
      }
      found.status = 'cancelled';
      found.cancelled_at = timestamp;
      found.cancelled_by = ctx.actorId;
      found.cancel_reason = reason;
      return found;
    });
    send(200, {
      change: presentChange(cancelled),
      note: '变更单已取消；运行中的重生成子任务已请求取消，其预留额度随子任务终态释放，不会重复扣费',
    });
  }

  /**
   * 补拍素材登记：needs_new_photo 跳过项（awaiting=material）上传新实拍后，项恢复为可执行的
   * 文字重合成（以新素材为底图）；不伪造「实物已由模型更新」。
   */
  async function attachChangeItemMaterial(ctx, req, changeId, itemId, send) {
    const body = await readJson(req);
    const assetId = typeof body?.asset_id === 'string' ? body.asset_id.trim() : '';
    if (assetId === '') throw new ApiError(422, 'INVALID_FIELD', 'asset_id 必填：请上传新实拍照片并登记其素材 ID');
    const order = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      reconcileChangeOrder(data, found);
      if (found.status === 'cancelled') throw new ApiError(409, 'CHANGE_CANCELLED', '变更单已取消');
      const asset = data.assets?.[assetId] ?? null;
      if (!asset || asset.tenant_id !== ctx.tenantId || asset.project_id !== found.project_id) {
        throw new ApiError(404, 'NOT_FOUND', '素材不存在或不属于该项目');
      }
      if (asset.role_status !== 'active') {
        throw new ApiError(409, 'ASSET_INACTIVE', '该素材已被替换，请使用当前有效素材');
      }
      mutateChangeItem(data, ctx, changeId, itemId, item => {
        if (item.status !== 'skipped' || item.awaiting !== 'material') {
          throw new ApiError(409, 'ITEM_NOT_AWAITING_MATERIAL', '该项当前不处于待补实拍状态', { status: item.status, awaiting: item.awaiting ?? null });
        }
        item.material_asset_id = assetId;
        item.material_added_by = ctx.actorId;
        item.material_added_at = now();
        // 恢复为可执行：以新实拍为底图重合成文字层（数量类视觉核对要求保留）
        item.status = 'pending';
        item.action = 'text_recompose';
        item.awaiting = null;
        item.skip_reason = null;
      });
      return finalizeChangeOrder(data, found);
    });
    send(200, { change: presentChange(order) });
  }

  /** 数量/套装类变化的人工视觉核对：未确认前整单不允许 completed。
   *  重合成质检 needs_review 的项（pending_adoption=true）：核对通过即选用新版本；
   *  若报告存在硬失败（blocked）则拒绝——质检硬失败不能靠人工核对放行。 */
  async function visualCheckItem(ctx, req, changeId, itemId, send) {
    const body = await readJson(req);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason === '') throw new ApiError(422, 'INVALID_FIELD', 'reason 必填：请说明视觉数量核对结论');
    if (reason.length > 300) throw new ApiError(422, 'INVALID_FIELD', 'reason 不能超过 300 个字符');
    // 预检：判断核对通过时是否需要一并选用重合成产生的新版本
    const precheck = await store.read(data => {
      const found = findChangeOrder(data, ctx, changeId);
      const item = (found.impact_items ?? []).find(entry => entry.id === itemId) ?? null;
      if (!item) throw new ApiError(404, 'NOT_FOUND', '变更项不存在');
      if (item.status !== 'done' || item.visual_check !== 'required') {
        throw new ApiError(409, 'VISUAL_CHECK_NOT_REQUIRED', '该项无需视觉数量核对，或尚未执行完成');
      }
      if (!item.pending_adoption) return { adopt: false };
      const run = data.runs?.[item.run_id] ?? null;
      const version = run?.versions?.find(entry => entry.id === item.result_version_id) ?? null;
      if (!run || !version) {
        throw new ApiError(409, 'ADOPTION_STATE_INVALID', '重合成结果版本已不可用，请重试该项');
      }
      const deliverable = run.deliverables.find(entry => entry.deliverable_id === version.deliverable_id);
      if (deliverable?.active_version_id === version.id) return { adopt: false };
      const report = version.report_id ? data.quality_reports?.[version.report_id] ?? null : null;
      if (!report) {
        throw new ApiError(409, 'VERSION_REPORT_MISSING', '新版本没有关联的质量报告，不能选用；请重试该项');
      }
      if (report.decision === 'blocked') {
        throw new ApiError(409, 'QA_BLOCKED_NOT_ADOPTABLE',
          '新版本质检存在硬失败，不能靠人工核对放行；请改用重生成或调整事实后重试');
      }
      return { adopt: true, run_id: item.run_id, version_id: version.id };
    });
    if (precheck.adopt) {
      await jobs.activateVersion(ctx, precheck.run_id, precheck.version_id);
    }
    const order = await store.mutate(data => {
      const found = findChangeOrder(data, ctx, changeId);
      mutateChangeItem(data, ctx, changeId, itemId, item => {
        if (item.status !== 'done' || item.visual_check !== 'required') {
          throw new ApiError(409, 'VISUAL_CHECK_NOT_REQUIRED', '该项无需视觉数量核对，或尚未执行完成');
        }
        item.visual_check = 'passed';
        item.visual_check_by = ctx.actorId;
        item.visual_check_at = now();
        item.visual_check_reason = reason;
        item.pending_adoption = false;
      });
      return finalizeChangeOrder(data, found);
    });
    send(200, { change: presentChange(order) });
  }

  async function listReplacementTodos(ctx, query, send) {
    const projectId = String(query?.get('project_id') ?? '').trim() || null;
    const result = await store.read(data => {
      if (projectId) findProject(data, ctx, projectId);
      const items = Object.values(data.replacement_todos ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .filter(item => !projectId || item.project_id === projectId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
      return { replacement_todos: items, total: items.length };
    });
    send(200, result);
  }

  /** 只记录「商家确认已在各渠道完成替换」；不接平台回执，绝不写「店铺同步成功」。 */
  async function confirmReplacementTodo(ctx, req, todoId, send) {
    const body = await readJson(req).catch(() => ({}));
    const todo = await store.mutate(data => {
      const found = data.replacement_todos?.[todoId] ?? null;
      if (!found || found.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '替换待办不存在');
      if (found.status === 'replaced') return found; // 重复确认幂等
      found.status = 'replaced';
      found.confirmed_by = ctx.actorId;
      found.confirmed_at = now();
      const note = typeof body?.note === 'string' ? body.note.trim() : '';
      if (note) found.note = note.slice(0, 300);
      return found;
    });
    send(200, { replacement_todo: todo });
  }

  async function getReadiness(ctx, projectId, send) {
    const readiness = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const assets = Object.values(data.assets).filter(asset => asset.project_id === project.id);
      return computeReadiness(project, assets, latestTruth(data, project.id));
    });
    send(200, readiness);
  }

  // ---------- M04：目录、品牌套件、CommerceSpec ----------

  function handleCatalog(method, rest, query, send) {
    requireMethod(method, ['GET', 'HEAD']);
    if (rest.length === 2 && rest[1] === 'templates') {
      return send(200, { templates: listTemplates() });
    }
    if (rest.length === 3 && rest[1] === 'templates') {
      const template = getTemplate(rest[2]);
      if (!template) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', '模板不存在');
      return send(200, { template });
    }
    if (rest.length === 2 && rest[1] === 'channel-rules') {
      const at = clock();
      const rules = listChannelRules().map(rule => {
        const matched = matchChannelRule({ platform: rule.platform, category: query.get('category') ?? '', at });
        return {
          id: rule.id,
          platform: rule.platform,
          version: rule.version,
          source: rule.source,
          effective_at: rule.effective_at,
          review_due_at: rule.review_due_at,
          status: matched.status,
          days_to_review: matched.days_to_review ?? null,
          categories: rule.categories,
          constraints: rule.constraints,
          notes: rule.notes,
        };
      });
      return send(200, { catalog_ready: true, rules });
    }
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  async function handleBrandKits(ctx, method, rest, req, send) {
    if (rest.length === 1) {
      if (method === 'POST') return createBrandKit(ctx, req, send);
      requireMethod(method, ['GET', 'HEAD', 'POST']);
      return listBrandKits(ctx, send);
    }
    if (rest.length === 2) {
      requireMethod(method, ['GET', 'HEAD']);
      return getBrandKit(ctx, rest[1], send);
    }
    if (rest.length === 3 && rest[2] === 'versions') {
      requireMethod(method, ['POST']);
      return createBrandKitVersion(ctx, rest[1], req, send);
    }
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  function validateLogoAsset(data, ctx, payload) {
    const id = payload.logo?.asset_id;
    if (!id) return;
    const asset = data.assets[id];
    if (!asset || asset.tenant_id !== ctx.tenantId) throw new ApiError(422, 'INVALID_LOGO_ASSET', 'Logo 必须来自当前账户上传的素材');
    if (payload.logo.asset_sha256 && payload.logo.asset_sha256 !== asset.sha256) throw new ApiError(422, 'LOGO_HASH_MISMATCH', 'Logo 素材与摘要不匹配');
  }

  async function createBrandKit(ctx, req, send) {
    const payload = validateBrandKitInput(await readJson(req));
    const result = await store.mutate(data => {
      validateLogoAsset(data, ctx, payload);
      const count = Object.values(data.brand_kits).filter(kit => kit.tenant_id === ctx.tenantId).length;
      if (count >= 20) throw new ApiError(409, 'BRAND_KIT_LIMIT', '每个租户最多 20 个品牌套件');
      const duplicated = Object.values(data.brand_kits).find(kit =>
        kit.tenant_id === ctx.tenantId && kit.name.toLowerCase() === payload.name.toLowerCase());
      if (duplicated) throw new ApiError(409, 'BRAND_KIT_EXISTS', `品牌套件「${payload.name}」已存在，请改用新版本追加`);
      const timestamp = now();
      const kit = {
        id: newId('bk'),
        tenant_id: ctx.tenantId,
        name: payload.name,
        head_version: 1,
        created_at: timestamp,
        updated_at: timestamp,
        created_by: ctx.actorId,
      };
      const version = {
        id: newId('bkv'),
        tenant_id: ctx.tenantId,
        brand_kit_id: kit.id,
        version: 1,
        base_version: 0,
        ...payload,
        content_hash: brandKitContentHash(payload),
        created_at: timestamp,
        created_by: ctx.actorId,
      };
      data.brand_kits[kit.id] = kit;
      data.brand_kit_versions[version.id] = version;
      return { kit, version };
    });
    send(201, { brand_kit: serializeBrandKit(result.kit), version: result.version });
  }

  async function createBrandKitVersion(ctx, kitId, req, send) {
    const body = await readJson(req);
    const payload = validateBrandKitInput(body);
    const result = await store.mutate(data => {
      const kit = findBrandKit(data, ctx, kitId);
      validateLogoAsset(data, ctx, payload);
      const baseVersion = body.base_version;
      if (!Number.isInteger(baseVersion) || baseVersion < 1) {
        throw new ApiError(422, 'INVALID_BASE_VERSION', 'base_version 必须为不小于 1 的整数，用于乐观锁');
      }
      if (baseVersion !== kit.head_version) {
        throw new ApiError(409, 'VERSION_CONFLICT', `品牌套件已更新到 v${kit.head_version}，请基于最新版本重新提交`, {
          current_version: kit.head_version,
        });
      }
      const timestamp = now();
      const version = {
        id: newId('bkv'),
        tenant_id: ctx.tenantId,
        brand_kit_id: kit.id,
        version: kit.head_version + 1,
        base_version: baseVersion,
        ...payload,
        content_hash: brandKitContentHash(payload),
        created_at: timestamp,
        created_by: ctx.actorId,
      };
      data.brand_kit_versions[version.id] = version;
      kit.head_version = version.version;
      kit.updated_at = timestamp;
      return { kit, version };
    });
    send(201, { brand_kit: serializeBrandKit(result.kit), version: result.version });
  }

  async function listBrandKits(ctx, send) {
    const kits = await store.read(data => Object.values(data.brand_kits)
      .filter(kit => kit.tenant_id === ctx.tenantId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map(kit => {
        const head = latestBrandKitVersion(data, kit.id);
        return {
          ...serializeBrandKit(kit),
          colors: head ? [head.palette.primary, ...head.palette.secondary] : [],
          logo_present: head?.logo?.present ?? false,
          font_count: head?.fonts?.length ?? 0,
          banned_expression_count: head?.banned_expressions?.length ?? 0,
          content_hash: head?.content_hash ?? null,
        };
      }));
    send(200, { tenant_id: ctx.tenantId, brand_kits: kits });
  }

  async function getBrandKit(ctx, kitId, send) {
    const detail = await store.read(data => {
      const kit = findBrandKit(data, ctx, kitId);
      const versions = Object.values(data.brand_kit_versions)
        .filter(item => item.brand_kit_id === kit.id && item.tenant_id === ctx.tenantId)
        .sort((left, right) => left.version - right.version)
        .map(item => ({
          version: item.version,
          content_hash: item.content_hash,
          created_at: item.created_at,
          created_by: item.created_by,
          palette: item.palette,
          logo: item.logo,
          fonts: item.fonts,
          tone: item.tone,
          banned_expressions: item.banned_expressions,
        }));
      return { brand_kit: serializeBrandKit(kit), versions };
    });
    send(200, detail);
  }

  async function previewSpec(ctx, projectId, req, send) {
    const body = await readJson(req);
    const result = await store.read(data => buildSpecDraft(data, ctx, projectId, body, { persist: false }));
    send(200, result);
  }

  async function createSpec(ctx, projectId, req, send) {
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const draft = buildSpecDraft(data, ctx, projectId, body, { persist: true });
      const project = findProject(data, ctx, projectId);
      const timestamp = now();
      const version = project.spec_head_version + 1;
      const previous = latestSpec(data, project.id);
      const changed = previous ? previous.deliverable_hash !== draft.payload.deliverable_hash : false;
      const record = {
        id: newId('spec'),
        tenant_id: ctx.tenantId,
        project_id: project.id,
        version,
        base_version: body.base_version,
        ...draft.payload,
        requires_requote: changed,
        deliverable_changes: previous ? diffDeliverables(previous.deliverables, draft.payload.deliverables) : [],
        content_hash: specContentHash(draft.payload),
        created_by: ctx.actorId,
        created_at: timestamp,
      };
      data.specs[record.id] = record;
      project.spec_head_version = version;
      project.status = 'spec_frozen';
      project.updated_at = timestamp;
      return { record, readiness: draft.readiness };
    });
    send(201, {
      spec: { ...result.record, validity: { validity: 'current', reasons: [] } },
      readiness: result.readiness,
      requires_requote: result.record.requires_requote,
      deliverable_changes: result.record.deliverable_changes,
    });
  }

  async function listSpecs(ctx, projectId, send) {
    const payload = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const truth = latestTruth(data, project.id);
      const specs = Object.values(data.specs)
        .filter(item => item.project_id === project.id && item.tenant_id === ctx.tenantId)
        .sort((left, right) => left.version - right.version)
        .map(item => {
          const channel = item.channel.rule_id
            ? matchChannelRule({ platform: item.channel.platform, category: project.category, at: clock() })
            : { status: 'missing', rule: null };
          const brandHead = item.brand_kit ? latestBrandKitVersion(data, item.brand_kit.id) : null;
          return {
            version: item.version,
            base_version: item.base_version,
            content_hash: item.content_hash,
            created_at: item.created_at,
            created_by: item.created_by,
            template: { id: item.template.id, name: item.template.name, version: item.template.version },
            brand_kit: item.brand_kit ? { id: item.brand_kit.id, name: item.brand_kit.name, version: item.brand_kit.version } : null,
            channel: { platform: item.channel.platform, version: item.channel.version, platform_coverage: item.channel.platform_coverage },
            deliverable_count: item.deliverables.length,
            requires_requote: item.requires_requote,
            validity: computeSpecValidity(item, {
              truthVersion: truth?.version ?? 0,
              brandKitVersion: brandHead?.version ?? null,
              channel,
              at: clock(),
            }),
          };
        });
      return { project_id: project.id, head_version: project.spec_head_version, specs };
    });
    send(200, payload);
  }

  async function getSpec(ctx, projectId, rawVersion, send) {
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 1) throw new ApiError(404, 'NOT_FOUND', 'spec 版本不存在');
    const payload = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const item = Object.values(data.specs).find(candidate =>
        candidate.project_id === project.id && candidate.tenant_id === ctx.tenantId && candidate.version === version);
      if (!item) throw new ApiError(404, 'NOT_FOUND', 'spec 版本不存在');
      const truth = latestTruth(data, project.id);
      const brandHead = item.brand_kit ? latestBrandKitVersion(data, item.brand_kit.id) : null;
      const channel = item.channel.rule_id
        ? matchChannelRule({ platform: item.channel.platform, category: project.category, at: clock() })
        : { status: 'missing', rule: null };
      return {
        spec: {
          ...item,
          validity: computeSpecValidity(item, {
            truthVersion: truth?.version ?? 0,
            brandKitVersion: brandHead?.version ?? null,
            channel,
            at: clock(),
          }),
        },
      };
    });
    send(200, payload);
  }

  /** 组装 draft 并做齐全部校验；persist 区分预览与冻结；truthVersion 指定冻结的事实版本（默认当前 head）。 */
  function buildSpecDraft(data, ctx, projectId, body, { persist, truthVersion = null }) {
    const project = findProject(data, ctx, projectId);
    const assets = Object.values(data.assets)
      .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
    const truth = truthVersion === null || truthVersion === undefined
      ? latestTruth(data, project.id)
      : Object.values(data.truth_versions ?? {}).find(item =>
          item.tenant_id === ctx.tenantId && item.project_id === project.id && item.version === Number(truthVersion)) ?? null;
    if (truthVersion !== null && truthVersion !== undefined && !truth) {
      throw new ApiError(404, 'NOT_FOUND', `指定事实版本 v${truthVersion} 不存在`);
    }
    const readiness = computeReadiness(project, assets, truth);
    if (!truth) {
      throw new ApiError(409, 'READINESS_BLOCKED', '尚未确认商品事实，无法冻结生产配置', { blockers: readiness.blockers });
    }
    if (persist && !readiness.can_start_production) {
      throw new ApiError(409, 'READINESS_BLOCKED', '商品事实或素材未达到可生产条件，无法冻结生产配置', {
        blockers: readiness.blockers,
      });
    }
    if (typeof body.template_id !== 'string' || !body.template_id.trim()) {
      throw new ApiError(422, 'INVALID_FIELD', 'template_id 必填');
    }
    const template = getTemplate(body.template_id.trim());
    if (!template) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', `模板 ${body.template_id} 不存在`);

    let brandKit = null;
    if (body.brand_kit_id) {
      const kit = findBrandKit(data, ctx, String(body.brand_kit_id));
      const wanted = body.brand_kit_version ?? kit.head_version;
      const version = Object.values(data.brand_kit_versions).find(item =>
        item.brand_kit_id === kit.id && item.tenant_id === ctx.tenantId && item.version === wanted);
      if (!version) throw new ApiError(404, 'BRAND_KIT_VERSION_NOT_FOUND', `品牌套件版本 v${wanted} 不存在`);
      brandKit = { ...version, id: kit.id, name: kit.name };
    }
    if (persist) {
      if (!Number.isInteger(body.base_version)) {
        throw new ApiError(422, 'INVALID_BASE_VERSION', 'base_version 必填，用于避免覆盖他人刚冻结的配置');
      }
      if (body.base_version !== project.spec_head_version) {
        throw new ApiError(409, 'VERSION_CONFLICT', `生产配置已更新到 v${project.spec_head_version}，请基于最新版本重新提交`, {
          current_version: project.spec_head_version,
        });
      }
    }

    const platform = typeof body.platform === 'string' && body.platform.trim() ? body.platform.trim() : project.platform;
    const channel = matchChannelRule({ platform, category: project.category, at: clock() });
    const resolutions = body.conflict_resolutions ?? {};
    if (resolutions !== null && typeof resolutions !== 'object') {
      throw new ApiError(422, 'INVALID_RESOLUTIONS', 'conflict_resolutions 必须为对象');
    }
    const payload = assembleSpec({ project, truth, template, brandKit, channel, resolutions, textLayout: body.text_layout ?? null, at: clock() });

    if (payload.conflicts.unresolvable.length > 0) {
      throw new ApiError(409, 'SPEC_CONFLICT_UNRESOLVABLE', '存在无法满足的平台硬约束，需要先修改商品事实或换模板', {
        conflicts: payload.conflicts.unresolvable,
      });
    }
    if (persist && payload.conflicts.pending.length > 0) {
      throw new ApiError(409, 'SPEC_CONFLICTS_PENDING', '存在未处理的规则冲突，必须显式选择处理方式', {
        conflicts: payload.conflicts.pending,
      });
    }
    return {
      payload,
      readiness,
      project_id: project.id,
      base_version: project.spec_head_version,
      template: { id: template.id, name: template.name, version: template.version },
      would_freeze: payload.conflicts.pending.length === 0,
      frozen: persist,
    };
  }

  function findBrandKit(data, ctx, kitId) {
    const kit = data.brand_kits[kitId];
    if (!kit || kit.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '品牌套件不存在');
    return kit;
  }

  // ---------- M05 额度、报价与任务 ----------
  async function getCredits(ctx, send) {
    // R03：读取前先回收已到期未使用的批次，避免把过期额度继续算作可用
    await store.mutate(data => sweepExpiredLots(data, ctx.tenantId, new Date(clock()), { initialCredits }));
    return store.read(data => send(200, {
      tenant_id: ctx.tenantId,
      balance: balanceOf(data, ctx.tenantId, { initialCredits }),
      recent: ledgerEntries(data, ctx.tenantId, { limit: 20 }),
      note: '演示额度，不代表真实货币或可计费权益；能否生成由服务端判定，不信任前端余额。',
    }));
  }

  // M06：生成记录查询。租户过滤在 jobs 内部完成，跨租户一律按不存在处理。
  function listGenerationRecordsRoute(ctx, query, send) {
    const runId = String(query?.get('run_id') ?? '').trim() || null;
    const projectId = String(query?.get('project_id') ?? '').trim() || null;
    return jobs.listGenerationRecords(ctx, { runId, projectId })
      .then(result => send(200, { ...result, provider: providerInfo }));
  }

  // M07：质量报告与人工复核。人工裁决的校验与证据校验在 m07 内完成，
  // 这里只负责解析请求体并禁止客户端伪造复核人（复核人取自租户上下文）。
  function listQualityReportsRoute(ctx, query, send) {
    const runId = String(query?.get('run_id') ?? '').trim() || null;
    const projectId = String(query?.get('project_id') ?? '').trim() || null;
    return jobs.listQualityReports(ctx, { runId, projectId }).then(result => send(200, result));
  }

  async function reviewQualityReportRoute(ctx, req, reportId, send) {
    const body = await readJson(req);
    if (body && Object.prototype.hasOwnProperty.call(body, 'reviewer')) {
      throw new ApiError(400, 'REVIEWER_NOT_CLIENT_SUPPLIED', '复核人由租户上下文确定，不能由客户端填写');
    }
    const result = await jobs.reviewQualityReport(ctx, reportId, {
      decisions: body?.decisions ?? [],
      note: body?.note ?? null,
    });
    send(200, result);
  }

  // M08：版本回退与正式导出。导出资格（完整性、可发布、stale）全部由 jobs 在锁内重算。
  function activateVersionRoute(ctx, runId, versionId, send) {
    return jobs.activateVersion(ctx, runId, versionId).then(result => send(200, result));
  }

  // M13：免费文字排版修改。权限走 run:create（owner/editor），复核者与只读角色不能改内容。
  async function textEditRoute(ctx, req, runId, deliverableId, send) {
    const body = await readJson(req);
    const result = await jobs.editDeliverableText({
      ctx,
      runId,
      deliverableId,
      baseVersionId: typeof body?.base_version_id === 'string' ? body.base_version_id.trim() || null : null,
      edits: Array.isArray(body?.edits) ? body.edits : [],
    });
    send(200, result);
  }

  async function createExportRoute(ctx, req, runId, send) {
    const body = await readJson(req);
    const scope = String(body?.scope ?? 'complete').trim();
    const result = await jobs.createExport(ctx, runId, { scope });
    send(201, result);
  }

  async function downloadExportRoute(ctx, exportId, res, send) {
    const pkg = await jobs.readExportPackage(ctx, exportId);
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.filename}"`);
    res.setHeader('X-Package-SHA256', pkg.sha256);
    send(200, pkg.bytes, 'application/zip');
  }

  async function createQuote(ctx, req, send) {
    const body = await readJson(req);
    const projectId = String(body.project_id ?? '').trim();
    if (!projectId) throw new ApiError(422, 'MISSING_PROJECT', '报价需要指定项目');
    const quoted = await store.read(data => {
      const project = findProject(data, ctx, projectId);
      const spec = resolveSpecRecord(data, project.id, body.spec_version);
      const quote = quoteFromSpec({ spec, at: clock(), finishedImages: ctx.mode === 'session', includeOptional: body.include_optional === true });
      return { quote: { ...quote, tenant_id: ctx.tenantId, project_id: project.id } };
    });
    const record = await store.mutate(data => {
      data.quotes[quoted.quote.quote_id] = quoted.quote;
      return quoted.quote;
    });
    send(201, { quote: record, status: quoteStatus(record, clock()) });
  }

  function listQuotes(ctx, send) {
    return store.read(data => send(200, {
      quotes: Object.values(data.quotes ?? {})
        .filter(quote => quote.tenant_id === ctx.tenantId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, 20)
        .map(quote => ({
          quote_id: quote.quote_id, project_id: quote.project_id, price_version: quote.price_version,
          spec_ref: quote.spec_ref, estimated_credits: quote.estimated_credits, max_credits: quote.max_credits,
          max_attempts: quote.max_attempts, created_at: quote.created_at, expires_at: quote.expires_at,
          status: quoteStatus(quote, clock()),
        })),
    }));
  }

  function getQuote(ctx, quoteId, send) {
    return store.read(data => {
      const quote = data.quotes?.[quoteId];
      if (!quote || quote.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '报价不存在');
      send(200, { quote, status: quoteStatus(quote, clock()) });
    });
  }

  async function createRun(ctx, req, send) {
    const body = await readJson(req);
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey === '') {
      throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', '创建任务必须带 Idempotency-Key，避免重复提交产生重复费用');
    }
    const scenario = body.scenario;
    if (scenario !== undefined && !allowScenarioInjection) {
      throw new ApiError(400, 'SCENARIO_NOT_ALLOWED', '当前环境不允许注入 Provider 场景');
    }
    const prepared = await store.read(data => {
      const project = findProject(data, ctx, String(body.project_id ?? '').trim());
      const spec = resolveSpecRecord(data, project.id, body.spec_version);
      const quoteId = String(body.quote_id ?? '').trim();
      const quote = quoteId ? data.quotes?.[quoteId] : null;
      if (!quote || quote.tenant_id !== ctx.tenantId || quote.project_id !== project.id) {
        throw new ApiError(422, 'QUOTE_REQUIRED', '必须先基于冻结的 spec 取得有效报价，再创建任务');
      }
      if (quoteStatus(quote, clock()) === 'expired') {
        throw new ApiError(409, 'QUOTE_EXPIRED', '报价已过期，请重新取价后再执行');
      }
      if (!quoteMatchesSpec(quote, spec)) {
        throw new ApiError(409, 'QUOTE_SPEC_MISMATCH', '报价与所选冻结快照不一致，请重新报价');
      }
      const readiness = computeReadiness(project, Object.values(data.assets).filter(asset => asset.project_id === project.id), latestTruth(data, project.id));
      if (!readiness.can_start_production) {
        throw new ApiError(409, 'READINESS_BLOCKED', readiness.blocker_count > 0
          ? `生产前置未满足：${readiness.blockers[0]?.message ?? '请检查商品事实与素材'}`
          : '生产前置未满足', { blockers: readiness.blockers });
      }
      return { project, spec, quote };
    });

    const runId = newId('run');
    const createdAt = new Date(clock()).toISOString();
    const created = await jobs.createRun({
      ctx,
      run: { id: runId, created_at: createdAt },
      project: prepared.project,
      spec: prepared.spec,
      quote: prepared.quote,
      idempotencyKey,
      scenario: allowScenarioInjection && scenario ? String(scenario) : 'success',
      fingerprint: fingerprintOf({
        project_id: prepared.project.id,
        quote_id: prepared.quote.quote_id,
        spec_version: prepared.spec.version,
        scenario: allowScenarioInjection && scenario ? String(scenario) : 'success',
      }),
    });
    send(created.replayed ? 200 : 201, {
      run: created.run,
      replayed: created.replayed,
      balance: await store.read(data => balanceOf(data, ctx.tenantId, { initialCredits })),
    });
  }

  function listRunsRoute(ctx, query, send) {
    const projectId = String(query?.get('project_id') ?? '').trim() || null;
    return jobs.listRuns(ctx, projectId).then(result => send(200, result));
  }

  /**
   * 指定图片重生成发起核心：从源 run 恢复冻结 spec 并自算单张报价。
   * M13 路由与 E03 变更单执行共用；幂等键由调用方给出。
   * specVersion（E03）：变更单重生成使用按新事实冻结的快照，而非源任务旧 spec。
   * expectedCredits（E03）：实际报价高于已确认报价时拒绝（在预留额度之前）。
   */
  async function launchRegeneration({ ctx, sourceRunId, deliverableId, sourceVersionId = null, idempotencyKey, specVersion = null, expectedCredits = null }) {
    const prepared = await store.read(data => {
      const sourceRun = Object.values(data.runs ?? {})
        .find(item => item.tenant_id === ctx.tenantId && item.id === sourceRunId);
      if (!sourceRun) throw new ApiError(404, 'NOT_FOUND', '源任务不存在');
      const project = data.projects?.[sourceRun.project_id];
      if (!project || project.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '源任务所属项目不存在');
      if (!sourceRun.deliverables.some(item => item.deliverable_id === deliverableId)) {
        throw new ApiError(404, 'NOT_FOUND', '源任务中不存在该交付物');
      }
      // 默认用源任务创建时冻结的 spec 版本，配置不会漂移；E03 变更单重生成用显式指定的新快照
      const spec = specVersion === null || specVersion === undefined
        ? resolveSpecRecord(data, project.id, sourceRun.spec_ref?.version)
        : resolveSpecRecord(data, project.id, specVersion);
      let quote;
      try {
        quote = quoteFromSpec({
          spec,
          finishedImages: true,
          includeOptional: true,
          onlyDeliverableIds: [deliverableId],
          at: new Date(clock()),
        });
      } catch (error) {
        throw new ApiError(404, 'NOT_FOUND', `该交付物无法单独计价：${error.message}`);
      }
      if (expectedCredits !== null && expectedCredits !== undefined
        && (quote.estimated_credits ?? 0) > expectedCredits) {
        throw new ApiError(409, 'QUOTE_STALE',
          `重生成实际报价 ${quote.estimated_credits} 超出已确认报价 ${expectedCredits}，请刷新报价并重新确认后再执行`, {
            confirmed_credits: expectedCredits, actual_credits: quote.estimated_credits,
          });
      }
      return { project, spec, quote };
    });

    const childRunId = newId('run');
    const createdAt = new Date(clock()).toISOString();
    const scenario = 'success';
    const created = await jobs.createRun({
      ctx,
      run: { id: childRunId, created_at: createdAt },
      project: prepared.project,
      spec: prepared.spec,
      quote: prepared.quote,
      idempotencyKey,
      scenario,
      fingerprint: fingerprintOf({
        kind: 'regeneration',
        source_run_id: sourceRunId,
        deliverable_id: deliverableId,
        source_version_id: sourceVersionId,
        spec_version: prepared.spec.version,
        scenario,
      }),
      regeneration: {
        source_run_id: sourceRunId,
        deliverable_id: deliverableId,
        source_version_id: sourceVersionId,
        // E03：变更单重生成显式冻结了新 spec 快照，报价一致性对照新快照而非源任务旧 spec
        spec_override: specVersion != null,
      },
    });
    return { created, prepared };
  }

  // M13（模块 05）：指定图片重生成。服务端从源 run 恢复冻结 spec 并自算单张报价，
  // 客户端不需要（也不允许）先建报价；required 与 optional 交付物都可重生成。
  async function regenerateRunRoute(ctx, req, runId, send) {
    const body = await readJson(req);
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey === '') {
      throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', '重生成必须带 Idempotency-Key，避免重复提交产生重复费用');
    }
    const deliverableId = String(body?.deliverable_id ?? '').trim();
    if (deliverableId === '') {
      throw new ApiError(422, 'DELIVERABLE_REQUIRED', '必须指定要重生成的交付物');
    }
    const sourceVersionId = typeof body?.source_version_id === 'string' && body.source_version_id.trim() !== ''
      ? body.source_version_id.trim() : null;
    const { created, prepared } = await launchRegeneration({
      ctx, sourceRunId: runId, deliverableId, sourceVersionId, idempotencyKey,
    });
    send(created.replayed ? 200 : 201, {
      run: created.run,
      replayed: created.replayed,
      source_run_id: runId,
      quote_id: prepared.quote.quote_id,
      balance: await store.read(data => balanceOf(data, ctx.tenantId, { initialCredits })),
    });
  }

  async function cancelRunRoute(ctx, req, runId, send) {
    const body = await readJson(req).catch(() => ({}));
    const result = await jobs.cancelRun({ ctx, runId, reason: String(body.reason ?? 'user_cancelled') });
    send(200, { run: result.run, note: '重复取消幂等；已请求取消后供应商的迟到结果不会再改变任务状态。' });
  }

  async function confirmBudgetRoute(ctx, req, runId, send) {
    const body = await readJson(req);
    const result = await jobs.confirmBudget({
      ctx, runId,
      extraCredits: Number(body.extra_credits ?? 0),
      confirm: body.confirm !== false,
    });
    send(200, { run: result.run });
  }

  /** R02：供应商结果长期未知时的人工核对收口。 */
  async function reconcileRunRoute(ctx, req, runId, send) {
    const body = await readJson(req);
    const result = await jobs.reconcileRun({
      ctx, runId,
      outcome: String(body.outcome ?? '').trim(),
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
    });
    send(200, { run: result.run });
  }

  /**
   * SSE 事件流：支持 Last-Event-ID 续传（断线后不丢事件）与按 event_id 去重。
   * 至少一次投递，客户端负责去重；超出保留期则返回需要刷新快照的提示事件。
   */
  async function streamRunEvents(ctx, req, res, runId, query, send) {
    const header = Number(req.headers['last-event-id'] ?? query.get('last_event_id') ?? 0);
    const since = Number.isInteger(header) && header >= 0 ? header : 0;
    let snapshot = [];
    let runState = null;
    try {
      snapshot = await jobs.eventsSince(ctx, runId, since);
      runState = await jobs.getRun(ctx, runId);
    } catch (error) {
      const failure = toApiError(error);
      send(failure.status, { error: failure.code, message: failure.message });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (req.socket) req.socket.setTimeout(0);
    // 事件名用规范的 message：EventSource 只把 message 映射到 onmessage/addEventListener('message')。
    // 自定义事件名（如 run）不会触发 message 监听，导致浏览器端"连上了但收不到事件"。
    const write = event => {
      res.write(`id: ${event.sequence}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // 终态标记不占用 sequence 空间：它不是一条领域事件，只是给客户端的收尾信号。
    // 刻意不写 "id:" 行——按 SSE 规范，只有携带 id 的事件才更新客户端的 Last-Event-ID 游标。
    // 若复用 last_sequence 当 id，会与最后一条真实事件重号，破坏游标语义（断线续传时错位）；
    // 若写一个非数字 id（如 terminal-xxx），同样会让游标变成非法值。
    const writeTerminal = payload => {
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    for (const event of snapshot) write(event);
    if (runState.run && !['queued', 'running', 'evaluating', 'awaiting_confirmation'].includes(runState.run.status)) {
      // 终态也用 message 类型：前端靠同一条链路拿到终态事件，不依赖额外的事件名
      writeTerminal({ terminal: runState.run.status, terminal_reason: runState.run.terminal_reason });
      res.end();
      return;
    }

    const heartbeat = setInterval(() => res.write(': 心跳\n\n'), 10_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    let unsubscribe = null;
    const cleanup = () => {
      clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    };
    unsubscribe = jobs.subscribe(runId, event => {
      write(event);
      if (TERMINAL_STATES.has(String(event.payload?.status)) || event.status === 'released') {
        writeTerminal({ terminal: 'settled', status: event.status });
        res.end();
        cleanup();
      }
    });
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  // ---------- M09：授权评测集、冠军—挑战者与灰度计划 ----------

  /**
   * 评测集只接受显式授权的样本：未授权或缺少授权凭据的条目直接拒绝，
   * 不进入数据集，避免"用未授权素材算出评测结论"。
   */
  async function importEvalDataset(ctx, req, send) {
    const body = await readJson(req);
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new ApiError(422, 'DATASET_ITEMS_REQUIRED', '需要至少 1 条评测集条目');
    }
    if (items.length > 500) throw new ApiError(422, 'DATASET_TOO_LARGE', '单次最多导入 500 条，超过请分批');
    const seen = new Set();
    const prepared = items.map((item, index) => {
      const skuId = String(item?.sku_id ?? '').trim();
      if (!skuId) throw new ApiError(422, 'DATASET_ITEM_INVALID', `第 ${index + 1} 条缺少 sku_id`);
      if (seen.has(skuId)) throw new ApiError(422, 'DATASET_DUPLICATE_SKU', `sku_id 重复：${skuId}`);
      seen.add(skuId);
      const split = String(item?.split ?? 'eval').trim();
      if (!['eval', 'holdout'].includes(split)) {
        throw new ApiError(422, 'DATASET_SPLIT_INVALID', `第 ${index + 1} 条 split 只能是 eval 或 holdout`);
      }
      if (item?.licensed !== true) {
        throw new ApiError(422, 'DATASET_LICENSE_REQUIRED', `第 ${index + 1} 条未声明授权，不得进入评测集`);
      }
      const licenseRef = String(item?.license_ref ?? '').trim();
      if (!licenseRef) {
        throw new ApiError(422, 'DATASET_LICENSE_REQUIRED', `第 ${index + 1} 条缺少授权凭据 license_ref`);
      }
      return {
        sku_id: skuId,
        split,
        licensed: true,
        license_ref: licenseRef,
        note: String(item?.note ?? '').slice(0, 200),
      };
    });

    const result = await store.mutate(data => {
      const timestamp = now();
      for (const item of prepared) {
        const key = `${ctx.tenantId}:${item.sku_id}`;
        const existing = data.eval_dataset_items[key];
        data.eval_dataset_items[key] = existing
          ? { ...existing, ...item, updated_at: timestamp }
          : {
            id: newId('eds'),
            tenant_id: ctx.tenantId,
            ...item,
            created_at: timestamp,
            updated_at: timestamp,
            created_by: ctx.actorId,
          };
      }
      return datasetSnapshot(data, ctx.tenantId);
    });
    send(201, {
      tenant_id: ctx.tenantId,
      imported: prepared.length,
      dataset_hash: result.hash,
      summary: result.summary,
      items: result.items,
    });
  }

  async function listEvalDataset(ctx, query, send) {
    const snapshot = await store.read(data => datasetSnapshot(data, ctx.tenantId));
    const split = String(query?.get('split') ?? '').trim();
    const items = split ? snapshot.items.filter(item => item.split === split) : snapshot.items;
    send(200, {
      tenant_id: ctx.tenantId,
      dataset_hash: snapshot.hash,
      summary: snapshot.summary,
      items,
    });
  }

  async function createEvalReport(ctx, req, send) {
    const body = await readJson(req);
    const championModelId = String(body.champion_model_id ?? provider.capabilities().id ?? '').trim();
    const candidateModelId = String(body.candidate_model_id ?? '').trim();
    if (!candidateModelId) throw new ApiError(422, 'CANDIDATE_MODEL_REQUIRED', '需要指定候选模型');
    if (championModelId && candidateModelId === championModelId) {
      throw new ApiError(422, 'CANDIDATE_EQUALS_CHAMPION', '候选模型不能与冠军相同');
    }
    const samples = body.samples;
    if (!Array.isArray(samples)) throw new ApiError(422, 'SAMPLES_REQUIRED', '需要提供评测样本');
    if (samples.length > 5_000) throw new ApiError(422, 'SAMPLES_TOO_LARGE', '单次最多 5000 条评测样本');

    const report = await store.mutate(data => {
      const snapshot = datasetSnapshot(data, ctx.tenantId);
      const summary = summarizeEvaluation({
        datasetItems: snapshot.items,
        samples,
        championModelId: championModelId || null,
        candidateModelId,
      });
      const record = {
        id: newId('evr'),
        tenant_id: ctx.tenantId,
        dataset_hash: snapshot.hash,
        created_at: now(),
        created_by: ctx.actorId,
        ...summary,
      };
      data.eval_reports[record.id] = record;
      return record;
    });
    send(201, { report });
  }

  async function listEvalReports(ctx, query, send) {
    const status = String(query?.get('status') ?? '').trim();
    const candidate = String(query?.get('candidate_model_id') ?? '').trim();
    const reports = await store.read(data => Object.values(data.eval_reports)
      .filter(item => item.tenant_id === ctx.tenantId)
      .filter(item => (status ? item.status === status : true))
      .filter(item => (candidate ? item.candidate_model_id === candidate : true))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map(item => ({ ...item, dataset_stale: item.dataset_hash !== datasetHash(data, ctx.tenantId) })));
    send(200, { tenant_id: ctx.tenantId, reports });
  }

  async function getEvalReport(ctx, reportId, send) {
    const report = await store.read(data => {
      const found = data.eval_reports[reportId];
      if (!found || found.tenant_id !== ctx.tenantId) return null;
      return { ...found, dataset_stale: found.dataset_hash !== datasetHash(data, ctx.tenantId) };
    });
    if (!report) throw new ApiError(404, 'NOT_FOUND', '评测报告不存在');
    send(200, { report });
  }

  /**
   * 模型路由视图。冠军永远是当前实际注册并按环境选中的 Provider；
   * 候选只有在该 Provider 就是候选本身时才视为"Adapter 已注册"，否则灰度必须被阻断。
   */
  async function getModelRouting(ctx, send) {
    const capabilities = provider.capabilities();
    const championModelId = String(capabilities.id ?? 'unknown');
    const data = await store.read(data => {
      const currentHash = datasetHash(data, ctx.tenantId);
      const byCandidate = new Map();
      for (const report of Object.values(data.eval_reports)) {
        if (report.tenant_id !== ctx.tenantId) continue;
        const previous = byCandidate.get(report.candidate_model_id);
        if (!previous || report.created_at > previous.created_at) byCandidate.set(report.candidate_model_id, report);
      }
      return { currentHash, byCandidate: [...byCandidate.values()] };
    });

    const candidates = data.byCandidate.map(report => {
      const adapterRegistered = report.candidate_model_id === championModelId;
      return {
        model_id: report.candidate_model_id,
        latest_report_id: report.id,
        report_status: report.status,
        dataset_stale: report.dataset_hash !== data.currentHash,
        decision: report.decision,
        adapter_registered: adapterRegistered,
        canary: planCanary({
          decision: report.dataset_hash !== data.currentHash ? { promote: false } : report.decision,
          adapterAvailable: adapterRegistered,
        }),
      };
    });
    const championCanary = planCanary({ decision: { promote: false }, adapterAvailable: false });
    send(200, {
      tenant_id: ctx.tenantId,
      champion: {
        model_id: championModelId,
        mode: providerInfo.mode,
        acceptance: providerInfo.acceptance,
        simulated: capabilities.simulated === true,
        capabilities,
      },
      candidates,
      canary: {
        max_percent: MAX_CANARY_PERCENT,
        min_percent: MIN_CANARY_PERCENT,
        active: false,
        plan: championCanary,
      },
      note: '灰度最多 5%；候选未胜出或没有真实 Adapter 时不启用灰度，也不能把候选写成默认模型。',
    });
  }

  /** 灰度健康检查：任一阈值触达即要求回滚；样本不足同样不能判定健康。 */
  async function evaluateCanaryRoute(ctx, req, send) {
    const body = await readJson(req);
    const samples = body.samples;
    if (!Array.isArray(samples)) throw new ApiError(422, 'SAMPLES_REQUIRED', '需要提供灰度观测样本');
    if (samples.length > 5_000) throw new ApiError(422, 'SAMPLES_TOO_LARGE', '单次最多 5000 条灰度样本');
    const thresholds = { ...DEFAULT_CANARY_THRESHOLDS };
    for (const key of Object.keys(thresholds)) {
      if (body.thresholds?.[key] === undefined) continue;
      const value = Number(body.thresholds[key]);
      if (!Number.isFinite(value) || value < 0) {
        throw new ApiError(422, 'CANARY_THRESHOLD_INVALID', `阈值 ${key} 必须是非负数`);
      }
      thresholds[key] = value;
    }
    const health = evaluateCanaryHealth({ samples, thresholds });
    send(200, {
      tenant_id: ctx.tenantId,
      health,
      rollback_required: health.healthy === false,
      note: health.healthy
        ? '灰度指标未触达回滚阈值；样本量足够前不得据此宣布候选可转正。'
        : '灰度已触达回滚阈值，必须停止候选并回退到冠军模型。',
    });
  }

  function datasetSnapshot(data, tenantId) {
    const items = Object.values(data.eval_dataset_items)
      .filter(item => item.tenant_id === tenantId)
      .sort((left, right) => left.sku_id.localeCompare(right.sku_id))
      .map(item => ({
        sku_id: item.sku_id,
        split: item.split,
        licensed: item.licensed,
        license_ref: item.license_ref,
        note: item.note ?? '',
        updated_at: item.updated_at,
      }));
    return { items, summary: summarizeDataset(items), hash: datasetHash(data, tenantId) };
  }

  function datasetHash(data, tenantId) {
    const items = Object.values(data.eval_dataset_items)
      .filter(item => item.tenant_id === tenantId)
      .map(item => [item.sku_id, item.split, item.license_ref])
      .sort((left, right) => left[0].localeCompare(right[0]));
    return fingerprintOf(items);
  }

  function handleEval(ctx, method, rest, req, query, send) {
    if (rest.length === 2 && rest[1] === 'dataset') {
      if (method === 'POST') return importEvalDataset(ctx, req, send);
      requireMethod(method, ['GET', 'HEAD']);
      return listEvalDataset(ctx, query, send);
    }
    if (rest.length === 2 && rest[1] === 'reports') {
      if (method === 'POST') return createEvalReport(ctx, req, send);
      requireMethod(method, ['GET', 'HEAD']);
      return listEvalReports(ctx, query, send);
    }
    if (rest.length === 3 && rest[1] === 'reports') {
      requireMethod(method, ['GET', 'HEAD']);
      return getEvalReport(ctx, rest[2], send);
    }
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  // ---------- M10：结构化详情页与首帧视频 ----------

  function detailContext(data, ctx, projectId, specVersion) {
    const project = findProject(data, ctx, projectId);
    const truth = latestTruth(data, project.id);
    if (!truth) throw new ApiError(409, 'TRUTH_REQUIRED', '需要先确认商品事实，详情页参数必须能引用事实');
    const spec = resolveSpecRecord(data, project.id, specVersion);
    const brandKit = spec.brand_kit ? latestBrandKitVersion(data, spec.brand_kit.id) : null;
    const assets = Object.values(data.assets)
      .filter(asset => asset.tenant_id === ctx.tenantId && asset.project_id === project.id);
    const channel = matchChannelRule({
      platform: spec.channel?.platform ?? project.platform,
      category: project.category ?? '',
      at: clock(),
    });
    return { project, truth, spec, brandKit, assets, channel };
  }

  function detailPageView(page, context) {
    return {
      ...page,
      validity: checkDetailPageValidity({
        page,
        truth: context.truth,
        spec: context.spec,
        brandKit: context.brandKit,
        assets: context.assets,
        channel: context.channel,
      }),
      platform_delivery: planPlatformDelivery({ channel: context.channel }),
    };
  }

  function normalizeSections(sections) {
    if (!Array.isArray(sections)) {
      throw new ApiError(422, 'DETAIL_SECTIONS_REQUIRED', 'sections 必须是数组');
    }
    return sections;
  }

  async function createDetailPage(ctx, req, projectId, send) {
    const body = await readJson(req);
    const sections = normalizeSections(body.sections);
    const result = await store.mutate(data => {
      const context = detailContext(data, ctx, projectId, body.spec_version);
      const page = buildDetailPage({
        tenantId: ctx.tenantId,
        projectId: context.project.id,
        spec: context.spec,
        truth: context.truth,
        brandKit: context.brandKit,
        assets: context.assets,
        sections,
        copyVersion: body.copy_version,
        platform: context.project.platform,
        channel: context.channel,
        at: clock(),
      });
      const sameProject = Object.values(data.detail_pages)
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === context.project.id);
      const record = {
        id: newId('dtp'),
        tenant_id: ctx.tenantId,
        project_id: context.project.id,
        version: sameProject.length + 1,
        previous_page_id: null,
        created_at: now(),
        created_by: ctx.actorId,
        ...page,
      };
      data.detail_pages[record.id] = record;
      return { record, decision: page.decision };
    });
    send(201, {
      detail_page: { ...result.record, validity: { validity: 'current', reasons: [] } },
    });
  }

  async function listDetailPages(ctx, projectId, send) {
    const payload = await store.read(data => {
      const context = detailContext(data, ctx, projectId, undefined);
      const pages = Object.values(data.detail_pages)
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === projectId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .map(item => detailPageView(item, context));
      return { project_id: projectId, detail_pages: pages, total: pages.length };
    });
    send(200, payload);
  }

  async function getDetailPageRoute(ctx, pageId, send) {
    const payload = await store.read(data => {
      const page = data.detail_pages?.[pageId] ?? null;
      if (!page || page.tenant_id !== ctx.tenantId) return null;
      const context = detailContext(data, ctx, page.project_id, undefined);
      return { detail_page: detailPageView(page, context) };
    });
    if (!payload) throw new ApiError(404, 'NOT_FOUND', '详情页不存在');
    send(200, payload);
  }

  /**
   * 重检：默认按当前最新事实与配置重建。未变化的参数复用上次来源快照，
   * 但六模块、事实值、素材生效、文案版本与平台覆盖每次都全量检查（PDP-02）。
   */
  async function recheckDetailPage(ctx, pageId, req, send) {
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const previous = data.detail_pages?.[pageId] ?? null;
      if (!previous || previous.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '详情页不存在');
      }
      const context = detailContext(data, ctx, previous.project_id, body.spec_version);
      const sections = body.sections === undefined
        ? previous.sections.map(section => ({
          key: section.key,
          params: (section.params ?? []).map(param => ({
            key: param.key, label: param.label, value: param.value, source: param.source,
          })),
        }))
        : normalizeSections(body.sections);
      const page = buildDetailPage({
        tenantId: ctx.tenantId,
        projectId: previous.project_id,
        spec: context.spec,
        truth: context.truth,
        brandKit: context.brandKit,
        assets: context.assets,
        sections,
        copyVersion: body.copy_version ?? previous.copy_version,
        platform: context.project.platform,
        channel: context.channel,
        previousPage: previous,
        at: clock(),
      });
      const sameProject = Object.values(data.detail_pages)
        .filter(item => item.tenant_id === ctx.tenantId && item.project_id === previous.project_id);
      const record = {
        ...page,
        id: newId('dtp'),
        tenant_id: ctx.tenantId,
        project_id: previous.project_id,
        version: sameProject.length + 1,
        previous_page_id: previous.id,
        created_at: now(),
        created_by: ctx.actorId,
      };
      data.detail_pages[record.id] = record;
      return record;
    });
    send(201, {
      detail_page: { ...result, validity: { validity: 'current', reasons: [] } },
    });
  }

  function handleDetailPages(ctx, method, rest, req, send) {
    if (rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      return store.read(data => Object.values(data.detail_pages)
        .filter(item => item.tenant_id === ctx.tenantId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))))
        .then(items => send(200, { tenant_id: ctx.tenantId, detail_pages: items, total: items.length }));
    }
    if (rest.length === 2) {
      requireMethod(method, ['GET', 'HEAD']);
      return getDetailPageRoute(ctx, rest[1], send);
    }
    if (rest.length === 3 && rest[2] === 'recheck') {
      requireMethod(method, ['POST']);
      return recheckDetailPage(ctx, rest[1], req, send);
    }
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  async function createVideoPlanRoute(ctx, req, projectId, send) {
    const body = await readJson(req);
    if (body.first_frame !== undefined && (body.first_frame === null || typeof body.first_frame !== 'object')) {
      throw new ApiError(422, 'FIRST_FRAME_INVALID', 'first_frame 必须是对象');
    }
    const result = await jobs.createVideoPlan(ctx, projectId, body);
    send(201, result);
  }

  function handleVideoPlans(ctx, method, rest, req, send) {
    if (rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      return jobs.listVideoPlans(ctx).then(result => send(200, result));
    }
    if (rest.length === 2) {
      requireMethod(method, ['GET', 'HEAD']);
      return jobs.getVideoPlan(ctx, rest[1]).then(result => send(200, result));
    }
    if (rest.length === 3 && rest[2] === 'frames') {
      requireMethod(method, ['POST']);
      return readJson(req).then(body => jobs.evaluateVideoPlanFrames(ctx, rest[1], body)).then(result => send(200, result));
    }
    if (rest.length === 3 && rest[2] === 'generate') {
      requireMethod(method, ['POST']);
      return jobs.generateVideo(ctx, rest[1]).then(result => send(200, result));
    }
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  async function createJointExportRoute(ctx, req, projectId, send) {
    const body = await readJson(req);
    const result = await jobs.createJointExport(ctx, projectId, {
      run_id: body.run_id ?? null,
      scope: body.scope ?? 'partial',
      detail_page_id: body.detail_page_id ?? null,
      video_plan_id: body.video_plan_id ?? null,
    });
    send(201, result);
  }

  // ---------- M11：批量、团队与品牌配方 ----------

  function tenantMembers(data, tenantId) {
    return Object.values(data.members ?? {}).filter(item => item.tenant_id === tenantId);
  }

  /**
   * 权限闸口。零成员的租户把当前操作者视为 owner（引导路径）；
   * 一旦登记过成员，未登记的操作者一律 403，不靠"默认放行"兜底。
   */
  async function requireAction(ctx, action) {
    const resolved = await store.read(data => resolveRole({
      members: tenantMembers(data, ctx.tenantId),
      actorId: ctx.actorId,
    }));
    // 空成员表的 bootstrap 只允许演示模式；真实会话必须存在成员记录
    if (resolved.bootstrap && ctx.mode === 'session') {
      throw new ApiError(403, 'FORBIDDEN', '该账户不是当前工作区成员');
    }
    if (!can(resolved.role, action)) {
      throw new ApiError(403, 'FORBIDDEN', `当前角色${resolved.role ? `（${resolved.role}）` : ''}没有 ${action} 权限`, {
        action, role: resolved.role ?? null,
      });
    }
    return resolved.role;
  }

  function roleOf(data, ctx) {
    return resolveRole({ members: tenantMembers(data, ctx.tenantId), actorId: ctx.actorId });
  }

  function batchItemsOf(data, ctx, batchId) {
    return Object.values(data.batch_items ?? {})
      .filter(item => item.batch_id === batchId && item.tenant_id === ctx.tenantId)
      .sort((left, right) => left.index - right.index);
  }

  function runStateOf(data, item) {
    if (!item.run_id) return null;
    const run = data.runs?.[item.run_id] ?? null;
    if (!run || run.tenant_id !== item.tenant_id) return 'failed';
    if (ACTIVE_STATES.has(run.status)) return 'running';
    if (run.status === 'completed') return 'completed';
    if (run.status === 'cancelled') return 'cancelled';
    return 'failed';
  }

  /** 条目状态：已产生运行的按运行状态回写，未开始的按当前上下文重算阻断。 */
  function itemStatusOf(data, item) {
    const runState = runStateOf(data, item);
    if (runState) return runState;
    if (item.status === 'invalid') return 'invalid';
    return item.status === 'ready' || item.status === 'blocked' ? item.status : 'imported';
  }

  /**
   * 批量状态只反映"是否已开始执行"，不把"预览后就绪"误判成执行中：
   * running 必须真的有在途任务；就绪未开始记为 ready。
   */
  function batchStatusOf(items) {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked', 'invalid']);
    if (items.some(item => item.status === 'running')) return 'running';
    if (items.length > 0 && items.every(item => terminal.has(item.status))) {
      return items.every(item => item.status === 'completed') ? 'completed' : 'partial';
    }
    if (items.some(item => item.status === 'completed' || item.status === 'failed')) return 'partial';
    if (items.some(item => item.status === 'ready')) return 'ready';
    if (items.some(item => item.status === 'blocked' || item.status === 'invalid')) return 'blocked';
    return 'imported';
  }

  /**
   * 逐项评估：事实、素材、冻结配置、报价能力与额度都在这里判定。
   * 任何一项不满足只标记该条目，不影响批内其他条目。
   */
  function evaluateBatchItem(data, ctx, item) {
    if (!item.project_id) {
      return { status: 'invalid', blockers: item.blockers ?? [], quote: null };
    }
    const project = data.projects?.[item.project_id] ?? null;
    if (!project || project.tenant_id !== ctx.tenantId) {
      return { status: 'blocked', blockers: [{ code: 'PROJECT_MISSING', message: '导入的项目已不存在' }], quote: null };
    }
    const blockers = [];
    const assets = Object.values(data.assets ?? {})
      .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
    const truth = latestTruth(data, project.id);
    const readiness = computeReadiness(project, assets, truth);
    for (const blocker of readiness.blockers ?? []) {
      blockers.push({ code: blocker.code, message: blocker.message });
    }
    const spec = latestSpec(data, project.id);
    if (!spec) blockers.push({ code: 'SPEC_REQUIRED', message: '尚未冻结生产配置，需先完成模板与平台设置' });
    let quote = null;
    if (spec) {
      try {
        quote = quoteFromSpec({ spec, at: clock(), finishedImages: ctx.mode === 'session' });
      } catch (error) {
        blockers.push({ code: 'QUOTE_UNAVAILABLE', message: error?.message ?? '报价不可用' });
      }
    }
    if (blockers.length > 0) return { status: 'blocked', blockers, quote, spec };
    return { status: 'ready', blockers: [], quote, spec };
  }

  function refreshBatch(data, ctx, batch) {
    const items = batchItemsOf(data, ctx, batch.id);
    for (const item of items) {
      const runState = runStateOf(data, item);
      if (runState) {
        item.status = runState;
        continue;
      }
      if (item.status === 'invalid' || item.status === 'running') continue;
      const evaluated = evaluateBatchItem(data, ctx, item);
      item.status = evaluated.status;
      item.blockers = evaluated.blockers;
      item.estimated_credits = evaluated.quote?.estimated_credits ?? 0;
      item.max_credits = evaluated.quote?.max_credits ?? 0;
      item.spec_version = evaluated.spec?.version ?? item.spec_version ?? null;
    }
    batch.items = items;
    batch.summary = batchSummary(items);
    batch.status = batchStatusOf(items);
    batch.updated_at = new Date(clock()).toISOString();
    return items;
  }

  function batchView(data, ctx, batch) {
    const items = batch.items ?? batchItemsOf(data, ctx, batch.id);
    return {
      ...batch,
      items,
      summary: batchSummary(items),
      status: batchStatusOf(items),
      console: summarizeCatalogConsole({ items }),
    };
  }

  function normalizeImportRows({ rows = [], columns = [] } = {}) {
    if (!Array.isArray(rows)) throw new ApiError(422, 'IMPORT_ROWS_INVALID', 'rows 必须是数组');
    if (rows.length > 0 && Array.isArray(rows[0]) && Array.isArray(columns) && columns.length > 0) {
      return rows.map(cells => Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ''])));
    }
    return rows;
  }

  async function createBatchRoute(ctx, req, send) {
    await requireAction(ctx, 'batch:create');
    const body = await readJson(req);
    const rows = normalizeImportRows({ rows: body.rows, columns: body.columns });
    const created = await store.mutate(data => {
      const existingSkus = Object.values(data.projects ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .map(item => item.sku);
      const brandKitIds = Object.values(data.brand_kits ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .map(item => item.id);
      let preview;
      try {
        preview = previewImportRows({
          rows, columns: body.columns, mapping: body.mapping, existingSkus,
          templateIds: listTemplates().map(item => item.id), brandKitIds,
        });
      } catch (error) {
        throw new ApiError(422, 'IMPORT_INVALID', error?.message ?? '导入数据无效');
      }
      if (!preview.ok && preview.rows.length === 0) {
        throw new ApiError(422, 'IMPORT_MAPPING_INVALID', preview.issues[0]?.message ?? '导入字段映射无效', {
          issues: preview.issues,
        });
      }
      const timestamp = now();
      const batchId = newId('bat');
      const items = [];
      for (const row of preview.rows) {
        const item = {
          id: newId('bit'),
          tenant_id: ctx.tenantId,
          batch_id: batchId,
          index: row.index,
          sku: row.sku,
          name: row.name,
          category: row.category,
          platform: row.platform,
          template_id: row.template_id,
          brand_kit_id: row.brand_kit_id,
          facts: row.facts,
          status: row.valid ? 'imported' : 'invalid',
          project_id: null,
          run_id: null,
          quote_id: null,
          spec_version: null,
          blockers: row.valid ? [] : row.errors,
          warnings: row.warnings,
          estimated_credits: 0,
          max_credits: 0,
          last_error: null,
          created_at: timestamp,
        };
        if (row.valid) {
          const duplicate = Object.values(data.projects ?? {}).find(existing =>
            existing.tenant_id === ctx.tenantId && existing.sku.toLowerCase() === row.sku.toLowerCase());
          if (duplicate) {
            item.status = 'invalid';
            item.blockers = [{ code: 'IMPORT_SKU_EXISTS', message: `SKU ${row.sku} 已存在` }];
          } else {
            const project = {
              id: newId('prj'),
              tenant_id: ctx.tenantId,
              name: row.name,
              sku: row.sku,
              category: row.category,
              platform: row.platform ?? '',
              status: 'drafting',
              truth_head_version: 0,
              spec_head_version: 0,
              confirmation_status: null,
              created_at: timestamp,
              updated_at: timestamp,
              created_by: ctx.actorId,
              batch_id: batchId,
            };
            data.projects[project.id] = project;
            item.project_id = project.id;
          }
        }
        data.batch_items[item.id] = item;
        items.push(item);
      }
      const batch = {
        id: batchId,
        schema_version: 1,
        tenant_id: ctx.tenantId,
        name: String(body.name ?? '').trim() || `批量导入 ${timestamp.slice(0, 10)}`,
        status: batchStatusOf(items),
        columns: Array.isArray(body.columns) ? body.columns : [],
        mapping: preview.mapping,
        items,
        summary: batchSummary(items),
        budget: {
          confirmed: false,
          confirmed_by: null,
          confirmed_at: null,
          estimated_credits: 0,
          max_credits: 0,
        },
        export_ids: [],
        created_by: ctx.actorId,
        created_at: timestamp,
        updated_at: timestamp,
      };
      data.batches[batch.id] = batch;
      return { batch, issues: preview.issues, summary: preview.summary };
    });
    send(201, {
      batch: batchView(await store.read(data => data), ctx, created.batch),
      import_issues: created.issues,
      import_summary: created.summary,
    });
  }

  async function listBatchesRoute(ctx, send) {
    await requireAction(ctx, 'batch:read');
    const payload = await store.read(data => {
      const batches = Object.values(data.batches ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .map(item => {
          const items = batchItemsOf(data, ctx, item.id).map(item2 => ({ ...item2, status: itemStatusOf(data, item2) }));
          return batchView(data, ctx, { ...item, items });
        });
      return { tenant_id: ctx.tenantId, batches, total: batches.length };
    });
    send(200, payload);
  }

  async function getBatchRoute(ctx, batchId, send) {
    await requireAction(ctx, 'batch:read');
    const payload = await store.read(data => {
      const batch = data.batches?.[batchId] ?? null;
      if (!batch || batch.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '批量任务不存在');
      const items = batchItemsOf(data, ctx, batch.id).map(item => ({ ...item, status: itemStatusOf(data, item) }));
      return { batch: batchView(data, ctx, { ...batch, items }) };
    });
    send(200, payload);
  }

  async function previewBatchRoute(ctx, batchId, send) {
    await requireAction(ctx, 'batch:preview');
    const payload = await store.mutate(data => {
      const batch = data.batches?.[batchId] ?? null;
      if (!batch || batch.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '批量任务不存在');
      if (batch.status === 'running') throw new ApiError(409, 'BATCH_RUNNING', '批量正在执行，不能重复预览');
      const items = refreshBatch(data, ctx, batch);
      const balance = balanceOf(data, ctx.tenantId, { initialCredits });
      const plan = planBatch({
        items: items.map(item => ({
          item_id: item.id, sku: item.sku, status: item.status, blockers: item.blockers,
          estimated_credits: item.estimated_credits, max_credits: item.max_credits,
        })),
        availableCredits: balance.available,
        // 预览回答"确认预算后能否开始"，因此这里按已确认计算，并单独标出是否仍需确认
        confirmed: true,
      });
      batch.preview = {
        at: new Date(clock()).toISOString(),
        estimated_credits: plan.estimated_credits,
        max_credits: plan.max_credits,
        can_start: plan.can_start,
        budget_confirmed: batch.budget?.confirmed === true,
        requires_budget_confirmation: batch.budget?.confirmed !== true,
        reasons: plan.reasons,
      };
      return {
        batch: batchView(data, ctx, batch),
        preview: {
          ...plan,
          budget_confirmed: batch.preview.budget_confirmed,
          requires_budget_confirmation: batch.preview.requires_budget_confirmation,
        },
        balance,
      };
    });
    send(200, payload);
  }

  async function startBatchRoute(ctx, req, batchId, send) {
    await requireAction(ctx, 'batch:start');
    const body = await readJson(req).catch(() => ({}));
    if (body.confirm_budget !== true) {
      throw new ApiError(422, 'BATCH_BUDGET_UNCONFIRMED', '开始批量前必须显式确认预算（confirm_budget: true）');
    }
    const prepared = await store.mutate(data => {
      const batch = data.batches?.[batchId] ?? null;
      if (!batch || batch.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '批量任务不存在');
      if (batch.status === 'running') throw new ApiError(409, 'BATCH_RUNNING', '批量正在执行，不能重复开始');
      const items = refreshBatch(data, ctx, batch);
      const balance = balanceOf(data, ctx.tenantId, { initialCredits });
      const plan = planBatch({
        items: items.map(item => ({
          item_id: item.id, sku: item.sku, status: item.status, blockers: item.blockers,
          estimated_credits: item.estimated_credits, max_credits: item.max_credits,
        })),
        availableCredits: balance.available,
        confirmed: true,
      });
      if (!plan.can_start) {
        throw new ApiError(409, 'BATCH_NOT_STARTABLE', plan.reasons[0]?.message ?? '批量暂不可开始', {
          reasons: plan.reasons,
        });
      }
      batch.budget = {
        confirmed: true,
        confirmed_by: ctx.actorId,
        confirmed_at: new Date(clock()).toISOString(),
        estimated_credits: plan.estimated_credits,
        max_credits: plan.max_credits,
      };
      batch.status = 'running';
      batch.updated_at = new Date(clock()).toISOString();
      const ready = items.filter(item => item.status === 'ready');
      batch.items = items;
      return {
        batchId: batch.id,
        ready: ready.map(item => ({ itemId: item.id, projectId: item.project_id, sku: item.sku })),
      };
    });

    const failures = [];
    for (const entry of prepared.ready) {
      try {
        const context = await store.read(data => {
          const project = data.projects?.[entry.projectId] ?? null;
          if (!project || project.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '项目不存在');
          const spec = latestSpec(data, project.id);
          if (!spec) throw new ApiError(409, 'SPEC_REQUIRED', '缺少冻结配置');
          return { project, spec };
        });
        const quote = await store.mutate(data => {
          const record = { ...quoteFromSpec({ spec: context.spec, at: clock(), finishedImages: ctx.mode === 'session' }), tenant_id: ctx.tenantId, project_id: context.project.id };
          data.quotes[record.quote_id] = record;
          return record;
        });
        const runId = newId('run');
        await jobs.createRun({
          ctx,
          run: { id: runId, created_at: new Date(clock()).toISOString() },
          project: context.project,
          spec: context.spec,
          quote,
          idempotencyKey: `batch:${prepared.batchId}:${entry.itemId}`,
          scenario: 'success',
          fingerprint: fingerprintOf({
            batch_id: prepared.batchId, item_id: entry.itemId,
            project_id: context.project.id, spec_version: context.spec.version, quote_id: quote.quote_id,
          }),
        });
        await store.mutate(data => {
          const item = data.batch_items?.[entry.itemId] ?? null;
          if (!item || item.tenant_id !== ctx.tenantId) return;
          item.run_id = runId;
          item.quote_id = quote.quote_id;
          item.status = 'running';
          item.spec_version = context.spec.version;
          item.blockers = [];
          item.last_error = null;
          item.updated_at = new Date(clock()).toISOString();
        });
      } catch (error) {
        failures.push({ item_id: entry.itemId, sku: entry.sku, code: error?.code ?? 'INTERNAL_ERROR', message: error?.message ?? '未知错误' });
        await store.mutate(data => {
          const item = data.batch_items?.[entry.itemId] ?? null;
          if (!item || item.tenant_id !== ctx.tenantId) return;
          item.status = 'failed';
          item.last_error = { code: error?.code ?? 'INTERNAL_ERROR', message: error?.message ?? '未知错误' };
          item.updated_at = new Date(clock()).toISOString();
        });
      }
    }

    const view = await store.read(data => {
      const batch = data.batches?.[batchId] ?? null;
      if (!batch || batch.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '批量任务不存在');
      const items = batchItemsOf(data, ctx, batch.id).map(item => ({ ...item, status: itemStatusOf(data, item) }));
      batch.items = items;
      batch.summary = batchSummary(items);
      return batchView(data, ctx, batch);
    });
    send(201, { batch: view, started: prepared.ready.length - failures.length, failures });
  }

  async function batchExportRoute(ctx, batchId, req, send) {
    await requireAction(ctx, 'batch:export');
    const body = await readJson(req).catch(() => ({}));
    const scope = body.scope ?? 'partial';
    const result = await jobs.createBatchExport(ctx, batchId, { scope });
    send(201, result);
  }

  async function listMembersRoute(ctx, send) {
    const payload = await store.read(data => {
      const resolved = roleOf(data, ctx);
      if (!resolved.role) throw new ApiError(403, 'FORBIDDEN', '当前操作者不是该租户成员');
      return {
        tenant_id: ctx.tenantId,
        role: resolved.role,
        bootstrap: resolved.bootstrap === true,
        permissions: describePermissions(resolved.role).permissions,
        members: tenantMembers(data, ctx.tenantId)
          .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
          .map(item => ({ actor_id: item.actor_id, role: item.role, created_at: item.created_at })),
      };
    });
    send(200, payload);
  }

  async function upsertMemberRoute(ctx, req, send) {
    const actorRole = await requireAction(ctx, 'member:manage');
    const body = await readJson(req);
    const targetActorId = String(body.actor_id ?? '').trim();
    if (!targetActorId) throw new ApiError(422, 'MEMBER_ACTOR_REQUIRED', '需要提供 actor_id');
    const role = String(body.role ?? '').trim();
    const result = await store.mutate(data => {
      // 首次登记成员时，把当前操作者固化为 owner：否则引导期一加人就没人能管理租户
      if (tenantMembers(data, ctx.tenantId).length === 0 && actorRole === 'owner') {
        const bootstrap = {
          id: newId('mbr'),
          tenant_id: ctx.tenantId,
          actor_id: ctx.actorId,
          role: 'owner',
          created_by: ctx.actorId,
          created_at: now(),
          updated_at: now(),
        };
        data.members[bootstrap.id] = bootstrap;
      }
      const members = tenantMembers(data, ctx.tenantId);
      const plan = planMemberChange({ members, targetActorId, nextRole: role, actorRole });
      if (!plan.ok) throw new ApiError(409, plan.code, plan.message);
      const existing = members.find(item => item.actor_id === targetActorId) ?? null;
      if (existing) {
        existing.role = role;
        existing.updated_at = new Date(clock()).toISOString();
        return { member: existing, action: 'update' };
      }
      const record = {
        id: newId('mbr'),
        tenant_id: ctx.tenantId,
        actor_id: targetActorId,
        role,
        created_by: ctx.actorId,
        created_at: new Date(clock()).toISOString(),
        updated_at: new Date(clock()).toISOString(),
      };
      data.members[record.id] = record;
      return { member: record, action: 'add' };
    });
    send(201, { member: { actor_id: result.member.actor_id, role: result.member.role }, action: result.action });
  }

  async function removeMemberRoute(ctx, actorId, send) {
    const actorRole = await requireAction(ctx, 'member:manage');
    const result = await store.mutate(data => {
      const members = tenantMembers(data, ctx.tenantId);
      const plan = planMemberChange({ members, targetActorId: actorId, nextRole: null, actorRole });
      if (!plan.ok) throw new ApiError(409, plan.code, plan.message);
      const existing = members.find(item => item.actor_id === actorId);
      delete data.members[existing.id];
      return { removed: actorId };
    });
    send(200, result);
  }

  async function createRecipeRoute(ctx, req, send) {
    await requireAction(ctx, 'recipe:write');
    const body = await readJson(req);
    const checked = validateRecipeInput(body);
    if (!checked.ok) {
      throw new ApiError(422, 'RECIPE_INVALID', checked.issues[0]?.message ?? '配方参数无效', { issues: checked.issues });
    }
    const result = await store.mutate(data => {
      const kit = data.brand_kits?.[checked.payload.brand_kit_id] ?? null;
      if (!kit || kit.tenant_id !== ctx.tenantId) {
        throw new ApiError(422, 'RECIPE_BRAND_KIT_UNKNOWN', '品牌套件不存在或不属于当前租户');
      }
      const template = listTemplates().find(item => item.id === checked.payload.template_id);
      if (!template) throw new ApiError(422, 'RECIPE_TEMPLATE_UNKNOWN', '模板不存在');
      const recipeId = newId('rcp');
      const recipe = {
        id: recipeId,
        schema_version: 1,
        tenant_id: ctx.tenantId,
        name: checked.payload.name,
        scope: checked.payload.scope,
        head_version: 1,
        created_by: ctx.actorId,
        created_at: now(),
        updated_at: now(),
      };
      data.recipes[recipeId] = recipe;
      const version = {
        id: newId('rcv'),
        tenant_id: ctx.tenantId,
        recipe_id: recipeId,
        ...makeRecipeVersion({
          recipeId, previousVersions: [], payload: checked.payload, actorId: ctx.actorId, at: new Date(clock()),
        }),
      };
      data.recipe_versions[version.id] = version;
      return { recipe, version };
    });
    send(201, {
      recipe: result.recipe,
      version: result.version,
      note: result.version.status === 'pending'
        ? '共享配方需要 owner 审批后才能用于生产'
        : '私有配方仅创建者可用，版本已生效',
    });
  }

  async function listRecipesRoute(ctx, send) {
    await requireAction(ctx, 'recipe:read');
    const payload = await store.read(data => {
      const recipes = Object.values(data.recipes ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && isRecipeVisible({ recipe: item, actorId: ctx.actorId }))
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .map(item => {
          const versions = Object.values(data.recipe_versions ?? {})
            .filter(version => version.recipe_id === item.id)
            .sort((left, right) => left.version - right.version);
          const latest = versions[versions.length - 1] ?? null;
          return {
            ...item,
            latest_version: latest ? { version: latest.version, status: latest.status } : null,
            approved_version: versions.filter(v => v.status === 'approved')
              .sort((l, r) => r.version - l.version)[0]?.version ?? null,
          };
        });
      return { tenant_id: ctx.tenantId, recipes, total: recipes.length };
    });
    send(200, payload);
  }

  async function getRecipeRoute(ctx, recipeId, send) {
    await requireAction(ctx, 'recipe:read');
    const payload = await store.read(data => {
      const recipe = data.recipes?.[recipeId] ?? null;
      if (!recipe || recipe.tenant_id !== ctx.tenantId || !isRecipeVisible({ recipe, actorId: ctx.actorId })) {
        throw new ApiError(404, 'NOT_FOUND', '配方不存在');
      }
      const versions = Object.values(data.recipe_versions ?? {})
        .filter(item => item.recipe_id === recipe.id)
        .sort((left, right) => left.version - right.version);
      return { recipe, versions };
    });
    send(200, payload);
  }

  async function approveRecipeRoute(ctx, recipeId, req, send) {
    const actorRole = await requireAction(ctx, 'recipe:approve');
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const recipe = data.recipes?.[recipeId] ?? null;
      if (!recipe || recipe.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '配方不存在');
      const versionNumber = Number(body.version);
      if (!Number.isInteger(versionNumber)) throw new ApiError(422, 'RECIPE_VERSION_REQUIRED', '需要指定要审批的版本号');
      const versions = Object.values(data.recipe_versions ?? {})
        .filter(item => item.recipe_id === recipe.id)
        .sort((left, right) => left.version - right.version);
      const target = versions.find(item => item.version === versionNumber) ?? null;
      if (!target) throw new ApiError(404, 'NOT_FOUND', '配方版本不存在');
      const applied = applyRecipeApproval({
        version: target,
        decision: body.decision,
        actorRole,
        actorId: ctx.actorId,
        note: body.note ?? '',
        at: new Date(clock()),
      });
      if (!applied.ok) throw new ApiError(409, applied.code, applied.message);
      const updated = { ...applied.version, tenant_id: ctx.tenantId, recipe_id: recipe.id, id: target.id };
      const superseded = [];
      if (applied.supersede_previous_approved) {
        for (const version of versions) {
          if (version.id === target.id) continue;
          if (version.status !== 'approved') continue;
          version.status = 'superseded';
          version.superseded_at = applied.at;
          superseded.push(version.version);
        }
      }
      data.recipe_versions[target.id] = updated;
      recipe.updated_at = applied.at;
      return { version: updated, superseded, recipe };
    });
    send(200, {
      recipe: result.recipe,
      version: result.version,
      superseded_versions: result.superseded,
      invalidation_note: result.superseded.length > 0
        ? '新版本已批准，引用旧版本的记录会变为 stale，需要重新按新版本生产'
        : null,
    });
  }

  async function recordRecipeUsageRoute(ctx, recipeId, req, send) {
    await requireAction(ctx, 'recipe:write');
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const recipe = data.recipes?.[recipeId] ?? null;
      if (!recipe || recipe.tenant_id !== ctx.tenantId || !isRecipeVisible({ recipe, actorId: ctx.actorId })) {
        throw new ApiError(404, 'NOT_FOUND', '配方不存在');
      }
      const versions = Object.values(data.recipe_versions ?? {})
        .filter(item => item.recipe_id === recipe.id);
      const targetVersion = Number(body.version ?? 0);
      const version = targetVersion
        ? versions.find(item => item.version === targetVersion) ?? null
        : versions.filter(item => item.status === 'approved').sort((l, r) => r.version - l.version)[0] ?? null;
      if (!version || version.status !== 'approved') {
        throw new ApiError(409, 'RECIPE_NOT_APPROVED', '配方版本尚未批准，不能用于生产');
      }
      const usage = {
        id: newId('rus'),
        tenant_id: ctx.tenantId,
        recipe_id: recipe.id,
        recipe_version: version.version,
        actor_id: ctx.actorId,
        target_type: String(body.target_type ?? 'spec').trim() || 'spec',
        target_id: String(body.target_id ?? '').trim() || null,
        created_at: now(),
      };
      data.recipe_usages[usage.id] = usage;
      return { usage, version };
    });
    const validity = evaluateRecipeUseValidity({
      usage: result.usage,
      recipe: { ...result.version, scope: result.version.payload.scope, created_by: result.version.created_by },
      versions: await store.read(data => Object.values(data.recipe_versions ?? {})
        .filter(item => item.recipe_id === recipeId)),
    });
    send(201, { usage: result.usage, validity });
  }

  async function listRecipeUsagesRoute(ctx, recipeId, send) {
    await requireAction(ctx, 'recipe:read');
    const payload = await store.read(data => {
      const recipe = data.recipes?.[recipeId] ?? null;
      if (!recipe || recipe.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '配方不存在');
      const versions = Object.values(data.recipe_versions ?? {}).filter(item => item.recipe_id === recipe.id);
      const head = versions.filter(item => item.status === 'approved').sort((l, r) => r.version - l.version)[0] ?? null;
      const usages = Object.values(data.recipe_usages ?? {})
        .filter(item => item.recipe_id === recipe.id && item.tenant_id === ctx.tenantId)
        .map(item => ({
          ...item,
          validity: evaluateRecipeUseValidity({
            usage: item,
            recipe: { ...head, scope: recipe.scope, created_by: recipe.created_by, brand_kit_id: head?.payload?.brand_kit_id ?? null },
            versions,
          }),
        }));
      return { recipe_id: recipe.id, usages, total: usages.length };
    });
    send(200, payload);
  }

  // ---------- M12：结果回流、效果导入、实验、商业化、可观测性与备份 ----------

  async function createFeedbackRoute(ctx, req, send) {
    await requireAction(ctx, 'feedback:write');
    const body = await readJson(req);
    const checked = validateFeedbackInput(body);
    if (!checked.ok) {
      throw new ApiError(422, 'FEEDBACK_INVALID', checked.issues[0].message, { issues: checked.issues });
    }
    const runId = String(body.run_id ?? '').trim();
    if (!runId) throw new ApiError(422, 'FEEDBACK_RUN_REQUIRED', '需要提供 run_id');
    const versionIdIn = body.version_id ? String(body.version_id) : null;
    const target = await store.read(data => {
      const run = data.runs?.[runId] ?? null;
      if (!run || run.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
      const versions = Array.isArray(run.versions) ? run.versions : [];
      const version = versionIdIn
        ? versions.find(item => item.id === versionIdIn) ?? null
        : versions.find(item => item.active === true) ?? null;
      return {
        run: { status: run.status, project_id: run.project_id },
        version: version ? {
          id: version.id, active: version.active === true,
          report_id: version.report_id ?? null, deliverable_id: version.deliverable_id ?? null,
        } : null,
      };
    });
    let report = null;
    let reportValidity = null;
    if (target.version?.report_id) {
      const view = await jobs.getQualityReport(ctx, target.version.report_id);
      report = { decision: view.report.decision };
      reportValidity = view.report.validity;
    }
    const eligibility = evaluateFeedbackEligibility({
      decision: checked.value.decision, run: target.run, version: target.version, report, reportValidity,
    });
    if (!eligibility.ok) {
      const first = eligibility.blockers[0];
      throw new ApiError(409, first.code, first.message, { blockers: eligibility.blockers });
    }
    if (checked.value.experiment_id) {
      await store.read(data => {
        const experiment = data.experiments?.[checked.value.experiment_id] ?? null;
        if (!experiment || experiment.tenant_id !== ctx.tenantId) {
          throw new ApiError(404, 'NOT_FOUND', '实验不存在');
        }
        return experiment;
      });
    }
    const record = await store.mutate(data => {
      const item = {
        id: newId('fbk'),
        tenant_id: ctx.tenantId,
        run_id: runId,
        project_id: target.run.project_id ?? null,
        version_id: target.version.id,
        deliverable_id: target.version.deliverable_id ?? null,
        decision: checked.value.decision,
        reason_code: checked.value.reason_code,
        note: checked.value.note,
        experiment_id: checked.value.experiment_id,
        arm: checked.value.arm,
        report_id: target.version.report_id ?? null,
        evidence: report ? { report_decision: report.decision, report_validity: reportValidity } : null,
        actor_id: ctx.actorId,
        created_at: new Date(clock()).toISOString(),
      };
      data.feedback[item.id] = item;
      return item;
    });
    send(201, { feedback: record });
  }

  async function listFeedbackRoute(ctx, query, send) {
    await requireAction(ctx, 'feedback:read');
    const runId = query.get('run_id');
    const limit = Math.min(Math.max(Number(query.get('limit') ?? 100) || 100, 1), 500);
    const payload = await store.read(data => {
      const scoped = Object.values(data.feedback ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .filter(item => !runId || item.run_id === runId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
      return {
        tenant_id: ctx.tenantId,
        feedback: scoped.slice(0, limit),
        total: scoped.length,
        summary: summarizeFeedback(scoped),
      };
    });
    send(200, payload);
  }

  async function createOutcomeImportRoute(ctx, req, send) {
    await requireAction(ctx, 'outcome:write');
    const body = await readJson(req);
    const checked = validateOutcomeImportInput(body);
    if (!checked.ok) {
      const first = checked.issues[0];
      const status = first.code === 'OUTCOME_AUTHORIZATION_REQUIRED' ? 403 : 422;
      throw new ApiError(status, first.code, first.message, { issues: checked.issues });
    }
    if (checked.value.experiment_id) {
      await store.read(data => {
        const experiment = data.experiments?.[checked.value.experiment_id] ?? null;
        if (!experiment || experiment.tenant_id !== ctx.tenantId) {
          throw new ApiError(404, 'NOT_FOUND', '实验不存在');
        }
        return experiment;
      });
    }
    const preview = previewOutcomeRows({ rows: body.rows });
    if (preview.summary.valid === 0) {
      throw new ApiError(422, 'OUTCOME_NO_VALID_ROWS', '没有任何可用行，请修正后再导入', {
        rows: preview.rows, issues: checked.issues,
      });
    }
    const record = await store.mutate(data => {
      const item = {
        id: newId('imp'),
        tenant_id: ctx.tenantId,
        source: checked.value.source,
        authorization_reference: checked.value.authorization_reference,
        experiment_id: checked.value.experiment_id,
        arm: checked.value.arm,
        rows: preview.accepted.map(row => ({
          ...row, experiment_id: checked.value.experiment_id, arm: checked.value.arm,
        })),
        rejected: preview.rows.filter(row => !row.valid).map(row => ({
          index: row.index, sku: row.sku ?? null, errors: row.errors,
        })),
        summary: preview.summary,
        imported_by: ctx.actorId,
        imported_at: new Date(clock()).toISOString(),
      };
      data.outcome_imports[item.id] = item;
      return item;
    });
    send(201, { import: record, rows_preview: preview.rows });
  }

  async function listOutcomesRoute(ctx, query, send) {
    await requireAction(ctx, 'outcome:read');
    const experimentId = query.get('experiment_id');
    const payload = await store.read(data => {
      const imports = Object.values(data.outcome_imports ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .filter(item => !experimentId || item.experiment_id === experimentId)
        .sort((left, right) => String(right.imported_at).localeCompare(String(left.imported_at)));
      const rows = imports.flatMap(item => item.rows);
      const sources = [...new Set(imports.map(item => `${item.source}｜${item.authorization_reference}`))];
      return {
        tenant_id: ctx.tenantId,
        imports: imports.map(item => ({
          id: item.id, source: item.source, authorization_reference: item.authorization_reference,
          experiment_id: item.experiment_id, arm: item.arm, summary: item.summary,
          imported_at: item.imported_at,
        })),
        metrics: summarizeOutcomeMetrics(rows),
        sources,
      };
    });
    send(200, payload);
  }

  async function createExperimentRoute(ctx, req, send) {
    await requireAction(ctx, 'outcome:write');
    const body = await readJson(req);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiError(422, 'EXPERIMENT_NAME_REQUIRED', '实验名称不能为空');
    if (name.length > 80) throw new ApiError(422, 'EXPERIMENT_NAME_TOO_LONG', '实验名称不能超过 80 字');
    const metrics = ['ctr', 'cvr', 'cost_per_order', 'adoption_rate'];
    const primaryMetric = String(body.primary_metric ?? 'cvr').trim();
    if (!metrics.includes(primaryMetric)) {
      throw new ApiError(422, 'EXPERIMENT_METRIC_INVALID', `primary_metric 必须是 ${metrics.join(' / ')} 之一`);
    }
    const experiment = await store.mutate(data => {
      const item = {
        id: newId('exp'),
        tenant_id: ctx.tenantId,
        name,
        hypothesis: body.hypothesis ? String(body.hypothesis).trim().slice(0, 500) : null,
        primary_metric: primaryMetric,
        status: 'collecting',
        created_by: ctx.actorId,
        created_at: new Date(clock()).toISOString(),
      };
      data.experiments[item.id] = item;
      return item;
    });
    send(201, { experiment });
  }

  async function listExperimentsRoute(ctx, send) {
    await requireAction(ctx, 'outcome:read');
    const payload = await store.read(data => ({
      tenant_id: ctx.tenantId,
      experiments: Object.values(data.experiments ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .map(item => ({ ...item })),
    }));
    send(200, payload);
  }

  async function getExperimentRoute(ctx, experimentId, send) {
    await requireAction(ctx, 'outcome:read');
    const payload = await store.read(data => {
      const experiment = data.experiments?.[experimentId] ?? null;
      if (!experiment || experiment.tenant_id !== ctx.tenantId) {
        throw new ApiError(404, 'NOT_FOUND', '实验不存在');
      }
      const imports = Object.values(data.outcome_imports ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.experiment_id === experiment.id);
      const outcomes = imports.flatMap(item => item.rows);
      const feedback = Object.values(data.feedback ?? {})
        .filter(item => item.tenant_id === ctx.tenantId && item.experiment_id === experiment.id);
      return {
        experiment,
        report: buildExperimentReport({ experiment, outcomes, feedback }),
        provenance: {
          imports: imports.length,
          sources: [...new Set(imports.map(item => item.source))],
          authorization_references: [...new Set(imports.map(item => item.authorization_reference))],
        },
      };
    });
    send(200, payload);
  }

  function grantOrder(data, order, actor) {
    if (order.plan_snapshot.kind === 'experience') return grantExperienceCredits(data, { tenantId: order.tenant_id, actor, at: clock(), initialCredits });
    const snapshot = order.plan_snapshot;
    return appendEntry(data, { type: 'grant', amount: order.credits, tenantId: order.tenant_id,
      uniqueOperationKey: `billing-order:${order.id}`, actor, initialCredits, at: clock(),
      memo: `套餐到账：${snapshot.name}`,
      lot: { order_id: order.id, kind: snapshot.kind,
        expires_at: snapshot.validity_days ? expiryFromSnapshot(snapshot, clock()) : null, version_snapshot: snapshot } });
  }

  function validatePayment(order, result) {
    const identity = paymentProvider?.identity;
    if (identity && (result.mchid !== identity.mchid || result.appid !== identity.appid)) throw new ApiError(400, 'PAYMENT_IDENTITY_MISMATCH', '支付商户或 AppID 不匹配');
    if (result.out_trade_no !== order.out_trade_no || result.amount?.total !== order.price_cents || result.amount?.currency !== order.currency || !result.transaction_id) throw new ApiError(400, 'PAYMENT_AMOUNT_MISMATCH', '支付订单、金额或币种不匹配');
  }

  function settlePayment(data, order, result, actor) {
    validatePayment(order, result);
    if (['settled_real', 'refunded'].includes(order.status) || order.refund_status) return order;
    const reused = Object.values(data.billing_orders).some(o => o.id !== order.id && o.transaction_id === result.transaction_id);
    if (reused) throw new ApiError(409, 'PAYMENT_TRANSACTION_REUSED', '支付交易已关联其他订单');
    grantOrder(data, order, actor);
    order.status = 'settled_real'; order.settled_at = new Date(clock()).toISOString();
    order.settled_by = actor; order.transaction_id = result.transaction_id; order.wechat_trade_state = 'SUCCESS';
    const id = newId('pay'); data.payment_events[id] = { id, tenant_id: order.tenant_id, order_id: order.id, type: 'real_order_settled', amount_cents: order.price_cents, created_at: order.settled_at };
    return order;
  }

  function finishRefund(data, order, result) {
    if (order.refund_status !== 'processing') return;
    if (paymentProvider?.identity && (result.out_refund_no !== order.refund_out_refund_no ||
      result.amount?.refund !== order.refund_amount_cents || result.amount?.total !== order.price_cents)) {
      throw new ApiError(400, 'REFUND_AMOUNT_MISMATCH', '退款订单或金额不匹配');
    }
    const status = result.status ?? result.refund_status;
    if (status === 'ABNORMAL') {
      order.refund_requires_manual = true;
      order.refund_error = '微信退款异常，需在商户平台处理；对应权益继续冻结';
      return;
    }
    if (!['SUCCESS', 'CLOSED', 'ABNORMAL'].includes(status)) return;
    // 只在最终结果确定后解除冻结；成功后同步回收原订单批次。
    for (const allocation of order.refund_allocations ?? []) {
      const lot = data.credit_lots[allocation.lot_id];
      if (!lot || (lot.refund_frozen ?? 0) < allocation.amount) throw new Error('退款冻结批次不一致');
      lot.refund_frozen -= allocation.amount;
      data.credit_accounts[order.tenant_id].available += allocation.amount;
    }
    if (status === 'SUCCESS') {
      appendEntry(data, { type: 'revoke', amount: order.refund_credits, tenantId: order.tenant_id,
        uniqueOperationKey: `billing-refund:${order.refund_out_refund_no}`, actor: 'refund_result', initialCredits, at: order.refund_started_at ?? clock(), lot: { order_id: order.id } });
      order.status = 'refunded'; order.refund_status = 'success'; order.refunded_at = new Date(clock()).toISOString();
    } else { order.refund_status = 'failed'; order.refund_error = status; }
    order.refund_allocations = []; order.refund_transaction_id = result.refund_id ?? null;
    sweepExpiredLots(data, order.tenant_id, clock(), { initialCredits });
  }

  async function createBillingOrderRoute(ctx, req, send) {
    await requireAction(ctx, 'billing:manage');
    const body = await readJson(req), plan = resolvePlanById(String(body.plan_id ?? ''));
    if (!plan) throw new ApiError(422, 'PLAN_UNKNOWN', '套餐不存在');
    const capability = evaluatePaymentCapability({ provider: paymentProvider });
    const free = plan.kind === 'experience';
    if (!free && !capability.can_checkout) throw new ApiError(409, capability.blockers[0]?.code ?? 'PAYMENT_UNAVAILABLE', '支付通道尚未开放');
    let order = await store.mutate(data => {
      const existing = Object.values(data.billing_orders).find(o => o.tenant_id === ctx.tenantId && o.plan_id === plan.id &&
        (free || o.status === 'pending_wechat_checkout'));
      if (existing) return existing;
      const live = capability.real_money && capability.supports_native_qr && !free;
      const item = { id: newId('ord'), tenant_id: ctx.tenantId, plan_id: plan.id, plan_snapshot: planSnapshot(plan),
        credits: plan.credits, seats: plan.seats ?? 1, price_cents: plan.price_cents, currency: plan.currency ?? 'CNY',
        out_trade_no: live ? 'TB' + randomBytes(12).toString('hex') : null,
        status: live ? 'pending_wechat_checkout' : 'pending_demo_settlement', real_money: live, simulated: !live,
        settlement: live ? 'wechat_native' : 'internal_demo_credits', pay_provider: live ? 'wechat_native' : 'mock',
        notice: plan.terms ?? plan.note, created_by: ctx.actorId, created_at: new Date(clock()).toISOString(),
        expires_at: new Date(new Date(clock()).getTime() + 15 * 60_000).toISOString() };
      data.billing_orders[item.id] = item;
      if (free) {
        grantOrder(data, item, ctx.actorId); item.status = 'settled_real'; item.real_money = false; item.simulated = false;
        item.pay_provider = 'free_trial'; item.settled_at = new Date(clock()).toISOString();
      }
      const id = newId('pay'); data.payment_events[id] = { id, tenant_id: ctx.tenantId, order_id: item.id,
        type: 'order_created', amount_cents: item.price_cents, created_at: item.created_at };
      return item;
    });
    // 站内订单先落盘，外部下单不占写队列，重试沿用同一商户单号。
    if (order.real_money && !order.code_url) {
      let native;
      try { native = await paymentProvider.createNativeOrder({ out_trade_no: order.out_trade_no,
        description: '千图百炼 ' + order.plan_snapshot.name, amount_cents: order.price_cents,
        attach: JSON.stringify({ order_id: order.id }), expires_at: order.expires_at }); }
      catch (error) { throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', '支付下单暂不可用，请查询原订单后重试'); }
      order = await store.mutate(data => { const o = data.billing_orders[order.id];
        o.code_url = native.code_url; o.pay_qr = native.qr_code_url ?? null; o.prepay_id = native.prepay_id ?? null;
        o.wechat_trade_state = native.trade_state; return o; });
    }
    send(201, { order, payment: capability });
  }

  async function listBillingOrdersRoute(ctx, send) {
    await requireAction(ctx, 'billing:read');
    const payload = await store.read(data => ({
      tenant_id: ctx.tenantId,
      orders: Object.values(data.billing_orders ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .map(item => ({ ...item })),
      payment: evaluatePaymentCapability({ provider: paymentProvider }),
    }));
    send(200, payload);
  }

  async function settleBillingOrderRoute(ctx, orderId, send) {
    await requireAction(ctx, 'billing:manage');
    const capability = evaluatePaymentCapability({ provider: paymentProvider });
    const result = await store.mutate(data => {
      const order = data.billing_orders?.[orderId] ?? null;
      if (!order || order.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '订单不存在');
      // 真实支付订单：只允许回调结算（状态机保护），手动 settle 拦截
      if (order.real_money === true && order.pay_provider === 'wechat_native') {
        throw new ApiError(409, 'ORDER_SETTLE_VIA_CALLBACK', '微信支付订单只能通过回调自动结算，不允许手动结算');
      }
      // 已结算订单：无论 demo 还是 real，手动再调都返回 409
      if (order.status === 'settled_demo' || order.status === 'settled_real') {
        throw new ApiError(409, 'ORDER_STATE_INVALID', `订单当前状态为 ${order.status}，不能重复结算`);
      }
      if (order.status !== 'pending_demo_settlement') {
        throw new ApiError(409, 'ORDER_STATE_INVALID', `订单当前状态为 ${order.status}，不能结算`);
      }
      const entry = grantOrder(data, order, ctx.actorId);
      order.status = 'settled_demo';
      order.settled_at = new Date(clock()).toISOString();
      order.settled_by = ctx.actorId;
      const event = {
        id: newId('pay'), tenant_id: ctx.tenantId, order_id: order.id,
        type: 'demo_order_settled', amount_cents: 0, currency: order.plan_snapshot.currency,
        actor_id: ctx.actorId, created_at: order.settled_at,
      };
      data.payment_events[event.id] = event;
      return { order, balance: entry.balance, applied: entry.applied, idempotent: false };
    });
    send(200, {
      ...result,
      notice: result.order.real_money ? '额度已通过回调发放'
        : '演示额度已到账；未发生真实收款，不能作为生产计费依据',
    });
  }

  async function refundBillingOrderRoute(ctx, orderId, req, send) {
    await requireAction(ctx, 'billing:manage');
    const body = await readJson(req).catch(() => ({}));
    const order = await store.mutate(data => {
      const o = data.billing_orders[orderId];
      if (!o || o.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '订单不存在');
      if (!o.real_money) throw new ApiError(409, 'ORDER_NOT_REAL_MONEY', '演示订单不能退真实资金');
      if (o.status === 'refunded') throw new ApiError(409, 'ORDER_ALREADY_REFUNDED', '订单已退款');
      if (o.status !== 'settled_real') throw new ApiError(409, 'ORDER_NOT_SETTLED', '订单尚未到账');
      if (!paymentProvider?.refund || !evaluatePaymentCapability({ provider: paymentProvider }).can_refund) throw new ApiError(409, 'PAYMENT_REFUND_UNIMPLEMENTED', '退款通道未配置');
      if (o.refund_status === 'processing') return o;
      sweepExpiredLots(data, ctx.tenantId, clock(), { initialCredits });
      const credits = refundableCreditsForOrder(data, ctx.tenantId, o.id);
      if (!credits) throw new ApiError(409, 'NO_REFUNDABLE_CREDITS', '没有可退额度');
      o.refund_credits = credits; o.refund_amount_cents = Math.min(o.price_cents, Math.floor(o.price_cents * credits / o.credits));
      if (!o.refund_amount_cents) throw new ApiError(409, 'REFUND_AMOUNT_ZERO', '可退金额为零');
      o.refund_out_refund_no = 'RF_' + randomBytes(12).toString('hex');
      o.refund_status = 'processing'; o.refund_started_at = new Date(clock()).toISOString(); o.refund_allocations = [];
      for (const lot of Object.values(data.credit_lots).filter(l => l.tenant_id === ctx.tenantId && l.source_order_id === o.id)) {
        const amount = Math.max(0, lot.total - lot.consumed - lot.reserved - lot.expired - (lot.revoked ?? 0) - (lot.refund_frozen ?? 0));
        if (!amount) continue;
        lot.refund_frozen = (lot.refund_frozen ?? 0) + amount;
        data.credit_accounts[ctx.tenantId].available -= amount;
        o.refund_allocations.push({ lot_id: lot.id, amount });
      }
      return o;
    });
    let result;
    try {
      // 同一退款号重入安全；未知响应保留冻结，之后通过查退款补偿。
      result = await paymentProvider.refund({ out_trade_no: order.out_trade_no, out_refund_no: order.refund_out_refund_no,
        refund_amount_cents: order.refund_amount_cents, total_amount_cents: order.price_cents, reason: body.reason ?? '用户申请退款' });
    } catch (error) {
      await store.mutate(data => { data.billing_orders[order.id].refund_error = error.message; });
      throw new ApiError(502, 'PAYMENT_REFUND_FAILED', '退款结果尚未确定，权益保持冻结，请刷新订单查询');
    }
    const updated = await store.mutate(data => { const o = data.billing_orders[order.id]; finishRefund(data, o, result); return o; });
    send(200, { order: updated, refunded_credits: updated.refund_status === 'success' ? updated.refund_credits : 0, refund_amount_cents: updated.refund_amount_cents, balance: await store.read(data => balanceOf(data, ctx.tenantId, { initialCredits })) });
  }

  async function wechatNotifyRoute(ctx, req, send) {
    if (!paymentProvider?.verifyNotify) throw new ApiError(503, 'PAYMENT_UNAVAILABLE', '支付通道未配置');
    const body = (await readBody(req, 1024 * 1024)).toString('utf8');
    const verified = paymentProvider.verifyNotify({ headers: req.headers, body });
    if (!verified?.ok) throw new ApiError(401, 'PAYMENT_SIGNATURE_INVALID', '支付通知验签或解密失败');
    const result = verified.data;
    await store.mutate(data => {
      if (result?.out_refund_no) {
        const order = Object.values(data.billing_orders).find(o => o.refund_out_refund_no === result.out_refund_no);
        if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '退款订单不存在');
        if (paymentProvider.identity && result.mchid !== paymentProvider.identity.mchid) throw new ApiError(400, 'PAYMENT_IDENTITY_MISMATCH', '退款商户不匹配');
        if (result.amount?.refund !== order.refund_amount_cents || result.amount?.total !== order.price_cents) throw new ApiError(400, 'REFUND_AMOUNT_MISMATCH', '退款金额不匹配');
        finishRefund(data, order, result); return;
      }
      const order = Object.values(data.billing_orders).find(o => o.out_trade_no && o.out_trade_no === result?.out_trade_no);
      if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '支付订单不存在');
      if (result.trade_state === 'SUCCESS') settlePayment(data, order, result, 'wechat_callback');
      else if (['CLOSED', 'REVOKED', 'PAYERROR'].includes(result.trade_state) && order.status === 'pending_wechat_checkout') {
        order.status = 'wechat_' + result.trade_state.toLowerCase(); order.wechat_trade_state = result.trade_state;
      }
    });
    send(200, { code: 'SUCCESS', message: '成功' });
  }

  async function payBillingOrderRoute(ctx, orderId, send) {
    await requireAction(ctx, 'billing:manage');
    const order = await store.read(data => {
      const item = data.billing_orders?.[orderId] ?? null;
      if (!item || item.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '订单不存在');
      return item;
    });
    if (order.real_money !== true || order.pay_provider !== 'wechat_native') {
      throw new ApiError(409, 'ORDER_NOT_WECHAT', '该订单不涉及微信支付 Native 下单');
    }
    if (order.status !== 'pending_wechat_checkout') {
      throw new ApiError(409, 'ORDER_STATE_INVALID', `订单当前状态为 ${order.status}`);
    }
    const provider = paymentProvider;
    if (!provider?.createNativeOrder) throw new ApiError(501, 'PAYMENT_UNIMPLEMENTED', '支付 Provider 未配置');
    let result;
    try {
      result = await provider.createNativeOrder({
        out_trade_no: order.out_trade_no,
        description: `千图百炼 ${order.plan_snapshot.name} ${order.credits}张额度`,
        amount_cents: order.price_cents,
        attach: JSON.stringify({ order_id: order.id, tenant_id: ctx.tenantId }),
      });
    } catch (err) {
      throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', `下单失败：${err.message}`);
    }
    await store.mutate(data => {
      const o = data.billing_orders?.[order.id];
      if (!o) return;
      o.code_url = result.code_url ?? o.code_url;
      o.prepay_id = result.prepay_id ?? o.prepay_id;
      o.pay_qr = result.qr_code_url ?? o.pay_qr;
      o.wechat_trade_state = result.trade_state;
      o.updated_at = new Date(clock()).toISOString();
    });
    send(200, { order: { ...order, code_url: result.code_url }, provider: provider.id });
  }

  /** 查单。 */
  async function queryBillingOrderRoute(ctx, orderId, send) {
    await requireAction(ctx, 'billing:read');
    let order = await store.read(data => { const o = data.billing_orders[orderId];
      if (!o || o.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '订单不存在'); return o; });
    let result = null;
    if (order.refund_status === 'processing' && paymentProvider?.queryRefund) {
      result = await paymentProvider.queryRefund({ out_refund_no: order.refund_out_refund_no });
      order = await store.mutate(data => { const o = data.billing_orders[orderId]; finishRefund(data, o, result); return o; });
    } else if (order.out_trade_no && paymentProvider?.queryOrder) {
      result = await paymentProvider.queryOrder({ out_trade_no: order.out_trade_no });
      if (result.trade_state === 'SUCCESS') order = await store.mutate(data => settlePayment(data, data.billing_orders[orderId], result, 'query_order'));
    }
    send(200, { order, provider_state: result });
  }

  async function closeBillingOrderRoute(ctx, orderId, send) {
    await requireAction(ctx, 'billing:manage');
    const order = await store.read(data => {
      const item = data.billing_orders?.[orderId] ?? null;
      if (!item || item.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '订单不存在');
      return item;
    });
    if (!order.out_trade_no) {
      throw new ApiError(409, 'ORDER_NO_OUT_TRADE_NO', '订单无商户号，不能通过微信关单');
    }
    const provider = paymentProvider;
    if (!provider?.closeOrder) throw new ApiError(501, 'PAYMENT_UNIMPLEMENTED', '支付 Provider 未配置');
    let providerResult;
    try { providerResult = await provider.closeOrder({ out_trade_no: order.out_trade_no }); }
    catch (err) { throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', `关单失败：${err.message}`); }
    if (providerResult.trade_state === 'SUCCESS') providerResult = await provider.queryOrder({ out_trade_no: order.out_trade_no });
    const updatedOrder = await store.mutate(data => {
      const o = data.billing_orders?.[order.id];
      if (!o) return null;
      if (providerResult.trade_state === 'SUCCESS') return settlePayment(data, o, providerResult, 'close_order_race');
      if (providerResult.closed === false) throw new ApiError(409, 'ORDER_CLOSE_UNCONFIRMED', '关单未成功，请刷新订单查询支付结果');
      if (o.status === 'pending_wechat_checkout') {
        o.status = 'wechat_closed';
        o.wechat_trade_state = 'CLOSED';
        o.settled_at = new Date(clock()).toISOString();
      }
      return o;
    });
    send(200, { order: updatedOrder ?? order, provider_state: providerResult });
  }

  async function metricsRoute(ctx, send) {
    await requireAction(ctx, 'metrics:read');
    const payload = await store.read(data => buildObservabilitySnapshot({
      data,
      tenantId: ctx.tenantId,
      counters: metrics,
      startedAt,
      at: new Date(clock()).toISOString(),
      provider: publish.provider,
      balance: balanceOf(data, ctx.tenantId, { initialCredits }),
    }));
    send(200, payload);
  }

  // ---------- M12：租户级备份与恢复 ----------

  async function presentBlobNames() {
    try {
      const names = await readdir(path.join(store.dir, 'blobs'));
      return names.filter(name => !name.endsWith('.tmp'));
    } catch {
      return [];
    }
  }

  async function loadBackupFiles(ctx, backupId) {
    if (!/^bkp_[0-9a-f]{16}$/.test(backupId)) {
      throw new ApiError(400, 'BACKUP_ID_INVALID', '备份编号无效');
    }
    const record = await store.read(data => {
      const item = data.backups?.[backupId] ?? null;
      if (!item || item.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '备份不存在');
      return item;
    });
    let manifest = null;
    let snapshot = null;
    try {
      manifest = JSON.parse(await readFile(path.join(backupDirOf(backupId), 'manifest.json'), 'utf8'));
      snapshot = JSON.parse(await readFile(path.join(backupDirOf(backupId), 'data.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { record, manifest, snapshot };
  }

  async function createBackupRoute(ctx, send) {
    await requireAction(ctx, 'backup:manage');
    const backupId = newId('bkp');
    const createdAt = new Date(clock()).toISOString();
    const snapshot = await store.read(data => tenantSnapshot(data, ctx.tenantId));
    const manifest = buildBackupManifest({
      backupId, tenantId: ctx.tenantId, snapshot, createdAt, createdBy: ctx.actorId,
      formatVersion: BACKUP_FORMAT_VERSION,
    });
    const dir = backupDirOf(backupId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'data.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const record = await store.mutate(data => {
      const item = {
        id: backupId,
        tenant_id: ctx.tenantId,
        format_version: manifest.format_version,
        data_sha256: manifest.data_sha256,
        blob_refs_sha256: manifest.blob_refs_sha256,
        counts: manifest.counts,
        blob_count: manifest.blob_refs.length,
        created_by: ctx.actorId,
        created_at: createdAt,
        restored_at: null,
      };
      data.backups[item.id] = item;
      return item;
    });
    send(201, {
      backup: record,
      manifest: {
        data_sha256: manifest.data_sha256, blob_refs_sha256: manifest.blob_refs_sha256,
        counts: manifest.counts, blob_refs: manifest.blob_refs.length,
      },
    });
  }

  async function listBackupsRoute(ctx, send) {
    await requireAction(ctx, 'backup:manage');
    const payload = await store.read(data => ({
      tenant_id: ctx.tenantId,
      backups: Object.values(data.backups ?? {})
        .filter(item => item.tenant_id === ctx.tenantId)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
    }));
    send(200, payload);
  }

  async function getBackupRoute(ctx, backupId, send) {
    await requireAction(ctx, 'backup:manage');
    const loaded = await loadBackupFiles(ctx, backupId);
    send(200, {
      backup: loaded.record,
      manifest: loaded.manifest
        ? {
          format_version: loaded.manifest.format_version, tenant_id: loaded.manifest.tenant_id,
          created_at: loaded.manifest.created_at, data_sha256: loaded.manifest.data_sha256,
          counts: loaded.manifest.counts, blob_refs: loaded.manifest.blob_refs.length,
        }
        : null,
    });
  }

  async function verifyBackupRoute(ctx, backupId, send) {
    await requireAction(ctx, 'backup:manage');
    const loaded = await loadBackupFiles(ctx, backupId);
    const presentBlobs = await presentBlobNames();
    const verdict = verifyBackupManifest({
      manifest: loaded.manifest, snapshot: loaded.snapshot, tenantId: ctx.tenantId, presentBlobs,
    });
    send(verdict.ok ? 200 : 409, {
      backup: loaded.record,
      ok: verdict.ok,
      issues: verdict.issues,
      checked: { blobs_present: presentBlobs.length },
    });
  }

  async function restoreBackupRoute(ctx, req, backupId, send) {
    await requireAction(ctx, 'backup:manage');
    const body = await readJson(req).catch(() => ({}));
    if (body.confirm !== true) {
      throw new ApiError(422, 'BACKUP_CONFIRM_REQUIRED', '恢复会覆盖本租户当前数据，必须显式确认（confirm: true）');
    }
    const loaded = await loadBackupFiles(ctx, backupId);
    const presentBlobs = await presentBlobNames();
    const verdict = verifyBackupManifest({
      manifest: loaded.manifest, snapshot: loaded.snapshot, tenantId: ctx.tenantId, presentBlobs,
    });
    if (!verdict.ok) {
      throw new ApiError(409, verdict.issues[0]?.code ?? 'BACKUP_INVALID', '备份校验未通过，未执行恢复', {
        issues: verdict.issues,
      });
    }
    const restored = await store.mutate(draft => {
      mergeTenantSnapshot(draft, loaded.snapshot, ctx.tenantId);
      const record = draft.backups?.[backupId] ?? null;
      if (record) {
        record.restored_at = new Date(clock()).toISOString();
        record.restored_by = ctx.actorId;
      }
      return { counts: loaded.manifest.counts };
    });
    send(200, {
      restored: true,
      backup_id: backupId,
      counts: restored.counts,
      notice: '仅恢复本租户数据；其他租户记录未被覆盖',
    });
  }

  function resolveSpecRecord(data, projectId, rawVersion) {
    const version = rawVersion === undefined || rawVersion === null || rawVersion === '' ? null : Number(rawVersion);
    if (version !== null && (!Number.isInteger(version) || version < 1)) {
      throw new ApiError(422, 'INVALID_SPEC_VERSION', 'spec 版本无效');
    }
    const candidates = Object.values(data.specs ?? {})
      .filter(item => item.project_id === projectId)
      .sort((left, right) => left.version - right.version);
    const spec = version === null ? candidates[candidates.length - 1] : candidates.find(item => item.version === version);
    if (!spec) throw new ApiError(404, 'NOT_FOUND', '未找到该版本的冻结生产配置');
    return spec;
  }

  function findProject(data, ctx, projectId) {
    const project = data.projects[projectId];
    if (!project || project.tenant_id !== ctx.tenantId) {
      throw new ApiError(404, 'NOT_FOUND', '项目不存在');
    }
    return project;
  }
}

function latestTruth(data, projectId) {
  let latest = null;
  for (const item of Object.values(data.truth_versions)) {
    if (item.project_id !== projectId) continue;
    if (!latest || item.version > latest.version) latest = item;
  }
  return latest;
}

function latestBrandKitVersion(data, kitId) {
  let latest = null;
  for (const item of Object.values(data.brand_kit_versions)) {
    if (item.brand_kit_id !== kitId) continue;
    if (!latest || item.version > latest.version) latest = item;
  }
  return latest;
}

function latestSpec(data, projectId) {
  let latest = null;
  for (const item of Object.values(data.specs)) {
    if (item.project_id !== projectId) continue;
    if (!latest || item.version > latest.version) latest = item;
  }
  return latest;
}

/** 交付清单变化摘要：用于提示"改了清单要重新报价"（FR-013）。 */
function diffDeliverables(previous, next) {
  const changes = [];
  const before = new Map(previous.map(item => [item.id, item]));
  const after = new Map(next.map(item => [item.id, item]));
  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old) { changes.push({ deliverable_id: id, change: 'added', label: item.label }); continue; }
    if (old.required !== item.required) changes.push({ deliverable_id: id, change: 'required_changed', label: item.label });
    if (old.ratio !== item.ratio || old.width !== item.width || old.height !== item.height) {
      changes.push({ deliverable_id: id, change: 'size_changed', label: item.label, from: `${old.width}×${old.height} ${old.ratio}`, to: `${item.width}×${item.height} ${item.ratio}` });
    }
    if (JSON.stringify(old.text_blocks) !== JSON.stringify(item.text_blocks)) {
      changes.push({ deliverable_id: id, change: 'text_blocks_changed', label: item.label });
    }
  }
  for (const [id, item] of before) {
    if (!after.has(id)) changes.push({ deliverable_id: id, change: 'removed', label: item.label });
  }
  return changes;
}

function serializeBrandKit(kit) {
  return {
    id: kit.id,
    tenant_id: kit.tenant_id,
    name: kit.name,
    head_version: kit.head_version,
    created_at: kit.created_at,
    updated_at: kit.updated_at,
    created_by: kit.created_by,
  };
}

function serializeProject(project) {
  return {
    id: project.id,
    tenant_id: project.tenant_id,
    name: project.name,
    sku: project.sku,
    category: project.category,
    platform: project.platform,
    status: project.status,
    truth_head_version: project.truth_head_version,
    spec_head_version: project.spec_head_version ?? 0,
    confirmation_status: project.confirmation_status ?? null,
    created_at: project.created_at,
    updated_at: project.updated_at,
    created_by: project.created_by,
  };
}

function serializeAsset(asset, projectId) {
  return {
    id: asset.id,
    tenant_id: asset.tenant_id,
    project_id: asset.project_id,
    filename: asset.filename,
    role: asset.role,
    role_label: ASSET_ROLES[asset.role]?.label ?? asset.role,
    role_status: asset.role_status,
    mime: asset.mime,
    ext: asset.ext,
    size_bytes: asset.size_bytes,
    sha256: asset.sha256,
    content_hash: asset.content_hash,
    width: asset.width,
    height: asset.height,
    warnings: asset.warnings,
    source: asset.source,
    // R04：卖家确认的商品矩形（归一化坐标），仅用于生成主体掩码，不改动原始像素
    subject_box: asset.subject_box ?? null,
    created_at: asset.created_at,
    created_by: asset.created_by,
    superseded_by: asset.superseded_by,
    content_url: `/api/projects/${projectId}/assets/${asset.id}/content`,
  };
}

function requireMethod(method, allowed) {
  if (!allowed.includes(method)) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', `该接口仅支持 ${allowed.join(' / ')}`, undefined, { allow: allowed.join(', ') });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    req.on('data', chunk => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return finish(reject, new ApiError(413, 'PAYLOAD_TOO_LARGE', `请求内容超过上限 ${limit} 字节`));
      finish(resolve, Buffer.concat(chunks));
    });
    req.on('error', () => finish(reject, new ApiError(400, 'INVALID_BODY', '请求体读取失败')));
    req.on('aborted', () => finish(reject, new ApiError(400, 'INVALID_BODY', '请求被中断')));
  });
}

async function readJson(req, limit = LIMITS.maxJsonBytes) {
  const buffer = await readBody(req, limit);
  if (buffer.length === 0) throw new ApiError(400, 'INVALID_BODY', '请求体不能为空');
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
}
