import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, STATIC_FILES } from '../src/server.mjs';
import { getTemplate, listChannelRules, matchChannelRule, ruleStatus } from '../src/catalog.mjs';
import { MAX_BANNED_EXPRESSIONS } from '../src/spec.mjs';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';
const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];

function pngBuffer(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'm04-'));
  const app = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS, ...options });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const { port } = await app.listen();
  return { port, dir, app };
}

const as = (tenant = TENANT_A, actor = 'tester_a') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

async function createProject(port, overrides = {}, tenant = TENANT_A) {
  const response = await request(port, '/api/projects', {
    method: 'POST', headers: as(tenant),
    body: { name: '月光舒缓面霜', sku: 'MC-50', category: '面霜', platform: '天猫', ...overrides },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.project;
}

async function uploadSubject(port, projectId, tenant = TENANT_A) {
  const response = await request(port, `/api/projects/${projectId}/assets?role=subject&filename=shot.png`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': 'image/png' }, body: pngBuffer(1200, 1200),
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.asset;
}

const defaultFacts = () => [
  { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
];

async function confirmTruth(port, projectId, { facts = defaultFacts(), criticalText = [{ text: '月光舒缓' }], tenant = TENANT_A } = {}) {
  const response = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers: as(tenant),
    body: { base_version: 0, confirm: true, facts, critical_text: criticalText },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.truth_version;
}

async function readyProject(port, overrides = {}, truthOptions = {}) {
  const project = await createProject(port, overrides);
  await uploadSubject(port, project.id);
  const truth = await confirmTruth(port, project.id, truthOptions);
  return { project, truth };
}

async function createBrandKit(port, overrides = {}, tenant = TENANT_A) {
  const response = await request(port, '/api/brand-kits', {
    method: 'POST', headers: as(tenant),
    body: {
      name: '月光品牌套件',
      palette: { primary: '#246BCE', secondary: ['#F8FAFC'] },
      logo: { present: false },
      fonts: [{ name: '思源黑体', license: 'licensed', license_ref: 'LIC-2026-01' }],
      tone: '克制、可信',
      banned_expressions: [],
      ...overrides,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json;
}

const preview = (port, projectId, body, tenant = TENANT_A) => request(port, `/api/projects/${projectId}/specs/preview`, {
  method: 'POST', headers: as(tenant), body,
});

const freeze = (port, projectId, body, tenant = TENANT_A) => request(port, `/api/projects/${projectId}/specs`, {
  method: 'POST', headers: as(tenant), body,
});

// ---------- 1. 模板：不只是 Prompt ----------
test('M04 模板目录：交付清单含比例/尺寸/格式/必需标记，且带允许变化、输入要求、QA 与预算', async t => {
  const { port } = await start(t);
  const list = await request(port, '/api/catalog/templates', { headers: as() });
  assert.equal(list.status, 200);
  assert.equal(list.json.templates.length, 3);
  const listing = list.json.templates.find(item => item.id === 'tpl_listing_pack');
  assert.equal(listing.required_deliverable_count, 3);
  assert.equal(listing.recommended_budget.max_attempts, 3);

  const detail = await request(port, '/api/catalog/templates/tpl_listing_pack', { headers: as() });
  assert.equal(detail.status, 200);
  const template = detail.json.template;
  assert.ok(template.deliverables.length >= 3);
  for (const deliverable of template.deliverables) {
    assert.match(deliverable.ratio, /^\d+:\d+$/);
    assert.ok(Number.isInteger(deliverable.width) && deliverable.width > 0);
    assert.ok(Array.isArray(deliverable.formats) && deliverable.formats.length > 0);
    assert.equal(typeof deliverable.required, 'boolean');
    assert.ok(Array.isArray(deliverable.text_blocks));
  }
  assert.ok(template.allowed_variations.includes('background'));
  assert.ok(template.forbidden_changes.some(item => item.includes('主体')));
  assert.ok(template.input_requirements.every(item => item.code && item.label));
  assert.ok(template.qa_profile.checks.includes('subject_identity'));
  assert.equal(template.creative_direction.background, 'scene');

  const missing = await request(port, '/api/catalog/templates/tpl_not_exist', { headers: as() });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'TEMPLATE_NOT_FOUND');
});

// ---------- 2. 平台规则：来源、版本、生效与复核日期 ----------
test('M04 平台规则：状态按生效/复核日期计算，缺失与过期都只表示覆盖不足', async t => {
  const { port } = await start(t);
  const response = await request(port, `/api/catalog/channel-rules?category=${encodeURIComponent('面霜')}`, { headers: as() });
  assert.equal(response.status, 200);
  const rules = response.json.rules;
  assert.equal(rules.length, 3);
  for (const rule of rules) {
    assert.equal(typeof rule.source.name, 'string');
    assert.equal(rule.source.verified, false, '内置基线不得声称已通过官方核验');
    assert.ok(rule.effective_at && rule.review_due_at);
    assert.ok(['current', 'review_due', 'expired', 'not_effective'].includes(rule.status));
  }
  const douyin = rules.find(rule => rule.platform === '抖音');
  assert.equal(douyin.status, 'expired');

  // 纯函数边界：用显式时钟验证，不依赖运行当天
  const tmall = listChannelRules().find(rule => rule.id === 'ch_tmall_listing');
  assert.equal(ruleStatus(tmall, new Date('2026-02-01T00:00:00.000Z')).status, 'not_effective');
  assert.equal(ruleStatus(tmall, new Date('2026-06-01T00:00:00.000Z')).status, 'current');
  assert.equal(ruleStatus(tmall, new Date('2027-02-20T00:00:00.000Z')).status, 'review_due');
  assert.equal(ruleStatus(tmall, new Date('2027-03-02T00:00:00.000Z')).status, 'expired');

  const expired = matchChannelRule({ platform: '抖音', category: '面霜', at: new Date('2026-10-26T00:00:00.000Z') });
  assert.equal(expired.coverage, 'expired');
  assert.ok(expired.reasons.some(reason => reason.includes('复核')));

  const missing = matchChannelRule({ platform: '小红书', category: '面霜', at: new Date('2026-10-26T00:00:00.000Z') });
  assert.equal(missing.coverage, 'missing');
  assert.equal(missing.rule, null);

  const limited = matchChannelRule({ platform: '天猫', category: '家电', at: new Date('2026-10-26T00:00:00.000Z') });
  assert.equal(limited.coverage, 'covered', '基线类目为通配，未单独限制类目');
});

// ---------- 3. 品牌套件 ----------
test('M04 品牌套件：字段校验、重名拒绝、跨租户不可见', async t => {
  const { port } = await start(t);
  const created = await createBrandKit(port);
  assert.match(created.brand_kit.id, /^bk_[0-9a-f]{16}$/);
  assert.equal(created.brand_kit.head_version, 1);
  assert.equal(created.version.version, 1);
  assert.match(created.version.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(created.version.fonts[0].license, 'licensed');

  const badColor = await request(port, '/api/brand-kits', {
    method: 'POST', headers: as(), body: { name: '坏颜色', palette: { primary: 'blue' } },
  });
  assert.equal(badColor.status, 422);
  assert.equal(badColor.json.error, 'INVALID_PALETTE');

  const badFont = await request(port, '/api/brand-kits', {
    method: 'POST', headers: as(),
    body: { name: '坏字体', palette: { primary: '#FFFFFF' }, fonts: [{ name: '某字体', license: 'free' }] },
  });
  assert.equal(badFont.status, 422);
  assert.equal(badFont.json.error, 'INVALID_FONTS');

  const tooManyBanned = await request(port, '/api/brand-kits', {
    method: 'POST', headers: as(),
    body: { name: '过多禁用', palette: { primary: '#FFFFFF' }, banned_expressions: Array.from({ length: MAX_BANNED_EXPRESSIONS + 1 }, (_, index) => `词${index}`) },
  });
  assert.equal(tooManyBanned.status, 422);
  assert.equal(tooManyBanned.json.error, 'INVALID_BANNED_EXPRESSIONS');

  const duplicate = await request(port, '/api/brand-kits', {
    method: 'POST', headers: as(), body: { name: '月光品牌套件', palette: { primary: '#123456' } },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'BRAND_KIT_EXISTS');

  const crossTenant = await request(port, `/api/brand-kits/${created.brand_kit.id}`, { headers: as(TENANT_B) });
  assert.equal(crossTenant.status, 404);
  const crossList = await request(port, '/api/brand-kits', { headers: as(TENANT_B) });
  assert.equal(crossList.json.brand_kits.length, 0);
});

// ---------- 4. 品牌套件版本只追加 ----------
test('M04 品牌套件版本：乐观锁、旧版本内容不被改写', async t => {
  const { port } = await start(t);
  const created = await createBrandKit(port);
  const kitId = created.brand_kit.id;
  const v1 = created.version;

  const conflict = await request(port, `/api/brand-kits/${kitId}/versions`, {
    method: 'POST', headers: as(),
    body: { base_version: 99, name: '月光品牌套件', palette: { primary: '#000000' } },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'VERSION_CONFLICT');
  assert.equal(conflict.json.details.current_version, 1);

  const v2Response = await request(port, `/api/brand-kits/${kitId}/versions`, {
    method: 'POST', headers: as(),
    body: { base_version: 1, name: '月光品牌套件', palette: { primary: '#15803D' }, logo: { present: true, description: '文字标' } },
  });
  assert.equal(v2Response.status, 201, JSON.stringify(v2Response.json));
  assert.equal(v2Response.json.version.version, 2);
  assert.notEqual(v2Response.json.version.content_hash, v1.content_hash);

  const detail = await request(port, `/api/brand-kits/${kitId}`, { headers: as() });
  assert.equal(detail.json.brand_kit.head_version, 2);
  assert.equal(detail.json.versions.length, 2);
  assert.equal(detail.json.versions[0].palette.primary, '#246BCE', 'v1 内容保持原样');
  assert.equal(detail.json.versions[1].palette.primary, '#15803D');
  assert.equal(detail.json.versions[0].logo.present, false);
});

// ---------- 5. 冲突可见：平台硬约束 vs 模板/品牌 ----------
test('M04 预览：平台硬约束与模板/品牌冲突逐条可见且带处理方式', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const kit = await createBrandKit(port, { logo: { present: true, description: '左上角文字标' } });

  const response = await preview(port, project.id, {
    template_id: 'tpl_listing_pack', brand_kit_id: kit.brand_kit.id,
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const conflicts = response.json.payload.conflicts;
  const codes = [...conflicts.pending, ...conflicts.unresolvable].map(item => item.code).sort();
  assert.deepEqual(codes, ['CHANNEL_BANS_LOGO', 'CHANNEL_PLAIN_WHITE_REQUIRED']);
  assert.equal(response.json.would_freeze, false, '未处理冲突时不可冻结');
  for (const conflict of conflicts.pending) {
    assert.ok(conflict.options.length > 0);
    assert.equal(conflict.options.some(option => option.id === 'change_template'), true);
  }
  assert.equal(response.json.payload.channel.status, 'current');
  assert.equal(response.json.payload.channel.coverage, 'covered');
  assert.equal(response.json.payload.channel.platform_coverage, 'unknown', '演示基线未核验来源，不能声称平台通过');
  assert.equal(response.json.payload.channel.can_claim_platform_compliance, false);
});

// ---------- 6. 未处理冲突不能冻结 ----------
test('M04 冻结：未处理冲突返回 409 并列出可选处理，不静默取一条', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const response = await freeze(port, project.id, { template_id: 'tpl_listing_pack', base_version: 0 });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, 'SPEC_CONFLICTS_PENDING');
  assert.equal(response.json.details.conflicts.length, 1);
  assert.equal(response.json.details.conflicts[0].code, 'CHANNEL_PLAIN_WHITE_REQUIRED');

  const specs = await request(port, `/api/projects/${project.id}/specs`, { headers: as() });
  assert.equal(specs.json.specs.length, 0, '被拒绝的请求不产生任何快照');

  const invalidResolution = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'ignore_platform' },
  });
  assert.equal(invalidResolution.status, 422);
  assert.equal(invalidResolution.json.error, 'INVALID_RESOLUTION');
  assert.ok(invalidResolution.json.details.allowed.includes('adopt_plain_white'));
});

// ---------- 7. 冻结成功：快照内容与依据 ----------
test('M04 冻结成功：交付清单按处理方式调整，快照记录模板/套件/规则版本与哈希', async t => {
  const { port } = await start(t);
  const { project, truth } = await readyProject(port);
  const kit = await createBrandKit(port, { logo: { present: true } });
  const response = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', brand_kit_id: kit.brand_kit.id, base_version: 0,
    conflict_resolutions: {
      'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white',
      'CHANNEL_BANS_LOGO:main': 'omit_logo_on_main',
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const spec = response.json.spec;
  assert.equal(spec.version, 1);
  assert.equal(spec.project_id, project.id);
  const main = spec.deliverables.find(item => item.id === 'main');
  assert.equal(main.background, 'plain_white');
  assert.equal(main.logo_allowed, false);
  assert.equal(spec.deliverables.find(item => item.id === 'scene').background, 'scene', '其他交付物保留模板方向');
  assert.equal(spec.template.id, 'tpl_listing_pack');
  assert.equal(spec.template.version, 1);
  assert.equal(spec.brand_kit.version, 1);
  assert.equal(spec.channel.rule_id, 'ch_tmall_listing');
  assert.equal(spec.channel.version, '2026.03');
  assert.equal(spec.product_truth.version, truth.version);
  assert.equal(spec.product_truth.content_hash, truth.content_hash);
  assert.equal(spec.provenance.resolutions.length, 2);
  assert.match(spec.content_hash, /^[0-9a-f]{64}$/);
  assert.match(spec.deliverable_hash, /^[0-9a-f]{64}$/);
  assert.equal(spec.budget.note.includes('M05'), true);
  assert.equal(response.json.requires_requote, false, '首版无需重新报价');
  assert.equal(response.json.readiness.can_start_production, true);

  const detail = await request(port, `/api/projects/${project.id}`, { headers: as() });
  assert.equal(detail.json.project.spec_head_version, 1);
  assert.equal(detail.json.project.status, 'spec_frozen');
});

// ---------- 8. 平台规则过期与未收录 ----------
test('M04 规则覆盖：过期与未收录都标记 unknown，且不影响冻结但不得声称平台通过', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const expired = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', platform: '抖音', base_version: 0,
    conflict_resolutions: { 'CHANNEL_ASPECT_MISMATCH:main': 'adopt_channel_ratio' },
  });
  assert.equal(expired.status, 201, JSON.stringify(expired.json));
  assert.equal(expired.json.spec.channel.status, 'expired');
  assert.equal(expired.json.spec.channel.coverage, 'expired');
  assert.equal(expired.json.spec.channel.platform_coverage, 'unknown');
  assert.equal(expired.json.spec.channel.can_claim_platform_compliance, false);
  assert.equal(expired.json.spec.gaps.unknown_rule_coverage, true);
  assert.ok(expired.json.spec.gaps.warnings.some(item => item.code === 'CHANNEL_EXPIRED'));
  assert.equal(expired.json.spec.deliverables.find(item => item.id === 'main').ratio, '3:4');

  const second = await readyProject(port, { sku: 'MC-51' });
  const missing = await freeze(port, second.project.id, {
    template_id: 'tpl_social_note', platform: '小红书', base_version: 0,
  });
  assert.equal(missing.status, 201, JSON.stringify(missing.json));
  assert.equal(missing.json.spec.channel.status, 'missing');
  assert.equal(missing.json.spec.channel.coverage, 'missing');
  assert.equal(missing.json.spec.channel.rule_id, null);
  assert.equal(missing.json.spec.channel.can_claim_platform_compliance, false);
});

// ---------- 9. 无法满足的硬约束必须停止 ----------
test('M04 无法满足：关键文字超出平台上限时拒绝冻结并指出必须改事实', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port, {}, { criticalText: [{ text: '月光舒缓屏障修护霜五十克装' }] });
  const response = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, 'SPEC_CONFLICT_UNRESOLVABLE');
  assert.equal(response.json.details.conflicts[0].code, 'CRITICAL_TEXT_TOO_LONG');
  assert.equal(response.json.details.conflicts[0].options.length, 0, '不提供"忽略平台"的选项');

  const specs = await request(port, `/api/projects/${project.id}/specs`, { headers: as() });
  assert.equal(specs.json.specs.length, 0);
});

