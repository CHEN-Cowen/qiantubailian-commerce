/**
 * M07 Commerce QA 与人工复核。
 *
 * 设计原则（照 PRD 5.4 / 6 与剩余开发接手包）：
 * 1. 每个检查项只输出 pass / fail / unknown / not_applicable，绝不把"没查"写成通过。
 * 2. 硬失败一律 blocked；没有硬失败但必要项未知或失败，才是 needs_review。
 * 3. 美学分只是参考，**不参与**放行判定，高分不能覆盖硬失败。
 * 4. 没有 OCR、没有视觉评审模型时，相应检查必须 unknown，不能拿占位检测器直接放行。
 * 5. 人工确认只允许覆盖"原始状态为 unknown 且显式标记可裁决"的检查；
 *    不能确认硬失败，也不能覆盖商品事实与平台硬失败。
 * 6. 机器证据只增不改；人工复核单独记录人、理由、证据与时间。
 */
import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { MASK_VERSION, decodePng } from './m06.mjs';
import { checkCriticalText } from './ocr.mjs';
import { readImageSize, sniffImageType } from './images.mjs';

export const QA_VERSION = 'm07.qa.1';
export const CHECKER_VERSIONS = Object.freeze({
  qa: QA_VERSION,
  mask: MASK_VERSION,
  png_decode: 'm06.decode.1',
  jpeg_header: 'm02.inspect.1',
});

export const CHECK_STATUSES = Object.freeze(['pass', 'fail', 'unknown', 'not_applicable']);
export const DECISIONS = Object.freeze(['publishable', 'needs_review', 'blocked']);

const FLAT_VARIANCE_THRESHOLD = 1.5;
const COLOR_TOLERANCE = 24;
const ASPECT_TOLERANCE = 0.01;
const REVIEW_REASON_MIN = 2;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = at => new Date(at).toISOString();

/** 检测器参考了哪个版本的规则与解码能力，报告可据此重放。 */
const check = ({
  code, label, status, severity = 'info', hardGate = false, required = false,
  adjudicable = false, evidence = null, region = null, confidence = null, suggestedAction = null,
}) => ({
  code,
  label,
  status,
  severity,
  hard_gate: hardGate,
  required,
  adjudicable,
  evidence,
  region,
  confidence,
  suggested_action: suggestedAction,
});

const normalizeFormat = value => {
  const text = String(value ?? '').toLowerCase();
  if (text === 'jpeg') return 'jpg';
  return text;
};

const statusOf = item => item.effective_status ?? item.status;

/** 按 PRD 6 节：硬失败 blocked；必要项未知或失败 needs_review；其余 publishable。 */
export function decideQuality(checks, { aestheticScore = null } = {}) {
  const blocked = checks.filter(item => item.hard_gate && statusOf(item) === 'fail');
  // 刻意保留这个参数只是为了在测试里证明：美学分再高也不改变上述判定。
  void aestheticScore;
  if (blocked.length > 0) {
    return {
      decision: 'blocked',
      reasons: {
        blocked: blocked.map(item => ({ code: item.code, label: item.label })),
        review_required: [],
      },
    };
  }
  const unresolved = checks.filter(item =>
    item.required && (statusOf(item) === 'fail' || statusOf(item) === 'unknown'));
  if (unresolved.length > 0) {
    return {
      decision: 'needs_review',
      reasons: {
        blocked: [],
        review_required: unresolved.map(item => ({
          code: item.code,
          label: item.label,
          status: statusOf(item),
          adjudicable: item.adjudicable === true,
        })),
      },
    };
  }
  return { decision: 'publishable', reasons: { blocked: [], review_required: [] } };
}

/** 把复核结论叠加到机器证据上；机器 status 原样保留，另给 effective_status。 */
export function resolveEffectiveChecks(report) {
  const overrides = new Map();
  for (const review of report.reviews ?? []) {
    for (const decision of review.decisions ?? []) {
      overrides.set(decision.code, {
        review_id: review.id,
        reviewer: review.reviewer,
        reviewed_at: review.created_at,
        decision: decision.decision,
        reason: decision.reason,
        evidence: decision.evidence,
      });
    }
  }
  return (report.checks ?? []).map(item => {
    const override = overrides.get(item.code) ?? null;
    return {
      ...item,
      machine_status: item.status,
      effective_status: override?.decision ?? item.status,
      adjudication: override,
    };
  });
}

/** 报告当前是否仍对得上冻结事实、规则与文件；stale 不得正式导出。 */
export function computeReportValidity({
  report, spec = null, truth = null, brandKitVersion = null, channel = null, outputExists = true,
} = {}) {
  const reasons = [];
  if (!spec || spec.version !== report?.spec_ref?.version || spec.content_hash !== report?.spec_ref?.content_hash) {
    reasons.push('冻结生产配置已变更或不可读取');
  }
  if (!truth || truth.version !== report?.truth_ref?.version
    || (report?.truth_ref?.content_hash && truth.content_hash !== report.truth_ref.content_hash)) {
    reasons.push('商品事实已有新版本');
  }
  if (report?.brand_kit_ref) {
    if (brandKitVersion !== report.brand_kit_ref.version) reasons.push('品牌套件已有新版本');
  }
  if (report?.rules_ref?.rule_id) {
    const liveVersion = channel?.rule?.version ?? null;
    if (liveVersion !== report.rules_ref.version) reasons.push('平台规则版本已变化');
    const liveStatus = channel?.status ?? 'missing';
    if (liveStatus === 'expired' || liveStatus === 'not_effective') {
      reasons.push(`平台规则当前状态为 ${liveStatus}`);
    }
  }
  if (!outputExists) reasons.push('输出文件缺失或哈希不可读');
  return { validity: reasons.length === 0 ? 'current' : 'stale', reasons };
}

