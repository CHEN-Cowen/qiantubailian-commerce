import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

let app;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await app?.close(); }
  catch { console.error('服务关闭失败'); process.exitCode = 1; }
  if (process.connected) process.disconnect();
}

try {
  try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('环境文件加载失败'); }
  const config = loadConfig();
  app = createApp(config);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (process.send) process.on('message', message => {
    if (message?.type === 'signal' && message.signal === 'SIGTERM') process.emit('SIGTERM');
  });
  app.server.on('error', () => { console.error('服务运行失败'); process.exitCode = 1; void stop(); });
  const address = await app.listen();
  if (!stopping) {
    console.log(`M03 已启动，端口 ${address.port}`);
    if (process.send) process.send({ type: 'ready', port: address.port, host: address.address });
  } else {
    await app.close();
  }
} catch {
  console.error('M03 启动失败，请检查配置与端口');
  process.exitCode = 1;
  await stop();
}