// ---------- 10. 无依据内容只提示不代写 ----------
test('M04 无依据内容：未附证据的卖点/成分只给补证据提示，不自动补全文案', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port, {}, {
    facts: [
      { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
      { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
      { key: '成分', value: '神经酰胺', critical: false, confirmed: true, source_type: 'user_input' },
    ],
  });
  const response = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const gaps = response.json.spec.gaps.claims_without_evidence;
  assert.deepEqual(gaps.map(item => item.fact_key).sort(), ['容量', '成分', '核心卖点'].sort(), '规格、成分与卖点都属需要依据的内容');
  assert.ok(gaps.every(item => item.code === 'CLAIM_WITHOUT_EVIDENCE' && item.message.includes('补证据')));
  // 只保留"引用哪条事实"，没有任何生成出来的文案
  const benefit = response.json.spec.deliverables.find(item => item.id === 'benefit');
  assert.deepEqual(benefit.text_blocks, ['fact:核心卖点', 'critical_text']);
  assert.equal(JSON.stringify(response.json.spec).includes('即刻'), false);
  assert.equal(response.json.spec.gaps.missing_references.length, 0);

  const noClaim = await readyProject(port, { sku: 'MC-52' }, {
    facts: [{ key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' }],
  });
  const withMissingRef = await freeze(port, noClaim.project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(withMissingRef.status, 201, JSON.stringify(withMissingRef.json));
  const missing = withMissingRef.json.spec.gaps.missing_references;
  assert.ok(missing.some(item => item.code === 'FACT_REFERENCE_MISSING' && item.message.includes('核心卖点')));
});

// ---------- 11. 旧快照不被新配置覆盖 ----------
test('M04 快照不覆盖：换品牌套件版本后旧 spec 内容与哈希不变，只被判为 stale', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const kit = await createBrandKit(port);
  const first = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', brand_kit_id: kit.brand_kit.id, base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const before = await request(port, `/api/projects/${project.id}/specs/1`, { headers: as() });
  assert.equal(before.json.spec.validity.validity, 'current');

  await request(port, `/api/brand-kits/${kit.brand_kit.id}/versions`, {
    method: 'POST', headers: as(),
    body: { base_version: 1, name: '月光品牌套件', palette: { primary: '#6D5BD0' } },
  });

  const after = await request(port, `/api/projects/${project.id}/specs/1`, { headers: as() });
  assert.equal(after.json.spec.content_hash, first.json.spec.content_hash, '旧快照哈希不变');
  assert.deepEqual(after.json.spec.deliverables, first.json.spec.deliverables, '旧快照交付清单不变');
  assert.equal(after.json.spec.brand_kit.version, 1);
  assert.equal(after.json.spec.validity.validity, 'stale');
  assert.ok(after.json.spec.validity.reasons.some(reason => reason.includes('品牌套件')));

  const second = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', brand_kit_id: kit.brand_kit.id, base_version: 1,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  assert.equal(second.json.spec.brand_kit.version, 2);
  assert.equal(second.json.spec.validity.validity, 'current');
  assert.notEqual(second.json.spec.content_hash, first.json.spec.content_hash);
  assert.equal(second.json.requires_requote, false, '只换品牌套件不改清单结构，不应要求重新报价');
  assert.deepEqual(second.json.deliverable_changes, []);
});

// ---------- 12. 交付清单变化要重新报价 ----------
test('M04 清单变更：换模板导致交付清单变化时标记需重新报价并列出差异', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const first = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));

  const same = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 1,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(same.status, 201);
  assert.equal(same.json.requires_requote, false, '清单未变不要求重新报价');
  assert.deepEqual(same.json.deliverable_changes, []);

  const changed = await freeze(port, project.id, {
    template_id: 'tpl_ad_creative', base_version: 2,
    conflict_resolutions: {
      'CHANNEL_PLAIN_WHITE_REQUIRED:square': 'adopt_plain_white',
      'CHANNEL_BANS_MAIN_TEXT:square': 'drop_main_text',
      'CHANNEL_MIN_SIZE:square': 'adopt_channel_size',
    },
  });
  assert.equal(changed.status, 201, JSON.stringify(changed.json));
  assert.equal(changed.json.requires_requote, true);
  const kinds = changed.json.deliverable_changes.map(item => item.change);
  assert.ok(kinds.includes('added') && kinds.includes('removed'));
  const square = changed.json.spec.deliverables.find(item => item.id === 'square');
  assert.equal(square.width, 1200, '按平台最小短边等比放大');
  assert.equal(square.height, 1200);
  assert.deepEqual(square.text_blocks, []);
});

