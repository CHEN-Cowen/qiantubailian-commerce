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
import {
  ASSET_ROLES, LIMITS, activeAssets, computeReadiness, sha256,
  truthContentHash, validateFilename, validateProjectInput, validateRole, validateTruthInput,
} from './domain.mjs';
import { getTemplate, listChannelRules, listTemplates, matchChannelRule } from './catalog.mjs';
import {
  assembleSpec, brandKitContentHash, computeSpecValidity, specContentHash, validateBrandKitInput,
} from './spec.mjs';
import { PRICE_VERSION, quoteFromSpec, quoteMatchesSpec, quoteStatus } from './pricing.mjs';
import { listCommercePlans as _listCommercePlans, commercePlanById as _commercePlanById, planSnapshot } from './plans.mjs';
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
import { appendEntry, balanceOf, grantExperienceCredits, ledgerEntries, sweepExpiredLots } from './credits.mjs';
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
  const jobs = createJobs({
    store, provider, clock, initialCredits, attemptTimeoutMs, maxConcurrency, tickMs, revisionMaxRounds,
    providerMaxConcurrency, tenantMaxConcurrency, unknownReconcileMs,
    // R04：注入 OCR 时才会对成品做真实文字核对，否则文字项保持 unknown
    ocr: injectedOcr ?? createOcrFromEnv(process.env),
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
  publish.provider = { ...providerInfo, capabilities: () => provider.capabilities() };
  publish.credits = { balanceOf: tenantId => store.read(data => balanceOf(data, tenantId, { initialCredits })) };
  // 暴露 drain：关闭服务时先排空写队列，再让调用方清理数据目录
  publish.drain = () => (typeof store.drain === 'function' ? store.drain() : Promise.resolve());
  const backupDirOf = backupId => path.join(store.dir, 'backups', backupId);
  // R01：状态变更方法集合。createApi 在下方提前 return publish，所有 const 声明必须在此之前，
  // 否则被提升的函数访问时会处于暂时性死区（ReferenceError）。
  const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
      if (rest.length === 1 && method === 'POST') return createRun(ctx, req, send);
      if (rest.length === 1) { requireMethod(method, ['GET', 'HEAD', 'POST']); return listRunsRoute(ctx, query, send); }
      if (rest.length === 2) { requireMethod(method, ['GET', 'HEAD']); return jobs.getRun(ctx, rest[1]).then(result => send(200, result)); }
      if (rest.length === 5 && rest[2] === 'versions' && rest[4] === 'activate') {
        requireMethod(method, ['POST']);
        return activateVersionRoute(ctx, rest[1], rest[3], send);
      }
      if (rest.length !== 3) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
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
      if (rest.length === 2 && rest[1] === 'orders') {
        if (method === 'POST') return createBillingOrderRoute(ctx, req, send);
        requireMethod(method, ['GET', 'HEAD', 'POST']);
        return listBillingOrdersRoute(ctx, send);
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
  function actionForRoute([resource, second, third, fourth], method) {
    const write = STATE_CHANGING.has(method);
    switch (resource) {
      case 'credits': return 'credits:read';
      case 'quotes': return write ? 'quote:create' : 'quote:read';
      case 'runs': {
        if (second === undefined) return write ? 'run:create' : 'run:read';
        if (third === 'cancel') return 'run:cancel';
        if (third === 'budget-confirmation') return 'run:budget';
        if (third === 'reconcile') return 'run:reconcile';
        if (third === 'exports' && write) return 'export:create';
        if (third === 'versions' && fourth === 'activate' && write) return 'version:activate';
        return 'run:read';
      }
      case 'exports': return second !== undefined && third === 'download' ? 'export:download' : 'export:read';
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
      case 'projects': {
        if (second === undefined) return write ? 'project:create' : 'project:read';
        if (third === 'assets') return write ? 'asset:write' : 'project:read';
        if (third === 'truth-versions') return write ? 'truth:write' : 'project:read';
        if (third === 'specs') return write ? 'spec:write' : 'project:read';
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
    const mask = createSubjectMask({ bytes, mime: asset.mime, box });
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

  async function createTruthVersion(ctx, req, projectId, send) {
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const project = findProject(data, ctx, projectId);
      const assets = Object.values(data.assets)
        .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
      const payload = validateTruthInput(body, { project, assets });
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

  async function createBrandKit(ctx, req, send) {
    const payload = validateBrandKitInput(await readJson(req));
    const result = await store.mutate(data => {
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

  /** 组装 draft 并做齐全部校验；persist 区分预览与冻结。 */
  function buildSpecDraft(data, ctx, projectId, body, { persist }) {
    const project = findProject(data, ctx, projectId);
    const assets = Object.values(data.assets)
      .filter(asset => asset.project_id === project.id && asset.tenant_id === ctx.tenantId);
    const truth = latestTruth(data, project.id);
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
    const payload = assembleSpec({ project, truth, template, brandKit, channel, resolutions, at: clock() });

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
      const quote = quoteFromSpec({ spec, at: clock() });
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
        quote = quoteFromSpec({ spec, at: clock() });
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
          const record = { ...quoteFromSpec({ spec: context.spec, at: clock() }), tenant_id: ctx.tenantId, project_id: context.project.id };
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

  async function createBillingOrderRoute(ctx, req, send) {
    await requireAction(ctx, 'billing:manage');
    const body = await readJson(req);
    const capability = evaluatePaymentCapability({ provider: paymentProvider });
    if (!capability.can_checkout) {
      throw new ApiError(409, capability.blockers[0]?.code ?? 'PAYMENT_UNAVAILABLE',
        capability.blockers[0]?.message ?? '当前不具备下单条件', { payment: capability });
    }
    const plan = resolvePlanById(String(body.plan_id ?? ''));
    if (!plan) throw new ApiError(422, 'PLAN_UNKNOWN', '套餐不存在');
    const order = await store.mutate(data => {
      const item = {
        id: newId('ord'),
        tenant_id: ctx.tenantId,
        plan_id: plan.id,
        plan_snapshot: planSnapshot(plan),
        credits: plan.credits,
        seats: plan.seats ?? 1,
        status: 'pending_demo_settlement',
        real_money: false,
        simulated: true,
        settlement: 'internal_demo_credits',
        notice: plan.terms ?? plan.note ?? '演示订单：不扣真实货币、不开具发票、不代表可计费权益',
        created_by: ctx.actorId,
        created_at: new Date(clock()).toISOString(),
      };
      data.billing_orders[item.id] = item;
      const event = {
        id: newId('pay'),
        tenant_id: ctx.tenantId,
        order_id: item.id,
        type: 'demo_order_created',
        amount_cents: 0,
        currency: plan.currency,
        actor_id: ctx.actorId,
        created_at: item.created_at,
      };
      data.payment_events[event.id] = event;
      return item;
    });
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
    if (!capability.can_settle) {
      throw new ApiError(409, capability.blockers[0]?.code ?? 'PAYMENT_SETTLE_UNSUPPORTED',
        capability.blockers[0]?.message ?? '当前不具备结算条件', { payment: capability });
    }
    const result = await store.mutate(data => {
      const order = data.billing_orders?.[orderId] ?? null;
      if (!order || order.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '订单不存在');
      if (order.status !== 'pending_demo_settlement') {
        throw new ApiError(409, 'ORDER_STATE_INVALID', `订单当前状态为 ${order.status}，不能重复结算`);
      }
      const entry = appendEntry(data, {
        type: 'grant', amount: order.credits, tenantId: ctx.tenantId,
        uniqueOperationKey: `billing-order:${order.id}`,
        memo: '演示套餐开通额度（内部演示，不代表真实权益）',
        actor: ctx.actorId, initialCredits, at: clock(),
      });
      order.status = 'settled_demo';
      order.settled_at = new Date(clock()).toISOString();
      order.settled_by = ctx.actorId;
      const event = {
        id: newId('pay'), tenant_id: ctx.tenantId, order_id: order.id,
        type: 'demo_order_settled', amount_cents: 0, currency: order.plan_snapshot.currency,
        actor_id: ctx.actorId, created_at: order.settled_at,
      };
      data.payment_events[event.id] = event;
      return { order, balance: entry.balance, applied: entry.applied };
    });
    send(200, {
      ...result,
      notice: '演示额度已到账；未发生真实收款，不能作为生产计费依据',
    });
  }

  async function refundBillingOrderRoute(ctx, orderId, req, send) {
    await requireAction(ctx, 'billing:manage');
    await readJson(req).catch(() => ({}));
    const capability = evaluatePaymentCapability({ provider: paymentProvider });
    if (!capability.can_refund) {
      throw new ApiError(409, capability.blockers[0]?.code ?? 'PAYMENT_REFUND_UNSUPPORTED',
        capability.blockers[0]?.message ?? '当前不具备退款条件', { payment: capability });
    }
    const order = await store.read(data => {
      const item = data.billing_orders?.[orderId] ?? null;
      if (!item || item.tenant_id !== ctx.tenantId) throw new ApiError(404, 'NOT_FOUND', '订单不存在');
      return item;
    });
    if (order.real_money !== true) {
      throw new ApiError(409, 'ORDER_NOT_REAL_MONEY', '演示订单不涉及真实收款，不能发起真实退款');
    }
    throw new ApiError(409, 'REFUND_UNIMPLEMENTED', '真实支付通道尚未接入，未执行退款');
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
