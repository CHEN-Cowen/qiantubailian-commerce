/**
 * M13 文字排版修改（不改图，只改可编辑层）。
 *
 * 边界：
 * 1. 只允许改文字层的文案/位置/字号/宽度，不触碰生成图本身的像素；
 *    商品外形、包装关键文字、Logo 仍然是原样叠加或原样保留。
 * 2. 包装关键文字（must_match_source_pixels）不可改写，只能保留；
 *    一旦允许改写，就变成"用排版层伪造包装信息"。
 * 3. 任何越界参数都返回具体问题码，不静默截断，让前端能告诉用户改了什么。
 */

export const TEXT_EDIT_VERSION = 'm13.text-edit.1';

export const TEXT_EDIT_LIMITS = Object.freeze({
  text_max_length: 60,
  min_width: 0.15,
  max_width: 0.96,
  min_size_ratio: 0.018,
  max_size_ratio: 0.16,
  min_x: 0,
  max_x: 0.95,
  min_y: 0.02,
  max_y: 0.98,
});

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

/** 前端展示用：只暴露可编辑字段与可读来源，不返回整份执行计划。 */
export function presentTextLayers(layers = []) {
  return layers.map(layer => ({
    id: layer.id,
    source: layer.source ?? null,
    label: layer.source === 'critical_text' ? '包装关键文字' : layer.logo ? '品牌 Logo' : layer.fact_key ?? '营销文字',
    text: layer.text ?? '',
    logo: layer.logo === true,
    editable_text: layer.editable_text === true && layer.logo !== true && layer.must_match_source_pixels !== true,
    editable_layout: layer.logo !== true && layer.must_match_source_pixels !== true,
    readonly_reason: layer.must_match_source_pixels === true ? 'PACKAGING_TEXT_MUST_MATCH_PIXELS' : layer.logo === true ? 'LOGO_USES_ORIGINAL_PIXEL' : null,
    x: layer.x, y: layer.y, width: layer.width, size_ratio: layer.size_ratio,
    align: layer.align ?? 'left',
    color: layer.color ?? null,
  }));
}

/**
 * 合并用户修改。返回新层集合与逐项问题；不抛异常，由调用方决定是否受理。
 * 至少一项实际发生变化才算修改成功（避免"点一下保存"就产出一个新版本）。
 */
export function applyTextEdits({ layers = [], edits = [] } = {}) {
  const limits = TEXT_EDIT_LIMITS;
  const issues = [];
  const byId = new Map(layers.map(layer => [layer.id, layer]));
  const seen = new Set();
  let changed = false;
  const next = layers.map(layer => ({ ...layer }));

  for (const edit of Array.isArray(edits) ? edits : []) {
    const id = String(edit?.id ?? '').trim();
    const target = byId.get(id);
    if (!target) { issues.push({ id, code: 'LAYER_NOT_FOUND', message: '文字层不存在' }); continue; }
    if (seen.has(id)) { issues.push({ id, code: 'DUPLICATE_LAYER_EDIT', message: '同一文字层被重复修改' }); continue; }
    seen.add(id);
    const index = next.findIndex(item => item.id === id);
    const layer = next[index];
    if (target.logo === true) { issues.push({ id, code: 'LAYER_NOT_EDITABLE', message: 'Logo 使用品牌原图，不可在排版层改写' }); continue; }
    if (target.must_match_source_pixels === true) {
      issues.push({ id, code: 'PACKAGING_TEXT_READONLY', message: '包装关键文字必须与原始包装一致，不可改写' });
      continue;
    }
    if (edit.text !== undefined) {
      const text = String(edit.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) { issues.push({ id, code: 'TEXT_EMPTY', message: '文字不能为空，如需隐藏请调整位置而不是清空' }); continue; }
      if (text.length > limits.text_max_length) {
        issues.push({ id, code: 'TEXT_TOO_LONG', message: `文字超过 ${limits.text_max_length} 字，请精简后再保存` });
        continue;
      }
      if (text !== layer.text) { layer.text = text; changed = true; }
    }
    for (const [key, min, max] of [
      ['x', limits.min_x, limits.max_x],
      ['y', limits.min_y, limits.max_y],
      ['width', limits.min_width, limits.max_width],
      ['size_ratio', limits.min_size_ratio, limits.max_size_ratio],
    ]) {
      if (edit[key] === undefined) continue;
      const value = Number(edit[key]);
      if (!Number.isFinite(value)) { issues.push({ id, code: 'LAYOUT_INVALID', message: `${key} 必须是数字` }); continue; }
      if (value < min || value > max) {
        issues.push({ id, code: 'LAYOUT_OUT_OF_RANGE', message: `${key} 需在 ${min}—${max} 之间` });
        continue;
      }
      if (Math.abs(value - layer[key]) > 1e-6) { layer[key] = value; changed = true; }
    }
  }

  return {
    layers: next,
    changed,
    issues,
    summary: next.filter(layer => layer.logo !== true)
      .map(layer => ({ id: layer.id, source: layer.source ?? null, fact_key: layer.fact_key ?? null, text: layer.text })),
  };
}

/** 排版层的可读摘要，写进版本备注，方便回看"这一版改了哪句话"。 */
export function describeTextEdits({ before = [], after = [] } = {}) {
  const previous = new Map(before.map(layer => [layer.id, layer]));
  const changes = [];
  for (const layer of after) {
    const old = previous.get(layer.id);
    if (!old) continue;
    if (old.text !== layer.text) changes.push({ id: layer.id, field: 'text', from: old.text, to: layer.text });
    for (const key of ['x', 'y', 'width', 'size_ratio']) {
      if (Math.abs(Number(old[key]) - Number(layer[key])) > 1e-6) {
        changes.push({ id: layer.id, field: key, from: old[key], to: layer[key] });
      }
    }
  }
  return changes;
}

/** 前端滑块的安全边界，与后端校验完全一致。 */
export function textEditLimits() {
  return { ...TEXT_EDIT_LIMITS, version: TEXT_EDIT_VERSION };
}

export { clampNumber };
