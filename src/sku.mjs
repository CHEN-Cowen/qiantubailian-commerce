import { ApiError } from './errors.mjs';
import { contentHash } from './domain.mjs';

/**
 * E01 共用 SKU 与包装包含物档案：纯函数校验、单位规范化、版本差异与单规格简化视图。
 * 所有规则为纯函数，不含 IO；时间戳、ID 由路由层写入。
 */

export const SKU_LIMITS = Object.freeze({
  maxSkus: 50,
  maxAttributes: 30,
  maxContents: 60,
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 显式单位换算表（PRD 6.1：等价单位使用明确规则，不靠模型随意判断）。
 * - 体积 / 质量 / 长度换算到各自维度的基准单位。
 * - 计数单位之间不换算，只做同名别名归一（如「个 / 件」）；不同计数单位互不等价。
 * dimension + to_base 相同才可比；不在表内的单位一律 UNKNOWN_UNIT。
 */
const UNIT_TABLE = Object.freeze({
  // 体积（基准 ml）
  ml: { dimension: 'volume', canonical: 'ml', to_base: 1 },
  毫升: { dimension: 'volume', canonical: 'ml', to_base: 1 },
  l: { dimension: 'volume', canonical: 'L', to_base: 1000 },
  升: { dimension: 'volume', canonical: 'L', to_base: 1000 },
  // 质量（基准 g）
  g: { dimension: 'mass', canonical: 'g', to_base: 1 },
  克: { dimension: 'mass', canonical: 'g', to_base: 1 },
  kg: { dimension: 'mass', canonical: 'kg', to_base: 1000 },
  千克: { dimension: 'mass', canonical: 'kg', to_base: 1000 },
  公斤: { dimension: 'mass', canonical: 'kg', to_base: 1000 },
  mg: { dimension: 'mass', canonical: 'mg', to_base: 0.001 },
  毫克: { dimension: 'mass', canonical: 'mg', to_base: 0.001 },
  // 长度（基准 mm）
  mm: { dimension: 'length', canonical: 'mm', to_base: 1 },
  毫米: { dimension: 'length', canonical: 'mm', to_base: 1 },
  cm: { dimension: 'length', canonical: 'cm', to_base: 10 },
  厘米: { dimension: 'length', canonical: 'cm', to_base: 10 },
  m: { dimension: 'length', canonical: 'm', to_base: 1000 },
  米: { dimension: 'length', canonical: 'm', to_base: 1000 },
  // 计数（「个 / 件」归一为同一单位，其余计数单位各自独立、互不换算）
  件: { dimension: 'count:件', canonical: '件', to_base: 1 },
  个: { dimension: 'count:件', canonical: '件', to_base: 1 },
  条: { dimension: 'count:条', canonical: '条', to_base: 1 },
  包: { dimension: 'count:包', canonical: '包', to_base: 1 },
  瓶: { dimension: 'count:瓶', canonical: '瓶', to_base: 1 },
  盒: { dimension: 'count:盒', canonical: '盒', to_base: 1 },
  套: { dimension: 'count:套', canonical: '套', to_base: 1 },
  罐: { dimension: 'count:罐', canonical: '罐', to_base: 1 },
  支: { dimension: 'count:支', canonical: '支', to_base: 1 },
  片: { dimension: 'count:片', canonical: '片', to_base: 1 },
  张: { dimension: 'count:张', canonical: '张', to_base: 1 },
  袋: { dimension: 'count:袋', canonical: '袋', to_base: 1 },
  箱: { dimension: 'count:箱', canonical: '箱', to_base: 1 },
});

/** 各维度的基准单位（计数维度的基准即归一后的别名本身）。 */
const DIMENSION_BASE = Object.freeze({ volume: 'ml', mass: 'g', length: 'mm' });

function lookupUnit(raw, field = 'unit') {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(422, 'INVALID_FIELD', `${field} 必填，必须显式标注单位`);
  }
  const name = raw.trim();
  const entry = UNIT_TABLE[name] ?? UNIT_TABLE[name.toLowerCase()];
  if (!entry) {
    throw new ApiError(422, 'UNKNOWN_UNIT', `无法识别的单位「${name}」，请使用单位表内的标准单位`);
  }
  return entry;
}

/** 归一化数量与单位：换算到所属维度的基准单位，等价单位归一到同一表达。 */
export function normalizeQuantity(quantity, unit) {
  const entry = lookupUnit(unit);
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new ApiError(422, 'INVALID_FIELD', 'quantity 必须为大于 0 的有限数值');
  }
  const base = DIMENSION_BASE[entry.dimension] ?? entry.canonical;
  return { value: quantity * entry.to_base, unit: base, dimension: entry.dimension };
}

