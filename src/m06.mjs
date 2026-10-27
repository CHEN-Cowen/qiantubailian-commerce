/**
 * M06 商品主体保护与生成记录。
 *
 * 三件事，全部可独立验证、不依赖外部服务：
 * 1. 主体掩码：从真实 PNG 像素推导主体区域（背景色差或透明通道），产出掩码与去背图。
 *    非 PNG、损坏 PNG、主体占比异常都会明确返回不可用原因，绝不假装有掩码。
 * 2. 本地主体合成：把去背后的主体按比例贴回生成图，保留商品原始像素。
 *    对齐方式固定为等比最近邻，不做检测配准，因此记录里 alignment_verified 恒为 false。
 * 3. 能力闸口与生成记录：Provider 必须声明掩码或本地合成能力，否则明确拒绝而不是静默丢弃保护；
 *    每次调用（成功或拒绝）都留一条可追溯记录，含模型、请求、用量、成本、时延、版本与哈希。
 */
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { readImageSize } from './images.mjs';

export const M06_VERSION = 'm06.1';
export const MASK_VERSION = 'm06.mask.1';
export const SUBJECT_MASK_MAX_SIDE = 512;
const MASK_BACKGROUND_THRESHOLD = 42;
const MASK_MIN_COVERAGE = 0.02;
const MASK_MAX_COVERAGE = 0.98;
const MAX_COMPOSITE_PIXELS = 6_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const REFERENCE_ROLES = Object.freeze({
  product_subject: '商品主体原图，形状、文字、Logo 与颜色不得改变',
  product_packaging: '包装原图，包装上的文字与 Logo 属不可变区域',
  subject_cutout: '去背后的主体，仅用于本地合成，不发送给供应商',
  style_reference: '风格参考，只影响场景与光线，不改变商品',
  subject_mask: '主体区域掩码，白色为需要保护的商品像素',
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const generationRecordId = () => `gen_${randomBytes(8).toString('hex')}`;

// ---------- PNG 编解码（仅 8 位、非隔行；零依赖） ----------

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

function pngChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, colorType, channels, pixelAt) {
  const raw = Buffer.alloc((width * channels + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const values = pixelAt(x, y);
      for (let index = 0; index < channels; index += 1) raw[offset + index] = values[index] ?? 0;
      offset += channels;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const encodeMaskPng = (width, height, isSubject) =>
  encodePng(width, height, 2, 3, (x, y) => {
    const value = isSubject(y * width + x) ? 255 : 0;
    return [value, value, value];
  });

export const encodeRgbaPng = (width, height, rgbs, alphaAt) =>
  encodePng(width, height, 6, 4, (x, y) => {
    const index = y * width + x;
    return [rgbs[index * 3], rgbs[index * 3 + 1], rgbs[index * 3 + 2], alphaAt(index)];
  });

export const encodeRgbPng = (width, height, rgbs) =>
  encodePng(width, height, 2, 3, (x, y) => {
    const index = y * width + x;
    return [rgbs[index * 3], rgbs[index * 3 + 1], rgbs[index * 3 + 2]];
  });

/**
 * 解码 PNG 为 RGBA。返回 null 表示不能安全解码（不是 PNG、位深/类型不支持、
 * 隔行、IDAT 缺失或损坏）。调用方必须把 null 当作"掩码不可用"，不能兜底。
 */
export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) return null;
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      if (payload.length < 13) return null;
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      bitDepth = payload[8];
      colorType = payload[9];
      interlace = payload[12];
    } else if (type === 'IDAT') {
      idat.push(payload);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels || idat.length === 0) return null;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(width * height * 4);
  const prior = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    raw.copy(current, 0, cursor, cursor + stride);
    cursor += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels] : 0;
      const up = prior[index];
      const upLeft = index >= channels ? prior[index - channels] : 0;
      let value = current[index];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceUp = Math.abs(estimate - up);
        const distanceUpLeft = Math.abs(estimate - upLeft);
        value += distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
          ? left : distanceUp <= distanceUpLeft ? up : upLeft;
      } else if (filter !== 0) return null;
      current[index] = value & 0xFF;
    }
    current.copy(prior);
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (channels === 1) {
        const gray = current[source];
        pixels[target] = gray; pixels[target + 1] = gray; pixels[target + 2] = gray; pixels[target + 3] = 255;
      } else if (channels === 2) {
        const gray = current[source];
        pixels[target] = gray; pixels[target + 1] = gray; pixels[target + 2] = gray; pixels[target + 3] = current[source + 1];
      } else if (channels === 3) {
        pixels[target] = current[source]; pixels[target + 1] = current[source + 1];
        pixels[target + 2] = current[source + 2]; pixels[target + 3] = 255;
      } else {
        pixels[target] = current[source]; pixels[target + 1] = current[source + 1];
        pixels[target + 2] = current[source + 2]; pixels[target + 3] = current[source + 3];
      }
    }
  }
  return { width, height, pixels };
}

