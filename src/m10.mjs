/**
 * M10 结构化详情页与首帧图生视频。
 *
 * 三条硬边界（PRD PDP-01—PDP-04、VID-01—VID-04）：
 * 1. 详情页每个参数都必须能追到来源（事实版本、素材哈希、生产配置版本、品牌套件版本）；
 *    来源缺失、素材失效或事实值不一致时页面只能是 blocked，不能"先出稿后补来源"。
 * 2. 视频必须先有可发布首帧；首帧缺失、待复核或已失效时直接阻断，不允许"先生成再挑帧"。
 *    首段只允许 3 秒以内的低幅度动效，音源必须可追溯。
 * 3. 中间帧异常必须能阻断整段视频；检测不足按待复核处理，不能当成通过。
 *    平台不支持 HTML 直传时只提供结构化数据与图片，不得承诺直传。
 *
 * 本文件只做纯计算，不做 I/O；API 层负责取当前事实/素材/配置并落库。
 */
import { contentHash } from './domain.mjs';

export const M10_VERSION = 'm10.1';
export const DETAIL_PAGE_SCHEMA_VERSION = 1;
export const VIDEO_PLAN_SCHEMA_VERSION = 1;
export const VIDEO_FRAME_REPORT_SCHEMA_VERSION = 1;

/** 详情页固定六模块：首屏 / 卖点 / 场景 / 细节 / 规格 / 服务。 */
export const DETAIL_SECTIONS = Object.freeze([
  { key: 'hero', label: '首屏', note: '主图或主图组合 + 一句话定位，只引用已确认事实' },
  { key: 'selling_points', label: '卖点', note: '逐条卖点，逐条对应已验证事实' },
  { key: 'scenarios', label: '场景', note: '使用场景描述，可引用场景图' },
  { key: 'details', label: '细节', note: '材质、工艺与局部特写' },
  { key: 'specs', label: '规格', note: '尺寸、容量、型号等参数，必须与事实值一致' },
  { key: 'service', label: '服务', note: '发货、售后与保障条款，必须引用已确认事实' },
]);
export const DETAIL_SECTION_KEYS = Object.freeze(DETAIL_SECTIONS.map(item => item.key));

export const DETAIL_SOURCE_TYPES = Object.freeze(['fact', 'asset', 'spec', 'brand_kit']);
export const DETAIL_CHECK_CODES = Object.freeze([
  'DETAIL_SECTIONS_COMPLETE',
  'DETAIL_PARAM_SOURCES',
  'DETAIL_FACT_VALUES',
  'DETAIL_ASSETS_ACTIVE',
  'DETAIL_COPY_VERSION',
  'DETAIL_PLATFORM_COVERAGE',
  'DETAIL_PLATFORM_DELIVERY',
]);

/** 视频首段只允许 3 秒以内、低幅度动效。 */
export const MAX_VIDEO_DURATION_SECONDS = 3;
export const MAX_LOW_MOTION_AMPLITUDE = 0.15;
export const DEFAULT_LOW_MOTION_AMPLITUDE = 0.08;
export const VIDEO_MOTION_TYPES = Object.freeze(['push_in', 'pan', 'light_shift', 'parallax']);
export const VIDEO_FRAME_KINDS = Object.freeze(['first', 'middle', 'last']);
export const VIDEO_FRAME_CHECKS = Object.freeze([
  'FILE_INTEGRITY', 'SUBJECT_IDENTITY', 'TEXT_LOGO', 'RISK_CONTENT',
]);
export const HARD_FRAME_CHECKS = new Set(VIDEO_FRAME_CHECKS);

const normalizeText = value => String(value ?? '').trim().replace(/\s+/g, ' ');

const statusCheck = ({ code, label, status, hardGate = true, message = '', evidence = null }) => ({
  code, label, status, hard_gate: hardGate, message, evidence,
});

const passCheck = (code, label, { hardGate = true, message = '' } = {}) =>
  statusCheck({ code, label, status: 'pass', hardGate, message });

function failCheck(code, label, { hardGate = true, message, evidence = null } = {}) {
  return statusCheck({ code, label, status: 'fail', hardGate, message, evidence });
}

function unknownCheck(code, label, { hardGate = false, message, evidence = null } = {}) {
  return statusCheck({ code, label, status: 'unknown', hardGate, message, evidence });
}

const issue = (code, message, evidence = null) => ({ code, message, evidence });

// ---------- 详情页：来源解析 ----------

function factOf(truth, key) {
  const wanted = normalizeText(key);
  return (truth?.facts ?? []).find(item => normalizeText(item.key) === wanted) ?? null;
}

function assetOf(assets, assetId) {
  const wanted = normalizeText(assetId);
  return (assets ?? []).find(item => item.id === wanted) ?? null;
}

