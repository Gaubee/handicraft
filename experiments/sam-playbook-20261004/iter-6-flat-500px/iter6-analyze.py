#!/usr/bin/env python3
"""iter-6 取证分析器：frames.jsonl → 工具时间线/assistant 转录/审批帧/统计；sam-logs wire 回执参数提取；
终树锚点（imagePx/ppm）+ 逐叶掩膜 px/fill + task-layout 逐块钻数对账 + grants/results 取证。
与 iter-4/5 同口径，另增：工作画布锚点预验证节（500×500 判定）。DB 全程只读。"""
import json, os, sys, glob, sqlite3

TID = "92132887-b3b5-434b-8ef6-2bb799102291"
DR = "/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root"
OUT = "/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/iter-6-flat-500px"

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

# ---- 0. 工作画布锚点（本轮核心前置验证）----
print("== WORK CANVAS ANCHOR ==")
tv = con.execute("SELECT version, tree_blob_ref, cause, created_at FROM tree_versions WHERE task_id=? ORDER BY version DESC LIMIT 1", (TID,)).fetchone()
if tv:
    tree = json.load(open(blob_path(tv[1])))
    ip = tree.get("imagePx", {})
    cc = tree.get("canvasCm", {})
    ppm = None
    if ip.get("width") and cc.get("w"):
        ppm = ip["width"] / (cc["w"] * 10)
    print(f"tree v{tv[0]} cause={tv[2]} created={tv[3]}")
    print(f"canvasCm={cc} imagePx={ip} ppm={ppm}")
    print("ANCHOR:", "PASS 500x500" if ip.get("width") == 500 and ip.get("height") == 500 else f"FAIL/other: {ip}")
    json.dump(tree, open(f"{OUT}/tree-final.json", "w"), ensure_ascii=False, indent=1)
else:
    print("(no tree yet)")

# 工件帧（intake-image 尺寸 + scene-analysis）
from struct import unpack
def png_dims(p):
    with open(p, "rb") as f:
        d = f.read(33)
    return unpack(">II", d[16:24]) if d[:8] == b"\x89PNG\r\n\x1a\n" else (None, None)

arts = [f for f in frames if f["kind"] == "artifact"]
print("\n== artifact frames ==")
for f in arts:
    p = f["payload"]
    line = f"#{f['seq']} {p.get('name')} {str(p.get('blobRef'))[:12]}"
    if p.get("name") == "intake-image.png":
        bp = blob_path(p.get("blobRef"))
        if bp:
            w, h = png_dims(bp)
            line += f" dims={w}x{h}"
    print(line)

# intake resample progress 帧扫描
print("\n== intakeResample/progress 提及 ==")
for f in frames:
    s = json.dumps(f.get("payload", {}), ensure_ascii=False)
    if "intake" in s.lower() or "resample" in s.lower():
        print(f"#{f.get('seq')} {f.get('kind')}: {s[:400]}")

# ---- 1. kinds 统计 + 工具时间线 ----
kinds = {}
for f in frames:
    kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
print("\nKINDS:", json.dumps(kinds, ensure_ascii=False))

tools = [f for f in frames if f["kind"] == "tool"]
with open(f"{OUT}/raw-tool-timeline.md", "w") as fh:
    fh.write(f"# iter-6 工具调用时间线（全量 {len(tools)} 次）\n\n| seq | 工具 | 参数摘要 |\n|---|---|---|\n")
    for f in tools:
        p = f["payload"]
        inp = json.dumps(p.get("input", {}), ensure_ascii=False)
        fh.write(f"| {f['seq']} | {p.get('name')} | `{inp[:600]}` |\n")

# ---- 2. assistant 转录（全文）----
with open(f"{OUT}/raw-assistant-transcripts.md", "w") as fh:
    fh.write("# iter-6 assistant 全文转录\n\n")
    for f in frames:
        if f["kind"] != "transcript":
            continue
        p = f["payload"]
        fh.write(f"## #{f['seq']} [{p.get('role')}]\n\n{p.get('text','')}\n\n")

# ---- 3. 审批帧 + 结果帧 ----
print("\n== approval / done / result frames ==")
for f in frames:
    if f["kind"] in ("approval-request", "approval-resolved", "done", "error"):
        print(f"#{f['seq']} {f['kind']}: {json.dumps(f['payload'], ensure_ascii=False)[:1500]}")

# ---- 3b. grants 表（授权链 consumed）----
print("\n== grants (DB ro) ==")
for row in con.execute("SELECT id, proposal_id, consumed, auto_approved, created_at FROM grants WHERE task_id=? ORDER BY created_at", (TID,)):
    print(row)

# ---- 3c. results 表（分享包）----
print("\n== results (DB ro) ==")
for row in con.execute("SELECT public_id, title, bundle_path, created_at, expires_at FROM results WHERE task_id=?", (TID,)):
    print(row)

# ---- 4. 变体轮询/重发检测：tree_refine steps 提取 ----
print("\n== tree_refine 调用（nodeId+steps）==")
for f in tools:
    p = f["payload"]
    if p.get("name", "").endswith("tree_refine"):
        inp = p.get("input", {})
        print(f"#{f['seq']} node={inp.get('nodeId')} steps={json.dumps(inp.get('steps'), ensure_ascii=False)[:400]}")

