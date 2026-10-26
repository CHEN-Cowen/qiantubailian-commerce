import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, STATIC_FILES } from '../src/server.mjs';
import { inspectImage } from '../src/images.mjs';
import { computeReadiness } from '../src/domain.mjs';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';
const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];

// ---------- 测试用最小真实图片头 ----------
function pngBuffer(width, height, pad = 0) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return pad > 0 ? Buffer.concat([header, Buffer.alloc(pad, 0x01)]) : header;
}

function jpegBuffer(width, height, pad = 0) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(21);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(0x0011, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const tail = Buffer.from([0xff, 0xd9]);
  const body = pad > 0 ? Buffer.alloc(pad, 0x02) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, body, tail]);
}

function webpBuffer(width, height) {
  const buffer = Buffer.alloc(40);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(32, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8 ', 12, 'latin1');
  buffer.writeUInt32LE(20, 16);
  buffer[23] = 0x9d; buffer[24] = 0x01; buffer[25] = 0x2a;
  buffer.writeUInt16LE(width & 0x3fff, 26);
  buffer.writeUInt16LE(height & 0x3fff, 28);
  return buffer;
}

// ---------- HTTP 与启动辅助 ----------
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'm03-'));
  const app = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS, ...options });
  t.after(async () => {
    await app.close(); // close() 会先排空写队列，再让清理安全进行
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      // 清理失败（Windows 上系统临时目录偶发 ENOTEMPTY）只记录，不掩盖测试结论
      console.error('[m03] 临时目录清理失败（不影响测试结论）', dir, error?.code ?? error?.message ?? error);
    }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

const as = (tenant = TENANT_A, actor = 'tester_a') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

async function createProject(port, overrides = {}, tenant = TENANT_A) {
  const response = await request(port, '/api/projects', {
    method: 'POST',
    headers: as(tenant),
    body: { name: '月光舒缓面霜', sku: 'MC-50', category: '面霜', platform: '天猫旗舰店', ...overrides },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.project;
}

async function upload(port, projectId, buffer, { role = 'subject', filename = 'shot.png', mime = 'image/png', extra = '', tenant = TENANT_A } = {}) {
  const query = new URLSearchParams({ role, filename });
  return request(port, `/api/projects/${projectId}/assets?${query}${extra}`, {
    method: 'POST',
    headers: { ...as(tenant), 'Content-Type': mime },
    body: buffer,
  });
}

async function truth(port, projectId, body, tenant = TENANT_A) {
  return request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    headers: as(tenant),
    body,
  });
}

// ---------- 1. 图片真实类型与尺寸 ----------
test('M03 图片识别：真实类型、尺寸与损坏文件拒绝', () => {
  assert.deepEqual(
    (() => { const info = inspectImage(pngBuffer(1200, 1500)); return { mime: info.mime, width: info.width, height: info.height }; })(),
    { mime: 'image/png', width: 1200, height: 1500 },
  );
  assert.deepEqual(
    (() => { const info = inspectImage(jpegBuffer(800, 1200)); return { mime: info.mime, ext: info.ext, height: info.height }; })(),
    { mime: 'image/jpeg', ext: 'jpg', height: 1200 },
  );
  assert.deepEqual(
    (() => { const info = inspectImage(webpBuffer(1600, 900)); return { mime: info.mime, width: info.width }; })(),
    { mime: 'image/webp', width: 1600 },
  );
  assert.throws(() => inspectImage(Buffer.from('GIF89a-not-an-accepted-format')), error => error.code === 'UNSUPPORTED_FILE_TYPE' && error.status === 415);
  assert.throws(() => inspectImage(pngBuffer(1200, 1200).subarray(0, 20)), error => error.code === 'CORRUPT_IMAGE');
  assert.throws(() => inspectImage(Buffer.alloc(0)), error => error.code === 'EMPTY_FILE' && error.status === 400);
});

// ---------- 2. 项目创建与 SKU 重复 ----------
test('M03 项目创建：必填校验、同租户 SKU 重复不覆盖、不同租户可复用 SKU', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  assert.match(project.id, /^prj_[0-9a-f]{16}$/);
  assert.equal(project.tenant_id, TENANT_A);
  assert.equal(project.truth_head_version, 0);
  assert.equal(project.created_by, 'tester_a');

  const detail = await request(port, `/api/projects/${project.id}`, { headers: as() });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.readiness.can_start_production, false);
  assert.deepEqual(detail.json.readiness.blockers.map(item => item.code), ['NO_ASSETS', 'NO_TRUTH_VERSION']);

  const duplicate = await request(port, '/api/projects', {
    method: 'POST', headers: as(), body: { name: '另一个名字', sku: 'mc-50', category: '面霜' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'SKU_EXISTS');
  assert.equal(duplicate.json.details.existing_project_id, project.id);

  const listA = await request(port, '/api/projects', { headers: as() });
  assert.equal(listA.json.projects.length, 1);
  assert.equal(listA.json.projects[0].name, '月光舒缓面霜');

  await createProject(port, { name: 'B 租户同名商品' }, TENANT_B);
  const listB = await request(port, '/api/projects', { headers: as(TENANT_B) });
  assert.equal(listB.json.projects.length, 1);
  assert.equal(listB.json.projects[0].id !== project.id, true);

  for (const body of [{ sku: 'MC-51', category: '面霜' }, { name: 'x', sku: '中文 SKU', category: '面霜' }, { name: 'x', sku: 'MC-52' }]) {
    const response = await request(port, '/api/projects', { method: 'POST', headers: as(), body });
    assert.equal(response.status, 422, JSON.stringify(body));
  }
});

// ---------- 3. 跨租户拒绝 ----------
test('M03 跨租户拒绝：未知租户 403，跨租户读写按不存在处理', async t => {
  const { port } = await start(t);
  const project = await createProject(port);

  assert.equal((await request(port, '/api/projects', { headers: { 'x-tenant-id': 'tenant_z' } })).status, 403);
  assert.equal((await request(port, '/api/projects', { headers: { 'x-actor-id': 'bad actor!' } })).status, 400);

  const paths = [
    ['GET', `/api/projects/${project.id}`],
    ['GET', `/api/projects/${project.id}/assets`],
    ['GET', `/api/projects/${project.id}/readiness`],
    ['GET', `/api/projects/${project.id}/truth-versions`],
  ];
  for (const [method, route] of paths) {
    const response = await request(port, route, { method, headers: as(TENANT_B) });
    assert.equal(response.status, 404, `${method} ${route}`);
  }

  const foreignUpload = await upload(port, project.id, pngBuffer(1200, 1200), { tenant: TENANT_B });
  assert.equal(foreignUpload.status, 404);
  const foreignTruth = await truth(port, project.id, { base_version: 0, confirm: false, facts: [] }, TENANT_B);
  assert.equal(foreignTruth.status, 404);

  const ownerDetail = await request(port, `/api/projects/${project.id}`, { headers: as() });
  assert.equal(ownerDetail.json.assets.length, 0, '跨租户写入不得产生任何素材');
  assert.equal(ownerDetail.json.project.truth_head_version, 0, '跨租户提交不得产生事实版本');
});

// ---------- 4. 上传校验 ----------
test('M03 素材上传：类型、扩展名、体积、职责与数量上限校验', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  const endpoint = `/api/projects/${project.id}/assets`;

  const invalidRole = await upload(port, project.id, pngBuffer(1200, 1200), { role: 'cover' });
  assert.equal(invalidRole.status, 422);
  assert.equal(invalidRole.json.error, 'INVALID_ROLE');

  const textFile = await request(port, `${endpoint}?role=subject&filename=a.png`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' }, body: Buffer.from('this is not an image at all'),
  });
  assert.equal(textFile.status, 415);
  assert.equal(textFile.json.error, 'UNSUPPORTED_FILE_TYPE');

  const typeMismatch = await upload(port, project.id, pngBuffer(1200, 1200), { mime: 'image/jpeg' });
  assert.equal(typeMismatch.status, 415);
  assert.equal(typeMismatch.json.error, 'TYPE_MISMATCH');

  const extensionMismatch = await upload(port, project.id, pngBuffer(1200, 1200), { filename: 'shot.jpg' });
  assert.equal(extensionMismatch.status, 415);
  assert.equal(extensionMismatch.json.error, 'EXTENSION_MISMATCH');

  const empty = await request(port, `${endpoint}?role=subject&filename=a.png`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'EMPTY_FILE');

  const stored = await upload(port, project.id, pngBuffer(1200, 1200, 4096));
  assert.equal(stored.status, 201, JSON.stringify(stored.json));
  assert.equal(stored.json.asset.width, 1200);
  assert.match(stored.json.asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.json.asset.role_label, '主体');
  assert.deepEqual(stored.json.warnings, []);

  const content = await request(port, stored.json.asset.content_url, { headers: as() });
  assert.equal(content.status, 200);
  assert.equal(content.headers['content-type'], 'image/png');
  assert.deepEqual(content.body, pngBuffer(1200, 1200, 4096));

  for (let index = 0; index < 5; index++) {
    const extra = await upload(port, project.id, pngBuffer(1200, 1200), { role: 'detail', filename: `detail-${index}.png` });
    assert.equal(extra.status, 201);
  }
  const overLimit = await upload(port, project.id, pngBuffer(1200, 1200), { role: 'detail', filename: 'detail-6.png' });
  assert.equal(overLimit.status, 409);
  assert.equal(overLimit.json.error, 'ASSET_LIMIT');

  const limited = await start(t, { maxUploadBytes: 512 });
  const limitedProject = await createProject(limited.port);
  const tooLarge = await upload(limited.port, limitedProject.id, pngBuffer(1200, 1200, 2048));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.error, 'PAYLOAD_TOO_LARGE');
});

