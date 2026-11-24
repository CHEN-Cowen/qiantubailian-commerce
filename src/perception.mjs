/**
 * M-V1 消费者感知方向：七类一级方向的唯一真源 + 确定性推荐规则 + 方案卡装配。
 *
 * 三条边界：
 * 1. 七类方向是**产品内部语义分类**，不是学术分类，也不是固定设计风格。
 *    它们只用于把"用户想要什么感觉"翻译成"往哪个方向做图"，不直接等于 Prompt。
 * 2. 推荐是**确定性规则**，不是 AI 分析。同一输入永远得到同一结果，每条理由都能在
 *    HINT 表里查到出处。UI 不得把这套结果描述成"AI 已分析你的商品图"。
 * 3. 品类只是**弱信号**（+1），卖点关键词与价格定位才是强信号（+2）。
 *    刻意不给品类与方向做一对一硬映射：同一品类换个卖点，首选方向应当能翻转。
 *    信号不足时降置信度并显式返回 missing_inputs，由用户自己选，不假装确定。
 */

export const PERCEPTION_VERSION = 'perception.1';
export const STYLE_REF_MANIFEST_VERSION = 'style-ref.1';

/** 置信度：high 有明确领先信号 / medium 有信号但接近 / low 基本没信号。 */
export const CONFIDENCE = Object.freeze({ high: 'high', medium: 'medium', low: 'low' });

const goal = (key, name, summary, tags) => Object.freeze({ key, name, summary, tags: Object.freeze(tags) });

export const PERCEPTION_GOALS = Object.freeze([
  goal('quality_premium', '品质与档次', '看起来更贵一点，做工和细节经得起近看', ['精致', '高级', '奢华', '优雅']),
  goal('professional_trust', '专业与可信', '让人觉得靠谱、专业、可以放心买', ['专业', '严谨', '安全', '可靠']),
  goal('natural_comfort', '自然与舒适', '干净、自然、看着舒服，没有压迫感', ['清新', '纯净', '健康', '温暖']),
  goal('emotion_lifestyle', '情绪与生活方式', '有情绪和氛围，像某个具体的生活瞬间', ['浪漫', '治愈', '松弛', '时尚']),
  goal('vital_innovation', '活力与创新', '年轻、有劲、有点新鲜感', ['年轻', '潮流', '科技', '运动']),
  goal('practical_value', '实用与高性价比', '实在、耐用，一眼看出买得值', ['实惠', '耐用', '实用', '划算']),
  goal('culture_heritage', '文化与传承', '有年头、有手艺，带点文化底色', ['传统', '匠心', '经典', '文化']),
]);

export const PERCEPTION_KEYS = Object.freeze(PERCEPTION_GOALS.map(item => item.key));

const GOAL_BY_KEY = new Map(PERCEPTION_GOALS.map(item => [item.key, item]));

/** 权重：关键词与价格是强信号，品类与用途只做微调。改这里必须同步改测试的覆盖断言。 */
export const WEIGHTS = Object.freeze({ category: 1, keyword: 2, price: 2, purpose: 1 });

/**
 * 品类倾向：只给"更可能"的方向，不给唯一答案。
 * 不在表里的品类不报错，只是不贡献分数（并计入 missing_inputs）。
 */
