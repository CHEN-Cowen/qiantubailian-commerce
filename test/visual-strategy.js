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
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
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
