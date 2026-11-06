/**
 * P2 商品图评审接入：把 commerce-image-reviewer 规则装配成可调用请求，
 * 校验模型输出，再映射为现有 QA 检查项。
 *
 * 三条底线：
 * 1. 未配置评审模型时明确"未配置"，不伪造看图结论；已配置但调用失败/超时/返回非法 JSON 时，
 *    八项检查一律 unknown 并写明原因。
 * 2. 模型只提供证据，不决定严重度、收费与最终交付；关键商品项不接受模型自行 "not_applicable"。
 * 3. 追加检查，不覆盖 m07 已有的原始证据与判定依据。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { REVIEW_CHECK_CODES, REVIEW_SCHEMA_VERSION, REVIEW_SKILL_VERSION, validateReviewOutput } from './visual-contract.mjs';
import { decideQuality } from './m07.mjs';
import { contentHash } from './domain.mjs';

export const VISUAL_REVIEW_VERSION = 'visual-review.1';
export const VISUAL_REVIEW_TIMEOUT_MS = 20_000;
const MAX_ATTACHED_BYTES = 8 * 1024 * 1024;

/** 关键商品检查：模型不能靠 not_applicable 或降低严重度绕过。 */
const CRITICAL_PRODUCT_CODES = Object.freeze([
  'PRODUCT_IDENTITY', 'SKU_MATCH', 'PRODUCT_COLOR', 'PACKAGE_TEXT', 'INCLUDED_ITEMS',
]);

export const REVIEW_CHECK_REGISTRY = Object.freeze({
  PRODUCT_IDENTITY: { label: '商品身份', required: true, hard_gate: true },
  SKU_MATCH: { label: 'SKU 一致', required: true, hard_gate: true },
  PRODUCT_COLOR: { label: '商品颜色', required: true, hard_gate: true },
  PACKAGE_TEXT: { label: '包装文字', required: true, hard_gate: true },
  INCLUDED_ITEMS: { label: '包含物', required: true, hard_gate: true },
  BRAND_LAYOUT: { label: '品牌与版式', required: true, hard_gate: false },
  COMPOSITION: { label: '构图与场景', required: true, hard_gate: false },
  COMPOSITE_QUALITY: { label: '合成质量', required: false, hard_gate: false },
});