/** 汇总任务质量：有失败或必要未知时不允许标为可发布。 */
export function aggregateQualityStatus(reports, { requireAllDeliverables = true, deliverableCount = 0 } = {}) {
  if (!reports || reports.length === 0) return 'not_checked';
  const latest = new Map();
  for (const report of reports) {
    const current = latest.get(report.deliverable_id);
    if (!current || String(report.checked_at) >= String(current.checked_at)) {
      latest.set(report.deliverable_id, report);
    }
  }
  const decisions = [...latest.values()].map(item => item.decision);
  if (decisions.includes('blocked')) return 'blocked';
  if (decisions.includes('needs_review')) return 'needs_review';
  if (requireAllDeliverables && latest.size < deliverableCount) return 'not_checked';
  return 'publishable';
}

// ---------- 像素级检查（只对可完整解码的 PNG 生效） ----------

function luminanceAt(pixels, index) {
  return pixels[index * 4] * 0.2126 + pixels[index * 4 + 1] * 0.7152 + pixels[index * 4 + 2] * 0.0722;
}

/** 采样估计亮度方差：近乎纯色的输出通常意味着生成失败或空白图。 */
export function analyzeFlatness(decoded, step = 7) {
  if (!decoded) return null;
  const total = decoded.width * decoded.height;
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < total; index += step) {
    const luminance = luminanceAt(decoded.pixels, index);
    sum += luminance;
    sumSquares += luminance * luminance;
    count += 1;
  }
  if (count === 0) return null;
  const mean = sum / count;
  return { mean, variance: Math.max(0, sumSquares / count - mean * mean), samples: count };
}

/** 掩码图缩放到输出尺寸后，逐像素核对商品像素是否被原样保留。 */
export function verifyCompositeOutput({ outputDecoded, maskBytes, cutoutBytes } = {}) {
  if (!outputDecoded) return { available: false, reason: 'OUTPUT_NOT_DECODABLE' };
  const mask = decodePng(maskBytes);
  const cutout = decodePng(cutoutBytes);
  if (!mask || !cutout || mask.width !== cutout.width || mask.height !== cutout.height) {
    return { available: false, reason: 'SUBJECT_ARTIFACT_INVALID' };
  }
  let checked = 0;
  let mismatches = 0;
  for (let y = 0; y < outputDecoded.height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor(y * mask.height / outputDecoded.height));
    for (let x = 0; x < outputDecoded.width; x += 1) {
      const mx = Math.min(mask.width - 1, Math.floor(x * mask.width / outputDecoded.width));
      const maskIndex = (my * mask.width + mx) * 4;
      if (mask.pixels[maskIndex] < 128) continue;
      if (cutout.pixels[maskIndex + 3] < 128) continue;
      const target = (y * outputDecoded.width + x) * 4;
      checked += 1;
      if (outputDecoded.pixels[target] !== cutout.pixels[maskIndex]
        || outputDecoded.pixels[target + 1] !== cutout.pixels[maskIndex + 1]
        || outputDecoded.pixels[target + 2] !== cutout.pixels[maskIndex + 2]) {
        mismatches += 1;
      }
    }
  }
  return { available: true, checked, mismatches, exact: checked > 0 && mismatches === 0 };
}

/** 掩码区域的平均颜色：只用于已做本地合成的输出，避免无配准时的伪比较。 */
export function meanColorInMask({ outputDecoded, maskBytes, cutoutBytes } = {}) {
  if (!outputDecoded) return null;
  const mask = decodePng(maskBytes);
  const cutout = decodePng(cutoutBytes);
  if (!mask || !cutout || mask.width !== cutout.width || mask.height !== cutout.height) return null;
  const outputSum = [0, 0, 0];
  const cutoutSum = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < outputDecoded.height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor(y * mask.height / outputDecoded.height));
    for (let x = 0; x < outputDecoded.width; x += 1) {
      const mx = Math.min(mask.width - 1, Math.floor(x * mask.width / outputDecoded.width));
      const maskIndex = (my * mask.width + mx) * 4;
      if (mask.pixels[maskIndex] < 128) continue;
      if (cutout.pixels[maskIndex + 3] < 128) continue;
      const target = (y * outputDecoded.width + x) * 4;
      outputSum[0] += outputDecoded.pixels[target];
      outputSum[1] += outputDecoded.pixels[target + 1];
      outputSum[2] += outputDecoded.pixels[target + 2];
      cutoutSum[0] += cutout.pixels[maskIndex];
      cutoutSum[1] += cutout.pixels[maskIndex + 1];
      cutoutSum[2] += cutout.pixels[maskIndex + 2];
      count += 1;
    }
  }
  if (count === 0) return null;
  const output = outputSum.map(value => value / count);
  const source = cutoutSum.map(value => value / count);
  const delta = Math.sqrt(
    (output[0] - source[0]) ** 2 + (output[1] - source[1]) ** 2 + (output[2] - source[2]) ** 2,
  );
  return { output, source, delta, samples: count };
}

