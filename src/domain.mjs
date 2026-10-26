import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';

/**
 * M03 领域规则：Project / SourceAsset / ProductTruth 的字段校验与可生产闸口。
 * 所有规则为纯函数，便于测试；时间戳、ID 由调用方（服务端）写入。
 */
export const LIMITS = Object.freeze({
  maxAssetsPerProject: 6,
  maxBytes: 20 * 1024 * 1024,
  minShortSide: 1024,
  maxFacts: 200,
  maxJsonBytes: 256 * 1024,
});

export const ASSET_ROLES = Object.freeze({
  subject: Object.freeze({ label: '主体', exclusive: true }),
  packaging: Object.freeze({ label: '包装', exclusive: true }),
  detail: Object.freeze({ label: '细节', exclusive: false }),
  style: Object.freeze({ label: '风格', exclusive: false }),
});

/** 单一槽位职责：同一项目只能有一张生效素材，第二张必须显式替换。 */
export const EXCLUSIVE_ROLES = Object.freeze(Object.keys(ASSET_ROLES).filter(role => ASSET_ROLES[role].exclusive));

export const PROTECTION_TYPES = Object.freeze(['shape', 'text', 'logo', 'color']);
export const ALLOWED_TRANSFORMS = Object.freeze(['translate', 'scale', 'rotate', 'perspective', 'lighting', 'shadow']);
export const NORMALIZATION_RULES = Object.freeze(['none', 'trim', 'collapse_spaces', 'fullwidth_to_halfwidth']);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 稳定序列化，用于内容哈希：字段顺序不影响结果。 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const contentHash = value => sha256(canonical(value));

function text(value, field, { min = 1, max = 200, pattern } = {}) {
  if (typeof value !== 'string') throw new ApiError(422, 'INVALID_FIELD', `${field} 必须为字符串`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ApiError(422, 'INVALID_FIELD', `${field} 不能为空`);
  if (trimmed.length > max) throw new ApiError(422, 'INVALID_FIELD', `${field} 长度不能超过 ${max} 个字符`);
  if (pattern && !pattern.test(trimmed)) throw new ApiError(422, 'INVALID_FIELD', `${field} 格式不符合要求`);
  return trimmed;
}

function optionalText(value, field, options) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, field, options);
}

export function validateProjectInput(body) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  return {
    name: text(body.name, 'name', { max: 80 }),
    sku: text(body.sku, 'sku', { max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ }),
    category: text(body.category, 'category', { max: 40 }),
    platform: optionalText(body.platform, 'platform', { max: 40 }),
  };
}

export function validateRole(value) {
  const role = typeof value === 'string' ? value.trim() : '';
  if (!Object.hasOwn(ASSET_ROLES, role)) {
    throw new ApiError(422, 'INVALID_ROLE', `素材职责必须为 ${Object.keys(ASSET_ROLES).join(' / ')} 之一`);
  }
  return role;
}

export function validateFilename(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (!raw || raw.length > 200) throw new ApiError(422, 'INVALID_FILENAME', '文件名不能为空且不超过 200 个字符');
  if (/[\\/\u0000-\u001f\u007f]/.test(raw)) throw new ApiError(422, 'INVALID_FILENAME', '文件名不能包含路径分隔符或控制字符');
  return raw;
}

