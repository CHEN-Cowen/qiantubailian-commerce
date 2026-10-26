/**
 * M10 测试：结构化详情页（来源可追溯、事实一致、素材失效阻断、平台不承诺直传）
 * 与首帧图生视频（首帧闸口、3 秒低幅度、音源、首中尾分镜、中间帧阻断、Provider 能力阻断、联合导出）。
 *
 * 纯函数单测给出确定性证据；端到端用例跑真实 HTTP 链路。
 * 当前 Provider 不支持视频，所有视频用例验证的是"如实阻断"，不是"已经生成视频"。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import {
  DETAIL_SECTION_KEYS, MAX_VIDEO_DURATION_SECONDS, buildDetailPage, buildJointManifest,
  checkDetailPageValidity, evaluateVideoFrames, planPlatformDelivery, planVideo, resolveParamSource,
} from '../src/m10.mjs';
import { encodeRgbPng } from '../src/m06.mjs';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'tester_m10') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

function subjectPng(width = 96, height = 96) {
  const pixels = Buffer.alloc(width * height * 3, 240);
  for (let y = 24; y < 72; y += 1) {
    for (let x = 24; x < 72; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = 190; pixels[index + 1] = 40; pixels[index + 2] = 50;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm10-'));
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
    body: { name: 'M10 精华', sku: 'M10-01', category: '精华', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const project = created.json.project;

  const asset = await request(port, `/api/projects/${project.id}/assets?role=packaging&filename=box.png`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': 'image/png' }, body: subjectPng(),
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));
  const packaging = asset.json.asset;

  const subject = await request(port, `/api/projects/${project.id}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': 'image/png' }, body: subjectPng(80, 80),
  });
  assert.equal(subject.status, 201, JSON.stringify(subject.json));

  const truth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(tenant),
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '30ml', critical: true, confirmed: true, source_asset_id: packaging.id },
        { key: '核心卖点', value: '温和修护', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '适用肤质', value: '混合性', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '润泽精华' }],
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
  return { project, spec: frozen.json.spec, packaging, truth: truth.json.truth_version };
}

/** 六模块齐全、全部引用已确认事实的最小详情页输入。 */
function sectionsOf({ packagingId, capacity = '30ml' } = {}) {
  const fact = (key, value) => ({ type: 'fact', key, value });
  return [
    { key: 'hero', params: [{ key: 'headline', label: '主标题', value: '温和修护', source: fact('核心卖点', '温和修护') }] },
    { key: 'selling_points', params: [{ key: 'sp1', label: '卖点一', value: '温和修护', source: fact('核心卖点', '温和修护') }] },
    { key: 'scenarios', params: [{ key: 'scene', label: '场景', value: '混合性', source: fact('适用肤质', '混合性') }] },
    { key: 'details', params: [{ key: 'shot', label: '细节图', value: '包装正面', source: { type: 'asset', asset_id: packagingId } }] },
    { key: 'specs', params: [{ key: 'volume', label: '容量', value: capacity, source: fact('容量', '30ml') }] },
    { key: 'service', params: [{ key: 'after_sale', label: '售后', value: '温和修护', source: fact('核心卖点', '温和修护') }] },
  ];
}

const truthFixture = overrides => ({
  version: 2,
  content_hash: 'truth_hash_v2',
  facts: [
    { key: '容量', value: '30ml', unit: '', source_type: 'asset', source_asset_id: 'ast_box', confirmed: true },
    { key: '核心卖点', value: '温和修护', unit: '', source_type: 'user_input', source_asset_id: null, confirmed: true },
    { key: '适用肤质', value: '混合性', unit: '', source_type: 'user_input', source_asset_id: null, confirmed: true },
  ],
  ...overrides,
});

const assetsFixture = () => ([
  { id: 'ast_box', role: 'packaging', role_status: 'active', sha256: 'a'.repeat(64), filename: 'box.png' },
  { id: 'ast_subject', role: 'subject', role_status: 'active', sha256: 'b'.repeat(64), filename: 'subject.png' },
]);

const specFixture = () => ({ version: 1, content_hash: 'spec_hash_v1', brand_kit: null });

// ---------- 纯函数：来源解析 ----------

