#!/usr/bin/env bash
# 在 Linux 目标机上执行部署：解包、安装生产依赖、重启 systemd 服务、健康检查。
# 由 scripts/poll-deploy.sh（systemd 定时器）调用，也可手动执行。
# 发布包只含版本库文件，不含 node_modules、runtime 与 .env，因此不会覆盖密钥和业务数据。
#
# 用法：deploy-linux.sh <部署目录> <发布包> <systemd 服务名> [健康检查地址] [超时秒数] [去掉几层目录前缀]
# 自定义前缀的包（如 codeload 的 qiantubailian-commerce-<tag>/）传 1；git archive 生成的包传 0。
set -euo pipefail

TARGET_PATH="${1:-}"
ARCHIVE="${2:-}"
SERVICE_NAME="${3:-}"
HEALTH_URL="${4:-http://127.0.0.1:3000/readyz}"
HEALTH_TIMEOUT_SECONDS="${5:-90}"
STRIP_COMPONENTS="${6:-0}"

step() { printf '==> %s\n' "$1"; }

if [[ -z "$TARGET_PATH" || -z "$ARCHIVE" || -z "$SERVICE_NAME" ]]; then
  echo "用法：$0 <部署目录> <发布包> <systemd 服务名> [健康检查地址] [超时秒数] [去前缀层数]" >&2
  exit 2
fi
[[ -d "$TARGET_PATH" ]] || { echo "部署目录不存在：$TARGET_PATH" >&2; exit 1; }
[[ -f "$ARCHIVE" ]] || { echo "发布包不存在：$ARCHIVE" >&2; exit 1; }
command -v systemctl >/dev/null || { echo '找不到 systemctl，本脚本只支持 systemd 托管服务' >&2; exit 1; }
command -v curl >/dev/null || { echo '找不到 curl，无法执行健康检查' >&2; exit 1; }
systemctl cat "$SERVICE_NAME" >/dev/null 2>&1 || { echo "未找到 systemd 服务：$SERVICE_NAME" >&2; exit 1; }

# 优先使用应用自带的 Node（服务器上是 $TARGET_PATH/node），否则用 PATH 中的 node。
if [[ -x "$TARGET_PATH/node/bin/node" ]]; then
  NODE_DIR="$TARGET_PATH/node/bin"
else
  NODE_DIR="$(dirname "$(command -v node)")"
fi
if [[ -x "$NODE_DIR/npm" ]]; then
  NPM_BIN="$NODE_DIR/npm"
else
  NPM_BIN="npm"
fi
# 自带 Node 不在 PATH 里时，npm 的 /usr/bin/env node 会找不到解释器，因此显式加入。
export PATH="$NODE_DIR:$PATH"
"$NODE_DIR/node" --version

step "停止服务（$SERVICE_NAME）"
systemctl stop "$SERVICE_NAME"

start_app() {
  step "启动服务（$SERVICE_NAME）"
  systemctl start "$SERVICE_NAME"
}

trap start_app EXIT

step "解包 $ARCHIVE → $TARGET_PATH"
tar -xzf "$ARCHIVE" -C "$TARGET_PATH" --strip-components="$STRIP_COMPONENTS"
rm -f "$ARCHIVE"

# 以 root 运行时（如 systemd 定时器），解包出来的文件会变成 root 所有；保持原目录属主，避免后续非 root 操作失败。
if [[ $EUID -eq 0 ]]; then
  chown -R "$(stat -c '%u:%g' "$TARGET_PATH")" "$TARGET_PATH"
fi

step '安装生产依赖（npm ci --omit=dev）'
(
  cd "$TARGET_PATH"
  "$NPM_BIN" ci --omit=dev --no-audit --no-fund
)

trap - EXIT
start_app

step "健康检查 $HEALTH_URL（最多 $HEALTH_TIMEOUT_SECONDS 秒）"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
while (($(date +%s) < deadline)); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "健康检查通过"
    exit 0
  fi
  sleep 3
done
echo "部署后健康检查失败：$HEALTH_URL 未在 ${HEALTH_TIMEOUT_SECONDS}s 内返回成功，请查看 journalctl -u $SERVICE_NAME" >&2
exit 1