export function validateRegion(region, field) {
  if (region === undefined || region === null) return null;
  if (!isPlainObject(region)) throw new ApiError(422, 'INVALID_REGION', `${field} 必须为对象`);
  const unit = region.unit;
  if (!['normalized', 'pixel'].includes(unit)) {
    throw new ApiError(422, 'INVALID_REGION_UNIT', `${field}.unit 必须显式标注 normalized 或 pixel`);
  }
  const numbers = ['x', 'y', 'w', 'h'].map(key => {
    const value = region[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ApiError(422, 'INVALID_REGION', `${field}.${key} 必须为不小于 0 的数值`);
    }
    return value;
  });
  const [x, y, w, h] = numbers;
  if (w <= 0 || h <= 0) throw new ApiError(422, 'INVALID_REGION', `${field}.w 与 ${field}.h 必须大于 0`);
  if (unit === 'normalized') {
    if (x > 1 || y > 1 || x + w > 1.000001 || y + h > 1.000001) {
      throw new ApiError(422, 'INVALID_REGION', `${field} 归一化坐标必须落在 0—1 区间内`);
    }
    return { unit, x, y, w, h };
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) {
    throw new ApiError(422, 'INVALID_REGION', `${field} 像素坐标必须为整数`);
  }
  const imageWidth = region.image_width;
  const imageHeight = region.image_height;
  if (!Number.isInteger(imageWidth) || imageWidth <= 0 || !Number.isInteger(imageHeight) || imageHeight <= 0) {
    throw new ApiError(422, 'INVALID_REGION', `${field} 使用像素单位时必须同时标注原图 image_width 与 image_height`);
  }
  if (x + w > imageWidth || y + h > imageHeight) {
    throw new ApiError(422, 'INVALID_REGION', `${field} 超出原图范围`);
  }
  return { unit, x, y, w, h, image_width: imageWidth, image_height: imageHeight };
}

function validateFacts(input, assets) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ApiError(422, 'INVALID_FACTS', 'facts 必须为数组');
  if (input.length > LIMITS.maxFacts) throw new ApiError(422, 'INVALID_FACTS', `事实条目不能超过 ${LIMITS.maxFacts} 项`);
  const seen = new Set();
  return input.map((item, index) => {
    const field = `facts[${index}]`;
    if (!isPlainObject(item)) throw new ApiError(422, 'INVALID_FACTS', `${field} 必须为对象`);
    const key = text(item.key, `${field}.key`, { max: 60 });
    if (seen.has(key)) throw new ApiError(422, 'DUPLICATE_FACT_KEY', `事实键「${key}」重复`);
    seen.add(key);
    const rawValue = item.value;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
      throw new ApiError(422, 'INVALID_FACTS', `${field}.value 必须为字符串或数值`);
    }
    const value = String(rawValue).trim();
    if (!value) throw new ApiError(422, 'INVALID_FACTS', `${field}.value 不能为空，禁止留空代替未知规格`);
    if (value.length > 500) throw new ApiError(422, 'INVALID_FACTS', `${field}.value 长度不能超过 500 个字符`);
    let confidence = null;
    if (item.confidence !== undefined && item.confidence !== null) {
      if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        throw new ApiError(422, 'INVALID_FACTS', `${field}.confidence 必须为 0—1 之间的数值`);
      }
      confidence = item.confidence;
    }
    const critical = item.critical === true;
    const confirmed = item.confirmed === true;
    let sourceType = 'user_input';
    let sourceAssetId = null;
    if (item.source_asset_id !== undefined && item.source_asset_id !== null && item.source_asset_id !== '') {
      const asset = assets.find(candidate => candidate.id === item.source_asset_id);
      if (!asset) throw new ApiError(422, 'FACT_SOURCE_INVALID', `${field}.source_asset_id 不存在或不属于该项目`);
      if (asset.role === 'style') {
        throw new ApiError(422, 'STYLE_NOT_FACT_SOURCE', '风格图不作为商品事实来源，请选择主体、包装或细节素材');
      }
      if (asset.role_status !== 'active') {
        throw new ApiError(422, 'FACT_SOURCE_INVALID', `${field}.source_asset_id 指向的素材已被替换，不能作为事实来源`);
      }
      sourceType = 'asset';
      sourceAssetId = asset.id;
    } else if (item.source_type !== 'user_input') {
      throw new ApiError(422, 'FACT_SOURCE_REQUIRED', `${field} 必须标注来源素材，或显式声明 source_type 为 user_input`);
    }
    return {
      key,
      value,
      unit: optionalText(item.unit, `${field}.unit`, { max: 20 }),
      source_type: sourceType,
      source_asset_id: sourceAssetId,
      region: validateRegion(item.region, `${field}.region`),
      confidence,
      critical,
      confirmed,
      note: optionalText(item.note, `${field}.note`, { max: 300 }),
    };
  });
}