// ---------- 5. 低清提示 ----------
test('M03 低清素材可保存但提示补图，并进入 readiness 警告', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  const response = await upload(port, project.id, pngBuffer(800, 900), { filename: 'low.png' });
  assert.equal(response.status, 201);
  assert.deepEqual(response.json.warnings.map(item => item.code), ['LOW_RESOLUTION']);
  assert.match(response.json.warnings[0].message, /1024/);
  assert.ok(response.json.readiness.warnings.some(item => item.code === 'LOW_RESOLUTION'));
});

// ---------- 6. 参考职责冲突 ----------
test('M03 参考职责冲突：默认拒绝并给出候选，显式 replace 才替换旧素材', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  const first = await upload(port, project.id, pngBuffer(1200, 1200), { filename: 'front.png' });
  assert.equal(first.status, 201);

  const conflict = await upload(port, project.id, pngBuffer(1300, 1300), { filename: 'back.png' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'REFERENCE_CONFLICT');
  assert.equal(conflict.json.details.candidates.length, 1);
  assert.equal(conflict.json.details.candidates[0].asset_id, first.json.asset.id);

  const replaced = await upload(port, project.id, pngBuffer(1300, 1300), { filename: 'back.png', extra: '&on_conflict=replace' });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.json));
  assert.deepEqual(replaced.json.replaced_asset_ids, [first.json.asset.id]);

  const assets = await request(port, `/api/projects/${project.id}/assets`, { headers: as() });
  const statuses = assets.json.assets.map(asset => [asset.filename, asset.role_status]);
  assert.deepEqual(statuses, [['front.png', 'superseded'], ['back.png', 'active']]);

  const secondDetail = await upload(port, project.id, pngBuffer(1200, 1200), { role: 'detail', filename: 'd1.png' });
  const thirdDetail = await upload(port, project.id, pngBuffer(1200, 1200), { role: 'detail', filename: 'd2.png' });
  assert.equal(secondDetail.status, 201);
  assert.equal(thirdDetail.status, 201);
});

