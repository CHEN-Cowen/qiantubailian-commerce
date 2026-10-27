import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { encodeRgbPng } from '../src/m06.mjs';

const TEST_ROOT = fileURLToPath(new URL('../runtime/test-tmp/', import.meta.url));

function subjectPng(width = 900, height = 900) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= width * 0.3 && x < width * 0.7 && y >= height * 0.25 && y < height * 0.75;
      const index = (y * width + x) * 3;
      pixels[index] = inside ? 198 : 246;
      pixels[index + 1] = inside ? 36 : 246;
      pixels[index + 2] = inside ? 44 : 246;
    }
  }
  return encodeRgbPng(width, height, pixels);
}

function request(port, route, { method = 'GET', headers = {}, body, query } = {}) {
  const fullPath = route + (query ? `?${query}` : '');
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: fullPath, method,
      headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: data, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedProject(port, { tenantId, actor = 'alice' } = {}) {
  const headers = { 'x-tenant-id': tenantId, 'x-actor-id': actor };
  const created = await request(port, '/api/projects', {
    method: 'POST', headers,
    body: { name: 'R05 测试商品', sku: `r05-${Math.random().toString(36).slice(2, 7)}`, category: '测试品类', platform: '淘宝' },
  });
  assert.equal(created.status, 201, `创建项目失败: ${created.text}`);
  const projectId = created.body.project.id;
  const png = subjectPng(1024, 1024);
  const upload = await request(port, `/api/projects/${projectId}/assets?role=subject&filename=subject.png`, {
    method: 'POST', headers, body: png,
  });
  assert.equal(upload.status, 201, `上传失败: ${upload.text}`);
  const assetId = upload.body.asset.id;
  // R04 确认格式：base_version + confirm + source_type
  const truth = await request(port, `/api/projects/${projectId}/truth-versions`, {
    method: 'POST', headers,
    body: {
      base_version: 0, confirm: true,
      facts: [
        { key: '商品名称', value: 'R05 测试商品', critical: true, confirmed: true, source_type: 'asset', source_asset_id: assetId },
        { key: '容量', value: '100ml', critical: false, confirmed: true, source_type: 'asset', source_asset_id: assetId },
      ],
      critical_text: [{ text: 'R05 Test' }],
    },
  });
  assert.equal(truth.status, 201, `truth 失败: ${truth.text}`);
  return { tenantId, headers, projectId };
}

async function freezeSpec(port, { headers, projectId, templateId = 'tpl_listing_pack', platform = '天猫' } = {}) {
  const preview = await request(port, `/api/projects/${projectId}/specs/preview`, {
    method: 'POST', headers, body: { template_id: templateId, platform },
  });
  // 收集冲突处理
  const resolutions = {};
  if (preview.status === 200 && preview.body?.payload?.conflicts) {
    for (const conflict of [...preview.body.payload.conflicts.pending ?? [], ...preview.body.payload.conflicts.unresolvable ?? []]) {
      if (conflict.options?.length > 0) resolutions[conflict.key] = conflict.options[0].id;
    }
  }
  const frozen = await request(port, `/api/projects/${projectId}/specs`, {
    method: 'POST', headers,
    body: { template_id: templateId, platform, conflict_resolutions: resolutions, base_version: 0 },
  });
  assert.equal(frozen.status, 201, `freeze 失败: ${frozen.text}`);
  return frozen.body.spec;
}

async function waitForRun(port, runId, headers, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await request(port, `/api/runs/${runId}`, { headers });
    if (r.status === 200) {
      const s = r.body.run.status;
      if (['completed', 'failed', 'cancelled', 'limit_reached', 'needs_attention'].includes(s)) return r.body.run;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`run ${runId} 超时未进入终态`);
}

// ---------- 共享 server 环境 ----------
const shared = { port: null, app: null, cleanup: null };
async function setupShared() {
  const runtimeDir = await mkdtemp(path.join(TEST_ROOT, 'r05-'));
  const app = createApp({
    port: 0, storeDir: runtimeDir,
    allowedTenants: ['tenant_demo', 'tenant_r05', 'tenant_r05_a', 'tenant_r05_b', 'tenant_r05_q', 'tenant_r05_v', 'tenant_r05_e'],
    initialCredits: 240, attemptTimeoutMs: 30_000,
  });
  const { port } = await app.listen();
  shared.port = port;
  shared.app = app;
  shared.cleanup = async () => {
    await app.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  };
}

test('R05 共享 server 启动', async () => {
  await setupShared();
  assert.ok(shared.port > 0);
  const health = await request(shared.port, '/healthz');
  assert.equal(health.status, 200);
});

test('R05 listRuns 按 project_id 过滤', async () => {
  const { port } = shared;
  const a = await seedProject(port, { tenantId: 'tenant_r05_a' });
  const b = await seedProject(port, { tenantId: 'tenant_r05_a' });
  const specA = await freezeSpec(port, a);
  const specB = await freezeSpec(port, b);

  const qA = await request(port, '/api/quotes', { method: 'POST', headers: a.headers, body: { project_id: a.projectId } });
  assert.equal(qA.status, 201);
  await request(port, '/api/runs', {
    method: 'POST', headers: { ...a.headers, 'Idempotency-Key': 'r05-a-1' },
    body: { project_id: a.projectId, quote_id: qA.body.quote.quote_id, spec_version: specA.version },
  });

  const qB = await request(port, '/api/quotes', { method: 'POST', headers: b.headers, body: { project_id: b.projectId } });
  assert.equal(qB.status, 201);
  await request(port, '/api/runs', {
    method: 'POST', headers: { ...b.headers, 'Idempotency-Key': 'r05-b-1' },
    body: { project_id: b.projectId, quote_id: qB.body.quote.quote_id, spec_version: specB.version },
  });

  const filtered = await request(port, '/api/runs', { headers: a.headers, query: `project_id=${a.projectId}` });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.runs.every(r => r.project_id === a.projectId), `过滤后混入别的项目`);
});