function validateImmutableRegions(input, assets) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ApiError(422, 'INVALID_IMMUTABLE_REGIONS', 'immutable_regions 必须为数组');
  return input.map((item, index) => {
    const field = `immutable_regions[${index}]`;
    if (!isPlainObject(item)) throw new ApiError(422, 'INVALID_IMMUTABLE_REGIONS', `${field} 必须为对象`);
    const asset = assets.find(candidate => candidate.id === item.asset_id);
    if (!asset) throw new ApiError(422, 'IMMUTABLE_REGION_INVALID', `${field}.asset_id 不存在或不属于该项目`);
    if (asset.role === 'style') throw new ApiError(422, 'IMMUTABLE_REGION_INVALID', '风格图不能作为不可变商品区域');
    if (!Array.isArray(item.allowed_transforms) || item.allowed_transforms.length === 0) {
      throw new ApiError(422, 'INVALID_IMMUTABLE_REGIONS', `${field}.allowed_transforms 至少需要一项允许变换`);
    }
    const invalidTransform = item.allowed_transforms.find(value => !ALLOWED_TRANSFORMS.includes(value));
    if (invalidTransform) throw new ApiError(422, 'INVALID_IMMUTABLE_REGIONS', `${field}.allowed_transforms 含未知变换：${invalidTransform}`);
    if (!PROTECTION_TYPES.includes(item.protection)) {
      throw new ApiError(422, 'INVALID_IMMUTABLE_REGIONS', `${field}.protection 必须为 ${PROTECTION_TYPES.join(' / ')} 之一`);
    }
    return {
      asset_id: asset.id,
      mask_id: text(item.mask_id, `${field}.mask_id`, { max: 80 }),
      protection: item.protection,
      allowed_transforms: [...new Set(item.allowed_transforms)],
      region: validateRegion(item.region, `${field}.region`),
    };
  });
}

function validateCriticalText(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ApiError(422, 'INVALID_CRITICAL_TEXT', 'critical_text 必须为数组');
  return input.map((item, index) => {
    const field = `critical_text[${index}]`;
    if (!isPlainObject(item)) throw new ApiError(422, 'INVALID_CRITICAL_TEXT', `${field} 必须为对象`);
    const normalization = item.normalization ?? 'trim';
    if (!NORMALIZATION_RULES.includes(normalization)) {
      throw new ApiError(422, 'INVALID_CRITICAL_TEXT', `${field}.normalization 必须为 ${NORMALIZATION_RULES.join(' / ')} 之一`);
    }
    return {
      text: text(item.text, `${field}.text`, { max: 500 }),
      region: validateRegion(item.region, `${field}.region`),
      case_sensitive: item.case_sensitive !== false,
      normalization,
    };
  });
}

/** 素材中当前生效的部分；被替换的素材保留但不再参与事实与生产。 */
export const activeAssets = assets => assets.filter(asset => asset.role_status === 'active');

/**
 * 校验一次事实版本提交。confirm=true 时的闸口由 computeReadiness 统一裁决，
 * 避免确认逻辑与可生产判断出现两套标准。
 */
export function validateTruthInput(body, { project, assets }) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  if (!Number.isInteger(body.base_version) || body.base_version < 0) {
    throw new ApiError(422, 'INVALID_BASE_VERSION', 'base_version 必须为不小于 0 的整数，用于乐观锁');
  }
  const sku = optionalText(body.sku, 'sku', { max: 64 }) ?? project.sku;
  const category = optionalText(body.category, 'category', { max: 40 }) ?? project.category;
  if (sku.toLowerCase() !== project.sku.toLowerCase()) {
    throw new ApiError(422, 'SKU_MISMATCH', `事实版本 SKU 必须与项目 SKU（${project.sku}）一致，如需换 SKU 请新建项目`);
  }
  const facts = validateFacts(body.facts, activeAssets(assets));
  return {
    base_version: body.base_version,
    confirm: body.confirm === true,
    sku,
    category,
    facts,
    immutable_regions: validateImmutableRegions(body.immutable_regions, activeAssets(assets)),
    critical_text: validateCriticalText(body.critical_text),
  };
}

