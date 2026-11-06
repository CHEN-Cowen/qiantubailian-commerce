/**
 * 阶段 1：商品保真上下文。
 *
 * 覆盖验收场景：主体误改、错 SKU、风格图冒充主体、包装变化缺新素材、边缘/阴影/透视待复核。
 * 所有断言只依赖真实代码行为；真实生图效果仍未验收，测试里不出现"已通过视觉效果"的说法。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { classifyImpact } from '../src/change.mjs';
import {
  CONTEXT_VERSION, auditCompositeFidelity, auditProductContext, buildContextBinding, inspectAssetUsability,
} from '../src/product-context.mjs';

const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'tester_ai02') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

function png(width, height) {
  const pixels = new Uint8Array(width * height * 3).fill(200);
  return encodeRgbPng(width, height, pixels);
}

function asset(overrides = {}) {
  return {
    id: 'ast_1', project_id: 'prj_1', tenant_id: 'tenant_a', filename: 'shot.png',
    role: 'subject', role_status: 'active', mime: 'image/png', ext: 'png',
    size_bytes: 1024, sha256: 'a'.repeat(64), content_hash: 'a'.repeat(64),
    width: 1600, height: 1600, warnings: [], created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function project(overrides = {}) {
  return { id: 'prj_1', tenant_id: 'tenant_a', name: '陶瓷马克杯', sku: 'SKU-01', category: '杯具', ...overrides };
}

function truth(overrides = {}) {
  return {
    id: 'tru_1', project_id: 'prj_1', tenant_id: 'tenant_a', version: 1, sku: 'SKU-01',
    confirmation_status: 'confirmed', content_hash: 'f'.repeat(64),
    facts: [{ key: '容量', value: '350ml', critical: true, confirmed: true, source_asset_id: null }],
    ...overrides,
  };
}

// ---------- 1. 素材可用性 ----------
test('P1 素材可用性：可解码、低分辨率、非 PNG 主体与损坏文件都有明确结论', () => {
  const ok = inspectAssetUsability({ asset: asset(), bytes: png(1600, 1600) });
  assert.equal(ok.usable, true);
  assert.equal(ok.checks.decodable, 'verified');
  assert.equal(ok.checks.short_side, 1600);
  assert.equal(ok.checks.mask_source, 'png_auto');
  assert.deepEqual(ok.retake_hints, []);

  const small = inspectAssetUsability({ asset: asset(), bytes: png(800, 800) });
  assert.equal(small.usable, true, '低分辨率不阻断保存，只提示补拍');
  assert.equal(small.checks.short_side_ok, false);
  assert.ok(small.issues.some(item => item.code === 'LOW_RESOLUTION'));
  assert.ok(small.retake_hints.some(item => item.code === 'RESHOOT_LOW_RESOLUTION'));

  const jpeg = inspectAssetUsability({
    asset: asset({ mime: 'image/jpeg', ext: 'jpg', filename: 'shot.jpg' }),
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  });
  assert.equal(jpeg.usable, false, '损坏 JPEG 不能当作可用素材');
  assert.equal(jpeg.checks.decodable, 'invalid');
  assert.ok(jpeg.issues.some(item => item.code === 'ASSET_UNDECODABLE' && item.severity === 'blocker'));
  assert.ok(jpeg.retake_hints.some(item => item.code === 'RESHOOT_UNDECODABLE'));

  const jpegOk = inspectAssetUsability({
    asset: asset({ mime: 'image/jpeg', ext: 'jpg', width: 2000, height: 1500, filename: 'shot.jpg' }),
  });
  assert.equal(jpegOk.checks.mask_source, 'provider_mask_required');
  assert.ok(jpegOk.retake_hints.some(item => item.code === 'RESHOOT_SUBJECT_BOX'));

  const boxed = inspectAssetUsability({
    asset: asset({ mime: 'image/jpeg', ext: 'jpg', width: 2000, height: 1500, subject_box: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 } }),
  });
  assert.equal(boxed.checks.mask_source, 'manual_box');
  assert.ok(!boxed.retake_hints.some(item => item.code === 'RESHOOT_SUBJECT_BOX'));

  const unknownSize = inspectAssetUsability({ asset: asset({ width: null, height: null }) });
  assert.ok(unknownSize.issues.some(item => item.code === 'ASSET_DIMENSIONS_UNKNOWN'));
});

// ---------- 2. 角色与事实绑定 ----------
test('P1 上下文审计：风格图不能冒充主体，错 SKU 与风格图事实来源都被拦截', () => {
  const styleOnly = auditProductContext({
    project: project(),
    assets: [asset({ id: 'ast_style', role: 'style', sha256: 'b'.repeat(64) })],
    truth: truth(),
    usability: [],
  });
  assert.equal(styleOnly.can_bind, false);
  assert.ok(styleOnly.blockers.some(item => item.code === 'STYLE_CANNOT_BE_SUBJECT'));
  assert.ok(styleOnly.retake_requests.some(item => item.code === 'RESHOOT_MISSING_SUBJECT'));

  const wrongSku = auditProductContext({
    project: project({ sku: 'SKU-02' }),
    assets: [asset()],
    truth: truth({ sku: 'SKU-01' }),
    usability: [],
  });
  assert.ok(wrongSku.blockers.some(item => item.code === 'SKU_MISMATCH'));

  const styleFact = auditProductContext({
    project: project(),
    assets: [asset(), asset({ id: 'ast_style', role: 'style', sha256: 'b'.repeat(64) })],
    truth: truth({
      facts: [{
        key: '颜色', value: '奶油白', critical: true, confirmed: true, source_asset_id: 'ast_style',
      }],
    }),
    usability: [],
  });
  assert.ok(styleFact.blockers.some(item => item.code === 'STYLE_NOT_FACT_SOURCE'));

  const superseded = auditProductContext({
    project: project(),
    assets: [asset()],
    truth: truth({
      facts: [{
        key: '容量', value: '350ml', critical: true, confirmed: true, source_asset_id: 'ast_old',
      }],
    }),
    usability: [],
  });
  assert.ok(superseded.blockers.some(item => item.code === 'FACT_SOURCE_NOT_ACTIVE'));

  const clean = auditProductContext({ project: project(), assets: [asset()], truth: truth(), usability: [] });
  assert.equal(clean.can_bind, true);
  assert.deepEqual(clean.roles, { subject: 1, packaging: 0, detail: 0, style: 0 });
});

test('P1 包装变化缺新素材：关键包装事实无包装素材时阻断并给出补拍请求', () => {
  const audit = auditProductContext({
    project: project(),
    assets: [asset()],
    truth: truth({
      facts: [{
        key: '包装净含量', value: '350ml', unit: 'ml', critical: true, confirmed: true, source_asset_id: null,
      }],
    }),
    usability: [],
  });
  assert.equal(audit.can_bind, false);
  assert.ok(audit.blockers.some(item => item.code === 'PACKAGING_FACT_WITHOUT_ASSET'));
  assert.ok(audit.retake_requests.some(item => item.code === 'RESHOOT_PACKAGING_FRONT'));

  // 换包装 = 关联素材变化，必须重新实拍，不能用换字或重绘冒充
  const impact = classifyImpact({
    diff: { changed_asset_ids: ['ast_pkg'] },
    dependencyEntry: { kind: 'asset', ref: 'ast_pkg' },
  });
  assert.equal(impact.action, 'needs_new_photo');
  assert.match(impact.reason, /新实拍/);
});

// ---------- 3. 上下文绑定 ----------
test('P1 上下文绑定：同一份上下文可复现，素材替换与事实更新都会换 hash', () => {
  const binding = buildContextBinding({
    project: project(), assets: [asset()], truth: truth(),
  });
  assert.equal(binding.version, CONTEXT_VERSION);
  assert.match(binding.context_hash, /^ctx_[0-9a-f]{64}$/);
  assert.equal(binding.asset_count, 1);
  assert.equal(binding.truth.version, 1);
  assert.equal(binding.brand, null);
  assert.equal(binding.spec, null);

  const again = buildContextBinding({ project: project(), assets: [asset()], truth: truth() });
  assert.equal(again.context_hash, binding.context_hash, '字段顺序不影响哈希');

  const replaced = buildContextBinding({
    project: project(), assets: [asset({ sha256: 'c'.repeat(64), content_hash: 'c'.repeat(64) })], truth: truth(),
  });
  assert.notEqual(replaced.context_hash, binding.context_hash, '素材替换后旧报告必须失效');

  const newTruth = buildContextBinding({
    project: project(), assets: [asset()], truth: truth({ version: 2, content_hash: 'e'.repeat(64) }),
  });
  assert.notEqual(newTruth.context_hash, binding.context_hash);

  const withBrand = buildContextBinding({
    project: project(), assets: [asset()], truth: truth(),
    brandKitVersion: { brand_kit_id: 'bk_1', version: 3, content_hash: 'd'.repeat(64) },
    spec: { version: 2, content_hash: 'e'.repeat(64) },
  });
  assert.equal(withBrand.brand.version, 3);
  assert.notEqual(withBrand.context_hash, binding.context_hash);
});

// ---------- 4. 合成保真度 ----------
test('P1 合成保真度：边缘、阴影、透视固定待复核，绝不写成已验证', () => {
  const applied = auditCompositeFidelity({ composite: { applied: true, sha256: 'x'.repeat(64) } });
  assert.equal(applied.status, 'unverified');
  assert.equal(applied.needs_review, true);
  assert.deepEqual(applied.items.map(item => item.code),
    ['EDGE_FIDELITY', 'SHADOW_FIDELITY', 'PERSPECTIVE_FIDELITY']);
  assert.ok(applied.items.every(item => item.status === 'unverified'));
  assert.match(applied.note, /人工对照/);

  const none = auditCompositeFidelity({ composite: null });
  assert.equal(none.status, 'not_applicable');
  assert.equal(none.needs_review, false);
  assert.ok(none.items.every(item => item.status === 'not_applicable'));
});

// ---------- 5. HTTP 接入 ----------
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

async function start(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai02-'));
  const app = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS });
  t.after(async () => {
    await app.close();
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.error('[ai02] 临时目录清理失败（不影响测试结论）', dir, error?.code ?? error?.message ?? error);
    }
  });
  const { port } = await app.listen();
  return { port };
}

async function createProject(port, tenant = 'tenant_a') {
  const response = await request(port, '/api/projects', {
    method: 'POST', headers: as(tenant),
    body: { name: '陶瓷马克杯', sku: 'SKU-AI02', category: '杯具' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.project;
}

async function upload(port, projectId, buffer, { role = 'subject', filename = 'shot.png', mime = 'image/png', tenant = 'tenant_a' } = {}) {
  const query = new URLSearchParams({ role, filename });
  return request(port, `/api/projects/${projectId}/assets?${query}`, {
    method: 'POST', headers: { ...as(tenant), 'Content-Type': mime }, body: buffer,
  });
}

test('P1 HTTP：上传返回可用性与补拍提示，项目详情带上下文绑定与素材审计', async t => {
  const { port } = await start(t);
  const created = await createProject(port);

  const small = await upload(port, created.id, png(800, 800), { filename: 'small.png' });
  assert.equal(small.status, 201, JSON.stringify(small.json));
  assert.equal(small.json.usability.checks.decodable, 'verified');
  assert.equal(small.json.usability.checks.short_side_ok, false);
  assert.ok(small.json.usability.retake_hints.some(item => item.code === 'RESHOOT_LOW_RESOLUTION'));
  assert.ok(small.json.usability.asset_id.startsWith('ast_'));

  const detail = await request(port, `/api/projects/${created.id}`, { headers: as() });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.context_binding.version, CONTEXT_VERSION);
  assert.match(detail.json.context_binding.context_hash, /^ctx_[0-9a-f]{64}$/);
  assert.equal(detail.json.context_binding.asset_count, 1);
  assert.equal(detail.json.asset_audit.can_bind, true);
  assert.equal(detail.json.asset_audit.roles.subject, 1);
  assert.equal(detail.json.asset_usability.length, 1);
  // 详情页不读二进制，解码状态只能是 unverified
  assert.equal(detail.json.asset_usability[0].checks.decodable, 'unverified');

  const before = detail.json.context_binding.context_hash;
  const replaced = await request(port, `/api/projects/${created.id}/assets?${new URLSearchParams({ role: 'subject', filename: 'big.png', on_conflict: 'replace' })}`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' }, body: png(1600, 1600),
  });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.json));
  assert.equal(replaced.json.replaced_asset_ids.length, 1);
  const after = await request(port, `/api/projects/${created.id}`, { headers: as() });
  assert.notEqual(after.json.context_binding.context_hash, before, '主体替换后上下文哈希必须变化');
  assert.equal(after.json.context_binding.assets.length, 1);

  // 跨租户不可见
  const other = await request(port, `/api/projects/${created.id}`, { headers: as('tenant_b') });
  assert.equal(other.status, 404);
});

test('P1 HTTP：只有风格图时项目详情明确标注风格图不能冒充主体', async t => {
  const { port } = await start(t);
  const created = await createProject(port);
  const style = await upload(port, created.id, png(1600, 1600), { role: 'style', filename: 'style.png' });
  assert.equal(style.status, 201, JSON.stringify(style.json));
  assert.equal(style.json.usability.checks.mask_source, null);

  const detail = await request(port, `/api/projects/${created.id}`, { headers: as() });
  assert.equal(detail.json.asset_audit.can_bind, false);
  assert.ok(detail.json.asset_audit.blockers.some(item => item.code === 'STYLE_CANNOT_BE_SUBJECT'));
  assert.ok(detail.json.asset_audit.retake_requests.some(item => item.code === 'RESHOOT_MISSING_SUBJECT'));
  // 既有可生产闸口结论不变：没有主体就不能开始生产
  assert.equal(detail.json.readiness.can_start_production, false);
  assert.ok(detail.json.readiness.blockers.some(item => item.code === 'NO_SUBJECT_ASSET'));
});