const CATEGORY_HINTS = Object.freeze({
  香氛: ['quality_premium', 'natural_comfort', 'emotion_lifestyle'],
  香水: ['quality_premium', 'emotion_lifestyle', 'natural_comfort'],
  香薰: ['natural_comfort', 'emotion_lifestyle', 'quality_premium'],
  美妆: ['quality_premium', 'natural_comfort', 'professional_trust'],
  护肤: ['natural_comfort', 'quality_premium', 'professional_trust'],
  食品: ['natural_comfort', 'practical_value', 'culture_heritage'],
  零食: ['emotion_lifestyle', 'practical_value', 'natural_comfort'],
  咖啡: ['quality_premium', 'culture_heritage', 'emotion_lifestyle'],
  茶: ['culture_heritage', 'natural_comfort', 'quality_premium'],
  家电: ['professional_trust', 'practical_value', 'vital_innovation'],
  厨电: ['professional_trust', 'practical_value', 'vital_innovation'],
  清洁: ['professional_trust', 'practical_value', 'natural_comfort'],
  服饰: ['vital_innovation', 'quality_premium', 'emotion_lifestyle'],
  鞋: ['vital_innovation', 'practical_value', 'quality_premium'],
  运动: ['vital_innovation', 'professional_trust', 'practical_value'],
  数码: ['vital_innovation', 'professional_trust', 'practical_value'],
  母婴: ['professional_trust', 'natural_comfort', 'practical_value'],
  家居: ['natural_comfort', 'quality_premium', 'emotion_lifestyle'],
  家纺: ['natural_comfort', 'quality_premium', 'practical_value'],
  礼品: ['culture_heritage', 'quality_premium', 'emotion_lifestyle'],
  文创: ['culture_heritage', 'emotion_lifestyle', 'quality_premium'],
});

/**
 * 卖点关键词：命中即加分。关键词来自商家自己填写的卖点/说明原文，不改写、不扩写。
 * 同一段文字同时命中两个方向是正常语义重叠（如「手工」偏品质、「非遗」偏文化），
 * 不做互斥，也不替用户猜。
 */
const KEYWORD_HINTS = Object.freeze([
  { pattern: /精致|高级|奢华|质感|真皮|手工|限定|轻奢/i, key: 'quality_premium' },
  { pattern: /专业|认证|检测|安全|正品|医用|无菌|标准/i, key: 'professional_trust' },
  { pattern: /天然|有机|无添加|植物|纯棉|透气|温和|不刺激/i, key: 'natural_comfort' },
  { pattern: /浪漫|治愈|氛围|仪式感|松弛|陪伴|温柔/i, key: 'emotion_lifestyle' },
  { pattern: /科技|智能|潮流|联名|运动|年轻|新品|首发/i, key: 'vital_innovation' },
  { pattern: /实惠|耐用|大容量|性价比|囤货|划算|省钱/i, key: 'practical_value' },
  { pattern: /传统|非遗|匠心|古法|经典|老字号|手工技艺/i, key: 'culture_heritage' },
]);

/** 价格定位：只认商家确认过的定位原文，未填不计分。 */
const PRICE_HINTS = Object.freeze({
  高端: ['quality_premium'],
  轻奢: ['quality_premium'],
  中高端: ['quality_premium', 'natural_comfort'],
  中端: ['natural_comfort', 'practical_value'],
  大众: ['practical_value'],
  平价: ['practical_value'],
  入门: ['practical_value', 'vital_innovation'],
});

/** 用途倾向：主图不参与审美倾向（突出主体是产品保证，不是偏好）。 */
const PURPOSE_HINTS = Object.freeze({
  listing: [],
  advertising: ['vital_innovation', 'quality_premium'],
  social: ['emotion_lifestyle', 'natural_comfort'],
});

const normalize = value => String(value ?? '').trim();

/**
 * 品类命中方向：先精确匹配，再按分隔符拆开逐个匹配。
 *
 * 向导里的品类是粗分类（「美妆/护肤」「家居/日用」），档案里可能是细分类（「香氛」「面霜」）。
 * 两种都要认，否则用户选了品类却拿不到任何信号，推荐会整体退化成低置信。
 * 拆分后多个子类命中时合并去重，不做优先级取舍——品类本来就是弱信号。
 */
function categoryHintsFor(category) {
  const raw = normalize(category);
  if (!raw) return [];
  const direct = CATEGORY_HINTS[raw];
  if (direct) return direct;
  const parts = raw.split(/[/、,，\s]+/).filter(Boolean);
  if (parts.length < 2) return [];
  const merged = [];
  for (const part of parts) {
    for (const key of CATEGORY_HINTS[part] ?? []) {
      if (!merged.includes(key)) merged.push(key);
    }
  }
  return merged;
}