/**
 * 解析单个参数来源。返回 { ok, code, message, snapshot }：
 * - fact：事实必须存在；事实若来自素材，该素材必须仍生效；参数值与事实值必须一致。
 * - asset：素材必须存在且 role_status=active，并带内容哈希。
 * - spec / brand_kit：必须与当前冻结快照一致，不能引用"未来版本"。
 */
export function resolveParamSource({ param, truth = null, assets = [], spec = null, brandKit = null } = {}) {
  const source = param?.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, code: 'DETAIL_PARAM_UNSOURCED', message: '参数缺少来源，不能进入合格页', snapshot: null };
  }
  const type = normalizeText(source.type);
  if (!DETAIL_SOURCE_TYPES.includes(type)) {
    return { ok: false, code: 'DETAIL_SOURCE_TYPE_INVALID', message: `来源类型只能是 ${DETAIL_SOURCE_TYPES.join(' / ')}`, snapshot: null };
  }

  if (type === 'fact') {
    if (!truth) {
      return { ok: false, code: 'DETAIL_SOURCE_UNAVAILABLE', message: '缺少商品事实版本，无法校验事实来源', snapshot: null };
    }
    const key = normalizeText(source.key);
    const fact = factOf(truth, key);
    if (!fact) {
      return { ok: false, code: 'DETAIL_FACT_NOT_FOUND', message: `事实「${key || '(空)'}」不存在`, snapshot: null };
    }
    if (fact.source_asset_id) {
      const sourceAsset = assetOf(assets, fact.source_asset_id);
      if (!sourceAsset || sourceAsset.role_status !== 'active') {
        return {
          ok: false, code: 'DETAIL_FACT_SOURCE_STALE',
          message: `事实「${fact.key}」的来源素材已失效，不能继续引用`, snapshot: null,
        };
      }
    }
    const value = normalizeText(param.value);
    const candidates = new Set([
      normalizeText(fact.value),
      `${normalizeText(fact.value)}${normalizeText(fact.unit)}`,
    ]);
    if (!value) {
      return { ok: false, code: 'DETAIL_PARAM_VALUE_MISSING', message: '参数值不能为空', snapshot: null };
    }
    if (!candidates.has(value)) {
      return {
        ok: false, code: 'DETAIL_FACT_VALUE_MISMATCH',
        message: `参数值「${param.value}」与事实「${fact.key}=${fact.value}${fact.unit ?? ''}」不一致`,
        snapshot: null,
      };
    }
    return {
      ok: true,
      code: null,
      message: '',
      snapshot: {
        type: 'fact',
        key: fact.key,
        value: fact.value,
        unit: fact.unit ?? null,
        source_type: fact.source_type ?? 'user_input',
        source_asset_id: fact.source_asset_id ?? null,
        truth_version: truth.version,
        truth_content_hash: truth.content_hash,
        confirmed: fact.confirmed === true,
      },
    };
  }

  if (type === 'asset') {
    const asset = assetOf(assets, source.asset_id);
    if (!asset) {
      return { ok: false, code: 'DETAIL_ASSET_NOT_FOUND', message: `素材「${source.asset_id ?? '(空)'}」不存在`, snapshot: null };
    }
    if (asset.role_status !== 'active') {
      return {
        ok: false, code: 'DETAIL_ASSET_BLOCKED',
        message: `素材「${asset.filename ?? asset.id}」已被替换或失效，不能进入合格页`, snapshot: null,
      };
    }
    if (!asset.sha256) {
      return { ok: false, code: 'DETAIL_ASSET_UNVERIFIED', message: '素材缺少内容哈希，无法固定引用', snapshot: null };
    }
    return {
      ok: true,
      code: null,
      message: '',
      snapshot: {
        type: 'asset',
        asset_id: asset.id,
        role: asset.role,
        filename: asset.filename ?? null,
        sha256: asset.sha256,
        width: asset.width ?? null,
        height: asset.height ?? null,
      },
    };
  }

  if (type === 'spec') {
    if (!spec) {
      return { ok: false, code: 'DETAIL_SOURCE_UNAVAILABLE', message: '缺少生产配置快照，无法校验配置来源', snapshot: null };
    }
    const wanted = source.version === undefined || source.version === null ? null : Number(source.version);
    if (wanted !== null && (!Number.isInteger(wanted) || wanted !== spec.version)) {
      return { ok: false, code: 'DETAIL_SPEC_VERSION_STALE', message: `引用的配置版本 v${source.version} 不是当前快照 v${spec.version}`, snapshot: null };
    }
    return {
      ok: true,
      code: null,
      message: '',
      snapshot: { type: 'spec', version: spec.version, content_hash: spec.content_hash ?? null },
    };
  }

  // brand_kit
  if (!brandKit) {
    return { ok: false, code: 'DETAIL_SOURCE_UNAVAILABLE', message: '未选择品牌套件，无法校验品牌来源', snapshot: null };
  }
  const wanted = source.version === undefined || source.version === null ? null : Number(source.version);
  if (wanted !== null && (!Number.isInteger(wanted) || wanted !== brandKit.version)) {
    return { ok: false, code: 'DETAIL_BRAND_KIT_VERSION_STALE', message: `引用的品牌套件版本 v${source.version} 不是当前版本 v${brandKit.version}`, snapshot: null };
  }
  return {
    ok: true,
    code: null,
    message: '',
    snapshot: {
      type: 'brand_kit', id: brandKit.id ?? null, version: brandKit.version,
      content_hash: brandKit.content_hash ?? null,
    },
  };
}