# ---- 4b. 修树/重排操作统计 ----
print("\n== 修树操作统计 ==")
ops = {}
for f in tools:
    n = f["payload"].get("name", "?").split(".")[-1]
    if n.startswith("tree_"):
        ops[n] = ops.get(n, 0) + 1
print(ops)

# ---- 5. subject_segment 提示词序列（同参数重发检测）----
print("\n== subject_segment 提示词序列 ==")
for f in tools:
    p = f["payload"]
    if p.get("name", "").endswith("subject_segment"):
        inp = p.get("input", {})
        pr = inp.get("prompt") or inp.get("instruction") or ""
        box = inp.get("box")
        els = inp.get("elements")
        print(f"#{f['seq']} prompt={str(pr)[:80]!r} box={box} elements={'Y(%d)' % len(els) if els else '-'}")

# ---- 6. 授权链关键工具 ----
print("\n== 授权链工具（stones.add/strategy.design/execute/task.export/results）==")
for f in tools:
    p = f["payload"]
    n = p.get("name", "")
    if any(k in n for k in ("stones_add", "stones.add", "strategy_design", "strategy.design", "execute", "export", "stones_list")):
        print(f"#{f['seq']} {n}: {json.dumps(p.get('input', {}), ensure_ascii=False)[:400]}")

# ---- 7. SAM wire 回执参数 ----
print("\n== SAM wire 回执（confThreshold/maskMaxSide/precision）==")
wire = []
for d in sorted(glob.glob(f"{DR}/sam-logs/*/{TID}")):
    for jf in sorted(glob.glob(f"{d}/*.json")):
        try:
            r = json.load(open(jf))
        except Exception:
            continue
        req = r.get("request", {})
        wire.append(r)
        pr = req.get("prompt", {})
        ct = req.get("confThreshold")
        mms = req.get("maskMaxSide")
        print(f"{os.path.basename(jf)} outcome={r.get('outcome')} kind={pr.get('kind')} text={str(pr.get('text'))[:40]!r} box={'Y' if pr.get('box') else '-'} exB={'Y' if pr.get('excludeBox') else '-'} inst={pr.get('instances','-')} conf={ct} maskMaxSide={mms or '-'}")
nondefault = [w for w in wire if w.get("request", {}).get("confThreshold") not in (None, 0.4)]
print(f"\nWIRE total={len(wire)} ok={sum(1 for w in wire if w.get('outcome')=='ok')} confThreshold≠0.4: {len(nondefault)}")
maskmax = [w for w in wire if w.get("request", {}).get("maskMaxSide") not in (None,)]
print(f"maskMaxSide 显式携带: {len(maskmax)}")

# ---- 8. 工具名统计 ----
tool_counts = {}
for f in tools:
    n = f["payload"].get("name", "?")
    short = n.split(".")[-1]
    tool_counts[short] = tool_counts.get(short, 0) + 1
print("\nTOOL COUNTS:", json.dumps(tool_counts, ensure_ascii=False))

# ---- 9. KB 使用（kb_list/kb_get 时机）----
print("\n== KB 调用 ==")
for f in frames:
    if f["kind"] == "tool":
        p = f["payload"]
        if "kb" in p.get("name", ""):
            print(f"#{f['seq']} {p.get('name')}: {json.dumps(p.get('input', {}), ensure_ascii=False)[:300]}")

# ---- 10. 终树逐叶掩膜 px/fill ----
print("\n== 终树逐叶掩膜实测（mask px / bbox px / fill%）==")
if tv:
    nodes = {n["id"]: n for n in tree["nodes"]}
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

# ---- 11. task-layout 逐块钻数 ----
print("\n== task-layout 逐块钻数（终版）==")
lay_arts = [f for f in arts if f["payload"].get("name") == "task-layout.image-1.json"]
if lay_arts:
    lay = json.load(open(blob_path(lay_arts[-1]["payload"]["blobRef"])))
    json.dump(lay, open(f"{OUT}/task-layout-final.json", "w"), ensure_ascii=False)
    print(f"image={lay.get('imageWidth')}x{lay.get('imageHeight')} ppm={lay.get('grid',{}).get('pixelsPerMm')} gems={len(lay.get('gems',[]))}")
    cnt = {}
    for g in lay.get("gems", []):
        cnt[g["blockId"]] = cnt.get(g["blockId"], 0) + 1
    for b in lay.get("blocks", []):
        nm = "?"
        if tv:
            nn = nodes.get(b["id"])
            nm = nn.get("objectName") if nn else "?"
        print(f"{b['id']} {nm!r}: {cnt.get(b['id'],0)} gems")
    # 调色板名
    pal = lay.get("palette", {})
    print("palette:", {k: v.get("name") for k, v in pal.items()})
else:
    print("(no task-layout artifact)")

# ---- 12. 其余终版工件落盘 ----
for name, outname in [("strategy-plan.json", "strategy-plan-final.json"), ("stones-lint.json", "stones-lint-final.json"), ("scene-analysis.json", "scene-analysis.json")]:
    af = [f for f in arts if f["payload"].get("name") == name]
    if af:
        obj = json.load(open(blob_path(af[-1]["payload"]["blobRef"])))
        json.dump(obj, open(f"{OUT}/{outname}", "w"), ensure_ascii=False, indent=1)
        print(f"saved {outname} (from #{af[-1]['seq']})")
