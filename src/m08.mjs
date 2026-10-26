/**
 * M08 自动修订、版本管理与正式导出。
 *
 * 边界（PRD FR-023—FR-025、FR-036—FR-037）：
 * 1. 自动修订只处理机器能判定为"可修复"的硬失败，一次只推进一个关键项。
 * 2. 每轮保留通过项、记录变化项与原因；连续两轮关键问题无改善、轮数或预算触顶即停。
 * 3. 版本只增不改；回退只切换 active 标记，原文件与原报告不动，有效性按当前上下文另算。
 * 4. 导出前重算事实、快照、规则与文件哈希；stale 不得进入正式包。
 *    complete 要求全部交付物可发布；partial 只含可发布项并显式列出缺失。
 */
import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

export const M08_VERSION = 'm08.1';
export const REVISION_MAX_ROUNDS = 3;
export const REVISION_MAX_NO_IMPROVEMENT = 2;
export const EXPORT_SCHEMA_VERSION = 1;
export const PACKAGE_FORMAT_VERSION = 'qtb-package.1';

/** 哪些检查项属于"系统可以要求供应商重做"的可修复问题。 */
export const FIXABLE_CHECKS = Object.freeze({
  FILE_INTEGRITY: '文件损坏或哈希不符，重做',
  FILE_FORMAT: '输出格式不符合交付清单，按要求格式重做',
  SIZE: '尺寸或比例不符合清单，按目标尺寸重做',
  RISK_CONTENT: '空白、重复或高风险画面，重做',
});