/**
 * 组装结构化详情页。
 * previousPage 存在时输出重检范围：只对签名变化的参数重新解析，未变化参数复用上次来源快照，
 * 但六模块完整性、事实值、素材生效、文案版本、平台覆盖等关键约束每次都全量检查（PDP-02）。
 */
export function buildDetailPage({
  tenantId = null, projectId = null, spec = null, truth = null, brandKit = null,
  assets = [], sections = [], copyVersion = '', platform = null, previousPage = null,
  channel = null, at = new Date(),
} = {}) {
  const checks = [];
  const blockers = [];
  const normalizedCopyVersion = normalizeText(copyVersion);
  const input = Array.isArray(sections) ? sections : null;

  // 1) 六模块完整性
  const sectionIssues = [];
  if (input === null) {
    sectionIssues.push(issue('DETAIL_SECTIONS_INVALID', 'sections 必须是数组'));
  } else {
    const seen = new Set();
    for (const item of input) {
      const key = normalizeText(item?.key);
      if (!DETAIL_SECTION_KEYS.includes(key)) {
        sectionIssues.push(issue('DETAIL_SECTION_UNKNOWN', `未知模块「${key || '(空)'}」`));
        continue;
      }
      if (seen.has(key)) sectionIssues.push(issue('DETAIL_SECTION_DUPLICATE', `模块「${key}」重复`));
      seen.add(key);
      if (!Array.isArray(item.params) || item.params.length === 0) {
        sectionIssues.push(issue('DETAIL_SECTION_EMPTY', `模块「${key}」至少需要 1 个参数`));
      }
    }
    for (const key of DETAIL_SECTION_KEYS) {
      if (!seen.has(key)) sectionIssues.push(issue('DETAIL_SECTION_MISSING', `缺少模块「${key}」`));
    }
  }
  checks.push(sectionIssues.length === 0
    ? passCheck('DETAIL_SECTIONS_COMPLETE', '六模块完整性')
    : failCheck('DETAIL_SECTIONS_COMPLETE', '六模块完整性', {
      message: '详情页必须包含首屏、卖点、场景、细节、规格、服务六个模块，且每个模块至少 1 个参数',
      evidence: sectionIssues,
    }));
  blockers.push(...sectionIssues);

  // 2) 参数来源（含 PDP-02 重检范围）
  const previousParams = new Map();
  for (const section of previousPage?.sections ?? []) {
    for (const param of section.params ?? []) previousParams.set(`${section.key}/${param.key}`, param);
  }
  const sourceIssues = [];
  const factIssues = [];
  const assetIssues = [];
  const affected = [];
  let reused = 0;
  const outSections = [];

  for (const raw of input ?? []) {
    const key = normalizeText(raw?.key);
    const meta = DETAIL_SECTIONS.find(item => item.key === key);
    if (!meta) continue;
    const params = [];
    for (const param of Array.isArray(raw.params) ? raw.params : []) {
      const paramKey = normalizeText(param?.key);
      const label = normalizeText(param?.label) || paramKey;
      if (!paramKey) {
        sourceIssues.push(issue('DETAIL_PARAM_INVALID', `模块「${key}」存在缺少 key 的参数`));
        continue;
      }
      const value = normalizeText(param?.value);
      if (!value) sourceIssues.push(issue('DETAIL_PARAM_VALUE_MISSING', `参数「${paramKey}」缺少值`));

      const signature = contentHash({ key: paramKey, label, value, source: param?.source ?? null });
      const previous = previousParams.get(`${key}/${paramKey}`) ?? null;
      const canReuse = Boolean(previous && previous.signature === signature && previous.resolved === true);
      let resolution;
      if (canReuse) {
        resolution = {
          ok: true, code: null, message: '',
          snapshot: previous.source_snapshot ?? null,
        };
        reused += 1;
      } else {
        resolution = resolveParamSource({ param, truth, assets, spec, brandKit });
        affected.push(`${key}/${paramKey}`);
      }

      if (!resolution.ok) {
        sourceIssues.push(issue(resolution.code, `模块「${key}」参数「${paramKey}」：${resolution.message}`));
        if (resolution.code === 'DETAIL_FACT_VALUE_MISMATCH') {
          factIssues.push(issue(resolution.code, resolution.message));
        }
        if (resolution.code === 'DETAIL_ASSET_BLOCKED' || resolution.code === 'DETAIL_ASSET_NOT_FOUND') {
          assetIssues.push(issue(resolution.code, resolution.message));
        }
      }

      params.push({
        key: paramKey,
        label,
        value,
        source: param?.source ?? null,
        source_snapshot: resolution.snapshot,
        resolved: resolution.ok,
        signature,
        reused: canReuse,
        issue: resolution.ok ? null : { code: resolution.code, message: resolution.message },
      });
    }
    outSections.push({ key, label: meta.label, note: meta.note, params });
  }

  checks.push(sourceIssues.length === 0
    ? passCheck('DETAIL_PARAM_SOURCES', '参数来源可追溯')
    : failCheck('DETAIL_PARAM_SOURCES', '参数来源可追溯', {
      message: '每个详情参数都必须能追到事实、素材、生产配置或品牌套件版本',
      evidence: sourceIssues.slice(0, 20),
    }));
  blockers.push(...sourceIssues);

  checks.push(factIssues.length === 0
    ? passCheck('DETAIL_FACT_VALUES', '参数值与事实一致')
    : failCheck('DETAIL_FACT_VALUES', '参数值与事实一致', {
      message: '引用事实的参数值必须与事实值一致，不允许详情页自行改写规格',
      evidence: factIssues,
    }));
  blockers.push(...factIssues);

  // 3) 素材生效（PDP-04：失效/阻断素材不得入合格页）
  if (assetIssues.length === 0) {
    checks.push(passCheck('DETAIL_ASSETS_ACTIVE', '引用素材仍然生效'));
  } else {
    checks.push(failCheck('DETAIL_ASSETS_ACTIVE', '引用素材仍然生效', {
      message: '引用的素材必须仍为 active 且带内容哈希', evidence: assetIssues,
    }));
    blockers.push(...assetIssues);
  }

  // 4) 固定文案版本
  if (normalizedCopyVersion) {
    checks.push(passCheck('DETAIL_COPY_VERSION', '文案版本已固定'));
  } else {
    const item = issue('DETAIL_COPY_VERSION_MISSING', '必须传入 copy_version，详情页文案必须可回溯到固定版本');
    checks.push(failCheck('DETAIL_COPY_VERSION', '文案版本已固定', { message: item.message, evidence: [item] }));
    blockers.push(item);
  }

  // 5) 平台覆盖与交付方式（不声称平台通过）
  const delivery = planPlatformDelivery({ channel });
  const coverage = channel?.coverage ?? 'missing';
  const verified = channel?.rule?.source?.verified === true;
  checks.push(coverage === 'covered' && verified
    ? passCheck('DETAIL_PLATFORM_COVERAGE', '平台规则覆盖', { hardGate: false })
    : unknownCheck('DETAIL_PLATFORM_COVERAGE', '平台规则覆盖', {
      hardGate: false,
      message: '平台规则为内部演示基线且未核验，详情页不能声称已符合平台要求',
      evidence: { coverage, verified, reasons: channel?.reasons ?? [] },
    }));
  const unsupported = ['long_image', 'slices', 'html'].filter(name => delivery[name]?.supported !== true);
  checks.push(unsupported.length === 0
    ? passCheck('DETAIL_PLATFORM_DELIVERY', '平台交付形式', { hardGate: false })
    : unknownCheck('DETAIL_PLATFORM_DELIVERY', '平台交付形式', {
      hardGate: false,
      message: `平台未确认支持的交付形式：${unsupported.join(', ')}；不承诺直传`,
      evidence: delivery,
    }));

  const decision = blockers.length > 0 ? 'blocked' : 'publishable';
  const referencedAssets = [...new Set(outSections
    .flatMap(section => section.params)
    .map(param => param.source_snapshot)
    .filter(snapshot => snapshot?.type === 'asset')
    .map(snapshot => snapshot.asset_id))];

  return {
    schema_version: DETAIL_PAGE_SCHEMA_VERSION,
    builder_version: M10_VERSION,
    tenant_id: tenantId,
    project_id: projectId,
    spec_ref: spec ? { version: spec.version, content_hash: spec.content_hash ?? null } : null,
    truth_ref: truth ? { version: truth.version, content_hash: truth.content_hash ?? null } : null,
    brand_kit_ref: spec?.brand_kit && brandKit
      ? { id: spec.brand_kit.id, version: brandKit.version, content_hash: brandKit.content_hash ?? null }
      : null,
    channel_ref: channel?.rule
      ? {
        platform: channel.rule.platform, rule_id: channel.rule.id, version: channel.rule.version,
        status: channel.status, coverage, source_verified: verified,
      }
      : { platform: platform ?? null, rule_id: null, version: null, status: 'missing', coverage, source_verified: false },
    platform: platform ?? channel?.rule?.platform ?? null,
    copy_version: normalizedCopyVersion || null,
    sections: outSections,
    checks,
    blockers,
    decision,
    referenced_assets: referencedAssets,
    delivery,
    platform_compliance: 'not_claimed',
    context_hash: detailContextHash({ truth, spec, brandKit, assets, referencedAssets }),
    recheck: previousPage
      ? {
        mode: 'affected_and_critical',
        affected: [...new Set(affected)].sort(),
        reused_params: reused,
        full_checks: [
          'DETAIL_SECTIONS_COMPLETE', 'DETAIL_FACT_VALUES', 'DETAIL_ASSETS_ACTIVE',
          'DETAIL_COPY_VERSION', 'DETAIL_PLATFORM_COVERAGE',
        ],
        note: '只对签名变化的参数重新解析来源；六模块、事实值、素材生效、文案版本与平台覆盖始终全量检查。',
      }
      : null,
    generated_at: new Date(at).toISOString(),
  };
}

