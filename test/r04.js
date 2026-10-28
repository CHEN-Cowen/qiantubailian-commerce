import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  OCR_THRESHOLD, checkCriticalText, createOcrFromEnv, extractionCandidates,
} from '../src/ocr.mjs';
import {
  EXECUTION_VERSION, buildOverlaySvg, compileExecutionPlan, compileRevisionInstruction,
} from '../src/execution.mjs';

const TENANT_A = 'tenant_a';
const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

function subjectPng(width = 900, height = 900) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const inside = x >= width * 0.3 && x < width * 0.7 && y >= height * 0.25 && y < height * 0.75;
      pixels[index] = inside ? 198 : 246;
      pixels[index + 1] = inside ? 36 : 246;
      pixels[index + 2] = inside ? 44 : 246;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

/** 只含 SOF0 的最小 JPEG：足以通过签名与尺寸检查，用于"卖家常见 JPEG 输入"的契约验证。 */
function headerOnlyJpeg(width, height) {
  const buffer = Buffer.alloc(23);
  buffer[0] = 0xFF; buffer[1] = 0xD8;
  buffer[2] = 0xFF; buffer[3] = 0xC0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[11] = 3;
  buffer[12] = 1; buffer[13] = 0x11; buffer[14] = 0;
  buffer[15] = 2; buffer[16] = 0x11; buffer[17] = 1;
  buffer[18] = 3; buffer[19] = 0x11; buffer[20] = 1;
  buffer[21] = 0xFF; buffer[22] = 0xD9;
  return buffer;
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'r04-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 240, tickMs: 8, attemptTimeoutMs: 30_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

const as = (tenant = TENANT_A, actor = 'tester_r04') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });

/** 生成是异步的：等到供应商真的收到请求再断言，避免把"还没轮到"当成"没下发"。 */
async function waitSubmitted(provider, { minCount = 1, timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (provider.submitted.length >= minCount) return provider.submitted[provider.submitted.length - 1];
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`等待供应商请求超时（已有 ${provider.submitted.length} 条，期望 ${minCount} 条）`);
}

/** 等某个任务的全部交付物提交完（数量稳定），并按 run_id 取回该任务的请求。 */
async function waitRunSubmitted(provider, runId, timeoutMs = 15_000) {
  const started = Date.now();
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const matched = provider.submitted.filter(item => String(item.idempotency_key).startsWith(`sub:${runId}:`));
    if (matched.length > 0 && matched.length === stable) return matched;
    stable = matched.length;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`等待任务 ${runId} 的供应商请求超时`);
}

