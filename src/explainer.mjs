/**
 * E06 三种说明图（包装内容清单 / 尺寸说明 / SKU 对比）：确定性排版与事实一致性校验。
 *
 * 边界：
 * 1. 图上的文字、数量、单位全部来自商家确认的 SKU 档案与商品事实，编辑只允许改标题/副标题/脚注；
 *    数量、单位、条目名与对照值一律不可改（否则就是「用排版伪造规格」）。
 * 2. 适配结论不靠推测：尺寸图只列商家填写的带单位尺寸，并固定附上「不推断适配」声明；
 *    编辑后的文案里出现「适配/适合/通用/100%」这类承诺会被拒绝。
 * 3. 渲染是纯排版，不调用生图模型；需要照片但无合法来源时由路由层报价，不在本模块偷偷生成。
 */
import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const EXPLAINER_SCHEMA_VERSION = 1;
export const EXPLAINER_KINDS = Object.freeze(['packing_list', 'size', 'sku_compare']);
export const EXPLAINER_KIND_LABELS = Object.freeze({
  packing_list: '包装内容清单图',
  size: '尺寸说明图',
  sku_compare: 'SKU对比图',
});
export const EXPLAINER_LIMITS = Object.freeze({
  title_max_length: 40,
  subtitle_max_length: 80,
  footnote_max_length: 160,
  max_rows: 60,
});
export const EXPLAINER_CANVAS = Object.freeze({ width: 1080, height: 1350 });
/** 可编辑文案里禁止出现的承诺词：说明图不能替商家下断言。 */
export const CLAIM_BLOCKLIST = Object.freeze(['适配', '适合', '适用', '通用', '兼容', '保证', '100%', '百分之百', '万能', '绝不', '无风险', '永久有效']);
export const SIZE_DISCLAIMER = '尺寸为商家确认数据；不推断适配机型、容器或使用场景。';
export const FACT_SOURCE_NOTE = '仅使用商家已确认的 SKU 档案与商品事实；未确认内容不展示。';

const LENGTH_UNITS = new Set(['mm', 'cm', 'm', '毫米', '厘米', '米']);
const DIMENSION_KEY = /长|宽|高|深|厚|直径|尺寸/;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = text => createHash('sha256').update(text).digest('hex');
const charLength = text => [...String(text ?? '')].length;

const formatNumber = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return String(number);
};
const displayQuantity = (quantity, unit) => `${formatNumber(quantity)} ${unit}`.trim();
const attributeText = attribute => `${attribute.value}${attribute.unit ? ` ${attribute.unit}` : ''}`;