const PRIORITY = ['FILE_INTEGRITY', 'FILE_FORMAT', 'SIZE', 'RISK_CONTENT'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = at => new Date(at).toISOString();
const versionId = () => `ver_${randomBytes(8).toString('hex')}`;
const exportId = () => `exp_${randomBytes(8).toString('hex')}`;

/**
 * 修订计划：只看硬失败且可修复的检查项，按严重度排序取一个。
 * 未知项（OCR、事实、平台等）不在自动修订范围内，必须人工或更新规则后重检。
 */
export function planRevision({ report, deliverable } = {}) {
  if (!report) return { revise: false, reason: 'NO_REPORT', actions: [], preserve_checks: [] };
  if (report.decision !== 'blocked') {
    return { revise: false, reason: 'NOT_BLOCKED', actions: [], preserve_checks: [] };
  }
  const failures = (report.checks ?? [])
    .filter(item => item.status === 'fail' && item.hard_gate === true && FIXABLE_CHECKS[item.code])
    .sort((left, right) => PRIORITY.indexOf(left.code) - PRIORITY.indexOf(right.code));
  if (failures.length === 0) {
    return {
      revise: false,
      reason: 'NO_FIXABLE_HARD_FAILURE',
      actions: [],
      preserve_checks: (report.checks ?? []).filter(item => item.status === 'pass').map(item => item.code),
    };
  }
  const head = failures[0];
  const parameters = head.code === 'SIZE'
    ? { target_width: deliverable?.width ?? null, target_height: deliverable?.height ?? null, ratio: deliverable?.ratio ?? null }
    : head.code === 'FILE_FORMAT'
      ? { formats: [...(deliverable?.formats ?? [])] }
      : { reason: head.evidence?.reason ?? head.code };
  return {
    revise: true,
    reason: 'FIXABLE_HARD_FAILURE',
    actions: [{ code: head.code, action: 'regenerate', parameters }],
    // 已通过项必须保留：修订请求显式携带，复检时逐项比对
    preserve_checks: (report.checks ?? []).filter(item => item.status === 'pass').map(item => item.code),
  };
}

/** 修订结果对比：关键项是否解决、通过项是否退化、保留项是否仍在。 */
export function compareRevisionOutcome({ beforeReport, afterReport, actions = [] } = {}) {
  const before = new Map((beforeReport?.checks ?? []).map(item => [item.code, item.status]));
  const after = new Map((afterReport?.checks ?? []).map(item => [item.code, item.status]));
  const targeted = actions.map(item => item.code);
  const resolved = targeted.filter(code => before.get(code) === 'fail' && after.get(code) !== 'fail');
  const stillFailing = targeted.filter(code => after.get(code) === 'fail');
  const regressions = [...before.entries()]
    .filter(([code, status]) => status === 'pass' && after.get(code) === 'fail')
    .map(([code]) => code);
  const retained = [...before.entries()]
    .filter(([code, status]) => status === 'pass' && after.get(code) === 'pass')
    .map(([code]) => code);
  return {
    improved: resolved.length > 0 && regressions.length === 0,
    resolved,
    still_failing: stillFailing,
    regressions,
    retained,
    before_decision: beforeReport?.decision ?? null,
    after_decision: afterReport?.decision ?? null,
  };
}

// ---------- 版本 ----------

export function makeVersionRecord({
  run, attempt, deliverable, report, output = {}, at = new Date(),
} = {}) {
  const sameDeliverable = (run?.versions ?? []).filter(item => item.deliverable_id === attempt.deliverable_id);
  return {
    id: versionId(),
    schema_version: 1,
    tenant_id: run.tenant_id,
    project_id: run.project_id,
    run_id: run.id,
    deliverable_id: attempt.deliverable_id,
    number: sameDeliverable.length + 1,
    attempt_id: attempt.id,
    generation_record_id: report?.generation_record_id ?? null,
    report_id: report?.id ?? null,
    iteration: attempt.iteration,
    revision_round: attempt.revision?.round ?? 0,
    hash: output.sha256 ?? attempt.output_file?.hash ?? null,
    format: output.format ?? attempt.output_file?.format ?? null,
    width: output.width ?? null,
    height: output.height ?? null,
    bytes: output.bytes ?? 0,
    active: true,
    superseded_at: null,
    created_at: iso(at),
    created_by: 'system',
    note: attempt.revision
      ? `第 ${attempt.revision.round} 轮自动修订：${(attempt.revision.actions ?? []).map(item => item.code).join(', ')}`
      : `第 ${attempt.iteration} 轮生成`,
    deliverable_label: deliverable?.label ?? null,
  };
}

// ---------- 导出资格 ----------

function validityOf(reportId, validities) {
  return validities?.[reportId] ?? { validity: 'unknown', reasons: ['未计算报告有效性'] };
}

/**
 * 计算导出内容。不做 I/O，所有资格判定集中在这里，API 层只负责重算上下文。
 * scope=complete 要求全部交付物存在可发布且有效的活动版本；
 * scope=partial 只收集可发布版本，并逐项列出缺失原因。
 */
export function planExport({
  run, versions = [], reports = {}, validities = {}, scope = 'complete',
} = {}) {
  const active = versions.filter(item => item.active === true && item.run_id === run?.id);
  const byDeliverable = new Map();
  for (const item of active) {
    const current = byDeliverable.get(item.deliverable_id);
    if (!current || item.number > current.number) byDeliverable.set(item.deliverable_id, item);
  }
  const missing = [];
  let stale = 0;
  const candidates = [];
  for (const deliverable of run?.deliverables ?? []) {
    const version = byDeliverable.get(deliverable.deliverable_id) ?? null;
    if (!version) {
      missing.push({ deliverable_id: deliverable.deliverable_id, label: deliverable.label, reason: 'NO_ACTIVE_VERSION' });
      continue;
    }
    const report = reports[version.report_id] ?? null;
    const validity = validityOf(version.report_id, validities);
    if (!report) {
      missing.push({ deliverable_id: deliverable.deliverable_id, label: deliverable.label, reason: 'REPORT_MISSING', version_id: version.id });
      continue;
    }
    if (validity.validity !== 'current') {
      stale += 1;
      missing.push({
        deliverable_id: deliverable.deliverable_id, label: deliverable.label,
        reason: 'STALE', version_id: version.id, validity_reasons: validity.reasons ?? [],
      });
      continue;
    }
    const decision = report.decision ?? report.machine_decision ?? 'unknown';
    if (decision !== 'publishable') {
      missing.push({
        deliverable_id: deliverable.deliverable_id, label: deliverable.label,
        reason: decision === 'blocked' ? 'BLOCKED' : 'NEEDS_REVIEW',
        version_id: version.id, report_id: report.id,
      });
      continue;
    }
    candidates.push({ version, report, deliverable });
  }

  const staleCount = stale;
  if (scope === 'complete') {
    if (staleCount > 0) {
      return {
        ok: false, code: 'EXPORT_STALE', scope,
        message: '存在失效结果，必须重新检查后才能导出完整包',
        included: [], missing, stale: staleCount, complete: false,
      };
    }
    if (missing.length > 0) {
      return {
        ok: false, code: 'EXPORT_NOT_READY', scope,
        message: '完整包要求全部必需交付物可发布且有效',
        included: [], missing, stale: 0, complete: false,
      };
    }
    return {
      ok: true, code: 'PACKAGE_COMPLETE', scope,
      message: '完整包：全部交付物可发布且有效',
      included: candidates, missing: [], stale: 0, complete: true,
    };
  }

  if (candidates.length === 0) {
    if (staleCount > 0) {
      return {
        ok: false, code: 'EXPORT_STALE', scope,
        message: '没有当前有效的可发布项，不能导出',
        included: [], missing, stale: staleCount, complete: false,
      };
    }
    return {
      ok: false, code: 'EXPORT_NO_PUBLISHABLE', scope,
      message: '没有通过质量检查的交付物，可先完成人工复核',
      included: [], missing, stale: 0, complete: false,
    };
  }
  return {
    ok: true, code: 'PACKAGE_PARTIAL', scope,
    message: `部分包：仅含 ${candidates.length} 项可发布交付物，缺失 ${missing.length} 项`,
    included: candidates, missing, stale: staleCount, complete: false,
  };
}

export function buildManifest({
  run, spec, plan, provider = null, now = new Date(),
} = {}) {
  const included = plan.included ?? [];
  const entries = included.map(({ version, report, deliverable }) => ({
    deliverable_id: deliverable.deliverable_id,
    label: deliverable.label,
    file: `images/${deliverable.deliverable_id}.${version.format ?? 'png'}`,
    sha256: version.hash,
    format: version.format,
    width: version.width,
    height: version.height,
    bytes: version.bytes,
    version_id: version.id,
    version_number: version.number,
    attempt_id: version.attempt_id,
    report_id: report.id,
    generation_record_id: report.generation_record_id ?? null,
    decision: report.decision,
    validity: 'current',
    revision_round: version.revision_round ?? 0,
    intent: deliverable.type ?? null,
  }));
  return {
    package_format: PACKAGE_FORMAT_VERSION,
    schema_version: EXPORT_SCHEMA_VERSION,
    generated_at: iso(now),
    purpose: plan.scope === 'complete' ? 'formal_publish_package' : 'partial_export',
    scope: plan.scope,
    complete: plan.complete === true,
    run: {
      id: run.id,
      status: run.status,
      terminal_reason: run.terminal_reason ?? null,
      quality_status: run.quality_status ?? null,
      created_at: run.created_at,
    },
    project_id: run.project_id,
    platform: spec?.channel?.platform ?? null,
    spec: {
      version: spec?.version ?? run.spec_ref?.version ?? null,
      content_hash: spec?.content_hash ?? run.spec_ref?.content_hash ?? null,
      template_id: run.spec_ref?.template_id ?? null,
      template_version: run.spec_ref?.template_version ?? null,
    },
    truth: {
      version: spec?.product_truth?.version ?? null,
      content_hash: spec?.product_truth?.content_hash ?? null,
    },
    brand_kit: spec?.brand_kit
      ? { id: spec.brand_kit.id, version: spec.brand_kit.version } : null,
    rules: {
      platform: run.rule_ref?.platform ?? null,
      rule_id: run.rule_ref?.rule_id ?? null,
      version: run.rule_ref?.version ?? null,
      source_verified: false,
      note: '平台规则来源未核验，本包不代表平台审核通过',
    },
    provider: provider ? { id: provider.id ?? null, simulated: provider.simulated === true, acceptance: provider.acceptance ?? null } : null,
    assets: entries,
    missing: plan.missing ?? [],
    content_hash_scope: '清单与文件哈希；不含图片二进制',
  };
}

export function buildQaSummary({ run, plan, now = new Date() } = {}) {
  const deliverableSummaries = (plan.included ?? []).map(({ version, report, deliverable }) => ({
    deliverable_id: deliverable.deliverable_id,
    label: deliverable.label,
    version_id: version.id,
    report_id: report.id,
    decision: report.decision,
    machine_decision: report.machine_decision ?? report.decision,
    platform_compliance: report.platform_compliance ?? 'unknown',
    human_review: report.human_review
      ? { reviewer: report.human_review.reviewer, at: report.human_review.created_at, note: report.human_review.note }
      : null,
    checks: (report.checks ?? []).map(item => ({
      code: item.code,
      label: item.label,
      status: item.status,
      effective_status: item.effective_status ?? item.status,
      severity: item.severity,
      hard_gate: item.hard_gate === true,
      required: item.required === true,
      evidence: item.evidence ?? null,
      suggested_action: item.suggested_action ?? null,
    })),
  }));
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    generated_at: iso(now),
    run_id: run.id,
    package_scope: plan.scope,
    quality_status: run.quality_status ?? null,
    platform_compliance: 'not_claimed',
    note: 'OCR 与视觉评审未接入时对应检查为 unknown；人工复核只覆盖可裁决未知项。',
    excluded: plan.missing ?? [],
    deliverables: deliverableSummaries,
  };
}

/** 导出前复核：版本集合事实/规则/文件均需可推导。 */
export function exportBundleName(run, scope, at = new Date()) {
  const stamp = iso(at).replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `qtb-${run.id}-${scope}-${stamp}.zip`;
}

// ---------- 零依赖 ZIP（deflate） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosTime(at) {
  const date = new Date(at);
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * 生成标准 ZIP（deflate 压缩）。entries 顺序即写入顺序；
 * 文件名只允许 ASCII 与固定结构，避免不同平台解压乱码。
 */
export function buildZip(entries = [], { now = new Date() } = {}) {
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes ?? '');
    const compressed = deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

export function zipSha256(bytes) {
  return sha256(bytes);
}

export function exportRecordId() {
  return exportId();
}
