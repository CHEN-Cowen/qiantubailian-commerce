import { randomBytes, createHash } from 'node:crypto';
import { ApiError, toApiError } from './errors.mjs';
import { IMAGE_TYPES, inspectImage } from './images.mjs';
import {
  ASSET_ROLES, LIMITS, activeAssets, computeReadiness, sha256,
  truthContentHash, validateFilename, validateProjectInput, validateRole, validateTruthInput,
} from './domain.mjs';
import { getTemplate, listChannelRules, listTemplates, matchChannelRule } from './catalog.mjs';
import {
  assembleSpec, brandKitContentHash, computeSpecValidity, specContentHash, validateBrandKitInput,
} from './spec.mjs';
import { PRICE_VERSION, quoteFromSpec, quoteMatchesSpec, quoteStatus } from './pricing.mjs';
import { balanceOf, ledgerEntries } from './credits.mjs';
import { RETRYABLE_CODES } from './provider.mjs';
import { createProviderFromEnv } from './providers/index.mjs';
import { createJobs, TERMINAL_STATES } from './jobs.mjs';
import {
  MAX_CANARY_PERCENT, MIN_CANARY_PERCENT, DEFAULT_CANARY_THRESHOLDS, summarizeDataset,
  summarizeEvaluation, evaluateCanaryHealth, planCanary,
} from './m09.mjs';

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
  // M06：Provider 可注入（测试或宿主自建 Adapter）；不注入时按环境变量选择，默认 mock
  provider: injectedProvider = null,
  providerOptions = {},
} = {}) {
  if (!store) throw new Error('API 缺少存储实例');
  if (!Array.isArray(allowedTenants) || allowedTenants.length === 0) throw new Error('API 租户配置无效');
  if (!Number.isInteger(initialCredits) || initialCredits < 0) throw new Error('初始额度配置无效');
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
  });

  publish.jobs = jobs;
  publish.provider = { ...providerInfo, capabilities: () => provider.capabilities() };
  publish.credits = { balanceOf: tenantId => store.read(data => balanceOf(data, tenantId, { initialCredits })) };
  // 暴露 drain：关闭服务时先排空写队列，再让调用方清理数据目录
  publish.drain = () => (typeof store.drain === 'function' ? store.drain() : Promise.resolve());
  return publish;

  async function publish(req, res, route, send) {
    try {
      await dispatch(req, res, route, send);
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
      send(failure.status, body);
    }
  }

  async function dispatch(req, res, route, send) {
    const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
    const rest = route.split('/').filter(part => part !== '').slice(1);
    const method = req.method;
    // SSE 订阅走 EventSource，浏览器无法带自定义头，因此允许用 query 传租户
    const isEventStream = rest.length === 3 && rest[0] === 'runs' && rest[2] === 'events';
    const ctx = resolveContext(req, { allowQueryTenant: isEventStream, query });
    if (rest.length === 0) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    const [resource, projectId, section, third] = rest;

    if (resource === 'tenant' && rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      return send(200, { tenant_id: ctx.tenantId, actor_id: ctx.actorId, module: 'M09' });
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
      if (rest.length === 1) { requireMethod(method, ['GET', 'HEAD', 'POST']); return listRunsRoute(ctx, send); }
      if (rest.length === 2) { requireMethod(method, ['GET', 'HEAD']); return jobs.getRun(ctx, rest[1]).then(result => send(200, result)); }
      if (rest.length === 5 && rest[2] === 'versions' && rest[4] === 'activate') {
        requireMethod(method, ['POST']);
        return activateVersionRoute(ctx, rest[1], rest[3], send);
      }
      if (rest.length !== 3) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
      if (rest[2] === 'cancel') { requireMethod(method, ['POST']); return cancelRunRoute(ctx, req, rest[1], send); }
      if (rest[2] === 'budget-confirmation') { requireMethod(method, ['POST']); return confirmBudgetRoute(ctx, req, rest[1], send); }
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
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }

  function resolveContext(req, { allowQueryTenant = false, query = null } = {}) {
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
    return { tenantId, actorId };
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
  function getCredits(ctx, send) {
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

  function listRunsRoute(ctx, send) {
    return jobs.listRuns(ctx, null).then(result => send(200, result));
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