// ---------- 质量报告 ----------

const formatList = deliverable => (Array.isArray(deliverable?.formats) ? deliverable.formats : [])
  .map(normalizeFormat)
  .filter(Boolean);

const factsEvidence = truth => (truth?.facts ?? []).map(fact => ({
  key: fact.key,
  value: fact.value,
  unit: fact.unit ?? null,
  critical: fact.critical === true,
  confirmed: fact.confirmed === true,
}));

/**
 * 对一次成功生成的输出做全量检查并产出质量报告。
 * 调用方必须传入真实文件与冻结快照；任何缺失都以 unknown 记录，不得伪造通过。
 */
export function evaluateGenerationQuality({
  run, deliverable, attempt, spec, truth, channel = null,
  output = {}, subject = {}, assets = [], now = new Date(), ocr = null,
} = {}) {
  const at = iso(now);
  const bytes = output.bytes ?? null;
  const expectedHash = output.sha256 ?? (bytes ? sha256(bytes) : null);
  const actualFormat = normalizeFormat(output.format);
  const requestedFormats = formatList(deliverable);
  const sniffed = bytes ? sniffImageType(bytes) : null;
  const expectedMime = actualFormat === 'png' ? 'image/png' : actualFormat === 'jpg' ? 'image/jpeg' : null;
  const decoded = sniffed === 'image/png' ? decodePng(bytes) : output?.decoded_bytes ? decodePng(output.decoded_bytes) : null;
  const jpegSize = sniffed === 'image/jpeg' ? readImageSize(bytes, 'image/jpeg') : null;
  const measured = decoded
    ? { width: decoded.width, height: decoded.height }
    : jpegSize
      ? { width: jpegSize.width, height: jpegSize.height }
      : null;
  const protectionRequired = run?.subject_protection?.required === true;
  const protectionMode = attempt?.subject_protection?.mode ?? run?.subject_protection?.mode ?? 'not_required';
  const composite = attempt?.composite ?? null;
  const sourceHashes = new Set((assets ?? [])
    .filter(asset => asset?.sha256 && asset.role_status === 'active')
    .map(asset => asset.sha256));
  const checks = [];

  // 1. 文件可读性与哈希
  let integrity = null;
  if (!bytes || bytes.length === 0) {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'fail', severity: 'blocker', hardGate: true, required: true,
      evidence: { reason: 'OUTPUT_EMPTY' }, suggestedAction: '重新生成并确认供应商返回了文件体',
    });
  } else if (sniffed !== expectedMime) {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'fail', severity: 'blocker', hardGate: true, required: true,
      evidence: { declared_format: actualFormat, sniffed: sniffed ?? 'unrecognized', bytes: bytes.length },
      suggestedAction: '文件签名与声明格式不一致，必须重新生成',
    });
  } else if (actualFormat === 'png' && !decoded) {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'fail', severity: 'blocker', hardGate: true, required: true,
      evidence: { reason: 'PNG_NOT_DECODABLE', bytes: bytes.length },
      suggestedAction: 'PNG 无法解码，不能作为交付物',
    });
  } else if (actualFormat === 'jpg' && !jpegSize) {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'fail', severity: 'blocker', hardGate: true, required: true,
      evidence: { reason: 'JPEG_HEADER_INVALID', bytes: bytes.length },
      suggestedAction: 'JPEG 头部不可解析，不能作为交付物',
    });
  } else if (expectedHash && sha256(bytes) !== expectedHash) {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'fail', severity: 'blocker', hardGate: true, required: true,
      evidence: { expected_hash: expectedHash, actual_hash: sha256(bytes) },
      suggestedAction: '文件哈希与生成记录不一致，必须重新生成',
    });
  } else if (!measured) {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'unknown', severity: 'high', required: true,
      adjudicable: false, evidence: { reason: 'DIMENSION_UNREADABLE', format: actualFormat },
      suggestedAction: '无法读取文件尺寸，需人工确认文件是否可用',
    });
  } else if (Number.isFinite(output.width) && Number.isFinite(output.height)
    && (output.width !== measured.width || output.height !== measured.height)) {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'fail', severity: 'blocker', hardGate: true, required: true,
      evidence: { declared: { width: output.width, height: output.height }, measured },
      suggestedAction: '供应商声明尺寸与文件实际尺寸不一致，必须重新生成',
    });
  } else {
    integrity = check({
      code: 'FILE_INTEGRITY', label: '文件完整性', status: 'pass', required: true,
      evidence: {
        hash: expectedHash, format: actualFormat, width: measured.width, height: measured.height,
        bytes: bytes.length, decoder: decoded ? (sniffed === 'image/png' ? 'full_png' : 'full_jpeg') : 'jpeg_header_only',
      },
    });
  }
  checks.push(integrity);

  // 2. 文件格式是否符合交付清单
  checks.push(check({
    code: 'FILE_FORMAT', label: '文件格式', required: true, hardGate: true,
    status: requestedFormats.includes(actualFormat) ? 'pass' : 'fail',
    severity: requestedFormats.includes(actualFormat) ? 'info' : 'blocker',
    evidence: { requested: requestedFormats, actual: actualFormat },
    suggestedAction: requestedFormats.includes(actualFormat)
      ? null : `交付清单要求 ${requestedFormats.join(' / ')}，实际为 ${actualFormat}，必须重新生成或转换`,
  }));

  // 3. 尺寸与比例
  const requiredWidth = Number(deliverable?.width);
  const requiredHeight = Number(deliverable?.height);
  if (!measured || !Number.isFinite(requiredWidth) || !Number.isFinite(requiredHeight)) {
    checks.push(check({
      code: 'SIZE', label: '尺寸与比例', status: 'unknown', severity: 'high', required: true,
      adjudicable: false, evidence: { measured, required: { width: requiredWidth, height: requiredHeight } },
      suggestedAction: '无法核对尺寸，需重新生成或补齐交付清单尺寸',
    }));
  } else {
    const requiredAspect = requiredWidth / requiredHeight;
    const actualAspect = measured.width / measured.height;
    const aspectDeviation = Math.abs(actualAspect - requiredAspect) / requiredAspect;
    const sizeOk = measured.width >= requiredWidth && measured.height >= requiredHeight
      && aspectDeviation <= ASPECT_TOLERANCE;
    checks.push(check({
      code: 'SIZE', label: '尺寸与比例', required: true, hardGate: true,
      status: sizeOk ? 'pass' : 'fail', severity: sizeOk ? 'info' : 'blocker',
      evidence: {
        actual: measured, required: { width: requiredWidth, height: requiredHeight, ratio: deliverable?.ratio ?? null },
        aspect_deviation: Number(aspectDeviation.toFixed(4)),
      },
      suggestedAction: sizeOk ? null : '输出低于清单要求或比例不符，必须重新生成',
    }));
  }

  // 4. 主体像素保留（只有本地合成才能逐像素核对）
  let preservation = null;
  if (composite && composite.applied === true) {
    const verified = verifyCompositeOutput({
      outputDecoded: decoded, maskBytes: subject.maskBytes, cutoutBytes: subject.cutoutBytes,
    });
    if (!verified.available) {
      preservation = check({
        code: 'SUBJECT_PIXEL_PRESERVATION', label: '主体像素保留', status: 'unknown',
        severity: 'high', required: true, adjudicable: false,
        evidence: { reason: verified.reason, composite: { sha256: composite.sha256 ?? null } },
        suggestedAction: '缺少可解码的掩码/去背主体，无法核对像素保留',
      });
    } else if (!verified.exact && composite.lossy_encoding && subject.losslessBytes &&
      verifyCompositeOutput({ outputDecoded: decodePng(subject.losslessBytes), maskBytes: subject.maskBytes, cutoutBytes: subject.cutoutBytes }).exact) {
      preservation = check({
        code: 'SUBJECT_PIXEL_PRESERVATION', label: 'JPEG 压缩后主体核对', status: 'unknown',
        severity: 'high', required: true, adjudicable: true,
        evidence: { lossy_encoding: true, pre_encoding_exact: true, checked_pixels: verified.checked, mismatches: verified.mismatches },
        suggestedAction: '压缩前主体像素一致；JPEG 有损编码后需人工对照商品形状、文字和颜色',
      });
    } else if (verified.exact) {
      preservation = check({
        code: 'SUBJECT_PIXEL_PRESERVATION', label: '主体像素保留', status: 'pass',
        required: true, hardGate: true,
        evidence: { checked_pixels: verified.checked, mismatches: 0, composite_sha256: composite.sha256 ?? null },
      });
    } else {
      preservation = check({
        code: 'SUBJECT_PIXEL_PRESERVATION', label: '主体像素保留', status: 'fail',
        severity: 'blocker', required: true, hardGate: true,
        evidence: { checked_pixels: verified.checked, mismatches: verified.mismatches },
        suggestedAction: '掩码内商品像素被改写，必须重新合成',
      });
    }
  } else if (protectionMode === 'composite' && composite && composite.available === false) {
    preservation = check({
      code: 'SUBJECT_PIXEL_PRESERVATION', label: '主体像素保留', status: 'fail',
      severity: 'blocker', required: true, hardGate: true,
      evidence: { reason: composite.reason ?? 'COMPOSITE_FAILED' },
      suggestedAction: '声明本地合成但未能应用，必须重新生成',
    });
  } else {
    preservation = check({
      code: 'SUBJECT_PIXEL_PRESERVATION', label: '主体像素保留', status: 'not_applicable', required: false,
      evidence: { mode: protectionMode, note: '供应商侧掩码或非合成模式，系统没有逐像素核对依据' },
    });
  }
  checks.push(preservation);

  // 5. 主体一致性
  if (!protectionRequired) {
    checks.push(check({
      code: 'SUBJECT_PROTECTION', label: '商品主体保护', status: 'not_applicable', required: false,
      evidence: { mode: protectionMode },
    }));
  } else if (protectionMode === 'composite' && preservation?.status === 'pass') {
    checks.push(check({
      code: 'SUBJECT_PROTECTION', label: '商品主体保护', status: 'pass', required: true,
      evidence: { mode: 'composite', pixel_preservation: preservation.evidence },
    }));
  } else if (protectionMode === 'composite') {
    checks.push(check({
      code: 'SUBJECT_PROTECTION', label: '商品主体保护', status: 'unknown', severity: 'high',
      required: true, adjudicable: preservation?.evidence?.lossy_encoding === true,
      evidence: { mode: 'composite', preservation_status: preservation?.status ?? null },
      suggestedAction: '本地合成未通过像素核对，不能声称主体已被保护',
    }));
  } else if (protectionMode === 'mask') {
    checks.push(check({
      code: 'SUBJECT_PROTECTION', label: '商品主体保护', status: 'unknown', severity: 'high',
      required: true, adjudicable: true,
      evidence: {
        mode: 'mask', mask_ref: run?.subject_context?.mask_ref ?? null,
        note: '供应商声明支持掩码，但系统没有逐像素验证其输出的能力，需人工对照主体素材',
      },
      suggestedAction: '人工对照主体原图，确认形状、文字、Logo 与颜色未被改写',
    }));
  } else {
    checks.push(check({
      code: 'SUBJECT_PROTECTION', label: '商品主体保护', status: 'unknown', severity: 'high',
      required: true, adjudicable: false,
      evidence: { mode: protectionMode, warning: run?.subject_context?.warning ?? null },
      suggestedAction: '当前生成未获得已验证的主体保护，需更换支持掩码或本地合成的 Provider 后重新生成',
    }));
  }

  // 6. 对齐（本地合成只保证像素，不保证位置）
  if (composite && composite.applied === true) {
    checks.push(check({
      code: 'SUBJECT_ALIGNMENT', label: '主体位置对齐', status: 'unknown', severity: 'high',
      required: true, adjudicable: true,
      evidence: {
        alignment_verified: composite.meta?.alignment_verified === true,
        method: composite.meta?.method ?? null,
        replaced_ratio: composite.meta?.replaced_ratio ?? null,
      },
      suggestedAction: '人工对照生成图与主体原图，确认商品位置、朝向与比例合理',
    }));
  } else {
    checks.push(check({
      code: 'SUBJECT_ALIGNMENT', label: '主体位置对齐', status: 'not_applicable', required: false,
      evidence: { mode: protectionMode },
    }));
  }

  // 7. 颜色
  if (!decoded || !subject.maskBytes || !subject.cutoutBytes) {
    checks.push(check({
      code: 'COLOR', label: '商品颜色', status: 'unknown', severity: 'medium',
      required: protectionRequired, adjudicable: protectionRequired,
      evidence: {
        reason: !decoded ? 'PIXEL_DECODER_UNAVAILABLE' : 'SUBJECT_MASK_UNAVAILABLE',
        note: !decoded ? '当前只对 PNG 做像素核对，JPEG 输出无法机器比较颜色' : '缺少主体掩码，无法建立区域对应关系',
      },
      suggestedAction: protectionRequired ? '人工对照主体原图确认商品颜色未被改变' : null,
    }));
  } else if (composite && composite.applied === true) {
    const colors = meanColorInMask({
      outputDecoded: decoded, maskBytes: subject.maskBytes, cutoutBytes: subject.cutoutBytes,
    });
    const diff = colors?.delta ?? Infinity;
    const colorOk = diff <= COLOR_TOLERANCE;
    checks.push(check({
      code: 'COLOR', label: '商品颜色', required: true, hardGate: true,
      status: colorOk ? 'pass' : 'fail', severity: colorOk ? 'info' : 'blocker',
      evidence: {
        delta: Number.isFinite(diff) ? Number(diff.toFixed(2)) : null,
        tolerance: COLOR_TOLERANCE,
        samples: colors?.samples ?? 0,
      },
      suggestedAction: colorOk ? null : '掩码区域商品颜色偏离原图，必须重新合成',
    }));
  } else {
    checks.push(check({
      code: 'COLOR', label: '商品颜色', status: 'unknown', severity: 'medium',
      required: true, adjudicable: true,
      evidence: {
        mode: protectionMode,
        note: '没有逐像素配准，系统无法把输出区域与主体原图对应起来，需人工比对颜色',
      },
      suggestedAction: '人工对照主体原图确认颜色未被改变',
    }));
  }

  // 8. 商品事实
  const facts = factsEvidence(truth);
  if (!truth) {
    checks.push(check({
      code: 'TRUTH_FACTS', label: '商品事实一致', status: 'unknown', severity: 'high',
      required: true, adjudicable: false,
      evidence: { reason: 'TRUTH_SNAPSHOT_MISSING' },
      suggestedAction: '冻结的商品事实快照不可读取，需回溯任务依据',
    }));
  } else if (facts.length === 0) {
    checks.push(check({
      code: 'TRUTH_FACTS', label: '商品事实一致', status: 'not_applicable', required: false,
      evidence: { truth_version: truth.version },
    }));
  } else {
    checks.push(check({
      code: 'TRUTH_FACTS', label: '商品事实一致', status: 'unknown', severity: 'high',
      required: true, adjudicable: true,
      evidence: { truth_version: truth.version, facts, note: '机器不做语义判定，事实与图片的一致性必须人工核对' },
      suggestedAction: '逐项核对图片中的规格、容量、材质等是否与已确认事实一致',
    }));
  }

  // 9. 包装关键文字：OCR 已配置时机器比对，未配置时保持 unknown
  const criticalTexts = truth?.critical_text ?? [];
  if (criticalTexts.length === 0) {
    checks.push(check({
      code: 'OCR_CRITICAL_TEXT', label: '包装关键文字', status: 'not_applicable', required: false,
      evidence: { critical_text_count: 0 },
    }));
  } else {
    const textCheck = checkCriticalText({ criticalTexts, ocr });
    checks.push(check({
      code: 'OCR_CRITICAL_TEXT',
      label: '包装关键文字',
      // 文字不符是硬失败：包装文字与事实不一致，不能被审美评分覆盖
      status: textCheck.status === 'pass' ? 'pass' : textCheck.status === 'fail' ? 'fail' : 'unknown',
      severity: 'high',
      hardGate: textCheck.status === 'fail',
      required: true,
      adjudicable: textCheck.status !== 'pass',
      evidence: {
        critical_text: criticalTexts.map(item => ({ text: item.text, region: item.region ?? null })),
        ocr_engine: textCheck.engine ?? 'not_configured',
        matched: textCheck.matched,
        mismatched: textCheck.mismatched,
        note: textCheck.status === 'unknown'
          ? '未接入或本次未能完成 OCR，无法机器验证文字；不可读不等于通过'
          : textCheck.status === 'fail'
            ? '图中未检出已确认的包装关键文字，属于硬失败'
            : '已在图中检出全部已确认的包装关键文字',
      },
      suggestedAction: textCheck.status === 'pass'
        ? '如需更高精度可人工复核'
        : '人工逐字核对包装文字，或接入/修复 OCR 服务后重检',
    }));
  }

  // 10. 品牌规范
  if (!spec?.brand_kit) {
    checks.push(check({
      code: 'BRAND_RULES', label: '品牌规范', status: 'not_applicable', required: false,
      evidence: { brand_kit: null },
    }));
  } else {
    const unlicensed = (spec.gaps?.warnings ?? []).filter(item => item.code === 'FONT_NOT_LICENSED');
    checks.push(check({
      code: 'BRAND_RULES', label: '品牌规范', required: true, hardGate: false,
      status: unlicensed.length > 0 ? 'fail' : 'unknown',
      severity: unlicensed.length > 0 ? 'high' : 'medium',
      adjudicable: unlicensed.length === 0,
      evidence: {
        brand_kit: spec.brand_kit,
        logo_used: spec.creative_direction?.logo_used === true,
        unlicensed_fonts: unlicensed.map(item => item.message),
        note: unlicensed.length > 0
          ? '未授权字体不得用于商用成品，必须替换或取得授权'
          : 'Logo、字体与色彩规范需人工核对',
      },
      suggestedAction: unlicensed.length > 0
        ? '替换为已授权字体后重新生成' : '人工核对 Logo 使用、字体与品牌色',
    }));
  }

  // 11. 平台规则：覆盖不足、过期或来源未核验一律不得声称通过
  const rule = channel?.rule ?? null;
  const ruleStatus = channel?.status ?? 'missing';
  const sourceVerified = rule?.source?.verified === true;
  let platformCompliance = 'unknown';
  if (!rule) {
    checks.push(check({
      code: 'PLATFORM_RULES', label: '平台规则', status: 'unknown', severity: 'high',
      required: true, adjudicable: false,
      evidence: { status: ruleStatus, platform: spec?.channel?.platform ?? null },
      suggestedAction: '补齐该平台的规则版本后重新检查，不能凭经验放行',
    }));
  } else if (ruleStatus === 'expired' || ruleStatus === 'not_effective' || ruleStatus === 'missing') {
    checks.push(check({
      code: 'PLATFORM_RULES', label: '平台规则', status: 'unknown', severity: 'high',
      required: true, adjudicable: false,
      evidence: {
        status: ruleStatus, platform: rule.platform, version: rule.version,
        effective_at: rule.effective_at, review_due_at: rule.review_due_at,
        reasons: channel?.reasons ?? [],
      },
      suggestedAction: '导入当前有效且已核验的平台规则版本后重新检查',
    }));
  } else if (ruleStatus === 'review_due') {
    checks.push(check({
      code: 'PLATFORM_RULES', label: '平台规则', status: 'unknown', severity: 'medium',
      required: true, adjudicable: false,
      evidence: {
        status: ruleStatus, platform: rule.platform, version: rule.version,
        review_due_at: rule.review_due_at, days_to_review: channel?.days_to_review ?? null,
        reasons: channel?.reasons ?? [],
      },
      suggestedAction: '平台规则已到复核窗口，需复核后再放行',
    }));
  } else if (channel?.category_covered === false) {
    checks.push(check({
      code: 'PLATFORM_RULES', label: '平台规则', status: 'unknown', severity: 'high',
      required: true, adjudicable: false,
      evidence: {
        status: ruleStatus, platform: rule.platform, version: rule.version,
        coverage: channel?.coverage ?? null, reasons: channel?.reasons ?? [],
      },
      suggestedAction: '当前规则版本未覆盖该商品类目，不能据此声称平台合规',
    }));
  } else if (sourceVerified) {
    platformCompliance = 'verified';
    checks.push(check({
      code: 'PLATFORM_RULES', label: '平台规则', status: 'pass', required: true,
      evidence: { platform: rule.platform, version: rule.version, source: rule.source },
    }));
  } else {
    checks.push(check({
      code: 'PLATFORM_RULES', label: '平台规则', status: 'unknown', severity: 'medium',
      required: false, adjudicable: false,
      evidence: {
        platform: rule.platform, version: rule.version, status: ruleStatus,
        source: rule.source,
        note: '规则来源为内部演示基线，未经官方条款核验，不能声称平台审核通过；不阻断内部质量结论',
      },
      suggestedAction: '导入已核验的官方规则版本后才能声明平台合规',
    }));
  }

  // 12. 视觉质量：没有评审模型就是 unknown，不参与放行
  checks.push(check({
    code: 'VISUAL_QUALITY', label: '视觉质量', status: 'unknown', required: false, adjudicable: false,
    evidence: {
      aesthetic_score: null, evaluator: 'not_configured',
      note: '未接入视觉评审模型；美学分不参与放行，也不能覆盖硬失败',
    },
  }));

  // 13. 风险：空白图与"原图冒充生成图"是可确定判定的
  let risk = null;
  if (!bytes) {
    risk = check({
      code: 'RISK_CONTENT', label: '内容风险', status: 'unknown', severity: 'high',
      required: true, adjudicable: false, evidence: { reason: 'OUTPUT_MISSING' },
    });
  } else if (expectedHash && sourceHashes.has(expectedHash)) {
    risk = check({
      code: 'RISK_CONTENT', label: '内容风险', status: 'fail', severity: 'high',
      required: true, hardGate: true,
      evidence: { reason: 'OUTPUT_IDENTICAL_TO_SOURCE_ASSET', hash: expectedHash },
      suggestedAction: '输出与源素材完全相同，不能作为生成结果交付',
    });
  } else if (!decoded) {
    risk = check({
      code: 'RISK_CONTENT', label: '内容风险', status: 'unknown', severity: 'medium',
      required: true, adjudicable: true,
      evidence: {
        reason: 'PIXEL_DECODER_UNAVAILABLE', format: actualFormat,
        note: '没有像素解码器，无法自动检测空白或近乎纯色的输出',
      },
      suggestedAction: '人工确认画面不是空白或近乎纯色',
    });
  } else {
    const flatness = analyzeFlatness(decoded);
    const flat = flatness && flatness.variance < FLAT_VARIANCE_THRESHOLD;
    risk = check({
      code: 'RISK_CONTENT', label: '内容风险', required: true, hardGate: true,
      status: flat ? 'fail' : 'pass', severity: flat ? 'high' : 'info',
      evidence: {
        luminance_variance: flatness ? Number(flatness.variance.toFixed(3)) : null,
        threshold: FLAT_VARIANCE_THRESHOLD,
        duplicated_source: false,
      },
      suggestedAction: flat ? '画面近乎空白，必须重新生成' : null,
    });
  }
  checks.push(risk);

  const { decision, reasons } = decideQuality(checks);
  const measuredWidth = measured?.width ?? null;
  const measuredHeight = measured?.height ?? null;

  return {
    id: `qr_${randomBytes(8).toString('hex')}`,
    schema_version: 1,
    tenant_id: run?.tenant_id ?? null,
    project_id: run?.project_id ?? null,
    run_id: run?.id ?? null,
    deliverable_id: deliverable?.deliverable_id ?? attempt?.deliverable_id ?? null,
    attempt_id: attempt?.id ?? null,
    generation_record_id: null,
    asset_version: {
      hash: expectedHash,
      format: actualFormat || null,
      width: measuredWidth,
      height: measuredHeight,
      bytes: bytes?.length ?? 0,
    },
    output_file: { hash: expectedHash, format: actualFormat || null },
    spec_ref: spec
      ? {
        version: spec.version,
        content_hash: spec.content_hash,
        template_id: spec.template?.id ?? null,
        template_version: spec.template?.version ?? null,
      }
      : { version: run?.spec_ref?.version ?? null, content_hash: run?.spec_ref?.content_hash ?? null },
    truth_ref: {
      version: truth?.version ?? null,
      content_hash: truth?.content_hash ?? null,
    },
    brand_kit_ref: spec?.brand_kit
      ? { id: spec.brand_kit.id, version: spec.brand_kit.version, hash: spec.brand_kit.hash ?? null }
      : null,
    rules_ref: {
      platform: rule?.platform ?? spec?.channel?.platform ?? null,
      rule_id: rule?.id ?? spec?.channel?.rule_id ?? null,
      version: rule?.version ?? spec?.channel?.version ?? null,
      status: ruleStatus,
      source_verified: sourceVerified,
      effective_at: rule?.effective_at ?? null,
      review_due_at: rule?.review_due_at ?? null,
    },
    checker_versions: { ...CHECKER_VERSIONS },
    subject_context: {
      required: protectionRequired,
      mode: protectionMode,
      mask_ref: run?.subject_context?.mask_ref ?? null,
      mask_sha256: run?.subject_context?.mask_sha256 ?? null,
      cutout_sha256: run?.subject_context?.cutout_sha256 ?? null,
    },
    upstream: {
      format_contract: attempt?.result?.format_contract ?? null,
      composite: composite
        ? { applied: composite.applied === true, sha256: composite.sha256 ?? null, meta: composite.meta ?? null }
        : null,
    },
    checks,
    scores: {
      aesthetic: null,
      note: '未接入视觉评审模型；美学分不参与放行判定，也不覆盖硬失败',
    },
    machine_decision: decision,
    decision,
    decision_reasons: reasons,
    platform_compliance: platformCompliance,
    can_claim_platform_compliance: platformCompliance === 'verified',
    human_review: null,
    reviews: [],
    checked_at: at,
    created_at: at,
    updated_at: at,
  };
}