/**
 * 把各种形态的输入收成一段可匹配文本。
 * 兼容三种真实形态：字符串、字符串数组、商品事实数组（{key,label,value,unit}）。
 * 不做任何改写——只拼接，避免"帮用户补卖点"。
 */
function collectText(...values) {
  const parts = [];
  const walk = value => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) parts.push(trimmed);
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      const label = normalize(value.key ?? value.label);
      const text = normalize(value.value);
      const unit = normalize(value.unit);
      const merged = [label, text, unit].filter(Boolean).join(' ');
      if (merged) parts.push(merged);
    }
  };
  values.forEach(walk);
  return parts.join(' ');
}

/** 推荐与解释共用同一份信号文本，避免两处逻辑漂移。 */
const signalText = input => collectText(input.selling_points, input.description, input.notes, input.facts);

/** 按 key 取方向定义，未知返回 null（不抛错，调用方决定如何降级）。 */
export function getPerception(key) {
  const item = GOAL_BY_KEY.get(normalize(key));
  return item ? { ...item, tags: [...item.tags] } : null;
}

/** 全部方向（深拷贝，避免调用方改到唯一真源）。 */
export const listPerceptions = () => PERCEPTION_GOALS.map(item => ({ ...item, tags: [...item.tags] }));

/**
 * 逐条说明某个方向为什么被推荐——规则可复现，便于用户质疑和产品排查。
 * 返回空数组表示该方向没有任何信号支撑：此时不应展示为"推荐"，只能作为"其他可选"。
 */
export function explainDirection(key, input = {}) {
  const reasons = [];
  const category = normalize(input.category);
  const purpose = normalize(input.purpose);
  const price = normalize(input.price_positioning);
  const text = signalText(input);

  if (categoryHintsFor(category).includes(key)) reasons.push(`品类「${category}」常见这个方向`);

  for (const { pattern, key: hitKey } of KEYWORD_HINTS) {
    if (hitKey !== key) continue;
    const matched = text.match(pattern)?.[0];
    if (matched) { reasons.push(`卖点里提到「${matched}」`); break; }
  }

  if (PRICE_HINTS[price]?.includes(key)) reasons.push(`价格定位是「${price}」`);
  if (PURPOSE_HINTS[purpose]?.includes(key)) reasons.push(`本次用途是「${purpose}」`);

  return reasons;
}

/**
 * 推荐 2–3 个候选方向。
 *
 * 不返回"唯一答案"：即使首选分数明显领先，也仍然给出备选——用户可能就是不想要那个方向。
 * 分数全为 0 时返回枚举前 limit 个并标 low，不返回空数组（空数组会让前端无处可走）。
 */