test('M10 详情来源：缺失/非法类型/事实不存在/值不一致/素材失效都必须拒绝', () => {
  const truth = truthFixture({});
  const assets = assetsFixture();

  assert.equal(resolveParamSource({ param: { key: 'a', value: '30ml' }, truth, assets }).code, 'DETAIL_PARAM_UNSOURCED');
  assert.equal(resolveParamSource({ param: { key: 'a', value: '30ml', source: { type: 'guess' } }, truth, assets }).code, 'DETAIL_SOURCE_TYPE_INVALID');
  assert.equal(resolveParamSource({
    param: { key: 'a', value: 'x', source: { type: 'fact', key: '不存在' } }, truth, assets,
  }).code, 'DETAIL_FACT_NOT_FOUND');
  assert.equal(resolveParamSource({
    param: { key: 'a', value: '50ml', source: { type: 'fact', key: '容量' } }, truth, assets,
  }).code, 'DETAIL_FACT_VALUE_MISMATCH');
  assert.equal(resolveParamSource({
    param: { key: 'a', value: '1', source: { type: 'asset', asset_id: 'missing' } }, truth, assets,
  }).code, 'DETAIL_ASSET_NOT_FOUND');

  const stale = [{ ...assets[0], role_status: 'superseded' }, assets[1]];
  assert.equal(resolveParamSource({
    param: { key: 'a', value: '30ml', source: { type: 'fact', key: '容量' } }, truth, assets: stale,
  }).code, 'DETAIL_FACT_SOURCE_STALE');
  assert.equal(resolveParamSource({
    param: { key: 'a', value: '图', source: { type: 'asset', asset_id: 'ast_box' } }, truth, assets: stale,
  }).code, 'DETAIL_ASSET_BLOCKED');
  assert.equal(resolveParamSource({
    param: { key: 'a', value: '1', source: { type: 'spec', version: 9 } }, truth, assets, spec: specFixture(),
  }).code, 'DETAIL_SPEC_VERSION_STALE');

  const ok = resolveParamSource({ param: { key: 'a', value: '30ml', source: { type: 'fact', key: '容量' } }, truth, assets });
  assert.equal(ok.ok, true);
  assert.equal(ok.snapshot.source_asset_id, 'ast_box');
  assert.equal(ok.snapshot.truth_content_hash, 'truth_hash_v2');
});

// ---------- 纯函数：详情页构建 ----------

test('M10 详情页：六模块齐全且来源完整才可发布；缺模块、缺来源、值不一致、文案版本缺失都阻断', () => {
  const truth = truthFixture({});
  const assets = assetsFixture();
  const spec = specFixture();

  const good = buildDetailPage({
    spec, truth, assets, copyVersion: 'copy_v1',
    sections: sectionsOf({ packagingId: 'ast_box' }),
  });
  assert.equal(good.decision, 'publishable');
  assert.deepEqual(good.sections.map(item => item.key), [...DETAIL_SECTION_KEYS]);
  assert.equal(good.platform_compliance, 'not_claimed');
  assert.equal(good.delivery.html.supported, false);
  assert.equal(good.delivery.html.promise, 'none');
  assert.equal(good.checks.find(item => item.code === 'DETAIL_PLATFORM_COVERAGE').status !== 'pass', true);

  const missingSection = buildDetailPage({
    spec, truth, assets, copyVersion: 'copy_v1',
    sections: sectionsOf({ packagingId: 'ast_box' }).filter(item => item.key !== 'service'),
  });
  assert.equal(missingSection.decision, 'blocked');
  assert.equal(missingSection.blockers[0].code, 'DETAIL_SECTION_MISSING');

  const unsourced = buildDetailPage({
    spec, truth, assets, copyVersion: 'copy_v1',
    sections: [
      ...sectionsOf({ packagingId: 'ast_box' }).slice(0, 5),
      { key: 'service', params: [{ key: 'x', value: '七天无理由' }] },
    ],
  });
  assert.equal(unsourced.decision, 'blocked');
  assert.ok(unsourced.checks.find(item => item.code === 'DETAIL_PARAM_SOURCES').evidence
    .some(item => item.code === 'DETAIL_PARAM_UNSOURCED'));

  const wrongValue = buildDetailPage({
    spec, truth, assets, copyVersion: 'copy_v1',
    sections: sectionsOf({ packagingId: 'ast_box', capacity: '50ml' }),
  });
  assert.equal(wrongValue.decision, 'blocked');
  assert.ok(wrongValue.blockers.some(item => item.code === 'DETAIL_FACT_VALUE_MISMATCH'));

  const noCopy = buildDetailPage({ spec, truth, assets, sections: sectionsOf({ packagingId: 'ast_box' }) });
  assert.equal(noCopy.decision, 'blocked');
  assert.ok(noCopy.blockers.some(item => item.code === 'DETAIL_COPY_VERSION_MISSING'));
});