// ---------- 7. 缺图与关键项未确认拦截 ----------
test('M03 生产闸口：缺图、无关键项、关键项未确认均拦截，确认后放行', async t => {
  const { port } = await start(t);
  const project = await createProject(port);

  const noAssets = await truth(port, project.id, { base_version: 0, confirm: true, facts: [] });
  assert.equal(noAssets.status, 409);
  assert.equal(noAssets.json.error, 'CONFIRMATION_BLOCKED');
  assert.ok(noAssets.json.details.blockers.some(item => item.code === 'NO_ASSETS'));
  assert.equal((await request(port, `/api/projects/${project.id}`, { headers: as() })).json.project.truth_head_version, 0);

  const asset = await upload(port, project.id, pngBuffer(1400, 1400), { filename: 'hero.png' });
  const assetId = asset.json.asset.id;

  const noCritical = await truth(port, project.id, {
    base_version: 0, confirm: true,
    facts: [{ key: '容量', value: '50g', source_asset_id: assetId }],
  });
  assert.equal(noCritical.status, 409);
  assert.ok(noCritical.json.details.blockers.some(item => item.code === 'NO_CRITICAL_FACT'));

  const unconfirmed = await truth(port, project.id, {
    base_version: 0, confirm: true,
    facts: [{ key: '容量', value: '50g', unit: 'g', source_asset_id: assetId, critical: true }],
  });
  assert.equal(unconfirmed.status, 409);
  const blocker = unconfirmed.json.details.blockers.find(item => item.code === 'UNCONFIRMED_CRITICAL_FACTS');
  assert.deepEqual(blocker.details.keys, ['容量']);

  const draft = await truth(port, project.id, {
    base_version: 0, confirm: false,
    facts: [{ key: '容量', value: '50g', unit: 'g', source_asset_id: assetId, critical: true }],
  });
  assert.equal(draft.status, 201);
  assert.equal(draft.json.truth_version.confirmation_status, 'draft');
  assert.equal(draft.json.readiness.can_start_production, false);
  assert.ok(draft.json.readiness.blockers.some(item => item.code === 'TRUTH_DRAFT'));

  const confirmed = await truth(port, project.id, {
    base_version: 1, confirm: true,
    facts: [{ key: '容量', value: '50g', unit: 'g', source_asset_id: assetId, critical: true, confirmed: true }],
    critical_text: [{ text: 'MOON CALM', region: { unit: 'normalized', x: 0.1, y: 0.1, w: 0.4, h: 0.2 } }],
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.truth_version.confirmation_status, 'confirmed');
  assert.equal(confirmed.json.readiness.can_start_production, true);
  assert.equal(confirmed.json.truth_version.created_by, 'tester_a');
  assert.equal(confirmed.json.truth_version.facts[0].confirmed_by, 'tester_a');
  assert.ok(confirmed.json.truth_version.facts[0].confirmed_at);
});

// ---------- 8. 事实来源与坐标规则 ----------
test('M03 事实规则：风格图不作为事实来源、来源必须属于本项目、坐标需标注单位', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  const other = await createProject(port, { sku: 'WL-08', name: '雾白便携台灯' });
  const subject = await upload(port, project.id, pngBuffer(1200, 1200), { filename: 'hero.png' });
  const style = await upload(port, project.id, pngBuffer(1200, 1200), { role: 'style', filename: 'mood.png' });
  const foreign = await upload(port, other.id, pngBuffer(1200, 1200), { filename: 'other.png' });

  const fromStyle = await truth(port, project.id, {
    base_version: 0, facts: [{ key: '颜色', value: '象牙白', source_asset_id: style.json.asset.id }],
  });
  assert.equal(fromStyle.status, 422);
  assert.equal(fromStyle.json.error, 'STYLE_NOT_FACT_SOURCE');

  const fromForeign = await truth(port, project.id, {
    base_version: 0, facts: [{ key: '颜色', value: '象牙白', source_asset_id: foreign.json.asset.id }],
  });
  assert.equal(fromForeign.status, 422);
  assert.equal(fromForeign.json.error, 'FACT_SOURCE_INVALID');

  const noSource = await truth(port, project.id, { base_version: 0, facts: [{ key: '颜色', value: '象牙白' }] });
  assert.equal(noSource.status, 422);
  assert.equal(noSource.json.error, 'FACT_SOURCE_REQUIRED');

  const userInput = await truth(port, project.id, {
    base_version: 0, facts: [{ key: '规格', value: '50g', source_type: 'user_input', critical: true }],
  });
  assert.equal(userInput.status, 201, JSON.stringify(userInput.json));
  assert.equal(userInput.json.truth_version.facts[0].source_type, 'user_input');

  const badConfidence = await truth(port, project.id, {
    base_version: 1, facts: [{ key: 'a', value: '1', source_type: 'user_input', confidence: 1.5 }],
  });
  assert.equal(badConfidence.status, 422);

  const duplicateKey = await truth(port, project.id, {
    base_version: 1, facts: [
      { key: 'a', value: '1', source_type: 'user_input' },
      { key: 'a', value: '2', source_type: 'user_input' },
    ],
  });
  assert.equal(duplicateKey.status, 422);
  assert.equal(duplicateKey.json.error, 'DUPLICATE_FACT_KEY');

  const pixelWithoutSize = await truth(port, project.id, {
    base_version: 1, facts: [{
      key: 'b', value: '2', source_asset_id: subject.json.asset.id,
      region: { unit: 'pixel', x: 10, y: 10, w: 100, h: 100 },
    }],
  });
  assert.equal(pixelWithoutSize.status, 422);
  assert.equal(pixelWithoutSize.json.error, 'INVALID_REGION');

  const missingUnit = await truth(port, project.id, {
    base_version: 1, facts: [{
      key: 'c', value: '3', source_asset_id: subject.json.asset.id,
      region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    }],
  });
  assert.equal(missingUnit.status, 422);
  assert.equal(missingUnit.json.error, 'INVALID_REGION_UNIT');

  const badTransform = await truth(port, project.id, {
    base_version: 1,
    immutable_regions: [{ asset_id: subject.json.asset.id, mask_id: 'm1', protection: 'logo', allowed_transforms: ['warp'] }],
  });
  assert.equal(badTransform.status, 422);
  assert.equal(badTransform.json.error, 'INVALID_IMMUTABLE_REGIONS');
});