/** 事实版本内容哈希：只覆盖语义内容，不含服务端写入的时间与确认人时间戳。 */
export function truthContentHash(payload) {
  return contentHash({
    sku: payload.sku,
    category: payload.category,
    facts: payload.facts.map(fact => ({
      key: fact.key,
      value: fact.value,
      unit: fact.unit,
      source_type: fact.source_type,
      source_asset_id: fact.source_asset_id,
      region: fact.region,
      confidence: fact.confidence,
      critical: fact.critical,
      confirmed: fact.confirmed,
      note: fact.note,
    })),
    immutable_regions: payload.immutable_regions,
    critical_text: payload.critical_text,
    confirmation_status: payload.confirmation_status,
  });
}

/**
 * 可生产闸口：M03 唯一的“能不能开始生产”判断。
 * M05/M06 创建任务前必须复用同一函数，不得在前端或新接口重写一套。
 */
export function computeReadiness(project, assets, truth) {
  const active = activeAssets(assets);
  const blockers = [];
  const warnings = [];

  if (active.length === 0) {
    blockers.push({ code: 'NO_ASSETS', message: '缺少素材：至少需要 1 张商品实拍图' });
  } else if (active.filter(asset => asset.role === 'subject').length === 0) {
    blockers.push({ code: 'NO_SUBJECT_ASSET', message: '缺少「主体」职责素材，无法锁定商品形态' });
  }

  const conflicting = EXCLUSIVE_ROLES
    .map(role => ({ role, count: active.filter(asset => asset.role === role).length }))
    .filter(item => item.count > 1);
  if (conflicting.length > 0) {
    blockers.push({
      code: 'REFERENCE_CONFLICT',
      message: '存在冲突的参考职责，需要先选择保留哪一张素材',
      details: { roles: conflicting.map(item => item.role) },
    });
  }

  if (!truth) {
    blockers.push({ code: 'NO_TRUTH_VERSION', message: '尚未提交商品事实版本' });
  } else {
    const criticalFacts = truth.facts.filter(fact => fact.critical);
    const unconfirmed = criticalFacts.filter(fact => fact.confirmed !== true);
    if (criticalFacts.length === 0) {
      blockers.push({ code: 'NO_CRITICAL_FACT', message: '至少需要 1 项标记为关键的商品事实' });
    } else if (unconfirmed.length > 0) {
      blockers.push({
        code: 'UNCONFIRMED_CRITICAL_FACTS',
        message: `${unconfirmed.length} 项关键事实未确认`,
        details: { keys: unconfirmed.map(fact => fact.key) },
      });
    }
    if (truth.sku.toLowerCase() !== project.sku.toLowerCase()) {
      blockers.push({ code: 'SKU_MISMATCH', message: '事实版本 SKU 与项目不一致' });
    }
    if (truth.confirmation_status !== 'confirmed') {
      blockers.push({ code: 'TRUTH_DRAFT', message: '商品事实仍为草稿，关键项确认后才能开始生产' });
    }
    const activeIds = new Set(active.map(asset => asset.id));
    const staleSources = truth.facts.filter(fact => fact.source_asset_id && !activeIds.has(fact.source_asset_id));
    if (staleSources.length > 0) {
      blockers.push({
        code: 'TRUTH_SOURCE_SUPERSEDED',
        message: '事实引用的素材已被替换，需要基于新素材重新确认事实',
        details: { keys: staleSources.map(fact => fact.key) },
      });
    }
  }

  for (const asset of active) {
    if (!asset.width || !asset.height) {
      warnings.push({ code: 'DIMENSIONS_UNKNOWN', message: `「${asset.filename}」尺寸未知，建议重新上传`, asset_id: asset.id });
      continue;
    }
    const shortSide = Math.min(asset.width, asset.height);
    if (shortSide < LIMITS.minShortSide) {
      warnings.push({
        code: 'LOW_RESOLUTION',
        message: `「${asset.filename}」最短边 ${shortSide}px 低于建议 ${LIMITS.minShortSide}px，建议补图`,
        asset_id: asset.id,
      });
    }
  }

  return {
    project_id: project.id,
    can_start_production: blockers.length === 0,
    truth_version: truth?.version ?? null,
    confirmation_status: truth?.confirmation_status ?? null,
    blocker_count: blockers.length,
    blockers,
    warnings,
  };
}
