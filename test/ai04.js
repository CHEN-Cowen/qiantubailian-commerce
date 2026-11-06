/**
 * 阶段 3：修订建议与人工执行（规划部分）。
 *
 * 只验证"建议"链路：问题汇总、真实能力推导、请求绑定、策略校验、确定性兜底与用户可读计划。
 * 不调用真实模型，不执行修订；可执行动作的人工触发在 HTTP 用例中验证会复用既有重生成流程。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { compareRevisionOutcome } from '../src/m08.mjs';
import {
  ACTION_TITLES, REVISION_PLANNER_VERSION, REVISION_SCHEMA_VERSION, REVISION_SKILL_VERSION,
  buildIssueCatalog, buildRevisionRequest, createRevisionPlanner, createRevisionPlannerFromEnv,
  deterministicPlan, loadRefinerRules, planRevisionAction, presentRevisionPlan, resolveAvailableActions,
  validateRevisionPlan,
} from '../src/revision-planner.mjs';

const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const as = (tenant = 'tenant_a') => ({ 'x-tenant-id': tenant, 'x-actor-id': 'tester_ai04' });
const png = (width, height) => encodeRgbPng(width, height, new Uint8Array(width * height * 3).fill(190));

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
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function check(code, status, overrides = {}) {
  return {
    code, label: code, status, severity: 'high', required: true, hard_gate: true,
    evidence: { reason: `${code} ${status}` }, suggested_action: null, source: 'deterministic',
    ...overrides,
  };
}

function baseReport(checks, overrides = {}) {
  return {
    id: 'qr_1', tenant_id: 'tenant_a', run_id: 'run_1', deliverable_id: 'dlv_main',
    checks, decision: 'blocked', decision_reasons: { blocked: [], review_required: [] },
    machine_decision: 'blocked', artifact_sha256: 'cand_hash', upstream: { composite: null },
    brand_kit_ref: null, checker_versions: { m07: 'm07.1' },
    ...overrides,
  };
}

function baseRequest(overrides = {}) {
  const report = overrides.report ?? baseReport([check('FILE_INTEGRITY', 'fail')]);
  return buildRevisionRequest({
    project: { id: 'prj_1', name: '陶瓷马克杯', sku: 'SKU-01' },
    run: {
      id: 'run_1', tenant_id: 'tenant_a', project_id: 'prj_1',
      product_context: { context_hash: 'ctx_abc' },
      versions: [{ id: 'ver_2', active: true, deliverable_id: 'dlv_main', hash: 'cand_hash' }],
      revision: { round: 0 },
    },
    deliverable: {
      deliverable_id: 'dlv_main', label: '主图', type: 'main_image', width: 1200, height: 1200,
      ratio: '1:1', formats: ['jpg'], text_blocks: ['fact:容量'],
    },
    report,
    truth: { version: 2, content_hash: 'truth_hash', facts: [{ key: '容量', value: '350ml', critical: true, confirmed: true }] },
    spec: { version: 3, content_hash: 'spec_hash' },
    brandKitVersion: { brand_kit_id: 'bk_1', version: 4, palette: { primary: '#111111' } },
    providerCapabilities: { supports_seed: true, supports_mask: false },
    hasTextLayers: true,
    hasSubjectProtection: true,
    maxRounds: 3,
    ...overrides,
  });
}

function validPlan(request, overrides = {}) {
  const issue = request.issue_catalog.find(item => item.allowed_actions.length > 0);
  return {
    schema_version: REVISION_SCHEMA_VERSION,
    skill_version: REVISION_SKILL_VERSION,
    context_hash: request.context_hash,
    source_version_id: request.source_version_id,
    based_on_report_id: request.report_id,
    decision: 'propose_action',
    action: issue.allowed_actions[0],
    target_check_codes: [issue.code],
    locked_constraints: [...request.locked_constraints],
    parameters: {},
    instruction: `只修复 ${issue.code}，保留其他通过项`,
    reason: '存在可修复问题且能力可用',
    material_requests: [],
    ...overrides,
  };
}

function fakePlanner(output, { status = 'ok', reason = '模拟失败', delayMs = 0 } = {}) {
  return {
    configured: true, mode: 'test', model: 'fake-refiner', acceptance: 'not_verified', calls: [],
    async plan(args) {
      this.calls.push(args);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      return status === 'ok'
        ? { status: 'ok', output, latency_ms: 5, model: 'fake-refiner', request_id: 'req_plan_1' }
        : { status, reason, output: null, latency_ms: 2 };
    },
  };
}

// ---------- 1. 规则装配 ----------
test('P3 规则装配：系统提示包含修订 Skill 与动作规则，规则哈希可复现', async () => {
  const rules = await loadRefinerRules();
  assert.match(rules.rules_hash, /^refiner_rules_[0-9a-f]{64}$/);
  assert.match(rules.system, /商品图修订规划组件/);
  assert.match(rules.system, /动作选择/);
  assert.match(rules.system, /只使用一个动作/);
  assert.equal(rules.skill_version, REVISION_SKILL_VERSION);
  assert.equal(rules.schema_version, REVISION_SCHEMA_VERSION);
  assert.equal(rules.output_schema.properties.schema_version.const, REVISION_SCHEMA_VERSION);
  const again = await loadRefinerRules();
  assert.equal(again.rules_hash, rules.rules_hash);
});

// ---------- 2. 真实能力推导 ----------
test('P3 能力推导：只有真实具备的能力才进入 available_actions', () => {
  assert.deepEqual(resolveAvailableActions({}), ['convert_format', 'resize_canvas']);
  assert.deepEqual(resolveAvailableActions({ providerCapabilities: { supports_mask: false, supports_seed: true } }),
    ['convert_format', 'resize_canvas', 'regenerate_background', 'regenerate_image']);
  assert.ok(!resolveAvailableActions({ providerCapabilities: { supports_seed: true, supports_mask: false } }).includes('masked_edit'));
  assert.ok(resolveAvailableActions({ providerCapabilities: { supports_mask: true } }).includes('masked_edit'));
  assert.ok(resolveAvailableActions({ hasTextLayers: true }).includes('recompose_text'));
  assert.ok(resolveAvailableActions({ hasSubjectProtection: true }).includes('recompose_subject'));
  const local = resolveAvailableActions({});
  assert.ok(!local.includes('regenerate_image'), '没有生成能力时不能出现重新生成');
});

// ---------- 3. 问题汇总 ----------
test('P3 问题汇总：只收录失败与必需未知，通过项和非必需未知不进修订范围', () => {
  const report = baseReport([
    check('FILE_INTEGRITY', 'pass', { required: false, hard_gate: false }),
    check('FILE_FORMAT', 'fail'),
    check('VISUAL_QUALITY', 'unknown', { required: false, hard_gate: false, severity: 'low' }),
    check('SUBJECT_PROTECTION', 'unknown', { required: true, hard_gate: true }),
    check('REVIEW_PACKAGE_TEXT', 'fail'),
  ]);
  const available = resolveAvailableActions({
    providerCapabilities: { supports_seed: true, supports_mask: false },
    hasTextLayers: true, hasSubjectProtection: true,
  });
  const issues = buildIssueCatalog({ report, availableActions: available });
  assert.deepEqual(issues.map(item => item.code), ['FILE_FORMAT', 'SUBJECT_PROTECTION', 'REVIEW_PACKAGE_TEXT']);
  assert.equal(issues[0].kind, 'fail');
  assert.equal(issues[1].kind, 'unknown', '必需但未知的检查也要进入问题清单');
  assert.ok(issues[0].allowed_actions.includes('convert_format'));
  assert.deepEqual(issues[2].allowed_actions, [], '包装文字与包含物不能靠重绘掩盖');
  assert.equal(issues[2].needs_material, true);
  const noGeneration = buildIssueCatalog({ report, availableActions: ['convert_format', 'resize_canvas'] });
  assert.equal(noGeneration.find(item => item.code === 'SUBJECT_PROTECTION').allowed_actions.length, 0,
    '没有主体保护能力时不得给出主体动作');
});

// ---------- 4. 请求绑定 ----------
test('P3 请求绑定：报告哈希、上下文、成品版本与轮次限制被冻结', () => {
  const request = baseRequest();
  assert.equal(request.schema_version, REVISION_SCHEMA_VERSION);
  assert.equal(request.context_hash, 'ctx_abc');
  assert.match(request.report_hash, /^report_[0-9a-f]{64}$/);
  assert.equal(request.source_version_id, 'ver_2');
  assert.equal(request.artifact_hash, 'cand_hash');
  assert.deepEqual(request.preserve_check_codes, []);
  assert.ok(request.locked_constraints.includes('preserve_passed_checks'));
  assert.ok(request.locked_constraints.includes('preserve_confirmed_critical_facts'));
  assert.deepEqual(request.limits, { max_rounds: 3, round_used: 0, remaining_rounds: 3, no_improvement_limit: 2 });
  assert.ok(!request.available_actions.includes('masked_edit'));
});

test('P3 缺原始参考图：没有生效版本时明确标注，不伪造成品哈希', () => {
  const request = buildRevisionRequest({
    project: { id: 'prj_1', sku: 'SKU-01' },
    run: { id: 'run_1', versions: [], product_context: { context_hash: 'ctx_abc' }, revision: { round: 0 } },
    deliverable: { deliverable_id: 'dlv_main', formats: [] },
    report: baseReport([check('FILE_INTEGRITY', 'fail')], { artifact_sha256: null }),
  });
  assert.equal(request.source_version_id, 'artifact:dlv_main');
  assert.equal(request.artifact_hash, null, '缺原始版本时不能编造成品哈希');
  // 没有生成能力 → 文件失败只能本地/人工处理；这里用作"缺参考图后不得 propose 重新生成"的前提
  assert.ok(!request.available_actions.includes('regenerate_image'));
});

// ---------- 5. 策略校验 ----------
test('P3 不支持动作：能力未开放的动作被服务端拒绝', () => {
  const request = baseRequest();
  const bad = validPlan(request, { action: 'masked_edit', target_check_codes: ['SUBJECT_PROTECTION'] });
  const result = validateRevisionPlan(bad, request);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.code === 'ACTION_NOT_AVAILABLE'));

  const mixed = baseRequest({
    report: baseReport([check('FILE_FORMAT', 'fail'), check('SIZE', 'fail')]),
  });
  const crossIssue = validPlan(mixed, { action: 'convert_format', target_check_codes: ['SIZE'] });
  const cross = validateRevisionPlan(crossIssue, mixed);
  assert.equal(cross.ok, false);
  assert.ok(cross.errors.some(item => item.code === 'TARGET_ACTION_MISMATCH'),
    '格式动作不能用来修复尺寸问题');
});

test('P3 通过项退步：不能把已通过项当目标，复检退步必须判为未改善', () => {
  const report = baseReport([
    check('FILE_INTEGRITY', 'pass', { required: false, hard_gate: false }),
    check('SIZE', 'fail'),
  ]);
  const request = baseRequest({ report });
  const plan = validPlan(request, { target_check_codes: ['FILE_INTEGRITY'] });
  const result = validateRevisionPlan(plan, request);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.code === 'TARGET_NOT_FAILED'));

  const outcome = compareRevisionOutcome({
    beforeReport: report,
    afterReport: baseReport([check('FILE_INTEGRITY', 'fail'), check('SIZE', 'pass')]),
    actions: [{ code: 'SIZE' }],
  });
  assert.equal(outcome.improved, false, '目标解决但通过项退步不算改善');
  assert.deepEqual(outcome.regressions, ['FILE_INTEGRITY']);

  const requestBound = baseRequest({
    report: baseReport([check('FILE_INTEGRITY', 'pass', { required: false, hard_gate: false }), check('SIZE', 'fail')]),
  });
  assert.deepEqual(requestBound.preserve_check_codes, ['FILE_INTEGRITY'], '通过项必须写入保留清单');
});

test('P3 错误绑定：上下文、成品版本与报告不一致直接拒绝', () => {
  const request = baseRequest();
  const tampered = validPlan(request, {
    context_hash: 'ctx_other', source_version_id: 'ver_other', based_on_report_id: 'qr_other',
  });
  const result = validateRevisionPlan(tampered, request);
  assert.equal(result.ok, false);
  const codes = result.errors.map(item => item.code);
  assert.ok(codes.includes('BINDING_MISMATCH'));
  assert.equal(result.errors.filter(item => item.code === 'BINDING_MISMATCH').length, 3);
});

test('P3 参数注入：路径、URL 与脚本不得进入修订参数', () => {
  const request = baseRequest();
  for (const parameters of [
    { url: 'http://evil.example/steal' },
    { api_key: 'sk-live' },
    { note: '../../../etc/passwd' },
    { nested: { script: 'rm -rf /' } },
  ]) {
    const result = validateRevisionPlan(validPlan(request, { parameters }), request);
    assert.equal(result.ok, false, JSON.stringify(parameters));
    assert.ok(result.errors.some(item => item.code === 'INVALID_PARAMETERS' || item.path?.startsWith('parameters')),
      `参数注入未被拦截：${JSON.stringify(parameters)}`);
  }
});

test('P3 轮次限制：轮次用尽后不能再提出动作，只能停止', () => {
  const request = baseRequest();
  request.limits = { ...request.limits, round_used: 3, remaining_rounds: 0 };
  const proposed = validPlan(request);
  const result = validateRevisionPlan(proposed, request);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.code === 'ROUND_LIMIT_REACHED'));
  const fallback = deterministicPlan({ request });
  assert.equal(fallback.decision, 'stop');
  assert.match(fallback.reason, /轮次已用尽/);
});

test('P3 补实拍：没有合法工具路径时必须要求补素材，不能强行重绘', () => {
  const report = baseReport([check('REVIEW_PACKAGE_TEXT', 'fail')]);
  const request = baseRequest({ report });
  const plan = deterministicPlan({ request });
  assert.equal(plan.decision, 'needs_material');
  assert.ok(plan.material_requests.length > 0);
  assert.ok(plan.material_requests.some(item => item.includes('REVIEW_PACKAGE_TEXT')));
  const malformed = {
    schema_version: REVISION_SCHEMA_VERSION,
    skill_version: REVISION_SKILL_VERSION,
    context_hash: request.context_hash,
    source_version_id: request.source_version_id,
    based_on_report_id: request.report_id,
    decision: 'needs_material', action: null, instruction: null, parameters: {}, target_check_codes: [],
    locked_constraints: [...request.locked_constraints],
    reason: '需要补充素材', material_requests: [],
  };
  const result = validateRevisionPlan(malformed, request);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.code === 'MATERIAL_REQUIRED'));
});

test('P3 人工复核：仍有合法动作时不能直接转复核', () => {
  const request = baseRequest();
  const plan = validPlan(request, {
    decision: 'needs_review', action: null, instruction: null, parameters: {}, target_check_codes: [],
  });
  const result = validateRevisionPlan(plan, request);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.code === 'REVIEW_NOT_JUSTIFIED'));
});

// ---------- 6. 未配置与失败降级 ----------
test('P3 未配置规划模型：显式未配置，使用确定性建议且仍要求人工确认', async () => {
  const planner = createRevisionPlannerFromEnv({});
  assert.equal(planner.configured, false);
  assert.equal(planner.mode, 'not_configured');
  const request = baseRequest();
  const plan = await planRevisionAction({ planner, request });
  assert.equal(plan.status, 'not_configured');
  const view = presentRevisionPlan({ plan, report: request && baseReport([check('FILE_INTEGRITY', 'fail')]) });
  assert.equal(view.status, 'deterministic');
  assert.equal(view.decision, 'propose_action');
  assert.equal(view.version, REVISION_PLANNER_VERSION);
  assert.equal(view.executable, false, '未配置模型也只能给建议');
  assert.equal(view.executed, false);
  assert.equal(view.requires_confirmation, true);
  assert.ok(view.steps.some(item => item.includes('动作：')));
  assert.ok(view.steps.some(item => item.includes('重新评审')));
});

test('P3 规划输出非法：整体降级为确定性建议，并展示拒绝原因', async () => {
  const request = baseRequest();
  const tampered = validPlan(request, { context_hash: 'ctx_wrong', locked_constraints: [] });
  const planner = fakePlanner(tampered);
  const plan = await planRevisionAction({ planner, rules: await loadRefinerRules(), request });
  assert.equal(plan.status, 'invalid_output');
  assert.equal(plan.validation.ok, false);
  assert.ok(plan.validation.errors.some(item => item.code === 'BINDING_MISMATCH'));
  const view = presentRevisionPlan({ plan, report: baseReport([check('FILE_INTEGRITY', 'fail')]) });
  assert.equal(view.status, 'invalid_output');
  assert.equal(view.executable, false);
  assert.ok(view.steps.some(item => item.includes('校验失败原因')));
  assert.ok(view.steps.some(item => item.includes('BINDING_MISMATCH')));
});

test('P3 规划端点失败：超时与 HTTP 错误都降级，不抛出', async () => {
  for (const status of ['timeout', 'http_error']) {
    const planner = fakePlanner(null, { status, reason: `${status} 模拟` });
    const plan = await planRevisionAction({ planner, rules: await loadRefinerRules(), request: baseRequest() });
    assert.equal(plan.status, status);
    const view = presentRevisionPlan({ plan, report: baseReport([check('FILE_INTEGRITY', 'fail')]) });
    assert.equal(view.executable, false);
    assert.equal(view.decision, 'propose_action', '失败后用确定性建议兜底');
  }
});

test('P3 模型返回非法 JSON：Adapter 归类为 invalid_json', async () => {
  const planner = createRevisionPlanner({
    endpoint: 'http://127.0.0.1:9/plan',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }),
  });
  const result = await planner.plan({ system: 's', user: 'u' });
  assert.equal(result.status, 'invalid_json');
  assert.equal(result.output, null);
});

test('P3 建议不执行：计划只包含人工确认，不含任何执行或计费字段', async () => {
  const request = baseRequest();
  const plan = {
    status: 'ok', output: validPlan(request), request, rules_hash: 'refiner_rules_x',
    model: 'fake-refiner', latency_ms: 5, request_id: 'req_1',
  };
  const view = presentRevisionPlan({ plan, report: baseReport([check('FILE_INTEGRITY', 'fail')]) });
  assert.equal(view.status, 'proposed');
  assert.equal(view.executable, false);
  assert.equal(view.executed, false);
  assert.equal(view.requires_confirmation, true);
  assert.equal(view.action, 'regenerate_image');
  assert.deepEqual(view.target_check_codes, ['FILE_INTEGRITY']);
  assert.equal(view.rules_hash, 'refiner_rules_x');
  assert.ok(!('credits' in view) && !('cost' in view));
  assert.ok(!view.steps.some(item => item.startsWith('已执行')));
});

// ---------- 7. HTTP：规划与人工触发执行 ----------
async function bootstrapRun(port, headers = as()) {
  const created = await request(port, '/api/projects', {
    method: 'POST', headers, body: { name: 'AI04 马克杯', sku: 'SKU-AI04', category: '杯具', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;
  const uploaded = await request(port, `/api/projects/${projectId}/assets?role=subject&filename=shot.png`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: png(1200, 1200),
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  const truth = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers,
    body: {
      base_version: 0, confirm: true,
      facts: [{ key: '容量', value: '350ml', critical: true, confirmed: true, source_type: 'user_input' }],
      critical_text: [{ text: '350ml' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  const preview = await request(port, `/api/projects/${projectId}/specs/preview`, {
    method: 'POST', headers, body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${projectId}/specs`, {
    method: 'POST', headers,
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers, body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const start = await request(port, '/api/runs', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'ai04-run' },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  const runId = start.json.run.id;
  const started = Date.now();
  let run = null;
  while (Date.now() - started < 20_000) {
    const response = await request(port, `/api/runs/${runId}`, { headers });
    run = response.json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(['completed', 'limit_reached'].includes(run.status), `任务未正常结束：${run.status}`);
  const reports = await request(port, `/api/runs/${runId}/quality-reports`, { headers });
  assert.ok(reports.json.total > 0, '任务结束必须有质量报告');
  return { projectId, runId, report: reports.json.reports[0], billingMode: quote.json.quote.billing_mode };
}

test('P3 HTTP：未配置规划器时能力如实标注，规划接口返回确定性建议且不执行', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai04-http-'));
  const app = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS, initialCredits: 240, tickMs: 8 });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch (error) {
      console.error('[ai04] 临时目录清理失败（不影响测试结论）', dir, error?.code ?? error?.message ?? error);
    }
  });
  const { port } = await app.listen();

  const capability = await request(port, '/api/provider/capabilities', { headers: as() });
  assert.equal(capability.status, 200);
  assert.equal(capability.json.revision_planner.configured, false);
  assert.equal(capability.json.revision_planner.mode, 'not_configured');
  assert.equal(capability.json.revision_planner.acceptance, 'not_available');

  const { runId, report } = await bootstrapRun(port);
  const planned = await request(port, `/api/runs/${runId}/revision-plans`, {
    method: 'POST', headers: as(), body: { report_id: report.id },
  });
  assert.equal(planned.status, 201, JSON.stringify(planned.json));
  assert.equal(planned.json.plan.executable, false);
  assert.equal(planned.json.plan.executed, false);
  assert.ok(planned.json.plan.report_hash.startsWith('report_'));
  assert.equal(planned.json.plan.report_id, report.id);
  const executableAction = planned.json.plan.decision === 'propose_action'
    && ['regenerate_image', 'regenerate_background', 'recompose_subject'].includes(planned.json.plan.action);
  assert.equal(planned.json.execution.available, executableAction, '执行入口必须与动作能力一致');
  if (!executableAction) assert.ok(planned.json.execution.reason);
  assert.ok(Array.isArray(planned.json.execution.executable_actions));
  assert.equal(planned.json.executed, false, '规划不执行');

  const other = await request(port, `/api/runs/${runId}/revision-plans`, {
    method: 'POST', headers: as('tenant_b'), body: { report_id: report.id },
  });
  assert.equal(other.status, 404, '规划不得跨租户');
  void app;
});

test('P3 HTTP：动作未通过校验时不得执行；人工确认后才复用既有重生成，且幂等', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai04-exec-'));
  // 注入规划器：模拟模型明确给出可执行动作，用来验证"确认 + 幂等 + 复用重生成"链路
  const planner = {
    configured: true, mode: 'test', model: 'fake-refiner', acceptance: 'not_verified',
    async plan({ user }) {
      const planRequest = JSON.parse(user).revision_request;
      const issue = planRequest.issue_catalog.find(item => item.allowed_actions.includes('regenerate_image'));
      if (!issue) return { status: 'unavailable', reason: '没有可执行问题', output: null, latency_ms: 1 };
      return {
        status: 'ok', latency_ms: 1, model: 'fake-refiner', request_id: 'req_ai04',
        output: {
          schema_version: REVISION_SCHEMA_VERSION,
          skill_version: REVISION_SKILL_VERSION,
          context_hash: planRequest.context_hash,
          source_version_id: planRequest.source_version_id,
          based_on_report_id: planRequest.report_id,
          decision: 'propose_action',
          action: 'regenerate_image',
          target_check_codes: [issue.code],
          locked_constraints: [...planRequest.locked_constraints],
          parameters: {},
          instruction: `只修复 ${issue.code}，保留已通过项`,
          reason: '存在可执行问题',
          material_requests: [],
        },
      };
    },
  };
  const app = createApp({
    port: 0, storeDir: dir, demoMode: false, initialCredits: 60, tickMs: 8, revisionPlanner: planner,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch (error) {
      console.error('[ai04] 临时目录清理失败（不影响测试结论）', dir, error?.code ?? error?.message ?? error);
    }
  });
  const { port } = await app.listen();
  // 成品计价（finished_image）只在会话模式成立，人工确认执行复用既有重生成流程
  const registered = await request(port, '/api/auth/register', {
    method: 'POST', body: { email: 'ai04@example.test', password: 'AI04Account2026!', display_name: 'AI04' },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  const cookie = String(registered.headers['set-cookie']?.[0] ?? '').split(';')[0];
  const headers = { Cookie: cookie, 'x-csrf-token': registered.json.csrf_token };

  const { runId, report, billingMode } = await bootstrapRun(port, headers);
  assert.equal(billingMode, 'finished_image', '会话模式应使用成品计价');
  const planned = await request(port, `/api/runs/${runId}/revision-plans`, {
    method: 'POST', headers, body: { report_id: report.id },
  });
  assert.equal(planned.status, 201, JSON.stringify(planned.json));
  assert.equal(planned.json.plan.action, 'regenerate_image', '注入的可执行动作被服务端接受');
  const plan = planned.json.plan;

  if (plan.decision !== 'propose_action') {
    const rejected = await request(port, `/api/runs/${runId}/revision-plans/${planned.json.plan_id}/execute`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'ai04-exec-1' }, body: { confirm: true },
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.error, 'PLAN_NOT_EXECUTABLE');
    return;
  }

  const noConfirm = await request(port, `/api/runs/${runId}/revision-plans/${planned.json.plan_id}/execute`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'ai04-exec-1' }, body: { confirm: false },
  });
  assert.equal(noConfirm.status, 428, '未确认不得执行');
  assert.equal(noConfirm.json.error, 'CONFIRMATION_REQUIRED');

  const missingKey = await request(port, `/api/runs/${runId}/revision-plans/${planned.json.plan_id}/execute`, {
    method: 'POST', headers, body: { confirm: true },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.json.error, 'MISSING_IDEMPOTENCY_KEY');

  const executed = await request(port, `/api/runs/${runId}/revision-plans/${planned.json.plan_id}/execute`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'ai04-exec-1' }, body: { confirm: true },
  });
  assert.equal(executed.status, 201, JSON.stringify(executed.json));
  assert.ok(executed.json.child_run_id, '人工确认后复用既有重生成，创建新任务');
  assert.equal(executed.json.plan.executed, true);

  const replay = await request(port, `/api/runs/${runId}/revision-plans/${planned.json.plan_id}/execute`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'ai04-exec-1' }, body: { confirm: true },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.child_run_id, executed.json.child_run_id, '同一确认请求幂等，不重复扣费');
});

test('P3 HTTP：旧报告或已解决目标不得执行，避免对过期证据改图', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai04-stale-'));
  const app = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS, initialCredits: 240, tickMs: 8 });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch (error) {
      console.error('[ai04] 临时目录清理失败（不影响测试结论）', dir, error?.code ?? error?.message ?? error);
    }
  });
  const { port } = await app.listen();
  const { runId, report, projectId } = await bootstrapRun(port);

  // 新事实版本会让原报告失效
  const newTruth = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: 1, confirm: true,
      facts: [{ key: '容量', value: '400ml', critical: true, confirmed: true, source_type: 'user_input' }],
      critical_text: [{ text: '400ml' }],
    },
  });
  assert.equal(newTruth.status, 201, JSON.stringify(newTruth.json));

  const planned = await request(port, `/api/runs/${runId}/revision-plans`, {
    method: 'POST', headers: as(), body: { report_id: report.id },
  });
  // 事实版本变化后报告失效：规划必须直接拒绝，不能基于旧证据生成建议
  assert.equal(planned.status, 409, JSON.stringify(planned.json));
  assert.equal(planned.json.error, 'REPORT_STALE');
  assert.ok(planned.json.details.reasons.length > 0);
  const listed = await request(port, `/api/runs/${runId}/revision-plans`, { headers: as() });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.total, 0, '失效报告不应留下可执行建议');
});