// ---------- 9. 乐观锁与版本不可覆盖 ----------
test('M03 事实版本：乐观锁拒绝旧基线，新版本不覆盖旧版本', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  const asset = await upload(port, project.id, pngBuffer(1200, 1200), { filename: 'hero.png' });
  const assetId = asset.json.asset.id;

  const v1 = await truth(port, project.id, {
    base_version: 0, confirm: true,
    facts: [{ key: '容量', value: '50g', source_asset_id: assetId, critical: true, confirmed: true }],
  });
  assert.equal(v1.status, 201);
  const v1Hash = v1.json.truth_version.content_hash;

  const stale = await truth(port, project.id, {
    base_version: 0, confirm: true,
    facts: [{ key: '容量', value: '80g', source_asset_id: assetId, critical: true, confirmed: true }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'VERSION_CONFLICT');
  assert.equal(stale.json.details.current_version, 1);

  const v2 = await truth(port, project.id, {
    base_version: 1, confirm: true,
    facts: [
      { key: '容量', value: '80g', source_asset_id: assetId, critical: true, confirmed: true },
      { key: '包装颜色', value: '象牙白', source_asset_id: assetId, critical: true, confirmed: true },
    ],
  });
  assert.equal(v2.status, 201, JSON.stringify(v2.json));
  assert.equal(v2.json.truth_version.version, 2);
  assert.notEqual(v2.json.truth_version.content_hash, v1Hash);

  const oldVersion = await request(port, `/api/projects/${project.id}/truth-versions/1`, { headers: as() });
  assert.equal(oldVersion.status, 200);
  assert.equal(oldVersion.json.truth_version.content_hash, v1Hash);
  assert.equal(oldVersion.json.truth_version.facts.length, 1);
  assert.equal(oldVersion.json.truth_version.facts[0].value, '50g');

  const versions = await request(port, `/api/projects/${project.id}/truth-versions`, { headers: as() });
  assert.equal(versions.json.head_version, 2);
  assert.deepEqual(versions.json.versions.map(item => item.version), [1, 2]);
  assert.equal((await request(port, `/api/projects/${project.id}/truth-versions/9`, { headers: as() })).status, 404);

  const detail = await request(port, `/api/projects/${project.id}`, { headers: as() });
  assert.equal(detail.json.truth_head.version, 2);
  assert.equal(detail.json.truth_head.facts.length, 2);
});

// ---------- 10. 替换素材后事实来源失效 ----------
test('M03 素材被替换后，引用旧素材的事实版本阻止生产', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  const asset = await upload(port, project.id, pngBuffer(1200, 1200), { filename: 'v1.png' });
  const assetId = asset.json.asset.id;
  const confirmed = await truth(port, project.id, {
    base_version: 0, confirm: true,
    facts: [{ key: '容量', value: '50g', source_asset_id: assetId, critical: true, confirmed: true }],
  });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.json.readiness.can_start_production, true);

  const replaced = await upload(port, project.id, pngBuffer(1300, 1300), { filename: 'v2.png', extra: '&on_conflict=replace' });
  assert.equal(replaced.status, 201);

  const readiness = await request(port, `/api/projects/${project.id}/readiness`, { headers: as() });
  assert.equal(readiness.json.can_start_production, false);
  const blocker = readiness.json.blockers.find(item => item.code === 'TRUTH_SOURCE_SUPERSEDED');
  assert.deepEqual(blocker.details.keys, ['容量']);

  const foreignSource = await truth(port, project.id, {
    base_version: 1, confirm: true,
    facts: [{ key: '容量', value: '50g', source_asset_id: assetId, critical: true, confirmed: true }],
  });
  assert.equal(foreignSource.status, 422);
  assert.equal(foreignSource.json.error, 'FACT_SOURCE_INVALID');
});

