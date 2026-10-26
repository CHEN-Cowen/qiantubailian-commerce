/**
 * M07 测试：Commerce QA 检查项、硬门槛、未知状态与人工复核。
 *
 * 证据分两层：
 * - 纯函数/像素级：不依赖任何外部服务，可逐项复现；
 * - 端到端：模拟 Provider 跑通"生成 → 自动 QA → 报告查询 → 人工复核 → 失效复检"。
 *
 * 明确不在本模块声称完成的部分：OCR、视觉评审模型、平台官方条款核验。
 * 没有这些能力时，报告只能是 unknown / needs_review，不能写 pass。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import {
  compositeSubject, createSubjectMask, decodePng, encodeRgbPng,
} from '../src/m06.mjs';
import {
  aggregateQualityStatus, applyHumanReview, computeReportValidity, decideQuality,
  evaluateGenerationQuality, makeQaFailureReport, resolveEffectiveChecks, verifyCompositeOutput,
} from '../src/m07.mjs';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'tester_m07') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));
const NOW = new Date('2026-10-26T12:00:00.000Z');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// ---------- 测试图片 ----------

function gradientPng(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = (x * 4 + y) % 256;
      pixels[index + 1] = (y * 5 + x * 2) % 256;
      pixels[index + 2] = (x * 3 + y * 7) % 256;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

function solidPng(width, height, value = 128) {
  return encodeRgbPng(width, height, Buffer.alloc(width * height * 3, value));
}

const isSubjectPixel = (x, y, width, height) =>
  x >= width * 0.3 && x < width * 0.7 && y >= height * 0.25 && y < height * 0.75;

function subjectPng(width = 64, height = 64) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const subject = isSubjectPixel(x, y, width, height);
      pixels[index] = subject ? 198 : 246;
      pixels[index + 1] = subject ? 36 : 246;
      pixels[index + 2] = subject ? 44 : 246;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

// ---------- 纯函数上下文 ----------

function qualityContext(overrides = {}) {
  return {
    run: {
      id: 'run_qa',
      tenant_id: 'tenant_a',
      project_id: 'proj_qa',
      subject_protection: { required: true, mode: 'mask' },
      subject_context: {
        mask_ref: `mask:verified:${'a'.repeat(64)}`,
        mask_sha256: 'a'.repeat(64),
        cutout_sha256: 'b'.repeat(64),
      },
      ...(overrides.run ?? {}),
    },
    deliverable: {
      deliverable_id: 'main',
      formats: ['png'],
      width: 64,
      height: 64,
      ratio: '1:1',
      ...(overrides.deliverable ?? {}),
    },
    attempt: {
      id: 'atp_qa',
      deliverable_id: 'main',
      iteration: 1,
      subject_protection: { mode: 'mask' },
      result: { output: { width: 64, height: 64 } },
      ...(overrides.attempt ?? {}),
    },
    spec: {
      version: 1,
      content_hash: 'spec_hash_1',
      template: { id: 'tpl_qa', version: 1 },
      brand_kit: null,
      creative_direction: { logo_used: false },
      channel: { platform: '天猫' },
      gaps: { warnings: [] },
      ...(overrides.spec ?? {}),
    },
    truth: {
      version: 1,
      content_hash: 'truth_hash_1',
      facts: [{ key: '容量', value: '50g', critical: true, confirmed: true }],
      critical_text: [{ text: '月光舒缓' }],
      ...(overrides.truth ?? {}),
    },
    channel: {
      rule: {
        id: 'rule_tmall', platform: '天猫', version: 1,
        effective_at: '2026-01-01T00:00:00.000Z', review_due_at: '2027-01-01T00:00:00.000Z',
        source: { verified: false }, constraints: {},
      },
      status: 'current',
      category_covered: true,
      reasons: [],
      ...(overrides.channel ?? {}),
    },
  };
}

function evaluate(overrides = {}, output = {}) {
  const context = qualityContext(overrides);
  const bytes = output.bytes ?? gradientPng(64, 64);
  return evaluateGenerationQuality({
    ...context,
    output: {
      bytes,
      format: output.format ?? 'png',
      sha256: output.sha256 ?? sha(bytes),
      width: output.width ?? 64,
      height: output.height ?? 64,
    },
    subject: { maskBytes: null, cutoutBytes: null, composite: null },
    assets: overrides.assets ?? [],
    now: NOW,
  });
}

const codeOf = (report, code) => report.checks.find(item => item.code === code);

// ---------- 1. 判定规则 ----------

test('M07 判定：硬失败一律 blocked，美学分再高也不能覆盖', () => {
  const checks = [
    { code: 'FILE_FORMAT', label: '文件格式', status: 'fail', hard_gate: true, required: true },
    { code: 'VISUAL_QUALITY', label: '视觉质量', status: 'unknown', required: false },
  ];
  const verdict = decideQuality(checks, { aestheticScore: 0.99 });
  assert.equal(verdict.decision, 'blocked');
  assert.deepEqual(verdict.reasons.blocked.map(item => item.code), ['FILE_FORMAT']);
});

test('M07 判定：必要项未知为 needs_review，不必填项未知不影响', () => {
  const checks = [
    { code: 'SIZE', label: '尺寸', status: 'pass', required: true },
    { code: 'SUBJECT_PROTECTION', label: '主体', status: 'unknown', required: true },
    { code: 'VISUAL_QUALITY', label: '视觉', status: 'unknown', required: false },
  ];
  const verdict = decideQuality(checks);
  assert.equal(verdict.decision, 'needs_review');
  assert.deepEqual(verdict.reasons.review_required.map(item => item.code), ['SUBJECT_PROTECTION']);
});

test('M07 检查：格式不符是硬失败；纯色图与"原图冒充生成图"也硬失败', () => {
  const wrongFormat = evaluate({ deliverable: { formats: ['jpg'] } });
  assert.equal(wrongFormat.decision, 'blocked');
  assert.equal(codeOf(wrongFormat, 'FILE_FORMAT').status, 'fail');

  const flat = evaluate({}, { bytes: solidPng(64, 64, 120) });
  assert.equal(flat.decision, 'blocked');
  assert.equal(codeOf(flat, 'RISK_CONTENT').status, 'fail');

  const sourceBytes = gradientPng(64, 64);
  const duplicated = evaluate({ assets: [{ sha256: sha(sourceBytes), role_status: 'active' }] }, { bytes: sourceBytes });
  assert.equal(duplicated.decision, 'blocked');
  assert.match(codeOf(duplicated, 'RISK_CONTENT').evidence.reason, /IDENTICAL_TO_SOURCE/);
});

test('M07 检查：无 OCR、无视觉模型、平台规则未核验都只算未知，不写成通过', () => {
  const report = evaluate();
  assert.equal(report.decision, 'needs_review');
  for (const code of ['SUBJECT_PROTECTION', 'COLOR', 'TRUTH_FACTS', 'OCR_CRITICAL_TEXT']) {
    const item = codeOf(report, code);
    assert.equal(item.status, 'unknown', code);
    assert.equal(item.required, true, code);
    assert.equal(item.adjudicable, true, code);
  }
  assert.equal(codeOf(report, 'VISUAL_QUALITY').status, 'unknown');
  assert.equal(codeOf(report, 'VISUAL_QUALITY').required, false);
  assert.equal(codeOf(report, 'PLATFORM_RULES').status, 'unknown');
  assert.equal(codeOf(report, 'PLATFORM_RULES').required, false);
  assert.equal(report.platform_compliance, 'unknown');
  assert.equal(report.can_claim_platform_compliance, false);
  assert.equal(report.scores.aesthetic, null);
});

test('M07 检查：平台规则过期或覆盖不足时不可由人工裁决放行', () => {
  const expired = evaluate({
    channel: {
      status: 'expired',
      rule: {
        id: 'rule_tmall', platform: '天猫', version: 1,
        effective_at: '2025-01-01T00:00:00.000Z', review_due_at: '2025-12-31T00:00:00.000Z',
        source: { verified: false }, constraints: {},
      },
      reasons: ['规则已过复核日期'],
    },
  });
  const platform = codeOf(expired, 'PLATFORM_RULES');
  assert.equal(platform.status, 'unknown');
  assert.equal(platform.required, true);
  assert.equal(platform.adjudicable, false);
  assert.throws(() => applyHumanReview(expired, {
    reviewer: 'tester_m07',
    decisions: [{ code: 'PLATFORM_RULES', decision: 'pass', reason: '人工确认', evidence: '截图' }],
  }), error => error.code === 'REVIEW_NOT_ADJUDICABLE');
});

// ---------- 2. 人工复核 ----------

test('M07 复核：只覆盖 unknown 且可裁决项，机器结论不被改写', () => {
  const report = evaluate();
  const before = report.checks.map(item => [item.code, item.status]);
  const decisions = ['SUBJECT_PROTECTION', 'COLOR', 'TRUTH_FACTS', 'OCR_CRITICAL_TEXT']
    .map(code => ({ code, decision: 'pass', reason: '已逐项人工核对', evidence: '人工比对记录 #1' }));
  applyHumanReview(report, { reviewer: 'tester_m07', note: '首轮复核', decisions, now: NOW });

  assert.equal(report.machine_decision, 'needs_review');
  assert.equal(report.decision, 'publishable');
  assert.deepEqual(report.checks.map(item => [item.code, item.status]), before);
  const resolved = resolveEffectiveChecks(report);
  const subject = resolved.find(item => item.code === 'SUBJECT_PROTECTION');
  assert.equal(subject.machine_status, 'unknown');
  assert.equal(subject.effective_status, 'pass');
  assert.equal(subject.adjudication.reviewer, 'tester_m07');
  assert.equal(report.human_review.reviewer, 'tester_m07');
});

test('M07 复核：硬失败、非可裁决项、缺理由、缺证据、重复与未知项全部拒绝', () => {
  const blocked = evaluate({ deliverable: { formats: ['jpg'] } });
  assert.throws(() => applyHumanReview(blocked, {
    reviewer: 'tester_m07',
    decisions: [{ code: 'FILE_FORMAT', decision: 'pass', reason: '想放行', evidence: '无' }],
  }), error => error.code === 'REVIEW_NOT_ADJUDICABLE');

  const report = evaluate();
  const base = { code: 'SUBJECT_PROTECTION', decision: 'pass', reason: '已核对', evidence: '记录' };
  assert.throws(() => applyHumanReview(report, {
    reviewer: 'tester_m07', decisions: [{ ...base, reason: '短' }],
  }), error => error.code === 'REVIEW_REASON_REQUIRED');
  assert.throws(() => applyHumanReview(report, {
    reviewer: 'tester_m07', decisions: [{ ...base, evidence: '' }],
  }), error => error.code === 'REVIEW_EVIDENCE_REQUIRED');
  assert.throws(() => applyHumanReview(report, {
    reviewer: 'tester_m07', decisions: [base, base],
  }), error => error.code === 'DUPLICATE_CHECK');
  assert.throws(() => applyHumanReview(report, {
    reviewer: 'tester_m07', decisions: [{ ...base, code: 'NOT_A_CHECK' }],
  }), error => error.code === 'UNKNOWN_CHECK');
  assert.throws(() => applyHumanReview(report, { reviewer: '', decisions: [base] }),
    error => error.code === 'INVALID_ACTOR');
});

test('M07 复核：检查器异常只能待复核，不能被确认放行', () => {
  const report = makeQaFailureReport({
    run: { id: 'run_x', tenant_id: 'tenant_a', project_id: 'proj_x' },
    deliverable: { deliverable_id: 'main' }, attempt: { id: 'atp_x', deliverable_id: 'main' },
    error: Object.assign(new Error('boom'), { code: 'QA_DECODE_ERROR' }), now: NOW,
  });
  assert.equal(report.decision, 'needs_review');
  assert.equal(codeOf(report, 'QA_SERVICE').status, 'unknown');
  assert.throws(() => applyHumanReview(report, {
    reviewer: 'tester_m07',
    decisions: [{ code: 'QA_SERVICE', decision: 'pass', reason: '人工确认', evidence: '记录' }],
  }), error => error.code === 'REVIEW_NOT_ADJUDICABLE');
});

// ---------- 3. 像素级主体保留 ----------

test('M07 像素：本地合成后掩码内像素逐一相等，篡改一个像素即失败', () => {
  const mask = createSubjectMask({ bytes: subjectPng(), mime: 'image/png' });
  assert.equal(mask.available, true);
  const composed = compositeSubject({
    outputBytes: gradientPng(128, 128), cutoutBytes: mask.cutoutBytes, maskBytes: mask.maskBytes,
  });
  assert.equal(composed.applied, true);

  const output = decodePng(composed.bytes);
  const exact = verifyCompositeOutput({
    outputDecoded: output, maskBytes: mask.maskBytes, cutoutBytes: mask.cutoutBytes,
  });
  assert.equal(exact.exact, true);
  assert.ok(exact.checked > 0);

  const tampered = Buffer.from(output.pixels);
  const center = (64 * 128 + 64) * 4;
  tampered[center] = (tampered[center] + 60) % 256;
  const rgb = Buffer.alloc(128 * 128 * 3);
  for (let index = 0; index < 128 * 128; index += 1) {
    rgb[index * 3] = tampered[index * 4];
    rgb[index * 3 + 1] = tampered[index * 4 + 1];
    rgb[index * 3 + 2] = tampered[index * 4 + 2];
  }
  const damaged = verifyCompositeOutput({
    outputDecoded: decodePng(encodeRgbPng(128, 128, rgb)),
    maskBytes: mask.maskBytes, cutoutBytes: mask.cutoutBytes,
  });
  assert.equal(damaged.exact, false);
  assert.ok(damaged.mismatches >= 1);
});

// ---------- 4. 报告有效性 ----------

test('M07 有效性：事实、快照、品牌、规则或文件任一变化都判为 stale', () => {
  const context = qualityContext();
  const report = evaluate();
  const current = computeReportValidity({
    report, spec: context.spec, truth: context.truth, brandKitVersion: null, channel: context.channel,
    outputExists: true, at: NOW,
  });
  assert.equal(current.validity, 'current');

  const newerTruth = { ...context.truth, version: 2, content_hash: 'truth_hash_2' };
  assert.equal(computeReportValidity({
    report, spec: context.spec, truth: newerTruth, brandKitVersion: null, channel: context.channel,
    outputExists: true, at: NOW,
  }).validity, 'stale');

  assert.equal(computeReportValidity({
    report, spec: { ...context.spec, content_hash: 'spec_hash_2' }, truth: context.truth,
    brandKitVersion: null, channel: context.channel, outputExists: true, at: NOW,
  }).validity, 'stale');

  assert.equal(computeReportValidity({
    report, spec: context.spec, truth: context.truth, brandKitVersion: null,
    channel: context.channel, outputExists: false, at: NOW,
  }).validity, 'stale');

  const expiredChannel = {
    ...context.channel,
    status: 'expired',
    rule: { ...context.channel.rule, version: 2 },
  };
  const expired = computeReportValidity({
    report, spec: context.spec, truth: context.truth, brandKitVersion: null,
    channel: expiredChannel, outputExists: true, at: NOW,
  });
  assert.equal(expired.validity, 'stale');
  assert.ok(expired.reasons.length >= 2);
});

test('M07 汇总：任一交付物 blocked 就不是可发布，缺报告不能算通过', () => {
  const reports = [
    { deliverable_id: 'main', checked_at: '2026-10-26T12:00:01.000Z', decision: 'publishable' },
    { deliverable_id: 'benefit', checked_at: '2026-10-26T12:00:02.000Z', decision: 'publishable' },
  ];
  assert.equal(aggregateQualityStatus(reports, { requireAllDeliverables: true, deliverableCount: 2 }), 'publishable');
  assert.equal(aggregateQualityStatus(reports, { requireAllDeliverables: true, deliverableCount: 3 }), 'not_checked');
  assert.equal(aggregateQualityStatus([
    ...reports, { deliverable_id: 'scene', checked_at: '2026-10-26T12:00:03.000Z', decision: 'blocked' },
  ], { requireAllDeliverables: true, deliverableCount: 3 }), 'blocked');
  assert.equal(aggregateQualityStatus([
    reports[0], { ...reports[1], decision: 'needs_review' },
  ], { requireAllDeliverables: true, deliverableCount: 2 }), 'needs_review');
  assert.equal(aggregateQualityStatus([], { requireAllDeliverables: true, deliverableCount: 0 }), 'not_checked');
});

// ---------- 5. 端到端 ----------

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buffer.toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: buffer, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function start(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm07-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 240, tickMs: 8, attemptTimeoutMs: 2_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

async function readyProject(port, tenant = 'tenant_a') {
  const created = await request(port, '/api/projects', {
    method: 'POST', headers: as(tenant),
    body: { name: 'M07 面霜', sku: 'M07-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const project = created.json.project;

  const asset = await request(port, `/api/projects/${project.id}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': 'image/png' }, body: subjectPng(),
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));

  const truth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(tenant),
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));

  const preview = await request(port, `/api/projects/${project.id}/specs/preview`, {
    method: 'POST', headers: as(tenant), body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${project.id}/specs`, {
    method: 'POST', headers: as(tenant),
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  return { project, spec: frozen.json.spec };
}

async function startRun(port, { projectId, key, tenant = 'tenant_a' }) {
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(tenant), body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  return request(port, '/api/runs', {
    method: 'POST',
    headers: { ...as(tenant), 'Idempotency-Key': key },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
}

async function waitTerminal(port, runId, tenant = 'tenant_a', timeoutMs = 20_000) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeoutMs) {
    const response = await request(port, `/api/runs/${runId}`, { headers: as(tenant) });
    snapshot = response.json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`任务未进入终态，最后状态 ${snapshot?.status}`);
}

test('M07 端到端（模拟）：生成后自动出报告、租户隔离、复核受限且失效后拒收', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const created = await startRun(port, { projectId: project.id, key: 'm07-run' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const run = await waitTerminal(port, created.json.run.id);

  // 模拟 Provider 输出 PNG 且被压到 384 边长：完成不等于可发布
  assert.equal(run.status, 'completed');
  assert.equal(run.quality_status, 'blocked');

  const listed = await request(port, `/api/runs/${run.id}/quality-reports`, { headers: as() });
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  assert.equal(listed.json.total, run.deliverables.length);
  const reports = listed.json.reports;
  assert.ok(reports.every(item => item.decision === 'blocked'));
  assert.ok(reports.every(item => item.generation_record_id), '每条报告都要能追到生成记录');
  assert.ok(reports.every(item => item.validity === 'current'));

  const main = reports.find(item => item.deliverable_id === 'main');
  assert.ok(main, '主图必须有独立报告');
  assert.equal(codeOf(main, 'FILE_FORMAT').status, 'pass', '主图允许 png');
  assert.equal(codeOf(main, 'SIZE').status, 'fail', '模拟图被压缩，尺寸不符');
  assert.equal(codeOf(main, 'SUBJECT_PROTECTION').status, 'unknown');
  assert.equal(codeOf(main, 'SUBJECT_PROTECTION').adjudicable, true);
  assert.equal(codeOf(main, 'PLATFORM_RULES').adjudicable, false);

  const detail = await request(port, `/api/quality-reports/${main.id}`, { headers: as() });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.report.id, main.id);
  assert.ok(detail.json.run);

  const otherTenant = await request(port, `/api/quality-reports/${main.id}`, { headers: as('tenant_demo') });
  assert.equal(otherTenant.status, 404, '跨租户按不存在处理');

  const spoof = await request(port, `/api/quality-reports/${main.id}/reviews`, {
    method: 'POST', headers: as(),
    body: {
      reviewer: 'someone_else',
      decisions: [{ code: 'SUBJECT_PROTECTION', decision: 'pass', reason: '人工核对', evidence: '记录' }],
    },
  });
  assert.equal(spoof.status, 400, '复核人必须来自租户上下文');

  const hardFail = await request(port, `/api/quality-reports/${main.id}/reviews`, {
    method: 'POST', headers: as(),
    body: {
      decisions: [{ code: 'SIZE', decision: 'pass', reason: '人工认为可以', evidence: '截图' }],
    },
  });
  assert.equal(hardFail.status, 422, JSON.stringify(hardFail.json));
  assert.equal(hardFail.json.error, 'REVIEW_NOT_ADJUDICABLE');

  const platform = await request(port, `/api/quality-reports/${main.id}/reviews`, {
    method: 'POST', headers: as(),
    body: {
      decisions: [{ code: 'PLATFORM_RULES', decision: 'pass', reason: '人工确认平台', evidence: '截图' }],
    },
  });
  assert.equal(platform.status, 422, JSON.stringify(platform.json));
  assert.equal(platform.json.error, 'REVIEW_NOT_ADJUDICABLE');

  const reviewed = await request(port, `/api/quality-reports/${main.id}/reviews`, {
    method: 'POST', headers: as('tenant_a', 'reviewer_lead'),
    body: {
      note: '对照主体原图后确认',
      decisions: [{
        code: 'SUBJECT_PROTECTION', decision: 'pass', reason: '逐项对照未发现改写', evidence: '人工比对记录 #1',
      }],
    },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  const reviewedSubject = reviewed.json.report.checks.find(item => item.code === 'SUBJECT_PROTECTION');
  assert.equal(reviewedSubject.machine_status, 'unknown', '机器证据不被改写');
  assert.equal(reviewedSubject.effective_status, 'pass');
  assert.equal(reviewedSubject.adjudication.reviewer, 'reviewer_lead');
  assert.equal(reviewed.json.report.decision, 'blocked', '尺寸硬失败仍然阻断，复核不能变绿');

  // 事实出现新版本：旧报告立即失效，且不能再补复核
  const nextTruth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: 1, confirm: true,
      facts: [
        { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(nextTruth.status, 201, JSON.stringify(nextTruth.json));

  const stale = await request(port, `/api/quality-reports/${main.id}`, { headers: as() });
  assert.equal(stale.status, 200);
  assert.equal(stale.json.report.validity, 'stale');
  assert.ok(stale.json.report.validity_reasons.some(text => text.includes('事实')));

  const staleReview = await request(port, `/api/quality-reports/${main.id}/reviews`, {
    method: 'POST', headers: as(),
    body: {
      decisions: [{ code: 'TRUTH_FACTS', decision: 'pass', reason: '人工核对事实', evidence: '记录' }],
    },
  });
  assert.equal(staleReview.status, 409, JSON.stringify(staleReview.json));
  assert.equal(staleReview.json.error, 'REPORT_STALE');

  const records = await request(port, `/api/runs/${run.id}/generation-records`, { headers: as() });
  assert.equal(records.status, 200);
  assert.ok(records.json.records.every(item => item.qa_report_id), '生成记录与质量报告要一一对应');
});