test('M10 详情页：重检只重解析签名变化的参数，但关键约束全量检查；上下文变化即 stale', () => {
  const truth = truthFixture({});
  const assets = assetsFixture();
  const spec = specFixture();
  const first = buildDetailPage({
    spec, truth, assets, copyVersion: 'copy_v1', sections: sectionsOf({ packagingId: 'ast_box' }),
  });

  const unchanged = buildDetailPage({
    spec, truth, assets, copyVersion: 'copy_v1',
    sections: sectionsOf({ packagingId: 'ast_box' }), previousPage: first,
  });
  assert.equal(unchanged.decision, 'publishable');
  assert.deepEqual(unchanged.recheck.affected, []);
  assert.equal(unchanged.recheck.reused_params, 6);

  const changed = buildDetailPage({
    spec, truth, assets, copyVersion: 'copy_v1',
    sections: [
      ...sectionsOf({ packagingId: 'ast_box' }).slice(0, 5),
      { key: 'service', params: [{ key: 'after_sale', label: '售后', value: '7 天无理由', source: { type: 'fact', key: '核心卖点' } }] },
    ],
    previousPage: first,
  });
  assert.deepEqual(changed.recheck.affected, ['service/after_sale']);
  assert.equal(changed.recheck.reused_params, 5);
  // 未变化参数复用上次来源快照，但值已变化的参数仍被判为与事实不一致 → 阻断
  assert.equal(changed.decision, 'blocked');

  const current = checkDetailPageValidity({ page: first, truth, spec, assets });
  assert.equal(current.validity, 'current');

  const staleValid = checkDetailPageValidity({ page: first, truth: truthFixture({ content_hash: 'truth_hash_v3' }), spec, assets });
  assert.equal(staleValid.validity, 'stale');

  const staleAsset = checkDetailPageValidity({
    page: first, truth, spec, assets: [{ ...assets[0], role_status: 'superseded' }, assets[1]],
  });
  assert.equal(staleAsset.validity, 'stale');
  assert.ok(staleAsset.reasons.some(reason => reason.includes('ast_box')));
});

// ---------- 纯函数：视频计划与帧检查 ----------

const capabilities = () => ({ id: 'deterministic-mock', video: false, simulated: true, acceptance: 'simulated_only' });

const firstFrameFixture = overrides => ({
  available: true, kind: 'version', ref_id: 'ver_ok', publishable: true,
  decision: 'publishable', validity: 'current', sha256: 'c'.repeat(64), ...overrides,
});

const frame = (kind, checks) => ({ kind, at_ms: 0, checks });

test('M10 视频计划：无首帧/首帧待复核/超 3 秒/幅度过大/音源不可追溯/Provider 无视频能力都阻断', () => {
  const base = { capabilities: capabilities(), firstFrame: firstFrameFixture() };

  const noFrame = planVideo({ capabilities: capabilities(), firstFrame: null });
  assert.equal(noFrame.decision, 'blocked');
  assert.ok(noFrame.blockers.some(item => item.code === 'VIDEO_FIRST_FRAME'));

  const reviewFrame = planVideo({ ...base, firstFrame: firstFrameFixture({ publishable: false, decision: 'needs_review' }) });
  assert.ok(reviewFrame.blockers.some(item => item.code === 'VIDEO_FIRST_FRAME'));

  const tooLong = planVideo({ ...base, durationSeconds: 5 });
  assert.ok(tooLong.blockers.some(item => item.code === 'VIDEO_DURATION'));

  const tooMuchMotion = planVideo({ ...base, motion: { type: 'push_in', amplitude: 0.9 } });
  assert.ok(tooMuchMotion.blockers.some(item => item.code === 'VIDEO_MOTION'));

  const badAudio = planVideo({ ...base, audio: { source: 'licensed_track', license_ref: '' } });
  assert.ok(badAudio.blockers.some(item => item.code === 'VIDEO_AUDIO_SOURCE'));

  const licensed = planVideo({ ...base, audio: { source: 'licensed_track', license_ref: 'LIC-9' } });
  assert.equal(licensed.blockers.some(item => item.code === 'VIDEO_AUDIO_SOURCE'), false);

  const missingFrames = planVideo({ ...base, storyboard: [{ kind: 'first', at_ms: 0 }] });
  assert.ok(missingFrames.blockers.some(item => item.code === 'VIDEO_STORYBOARD'));

  const providerBlocked = planVideo({ ...base, capabilities: capabilities() });
  assert.equal(providerBlocked.generation.status, 'blocked');
  assert.equal(providerBlocked.generation.blocker_code, 'VIDEO_PROVIDER_UNSUPPORTED');
  assert.equal(providerBlocked.decision, 'blocked');
  assert.equal(providerBlocked.duration_seconds, MAX_VIDEO_DURATION_SECONDS);
});