export function recommendPerceptions(input = {}, { limit = 3 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > PERCEPTION_KEYS.length) {
    throw new RangeError('limit 必须是 1 到 ' + PERCEPTION_KEYS.length + ' 之间的整数');
  }

  const category = normalize(input.category);
  const purpose = normalize(input.purpose);
  const price = normalize(input.price_positioning);
  const text = signalText(input);
  const categoryHints = categoryHintsFor(category);

  const scored = PERCEPTION_KEYS.map(key => {
    let score = 0;
    const matched = [];
    if (categoryHints.includes(key)) { score += WEIGHTS.category; matched.push('category'); }
    if (KEYWORD_HINTS.some(({ pattern, key: hitKey }) => hitKey === key && pattern.test(text))) {
      score += WEIGHTS.keyword; matched.push('keyword');
    }
    if (PRICE_HINTS[price]?.includes(key)) { score += WEIGHTS.price; matched.push('price'); }
    if (PURPOSE_HINTS[purpose]?.includes(key)) { score += WEIGHTS.purpose; matched.push('purpose'); }
    return { key, score, matched };
  });

  // 稳定排序：分数相同时按枚举顺序（不依赖运行时排序实现，保证幂等）。
  const ordered = scored
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const picked = ordered.slice(0, limit);
  const topScore = picked[0]?.score ?? 0;
  const runnerUp = picked[1]?.score ?? 0;
  const nextScore = ordered[limit]?.score ?? 0;

  let confidence = CONFIDENCE.low;
  if (topScore === 0) confidence = CONFIDENCE.low;
  else if (topScore >= 2 * WEIGHTS.keyword && topScore - Math.max(runnerUp, nextScore) > 0) confidence = CONFIDENCE.high;
  else if (topScore >= WEIGHTS.keyword) confidence = CONFIDENCE.medium;

  const missing = [];
  if (!category) missing.push('category');
  else if (categoryHints.length === 0) missing.push('category_unrecognized');
  if (!text) missing.push('selling_points');
  if (!price) missing.push('price_positioning');
  if (!purpose) missing.push('purpose');

  const candidates = picked.map(item => {
    const definition = GOAL_BY_KEY.get(item.key);
    return {
      key: item.key,
      name: definition.name,
      summary: definition.summary,
      tags: [...definition.tags],
      score: item.score,
      signals: [...item.matched],
      reasons: explainDirection(item.key, input),
      reference: styleReference(item.key, category),
    };
  });

  return {
    version: PERCEPTION_VERSION,
    candidates,
    confidence,
    basis: {
      category: category || null,
      purpose: purpose || null,
      price_positioning: price || null,
      selling_points_present: Boolean(text),
    },
    missing_inputs: missing,
    // 明确写给调用方与 UI 的边界：不要把这句改写成人格化的"AI 判断"。
    rule_note: '按商品档案里的品类、卖点、价格定位与本次用途匹配，未分析商品图片。',
  };
}

/**
 * 参考图路径约定：assets/style-refs/{方向}/{序号}.jpg
 *
 * 路径**不含品类名**：中文文件名进 URL 需要额外编码，静态白名单与本地文件读取都容易出错。
 * 品类只作为元数据返回，真实文件路径以 manifest 的 file 字段为准。
 * 本函数只生成期望路径与核验状态，不读文件——素材是否到位由前端按 manifest 判定。
 */
export function styleReference(perceptionKey, category, index = 1) {
  const definition = GOAL_BY_KEY.get(normalize(perceptionKey));
  if (!definition) return null;
  const safeIndex = Number.isInteger(index) && index > 0 ? index : 1;
  const cat = normalize(category) || 'generic';
  return {
    manifest: STYLE_REF_MANIFEST_VERSION,
    perception: definition.key,
    category: cat,
    path: `assets/style-refs/${definition.key}/${safeIndex}.jpg`,
    // 未核验 ≠ 有图。前端必须按 manifest 确认后才展示，禁止拿占位图冒充。
    status: 'unverified',
  };
}

/**
 * 方案卡装配：把推荐结果整理成前端直接可渲染的结构。
 * 只做数据整形，不含样式或文案发挥；严格区分"规则推荐"与"用户已确认"。
 */
export function buildDirectionCards(recommendation, { limit = 3 } = {}) {
  if (!recommendation || !Array.isArray(recommendation.candidates)) {
    throw new TypeError('buildDirectionCards 需要 recommendPerceptions 的返回值');
  }
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit 必须是正整数');
  const cards = recommendation.candidates.slice(0, limit).map((candidate, index) => ({
    order: index + 1,
    key: candidate.key,
    name: candidate.name,
    summary: candidate.summary,
    tags: [...candidate.tags],
    reasons: [...candidate.reasons],
    reference: candidate.reference,
    // 方向内的两个确定性变体（M-V3）：A 案与方向默认策略一致，B 案是差异化备选。
    schemes: schemesForDirection(candidate.key),
    // 有信号的才是"推荐"；0 分只是兜底展示（让用户有得选），不能标成推荐。
    // 用户点选后才变成 user_confirmed，三者不得混用。
    source: candidate.score > 0 ? 'recommended' : 'fallback',
  }));
  return {
    version: PERCEPTION_VERSION,
    confidence: recommendation.confidence,
    cards,
    rule_note: recommendation.rule_note,
    missing_inputs: [...recommendation.missing_inputs],
  };
}

