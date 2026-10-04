#!/usr/bin/env python3
"""T7a 取证分析器（run2 任务 34260f3e）：frames.jsonl → 工具时间线/assistant 转录/审批帧/统计；
sam-logs wire 回执参数提取；终树锚点+逐叶掩膜 px/fill+task-layout 逐块钻数对账+grants/results 取证。
与 iter-4/6 同口径，新增 T1-T6 面：①style 字段与参考图层软回退帧 ②reference-image 工件缺席断言
③归属门 attribution-gaps（export warnings+bundle manifest audit）④导出原图门（source.img 字节=上传
blob）⑤pavingStyle 落参。DB 全程只读。"""
import json, os, sys, glob, sqlite3

TID = "34260f3e-603f-43f9-809d-910a42c53d65"
DR = "/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root"
OUT = "/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship"
UPLOAD_HASH = "6267829d311a27ee098b248f61bcb8afe31db0cfdcf76039a4453d4184aba5b9"

con = sqlite3.connect(f"file:{DR}/handicraft.db?mode=ro", uri=True)

def blob_path(h):
    row = con.execute("SELECT store_path FROM blobs WHERE hash=? LIMIT 1", (h,)).fetchone()
    return f"{DR}/blobs/{row[0]}" if row else None

frames = []
for line in open(f"{DR}/tasks/{TID}/frames.jsonl"):
    try:
        frames.append(json.loads(line))
    except Exception:
        pass

# ---- 0. 工作画布锚点 + T1/T2 面前置复核 ----
print("== WORK CANVAS ANCHOR / T1 style / T2 soft-fallback ==")
tv = con.execute("SELECT version, tree_blob_ref, cause, created_at FROM tree_versions WHERE task_id=? ORDER BY version DESC LIMIT 1", (TID,)).fetchone()
nodes = {}
tree = None
if tv:
    tree = json.load(open(blob_path(tv[1])))
    nodes = {n["id"]: n for n in tree["nodes"]}
    ip = tree.get("imagePx", {})
    cc = tree.get("canvasCm", {})
    ppm = ip.get("width") / (cc.get("w", 1) * 10) if ip.get("width") else None
    print(f"tree v{tv[0]} cause={tv[2]} created={tv[3]}")
    print(f"canvasCm={cc} imagePx={ip} ppm={ppm} imageBlobRef={str(tree.get('imageBlobRef'))[:16]}")
    print("ANCHOR:", "PASS 500x500" if ip.get("width") == 500 and ip.get("height") == 500 else f"other: {ip}")
    json.dump(tree, open(f"{OUT}/tree-final.json", "w"), ensure_ascii=False, indent=1)

arts = [f for f in frames if f["kind"] == "artifact"]
art_names = {}
for f in arts:
    art_names.setdefault(f["payload"].get("name"), 0)
    art_names[f["payload"].get("name")] += 1
print("artifact 帧名计数:", json.dumps(art_names, ensure_ascii=False))
print("reference-image.png 帧缺席:", "reference-image.png" not in art_names)
print("reference-image-report.json 帧缺席:", "reference-image-report.json" not in art_names)

for f in frames:
    if f["kind"] == "log":
        print(f"log 帧 #{f.get('seq')}: {f['payload'].get('text')[:200]}")

sa = [f for f in arts if f["payload"].get("name") == "scene-analysis.json"]
if sa:
    sad = json.load(open(blob_path(sa[-1]["payload"]["blobRef"])))
    json.dump(sad, open(f"{OUT}/scene-analysis.json", "w"), ensure_ascii=False, indent=1)
    print(f"scene-analysis style={sad.get('style')} imagePx={sad.get('imagePx')}")

# ---- 1. kinds 统计 + 工具时间线 ----
kinds = {}
for f in frames:
    kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
print("\nKINDS:", json.dumps(kinds, ensure_ascii=False))

tools = [f for f in frames if f["kind"] == "tool"]
with open(f"{OUT}/raw-tool-timeline.md", "w") as fh:
    fh.write(f"# T7a 工具调用时间线（全量 {len(tools)} 次）\n\n| seq | 工具 | 参数摘要 |\n|---|---|---|\n")
    for f in tools:
        p = f["payload"]
        inp = json.dumps(p.get("input", {}), ensure_ascii=False)
        fh.write(f"| {f['seq']} | {p.get('name')} | `{inp[:600]}` |\n")