test('M10 视频计划：首帧可发布 + 3 秒低幅度 + 音轨授权 + 分镜齐全 且 Provider 支持视频才 ready', () => {
  const ready = planVideo({
    capabilities: { id: 'fake-video', video: true, simulated: false, acceptance: 'verified' },
    firstFrame: firstFrameFixture(),
    durationSeconds: 3,
    motion: { type: 'light_shift', amplitude: 0.1 },
    audio: { source: 'licensed_track', license_ref: 'LIC-9' },
    storyboard: [
      { kind: 'first', at_ms: 0 }, { kind: 'middle', at_ms: 1500 }, { kind: 'last', at_ms: 3000 },
    ],
  });
  assert.equal(ready.decision, 'publishable');
  assert.equal(ready.generation.status, 'ready');
  assert.equal(ready.generation.blocker_code, null);
  assert.equal(ready.platform_compliance, 'not_claimed');
});

test('M10 帧检查：中间帧硬失败必然阻断；缺检测按待复核；缺帧不能算通过', () => {
  const allPass = kind => frame(kind, [
    { code: 'FILE_INTEGRITY', status: 'pass' },
    { code: 'SUBJECT_IDENTITY', status: 'pass' },
    { code: 'TEXT_LOGO', status: 'pass' },
    { code: 'RISK_CONTENT', status: 'pass' },
  ]);

  const pass = evaluateVideoFrames({ frames: [allPass('first'), allPass('middle'), allPass('last')] });
  assert.equal(pass.decision, 'publishable');

  const middleFail = evaluateVideoFrames({
    frames: [allPass('first'), frame('middle', [{ code: 'SUBJECT_IDENTITY', status: 'fail' }]), allPass('last')],
  });
  assert.equal(middleFail.decision, 'blocked');
  assert.ok(middleFail.blockers.some(item => item.evidence.kind === 'middle'));
  assert.equal(middleFail.middle_frame_blocking, true);

  const unknown = evaluateVideoFrames({
    frames: [allPass('first'), frame('middle', [{ code: 'FILE_INTEGRITY', status: 'unknown' }]), allPass('last')],
  });
  assert.equal(unknown.decision, 'needs_review');
  assert.equal(unknown.blockers.length, 0);

  const missing = evaluateVideoFrames({ frames: [allPass('first')] });
  assert.equal(missing.decision, 'needs_review');
  assert.ok(missing.review_items.some(item => item.code === 'VIDEO_FRAME_MISSING'));
});

test('M10 平台交付：未收录平台不承诺任何形式；HTML 永不承诺直传', () => {
  const delivery = planPlatformDelivery({ channel: { coverage: 'missing', rule: null } });
  assert.equal(delivery.html.supported, false);
  assert.equal(delivery.html.reason, 'CHANNEL_RULE_MISSING');

  const covered = planPlatformDelivery({
    channel: {
      coverage: 'covered',
      rule: { platform: '天猫', version: 1, constraints: { formats: ['jpg', 'png'] }, source: { verified: false } },
    },
  });
  assert.equal(covered.long_image.supported, true);
  assert.equal(covered.html.supported, false);
  assert.equal(covered.html.promise, 'none');
  assert.equal(covered.platform_compliance_claim, 'not_claimed');
});

