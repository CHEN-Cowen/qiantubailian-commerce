/**
 * M06 Provider 工厂：唯一决定"用模拟还是真实 Adapter"的地方。
 * - 默认 mock，保证无密钥环境仍能完整演练；
 * - 显式 QTB_PROVIDER=seedream 时必须有密钥，否则启动即失败，绝不悄悄降级；
 * - 返回 mode / acceptance，供 API 与自检报告如实标注验收状态。
 */
import { createProvider } from '../provider.mjs';
import { createSeedreamProvider, SEEDREAM_PROVIDER_ID } from './seedream.mjs';

export const PROVIDER_MODES = Object.freeze(['mock', SEEDREAM_PROVIDER_ID]);

export function createProviderFromEnv(env = process.env, options = {}) {
  const mode = String(env.QTB_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock';
  if (mode === 'mock') {
    return {
      provider: createProvider({ defaultScenario: 'success' }),
      mode: 'mock',
      acceptance: 'simulated_only',
      note: '确定性模拟 Provider；产物不是真实模型图',
    };
  }
  if (mode === SEEDREAM_PROVIDER_ID) {
    const apiKey = env.PARATERA_API_KEY?.trim() || env.PILOTDECK_SEEDREAM_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('QTB_PROVIDER=seedream 但缺少 PARATERA_API_KEY 或 PILOTDECK_SEEDREAM_API_KEY；不会回落到模拟 Provider');
    }
    return {
      provider: createSeedreamProvider({
        apiKey,
        baseUrl: env.PILOTDECK_SEEDREAM_BASE_URL?.trim() || undefined,
        model: env.PILOTDECK_SEEDREAM_MODEL?.trim() || undefined,
        supportsPostComposite: env.QTB_SEEDREAM_POST_COMPOSITE === '1',
        ...options,
      }),
      mode: SEEDREAM_PROVIDER_ID,
      acceptance: 'not_verified',
      note: '真实 Adapter 已接线，但未用真实密钥完成验收；不得宣称真实主体保护能力',
    };
  }
  throw new Error(`QTB_PROVIDER 配置无效：${mode}；可选值 ${PROVIDER_MODES.join(' / ')}`);
}
