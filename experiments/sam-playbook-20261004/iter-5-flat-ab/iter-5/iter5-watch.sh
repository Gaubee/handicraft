#!/bin/bash
# iter-5 盯跑循环：90s 间隔探针，任务离开 running 或 110 分钟上限即退出（与 iter-4 同口径）
TID=54a92bde-3a48-4478-b3e3-fccc771906ed
DB="file:/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root/handicraft.db?mode=ro"
LOG=/tmp/iter5-watch.log
START=$(date +%s)
while true; do
  {
    echo "== $(date -u +%H:%M:%SZ) =="
    sqlite3 "$DB" "SELECT status, updated_at FROM tasks WHERE id='$TID';" 2>/dev/null
    /tmp/iter5-status.sh | tail -n +3
  } >> "$LOG" 2>&1
  S=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id='$TID';" 2>/dev/null)
  NOW=$(date +%s)
  ELAPSED=$(( (NOW - START) / 60 ))
  if [ "$S" != "running" ] && [ -n "$S" ]; then echo "== TASK TERMINAL: status=$S after ${ELAPSED}min ==" >> "$LOG"; break; fi
  if [ $ELAPSED -ge 110 ]; then echo "== WATCHDOG 110min CAP ==" >> "$LOG"; break; fi
  sleep 90
done
