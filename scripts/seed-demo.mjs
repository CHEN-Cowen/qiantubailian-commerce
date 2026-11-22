/**
 * 演示数据种子：在独立数据目录里生成一个"可直接打开工作台"的示例商品项目。
 *
 * 存在的理由：工作台视图只接受真实 projectId（/api/projects/:id 及其素材、事实、
 * 规格、任务），空数据目录下一个项目都没有，截图与人工验收只能看到空态，
 * 无法覆盖工作台本体。这里用真实 HTTP 接口把项目、主体图、商品事实、冻结规格
 * 一次性造好，数据落在独立目录，不污染 runtime/ 的正式数据。
 *
 * 不会调用真实模型，也不产生任何真实扣款；素材是本地合成的占位图，
 * 或用 --image 指定的本地真实样片。
 *
 * 运行：
 *   node scripts/seed-demo.mjs
 *   node scripts/seed-demo.mjs --image "E:/path/to/subject.png"
 *   node scripts/seed-demo.mjs --data-dir runtime/demo-data --reset
 *
 * 之后：
 *   QTB_DATA_DIR=runtime/demo-data PORT=3210 node scripts/start.mjs
 *   打开 http://127.0.0.1:3210/#projects 点「演示：舒缓面霜」
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO_SKU = 'DEMO-001';
const DEMO_NAME = '演示：舒缓面霜';
const DEMO_CATEGORY = '面霜';
const DEMO_PLATFORM = '天猫';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const has = name => args.includes(`--${name}`);

const dataDir = path.resolve(ROOT, option('data-dir', 'runtime/demo-data'));
const imagePath = option('image', null);

if (has('reset')) {
  const relative = path.relative(path.join(ROOT, 'runtime'), dataDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    console.error('--reset 只允许清理 runtime/ 下的数据目录，已拒绝：' + dataDir);
    process.exit(1);
  }
  await rm(dataDir, { recursive: true, force: true });
  console.log(`已清空 ${path.relative(ROOT, dataDir)}`);
}

async function demoSubjectPng() {
  if (imagePath) {
    const bytes = await readFile(path.resolve(imagePath));
    console.log(`使用本地样片：${imagePath}`);
    return bytes;
  }
  const { default: sharp } = await import('sharp');
  // 1080x1440 浅紫底 + 中央瓶身色块：仅用于占位，不代表真实商品外观
  return sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#F5F0FF' } })
    .composite([{
      input: await sharp({ create: { width: 320, height: 620, channels: 3, background: '#5A00D6' } })
        .png().toBuffer(),
      left: 380, top: 470,
    }])
    .png().toBuffer();
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  const app = createApp({
    port: 0,
    storeDir: dataDir,
    tickMs: 10,
    // 演示身份：非生产环境默认开启，写接口无需登录；不产生真实收款
    demoMode: true,
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, json: type.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : null };
  };

  try {
    const existing = (await request('/api/projects')).json?.projects ?? [];
    const duplicate = existing.find(project => project.sku.toLowerCase() === DEMO_SKU.toLowerCase());
    if (duplicate) {
      console.log(`示例项目已存在，直接复用（加 --reset 可重建）`);
      console.log(`  项目：${duplicate.name} · ${duplicate.id}`);
      return duplicate.id;
    }

    const created = await request('/api/projects', {
      method: 'POST',
      body: { name: DEMO_NAME, sku: DEMO_SKU, category: DEMO_CATEGORY, platform: DEMO_PLATFORM },
    });
    if (created.status !== 201) throw new Error(`建项目失败 ${created.status}：${JSON.stringify(created.json)}`);
    const project = created.json.project;

    const uploaded = await request(
      `/api/projects/${project.id}/assets?role=subject&filename=demo-subject.png`,
      { method: 'POST', body: await demoSubjectPng(), headers: { 'Content-Type': 'image/png' } },
    );
    if (uploaded.status !== 201) throw new Error(`上传素材失败 ${uploaded.status}：${JSON.stringify(uploaded.json)}`);

    const truth = await request(`/api/projects/${project.id}/truth-versions`, {
      method: 'POST',
      body: {
        base_version: 0,
        confirm: true,
        facts: [
          { key: '容量', value: '50g', critical: true, confirmed: true, source_type: 'user_input' },
          { key: '核心卖点', value: '舒缓维稳', critical: false, confirmed: true, source_type: 'user_input' },
          { key: '适用肤质', value: '敏感肌', critical: false, confirmed: true, source_type: 'user_input' },
        ],
        critical_text: [{ text: '月光舒缓' }],
      },
    });
    if (truth.status !== 201) throw new Error(`写入商品事实失败 ${truth.status}：${JSON.stringify(truth.json)}`);

    const preview = await request(`/api/projects/${project.id}/specs/preview`, {
      method: 'POST',
      body: { template_id: 'tpl_listing_pack', platform: DEMO_PLATFORM },
    });
    if (preview.status !== 200) throw new Error(`规格预览失败 ${preview.status}：${JSON.stringify(preview.json)}`);
    const resolutions = {};
    for (const conflict of [
      ...(preview.json.payload?.conflicts?.pending ?? []),
      ...(preview.json.payload?.conflicts?.unresolvable ?? []),
    ]) {
      if (conflict.options?.length > 0) resolutions[conflict.key] = conflict.options[0].id;
    }
    const frozen = await request(`/api/projects/${project.id}/specs`, {
      method: 'POST',
      body: {
        template_id: 'tpl_listing_pack',
        platform: DEMO_PLATFORM,
        conflict_resolutions: resolutions,
        base_version: 0,
      },
    });
    if (frozen.status !== 201) throw new Error(`冻结规格失败 ${frozen.status}：${JSON.stringify(frozen.json)}`);

    console.log('示例项目已就绪：');
    console.log(`  项目：${DEMO_NAME} · ${project.id}`);
    console.log(`  数据目录：${path.relative(ROOT, dataDir)}`);
    console.log(`  主体素材：1 张${imagePath ? '（本地样片）' : '（合成占位图）'}，商品事实 1 版，规格已冻结`);
    return project.id;
  } finally {
    await app.close();
  }
}

const projectId = await main();
console.log('');
console.log('启动服务后打开商品项目列表，即可进入工作台：');
console.log(`  QTB_DATA_DIR="${path.relative(ROOT, dataDir).replace(/\\/g, '/')}" PORT=3210 node scripts/start.mjs`);
console.log('  http://127.0.0.1:3210/#projects');
console.log(`  （项目 ID：${projectId}）`);