// ---------- 主体掩码 ----------

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const pngSizeOf = bytes => readImageSize(bytes, 'image/png');

/** 归一化商品矩形：只接受 0..1 的比例，拒绝越界与过小区域（避免"整张图都算商品"）。 */
export function normalizeSubjectBox(box) {
  if (!box || typeof box !== 'object') return null;
  const values = ['x', 'y', 'width', 'height'].map(key => Number(box[key]));
  if (values.some(value => !Number.isFinite(value))) return null;
  const [x, y, width, height] = values;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  if (x + width > 1.001 || y + height > 1.001) return null;
  if (width < 0.02 || height < 0.02) return null;
  return {
    x: Math.round(x * 10000) / 10000,
    y: Math.round(y * 10000) / 10000,
    width: Math.round(width * 10000) / 10000,
    height: Math.round(height * 10000) / 10000,
  };
}

/**
 * 从主体素材推导掩码。
 * - PNG：零依赖解码后按背景色差/透明通道推导；
 * - JPEG/WebP：零依赖解码无法安全还原像素，但卖家最常见的正是 JPEG。此时允许用
 *   卖家确认的商品矩形（归一化坐标）生成**区域掩码**，交给支持掩码的 Provider 保护主体；
 *   不生成去背图，因此不会假装能本地合成。
 * 未给矩形且无法解码时明确返回不可用，让上层拒绝，而不是静默丢弃主体保护。
 */
