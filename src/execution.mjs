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

export function formatFactText(fact) {
  const value = String(fact.value ?? '');
  const unit = String(fact.unit ?? '').trim();
  if (!value || !unit || value.toLowerCase().endsWith(unit.toLowerCase())) return value;
  return value + ' ' + unit;
}

export const EXECUTION_VERSION = 'r04.execution.3';

/** 视觉策略在 spec 里存英文枚举，进入执行指令时翻成中文，避免中英混排。 */
const SATURATION_LABEL = Object.freeze({ low: '低', medium: '中', high: '高' });
const BRIGHTNESS_LABEL = Object.freeze({ low: '偏暗', medium: '适中', high: '明亮' });
const TONE_LABEL = Object.freeze({
  neutral: '中性', warm_neutral: '暖中性', natural: '自然', warm: '暖调', cool: '冷调', deep: '深沉',
});

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
        text: formatFactText(fact),
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
      asset_ref: logo.asset_id ?? null, editable_text: false,
      note: 'Logo 使用品牌原图叠加，不让生成模型重绘',
    });
  }
  const compiled = layers.map((layer, index) => {
    const originalBox = layouts[Math.min(index, layouts.length - 1)] ?? layouts[0] ?? { x: 0.08, y: 0.82, width: 0.84, size: 0.04, weight: 500, align: 'left' };
    const layout = deliverable.text_layout;
    const box = layout && !layer.logo ? { ...originalBox, x: layout.x, y: Math.min(0.95, layout.y + index * layout.size_ratio * 1.5), width: layout.width, size: layout.size_ratio } : originalBox;
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

const SHOT_GUIDANCE = Object.freeze({
  main_image: '使用商品参考图已有的视角，完整展示商品，边缘留出安全距离；商品为第一视觉焦点。',
  selling_point: '保留可验证卖点对应的真实结构，确保商品和文字预留区分开；避免用悬浮图标或标签暗示未经确认的功能。',
  scene_image: '选择能解释商品用途的实景，道具少而明确；商品与台面接触自然，投影、反射与现场光向一致，道具不遮挡关键部件或包装。',
  detail_image: '围绕参考图中可见的真实材质、工艺或关键部件取景；保留足够的识别线索，不补绘参考图看不见的结构。',
  ad_vertical: '完整保留商品轮廓，建立清楚的纵向视觉层级，避免把商品或关键识别信息贴在上下边缘。',
  ad_landscape: '控制横幅中的主体比例，使用负空间组织画面，避免用拉伸或裁剪填满横幅。',
  social_inner: '使用自然的拍摄视角和可辨识的真实细节，让商品用途在无额外文字的情况下可理解。',
});

function promptSections({ project, spec, truth, brandKitVersion, deliverable, layers, missing, sceneDirection }) {
  const facts = (truth?.facts ?? []).filter(fact => fact.confirmed === true);
  const criticalFacts = facts.filter(fact => fact.critical === true);
  const otherFacts = facts.filter(fact => fact.critical !== true);
  const direction = spec?.creative_direction ?? {};
  const forbidden = spec?.template?.forbidden_changes ?? [];
  const banned = brandKitVersion?.banned_expressions ?? [];
  const palette = brandKitVersion?.palette ?? null;
  const lines = [];
  lines.push(`【任务】生成「${deliverable.label}」（${deliverable.type ?? 'image'}），画布 ${deliverable.width}×${deliverable.height}。`);
  lines.push(`【商品】${project?.name ?? '未命名商品'}${project?.category ? `，品类 ${project.category}` : ''}${project?.sku ? `，SKU ${project.sku}` : ''}。`);
  if (criticalFacts.length > 0) {
    lines.push(`【已确认关键事实】${criticalFacts.map(fact => `${fact.key}：${formatFactText(fact)}`).join('；')}。只能原样呈现，不得改写、扩写或新增功效。`);
  }
  if (otherFacts.length > 0) {
    lines.push(`【其他已确认事实】${otherFacts.map(fact => `${fact.key}：${formatFactText(fact)}`).join('；')}。未确认信息一律不得出现在画面中。`);
  }
  if ((truth?.critical_text ?? []).length > 0) {
    lines.push(`【包装关键文字】${truth.critical_text.map(item => item.text).join(' / ')}。必须与原始包装像素一致，不得重绘或替换。`);
  }
  const background = deliverable.background ?? direction.background;
  if (background === 'plain_white') {
    lines.push('【画面】纯白无缝背景，商品完整居中，保留自然接触阴影；背景不出现道具、图案或渐变。');
  } else {
    lines.push(`【画面】${SHOT_GUIDANCE[deliverable.type] ?? '商品主体清晰，并与环境在透视和光线上一致。'}`);
    lines.push(`【摄影方向】背景 ${background ?? '简洁'}；光线 ${direction.lighting ?? '柔和均匀'}；${direction.whitespace ?? '保留画面呼吸空间'}；机位 ${direction.camera ?? '与参考图一致'}，若参考图缺少所需视角，沿用可见视角。`);
  }
  // M-V2：氛围与色彩只在显式配置时追加。旧快照没有这两个字段 → 指令与执行哈希都保持原样。
  const atmosphere = typeof direction.atmosphere === 'string' ? direction.atmosphere.trim() : '';
  if (atmosphere) lines.push(`【氛围】${atmosphere}。`);
  if (background !== 'plain_white' && direction.color && typeof direction.color === 'object') {
    const color = direction.color;
    const bits = [];
    if (SATURATION_LABEL[color.saturation]) bits.push(`饱和度${SATURATION_LABEL[color.saturation]}`);
    if (BRIGHTNESS_LABEL[color.brightness]) bits.push(`整体${BRIGHTNESS_LABEL[color.brightness]}`);
    if (TONE_LABEL[color.tone]) bits.push(`${TONE_LABEL[color.tone]}色调`);
    if (bits.length > 0) lines.push(`【色彩】${bits.join('、')}；只作用于背景与环境，不得改变商品本体颜色。`);
  }
  if (deliverable.type === 'scene_image' && background !== 'plain_white' && sceneDirection) {
    lines.push(`【场景执行】${sceneDirection.guidance.join('')} 若与上文摄影方向冲突，按上文执行；若与文字留白冲突，以实际文字区域为准。`);
  }
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
    const zones = [...new Set(layers.map(layer =>
      `左侧起点 ${pct(layer.x)}、纵向位置 ${pct(layer.y)}、宽 ${pct(layer.width)}`))];
    lines.push(`【文字层】为后置排版留出低纹理区域（自画布左上角量起）：${zones.join('；')}。这些区域避开商品轮廓和关键部件。`);
  }
  lines.push('【图中文字】保留商品本身已有的包装文字与标识。营销标题、价格、规格角标和独立品牌 Logo 由系统后置排版，底图不新增这些元素。');
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
export function compileExecutionPlan({ project, spec, truth, brandKitVersion = null, sceneDirections = {} } = {}) {
  const deliverables = [];
  for (const item of spec?.deliverables ?? []) {
    const { layers, missing } = compileTextLayers({ deliverable: item, truth, brandKitVersion });
    const sceneDirection = item.type === 'scene_image' ? sceneDirections[item.id] : null;
    deliverables.push({
      ...(sceneDirection ? { scene_direction: sceneDirection } : {}),
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
      // 条件展开：旧快照没有 atmosphere/color 时不新增键，payload 结构与 content_hash 与改动前一致。
      ...(typeof spec?.creative_direction?.atmosphere === 'string' && spec.creative_direction.atmosphere.trim()
        ? { atmosphere: spec.creative_direction.atmosphere.trim() } : {}),
      ...(spec?.creative_direction?.color ? { color: { ...spec.creative_direction.color } } : {}),
      logo_allowed: item.logo_allowed === true,
      text_blocks: [...(item.text_blocks ?? [])],
      text_layers: layers,
      missing_text: missing,
      forbidden_changes: [...(spec?.template?.forbidden_changes ?? [])],
      prompt: promptSections({ project, spec, truth, brandKitVersion, deliverable: item, layers, missing, sceneDirection }),
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
    region: action.region ?? null,
  }));
  const preserve = preserveChecks.map(item => (typeof item === 'string' ? item : item?.code ?? String(item)));
  const text = [
    `【修订第 ${round} 轮】只修复以下问题：${targets.map(item => `${item.code ?? 'ISSUE'}${item.instruction ? `（${item.instruction}）` : ''}`).join('；') || '无具体项'}。`,
    ...targets.filter(item => item.region).map(item =>
      `【问题位置 ${item.code}】相对原成品左上角，问题框为 [${item.region.map(pct).join('、')}]（左、上、右、下）。这是复核定位，不能用作像素锁定。`),
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
      if (!layer.data_uri) return '';
      return `<g id="${escape(layer.id)}" data-source="brand_logo"><image href="${escape(layer.data_uri)}" x="${x}" y="${y}" width="${Math.round(layer.width * width)}" height="${Math.round(height * 0.12)}" preserveAspectRatio="xMinYMin meet"/></g>`;
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