async function createProject(port, overrides = {}) {
  const response = await request(port, '/api/projects', {
    method: 'POST', headers: as(),
    body: { name: 'R04 精油', sku: `SKU-${Math.random()}`, category: '精油', platform: '天猫', ...overrides },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.project;
}

async function uploadAsset(port, projectId, { role = 'subject', body = subjectPng(), filename = 'shot.png', contentType = 'image/png' } = {}) {
  const response = await request(port, `/api/projects/${projectId}/assets?role=${role}&filename=${filename}`, {
    method: 'POST', headers: { ...as(), 'Content-Type': contentType }, body,
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.asset;
}

async function confirmTruth(port, projectId, { sourceAssetId, criticalText = ['静语薰衣草'] } = {}) {
  const response = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: 0, confirm: true,
      facts: [
        {
          key: '容量', value: '10ml', critical: true, confirmed: true,
          source_type: 'asset', source_asset_id: sourceAssetId,
        },
        { key: '香气', value: '薰衣草', critical: false, confirmed: true, source_type: 'user_input' },
        { key: '产地', value: '新疆', critical: false, confirmed: false, source_type: 'user_input' },
      ],
      critical_text: criticalText.map(text => ({ text })),
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.truth_version;
}

async function freezeSpec(port, projectId, { templateId = 'tpl_listing_pack', platform = '天猫', baseVersion = 0 } = {}) {
  const preview = await request(port, `/api/projects/${projectId}/specs/preview`, {
    method: 'POST', headers: as(), body: { template_id: templateId, platform },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${projectId}/specs`, {
    method: 'POST', headers: as(),
    body: { template_id: templateId, platform, conflict_resolutions: resolutions, base_version: baseVersion },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  return frozen.json.spec;
}

async function createBrandKit(port, projectId) {
  const created = await request(port, '/api/brand-kits', {
    method: 'POST', headers: as(),
    body: {
      name: '静语品牌',
      palette: { primary: '#5A6B4A', secondary: ['#EDE7DA'] },
      fonts: [{ name: '方正兰亭黑', role: 'heading', license: 'licensed' }],
      logo: { present: false },
      banned_expressions: ['最好', '第一', '治疗'],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.brand_kit;
}

/** 记录每个请求的完整内容，用于断言"配置是否真的进入了供应商请求"。 */
function recordingProvider(inner = null) {
  const submitted = [];
  return {
    submitted,
    capabilities: () => ({
      id: 'r04-recorder', version: 'rec.1', image: true, video: false,
      max_references: 3, supports_mask: true, supports_async: true, supports_cancel: true,
      supports_seed: true, supports_revision: false, max_side: 2048, formats: ['jpg', 'png'],
      simulated: true, acceptance: 'simulated_only',
    }),
    validate: request => inner?.validate?.(request) ?? { ok: true },
    submit(request) {
      submitted.push(JSON.parse(JSON.stringify(request)));
      if (inner) return inner.submit(request);
      return { provider_job_id: `rec_${submitted.length}`, status: 'queued', request_hash: request.request_hash };
    },
    poll: handle => inner?.poll
      ? inner.poll(handle)
      : { status: 'queued' },
    cancel: () => ({ status: 'cancelled' }),
  };
}

// ---------- 1. 执行指令编译 ----------
test('R04 编译：事实、品牌、构图、平台与文字层都进入执行指令，未确认事实不出现', () => {
  const spec = {
    version: 2,
    content_hash: 'spec-hash',
    product_truth: { version: 3, content_hash: 'truth-hash' },
    channel: { platform: '天猫', version: 'rule-1', coverage: 'partial', can_claim_platform_compliance: false },
    brand_kit: { id: 'bk_1', version: 1, content_hash: 'bk-hash' },
    creative_direction: { background: '暖白渐变', lighting: '柔和侧光', whitespace: '下方留白 25%', camera: '45 度俯拍' },
    template: { forbidden_changes: ['不得改变包装文字', '不得改变 Logo'] },
    deliverables: [
      {
        id: 'main', label: '主图', type: 'main_image', width: 800, height: 800, ratio: '1:1',
        formats: ['png'], text_blocks: [], logo_allowed: true,
      },
      {
        id: 'scene_1', label: '场景图 1', type: 'scene_image', width: 800, height: 800, ratio: '1:1',
        formats: ['jpg'], text_blocks: ['fact:容量', 'critical_text'], logo_allowed: false,
      },
      {
        id: 'scene_2', label: '场景图 2', type: 'scene_image', width: 800, height: 800, ratio: '1:1',
        formats: ['jpg'], text_blocks: ['fact:产地'], logo_allowed: false,
      },
    ],
  };
  const truth = {
    version: 3,
    content_hash: 'truth-hash',
    facts: [
      { key: '容量', value: '10ml', critical: true, confirmed: true },
      { key: '香气', value: '薰衣草', critical: false, confirmed: true },
      { key: '产地', value: '新疆', critical: false, confirmed: false },
    ],
    critical_text: [{ text: '静语薰衣草' }],
  };
  const brandKitVersion = {
    brand_kit_id: 'bk_1', version: 1, content_hash: 'bk-hash',
    palette: { primary: '#5A6B4A', secondary: ['#EDE7DA'] },
    fonts: [{ name: '方正兰亭黑', role: 'heading', license: 'licensed' }],
    logo: { present: false },
    banned_expressions: ['最好', '第一'],
  };
  const plan = compileExecutionPlan({ project: { name: '静语精油', category: '精油', sku: 'JY-10' }, spec, truth, brandKitVersion });

  assert.equal(plan.version, EXECUTION_VERSION);
  assert.equal(plan.deliverables.length, 3);
  const scene = plan.deliverables[1];
  assert.match(scene.prompt, /暖白渐变/, '背景配置必须进入指令');
  assert.match(scene.prompt, /柔和侧光/, '光线配置必须进入指令');
  assert.match(scene.prompt, /下方留白 25%/, '构图配置必须进入指令');
  assert.match(scene.prompt, /45 度俯拍/, '机位配置必须进入指令');
  assert.match(scene.prompt, /天猫/, '平台必须进入指令');
  assert.match(scene.prompt, /10ml/, '已确认事实必须进入指令');
  assert.match(scene.prompt, /静语薰衣草/, '包装关键文字必须进入指令');
  assert.match(scene.prompt, /#5A6B4A/, '品牌主色必须进入指令');
  assert.match(scene.prompt, /最好/, '禁用表达必须进入指令');
  assert.match(scene.prompt, /不得改变包装文字/, '模板不可改变项必须进入指令');
  assert.doesNotMatch(scene.prompt, /新疆/, '未确认事实不得进入指令');
  assert.match(scene.prompt, /不要在图像中绘制或改写任何文字/, '文字层策略必须进入指令');

  const texts = scene.text_layers.map(layer => layer.text);
  assert.ok(texts.includes('10ml'), '事实文字层必须存在');
  assert.ok(texts.includes('静语薰衣草'), '关键文字层必须存在');
  assert.ok(scene.text_layers.every(layer => layer.color), '文字层必须带颜色');
  assert.ok(scene.text_layers.every(layer => layer.bounding_box), '文字层必须带位置');
  assert.deepEqual(scene.missing_text, [], '两条文字块都应可解析');

  const third = plan.deliverables[2];
  assert.deepEqual(third.missing_text.map(item => item.reason), ['FACT_NOT_CONFIRMED'], '未确认事实必须显式报缺失');
  assert.match(third.prompt, /FACT_NOT_CONFIRMED/, '缺失信息必须写进指令，禁止补写');
  assert.equal(plan.text_policy.render_text_by_provider, false);

  // 同一输入必须编译出同一结果，配置变化必须改变哈希
  const again = compileExecutionPlan({ project: { name: '静语精油', category: '精油', sku: 'JY-10' }, spec, truth, brandKitVersion });
  assert.equal(again.content_hash, plan.content_hash);
  const changed = compileExecutionPlan({
    project: { name: '静语精油', category: '精油', sku: 'JY-10' },
    spec: { ...spec, creative_direction: { ...spec.creative_direction, lighting: '硬光直射' } },
    truth, brandKitVersion,
  });
  assert.notEqual(changed.content_hash, plan.content_hash, '配置变化必须改变执行计划哈希');
  assert.match(changed.deliverables[1].prompt, /硬光直射/);
});

test('R04 修订指令：只修具体项，并明确保留已通过项', () => {
  const instruction = compileRevisionInstruction({
    actions: [{ code: 'DIMENSION_MISMATCH', label: '尺寸不符', instruction: '按 800×800 输出' }],
    preserveChecks: [{ code: 'SUBJECT_INTEGRITY' }, 'BRAND_RULES'],
    round: 1,
  });
  assert.match(instruction.text, /DIMENSION_MISMATCH/);
  assert.match(instruction.text, /800×800/);
  assert.match(instruction.text, /SUBJECT_INTEGRITY/);
  assert.match(instruction.text, /BRAND_RULES/);
  assert.match(instruction.text, /不得回退/);
  assert.equal(instruction.hash.length, 64);
  const other = compileRevisionInstruction({
    actions: [{ code: 'DIMENSION_MISMATCH' }],
    preserveChecks: ['BRAND_RULES'],
    round: 1,
  });
  assert.notEqual(other.hash, instruction.hash, '保留项不同必须产生不同指令');
});

// ---------- 2. OCR 适配与文字核对 ----------
test('R04 OCR：未配置时保持 unknown；配置后按阈值标证据缺口，关键文字不符即硬失败', async () => {
  const notConfigured = createOcrFromEnv({});
  assert.equal(notConfigured.configured, false);
  const unknown = await notConfigured.recognize({ bytes: Buffer.from('x'), mime: 'image/png' });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'OCR_NOT_CONFIGURED');

  const configured = createOcrFromEnv({
    QTB_OCR_ENDPOINT: 'https://ocr.invalid/v1/recognize',
    QTB_OCR_API_KEY: 'test-key',
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.acceptance, 'contract_only', '不能自称已通过真实准确率验收');

  // 端点不可达时必须报 error，不能返回空数组冒充"图中无文字"
  const failed = await configured.recognize({ bytes: Buffer.from('x'), mime: 'image/png' });
  assert.ok(['error', 'unknown'].includes(failed.status), `不可达时应报错，实际 ${failed.status}`);

  const candidates = extractionCandidates({
    assetId: 'asset_1',
    lines: [
      { text: '容量：10ml', confidence: 0.95 },
      { text: '薰衣草精油', confidence: 0.52 },
      { text: '静语', confidence: null },
    ],
  });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(item => item.confirmed === false), '候选事实一律不得自动确认');
  assert.equal(candidates[0].needs_evidence, false);
  assert.equal(candidates[1].needs_evidence, true);
  assert.ok(candidates[1].confidence < OCR_THRESHOLD);
  assert.match(candidates[1].note, /低于/);
  assert.equal(candidates[2].needs_evidence, true, '无置信度必须要求补证据');
  assert.equal(candidates[0].source_asset_id, 'asset_1');

  // 关键文字核对：OCR 不可用时 unknown，检出时 pass，缺字时 fail
  const criticalTexts = [{ text: '静语薰衣草' }];
  assert.equal(checkCriticalText({ criticalTexts, ocr: null }).status, 'unknown');
  assert.equal(checkCriticalText({ criticalTexts, ocr: { status: 'error', reason: 'TIMEOUT' } }).status, 'unknown');
  const pass = checkCriticalText({
    criticalTexts,
    ocr: { status: 'ok', lines: [{ text: '静 语 薰 衣 草', confidence: 0.9 }], engine: 'fixture' },
  });
  assert.equal(pass.status, 'pass', 'OCR 行内空格不应被当成错字');
  const fail = checkCriticalText({
    criticalTexts,
    ocr: { status: 'ok', lines: [{ text: '静语玫瑰', confidence: 0.9 }] },
  });
  assert.equal(fail.status, 'fail');
  assert.deepEqual(fail.mismatched, ['静语薰衣草']);
});

// ---------- 3. 文字层导出 ----------
test('R04 文字层：导出的 SVG 可编辑，文字与位置来自执行计划', () => {
  const bytes = subjectPng(400, 400);
  const svg = buildOverlaySvg({
    width: 400, height: 400, mime: 'image/png', bytes,
    layers: [
      { id: 'layer_1', source: 'fact', fact_key: '容量', text: '10ml', x: 0.1, y: 0.2, width: 0.4, size_ratio: 0.08, weight: 700, color: '#5A6B4A', align: 'left', font_family: '方正兰亭黑' },
      { id: 'layer_2', source: 'brand_logo', logo: true, data_uri: `data:image/png;base64,${bytes.toString('base64')}`, text: '', x: 0.1, y: 0.9, size_ratio: 0.05, color: '#2A2420', align: 'left' },
    ],
    title: '主图',
  });
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /data:image\/png;base64,/);
  assert.match(svg, /data-fact="容量"/);
  assert.match(svg, />10ml</);
  assert.match(svg, /font-family="方正兰亭黑"/);
  assert.match(svg, /data-source="brand_logo"/);
  // 转义：文字里出现尖括号不能破坏 SVG 结构
  const escaped = buildOverlaySvg({
    width: 10, height: 10, mime: 'image/png', bytes: Buffer.from('x'),
    layers: [{ id: 'l', source: 'fact', text: 'a<b&c', x: 0, y: 0, width: 1, size_ratio: 0.1, color: '#000', align: 'left' }],
  });
  assert.match(escaped, /a&lt;b&amp;c/);
  assert.doesNotMatch(escaped, /a<b&c/);
});

// ---------- 4. HTTP：配置进入请求、格式处理、掩码预览、事实提取 ----------
test('R04 端到端（模拟）：配置变化改变供应商请求，JPEG 需矩形掩码，OCR 未配置时如实说明', async t => {
  const provider = recordingProvider();
  const { port } = await start(t, { provider });
  const project = await createProject(port);
  const asset = await uploadAsset(port, project.id);
  await createBrandKit(port, project.id);
  await confirmTruth(port, project.id, { sourceAssetId: asset.id });
  const spec = await freezeSpec(port, project.id);
  assert.equal(spec.brand_kit !== undefined, true, 'spec 应记录品牌引用');

  // 掩码预览：PNG 可自动推导
  const preview = await request(port, `/api/projects/${project.id}/assets/${asset.id}/mask-preview`, { headers: as() });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.headers['x-mask-method'], 'border_color_keying');
  assert.equal(preview.headers['x-mask-has-cutout'], 'true');
  assert.ok(preview.body.length > 0);

  // JPEG 输入：有矩形即可出掩码，但没有去背图，必须如实说明
  const jpegProject = await createProject(port);
  const jpegAsset = await uploadAsset(port, jpegProject.id, {
    body: headerOnlyJpeg(1200, 1200), filename: 'shot.jpg', contentType: 'image/jpeg',
  });
  assert.equal(jpegAsset.mime, 'image/jpeg');
  const noBox = await request(port, `/api/projects/${jpegProject.id}/assets/${jpegAsset.id}/mask-preview`, { headers: as() });
  assert.equal(noBox.status, 422, JSON.stringify(noBox.json));
  assert.equal(noBox.json.error, 'MASK_SOURCE_UNSUPPORTED_FORMAT');
  const badBox = await request(port, `/api/projects/${jpegProject.id}/assets/${jpegAsset.id}/subject-box`, {
    method: 'PUT', headers: as(), body: { x: 0.2, y: 0.2, width: 1.4, height: 0.4 },
  });
  assert.equal(badBox.status, 422);
  assert.equal(badBox.json.error, 'INVALID_SUBJECT_BOX');
  const boxSaved = await request(port, `/api/projects/${jpegProject.id}/assets/${jpegAsset.id}/subject-box`, {
    method: 'PUT', headers: as(), body: { x: 0.25, y: 0.2, width: 0.5, height: 0.6 },
  });
  assert.equal(boxSaved.status, 200, JSON.stringify(boxSaved.json));
  assert.equal(boxSaved.json.asset.subject_box.width, 0.5);
  const boxed = await request(port, `/api/projects/${jpegProject.id}/assets/${jpegAsset.id}/mask-preview`, { headers: as() });
  assert.equal(boxed.status, 200, JSON.stringify(boxed.json));
  assert.equal(boxed.headers['x-mask-method'], 'manual_box');
  assert.equal(boxed.headers['x-mask-has-cutout'], 'false', '矩形掩码没有去背图，不能声称可本地合成');

  // 事实提取：服务端未配置 OCR 时必须如实说明，且不给任何候选
  const extraction = await request(port, `/api/projects/${project.id}/assets/${asset.id}/fact-extraction`, {
    method: 'POST', headers: as(), body: {},
  });
  assert.equal(extraction.status, 200, JSON.stringify(extraction.json));
  assert.equal(extraction.json.configured, false);
  assert.deepEqual(extraction.json.candidates, [], '未配置 OCR 不得返回任何样例候选');

  // 风格图不能作为事实来源
  const styleAsset = await uploadAsset(port, project.id, { role: 'style' });
  const styleExtraction = await request(port, `/api/projects/${project.id}/assets/${styleAsset.id}/fact-extraction`, {
    method: 'POST', headers: as(), body: {},
  });
  assert.equal(styleExtraction.status, 422);
  assert.equal(styleExtraction.json.error, 'STYLE_NOT_FACT_SOURCE');

  // 生成：请求里必须能看到执行指令、尺寸、格式与参考图
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers: as(), body: { project_id: project.id, brand_kit_id: spec.brand_kit?.id },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const run = await request(port, '/api/runs', {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'r04-run' },
    body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  const first = await waitSubmitted(provider);
  assert.ok(first.execution, '供应商请求必须带执行指令');
  assert.equal(first.execution.content_hash, run.json.run.execution.content_hash);
  assert.match(first.execution.instruction.prompt, /10ml/, '已确认事实必须出现在供应商请求里');
  assert.match(first.execution.instruction.prompt, /静语薰衣草/, '包装关键文字必须出现在供应商请求里');
  assert.equal(first.execution.text_policy.render_text_by_provider, false);
  assert.ok(first.target_width > 0 && first.target_height > 0, '尺寸必须进入请求');
  assert.ok(first.formats.length > 0, '格式必须进入请求');
  assert.equal(first.request_hash.length, 64);
});

test('R04 请求哈希：风格或事实变化会产生不同的供应商请求', async t => {
  const provider = recordingProvider();
  // 放开并发上限：本用例要让两个任务的全部交付物都真实提交，才能比较请求内容
  const { port } = await start(t, { provider, providerMaxConcurrency: 40, tenantMaxConcurrency: 40 });
  const project = await createProject(port);
  const asset = await uploadAsset(port, project.id);
  await confirmTruth(port, project.id, { sourceAssetId: asset.id });
  await freezeSpec(port, project.id);
  const quoteA = await request(port, '/api/quotes', { method: 'POST', headers: as(), body: { project_id: project.id } });
  const runA = await request(port, '/api/runs', {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'r04-a' },
    body: { project_id: project.id, quote_id: quoteA.json.quote.quote_id },
  });
  assert.equal(runA.status, 201, JSON.stringify(runA.json));
  const requestsA = await waitRunSubmitted(provider, runA.json.run.id);
  const planHashA = requestsA[0].execution.content_hash;
  assert.ok(
    requestsA.every(item => item.execution.content_hash === planHashA),
    '同一任务下的所有交付物必须来自同一份执行计划',
  );
  assert.equal(
    new Set(requestsA.map(item => item.request_hash)).size,
    requestsA.length,
    '不同交付物的请求哈希必须不同（否则等于把同一张图重复提交）',
  );

  // 修改事实（新增一条已确认事实）→ spec 内容哈希变化 → 新报价 → 新请求哈希
  const truth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: 1, confirm: true,
      facts: [
        { key: '容量', value: '10ml', critical: true, confirmed: true, source_type: 'asset', source_asset_id: asset.id },
        { key: '香气', value: '薰衣草', critical: false, confirmed: true, source_type: 'user_input' },
        { key: '产地', value: '新疆', critical: false, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '静语薰衣草' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  await freezeSpec(port, project.id, { baseVersion: 1 });
  const quoteB = await request(port, '/api/quotes', { method: 'POST', headers: as(), body: { project_id: project.id } });
  const runB = await request(port, '/api/runs', {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'r04-b' },
    body: { project_id: project.id, quote_id: quoteB.json.quote.quote_id },
  });
  assert.equal(runB.status, 201, JSON.stringify(runB.json));
  const requestsB = await waitRunSubmitted(provider, runB.json.run.id);
  const planHashB = requestsB[0].execution.content_hash;
  assert.notEqual(planHashA, planHashB, '事实变化必须产生不同的执行计划哈希');
  assert.match(requestsB[0].execution.instruction.prompt, /新疆/, '新确认的事实必须进入新请求');
});

test('R04 OCR 已配置：候选进入事实前必须人工确认，未确认项不能直接用于生成', async t => {
  const ocr = {
    configured: true,
    mode: 'fixture',
    acceptance: 'contract_only',
    note: '测试用 OCR 适配器',
    async recognize() {
      return {
        status: 'ok',
        engine: 'fixture',
        lines: [
          { text: '容量 10ml', confidence: 0.96 },
          { text: '薰衣草精油', confidence: 0.41 },
        ],
      };
    },
  };
  const provider = recordingProvider();
  const { port } = await start(t, { provider, ocr });
  const project = await createProject(port);
  const asset = await uploadAsset(port, project.id);
  const extraction = await request(port, `/api/projects/${project.id}/assets/${asset.id}/fact-extraction`, {
    method: 'POST', headers: as(), body: {},
  });
  assert.equal(extraction.status, 200, JSON.stringify(extraction.json));
  assert.equal(extraction.json.configured, true);
  assert.equal(extraction.json.acceptance, 'contract_only');
  assert.match(extraction.json.note, /授权样本/);
  assert.equal(extraction.json.candidates.length, 2);
  assert.ok(extraction.json.candidates.every(item => item.confirmed === false));
  const low = extraction.json.candidates.find(item => item.value === '薰衣草精油');
  assert.equal(low.needs_evidence, true);

  // 用候选值直接建事实也必须显式确认；未确认时不得进入生成请求
  const truth = await request(port, `/api/projects/${project.id}/truth-versions`, {
    method: 'POST', headers: as(),
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '10ml', critical: true, confirmed: true, source_type: 'asset', source_asset_id: asset.id },
        { key: '香气', value: '薰衣草精油', critical: false, confirmed: false, source_type: 'asset', source_asset_id: asset.id, confidence: 0.41 },
      ],
      critical_text: [{ text: '静语薰衣草' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  await freezeSpec(port, project.id);
  const quote = await request(port, '/api/quotes', { method: 'POST', headers: as(), body: { project_id: project.id } });
  const run = await request(port, '/api/runs', {
    method: 'POST', headers: { ...as(), 'Idempotency-Key': 'r04-ocr' },
    body: { project_id: project.id, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  const prompt = (await waitSubmitted(provider)).execution.instruction.prompt;
  assert.match(prompt, /10ml/);
  assert.doesNotMatch(prompt, /薰衣草精油/, '未确认的候选事实不得进入供应商请求');
});

test('R04 掩码预览与矩形：跨租户不可访问，且不得改写原始素材', async t => {
  const { port } = await start(t);
  const project = await createProject(port);
  const asset = await uploadAsset(port, project.id);
  const before = await request(port, `/api/projects/${project.id}/assets/${asset.id}/content`, { headers: as() });
  assert.equal(before.status, 200);

  const crossTenant = await request(port, `/api/projects/${project.id}/assets/${asset.id}/mask-preview`, {
    headers: as('tenant_b', 'tester_b'),
  });
  assert.equal(crossTenant.status, 404, '跨租户必须按不存在处理');

  const boxed = await request(port, `/api/projects/${project.id}/assets/${asset.id}/subject-box`, {
    method: 'PUT', headers: as(), body: { x: 0.3, y: 0.25, width: 0.4, height: 0.5 },
  });
  assert.equal(boxed.status, 200, JSON.stringify(boxed.json));
  const after = await request(port, `/api/projects/${project.id}/assets/${asset.id}/content`, { headers: as() });
  assert.equal(after.status, 200);
  assert.equal(
    createHash('sha256').update(after.body).digest('hex'),
    createHash('sha256').update(before.body).digest('hex'),
    '调整商品矩形不得改写原始素材像素',
  );
  assert.equal(after.headers['content-type'], 'image/png');
});