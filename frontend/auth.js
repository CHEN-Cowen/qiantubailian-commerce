/**
 * R01 登录闸口。
 *
 * 行为约定：
 * - 会话已登录：写入 CSRF 令牌，页面正常进入。
 * - 未登录且服务端为演示模式：保持原有演示入口，不弹登录框（演示与生产隔离）。
 * - 未登录且服务端为生产口径：显示登录/注册闸口，业务请求在闸口通过前保持等待，
 *   不会以 401 空列表冒充“没有项目”。
 */
import { api, setSession } from './api.js';

let releaseReady;
window.__qtbAuthReady = new Promise(resolve => { releaseReady = resolve; });

const stateLabel = text => text;

const GATE_CSS = `
.auth-gate{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:rgba(42,36,32,.55);padding:20px;overflow:auto}
.auth-card{width:min(420px,100%);background:#FAF8F5;border:1px solid #ECE6DF;border-radius:14px;box-shadow:0 24px 60px rgba(36,30,25,.28);padding:30px 28px;color:#2A2420}
.auth-card h1{font-size:22px;line-height:1.3;margin:0 0 8px;letter-spacing:-.3px}
.auth-card .eyebrow{margin:0 0 6px;color:#D63A12;font-size:10px;font-weight:800;letter-spacing:1.7px}
.auth-lead{color:#6E655D;font-size:13px;margin:0 0 20px}
.auth-form{display:grid;gap:14px}
.auth-form label{display:grid;gap:5px;font-size:12px;color:#6E655D}
.auth-form input{border:1px solid #E5DED6;border-radius:7px;background:#fff;padding:10px 11px;font-size:14px;color:#2A2420}
.auth-form input:focus{outline:3px solid #FFC9AD;outline-offset:1px}
.auth-error{margin:0;color:#dc2626;background:#fff0f0;border:1px solid #f1cccc;border-radius:6px;padding:8px 10px;font-size:12px}
.auth-submit{width:100%;margin-top:4px}
.auth-switch{margin-top:14px;text-align:center}
.auth-note{color:#9C9188;font-size:11px;line-height:1.6;margin:12px 0 0}
@media(max-width:420px){.auth-card{padding:24px 18px}.auth-card h1{font-size:19px}}
`;

function ensureStyle() {
  if (document.getElementById('auth-style')) return;
  const style = document.createElement('style');
  style.id = 'auth-style';
  style.textContent = GATE_CSS;
  document.head.appendChild(style);
}

function buildGate({ demoHint = '' } = {}) {
  ensureStyle();
  const gate = document.createElement('div');
  gate.className = 'auth-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-label', '登录千图百炼');
  gate.innerHTML = `
    <div class="auth-card">
      <p class="eyebrow">千图百炼</p>
      <h1>登录你的商品视觉工作台</h1>
      <p class="auth-lead">用邮箱和密码登录，项目和素材只属于你的工作区。</p>
      <form class="auth-form" novalidate>
        <label>邮箱<input name="email" type="email" autocomplete="username" required></label>
        <label class="auth-register-only" hidden>昵称<input name="display_name" type="text" autocomplete="nickname"></label>
        <label class="auth-register-only" hidden>工作区名称<input name="tenant_name" type="text" placeholder="例如：我的小店"></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" minlength="10" required></label>
        <p class="auth-error" role="alert" hidden></p>
        <button class="primary auth-submit" type="submit">登录</button>
      </form>
      <div class="auth-switch">
        <button type="button" class="text-button auth-toggle">还没有账户？注册一个</button>
      </div>
      ${demoHint ? `<p class="auth-note">${demoHint}</p>` : ''}
      <p class="auth-note">账户恢复需要邮件服务，当前部署未配置时不可用。</p>
    </div>
  `;
  const form = gate.querySelector('form');
  const errorLine = gate.querySelector('.auth-error');
  const submit = gate.querySelector('.auth-submit');
  const toggle = gate.querySelector('.auth-toggle');
  let mode = 'login';

  toggle.addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    const registering = mode === 'register';
    gate.querySelectorAll('.auth-register-only').forEach(node => { node.hidden = !registering; });
    submit.textContent = registering ? '注册并开始' : '登录';
    toggle.textContent = registering ? '已有账户？去登录' : '还没有账户？注册一个';
    gate.querySelector('h1').textContent = registering ? '创建你的第一个工作区' : '登录你的商品视觉工作台';
    form.querySelector('input[name="password"]').setAttribute(
      'autocomplete', registering ? 'new-password' : 'current-password',
    );
    errorLine.hidden = true;
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    errorLine.hidden = true;
    submit.disabled = true;
    const data = new FormData(form);
    const payload = { email: String(data.get('email') ?? '').trim(), password: String(data.get('password') ?? '') };
    try {
      if (mode === 'register') {
        payload.display_name = String(data.get('display_name') ?? '').trim() || undefined;
        payload.tenant_name = String(data.get('tenant_name') ?? '').trim() || undefined;
        await api.register(payload);
      } else {
        await api.login(payload);
      }
      // 登录后重新加载：避免已发起的匿名请求结果污染页面状态
      location.reload();
    } catch (error) {
      errorLine.textContent = stateLabel(error?.message ?? '登录失败，请重试');
      errorLine.hidden = false;
      submit.disabled = false;
    }
  });

  document.body.appendChild(gate);
  gate.querySelector('input[name="email"]')?.focus();
  return gate;
}

function accountChip(session) {
  const note = document.getElementById('data-note-button');
  if (note) { note.textContent = '我的工作区'; note.title = '项目、额度和交付统计来自当前工作区；示例图片会单独标明'; }
  const avatar = document.querySelector('.top-actions .avatar');
  if (!avatar) return;
  avatar.textContent = (session.account?.display_name ?? '我').slice(0, 1);
  avatar.title = `${session.account?.display_name ?? ''} · ${session.tenant?.name ?? ''}`;
  avatar.addEventListener('click', async () => {
    if (!window.confirm('退出登录？')) return;
    try { await api.logout(); } finally { location.reload(); }
  });
}

async function boot() {
  let session;
  try {
    session = await api.session();
  } catch {
    // 会话接口本身失败时不阻塞页面：由业务请求自行报错，避免白屏
    releaseReady();
    return;
  }
  if (session?.authenticated) {
    setSession(session);
    accountChip(session);
    releaseReady();
    return;
  }
  if (session?.demo_mode) {
    releaseReady();
    return;
  }
  buildGate();
}

void boot();