/**
 * 单位等价判断：
 * - 传入两个单位字符串：同一维度（可换算 / 已归一）即等价，如 ml≡L、个≡件、ml≠g。
 * - 传入 {quantity, unit} 对：归一化后的基准数值相等才等价，如 500ml≡0.5L。
 */
export function unitsEquivalent(a, b) {
  const resolve = value => (isPlainObject(value)
    ? normalizeQuantity(value.quantity, value.unit)
    : { ...lookupUnit(value), value: null });
  const left = resolve(a);
  const right = resolve(b);
  if (left.dimension !== right.dimension) return false;
  if (left.value === null || right.value === null) return true;
  return Math.abs(left.value - right.value) < 1e-9;
}

function text(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw new ApiError(422, 'INVALID_FIELD', `${field} 必须为字符串`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ApiError(422, 'INVALID_FIELD', `${field} 不能为空`);
  if (trimmed.length > max) throw new ApiError(422, 'INVALID_FIELD', `${field} 长度不能超过 ${max} 个字符`);
  return trimmed;
}

function optionalNote(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, field, { max: 300 });
}

function validateAttributes(input, field) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > SKU_LIMITS.maxAttributes) {
    throw new ApiError(422, 'INVALID_FIELD', `${field} 必须为不超过 ${SKU_LIMITS.maxAttributes} 项的数组`);
  }
  return input.map((item, index) => {
    const at = `${field}[${index}]`;
    if (!isPlainObject(item)) throw new ApiError(422, 'INVALID_FIELD', `${at} 必须为对象`);
    const key = text(item.key, `${at}.key`, { max: 60 });
    // 差异属性的值禁止留空：空值会被误读成「未知」，不如要求删除该属性
    const value = text(item.value, `${at}.value`, { max: 200 });
    const attribute = { key, value };
    if (item.unit !== undefined && item.unit !== null && item.unit !== '') {
      attribute.unit = text(item.unit, `${at}.unit`, { max: 20 });
    }
    return attribute;
  });
}

function validateContents(input, field, assetsById) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > SKU_LIMITS.maxContents) {
    throw new ApiError(422, 'INVALID_FIELD', `${field} 必须为不超过 ${SKU_LIMITS.maxContents} 项的数组`);
  }
  return input.map((item, index) => {
    const at = `${field}[${index}]`;
    if (!isPlainObject(item)) throw new ApiError(422, 'INVALID_FIELD', `${at} 必须为对象`);
    const name = text(item.item, `${at}.item`, { max: 80 });
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new ApiError(422, 'INVALID_FIELD', `${at}.quantity 必须为大于 0 的有限数值`);
    }
    // 单位必填且必须在显式换算表内（UNKNOWN_UNIT 在此抛出）
    const unit = lookupUnit(item.unit, `${at}.unit`).canonical;
    if (typeof item.included !== 'boolean') {
      throw new ApiError(422, 'INVALID_FIELD', `${at}.included 必须为布尔值（false 表示展示用道具、不随包装交付）`);
    }
    const source = typeof item.source === 'string' ? item.source.trim() : '';
    if (!['user_input', 'asset'].includes(source)) {
      throw new ApiError(422, 'INVALID_FIELD', `${at}.source 必须为 user_input 或 asset`);
    }
    const content = { item: name, quantity: item.quantity, unit, included: item.included, source };
    if (source === 'asset') {
      const assetId = typeof item.source_asset_id === 'string' ? item.source_asset_id.trim() : '';
      if (!assetId) throw new ApiError(422, 'INVALID_FIELD', `${at}.source_asset_id 必填：来源为素材时必须指明依据素材`);
      const asset = assetsById?.get(assetId);
      if (!asset) throw new ApiError(422, 'INVALID_FIELD', `${at}.source_asset_id 指向的素材不属于该项目`);
      if (asset.role === 'style') {
        throw new ApiError(422, 'INVALID_FIELD', `${at} 的来源素材是风格图，不能作为包装包含物依据`);
      }
      if (asset.role_status !== 'active') {
        throw new ApiError(422, 'INVALID_FIELD', `${at} 的来源素材已被替换，请改用生效中的素材`);
      }
      content.source_asset_id = assetId;
    }
    const note = optionalNote(item.note, `${at}.note`);
    if (note) content.note = note;
    return content;
  });
}

/**
 * 校验 PUT /skus 请求体：{ base_version, confirm, skus }。
 * assets（可选）为该项目当前租户的素材数组，用于核对 source=asset 的包含物来源。
 */
