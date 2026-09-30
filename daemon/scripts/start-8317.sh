#!/usr/bin/env bash
# start-8317.sh —— 8317 生产验收实例统一启动脚本（Owner 验收 2026-09-30「重启废
# token」根治：JWT_SECRET 固化于 DATA_ROOT/.jwt-secret——重启不再使已签发凭证
# 失效；同时固化 LIVE 开关/SAM 桥/admin 引导全套 env，替代手工 nohup 命令行）。
# 用法：bash daemon/scripts/start-8317.sh （已有实例在跑会先 SIGTERM 优雅退出）。
set -euo pipefail

DATA_ROOT='/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root'
SECRET_FILE="$DATA_ROOT/.jwt-secret"
LOG="${LOG:-/tmp/daemon-8317.log}"

if [ ! -f "$SECRET_FILE" ]; then
  echo "生成新 JWT_SECRET → $SECRET_FILE" >&2
  umask 077
  openssl rand -hex 32 > "$SECRET_FILE"
fi
JWT_SECRET=$(cat "$SECRET_FILE")

# 在跑实例先优雅退出
OLD_PID=$(lsof -nP -iTCP:8317 -sTCP:LISTEN -t | head -1 || true)
if [ -n "${OLD_PID:-}" ]; then
  echo "停旧实例 PID=$OLD_PID" >&2
  kill "$OLD_PID"
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:8317 -sTCP:LISTEN -t >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

cd "$(dirname "$0")/.."
nohup env \
  DATA_ROOT="$DATA_ROOT" \
  JWT_SECRET="$JWT_SECRET" \
  ADMIN_USERNAME=admin \
  ADMIN_PASSWORD=admin8888 \
  ALLOW_ANONYMOUS=1 \
  SAM_SSH_HOST=macmini \
  SAM_SSH_REMOTE_COMMAND='cd ~/sam3-spike/service && ~/sam3-spike/mlx_sam3/.venv/bin/python sam3_service.py' \
  SAM_ANALYZE_LIVE=1 \
  STRATEGY_DESIGN_LIVE=1 \
  /Users/kzf/.vite-plus/js_runtime/node/24.21.0/bin/node \
    --require /Users/kzf/Pictures/贴钻-backend/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/preflight.cjs \
    --import "file:///Users/kzf/Pictures/贴钻-backend/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs" \
    src/index.ts >> "$LOG" 2>&1 &

sleep 4
curl -s -o /dev/null -w "HTTP=%{http_code}\n" http://127.0.0.1:8317/
# 只查本次 boot 段（最后一次「已启动」之后的行）——日志是追加模式，全文件
# grep 会命中历史实例的旧警告造成误报。
if tail -n +"$(grep -n '贴钻 daemon 已启动' "$LOG" | tail -1 | cut -d: -f1)" "$LOG" | grep -q "JWT_SECRET 为空"; then
  echo "警告：JWT_SECRET 未生效！" >&2
else
  echo "JWT_SECRET 已固化（本次 boot 无空密钥警告）"
fi