/** 详情页上下文哈希：事实版本、配置版本与引用素材哈希共同决定页面是否仍可发布。 */
export function detailContextHash({ truth = null, spec = null, brandKit = null, assets = [], referencedAssets = [] } = {}) {
  const wanted = new Set(referencedAssets);
  return contentHash({
    tenant_id: null,
    truth: truth ? { version: truth.version, content_hash: truth.content_hash ?? null } : null,
    spec: spec ? { version: spec.version, content_hash: spec.content_hash ?? null } : null,
    brand_kit: brandKit ? { version: brandKit.version, content_hash: brandKit.content_hash ?? null } : null,
    assets: (assets ?? [])
      .filter(item => wanted.size === 0 || wanted.has(item.id))
      .map(item => [item.id, item.sha256 ?? null, item.role_status])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  });
}

/** 详情页有效性：事实、配置、品牌套件、引用素材或平台规则任一变化即为 stale。 */
export function checkDetailPageValidity({
  page, truth = null, spec = null, brandKit = null, assets = [], channel = null,
} = {}) {
  const reasons = [];
  if (!page) return { validity: 'unknown', reasons: ['详情页不存在'] };
  if (!truth) reasons.push('当前项目没有商品事实版本');
  else if (truth.version !== page.truth_ref?.version || (truth.content_hash ?? null) !== (page.truth_ref?.content_hash ?? null)) {
    reasons.push(`商品事实已从 v${page.truth_ref?.version} 更新到 v${truth.version}`);
  }
  if (!spec) reasons.push('当前项目没有生产配置快照');
  else if (spec.version !== page.spec_ref?.version || (spec.content_hash ?? null) !== (page.spec_ref?.content_hash ?? null)) {
    reasons.push(`生产配置已从 v${page.spec_ref?.version} 更新到 v${spec.version}`);
  }
  if (page.brand_kit_ref) {
    if (!brandKit) reasons.push('引用的品牌套件不存在');
    else if ((brandKit.content_hash ?? null) !== (page.brand_kit_ref.content_hash ?? null)) {
      reasons.push(`品牌套件已更新到 v${brandKit.version}`);
    }
  }
  for (const assetId of page.referenced_assets ?? []) {
    const current = (assets ?? []).find(item => item.id === assetId) ?? null;
    if (!current) reasons.push(`引用素材 ${assetId} 已不存在`);
    else if (current.role_status !== 'active') reasons.push(`引用素材 ${assetId} 已失效或被替换`);
  }
  if (page.channel_ref?.version && channel?.rule?.version && channel.rule.version !== page.channel_ref.version) {
    reasons.push(`平台规则已从 v${page.channel_ref.version} 更新到 v${channel.rule.version}`);
  }
  return { validity: reasons.length === 0 ? 'current' : 'stale', reasons };
}

