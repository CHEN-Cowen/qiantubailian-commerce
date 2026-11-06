/**
 * P5—P6 套图 manifest 与规则检查（纯函数，不含 IO）。
 *
 * 边界：
 * 1. 套图不是"多张图随便打包"：每个交付物必须有当前选用版本、当前有效报告，并通过单图质量门槛；
 * 2. 跨图可确定性核对的事实/品牌/重复/缺失必须逐项检查；
 * 3. 跨图外观与主体一致性无法由确定性规则证明，保留为 unknown，交人工或已验收视觉评审，
 *    绝不因为"看起来差不多"就标通过；
 * 4. 更新只处理受影响的图仍由 E03 影响清单负责，本模块只回答"这组图能否作为一个套图交付"。
 */
import { createHash } from 'node:crypto';

export const SUITE_FORMAT_VERSION = 'qtb-suite-manifest.1';
export const SUITE_DECISIONS = Object.freeze(['publishable', 'needs_review', 'blocked']);

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = at => new Date(at).toISOString();

function layerFacts(version) {
  const facts = new Map();
  for (const layer of version?.text_layers ?? []) {
    if (layer?.source !== 'fact' || !layer?.fact_key) continue;
    const text = String(layer.text ?? '').trim();
    if (text !== '') facts.set(layer.fact_key, text);
  }
  return facts;
}

function brandRefs(entries = []) {
  return [...new Set(entries
    .filter(item => item?.kind === 'brand' && item.ref)
    .map(item => `${item.ref}@${item.source_version?.brand_kit_version ?? 'unknown'}`))];
}

/**
 * 构建套图清单并给出决策。
 *
 * @param run          任务（提供交付物、规格/事实引用）
 * @param deliverables 分图列表；缺省用 run.deliverables
 * @param versions     版本列表；缺省用 run.versions
 * @param reports      质量报告映射（按 report id）
 * @param validities   报告有效性映射（按 report id，形如 { validity, reasons }）
 * @param dependencies 该任务的依赖记录列表
 * @param truth        冻结事实版本（用于检查关键事实是否至少出现在一张图里）
 * @param brandKit     冻结品牌套件信息（spec.brand_kit）
 */
