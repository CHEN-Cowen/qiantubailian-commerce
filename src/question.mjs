/**
 * E05 售前问题分流与最小必要修改：脱敏输入校验、归类建议、五类分流（纯函数，不含 IO）。
 *
 * 业务规则（MASTER-PROMPT 第 6 节 / PRD 第 9 节）：
 * 1. 输入为手动填写/粘贴的脱敏问题；不接客服账号、不导入聊天、不抓取私人数据。
 *    限制长度，检测到明显个人信息（手机号/身份证/长串订单号/邮箱/收货地址）拒绝入库并提示去除。
 * 2. 没有真实频次只显示「输入的问题」，绝不伪造「高频」；商家可人工提供来源与次数，明确标注人工提供。
 * 3. 五类分流结果：reuse_existing（已有内容可复用）/ missing_facts（缺少依据，附补充清单）/
 *    text_suggestion（已有事实但说明不明显，给简短文字与位置建议）/ needs_explainer（需要补图，给图种与提纲）/
 *    out_of_scope（物流/支付/库存/主题页面故障，标清处理边界，不强行生成商品图解决）。
 * 4. 不编造事实：提纲与文字建议只引用已确认事实与档案条目；尺寸说明不能断言适配所有场景。
 */
import { ApiError } from './errors.mjs';

export const QUESTION_CATEGORIES = Object.freeze(['quantity', 'size', 'spec_diff', 'usage', 'other']);
/** 非商品图问题：分流到对应处理边界，不卖生图 */
export const OUT_OF_SCOPE_CATEGORIES = Object.freeze(['logistics', 'payment', 'inventory', 'theme']);
export const QUESTION_RESULTS = Object.freeze([
  'reuse_existing', 'missing_facts', 'text_suggestion', 'needs_explainer', 'out_of_scope',
]);

export const QUESTION_LIMITS = Object.freeze({
  textMax: 500,
  sourceMax: 50,
  frequencyMax: 9999,
});

export const CATEGORY_LABELS = Object.freeze({
  quantity: '数量/包含物',
  size: '尺寸',
  spec_diff: '规格差别',
  usage: '使用方式',
  other: '其他',
  logistics: '物流/配送',
  payment: '支付/退款',
  inventory: '库存/缺货',
  theme: '店铺主题/页面',
});

export const RESULT_LABELS = Object.freeze({
  reuse_existing: '已有内容可复用',
  missing_facts: '缺少依据',
  text_suggestion: '文字/位置建议',
  needs_explainer: '需要补图',
  out_of_scope: '不属于商品图问题',
});

/** 非商品图问题的处理边界指引（不强行生成商品图）。 */
const SCOPE_GUIDANCE = Object.freeze({
  logistics: '物流/配送问题请在店铺物流工具或承运商处处理；商品图不能回答时效与包裹状态',
  payment: '支付/退款/发票问题请在店铺交易与财务工具处理；商品图不承担交易说明',
  inventory: '库存/缺货问题请在店铺库存工具处理；商品图不能声明现货状态',
  theme: '店铺主题/页面切图故障属于店铺装修与模板范围，请用店铺装修工具处理；本系统只维护商品图内容',
});

/** 补图图种（E06 执行的三种说明图）。 */
export const EXPLAINER_KINDS = Object.freeze({
  quantity: 'packing_list',
  size: 'size',
  spec_diff: 'sku_compare',
});
export const EXPLAINER_KIND_LABELS = Object.freeze({
  packing_list: '包装内容清单图',
  size: '尺寸说明图',
  sku_compare: 'SKU 规格对比图',
});

// ---------- 输入校验与脱敏提示 ----------