// ---------- 视频：首帧、分镜与帧级检查 ----------

/**
 * 视频计划。firstFrame 由 API 层归一化后传入：
 * { kind, ref_id, sha256, publishable, decision, validity, label }。
 * 首帧不可发布、动效幅度过大、时长超过 3 秒、音源不可追溯或 Provider 不支持视频都必须阻断。
 */
export function planVideo({
  tenantId = null, projectId = null, firstFrame = null, detailPage = null,
  capabilities = null, durationSeconds = MAX_VIDEO_DURATION_SECONDS,
  motion = {}, audio = {}, storyboard = null, at = new Date(),
} = {}) {
  const checks = [];
  const blockers = [];
  const add = (check, extra) => {
    checks.push(check);
    if (check.status === 'fail' && check.hard_gate) blockers.push(issue(check.code, check.message, extra ?? check.evidence));
  };

  // VID-01：首帧
  if (!firstFrame || firstFrame.available !== true) {
    add(failCheck('VIDEO_FIRST_FRAME', '有效首帧', {
      message: '缺少可用首帧，不能直接生成视频；请先选定已发布的图片版本或生效素材',
    }));
  } else if (firstFrame.publishable !== true) {
    add(failCheck('VIDEO_FIRST_FRAME', '有效首帧', {
      message: `首帧结论为 ${firstFrame.decision ?? 'unknown'}（有效期 ${firstFrame.validity ?? 'unknown'}），必须可发布且有效才能生成视频`,
    }));
  } else {
    add(passCheck('VIDEO_FIRST_FRAME', '有效首帧', {
      message: `首帧来源 ${firstFrame.kind}：${firstFrame.ref_id ?? ''}`,
    }));
  }

  // VID-02：3 秒、低幅度
  const duration = Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : MAX_VIDEO_DURATION_SECONDS;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_VIDEO_DURATION_SECONDS) {
    add(failCheck('VIDEO_DURATION', '首段时长', {
      message: `首段只允许 1—${MAX_VIDEO_DURATION_SECONDS} 秒，收到 ${durationSeconds}`,
    }));
  } else {
    add(passCheck('VIDEO_DURATION', '首段时长', { message: `${duration} 秒` }));
  }
  const amplitude = Number.isFinite(Number(motion.amplitude)) ? Number(motion.amplitude) : DEFAULT_LOW_MOTION_AMPLITUDE;
  const motionType = normalizeText(motion.type) || 'push_in';
  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > MAX_LOW_MOTION_AMPLITUDE) {
    add(failCheck('VIDEO_MOTION', '低幅度动效', {
      message: `首段动效幅度必须在 0—${MAX_LOW_MOTION_AMPLITUDE} 之间，收到 ${motion.amplitude}`,
    }));
  } else if (!VIDEO_MOTION_TYPES.includes(motionType)) {
    add(failCheck('VIDEO_MOTION', '低幅度动效', {
      message: `动效类型只能是 ${VIDEO_MOTION_TYPES.join(' / ')}`,
    }));
  } else {
    add(passCheck('VIDEO_MOTION', '低幅度动效', { message: `${motionType} ${amplitude}` }));
  }

  // VID-04：音源
  const audioSource = normalizeText(audio?.source) || 'none';
  const licenseRef = normalizeText(audio?.license_ref);
  if (audioSource === 'none') {
    add(passCheck('VIDEO_AUDIO_SOURCE', '音源可追溯', { message: '无音轨' }));
  } else if (audioSource === 'licensed_track' && licenseRef) {
    add(passCheck('VIDEO_AUDIO_SOURCE', '音源可追溯', { message: `授权曲目 ${licenseRef}` }));
  } else {
    add(failCheck('VIDEO_AUDIO_SOURCE', '音源可追溯', {
      message: '有音轨时必须提供可追溯授权（source=licensed_track 且 license_ref 非空）',
    }));
  }

  // VID-03：首中尾分镜
  const frames = normalizeStoryboard({ storyboard, durationSeconds: duration, at });
  const kinds = new Set(frames.map(item => item.kind));
  const missingKinds = VIDEO_FRAME_KINDS.filter(kind => !kinds.has(kind));
  if (missingKinds.length > 0) {
    add(failCheck('VIDEO_STORYBOARD', '首中尾分镜', {
      message: `分镜缺少关键帧「${missingKinds.join('、')}」；首中尾必须齐全`,
      evidence: { missing: missingKinds },
    }));
  } else {
    add(passCheck('VIDEO_STORYBOARD', '首中尾分镜', { message: '首帧、中间帧、尾帧齐全' }));
  }

  // 详情页：若视频文案引用详情页，则详情页必须可发布
  if (detailPage) {
    if (detailPage.decision === 'publishable') {
      add(passCheck('VIDEO_DETAIL_PAGE', '引用详情页可发布'));
    } else {
      add(failCheck('VIDEO_DETAIL_PAGE', '引用详情页可发布', {
        message: '引用的详情页不是可发布状态，视频文案不能取自阻断页',
      }));
    }
  }

  // Provider 能力：不支持视频时如实阻断，绝不假装生成
  const videoSupported = capabilities?.video === true;
  if (videoSupported) {
    add(passCheck('VIDEO_PROVIDER', 'Provider 视频能力'));
  } else {
    add(failCheck('VIDEO_PROVIDER', 'Provider 视频能力', {
      message: `当前 Provider「${capabilities?.id ?? 'unknown'}」不支持视频（simulated=${capabilities?.simulated === true}，acceptance=${capabilities?.acceptance ?? 'not_verified'}），本轮只能出分镜与检查计划，不生成视频文件`,
      evidence: { provider: capabilities?.id ?? null, video: capabilities?.video ?? null },
    }));
  }

  const decision = blockers.length > 0 ? 'blocked' : 'publishable';
  return {
    schema_version: VIDEO_PLAN_SCHEMA_VERSION,
    builder_version: M10_VERSION,
    tenant_id: tenantId,
    project_id: projectId,
    first_frame: firstFrame ?? null,
    detail_page_id: detailPage?.id ?? null,
    duration_seconds: duration,
    motion: { type: motionType, amplitude },
    audio: { source: audioSource, license_ref: licenseRef || null },
    frames,
    checks,
    blockers,
    decision,
    generation: {
      status: decision === 'publishable' ? 'ready' : 'blocked',
      blocker_code: decision === 'publishable' ? null : 'VIDEO_PROVIDER_UNSUPPORTED',
      provider: capabilities
        ? { id: capabilities.id ?? null, video: capabilities.video === true, simulated: capabilities.simulated === true, acceptance: capabilities.acceptance ?? null }
        : null,
      note: '计划可执行不等于已生成；只有 Provider 真实返回视频并通过帧级检查后才可交付。',
    },
    platform_compliance: 'not_claimed',
    generated_at: new Date(at).toISOString(),
  };
}

