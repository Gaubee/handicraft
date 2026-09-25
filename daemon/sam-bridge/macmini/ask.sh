#!/bin/bash
# SAM3 服务一次性客户端（P2.1）——FIFO 面串行问答（mkdir 原子锁——macOS 无 flock CLI）。
# 用法: ask.sh '<json 请求行>'   → stdout 打印一行 JSON 响应
# 例:  ask.sh '{"id":1,"method":"version"}'
# 注: 只取第一行响应；请求 id 唯一化后由调用方核对 id 字段防陈旧串扰
#      （前序客户端半途而亡的残留响应会被当成本次响应——极边缘，见 PROTOCOL.md）。
# 锁: ask.lockdir 原子 mkdir；>600s 视为持锁客户端已死，自动破除。
set -euo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"
TIMEOUT="${ASK_TIMEOUT:-180}"
LOCK="$BASE/ask.lockdir"

# —— 串行锁（忙等上限 ~120s）——
i=0
until mkdir "$LOCK" 2>/dev/null; do
  now=$(date +%s)
  born=$(stat -f %m "$LOCK" 2>/dev/null || echo "$now")
  if [ $((now - born)) -gt 600 ]; then
    rm -rf "$LOCK"
    continue
  fi
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    echo '{"id":null,"ok":false,"error":{"code":"CLIENT_BUSY","message":"ask 锁忙超过 120s"}}' >&2
    exit 1
  fi
  sleep 0.2
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

exec 3<>"$BASE/in.fifo"
exec 4<>"$BASE/out.fifo"

printf '%s\n' "$1" >&3
IFS= read -r -t "$TIMEOUT" resp <&4 || {
  echo '{"id":null,"ok":false,"error":{"code":"CLIENT_TIMEOUT","message":"no response within '"$TIMEOUT"'s（服务未起或已死？查 logs/stderr.log）"}}' >&2
  exit 1
}
printf '%s\n' "$resp"
