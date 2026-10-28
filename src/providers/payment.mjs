/**
 * R08 支付 Provider 工厂。
 *
 * 与图像 Provider (QTB_PROVIDER) 独立：支付 Provider 通过 QTB_PAYMENT_PROVIDER 配置。
 *   - mock：createMockWechatPaymentProvider()，无外部依赖，用于开发与测试
 *   - wechat_native：createWechatPaymentProvider()，需要完整 env 配置，缺配置启动即抛
 */
import { createWechatPaymentProvider, createMockWechatPaymentProvider, WECHAT_PAYMENT_PROVIDER_ID } from './wechat.mjs';

export const PAYMENT_PROVIDER_MODES = Object.freeze(['none', 'mock', WECHAT_PAYMENT_PROVIDER_ID]);

export function createPaymentProviderFromEnv(env = process.env, options = {}) {
  const mode = String(env.QTB_PAYMENT_PROVIDER ?? 'none').trim().toLowerCase() || 'none';
  if (mode === 'none') return { provider: null, mode, acceptance: 'not_configured' };
  if (mode === 'mock') {
    return {
      provider: createMockWechatPaymentProvider(options),
      mode: 'mock',
      acceptance: 'simulated_only',
      note: 'mock 支付 Provider；不进行真实扣款，仅用于开发与测试',
    };
  }
  if (mode === WECHAT_PAYMENT_PROVIDER_ID) {
    if (env.QTB_ENABLE_REAL_PAYMENTS !== '1') throw new Error('真实收款保持关闭；完成商户与交易验收后才可设置 QTB_ENABLE_REAL_PAYMENTS=1');
    if (!env.QTB_WX_SERIAL_NO) throw new Error('缺少 QTB_WX_SERIAL_NO');
    return {
      provider: createWechatPaymentProvider({
        mchid: env.QTB_WX_MCHID,
        appid: env.QTB_WX_APPID,
        apiv3Key: env.QTB_WX_APIV3_KEY,
        privateKeyPem: env.QTB_WX_PRIVATE_KEY,
        platformCertPem: env.QTB_WX_PLATFORM_CERT,
        notifyUrl: env.QTB_WX_NOTIFY_URL,
        serialNo: env.QTB_WX_SERIAL_NO,
        platformSerial: env.QTB_WX_PLATFORM_SERIAL,
        ...options,
      }),
      mode: WECHAT_PAYMENT_PROVIDER_ID,
      acceptance: 'not_verified',
      note: '微信 Native 支付 Provider 已接线，但未用真实商户资质完成验收；不得宣称真实扣款能力',
    };
  }
  throw new Error(`QTB_PAYMENT_PROVIDER 配置无效：${mode}；可选值 ${PAYMENT_PROVIDER_MODES.join(' / ')}`);
}