/** QA 自身不可用（例如解码器异常）时也必须留待复核记录，不能当作通过。 */
export function makeQaFailureReport({ run, deliverable, attempt, spec, truth, error, now = new Date() } = {}) {
  const at = iso(now);
  const checks = [check({
    code: 'QA_SERVICE', label: '质量检查服务', status: 'unknown', severity: 'high',
    required: true, adjudicable: false,
    evidence: { reason: error?.code ?? 'QA_INTERNAL_ERROR', note: '检查器异常，不能据此放行' },
    suggestedAction: '修复检查器后重新检查',
  })];
  const { decision, reasons } = decideQuality(checks);
  return {
    id: `qr_${randomBytes(8).toString('hex')}`,
    schema_version: 1,
    tenant_id: run?.tenant_id ?? null,
    project_id: run?.project_id ?? null,
    run_id: run?.id ?? null,
    deliverable_id: deliverable?.deliverable_id ?? attempt?.deliverable_id ?? null,
    attempt_id: attempt?.id ?? null,
    generation_record_id: null,
    asset_version: { hash: attempt?.output_file?.hash ?? null, format: attempt?.output_file?.format ?? null, width: null, height: null, bytes: 0 },
    output_file: { hash: attempt?.output_file?.hash ?? null, format: attempt?.output_file?.format ?? null },
    spec_ref: spec ? { version: spec.version, content_hash: spec.content_hash, template_id: spec.template?.id ?? null, template_version: spec.template?.version ?? null } : null,
    truth_ref: { version: truth?.version ?? null, content_hash: truth?.content_hash ?? null },
    brand_kit_ref: null,
    rules_ref: null,
    checker_versions: { ...CHECKER_VERSIONS },
    subject_context: null,
    upstream: null,
    checks,
    scores: { aesthetic: null, note: '检查服务异常，未产生美学分' },
    machine_decision: decision,
    decision,
    decision_reasons: reasons,
    platform_compliance: 'unknown',
    can_claim_platform_compliance: false,
    human_review: null,
    reviews: [],
    checked_at: at,
    created_at: at,
    updated_at: at,
  };
}