with open(f"{OUT}/raw-assistant-transcripts.md", "w") as fh:
    fh.write("# T7a assistant 全文转录\n\n")
    for f in frames:
        if f["kind"] != "transcript":
            continue
        p = f["payload"]
        fh.write(f"## #{f['seq']} [{p.get('role')}]\n\n{p.get('text','')}\n\n")

# ---- 3. 审批帧 ----
print("\n== approval / done / error frames ==")
for f in frames:
    if f["kind"] in ("approval-request", "approval-resolved", "done", "error"):
        print(f"#{f['seq']} {f['kind']}: {json.dumps(f['payload'], ensure_ascii=False)[:1200]}")

print("\n== grants (DB ro) ==")
for row in con.execute("SELECT id, proposal_id, consumed, auto_approved, created_at FROM grants WHERE task_id=? ORDER BY created_at", (TID,)):
    print(row)

print("\n== results (DB ro) ==")
for row in con.execute("SELECT public_id, title, bundle_path, created_at, expires_at FROM results WHERE task_id=?", (TID,)):
    print(row)

# ---- 4. 修树操作统计 ----
ops = {}
for f in tools:
    n = f["payload"].get("name", "?").split(".")[-1]
    if n.startswith("tree_"):
        ops[n] = ops.get(n, 0) + 1
print("\n修树操作统计:", ops)

# ---- 5. subject_segment 提示词序列 ----
print("\n== subject_segment 序列 ==")
for f in tools:
    p = f["payload"]
    if p.get("name", "").endswith("subject_segment"):
        inp = p.get("input", {})
        pr = inp.get("prompt") or inp.get("instruction") or ""
        print(f"#{f['seq']} prompt={str(pr)[:80]!r} box={inp.get('box')} elements={'Y(%d)' % len(inp.get('elements') or []) if inp.get('elements') else '-'}")

# ---- 6. 策略/导出关键工具 + pavingStyle ----
print("\n== 策略/导出工具（pavingStyle 落参）==")
for f in tools:
    p = f["payload"]
    n = p.get("name", "")
    if any(k in n for k in ("stones_add", "stones.add", "strategy", "execute", "export", "set_create", "set.create")):
        inp = p.get("input", {})
        ps = inp.get("pavingStyle")
        tag = f" pavingStyle={ps}" if ps else ""
        print(f"#{f['seq']} {n}{tag}: {json.dumps(inp, ensure_ascii=False)[:300]}")

# ---- 7. SAM wire 回执 ----
print("\n== SAM wire 回执 ==")
wire = []
for d in sorted(glob.glob(f"{DR}/sam-logs/*/{TID}")):
    for jf in sorted(glob.glob(f"{d}/*.json")):
        try:
            r = json.load(open(jf))
        except Exception:
            continue
        wire.append(r)
        req = r.get("request", {})
        pr = req.get("prompt", {})
        print(f"{os.path.basename(jf)} outcome={r.get('outcome')} text={str(pr.get('text'))[:40]!r} box={'Y' if pr.get('box') else '-'} conf={req.get('confThreshold')} maskMaxSide={req.get('maskMaxSide') or '-'}")
nondefault = [w for w in wire if w.get("request", {}).get("confThreshold") not in (None, 0.4)]
print(f"\nWIRE total={len(wire)} ok={sum(1 for w in wire if w.get('outcome')=='ok')} confThreshold≠0.4: {len(nondefault)}")
from collections import Counter
print("conf 分布:", dict(Counter(w.get("request", {}).get("confThreshold") for w in wire)))

# ---- 8. 工具名统计 ----
tool_counts = {}
for f in tools:
    short = f["payload"].get("name", "?").split(".")[-1]
    tool_counts[short] = tool_counts.get(short, 0) + 1
print("\nTOOL COUNTS:", json.dumps(tool_counts, ensure_ascii=False))

# ---- 9. KB 使用 ----
print("\n== KB 调用 ==")
for f in tools:
    if "kb" in f["payload"].get("name", ""):
        print(f"#{f['seq']} {f['payload'].get('name')}: {json.dumps(f['payload'].get('input', {}), ensure_ascii=False)[:260]}")

