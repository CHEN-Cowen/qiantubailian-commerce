/**
 * P1 商品保真上下文：素材可用性、角色/事实/品牌/SKU 绑定与合成保真度。
 *
 * 这里全部是纯函数，不读文件、不调模型、不改写已有事实与素材：
 * - inspectAssetUsability：可解码、尺寸、最短边、掩码来源，给出可执行的补拍提示；
 * - auditProductContext：角色是否足够支撑生产、事实是否绑在生效素材上；
 * - buildContextBinding：把项目/SKU/事实/素材/品牌/规格冻成一个稳定 hash；
 * - auditCompositeFidelity：边缘、阴影、透视一律保持"待复核"，不冒充已验证。
 *
 * 上游（api / jobs / m07）复用本模块，不各自重写一套判断。
 */
import { decodePng } from './m06.mjs';
import { readImageSize } from './images.mjs';
import { ASSET_ROLES, LIMITS, activeAssets, contentHash, sha256 } from './domain.mjs';

export const CONTEXT_VERSION = 'product-context.1';

/** 关键事实里出现这些词，说明需要包装素材来核对包装文字与版式。 */
const PACKAGING_FACT_PATTERN = /包装|外盒|彩盒|盒面|瓶身|罐身|标签|净含量|package|packaging/i;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function issue(code, message, { severity = 'warning', assetId = null, details = null } = {}) {
  return { code, message, severity, asset_id: assetId, details };
}

function retake(code, message, { role = null, assetId = null } = {}) {
  return { code, role, asset_id: assetId, message };
}

/**
 * 单张素材的可用性。
 *
 * bytes 可选：给了就做真实解码（PNG 走 decodePng，JPEG/WebP 只读头部尺寸）；
 * 没给（如项目详情页）就按上传时已校验的元数据判断，并把解码状态标为 unverified，
 * 不用"已解码"冒充。
 */
export function inspectAssetUsability({ asset, bytes = null } = {}) {
  if (!isPlainObject(asset)) throw new TypeError('inspectAssetUsability 需要素材记录');
  const role = asset.role ?? null;
  const issues = [];
  const retakeHints = [];
  const checks = {
    decodable: 'unverified',
    dimensions_known: false,
    short_side: null,
    short_side_ok: false,
    mask_source: null,
  };

  const width = Number.isFinite(asset.width) && asset.width > 0 ? asset.width : null;
  const height = Number.isFinite(asset.height) && asset.height > 0 ? asset.height : null;

  if (bytes) {
    const mime = asset.mime ?? null;
    let decoded = null;
    if (mime === 'image/png') decoded = decodePng(bytes);
    else if (mime === 'image/jpeg' || mime === 'image/webp') decoded = readImageSize(bytes, mime);
    if (decoded) {
      checks.decodable = 'verified';
      checks.dimensions_known = true;
      checks.short_side = Math.min(decoded.width, decoded.height);
    } else {
      checks.decodable = 'invalid';
      issues.push(issue('ASSET_UNDECODABLE', '素材文件无法解码，不能用于生成或作为核对依据', {
        severity: 'blocker', assetId: asset.id ?? null,
      }));
      retakeHints.push(retake('RESHOOT_UNDECODABLE', '请重新导出并上传可正常打开的原始图片', {
        role, assetId: asset.id ?? null,
      }));
    }
  } else if (width && height) {
    checks.dimensions_known = true;
    checks.short_side = Math.min(width, height);
  } else {
    issues.push(issue('ASSET_DIMENSIONS_UNKNOWN', '素材尺寸未知，无法判断是否达到清晰度要求', {
      severity: 'warning', assetId: asset.id ?? null,
    }));
    retakeHints.push(retake('RESHOOT_DIMENSIONS_UNKNOWN', '请重新上传可读出尺寸的原图', {
      role, assetId: asset.id ?? null,
    }));
  }

  if (checks.short_side !== null) {
    checks.short_side_ok = checks.short_side >= LIMITS.minShortSide;
    if (!checks.short_side_ok) {
      issues.push(issue('LOW_RESOLUTION', `最短边 ${checks.short_side}px 低于建议 ${LIMITS.minShortSide}px，主体细节可能被压缩`, {
        severity: 'warning', assetId: asset.id ?? null,
      }));
      retakeHints.push(retake('RESHOOT_LOW_RESOLUTION', `请补拍最短边 ≥ ${LIMITS.minShortSide}px 的清晰原图`, {
        role, assetId: asset.id ?? null,
      }));
    }
  }

  if (role === 'subject') {
    if (asset.mime === 'image/png' && checks.decodable !== 'invalid') {
      checks.mask_source = 'png_auto';
    } else if (asset.subject_box) {
      checks.mask_source = 'manual_box';
    } else {
      checks.mask_source = 'provider_mask_required';
      issues.push(issue('SUBJECT_BOX_REQUIRED', '非 PNG 主体未标注商品矩形，本地无法生成区域掩码，只能依赖供应商掩码能力', {
        severity: 'warning', assetId: asset.id ?? null,
      }));
      retakeHints.push(retake('RESHOOT_SUBJECT_BOX', '请补一张透明背景 PNG 主体图，或标注商品矩形后重新生成', {
        role, assetId: asset.id ?? null,
      }));
    }
  }

  const blocked = issues.some(item => item.severity === 'blocker');
  return {
    asset_id: asset.id ?? null,
    role,
    filename: asset.filename ?? null,
    usable: !blocked,
    checks,
    issues,
    retake_hints: retakeHints,
  };
}

