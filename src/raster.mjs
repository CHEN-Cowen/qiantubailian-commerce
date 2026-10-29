import sharp from 'sharp';
import { buildOverlaySvg } from './execution.mjs';
import { createSubjectMask } from './m06.mjs';
import { createHash } from 'node:crypto';

export async function prepareSubjectMask({ bytes, mime, box = null }) {
  let png;
  try { png = await sharp(bytes, { limitInputPixels: 48_000_000 }).rotate().png().toBuffer(); }
  catch { return createSubjectMask({ bytes, mime, box }); }
  const mask = createSubjectMask({ bytes: png, mime: 'image/png', box });
  if (!mask.available || !box) return mask;
  const alpha = await sharp(mask.maskBytes).removeAlpha().greyscale().raw().toBuffer();
  const cutoutBytes = await sharp(png).resize(mask.width, mask.height, { kernel: 'nearest' }).removeAlpha()
    .joinChannel(alpha, { raw: { width: mask.width, height: mask.height, channels: 1 } }).png().toBuffer();
  return { ...mask, cutoutBytes, cutout_sha256: createHash('sha256').update(cutoutBytes).digest('hex'),
    has_cutout: true, method: 'manual_box_pixels', message: '保留框内原始商品像素（含框内背景），边缘和摆放仍需复核' };
}

/** E06：把确定性排版的 SVG 栅格化为 PNG（librsvg），不经过任何生图模型。 */
export async function renderSvgPng(svg, { width = null, height = null } = {}) {
  const pipeline = sharp(Buffer.from(svg), { limitInputPixels: 48_000_000 });
  if (width && height) pipeline.resize(width, height, { fit: 'fill' });
  return pipeline.png({ adaptiveFiltering: false }).toBuffer();
}

export async function decodeToPng(bytes) {
  return sharp(bytes, { limitInputPixels: 48_000_000 }).rotate().removeAlpha().png({ adaptiveFiltering: false }).toBuffer();
}

export async function draftPreview(bytes) {
  const base = await sharp(bytes, { limitInputPixels: 48_000_000 }).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const { width, height } = await sharp(base).metadata();
  const mark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="${height / 2 - 28}" width="100%" height="56" fill="white" opacity="0.8"/><text x="50%" y="${height / 2 + 8}" text-anchor="middle" font-size="22" fill="#555">千图百炼 · 待验收预览</text></svg>`);
  return sharp(base).composite([{ input: mark }]).png().toBuffer();
}

export async function renderLayers({ bytes, width, height, layers = [], logoBytes = null, format = 'png' }) {
  const resolved = layers.map(layer => {
    if (!layer.logo) return layer;
    if (!logoBytes) throw new Error('缺少品牌 Logo 原图，请上传后重新冻结配置');
    return { ...layer, data_uri: `data:image/png;base64,${logoBytes.toString('base64')}` };
  });
  const svg = buildOverlaySvg({ bytes, width, height, mime: 'image/png', layers: resolved });
  const pipeline = sharp(Buffer.from(svg), { limitInputPixels: 48_000_000 });
  const losslessBytes = await pipeline.png().toBuffer();
  return { svg, losslessBytes, bytes: format === 'jpg' ? await sharp(losslessBytes).jpeg({ quality: 95 }).toBuffer() : losslessBytes };
}
