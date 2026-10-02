#!/usr/bin/env bash
# start-e2e-8320.sh —— 断点续跑端到端走查独立实例（2026-10-02，P0.1 自走查用）。
# 与 start-8317.sh 同构，差异仅三处：独立 DATA_ROOT（走查后整目录可弃）/PORT=8320/
# SEGMENT_TOOL_SLICE_MS=60s（压短切片——走查窗口内可见 agent 链式续调多片）。
# LLM 配置不在此脚本——daemon/.env 由 boot 自动桥接（密钥只落 DATA_ROOT 内，红线）。
# 用法：bash daemon/scripts/start-e2e-8320.sh （已有实例在跑会先 SIGTERM 优雅退出）。
set -euo pipefail

DATA_ROOT='/Users/kzf/Pictures/贴钻/experiments/segment-e2e-20261002/data-root'
SECRET_FILE="$DATA_ROOT/.jwt-secret"
LOG="${LOG:-/tmp/daemon-8320.log}"
PORT=8320

mkdir -p "$DATA_ROOT"
if [ ! -f "$SECRET_FILE" ]; then
  echo "生成新 JWT_SECRET → $SECRET_FILE" >&2
  umask 077
  openssl rand -hex 32 > "$SECRET_FILE"
fi
JWT_SECRET=$(cat "$SECRET_FILE")

# 在跑实例先优雅退出
OLD_PID=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | head -1 || true)
if [ -n "${OLD_PID:-}" ]; then
  echo "停旧实例 PID=$OLD_PID" >&2
  kill "$OLD_PID"
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

cd "$(dirname "$0")/.."
nohup env \
  PORT="$PORT" \
  DATA_ROOT="$DATA_ROOT" \
  JWT_SECRET="$JWT_SECRET" \
  ADMIN_USERNAME=admin \
  ADMIN_PASSWORD=admin8888 \
  ALLOW_ANONYMOUS=1 \
  SAM_SSH_HOST=macmini \
  SAM_SSH_REMOTE_COMMAND='cd ~/sam3-spike/service && ~/sam3-spike/mlx_sam3/.venv/bin/python sam3_service.py' \
  SAM_ANALYZE_LIVE=1 \
  STRATEGY_DESIGN_LIVE=1 \
  SEGMENT_TOOL_SLICE_MS=60000 MCP_PORT=8319 \
  /Users/kzf/.vite-plus/js_runtime/node/24.21.0/bin/node \
    --require /Users/kzf/Pictures/贴钻-backend/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/preflight.cjs \
    --import "file:///Users/kzf/Pictures/贴钻-backend/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs" \
    src/index.ts >> "$LOG" 2>&1 &

sleep 4
curl -s -o /dev/null -w "HTTP=%{http_code}\n" "http://127.0.0.1:$PORT/"
echo "E2E 实例：http://127.0.0.1:$PORT/（DATA_ROOT=${DATA_ROOT}，切片 60s）"
