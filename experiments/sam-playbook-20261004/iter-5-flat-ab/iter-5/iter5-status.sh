#!/bin/bash
# iter-5 盯跑状态探针：帧数/最近帧/任务状态（DB 只读）——同一探针可反复手动调用
TID=54a92bde-3a48-4478-b3e3-fccc771906ed
F="/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root/tasks/$TID/frames.jsonl"
DB="file:/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root/handicraft.db?mode=ro"
echo "== $(date -u +%H:%M:%SZ) =="
wc -l < "$F" 2>/dev/null | xargs echo "frames:"
sqlite3 "$DB" "SELECT status, created_at, updated_at FROM tasks WHERE id='$TID';" 2>/dev/null
python3 - "$F" <<'EOF'
import json, sys
frames = []
try:
    for line in open(sys.argv[1]):
        try: frames.append(json.loads(line))
        except: pass
except FileNotFoundError:
    print("(no frames file)"); sys.exit()
kinds = {}
for f in frames: kinds[f.get('kind')] = kinds.get(f.get('kind'), 0) + 1
print("kinds:", kinds)
for f in frames[-8:]:
    p = f.get('payload', {})
    if f.get('kind') == 'transcript':
        print(f"  #{f.get('seq')} transcript[{p.get('role')}] {str(p.get('text',''))[:110]!r}")
    elif f.get('kind') == 'tool':
        print(f"  #{f.get('seq')} tool {p.get('name')} {str(p.get('input',p))[:100]!r}")
    else:
        print(f"  #{f.get('seq')} {f.get('kind')} {str(p)[:100]!r}")
EOF