const DEFAULT_RULE_FILES = Object.freeze({
  system: 'docs/ai-development/runtime/reviewer-system.md',
  skill: 'skills/commerce-image-reviewer/SKILL.md',
  checklist: 'skills/commerce-image-reviewer/references/checklist.md',
  schema: 'skills/commerce-image-reviewer/references/output.schema.json',
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function stripFrontmatter(text) {
  return String(text).replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

let rulesCache = null;
let rulesCacheKey = null;

/**
 * 装配评审规则：系统说明 + Skill 主体 + 检查标准 + 输出 Schema。
 * 规则哈希会写进请求与报告，规则文件变动后旧报告即可判定为不再适用。
 */
export async function loadReviewerRules({ root = new URL('..', import.meta.url), files = DEFAULT_RULE_FILES } = {}) {
  const key = `${root}:${JSON.stringify(files)}`;
  if (rulesCache && rulesCacheKey === key) return rulesCache;
  const entries = {};
  for (const [name, relative] of Object.entries(files)) {
    entries[name] = await readFile(new URL(relative, root), 'utf8');
  }
  const systemBody = [entries.system, stripFrontmatter(entries.skill), entries.checklist]
    .map(item => String(item).trim())
    .filter(Boolean)
    .join('\n\n');
  const schema = JSON.parse(entries.schema);
  const rulesHash = sha256([
    entries.system, stripFrontmatter(entries.skill), entries.checklist, entries.schema,
  ].join('\u0000'));
  rulesCache = {
    system: systemBody,
    output_schema: schema,
    rules_hash: `rules_${rulesHash}`,
    files: Object.fromEntries(Object.entries(files).map(([name, relative]) => [relative, sha256(entries[name])])),
    skill_version: REVIEW_SKILL_VERSION,
    schema_version: REVIEW_SCHEMA_VERSION,
  };
  rulesCacheKey = key;
  return rulesCache;
}

/** 未配置的样子：可调用但只返回"不可用"，绝不假装看过图。 */
function unavailableReviewer(reason, note) {
  return {
    configured: false,
    mode: 'not_configured',
    acceptance: 'not_available',
    note,
    async review() {
      return { status: 'unavailable', reason, note, output: null };
    },
  };
}

export function createVisualReviewer({
  endpoint = null,
  apiKey = null,
  model = null,
  timeoutMs = VISUAL_REVIEW_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!endpoint) {
    return unavailableReviewer(
      'VISUAL_REVIEW_NOT_CONFIGURED',
      '未配置 QTB_VISUAL_REVIEW_ENDPOINT，视觉评审项保持未知，不会用样例或规则文字冒充看图结论',
    );
  }
  if (typeof fetchImpl !== 'function') {
    return unavailableReviewer('VISUAL_REVIEW_FETCH_UNAVAILABLE', '当前运行时没有可用的 fetch，无法调用视觉评审端点');
  }
  return {
    configured: true,
    mode: 'http',
    acceptance: 'not_verified',
    model,
    note: '外部注入的视觉评审端点；真实看图效果需人工对照验收',
    async review({ system, user, images = [], output_schema = null, timeoutMs: callTimeout = timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), callTimeout);
      const started = Date.now();
      try {
        const body = {
          model,
          system,
          user,
          images: images.map(image => ({
            image_id: image.image_id,
            role: image.role ?? null,
            mime: image.mime ?? null,
            image_base64: Buffer.from(image.bytes).toString('base64'),
          })),
          output_schema,
        };
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        const latencyMs = Date.now() - started;
        if (!response.ok) {
          return {
            status: 'http_error',
            reason: `视觉评审端点返回 HTTP ${response.status}`,
            http_status: response.status,
            latency_ms: latencyMs,
            output: null,
          };
        }
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return {
            status: 'invalid_json',
            reason: '视觉评审端点返回的不是合法 JSON',
            latency_ms: latencyMs,
            output: null,
            raw_length: text.length,
          };
        }
        const output = isPlainObject(payload?.output) ? payload.output
          : isPlainObject(payload?.result?.output) ? payload.result.output
            : isPlainObject(payload?.result) ? payload.result
              : payload;
        return {
          status: 'ok',
          output,
          request_id: payload?.request_id ?? payload?.id ?? null,
          model: payload?.model ?? model,
          provider: payload?.provider ?? null,
          latency_ms: latencyMs,
        };
      } catch (error) {
        const latencyMs = Date.now() - started;
        if (error?.name === 'AbortError') {
          return {
            status: 'timeout',
            reason: `视觉评审调用超过 ${callTimeout}ms 未返回，结论置为待复核`,
            latency_ms: latencyMs,
            output: null,
          };
        }
        return {
          status: 'error',
          reason: `视觉评审调用失败：${error?.message ?? 'UNKNOWN_ERROR'}`,
          latency_ms: latencyMs,
          output: null,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 环境变量：只有显式配置端点才算"已接入"，否则保持未配置。 */
export function createVisualReviewerFromEnv(env = process.env) {
  const endpoint = typeof env?.QTB_VISUAL_REVIEW_ENDPOINT === 'string'
    ? env.QTB_VISUAL_REVIEW_ENDPOINT.trim() : '';
  if (!endpoint) {
    return createVisualReviewer({});
  }
  const timeout = Number(env.QTB_VISUAL_REVIEW_TIMEOUT_MS);
  return createVisualReviewer({
    endpoint,
    apiKey: env.QTB_VISUAL_REVIEW_API_KEY?.trim() || null,
    model: env.QTB_VISUAL_REVIEW_MODEL?.trim() || null,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}

function artifactHashOf(candidate) {
  if (candidate?.sha256) return candidate.sha256;
  if (Buffer.isBuffer(candidate?.bytes) && candidate.bytes.length > 0) return sha256(candidate.bytes);
  return null;
}

/**
 * 组装评审请求。candidate 是待评图，references 是商品参考图（主体/包装/细节）。
 * 风格图不随请求附带，避免模型把风格图当成商品身份依据。
 */
export function buildReviewRequest({
  project = null,
  run = null,
  deliverable = null,
  truth = null,
  spec = null,
  brandKitVersion = null,
  candidate = null,
  references = [],
  compositeApplied = false,
} = {}) {
  const deliverableId = deliverable?.deliverable_id ?? null;
  const artifactHash = artifactHashOf(candidate);
  const contextHash = run?.product_context?.context_hash
    ?? `ctx_${contentHash({
      project_id: project?.id ?? run?.project_id ?? null,
      sku: project?.sku ?? null,
      truth: truth ? { version: truth.version ?? null, content_hash: truth.content_hash ?? null } : null,
      spec: spec ? { version: spec.version ?? null, content_hash: spec.content_hash ?? null } : null,
    })}`;
  const artifactVersionId = `art:${run?.id ?? 'run'}:${deliverableId ?? 'deliverable'}`;

  const imageBindings = [{
    image_id: 'img_candidate',
    role: 'candidate',
    asset_id: null,
    attached: Boolean(candidate?.bytes?.length),
    sha256: artifactHash,
  }];
  const images = [];
  if (candidate?.bytes?.length) {
    images.push({
      image_id: 'img_candidate', role: 'candidate', mime: candidate.mime ?? null, bytes: candidate.bytes,
    });
  }

  let attachedBytes = candidate?.bytes?.length ?? 0;
  const missing = [];
  for (const item of references ?? []) {
    const asset = item?.asset ?? null;
    if (!asset?.id) continue;
    const bytes = item?.bytes ?? null;
    const allowed = asset.role !== 'style';
    const canAttach = allowed && Boolean(bytes?.length) && attachedBytes + bytes.length <= MAX_ATTACHED_BYTES;
    const imageId = `img_${asset.id}`;
    imageBindings.push({
      image_id: imageId,
      role: asset.role ?? null,
      asset_id: asset.id,
      attached: canAttach,
      sha256: asset.sha256 ?? null,
    });
    if (canAttach) {
      attachedBytes += bytes.length;
      images.push({
        image_id: imageId, role: asset.role ?? null, mime: asset.mime ?? null, bytes,
      });
    } else if (allowed) {
      missing.push({
        asset_id: asset.id,
        role: asset.role ?? null,
        reason: bytes?.length ? 'REFERENCE_BUDGET_EXCEEDED' : 'REFERENCE_BYTES_MISSING',
      });
    } else {
      missing.push({ asset_id: asset.id, role: asset.role, reason: 'STYLE_NOT_PRODUCT_REFERENCE' });
    }
  }

  const request = {
    schema_version: REVIEW_SCHEMA_VERSION,
    skill_version: REVIEW_SKILL_VERSION,
    context_hash: contextHash,
    artifact_version_id: artifactVersionId,
    artifact_hash: artifactHash ?? 'artifact-missing',
    required_check_codes: [...REVIEW_CHECK_CODES],
    image_bindings: imageBindings,
    context: {
      sku_id: project?.sku ?? run?.product_context?.sku ?? null,
      product_name: project?.name ?? null,
      category: project?.category ?? null,
      facts: (truth?.facts ?? []).map(fact => ({
        key: fact.key, value: fact.value, unit: fact.unit ?? null, critical: fact.critical === true,
      })),
      critical_text: (truth?.critical_text ?? []).map(item => (typeof item === 'string' ? item : item?.text ?? null))
        .filter(Boolean),
      brand: brandKitVersion
        ? {
          brand_kit_id: brandKitVersion.brand_kit_id ?? null,
          version: brandKitVersion.version ?? null,
          palette: brandKitVersion.palette ?? null,
          logo_present: brandKitVersion.logo?.present === true,
          banned_expressions: [...(brandKitVersion.banned_expressions ?? [])],
        }
        : null,
      requirement: {
        deliverable_id: deliverableId,
        label: deliverable?.label ?? null,
        type: deliverable?.type ?? null,
        width: deliverable?.width ?? null,
        height: deliverable?.height ?? null,
        ratio: deliverable?.ratio ?? null,
        platform: spec?.channel?.platform ?? null,
        background: deliverable?.background ?? null,
        lighting: deliverable?.lighting ?? null,
        composition: deliverable?.composition ?? null,
        text_blocks: deliverable?.text_blocks ?? [],
        logo_allowed: deliverable?.logo_allowed === true,
        allowed_transforms: [...(spec?.template?.allowed_transforms ?? [])],
      },
      composite_applied: compositeApplied === true,
    },
    synthetic: false,
  };
  return { request, images, missing };
}

/**
 * 调用评审并做结构与绑定校验。
 * 返回 status: not_configured / unavailable / timeout / error / invalid_json / invalid_output / ok。
 */
export async function reviewArtifact({ reviewer, rules = null, bundle, timeoutMs } = {}) {
  if (!reviewer) {
    return { status: 'not_configured', reason: 'VISUAL_REVIEW_NOT_CONFIGURED', output: null };
  }
  if (reviewer.configured === false) {
    return { status: 'not_configured', reason: 'VISUAL_REVIEW_NOT_CONFIGURED', output: null, note: reviewer.note };
  }
  if (!bundle?.request) throw new TypeError('reviewArtifact 需要请求 bundle');
  const candidateBinding = bundle.request.image_bindings.find(item => item.role === 'candidate');
  if (!candidateBinding?.attached) {
    return {
      status: 'unavailable',
      reason: 'CANDIDATE_NOT_ATTACHED',
      note: '待评图缺失或无法读取，评审模型不得给出任何结论',
      request: bundle.request,
    };
  }
  const resolvedRules = rules ?? await loadReviewerRules();
  const result = await reviewer.review({
    system: resolvedRules.system,
    user: JSON.stringify({ review_request: bundle.request }),
    images: bundle.images,
    output_schema: resolvedRules.output_schema,
    ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
  if (result.status !== 'ok') {
    return {
      ...result,
      request: bundle.request,
      rules_hash: resolvedRules.rules_hash,
      reason_code: result.status.toUpperCase(),
    };
  }
  const validation = validateReviewOutput(result.output, { request: bundle.request });
  if (!validation.ok) {
    return {
      status: 'invalid_output',
      reason: '视觉评审输出未通过结构与绑定校验',
      output: result.output,
      validation,
      request: bundle.request,
      rules_hash: resolvedRules.rules_hash,
      request_id: result.request_id ?? null,
      latency_ms: result.latency_ms ?? null,
      model: result.model ?? null,
      provider: result.provider ?? null,
    };
  }
  return {
    status: result.output.observation_status === 'unavailable' ? 'unavailable' : 'ok',
    output: result.output,
    validation,
    request: bundle.request,
    rules_hash: resolvedRules.rules_hash,
    request_id: result.request_id ?? null,
    latency_ms: result.latency_ms ?? null,
    model: result.model ?? null,
    provider: result.provider ?? null,
    reason: result.output.observation_status === 'unavailable'
      ? (result.output.unknown_reasons?.[0] ?? '模型未能观察待评图')
      : null,
  };
}

const FAILURE_REASON_TEXT = Object.freeze({
  not_configured: '未配置视觉评审模型，本项保持 unknown，等待人工核对',
  unavailable: '视觉评审未能观察待评图，本项保持 unknown',
  timeout: '视觉评审调用超时，本项保持 unknown，需重试或人工复核',
  error: '视觉评审调用失败，本项保持 unknown，需人工复核',
  invalid_json: '视觉评审返回非 JSON，本项保持 unknown，需人工复核',
  http_error: '视觉评审端点报错，本项保持 unknown，需人工复核',
  invalid_output: '视觉评审输出未通过校验（结构、哈希或参考图绑定不一致），本项保持 unknown',
});

function severityOf(status, hardGate) {
  if (status === 'fail') return hardGate ? 'blocker' : 'high';
  if (status === 'unknown') return hardGate ? 'high' : 'medium';
  return 'info';
}

/** 把一次评审结果映射成 m07 兼容的检查项；不修改任何既有检查。 */
export function visualReviewChecks({ review, brandKit = null, compositeApplied = false } = {}) {
  // 只有 ok / unavailable 的模型输出可以作为证据；结构或绑定校验失败时，整份输出不可信。
  const usableOutput = review?.status === 'ok' || review?.status === 'unavailable';
  const output = usableOutput ? review?.output ?? null : null;
  const checksByCode = new Map(
    (Array.isArray(output?.checks) ? output.checks : []).map(check => [check.code, check]),
  );
  return REVIEW_CHECK_CODES.map(code => {
    const spec = REVIEW_CHECK_REGISTRY[code];
    const required = code === 'BRAND_LAYOUT' ? true : spec.required;
    const hardGate = spec.hard_gate;
    const modelCheck = checksByCode.get(code) ?? null;
    const reasons = [];

    let status = 'unknown';
    let evidence = {
      source: 'visual_model',
      observation_status: output?.observation_status ?? 'unavailable',
      model_status: modelCheck?.status ?? null,
      model_evidence: modelCheck?.evidence ?? null,
      region: modelCheck?.region ?? null,
      reference_image_ids: modelCheck?.reference_image_ids ?? [],
      reviewed_by: 'commerce-image-reviewer',
    };
    let suggestedAction = modelCheck?.suggested_fix ?? null;

    if (!output) {
      reasons.push(FAILURE_REASON_TEXT[review?.status] ?? '视觉评审没有返回可用结论');
      evidence.reason = review?.reason ?? review?.status ?? 'NO_OUTPUT';
    } else if (modelCheck) {
      const modelStatus = modelCheck.status;
      if (modelStatus === 'not_applicable') {
        if (code === 'COMPOSITE_QUALITY' && compositeApplied !== true) {
          status = 'not_applicable';
        } else if (CRITICAL_PRODUCT_CODES.includes(code)) {
          status = 'unknown';
          reasons.push('关键商品检查不接受模型判定为"不适用"，需按程序条件或人工复核确认');
          evidence.reason = 'NOT_APPLICABLE_NOT_ALLOWED';
        } else {
          status = 'not_applicable';
        }
      } else {
        status = modelStatus;
      }
      if (status === 'unknown' && !modelCheck.suggested_fix) {
        suggestedAction = '补充可辨识的参考图或重新拍摄后再核对';
      }
    } else {
      reasons.push(`评审输出缺少 ${code} 检查项`);
      evidence.reason = 'MISSING_CHECK';
    }

    if (!suggestedAction && (status === 'fail' || status === 'unknown')) {
      suggestedAction = '人工对照主体原图与最终图后确认';
    }
    if (status === 'not_applicable') suggestedAction = null;

    return {
      code: `REVIEW_${code}`,
      label: spec.label,
      status,
      severity: severityOf(status, hardGate),
      required,
      hard_gate: hardGate,
      adjudicable: status === 'unknown',
      source: 'visual_model',
      evidence: Object.keys(evidence).length > 0 ? evidence : null,
      ...(reasons.length > 0 ? { reasons } : {}),
      ...(suggestedAction ? { suggested_action: suggestedAction } : {}),
    };
  });
}

/**
 * 把评审结果追加到现有报告：先保留原 checks 与机器判定依据，再按合并后的检查重算 decision。
 */
export function attachVisualReview({ report, review, rulesHash = null, checkedAt = null } = {}) {
  if (!report) throw new TypeError('attachVisualReview 需要报告');
  const brandKit = report.brand_kit_ref ? { brand_kit_id: report.brand_kit_ref.id } : null;
  const compositeApplied = report.upstream?.composite?.applied === true;
  const checks = visualReviewChecks({ review, brandKit, compositeApplied });
  report.visual_review = {
    version: VISUAL_REVIEW_VERSION,
    status: review.status,
    observation_status: review.output?.observation_status ?? 'unavailable',
    model: review.model ?? null,
    provider: review.provider ?? null,
    request_id: review.request_id ?? null,
    latency_ms: review.latency_ms ?? null,
    context_hash: review.request?.context_hash ?? null,
    artifact_version_id: review.request?.artifact_version_id ?? null,
    artifact_hash: review.request?.artifact_hash ?? null,
    rules_hash: rulesHash ?? review.rules_hash ?? null,
    unknown_reasons: [
      ...(review.output?.unknown_reasons ?? []),
      ...(review.reason ? [review.reason] : []),
    ],
    validation_errors: review.validation?.errors ?? [],
    appended_check_codes: checks.map(item => item.code),
    note: '视觉评审只提供证据；严重度、收费与最终交付由服务端与人工决定；真实看图效果尚未人工验收',
    checked_at: checkedAt ? new Date(checkedAt).toISOString() : null,
  };
  report.checks = [...(report.checks ?? []), ...checks];
  const { decision, reasons } = decideQuality(report.checks);
  report.machine_decision = decision;
  report.decision = decision;
  report.decision_reasons = reasons;
  report.checker_versions = { ...(report.checker_versions ?? {}), visual_review: VISUAL_REVIEW_VERSION };
  return report;
}

/** 供测试与诊断：不调用模型，直接构造一次"不可用"评审。 */
export function unavailableReview(status = 'not_configured', reason = null) {
  return {
    status,
    reason: reason ?? FAILURE_REASON_TEXT[status] ?? '视觉评审不可用',
    output: null,
  };
}