export function createSubjectMask({ bytes, mime, box = null } = {}) {
  const normalized = normalizeSubjectBox(box);
  if (normalized) {
    const size = mime === 'image/png' ? pngSizeOf(bytes) : readImageSize(bytes, mime);
    if (size) {
      const scale = Math.min(1, SUBJECT_MASK_MAX_SIDE / Math.max(size.width, size.height));
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      const left = Math.floor(normalized.x * width);
      const top = Math.floor(normalized.y * height);
      const right = Math.min(width, Math.ceil((normalized.x + normalized.width) * width));
      const bottom = Math.min(height, Math.ceil((normalized.y + normalized.height) * height));
      const maskBytes = encodeMaskPng(width, height, index => {
        const x = index % width;
        const y = Math.floor(index / width);
        return x >= left && x < right && y >= top && y < bottom;
      });
      const coverage = ((right - left) * (bottom - top)) / (width * height);
      return {
        available: true,
        width,
        height,
        coverage,
        edge_pixels: 2 * ((right - left) + (bottom - top)),
        box: normalized,
        maskBytes,
        cutoutBytes: null,
        sha256: sha256(maskBytes),
        cutout_sha256: null,
        has_cutout: false,
        method: 'manual_box',
        message: '使用卖家确认的商品矩形生成区域掩码；本地无法生成去背图，需 Provider 支持掩码',
      };
    }
    return { available: false, reason: 'MASK_SOURCE_UNDECODABLE', message: '主体素材文件头不完整，无法按矩形生成掩码' };
  }
  if (mime && mime !== 'image/png') {
    return {
      available: false,
      reason: 'MASK_SOURCE_UNSUPPORTED_FORMAT',
      message: `主体素材为 ${mime}，请先确认商品区域（矩形掩码）或改用 PNG 以自动推导掩码`,
    };
  }
  const decoded = decodePng(bytes);
  if (!decoded) {
    return { available: false, reason: 'MASK_SOURCE_UNDECODABLE', message: '主体素材不是可解码的 8 位非隔行 PNG，无法推导主体掩码' };
  }
  const scale = Math.min(1, SUBJECT_MASK_MAX_SIDE / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const sampleIndex = (x, y) => {
    const sx = Math.min(decoded.width - 1, Math.floor(x / scale));
    const sy = Math.min(decoded.height - 1, Math.floor(y / scale));
    return (sy * decoded.width + sx) * 4;
  };

  const border = [];
  for (let x = 0; x < width; x += 1) { border.push(sampleIndex(x, 0)); border.push(sampleIndex(x, height - 1)); }
  for (let y = 0; y < height; y += 1) { border.push(sampleIndex(0, y)); border.push(sampleIndex(width - 1, y)); }
  const transparentBorder = border.filter(index => decoded.pixels[index + 3] < 16).length > border.length / 2;
  const background = transparentBorder
    ? null
    : {
      r: median(border.map(index => decoded.pixels[index])),
      g: median(border.map(index => decoded.pixels[index + 1])),
      b: median(border.map(index => decoded.pixels[index + 2])),
    };

  const subject = new Uint8Array(width * height);
  const rgbs = Buffer.alloc(width * height * 3);
  let coverageCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const source = sampleIndex(x, y);
      const alpha = decoded.pixels[source + 3];
      let isSubject;
      if (transparentBorder) {
        isSubject = alpha >= 128;
      } else {
        const dr = decoded.pixels[source] - background.r;
        const dg = decoded.pixels[source + 1] - background.g;
        const db = decoded.pixels[source + 2] - background.b;
        isSubject = Math.sqrt(dr * dr + dg * dg + db * db) > MASK_BACKGROUND_THRESHOLD;
      }
      subject[index] = isSubject ? 1 : 0;
      if (isSubject) coverageCount += 1;
      rgbs[index * 3] = decoded.pixels[source];
      rgbs[index * 3 + 1] = decoded.pixels[source + 1];
      rgbs[index * 3 + 2] = decoded.pixels[source + 2];
    }
  }

  const coverage = coverageCount / (width * height);
  if (coverage < MASK_MIN_COVERAGE || coverage > MASK_MAX_COVERAGE) {
    return {
      available: false,
      reason: 'MASK_DEGENERATE',
      message: `主体占比 ${(coverage * 100).toFixed(1)}%，无法区分主体与背景`,
      coverage,
    };
  }

  // 掩码边界像素数：供后续"边缘融合"复核做基线（M07 会做更细的融合检查）
  let edgePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (subject[index] !== 1) continue;
      const neighbors = [
        x > 0 ? subject[index - 1] : 0,
        x + 1 < width ? subject[index + 1] : 0,
        y > 0 ? subject[index - width] : 0,
        y + 1 < height ? subject[index + width] : 0,
      ];
      if (neighbors.some(value => value !== 1)) edgePixels += 1;
    }
  }

  const maskBytes = encodeMaskPng(width, height, index => subject[index] === 1);
  const cutoutBytes = encodeRgbaPng(width, height, rgbs, index => (subject[index] === 1 ? 255 : 0));
  return {
    available: true,
    width,
    height,
    coverage,
    edge_pixels: edgePixels,
    background: transparentBorder ? { mode: 'alpha' } : { mode: 'border_color', ...background, threshold: MASK_BACKGROUND_THRESHOLD },
    maskBytes,
    cutoutBytes,
    sha256: sha256(maskBytes),
    cutout_sha256: sha256(cutoutBytes),
    has_cutout: true,
    method: transparentBorder ? 'alpha_channel' : 'border_color_keying',
  };
}

/**
 * 本地主体合成：把去背后的商品像素按等比最近邻贴回生成图。
 * 这一步只保证"原始商品像素被保留"，不保证位置与透视正确，故 alignment_verified 恒为 false。
 */
