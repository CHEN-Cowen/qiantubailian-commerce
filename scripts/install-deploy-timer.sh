#!/usr/bin/env bash
# 一次性安装：把 poll-deploy.sh 装到 /opt/qtb-deploy，并注册 systemd 定时器（每 2 分钟检查一次发布标签）。
# 用法：sudo bash scripts/install-deploy-timer.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo '请用 sudo 运行：sudo bash scripts/install-deploy-timer.sh' >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR=/opt/qtb-deploy

install -d -m 0755 "$DEST_DIR"
install -m 0755 "$SRC_DIR/poll-deploy.sh" "$DEST_DIR/deploy.sh"
install -m 0755 "$SRC_DIR/deploy-linux.sh" "$DEST_DIR/deploy-linux.sh"
bash -n "$DEST_DIR/deploy.sh"
bash -n "$DEST_DIR/deploy-linux.sh"

cat > /etc/systemd/system/qtb-deploy.service <<'UNIT'
[Unit]
Description=Qiantubailian 发布检查（发现新的 deploy-* 标签时更新并重启）
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/qtb-deploy/deploy.sh
Nice=10
UNIT

cat > /etc/systemd/system/qtb-deploy.timer <<'UNIT'
[Unit]
Description=每 2 分钟检查一次 Qiantubailian 发布标签

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=10s
Unit=qtb-deploy.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now qtb-deploy.timer
systemctl list-timers qtb-deploy.timer --no-pager
