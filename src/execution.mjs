/**
 * R04：执行指令编译。
 *
 * 目标不是"写一句更长的提示词"，而是保证冻结快照里的每一项要求真正进入供应商请求：
 * - 商品事实（已确认/关键）、包装关键文字 → 只引用事实，不扩写；
 * - 品牌（色彩、字体、Logo、禁用表达）→ 进入品牌约束；
 * - 视觉配置（背景、光线、构图、留白、机位）→ 进入执行指令；
 * - 平台尺寸与格式 → 取自冻结快照，不改写；
 * - 文字排版 → 进入可编辑文字层，并明确要求供应商不要绘制精确文字，避免乱码；
 * - 修订 → 带具体错误码与必须保留的通过项。
 *
 * 同一份快照编译结果稳定（相同输入 → 相同哈希），便于对比"配置变了请求是否跟着变"。
 */
import { createHash } from 'node:crypto';

export const EXECUTION_VERSION = 'r04.execution.1';
export const TEXT_POLICY = Object.freeze({
  render_text_by_provider: false,
  reason: '精确文字与 Logo 由可编辑排版层叠加，避免生成模型绘制文字导致乱码或错字',
  overlay_format: 'svg',
});

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pct = value => `${Math.round(value * 1000) / 10}%`;

/** 交付物类型决定文字层放在哪里；没有配置就成了"摆设"，所以这里给出明确版式。 */
const LAYOUTS = Object.freeze({
  main_image: [],
  selling_point: [
    { x: 0.08, y: 0.1, width: 0.54, size: 0.072, weight: 700, align: 'left' },
    { x: 0.08, y: 0.82, width: 0.84, size: 0.036, weight: 500, align: 'left' },
  ],
  scene_image: [
    { x: 0.08, y: 0.12, width: 0.5, size: 0.05, weight: 600, align: 'left' },
  ],
  detail_image: [
    { x: 0.08, y: 0.8, width: 0.84, size: 0.042, weight: 600, align: 'left' },
  ],
});

function textLayerTexts({ textBlocks = [], truth }) {
  const facts = new Map((truth?.facts ?? []).map(fact => [fact.key, fact]));
  const layers = [];
  const missing = [];
  for (const block of textBlocks) {
    if (block === 'critical_text') {
      for (const item of truth?.critical_text ?? []) {
        if (!item?.text) continue;
        layers.push({
          source: 'critical_text',
          fact_key: null,
          text: item.text,
          editable_text: true,
          must_match_source_pixels: true,
        });
      }
      if ((truth?.critical_text ?? []).length === 0) missing.push({ block, reason: 'NO_CRITICAL_TEXT' });
      continue;
    }
    if (!block.startsWith('fact:')) {
      missing.push({ block, reason: 'UNKNOWN_TEXT_BLOCK' });
      continue;
    }
    const key = block.slice(5);
    const fact = facts.get(key) ?? null;
    if (!fact) missing.push({ block, reason: 'FACT_REFERENCE_MISSING', fact_key: key });
    else if (fact.confirmed !== true) missing.push({ block, reason: 'FACT_NOT_CONFIRMED', fact_key: key });
    else {
      layers.push({
        source: 'fact',
        fact_key: key,
        text: String(fact.value),
        critical: fact.critical === true,
        editable_text: true,
      });
    }
  }
  return { layers, missing };
}

/**
 * 编译单个交付物的文字层。位置来自类型版式，字体与颜色来自品牌套件；
 * 没有品牌套件时用中性默认值，但仍标记为"未采用品牌字体"。
 */
export function compileTextLayers({ deliverable, truth, brandKitVersion = null } = {}) {
  const { layers, missing } = textLayerTexts({ textBlocks: deliverable?.text_blocks ?? [], truth });
  const layouts = LAYOUTS[deliverable?.type ?? ''] ?? LAYOUTS.selling_point;
  const palette = brandKitVersion?.palette ?? null;
  const font = brandKitVersion?.fonts?.find(item => item.role === 'heading')
    ?? brandKitVersion?.fonts?.[0] ?? null;
  const logo = brandKitVersion?.logo ?? null;
  if (logo?.present === true && deliverable?.logo_allowed === true) {
    layers.push({
      source: 'brand_logo', fact_key: null, text: '', logo: true,
      asset_ref: logo.asset_sha256 ?? null, editable_text: false,
      note: 'Logo 使用品牌原图叠加，不让生成模型重绘',
    });
  }
  const compiled = layers.map((layer, index) => {
    const box = layouts[Math.min(index, layouts.length - 1)] ?? layouts[0] ?? { x: 0.08, y: 0.82, width: 0.84, size: 0.04, weight: 500, align: 'left' };
    return {
      id: `layer_${index + 1}`,
      ...layer,
      x: box.x,
      y: box.y,
      width: box.width,
      size_ratio: box.size,
      weight: box.weight,
      align: box.align,
      color: palette?.primary ?? '#2A2420',
      background: palette?.secondary?.[0] ?? null,
      font_family: font?.name ?? null,
      font_license: font?.license ?? 'unknown',
      bounding_box: {
        x: pct(box.x), y: pct(box.y), width: pct(box.width),
        note: '相对画布比例；导出时可编辑调整',
      },
    };
  });
  return { layers: compiled, missing, layout: deliverable?.type ?? null };
}