// ---------- 13. 乐观锁与前置闸口 ----------
test('M04 冻结前置条件：乐观锁冲突与不可生产状态都拒绝，不产生快照', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });

  const stale = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'VERSION_CONFLICT');
  assert.equal(stale.json.details.current_version, 1);

  const noBase = await freeze(port, project.id, { template_id: 'tpl_listing_pack' });
  assert.equal(noBase.status, 422);
  assert.equal(noBase.json.error, 'INVALID_BASE_VERSION');

  const bare = await createProject(port, { sku: 'MC-EMPTY' });
  const blocked = await freeze(port, bare.id, { template_id: 'tpl_listing_pack', base_version: 0 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'READINESS_BLOCKED');
  assert.ok(blocked.json.details.blockers.length > 0);

  const draftOnly = await createProject(port, { sku: 'MC-DRAFT' });
  await uploadSubject(port, draftOnly.id);
  await request(port, `/api/projects/${draftOnly.id}/truth-versions`, {
    method: 'POST', headers: as(),
    body: { base_version: 0, confirm: false, facts: defaultFacts() },
  });
  const blockedDraft = await freeze(port, draftOnly.id, { template_id: 'tpl_listing_pack', base_version: 0 });
  assert.equal(blockedDraft.status, 409);
  assert.equal(blockedDraft.json.error, 'READINESS_BLOCKED');
  assert.ok(blockedDraft.json.details.blockers.some(item => item.code === 'TRUTH_DRAFT'));
});