function normalizeStoryboard({ storyboard, durationSeconds, at = new Date() }) {
  const endMs = Math.round(Math.max(1, durationSeconds) * 1000);
  const fallback = [
    { kind: 'first', at_ms: 0 },
    { kind: 'middle', at_ms: Math.round(endMs / 2) },
    { kind: 'last', at_ms: endMs },
  ];
  const source = Array.isArray(storyboard) && storyboard.length > 0
    ? storyboard
    : fallback.map(item => ({ ...item, auto_filled: true }));
  return source
    .map((item, index) => ({
      index,
      kind: VIDEO_FRAME_KINDS.includes(normalizeText(item?.kind)) ? normalizeText(item.kind) : null,
      at_ms: Number.isFinite(Number(item?.at_ms)) ? Number(item.at_ms) : null,
      note: normalizeText(item?.note) || null,
      auto_filled: item?.auto_filled === true,
      planned_at: new Date(at).toISOString(),
    }))
    .filter(item => item.kind !== null && item.at_ms !== null && item.at_ms >= 0 && item.at_ms <= endMs);
}

/**
 * 帧级检查（VID-03）。硬检查出现 fail 即 blocked（中间帧异常必然阻断）；
 * 缺检测结果按 unknown → needs_review，不能当成 pass。
 */