function sanitizeText(value, field, max) {
  if (typeof value !== 'string') throw new ApiError(422, 'INVALID_FIELD', `${field} 必须为字符串`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new ApiError(422, 'INVALID_FIELD', `${field} 不能为空`);
  if (charLength(text) > max) throw new ApiError(422, 'INVALID_FIELD', `${field} 不能超过 ${max} 个字符`);
  return text;
}

/** 文案里的承诺词扫描：返回命中的词，供拒绝与展示。 */
export function scanClaims(text) {
  const source = String(text ?? '');
  return CLAIM_BLOCKLIST.filter(word => source.includes(word));
}

function applyClaimsGuard(plan) {
  const targets = [['title', plan.title], ['subtitle', plan.subtitle], ['footnote', plan.footnote]];
  const blocked = [];
  for (const [field, text] of targets) {
    for (const word of scanClaims(text)) blocked.push({ field, word });
  }
  return blocked;
}

/**
 * 生成说明图排版计划（纯函数，不落库）。
 * 返回 ok=false 时带 code 与 missing：缺什么资料就明说，不用猜测补齐。
 */
export function buildExplainerPlan({
  kind, skuProfile, skuId, peerSkuId = null, skuCode = null, peerSkuCode = null, truth = null,
} = {}) {
  if (!EXPLAINER_KINDS.includes(kind)) {
    throw new ApiError(422, 'INVALID_FIELD', `kind 必须为 ${EXPLAINER_KINDS.join(' / ')}`);
  }
  const label = EXPLAINER_KIND_LABELS[kind];
  if (!isPlainObject(skuProfile) || !Array.isArray(skuProfile.skus)) {
    return { ok: false, kind, code: 'NO_SKU_PROFILE', message: '项目还没有 SKU 档案，请先在商品事实中维护 SKU 档案', missing: [], label };
  }
  // 以 ID 为首选；档案重写时可能换了内部 ID，回落到商家编号仍能定位同一 SKU。
  const matchSku = (id, code) => skuProfile.skus.find(item =>
    (id && item.id === id) || (code && item.sku_code === code)) ?? null;
  const sku = matchSku(skuId, skuCode);
  if (!sku) {
    return { ok: false, kind, code: 'SKU_NOT_FOUND', message: '指定的 SKU 不在当前档案内', missing: [], label };
  }
  const baseSources = {
    sku_profile_version: skuProfile.version ?? null,
    truth_version: truth?.version ?? null,
    sku_id: sku.id ?? null,
    sku_code: sku.sku_code ?? '',
    peer_sku_id: peerSkuId ?? null,
    peer_sku_code: null,
  };

  if (kind === 'packing_list') {
    const contents = Array.isArray(sku.contents) ? sku.contents : [];
    if (contents.length === 0) {
      return {
        ok: false, kind, code: 'CONTENT_MISSING', label,
        message: `SKU「${sku.sku_code}」还没有包装包含物记录，无法生成清单图`,
        missing: ['在 SKU 档案中登记包装包含物（物件名、数量、单位、是否随包装交付）'],
      };
    }
    const rows = contents.map((item, index) => ({
      id: `row_${index + 1}`,
      section: item.included === false ? 'excluded' : 'included',
      label: item.item,
      value: displayQuantity(item.quantity, item.unit),
      quantity: item.quantity,
      unit: item.unit,
    }));
    return finalizePlan({
      kind, label, sku, peer: null, rows, sources: baseSources,
      title: `${sku.label} · 包装内容`,
      subtitle: `商家编号 ${sku.sku_code}`,
      footnote: `事实来源：SKU 档案 v${skuProfile.version ?? '-'}${truth?.version ? ` · 商品事实 v${truth.version}` : ''}`,
      fact_snapshot: {
        contents: contents.map(item => ({ item: item.item, quantity: item.quantity, unit: item.unit, included: item.included !== false })),
        attributes: [],
      },
      extra_notes: ['清单只列商家确认的包装包含物；道具类物品单独标注「不随包装交付」。'],
    });
  }

  if (kind === 'size') {
    const attributes = Array.isArray(sku.attributes) ? sku.attributes : [];
    const rows = [];
    const missing = [];
    for (const attribute of attributes) {
      const unit = typeof attribute.unit === 'string' ? attribute.unit.trim() : '';
      if (unit && LENGTH_UNITS.has(unit)) {
        // 已确认事实是这个 SKU 规格的权威来源：同名事实存在时以事实值为准，
        // 这样 E03 的「事实变化 → 免费重排」才会真的换上新数值，而不是照旧档案排版。
        const fact = (truth?.facts ?? []).find(item => item.key === attribute.key) ?? null;
        const displayUnit = fact?.unit ?? unit;
        const value = fact
          ? `${formatNumber(fact.value)}${displayUnit ? ` ${displayUnit}` : ''}`
          : attributeText(attribute);
        rows.push({
          id: `row_${rows.length + 1}`,
          section: 'size',
          label: attribute.key,
          value,
          unit: displayUnit,
        });
      } else if (!unit && DIMENSION_KEY.test(String(attribute.key))) {
        missing.push(`属性「${attribute.key}」缺单位：请在 SKU 档案中填写带单位的尺寸（如 长 30 cm）`);
      }
    }
    if (rows.length === 0) {
      return {
        ok: false, kind, code: 'SIZE_FACTS_MISSING', label,
        message: `SKU「${sku.sku_code}」没有带单位的尺寸属性，无法生成尺寸说明图`,
        missing: missing.length > 0 ? missing : ['在 SKU 档案中为尺寸属性填写带单位的值（如 长 30 cm / 宽 20 cm / 高 10 cm）'],
      };
    }
    return finalizePlan({
      kind, label, sku, peer: null, rows, sources: baseSources,
      title: `${sku.label} · 尺寸说明`,
      subtitle: `商家编号 ${sku.sku_code}`,
      footnote: `事实来源：SKU 档案 v${skuProfile.version ?? '-'}${truth?.version ? ` · 商品事实 v${truth.version}` : ''}`,
      disclaimer: SIZE_DISCLAIMER,
      fact_snapshot: {
        contents: [],
        attributes: rows.map(row => ({ key: row.label, value: row.value })),
      },
      extra_notes: [SIZE_DISCLAIMER],
    });
  }

  // sku_compare
  if (!peerSkuId && !peerSkuCode) {
    return { ok: false, kind, code: 'PEER_SKU_REQUIRED', label, message: 'SKU 对比图需要指定对比的另一个 SKU', missing: ['选择对比 SKU'] };
  }
  const peer = matchSku(peerSkuId, peerSkuCode);
  if (!peer) {
    return { ok: false, kind, code: 'PEER_SKU_NOT_FOUND', label, message: '对比 SKU 不在当前档案内', missing: [] };
  }
  if (String(peer.sku_code).toLowerCase() === String(sku.sku_code).toLowerCase()) {
    return { ok: false, kind, code: 'PEER_SKU_INVALID', label, message: '对比 SKU 不能与当前 SKU 相同', missing: [] };
  }
  const rows = [];
  const attributeKeys = [...new Set([
    ...(sku.attributes ?? []).map(item => item.key),
    ...(peer.attributes ?? []).map(item => item.key),
  ])];
  for (const key of attributeKeys) {
    const left = (sku.attributes ?? []).find(item => item.key === key) ?? null;
    const right = (peer.attributes ?? []).find(item => item.key === key) ?? null;
    if (!left && !right) continue;
    const a = left ? attributeText(left) : '未提供';
    const b = right ? attributeText(right) : '未提供';
    rows.push({ id: `row_${rows.length + 1}`, section: 'compare', group: 'attributes', label: key, a, b, diff: a !== b });
  }
  const itemNames = [...new Set([
    ...(sku.contents ?? []).map(item => item.item),
    ...(peer.contents ?? []).map(item => item.item),
  ])];
  for (const name of itemNames) {
    const left = (sku.contents ?? []).find(item => item.item === name) ?? null;
    const right = (peer.contents ?? []).find(item => item.item === name) ?? null;
    if (!left && !right) continue;
    const a = left ? displayQuantity(left.quantity, left.unit) : '未包含';
    const b = right ? displayQuantity(right.quantity, right.unit) : '未包含';
    rows.push({ id: `row_${rows.length + 1}`, section: 'compare', group: 'contents', label: name, a, b, diff: a !== b });
  }
  if (rows.length === 0) {
    return {
      ok: false, kind, code: 'COMPARE_EMPTY', label,
      message: '两个 SKU 都没有可比较的已确认属性或包含物', missing: ['先为两个 SKU 补充已确认的差异属性或包装包含物'],
    };
  }
  const sources = { ...baseSources, peer_sku_id: peer.id ?? null, peer_sku_code: peer.sku_code ?? '' };
  return finalizePlan({
    kind, label, sku, peer, rows, sources,
    title: `${sku.label} / ${peer.label}`,
    subtitle: `商家编号 ${sku.sku_code} vs ${peer.sku_code}`,
    footnote: `事实来源：SKU 档案 v${skuProfile.version ?? '-'}${truth?.version ? ` · 商品事实 v${truth.version}` : ''}`,
    fact_snapshot: {
      contents: (sku.contents ?? []).map(item => ({ item: item.item, quantity: item.quantity, unit: item.unit, included: item.included !== false })),
      peer_contents: (peer.contents ?? []).map(item => ({ item: item.item, quantity: item.quantity, unit: item.unit, included: item.included !== false })),
      attributes: (sku.attributes ?? []).map(item => ({ key: item.key, value: attributeText(item) })),
      peer_attributes: (peer.attributes ?? []).map(item => ({ key: item.key, value: attributeText(item) })),
    },
    extra_notes: ['对比只呈现已确认差异；没有提供的一侧标注「未包含 / 未提供」，不推断优劣。'],
  });
}

function finalizePlan({
  kind, label, sku, peer, rows, sources, title, subtitle, footnote,
  fact_snapshot: factSnapshot, disclaimer = null, extra_notes = [],
}) {
  const plan = {
    ok: true,
    kind,
    label,
    sku: { id: sku.id ?? null, sku_code: sku.sku_code, label: sku.label },
    peer_sku: peer ? { id: peer.id ?? null, sku_code: peer.sku_code, label: peer.label } : null,
    title,
    subtitle,
    footnote,
    disclaimer,
    rows,
    notes: [...extra_notes, '说明图为确定性排版，不调用生图模型，不消耗生图额度。'],
    canvas: { ...EXPLAINER_CANVAS },
    sources,
    fact_snapshot: { ...factSnapshot, ...sources },
    claims: { ok: true, blocked: [] },
    missing: [],
  };
  const blocked = applyClaimsGuard(plan);
  plan.claims = { ok: blocked.length === 0, blocked };
  plan.plan_hash = planFingerprint(plan);
  return plan;
}

/** 计划指纹：同一 SKU 同一事实版本同一排版 = 同一张图，用来避免重复制作。 */
export function planFingerprint(plan) {
  return sha256(JSON.stringify({
    kind: plan.kind,
    sku_id: plan.sku?.id ?? null,
    peer_sku_id: plan.peer_sku?.id ?? null,
    sources: plan.sources,
    title: plan.title, subtitle: plan.subtitle, footnote: plan.footnote,
    rows: plan.rows,
  }));
}

/**
 * 编辑只允许标题/副标题/脚注；任何改写数量、单位、条目名或对照值的请求都会被拒绝。
 * 返回新计划（rows 原样保留）与逐项问题。
 */
export function applyExplainerEdits({ plan, edits = {} } = {}) {
  if (!isPlainObject(plan) || plan.ok !== true) throw new ApiError(422, 'PLAN_INVALID', '排版计划不可编辑：请先生成有效计划');
  if (!isPlainObject(edits)) throw new ApiError(400, 'INVALID_BODY', 'edits 必须为对象');
  const issues = [];
  const next = { ...plan };
  const allowed = ['title', 'subtitle', 'footnote'];
  for (const [field, value] of Object.entries(edits)) {
    const key = field === 'footnote_note' ? 'footnote' : field;
    if (!allowed.includes(key)) {
      issues.push({ field, code: 'FACT_VALUE_IMMUTABLE', message: '数量、单位、条目名与对照值来自确认事实，不能在排版层改写' });
      continue;
    }
    let text;
    try {
      text = sanitizeText(value, key, key === 'title' ? EXPLAINER_LIMITS.title_max_length
        : key === 'subtitle' ? EXPLAINER_LIMITS.subtitle_max_length : EXPLAINER_LIMITS.footnote_max_length);
    } catch (error) {
      issues.push({ field: key, code: error.code ?? 'INVALID_FIELD', message: error.message });
      continue;
    }
    const words = scanClaims(text);
    if (words.length > 0) {
      issues.push({ field: key, code: 'CLAIM_NOT_ALLOWED', message: `文案含未经验证的承诺表达「${words.join('、')}」，说明图不能替商家下结论` });
      continue;
    }
    next[key] = text;
  }
  const changed = allowed.some(key => next[key] !== plan[key]);
  next.plan_hash = planFingerprint(next);
  return { plan: next, issues, changed };
}

/**
 * 事实一致性审计：逐行核对计划里的数量/单位/条目名/对照值与冻结快照是否一致。
 * 导出与选版前都会调用；不一致直接阻断，不能用「预览正常」放行。
 */
export function auditExplainerPlan(plan, { truth = null } = {}) {
  if (!isPlainObject(plan) || !Array.isArray(plan.rows)) {
    return { ok: false, mismatches: [{ field: 'plan', expected: '排版计划', actual: null }], claims: { ok: false, blocked: [] } };
  }
  const snapshot = plan.fact_snapshot ?? {};
  const mismatches = [];
  const contents = snapshot.contents ?? [];
  const attributes = snapshot.attributes ?? [];
  const peerContents = snapshot.peer_contents ?? [];
  const peerAttributes = snapshot.peer_attributes ?? [];

  for (const row of plan.rows) {
    if (row.section === 'included' || row.section === 'excluded') {
      const source = contents.find(item => item.item === row.label) ?? null;
      if (!source) { mismatches.push({ row: row.id, field: 'item', expected: row.label, actual: null }); continue; }
      const expected = displayQuantity(source.quantity, source.unit);
      if (expected !== row.value) mismatches.push({ row: row.id, field: 'value', expected, actual: row.value });
    } else if (row.section === 'size') {
      const source = attributes.find(item => item.key === row.label) ?? null;
      if (!source) { mismatches.push({ row: row.id, field: 'key', expected: row.label, actual: null }); continue; }
      if (source.value !== row.value) mismatches.push({ row: row.id, field: 'value', expected: source.value, actual: row.value });
    } else if (row.section === 'compare') {
      if (row.group === 'attributes') {
        const left = attributes.find(item => item.key === row.label) ?? null;
        const right = peerAttributes.find(item => item.key === row.label) ?? null;
        const expectedA = left ? left.value : '未提供';
        const expectedB = right ? right.value : '未提供';
        if (expectedA !== row.a) mismatches.push({ row: row.id, field: 'a', expected: expectedA, actual: row.a });
        if (expectedB !== row.b) mismatches.push({ row: row.id, field: 'b', expected: expectedB, actual: row.b });
      } else {
        const left = contents.find(item => item.item === row.label) ?? null;
        const right = peerContents.find(item => item.item === row.label) ?? null;
        const expectedA = left ? displayQuantity(left.quantity, left.unit) : '未包含';
        const expectedB = right ? displayQuantity(right.quantity, right.unit) : '未包含';
        if (expectedA !== row.a) mismatches.push({ row: row.id, field: 'a', expected: expectedA, actual: row.a });
        if (expectedB !== row.b) mismatches.push({ row: row.id, field: 'b', expected: expectedB, actual: row.b });
      }
    }
  }
  // 跨来源核对：SKU 档案与「已确认商品事实」同名属性必须一致。
  // 两者矛盾时不能选一边照排：那等于用排版掩盖确认事实之间的冲突。
  if (truth) {
    const facts = new Map((truth.facts ?? []).map(fact => [fact.key, fact]));
    for (const row of plan.rows) {
      const attributeRow = row.section === 'size'
        || (row.section === 'compare' && row.group === 'attributes');
      if (!attributeRow) continue;
      const fact = facts.get(row.label);
      if (!fact) continue;
      const expected = attributeText(fact);
      const actual = row.section === 'size' ? row.value : row.a;
      if (expected !== actual) {
        mismatches.push({ row: row.id, field: 'truth_conflict', expected, actual });
      }
    }
  }
  const blocked = applyClaimsGuard(plan);
  return { ok: mismatches.length === 0 && blocked.length === 0, mismatches, claims: { ok: blocked.length === 0, blocked } };
}

/** 依据变化的判定：来源档案/事实版本变了，图就过期，需要按最新事实重排。 */
export function explainerStale({ version, skuProfile = null, truth = null } = {}) {
  const sources = version?.plan?.sources ?? {};
  const reasons = [];
  if (skuProfile && sources.sku_profile_version !== null && sources.sku_profile_version !== undefined
    && sources.sku_profile_version !== skuProfile.version) {
    reasons.push({ code: 'SKU_PROFILE_CHANGED', from: sources.sku_profile_version, to: skuProfile.version });
  }
  if (truth && sources.truth_version !== null && sources.truth_version !== undefined
    && sources.truth_version !== truth.version) {
    reasons.push({ code: 'TRUTH_CHANGED', from: sources.truth_version, to: truth.version });
  }
  return { stale: reasons.length > 0, reasons };
}

/**
 * 依赖条目（供 E03 变更影响直接复用）：SKU 条目 + 命中的商品事实 + 底图素材。
 * 说明图整版都由档案推导，所以证据档位是 deterministic，不用 OCR 候选冒充。
 */
export function dependencyEntriesFor({ plan, truth = null, basePhoto = null } = {}) {
  const entries = [];
  const skuCodes = [plan?.sources?.sku_code, plan?.sources?.peer_sku_code].filter(Boolean);
  for (const code of skuCodes) entries.push({ kind: 'sku', ref: code, evidence: 'deterministic', note: '说明图按该 SKU 档案确定性排版' });
  const factKeys = new Set((truth?.facts ?? []).map(fact => fact.key));
  for (const row of plan?.rows ?? []) {
    if (factKeys.has(row.label)) entries.push({ kind: 'fact', ref: row.label, evidence: 'deterministic', note: '说明图文字引用该确认事实' });
  }
  if (basePhoto?.type === 'asset' && basePhoto.asset_id) {
    entries.push({ kind: 'asset', ref: basePhoto.asset_id, evidence: 'manual', note: '说明图使用该商家素材作底图' });
  }
  return entries;
}

const escapeXml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[ch]));

