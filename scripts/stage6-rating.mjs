/**
 * 阶段 6 人工盲评本地页。
 *
 * 只服务三样东西：评分页、匿名候选图、商品原图。
 * 不暴露 blind-key.json / candidates.json / 任务报告，评分人看不到臂标识。
 * 每次保存直接写回 docs/ai-development/stage6/blind-rating-sheet.csv，
 * 口径：missed_detection / false_alarm 由揭盲后分析者填写，评分页不采集。
 *
 * 用法：node scripts/stage6-rating.mjs [--stamp real-2026-11-06b] [--port 4173]
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './ai-eval.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAGE6_DIR = path.resolve(ROOT, 'docs/ai-development/stage6');
const SHEET = path.join(STAGE6_DIR, 'blind-rating-sheet.csv');
const CANDIDATE_ROOT = path.resolve(ROOT, 'runtime/stage6-candidates');
const MATERIALS = path.resolve(ROOT, '../商品测试素材-12款');
const PAGE = path.resolve(ROOT, 'scripts/stage6-rating.html');

const argv = process.argv.slice(2);
const argOf = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};

async function latestStamp() {
  const dirs = await readdir(CANDIDATE_ROOT, { withFileTypes: true });
  const candidates = [];
  for (const dir of dirs.filter(item => item.isDirectory())) {
    try {
      await readFile(path.join(CANDIDATE_ROOT, dir.name, 'candidates.json'));
      candidates.push(dir.name);
    } catch { /* 没有索引的目录不参与 */ }
  }
  candidates.sort();
  return candidates.at(-1) ?? null;
}

const STAMP = argOf('--stamp') ?? await latestStamp();
if (!STAMP) throw new Error('没有可用的候选批次，先运行 scripts/stage6-candidates.mjs');
const BLIND_DIR = path.join(CANDIDATE_ROOT, STAMP, 'blind');
const PORT = Number(argOf('--port') ?? 4173);

const COLUMNS = Object.freeze([
  'blind_id', 'case_id', 'product_id', 'product_name', 'scenario', 'image_path',
  'rating_status', 'fact_error', 'missed_detection', 'false_alarm', 'unknown',
  'quality_pass', 'direct_adoption', 'severity', 'notes',
]);

const RATING_FIELDS = Object.freeze(['fact_error', 'unknown', 'quality_pass', 'direct_adoption']);
const BINARY = new Set(['0', '1']);

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serialize(entries) {
  const lines = [COLUMNS.join(',')];
  for (const entry of entries) lines.push(COLUMNS.map(column => csvEscape(entry[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

async function loadSheet() {
  const rows = parseCsv(await readFile(SHEET, 'utf8'));
  const header = rows[0];
  if (!header?.includes('blind_id') || header.length !== COLUMNS.length) {
    throw new Error(`盲评表列数不符：期望 ${COLUMNS.length}，实际 ${header?.length}`);
  }
  return rows.slice(1).map(values => {
    const entry = {};
    COLUMNS.forEach((column, index) => { entry[column] = values[index] ?? ''; });
    return entry;
  });
}

const entries = await loadSheet();
if (entries.length !== 36) throw new Error(`盲评表应为 36 行，实际 ${entries.length}`);

const blindFiles = new Map();
for (const name of await readdir(BLIND_DIR)) {
  const id = name.split('.')[0];
  if (id) blindFiles.set(id, path.join(BLIND_DIR, name));
}

const manifest = JSON.parse(await readFile(path.join(MATERIALS, '素材清单.json'), 'utf8'));
const referenceFiles = new Map();
for (const item of manifest) {
  const productId = `P${String(item.id).padStart(2, '0')}`;
  if (['P09', 'P10', 'P11', 'P12'].includes(productId)) {
    referenceFiles.set(productId, path.join(MATERIALS, item.original_file));
  }
}

const byId = new Map(entries.map(entry => [entry.blind_id, entry]));
const publicEntry = entry => ({
  blind_id: entry.blind_id,
  case_id: entry.case_id,
  product_id: entry.product_id,
  product_name: entry.product_name,
  scenario: entry.scenario,
  rating_status: entry.rating_status,
  fact_error: entry.fact_error,
  unknown: entry.unknown,
  quality_pass: entry.quality_pass,
  direct_adoption: entry.direct_adoption,
  severity: entry.severity,
  notes: entry.notes,
});

function progress() {
  const rated = entries.filter(entry => entry.rating_status === 'rated').length;
  return { rated, total: entries.length };
}

function validate(body) {
  const entry = byId.get(String(body?.blind_id ?? ''));
  if (!entry) return { error: '未知盲号' };
  for (const field of RATING_FIELDS) {
    const value = String(body[field] ?? '');
    if (!BINARY.has(value)) return { error: `${field} 必须选择 0 或 1` };
  }
  const severity = String(body.severity ?? '');
  if (severity && !['1', '2', '3', '4'].includes(severity)) return { error: '严重度必须为 1—4' };
  const notes = String(body.notes ?? '').trim();
  if (notes.length > 400) return { error: '备注最多 400 字' };
  const needsNote = body.fact_error === '1' || body.unknown === '1' || body.quality_pass === '0';
  if (needsNote && notes.length === 0) return { error: '存在事实错误/无法判断/画质不合格时必须写备注' };
  return { entry, severity, notes };
}

async function handleRate(body) {
  const checked = validate(body);
  if (checked.error) return { status: 400, json: { error: checked.error } };
  const entry = checked.entry;
  for (const field of RATING_FIELDS) entry[field] = String(body[field]);
  entry.severity = checked.severity;
  entry.notes = checked.notes;
  entry.rating_status = 'rated';
  await writeFile(SHEET, serialize(entries), 'utf8');
  return { status: 200, json: { entry: publicEntry(entry), progress: progress() } };
}

const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function sendFile(res, file) {
  readFile(file)
    .then(bytes => {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      res.end(bytes);
    })
    .catch(() => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'NOT_FOUND' })); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const route = url.pathname;
  const json = (status, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    res.end(bytes);
  };

  if (req.method === 'GET' && route === '/') {
    readFile(PAGE).then(bytes => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      res.end(bytes);
    }).catch(() => json(500, { error: 'PAGE_MISSING' }));
    return;
  }
  if (req.method === 'GET' && route === '/api/state') {
    json(200, { stamp: STAMP, progress: progress(), entries: entries.map(publicEntry) });
    return;
  }
  if (req.method === 'GET' && route.startsWith('/blind/')) {
    const id = route.slice('/blind/'.length).split('.')[0];
    const file = blindFiles.get(id);
    if (!file) { json(404, { error: 'NOT_FOUND' }); return; }
    sendFile(res, file);
    return;
  }
  if (req.method === 'GET' && route.startsWith('/reference/')) {
    const productId = route.slice('/reference/'.length);
    const file = referenceFiles.get(productId);
    if (!file) { json(404, { error: 'NOT_FOUND' }); return; }
    sendFile(res, file);
    return;
  }
  if (req.method === 'POST' && route === '/api/rate') {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 4_096) req.destroy();
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { json(400, { error: 'BAD_JSON' }); return; }
      handleRate(body)
        .then(result => json(result.status, result.json))
        .catch(() => json(500, { error: 'SAVE_FAILED' }));
    });
    return;
  }
  json(404, { error: 'NOT_FOUND' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`阶段 6 盲评页：http://127.0.0.1:${PORT}/`);
  console.log(`批次 ${STAMP}；已评分 ${progress().rated}/${entries.length}`);
  console.log('评分页不暴露臂映射；missed_detection / false_alarm 留待揭盲后分析者填写。');
});