/** 明显个人信息模式：检测到即拒绝入库，提示商家先去除（日志不落原文）。 */
const PII_PATTERNS = [
  { type: 'phone', label: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { type: 'id_card', label: '身份证号', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { type: 'long_number', label: '长串数字（疑似订单/快递单号）', pattern: /(?<!\d)\d{12,}(?!\d)/ },
  { type: 'email', label: '邮箱地址', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { type: 'address', label: '收货地址', pattern: /(收货地址|详细地址|地址[:：])/ },
];

export function detectPii(text) {
  return PII_PATTERNS.filter(item => item.pattern.test(String(text ?? ''))).map(item => item.type);
}

/**
 * 问题输入校验：text 必填限长；frequency 可选（count+source 必须同时出现，标注人工提供）。
 * 命中明显个人信息 → 422 PII_DETECTED（只在 message 里列类型，不回显原文）。
 */
export function validateQuestionInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_BODY', '请求体必须为 JSON 对象');
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new ApiError(422, 'INVALID_FIELD', 'text 必填：请输入顾客问题');
  if (text.length > QUESTION_LIMITS.textMax) {
    throw new ApiError(422, 'INVALID_FIELD', `问题最长 ${QUESTION_LIMITS.textMax} 字符，请精简后输入`);
  }
  const pii = detectPii(text);
  if (pii.length > 0) {
    const labels = pii.map(type => PII_PATTERNS.find(item => item.type === type).label).join('、');
    throw new ApiError(422, 'PII_DETECTED',
      `问题文本疑似包含个人信息（${labels}）。请去除姓名、电话、地址与订单号后再提交；系统不存储原始敏感信息`,
      { pii_types: pii });
  }
  const skuId = typeof body.sku_id === 'string' && body.sku_id.trim() !== '' ? body.sku_id.trim() : null;
  let frequency = null;
  if (body.frequency !== undefined && body.frequency !== null) {
    const raw = body.frequency;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ApiError(422, 'INVALID_FIELD', 'frequency 必须为 { count, source } 对象');
    }
    const count = Number(raw.count);
    const source = typeof raw.source === 'string' ? raw.source.trim() : '';
    if (!Number.isInteger(count) || count < 1 || count > QUESTION_LIMITS.frequencyMax) {
      throw new ApiError(422, 'INVALID_FIELD', `frequency.count 必须为 1..${QUESTION_LIMITS.frequencyMax} 的整数`);
    }
    if (!source || source.length > QUESTION_LIMITS.sourceMax) {
      throw new ApiError(422, 'INVALID_FIELD', `frequency.source 必填且不超过 ${QUESTION_LIMITS.sourceMax} 字符（人工提供的来源说明）`);
    }
    frequency = { count, source };
  }
  return { text, skuId, frequency };
}

/** 频次展示口径：无真实频次只写「输入的问题」，绝不标高频。 */
export function frequencyLabelOf(group) {
  if (group?.frequency && group.frequency_source === 'manual') {
    return `人工提供：${group.frequency.count} 次（来源：${group.frequency.source}）`;
  }
  return '输入的问题（未提供频次）';
}

// ---------- 归类建议 ----------

const CATEGORY_PATTERNS = [
  // 非商品图问题优先识别，避免被商品关键词吞掉
  { category: 'logistics', pattern: /物流|快递|发货|配送|运费|几天到|包裹|签收|丢件/ },
  { category: 'payment', pattern: /支付|付款|退款|发票|优惠|改价/ },
  { category: 'inventory', pattern: /库存|有货|缺货|现货|断货|补货/ },
  { category: 'theme', pattern: /装修|主题|模板|店招|首页图|页面显示|切图|轮播/ },
  { category: 'quantity', pattern: /几个|多少(个|件|瓶|盒|支|片|袋)|数量|包含|配件|清单|有没有.*(送|赠)|附赠|套装里|装箱/ },
  { category: 'size', pattern: /多大|尺寸|大小|长|宽|高|直径|厚度|放得下|能放|占地/ },
  { category: 'spec_diff', pattern: /区别|差别|对比|哪个好|两款|两个(规格|型号)|不一样|选哪/ },
  { category: 'usage', pattern: /怎么用|怎么使用|如何使用|使用方法|用法|如何用|怎么(吃|喝|涂|用|安装)/ },
];

/** 关键词归类建议（商家可改正；规则只给建议，不假装理解语义）。 */
export function suggestCategory(text) {
  const value = String(text ?? '');
  for (const item of CATEGORY_PATTERNS) {
    if (item.pattern.test(value)) return item.category;
  }
  return 'other';
}

// ---------- 五类分流 ----------

const SIZE_KEY_PATTERN = /尺寸|长|宽|高|直径|厚度|大小/;
const USAGE_KEY_PATTERN = /使用|用法/;

function factText(fact) {
  return `${fact.key}：${fact.value}${fact.unit ?? ''}`;
}

/**
 * 按生效归类做信息缺口判定。返回 missing 数组（空 = 依据齐备）。
 * 缺口清单必须具体：缺哪条资料、需要什么单位/口径；不推测数据。
 */
export function missingFactsFor({ category, sku, skuProfile, truth }) {
  const missing = [];
  const needsSku = ['quantity', 'size', 'spec_diff'].includes(category);
  if (needsSku && !sku) {
    missing.push({ code: 'sku', message: '请先指定问题对应的 SKU（数量、尺寸与规格差别按 SKU 核对）' });
    return missing;
  }
  if (category === 'quantity') {
    const contents = (sku?.contents ?? []).filter(item => item.included === true);
    if (contents.length === 0) {
      missing.push({
        code: 'contents',
        message: '请在 SKU 档案补充包含物条目：物件名、数量与单位（如「瓶装 1 瓶」）；配件照片可在包含物里关联素材',
      });
    }
  } else if (category === 'size') {
    const attrs = (sku?.attributes ?? []).filter(item => SIZE_KEY_PATTERN.test(String(item.key ?? '')));
    const facts = (truth?.facts ?? []).filter(item => SIZE_KEY_PATTERN.test(String(item.key ?? '')));
    if (attrs.length === 0 && facts.length === 0) {
      missing.push({
        code: 'dimensions',
        message: '请提供测量值：哪条尺寸（如「瓶身高度」）、数值、单位（mm/cm）与测量口径（如「含盖/不含盖」）',
      });
    }
  } else if (category === 'spec_diff') {
    const skus = skuProfile?.skus ?? [];
    if (skus.length < 2) {
      missing.push({ code: 'spec_diff', message: '规格对比需要档案内至少两个 SKU；请先维护 SKU 档案' });
    } else {
      const keys = new Set();
      for (const skuItem of skus) for (const attr of skuItem.attributes ?? []) keys.add(String(attr.key ?? ''));
      const hasDiff = [...keys].some(key => {
        const values = new Set(skus.map(skuItem => {
          const attr = (skuItem.attributes ?? []).find(item => String(item.key) === key);
          return attr ? `${attr.value}${attr.unit ?? ''}` : null;
        }).filter(Boolean));
        return values.size > 1;
      });
      if (!hasDiff) {
        missing.push({ code: 'spec_diff', message: '各 SKU 的差异属性（如容量/件数）尚未确认或取值相同；请补齐差异属性' });
      }
    }
  } else if (category === 'usage') {
    const facts = (truth?.facts ?? []).filter(item => USAGE_KEY_PATTERN.test(String(item.key ?? '')));
    if (facts.length === 0) {
      missing.push({
        code: 'usage',
        message: '请先在商品事实中确认「使用方式」类事实（如：早晚洁面后取适量涂抹）；系统不推测用法',
      });
    }
  } else if (category === 'other') {
    if ((truth?.facts ?? []).length === 0) {
      missing.push({ code: 'facts', message: '请先在商品事实中确认与问题相关的事实；没有依据时不生成说明内容' });
    }
  }
  return missing;
}

/**
 * 单个问题的分流分析（纯函数）。
 * @param category      生效归类（商家改正后的 category_final）
 * @param sku           关联 SKU 档案条目（可空）
 * @param reusableVersions 该 SKU 当前可用的版本清单（调用方用导出闸口算出，失效/未过闸口的不在内）
 * @returns { result, detail } detail 按结果携带 missing/reusable/suggestion/explainer/scope_note
 */
export function analyzeQuestion({ category, sku = null, skuProfile = null, truth = null, reusableVersions = [] } = {}) {
  if (OUT_OF_SCOPE_CATEGORIES.includes(category)) {
    return {
      result: 'out_of_scope',
      detail: { scope_category: category, scope_note: SCOPE_GUIDANCE[category] },
    };
  }
  const missing = missingFactsFor({ category, sku, skuProfile, truth });
  if (missing.length > 0) {
    return { result: 'missing_facts', detail: { missing } };
  }
  const reusable = (reusableVersions ?? []).map(item => ({
    run_id: item.run_id, deliverable_id: item.deliverable_id,
    deliverable_label: item.deliverable_label ?? item.deliverable_id,
    version_id: item.version_id, version_number: item.number ?? null,
    format: item.format ?? null,
  }));
  if (reusable.length > 0) {
    return {
      result: 'reuse_existing',
      detail: {
        reusable,
        note: '以上是该 SKU 当前选用且通过全部导出闸口的图片；系统只按归属与闸口筛选，不判断图片是否直接回答该问题，'
          + '失效或未过闸口的旧版本不在列，商家确认后才可作为复用依据',
      },
    };
  }
  if (category === 'usage' || category === 'other') {
    const facts = (truth?.facts ?? []).filter(fact =>
      category === 'usage' ? USAGE_KEY_PATTERN.test(String(fact.key ?? '')) : true);
    return {
      result: 'text_suggestion',
      detail: {
        suggestion: {
          texts: facts.map(factText),
          position: '建议放在详情页首屏常见问题区或主图下方文字说明区',
          note: '以上文案逐字引用已确认事实，未扩写；如需图上呈现请确认后进入补图',
        },
      },
    };
  }
  const kind = EXPLAINER_KINDS[category] ?? null;
  const outline = [];
  if (category === 'quantity') {
    for (const content of (sku?.contents ?? []).filter(item => item.included === true)) {
      outline.push(`${content.item} × ${content.quantity}${content.unit}`);
    }
  } else if (category === 'size') {
    const attrs = (sku?.attributes ?? []).filter(item => SIZE_KEY_PATTERN.test(String(item.key ?? '')));
    const facts = (truth?.facts ?? []).filter(item => SIZE_KEY_PATTERN.test(String(item.key ?? '')));
    for (const attr of attrs) outline.push(`${attr.key}：${attr.value}${attr.unit ?? ''}（SKU 档案）`);
    for (const fact of facts) outline.push(`${factText(fact)}（确认事实）`);
  } else if (category === 'spec_diff') {
    const skus = skuProfile?.skus ?? [];
    const keys = new Set();
    for (const skuItem of skus) for (const attr of skuItem.attributes ?? []) keys.add(String(attr.key ?? ''));
    for (const key of keys) {
      const cells = skus.map(skuItem => {
        const attr = (skuItem.attributes ?? []).find(item => String(item.key) === key);
        return `${skuItem.sku_code}：${attr ? `${attr.value}${attr.unit ?? ''}` : '—'}`;
      });
      outline.push(`${key} — ${cells.join(' / ')}`);
    }
  }
  return {
    result: 'needs_explainer',
    detail: {
      explainer_kind: kind,
      explainer_kind_label: EXPLAINER_KIND_LABELS[kind] ?? null,
      outline,
      note: category === 'size'
        ? '提纲仅引用已确认测量值；尺寸说明不能断言「适用于所有场景」，个体适配需另补依据'
        : '提纲仅引用已确认事实与档案条目，待商家确认后进入补图方案（E06）',
    },
  };
}

/** 问题组呈现：不改动存储结构，扁平化输出给前端/审计。 */
export function presentQuestionGroup(group) {
  if (group === null || typeof group !== 'object' || Array.isArray(group)) return null;
  return {
    id: group.id,
    project_id: group.project_id,
    text: group.text,
    sku_id: group.sku_id ?? null,
    sku_code: group.sku_code ?? null,
    category_suggested: group.category_suggested,
    category_final: group.category_final,
    category_label: CATEGORY_LABELS[group.category_final] ?? group.category_final,
    frequency: group.frequency ?? null,
    frequency_source: group.frequency_source ?? null,
    frequency_label: frequencyLabelOf(group),
    result: group.result,
    result_label: RESULT_LABELS[group.result] ?? group.result,
    detail: group.detail ?? {},
    duplicate_of: group.duplicate_of ?? null,
    facts_snapshot: group.facts_snapshot ?? null,
    status: group.status,
    confirmed_at: group.confirmed_at ?? null,
    confirmed_by: group.confirmed_by ?? null,
    created_by: group.created_by,
    created_at: group.created_at,
    updated_at: group.updated_at ?? group.created_at,
  };
}
