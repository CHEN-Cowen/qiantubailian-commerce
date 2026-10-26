/**
 * M04 目录：任务模板与平台规则的只读基线。
 *
 * 两个刻意的边界：
 * 1. 模板不是"一段 Prompt"，而是用途、交付清单、允许变化、输入要求、QA 档与推荐预算的集合（FR-010）。
 * 2. 平台规则必须带来源、适用类目、版本、生效与复核日期（FR-012）。本文件内置的是**内部演示基线**，
 *    source.verified 一律为 false —— 因此任何 spec 都不能声称"已通过平台审核"，只能说明覆盖情况。
 *    真实平台规则需要按版本导入并标注来源，届时把 verified 置真并补齐 url。
 */
export const CATALOG_VERSION = 'catalog-demo.1';

const DAY = 24 * 60 * 60 * 1000;

const TEMPLATES = [
  {
    id: 'tpl_listing_pack',
    name: '新品上架包',
    purpose: 'listing',
    version: 1,
    content_goal: 'listing',
    summary: '主图、卖点图、场景图与细节图，覆盖上架首屏与详情说服链路。',
    allowed_variations: ['background', 'lighting', 'props', 'composition', 'shadow'],
    forbidden_changes: ['商品主体形态', '包装文字与 Logo', '型号与规格参数'],
    input_requirements: [
      { code: 'subject_asset', label: '主体素材至少 1 张', required: true },
      { code: 'critical_fact', label: '至少 1 项已确认的关键商品事实', required: true },
      { code: 'critical_text', label: '包装关键文字（包装有文字时必填）', required: false },
    ],
    creative_direction: { background: 'scene', lighting: 'soft daylight', whitespace: '右侧留白 30%', camera: 'eye level' },
    qa_profile: { id: 'qa_listing_basic', version: 1, checks: ['file', 'dimensions', 'subject_identity', 'text_logo', 'brand', 'risk'] },
    recommended_budget: { max_credits: 24, max_attempts: 3, price_version: 'p1-draft' },
    deliverables: [
      {
        id: 'main', type: 'main_image', label: '主图 · 白底', required: true, count: 1,
        ratio: '1:1', width: 1200, height: 1200, formats: ['jpg', 'png'],
        text_blocks: [], note: '主体形态与包装文字以商品事实为准',
      },
      {
        id: 'benefit', type: 'selling_point', label: '卖点图', required: true, count: 1,
        ratio: '3:4', width: 1200, height: 1500, formats: ['jpg'],
        text_blocks: ['fact:核心卖点', 'critical_text'], note: '只允许引用已确认事实，不自动扩写功效',
      },
      {
        id: 'scene', type: 'scene_image', label: '场景图 · 晨间', required: true, count: 1,
        ratio: '3:4', width: 1200, height: 1500, formats: ['jpg'],
        text_blocks: [], note: '场景与光影可生成，主体不可改动',
      },
      {
        id: 'detail', type: 'detail_image', label: '细节图 · 材质', required: false, count: 1,
        ratio: '1:1', width: 1200, height: 1200, formats: ['jpg', 'png'],
        text_blocks: ['fact:成分'], note: '局部特写，需与包装事实一致',
      },
    ],
  },
  {
    id: 'tpl_ad_creative',
    name: '投放素材包',
    purpose: 'advertising',
    version: 1,
    content_goal: 'advertising',
    summary: '方图、竖版与横版三件套，用于信息流与开屏投放。',
    allowed_variations: ['background', 'lighting', 'props', 'copy_layout'],
    forbidden_changes: ['商品主体形态', '包装文字与 Logo', '价格与促销信息'],
    input_requirements: [
      { code: 'subject_asset', label: '主体素材至少 1 张', required: true },
      { code: 'critical_fact', label: '至少 1 项已确认的关键商品事实', required: true },
    ],
    creative_direction: { background: 'gradient_studio', lighting: 'hard rim light', whitespace: '上方留白 20%', camera: 'slightly low angle' },
    qa_profile: { id: 'qa_ad_basic', version: 1, checks: ['file', 'dimensions', 'subject_identity', 'text_logo', 'brand', 'risk', 'claim_evidence'] },
    recommended_budget: { max_credits: 18, max_attempts: 3, price_version: 'p1-draft' },
    deliverables: [
      {
        id: 'square', type: 'main_image', label: '方图 · 信息流', required: true, count: 1,
        ratio: '1:1', width: 1080, height: 1080, formats: ['jpg'],
        text_blocks: ['fact:核心卖点'], note: '文案只引用事实，禁止新增功效表述',
      },
      {
        id: 'vertical', type: 'ad_vertical', label: '竖版 · 开屏', required: true, count: 1,
        ratio: '9:16', width: 1080, height: 1920, formats: ['jpg', 'png'],
        text_blocks: ['critical_text'], note: '上下安全区各留 15%',
      },
      {
        id: 'landscape', type: 'ad_landscape', label: '横版 · 横幅', required: false, count: 1,
        ratio: '16:9', width: 1200, height: 628, formats: ['jpg'],
        text_blocks: ['fact:核心卖点'], note: '可选交付',
      },
    ],
  },
  {
    id: 'tpl_social_note',
    name: '社媒笔记',
    purpose: 'social',
    version: 1,
    content_goal: 'social',
    summary: '封面与内页图，用于内容种草与私域素材。',
    allowed_variations: ['background', 'lighting', 'props', 'composition', 'copy_layout'],
    forbidden_changes: ['商品主体形态', '包装文字与 Logo'],
    input_requirements: [
      { code: 'subject_asset', label: '主体素材至少 1 张', required: true },
      { code: 'critical_fact', label: '至少 1 项已确认的关键商品事实', required: true },
    ],
    creative_direction: { background: 'lifestyle', lighting: 'warm window light', whitespace: '下方留白 25%', camera: 'top down' },
    qa_profile: { id: 'qa_social_basic', version: 1, checks: ['file', 'dimensions', 'subject_identity', 'text_logo', 'risk'] },
    recommended_budget: { max_credits: 12, max_attempts: 3, price_version: 'p1-draft' },
    deliverables: [
      {
        id: 'cover', type: 'main_image', label: '笔记封面', required: true, count: 1,
        ratio: '3:4', width: 1080, height: 1440, formats: ['jpg'],
        text_blocks: ['fact:核心卖点'], note: '不写未经确认的功效',
      },
      {
        id: 'inner', type: 'social_inner', label: '内页图', required: false, count: 2,
        ratio: '1:1', width: 1080, height: 1080, formats: ['jpg'],
        text_blocks: [], note: '可选，最多 2 张',
      },
    ],
  },
];