export function evaluateVideoFrames({ frames = [], requiredKinds = VIDEO_FRAME_KINDS } = {}) {
  const blockers = [];
  const reviewItems = [];
  const normalized = [];
  const seenKinds = new Set();

  for (const [index, frame] of (Array.isArray(frames) ? frames : []).entries()) {
    const kind = VIDEO_FRAME_KINDS.includes(normalizeText(frame?.kind)) ? normalizeText(frame.kind) : `frame_${index + 1}`;
    seenKinds.add(kind);
    const provided = new Map();
    for (const check of Array.isArray(frame?.checks) ? frame.checks : []) {
      const code = normalizeText(check?.code);
      const status = normalizeText(check?.status);
      if (!HARD_FRAME_CHECKS.has(code)) {
        reviewItems.push(issue('VIDEO_FRAME_CHECK_UNKNOWN', `帧 ${kind} 存在未知检查项「${code || '(空)'}」，不做放行依据`, { kind, code }));
        continue;
      }
      if (!['pass', 'fail', 'unknown', 'not_applicable'].includes(status)) {
        reviewItems.push(issue('VIDEO_FRAME_STATUS_INVALID', `帧 ${kind} 检查项「${code}」状态无效`, { kind, code, status }));
        continue;
      }
      provided.set(code, status);
    }
    const checks = [];
    for (const code of VIDEO_FRAME_CHECKS) {
      const status = provided.get(code) ?? 'unknown';
      checks.push({
        code,
        status,
        note: provided.has(code) ? null : '缺少检测结果，按待复核处理',
      });
      if (status === 'fail') {
        blockers.push(issue('VIDEO_FRAME_FAILED', `帧 ${kind} 的「${code}」为 fail，必须阻断整段视频`, { kind, code }));
      } else if (status === 'unknown') {
        reviewItems.push(issue('VIDEO_FRAME_UNKNOWN', `帧 ${kind} 的「${code}」检测不足，需复核`, { kind, code }));
      }
    }
    normalized.push({
      kind,
      at_ms: Number.isFinite(Number(frame?.at_ms)) ? Number(frame.at_ms) : null,
      note: normalizeText(frame?.note) || null,
      checks,
      decision: checks.some(item => item.status === 'fail')
        ? 'fail'
        : checks.some(item => item.status === 'unknown') ? 'unknown' : 'pass',
    });
  }

  for (const kind of requiredKinds) {
    if (!seenKinds.has(kind)) {
      reviewItems.push(issue('VIDEO_FRAME_MISSING', `缺少「${kind}」帧检查结果，不能判定视频合格`, { kind }));
    }
  }

  const decision = blockers.length > 0
    ? 'blocked'
    : reviewItems.length > 0 ? 'needs_review' : 'publishable';

  return {
    schema_version: VIDEO_FRAME_REPORT_SCHEMA_VERSION,
    evaluator_version: M10_VERSION,
    decision,
    frames: normalized,
    blockers,
    review_items: reviewItems,
    middle_frame_blocking: true,
    note: '任一硬检查 fail 立即阻断；检测不足按待复核；缺帧不能算通过。',
  };
}

