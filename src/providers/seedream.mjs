/**
 * M06 真实 Seedream Adapter（Paratera /v1/images/generations）。
 *
 * 契约与 src/provider.mjs 完全一致：capabilities / validate / estimate / submit / poll / cancel。
 * 关键自我约束：
 * - 没有密钥时构造即失败，绝不静默回落到模拟 Provider。
 * - 能力如实声明：Paratera 接口没有掩码参数，因此 supports_mask 默认 false；
 *   本地主体合成对齐未验收，supports_post_composite 默认 false。两者都为 false 时，
 *   需要主体保护的请求会被明确拒绝，而不是把保护悄悄丢掉。
 * - 只有真实拿到并核对过图片头字节，才产出 output；否则按供应商错误处理。
 * - 记录真实模型名、用量、时延、请求 id 与账单口径；验收状态固定为 not_verified。
 */
import { createHash, randomBytes } from 'node:crypto';
import { inspectImage } from '../images.mjs';

export const SEEDREAM_PROVIDER_ID = 'seedream';
export const SEEDREAM_ADAPTER_VERSION = 'm06.seedream.1';
export const SEEDREAM_DEFAULT_BASE_URL = 'https://llmapi.paratera.com/v1';
export const SEEDREAM_DEFAULT_MODEL = 'Doubao-Seedream-4.0';
export const SEEDREAM_MAX_SIDE = 4096;
const MAX_REFERENCES = 10;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function failure(code, message, retryable = false, extra = {}) {
  return { code, message, retryable, ...extra };
}

function mapHttpFailure(status, message) {
  const trimmed = String(message ?? '').slice(0, 500);
  if (status === 429) return failure('RATE_LIMITED', `供应商限流：${trimmed}`, true, { http_status: status });
  if (status === 401 || status === 403) {
    return failure('PROVIDER_ERROR', `供应商鉴权失败（HTTP ${status}），请检查密钥配置：${trimmed}`, false, { http_status: status });
  }
  if (status === 408 || status === 504) return failure('PROVIDER_TIMEOUT', `供应商超时：${trimmed}`, true, { http_status: status });
  if (status >= 500) return failure('PROVIDER_ERROR', `供应商内部错误：${trimmed}`, true, { http_status: status });
  if (status >= 400 && /policy|sensitive|content|安全|审核|违规/iu.test(trimmed)) {
    return failure('CONTENT_REJECTED', `供应商内容策略拒绝：${trimmed}`, false, { http_status: status });
  }
  if (status >= 400) return failure('INVALID_INPUT', `供应商拒绝请求参数：${trimmed}`, false, { http_status: status });
  return failure('PROVIDER_ERROR', `供应商返回异常状态 ${status}：${trimmed}`, true, { http_status: status });
}

/**
 * @param {object} options
 * @param {string} options.apiKey 必填，缺失直接抛错
 * @param {Function} [options.fetchImpl] 便于测试注入，生产用全局 fetch
 */
