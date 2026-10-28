/**
 * R07 价格页 / 额度管理
 *
 * 约束：
 * 1. 价格全部来自 /api/plans，前端不硬编码也不允许篡改。
 * 2. 真实支付入口受后端 payment.provider 能力闸口控制；未配置时按钮禁用且显示「暂不可购买」。
 * 3. 尝鲜包 / 日常月包 / 高频月包 / 体验额度的有效期、包含次数、到期与不结转规则与后端 plans.mjs 一致。
 */
import { api, ApiFailure } from './api.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CENTS_PER_YUAN = 100;
const yuan = cents => (cents / CENTS_PER_YUAN).toFixed(2);

const state = {
  plans: null,          // { price_version, plans: [...], usage_example, delivery_definition, commerce_constraints }
  payment: null,        // { provider, configured, acceptance, note, can_purchase }
  balance: null,        // 额度账本
  toast: message => window.alert(message),
  order: null,          // 创建订单结果（待支付状态）
};

export function initPricing({ toast } = {}) {
  if (typeof toast === 'function') state.toast = toast;
  // 全局入口：顶栏、workbench 等地方可以触发打开
  document.addEventListener('click', event => {
    if (event.target.closest('[data-open="pricing"]')) {
      void openPricing();
    }
  });
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-open="pricing-buy"]');
    if (!trigger) return;
    const planId = trigger.dataset.planId;
    void openPricing({ autoBuyPlanId: planId });
  });
  // 关闭
  $('#pricing-dialog')?.addEventListener('close', () => { state.order = null; clearTimeout(state.pollTimer); });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-query-order]');
    if (!button) return;
    try { const result = await api.queryBillingOrder(button.dataset.queryOrder); state.order = result.order; state.balance = (await api.credits()).balance; render(); }
    catch (error) { state.toast?.(errorText(error)); }
  });
}

export async function openPricing({ autoBuyPlanId = null } = {}) {
  const dialog = $('#pricing-dialog');
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  renderLoading('正在读取价格与额度…');
  try {
    const [plans, balance] = await Promise.all([
      api.listPlans(),
      api.credits().catch(() => ({})),
    ]);
    state.plans = plans;
    state.payment = plans.payment;
    state.balance = balance.balance ?? balance;
    state.order = null;
    state.orders = (await api.listBillingOrders()).orders ?? [];
    render();
    scheduleOrderPoll();
    if (autoBuyPlanId) {
      const plan = (state.plans.plans ?? []).find(p => p.id === autoBuyPlanId);
      if (plan) await buyPlan(plan);
    }
  } catch (error) {
    renderError(errorText(error));
  }
}

function errorText(error) {
  if (error instanceof ApiFailure) return error.message;
  return `操作失败：${error.message ?? error}`;
}

function renderLoading(text) {
  $('#pricing-body').innerHTML = `<p class="real-hint">${escapeHtml(text)}</p>`;
}

function renderError(text) {
  $('#pricing-body').innerHTML = `<p class="real-error" role="alert">${escapeHtml(text)}</p>`;
}