function factSourceRole(assets, sourceAssetId) {
  const source = assets.find(item => item.id === sourceAssetId);
  return source ? source.role : null;
}

/**
 * 项目级上下文审计：角色是否撑得起生产，关键事实是否绑在生效素材上。
 * 返回 can_bind 只代表"这份上下文足够冻结"，不代表质量已验收。
 */
export function auditProductContext({ project, assets = [], truth = null, usability = [] } = {}) {
  if (!isPlainObject(project)) throw new TypeError('auditProductContext 需要项目记录');
  const active = activeAssets(assets);
  const blockers = [];
  const warnings = [];
  const retakeRequests = [];

  const roles = Object.fromEntries(Object.keys(ASSET_ROLES).map(role => [role, 0]));
  for (const asset of active) roles[asset.role] = (roles[asset.role] ?? 0) + 1;

  for (const item of usability) {
    for (const entry of item.issues ?? []) {
      if (entry.severity === 'blocker') blockers.push(entry);
      else warnings.push(entry);
    }
    for (const hint of item.retake_hints ?? []) {
      // 可解码失败与低分辨率都要重拍；SUBJECT_BOX_REQUIRED 属于操作提示，保留但去重
      retakeRequests.push(hint);
    }
  }

  if (active.length === 0) {
    blockers.push(issue('NO_ACTIVE_ASSETS', '项目没有生效素材，无法冻结商品上下文', { severity: 'blocker' }));
    retakeRequests.push(retake('RESHOOT_MISSING_SUBJECT', '请至少上传 1 张商品主体实拍图', { role: 'subject' }));
  } else if (roles.subject === 0) {
    const onlyStyle = active.every(asset => asset.role === 'style');
    blockers.push(issue(
      'STYLE_CANNOT_BE_SUBJECT',
      onlyStyle
        ? '当前只有风格参考图。风格图不能冒充商品主体，无法锁定商品形状、文字与颜色'
        : '缺少「主体」职责素材，无法锁定商品形态',
      { severity: 'blocker', details: { style_assets: active.filter(asset => asset.role === 'style').map(asset => asset.id) } },
    ));
    retakeRequests.push(retake('RESHOOT_MISSING_SUBJECT', '请补拍商品主体正面清晰图并标记为「主体」', { role: 'subject' }));
  }

  const criticalPackagingFacts = truth?.facts?.filter(fact => fact.critical === true
    && PACKAGING_FACT_PATTERN.test(`${fact.key} ${fact.unit ?? ''}`)) ?? [];
  if (criticalPackagingFacts.length > 0 && roles.packaging === 0) {
    blockers.push(issue(
      'PACKAGING_FACT_WITHOUT_ASSET',
      '关键事实涉及包装文字/版式，但没有「包装」素材，无法核对包装是否被改写',
      { severity: 'blocker', details: { keys: criticalPackagingFacts.map(fact => fact.key) } },
    ));
    retakeRequests.push(retake('RESHOOT_PACKAGING_FRONT', '请补拍包装正面（含文字、Logo 与净含量）并标记为「包装」', { role: 'packaging' }));
  }

  if (truth) {
    if (typeof truth.sku === 'string' && project.sku
      && truth.sku.toLowerCase() !== project.sku.toLowerCase()) {
      blockers.push(issue('SKU_MISMATCH', `事实版本 SKU「${truth.sku}」与项目 SKU「${project.sku}」不一致`, {
        severity: 'blocker',
      }));
    }
    const activeIds = new Set(active.map(asset => asset.id));
    for (const fact of truth.facts ?? []) {
      if (!fact.source_asset_id) continue;
      const role = factSourceRole(assets, fact.source_asset_id);
      if (role === 'style') {
        blockers.push(issue('STYLE_NOT_FACT_SOURCE', `事实「${fact.key}」引用了风格图，风格图不能作为商品事实来源`, {
          severity: 'blocker', assetId: fact.source_asset_id,
        }));
      } else if (!activeIds.has(fact.source_asset_id)) {
        blockers.push(issue('FACT_SOURCE_NOT_ACTIVE', `事实「${fact.key}」引用的素材已被替换或停用，需要基于新素材重新确认`, {
          severity: 'blocker', assetId: fact.source_asset_id,
        }));
      }
    }
  } else {
    warnings.push(issue('TRUTH_NOT_BOUND', '尚未提交商品事实版本，绑定里不会有事实哈希', {
      severity: 'warning',
    }));
  }

  const hashes = new Map();
  for (const asset of active) {
    if (!asset.sha256) continue;
    const previous = hashes.get(asset.sha256);
    if (previous) {
      warnings.push(issue('DUPLICATE_ASSET_CONTENT', `「${asset.filename}」与「${previous.filename}」内容完全相同，请确认是否重复上传`, {
        severity: 'warning', assetId: asset.id,
      }));
      retakeRequests.push(retake('RESHOOT_DUPLICATE', `「${asset.filename}」与已有素材内容相同，请删除其一或补拍不同角度`, {
        role: asset.role, assetId: asset.id,
      }));
    } else {
      hashes.set(asset.sha256, asset);
    }
  }

  if (roles.packaging === 0 && criticalPackagingFacts.length === 0 && active.length > 0) {
    warnings.push(issue('PACKAGING_ASSET_MISSING', '没有包装素材，包装上的文字与 Logo 无法被核对', {
      severity: 'warning',
    }));
  }

  return {
    project_id: project.id ?? null,
    sku: project.sku ?? null,
    can_bind: blockers.length === 0,
    roles,
    blocker_count: blockers.length,
    blockers,
    warnings,
    retake_requests: dedupeRetakes(retakeRequests),
  };
}