export function compositeSubject({ outputBytes, cutoutBytes, maskBytes } = {}) {
  const output = decodePng(outputBytes);
  if (!output) return { available: false, applied: false, reason: 'OUTPUT_NOT_PNG', message: '生成结果不是可解码 PNG，无法做本地主体合成' };
  if (output.width * output.height > MAX_COMPOSITE_PIXELS) {
    return { available: false, applied: false, reason: 'OUTPUT_TOO_LARGE', message: `生成结果 ${output.width}×${output.height} 超出本地合成上限` };
  }
  const cutout = decodePng(cutoutBytes);
  const mask = decodePng(maskBytes);
  if (!cutout || !mask || mask.width !== cutout.width || mask.height !== cutout.height) {
    return { available: false, applied: false, reason: 'SUBJECT_ARTIFACT_INVALID', message: '去背主体或掩码不可解码，无法本地合成' };
  }
  const width = output.width;
  const height = output.height;
  // 解码结果为 RGBA；合成与编码都按 RGB 处理，避免 alpha 通道串位
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    rgb[index * 3] = output.pixels[index * 4];
    rgb[index * 3 + 1] = output.pixels[index * 4 + 1];
    rgb[index * 3 + 2] = output.pixels[index * 4 + 2];
  }
  let replaced = 0;
  for (let y = 0; y < height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor(y * mask.height / height));
    for (let x = 0; x < width; x += 1) {
      const mx = Math.min(mask.width - 1, Math.floor(x * mask.width / width));
      const maskIndex = (my * mask.width + mx) * 4;
      if (mask.pixels[maskIndex] < 128) continue;
      if (cutout.pixels[maskIndex + 3] < 128) continue;
      const target = (y * width + x) * 3;
      rgb[target] = cutout.pixels[maskIndex];
      rgb[target + 1] = cutout.pixels[maskIndex + 1];
      rgb[target + 2] = cutout.pixels[maskIndex + 2];
      replaced += 1;
    }
  }
  if (replaced === 0) return { available: true, applied: false, reason: 'NO_SUBJECT_PIXELS', message: '生成图内没有命中掩码区域，未替换任何像素' };
  const bytes = encodeRgbPng(width, height, rgb);
  return {
    available: true,
    applied: true,
    bytes,
    sha256: sha256(bytes),
    width,
    height,
    meta: {
      method: 'proportional_nearest_neighbor',
      replaced_pixels: replaced,
      replaced_ratio: replaced / (width * height),
      mask_coverage: replaced / (width * height),
      outside_mask_replacements: 0,
      edge_fusion: 'hard_binary_edge',
      compression: 'png_lossless',
      alignment_verified: false,
      note: '只保留原始商品像素，未做检测配准；掩码外像素未被替换，位置一致性需人工复核',
    },
  };
}

/**
 * 参考图职责：顺序即提示词里的图 1、图 2……，绝不混用角色。
 * 主体与包装是必需参考；风格只剩余量时才加入，放不下的明确记为 dropped，不静默改角色。
 * 去背主体只服务本地合成，永远标记 sent_to_provider=false，避免供应商误用。
 */
export function buildReferencePlan({
  subjectAsset, packagingAsset = null, styleAssets = [], cutoutSha256 = null, maxReferences = Infinity,
} = {}) {
  const required = [];
  if (subjectAsset) {
    required.push({
      index: required.length + 1,
      role: 'product_subject',
      asset_id: subjectAsset.id,
      sha256: subjectAsset.sha256,
      ext: subjectAsset.ext,
      mime: subjectAsset.mime,
      width: subjectAsset.width,
      height: subjectAsset.height,
      purpose: REFERENCE_ROLES.product_subject,
      sent_to_provider: true,
    });
  }
  if (packagingAsset) {
    required.push({
      index: required.length + 1,
      role: 'product_packaging',
      asset_id: packagingAsset.id,
      sha256: packagingAsset.sha256,
      ext: packagingAsset.ext,
      mime: packagingAsset.mime,
      width: packagingAsset.width,
      height: packagingAsset.height,
      purpose: REFERENCE_ROLES.product_packaging,
      sent_to_provider: true,
    });
  }
  if (required.length > maxReferences) {
    return {
      references: [],
      dropped: required.map(item => ({ role: item.role, asset_id: item.asset_id, reason: 'CAPABILITY_REFERENCE_LIMIT' })),
      required_count: required.length,
      capacity_exceeded: true,
    };
  }
  const dropped = [];
  const styles = [];
  for (const style of styleAssets) {
    if (required.length + styles.length >= maxReferences) {
      dropped.push({ role: 'style_reference', asset_id: style.id, reason: 'CAPABILITY_REFERENCE_LIMIT' });
      continue;
    }
    styles.push({
      index: required.length + styles.length + 1,
      role: 'style_reference',
      asset_id: style.id,
      sha256: style.sha256,
      ext: style.ext,
      mime: style.mime,
      width: style.width,
      height: style.height,
      purpose: REFERENCE_ROLES.style_reference,
      sent_to_provider: true,
    });
  }
  const references = [...required, ...styles];
  if (cutoutSha256) {
    references.push({
      index: references.length + 1,
      role: 'subject_cutout',
      asset_id: null,
      sha256: cutoutSha256,
      ext: 'png',
      mime: 'image/png',
      purpose: REFERENCE_ROLES.subject_cutout,
      sent_to_provider: false,
    });
  }
  return { references, dropped, required_count: required.length, capacity_exceeded: false };
}

