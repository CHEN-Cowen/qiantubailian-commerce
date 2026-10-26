/**
 * M05 确定性模拟 Provider。
 *
 * 为什么要先做它：任务执行骨架的所有不变量（幂等、未知不重复提交、取消后迟到结果、
 * 超时与挽回、异常恢复）都必须能在**没有外部依赖、不需要密钥**的前提下反复验证。
 * M06 接真实 Seedream 时只是换一个实现同一份契约的 Adapter，不动编排逻辑。
 *
 * 契约照 PRD 第 8 节：capabilities / validate / estimate / submit / poll / cancel / normalize_result。
 * 标准错误：INVALID_INPUT、UNSUPPORTED_CAPABILITY、RATE_LIMITED、PROVIDER_TIMEOUT、
 *          PROVIDER_ERROR、CONTENT_REJECTED、BUDGET_EXCEEDED、CANCELLED。
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const PROVIDER_ID = 'deterministic-mock';
export const PROVIDER_VERSION = 'mock.1';
export const MAX_SYNTHETIC_SIDE = 384;

export const RETRYABLE_CODES = new Set(['PROVIDER_TIMEOUT', 'RATE_LIMITED', 'PROVIDER_ERROR']);

/** 场景用于注入失败，全部确定性：同一 request + 同一场景必然得到同一结果。 */
export const SCENARIOS = Object.freeze([
  'success', 'unknown_once', 'rate_limited', 'timeout',
  'content_rejected', 'provider_error', 'late_success',
]);

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text) {
  const digest = createHash('sha256').update(String(text)).digest();
  return digest.readUInt32BE(0);
}

