import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/server.mjs';
import { createProvider } from '../src/provider.mjs';

// 公网试用与本机账户、素材和外部服务完全分开；不读取 .env。
process.env.NODE_ENV = 'production';
process.env.QTB_PAYMENT_PROVIDER = 'none';
process.env.QTB_ENABLE_REAL_PAYMENTS = '0';
process.env.QTB_PROVIDER = 'mock';
for (const key of ['QTB_OCR_ENDPOINT', 'QTB_OCR_API_KEY', 'QTB_OCR_MODEL']) delete process.env[key];

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'runtime', 'share-demo');
const staticRoot = path.join(directory, 'frontend');
await mkdir(directory, { recursive: true });
await cp(path.join(root, 'frontend'), staticRoot, { recursive: true });
const indexPath = path.join(staticRoot, 'index.html');
const html = await readFile(indexPath, 'utf8');
const banner = '<aside class="share-demo-banner">千图百炼 · 功能演示：背景为模拟图，商品与文字在本地合成；不调用付费 AI，不开放收款。请注册自己的演示账户。</aside>';
await writeFile(indexPath, html.replace('</head>', '<style>.share-demo-banner{position:fixed;inset:0 0 auto;z-index:20000;padding:10px 16px;background:#fff2d6;color:#644510;font:13px/1.5 system-ui;text-align:center;box-shadow:0 1px 4px #0001}body{padding-top:42px}.wb-check-body{min-width:0;overflow-wrap:anywhere}</style></head>').replace('<body>', '<body>' + banner));

const base = createProvider();
const requests = new Map();
const capabilities = () => ({ ...base.capabilities(), supports_mask: false, supports_post_composite: true });
const provider = {
  ...base, capabilities,
  submit(request) {
    const handle = base.submit(request);
    requests.set(handle.provider_job_id, request);
    return handle;
  },
  async poll(handle) {
    const result = await base.poll(handle);
    if (result.status !== 'succeeded') return result;
    const request = requests.get(handle.provider_job_id);
    if (!request) throw new Error('演示调用上下文不存在');
    // shortcut: 只演示任务、排版和交付流程；接入经授权的真实模型后替换此模拟背景。
    const bytes = await sharp(result.result.output.bytes).resize(request.target_width, request.target_height).png().toBuffer();
    return { ...result, result: { ...result.result, model: 'demo-background-not-ai', output: {
      ...result.result.output, bytes, width: request.target_width, height: request.target_height,
      format: 'png', sha256: createHash('sha256').update(bytes).digest('hex'), downscaled: false,
    } } };
  },
};

const app = createApp({ host: '127.0.0.1', port: Number(process.env.QTB_SHARE_DEMO_PORT ?? 3221),
  storeDir: path.join(directory, 'data'), staticRoot, initialCredits: 0, demoMode: false,
  secureCookies: true, provider, emailRecoveryConfigured: false, maxConcurrency: 2,
  providerMaxConcurrency: 2, tenantMaxConcurrency: 1, maxUploadBytes: 8 * 1024 * 1024 });
const address = await app.listen();
console.log(`Share demo listening on http://127.0.0.1:${address.port}; payments disabled; simulated images only`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); });