// ---------- 11. API 路由语义 ----------
test('M03 路由语义：未知接口 404、错误方法 405 带 Allow（M05 后 /api/runs 与 /api/quotes 已实现）', async t => {
  const { port } = await start(t);
  // M05 已实现：这些路由不再是 501，但必须按方法判定并带 Allow
  for (const route of ['/api/runs', '/api/quotes']) {
    const response = await request(port, route, { method: 'DELETE', headers: as() });
    assert.equal(response.status, 405, route);
    assert.ok(response.headers.allow?.includes('GET'), `${route} 应回 Allow 头`);
  }
  // 不存在的任务仍按不存在处理，不泄漏
  const missingRun = await request(port, '/api/runs/not-exist', { headers: as() });
  assert.equal(missingRun.status, 404);
  assert.equal(missingRun.json.error, 'NOT_FOUND');
  for (const route of ['/api', '/api/', '/api/unknown']) {
    const response = await request(port, route, { headers: as() });
    assert.equal(response.status, 404, route);
    assert.equal(response.json.error, 'NOT_FOUND');
  }
  const project = await createProject(port);
  for (const [route, expected] of [
    ['/api/projects', 'GET, HEAD, POST'],
    [`/api/projects/${project.id}`, 'GET, HEAD'],
    [`/api/projects/${project.id}/assets`, 'GET, HEAD, POST'],
    [`/api/projects/${project.id}/truth-versions`, 'GET, HEAD, POST'],
    [`/api/projects/${project.id}/readiness`, 'GET, HEAD'],
  ]) {
    const response = await request(port, route, { method: 'PUT', headers: as(), body: {} });
    assert.equal(response.status, 405, route);
    assert.equal(response.headers.allow, expected, route);
  }
  const tenant = await request(port, '/api/tenant', { headers: as() });
  assert.equal(tenant.status, 200);
  assert.equal(tenant.json.tenant_id, TENANT_A);
  assert.match(tenant.json.module, /^M\d{2}$/, '模块标识随版本推进，不在旧用例里钉死具体模块号');
});