/** 供前端判断"是否值得先问用户补信息"：信号太弱时先补输入，比硬推三个方向更诚实。 */
export const needsMoreInput = recommendation => (
  recommendation?.confidence === CONFIDENCE.low && recommendation.missing_inputs.length > 0
);

// ---------- M-V2：感知方向 → 可视化策略 ----------

/** 背景只能落在既有四个枚举内：新增背景类型会连带改平台规则与验收口径，不在本模块扩张。 */
export const BACKGROUNDS = Object.freeze(['plain_white', 'gradient_studio', 'scene', 'lifestyle']);
export const COLOR_SATURATION = Object.freeze(['low', 'medium', 'high']);
export const COLOR_BRIGHTNESS = Object.freeze(['low', 'medium', 'high']);
export const COLOR_TONES = Object.freeze(['neutral', 'warm_neutral', 'natural', 'warm', 'cool', 'deep']);

/**
 * 方向 → 视觉参数。把"想要什么感觉"翻译成执行层能用的背景/光线/留白/机位/氛围/色彩。
 *
 * 刻意不做的事：
 * - 不定义文字排版（text_layout）。交付里要不要文字由模板的 text_blocks 与文字层决定，
 *   在视觉策略里再放一份会变成两套真源，冲突时无法判断谁说了算。
 * - 不定义道具数量。场景道具由 scene-direction 模块按既有选项决定，避免两处同时下指令。
 * - 不改商品事实相关项。这里全部是环境与光线，不涉及主体、包装、颜色本体。
 */
const VISUAL_STRATEGY = Object.freeze({
  quality_premium: Object.freeze({
    background: 'gradient_studio',
    lighting: 'soft studio light',
    whitespace: '上方留白 20%',
    camera: 'eye level',
    atmosphere: '优雅、克制',
    color: Object.freeze({ saturation: 'low', brightness: 'high', tone: 'warm_neutral' }),
  }),
  professional_trust: Object.freeze({
    background: 'plain_white',
    lighting: 'soft studio light',
    whitespace: '居中对称',
    camera: 'eye level',
    atmosphere: '干净、严谨',
    color: Object.freeze({ saturation: 'low', brightness: 'high', tone: 'neutral' }),
  }),
  natural_comfort: Object.freeze({
    background: 'scene',
    lighting: 'soft daylight',
    whitespace: '右侧留白 30%',
    camera: 'eye level',
    atmosphere: '自然、通透',
    color: Object.freeze({ saturation: 'low', brightness: 'high', tone: 'natural' }),
  }),
  emotion_lifestyle: Object.freeze({
    background: 'lifestyle',
    lighting: 'warm window light',
    whitespace: '下方留白 25%',
    camera: 'slightly low angle',
    atmosphere: '温暖、有故事',
    color: Object.freeze({ saturation: 'medium', brightness: 'medium', tone: 'warm' }),
  }),
  vital_innovation: Object.freeze({
    background: 'gradient_studio',
    lighting: 'hard rim light',
    whitespace: '居中',
    camera: 'slightly low angle',
    atmosphere: '有劲、利落',
    color: Object.freeze({ saturation: 'high', brightness: 'high', tone: 'cool' }),
  }),
  practical_value: Object.freeze({
    background: 'plain_white',
    lighting: 'soft daylight',
    whitespace: '居中',
    camera: 'top down',
    atmosphere: '清楚、实在',
    color: Object.freeze({ saturation: 'medium', brightness: 'high', tone: 'neutral' }),
  }),
  culture_heritage: Object.freeze({
    background: 'scene',
    lighting: 'soft daylight',
    whitespace: '右侧留白 30%',
    camera: 'eye level',
    atmosphere: '沉静、有年头',
    color: Object.freeze({ saturation: 'low', brightness: 'medium', tone: 'deep' }),
  }),
});