// ---------- 最小 PNG 编码器（零依赖） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 由 request 决定的彩色渐变，同一输入永远得到同一张图，便于做像素级断言。 */
function syntheticImage(request) {
  const width = Math.max(8, Math.min(MAX_SYNTHETIC_SIDE, request.target_width ?? 384));
  const height = Math.max(8, Math.min(MAX_SYNTHETIC_SIDE, request.target_height ?? 384));
  const random = mulberry32(seedFrom(`${request.request_hash}:${request.deliverable_id}`));
  const hueBase = random();
  const noise = 0.12 + random() * 0.2;
  const bytes = encodePng(width, height, (x, y) => {
    const across = x / Math.max(1, width - 1);
    const down = y / Math.max(1, height - 1);
    const base = hueBase + across * 0.35 + down * 0.25;
    const jitter = ((x * 73 + y * 31) % 17) / 17 * noise;
    const channel = index => {
      const wave = Math.sin((base + index / 3) * Math.PI * 2);
      const value = 0.62 + wave * 0.22 + jitter;
      return Math.max(0, Math.min(255, Math.round(value * 255)));
    };
    return [channel(0), channel(1), channel(2)];
  });
  return {
    format: 'png',
    bytes,
    width,
    height,
    requested_width: request.target_width ?? null,
    requested_height: request.target_height ?? null,
    downscaled: (request.target_width ?? 0) > width || (request.target_height ?? 0) > height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * 建 Provider。options.scenario 为默认场景；请求可用 meta.scenario 覆盖，
 * 让单个测试对单个 Attempt 注入失败，而不影响其他用例。
 */
export function createProvider({ defaultScenario = 'success', cancelAlwaysSucceeds = true } = {}) {
  const submitted = new Map();

  function capabilities() {
    return {
      id: PROVIDER_ID,
      version: PROVIDER_VERSION,
      image: true,
      video: false,
      max_references: 2,
      supports_mask: true,
      supports_async: true,
      supports_cancel: true,
      supports_seed: true,
      max_side: 2048,
      formats: ['jpg', 'png'],
    };
  }

  /** 明确拒绝不支持的约束，绝不静默丢弃主体保护。 */
  function validate(request) {
    if (!request?.request_hash) return { ok: false, code: 'INVALID_INPUT', message: '缺少 request_hash' };
    if (request.target_width > 2048 || request.target_height > 2048) {
      return { ok: false, code: 'UNSUPPORTED_CAPABILITY', message: `边长上限 2048，收到 ${request.target_width}×${request.target_height}` };
    }
    if (request.kind === 'video') {
      return { ok: false, code: 'UNSUPPORTED_CAPABILITY', message: '模拟 Provider 不支持视频' };
    }
    if (request.references > 2) {
      return { ok: false, code: 'UNSUPPORTED_CAPABILITY', message: `最多 2 张参考图，收到 ${request.references}` };
    }
    if (request.requires_subject_protection && !request.mask_ref) {
      return { ok: false, code: 'UNSUPPORTED_CAPABILITY', message: '需要主体保护但未提供掩码，禁止静默丢弃保护' };
    }
    return { ok: true };
  }

  function estimate(request) {
    const side = Math.max(request.target_width ?? 1024, request.target_height ?? 1024);
    const perPixel = 0.0000045;
    const estimated = Math.max(1, Math.round(side * side * perPixel));
    return {
      price_version: 'mock-price.1',
      estimated_credits: estimated,
      uncertainty: '确定性模拟，误差为 0',
      max_credits: estimated,
    };
  }

  function submit(request) {
    const scenario = request.scenario ?? defaultScenario;
    const providerJobId = `pv_${sha(`${request.request_hash}:${scenario}`).slice(0, 16)}`;
    if (!submitted.has(providerJobId)) {
      submitted.set(providerJobId, {
        provider_job_id: providerJobId,
        request_hash: request.request_hash,
        idempotency_key: request.idempotency_key ?? request.request_hash,
        scenario,
        request,
        submitted_at: request.submitted_at ?? new Date().toISOString(),
        polls: 0,
        cancelled: false,
      });
    }
    return {
      provider_job_id: providerJobId,
      status: 'queued',
      request_hash: request.request_hash,
      idempotency_key: request.idempotency_key ?? request.request_hash,
      provider_meta: { id: PROVIDER_ID, version: PROVIDER_VERSION, simulated: true, scenario },
    };
  }

  /**
   * 轮询。关键：unknown 绝不当失败，也不允许据此重复 submit（第 8 节 poll 约束）。
   * ticksNeeded 由场景决定；每次调用 polls 自增，因此完全确定。
   */
  function poll(handle) {
    const record = submitted.get(handle.provider_job_id) ?? handle;
    if (!record) return { status: 'unknown', code: 'PROVIDER_UNKNOWN', message: '找不到该次调用' };
    record.polls += 1;
    const { polls } = record;
    switch (record.scenario) {
      case 'rate_limited':
        return polls < 1 ? { status: 'queued' }
          : { status: 'failed', retryable: true, code: 'RATE_LIMITED', message: '供应商限流，可重试' };
      case 'provider_error':
        return polls < 1 ? { status: 'running' }
          : { status: 'failed', retryable: true, code: 'PROVIDER_ERROR', message: '供应商内部错误，可重试' };
      case 'timeout':
        return { status: 'running', message: '供应商迟迟不返回，等待直到本地超时' };
      case 'content_rejected':
        return polls < 2 ? { status: 'running' }
          : { status: 'failed', retryable: false, code: 'CONTENT_REJECTED', message: '供应商以内容策略拒绝该请求' };
      case 'unknown_once':
        if (polls === 1) return { status: 'unknown', code: 'PROVIDER_UNKNOWN', message: '本次轮询未知，不得当作失败重复提交' };
        return polls < 3 ? { status: 'running' }
          : { status: 'succeeded', result: normalizeResult({ request: record.request, handle }) };
      case 'late_success':
        // 迟到的成功：取消后仍可能返回，编排必须只审计不复活
        return polls < 4 ? { status: 'running' }
          : { status: 'succeeded', result: normalizeResult({ request: record.request, handle }) };
      case 'success':
      default:
        return polls < 2 ? { status: 'queued' }
          : polls < 3 ? { status: 'running' }
            : { status: 'succeeded', result: normalizeResult({ request: record.request, handle }) };
    }
  }

  function cancel(handle) {
    const record = submitted.get(handle.provider_job_id) ?? handle;
    if (!record) return { status: 'cannot_cancel', message: '找不到该次调用，本地仍会阻止后续阶段' };
    record.cancelled = true;
    if (!cancelAlwaysSucceeds) return { status: 'cannot_cancel', message: '供应商不支持取消，本地停止仍然生效' };
    return { status: 'cancelled', message: '供应商已确认取消' };
  }

  /** 只在这里产生成果文件与用量，保证每条 Supplier 调用都可追溯。 */
  function normalizeResult({ request, handle }) {
    const output = syntheticImage(request);
    return {
      provider: PROVIDER_ID,
      model: `synthetic-gradient/${PROVIDER_VERSION}`,
      model_version: PROVIDER_VERSION,
      provider_job_id: handle?.provider_job_id ?? null,
      provider_request_id: `req_${request.request_hash.slice(0, 12)}`,
      usage: { images: 1, unit: 'image' },
      latency_ms: 1200,
      output,
    };
  }

  return { capabilities, validate, estimate, submit, poll, cancel, normalizeResult, _submitted: submitted };
}

export const isRetryable = code => RETRYABLE_CODES.has(code);
