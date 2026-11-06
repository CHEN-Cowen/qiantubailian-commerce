#!/usr/bin/env node
/**
 * 阶段 6 本地 LLM 桥接。
 *
 * 系统的视觉评审与修订规划 Adapter 使用自定义契约：
 *   POST { model, system, user, images?, output_schema? } -> { output, request_id, model }
 * Paratera 提供的是 OpenAI 兼容 /v1/chat/completions。本桥接只做这一层转换，
 * 让 QTB_VISUAL_REVIEW_ENDPOINT / QTB_REVISION_PLANNER_ENDPOINT 能指向真实模型。
 *
 * 约束：
 * - 只监听 loopback；不打印密钥。
 * - 模型必须输出 JSON；解析失败按 HTTP 502 返回，由上游置为检查未知，不伪造结论。
 * - 验收状态固定 not_verified：桥接通不等于效果验收。
 *
 * 用法：
 *   node scripts/stage6-llm-bridge.mjs
 *   node scripts/stage6-llm-bridge.mjs --port 4100
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(`${ROOT}.env`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const HOST = process.env.QTB_STAGE6_BRIDGE_HOST?.trim() || '127.0.0.1';
const PORT = Number(process.env.QTB_STAGE6_BRIDGE_PORT ?? 4100);
const BASE_URL = (process.env.PARATERA_BASE_URL
  || process.env.PILOTDECK_SEEDREAM_BASE_URL
  || 'https://llmapi.paratera.com/v1').replace(/\/+$/u, '');
const API_KEY = process.env.PARATERA_API_KEY?.trim() || process.env.PILOTDECK_SEEDREAM_API_KEY?.trim() || '';
const DEFAULT_MODEL = process.env.QTB_STAGE6_DEFAULT_MODEL?.trim() || 'GLM-4.6V';
const MAX_TOKENS = Number(process.env.QTB_STAGE6_MAX_TOKENS ?? 6000);
const TIMEOUT_MS = Number(process.env.QTB_STAGE6_BRIDGE_TIMEOUT_MS ?? 120_000);
const TOKEN = process.env.QTB_STAGE6_BRIDGE_TOKEN?.trim() || '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

if (HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost') {
  console.error('阶段 6 桥接只允许监听 loopback 地址');
  process.exit(1);
}
if (!API_KEY) {
  console.error('阶段 6 桥接缺少 PARATERA_API_KEY 或 PILOTDECK_SEEDREAM_API_KEY');
  process.exit(1);
}

const MODELS = Object.freeze({
  review: process.env.QTB_STAGE6_REVIEW_MODEL?.trim() || DEFAULT_MODEL,
  plan: process.env.QTB_STAGE6_PLAN_MODEL?.trim() || DEFAULT_MODEL,
});

/** 从模型输出中提取第一个完整 JSON 对象；容忍代码围栏与前后解释。 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const source = text.replace(/```(?:json)?/giu, '').trim();
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

const OCR_SYSTEM = `你是一个精确的图片文字提取工具。请仔细查看图片，提取所有可见文字。

返回 JSON 格式：
{"lines":[{"text":"提取的文字","confidence":0.95}]}

规则：
1. 提取图片中所有可见文字，包括商品上的文字、标签、水印、背景文字等；
2. confidence 取值 0-1，清晰可读给 0.9-1.0，模糊不清给 0.3-0.7；
3. 每行文字单独一条记录；
4. 如果图片中没有文字，返回 {"lines":[]}；
5. 只输出 JSON，不要解释。`;

const REVIEW_RULES = `
评审输出还必须满足以下服务端语义校验，违反任意一条都会被整体拒绝：
1. image_bindings 中的八个检查码各出现一次，不得重复替代遗漏。
2. reference_image_ids 只能引用实际送入的参考图；禁止把 candidate 自己当成商品一致性依据。
3. status 为 fail 或 unknown 时，suggested_fix 必须是非空字符串；unknown 还必须在 unknown_reasons 里列出具体原因。
4. 没有参考图时，商品对照类检查（PRODUCT_IDENTITY、SKU_MATCH、PRODUCT_COLOR）不得给出 pass。
5. not_applicable 只能用于确实不适用的检查，不能用来绕过关键商品检查。`;

function buildMessages({ kind, system, user, images = [], outputSchema = null }) {
  const schemaNote = outputSchema
    ? `\n\n必须严格按以下 JSON Schema 输出，只输出 JSON 本身，不要解释、不要 Markdown：\n${JSON.stringify(outputSchema)}`
    : '\n\n只输出 JSON 本身，不要解释。';
  const ruleNote = kind === 'review' ? REVIEW_RULES : '';
  const messages = [];
  if (typeof system === 'string' && system.trim()) {
    messages.push({ role: 'system', content: `${system}${ruleNote}${schemaNote}` });
  }
  const userText = typeof user === 'string' ? user : JSON.stringify(user ?? {});
  const content = [{ type: 'text', text: `${userText}${typeof system === 'string' && system.trim() ? '' : schemaNote}` }];
  for (const image of images) {
    if (!image?.image_base64) continue;
    const mime = image.mime || 'image/jpeg';
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${image.image_base64}` },
    });
  }
  messages.push({ role: 'user', content });
  return messages;
}

async function callParatera({ model, messages, path }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      console.error(`[bridge] ${path} 模型调用失败 HTTP ${response.status}（${latencyMs}ms）`);
      return { status: response.status, latency_ms: latencyMs, error: raw.slice(0, 500) };
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { return { status: 502, latency_ms: latencyMs, error: '供应商返回非 JSON' }; }
    const content = payload?.choices?.[0]?.message?.content ?? '';
    const output = extractJson(content);
    console.log(`[bridge] ${path} model=${payload?.model ?? model} ${latencyMs}ms tokens=${payload?.usage?.total_tokens ?? '?'} json=${output ? 'ok' : 'invalid'}`);
    if (!output) {
      return { status: 502, latency_ms: latencyMs, error: `模型未输出合法 JSON（content 长度 ${String(content).length}）` };
    }
    return {
      status: 200,
      latency_ms: latencyMs,
      body: {
        output,
        request_id: payload?.request_id ?? payload?.id ?? null,
        model: payload?.model ?? model,
        provider: 'paratera',
        usage: payload?.usage ?? null,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error?.name === 'AbortError' ? `调用超过 ${TIMEOUT_MS}ms` : (error?.message ?? 'UNKNOWN_ERROR');
    console.error(`[bridge] ${path} 调用异常：${message}`);
    return { status: error?.name === 'AbortError' ? 504 : 502, latency_ms: latencyMs, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function send(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  res.end(bytes);
}

async function readJson(req) {
  if (req.headers.authorization && TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return { status: 403, error: '桥接令牌不匹配' };
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { status: 413, error: '请求体过大' };
    chunks.push(chunk);
  }
  try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { status: 400, error: '请求体必须是 JSON' }; }
}

const server = http.createServer(async (req, res) => {
  const path = req.url?.split('?')[0] ?? '';
  if (req.method === 'GET' && path === '/healthz') {
    send(res, 200, {
      status: 'ok',
      service: 'qtb-stage6-llm-bridge',
      mode: 'paratera-openai-bridge',
      acceptance: 'not_verified',
      models: { ...MODELS, ocr: MODELS.review },
      base_url: BASE_URL,
    });
    return;
  }
  if (req.method !== 'POST' || (path !== '/review' && path !== '/plan' && path !== '/ocr')) {
    send(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  const parsed = await readJson(req);
  if (parsed.status) { send(res, parsed.status, { error: parsed.error }); return; }
  const { body } = parsed;

  if (path === '/ocr') {
    const model = (typeof body?.model === 'string' && body.model.trim()) ? body.model.trim() : MODELS.review;
    const imageBase64 = typeof body?.image_base64 === 'string' ? body.image_base64 : '';
    const mime = typeof body?.mime === 'string' ? body.mime : 'image/jpeg';
    if (!imageBase64) { send(res, 400, { error: '缺少 image_base64' }); return; }
    const messages = [
      { role: 'system', content: OCR_SYSTEM },
      { role: 'user', content: [
        { type: 'text', text: '请提取这张图片中的所有文字。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
      ]},
    ];
    const result = await callParatera({ model, messages, path });
    if (result.status !== 200) {
      send(res, result.status, { error: result.error, latency_ms: result.latency_ms });
      return;
    }
    const output = result.body.output;
    send(res, 200, {
      lines: Array.isArray(output?.lines) ? output.lines : [],
      engine: result.body.model ?? model,
      request_id: result.body.request_id,
      usage: result.body.usage,
      latency_ms: result.latency_ms,
    });
    return;
  }

  const kind = path === '/review' ? 'review' : 'plan';
  const model = (typeof body?.model === 'string' && body.model.trim()) ? body.model.trim() : MODELS[kind];
  const messages = buildMessages({
    kind,
    system: body?.system,
    user: body?.user,
    images: kind === 'review' ? (Array.isArray(body?.images) ? body.images : []) : [],
    outputSchema: body?.output_schema ?? null,
  });
  const result = await callParatera({ model, messages, path });
  if (result.status !== 200) {
    send(res, result.status, { error: result.error, latency_ms: result.latency_ms });
    return;
  }
  send(res, 200, { ...result.body, latency_ms: result.latency_ms });
});

server.listen(PORT, HOST, () => {
  console.log(`阶段 6 LLM 桥接已启动：http://${HOST}:${PORT}（评审模型 ${MODELS.review}，规划模型 ${MODELS.plan}）`);
  console.log('验收状态：not_verified —— 桥接通只代表可调用，效果仍需人工对照');
});

const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