# ---- 10. 终树逐叶掩膜 ----
print("\n== 终树逐叶掩膜实测 ==")
if tree:
    for n in tree["nodes"]:
        m = n.get("mask")
        if not m or m.get("kind") != "blob":
            continue
        bp = blob_path(m.get("blobRef"))
        if not bp:
            continue
        data = open(bp, "rb").read()
        nz = sum(1 for b in data if b)
        area = m["w"] * m["h"]
        kids = len(n.get("children") or [])
        print(f"{n['id']} {n.get('objectName')!r} bbox={n.get('bbox')} mask={m['w']}x{m['h']} nz={nz} fill={100*nz/area:.1f}% children={kids}")

# ---- 11. task-layout ----
print("\n== task-layout 逐块钻数 ==")
lay_arts = [f for f in arts if f["payload"].get("name") == "task-layout.image-1.json"]
if lay_arts:
    lay = json.load(open(blob_path(lay_arts[-1]["payload"]["blobRef"])))
    json.dump(lay, open(f"{OUT}/task-layout-final.json", "w"), ensure_ascii=False)
    print(f"image={lay.get('imageWidth')}x{lay.get('imageHeight')} ppm={lay.get('grid',{}).get('pixelsPerMm')} gems={len(lay.get('gems',[]))}")
    cnt = {}
    for g in lay.get("gems", []):
        cnt[g["blockId"]] = cnt.get(g["blockId"], 0) + 1
    for b in lay.get("blocks", []):
        nn = nodes.get(b["id"])
        print(f"{b['id']} {nn.get('objectName') if nn else '?'}: {cnt.get(b['id'],0)} gems")

# ---- 12. 其余终版工件落盘 ----
for name, outname in [("strategy-plan.json", "strategy-plan-final.json"), ("stones-lint.json", "stones-lint-final.json")]:
    af = [f for f in arts if f["payload"].get("name") == name]
    if af:
        obj = json.load(open(blob_path(af[-1]["payload"]["blobRef"])))
        json.dump(obj, open(f"{OUT}/{outname}", "w"), ensure_ascii=False, indent=1)
        print(f"saved {outname} (from #{af[-1]['seq']})")

# ---- 13. T4 归属门 + T5 导出原图门（bundle 取证）----
print("\n== T4 归属门 / T5 导出原图门 ==")
res = con.execute("SELECT public_id, bundle_path FROM results WHERE task_id=?", (TID,)).fetchall()
for pid, bpath in res:
    bdir = os.path.dirname(bpath) if os.path.isabs(bpath) else os.path.join(DR, bpath)
    print("bundle dir:", bdir, os.path.isdir(bdir))
    bj = os.path.join(bdir, "bundle.json")
    if os.path.exists(bj):
        bundle = json.load(open(bj))
        json.dump(bundle, open(f"{OUT}/bundle.json", "w"), ensure_ascii=False, indent=1)
        audit = bundle.get("audit") or {}
        print("bundle.json audit 段 keys:", list(audit.keys()))
        print("attributionGaps:", json.dumps(audit.get("attributionGaps"), ensure_ascii=False)[:1500])
        print("layoutAlignment:", json.dumps(audit.get("layoutAlignment"), ensure_ascii=False)[:600])
        print("sourceImage:", json.dumps(audit.get("sourceImage"), ensure_ascii=False)[:300])
        print("warnings:", json.dumps(bundle.get("warnings"), ensure_ascii=False)[:800])
    src = os.path.join(bdir, "source.img")
    if os.path.exists(src):
        import hashlib
        h = hashlib.sha256(open(src, "rb").read()).hexdigest()
        up = hashlib.sha256(open(blob_path(UPLOAD_HASH), "rb").read()).hexdigest() if blob_path(UPLOAD_HASH) else None
        print(f"source.img sha256={h}")
        print(f"upload    sha256={up}")
        print("SOURCE-IMG == UPLOAD BYTES:", h == up)
    for fn in os.listdir(bdir):
        print(" bundle file:", fn, os.path.getsize(os.path.join(bdir, fn)))