function dedupeRetakes(list) {
  const seen = new Set();
  return list.filter(item => {
    const key = `${item.code}:${item.asset_id ?? ''}:${item.role ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 冻结上下文绑定。context_hash 覆盖项目、SKU、事实版本、生效素材版本、
 * 品牌版本与规格版本；任一素材被替换都会得到新 hash，旧报告随即失效。
 */
export function buildContextBinding({ project, assets = [], truth = null, brandKitVersion = null, spec = null } = {}) {
  if (!isPlainObject(project)) throw new TypeError('buildContextBinding 需要项目记录');
  const active = [...activeAssets(assets)].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const payload = {
    project_id: project.id ?? null,
    sku: project.sku ?? null,
    truth: truth ? {
      version: truth.version ?? null,
      content_hash: truth.content_hash ?? null,
      confirmation_status: truth.confirmation_status ?? null,
    } : null,
    assets: active.map(asset => ({
      asset_id: asset.id,
      role: asset.role,
      sha256: asset.sha256,
      width: asset.width ?? null,
      height: asset.height ?? null,
      mime: asset.mime ?? null,
      subject_box: asset.subject_box ?? null,
    })),
    brand: brandKitVersion ? {
      brand_kit_id: brandKitVersion.brand_kit_id ?? null,
      version: brandKitVersion.version ?? null,
      content_hash: brandKitVersion.content_hash ?? null,
    } : null,
    spec: spec ? {
      version: spec.version ?? null,
      content_hash: spec.content_hash ?? null,
    } : null,
  };
  const hash = `ctx_${contentHash(payload)}`;
  return {
    version: CONTEXT_VERSION,
    ...payload,
    context_hash: hash,
    // 同一份上下文可复现：便于测试与后续报告绑定核对
    hash_algorithm: 'sha256(canonical(json))',
    asset_count: active.length,
  };
}

/**
 * 本地合成只保证掩码内像素逐像素一致；边缘融合、阴影与透视没有自动验收依据。
 * 因此三项固定为 unverified，必须人工对照，绝不写成 pass。
 */
export function auditCompositeFidelity({ composite = null } = {}) {
  const applied = composite?.applied === true;
  const items = [
    { code: 'EDGE_FIDELITY', label: '边缘融合', status: applied ? 'unverified' : 'not_applicable' },
    { code: 'SHADOW_FIDELITY', label: '阴影自然度', status: applied ? 'unverified' : 'not_applicable' },
    { code: 'PERSPECTIVE_FIDELITY', label: '透视一致性', status: applied ? 'unverified' : 'not_applicable' },
  ];
  return {
    status: applied ? 'unverified' : 'not_applicable',
    needs_review: applied,
    items,
    note: applied
      ? '本地合成只保证商品像素未被改写，边缘、阴影与透视没有机器验收依据，需人工对照主体原图'
      : '未应用本地合成，不适用合成保真度检查',
    review_basis: applied ? '人工对照生成图与主体原图：轮廓是否有白边/锯齿、阴影方向是否一致、商品透视是否与场景匹配' : null,
    composite_sha256: composite?.sha256 ?? null,
  };
}

/** 素材内容指纹：便于在报告里简短引用一张素材，而不必展开整条记录。 */
export const assetFingerprint = asset => (asset?.sha256 ? `asset:${asset.sha256.slice(0, 16)}` : null);
export const fingerprintOf = value => sha256(JSON.stringify(value)).slice(0, 16);
