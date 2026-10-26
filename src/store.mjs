import path from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';

/**
 * M03 持久化：原生 JSON 文件 + 文件体（blob）目录，零依赖。
 * - 读操作返回结构化克隆，调用方无法绕过 store 修改内存数据。
 * - 写操作串行化并在临时文件上原子替换，避免部分写入。
 * - 写失败时内存与磁盘都保持上一个已提交状态。
 */
const EMPTY_DATA = () => ({ schema_version: 1, projects: {}, assets: {}, truth_versions: {} });

function normalize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('存储结构无效');
  if (raw.schema_version !== 1) throw new Error('存储版本不支持');
  const data = EMPTY_DATA();
  for (const key of ['projects', 'assets', 'truth_versions']) {
    const table = raw[key];
    if (table === undefined) continue;
    if (table === null || typeof table !== 'object' || Array.isArray(table)) throw new Error('存储结构无效');
    data[key] = table;
  }
  return data;
}

export function createStore({ dir } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new Error('存储目录无效');
  const base = path.resolve(dir);
  const dataFile = path.join(base, 'data.json');
  const blobDir = path.join(base, 'blobs');
  let data = null;
  let queue = Promise.resolve();
  let initializing = null;

  async function persist(snapshot) {
    const temporary = `${dataFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    try {
      await rename(temporary, dataFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function init() {
    if (data) return;
    if (initializing) return initializing;
    initializing = (async () => {
      await mkdir(blobDir, { recursive: true });
      try {
        data = normalize(JSON.parse(await readFile(dataFile, 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('存储文件读取失败');
        data = EMPTY_DATA();
        await persist(data);
      }
    })();
    try {
      await initializing;
    } finally {
      initializing = null;
    }
  }

  return {
    dir: base,
    init,
    async read(reader) {
      await init();
      await queue;
      return reader(structuredClone(data));
    },
    async mutate(mutator) {
      await init();
      const run = queue.then(async () => {
        const draft = structuredClone(data);
        const result = await mutator(draft);
        await persist(draft);
        data = draft;
        return result;
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    async putBlob(buffer, hash, ext) {
      await init();
      const file = path.join(blobDir, `${hash}.${ext}`);
      try {
        await readFile(file);
        return file;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, buffer);
      try {
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return file;
    },
    async readBlob(hash, ext) {
      await init();
      if (!/^[0-9a-f]{64}$/.test(hash) || !/^[a-z0-9]{2,5}$/.test(ext)) return null;
      try {
        return await readFile(path.join(blobDir, `${hash}.${ext}`));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}