// ---------- 12. 重新加载后数据仍在 ----------
test('M03 持久化：重开服务后项目、素材与事实版本仍可读且哈希一致', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'm03-persist-'));
  t.after(async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.error('[m03] 临时目录清理失败（不影响测试结论）', dir, error?.code ?? error?.message ?? error);
    }
  });
  const first = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS });
  const { port: firstPort } = await first.listen();
  const project = await createProject(firstPort);
  const asset = await upload(firstPort, project.id, pngBuffer(1200, 1200, 1024), { filename: 'hero.png' });
  const confirmed = await truth(firstPort, project.id, {
    base_version: 0, confirm: true,
    facts: [{ key: '容量', value: '50g', source_asset_id: asset.json.asset.id, critical: true, confirmed: true }],
  });
  assert.equal(confirmed.status, 201);
  const hash = confirmed.json.truth_version.content_hash;
  await first.close();

  const second = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS });
  t.after(() => second.close());
  const { port: secondPort } = await second.listen();
  const detail = await request(secondPort, `/api/projects/${project.id}`, { headers: as() });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.assets.length, 1);
  assert.equal(detail.json.truth_head.content_hash, hash);
  assert.equal(detail.json.readiness.can_start_production, true);
  const content = await request(secondPort, detail.json.assets[0].content_url, { headers: as() });
  assert.deepEqual(content.body, pngBuffer(1200, 1200, 1024));
});

