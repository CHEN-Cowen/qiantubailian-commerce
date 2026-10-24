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
const files = ['frontend/app.js', 'plugins/seedream/server.mjs'].map(name => path.join(root, name));
for (const directory of ['src', 'scripts', 'test']) files.push(...await enumerate(path.join(root, directory)));
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error || result.status !== 0) { process.exitCode = 1; break; }
}
if (!process.exitCode) console.log(`语法检查通过：${files.length} 个文件`);
