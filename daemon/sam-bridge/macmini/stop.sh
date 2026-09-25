#!/bin/bash
# SAM3 服务停止（P2.1）——按 pid 文件：SIGTERM 优雅→10s 界→SIGKILL 兜底。
set -euo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$BASE/sam3-service.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "not running (no pidfile)"
  exit 0
fi
pid="$(cat "$PIDFILE")"

if kill -0 "$pid" 2>/dev/null; then
  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    echo "stopped pid=$pid (SIGKILL 兜底)"
  else
    echo "stopped pid=$pid"
  fi
else
  echo "stale pidfile (进程已不在) pid=$pid"
fi
rm -f "$PIDFILE"