export function createSeedreamProvider({
  apiKey,
  baseUrl = process.env.PILOTDECK_SEEDREAM_BASE_URL || SEEDREAM_DEFAULT_BASE_URL,
  model = process.env.PILOTDECK_SEEDREAM_MODEL || SEEDREAM_DEFAULT_MODEL,
  supportsMask = false,
  supportsPostComposite = false,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  timeoutMs = 120_000,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Seedream Adapter 缺少密钥：请设置 PARATERA_API_KEY 或 PILOTDECK_SEEDREAM_API_KEY；没有密钥时不会回落到模拟 Provider');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Seedream Adapter 缺少 fetch 实现');
  const endpoint = `${String(baseUrl).replace(/\/+$/u, '')}/images/generations`;
  const jobs = new Map();

  function capabilities() {
    return {
      id: SEEDREAM_PROVIDER_ID,
      version: SEEDREAM_ADAPTER_VERSION,
      image: true,
      video: false,
      max_references: MAX_REFERENCES,
      supports_mask: supportsMask === true,
      supports_post_composite: supportsPostComposite === true,
      supports_async: true,
      supports_cancel: true,
      supports_seed: false,
      max_side: SEEDREAM_MAX_SIDE,
      formats: ['jpg', 'png', 'webp'],
      simulated: false,
      acceptance: 'not_verified',
      endpoint,
      model,
      note: '真实 Adapter 已接线但未用真实密钥验收；验收前不得宣称真实主体保护能力',
    };
  }

  function validate(request) {
    if (!request?.request_hash) return { ok: false, code: 'INVALID_INPUT', message: '缺少 request_hash' };
    if (request.kind === 'video') return { ok: false, code: 'UNSUPPORTED_CAPABILITY', message: 'Seedream Adapter 只支持图片' };
    const width = Number(request.target_width ?? 0);
    const height = Number(request.target_height ?? 0);
    if (width > SEEDREAM_MAX_SIDE || height > SEEDREAM_MAX_SIDE || width < 1 || height < 1) {
      return { ok: false, code: 'UNSUPPORTED_CAPABILITY', message: `目标尺寸必须在 1—${SEEDREAM_MAX_SIDE} 之间，收到 ${width}×${height}` };
    }
    if (Number(request.references ?? 0) > MAX_REFERENCES) {
      return { ok: false, code: 'UNSUPPORTED_CAPABILITY', message: `最多 ${MAX_REFERENCES} 张参考图，收到 ${request.references}` };
    }
    if (request.requires_subject_protection) {
      if (!request.mask_ref || !String(request.mask_ref).startsWith('mask:verified:')) {
        return {
          ok: false,
          code: 'UNSUPPORTED_CAPABILITY',
          message: '需要商品主体保护，但主体掩码缺失或未经像素校验；拒绝静默丢弃保护',
        };
      }
      if (!capabilities().supports_mask && !capabilities().supports_post_composite) {
        return {
          ok: false,
          code: 'UNSUPPORTED_CAPABILITY',
          message: 'Seedream Adapter 未声明掩码能力，也未声明可验收的本地主体合成；拒绝在无保护的情况下真实调用',
          details: { supports_mask: false, supports_post_composite: false },
        };
      }
    }
    return { ok: true };
  }

  function estimate() {
    return {
      price_version: 'seedream-unverified',
      estimated_credits: null,
      max_credits: null,
      uncertainty: '真实账单未接入，无法在本地给出可靠估算',
    };
  }

  function normalizeImages(referenceImages = []) {
    return referenceImages
      .filter(item => item && typeof item.data_uri === 'string' && item.data_uri.startsWith('data:image/'))
      .map(item => item.data_uri);
  }

  async function download(url, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw Object.assign(new Error(`图片下载失败：HTTP ${response.status}`), { code: 'PROVIDER_ERROR', retryable: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes;
  }

  function start(request) {
    const idempotencyKey = request.idempotency_key ?? request.request_hash;
    const existing = jobs.get(idempotencyKey);
    if (existing) return existing.handle;
    const providerJobId = `sdr_${sha256(Buffer.from(`${request.request_hash}:${clock()}:${randomBytes(4).toString('hex')}`)).slice(0, 16)}`;
    const controller = new AbortController();
    const startedAt = clock();
    const state = {
      provider_job_id: providerJobId,
      request_hash: request.request_hash,
      idempotency_key: idempotencyKey,
      status: 'running',
      cancelled: false,
      result: null,
      error: null,
      controller,
    };
    const size = `${Number(request.target_width)}x${Number(request.target_height)}`;
    const images = normalizeImages(request.reference_images);
    const payload = {
      model,
      prompt: request.prompt ?? request.instructions ?? '生成一张电商商品图，商品主体必须与参考图一致',
      size,
      response_format: 'b64_json',
      watermark: false,
      sequential_image_generation: 'disabled',
    };
    if (images.length === 1) payload.image = images[0];
    else if (images.length > 1) payload.image = images;

    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    state.settled = (async () => {
      // 进程重启后内存里的 data URI 会丢失；缺少主体参考图时绝不能"照样"调用真实模型
      if (Number(request.references ?? 0) > 0 && images.length === 0) {
        state.status = 'failed';
        state.error = failure(
          'REFERENCE_PAYLOAD_UNAVAILABLE',
          '参考图载荷未就绪（可能因进程重启），拒绝在缺少主体参考图时调用真实模型',
          false,
        );
        clearTimeout(timer);
        return;
      }
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const requestId = response.headers?.get?.('x-request-id') ?? response.headers?.get?.('x-tt-logid') ?? null;
        const raw = await response.text();
        let body = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        if (!response.ok) {
          const message = body?.error?.message ?? body?.message ?? raw;
          throw Object.assign(new Error(String(message)), {
            ...mapHttpFailure(response.status, message),
            provider_request_id: requestId,
          });
        }
        const items = Array.isArray(body?.data) ? body.data : [];
        const item = items[0];
        if (!item) throw Object.assign(new Error('供应商未返回任何图片'), failure('PROVIDER_ERROR', '供应商未返回任何图片', true));
        let bytes;
        if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
          bytes = Buffer.from(item.b64_json.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, ''), 'base64');
        } else if (typeof item.url === 'string' && item.url.length > 0) {
          bytes = await download(item.url, controller.signal);
        } else {
          throw Object.assign(new Error('供应商返回的图片项缺少 b64_json 与 url'), failure('PROVIDER_ERROR', '供应商返回的图片项缺少有效载荷', true));
        }
        let info;
        try {
          info = inspectImage(bytes);
        } catch (error) {
          throw Object.assign(new Error(`供应商返回内容不是可用图片：${error?.message ?? error}`), failure('PROVIDER_ERROR', '供应商返回内容不是可用图片', false));
        }
        const endedAt = clock();
        state.result = {
          provider: SEEDREAM_PROVIDER_ID,
          model,
          model_version: model,
          provider_job_id: providerJobId,
          provider_request_id: requestId ?? body?.id ?? null,
          usage: body?.usage ? {
            generated_images: body.usage.generated_images ?? items.length,
            output_tokens: body.usage.output_tokens ?? null,
            total_tokens: body.usage.total_tokens ?? null,
            unit: 'provider_token',
          } : { generated_images: items.length, unit: 'image' },
          cost: {
            billing_unit: 'provider_token',
            provider_cost: null,
            output_tokens: body?.usage?.output_tokens ?? null,
            total_tokens: body?.usage?.total_tokens ?? null,
            note: '真实账单未接入，成本只记录供应商标注的用量',
          },
          latency_ms: Math.max(0, endedAt - startedAt),
          output: {
            format: info.ext,
            bytes,
            width: info.width,
            height: info.height,
            sha256: sha256(bytes),
            requested_width: Number(request.target_width),
            requested_height: Number(request.target_height),
          },
          provider_meta: { simulated: false, acceptance: 'not_verified', endpoint, model },
        };
        state.status = 'succeeded';
      } catch (error) {
        if (state.cancelled) {
          state.error = failure('CANCELLED', '本地已请求取消，供应商调用终止', false, { provider_request_id: state.providerRequestId ?? null });
        } else if (state.timedOut) {
          state.error = failure('PROVIDER_TIMEOUT', `供应商在 ${timeoutMs}ms 内未返回`, true);
        } else if (error?.code && error?.retryable !== undefined) {
          state.error = failure(error.code, error.message, error.retryable, { provider_request_id: error.provider_request_id ?? null });
        } else if (error?.name === 'AbortError') {
          state.error = failure('PROVIDER_TIMEOUT', '供应商调用被中止', true);
        } else {
          state.error = failure('PROVIDER_ERROR', `供应商调用失败：${error?.message ?? error}`, true);
        }
        state.status = 'failed';
      } finally {
        clearTimeout(timer);
      }
    })();

    const handle = {
      provider_job_id: providerJobId,
      status: 'queued',
      request_hash: request.request_hash,
      idempotency_key: idempotencyKey,
      provider_meta: { id: SEEDREAM_PROVIDER_ID, version: SEEDREAM_ADAPTER_VERSION, simulated: false, acceptance: 'not_verified' },
    };
    state.handle = handle;
    jobs.set(idempotencyKey, state);
    return handle;
  }

  function submit(request) {
    return start(request);
  }

  function poll(handle) {
    const state = jobs.get(handle.idempotency_key) ?? [...jobs.values()].find(item => item.provider_job_id === handle.provider_job_id);
    if (!state) return { status: 'unknown', code: 'PROVIDER_UNKNOWN', message: '找不到该次真实调用，按未知处理，不重复提交' };
    if (state.status === 'succeeded') return { status: 'succeeded', result: state.result };
    if (state.status === 'failed') return { status: 'failed', ...state.error };
    return { status: 'running', note: '真实调用进行中' };
  }

  function cancel(handle) {
    const state = jobs.get(handle.idempotency_key) ?? [...jobs.values()].find(item => item.provider_job_id === handle.provider_job_id);
    if (!state) return { status: 'cannot_cancel', message: '找不到该次调用，本地停止仍然生效' };
    state.cancelled = true;
    try { state.controller.abort(); } catch { /* 已结束 */ }
    return { status: 'cancelled', message: '已中止真实调用；迟到的成功结果只进审计，不收费' };
  }

  return {
    capabilities,
    validate,
    estimate,
    submit,
    poll,
    cancel,
    // 便于测试核对状态；生产编排不直接使用
    _jobs: jobs,
  };
}