/**
 * 确定性 SVG 排版。同一计划 + 同一底图永远得到同一张图（不含时间戳/随机数）。
 */
export function renderExplainerSvg(plan, { baseDataUri = null } = {}) {
  if (!isPlainObject(plan) || plan.ok !== true) throw new ApiError(422, 'PLAN_INVALID', '排版计划无效，不能渲染');
  const { width, height } = plan.canvas ?? EXPLAINER_CANVAS;
  const rows = plan.rows ?? [];
  const top = 250;
  const bottomSpace = 190;
  const rowHeight = Math.max(36, Math.min(78, Math.floor((height - top - bottomSpace) / Math.max(1, rows.length))));
  const body = [];

  if (baseDataUri) {
    body.push(`<image href="${escapeXml(baseDataUri)}" x="0" y="0" width="${width}" height="${Math.round(height * 0.42)}" preserveAspectRatio="xMidYMid slice" opacity="0.92"/>`);
    body.push(`<rect x="0" y="${Math.round(height * 0.42) - 60}" width="${width}" height="60" fill="url(#fade)"/>`);
  }

  let y = top;
  if (plan.kind === 'sku_compare') {
    const left = plan.sku?.label ?? '';
    const right = plan.peer_sku?.label ?? '';
    body.push(`<text x="${Math.round(width * 0.5)}" y="${y - 34}" font-size="30" font-weight="600" text-anchor="middle" fill="#5F6B62">${escapeXml(plan.sku?.sku_code ?? '')}</text>`);
    body.push(`<text x="${Math.round(width * 0.82)}" y="${y - 34}" font-size="30" font-weight="600" text-anchor="middle" fill="#5F6B62">${escapeXml(plan.peer_sku?.sku_code ?? '')}</text>`);
    body.push(`<text x="80" y="${y - 34}" font-size="24" fill="#8A958C">项目 / 对比</text>`);
    body.push(`<line x1="80" y1="${y - 16}" x2="${width - 80}" y2="${y - 16}" stroke="#DFE5DC" stroke-width="2"/>`);
    void left; void right;
  }

  rows.forEach((row, index) => {
    const baseline = y + rowHeight * index;
    const centerY = baseline + Math.round(rowHeight * 0.62);
    if (index % 2 === 0) {
      body.push(`<rect x="60" y="${baseline}" width="${width - 120}" height="${rowHeight}" rx="12" fill="#FFFFFF"/>`);
    }
    if (plan.kind === 'sku_compare') {
      body.push(`<text x="80" y="${centerY}" font-size="32" fill="#263A32">${escapeXml(row.label)}</text>`);
      body.push(`<text x="${Math.round(width * 0.5)}" y="${centerY}" font-size="34" font-weight="600" text-anchor="middle" fill="${row.diff ? '#B45309' : '#263A32'}">${escapeXml(row.a)}</text>`);
      body.push(`<text x="${Math.round(width * 0.82)}" y="${centerY}" font-size="34" font-weight="600" text-anchor="middle" fill="${row.diff ? '#B45309' : '#263A32'}">${escapeXml(row.b)}</text>`);
      if (row.diff) body.push(`<circle cx="${width - 84}" cy="${centerY - 10}" r="8" fill="#D97706"/>`);
    } else {
      const dim = row.section === 'excluded';
      body.push(`<text x="84" y="${centerY}" font-size="34" fill="${dim ? '#8A958C' : '#263A32'}">${escapeXml(row.label)}</text>`);
      body.push(`<text x="${width - 84}" y="${centerY}" font-size="38" font-weight="700" text-anchor="end" fill="${dim ? '#8A958C' : '#365F49'}">${escapeXml(row.value)}</text>`);
      if (dim) body.push(`<text x="${width - 84 - 8}" y="${centerY + 28}" font-size="22" text-anchor="end" fill="#8A958C">不随包装交付</text>`);
    }
  });

  const notes = [];
  if (plan.kind === 'packing_list') notes.push(`含 ${(plan.rows ?? []).filter(row => row.section === 'included').length} 项随包装交付内容`);
  if (plan.kind === 'sku_compare') notes.push('橙色为已确认差异项；未提供的一侧标注「未包含 / 未提供」');
  if (plan.disclaimer) notes.push(plan.disclaimer);

  const footnoteY = height - 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F7F8F5" stop-opacity="0"/>
      <stop offset="100%" stop-color="#F7F8F5" stop-opacity="1"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="#F7F8F5"/>
  <rect x="0" y="0" width="${width}" height="${baseDataUri ? 118 : 190}" fill="#365F49"/>
  <text x="64" y="${baseDataUri ? 66 : 74}" font-size="48" font-weight="700" fill="#FFFFFF">${escapeXml(plan.title)}</text>
  <text x="64" y="${baseDataUri ? 104 : 128}" font-size="28" fill="#D7E3DA">${escapeXml(plan.subtitle)}</text>
  ${body.join('\n  ')}
  ${notes.map((note, index) => `<text x="64" y="${height - 150 - index * 34}" font-size="24" fill="#6D786F">${escapeXml(note)}</text>`).join('\n  ')}
  <line x1="64" y1="${height - 122}" x2="${width - 64}" y2="${height - 122}" stroke="#DFE5DC" stroke-width="2"/>
  <text x="64" y="${footnoteY}" font-size="24" fill="#263A32">${escapeXml(plan.footnote)}</text>
  <text x="64" y="${footnoteY + 34}" font-size="22" fill="#8A958C">${escapeXml(FACT_SOURCE_NOTE)}</text>
</svg>`;
}

/** 前端视图：不返回 SVG 全文，只给版本摘要、状态与替换清单。 */
export function presentExplainer({ record, skuProfile = null, truth = null } = {}) {
  if (!record || typeof record !== 'object') return null;
  const versions = record.versions ?? [];
  const active = versions.find(item => item.active === true) ?? versions[versions.length - 1] ?? null;
  const stale = active ? explainerStale({ version: active, skuProfile, truth }) : { stale: false, reasons: [] };
  const reviewed = active?.review?.decision === 'confirmed';
  const auditOk = active?.checks?.audit?.ok === true;
  let status = 'draft';
  if (stale.stale) status = 'stale';
  else if (!auditOk) status = 'needs_review';
  else if (!reviewed) status = 'awaiting_review';
  else if (active?.active === true) status = 'active';
  else status = 'checked';
  return {
    id: record.id,
    project_id: record.project_id,
    kind: record.kind,
    kind_label: EXPLAINER_KIND_LABELS[record.kind] ?? record.kind,
    sku: record.sku ?? null,
    peer_sku: record.peer_sku ?? null,
    status,
    stale: stale.stale,
    stale_reasons: stale.reasons,
    version_count: versions.length,
    active_version: active ? {
      id: active.id,
      number: active.number,
      active: active.active === true,
      width: active.width,
      height: active.height,
      hash: active.hash,
      reviewed,
      review: active.review ?? null,
      checks: active.checks ?? null,
      plan: {
        title: active.plan?.title, subtitle: active.plan?.subtitle, footnote: active.plan?.footnote,
        disclaimer: active.plan?.disclaimer ?? null, notes: active.plan?.notes ?? [],
        rows: active.plan?.rows ?? [], sources: active.plan?.sources ?? null,
        fact_snapshot: active.plan?.fact_snapshot ?? null,
      },
      edits: active.edits ?? null,
      base_photo: active.base_photo ?? null,
      created_at: active.created_at,
    } : null,
    versions: versions.map(item => ({
      id: item.id, number: item.number, active: item.active === true,
      hash: item.hash, reviewed: item.review?.decision === 'confirmed',
      review: item.review ?? null, created_at: item.created_at,
      edits: item.edits ?? null, stale: explainerStale({ version: item, skuProfile, truth }).stale,
    })),
    replacement_list: replacementListFor(record),
    adoption: record.adoption ?? [],
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** 旧文件替换清单：交付路径、当前哈希、上一版哈希与本次改动说明。 */
export function replacementListFor(record) {
  const versions = record.versions ?? [];
  const active = versions.find(item => item.active === true) ?? null;
  if (!active) return [];
  const previous = versions.filter(item => item.number < active.number).sort((a, b) => b.number - a.number)[0] ?? null;
  const path = explainerPath(record, active);
  return [{
    path,
    new_sha256: active.hash,
    new_version_number: active.number,
    previous_sha256: previous?.hash ?? null,
    previous_version_number: previous?.number ?? null,
    change_note: active.edits?.changes ?? [],
    note: '这是需要替换到店铺的说明图文件清单；系统不会自动同步平台。',
  }];
}

export function explainerPath(record, version) {
  const kind = record.kind ?? 'explainer';
  const code = String(record.sku?.sku_code ?? 'sku').replace(/[^\w.-]+/g, '-');
  return `images/explainers/${kind}/${code}-v${version.number}.png`;
}

/** 人工复核输入校验：拒绝要留依据；确认必须建立在事实审计通过之上。 */
export function validateExplainerReview(body, version) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!['confirm', 'reject'].includes(action)) throw new ApiError(422, 'INVALID_FIELD', 'action 必须为 confirm / reject');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 300) throw new ApiError(422, 'INVALID_FIELD', 'reason 必填且不超过 300 字符：人工复核必须留下依据');
  if (action === 'confirm' && version?.checks?.audit?.ok !== true) {
    throw new ApiError(409, 'AUDIT_FAILED', '事实一致性审计未通过，不能确认该说明图');
  }
  return { action, reason };
}

/** 采用反馈：只记录商家自述，不换算成转化收益。 */
export function validateExplainerFeedback(body) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  if (typeof body.used !== 'boolean') throw new ApiError(422, 'INVALID_FIELD', 'used 必须为布尔值（是否实际采用）');
  const channel = typeof body.channel === 'string' ? body.channel.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (channel.length > 40) throw new ApiError(422, 'INVALID_FIELD', 'channel 不能超过 40 个字符');
  if (reason.length > 300) throw new ApiError(422, 'INVALID_FIELD', 'reason 不能超过 300 个字符');
  return {
    used: body.used,
    channel: channel || null,
    reason: reason || null,
    note: '采用反馈为商家自述，仅用于回顾是否用过这张图；不代表店铺曝光、点击或转化收益，也不接入平台数据。',
  };
}
