import { fork } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { healthcheck } from './healthcheck.mjs';
import { loadConfig } from '../src/config.mjs';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function runSmoke(env = process.env) {
  const port = env.PORT === undefined ? await reservePort() : loadConfig({ ...env, HOST: '127.0.0.1' }).port;
  const child = fork(fileURLToPath(new URL('./start.mjs', import.meta.url)), [], {
    env: { ...env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-4_096); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-4_096); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let timer;
  try {
    const ready = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('子进程启动超时')), 8_000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('子进程在就绪前退出')));
      child.on('message', message => { if (message?.type === 'ready') resolve(message); });
    });
    clearTimeout(timer);
    if (ready.port !== port) throw new Error('子进程端口不匹配');
    await healthcheck(`http://127.0.0.1:${ready.port}`);
    // Windows 不支持向子进程投递原生 SIGTERM，通过 IPC 进入同一信号处理器。
    if (process.platform === 'win32') child.send({ type: 'signal', signal: 'SIGTERM' });
    else if (!child.kill('SIGTERM')) throw new Error('SIGTERM 发送失败');
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('子进程关闭超时')), 6_000); }),
    ]);
    if (result.code !== 0 || result.signal) throw new Error('子进程非正常退出');
    return { port: ready.port, code: result.code };
  } catch (error) {
    throw new Error(`${error.message}${output ? '（子进程检查未通过）' : ''}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await runSmoke(); console.log(`真实启动、HTTP 探测与 SIGTERM 处理通过，端口 ${result.port}`); }
  catch (error) { console.error(`冒烟检查失败：${error.message}`); process.exitCode = 1; }
}
