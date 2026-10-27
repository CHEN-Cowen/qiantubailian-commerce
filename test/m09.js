/**
 * M09 测试：授权评测集、冠军—挑战者与灰度回退。
 *
 * 关键约束（不允许为了让测试通过而放松）：
 * 1. 未授权素材不得进入评测集；授权样本不足时评测状态必须是 insufficient_dataset。
 * 2. 未知样本不算正确；候选必须在全部可比指标不劣于冠军且至少一项严格更优才算胜出。
 * 3. 灰度上限 5%；候选未胜出或缺 Adapter 时灰度比例为 0，不得宣称已在灰度。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import {
  DEFAULT_CANARY_THRESHOLDS, MIN_EVAL_SKUS, MIN_HOLDOUT_SKUS, compareModels,
  evaluateCanaryHealth, planCanary, summarizeDataset, summarizeEvaluation,
} from '../src/m09.mjs';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'tester_m09') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

// ---------- 测试数据构造 ----------

function datasetItems({ evalCount = MIN_EVAL_SKUS, holdoutCount = MIN_HOLDOUT_SKUS, unlicensed = 0 } = {}) {
  const items = [];
  for (let index = 0; index < evalCount; index += 1) {
    items.push({ sku_id: `sku_e${index}`, split: 'eval', licensed: true, license_ref: `lic_e${index}` });
  }
  for (let index = 0; index < holdoutCount; index += 1) {
    items.push({ sku_id: `sku_h${index}`, split: 'holdout', licensed: true, license_ref: `lic_h${index}` });
  }
  for (let index = 0; index < unlicensed; index += 1) {
    items.push({ sku_id: `sku_u${index}`, split: 'eval', licensed: false, license_ref: '' });
  }
  return items;
}

/**
 * 生成某模型的评测样本。quality 决定真实性/未知/合格情况：
 * good → 大部分 ok 且合格；unknown_heavy → 大量 unknown；mismatch_heavy → 真实性回退。
 */
function modelSamples(items, modelId, { quality = 'good', costCredits = 2 } = {}) {
  return items.map((item, index) => {
    if (item.licensed !== true) {
      return {
        sku_id: item.sku_id, model_id: modelId, split: item.split, truth: 'ok',
        human: 'accepted', qualified: true, cost_credits: costCredits,
      };
    }
    if (quality === 'unknown_heavy') {
      return {
        sku_id: item.sku_id, model_id: modelId, split: item.split, truth: index % 2 === 0 ? 'unknown' : 'ok',
        human: 'accepted', qualified: index % 3 !== 0, cost_credits: costCredits,
      };
    }
    if (quality === 'mismatch_heavy') {
      return {
        sku_id: item.sku_id, model_id: modelId, split: item.split, truth: index % 2 === 0 ? 'mismatch' : 'ok',
        human: 'rejected', qualified: false, cost_credits: costCredits,
      };
    }
    return {
      sku_id: item.sku_id, model_id: modelId, split: item.split, truth: 'ok',
      human: 'accepted', qualified: true, cost_credits: costCredits,
    };
  });
}

