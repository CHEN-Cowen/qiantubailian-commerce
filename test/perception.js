/**
 * M-V1 感知方向：枚举完整性、推荐确定性、信号优先级、降级与方案卡装配。
 *
 * 这些断言只验证"规则是否按声明执行"，不验证"方向推得好不好看"——
 * 后者需要真实商家校对，测试替代不了。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKGROUNDS, CONFIDENCE, PERCEPTION_GOALS, PERCEPTION_KEYS, PERCEPTION_VERSION, SCHEMES,
  STYLE_REF_MANIFEST_VERSION, WEIGHTS,
  buildDirectionCards, explainDirection, findScheme, getPerception, listPerceptions, needsMoreInput,
  recommendPerceptions, resolveVisualStrategy, schemesForDirection, styleReference,
} from '../src/perception.mjs';

test('七类方向完整、键唯一、二级标签非空', () => {
  assert.equal(PERCEPTION_GOALS.length, 7);
  assert.equal(new Set(PERCEPTION_KEYS).size, 7);
  for (const goal of PERCEPTION_GOALS) {
    assert.match(goal.key, /^[a-z_]+$/);
    assert.ok(goal.name.length > 0);
    assert.ok(goal.summary.length > 0);
    assert.ok(goal.tags.length >= 3, `${goal.key} 至少要有 3 个二级标签`);
    assert.ok(goal.tags.every(tag => typeof tag === 'string' && tag.length > 0));
  }
});

test('唯一真源被冻结，返回值改动不影响后续调用', () => {
  assert.ok(Object.isFrozen(PERCEPTION_GOALS));
  assert.ok(Object.isFrozen(PERCEPTION_KEYS));
  const first = listPerceptions();
  first[0].name = '被改坏';
  first[0].tags.push('脏数据');
  assert.notEqual(listPerceptions()[0].name, '被改坏');
  // 返回的是深拷贝：标签内容必须与真源一致，且长度不被外部 push 影响。
  assert.deepEqual(listPerceptions()[0].tags, PERCEPTION_GOALS[0].tags);
});

test('getPerception 命中返回拷贝，未知返回 null 而不抛错', () => {
  const goal = getPerception('quality_premium');
  assert.equal(goal.name, '品质与档次');
  goal.tags.push('x');
  assert.equal(getPerception('quality_premium').tags.length, 4);
  assert.equal(getPerception('not_a_goal'), null);
  assert.equal(getPerception(''), null);
  assert.equal(getPerception(null), null);
});

test('同输入永远同输出（幂等）', () => {
  const input = { category: '香氛', selling_points: '精致高级的手工玻璃瓶', price_positioning: '中高端', purpose: 'advertising' };
  const a = recommendPerceptions(input);
  const b = recommendPerceptions({ ...input });
  assert.deepEqual(a.candidates.map(item => item.key), b.candidates.map(item => item.key));
  assert.deepEqual(a.candidates.map(item => item.score), b.candidates.map(item => item.score));
  assert.equal(a.confidence, b.confidence);
});

test('默认返回 3 个互不重复的合法方向', () => {
  const result = recommendPerceptions({ category: '香氛', selling_points: '天然植物精油' });
  assert.equal(result.candidates.length, 3);
  assert.equal(new Set(result.candidates.map(item => item.key)).size, 3);
  for (const candidate of result.candidates) {
    assert.ok(PERCEPTION_KEYS.includes(candidate.key));
    assert.ok(candidate.reasons.length > 0, `${candidate.key} 被推荐却没有理由`);
    assert.ok(candidate.reference.status === 'unverified');
  }
  assert.equal(result.version, PERCEPTION_VERSION);
});

test('limit 可控，非法 limit 直接抛错而不是悄悄截断', () => {
  assert.equal(recommendPerceptions({ category: '家电' }, { limit: 2 }).candidates.length, 2);
  assert.equal(recommendPerceptions({ category: '家电' }, { limit: 1 }).candidates.length, 1);
  for (const bad of [0, -1, 8, 1.5, '3', null]) {
    assert.throws(() => recommendPerceptions({}, { limit: bad }), RangeError);
  }
});

test('完全无输入时降为 low，仍返回方向但把缺项说清楚', () => {
  const result = recommendPerceptions({});
  assert.equal(result.confidence, CONFIDENCE.low);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.missing_inputs, ['category', 'selling_points', 'price_positioning', 'purpose']);
  assert.equal(result.basis.category, null);
  assert.equal(needsMoreInput(result), true);
});

test('未知品类不算输入，标记 category_unrecognized 而不是猜一个方向', () => {
  const result = recommendPerceptions({ category: '不明飞行物' });
  assert.ok(result.missing_inputs.includes('category_unrecognized'));
  assert.equal(result.confidence, CONFIDENCE.low);
  assert.equal(needsMoreInput(result), true);
});

test('品类是弱信号：同一品类换卖点，首选方向会翻转', () => {
  const premium = recommendPerceptions({ category: '香氛', selling_points: '精致高级，手工吹制' });
  const natural = recommendPerceptions({ category: '香氛', selling_points: '天然植物，无添加' });
  assert.equal(premium.candidates[0].key, 'quality_premium');
  assert.equal(natural.candidates[0].key, 'natural_comfort');
});

test('关键词强于品类：跨品类也能被卖点主导', () => {
  // 家电的品类倾向里没有文化方向，全靠卖点关键词把它推到首位。
  const result = recommendPerceptions({ category: '家电', selling_points: '非遗古法，老字号匠心' });
  assert.equal(result.candidates[0].key, 'culture_heritage');
  assert.ok(result.candidates[0].signals.includes('keyword'));
});

test('同一卖点同时命中多个方向时不报错，同分按枚举顺序稳定排序', () => {
  // 「手工」属于品质语义，「非遗」属于文化语义，一个卖点同时命中两者是真实情况，
  // 不该由代码猜用户想表达哪个；同分时按枚举顺序给出可预期的结果。
  const result = recommendPerceptions({ category: '家电', selling_points: '手工打造，非遗技艺' });
  const keys = result.candidates.map(item => item.key);
  assert.ok(keys.includes('quality_premium'));
  assert.ok(keys.includes('culture_heritage'));
  assert.equal(keys[0], 'quality_premium', '同分按枚举顺序，不依赖 Array.sort 的稳定性');
});

test('价格定位参与打分，且理由可复现', () => {
  const result = recommendPerceptions({ category: '服饰', price_positioning: '平价' });
  const practical = result.candidates.find(item => item.key === 'practical_value');
  assert.ok(practical, '平价定位应把实用方向带进候选');
  assert.ok(practical.signals.includes('price'));
  assert.ok(practical.reasons.some(text => text.includes('平价')));
});

test('七个方向都能被某组正常输入推到首位（规则无死分支）', () => {
  const cases = [
    [{ category: '香氛', selling_points: '精致高级，真皮礼盒', price_positioning: '高端' }, 'quality_premium'],
    [{ category: '家电', selling_points: '专业认证，无菌标准' }, 'professional_trust'],
    [{ category: '护肤', selling_points: '天然有机，无添加温和' }, 'natural_comfort'],
    [{ category: '礼品', selling_points: '浪漫氛围，仪式感拉满' }, 'emotion_lifestyle'],
    [{ category: '服饰', selling_points: '潮流联名，年轻人都在穿' }, 'vital_innovation'],
    [{ category: '家居', selling_points: '耐用大容量，性价比高', price_positioning: '平价' }, 'practical_value'],
    [{ category: '茶', selling_points: '非遗古法，老字号匠心' }, 'culture_heritage'],
  ];
  const firsts = cases.map(([input]) => recommendPerceptions(input).candidates[0].key);
  assert.deepEqual(firsts, cases.map(([, expected]) => expected));
  assert.equal(new Set(firsts).size, 7, '七个方向应各自可被推到首位');
});

test('强信号且明显领先时给 high，信号接近时不给 high', () => {
  const strong = recommendPerceptions({ category: '香氛', selling_points: '精致高级奢华', price_positioning: '高端' });
  assert.equal(strong.confidence, CONFIDENCE.high);
  const weak = recommendPerceptions({ purpose: 'social' });
  assert.notEqual(weak.confidence, CONFIDENCE.high);
});

test('explainDirection 对无信号方向返回空数组，不编造理由', () => {
  assert.deepEqual(explainDirection('culture_heritage', { category: '数码' }), []);
  assert.ok(explainDirection('culture_heritage', { category: '茶' }).length > 0);
});

test('主图用途不贡献审美倾向（突出主体是产品保证，不是偏好）', () => {
  const listing = recommendPerceptions({ category: '香氛', purpose: 'listing' });
  assert.ok(listing.candidates.every(item => !item.signals.includes('purpose')));
});

test('权重表与实际打分一致，避免注释与代码漂移', () => {
  const single = recommendPerceptions({ category: '香氛', selling_points: '精致' }, { limit: 3 });
  const byKeyword = single.candidates.find(item => item.key === 'quality_premium');
  // 品类 +1 与关键词 +2 同时命中时，得分必须等于两者权重之和。
  assert.equal(byKeyword.score, WEIGHTS.category + WEIGHTS.keyword);
});

test('方案卡装配保留规则边界，有信号的方向标 recommended', () => {
  const recommendation = recommendPerceptions({ category: '香氛', selling_points: '天然植物' });
  const deck = buildDirectionCards(recommendation);
  assert.equal(deck.cards.length, 3);
  assert.equal(deck.version, PERCEPTION_VERSION);
  assert.equal(deck.confidence, recommendation.confidence);
  assert.ok(deck.rule_note.includes('未分析商品图片'));
  for (const [index, card] of deck.cards.entries()) {
    assert.equal(card.order, index + 1);
    assert.equal(card.source, 'recommended');
    assert.ok(card.reasons.length > 0);
  }
  assert.throws(() => buildDirectionCards(null), TypeError);
});

test('0 分方向只能标 fallback，不能冒充推荐', () => {
  // 完全空白时仍然是三个 0 分方向，用户要有得选；但给不出理由的不许叫"推荐"。
  const deck = buildDirectionCards(recommendPerceptions({}));
  assert.equal(deck.cards.length, 3);
  assert.ok(deck.cards.every(card => card.source === 'fallback'));
  assert.ok(deck.cards.every(card => card.reasons.length === 0));

  // 只有卖点信号时，第 2、3 位是 0 分兜底项，必须标 fallback（品类信号也算理由，不能用家电那种输入）。
  const mixed = buildDirectionCards(recommendPerceptions({ selling_points: '天然植物' }));
  assert.equal(mixed.cards[0].source, 'recommended');
  assert.equal(mixed.cards[0].key, 'natural_comfort');
  assert.deepEqual(mixed.cards.slice(1).map(card => card.source), ['fallback', 'fallback']);
});

test('参考图路径按方向与序号约定生成，且默认不声称已核验', () => {
  const ref = styleReference('quality_premium', '香氛', 2);
  assert.equal(ref.manifest, STYLE_REF_MANIFEST_VERSION);
  assert.equal(ref.path, 'assets/style-refs/quality_premium/2.jpg');
  // 品类只作元数据，不进路径：中文文件名在 URL 与静态白名单里都是坑。
  assert.equal(ref.category, '香氛');
  assert.ok(!ref.path.includes('香氛'));
  assert.equal(ref.status, 'unverified');
  assert.equal(styleReference('quality_premium', '香氛').path, 'assets/style-refs/quality_premium/1.jpg');
  assert.equal(styleReference('not_a_goal', '香氛'), null);
});

test('needsMoreInput 只在低置信且有缺项时为真', () => {
  assert.equal(needsMoreInput(null), false);
  assert.equal(needsMoreInput({ confidence: CONFIDENCE.high, missing_inputs: ['price_positioning'] }), false);
  assert.equal(needsMoreInput({ confidence: CONFIDENCE.low, missing_inputs: [] }), false);
  assert.equal(needsMoreInput({ confidence: CONFIDENCE.low, missing_inputs: ['category'] }), true);
});

test('能直接吃商品事实数组与多段卖点，不丢信号', () => {
  // 商品档案里卖点是 facts（{key,value,unit}），不是字符串；接入时不能要求上层先改结构。
  const fromFacts = recommendPerceptions({
    category: '香氛',
    facts: [
      { key: '主要卖点', value: '天然植物精油，无添加' },
      { key: '容量', value: '100', unit: 'ml' },
    ],
  });
  assert.equal(fromFacts.candidates[0].key, 'natural_comfort');
  assert.ok(fromFacts.candidates[0].reasons.some(text => text.includes('天然')));

  const fromArray = recommendPerceptions({ category: '香氛', selling_points: ['天然植物', '无添加'] });
  assert.equal(fromArray.candidates[0].key, 'natural_comfort');
});

test('唯一真源是深冻结的，连元素与标签都改不动', () => {
  assert.ok(Object.isFrozen(PERCEPTION_GOALS[0]));
  assert.ok(Object.isFrozen(PERCEPTION_GOALS[0].tags));
  assert.throws(() => { PERCEPTION_GOALS[0].name = 'x'; }, TypeError);
  assert.throws(() => { PERCEPTION_GOALS[0].tags.push('x'); }, TypeError);
});

test('参考图序号非法时回落到 1，不生成 0 或小数路径', () => {
  assert.ok(styleReference('quality_premium', '香氛', 0).path.endsWith('/1.jpg'));
  assert.ok(styleReference('quality_premium', '香氛', -5).path.endsWith('/1.jpg'));
  assert.ok(styleReference('quality_premium', '香氛', 1.5).path.endsWith('/1.jpg'));
});

test('方案卡装配拒绝非法 limit，不静默返回空卡', () => {
  const recommendation = recommendPerceptions({ category: '香氛' });
  assert.throws(() => buildDirectionCards(recommendation, { limit: 0 }), RangeError);
  assert.throws(() => buildDirectionCards(recommendation, { limit: -1 }), RangeError);
});

test('向导的粗分类品类也能命中（美妆/护肤、家居/日用）', () => {
  // 向导只提供粗分类选项，直接传「美妆/护肤」必须能拆开命中「美妆」「护肤」。
  const beauty = recommendPerceptions({ category: '美妆/护肤', selling_points: '天然植物，无添加' });
  assert.ok(!beauty.missing_inputs.includes('category_unrecognized'));
  assert.equal(beauty.candidates[0].key, 'natural_comfort');
  assert.ok(beauty.candidates.some(item => item.signals.includes('category')));

  const home = recommendPerceptions({ category: '家居/日用' });
  assert.ok(!home.missing_inputs.includes('category_unrecognized'));
  assert.ok(home.candidates.some(item => item.signals.includes('category')));

  // 「其他/不确定」不是有效品类，必须如实标记，不能假装识别到了
  const other = recommendPerceptions({ category: '其他' });
  assert.ok(other.missing_inputs.includes('category_unrecognized'));
});

// ---------- M-V3 方案卡 ----------

test('每个方向两个方案：id 唯一、枚举合法、A 案与方向默认策略一致', () => {
  for (const key of PERCEPTION_KEYS) {
    const schemes = SCHEMES[key];
    assert.equal(schemes.length, 2, `${key} 应有 2 个方案`);
    const defaultStrategy = resolveVisualStrategy(key).creative_direction;
    const seen = new Set();
    for (const scheme of schemes) {
      assert.equal(scheme.id, `${key}.${scheme === schemes[0] ? 'a' : 'b'}`, `${key} 方案 id 命名必须是 {key}.{a|b}`);
      assert.ok(!seen.has(scheme.id), `方案 id 重复：${scheme.id}`);
      seen.add(scheme.id);
      assert.equal(scheme.perception, key);
      assert.ok(BACKGROUNDS.includes(scheme.background), `${scheme.id} 背景不在枚举内`);
      assert.ok(scheme.name.trim() && scheme.summary.trim() && scheme.reason.trim(), `${scheme.id} 文案不能为空`);
      assert.ok(scheme.refIndex === 1 || scheme.refIndex === 2, `${scheme.id} refIndex 只能是 1 或 2`);
      assert.equal(typeof scheme.lighting, 'string');
      assert.ok(scheme.lighting.trim(), `${scheme.id} lighting 不能为空`);
      assert.ok(scheme.whitespace.trim(), `${scheme.id} whitespace 不能为空`);
    }
    // A 案必须就是方向默认策略，否则"方向推荐"与"方案A"两张嘴说话
    const [a] = schemes;
    assert.equal(a.background, defaultStrategy.background, `${key} A 案背景应与方向默认一致`);
    assert.equal(a.lighting, defaultStrategy.lighting, `${key} A 案光线应与方向默认一致`);
    assert.equal(a.whitespace, defaultStrategy.whitespace, `${key} A 案留白应与方向默认一致`);
    // B 案必须与 A 案有真实差异，否则用户比较的是假选项
    const [, b] = schemes;
    const differs = b.background !== a.background || b.lighting !== a.lighting || b.whitespace !== a.whitespace;
    assert.ok(differs, `${key} B 案与 A 案完全相同，没有可比性`);
  }
  // refIndex 覆盖：两案各占一张参考图，保证视觉上也不同
  for (const key of PERCEPTION_KEYS) {
    assert.deepEqual(SCHEMES[key].map(scheme => scheme.refIndex).sort(), [1, 2], `${key} 两案应分别锚定两张参考图`);
  }
});

test('schemesForDirection 与 findScheme：未知值返回空/null，不猜默认', () => {
  assert.deepEqual(schemesForDirection('natural_comfort').length, 2);
  assert.deepEqual(schemesForDirection('not_a_goal'), []);
  assert.deepEqual(schemesForDirection(''), []);
  const found = findScheme('natural_comfort.b');
  assert.equal(found.id, 'natural_comfort.b');
  assert.equal(findScheme('natural_comfort.z'), null);
  assert.equal(findScheme(''), null);
  assert.equal(findScheme(123), null);
});

test('方向卡携带方案列表，改动返回值不影响真源', () => {
  const deck = buildDirectionCards(recommendPerceptions({ category: '香氛' }));
  for (const card of deck.cards) {
    assert.equal(card.schemes.length, 2);
    assert.equal(card.schemes[0].id, `${card.key}.a`);
  }
  const schemes = deck.cards[0].schemes;
  schemes[0].name = '被改坏';
  assert.notEqual(SCHEMES[deck.cards[0].key][0].name, '被改坏');
});