/**
 * 方案卡（M-V3）：每个方向两个确定性变体，供用户在方向内二次比较。
 * A 案 = 该方向的默认策略（与 resolveVisualStrategy 逐字段一致）；B 案 = 差异化备选。
 * 边界：
 * - lighting/whitespace 在用户选定方案后作为"用户明确确认值"覆盖模板默认（用户明确选择 > 模板默认）；
 * - background 只用于预选背景 chip 与方案展示，最终背景仍由模板决定，平台纯白约束在 spec 冲突层处理；
 * - refIndex 指向 manifest 里该方向的第几张参考图（由前端按 manifest 解析实际文件，缺图走空态）；
 * - 不定义道具与文字排版，理由同 VISUAL_STRATEGY。
 */
export const SCHEMES = Object.freeze({
  quality_premium: Object.freeze([
    Object.freeze({ id: 'quality_premium.a', perception: 'quality_premium', name: '影棚质感', refIndex: 1, background: 'gradient_studio', lighting: 'soft studio light', whitespace: '上方留白 20%', summary: '渐变影棚背景，突出材质与轮廓', reason: '最常见的质感表达，多数商品都适用' }),
    Object.freeze({ id: 'quality_premium.b', perception: 'quality_premium', name: '极简白底', refIndex: 2, background: 'plain_white', lighting: 'soft even light', whitespace: '居中对称', summary: '干净白底，高级感靠细节与留白', reason: '更克制，适合包装本身已经精致的商品' }),
  ]),
  professional_trust: Object.freeze([
    Object.freeze({ id: 'professional_trust.a', perception: 'professional_trust', name: '标准白底', refIndex: 1, background: 'plain_white', lighting: 'soft studio light', whitespace: '居中对称', summary: '均匀棚灯，规规矩矩交代商品', reason: '检测报告式的克制，最让人放心' }),
    Object.freeze({ id: 'professional_trust.b', perception: 'professional_trust', name: '冷静深调', refIndex: 2, background: 'gradient_studio', lighting: 'soft side light', whitespace: '居中', summary: '深色影棚渐变，突出精密与专业', reason: '适合器械、工具类，深色环境更显可靠' }),
  ]),
  natural_comfort: Object.freeze([
    Object.freeze({ id: 'natural_comfort.a', perception: 'natural_comfort', name: '自然场景', refIndex: 1, background: 'scene', lighting: 'soft daylight', whitespace: '右侧留白 30%', summary: '白天自然光下的真实场景', reason: '最直接的自然感，绿植与光线都真实' }),
    Object.freeze({ id: 'natural_comfort.b', perception: 'natural_comfort', name: '清晨桌面', refIndex: 2, background: 'lifestyle', lighting: 'morning window light', whitespace: '下方留白 25%', summary: '把产品放进生活桌面，日常可用感', reason: '生活方式场景，更贴近使用时刻' }),
  ]),
  emotion_lifestyle: Object.freeze([
    Object.freeze({ id: 'emotion_lifestyle.a', perception: 'emotion_lifestyle', name: '暖光日常', refIndex: 1, background: 'lifestyle', lighting: 'warm window light', whitespace: '下方留白 25%', summary: '暖调窗光下的居家氛围', reason: '温暖治愈，适合香氛、织物质感' }),
    Object.freeze({ id: 'emotion_lifestyle.b', perception: 'emotion_lifestyle', name: '晨光卧室', refIndex: 2, background: 'scene', lighting: 'soft morning light', whitespace: '右侧留白 30%', summary: '清晨卧室的松弛感，更清新', reason: '氛围更轻，适合清爽型商品' }),
  ]),
  vital_innovation: Object.freeze([
    Object.freeze({ id: 'vital_innovation.a', perception: 'vital_innovation', name: '动感渐变', refIndex: 1, background: 'gradient_studio', lighting: 'hard rim light', whitespace: '居中', summary: '高饱和渐变加硬轮廓光，最有劲', reason: '运动、饮品类的经典张力表达' }),
    Object.freeze({ id: 'vital_innovation.b', perception: 'vital_innovation', name: '科技冷调', refIndex: 2, background: 'gradient_studio', lighting: 'cool rim light', whitespace: '居中', summary: '冷色轮廓光，科技感更强更克制', reason: '数码、智能品类更适合冷调' }),
  ]),
  practical_value: Object.freeze([
    Object.freeze({ id: 'practical_value.a', perception: 'practical_value', name: '清晰白底', refIndex: 1, background: 'plain_white', lighting: 'soft daylight', whitespace: '居中', summary: '白底均匀光，看得一清二楚', reason: '把商品交代清楚就是最大的实惠感' }),
    Object.freeze({ id: 'practical_value.b', perception: 'practical_value', name: '场景陈列', refIndex: 2, background: 'scene', lighting: 'soft daylight', whitespace: '下方留白 25%', summary: '收纳场景陈列，容量组合看得清', reason: '套装、多件商品放场景里更显得划算' }),
  ]),
  culture_heritage: Object.freeze([
    Object.freeze({ id: 'culture_heritage.a', perception: 'culture_heritage', name: '案头茶席', refIndex: 1, background: 'scene', lighting: 'soft daylight', whitespace: '右侧留白 30%', summary: '木案与茶席，沉静有年头', reason: '传统器物的经典表达' }),
    Object.freeze({ id: 'culture_heritage.b', perception: 'culture_heritage', name: '素壁展陈', refIndex: 2, background: 'scene', lighting: 'soft side light', whitespace: '居中对称', summary: '素墙侧光，像博物馆展陈', reason: '更突出器型与釉色，适合精致工艺' }),
  ]),
});

