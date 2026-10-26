import { randomBytes } from 'node:crypto';
import { ApiError, toApiError } from './errors.mjs';
import { IMAGE_TYPES, inspectImage } from './images.mjs';
import {
  ASSET_ROLES, LIMITS, activeAssets, computeReadiness, sha256,
  truthContentHash, validateFilename, validateProjectInput, validateRole, validateTruthInput,
} from './domain.mjs';

const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;
const now = () => new Date().toISOString();

/**
 * M03 项目、素材与商品事实 API。
 * 约束：
 * - 所有查询强制带租户条件；跨租户对象一律按不存在处理，避免泄漏对象是否存在。
 * - 事实版本只追加，不原地覆盖；写入用 base_version 乐观锁。
 * - /api/runs、/api/quotes 属 M05，明确返回 501，不假装已实现。
 */
export function createApi({
  store,
  allowedTenants = ['tenant_demo'],
  defaultTenant = 'tenant_demo',
  defaultActor = 'demo_operator',
  maxUploadBytes = LIMITS.maxBytes,
} = {}) {
  if (!store) throw new Error('API 缺少存储实例');
  if (!Array.isArray(allowedTenants) || allowedTenants.length === 0) throw new Error('API 租户配置无效');

  return async function handleApi(req, res, route, send) {
    try {
      await dispatch(req, route, send);
    } catch (error) {
      const failure = toApiError(error);
      if (res.headersSent) { res.destroy(); return; }
      if (failure.allow) res.setHeader('Allow', failure.allow);
      const body = { error: failure.code, message: failure.message };
      if (failure.details !== undefined) body.details = failure.details;
      send(failure.status, body);
    }
  };

  async function dispatch(req, route, send) {
    const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
    const rest = route.split('/').filter(part => part !== '').slice(1);
    const method = req.method;
    const ctx = resolveContext(req);
    if (rest.length === 0) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    const [resource, projectId, section, third] = rest;

    if (resource === 'runs' || resource === 'quotes') {
      throw new ApiError(501, 'NOT_IMPLEMENTED', '任务、报价与事件接口将在 M05 接入，M03 不提供');
    }
    if (resource === 'tenant' && rest.length === 1) {
      requireMethod(method, ['GET', 'HEAD']);
      return send(200, { tenant_id: ctx.tenantId, actor_id: ctx.actorId, module: 'M03' });
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
    if (rest.length === 3 && section === 'readiness') {
      requireMethod(method, ['GET', 'HEAD']);
      return getReadiness(ctx, projectId, send);
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

  function resolveContext(req) {
    const tenantHeader = req.headers['x-tenant-id'];
    const tenantId = tenantHeader === undefined ? defaultTenant : String(tenantHeader).trim();
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