// ---------- 13. 前端接线契约 ----------
test('M03 前端接线：真实数据脚本引用的元素存在、白名单同步、占位文案已替换', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const realData = await readFile(new URL('../frontend/real-data.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  const requiredIds = [
    'real-list', 'project-dialog', 'project-dialog-title', 'project-form', 'project-error', 'project-submit',
    'upload-dialog', 'upload-form', 'upload-project', 'upload-role', 'upload-file', 'upload-error',
    'upload-result', 'upload-replace', 'upload-submit', 'truth-dialog', 'truth-title', 'truth-body',
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html 缺少 #${id}`);
    assert.match(realData, new RegExp(`'#${id}'`), `real-data.js 未引用 #${id}`);
  }
  for (const name of ['api.js', 'real-data.js', 'm03.css']) assert.ok(STATIC_FILES.includes(name), `白名单缺少 ${name}`);
  assert.match(html, /href="m03\.css"/);
  assert.match(html, /REAL DATA · 服务端持久化/);
  assert.match(html, /M02 演示数据/);
  assert.match(app, /initRealData\(\{ toast \}\)/);
  assert.doesNotMatch(app, /M03 接入文件校验/);
  assert.doesNotMatch(app, /M03 接入版本与来源记录/);
  assert.doesNotMatch(app, /M03 接入商品事实与平台目标/);
  assert.match(realData, /onConflict/);
  assert.match(realData, /confirm/);
  const apiClient = await readFile(new URL('../frontend/api.js', import.meta.url), 'utf8');
  assert.match(apiClient, /on_conflict/);
  assert.match(apiClient, /x-actor-id/);
});

// ---------- 14. 闸口函数与接口一致 ----------
test('M03 readiness 纯函数与接口结论一致', () => {
  const project = { id: 'prj_x', sku: 'MC-50', category: '面霜' };
  const noAssets = computeReadiness(project, [], null);
  assert.equal(noAssets.can_start_production, false);
  assert.deepEqual(noAssets.blockers.map(item => item.code), ['NO_ASSETS', 'NO_TRUTH_VERSION']);

  const conflictAssets = [
    { id: 'a1', role: 'subject', role_status: 'active', width: 1200, height: 1200, filename: 'a1.png' },
    { id: 'a2', role: 'subject', role_status: 'active', width: 1200, height: 1200, filename: 'a2.png' },
  ];
  const conflict = computeReadiness(project, conflictAssets, null);
  assert.ok(conflict.blockers.some(item => item.code === 'REFERENCE_CONFLICT'));

  const okAsset = [{ id: 'a1', role: 'subject', role_status: 'active', width: 1200, height: 1200, filename: 'a1.png' }];
  const truth = {
    version: 1, sku: 'MC-50', category: '面霜', confirmation_status: 'confirmed',
    facts: [{ key: '容量', value: '50g', critical: true, confirmed: true, source_asset_id: 'a1' }],
  };
  assert.equal(computeReadiness(project, okAsset, truth).can_start_production, true);
});