function render() {
  const body = $('#pricing-body');
  if (!body) return;
  const plans = state.plans?.plans ?? [];
  const balance = state.balance ?? {};
  const payment = state.payment ?? {};
  // 后端 evaluatePaymentCapability 返回 can_checkout / real_money / mode
  const canPurchase = payment.can_checkout === true && payment.real_money === true;
  const acceptance = payment.acceptance ?? 'simulated_only';

  const plansHtml = plans.map(plan => {
    plan.free = plan.kind === 'experience' || plan.price_cents === 0;
    const disabled = plan.free ? false : !canPurchase;
    const validity = plan.validity_days >= 28
      ? `到账起 ${plan.validity_days} 天内有效，不结转`
      : `到账起 ${plan.validity_days} 天内有效，不结转`;
    const buttonLabel = plan.free
      ? '领取体验额度'
      : canPurchase ? `支付 ¥${yuan(plan.price_cents)}` : '暂不可购买';
    const highlights = plan.highlights ?? [];
    return `<article class="pricing-card ${plan.free ? 'free' : ''} ${disabled ? 'disabled' : ''}">
      ${plan.is_default_trial ? '<span class="pricing-badge">首次体验</span>' : ''}
      <h3>${escapeHtml(plan.name)}</h3>
      <p class="pricing-price">
        ${plan.free ? '<span class="free-label">免费</span>' : `<b>¥${yuan(plan.price_cents)}</b>`}
        <small>/ ${plan.credits} 张</small>
      </p>
      <ul class="pricing-highlights">
        ${highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
        ${plan.terms ? `<li class="terms">${escapeHtml(plan.terms)}</li>` : ''}
      </ul>
      <p class="pricing-validity">${escapeHtml(validity)}</p>
      <button class="primary ${disabled ? '' : ''}" data-buy-plan="${plan.id}" ${disabled ? 'disabled' : ''}>
        ${buttonLabel}
      </button>
      ${disabled && !plan.free ? `<p class="pricing-lock">${escapeHtml(payment.note ?? '真实支付未配置，暂不可购买')}</p>` : ''}
    </article>`;
  }).join('');

  const usage = state.plans?.usage_example ?? {};
  const rules = state.plans?.rules ?? {};
  const dc = state.plans?.delivery_definition ?? {};

  body.innerHTML = `
    <section class="pricing-section">
      <h2>当前额度</h2>
      <div class="balance-row">
        <div class="balance-cell"><span>可用</span><b>${balance.available ?? 0}</b> 张</div>
        <div class="balance-cell"><span>已预留</span><b>${balance.reserved ?? 0}</b></div>
        <div class="balance-cell"><span>已消耗</span><b>${balance.consumed ?? 0}</b></div>
        <div class="balance-cell"><span>总额度</span><b>${balance.granted_total ?? 0}</b></div>
      </div>
        <p class="real-note">成品额度 · 通过检查后结算，失败释放；待复核保持预留</p>
      ${state.plans?.price_version ? `<p class="real-hint">价格版本 ${escapeHtml(state.plans.price_version)}</p>` : ''}
    </section>

    <section class="pricing-section">
      <h2>套餐与价格</h2>
      <p class="real-hint">
        价格全部来自服务端，前端不可篡改。当前支付能力：
        <b>${escapeHtml(payment.provider ?? '未配置')}</b> ·
        ${escapeHtml(payment.note ?? acceptance)}
      </p>
      <div class="pricing-grid">${plansHtml}</div>
    </section>

    <section class="pricing-section">
      <h2>使用规则与交付定义</h2>
      <div class="rules-grid">
        <div class="rule-cell">
          <b>一张图消耗多少？</b>
          <p>${escapeHtml(usage.description ?? usage.default_per_unit ?? '按冻结快照交付项定义；主图 / 卖点图通常各 1 张 = 1 额度')}</p>
          ${usage.typical_quote ? `<small>例：${escapeHtml(usage.typical_quote)}</small>` : ''}
        </div>
        <div class="rule-cell">
          <b>什么叫"一张成品"？</b>
          <p>${escapeHtml(dc.summary ?? dc.definition ?? '一次生产 run 冻结的每个交付项每张图算一张；同一个已付版本重复下载不扣费')}</p>
        </div>
        <div class="rule-cell">
          <b>自动修复次数？</b>
          <p>${escapeHtml(rules.auto_revision_default ? `初始候选上限 ${rules.auto_revision_default} 次（可配置），修复中的外部费用仍记成本` : '自动修复次数由任务创建时的 max_attempts 决定')}</p>
        </div>
        <div class="rule-cell">
          <b>额度有效期？</b>
          <p>${escapeHtml(rules.monthly_validity_days ? `月包到账起 ${rules.monthly_validity_days} 天；尝鲜包默认到账起 ${rules.one_time_validity_days ?? 90} 天` : '见各套餐说明')}</p>
        </div>
        <div class="rule-cell">
          <b>未用额度结转？</b>
          <p>${escapeHtml(rules.rollover ? (rules.rollover === 'none' ? '不结转' : rules.rollover) : '不结转')}</p>
        </div>
        <div class="rule-cell">
          <b>提前续购 / 升级？</b>
          <p>${escapeHtml(rules.upgrade_policy ?? '按简单规则：旧套餐剩余额度保留，新套餐叠加；不自动续费')}</p>
        </div>
        <div class="rule-cell">
          <b>退款？</b>
          <p>${escapeHtml(rules.refund_policy ?? '未使用的可退人民币（处理中冻结，结果确认后更新权益）；已使用按已公开规则计算，不承诺无条件退款')}</p>
        </div>
      </div>
    </section>

    ${state.order ? renderOrder(state.order) : ''}
    <section class="pricing-section"><h2>我的订单</h2>${(state.orders ?? []).map(renderOrder).join('') || '<p>尚无订单</p>'}</section>
  `;

  // 绑定购买按钮
  $$('[data-buy-plan]', body).forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.buyPlan;
      const plan = plans.find(p => p.id === id);
      if (plan) void buyPlan(plan);
    });
  });
}

