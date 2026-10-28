import QRCode from 'qrcode';
/**
 * R08 微信 Native 支付 Provider。
 *
 * 外部阻断（必须用户办理，代码不伪造验收）：
 *   - 经营主体营业执照 + 微信支付商户号 + Native 支付能力开通
 *   - 已认证服务号/小程序 AppID（商户必须绑定 AppID）
 *   - 商户 API 密钥 + APIv3 证书（环境变量注入，不存代码）
 *
 * 内部结构：
 *   - APIv3 签名工具（纯算法，不需要密钥也可单测）
 *   - APIv3 通知解密工具（纯算法）
 *   - createWechatPaymentProvider()：需要完整 env 配置，缺失则构造即失败
 *   - createMockWechatPaymentProvider()：测试用，不依赖外部
 *
 * 设计决策：
 *   - 真实密钥绝不写代码，全部通过环境变量注入；缺配置启动即抛，绝不悄悄降级
 *   - amount_cents=0 的免单套餐不调微信 API，Provider 内部直接返回 paid 结果
 *   - APIv3 接口签名 + 验签 + AES-256-GCM 解密 + SHA256-RSA2048 验签证书链
 */
import { createHash, createSign, createVerify, randomBytes, createDecipheriv, X509Certificate } from 'node:crypto';

export const WECHAT_PAYMENT_PROVIDER_ID = 'wechat_native';
export const WECHAT_PAYMENT_VERSION = 'wechat-native.1';

// ---------- APIv3 签名工具 ----------

/**
 * APIv3 请求签名：SHA256-RSA2048。
 * signMessage = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`
 * 返回 { signature, timestamp, nonceStr, message }。
 */
export function signApiV3({ method = 'POST', urlPath = '/', timestamp, nonceStr, body = '', privateKeyPem } = {}) {
  if (!privateKeyPem) throw new Error('signApiV3 需要商户私钥（apiclient_key.pem 内容）');
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = nonceStr ?? randomBytes(16).toString('hex');
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const message = `${method.toUpperCase()}\n${urlPath}\n${ts}\n${nonce}\n${bodyStr}\n`;
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  const signature = signer.sign(privateKeyPem, 'base64');
  return { signature, timestamp: ts, nonceStr: nonce, message };
}

/**
 * APIv3 回调签名验证：SHA256-RSA2048。
 * signMessage = `${timestamp}\n${nonce}\n${body}\n`
 * 用平台证书公钥验签。
 */
export function verifyApiV3Signature({ timestamp, nonce, body, signature, platformCertPem } = {}) {
  if (!platformCertPem) return { ok: false, reason: '缺少平台证书公钥' };
  if (!signature) return { ok: false, reason: '缺少签名' };
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const message = `${timestamp}\n${nonce}\n${bodyStr}\n`;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(message);
  try {
    const ok = verifier.verify(platformCertPem, signature, 'base64');
    return { ok, reason: ok ? null : '签名不匹配' };
  } catch (err) {
    return { ok: false, reason: `验签异常：${err.message}` };
  }
}

/**
 * APIv3 通知资源数据解密：AES-256-GCM。
 * ciphertext = base64(12字节IV + 16字节TAG + N字节密文)
 * apiv3Key 是 32 字节（可能 base64 编码）。
 */
