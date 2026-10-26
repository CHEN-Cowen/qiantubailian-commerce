import { ApiError } from './errors.mjs';

/**
 * 真实文件类型识别与图像尺寸解析。
 * 只依据文件头字节判断类型，不信任客户端声明的 Content-Type 或扩展名。
 * 零依赖实现，覆盖 M03 允许的 JPEG / PNG / WebP。
 */
export const IMAGE_TYPES = Object.freeze({
  'image/jpeg': Object.freeze({ ext: 'jpg', label: 'JPEG' }),
  'image/png': Object.freeze({ ext: 'png', label: 'PNG' }),
  'image/webp': Object.freeze({ ext: 'webp', label: 'WebP' }),
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    offset += 2 + size;
  }
  return null;
}

function webpSize(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (!width || !height) return null;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

export function readImageSize(buffer, mime) {
  if (mime === 'image/png') return pngSize(buffer);
  if (mime === 'image/jpeg') return jpegSize(buffer);
  if (mime === 'image/webp') return webpSize(buffer);
  return null;
}

/**
 * 校验并识别一张上传图片。类型不在白名单、文件头与格式不符、
 * 或文件已损坏（无法读出尺寸）都直接拒绝，不进入存储。
 */
export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, 'EMPTY_FILE', '上传内容为空');
  }
  const mime = sniffImageType(buffer);
  if (!mime) {
    throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', '仅支持真实的 JPEG、PNG 或 WebP 图片文件');
  }
  const size = readImageSize(buffer, mime);
  if (!size) {
    throw new ApiError(415, 'CORRUPT_IMAGE', '图片文件头不完整或已损坏，无法读取尺寸');
  }
  return { mime, ext: IMAGE_TYPES[mime].ext, width: size.width, height: size.height };
}