// ---------- HTTP 辅助 ----------

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
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function start(t, options = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_ROOT, 'm09-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 0, tickMs: 5, attemptTimeoutMs: 30_000,
    allowScenarioInjection: false, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

// ---------- 纯函数 ----------

test('M09 数据集摘要：未授权样本不计入，不足 100 SKU 与留出集不足必须阻断', () => {
  const small = summarizeDataset(datasetItems({ evalCount: 50, holdoutCount: 10, unlicensed: 3 }));
  assert.equal(small.ready, false);
  assert.equal(small.total, 63);
  assert.equal(small.licensed, 60);
  assert.equal(small.unlicensed, 3);
  assert.deepEqual(small.blockers.map(item => item.code).sort(), ['DATASET_TOO_SMALL', 'HOLDOUT_TOO_SMALL']);
  assert.equal(small.blockers.find(item => item.code === 'DATASET_TOO_SMALL').detail.required, MIN_EVAL_SKUS);

  const ready = summarizeDataset(datasetItems());
  assert.equal(ready.ready, true);
  assert.equal(ready.eval_count, MIN_EVAL_SKUS);
  assert.equal(ready.holdout_count, MIN_HOLDOUT_SKUS);
  assert.equal(ready.blockers.length, 0);

  const duplicate = summarizeDataset([
    ...datasetItems({ evalCount: MIN_EVAL_SKUS, holdoutCount: MIN_HOLDOUT_SKUS }),
    { sku_id: 'sku_e0', split: 'eval', licensed: true, license_ref: 'lic_dup' },
  ]);
  assert.equal(duplicate.ready, false);
  assert.ok(duplicate.blockers.some(item => item.code === 'DUPLICATE_SKU'));
});

test('M09 冠军—挑战者：任一项回退即拒绝，全部不劣且至少一项更优才允许晋级', () => {
  const base = {
    skus: MIN_EVAL_SKUS, holdout_skus: MIN_HOLDOUT_SKUS,
    truthfulness: 0.9, unknown_rate: 0.15, human_acceptance_rate: 0.7, cost_per_qualified: 5,
  };
  const better = { ...base, truthfulness: 0.95, unknown_rate: 0.1, human_acceptance_rate: 0.8, cost_per_qualified: 4 };
  const promoted = compareModels({ champion: base, candidate: better });
  assert.equal(promoted.promote, true, JSON.stringify(promoted));
  assert.deepEqual(promoted.improvements.sort(), ['cost_per_qualified', 'human_acceptance_rate', 'truthfulness', 'unknown_rate']);

  const tied = compareModels({ champion: base, candidate: { ...base } });
  assert.equal(tied.promote, false);
  assert.deepEqual(tied.reasons, ['NO_STRICT_IMPROVEMENT']);

  const regression = compareModels({ champion: base, candidate: { ...better, truthfulness: 0.85 } });
  assert.equal(regression.promote, false);
  assert.ok(regression.reasons.includes('TRUTHFULNESS_REGRESSION'));

  const missingBaseline = compareModels({ champion: null, candidate: better });
  assert.equal(missingBaseline.promote, false);
  assert.ok(missingBaseline.reasons.includes('CHAMPION_NO_BASELINE'));

  const underSampled = compareModels({
    champion: base, candidate: { ...better, skus: 10, holdout_skus: 2 },
  });
  assert.equal(underSampled.promote, false);
  assert.ok(underSampled.reasons.includes('CANDIDATE_INSUFFICIENT_SAMPLES'));
});

test('M09 评测结论：授权素材不足时不得声称评测完成，未知样本不算正确', () => {
  const items = datasetItems();
  const samples = [
    ...modelSamples(items, 'champion-model'),
    ...modelSamples(items, 'candidate-model', { quality: 'unknown_heavy' }),
  ];

  const insufficient = summarizeEvaluation({
    datasetItems: datasetItems({ evalCount: 10, holdoutCount: 2 }),
    samples, championModelId: 'champion-model', candidateModelId: 'candidate-model',
  });
  assert.equal(insufficient.status, 'insufficient_dataset');
  assert.equal(insufficient.decision.promote, false);
  assert.equal(insufficient.dataset.ready, false);

  const completed = summarizeEvaluation({
    datasetItems: items, samples,
    championModelId: 'champion-model', candidateModelId: 'candidate-model',
  });
  assert.equal(completed.status, 'completed', JSON.stringify(completed.decision));
  assert.equal(completed.metrics.candidate.truth_unknown > 0, true);
  // 未知率更高属于回退，不能因为"未知"被当成正确而晋级
  assert.ok(completed.decision.reasons.includes('UNKNOWN_RATE_REGRESSION'));
  assert.equal(completed.decision.promote, false);

  // 未授权 sku 的样本即使传进来也会被排除
  const dirty = summarizeEvaluation({
    datasetItems: datasetItems({ unlicensed: 5 }),
    samples: [
      ...modelSamples(items, 'champion-model'),
      ...modelSamples(datasetItems({ unlicensed: 5 }).filter(item => !item.licensed), 'candidate-model'),
      ...modelSamples(items, 'candidate-model'),
    ],
    championModelId: 'champion-model', candidateModelId: 'candidate-model',
  });
  assert.equal(dirty.excluded_unlicensed, 5);
  assert.equal(dirty.status, 'completed');
});

test('M09 灰度计划：上限 5%，候选未胜出或缺 Adapter 时比例为 0', () => {
  const winning = { promote: true, reasons: [], improvements: ['truthfulness'] };
  const blocked = planCanary({ decision: winning, adapterAvailable: false, requestedPercent: 20 });
  assert.equal(blocked.active, false);
  assert.equal(blocked.percent, 0);
  assert.equal(blocked.blocked_reason, 'CANDIDATE_ADAPTER_UNAVAILABLE');

  const notWinning = planCanary({ decision: { promote: false }, adapterAvailable: true, requestedPercent: 3 });
  assert.equal(notWinning.active, false);
  assert.equal(notWinning.blocked_reason, 'CANDIDATE_NOT_WINNING');

  const active = planCanary({ decision: winning, adapterAvailable: true, requestedPercent: 20 });
  assert.equal(active.active, true);
  assert.equal(active.percent, 5, '请求 20% 必须被压到 5% 上限');

  const tiny = planCanary({ decision: winning, adapterAvailable: true, requestedPercent: 0 });
  assert.equal(tiny.percent, 1, '低于下限时不得把比例降成 0 而假装在灰度');
  assert.equal(tiny.max_percent, 5);
});

test('M09 灰度健康：样本不足、未知率与真实性触线都要求回滚', () => {
  const insufficient = evaluateCanaryHealth({ samples: [{ truth: 'ok' }] });
  assert.equal(insufficient.healthy, false);
  assert.ok(insufficient.breaches.includes('INSUFFICIENT_CANARY_SAMPLES'));

  const healthy = evaluateCanaryHealth({
    samples: Array.from({ length: DEFAULT_CANARY_THRESHOLDS.min_canary_samples }, () => ({
      truth: 'ok', unknown: false, qa_status: 'publishable',
    })),
  });
  assert.equal(healthy.healthy, true, JSON.stringify(healthy));
  assert.equal(healthy.unknown_rate, 0);

  const bad = evaluateCanaryHealth({
    samples: Array.from({ length: DEFAULT_CANARY_THRESHOLDS.min_canary_samples }, (_, index) => ({
      truth: index % 2 === 0 ? 'mismatch' : 'ok', unknown: index % 3 === 0, qa_status: 'blocked',
    })),
  });
  assert.equal(bad.healthy, false);
  assert.ok(bad.breaches.includes('UNKNOWN_RATE_ABOVE_THRESHOLD'));
  assert.ok(bad.breaches.includes('BLOCKED_RATE_ABOVE_THRESHOLD'));
  assert.ok(bad.breaches.includes('TRUTHFULNESS_BELOW_THRESHOLD'));
});

// ---------- 端到端 ----------

test('M09 端到端：授权导入 → 评测 → 候选路由与灰度阻断 → 数据集变更使报告失效 → 租户隔离', async t => {
  const { port } = await start(t);

  const tenant = await request(port, '/api/tenant', { headers: as() });
  assert.equal(tenant.json.module, 'M12');

  // 未授权条目必须被拒绝
  const rejected = await request(port, '/api/eval/dataset', {
    method: 'POST', headers: as(),
    body: { items: [{ sku_id: 'sku_unlicensed', split: 'eval', licensed: false, license_ref: '' }] },
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.json));
  assert.equal(rejected.json.error, 'DATASET_LICENSE_REQUIRED');

  const duplicated = await request(port, '/api/eval/dataset', {
    method: 'POST', headers: as(),
    body: {
      items: [
        { sku_id: 'sku_x', licensed: true, license_ref: 'lic_x' },
        { sku_id: 'sku_x', licensed: true, license_ref: 'lic_y' },
      ],
    },
  });
  assert.equal(duplicated.status, 422);
  assert.equal(duplicated.json.error, 'DATASET_DUPLICATE_SKU');

  const items = datasetItems();
  const imported = await request(port, '/api/eval/dataset', {
    method: 'POST', headers: as(),
    body: {
      items: items.map(item => ({
        sku_id: item.sku_id, split: item.split, licensed: true, license_ref: item.license_ref,
      })),
    },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  assert.equal(imported.json.imported, items.length);
  assert.equal(imported.json.summary.ready, true);
  assert.equal(imported.json.summary.holdout_count, MIN_HOLDOUT_SKUS);

  const dataset = await request(port, '/api/eval/dataset?split=holdout', { headers: as() });
  assert.equal(dataset.status, 200);
  assert.equal(dataset.json.items.length, MIN_HOLDOUT_SKUS);

  const champion = 'deterministic-mock';
  const candidate = 'gpt-image-candidate';
  // 候选在真实性上更优，但未知率没有回退；用于验证"可以胜出"的路径
  const samples = [
    ...modelSamples(items, champion),
    ...modelSamples(items, candidate, { costCredits: 1 }),
  ];
  const created = await request(port, '/api/eval/reports', {
    method: 'POST', headers: as(), body: { champion_model_id: champion, candidate_model_id: candidate, samples },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const report = created.json.report;
  assert.equal(report.status, 'completed');
  assert.equal(report.decision.promote, true, JSON.stringify(report.decision));

  const same = await request(port, '/api/eval/reports', {
    method: 'POST', headers: as(), body: { champion_model_id: champion, candidate_model_id: champion, samples },
  });
  assert.equal(same.status, 422);
  assert.equal(same.json.error, 'CANDIDATE_EQUALS_CHAMPION');

  const routing = await request(port, '/api/models', { headers: as() });
  assert.equal(routing.status, 200, JSON.stringify(routing.json));
  assert.equal(routing.json.champion.model_id, champion);
  assert.equal(routing.json.champion.simulated, true);
  const entry = routing.json.candidates.find(item => item.model_id === candidate);
  assert.ok(entry, '候选应出现在路由视图');
  assert.equal(entry.dataset_stale, false);
  assert.equal(entry.adapter_registered, false);
  assert.equal(entry.canary.active, false);
  assert.equal(entry.canary.percent, 0);
  assert.equal(entry.canary.blocked_reason, 'CANDIDATE_ADAPTER_UNAVAILABLE');
  assert.equal(routing.json.canary.max_percent, 5);
  assert.equal(routing.json.canary.active, false);

  const health = await request(port, '/api/models/canary/health', {
    method: 'POST', headers: as(),
    body: {
      samples: Array.from({ length: DEFAULT_CANARY_THRESHOLDS.min_canary_samples }, (_, index) => ({
        truth: 'mismatch', unknown: true, qa_status: 'blocked',
      })),
    },
  });
  assert.equal(health.status, 200, JSON.stringify(health.json));
  assert.equal(health.json.rollback_required, true);
  assert.ok(health.json.health.breaches.includes('TRUTHFULNESS_BELOW_THRESHOLD'));

  // 数据集变更后，旧报告必须标记失效，且灰度继续阻断
  const changed = await request(port, '/api/eval/dataset', {
    method: 'POST', headers: as(),
    body: { items: [{ sku_id: 'sku_e0', split: 'eval', licensed: true, license_ref: 'lic_e0_v2' }] },
  });
  assert.equal(changed.status, 201);

  const staleReport = await request(port, `/api/eval/reports/${report.id}`, { headers: as() });
  assert.equal(staleReport.status, 200);
  assert.equal(staleReport.json.report.dataset_stale, true);

  const staleRouting = await request(port, '/api/models', { headers: as() });
  const staleEntry = staleRouting.json.candidates.find(item => item.model_id === candidate);
  assert.equal(staleEntry.dataset_stale, true);
  assert.equal(staleEntry.canary.active, false);
  assert.equal(staleEntry.canary.blocked_reason, 'CANDIDATE_NOT_WINNING');

  // 跨租户：同一个报告 id 在另一个租户下必须按不存在处理
  const other = await request(port, `/api/eval/reports/${report.id}`, { headers: as('tenant_demo') });
  assert.equal(other.status, 404);
  const otherDataset = await request(port, '/api/eval/dataset', { headers: as('tenant_demo') });
  assert.equal(otherDataset.status, 200);
  assert.equal(otherDataset.json.items.length, 0);
  assert.equal(otherDataset.json.summary.ready, false);
});
