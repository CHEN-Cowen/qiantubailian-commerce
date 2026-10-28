/**
 * 端到端自测与截图脚本共用的确定性图片 Provider。
 *
 * 外部真实模型未验收（未配置 PARATERA_API_KEY），这里按请求尺寸生成可解码 PNG，
 * 支持本地后合成，让任务执行、质检、结算与导出链路真实跑通。
 * 能力声明中 simulated=true，任何截图/报告都不得把它当作真实出图效果。
 */
import { createHash } from 'node:crypto';
import { encodeRgbPng } from '../src/m06.mjs';

export function createFixtureProvider() {
  const calls = new Map();
  let sequence = 0;
  return {
    capabilities: () => ({
      id: 'e2e-fixture', version: '1', image: true, video: false, max_references: 6,
      supports_mask: false, supports_post_composite: true, supports_async: true,
      supports_revision: false, supports_cancel: true, max_side: 4096, formats: ['png', 'jpg'],
      simulated: true, acceptance: 'simulated_only',
    }),
    validate: () => ({ ok: true }),
    estimate: () => ({ estimated_credits: 1, max_credits: 1 }),
    submit(request) {
      sequence += 1;
      calls.set(request.idempotency_key, { request, seed: sequence });
      return { provider_job_id: request.idempotency_key, status: 'queued' };
    },
    poll(handle) {
      const entry = calls.get(handle.provider_job_id);
      const request = entry?.request;
      const seed = entry?.seed ?? 0;
      const width = request?.target_width ?? 1024;
      const height = request?.target_height ?? 1024;
      const rgb = Buffer.alloc(width * height * 3);
      // 低频柔和渐变（不是噪点）：仅让截图里的占位背景看起来像一张正常的场景图
      for (let y = 0; y < height; y += 1) {
        const v = y / Math.max(1, height - 1);
        for (let x = 0; x < width; x += 1) {
          const u = x / Math.max(1, width - 1);
          const index = (y * width + x) * 3;
          const wave = Math.sin((u * 2 + v) * Math.PI + seed) * 10;
          rgb[index] = Math.round(214 - 46 * v + wave + (seed % 3) * 3);
          rgb[index + 1] = Math.round(220 - 38 * v + wave * 0.5);
          rgb[index + 2] = Math.round(212 - 30 * v + wave * 0.3);
        }
      }
      const bytes = encodeRgbPng(width, height, rgb);
      return {
        status: 'succeeded',
        result: {
          provider: 'e2e-fixture', model: 'fixture/image', model_version: '1',
          provider_job_id: handle.provider_job_id, provider_request_id: `req_${handle.provider_job_id}`,
          usage: { images: 1 }, cost: { amount: 0, currency: 'internal_demo' }, latency_ms: 5,
          output: { bytes, width, height, format: 'png', sha256: createHash('sha256').update(bytes).digest('hex') },
        },
      };
    },
    cancel: () => ({ cancelled: true }),
  };
}
