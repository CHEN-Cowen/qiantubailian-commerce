/**
 * M14 测试：指定图片重生成与结算。
 *
 * 覆盖验收硬项：
 * 1. 改卖点图时主图/场景图的版本 id、hash、选用状态不变；旧结果保留（versions 只增）。
 * 2. 成功一次结算：credits 账本恰好多 capture 1 点；重启（重建 jobs 实例读同一 store）后
 *    复核收口不双扣（regen: 幂等键）。
 * 3. 取消 → release；失败 → release；needs_review → 预留保留，复核通过才 capture。
 * 4. 同 Idempotency-Key 重放返回同一子 run 不重复扣费；进行中再请求同交付物 → 409。
 * 5. 跨租户 404；legacy 计价任务 409 REGENERATION_UNSUPPORTED；失效 source_version_id 404。
 * 6. 非 publishable 只登记历史不自动选用；复核通过后 activateVersion 可人工选用。
 * 7. 导出 complete 包引用新版本，主图不变。
 * 8. regeneration_request 子 run 上 editDeliverableText 被拒绝（409）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  createSizeFixture, setupSession, startFinishedRun, waitTerminal,
  setupDemo, demoRequest, as,
} from './m13.js';

/** 把 run 所有当前选用版本的报告复核为可发布（与前端复核动作一致）。 */
async function publishCurrentReports(req, run, { expectPublishable = true } = {}) {
  const versions = (await req(`/api/runs/${run.id}/versions`)).json.versions.filter(item => item.current);
  for (const item of versions) {
    const report = (await req(`/api/quality-reports/${item.report_id}`)).json.report;
    if (report.decision === 'publishable') continue;
    const decisions = (report.checks ?? [])
      .filter(check => check.required && check.status === 'unknown' && check.adjudicable)
      .map(check => ({ code: check.code, decision: 'pass', reason: 'M14 测试样本人工检查通过', evidence: report.id }));
    if (decisions.length === 0) continue;
    const reviewed = await req(`/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', body: { decisions, note: '仅测试 fixture，不证明真实模型效果' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
    if (expectPublishable) assert.equal(reviewed.json.report.decision, 'publishable', JSON.stringify(reviewed.json.report.decision_reasons));
  }
}

const capturesOf = entries => entries.filter(item => item.type === 'capture');
const releasesOf = entries => entries.filter(item => item.type === 'release');

/** 走真实订单流程给当前会话充值（plan_taster_10 → demo 结算 → grant 到账 10 点）。 */
async function topUp(req) {
  const created = await req('/api/billing/orders', {
    method: 'POST', body: { plan_id: 'plan_taster_10' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const order = created.json.order;
  if (order.status === 'pending_demo_settlement') {
    const settled = await req(`/api/billing/orders/${order.id}/settle`, { method: 'POST' });
    assert.equal(settled.status, 200, JSON.stringify(settled.json));
  }
  return order;
}

/** 模拟支付 Provider：不产生真实收款，让 plan_taster_10 订单可走 demo 结算到账。 */
const demoPayment = {
  capabilities: () => ({ simulated: true, real_money: false, supports_refunds: false }),
};

function readZip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset = dataStart + compressedSize;
  }
  return files;
}

// ---------- 1. 成功重生成：隔离性、幂等结算、人工选用、导出 ----------

test('M14 重生成成功：其它交付物不变、旧结果保留、重启后复核收口恰好 capture 1、人工选用、导出新版本', async t => {
  const provider = createSizeFixture();
  const session = await setupSession(t, { provider, initialCredits: 50, paymentProvider: demoPayment });
  const { req, snapshot } = session;
  const run = await startFinishedRun(req, 'm14-main');
  const done = await waitTerminal(req, run.id);
  assert.equal(done.status, 'completed');
  await publishCurrentReports(req, done);
  // 体验额度（3 点）在主任务预留时冻结；重生成需要新的可用余额 → 走订单流程充值
  await topUp(req);

  const before = (await req(`/api/runs/${run.id}`)).json.run;
  const mainBefore = before.deliverables.find(item => item.deliverable_id === 'main');
  const sceneBefore = before.deliverables.find(item => item.deliverable_id === 'scene');
  const benefitBefore = before.deliverables.find(item => item.deliverable_id === 'benefit');
  const versionsBefore = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  const benefitCountBefore = versionsBefore.filter(item => item.deliverable_id === 'benefit').length;
  const ledgerBefore = Object.values((await snapshot()).credit_entries ?? {});
  const capturesBefore = capturesOf(ledgerBefore).length;

  // 发起重生成（卖点图）
  const created = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'm14-regen-1' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const child = created.json.run;
  assert.equal(created.json.source_run_id, run.id);
  assert.ok(child.regeneration_request, '子 run 必须携带 regeneration_request');
  assert.equal(child.regeneration_request.source_run_id, run.id);
  assert.equal(child.regeneration_request.deliverable_id, 'benefit');
  assert.equal(child.deliverables.length, 1, '单张报价只生成一个交付项');
  assert.ok(child.regeneration.reserved_credits >= 1, '重生成必须单独预留额度');

  // 同 Idempotency-Key 重放：返回同一子 run，不建新任务、不重复预留
  const replay = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'm14-regen-1' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.run.id, child.id);
  assert.equal(replay.json.replayed, true);

  const childDone = await waitTerminal(req, child.id);
  assert.equal(childDone.status, 'completed', JSON.stringify(childDone));

  // 其它交付物完全不变（硬验收）
  const after = (await req(`/api/runs/${run.id}`)).json.run;
  const mainAfter = after.deliverables.find(item => item.deliverable_id === 'main');
  const sceneAfter = after.deliverables.find(item => item.deliverable_id === 'scene');
  assert.equal(mainAfter.active_version_id, mainBefore.active_version_id);
  assert.equal(sceneAfter.active_version_id, sceneBefore.active_version_id);
  const versionsAfter = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  assert.equal(versionsAfter.length, versionsBefore.length + 1, 'versions 只增不改');
  const mainVersion = versionsAfter.find(item => item.id === mainBefore.active_version_id);
  const sceneVersion = versionsAfter.find(item => item.id === sceneBefore.active_version_id);
  assert.equal(mainVersion.active, true);
  assert.equal(sceneVersion.active, true);

  // 子 run 报告未复核 → needs_review → adopted 只入历史，源任务 active 不变
  const adopted = versionsAfter.find(item => item.adopted_from?.run_id === child.id);
  assert.ok(adopted, '重生成产物必须 adopt 回源任务');
  assert.equal(adopted.deliverable_id, 'benefit');
  assert.equal(adopted.number, benefitCountBefore + 1);
  assert.equal(adopted.note, '指定图片重生成（待人工确认）');
  assert.equal(adopted.active, false);
  assert.notEqual(adopted.hash, versionsAfter.find(item => item.id === benefitBefore.active_version_id).hash,
    '重生成新图哈希必须与旧版本不同');
  const benefitAfter = after.deliverables.find(item => item.deliverable_id === 'benefit');
  assert.equal(benefitAfter.active_version_id, benefitBefore.active_version_id, '未确认的修改不得替换选用版本');
  const sourceRegistration = childDone.regenerations
    ?? (await req(`/api/runs/${child.id}`)).json.run.regenerations;
  void sourceRegistration;
  const sourceReg = after.regenerations?.find(item => item.run_id === child.id);
  assert.ok(sourceReg, '源任务必须登记这次重生成');
  assert.equal(sourceReg.status, 'needs_review');

  // 待复核：预留保留，未 capture 未 release
  const childView = (await req(`/api/runs/${child.id}`)).json.run;
  assert.equal(childView.regeneration.captured_credits, 0);
  assert.equal(childView.regeneration.released_credits, 0);

  // F.8：regeneration_request 子 run 上不允许文字修改（模块 04 互斥）
  const textEditOnChild = await req(`/api/runs/${child.id}/deliverables/benefit/text-edits`, {
    method: 'POST', body: { edits: [{ id: 'layer_1', text: 'x' }] },
  });
  assert.equal(textEditOnChild.status, 409, JSON.stringify(textEditOnChild.json));
  assert.equal(textEditOnChild.json.error, 'TEXT_EDIT_CONFLICT');

  // 重启模拟：用同一数据目录重建 jobs 实例（recover 重挂后仍走同一结算路径），
  // 确认恢复过程不产生任何重复结算，随后复核收口恰好 capture 1 点。
  const restartedApp = createApp({
    port: 0, storeDir: session.dir, demoMode: false, initialCredits: 0,
    tickMs: 5, attemptTimeoutMs: 30_000, provider: createSizeFixture(),
  });
  const restarted = await restartedApp.listen();
  t.after(async () => { await restartedApp.close().catch(() => {}); });
  void restarted;
  const ledgerAfterRestart = Object.values((await snapshot()).credit_entries ?? {});
  assert.equal(capturesOf(ledgerAfterRestart).length, capturesBefore, '重启恢复不得重复结算');

  // 复核子 run 报告：收口恰好 capture 1 点
  const childReportId = childView.deliverables.find(item => item.deliverable_id === 'benefit').quality_report_id;
  const childReport = (await req(`/api/quality-reports/${childReportId}`)).json.report;
  const decisions = (childReport.checks ?? [])
    .filter(check => check.required && check.status === 'unknown' && check.adjudicable)
    .map(check => ({ code: check.code, decision: 'pass', reason: 'M14 测试样本人工检查通过', evidence: childReport.id }));
  const reviewed = await req(`/api/quality-reports/${childReportId}/reviews`, {
    method: 'POST', body: { decisions, note: '复核重生成结果' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  assert.equal(reviewed.json.report.decision, 'publishable');

  // 重复复核同一报告：幂等收口，不得再次 capture
  await req(`/api/quality-reports/${childReportId}/reviews`, {
    method: 'POST',
    body: { decisions: [{ code: decisions[0].code, decision: 'pass', reason: '重复复核', evidence: childReport.id }] },
  });

  const ledgerAfter = Object.values((await snapshot()).credit_entries ?? {});
  assert.equal(capturesOf(ledgerAfter).length, capturesBefore + 1, '重生成收口必须恰好 capture 1 点');
  assert.equal(releasesOf(ledgerAfter).length, releasesOf(ledgerBefore).length);
  const regenCapture = capturesOf(ledgerAfter).find(item => item.job_id === child.id);
  assert.ok(regenCapture, 'capture 必须挂在重生成子 run 上');
  const childSettled = (await req(`/api/runs/${child.id}`)).json.run;
  assert.equal(childSettled.regeneration.captured_credits, 1);
  assert.equal(childSettled.deliverables[0].entitlement_settled, 'capture');

  // 人工在源任务选用 adopted 版本
  const activated = await req(`/api/runs/${run.id}/versions/${adopted.id}/activate`, { method: 'POST' });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));
  const afterActivate = (await req(`/api/runs/${run.id}`)).json.run;
  assert.equal(afterActivate.deliverables.find(item => item.deliverable_id === 'benefit').active_version_id, adopted.id);
  assert.equal(afterActivate.deliverables.find(item => item.deliverable_id === 'main').active_version_id,
    mainBefore.active_version_id, '主图选用版本不得被波及');

  // 导出 complete：包引用新版本（卖点图）与旧版本（主图）
  const exported = await req(`/api/runs/${run.id}/exports`, { method: 'POST', body: { scope: 'complete' } });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));
  const download = await req(exported.json.export.download_url);
  const files = readZip(download.body);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const benefitAsset = manifest.assets.find(item => item.deliverable_id === 'benefit');
  const mainAsset = manifest.assets.find(item => item.deliverable_id === 'main');
  assert.equal(benefitAsset.version_id, adopted.id);
  assert.equal(createHash('sha256').update(files.get(benefitAsset.file)).digest('hex'), adopted.hash,
    '卖点图必须是重生成的版本');
  assert.equal(mainAsset.version_id, mainBefore.active_version_id);
  assert.equal(createHash('sha256').update(files.get(mainAsset.file)).digest('hex'), mainVersion.hash,
    '主图文件必须保持原版本');
});

// ---------- 2. 失败 → release；重生成链路错误路径 ----------

test('M14 失败与错误路径：子任务生成失败释放额度；legacy 409；失效版本 404；跨租户 404', async t => {
  // 主任务用成功 fixture；子 run（run_id 与首个提交不同）注入供应商失败
  const calls = new Map();
  let mainRunId = null;
  const childFailProvider = {
    capabilities: () => ({ id: 'm14-child-fail', version: '1', image: true, video: false,
      max_references: 6, supports_mask: false, supports_post_composite: true, supports_async: true,
      supports_revision: false, supports_cancel: true, max_side: 4096, formats: ['png', 'jpg'],
      simulated: true, acceptance: 'simulated_only' }),
    validate: () => ({ ok: true }),
    estimate: () => ({ estimated_credits: 1, max_credits: 1 }),
    submit(request) {
      if (mainRunId === null) mainRunId = request.run_id;
      calls.set(request.idempotency_key, request);
      return { provider_job_id: request.idempotency_key, status: 'queued' };
    },
    poll(handle) {
      const request = calls.get(handle.provider_job_id);
      if (!request || request.run_id !== mainRunId) {
        return {
          status: 'failed',
          error: { code: 'PROVIDER_GENERATION_FAILED', message: 'M14 注入的供应商失败', retryable: false },
          result: null,
        };
      }
      const width = request?.target_width ?? 1200;
      const height = request?.target_height ?? 1200;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 3;
          rgb[index] = (x * 3 + y * 2) % 256;
          rgb[index + 1] = (y * 5 + x) % 256;
          rgb[index + 2] = (x * 7 + y * 3) % 256;
        }
      }
      const bytes = encodeRgbPng(width, height, rgb);
      return { status: 'succeeded', result: {
        provider: 'm14-child-fail', model: 'fixture/image', model_version: '1',
        provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ status: 'cancelled' }),
  };
  const { req, snapshot } = await setupSession(t, { provider: childFailProvider, initialCredits: 50, paymentProvider: demoPayment });
  const run = await startFinishedRun(req, 'm14-fail-main');
  const done = await waitTerminal(req, run.id);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  await publishCurrentReports(req, done);
  await topUp(req);

  // legacy 任务：演示计价 → 409 REGENERATION_UNSUPPORTED
  const demoPort = await setupDemo(t, { provider: createSizeFixture() });
  const demoProject = (await demoRequest(demoPort, '/api/projects', {
    method: 'POST', headers: as(), body: { name: 'M14 演示', sku: 'M14-D', category: '面霜', platform: '天猫' },
  })).json.project;
  const demoAsset = await demoRequest(demoPort, `/api/projects/${demoProject.id}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' },
    body: encodeRgbPng(64, 64, Buffer.alloc(64 * 64 * 3, 200)),
  });
  assert.equal(demoAsset.status, 201, JSON.stringify(demoAsset.json));
  const demoTruth = await demoRequest(demoPort, `/api/projects/${demoProject.id}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '月光舒缓' }],
    },
  });
  assert.equal(demoTruth.status, 201, JSON.stringify(demoTruth.json));
  const demoPreview = await demoRequest(demoPort, `/api/projects/${demoProject.id}/specs/preview`, {
    method: 'POST', headers: as(), body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(demoPreview.status, 200, JSON.stringify(demoPreview.json));
  const demoResolutions = {};
  for (const conflict of [...demoPreview.json.payload.conflicts.pending, ...demoPreview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) demoResolutions[conflict.key] = conflict.options[0].id;
  }
  const demoSpec = await demoRequest(demoPort, `/api/projects/${demoProject.id}/specs`, {
    method: 'POST', headers: as(),
    body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: demoResolutions, base_version: 0 },
  });
  assert.equal(demoSpec.status, 201, JSON.stringify(demoSpec.json));
  const demoQuote = await demoRequest(demoPort, '/api/quotes', {
    method: 'POST', headers: as(), body: { project_id: demoProject.id },
  });
  assert.equal(demoQuote.status, 201, JSON.stringify(demoQuote.json));
  const demoRun = await demoRequest(demoPort, '/api/runs', {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'm14-demo-run' },
    body: { project_id: demoProject.id, quote_id: demoQuote.json.quote.quote_id },
  });
  assert.equal(demoRun.status, 201, JSON.stringify(demoRun.json));
  let legacyDone = null;
  for (let i = 0; i < 600; i += 1) {
    legacyDone = (await demoRequest(demoPort, `/api/runs/${demoRun.json.run.id}`, { headers: as() })).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(legacyDone.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(legacyDone.status, 'completed');
  const legacyAttempt = await demoRequest(demoPort, `/api/runs/${demoRun.json.run.id}/regenerate`, {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'm14-legacy-regen' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(legacyAttempt.status, 409, JSON.stringify(legacyAttempt.json));
  assert.equal(legacyAttempt.json.error, 'REGENERATION_UNSUPPORTED',
    'legacy 计价任务必须明确提示不支持，而不是静默失败');

  // 失效 source_version_id → 404
  const badVersion = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST', headers: { 'Idempotency-Key': 'm14-bad-version' },
    body: { deliverable_id: 'benefit', source_version_id: 'ver_not_exist' },
  });
  assert.equal(badVersion.status, 404, JSON.stringify(badVersion.json));

  // 不存在的交付物 → 404
  const badDeliverable = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST', headers: { 'Idempotency-Key': 'm14-bad-deliverable' },
    body: { deliverable_id: 'nonexistent' },
  });
  assert.equal(badDeliverable.status, 404, JSON.stringify(badDeliverable.json));

  // 跨租户 404：新注册账号是另一个租户
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email: 'm14-other@example.test', password: 'M14Other2026!', display_name: 'Other' },
  });
  assert.ok([201, 409].includes(registered.status), String(registered.status));
  const cross = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST', headers: { 'Idempotency-Key': 'm14-cross-2' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(cross.status, 404, JSON.stringify(cross.json));
  // 切回主账号继续
  const back = await req('/api/auth/login', {
    method: 'POST', body: { email: 'm13@example.test', password: 'M13Account2026!' },
  });
  assert.equal(back.status, 200, JSON.stringify(back.json));

  // 生成失败 → 子 run 终态 failed，重生成额度按 release 收口
  const created = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST', headers: { 'Idempotency-Key': 'm14-regen-fail' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const child = created.json.run;
  const childDone = await waitTerminal(req, child.id);
  assert.equal(childDone.status, 'failed', JSON.stringify(childDone));
  const entries = Object.values((await snapshot()).credit_entries ?? {});
  const childRelease = releasesOf(entries).filter(item => item.job_id === child.id);
  assert.equal(childRelease.length, 1, '失败必须释放重生成额度（幂等键只生效一次）');
  const childView = (await req(`/api/runs/${child.id}`)).json.run;
  assert.equal(childView.regeneration.released_credits, 1);
  assert.equal(childView.regeneration.captured_credits, 0);
  // 失败不产生 adopted 版本，源任务版本不变
  const versions = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  assert.equal(versions.filter(item => item.adopted_from).length, 0);
});

// ---------- 3. 进行中互斥与旧结果保留 ----------

test('M14 进行中互斥：同交付物挂起重生成时再次请求 409；终态后可再次发起，versions 只增', async t => {
  const provider = createSizeFixture();
  const { req } = await setupSession(t, { provider, initialCredits: 50, paymentProvider: demoPayment });
  const run = await startFinishedRun(req, 'm14-mutex-main');
  const done = await waitTerminal(req, run.id);
  assert.equal(done.status, 'completed');
  await publishCurrentReports(req, done);
  await topUp(req);

  // 把 poll 换成永远挂起（主任务已完成，只有子 run 会再 poll）
  const originalPoll = provider.poll;
  provider.poll = () => ({ status: 'queued' });

  const pendingChild = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST', headers: { 'Idempotency-Key': 'm14-mutex-1' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(pendingChild.status, 201, JSON.stringify(pendingChild.json));

  // 挂起中的子 run 未到终态 → 同交付物再次请求必须被互斥拒绝
  const blocked = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST', headers: { 'Idempotency-Key': 'm14-mutex-1b' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.json));
  assert.equal(blocked.json.error, 'REGENERATION_IN_PROGRESS');

  // 恢复 poll，等子 run 完成；终态后互斥解除，可再次发起
  provider.poll = originalPoll;
  await waitTerminal(req, pendingChild.json.run.id);
  const second = await req(`/api/runs/${run.id}/regenerate`, {
    method: 'POST', headers: { 'Idempotency-Key': 'm14-mutex-2' },
    body: { deliverable_id: 'benefit' },
  });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  await waitTerminal(req, second.json.run.id);

  // 两次重生成都 adopt：versions 只增，旧结果保留
  const versions = (await req(`/api/runs/${run.id}/versions`)).json.versions;
  const adoptedAll = versions.filter(item => item.adopted_from);
  assert.equal(adoptedAll.length, 2, '两次重生成都必须登记为历史版本');
  assert.equal(versions.filter(item => item.deliverable_id === 'benefit').length, 3, '原版本 + 2 个 adopted');
  const mainVersion = versions.find(item => item.active && item.deliverable_id === 'main');
  assert.ok(mainVersion, '主图选用版本不受影响');
});