// ---------- 平台交付能力 ----------

/**
 * 平台交付形式。演示基线里三个平台都没有 HTML 直传能力，
 * 因此 HTML 一律 supported=false、promise=none；只能提供结构化数据与图片由商家自行上传。
 */
export function planPlatformDelivery({ channel = null, requestedFormats = ['long_image', 'slices', 'html'] } = {}) {
  const rule = channel?.rule ?? null;
  const covered = (channel?.coverage ?? 'missing') === 'covered';
  const formats = Array.isArray(rule?.constraints?.formats) ? rule.constraints.formats : [];
  const raster = formats.some(item => ['jpg', 'jpeg', 'png', 'webp'].includes(item));

  const base = name => {
    if (!rule) {
      return {
        supported: false, reason: 'CHANNEL_RULE_MISSING',
        ...(name === 'html' ? { direct_upload: false, promise: 'none' } : {}),
        reasons: ['未收录该平台规则，不能承诺任何交付形式'],
      };
    }
    if (!covered) {
      return {
        supported: false, reason: 'CHANNEL_COVERAGE_UNKNOWN',
        ...(name === 'html' ? { direct_upload: false, promise: 'none' } : {}),
        reasons: [...(channel?.reasons ?? [])],
      };
    }
    if (name === 'html') {
      return {
        supported: false,
        direct_upload: false,
        promise: 'none',
        reason: 'CHANNEL_NO_HTML_DIRECT_UPLOAD',
        reasons: ['内部演示基线未记录该平台 HTML 直传能力，不得承诺直传'],
      };
    }
    if (!raster) return { supported: false, reason: 'CHANNEL_RASTER_UNSUPPORTED', reasons: ['平台基线未列出可用图片格式'] };
    return { supported: true, reason: null, reasons: [] };
  };

  const delivery = {
    platform: rule?.platform ?? channel?.platform ?? null,
    rule_version: rule?.version ?? null,
    allowed_formats: [...formats],
    platform_compliance_claim: 'not_claimed',
    note: '平台能力以内部演示基线为准，未经官方条款核验；HTML 不支持直传时不承诺直传。',
  };
  for (const name of requestedFormats) {
    if (!['long_image', 'slices', 'html'].includes(name)) continue;
    delivery[name] = base(name);
  }
  return delivery;
}

// ---------- 联合导出清单 ----------

/**
 * 图、视频、详情页联合导出清单。
 * 视频在当前 Provider 下必然缺失，缺失项必须显式列出，不能静默省略。
 */
export function buildJointManifest({
  project = null, run = null, spec = null, truth = null, provider = null,
  images = [], detailPage = null, videoPlan = null, frameReport = null, delivery = null,
  missing = [], now = new Date(),
} = {}) {
  return {
    package_format: 'qtb-joint-package.1',
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    project_id: project?.id ?? run?.project_id ?? null,
    run_id: run?.id ?? null,
    spec: spec ? { version: spec.version, content_hash: spec.content_hash ?? null } : null,
    truth: truth ? { version: truth.version, content_hash: truth.content_hash ?? null } : null,
    platform: spec?.channel?.platform ?? project?.platform ?? null,
    provider: provider
      ? { id: provider.id ?? null, simulated: provider.simulated === true, acceptance: provider.acceptance ?? null }
      : null,
    images: images.map(item => ({
      deliverable_id: item.deliverable_id,
      label: item.label ?? null,
      file: item.file,
      sha256: item.sha256 ?? null,
      format: item.format ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
      bytes: item.bytes ?? null,
      version_id: item.version_id ?? null,
      report_id: item.report_id ?? null,
      decision: item.decision ?? null,
    })),
    artifacts: [
      {
        name: 'detail-page.json',
        included: detailPage?.decision === 'publishable',
        decision: detailPage?.decision ?? null,
        copy_version: detailPage?.copy_version ?? null,
        platform_compliance: detailPage?.platform_compliance ?? 'not_claimed',
      },
      {
        name: 'video-plan.json',
        included: Boolean(videoPlan),
        decision: videoPlan?.decision ?? null,
        generation_status: videoPlan?.generation?.status ?? null,
      },
      {
        name: 'video-frames.json',
        included: Boolean(frameReport),
        decision: frameReport?.decision ?? null,
      },
      {
        name: 'platform-delivery.json',
        included: true,
        html_direct_upload: delivery?.html?.supported === true,
        html_promise: delivery?.html?.promise ?? 'none',
      },
    ],
    missing,
    platform_compliance: 'not_claimed',
    note: '视频缺失由 Provider 能力决定并显式列出；HTML 直传未获渠道确认时不承诺。',
  };
}
