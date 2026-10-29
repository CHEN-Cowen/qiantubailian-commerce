/**
 * E05 测试：售前疑问补图助手（脱敏输入、归类建议、五类分流、频次来源、版本绑定）。
 *
 * 覆盖：
 * 1. 纯函数：个人信息检测与拒绝（不回显原文）、长度限制、频次对象校验与展示口径（绝不标「高频」）、
 *    关键词归类（非商品图问题优先）、五类分流（无 SKU / 缺依据 / 已有图 / 文字建议 / 补图提纲 / 越界）。
 * 2. 集成：物流问题 out_of_scope 不卖生图；无 SKU 的数量问题给补 SKU 指引；
 *    有包含物的数量问题给包装清单图提纲；使用方式问题给文字建议且逐字引用事实；
 *    归类改正后按当前版本重跑分析；确认绑定当前档案/事实，版本更新后确认被拒（QUESTION_STALE）；
 *    幂等键重放与复用冲突；跨租户一律 404；输入命中个人信息不入库。
 * 3. 集成（有成品）：已有通过闸口的图 → reuse_existing；事实更新导致报告失效后重分析 →
 *    旧图不再列出（旧失效作品不能当作当前可用复用结果）。
 * 运行：node --test test/e05.js（Node 22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import {
  analyzeQuestion, detectPii, frequencyLabelOf, missingFactsFor, suggestCategory, validateQuestionInput,
} from '../src/question.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 纯函数 fixture ----------

const PROFILE = {
  version: 1,
  skus: [
    {
      id: 'sku_a', sku_code: 'E05-01', label: '标准装', confirmed: true,
      attributes: [{ key: '容量', value: '50', unit: 'g' }],
      contents: [
        { item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' },
        { item: '说明书', quantity: 1, unit: '份', included: true, source: 'user_input' },
      ],
    },
    {
      id: 'sku_b', sku_code: 'E05-02', label: '双支装', confirmed: true,
      attributes: [{ key: '容量', value: '100', unit: 'g' }],
      contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
    },
  ],
};
const TRUTH = {
  version: 3,
  facts: [
    { key: '容量', value: '50', unit: 'g' },
    { key: '核心卖点', value: '舒缓维稳', unit: null },
    { key: '使用方法', value: '早晚洁面后取适量涂抹', unit: null },
  ],
};
const skuA = PROFILE.skus[0];

function analyze(category, extra = {}) {
  return analyzeQuestion({ category, sku: skuA, skuProfile: PROFILE, truth: TRUTH, ...extra });
}

test('E05 纯函数：输入脱敏、限长与频次口径', () => {
  // 命中手机号/身份证/长数字/邮箱/地址 → 类型列表（不回显原文）
  assert.deepEqual(detectPii('我电话 13800138000'), ['phone']);
  assert.deepEqual(detectPii('订单号 2026010112345678'), ['long_number']);
  assert.deepEqual(detectPii('联系 buyer@example.com'), ['email']);
  assert.ok(detectPii('收货地址：某某路 1 号').includes('address'));
  assert.deepEqual(detectPii('这个能装几瓶'), []);
  const rejected = (() => {
    try { validateQuestionInput({ text: '我的手机是 13800138000' }); return null; } catch (error) { return error; }
  })();
  assert.equal(rejected?.status, 422);
  assert.equal(rejected?.code, 'PII_DETECTED');
  assert.ok(!JSON.stringify(rejected.message).includes('13800138000'), '错误信息不得回显原始敏感信息');
  assert.deepEqual(rejected.details?.pii_types, ['phone']);
  // 限长与必填
  assert.equal((() => { try { validateQuestionInput({ text: ' ' }); } catch (e) { return e.code; } })(), 'INVALID_FIELD');
  assert.equal((() => {
    try { validateQuestionInput({ text: '问'.repeat(501) }); } catch (e) { return e.code; }
  })(), 'INVALID_FIELD');
  // 频次必须 {count, source} 同时出现；只有 count 不足以标注人工频次
  assert.equal((() => {
    try { validateQuestionInput({ text: '有多大', frequency: { count: 3 } }); } catch (e) { return e.code; }
  })(), 'INVALID_FIELD');
  assert.deepEqual(validateQuestionInput({ text: '有多大', frequency: { count: 3, source: '客服群聊截图' } }),
    { text: '有多大', skuId: null, frequency: { count: 3, source: '客服群聊截图' } });
  // 展示口径：无频次绝不出现「高频」
  assert.equal(frequencyLabelOf({}), '输入的问题（未提供频次）');
  assert.ok(!frequencyLabelOf({}).includes('高频'));
  assert.equal(frequencyLabelOf({ frequency: { count: 7, source: '人工统计' }, frequency_source: 'manual' }),
    '人工提供：7 次（来源：人工统计）');
});

test('E05 纯函数：归类建议与五类分流', () => {
  assert.equal(suggestCategory('什么时候发货，快递几天到'), 'logistics');
  assert.equal(suggestCategory('能退款吗'), 'payment');
  assert.equal(suggestCategory('还有现货吗'), 'inventory');
  assert.equal(suggestCategory('这个瓶子有多大'), 'size');
  assert.equal(suggestCategory('收到有几个，配件包含哪些'), 'quantity');
  assert.equal(suggestCategory('两个规格有什么区别'), 'spec_diff');
  assert.equal(suggestCategory('怎么使用'), 'usage');
  assert.equal(suggestCategory('适合送人吗'), 'other');

  // 越界问题：给处理边界，不强行生图
  const logistics = analyze('logistics');
  assert.equal(logistics.result, 'out_of_scope');
  assert.match(logistics.detail.scope_note, /物流/);
  assert.equal(logistics.detail.explainer_kind, undefined);

  // 缺 SKU：数量/尺寸/规格差别都要求先指定 SKU
  assert.deepEqual(missingFactsFor({ category: 'quantity', sku: null, skuProfile: PROFILE, truth: TRUTH })
    .map(item => item.code), ['sku']);
  // 缺尺寸：给出具体测量口径要求
  const sizeMissing = analyze('size');
  assert.equal(sizeMissing.result, 'missing_facts');
  assert.equal(sizeMissing.detail.missing[0].code, 'dimensions');
  assert.match(sizeMissing.detail.missing[0].message, /单位|口径/);

  // 已有包含物 → 包装清单图提纲（逐条列出确认条目）
  const quantity = analyze('quantity');
  assert.equal(quantity.result, 'needs_explainer');
  assert.equal(quantity.detail.explainer_kind, 'packing_list');
  assert.deepEqual(quantity.detail.outline, ['瓶装 × 1瓶', '说明书 × 1份']);

  // 规格差别 → SKU 对比提纲（按属性逐行对照，不臆造）
  const specDiff = analyze('spec_diff');
  assert.equal(specDiff.detail.explainer_kind, 'sku_compare');
  assert.ok(specDiff.detail.outline.some(line => line.startsWith('容量') && line.includes('E05-01')));

  // 使用方式：有事实 → 文字建议，逐字引用，不扩写
  const usage = analyze('usage');
  assert.equal(usage.result, 'text_suggestion');
  assert.deepEqual(usage.detail.suggestion.texts, ['使用方法：早晚洁面后取适量涂抹']);

  // 已有图（调用方经导出闸口筛选后传入）→ reuse_existing
  const reuse = analyze('quantity', { reusableVersions: [{
    run_id: 'run_1', deliverable_id: 'benefit', deliverable_label: '卖点图',
    version_id: 'ver_1', number: 2, format: 'png',
  }] });
  assert.equal(reuse.result, 'reuse_existing');
  assert.equal(reuse.detail.reusable[0].version_id, 'ver_1');
  assert.match(reuse.detail.note, /不判断图片是否直接回答/);

  // 尺寸说明不能断言适配所有场景
  const sizeOk = analyze('size', {
    sku: { ...skuA, attributes: [...skuA.attributes, { key: '瓶身高度', value: '120', unit: 'mm' }] },
  });
  assert.equal(sizeOk.result, 'needs_explainer');
  assert.equal(sizeOk.detail.explainer_kind, 'size');
  assert.match(sizeOk.detail.note, /不能断言/);
});

// ---------- Provider / 会话脚手架（与 e04 同型） ----------

function createFixture() {
  let submitCount = 0;
  const calls = new Map();
  return {
    capabilities: () => ({ id: 'e05-fixture', version: '1', image: true, video: false,
      max_references: 6, supports_mask: false, supports_post_composite: true, supports_async: true,
      supports_revision: false, supports_cancel: true, max_side: 4096, formats: ['png', 'jpg'],
      simulated: true, acceptance: 'simulated_only' }),
    validate: () => ({ ok: true }),
    estimate: () => ({ estimated_credits: 1, max_credits: 1 }),
    submit(request) {
      submitCount += 1;
      calls.set(request.idempotency_key, { request, seed: submitCount });
      return { provider_job_id: request.idempotency_key, status: 'queued' };
    },
    poll(handle) {
      const entry = calls.get(handle.provider_job_id);
      const seed = entry?.seed ?? 0;
      const width = entry?.request?.target_width ?? 1024;
      const height = entry?.request?.target_height ?? 1024;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 3;
          rgb[index] = (x * 3 + y * 2 + seed * 17) % 256;
          rgb[index + 1] = (y * 5 + x + seed * 29) % 256;
          rgb[index + 2] = (x * 7 + y * 3 + seed * 53) % 256;
        }
      }
      const bytes = encodeRgbPng(width, height, rgb);
      return { status: 'succeeded', result: {
        provider: 'e05-fixture', model: 'fixture/image', model_version: '1',
        provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
        usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
        output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
      } };
    },
    cancel: () => ({ cancelled: true }),
  };
}

async function setup(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'e05-'));
  const app = createApp({ port: 0, storeDir: dir, demoMode: false, initialCredits: 0, tickMs: 5, ...options });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

async function registerClient(port, { email, tenantName }) {
  let cookie = '';
  let csrf = '';
  const req = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie, 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const json = contentType.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null;
    if (json?.csrf_token) csrf = json.csrf_token;
    return { status: response.status, json, buffer, contentType };
  };
  const registered = await req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'E05Account2026!', display_name: 'E05', tenant_name: tenantName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  return { req };
}

async function sharpImage(width = 1200, height = 1200) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: '#dde5dd' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 600, channels: 3, background: '#335577' } }).png().toBuffer(), left: 400, top: 300 }])
    .png().toBuffer();
}

const FACTS = [
  { key: '容量', value: '50', unit: 'g', critical: true, confirmed: true, source_type: 'user_input' },
  { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
  { key: '使用方法', value: '早晚洁面后取适量涂抹', critical: false, confirmed: true, source_type: 'user_input' },
];

function skuPayload() {
  return {
    confirm: true,
    skus: [
      {
        sku_code: 'E05-01', label: '标准装', confirmed: true,
        attributes: [{ key: '容量', value: '50', unit: 'g' }],
        contents: [{ item: '瓶装', quantity: 1, unit: '瓶', included: true, source: 'user_input' }],
      },
      {
        sku_code: 'E05-02', label: '双支装', confirmed: true,
        attributes: [{ key: '容量', value: '100', unit: 'g' }],
        contents: [{ item: '瓶装', quantity: 2, unit: '瓶', included: true, source: 'user_input' }],
      },
    ],
  };
}

/** 建项目 → 主体素材 → 两 SKU 档案 → 事实（可选追加事实）。 */
async function setupProject(req, { withUsageFact = true } = {}) {
  const created = await req('/api/projects', {
    method: 'POST', body: { name: 'E05 面霜', sku: 'E05-01', category: '面霜', platform: '天猫' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id;
  const asset = await req(`/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', body: await sharpImage(), headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(asset.status, 201, JSON.stringify(asset.json));
  const profile = await req(`/api/projects/${projectId}/skus`, {
    method: 'PUT', body: { base_version: 0, ...skuPayload() },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.json));
  const skuIds = Object.fromEntries(profile.json.sku_profile.skus.map(item => [item.sku_code, item.id]));
  const facts = withUsageFact ? FACTS : FACTS.filter(item => item.key !== '使用方法');
  const truth = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST', body: { base_version: 0, confirm: true, facts, critical_text: [{ text: '月光舒缓' }] },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  return { projectId, skuIds, truthVersion: truth.json.truth_version.version };
}

async function analyzeQuestionApi(req, projectId, body, key, { expected = 201 } = {}) {
  const result = await req(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', body, headers: { 'Idempotency-Key': key },
  });
  assert.equal(result.status, expected, JSON.stringify(result.json));
  return result.json;
}

// ---------- 集成 ----------

test('E05 集成：五类分流、归类改正、频次口径、幂等与跨租户', async (t) => {
  const { port } = await setup(t);
  const owner = await registerClient(port, { email: 'e05-a@example.test', tenantName: '甲店' });
  const outsider = await registerClient(port, { email: 'e05-b@example.test', tenantName: '乙店' });
  const { req } = owner;
  const { projectId, skuIds } = await setupProject(req);

  // 1. 缺幂等键 → 400；带键才入库
  const noKey = await req(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', body: { text: '这个瓶子有多大' },
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.error, 'MISSING_IDEMPOTENCY_KEY');

  // 2. 个人信息问题拒绝入库，且不落库
  const pii = await req(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', body: { text: '顾客手机 13800138000 问尺寸' }, headers: { 'Idempotency-Key': 'q-pii' },
  });
  assert.equal(pii.status, 422);
  assert.equal(pii.json.error, 'PII_DETECTED');
  assert.ok(!JSON.stringify(pii.json).includes('13800138000'));
  const afterPii = await req(`/api/projects/${projectId}/question-groups`);
  assert.equal(afterPii.status, 200);
  assert.equal(afterPii.json.groups.length, 0, '被拒绝的问题不得入库');

  // 3. 物流问题 → out_of_scope（不卖生图）
  const shipping = await analyzeQuestionApi(req, projectId, { text: '什么时候发货，快递几天到' }, 'q-ship');
  assert.equal(shipping.group.result, 'out_of_scope');
  assert.equal(shipping.group.category_final, 'logistics');
  assert.match(shipping.group.detail.scope_note, /物流/);
  assert.equal(shipping.group.frequency_label, '输入的问题（未提供频次）');

  // 4. 数量问题无 SKU → 缺 SKU 指引；带 SKU → 包装清单图提纲
  const noSku = await analyzeQuestionApi(req, projectId, { text: '收到之后有几个，配件包含哪些' }, 'q-no-sku');
  assert.equal(noSku.group.result, 'missing_facts');
  assert.equal(noSku.group.detail.missing[0].code, 'sku');
  const quantity = await analyzeQuestionApi(req, projectId, {
    text: '收到之后有几个，配件包含哪些',
    sku_id: skuIds['E05-01'],
    frequency: { count: 12, source: '人工翻看客服记录' },
  }, 'q-count');
  assert.equal(quantity.group.result, 'needs_explainer');
  assert.equal(quantity.group.detail.explainer_kind, 'packing_list');
  assert.equal(quantity.group.frequency_label, '人工提供：12 次（来源：人工翻看客服记录）');
  assert.equal(quantity.group.duplicate_of, noSku.group.id, '同一问题再次出现应关联到最近一条');

  // 5. 尺寸问题缺测量值 → 具体补充清单
  const size = await analyzeQuestionApi(req, projectId, {
    text: '这个瓶子有多大，能放进抽屉吗', sku_id: skuIds['E05-01'],
  }, 'q-size');
  assert.equal(size.group.result, 'missing_facts');
  assert.equal(size.group.detail.missing[0].code, 'dimensions');

  // 6. 使用方式 → 文字建议，逐字引用已确认事实
  const usage = await analyzeQuestionApi(req, projectId, { text: '这个怎么用' }, 'q-usage');
  assert.equal(usage.group.result, 'text_suggestion');
  assert.deepEqual(usage.group.detail.suggestion.texts, ['使用方法：早晚洁面后取适量涂抹']);

  // 7. 幂等：同键同请求重放返回同一问题组；同键不同请求 → 409
  const replay = await analyzeQuestionApi(req, projectId, { text: '这个怎么用' }, 'q-usage', { expected: 200 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.group.id, usage.group.id);
  const conflict = await req(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', body: { text: '还有现货吗' }, headers: { 'Idempotency-Key': 'q-usage' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'IDEMPOTENCY_KEY_CONFLICT');

  // 8. 归类改正：系统归类为数量，商家改正为规格差别 → 按当前档案重跑分析
  const corrected = await req(`/api/question-groups/${quantity.group.id}/review`, {
    method: 'POST', body: { action: 'correct', category: 'spec_diff' },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
  assert.equal(corrected.json.group.category_final, 'spec_diff');
  assert.equal(corrected.json.group.category_suggested, 'quantity', '系统建议保留，不改写历史');
  assert.equal(corrected.json.group.result, 'needs_explainer');
  assert.equal(corrected.json.group.detail.explainer_kind, 'sku_compare');
  assert.equal(corrected.json.group.status, 'open', '改正归类会清掉旧确认');
  // 非法归类 → 422
  assert.equal((await req(`/api/question-groups/${quantity.group.id}/review`, {
    method: 'POST', body: { action: 'correct', category: 'nonsense' },
  })).status, 422);

  // 9. 确认绑定当前版本；事实更新后确认被拒（QUESTION_STALE），重分析后才可确认
  const confirmed = await req(`/api/question-groups/${quantity.group.id}/review`, {
    method: 'POST', body: { action: 'confirm' },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.group.status, 'confirmed');
  assert.equal(confirmed.json.group.confirmed_by, confirmed.json.group.confirmed_by);
  const truth2 = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: { base_version: 1, confirm: true, facts: [...FACTS, { key: '净含量', value: '50', unit: 'g', confirmed: true, source_type: 'user_input' }] },
  });
  assert.equal(truth2.status, 201, JSON.stringify(truth2.json));
  const staleConfirm = await req(`/api/question-groups/${quantity.group.id}/review`, {
    method: 'POST', body: { action: 'confirm' },
  });
  assert.equal(staleConfirm.status, 409);
  assert.equal(staleConfirm.json.error, 'QUESTION_STALE');
  const detailStale = await req(`/api/question-groups/${quantity.group.id}`);
  assert.equal(detailStale.json.facts_stale, true);
  const refreshed = await req(`/api/question-groups/${quantity.group.id}/review`, {
    method: 'POST', body: { action: 'correct', category: 'spec_diff' },
  });
  assert.equal(refreshed.json.facts_stale, false);
  assert.equal((await req(`/api/question-groups/${quantity.group.id}/review`, {
    method: 'POST', body: { action: 'confirm' },
  })).status, 200);

  // 10. 列表汇总 + 跨租户一律 404
  const list = await req(`/api/projects/${projectId}/question-groups`);
  assert.equal(list.status, 200);
  assert.equal(list.json.summary.total, 5);
  assert.equal(list.json.summary.by_result.out_of_scope, 1);
  assert.equal(list.json.summary.by_result.text_suggestion, 1);
  const { req: outReq } = outsider;
  assert.equal((await outReq(`/api/question-groups/${quantity.group.id}`)).status, 404);
  assert.equal((await outReq(`/api/projects/${projectId}/question-groups`)).status, 404);
  assert.equal((await outReq(`/api/projects/${projectId}/questions/analyze`, {
    method: 'POST', body: { text: '这个怎么用' }, headers: { 'Idempotency-Key': 'x' },
  })).status, 404);
  assert.equal((await outReq(`/api/question-groups/${quantity.group.id}/review`, {
    method: 'POST', body: { action: 'confirm' },
  })).status, 404);
});

test('E05 集成：已有成品可复用；事实更新后旧图不再列为可用', async (t) => {
  const { port } = await setup(t, { provider: createFixture() });
  const { req } = await registerClient(port, { email: 'e05-c@example.test', tenantName: '丙店' });
  const { projectId, skuIds } = await setupProject(req);

  // 冻结 spec → 报价 → 任务 → 终态 → 人工复核至可发布
  const kit = await req('/api/brand-kits', {
    method: 'POST',
    body: {
      name: 'E05 品牌套件', palette: { primary: '#2F6B4F', secondary: ['#F8FAFC'] },
      logo: { present: false },
      fonts: [{ name: '思源黑体', license: 'licensed', license_ref: 'LIC-2026-01' }],
      tone: '克制、可信', banned_expressions: [],
    },
  });
  assert.equal(kit.status, 201, JSON.stringify(kit.json));
  const preview = await req(`/api/projects/${projectId}/specs/preview`, {
    method: 'POST', body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await req(`/api/projects/${projectId}/specs`, {
    method: 'POST',
    body: { template_id: 'tpl_listing_pack', platform: '天猫', brand_kit_id: kit.json.brand_kit.id, conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  const quote = await req('/api/quotes', { method: 'POST', body: { project_id: projectId } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));
  const run = await req('/api/runs', {
    method: 'POST', body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
    headers: { 'Idempotency-Key': 'e05-run' },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  let finished = null;
  const started = Date.now();
  for (;;) {
    finished = (await req(`/api/runs/${run.json.run.id}`)).json.run;
    if (['completed', 'limit_reached', 'failed', 'cancelled'].includes(finished.status)) break;
    if (Date.now() - started > 60_000) throw new Error(`任务未进入终态，最后状态 ${finished?.status}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 300));
  const versions = (await req(`/api/runs/${run.json.run.id}/versions`)).json.versions;
  for (const item of versions.filter(v => v.current)) {
    const report = (await req(`/api/quality-reports/${item.report_id}`)).json.report;
    if (!report || report.decision === 'publishable') continue;
    const decisions = (report.checks ?? [])
      .filter(check => check.required && check.status === 'unknown' && check.adjudicable)
      .map(check => ({ code: check.code, decision: 'pass', reason: 'E05 测试样本人工检查通过', evidence: report.id }));
    if (decisions.length === 0) continue;
    const reviewed = await req(`/api/quality-reports/${item.report_id}/reviews`, {
      method: 'POST', body: { decisions, note: '仅测试 fixture，不证明真实模型效果' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  }

  // 1. 已有通过闸口的图 → reuse_existing
  const reuse = await analyzeQuestionApi(req, projectId, {
    text: '收到之后有几个，配件包含哪些', sku_id: skuIds['E05-01'],
  }, 'e05-reuse');
  assert.equal(reuse.group.result, 'reuse_existing', JSON.stringify(reuse.group));
  assert.ok(reuse.group.detail.reusable.length >= 1);
  const listedVersionIds = reuse.group.detail.reusable.map(item => item.version_id);
  assert.ok(listedVersionIds.every(id => versions.some(item => item.id === id)), '只列当前选用版本');

  // 2. 事实更新 → 报告失效 → 重新分析后旧图不再列为可用复用结果
  const truth2 = await req(`/api/projects/${projectId}/truth-versions`, {
    method: 'POST',
    body: { base_version: 1, confirm: true, facts: [...FACTS, { key: '净含量', value: '60', unit: 'g', confirmed: true, source_type: 'user_input' }] },
  });
  assert.equal(truth2.status, 201, JSON.stringify(truth2.json));
  const refreshed = await req(`/api/question-groups/${reuse.group.id}/review`, {
    method: 'POST', body: { action: 'correct', category: 'quantity' },
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.notEqual(refreshed.json.group.result, 'reuse_existing', '失效的旧作品不能当作当前可用复用结果');
  assert.equal(refreshed.json.group.result, 'needs_explainer');
  assert.ok(!JSON.stringify(refreshed.json.group.detail).includes(listedVersionIds[0]), '失效版本不得再出现');
});
