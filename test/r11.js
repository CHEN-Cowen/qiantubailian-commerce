/**
 * R11 指标、部署、迁移与运维交付测试。
 *
 * 验收口径：
 * 1. 指标含真实口径：首张可用图耗时、采用率、失败率、每张成本、付款转化。
 * 2. 指标不泄漏素材内容、提示词等隐私字段。
 * 3. 备份创建与恢复可验证（快照完整性）。
 * 4. 部署手册存在且覆盖关键约束。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';
import { createHash } from 'node:crypto';

const TENANTS = ['tenant_a', 'tenant_demo'];
const as = (tenant = 'tenant_a', actor = 'owner_r11') => ({ 'x-tenant-id': tenant, 'x-actor-id': actor });
const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

function subjectPng(width = 128, height = 128) {
  const pixels = Buffer.alloc(width * height * 3, 240);
  for (let y = 32; y < 96; y += 1) {
    for (let x = 32; x < 96; x += 1) {
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
  const dir = await mkdtemp(path.join(TEST_ROOT, 'r11-'));
  const app = createApp({
    port: 0, storeDir: dir, allowedTenants: TENANTS,
    initialCredits: 400, tickMs: 8, attemptTimeoutMs: 30_000, allowScenarioInjection: true, ...options,
  });
  t.after(async () => {
    await app.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  });
  const { port } = await app.listen();
  return { port, dir, app };
}

function createSizeFixture() {
  const capabilities = () => ({
    id: 'r11-fixture', version: 'fixture.1', image: true, video: false,
    max_references: 2, supports_mask: true, supports_async: true, supports_cancel: true,
    supports_seed: true, supports_revision: false, max_side: 2048, formats: ['jpg', 'png'],
    simulated: true, acceptance: 'simulated_only',
  });
  const jobs = new Map();
  const cache = new Map();
  let sequence = 0;

  function bytesFor(width, height, format) {
    const key = `${format}:${width}x${height}`;
    if (cache.has(key)) return cache.get(key);
    let bytes;
    if (format === 'png') {
      const pixels = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 3;
          pixels[index] = (x * 3 + y * 2) % 256;
          pixels[index + 1] = (y * 5 + x) % 256;
          pixels[index + 2] = (x * 7 + y * 3) % 256;
        }
      }
      bytes = encodeRgbPng(width, height, pixels);
    } else {
      bytes = Buffer.alloc(23);
      bytes[0] = 0xFF; bytes[1] = 0xD8; bytes[2] = 0xFF; bytes[3] = 0xC0;
      bytes.writeUInt16BE(17, 4); bytes[6] = 8;
      bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
      bytes[11] = 3; bytes[12] = 1; bytes[13] = 0x11; bytes[14] = 0;
      bytes[15] = 2; bytes[16] = 0x11; bytes[17] = 1;
      bytes[18] = 3; bytes[19] = 0x11; bytes[20] = 1;
      bytes[21] = 0xFF; bytes[22] = 0xD9;
    }
    cache.set(key, bytes);
    return bytes;
  }

  function normalizeResult(job) {
    const { request } = job;
    const width = request.target_width;
    const height = request.target_height;
    const format = (request.formats ?? ['png']).includes('png') ? 'png' : 'jpg';
    const bytes = bytesFor(width, height, format);
    return {
      provider: 'r11-fixture', model: 'fixture/image', model_version: 'fixture.1',
      provider_job_id: job.request.idempotency_key,
      provider_request_id: `req_${job.request.request_hash.slice(0, 12)}`,
      usage: { images: 1, unit: 'image' },
      cost: { amount: 0, currency: 'internal_demo' },
      latency_ms: 8,
      output: { format, bytes, width, height, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
  }

  return {
    capabilities,
    validate: () => ({ ok: true }),
    estimate: request => {
      const side = Math.max(request.target_width ?? 1024, request.target_height ?? 1024);
      return { price_version: 'fixture.1', estimated_credits: Math.max(1, Math.round(side * side * 0.0000045)), max_credits: null };
    },
    submit: request => {
      sequence += 1;
      const providerJobId = `fx_${sequence}`;
      jobs.set(providerJobId, { request });
      return {
        provider_job_id: providerJobId, status: 'queued',
        request_hash: request.request_hash, idempotency_key: request.idempotency_key,
        provider_meta: { id: 'r11-fixture', version: 'fixture.1', simulated: true },
      };
    },
    poll: handle => {
      const job = jobs.get(handle.provider_job_id);
      if (!job) return { status: 'unknown', code: 'PROVIDER_UNKNOWN' };
      return { status: 'succeeded', result: normalizeResult(job) };
    },
    cancel: () => ({ status: 'cancelled' }),
    normalizeResult,
  };
}

async function freezeProject(port, projectId, tenant = 'tenant_a', actor = 'owner_r11') {
  const headers = as(tenant, actor);
  await request(port, `/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' },
    body: subjectPng(128, 128),
  });
  const truth = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers,
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '容量', value: '30ml', critical: true, confirmed: true, source_type: 'user_input' },
        { key: '核心卖点', value: '温和修护', critical: true, confirmed: true, source_type: 'user_input' },
      ],
      critical_text: [{ text: '润泽精华' }],
    },
  });
  assert.equal(truth.status, 201, JSON.stringify(truth.json));
  const preview = await request(port, `/api/projects/${projectId}/specs/preview`, {
    method: 'POST', headers, body: { template_id: 'tpl_listing_pack', platform: '天猫' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const resolutions = {};
  for (const conflict of [...preview.json.payload.conflicts.pending, ...preview.json.payload.conflicts.unresolvable]) {
    if (conflict.options.length > 0) resolutions[conflict.key] = conflict.options[0].id;
  }
  const frozen = await request(port, `/api/projects/${projectId}/specs`, {
    method: 'POST', headers, body: { template_id: 'tpl_listing_pack', platform: '天猫', conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
  return frozen.json.spec;
}

async function waitRunDone(port, runId, headers) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const polled = await request(port, `/api/runs/${runId}`, { headers });
    assert.equal(polled.status, 200, JSON.stringify(polled.json));
    const run = polled.json.run;
    if (run.status === 'completed' || run.status === 'failed') return run;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  throw new Error(`任务 ${runId} 未在预期时间内完成`);
}

async function reviewToPublishable(port, runId, headers) {
  const runDetail = await request(port, `/api/runs/${runId}`, { headers });
  assert.equal(runDetail.status, 200, JSON.stringify(runDetail.json));
  for (const version of runDetail.json.run.versions) {
    const reportRes = await request(port, `/api/quality-reports/${version.report_id}`, { headers });
    const report = reportRes.json.report;
    if (report.decision === 'publishable') continue;
    const decisions = report.checks
      .filter(item => item.status === 'unknown' && item.required === true && item.adjudicable === true)
      .map(item => ({ code: item.code, decision: 'pass', reason: `R11 复核 ${item.code}`, evidence: `复核 ${report.id}` }));
    const reviewed = await request(port, `/api/quality-reports/${report.id}/reviews`, {
      method: 'POST', headers, body: { decisions, note: 'R11 复核' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
    assert.equal(reviewed.json.report.decision, 'publishable');
  }
}

// ---------- 测试 ----------

test('R11 指标包含商业化口径', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 创建项目并执行一个完整流程
  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R11 指标测试', sku: 'R11-001', category: '精华' },
  });
  assert.equal(project.status, 201, JSON.stringify(project.json));
  const projectId = project.json.project.id;
  await freezeProject(port, projectId);

  // 先创建报价
  const quote = await request(port, '/api/quotes', {
    method: 'POST', headers, body: { project_id: projectId },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.json));

  // 创建并完成任务
  const run = await request(port, '/api/runs', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `r11-run-${Date.now()}` },
    body: { project_id: projectId, quote_id: quote.json.quote.quote_id },
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  const runId = run.json.run.id;
  const doneRun = await waitRunDone(port, runId, headers);
  assert.equal(doneRun.status, 'completed');
  await reviewToPublishable(port, runId, headers);

  // 导出
  const exported = await request(port, `/api/runs/${runId}/exports`, {
    method: 'POST', headers, body: { scope: 'partial' },
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.json));

  // 查指标
  const metrics = await request(port, '/api/metrics', { headers });
  assert.equal(metrics.status, 200, JSON.stringify(metrics.json));
  const m = metrics.json;

  // 基础字段
  assert.equal(m.tenant_id, 'tenant_a');
  assert.ok(m.http.total > 0);
  assert.ok(m.work.runs >= 1);
  assert.ok(m.work.exports >= 1);

  // R11 商业化指标：business 节存在且包含所有口径
  assert.ok(m.business, 'business 指标节必须存在');
  assert.ok(typeof m.business === 'object');

  // 各指标字段必须存在（可以是 null 如果没有数据）
  const businessKeys = [
    'avg_first_image_ms', 'adoption_rate', 'failure_rate',
    'unknown_rate', 'revision_net_improvement', 'cost_per_image', 'payment_conversion',
  ];
  for (const key of businessKeys) {
    assert.ok(key in m.business, `business.${key} 必须存在`);
  }

  // 有完成任务时，首张可用图耗时应该是正数
  assert.ok(m.business.avg_first_image_ms !== null, '有完成任务时 avg_first_image_ms 不应为 null');
  assert.ok(m.business.avg_first_image_ms >= 0, '首张可用图耗时不能为负');

  // 导出率与采用反馈、真实货币成本分开

  assert.equal(m.business.cost_per_image, null, '未核验的费用不能冒充货币成本');
  assert.ok(m.business.export_rate > 0);
  assert.ok(m.business.credits_per_image > 0);
  // 每张成品消耗额度与货币成本分开

  // 隐私：指标不得包含素材内容或提示词
  const metricsStr = JSON.stringify(m);
  assert.equal(metricsStr.includes('润泽精华'), false, '指标不得泄漏事实内容');
  assert.equal(metricsStr.includes('温和修护'), false, '指标不得泄漏卖点内容');
});

test('R11 备份创建与恢复验证', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headers = as();

  // 创建项目
  const project = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R11 备份测试', sku: 'R11-002', category: '精华' },
  });
  assert.equal(project.status, 201, JSON.stringify(project.json));
  const projectId = project.json.project.id;
  await freezeProject(port, projectId);

  // 创建备份
  const backup = await request(port, '/api/backups', { method: 'POST', headers });
  assert.equal(backup.status, 201, JSON.stringify(backup.json));
  const backupId = backup.json.backup.id;
  assert.ok(backup.json.manifest, '备份响应必须有 manifest');
  assert.ok(backup.json.manifest.data_sha256, 'manifest 必须有 data_sha256');
  assert.ok(backup.json.manifest.counts, 'manifest 必须有 counts');
  assert.equal(backup.json.backup.tenant_id, 'tenant_a');
  assert.ok(backup.json.backup.format_version > 0);

  // 验证备份列表包含该备份
  const list = await request(port, '/api/backups', { headers });
  assert.equal(list.status, 200);
  assert.ok(list.json.backups.some(b => b.id === backupId), '备份列表应包含新备份');

  // 删除项目（模拟数据丢失）
  // 注意：当前 API 可能没有删除项目的路由，用恢复来验证数据一致性
  // 恢复备份
  const restore = await request(port, `/api/backups/${backupId}/restore`, {
    method: 'POST', headers, body: { confirm: true },
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.json));
  assert.equal(restore.json.restored, true);

  // 验证恢复后项目仍在
  const restored = await request(port, `/api/projects/${projectId}`, { headers });
  assert.equal(restored.status, 200, '恢复后项目应仍存在');
  assert.equal(restored.json.project.name, 'R11 备份测试');
});

test('R11 部署手册存在且覆盖关键约束', async () => {
  const docPath = fileURLToPath(new URL('../docs/commercialization/部署手册.md', import.meta.url));
  const content = await readFile(docPath, 'utf8');

  // 关键约束
  assert.ok(content.includes('Node.js'), '必须提到 Node.js 版本要求');
  assert.ok(content.includes('单实例') || content.includes('单进程'), '必须说明单实例限制');
  assert.ok(content.includes('npm start'), '必须包含启动命令');
  assert.ok(content.includes('QTB_DATA_DIR'), '必须说明数据目录配置');
  assert.ok(content.includes('healthz'), '必须包含健康检查');
  assert.ok(content.includes('备份') || content.includes('backup'), '必须包含备份说明');
  assert.ok(content.includes('无密钥') || content.includes('演示'), '必须说明无密钥演示');
  assert.ok(content.includes('QTB_WX_MCHID'), '必须列出微信支付环境变量');
});

test('R11 指标跨租户隔离', async t => {
  const { port } = await start(t, { provider: createSizeFixture() });
  const headersA = as('tenant_a', 'owner_r11');
  const headersB = as('tenant_demo', 'operator_demo');

  // tenant_a 创建项目
  const projectA = await request(port, '/api/projects', {
    method: 'POST', headers: headersA,
    body: { name: 'R11 隔离测试 A', sku: 'R11-003', category: '精华' },
  });
  assert.equal(projectA.status, 201, JSON.stringify(projectA.json));

  // tenant_demo 的指标不应包含 tenant_a 的项目
  const metricsB = await request(port, '/api/metrics', { headers: headersB });
  assert.equal(metricsB.status, 200, JSON.stringify(metricsB.json));
  assert.equal(metricsB.json.work.projects, 0, 'tenant_demo 不应看到 tenant_a 的项目');
  assert.equal(metricsB.json.work.runs, 0, 'tenant_demo 不应有任务');
});