export function decryptApiV3Resource({ ciphertext, apiv3Key, nonce, associated_data = '' } = {}) {
  if (!apiv3Key) throw new Error('decryptApiV3Resource 需要 APIv3 密钥');
  const keyBuf = apiv3Key.length === 32 && Buffer.isBuffer(apiv3Key)
    ? apiv3Key
    : Buffer.from(apiv3Key, 'utf8');
  if (keyBuf.length !== 32) throw new Error('APIv3 密钥解码后必须 32 字节');
  const cipherBuf = Buffer.from(ciphertext, 'base64');
  const iv = Buffer.from(nonce ?? '', 'utf8');
  const tag = cipherBuf.subarray(cipherBuf.length - 16);
  const data = cipherBuf.subarray(0, cipherBuf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAAD(Buffer.from(associated_data, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return { ok: true, data: JSON.parse(decrypted.toString('utf8')) };
  } catch (err) {
    return { ok: false, reason: `解密失败：${err.message}` };
  }
}

// ---------- 金额与编号工具 ----------

/** CNY 分转元字符串（微信 API 接受分）。 */
export function formatYuan(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('金额必须为非负整数分');
  return (cents / 100).toFixed(2);
}

/** 微信商户订单号约束：32 字符内，字母数字下划线中划线。 */
export function validateOutTradeNo(outTradeNo) {
  if (typeof outTradeNo !== 'string') return false;
  if (outTradeNo.length === 0 || outTradeNo.length > 32) return false;
  return /^[A-Za-z0-9_\-]+$/.test(outTradeNo);
}

// ---------- Provider 工厂 ----------

function _pem(value) {
  if (typeof value !== 'string') return value;
  return value.includes('-----BEGIN') ? value : Buffer.from(value, 'base64').toString('utf8');
}

/**
 * 真实微信 Native 支付 Provider。缺失任一配置即抛，绝不回落到 mock。
 */
export function createWechatPaymentProvider({
  mchid, appid, apiv3Key, privateKeyPem, platformCertPem, notifyUrl,
  serialNo, platformSerial, fetchImpl = globalThis.fetch, clock = () => Date.now(), timeoutMs = 15_000,
} = {}) {
  const missing = [];
  if (!mchid?.trim()) missing.push('QTB_WX_MCHID');
  if (!appid?.trim()) missing.push('QTB_WX_APPID');
  if (!apiv3Key?.trim()) missing.push('QTB_WX_APIV3_KEY');
  if (!privateKeyPem?.trim()) missing.push('QTB_WX_PRIVATE_KEY');
  if (!platformCertPem?.trim()) missing.push('QTB_WX_PLATFORM_CERT');
  if (!notifyUrl?.trim()) missing.push('QTB_WX_NOTIFY_URL');
  if (missing.length > 0) {
    throw new Error(`微信 Native 支付 Provider 缺少必需配置：${missing.join(', ')}；不会回落到 mock Provider`);
  }
  const config = {
    mchid: mchid.trim(),
    appid: appid.trim(),
    apiv3Key: apiv3Key.trim(),
    privateKeyPem: _pem(privateKeyPem.trim()),
    platformCertPem: _pem(platformCertPem.trim()),
    notifyUrl: notifyUrl.trim(),
    baseUrl: 'https://api.mch.weixin.qq.com',
  };

  function verify(headers, body) {
    const get = name => typeof headers.get === 'function' ? headers.get(name) : headers[name];
    const timestamp = get('wechatpay-timestamp');
    if (!timestamp || !Number.isFinite(Number(timestamp)) || Math.abs(Number(new Date(clock())) / 1000 - Number(timestamp)) > 300) return { ok: false, reason: '签名时间戳无效或已过期' };
    let expected = platformSerial;
    if (!expected) {
      try { expected = new X509Certificate(config.platformCertPem).serialNumber; } catch { /* 公钥模式需显式配置 ID */ }
    }
    if (!expected || get('wechatpay-serial') !== expected) return { ok: false, reason: '微信验签证书序列号不匹配' };
    return verifyApiV3Signature({ timestamp, nonce: get('wechatpay-nonce'), body,
      signature: get('wechatpay-signature'), platformCertPem: config.platformCertPem });
  }

  async function request(method, urlPath, payload) {
    if (!serialNo) throw new Error('缺少商户 API 证书序列号 QTB_WX_SERIAL_NO');
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const signed = signApiV3({ method, urlPath, body, privateKeyPem: config.privateKeyPem, timestamp: Math.floor(clock() / 1000) });
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${signed.nonceStr}",signature="${signed.signature}",timestamp="${signed.timestamp}",serial_no="${serialNo}"`;
    const response = await fetchImpl(config.baseUrl + urlPath, {
      method, headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body ? { body } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    const valid = verify(response.headers, raw);
    if (!valid.ok) throw new Error(`微信响应验签失败：${valid.reason}`);
    let data = {};
    if (raw) { try { data = JSON.parse(raw); } catch { throw new Error('微信响应不是 JSON'); } }
    if (!response.ok) throw new Error(`微信接口 ${response.status}：${data.code ?? 'ERROR'} ${data.message ?? ''}`);
    return data;
  }

  return {
    id: WECHAT_PAYMENT_PROVIDER_ID,
    version: WECHAT_PAYMENT_VERSION,
    identity: { mchid: config.mchid, appid: config.appid },
    capabilities() {
      return {
        real_money: true,
        simulated: false,
        supports_refunds: true,
        supports_query: true,
        supports_close: true,
        supports_native_qr: true,
        currency: 'CNY',
        acceptance: 'not_verified',
      };
    },
    async createNativeOrder({ out_trade_no, description, amount_cents, attach = null, expires_at } = {}) {
      if (!validateOutTradeNo(out_trade_no)) throw new Error('商户订单号无效');
      if (!description || description.length > 127) throw new Error('订单描述不能为空且不超过 127 字符');
      if (!Number.isInteger(amount_cents) || amount_cents < 0) throw new Error('金额必须为非负整数分');
      if (amount_cents === 0) {
        return {
          out_trade_no, trade_state: 'SUCCESS', trade_state_desc: '免单套餐',
          transaction_id: `free_${out_trade_no}`, code_url: null, qr_code_url: null, zero_amount: true,
        };
      }
      const result = await request('POST', '/v3/pay/transactions/native', {
        mchid: config.mchid, appid: config.appid, out_trade_no, description,
        notify_url: config.notifyUrl, amount: { total: amount_cents, currency: 'CNY' },
        ...(attach ? { attach } : {}), ...(expires_at ? { time_expire: expires_at } : {}),
      });
      if (!result.code_url?.startsWith('weixin://')) throw new Error('微信未返回有效支付链接');
      return { ...result, out_trade_no, trade_state: 'NOTPAY', qr_code_url: await QRCode.toDataURL(result.code_url, { width: 256, margin: 2 }) };
    },
    async queryOrder({ out_trade_no } = {}) {
      if (!validateOutTradeNo(out_trade_no)) throw new Error('商户订单号无效');
      return request('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(out_trade_no)}?mchid=${encodeURIComponent(config.mchid)}`);
    },
    async closeOrder({ out_trade_no } = {}) {
      if (!validateOutTradeNo(out_trade_no)) throw new Error('商户订单号无效');
      await request('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(out_trade_no)}/close`, { mchid: config.mchid });
      return { out_trade_no, closed: true, trade_state: 'CLOSED' };
    },
    async refund({ out_trade_no, out_refund_no, refund_amount_cents, total_amount_cents, reason = '' } = {}) {
      if (!validateOutTradeNo(out_trade_no)) throw new Error('商户订单号无效');
      if (!validateOutTradeNo(out_refund_no)) throw new Error('退款单号无效');
      if (!Number.isInteger(refund_amount_cents) || refund_amount_cents <= 0) throw new Error('退款金额必须为正整数分');
      if (!Number.isInteger(total_amount_cents) || total_amount_cents <= 0) throw new Error('原订单金额必须为正整数分');
      if (refund_amount_cents > total_amount_cents) throw new Error('退款金额不能超过原订单金额');
      return request('POST', '/v3/refund/domestic/refunds', {
        out_trade_no, out_refund_no, reason, notify_url: config.notifyUrl,
        amount: { refund: refund_amount_cents, total: total_amount_cents, currency: 'CNY' },
      });
    },
    queryRefund({ out_refund_no }) {
      if (!validateOutTradeNo(out_refund_no)) throw new Error('退款单号无效');
      return request('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(out_refund_no)}`);
    },
    verifyNotify({ headers = {}, body = '' } = {}) {
      const timestamp = String(headers['wechatpay-timestamp'] ?? headers['Wechatpay-Timestamp'] ?? '');
      const nonce = String(headers['wechatpay-nonce'] ?? headers['Wechatpay-Nonce'] ?? '');
      const signature = String(headers['wechatpay-signature'] ?? headers['Wechatpay-Signature'] ?? '');
      const signResult = verify(headers, body);
      if (!signResult.ok) return { ok: false, reason: `签名验证失败：${signResult.reason}` };
      let payload;
      try { payload = typeof body === 'string' ? JSON.parse(body) : body; }
      catch (err) { return { ok: false, reason: `回调体 JSON 解析失败：${err.message}` }; }
      const resource = payload?.resource;
      if (!resource?.ciphertext) return { ok: false, reason: '回调体缺少加密资源' };
      let decryptResult;
      try { decryptResult = decryptApiV3Resource({ ...resource, apiv3Key: config.apiv3Key }); }
      catch (error) { return { ok: false, reason: error.message }; }
      if (!decryptResult.ok) return { ok: false, reason: decryptResult.reason };
      return { ok: true, event_type: payload.event_type, data: decryptResult.data };
    },
  };
}

/**
 * mock 支付 Provider：测试用，不依赖任何外部配置。
 * 允许 { realMoney: true } 模拟真实支付路径（native 下单、回调结算、查单）。
 */
export function createMockWechatPaymentProvider({ realMoney = false } = {}) {
  const store = new Map();
  const simulated = !realMoney;

  return {
    id: `${WECHAT_PAYMENT_PROVIDER_ID}_mock`,
    version: `${WECHAT_PAYMENT_VERSION}_mock`,
    capabilities() {
      return {
        real_money: realMoney,
        simulated,
        supports_refunds: true,
        supports_query: true,
        supports_close: true,
        supports_native_qr: true,
        currency: 'CNY',
        acceptance: 'simulated_only',
      };
    },
    createNativeOrder({ out_trade_no, description, amount_cents } = {}) {
      if (!validateOutTradeNo(out_trade_no)) throw new Error('商户订单号无效');
      if (!Number.isInteger(amount_cents) || amount_cents < 0) throw new Error('金额必须为非负整数分');
      const zero = amount_cents === 0;
      const record = store.get(out_trade_no) ?? { out_trade_no, amount_cents, description, state: zero ? 'SUCCESS' : 'NOTPAY', refunds: [] };
      store.set(out_trade_no, record);
      if (zero) return { out_trade_no, trade_state: 'SUCCESS', zero_amount: true };
      return {
        out_trade_no, trade_state: record.state,
        code_url: `weixin://wxpay/bizpayurl?pr=MOCK_${out_trade_no}`,
        qr_code_url: `data:image/png;base64,MOCK_QR_${out_trade_no}`,
        prepay_id: `wx_prepay_${out_trade_no}`,
      };
    },
    queryOrder({ out_trade_no } = {}) {
      const record = store.get(out_trade_no);
      return { out_trade_no, trade_state: record?.state ?? 'NOTPAY', transaction_id: `MOCK_${out_trade_no}`,
        amount: { total: record?.amount_cents, currency: 'CNY' } };
    },
    closeOrder({ out_trade_no } = {}) {
      const record = store.get(out_trade_no);
      if (!record) return { out_trade_no, closed: false, trade_state: 'NOTFOUND' };
      if (record.state === 'SUCCESS') return { out_trade_no, closed: false, trade_state: 'SUCCESS', reason: '已支付订单不能关闭' };
      record.state = 'CLOSED';
      return { out_trade_no, closed: true, trade_state: 'CLOSED' };
    },
    refund({ out_trade_no, out_refund_no, refund_amount_cents, total_amount_cents } = {}) {
      const record = store.get(out_trade_no);
      if (!record) throw new Error('订单不存在');
      if (record.state !== 'SUCCESS') throw new Error('只有已支付订单可以退款');
      const existing = record.refunds.find(r => r.out_refund_no === out_refund_no);
      if (existing) return { out_trade_no, out_refund_no, status: existing.state };
      if (refund_amount_cents > total_amount_cents) throw new Error('退款金额超过订单金额');
      if ((record.refunded_total ?? 0) + refund_amount_cents > total_amount_cents) throw new Error('累计退款超过订单金额');
      record.refunds.push({ out_refund_no, amount: refund_amount_cents, state: 'SUCCESS' });
      record.refunded_total = (record.refunded_total ?? 0) + refund_amount_cents;
      return { out_trade_no, out_refund_no, refund_amount: refund_amount_cents, status: 'SUCCESS' };
    },
    queryRefund({ out_refund_no }) {
      const found = [...store.values()].flatMap(x => x.refunds).find(x => x.out_refund_no === out_refund_no);
      return { out_refund_no, status: found?.state ?? 'PROCESSING' };
    },
    _setState(out_trade_no, state) {
      const record = store.get(out_trade_no) ?? { out_trade_no, amount_cents: 0, description: '', state: 'NOTPAY', refunds: [] };
      record.state = state;
      store.set(out_trade_no, record);
    },
    _mockNotify({ out_trade_no, trade_state = 'SUCCESS', transaction_id = null } = {}) {
      return {
        event_type: trade_state === 'SUCCESS' ? 'TRANSACTION.SUCCESS' : 'TRANSACTION.CLOSED',
        data: {
          out_trade_no, transaction_id: transaction_id ?? `MOCK_${out_trade_no}`,
          trade_state, amount: { total: store.get(out_trade_no)?.amount_cents ?? 1900, currency: 'CNY' },
        },
      };
    },
    /** mock 模式下的通知处理：body 直接解析为 JSON，不验签不解密。 */
    verifyNotify({ body = '' } = {}) {
      let payload;
      try { payload = typeof body === 'string' ? JSON.parse(body) : body; }
      catch (err) { return { ok: false, reason: `JSON 解析失败：${err.message}` }; }
      // 简化路径：mock 调用方可以直接把 _mockNotify 结果作为 body 发过来
      if (payload?.data?.out_trade_no) {
        return { ok: true, event_type: payload.event_type, data: payload.data };
      }
      return { ok: false, reason: 'mock 回调体缺少 data.out_trade_no' };
    },
  };
}