function promptSections({ project, spec, truth, brandKitVersion, deliverable, layers, missing }) {
  const facts = (truth?.facts ?? []).filter(fact => fact.confirmed === true);
  const criticalFacts = facts.filter(fact => fact.critical === true);
  const otherFacts = facts.filter(fact => fact.critical !== true);
  const direction = spec?.creative_direction ?? {};
  const forbidden = spec?.template?.forbidden_changes ?? [];
  const banned = brandKitVersion?.banned_expressions ?? [];
  const palette = brandKitVersion?.palette ?? null;
  const lines = [];
  lines.push(`【任务】生成「${deliverable.label}」（${deliverable.type ?? 'image'}，${deliverable.width}×${deliverable.height}，比例 ${deliverable.ratio ?? '按尺寸'}）。`);
  lines.push(`【商品】${project?.name ?? '未命名商品'}${project?.category ? `，品类 ${project.category}` : ''}${project?.sku ? `，SKU ${project.sku}` : ''}。`);
  if (criticalFacts.length > 0) {
    lines.push(`【已确认关键事实】${criticalFacts.map(fact => `${fact.key}：${fact.value}`).join('；')}。只能原样呈现，不得改写、扩写或新增功效。`);
  }
  if (otherFacts.length > 0) {
    lines.push(`【其他已确认事实】${otherFacts.map(fact => `${fact.key}：${fact.value}`).join('；')}。未确认信息一律不得出现在画面中。`);
  }
  if ((truth?.critical_text ?? []).length > 0) {
    lines.push(`【包装关键文字】${truth.critical_text.map(item => item.text).join(' / ')}。必须与原始包装像素一致，不得重绘或替换。`);
  }
  lines.push(`【背景】${deliverable.background ?? direction.background ?? '按模板'}；【光线】${direction.lighting ?? '按模板'}；【构图】${direction.whitespace ?? '无特殊要求'}，${direction.camera ?? '平视'}。`);
  if (palette) {
    lines.push(`【品牌色】主色 ${palette.primary}${palette.secondary?.length ? `，辅色 ${palette.secondary.join('、')}` : ''}；只用于场景与排版氛围，不得改变商品本体颜色。`);
  }
  if (brandKitVersion?.fonts?.length) {
    const unlicensed = brandKitVersion.fonts.filter(item => item.license !== 'licensed').map(item => item.name);
    lines.push(`【品牌字体】${brandKitVersion.fonts.map(item => `${item.name}（${item.license}）`).join('、')}${unlicensed.length > 0 ? '；未授权字体不得用于商用成品' : ''}。`);
  }
  if (banned.length > 0) lines.push(`【禁用表达】${banned.join('、')}；任何情况下都不得出现。`);
  if (forbidden.length > 0) lines.push(`【不可改变】${forbidden.join('、')}。`);
  if (layers.length > 0) {
    lines.push('【文字层】画面的营销文字与 Logo 由系统排版层叠加：请留出对应留白区域，不要在图像中绘制或改写任何文字、数字、Logo。');
  }
  lines.push('【主体保护】商品形状、包装文字、Logo 与颜色必须与参考图完全一致；只允许调整光线、阴影与场景。');
  lines.push(`【平台】${spec?.channel?.platform ?? '未指定'}；尺寸与格式按冻结快照输出，不额外裁切。平台审核结论未核验，不要声称一定能通过审核。`);
  if (missing.length > 0) {
    lines.push(`【缺失信息】${missing.map(item => item.reason).join('、')}；不得猜测或补写缺失内容。`);
  }
  return lines.join('\n');
}

/**
 * 编译整份执行计划：一次生成、逐交付物可查。
 */