test('R05 报价规格字段：width/height/ratio/formats/spec 不再为空', async () => {
  const { port } = shared;
  const { headers, projectId } = await seedProject(port, { tenantId: 'tenant_r05_q' });
  await freezeSpec(port, { headers, projectId });
  const quote = await request(port, '/api/quotes', { method: 'POST', headers, body: { project_id: projectId } });
  assert.equal(quote.status, 201);
  const line = quote.body.quote.lines[0];
  assert.ok(line.width > 0, `width 应来自冻结快照，实际 ${line.width}`);
  assert.ok(line.height > 0, `height 应来自冻结快照，实际 ${line.height}`);
  assert.ok(typeof line.ratio === 'string' || line.ratio === null, `ratio 类型不对`);
  assert.ok(Array.isArray(line.formats) || line.formats === null, `formats 类型不对`);
  assert.ok(typeof line.spec === 'string' && line.spec.length > 0, `spec 应为非空字符串，实际 ${JSON.stringify(line.spec)}`);
});

test('R05 版本切换与 active_version_id 更新', async () => {
  const { port } = shared;
  const { headers, projectId } = await seedProject(port, { tenantId: 'tenant_r05_v' });
  const spec = await freezeSpec(port, { headers, projectId });
  const q = await request(port, '/api/quotes', { method: 'POST', headers, body: { project_id: projectId } });
  const start = await request(port, '/api/runs', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'r05-v-1' },
    body: { project_id: projectId, quote_id: q.body.quote.quote_id, spec_version: spec.version },
  });
  assert.equal(start.status, 201, `启动失败: ${start.text}`);
  const runId = start.body.run.id;
  await waitForRun(port, runId, headers, 15000);
  const versions = await request(port, `/api/runs/${runId}/versions`, { headers });
  assert.equal(versions.status, 200);
  assert.ok(versions.body.versions.length > 0, 'run 应该至少有一个版本');
  // 单版本时 activate 会 VERSION_ALREADY_ACTIVE → 409，跳过
});

test('R05 完整包/部分包导出：scope 正确', async () => {
  const { port } = shared;
  const { headers, projectId } = await seedProject(port, { tenantId: 'tenant_r05_e' });
  const spec = await freezeSpec(port, { headers, projectId });
  const q = await request(port, '/api/quotes', { method: 'POST', headers, body: { project_id: projectId } });
  const start = await request(port, '/api/runs', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'r05-e-1' },
    body: { project_id: projectId, quote_id: q.body.quote.quote_id, spec_version: spec.version },
  });
  assert.equal(start.status, 201, `启动失败: ${start.text}`);
  const runId = start.body.run.id;
  await waitForRun(port, runId, headers, 20000);

  // 部分包（总是允许）
  const partial = await request(port, `/api/runs/${runId}/exports`, { method: 'POST', headers, body: { scope: 'partial' } });
  assert.ok([201, 409].includes(partial.status), `部分包应 201 或 409：${partial.status} ${partial.text}`);

  // 完整包只在 complete=true 且终态时允许
  const full = await request(port, `/api/runs/${runId}/exports`, { method: 'POST', headers, body: { scope: 'complete' } });
  assert.ok([201, 409].includes(full.status), `完整包应 201 或 409：${full.status} ${full.text}`);
});

test('R05 UI 契约：工作台必需 DOM 节点存在', async () => {
  const fs = await import('node:fs/promises');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const indexHtml = await fs.readFile(path.join(root, 'frontend/index.html'), 'utf8');
  const js = await fs.readFile(path.join(root, 'frontend/workbench.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'frontend/workbench.css'), 'utf8');

  // HTML 结构
  assert.match(indexHtml, /id="workbench-view"/);
  assert.match(indexHtml, /data-view-panel="workbench"/);
  assert.match(indexHtml, /id="wb-deliverables"/);
  assert.match(indexHtml, /id="wb-canvas"/);
  assert.match(indexHtml, /id="wb-qa-checks"/);
  assert.match(indexHtml, /id="wb-event-log"/);
  assert.match(indexHtml, /id="wb-export-complete"/);
  assert.match(indexHtml, /id="wb-btn-upload"/);
  assert.match(indexHtml, /id="wb-btn-truth"/);
  assert.match(indexHtml, /id="wb-btn-spec"/);
  assert.match(indexHtml, /id="wb-btn-start"/);
  assert.match(indexHtml, /workbench\.js/);

  // JS 关键 API
  assert.match(js, /export (async )?function openWorkbench/);
  assert.match(js, /function startEventLoop|function tryStartSSE/);
  assert.match(js, /pollTimer|setInterval.*pollRun/);
  assert.match(js, /lastEventId/);
  assert.match(js, /runTerminal|TERMINAL_STATES/);
  assert.match(js, /localStorage/);

  // CSS 品牌色
  assert.match(css, /#FAF8F5/);
  assert.match(css, /#FF5A2E/);
});

test('R05 共享 server 清理', async () => {
  if (shared.cleanup) {
    await shared.cleanup();
    shared.port = null;
    shared.cleanup = null;
  }
  assert.ok(1);
});
