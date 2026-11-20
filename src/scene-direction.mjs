const OPTIONS = {
  surface: {
    neutral: '使用低纹理哑光台面，台面色彩与主体形成适度明度差。',
    wood: '使用低饱和浅木台面，压低木纹对包装细节的干扰。',
    stone: '使用细纹哑光石材台面，避免镜面反射干扰包装识别。',
  },
  lighting: {
    soft: '使用柔和主光，在商品底部形成轻微接触阴影。',
    window: '使用单侧柔和窗光，背景与商品投影服从同一光向。',
    studio: '使用大面积柔光，控制包装高光，确保标签区域清楚可辨。',
  },
  props: {
    none: '场景仅保留商品与环境，不加入额外物件。',
    subtle: '最多使用一件弱化的背景道具，远离商品和文字区域，避免暗示随商品附送。',
  },
};

const DEFAULTS = { surface: 'neutral', lighting: 'soft', props: 'none' };
const descriptions = choices => Object.entries(OPTIONS).map(([key, options]) => options[choices[key]]);

export async function planSceneDirections({
  project, spec, deliverableIds, brandKitVersion, env = process.env, fetchImpl = globalThis.fetch,
}) {
  const scenes = (spec.deliverables ?? []).filter(item =>
    item.type === 'scene_image' && item.background !== 'plain_white' && deliverableIds.has(item.id));
  if (scenes.length === 0) return {};

  const endpoint = env.QTB_SCENE_PLANNER_ENDPOINT?.trim();
  const model = env.QTB_SCENE_PLANNER_MODEL?.trim();
  return Object.fromEntries(await Promise.all(scenes.map(async scene => {
    let choices = DEFAULTS;
    let source = 'default';
    if (endpoint && model) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(env.QTB_SCENE_PLANNER_API_KEY?.trim()
              ? { authorization: 'Bearer ' + env.QTB_SCENE_PLANNER_API_KEY.trim() } : {}),
          },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content: '为电商详情页场景图选择与现有方向协调的台面、辅助布光和道具密度。只返回 JSON 对象，键为 surface、lighting、props。商品、文字、机位及布局由系统决定。',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  category: project.category ?? null,
                  purpose: scene.label,
                  direction: spec.creative_direction ?? {},
                  background: scene.background,
                  palette: brandKitVersion?.palette ?? null,
                  options: OPTIONS,
                }),
              },
            ],
          }),
        });
        if (!response.ok) throw new Error('Scene planner request failed');
        const payload = await response.json();
        const proposed = JSON.parse(payload.choices?.[0]?.message?.content);
        if (!proposed || !Object.entries(OPTIONS).every(([key, options]) =>
          typeof proposed[key] === 'string' && Object.hasOwn(options, proposed[key]))) {
          throw new Error('Invalid scene choices');
        }
        choices = proposed;
        source = 'model';
      } catch {
        source = 'fallback';
      }
    }
    return [scene.id, { source, model: source === 'model' ? model : null, guidance: descriptions(choices) }];
  })));
}