// ---------- 能力闸口 ----------

/**
 * 主体保护能力闸口。规则：
 * - 模拟 Provider 允许降级，但必须带原因，记录里会明确标 simulated_fallback；
 * - 真实 Provider 必须要么原生支持掩码，要么声明可做本地合成，否则拒绝调用；
 * - 掩码不可用时，真实 Provider 一律拒绝，绝不静默丢弃。
 */
export function checkSubjectProtection({ capabilities, protection, required = true } = {}) {
  if (!required) return { ok: true, mode: 'not_required' };
  const simulated = capabilities?.simulated === true;
  if (!protection?.available) {
    const reason = protection?.reason ?? 'MISSING_SUBJECT_ASSET';
    if (simulated) {
      return { ok: true, mode: 'simulated_fallback', warning: `模拟 Provider 在掩码不可用（${reason}）时降级运行，产物不得当作真实主体保护结果` };
    }
    return {
      ok: false,
      code: 'UNSUPPORTED_CAPABILITY',
      message: `主体掩码不可用（${reason}），拒绝在无主体保护的情况下调用真实模型`,
      details: { reason },
    };
  }
  if (capabilities?.supports_mask === true) {
    return { ok: true, mode: 'mask' };
  }
  if (capabilities?.supports_post_composite === true && protection?.has_cutout !== false) {
    return { ok: true, mode: 'composite' };
  }
  if (capabilities?.supports_post_composite === true && protection?.has_cutout === false) {
    return {
      ok: false,
      code: 'UNSUPPORTED_CAPABILITY',
      message: '当前主体素材只生成了区域掩码、没有去背图，无法做本地主体合成；请更换支持掩码的 Provider 或改用 PNG 素材',
      details: { method: protection?.method ?? null },
    };
  }
  if (simulated) {
    return { ok: true, mode: 'simulated_reference_only', warning: '模拟 Provider 不支持掩码或本地合成，仅按参考图模拟，产物不具真实主体保护' };
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_CAPABILITY',
    message: '该 Provider 既不支持掩码也不支持本地主体合成，拒绝静默丢弃主体保护',
    details: { provider: capabilities?.id ?? null },
  };
}

/** 参考图容量闸口：必需参考（主体/包装）超容量时必须拒绝，不能靠丢参考图凑数。 */
export function checkReferenceCapacity({ capabilities, plan } = {}) {
  if (plan?.capacity_exceeded) {
    return {
      ok: false,
      code: 'UNSUPPORTED_CAPABILITY',
      message: `主体与包装参考图共 ${plan.required_count} 张，Provider 最多 ${capabilities?.max_references ?? '未知'} 张；拒绝丢弃必需参考`,
      details: { required: plan.required_count, max_references: capabilities?.max_references ?? null },
    };
  }
  return { ok: true, dropped: plan?.dropped ?? [] };
}

// ---------- 生成记录 ----------

