/**
 * M-V2 视觉策略转换：方向 → 视觉参数 → 执行指令。
 *
 * 关键约束（也是本文件最重要的断言）：
 * 旧快照没有 atmosphere/color 时，编译出的指令与 content_hash 必须与加字段之前完全一致。
 * 否则已落盘的执行依据会集体漂移，run 记录里的 execution_hash 对不上。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BACKGROUNDS, COLOR_BRIGHTNESS, COLOR_SATURATION, COLOR_TONES, PERCEPTION_KEYS,
  resolveVisualStrategy, validateVisualStrategy,
} from '../src/perception.mjs';
import { compileExecutionPlan } from '../src/execution.mjs';
import { createApp } from '../src/server.mjs';

const TENANTS = ['tenant_a', 'tenant_b', 'tenant_demo'];
const as = (tenant = 'tenant_a') => ({ 'x-tenant-id': tenant, 'x-actor-id': 'tester' });

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: {
        ...(payload ? { 'Content-Length': payload.length, 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function start(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mv2-'));
  const app = createApp({ port: 0, storeDir: dir, allowedTenants: TENANTS });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用，不影响结论 */ }
  });
  const { port } = await app.listen();
  return port;
}

const baseSpec = () => ({
  version: 1,
  content_hash: 'spec-hash',
  template: { id: 'tpl_test', name: '测试模板', forbidden_changes: [] },
  channel: { platform: '天猫', version: 1, coverage: 'covered', can_claim_platform_compliance: false },
  creative_direction: {
    background: 'scene', lighting: 'soft daylight', whitespace: '右侧留白 30%', camera: 'eye level',
  },
  deliverables: [{
    id: 'main', label: '主图', type: 'main_image', width: 800, height: 800,
    ratio: '1:1', formats: ['png'], background: 'scene', text_blocks: [],
  }],
  budget: {},
  provenance: {},
  gaps: {},
});

const plan = spec => compileExecutionPlan({
  project: { name: '测试商品', category: '香氛', sku: null },
  spec,
  truth: { version: 1, content_hash: 'truth-hash', facts: [], critical_text: [] },
});

test('七个方向都能解析出完整且合规的视觉策略', () => {
  for (const key of PERCEPTION_KEYS) {
    const resolved = resolveVisualStrategy(key);
    assert.ok(resolved, `${key} 缺少视觉策略`);
    assert.equal(resolved.perception, key);
    const direction = resolved.creative_direction;
    assert.ok(BACKGROUNDS.includes(direction.background), `${key} 的背景不在既有枚举内`);
    for (const field of ['lighting', 'whitespace', 'camera', 'atmosphere']) {
      assert.equal(typeof direction[field], 'string');
      assert.ok(direction[field].length > 0, `${key} 的 ${field} 为空`);
    }
    assert.ok(COLOR_SATURATION.includes(direction.color.saturation));
    assert.ok(COLOR_BRIGHTNESS.includes(direction.color.brightness));
    assert.ok(COLOR_TONES.includes(direction.color.tone));
    // 不含文字排版：交付结构由 text_blocks 决定，这里再放一份就是两套真源。
    assert.equal(Object.hasOwn(direction, 'text_layout'), false);
  }
});

test('未知方向返回 null，不猜默认值', () => {
  assert.equal(resolveVisualStrategy('not_a_goal'), null);
  assert.equal(resolveVisualStrategy(''), null);
  assert.equal(resolveVisualStrategy(null), null);
});

test('策略是深拷贝，改返回值不影响真源', () => {
  const first = resolveVisualStrategy('quality_premium');
  first.creative_direction.color.tone = 'deep';
  first.creative_direction.background = 'plain_white';
  assert.equal(resolveVisualStrategy('quality_premium').creative_direction.color.tone, 'warm_neutral');
  assert.equal(resolveVisualStrategy('quality_premium').creative_direction.background, 'gradient_studio');
});

test('外部回传的视觉策略遇到非法值要明确拒绝', () => {
  assert.deepEqual(validateVisualStrategy({ background: 'scene' }), []);
  assert.deepEqual(validateVisualStrategy({}), []);
  assert.equal(validateVisualStrategy({ background: 'neon_void' }).length, 1);
  assert.equal(validateVisualStrategy({ color: { saturation: 'ultra', brightness: 'high', tone: 'warm' } }).length, 1);
  assert.equal(validateVisualStrategy({ color: 'warm' }).length, 1);
  assert.equal(validateVisualStrategy({ lighting: 123 }).length, 1);
  assert.throws(() => validateVisualStrategy(null), TypeError);
});

