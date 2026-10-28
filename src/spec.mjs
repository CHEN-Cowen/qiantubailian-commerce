import { ApiError } from './errors.mjs';
import { contentHash, canonical } from './domain.mjs';
import { CATALOG_VERSION, COVERAGE } from './catalog.mjs';

/**
 * M04 规则装配：品牌套件校验、交付清单推导、冲突检测与处理、CommerceSpec 快照。
 *
 * 三条硬边界：
 * 1. 优先级不可静默覆盖 —— 平台硬约束 > 商品事实 > 品牌约束 > 模板 > 用户创意。
 *    冲突必须显式选择处理方式；没有可选处理方式时停止，不允许"先跑起来再说"。
 * 2. 快照只追加不修改 —— 旧 spec 永远指向它当时引用的模板/套件/规则版本；
 *    新配置只影响新版本，旧版本只可能被判为 stale，内容不被改写。
 * 3. 不补内容 —— 无依据的卖点/功效/规格只会以"待补证据"出现，spec 不会替用户生成任何文案。
 */
export const SPEC_BUILDER_VERSION = 'm04.1';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const sha = value => contentHash(value);
const shortText = (value, field, { max = 120, min = 1 } = {}) => {
  if (typeof value !== 'string') throw new ApiError(422, 'INVALID_FIELD', `${field} 必须为字符串`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ApiError(422, 'INVALID_FIELD', `${field} 不能为空`);
  if (trimmed.length > max) throw new ApiError(422, 'INVALID_FIELD', `${field} 长度不能超过 ${max} 个字符`);
  return trimmed;
};

const HEX = /^#[0-9A-Fa-f]{6}$/;
const FONT_LICENSES = Object.freeze(['licensed', 'unlicensed', 'unknown']);
export const MAX_BANNED_EXPRESSIONS = 60;

/** 品牌基础套件输入校验（FR-011）：颜色、Logo、授权字体、语气、禁用表达。 */
export function validateBrandKitInput(body) {
  if (!isPlainObject(body)) throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  const name = shortText(body.name, 'name', { max: 60 });
  const palette = body.palette;
  if (!isPlainObject(palette)) throw new ApiError(422, 'INVALID_PALETTE', 'palette 必须为对象，包含 primary 与可选 secondary');
  if (typeof palette.primary !== 'string' || !HEX.test(palette.primary.trim())) {
    throw new ApiError(422, 'INVALID_PALETTE', 'palette.primary 必须为 #RRGGBB 主色');
  }
  const secondary = palette.secondary === undefined ? [] : palette.secondary;
  if (!Array.isArray(secondary)) throw new ApiError(422, 'INVALID_PALETTE', 'palette.secondary 必须为数组');
  if (secondary.length > 6) throw new ApiError(422, 'INVALID_PALETTE', 'palette.secondary 最多 6 个颜色');
  for (const [index, color] of secondary.entries()) {
    if (typeof color !== 'string' || !HEX.test(color.trim())) {
      throw new ApiError(422, 'INVALID_PALETTE', `palette.secondary[${index}] 必须为 #RRGGBB`);
    }
  }
  const logo = body.logo ?? { present: false };
  if (!isPlainObject(logo)) throw new ApiError(422, 'INVALID_LOGO', 'logo 必须为对象');
  if (typeof logo.present !== 'boolean') throw new ApiError(422, 'INVALID_LOGO', 'logo.present 必须为布尔值');
  const fonts = body.fonts ?? [];
  if (!Array.isArray(fonts)) throw new ApiError(422, 'INVALID_FONTS', 'fonts 必须为数组');
  if (fonts.length > 8) throw new ApiError(422, 'INVALID_FONTS', 'fonts 最多 8 个字体');
  const normalizedFonts = fonts.map((font, index) => {
    if (!isPlainObject(font)) throw new ApiError(422, 'INVALID_FONTS', `fonts[${index}] 必须为对象`);
    const fontName = shortText(font.name, `fonts[${index}].name`, { max: 60 });
    const license = font.license ?? 'unknown';
    if (!FONT_LICENSES.includes(license)) {
      throw new ApiError(422, 'INVALID_FONTS', `fonts[${index}].license 必须为 ${FONT_LICENSES.join(' / ')} 之一`);
    }
    return {
      name: fontName,
      license,
      license_ref: font.license_ref ? shortText(font.license_ref, `fonts[${index}].license_ref`, { max: 200 }) : null,
    };
  });
  const banned = body.banned_expressions ?? [];
  if (!Array.isArray(banned)) throw new ApiError(422, 'INVALID_BANNED_EXPRESSIONS', 'banned_expressions 必须为数组');
  if (banned.length > MAX_BANNED_EXPRESSIONS) {
    throw new ApiError(422, 'INVALID_BANNED_EXPRESSIONS', `禁用表达最多 ${MAX_BANNED_EXPRESSIONS} 条`);
  }
  const normalizedBanned = [...new Set(banned.map((item, index) => shortText(item, `banned_expressions[${index}]`, { max: 40 })))];
  return {
    name,
    palette: {
      primary: palette.primary.trim().toUpperCase(),
      secondary: [...new Set(secondary.map(color => color.trim().toUpperCase()))],
    },
    logo: {
      present: logo.present,
      ...(logo.asset_id ? { asset_id: shortText(logo.asset_id, 'logo.asset_id', { max: 80 }) } : {}),
      description: logo.description ? shortText(logo.description, 'logo.description', { max: 120 }) : null,
    },
    fonts: normalizedFonts,
    tone: body.tone ? shortText(body.tone, 'tone', { max: 120 }) : null,
    banned_expressions: normalizedBanned,
  };
}

/** 品牌套件版本内容哈希：只覆盖语义内容，不含时间与创建人。 */
export const brandKitContentHash = payload => sha({
  name: payload.name,
  palette: payload.palette,
  logo: payload.logo,
  fonts: payload.fonts,
  tone: payload.tone,
  banned_expressions: payload.banned_expressions,
});

const CLAIM_KEY = /功效|效果|卖点|适用|成分|规格|价格|容量/;

const isClaim = fact => CLAIM_KEY.test(fact.key);

const factValue = (facts, key) => {
  const name = key.replace(/^fact:/, '');
  return facts.find(fact => fact.key === name) ?? null;
};

/**
 * 冲突检测。每条冲突都标注"谁优先"，并只给出不违反平台硬约束的处理方式。
 * 处理方式为空表示当前无法满足规则，必须停下来改事实或换模板。
 */
export function detectConflicts({ template, brandKit, channel, truth, at }) {
  const conflicts = [];
  const mainImage = channel?.rule?.constraints?.main_image ?? null;
  const push = conflict => conflicts.push({ ...conflict, resolvable: conflict.options.length > 0 });

  for (const deliverable of template.deliverables) {
    const isMain = deliverable.type === 'main_image';
    if (!mainImage || !isMain) continue;

    if (mainImage.background === 'plain_white' && template.creative_direction.background !== 'plain_white') {
      push({
        key: `CHANNEL_PLAIN_WHITE_REQUIRED:${deliverable.id}`,
        code: 'CHANNEL_PLAIN_WHITE_REQUIRED',
        deliverable_id: deliverable.id,
        priority_winner: 'platform',
        message: `${channel.rule.platform}主图要求纯白背景，模板「${template.name}」的背景为 ${template.creative_direction.background}`,
        options: [
          { id: 'adopt_plain_white', label: '该交付物改用纯白背景（其他图保留模板方向）', effect: 'deliverable.background=plain_white' },
          { id: 'change_template', label: '换一个背景符合要求的模板', effect: 'requires_new_template' },
        ],
      });
    }

    if (mainImage.allow_text === false && deliverable.text_blocks.length > 0) {
      push({
        key: `CHANNEL_BANS_MAIN_TEXT:${deliverable.id}`,
        code: 'CHANNEL_BANS_MAIN_TEXT',
        deliverable_id: deliverable.id,
        priority_winner: 'platform',
        message: `${channel.rule.platform}主图不允许叠加文字，但该交付物引用了 ${deliverable.text_blocks.length} 处文字块`,
        options: [
          { id: 'drop_main_text', label: '该交付物不叠加任何文字（文字移到其他图）', effect: 'deliverable.text_blocks=[]' },
          { id: 'change_template', label: '换模板', effect: 'requires_new_template' },
        ],
      });
    }

    if (mainImage.allow_logo === false && brandKit?.logo?.present) {
      push({
        key: `CHANNEL_BANS_LOGO:${deliverable.id}`,
        code: 'CHANNEL_BANS_LOGO',
        deliverable_id: deliverable.id,
        priority_winner: 'platform',
        message: `${channel.rule.platform}主图不允许叠加品牌 Logo，而套件「${brandKit.name}」声明了 Logo`,
        options: [
          { id: 'omit_logo_on_main', label: '仅该交付物不叠 Logo（品牌约束让步，已记录）', effect: 'deliverable.logo=false' },
          { id: 'change_template', label: '换模板', effect: 'requires_new_template' },
        ],
      });
    }

    if (mainImage.ratio && deliverable.ratio !== mainImage.ratio) {
      push({
        key: `CHANNEL_ASPECT_MISMATCH:${deliverable.id}`,
        code: 'CHANNEL_ASPECT_MISMATCH',
        deliverable_id: deliverable.id,
        priority_winner: 'platform',
        message: `${channel.rule.platform}主图要求 ${mainImage.ratio} 比例，模板给的是 ${deliverable.ratio}`,
        options: [
          { id: 'adopt_channel_ratio', label: `按平台比例 ${mainImage.ratio} 输出`, effect: 'deliverable.ratio=channel' },
          { id: 'change_template', label: '换模板', effect: 'requires_new_template' },
        ],
      });
    }

    const minSide = mainImage.min_short_side;
    if (Number.isInteger(minSide) && Math.min(deliverable.width, deliverable.height) < minSide) {
      push({
        key: `CHANNEL_MIN_SIZE:${deliverable.id}`,
        code: 'CHANNEL_MIN_SIZE',
        deliverable_id: deliverable.id,
        priority_winner: 'platform',
        message: `${channel.rule.platform}主图最短边需 ≥ ${minSide}px，模板为 ${Math.min(deliverable.width, deliverable.height)}px`,
        options: [
          { id: 'adopt_channel_size', label: `提升到平台最小尺寸（短边 ${minSide}px）`, effect: 'deliverable.size=channel_min' },
        ],
      });
    }
  }

  // 品牌禁用表达 vs 商品事实：事实优先，只能记录品牌让步，不允许删改事实来迁就套件
  const banned = brandKit?.banned_expressions ?? [];
  if (banned.length > 0) {
    const texts = [
      ...truth.critical_text.map(item => ({ label: `关键文字「${item.text}」`, text: item.text })),
      ...truth.facts.map(fact => ({ label: `事实「${fact.key}=${fact.value}」`, text: `${fact.key}${fact.value}` })),
    ];
    for (const bannedText of banned) {
      const hit = texts.find(item => item.text.toLowerCase().includes(bannedText.toLowerCase()));
      if (!hit) continue;
      push({
        key: `BRAND_BANNED_TEXT:${bannedText}`,
        code: 'BRAND_BANNED_TEXT',
        deliverable_id: null,
        priority_winner: 'product_truth',
        message: `品牌套件禁用表达「${bannedText}」出现在${hit.label}中；商品事实优先级高于品牌约束`,
        options: [
          { id: 'record_brand_exception', label: '保留商品事实，记录品牌约束让步（不修改事实）', effect: 'provenance.brand_exceptions+=' },
        ],
      });
    }
  }

  // 关键文字超长：只能回到事实里改短，spec 不能替用户截断
  const maxChars = channel?.rule?.constraints?.text?.max_critical_text_chars;
  if (Number.isInteger(maxChars)) {
    for (const item of truth.critical_text) {
      if (item.text.length <= maxChars) continue;
      push({
        key: `CRITICAL_TEXT_TOO_LONG:${item.text}`,
        code: 'CRITICAL_TEXT_TOO_LONG',
        deliverable_id: null,
        priority_winner: 'platform',
        message: `关键文字「${item.text}」共 ${item.text.length} 字，超过${channel.rule.platform}上限 ${maxChars} 字`,
        options: [],
      });
    }
  }

  return conflicts;
}

/**
 * 应用处理方式并产出交付清单。返回的 deliverables 是快照内容，之后不再随配置变化。
 */
export function applyResolutions({ template, brandKit, channel, conflicts, resolutions }) {
  const deliverables = template.deliverables.map(item => ({
    id: item.id,
    type: item.type,
    label: item.label,
    required: item.required,
    count: item.count,
    ratio: item.ratio,
    width: item.width,
    height: item.height,
    formats: [...item.formats],
    text_blocks: [...item.text_blocks],
    note: item.note,
    background: template.creative_direction.background,
    logo_allowed: brandKit?.logo?.present === true,
    channel_adjusted: [],
  }));
  const applied = [];
  const pending = [];
  const unresolvable = [];
  const brandExceptions = [];

  for (const conflict of conflicts) {
    const choice = resolutions?.[conflict.key];
    if (!choice) {
      (conflict.options.length > 0 ? pending : unresolvable).push(conflict);
      continue;
    }
    const option = conflict.options.find(item => item.id === choice);
    if (!option) {
      throw new ApiError(422, 'INVALID_RESOLUTION', `冲突 ${conflict.code} 不支持处理方式 ${choice}`, {
        key: conflict.key,
        allowed: conflict.options.map(item => item.id),
      });
    }
    const target = conflict.deliverable_id
      ? deliverables.find(item => item.id === conflict.deliverable_id)
      : null;
    if (option.id === 'adopt_plain_white') target.background = 'plain_white';
    if (option.id === 'drop_main_text') target.text_blocks = [];
    if (option.id === 'omit_logo_on_main') target.logo_allowed = false;
    if (option.id === 'adopt_channel_ratio') target.ratio = channel.rule.constraints.main_image.ratio;
    if (option.id === 'adopt_channel_size') {
      const minSide = channel.rule.constraints.main_image.min_short_side;
      const scale = minSide / Math.min(target.width, target.height);
      if (scale > 1) {
        target.width = Math.round(target.width * scale);
        target.height = Math.round(target.height * scale);
      }
    }
    if (option.id === 'record_brand_exception') {
      brandExceptions.push({ expression: conflict.key.replace('BRAND_BANNED_TEXT:', ''), reason: conflict.message, recorded_at: null });
    }
    if (target && !target.channel_adjusted.includes(option.id)) target.channel_adjusted.push(option.id);
    applied.push({ key: conflict.key, code: conflict.code, option: option.id, priority_winner: conflict.priority_winner });
  }

  return { deliverables, applied, pending, unresolvable, brandExceptions };
}

/**
 * 无依据内容只做提示，绝不代写。卖点/功效/规格/价格来自用户输入时要求补证据（FR-014）。
 */
export function collectEvidenceGaps(truth) {
  return truth.facts
    .filter(fact => fact.source_type === 'user_input' && isClaim(fact))
    .map(fact => ({
      code: 'CLAIM_WITHOUT_EVIDENCE',
      fact_key: fact.key,
      message: `「${fact.key}」仅来自用户输入，没有素材依据；成品中不得据此扩写功效或规格表述，请补证据后再用`,
    }));
}

/** 交付清单里引用到不存在的事实键，视为模板与事实不匹配，必须显式暴露。 */
export function collectReferenceGaps(deliverables, truth) {
  const known = new Set(truth.facts.map(fact => `fact:${fact.key}`));
  const gaps = [];
  for (const deliverable of deliverables) {
    for (const block of deliverable.text_blocks) {
      if (block === 'critical_text') {
        if (truth.critical_text.length === 0) {
          gaps.push({ code: 'MISSING_CRITICAL_TEXT', deliverable_id: deliverable.id, message: `「${deliverable.label}」需要关键文字，但事实里没有关键文字` });
        }
        continue;
      }
      if (!block.startsWith('fact:')) continue;
      if (!known.has(block)) {
        gaps.push({
          code: 'FACT_REFERENCE_MISSING',
          deliverable_id: deliverable.id,
          message: `「${deliverable.label}」引用的事实「${block.slice(5)}」不存在，不会自动补写`,
        });
      }
    }
  }
  return gaps;
}

/**
 * 报价相关的清单哈希：只覆盖决定工作量与张数的结构（项数、必需、比例、尺寸、格式、文字块）。
 * 背景与 Logo 属于执行细节，记在快照里但不单独触发"重新报价"，避免加一个品牌套件就被要求重报价。
 */
export function deliverableHash(deliverables) {
  return sha(deliverables.map(item => ({
    id: item.id,
    required: item.required,
    count: item.count,
    ratio: item.ratio,
    width: item.width,
    height: item.height,
    formats: item.formats,
    text_blocks: item.text_blocks,
  })));
}

/** 组装一次 spec 的内容（不落库）。调用方负责 base_version 与租户校验。 */
export function assembleSpec({ project, truth, template, brandKit, channel, resolutions, textLayout = null, at = new Date() }) {
  const conflicts = detectConflicts({ template, brandKit, channel, truth, at });
  const { deliverables, applied, pending, unresolvable, brandExceptions } = applyResolutions({
    template, brandKit, channel, conflicts, resolutions,
  });

  const warnings = [];
  if (textLayout !== null) {
    const { x, y, width, size_ratio } = textLayout;
    if (![x, y, width, size_ratio].every(Number.isFinite) || x < 0 || y < 0 || x > 0.95 || y > 0.95 || width < 0.05 || x + width > 1 || size_ratio < 0.01 || size_ratio > 0.2) {
      throw new ApiError(422, 'INVALID_TEXT_LAYOUT', '排版位置和宽度需在画布内，字号比例需为 1%～20%');
    }
    for (const item of deliverables) item.text_layout = { x, y, width, size_ratio };
  }
  const coverage = channel?.coverage ?? COVERAGE.missing;
  for (const reason of channel?.reasons ?? []) warnings.push({ code: `CHANNEL_${coverage.toUpperCase()}`, message: reason });
  for (const font of brandKit?.fonts ?? []) {
    if (font.license !== 'licensed') {
      warnings.push({
        code: 'FONT_NOT_LICENSED',
        message: `字体「${font.name}」授权状态为 ${font.license}，未授权字体不得用于商用成品`,
      });
    }
  }
  if (channel?.status === 'review_due') {
    warnings.push({ code: 'CHANNEL_RULE_REVIEW_DUE', message: `平台规则 v${channel.rule.version} 即将到期复核，结论需在到期前复核` });
  }
  const evidenceGaps = collectEvidenceGaps(truth);
  const referenceGaps = collectReferenceGaps(deliverables, truth);
  for (const gap of evidenceGaps) warnings.push({ code: gap.code, message: gap.message });

  const platformCoverage = coverage === COVERAGE.covered && channel?.rule?.source?.verified === true
    ? 'verified'
    : 'unknown';

  return {
    template: {
      id: template.id,
      name: template.name,
      version: template.version,
      content_goal: template.content_goal,
      qa_profile: structuredClone(template.qa_profile),
      allowed_variations: [...template.allowed_variations],
      forbidden_changes: [...template.forbidden_changes],
      input_requirements: structuredClone(template.input_requirements),
      hash: sha({ id: template.id, version: template.version, deliverables: template.deliverables, creative: template.creative_direction }),
    },
    brand_kit: brandKit
      ? { id: brandKit.id, name: brandKit.name, version: brandKit.version, hash: brandKit.content_hash }
      : null,
    channel: {
      platform: channel?.rule?.platform ?? project.platform ?? null,
      rule_id: channel?.rule?.id ?? null,
      version: channel?.rule?.version ?? null,
      source: channel?.rule ? { ...channel.rule.source } : null,
      effective_at: channel?.rule?.effective_at ?? null,
      review_due_at: channel?.rule?.review_due_at ?? null,
      status: channel?.status ?? 'missing',
      coverage,
      coverage_reasons: [...(channel?.reasons ?? [])],
      platform_coverage: platformCoverage,
      can_claim_platform_compliance: platformCoverage === 'verified',
    },
    product_truth: { version: truth.version, content_hash: truth.content_hash },
    creative_direction: {
      ...structuredClone(template.creative_direction),
      logo_used: (brandKit?.logo?.present ?? false) && deliverables.some(item => item.logo_allowed),
    },
    deliverables,
    deliverable_hash: deliverableHash(deliverables),
    budget: {
      ...structuredClone(template.recommended_budget),
      note: '模板推荐预算，正式报价与有效期在 M05 生成；此处不作为可计费承诺',
    },
    provenance: {
      catalog_version: CATALOG_VERSION,
      spec_builder_version: SPEC_BUILDER_VERSION,
      template_id: template.id,
      template_version: template.version,
      brand_kit_id: brandKit?.id ?? null,
      brand_kit_version: brandKit?.version ?? null,
      channel_rule_id: channel?.rule?.id ?? null,
      channel_rule_version: channel?.rule?.version ?? null,
      resolutions: applied,
      brand_exceptions: brandExceptions,
    },
    conflicts: {
      total: conflicts.length,
      resolved: applied.length,
      pending: pending.map(item => ({ key: item.key, code: item.code, message: item.message, options: item.options })),
      unresolvable: unresolvable.map(item => ({ key: item.key, code: item.code, message: item.message, options: [] })),
    },
    gaps: {
      warnings,
      claims_without_evidence: evidenceGaps,
      missing_references: referenceGaps,
      unknown_rule_coverage: coverage !== COVERAGE.covered,
    },
  };
}

/** spec 内容哈希：覆盖装配结果与全部引用，保证"可重放其依据"。 */
export function specContentHash(payload) {
  return sha({
    template: payload.template,
    brand_kit: payload.brand_kit,
    channel: payload.channel,
    product_truth: payload.product_truth,
    creative_direction: payload.creative_direction,
    deliverables: payload.deliverables,
    deliverable_hash: payload.deliverable_hash,
    budget: payload.budget,
    provenance: payload.provenance,
    gaps: payload.gaps,
  });
}

/**
 * 快照有效性：只做计算，不改写旧快照。
 * 事实、品牌套件或平台规则任一变化，旧 spec 即为 stale，正式导出前必须复检。
 */
export function computeSpecValidity(spec, { truthVersion, brandKitVersion, channel, at = new Date() }) {
  const reasons = [];
  if (truthVersion !== spec.product_truth.version) {
    reasons.push(`商品事实已更新到 v${truthVersion}，快照引用 v${spec.product_truth.version}`);
  }
  if (spec.brand_kit) {
    if (brandKitVersion !== spec.brand_kit.version) {
      reasons.push(`品牌套件已更新到 v${brandKitVersion ?? '缺失'}，快照引用 v${spec.brand_kit.version}`);
    }
  }
  if (channel) {
    if (channel.status === 'expired') reasons.push(`平台规则 v${channel.rule.version} 已过复核日期，快照结论失效`);
    if (channel.status === 'not_effective') reasons.push(`平台规则 v${channel.rule.version} 尚未生效`);
    if (spec.channel.version && channel.rule.version !== spec.channel.version) {
      reasons.push(`平台规则已从 v${spec.channel.version} 更新到 v${channel.rule.version}`);
    }
  }
  return { validity: reasons.length === 0 ? 'current' : 'stale', reasons };
}

export const canonicalize = canonical;