function renderOrder(order) {
  const statusText = { pending_wechat_checkout: '待扫码支付', settled_real: '已到账', settled_demo: '演示到账', refunded: '已退款', wechat_closed: '已关闭', pending: '待支付', paid: '已支付', expired: '已过期', failed: '已失败' }[order.status] ?? order.status;
  return `
    <section class="pricing-section order-section">
      <h2>订单状态</h2>
      <p>订单号：<b>${escapeHtml(order.id)}</b> · ${escapeHtml(statusText)} · 金额 ¥${yuan(order.price_cents ?? 0)}</p>
      ${order.pay_qr && order.status === 'pending_wechat_checkout' ? `<img width="256" height="256" src="${escapeHtml(order.pay_qr)}" alt="本次订单微信支付二维码">` : ''}
      ${order.code_url && order.status === 'pending_wechat_checkout' ? `<p>请在可信支付客户端打开本次订单链接：<a href="${escapeHtml(order.code_url)}">微信支付</a></p><button data-query-order="${escapeHtml(order.id)}">刷新付款结果</button>` : ''}
${order.refund_status ? `<p>退款状态：${escapeHtml(order.refund_status)}</p>` : ''}
      ${order.refund_error ? `<p role="alert">${escapeHtml(order.refund_error)}</p>` : ''}
      ${order.refund_status === 'processing' ? `<button data-query-order="${escapeHtml(order.id)}">刷新退款状态</button>` : ''}
      ${order.real_money && order.status === 'settled_real' && order.refund_status !== 'processing' ? `<button data-refund-order="${escapeHtml(order.id)}">申请退还未使用额度</button>` : ''}
      <p class="real-note">${order.simulated ? '演示订单，未发生真实收款。' : '付款结果以服务端确认为准；不自动续费。'}</p>
    </section>`;
}

if (typeof document !== 'undefined') initPricing();

async function buyPlan(plan) {
  const button = document.querySelector(`[data-buy-plan="${plan.id}"]`);
  if (button) { button.disabled = true; button.textContent = '处理中…'; }
  try {
    if (plan.free) {
      // 体验额度：直接调用后端 /api/billing/orders（后端处理发放）
      const order = await api.createBillingOrder({ plan_id: plan.id, source: 'trial_claim' });
      state.order = order.order ?? order;
    } else {
      // 真实支付闸口：必须同时有 can_checkout 和 real_money
      if (!(state.payment?.can_checkout === true && state.payment?.real_money === true)) {
        state.toast?.('真实支付未配置，暂不可购买');
        if (button) { button.disabled = false; button.textContent = '暂不可购买'; }
        return;
      }
      const order = await api.createBillingOrder({ plan_id: plan.id, source: 'purchase' });
      state.order = order.order ?? order;
      state.toast?.(`订单已创建：¥${yuan(plan.price_cents)}，等待支付`);
    }
    // 刷新额度
    const credits = await api.credits().catch(() => ({}));
    state.balance = credits.balance ?? credits;
    state.orders = (await api.listBillingOrders()).orders ?? [];
    render();
    scheduleOrderPoll();
  } catch (error) {
    state.toast?.(errorText(error));
    if (button) { button.disabled = false; button.textContent = plan.free ? '领取体验额度' : `支付 ¥${yuan(plan.price_cents)}`; }
  }
}

function scheduleOrderPoll() {
  clearTimeout(state.pollTimer);
  if (!$('#pricing-dialog')?.open) return;
  const pending = [state.order, ...(state.orders ?? [])].filter(o => o && (o.status === 'pending_wechat_checkout' || o.refund_status === 'processing'));
  if (!pending.length) return;
  state.pollTimer = setTimeout(async () => {
    try {
      for (const id of new Set(pending.map(o => o.id))) await api.queryBillingOrder(id);
      state.orders = (await api.listBillingOrders()).orders ?? [];
      if (state.order) state.order = state.orders.find(o => o.id === state.order.id) ?? state.order;
      state.balance = (await api.credits()).balance;
      render();
    } catch { /* 查单失败仍保持未确认，下一轮恢复 */ }
    scheduleOrderPoll();
  }, 5000);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-refund-order]');
  if (!button || !window.confirm('按未使用额度比例申请退款？处理中对应额度将冻结。')) return;
  button.disabled = true;
  try {
    state.order = (await api.refundBillingOrder(button.dataset.refundOrder)).order;
    state.orders = (await api.listBillingOrders()).orders ?? [];
    state.balance = (await api.credits()).balance; render(); scheduleOrderPoll();
  } catch (error) { state.toast(errorText(error)); button.disabled = false; }
});