// ---------- 14. 跨租户隔离 ----------
test('M04 跨租户：他人项目的快照与套件一律按不存在处理', async t => {
  const { port } = await start(t);
  const { project } = await readyProject(port);
  const kit = await createBrandKit(port);
  const frozen = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', brand_kit_id: kit.brand_kit.id, base_version: 0,
    conflict_resolutions: { 'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white' },
  });
  assert.equal(frozen.status, 201);

  const readSpec = await request(port, `/api/projects/${project.id}/specs/1`, { headers: as(TENANT_B) });
  assert.equal(readSpec.status, 404);
  const listSpec = await request(port, `/api/projects/${project.id}/specs`, { headers: as(TENANT_B) });
  assert.equal(listSpec.status, 404);
  const previewOther = await preview(port, project.id, { template_id: 'tpl_listing_pack' }, TENANT_B);
  assert.equal(previewOther.status, 404);

  const ownProject = await createProject(port, { sku: 'MC-TB' }, TENANT_B);
  await uploadSubject(port, ownProject.id, TENANT_B);
  await confirmTruth(port, ownProject.id, { tenant: TENANT_B });
  const foreignKit = await freeze(port, ownProject.id, {
    template_id: 'tpl_listing_pack', brand_kit_id: kit.brand_kit.id, base_version: 0,
  }, TENANT_B);
  assert.equal(foreignKit.status, 404);
  assert.equal(foreignKit.json.error, 'NOT_FOUND');
});

