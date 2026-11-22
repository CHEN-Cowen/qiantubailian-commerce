import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function enumerate(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await enumerate(name));
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(name)) files.push(name);
  }
  return files;
}
// 裸跑 `node --test` 时，Node 按默认规则递归发现测试文件：
//   **/*.test.js、**/*-test.js、**/*_test.js、**/test-*.js、**/test.js、**/test/**/*.js
// 且只跳过 node_modules。因此仓库里一旦出现第二处 test 目录（例如运行时备份快照），
// 过期测试会被当成当前测试执行，产生与本次改动无关的假失败。这里提前拦截。
const DISCOVERY_IGNORED = new Set(['node_modules', '.git', 'scenes']);
const STRAY_TEST_FILE = /(?:\.test|-test|_test)\.(?:c|m)?js$|^test-[^/\\]+\.(?:c|m)?js$/;
async function findStrayTests(directory, relative = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (DISCOVERY_IGNORED.has(entry.name)) continue;
      // 仓库根目录的 test/ 是唯一合法测试目录，不再深入；其它层级的 test/ 一律上报
      if (relative && entry.name === 'test') { found.push(`${rel}/`); continue; }
      found.push(...await findStrayTests(path.join(directory, entry.name), rel));
    } else if (entry.isFile()) {
      if (STRAY_TEST_FILE.test(entry.name) || entry.name === 'test.js') found.push(rel);
    }
  }
  return found;
}
const strayTests = await findStrayTests(root);
if (strayTests.length) {
  console.error('以下文件会被 `node --test` 裸跑扫到，但不属于仓库根目录 test/：');
  for (const item of strayTests) console.error(`  - ${item}`);
  console.error('请把它们移出仓库或改名，否则会产生与当前代码无关的假失败。');
  process.exitCode = 1;
}

const files = ['plugins/seedream/server.mjs'].map(name => path.join(root, name));
for (const directory of ['src', 'scripts', 'test', 'frontend']) files.push(...await enumerate(path.join(root, directory)));
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error || result.status !== 0) { process.exitCode = 1; break; }
}
if (!process.exitCode) console.log(`语法检查通过：${files.length} 个文件`);