export function compileExecutionPlan({ project, spec, truth, brandKitVersion = null } = {}) {
  const deliverables = [];
  for (const item of spec?.deliverables ?? []) {
    const { layers, missing } = compileTextLayers({ deliverable: item, truth, brandKitVersion });
    deliverables.push({
      template_deliverable_id: item.id,
      label: item.label,
      type: item.type,
      width: item.width,
      height: item.height,
      ratio: item.ratio,
      formats: [...(item.formats ?? [])],
      background: item.background ?? spec?.creative_direction?.background ?? null,
      lighting: spec?.creative_direction?.lighting ?? null,
      composition: {
        whitespace: spec?.creative_direction?.whitespace ?? null,
        camera: spec?.creative_direction?.camera ?? null,
      },
      logo_allowed: item.logo_allowed === true,
      text_blocks: [...(item.text_blocks ?? [])],
      text_layers: layers,
      missing_text: missing,
      forbidden_changes: [...(spec?.template?.forbidden_changes ?? [])],
      prompt: promptSections({ project, spec, truth, brandKitVersion, deliverable: item, layers, missing }),
    });
  }
  const usedFacts = (truth?.facts ?? []).filter(fact => fact.confirmed === true)
    .map(fact => ({ key: fact.key, value: fact.value, critical: fact.critical === true }));
  const payload = {
    version: EXECUTION_VERSION,
    product: {
      name: project?.name ?? null,
      category: project?.category ?? null,
      sku: project?.sku ?? null,
    },
    truth_ref: truth ? { version: truth.version, content_hash: truth.content_hash } : null,
    facts: usedFacts,
    critical_text: (truth?.critical_text ?? []).map(item => item.text),
    brand: brandKitVersion
      ? {
        brand_kit_id: brandKitVersion.brand_kit_id ?? null,
        version: brandKitVersion.version ?? null,
        content_hash: brandKitVersion.content_hash ?? null,
        palette: brandKitVersion.palette ?? null,
        fonts: (brandKitVersion.fonts ?? []).map(item => ({ name: item.name, role: item.role ?? null, license: item.license })),
        logo_present: brandKitVersion.logo?.present === true,
        banned_expressions: [...(brandKitVersion.banned_expressions ?? [])],
      }
      : null,
    spec_ref: spec ? { version: spec.version, content_hash: spec.content_hash } : null,
    channel: spec?.channel
      ? {
        platform: spec.channel.platform ?? null,
        rule_version: spec.channel.version ?? null,
        coverage: spec.channel.coverage ?? null,
        can_claim_platform_compliance: spec.channel.can_claim_platform_compliance === true,
      }
      : null,
    text_policy: { ...TEXT_POLICY },
    deliverables,
  };
  return { ...payload, content_hash: sha(payload) };
}

export function executionForDeliverable(plan, { templateDeliverableId = null, deliverableId = null } = {}) {
  if (!plan) return null;
  const templateId = templateDeliverableId
    ?? (deliverableId && deliverableId.includes('#') ? deliverableId.split('#')[0] : deliverableId);
  return plan.deliverables.find(item => item.template_deliverable_id === templateId) ?? null;
}

/** 修订指令：只修一个关键项，明确列出必须保留的通过项。 */
export function compileRevisionInstruction({ actions = [], preserveChecks = [], round = 1 } = {}) {
  const targets = actions.map(action => ({
    code: action.code ?? null,
    label: action.label ?? null,
    instruction: action.instruction ?? action.message ?? null,
    target: action.target ?? null,
  }));
  const preserve = preserveChecks.map(item => (typeof item === 'string' ? item : item?.code ?? String(item)));
  const text = [
    `【修订第 ${round} 轮】只修复以下问题：${targets.map(item => `${item.code ?? 'ISSUE'}${item.instruction ? `（${item.instruction}）` : ''}`).join('；') || '无具体项'}。`,
    preserve.length > 0 ? `【必须保留】${preserve.join('、')} 已通过，不得回退或改动。` : '【必须保留】已通过项不得回退。',
    '不要顺带做审美改版；无法确认的项保持原样并标注未知。',
  ].join('\n');
  return { targets, preserve_checks: preserve, text, hash: sha({ targets, preserve }) };
}

/** 把文字层渲染成可编辑 SVG：图片嵌入 + 文字元素，打开即可改字、改色、改位置。 */
export function buildOverlaySvg({ width, height, mime, bytes, layers = [], title = '' } = {}) {
  const href = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
  const body = layers.map(layer => {
    const x = Math.round(layer.x * width);
    const y = Math.round(layer.y * height);
    const size = Math.max(12, Math.round(layer.size_ratio * Math.min(width, height)));
    const font = layer.font_family ? `font-family="${escape(layer.font_family)}"` : '';
    if (layer.logo) {
      return `<g id="${escape(layer.id)}" data-source="brand_logo"><text x="${x}" y="${y}" font-size="${size}" fill="${escape(layer.color)}" ${font}>[Logo 图层：使用品牌原图叠加]</text></g>`;
    }
    const anchor = layer.align === 'center' ? 'middle' : 'start';
    const textX = layer.align === 'center' ? Math.round((layer.x + layer.width / 2) * width) : x;
    return `<g id="${escape(layer.id)}" data-source="${escape(layer.source)}"${layer.fact_key ? ` data-fact="${escape(layer.fact_key)}"` : ''}>`
      + `<text x="${textX}" y="${y}" font-size="${size}" font-weight="${layer.weight}" text-anchor="${anchor}" fill="${escape(layer.color)}" ${font}>${escape(layer.text)}</text></g>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
    + `  <title>${escape(title)}</title>\n`
    + `  <image href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>\n`
    + `  ${body}\n</svg>\n`;
}

export { LAYOUTS as OVERLAY_LAYOUTS };
