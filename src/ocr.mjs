/**
 * R04：可配置 OCR。默认为"未配置"，此时所有文字类结论都是 unknown，绝不用样例结果冒充识别。
 *
 * 接入方式（服务端环境变量，密钥只留服务端）：
 * - `QTB_OCR_ENDPOINT`：接收 { image_base64, mime, model } 的 HTTP 端点；
 * - `QTB_OCR_API_KEY`：以 `Authorization: Bearer <key>` 发送；
 * - `QTB_OCR_MODEL`：可选，端点要求的模型名；
 * - `QTB_OCR_TIMEOUT_MS`：可选，默认 8s。
 *
 * 端点应返回 `{ lines: [{ text, confidence, bbox? }] }`，也接受 `{ blocks: [...] }`。
 * 收到无法解析的响应时整次识别标记 error，而不是返回空数组让上层误判"图中没有文字"。
 */
export const OCR_THRESHOLD = 0.8;
export const OCR_TIMEOUT_MS = 8_000;

function normalizeLines(payload) {
  const source = Array.isArray(payload?.lines) ? payload.lines
    : Array.isArray(payload?.blocks) ? payload.blocks
      : Array.isArray(payload?.data?.lines) ? payload.data.lines
        : null;
  if (!source) return null;
  return source
    .map(item => ({
      text: typeof item?.text === 'string' ? item.text.trim() : '',
      confidence: Number.isFinite(item?.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null,
      bbox: item?.bbox ?? item?.region ?? null,
    }))
    .filter(item => item.text.length > 0);
}

export function createOcrFromEnv(env = process.env) {
  const endpoint = env.QTB_OCR_ENDPOINT ?? '';
  const apiKey = env.QTB_OCR_API_KEY ?? '';
  const model = env.QTB_OCR_MODEL ?? '';
  const timeoutMs = Number(env.QTB_OCR_TIMEOUT_MS) > 0 ? Number(env.QTB_OCR_TIMEOUT_MS) : OCR_TIMEOUT_MS;
  if (!endpoint || !apiKey) {
    return {
      configured: false,
      mode: 'not_configured',
      acceptance: 'not_available',
      note: '未配置 OCR 端点与密钥；文字类结论保持 unknown，需人工核对',
      async recognize() {
        return { status: 'unknown', reason: 'OCR_NOT_CONFIGURED', lines: [] };
      },
    };
  }
  return {
    configured: true,
    mode: 'http',
    acceptance: 'contract_only',
    note: 'OCR 已按端点配置接入；真实识别准确率需用授权样本验收',
    async recognize({ bytes, mime }) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return { status: 'error', reason: 'EMPTY_IMAGE', lines: [] };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ image_base64: bytes.toString('base64'), mime, model }),
          signal: controller.signal,
        });
        if (!response.ok) {
          return { status: 'error', reason: `HTTP_${response.status}`, lines: [] };
        }
        const payload = await response.json();
        const lines = normalizeLines(payload);
        if (!lines) return { status: 'error', reason: 'UNPARSABLE_RESPONSE', lines: [] };
        return { status: 'ok', lines, engine: payload.engine ?? model ?? 'configured' };
      } catch (error) {
        return {
          status: 'error',
          reason: error?.name === 'AbortError' ? 'TIMEOUT' : 'REQUEST_FAILED',
          lines: [],
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const squeeze = value => String(value ?? '').replace(/\s+/g, '').toLowerCase();

/**
 * 把 OCR 行变成"候选事实"，逐项待用户确认：
 * - 置信度低于阈值的条目标 `needs_evidence`；
 * - 不自动 confirmed，也不把候选写进已确认事实。
 */
export function extractionCandidates({ lines = [], assetId = null } = {}) {
  return lines.map((line, index) => {
    const confidence = line.confidence;
    const low = confidence !== null && confidence < OCR_THRESHOLD;
    return {
      candidate_id: `cand_${index + 1}`,
      key: null,
      value: line.text,
      confidence,
      bbox: line.bbox ?? null,
      source_asset_id: assetId,
      source_type: assetId ? 'asset' : 'user_input',
      needs_evidence: low || confidence === null,
      confirmed: false,
      note: low ? `置信度 ${confidence}，低于 ${OCR_THRESHOLD}，请对照原图确认或补拍`
        : confidence === null ? 'OCR 未返回置信度，需人工确认' : null,
      editable: true,
    };
  });
}

/**
 * 关键文字核对：只做"图里是否出现这段文字"的包含判断，避免把 OCR 行序差异当成错字。
 * 英文与数字按去空格小写比较，中文按原样比较。
 */
export function checkCriticalText({ criticalTexts = [], ocr = null } = {}) {
  if (!ocr || ocr.status === 'unknown') {
    return {
      status: 'unknown',
      matched: [],
      mismatched: criticalTexts.map(item => item.text),
      reason: ocr?.reason ?? 'OCR_NOT_CONFIGURED',
    };
  }
  if (ocr.status === 'error') {
    return {
      status: 'unknown',
      matched: [],
      mismatched: criticalTexts.map(item => item.text),
      reason: ocr.reason ?? 'OCR_ERROR',
      engine: ocr.engine ?? null,
    };
  }
  const haystack = squeeze(ocr.lines.map(line => line.text).join('\n'));
  const matched = [];
  const mismatched = [];
  for (const item of criticalTexts) {
    const needle = squeeze(item.text);
    if (!needle) continue;
    if (haystack.includes(needle)) matched.push(item.text);
    else mismatched.push(item.text);
  }
  return {
    status: mismatched.length === 0 ? 'pass' : 'fail',
    matched,
    mismatched,
    reason: mismatched.length === 0 ? null : 'CRITICAL_TEXT_MISMATCH',
    engine: ocr.engine ?? 'configured',
  };
}
