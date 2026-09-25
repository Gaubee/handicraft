#!/bin/bash
# SAM3 服务常驻启动（P2.1）——nohup + FIFO 面 + pid 文件。
# 用法: service/start.sh   （客户端见 ask.sh；direct 模式不经此脚本）
set -euo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"
PY="$BASE/../mlx_sam3/.venv/bin/python"
PIDFILE="$BASE/sam3-service.pid"
LOGERR="$BASE/logs/stderr.log"

mkdir -p "$BASE/logs"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDFILE")"
  exit 0
fi
if [ ! -x "$PY" ]; then
  echo "ERROR: venv python 不存在: $PY" >&2
  exit 1
fi

mkfifo "$BASE/in.fifo" 2>/dev/null || true
mkfifo "$BASE/out.fifo" 2>/dev/null || true

nohup "$PY" "$BASE/sam3_service.py" --fifo >>"$LOGERR" 2>&1 </dev/null &
pid=$!
echo "$pid" > "$PIDFILE"
sleep 1

if kill -0 "$pid" 2>/dev/null; then
  echo "started pid=$pid"
  echo "  fifo : $BASE/{in,out}.fifo"
  echo "  ask  : $BASE/ask.sh '<json>'"
  echo "  logs : $BASE/logs/"
else
  echo "ERROR: 启动失败，查 $LOGERR" >&2
  rm -f "$PIDFILE"
  exit 1
fi