/** 某个方向的方案列表；未知方向返回空数组（调用方决定怎么提示），不猜默认值。 */
export function schemesForDirection(perceptionKey) {
  const schemes = SCHEMES[normalize(perceptionKey)];
  return schemes ? schemes.map(scheme => ({ ...scheme })) : [];
}

/** 按方案 id 查找；找不到或方向对不上都返回 null，由调用方明确拒绝。 */
export function findScheme(schemeId) {
  if (typeof schemeId !== 'string') return null;
  for (const schemes of Object.values(SCHEMES)) {
    const found = schemes.find(scheme => scheme.id === schemeId);
    if (found) return { ...found };
  }
  return null;
}

/**
 * 解析某个感知方向对应的可视化策略。
 * 未知方向返回 null，不猜一个默认值——调用方必须自己决定是报错还是回退到模板原有方向。
 */
export function resolveVisualStrategy(perceptionKey) {
  const key = normalize(perceptionKey);
  const strategy = VISUAL_STRATEGY[key];
  if (!strategy) return null;
  return {
    perception: key,
    // 只返回 creative_direction 需要的那部分，字段名与既有 spec 保持兼容。
    creative_direction: {
      background: strategy.background,
      lighting: strategy.lighting,
      whitespace: strategy.whitespace,
      camera: strategy.camera,
      atmosphere: strategy.atmosphere,
      color: { ...strategy.color },
    },
  };
}

/** 校验外部传入的视觉策略片段（如从前端回传），非法值明确拒绝而不是静默丢弃。 */
export function validateVisualStrategy(patch = {}) {
  const problems = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('视觉策略必须是对象');
  }
  if (patch.background !== undefined && !BACKGROUNDS.includes(patch.background)) {
    problems.push(`background 只能是 ${BACKGROUNDS.join(' / ')}`);
  }
  for (const key of ['lighting', 'whitespace', 'camera', 'atmosphere']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'string') problems.push(`${key} 必须是字符串`);
  }
  if (patch.color !== undefined) {
    const color = patch.color;
    if (!color || typeof color !== 'object' || Array.isArray(color)) {
      problems.push('color 必须是对象');
    } else {
      if (!COLOR_SATURATION.includes(color.saturation)) problems.push(`color.saturation 只能是 ${COLOR_SATURATION.join(' / ')}`);
      if (!COLOR_BRIGHTNESS.includes(color.brightness)) problems.push(`color.brightness 只能是 ${COLOR_BRIGHTNESS.join(' / ')}`);
      if (!COLOR_TONES.includes(color.tone)) problems.push(`color.tone 只能是 ${COLOR_TONES.join(' / ')}`);
    }
  }
  return problems;
}