test('M10 联合清单：视频缺失必须显式列出，不静默省略；HTML 直传不承诺', () => {
  const manifest = buildJointManifest({
    project: { id: 'prj_1' },
    spec: { version: 1, content_hash: 'h' },
    provider: { id: 'deterministic-mock', simulated: true, acceptance: 'simulated_only' },
    images: [{ deliverable_id: 'd1', label: '主图', file: 'images/d1.png', sha256: 'x' }],
    detailPage: { decision: 'publishable', copy_version: 'copy_v1' },
    videoPlan: { decision: 'blocked', generation: { status: 'blocked' } },
    frameReport: null,
    delivery: planPlatformDelivery({ channel: { coverage: 'missing', rule: null } }),
    missing: [{ artifact: 'video', reason: 'VIDEO_PROVIDER_UNSUPPORTED' }],
  });
  assert.equal(manifest.package_format, 'qtb-joint-package.1');
  assert.equal(manifest.provider.simulated, true);
  assert.ok(manifest.missing.some(item => item.artifact === 'video'));
  assert.equal(manifest.artifacts.find(item => item.name === 'platform-delivery.json').html_direct_upload, false);
  assert.equal(manifest.platform_compliance, 'not_claimed');
});

// ---------- 端到端 ----------

test('M10 端到端：详情页来源/事实/失效阻断 → 视频计划与帧检查 → 联合导出 → 租户隔离', async t => {
  const { port } = await start(t);
  const { project, packaging } = await readyProject(port);

  const tenant = await request(port, '/api/tenant', { headers: as() });
  assert.match(tenant.json.module, /^M\d{2}$/);

  // 1) 缺少文案版本：阻断
  const noCopy = await request(port, `/api/projects/${project.id}/detail-pages`, {
    method: 'POST', headers: as(), body: { sections: sectionsOf({ packagingId: packaging.id }) },
  });
  assert.equal(noCopy.status, 201, JSON.stringify(noCopy.json));
  assert.equal(noCopy.json.detail_page.decision, 'blocked');
  assert.ok(noCopy.json.detail_page.blockers.some(item => item.code === 'DETAIL_COPY_VERSION_MISSING'));

  // 2) 完整来源：可发布
  const created = await request(port, `/api/projects/${project.id}/detail-pages`, {
    method: 'POST', headers: as(),
    body: { sections: sectionsOf({ packagingId: packaging.id }), copy_version: 'copy_v1' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const page = created.json.detail_page;
  assert.equal(page.decision, 'publishable');
  assert.equal(page.copy_version, 'copy_v1');
  assert.equal(page.delivery.html.supported, false);
  assert.equal(page.platform_compliance, 'not_claimed');

  // 3) 事实值改写：阻断且给出不一致证据
  const wrong = await request(port, `/api/projects/${project.id}/detail-pages`, {
    method: 'POST', headers: as(),
    body: { sections: sectionsOf({ packagingId: packaging.id, capacity: '50ml' }), copy_version: 'copy_v1' },
  });
  assert.equal(wrong.status, 201, JSON.stringify(wrong.json));
  assert.equal(wrong.json.detail_page.decision, 'blocked');
  assert.ok(wrong.json.detail_page.blockers.some(item => item.code === 'DETAIL_FACT_VALUE_MISMATCH'));

  // 4) 重检：未变化参数复用来源，仍可发布
  const recheck = await request(port, `/api/projects/${project.id}/detail-pages/${page.id}/recheck`, {
    method: 'POST', headers: as(), body: {},
  });
  assert.equal(recheck.status, 201, JSON.stringify(recheck.json));
  assert.equal(recheck.json.detail_page.decision, 'publishable');
  assert.deepEqual(recheck.json.detail_page.recheck.affected, []);
  assert.ok(recheck.json.detail_page.version > page.version);

  // 5) 换素材使原引用失效 → 旧页 stale，新重检阻断
  const replaced = await request(port, `/api/projects/${project.id}/assets?role=packaging&filename=box2.png&on_conflict=replace`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' }, body: subjectPng(88, 88),
  });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.json));
  const listed = await request(port, `/api/projects/${project.id}/detail-pages`, { headers: as() });
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  const oldPage = listed.json.detail_pages.find(item => item.id === page.id);
  assert.equal(oldPage.validity.validity, 'stale');

  // 6) 视频：首帧缺失 → 阻断
  const noFrame = await request(port, `/api/projects/${project.id}/video-plans`, {
    method: 'POST', headers: as(), body: { first_frame: {} },
  });
  assert.equal(noFrame.status, 201, JSON.stringify(noFrame.json));
  assert.equal(noFrame.json.video_plan.decision, 'blocked');
  assert.ok(noFrame.json.video_plan.blockers.some(item => item.code === 'VIDEO_FIRST_FRAME'));

  // 7) 视频：生效主体素材做首帧 → Provider 无视频能力仍阻断
  const assets = await request(port, `/api/projects/${project.id}/assets`, { headers: as() });
  const subjectAsset = assets.json.assets.find(item => item.role === 'subject');
  const withFrame = await request(port, `/api/projects/${project.id}/video-plans`, {
    method: 'POST', headers: as(),
    body: {
      first_frame: { kind: 'asset', asset_id: subjectAsset.id },
      duration_seconds: 3,
      motion: { type: 'push_in', amplitude: 0.08 },
      audio: { source: 'none' },
    },
  });
  assert.equal(withFrame.status, 201, JSON.stringify(withFrame.json));
  const plan = withFrame.json.video_plan;
  assert.equal(plan.first_frame.available, true);
  assert.equal(plan.first_frame.publishable, true);
  assert.equal(plan.decision, 'blocked');
  assert.equal(plan.generation.status, 'blocked');
  assert.equal(plan.generation.blocker_code, 'VIDEO_PROVIDER_UNSUPPORTED');
  assert.equal(plan.has_video_file, false);
  assert.equal(plan.video_status, 'blocked');

  // 8) 生成视频：必须明确拒绝，不能假装成功
  const generate = await request(port, `/api/video-plans/${plan.id}/generate`, { method: 'POST', headers: as() });
  assert.equal(generate.status, 409, JSON.stringify(generate.json));
  assert.equal(generate.json.error, 'VIDEO_PROVIDER_UNSUPPORTED');

  // 9) 中间帧失败：阻断整段视频
  const frameReport = await request(port, `/api/video-plans/${plan.id}/frames`, {
    method: 'POST', headers: as(),
    body: {
      frames: [
        { kind: 'first', at_ms: 0, checks: [{ code: 'SUBJECT_IDENTITY', status: 'pass' }] },
        { kind: 'middle', at_ms: 1500, checks: [{ code: 'SUBJECT_IDENTITY', status: 'fail' }] },
        { kind: 'last', at_ms: 3000, checks: [{ code: 'SUBJECT_IDENTITY', status: 'pass' }] },
      ],
    },
  });
  assert.equal(frameReport.status, 200, JSON.stringify(frameReport.json));
  assert.equal(frameReport.json.frame_report.decision, 'blocked');
  assert.equal(frameReport.json.video_plan.video_status, 'blocked');

  // 10) 联合导出：只要部分包；视频缺失显式列出，完整包必须拒绝
  const joint = await request(port, `/api/projects/${project.id}/joint-exports`, {
    method: 'POST', headers: as(),
    body: { detail_page_id: recheck.json.detail_page.id, video_plan_id: plan.id, scope: 'partial' },
  });
  assert.equal(joint.status, 201, JSON.stringify(joint.json));
  const record = joint.json.export;
  assert.equal(record.kind, 'joint');
  assert.equal(record.complete, false);
  assert.ok(record.missing.some(item => item.artifact === 'video'));
  assert.ok(record.missing.some(item => item.artifact === 'image'));
  assert.equal(record.manifest.platform_compliance, 'not_claimed');

  const complete = await request(port, `/api/projects/${project.id}/joint-exports`, {
    method: 'POST', headers: as(),
    body: { detail_page_id: recheck.json.detail_page.id, video_plan_id: plan.id, scope: 'complete' },
  });
  assert.equal(complete.status, 409, JSON.stringify(complete.json));

  // 11) 跨租户：一律 404
  const otherPage = await request(port, `/api/detail-pages/${page.id}`, { headers: as('tenant_demo') });
  assert.equal(otherPage.status, 404);
  const otherPlan = await request(port, `/api/video-plans/${plan.id}`, { headers: as('tenant_demo') });
  assert.equal(otherPlan.status, 404);
});