/**
 * 平台规则基线。status 不写死，读取时按 effective_at / review_due_at 实时计算，
 * 避免"规则过期了但界面还在显示通过"。
 */
const CHANNEL_RULES = [
  {
    id: 'ch_tmall_listing',
    platform: '天猫',
    platform_aliases: ['天猫', 'tmall', '天猫旗舰店', '天猫商城'],
    categories: ['*'],
    version: '2026.03',
    source: { name: '内部演示基线（非平台官方条款）', url: null, verified: false },
    effective_at: '2026-03-01T00:00:00.000Z',
    review_due_at: '2027-03-01T00:00:00.000Z',
    constraints: {
      main_image: { background: 'plain_white', allow_text: false, allow_logo: false, min_short_side: 1200, ratio: '1:1' },
      text: { max_critical_text_chars: 12 },
      formats: ['jpg', 'png'],
    },
    notes: ['主图需纯白背景、无文字、无 Logo 叠加；尺寸按基线取 1200px 最短边'],
  },
  {
    id: 'ch_jd_listing',
    platform: '京东',
    platform_aliases: ['京东', 'jd', '京东自营', '京东商城'],
    categories: ['*'],
    version: '2026.01',
    source: { name: '内部演示基线（非平台官方条款）', url: null, verified: false },
    effective_at: '2026-01-15T00:00:00.000Z',
    review_due_at: '2026-11-15T00:00:00.000Z',
    constraints: {
      main_image: { background: 'plain_white', allow_text: false, allow_logo: true, min_short_side: 800, ratio: '1:1' },
      text: { max_critical_text_chars: 16 },
      formats: ['jpg', 'png'],
    },
    notes: ['主图允许右下角品牌 Logo，禁止促销文字'],
  },
  {
    id: 'ch_douyin_listing',
    platform: '抖音',
    platform_aliases: ['抖音', 'douyin', '抖音商城', '抖音小店'],
    categories: ['*'],
    version: '2025.11',
    source: { name: '内部演示基线（非平台官方条款）', url: null, verified: false },
    effective_at: '2025-11-01T00:00:00.000Z',
    review_due_at: '2026-09-01T00:00:00.000Z',
    constraints: {
      main_image: { background: 'any', allow_text: true, allow_logo: true, min_short_side: 600, ratio: '3:4' },
      text: { max_critical_text_chars: 20 },
      formats: ['jpg', 'png', 'webp'],
    },
    notes: ['竖版优先，允许场景化背景与文字；该基线复核日期已过，读取时应显示需复核'],
  },
];

