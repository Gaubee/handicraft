#!/usr/bin/env python3
"""补证① live 回归取证（HEAD 159d72c，任务 27c4f7f0·会话 ef497520，2026-10-05）。
验证链：JPEG(627d3260…) 直传 → followup 单漏斗归一 → 全链只引用归一 PNG ref(4d9eddcf…)。
DB 只读；断言失败即非零退出。"""
import json, sqlite3, struct, sys

DR = "/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root"
TID = "27c4f7f0-9432-4edf-b3f6-e7fcb1cf92ce"
OUT = "/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/jpeg-live-regression"
JPG_REF = "627d3260830a9ca753b1ac79310cf30ed4e123de70fae6a29b5eab8f2b7af5d4"  # 上传原字节（274101B JPEG）
PNG_REF = "4d9eddcf09f884013749bddb0ba7fc0"  # 前缀——完整值从 frames 取

con = sqlite3.connect(f"file:{DR}/handicraft.db?mode=ro", uri=True)
def blob_path(h):
    row = con.execute("SELECT store_path FROM blobs WHERE hash=? LIMIT 1", (h,)).fetchone()
    return f"{DR}/blobs/{row[0]}" if row else None

frames = [json.loads(l) for l in open(f"{DR}/tasks/{TID}/frames.jsonl")]
fails, checks = [], []
def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    if not ok: fails.append(name)
    print(("PASS " if ok else "FAIL ") + name + (("  | " + detail) if detail else ""))

raw = frames and json.dumps(frames)
# 1. 全程零 image-decode-failed（run1 的死链面）
check("零 image-decode-failed", "image-decode-failed" not in raw)

# 2. 归一 ref 提取：scene.analyze 调用入参里的 imageBlobRef（64 位十六进制正则——转录含中文括号叙事，裸 find 会切错）
import re
call_ref = None
for f in frames:
    t = f.get("payload", {}).get("text", "") or ""
    if "scene_analyze" in t:
        m = re.search(r'"imageBlobRef"\s*:\s*"([0-9a-f]{64})"', t)
        if m:
            call_ref = m.group(1)
            break
check("scene.analyze 输入=归一 ref（≠JPEG ref）", bool(call_ref) and call_ref != JPG_REF and call_ref.startswith(PNG_REF), call_ref or "not found")

# 3. 归一 blob 本体：PNG 魔数+尺寸（原 JPEG 1280×1280 → PNG 同尺寸；无 EXIF 旋转）
p = blob_path(call_ref)
head = open(p, "rb").read(26) if p else b""
ok_png = head[:8] == b"\x89PNG\r\n\x1a\n"
w, h = struct.unpack(">II", head[16:24]) if ok_png else (0, 0)
check("归一 blob=PNG 魔数", ok_png, f"{w}x{h}, {p}")

# 4. JPEG ref 与归一 ref 双双在库（原字节保留=审计真源）
check("原 JPEG blob 在库", blob_path(JPG_REF) is not None)

# 5. tasks.params：会话附件=归一 ref（prompt 锚注/审计面）
row = con.execute("SELECT params FROM tasks WHERE id=?", (TID,)).fetchone()
params = json.loads(row[0]) if row and row[0] else {}
pj = json.dumps(params, ensure_ascii=False)
check("tasks.params 含归一 ref", PNG_REF[:32] in pj)
# 设计=无 ref 双源：任务面（params 审计）零原 JPEG ref；原字节只存 blobs 内容库+上传归属入账
check("tasks.params 零 JPEG ref（无 ref 双源）", JPG_REF[:32] not in pj)

# 6. 会话可见面（帧流）零 JPEG ref 引用——归一 ref 才是唯一操作对象
jpeg_in_visible = [f["seq"] for f in frames if JPG_REF[:32] in json.dumps(f, ensure_ascii=False)]
check("帧流（会话可见面）零 JPEG ref 引用", len(jpeg_in_visible) == 0, f"seqs={jpeg_in_visible}")

# 7. intake-image.png 工件在场（工作画布锚点工件）
art_names = [f["payload"].get("name") for f in frames if f["kind"] == "artifact"]
check("intake-image.png 工件在场", "intake-image.png" in art_names, ",".join(map(str, art_names)))

# 8. scene-analysis 工件+style 判定在场（S2 真跑通——run1 死在这一步）
sa_arts = [f["payload"] for f in frames if f["kind"] == "artifact" and "scene" in str(f["payload"].get("name", ""))]
check("scene-analysis 工件在场", len(sa_arts) > 0, str([a.get("name") for a in sa_arts]))

# 9. 终态 done + 终报在场（轻指令闭环）
status = con.execute("SELECT status FROM tasks WHERE id=?", (TID,)).fetchone()[0]
final_texts = [f["payload"].get("text", "") for f in frames if f["kind"] == "transcript" and f["payload"].get("role") == "assistant"]
check("任务终态 done", status == "done", status)
check("assistant 终报在场", any(len(t) > 40 for t in final_texts))

# 10. style 判定值（photographic 预期——同图 run2 判过 photographic）
sa_path = None
for a in sa_arts:
    bp = blob_path(a.get("blobRef", ""))
    if bp:
        sa_path = bp
if sa_path:
    sa = json.load(open(sa_path))
    style = sa.get("style") or (sa.get("analysis") or {}).get("style")
    check("style 判定在场", bool(style), f"style={style} ({sa_path})")
else:
    check("style 判定在场", False, "scene-analysis blob 不可达")

json.dump({"taskId": TID, "checks": [{"name": n, "ok": o, "detail": d} for n, o, d in checks],
           "jpegRef": JPG_REF, "normalizedRef": call_ref, "taskStatus": status},
          open(f"{OUT}/verify-result.json", "w"), ensure_ascii=False, indent=1)
print(f"\n== {len(checks)-len(fails)}/{len(checks)} PASS ==")
sys.exit(1 if fails else 0)