test('旧快照编译结果不因新增字段而改变（键与哈希都一致）', () => {
  const before = plan(baseSpec());
  const again = plan(baseSpec());
  assert.equal(before.content_hash, again.content_hash, '同配置必须同哈希');
  const deliverable = before.deliverables[0];
  assert.equal(Object.hasOwn(deliverable, 'atmosphere'), false, '未配置时不得凭空多出 atmosphere 键');
  assert.equal(Object.hasOwn(deliverable, 'color'), false, '未配置时不得凭空多出 color 键');
  assert.ok(!deliverable.prompt.includes('【氛围】'));
  assert.ok(!deliverable.prompt.includes('【色彩】'));
});

test('配置氛围与色彩后进入执行指令，文案为中文且不越界改商品', () => {
  const spec = baseSpec();
  const strategy = resolveVisualStrategy('quality_premium').creative_direction;
  spec.creative_direction = { ...spec.creative_direction, ...strategy };
  const result = plan(spec);
  const deliverable = result.deliverables[0];

  assert.equal(deliverable.atmosphere, '优雅、克制');
  assert.deepEqual(deliverable.color, { saturation: 'low', brightness: 'high', tone: 'warm_neutral' });
  assert.ok(deliverable.prompt.includes('【氛围】优雅、克制。'));
  assert.ok(deliverable.prompt.includes('【色彩】饱和度低、整体明亮、暖中性色调'));
  assert.ok(deliverable.prompt.includes('不得改变商品本体颜色'));
});

test('配置变化必须产生不同请求（R04 精神）', () => {
  const plain = plan(baseSpec());
  const spec = baseSpec();
  spec.creative_direction = { ...spec.creative_direction, ...resolveVisualStrategy('natural_comfort').creative_direction };
  const styled = plan(spec);
  assert.notEqual(plain.content_hash, styled.content_hash);
  assert.notEqual(plain.deliverables[0].prompt, styled.deliverables[0].prompt);
});

test('纯白背景不追加色彩指令，避免与「纯白无缝背景」自相矛盾', () => {
  const spec = baseSpec();
  spec.deliverables[0].background = 'plain_white';
  spec.creative_direction = {
    ...spec.creative_direction,
    background: 'plain_white',
    atmosphere: '干净、严谨',
    color: { saturation: 'low', brightness: 'high', tone: 'neutral' },
  };
  const deliverable = plan(spec).deliverables[0];
  assert.ok(deliverable.prompt.includes('【氛围】干净、严谨。'));
  assert.ok(!deliverable.prompt.includes('【色彩】'));
});

test('色彩枚举翻成中文，未识别的值不进指令也不报错', () => {
  const spec = baseSpec();
  spec.creative_direction = {
    ...spec.creative_direction,
    color: { saturation: 'unknown_value', brightness: 'medium', tone: 'deep' },
  };
  const deliverable = plan(spec).deliverables[0];
  assert.ok(!deliverable.prompt.includes('unknown_value'));
  assert.ok(deliverable.prompt.includes('整体适中'));
  assert.ok(deliverable.prompt.includes('深沉色调'));
});

test('POST /api/perceptions/recommend 返回方向卡与背景映射', async t => {
  const port = await start(t);
  const response = await request(port, '/api/perceptions/recommend', {
    method: 'POST', headers: as(),
    body: { category: '香氛', selling_points: '天然植物精油，无添加', purpose: 'brand', limit: 3 },
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.version, 'perception.1');
  assert.equal(response.json.cards.length, 3);
  for (const card of response.json.cards) {
    assert.equal(card.source === 'recommended' || card.source === 'fallback', true);
    assert.ok(BACKGROUNDS.includes(card.strategy.background), `${card.key} 的背景不在枚举内`);
    assert.equal(typeof card.strategy.atmosphere, 'string');
  }
  assert.ok(response.json.rule_note.includes('未分析商品图片'));
  assert.equal(response.json.cards[0].key, 'natural_comfort');
});

test('推荐端点尊重 limit，非法 limit 与错误方法都明确拒绝', async t => {
  const port = await start(t);
  const two = await request(port, '/api/perceptions/recommend', {
    method: 'POST', headers: as(), body: { category: '家电', limit: 2 },
  });
  assert.equal(two.status, 200);
  assert.equal(two.json.cards.length, 2);

  for (const bad of [0, 8, 1.5, 'abc']) {
    const response = await request(port, '/api/perceptions/recommend', {
      method: 'POST', headers: as(), body: { category: '家电', limit: bad },
    });
    assert.equal(response.status, 422, `limit=${bad} 应被拒绝`);
    assert.equal(response.json.error, 'INVALID_LIMIT');
  }

  const wrongMethod = await request(port, '/api/perceptions/recommend', { headers: as() });
  assert.equal(wrongMethod.status, 405);
});

test('推荐端点幂等：连续两次调用结果完全一致', async t => {
  const port = await start(t);
  const payload = { method: 'POST', headers: as(), body: { category: '茶', selling_points: '非遗古法' } };
  const first = await request(port, '/api/perceptions/recommend', payload);
  const second = await request(port, '/api/perceptions/recommend', payload);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, second.json);
});

