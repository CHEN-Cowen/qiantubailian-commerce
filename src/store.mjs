import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';

/**
 * M03 持久化：原生 JSON 文件 + 文件体（blob）目录，零依赖。
 * - 读操作返回结构化克隆，调用方无法绕过 store 修改内存数据。
 * - 写操作串行化并在临时文件上原子替换，避免部分写入。
 * - 写失败时内存与磁盘都保持上一个已提交状态。
 */
const TABLES = Object.freeze([
  'projects', 'assets', 'truth_versions', 'brand_kits', 'brand_kit_versions', 'specs',
  // M05：报价、任务与事件（attempt 内嵌于 run）、额度账户与只增台账
  'quotes', 'runs', 'events', 'credit_accounts', 'credit_entries',
  // M06：生成记录（模型、请求、用量、成本、版本与输出哈希），只增不改
  'generation_records',
  // M07：Commerce QA 报告（检查项、证据、机器结论与人工复核），只增不改
  'quality_reports',
  // M08：正式导出记录（清单、摘要、包哈希），只增不改
  'exports',
  // M09：授权评测集、评测报告与模型候选（冠军由当前 Provider 决定）
  'eval_dataset_items', 'eval_reports', 'model_candidates', 'model_routing',
]);
const EMPTY_DATA = () => ({
  schema_version: 1,
  projects: {}, assets: {}, truth_versions: {}, brand_kits: {}, brand_kit_versions: {}, specs: {},
  quotes: {}, runs: {}, events: {}, credit_accounts: {}, credit_entries: {}, generation_records: {},
  quality_reports: {}, exports: {},
  eval_dataset_items: {}, eval_reports: {}, model_candidates: {}, model_routing: {},
});

function normalize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('存储结构无效');
  if (raw.schema_version !== 1) throw new Error('存储版本不支持');
  const data = EMPTY_DATA();
  for (const key of TABLES) {
    const table = raw[key];
    if (table === undefined) continue;
    if (table === null || typeof table !== 'object' || Array.isArray(table)) throw new Error('存储结构无效');
    data[key] = table;
  }
  assertTableKeys(data);
  return data;
}

/**
 * 表主键必须是非空字符串。
 * 这一道防线是为了拦住"用对象里不存在的字段当主键"这类错误：
 * 一旦主键是 undefined，所有记录会写到同一个键上，表看起来有数据，
 * 落盘后却只剩最后一条，很难从表面症状定位。
 */
function assertTableKeys(data) {
  for (const table of TABLES) {
    const rows = data[table];
    if (!rows || typeof rows !== 'object') continue;
    for (const key of Object.keys(rows)) {
      if (typeof key !== 'string' || key === '' || key === 'undefined' || key === 'null') {
        throw new Error(`表 ${table} 存在非法主键：${String(key)}`);
      }
    }
  }
}

export function createStore({ dir } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new Error('存储目录无效');
  const base = path.resolve(dir);
  const dataFile = path.join(base, 'data.json');
  const blobDir = path.join(base, 'blobs');
  let data = null;
  let queue = Promise.resolve();
  let initializing = null;

  // 临时文件名每次写入都带唯一随机后缀：并发写入不会抢占同一个临时文件，
  // 错误分支的清理也不会误删别人正在写的临时文件
  const tempTag = `${process.pid}.${randomBytes(4).toString('hex')}`;
  let tempCounter = 0;

  const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

  /**
   * Windows 上对同一文件的高频写入偶尔会返回 EPERM/ENOENT（杀毒软件或索引器
   * 短暂占用文件句柄）。这类错误是瞬时的，重试即可恢复；不做重试会让一次
   * 无关的写失败把整条业务链打断。
   */
  const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'EAGAIN']);

  async function persist(snapshot) {
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
    const temporary = `${dataFile}.${tempTag}.${tempCounter += 1}.tmp`;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await writeFile(temporary, payload, 'utf8');
        await rename(temporary, dataFile);
        return;
      } catch (error) {
        lastError = error;
        await rm(temporary, { force: true }).catch(() => {});
        if (!TRANSIENT_CODES.has(error.code)) throw error;
        await sleep(15 * (attempt + 1));
      }
    }
    throw lastError;
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
    /**
     * 等待所有排队中的写入完成。
     * 关闭服务或删除数据目录前必须调用：否则正在进行的落盘会与目录清理竞态，
     * 在 Windows 上表现为删除失败或读到半截文件。
     */
    async drain() {
      await init();
      await queue;
    },
    async mutate(mutator) {
      await init();
      const run = queue.then(async () => {
        const draft = structuredClone(data);
        const result = await mutator(draft);
        assertTableKeys(draft);
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
      // 临时名同样唯一化，避免并发写同一 blob 时互相抢占
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, buffer);
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
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