export function validateSkuProfilesInput(body, { project, assets = [] } = {}) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  if (!project) throw new ApiError(500, 'INTERNAL_ERROR', '缺少项目上下文');
  if (!Number.isInteger(body.base_version) || body.base_version < 0) {
    throw new ApiError(422, 'INVALID_FIELD', 'base_version 必须为不小于 0 的整数');
  }
  if (body.confirm !== undefined && typeof body.confirm !== 'boolean') {
    throw new ApiError(422, 'INVALID_FIELD', 'confirm 必须为布尔值');
  }
  if (!Array.isArray(body.skus) || body.skus.length < 1 || body.skus.length > SKU_LIMITS.maxSkus) {
    throw new ApiError(422, 'INVALID_FIELD', `skus 必须为 1—${SKU_LIMITS.maxSkus} 项的数组`);
  }
  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  const seenCodes = new Map();
  const skus = body.skus.map((item, index) => {
    const at = `skus[${index}]`;
    if (!isPlainObject(item)) throw new ApiError(422, 'INVALID_FIELD', `${at} 必须为对象`);
    const skuCode = text(item.sku_code, `${at}.sku_code`, { max: 64 });
    const codeKey = skuCode.toLowerCase();
    if (seenCodes.has(codeKey)) {
      throw new ApiError(422, 'INVALID_FIELD', `商家编号「${skuCode}」与 skus[${seenCodes.get(codeKey)}] 重复（同项目内不区分大小写）`);
    }
    seenCodes.set(codeKey, index);
    const sku = {
      sku_code: skuCode,
      label: text(item.label, `${at}.label`, { max: 80 }),
      attributes: validateAttributes(item.attributes, `${at}.attributes`),
      contents: validateContents(item.contents, `${at}.contents`, assetsById),
      confirmed: item.confirmed === true,
    };
    if (item.confirmed !== undefined && typeof item.confirmed !== 'boolean') {
      throw new ApiError(422, 'INVALID_FIELD', `${at}.confirmed 必须为布尔值`);
    }
    if (item.id !== undefined && item.id !== null && item.id !== '') {
      sku.id = text(item.id, `${at}.id`, { max: 64 });
    }
    return sku;
  });
  return { base_version: body.base_version, confirm: body.confirm === true, skus };
}

/** SKU 档案版本内容哈希：字段顺序不影响结果。 */
export const skuProfileContentHash = profile => contentHash({ skus: profile.skus });

const skuIdentity = sku => sku.id ?? `code:${String(sku.sku_code ?? '').toLowerCase()}`;

/**
 * 逐 SKU 差异（供 E03 变更影响分析复用）：
 * 以稳定内部 ID 对齐（无 ID 时回落到 sku_code 小写），返回新增 / 删除 / 字段级变化。
 */
export function diffSkuProfiles(oldSkus = [], newSkus = []) {
  const before = new Map(oldSkus.map(sku => [skuIdentity(sku), sku]));
  const after = new Map(newSkus.map(sku => [skuIdentity(sku), sku]));
  const changes = [];
  for (const [id, next] of after) {
    const prev = before.get(id);
    if (!prev) {
      changes.push({ sku_id: next.id ?? null, sku_code: next.sku_code, change: 'added' });
      continue;
    }
    const fields = {};
    if (prev.sku_code !== next.sku_code) fields.sku_code = { from: prev.sku_code, to: next.sku_code };
    if (prev.label !== next.label) fields.label = { from: prev.label, to: next.label };
    if (JSON.stringify(prev.attributes ?? []) !== JSON.stringify(next.attributes ?? [])) {
      fields.attributes = { from: prev.attributes ?? [], to: next.attributes ?? [] };
    }
    if (JSON.stringify(prev.contents ?? []) !== JSON.stringify(next.contents ?? [])) {
      fields.contents = { from: prev.contents ?? [], to: next.contents ?? [] };
    }
    if ((prev.confirmed === true) !== (next.confirmed === true)) {
      fields.confirmed = { from: prev.confirmed === true, to: next.confirmed === true };
    }
    if (Object.keys(fields).length > 0) {
      changes.push({ sku_id: next.id ?? prev.id ?? null, sku_code: next.sku_code, change: 'changed', fields });
    }
  }
  for (const [id, prev] of before) {
    if (!after.has(id)) changes.push({ sku_id: prev.id ?? null, sku_code: prev.sku_code, change: 'removed' });
  }
  return changes;
}

/**
 * 单规格简化视图：项目无 SKU 档案时，由 project.sku 派生一个未建档 SKU。
 * derived/confirmed 明确标记，不伪造已确认档案。
 */
export function simplifiedSkuView(project) {
  return {
    derived: true,
    skus: [{
      sku_code: project.sku,
      label: project.name,
      attributes: [],
      contents: [],
      confirmed: false,
      derived: true,
    }],
  };
}
