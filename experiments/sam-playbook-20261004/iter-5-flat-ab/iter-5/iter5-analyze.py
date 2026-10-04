#!/usr/bin/env python3
"""iter-5 取证分析器：frames.jsonl → 工具时间线/assistant 转录/审批帧/统计；sam-logs wire 回执参数提取。与 iter-4 同口径。"""
import json, os, sys, glob

TID = "54a92bde-3a48-4478-b3e3-fccc771906ed"
DR = "/Users/kzf/Pictures/贴钻/experiments/journey-clown-rich-v5-20260928/data-root"
OUT = "/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/iter-5-flat-ab/iter-5"

frames = []
for line in open(f"{DR}/tasks/{TID}/frames.jsonl"):
    try:
        frames.append(json.loads(line))
    except Exception:
        pass

# ---- 1. kinds 统计 + 工具时间线 ----
kinds = {}
for f in frames:
    kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
print("KINDS:", json.dumps(kinds, ensure_ascii=False))

tools = [f for f in frames if f["kind"] == "tool"]
with open(f"{OUT}/raw-tool-timeline.md", "w") as fh:
    fh.write(f"# iter-5 工具调用时间线（全量 {len(tools)} 次）\n\n| seq | 工具 | 参数摘要 |\n|---|---|---|\n")
    for f in tools:
        p = f["payload"]
        inp = json.dumps(p.get("input", {}), ensure_ascii=False)
        fh.write(f"| {f['seq']} | {p.get('name')} | `{inp[:600]}` |\n")

# ---- 2. assistant 转录（全文）----
with open(f"{OUT}/raw-assistant-transcripts.md", "w") as fh:
    fh.write("# iter-5 assistant 全文转录\n\n")
    for f in frames:
        if f["kind"] != "transcript":
            continue
        p = f["payload"]
        role = p.get("role")
        text = p.get("text", "")
        fh.write(f"## #{f['seq']} [{role}]\n\n{text}\n\n")

# ---- 3. 审批帧 + 结果帧 ----
print("\n== approval / done / result frames ==")
for f in frames:
    if f["kind"] in ("approval-request", "approval-resolved", "done", "error"):
        print(f"#{f['seq']} {f['kind']}: {json.dumps(f['payload'], ensure_ascii=False)[:1500]}")

# ---- 4. 变体轮询/重发检测：tree_refine steps 提取 ----
print("\n== tree_refine 调用（nodeId+steps）==")
for f in tools:
    p = f["payload"]
    if p.get("name", "").endswith("tree_refine"):
        inp = p.get("input", {})
        print(f"#{f['seq']} node={inp.get('nodeId')} steps={json.dumps(inp.get('steps'), ensure_ascii=False)[:400]}")

# ---- 5. subject_segment 提示词序列（同参数重发检测）----
print("\n== subject_segment 提示词序列 ==")
for f in tools:
    p = f["payload"]
    if p.get("name", "").endswith("subject_segment"):
        inp = p.get("input", {})
        pr = inp.get("prompt") or inp.get("instruction") or ""
        box = inp.get("box")
        print(f"#{f['seq']} prompt={str(pr)[:80]!r} box={box}")

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