// ---------- 15. 存储兼容 ----------
test('M04 存储：旧版 data.json 只有三张表也能加载并写入新表', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'm04-store-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, 'data.json'), `${JSON.stringify({ schema_version: 1, projects: {}, assets: {}, truth_versions: {} })}\n`, 'utf8');
  const app = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS });
  t.after(async () => { await app.close(); });
  const { port } = await app.listen();

  const kit = await createBrandKit(port);
  assert.equal(kit.brand_kit.head_version, 1);
  const raw = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(raw.schema_version, 1);
  assert.ok(raw.brand_kits[kit.brand_kit.id]);
  assert.ok(Object.keys(raw.brand_kit_versions).length === 1);
  assert.ok(Array.isArray(Object.values(raw.specs)));
  assert.ok(raw.specs !== null && typeof raw.specs === 'object');
});

// ---------- 16. 前端接线契约 ----------
test('M04 前端契约：静态白名单包含新文件，页面有生产配置入口', async t => {
  for (const file of ['m04.js', 'm04.css']) {
    assert.ok(STATIC_FILES.includes(file), `STATIC_FILES 缺少 ${file}`);
  }
  const html = await readFile(fileURLToPath(new URL('../frontend/index.html', import.meta.url)), 'utf8');
  for (const id of ['spec-dialog', 'spec-body', 'spec-form', 'brand-dialog', 'brand-form', 'spec-template', 'spec-brand']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.ok(html.includes('m04.css'), 'index.html 未引入 m04.css');
  assert.ok(html.includes('m04.js'), 'index.html 未引入 m04.js');

  const script = await readFile(fileURLToPath(new URL('../frontend/m04.js', import.meta.url)), 'utf8');
  assert.match(script, /validity\.reasons/, '界面必须展示快照失效原因，而不只是灰标签');
  assert.match(script, /spec-view/, '版本历史必须能点开某一版快照');
  assert.match(script, /getSpec\(/, '快照详情必须从 /specs/:version 读取冻结快照');
  const api = await readFile(fileURLToPath(new URL('../frontend/api.js', import.meta.url)), 'utf8');
  assert.match(api, /getSpec:/, 'api.js 缺少 getSpec 封装');
});