export const REVIEW_SOON_DAYS = 30;

export const COVERAGE = Object.freeze({
  covered: 'covered',
  category_missing: 'category_missing',
  expired: 'expired',
  not_effective: 'not_effective',
  missing: 'missing',
});

export const listTemplates = () => TEMPLATES.map(template => ({
  id: template.id,
  name: template.name,
  purpose: template.purpose,
  version: template.version,
  content_goal: template.content_goal,
  summary: template.summary,
  deliverable_count: template.deliverables.length,
  required_deliverable_count: template.deliverables.filter(item => item.required).length,
  recommended_budget: { ...template.recommended_budget },
  allowed_variations: [...template.allowed_variations],
}));

export const getTemplate = id => {
  const template = TEMPLATES.find(item => item.id === id);
  return template ? structuredClone(template) : null;
};

export const listChannelRules = () => CHANNEL_RULES.map(rule => ({
  id: rule.id,
  platform: rule.platform,
  version: rule.version,
  source: { ...rule.source },
  effective_at: rule.effective_at,
  review_due_at: rule.review_due_at,
  categories: [...rule.categories],
  constraints: structuredClone(rule.constraints),
  notes: [...rule.notes],
}));

const normalize = value => String(value ?? '').trim().toLowerCase();

/** 规则有效期状态：current / review_due / expired / not_effective。 */
export function ruleStatus(rule, at = new Date()) {
  const now = at.getTime();
  const effective = Date.parse(rule.effective_at);
  const reviewDue = Date.parse(rule.review_due_at);
  if (now < effective) return { status: 'not_effective', days_to_review: null };
  if (now >= reviewDue) return { status: 'expired', days_to_review: Math.floor((now - reviewDue) / DAY) };
  const remaining = Math.ceil((reviewDue - now) / DAY);
  return { status: remaining <= REVIEW_SOON_DAYS ? 'review_due' : 'current', days_to_review: remaining };
}

/**
 * 按平台与类目匹配规则，并给出覆盖结论。
 * 覆盖不足不等于"平台不通过"，而是"我们无法据此声称平台通过"（AC-13）。
 */
export function matchChannelRule({ platform, category, at = new Date() } = {}) {
  const wanted = normalize(platform);
  if (!wanted) return { rule: null, status: 'missing', coverage: COVERAGE.missing, reasons: ['未选择目标平台，无法匹配平台规则'] };
  const rule = CHANNEL_RULES.find(item => item.platform_aliases.some(alias => normalize(alias) === wanted));
  if (!rule) {
    return { rule: null, status: 'missing', coverage: COVERAGE.missing, reasons: [`未收录「${platform}」的平台规则，无法声称平台通过`] };
  }
  const { status, days_to_review } = ruleStatus(rule, at);
  const categories = rule.categories.map(normalize);
  const categoryCovered = categories.includes('*') || categories.includes(normalize(category));
  const detail = {
    rule: structuredClone(rule),
    status,
    days_to_review,
    category_covered: categoryCovered,
    reasons: [],
  };
  if (status === 'not_effective') {
    detail.coverage = COVERAGE.not_effective;
    detail.reasons.push(`规则 v${rule.version} 尚未生效（生效日 ${rule.effective_at.slice(0, 10)}）`);
  } else if (status === 'expired') {
    detail.coverage = COVERAGE.expired;
    detail.reasons.push(`规则 v${rule.version} 已过复核日期 ${rule.review_due_at.slice(0, 10)}（逾期 ${days_to_review} 天），结论需复核`);
  } else if (!categoryCovered) {
    detail.coverage = COVERAGE.category_missing;
    detail.reasons.push(`规则 v${rule.version} 未覆盖类目「${category}」`);
  } else {
    detail.coverage = COVERAGE.covered;
    if (status === 'review_due') detail.reasons.push(`规则 v${rule.version} 将在 ${days_to_review} 天后到期复核`);
  }
  if (!rule.source.verified) detail.reasons.push('规则来源为内部演示基线，未经官方条款核验，不能声称平台审核通过');
  return detail;
}