test('模板投影必须带 background，否则前端背景筛选会恒为空', async t => {
  const port = await start(t);
  const response = await request(port, '/api/catalog/templates', { headers: as() });
  assert.equal(response.status, 200);
  const templates = response.json.templates ?? [];
  assert.ok(templates.length > 0);
  for (const template of templates) {
    // 这条曾经缺失：listTemplates 精简投影漏掉背景，导致点任何背景 chip 都把可选方案清空。
    assert.ok(BACKGROUNDS.includes(template.background), `${template.id} 的 background 不在枚举内：${template.background}`);
  }
  // 四个背景都要有方案可筛，否则筛选后会出现空列表
  const covered = new Set(templates.map(item => item.background));
  for (const value of new Set(BACKGROUNDS)) {
    assert.ok(covered.has(value), `没有模板覆盖背景「${value}」，筛选后会是空列表`);
  }
});

// ---------- spec 冻结链路：perception 写入 creative_direction ----------

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

async function readyProject(port) {
  const created = await request(port, '/api/projects', {
    method: 'POST', headers: as(),
    body: { name: '月光舒缓面霜', sku: 'MC-50', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const project = created.json.project;
  const uploaded = await request(port, `/api/projects/${project.id}/assets?role=subject&filename=shot.png`, {
    method: 'POST', headers: { ...as(), 'Content-Type': 'image/png' }, body: pngBuffer(1200, 1200),
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  const confirmed = await request(port, `/api/projects/${project.id}/truth-versions`, {
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
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  return project;
}

const freeze = (port, projectId, body) =>
  request(port, `/api/projects/${projectId}/specs`, { method: 'POST', headers: as(), body });

const LISTING_RESOLUTIONS = {
  'CHANNEL_PLAIN_WHITE_REQUIRED:main': 'adopt_plain_white',
  'CHANNEL_BANS_LOGO:main': 'omit_logo_on_main',
};

test('冻结 spec 时 perception 把 atmosphere/color 写入 creative_direction，依据记入 provenance', async t => {
  const port = await start(t);
  const project = await readyProject(port);
  const response = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: LISTING_RESOLUTIONS,
    perception: 'natural_comfort',
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const spec = response.json.spec;
  const expected = resolveVisualStrategy('natural_comfort').creative_direction;
  // 氛围与色彩来自感知方向
  assert.equal(spec.creative_direction.atmosphere, expected.atmosphere);
  assert.deepEqual(spec.creative_direction.color, expected.color);
  // background 等其余字段仍由模板决定，感知方向不越权改写
  assert.equal(spec.creative_direction.background, 'scene');
  assert.equal(Object.hasOwn(spec.creative_direction, 'lighting'), true);
  // 依据可重放：provenance 记录方向 key 与感知模块版本
  assert.equal(spec.provenance.perception, 'natural_comfort');
  assert.equal(spec.provenance.perception_version, 'perception.1');
});

test('不带 perception 冻结的 spec 与旧行为逐字段一致（无 atmosphere/color/provenance 键）', async t => {
  const port = await start(t);
  const project = await readyProject(port);
  const response = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: LISTING_RESOLUTIONS,
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const spec = response.json.spec;
  assert.equal(Object.hasOwn(spec.creative_direction, 'atmosphere'), false);
  assert.equal(Object.hasOwn(spec.creative_direction, 'color'), false);
  assert.equal(Object.hasOwn(spec.provenance, 'perception'), false);
});

test('同一配置下带 perception 与不带的 spec 内容哈希不同', async t => {
  const port = await start(t);
  const project = await readyProject(port);
  const withPerception = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: LISTING_RESOLUTIONS, perception: 'natural_comfort',
  });
  assert.equal(withPerception.status, 201);
  // 第二版必须基于最新 head（首版冻结后 head 变为 v1）
  const base = withPerception.json.spec.version;
  const without = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: base,
    conflict_resolutions: LISTING_RESOLUTIONS,
  });
  assert.equal(without.status, 201);
  assert.notEqual(withPerception.json.spec.content_hash, without.json.spec.content_hash);
});

test('未知感知方向冻结时明确拒绝，不静默丢弃也不猜默认值', async t => {
  const port = await start(t);
  const project = await readyProject(port);
  for (const bad of ['not_a_goal', '', '   ', 123, null]) {
    const response = await freeze(port, project.id, {
      template_id: 'tpl_listing_pack', base_version: 0,
      conflict_resolutions: LISTING_RESOLUTIONS, perception: bad,
    });
    // null 与缺省同义：不传就是不用方向，允许；其余一律 422
    if (bad === null) continue;
    assert.equal(response.status, 422, `perception=${JSON.stringify(bad)} 应被拒绝`);
    assert.equal(response.json.error, 'INVALID_PERCEPTION');
  }
});

// ---------- M-V3 方案卡对比与冻结覆盖 ----------

test('推荐端点返回方向内方案卡：A/B 两案、A 案等于方向默认策略', async t => {
  const port = await start(t);
  const response = await request(port, '/api/perceptions/recommend', {
    method: 'POST', headers: as(),
    body: { category: '香氛', selling_points: '天然植物', limit: 3 },
  });
  assert.equal(response.status, 200);
  for (const card of response.json.cards) {
    assert.equal(card.schemes.length, 2, `${card.key} 应带 2 个方案`);
    const [a, b] = card.schemes;
    assert.equal(a.id, `${card.key}.a`);
    assert.equal(a.background, card.strategy.background, 'A 案背景应与方向策略一致');
    assert.ok(b.background !== a.background || b.lighting !== a.lighting || b.whitespace !== a.whitespace,
      `${card.key} B 案与 A 案没有真实差异`);
    assert.equal(typeof card.color_label, 'string');
    assert.ok(card.color_label.includes('饱和度') || card.color_label.includes('色调'), `色彩标签不可读：${card.color_label}`);
  }
});

test('冻结 spec 时方案把 lighting/whitespace 作为用户确认值覆盖模板默认', async t => {
  const port = await start(t);
  const project = await readyProject(port);
  const response = await freeze(port, project.id, {
    template_id: 'tpl_listing_pack', base_version: 0,
    conflict_resolutions: LISTING_RESOLUTIONS,
    perception: 'natural_comfort', scheme: 'natural_comfort.b',
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const spec = response.json.spec;
  const expected = resolveVisualStrategy('natural_comfort').creative_direction;
  assert.equal(spec.creative_direction.lighting, 'morning window light', '方案 B 的光线应覆盖模板与方向默认');
  assert.equal(spec.creative_direction.whitespace, '下方留白 25%');
  // 氛围/色彩仍来自方向；background 仍由模板决定
  assert.equal(spec.creative_direction.atmosphere, expected.atmosphere);
  assert.equal(spec.creative_direction.background, 'scene');
  assert.equal(spec.provenance.scheme, 'natural_comfort.b');
  assert.equal(spec.provenance.perception, 'natural_comfort');
});

test('方案校验：缺 perception、方向不匹配、未知 id 都明确拒绝', async t => {
  const port = await start(t);
  const project = await readyProject(port);
  // 只有控制组会冻结成功；成功后 head 前移，后续用例必须基于最新版本，否则先撞 409 版本冲突
  let baseVersion = 0;
  const cases = [
    [{ perception: 'natural_comfort', scheme: 'natural_comfort.b' }, null], // 控制组：合法
    [{ scheme: 'natural_comfort.b' }, 'INVALID_SCHEME'],
    [{ perception: 'natural_comfort', scheme: 'quality_premium.a' }, 'INVALID_SCHEME'],
    [{ perception: 'natural_comfort', scheme: 'natural_comfort.z' }, 'INVALID_SCHEME'],
    [{ perception: 'natural_comfort', scheme: 123 }, 'INVALID_SCHEME'],
  ];
  for (const [index, [partial, expectedError]] of cases.entries()) {
    const response = await freeze(port, project.id, {
      template_id: 'tpl_listing_pack', base_version: baseVersion,
      conflict_resolutions: LISTING_RESOLUTIONS, ...partial,
    });
    if (expectedError === null) {
      assert.equal(response.status, 201, `控制组应成功：${JSON.stringify(response.json)}`);
      baseVersion = response.json.spec.version;
    } else {
      assert.equal(response.status, 422, `用例 ${index} 应拒绝，实际 ${response.status}：${JSON.stringify(response.json)}`);
      assert.equal(response.json.error, expectedError);
    }
  }
});
