#!/usr/bin/env bash
# 由 systemd 定时器每 2 分钟调用：发现新的 deploy-* 标签时，把 /opt/qiantubailian 更新到该标签并重启服务。
# 发布包来自 codeload（只含版本库文件，不含 node_modules、runtime 与 .env）。
set -euo pipefail

REPO_SLUG="CHEN-Cowen/qiantubailian-commerce"
TARGET_PATH="${QTB_DEPLOY_PATH:-/opt/qiantubailian}"
SERVICE_NAME="${QTB_DEPLOY_SERVICE:-qiantubailian}"
HEALTH_URL="${QTB_DEPLOY_HEALTH_URL:-http://127.0.0.1:3000/readyz}"
STATE_FILE=/opt/qtb-deploy/last-deployed
WORK_DIR=/opt/qtb-deploy/work

mkdir -p "$WORK_DIR"

LATEST_TAG="$(git ls-remote --tags --refs "https://github.com/${REPO_SLUG}.git" 'refs/tags/deploy-*' \
  | awk '{print $2}' | sed 's#^refs/tags/##' | sort -V | tail -1)"
if [[ -z "$LATEST_TAG" ]]; then
  echo '没有 deploy-* 标签，跳过'
  exit 0
fi

CURRENT_TAG="$(cat "$STATE_FILE" 2>/dev/null || true)"
if [[ "$LATEST_TAG" == "$CURRENT_TAG" ]]; then
  echo "已是最新（$LATEST_TAG），跳过"
  exit 0
fi

echo "发现新版本 $LATEST_TAG（当前：${CURRENT_TAG:-无}）"
ARCHIVE="$WORK_DIR/qtb-release.tgz"
rm -f "$ARCHIVE"
curl -fsSL --retry 3 --retry-delay 2 --max-time 300 \
  -o "$ARCHIVE" "https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/tags/${LATEST_TAG}"

# 下载成功即记账，避免部署失败后每 2 分钟反复重启生产服务。
# 需要重试同一版本时：sudo rm /opt/qtb-deploy/last-deployed
mkdir -p "$(dirname "$STATE_FILE")"
echo "$LATEST_TAG" > "$STATE_FILE"

# codeload 包带一层 qiantubailian-commerce-<tag>/ 前缀，因此 strip 1。
# 用包内最新的 deploy-linux.sh 执行，这样部署逻辑随版本一起更新，不需要重装定时器。
SCRIPT_DIR="$WORK_DIR/script"
rm -rf "$SCRIPT_DIR"
mkdir -p "$SCRIPT_DIR"
tar -xzf "$ARCHIVE" -C "$SCRIPT_DIR" --strip-components=1 --wildcards '*/scripts/deploy-linux.sh'
bash "$SCRIPT_DIR/scripts/deploy-linux.sh" \
  "$TARGET_PATH" "$ARCHIVE" "$SERVICE_NAME" "$HEALTH_URL" 90 1