const recordBase = ({ run, attempt, request, provider, at }) => ({
  schema_version: 1,
  run_id: run.id,
  attempt_id: attempt.id,
  project_id: run.project_id,
  tenant_id: run.tenant_id,
  deliverable_id: attempt.deliverable_id,
  iteration: attempt.iteration,
  request_hash: request.request_hash,
  idempotency_key: request.idempotency_key ?? null,
  provider: provider.id,
  provider_version: provider.version ?? null,
  provider_meta: provider.simulated === true
    ? { simulated: true, acceptance: 'simulated_only' }
    : { simulated: false, acceptance: provider.acceptance ?? 'not_verified' },
  mask_version: MASK_VERSION,
  created_at: new Date(at).toISOString(),
});

export function makeGenerationRecord({ run, attempt, request, provider, result, output, protection, composite, at }) {
  return {
    ...recordBase({ run, attempt, request, provider, at }),
    id: generationRecordId(),
    status: 'succeeded',
    model: result.model ?? null,
    model_version: result.model_version ?? null,
    provider_request_id: result.provider_request_id ?? null,
    provider_job_id: attempt.provider_job_id ?? null,
    usage: result.usage ?? null,
    cost: result.cost ?? {
      billing_unit: 'internal_credit',
      internal_credits: attempt.planned_credits,
      provider_cost: null,
      note: '模拟 Provider 只结算内部演示额度',
    },
    latency_ms: result.latency_ms ?? null,
    output: {
      format: output.format ?? 'png',
      width: output.width ?? null,
      height: output.height ?? null,
      bytes: output.bytes?.length ?? null,
      sha256: output.sha256 ?? null,
    },
    subject_protection: {
      mode: protection?.mode ?? 'not_required',
      required: run.subject_protection?.required === true,
      mask: protection?.mask
        ? {
          ref: protection.mask.ref,
          sha256: protection.mask.sha256 ?? null,
          version: MASK_VERSION,
          coverage: protection.mask.coverage ?? null,
          method: protection.mask.method ?? null,
          verified: protection.mask.verified === true,
        }
        : null,
      references: request.reference_plan ?? [],
      composite: composite ?? null,
      warning: protection?.warning ?? null,
    },
    error: null,
  };
}

export function makeRejectedGenerationRecord({ run, attempt, request, provider, gate, at }) {
  return {
    ...recordBase({ run, attempt, request, provider, at }),
    id: generationRecordId(),
    status: 'rejected',
    model: null,
    model_version: null,
    provider_request_id: null,
    provider_job_id: null,
    usage: null,
    cost: { billing_unit: 'internal_credit', internal_credits: 0, provider_cost: null, note: '能力不满足，未调用供应商，不收费' },
    latency_ms: 0,
    output: null,
    subject_protection: {
      mode: 'rejected',
      required: run.subject_protection?.required === true,
      mask: request.mask_ref ? { ref: request.mask_ref, verified: String(request.mask_ref).startsWith('mask:verified:') } : null,
      references: request.reference_plan ?? [],
      composite: null,
      warning: gate.message,
    },
    error: { code: gate.code, message: gate.message, retryable: false, details: gate.details ?? null },
  };
}

/** 供应商失败也留记录：模型、请求、错误与已发生成本可追溯，但不产生输出。 */
export function makeFailedGenerationRecord({ run, attempt, request, provider, error, at }) {
  return {
    ...recordBase({ run, attempt, request, provider, at }),
    id: generationRecordId(),
    status: 'failed',
    model: null,
    model_version: null,
    provider_request_id: error.provider_request_id ?? null,
    provider_job_id: attempt.provider_job_id ?? null,
    usage: null,
    cost: { billing_unit: 'internal_credit', internal_credits: 0, provider_cost: null, note: '供应商技术失败，不向用户收费' },
    latency_ms: attempt.ended_at ? Math.max(0, new Date(attempt.ended_at).getTime() - new Date(attempt.started_at).getTime()) : null,
    output: null,
    subject_protection: {
      mode: attempt.subject_protection?.mode ?? 'not_required',
      required: run.subject_protection?.required === true,
      mask: attempt.subject_protection?.mask ?? null,
      references: request.reference_plan ?? [],
      composite: null,
      warning: attempt.subject_protection?.warning ?? null,
    },
    error: { code: error.code, message: error.message, retryable: Boolean(error.retryable) },
  };
}