const nonEmptyEvidence = value => {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
};

/**
 * 人工复核。只允许覆盖"机器状态 unknown 且 adjudicable"的检查项；
 * 硬失败、商品事实、平台硬失败都不会因为复核而变绿。
 */
export function applyHumanReview(report, { reviewer, decisions = [], note = null, now = new Date() } = {}) {
  if (!report) throw new ApiError(404, 'NOT_FOUND', '质量报告不存在');
  if (typeof reviewer !== 'string' || reviewer.trim() === '') {
    throw new ApiError(400, 'INVALID_ACTOR', '复核人标识无效');
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new ApiError(422, 'INVALID_REVIEW', '复核至少需要一项裁决');
  }
  const byCode = new Map((report.checks ?? []).map(item => [item.code, item]));
  const seen = new Set();
  const normalized = [];
  for (const item of decisions) {
    const code = typeof item?.code === 'string' ? item.code.trim() : '';
    const target = byCode.get(code);
    if (!target) throw new ApiError(422, 'UNKNOWN_CHECK', `检查项 ${code || '(空)'} 不在该报告中`);
    if (seen.has(code)) throw new ApiError(422, 'DUPLICATE_CHECK', `检查项 ${code} 重复裁决`);
    seen.add(code);
    if (target.status !== 'unknown') {
      throw new ApiError(422, 'REVIEW_NOT_ADJUDICABLE', `检查项 ${code} 的机器结论为 ${target.status}，人工复核只能裁决未知项`);
    }
    if (target.adjudicable !== true) {
      throw new ApiError(422, 'REVIEW_NOT_ADJUDICABLE', `检查项 ${code} 不可由人工裁决，需要通过修复或更新规则后重检`);
    }
    const verdict = item.decision;
    if (verdict !== 'pass' && verdict !== 'fail') {
      throw new ApiError(422, 'INVALID_REVIEW', `检查项 ${code} 的裁决只能是 pass 或 fail`);
    }
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (reason.length < REVIEW_REASON_MIN) {
      throw new ApiError(422, 'REVIEW_REASON_REQUIRED', `检查项 ${code} 必须填写复核理由`);
    }
    if (!nonEmptyEvidence(item.evidence)) {
      throw new ApiError(422, 'REVIEW_EVIDENCE_REQUIRED', `检查项 ${code} 必须提供复核证据`);
    }
    normalized.push({ code, decision: verdict, reason, evidence: item.evidence });
  }

  const at = iso(now);
  const review = {
    id: `rv_${randomBytes(8).toString('hex')}`,
    reviewer: reviewer.trim(),
    created_at: at,
    note: typeof note === 'string' && note.trim() ? note.trim() : null,
    decisions: normalized,
  };
  report.reviews = [...(report.reviews ?? []), review];
  const resolved = resolveEffectiveChecks(report);
  const { decision, reasons } = decideQuality(resolved);
  report.decision = decision;
  report.decision_reasons = reasons;
  report.human_review = review;
  report.updated_at = at;
  return report;
}

/** 展示用报告：机器证据 + 生效状态 + 有效性。 */
export function presentReport(report, validity = { validity: 'current', reasons: [] }) {
  return {
    ...report,
    checks: resolveEffectiveChecks(report),
    validity: validity.validity ?? 'current',
    validity_reasons: validity.reasons ?? [],
  };
}