export function buildSuiteManifest({
  run = null, deliverables = null, versions = null, reports = {}, validities = {},
  dependencies = [], truth = null, brandKit = null, now = new Date(),
} = {}) {
  const list = deliverables ?? run?.deliverables ?? [];
  const allVersions = versions ?? run?.versions ?? [];
  const images = [];
  const checks = [];
  const missing = [];

  const push = (item) => { checks.push(item); };

  for (const deliverable of list) {
    const version = allVersions.find(item =>
      item.deliverable_id === deliverable.deliverable_id && item.active === true) ?? null;
    if (!version) {
      missing.push({ deliverable_id: deliverable.deliverable_id, label: deliverable.label ?? null, reason: 'NO_ACTIVE_VERSION' });
      push({
        code: 'SUITE_IMAGE_MISSING', status: 'fail', hard_gate: true,
        deliverable_id: deliverable.deliverable_id,
        reason: '该交付物没有当前选用版本，套图不完整',
      });
      continue;
    }
    const report = reports[version.report_id] ?? null;
    const validity = validities[version.report_id] ?? { validity: 'unknown', reasons: ['未计算报告有效性'] };
    const record = dependencies.find(item =>
      item.run_id === run?.id && item.deliverable_id === deliverable.deliverable_id
      && item.version_id === version.id) ?? null;
    const entries = record?.entries ?? [];
    const facts = layerFacts(version);
    const brands = brandRefs(entries);

    images.push({
      deliverable_id: deliverable.deliverable_id,
      label: deliverable.label ?? deliverable.deliverable_id,
      required: deliverable.required !== false,
      version_id: version.id,
      version_number: version.number ?? null,
      revision_round: version.revision_round ?? 0,
      report_id: version.report_id ?? null,
      report_decision: report?.decision ?? null,
      report_validity: validity.validity ?? 'unknown',
      sha256: version.hash ?? null,
      format: version.format ?? null,
      width: version.width ?? null,
      height: version.height ?? null,
      dependency_evidence: record ? (entries.some(item => item.evidence === 'deterministic') ? 'deterministic' : 'manual') : 'unknown',
      fact_keys: [...new Set([...facts.keys(), ...entries.filter(item => item.kind === 'fact').map(item => item.ref)])],
      fact_texts: Object.fromEntries(facts),
      brand_refs: brands,
    });

    if (!report) {
      missing.push({ deliverable_id: deliverable.deliverable_id, label: deliverable.label ?? null, reason: 'REPORT_MISSING' });
      push({
        code: 'SUITE_REPORT_MISSING', status: 'fail', hard_gate: true,
        deliverable_id: deliverable.deliverable_id, version_id: version.id,
        reason: '该图没有质量报告，不能作为套图交付',
      });
      continue;
    }
    if (validity.validity !== 'current') {
      missing.push({
        deliverable_id: deliverable.deliverable_id, label: deliverable.label ?? null,
        reason: 'REPORT_STALE', validity_reasons: validity.reasons ?? [],
      });
      push({
        code: 'SUITE_REPORT_STALE', status: 'fail', hard_gate: true,
        deliverable_id: deliverable.deliverable_id, version_id: version.id, report_id: report.id,
        validity: validity.validity ?? 'unknown', reasons: validity.reasons ?? [],
        reason: '报告已失效，必须先重新检查才能作为套图交付',
      });
      continue;
    }
    const decision = report.decision ?? report.machine_decision ?? 'unknown';
    if (decision === 'blocked') {
      push({
        code: 'SUITE_IMAGE_BLOCKED', status: 'fail', hard_gate: true,
        deliverable_id: deliverable.deliverable_id, version_id: version.id, report_id: report.id,
        reason: '该图仍有阻断项，套图不得整体放行',
      });
    } else if (decision !== 'publishable') {
      push({
        code: 'SUITE_IMAGE_NEEDS_REVIEW', status: 'unknown',
        deliverable_id: deliverable.deliverable_id, version_id: version.id, report_id: report.id,
        reason: '该图质量状态为待复核/未知，套图不能标为可发布',
      });
    }
  }

  // 重复：同一套图里出现完全相同的产物，通常是复制而非真正的多图
  const byHash = new Map();
  for (const image of images) {
    if (!image.sha256) continue;
    if (!byHash.has(image.sha256)) byHash.set(image.sha256, []);
    byHash.get(image.sha256).push(image.deliverable_id);
  }
  for (const [hash, ids] of byHash) {
    if (ids.length < 2) continue;
    push({
      code: 'SUITE_DUPLICATE_IMAGE', status: 'fail', hard_gate: true,
      sha256: hash, deliverable_ids: ids,
      reason: '多张交付物输出完全相同，套图存在重复图',
    });
    missing.push({ reason: 'DUPLICATE_IMAGE', sha256: hash, deliverable_ids: ids });
  }

  // 跨图事实：同一 fact_key 的文字不一致 → 事实冲突（确定性硬失败）
  const factUsages = new Map();
  for (const image of images) {
    for (const [key, text] of Object.entries(image.fact_texts ?? {})) {
      if (!factUsages.has(key)) factUsages.set(key, []);
      factUsages.get(key).push({ deliverable_id: image.deliverable_id, text });
    }
  }
  for (const [key, usages] of factUsages) {
    const texts = [...new Set(usages.map(item => item.text))];
    if (texts.length > 1) {
      push({
        code: 'SUITE_FACT_CONFLICT', status: 'fail', hard_gate: true,
        fact_key: key, values: texts, deliverable_ids: usages.map(item => item.deliverable_id),
        reason: `不同图片对事实「${key}」的展示文字不一致，套图存在跨图事实冲突`,
      });
    }
  }

  // 品牌：同一套图不得混用不同品牌版本；有品牌套件但部分图缺少品牌依赖 → 待人工核对
  const brandVersionSet = new Set(images.flatMap(item => item.brand_refs ?? []));
  if (brandVersionSet.size > 1) {
    push({
      code: 'SUITE_BRAND_VERSION_CONFLICT', status: 'fail', hard_gate: true,
      brand_refs: [...brandVersionSet],
      reason: '同一套图混用了不同品牌套件版本，需统一后重出',
    });
  }
  if (brandKit?.id) {
    const withoutBrand = images.filter(item => (item.brand_refs ?? []).length === 0);
    if (brandVersionSet.size > 0 && withoutBrand.length > 0) {
      push({
        code: 'SUITE_BRAND_COVERAGE_UNKNOWN', status: 'unknown',
        deliverable_ids: withoutBrand.map(item => item.deliverable_id),
        reason: '部分图片没有品牌依赖记录：无法断定品牌色/Logo 是否一致，需人工核对',
      });
    }
  }

  // 信息缺失：冻结事实里的关键事实必须至少出现在一张图；否则需人工确认是否遗漏
  if (truth) {
    const referenced = new Set(images.flatMap(item => item.fact_keys ?? []));
    const missingCritical = (truth.facts ?? [])
      .filter(fact => fact?.critical === true)
      .filter(fact => !referenced.has(fact.key))
      .map(fact => fact.key);
    if (missingCritical.length > 0) {
      push({
        code: 'SUITE_CRITICAL_FACT_MISSING', status: 'unknown',
        fact_keys: missingCritical,
        reason: '关键事实未出现在任何一张图的依赖记录中：不能断定套图已完整表达，需人工确认',
      });
    }
  }

  // 外观/主体一致性：确定性规则只能核对元数据，不能代替看图
  if (images.length > 1) {
    push({
      code: 'SUITE_APPEARANCE_UNVERIFIED', status: 'unknown',
      deliverable_ids: images.map(item => item.deliverable_id),
      reason: '跨图外观与主体一致性无法由确定性规则证明，需人工或已验收的视觉评审确认',
    });
  }

  if (images.length === 0) {
    push({
      code: 'SUITE_EMPTY', status: 'fail', hard_gate: true,
      reason: '没有可交付的图片，不能生成套图清单',
    });
  }

  const failures = checks.filter(item => item.status === 'fail');
  const unknowns = checks.filter(item => item.status === 'unknown');
  const decision = failures.length > 0 ? 'blocked' : (unknowns.length > 0 ? 'needs_review' : 'publishable');
  const core = {
    suite_format: SUITE_FORMAT_VERSION,
    schema_version: 1,
    run_id: run?.id ?? null,
    images: images.map(item => ({
      deliverable_id: item.deliverable_id, version_id: item.version_id, sha256: item.sha256,
    })),
    checks: checks.map(item => ({ code: item.code, status: item.status })),
  };
  return {
    suite_format: SUITE_FORMAT_VERSION,
    schema_version: 1,
    suite_id: `suite_${sha256(core).slice(0, 16)}`,
    generated_at: iso(now),
    tenant_id: run?.tenant_id ?? null,
    project_id: run?.project_id ?? null,
    run_id: run?.id ?? null,
    spec: run?.spec_ref ?? null,
    truth: truth ? { version: truth.version ?? null, content_hash: truth.content_hash ?? null } : null,
    brand_kit: brandKit ? { id: brandKit.id ?? null, version: brandKit.version ?? null } : null,
    decision,
    decision_label: decision === 'publishable'
      ? '套图可交付'
      : decision === 'blocked' ? '套图被阻断，不能整体交付' : '套图待人工/视觉复核，不能标为可交付',
    counts: {
      images: images.length,
      required_images: images.filter(item => item.required).length,
      fail: failures.length,
      unknown: unknowns.length,
      blocked_images: images.filter(item => item.report_decision === 'blocked').length,
    },
    images,
    checks,
    missing,
    note: '跨图外观/主体一致性未由确定性规则证明；未知项不等于通过。',
  };
}
