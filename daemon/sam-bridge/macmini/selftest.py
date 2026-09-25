#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P2.1 部署自测：start.sh 起→协议面探针→断言→stop.sh 停。stdout 由外层 tee 到 logs/selftest.log。"""
import base64
import json
import subprocess
import sys
import time
from pathlib import Path

BASE = Path.home() / "sam3-spike" / "service"
IMG = sorted((Path.home() / "sam3-spike" / "images").glob("*.jpg"))[0]

FAILS = []


def ask(req_obj=None, raw=None):
    arg = raw if raw is not None else json.dumps(req_obj, ensure_ascii=False)
    r = subprocess.run([str(BASE / "ask.sh"), arg], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        return {"_client_error": r.stderr.strip()[:300]}
    try:
        return json.loads(r.stdout.strip())
    except Exception as e:  # noqa: BLE001
        return {"_bad": r.stdout[:200], "err": str(e)}


def check(name, cond, extra=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}", flush=True)
    if not cond:
        FAILS.append(name)


print(f"image = {IMG.name}", flush=True)

print("== start.sh ==", flush=True)
r = subprocess.run([str(BASE / "start.sh")], capture_output=True, text=True)
print(r.stdout.strip(), flush=True)
check("start ok", r.returncode == 0 and "pid=" in r.stdout)

# 1 version
t0 = time.time()
v = ask({"id": "v1", "method": "version"})
print(f"version ({time.time()-t0:.1f}s): {json.dumps(v, ensure_ascii=False)[:400]}", flush=True)
check("version ok", v.get("ok") is True and v.get("id") == "v1")
vr = v.get("result") or {}
check("version fields", all(k in vr for k in ("service", "mlxSam3", "model", "chip")), str({k: vr.get(k) for k in ('mlxSam3','model','chip')}))

# 2 segment 文本面 person
t0 = time.time()
s = ask({"id": "s1", "method": "segment", "params": {
    "imagePath": str(IMG), "prompt": {"text": "person"}, "topK": 2}})
dt = time.time() - t0
res = s.get("result") or {}
print(f"segment text person ({dt:.1f}s incl 首载): count={res.get('count')} "
      f"maskPx={res.get('maskPx')} score={res.get('score')}", flush=True)
check("segment text ok", s.get("ok") is True and s.get("id") == "s1")
check("mask non-empty", (res.get("maskPx") or 0) > 0, f"maskPx={res.get('maskPx')}")
m = res.get("mask") or {}
check("mask dims = 原图", m.get("w") == res.get("width") and m.get("h") == res.get("height"),
      f"{m.get('w')}x{m.get('h')} vs {res.get('width')}x{res.get('height')}")
if m.get("dataBase64"):
    b = base64.b64decode(m["dataBase64"])
    check("mask bytes 0/1 且和=maskPx", set(b) <= {0, 1} and sum(b) == res.get("maskPx"),
          f"len={len(b)} sum={sum(b)}")

# 3 segment box 面（用 person 框收缩 60%）
bx = res["detections"][0]["boxPx"] if res.get("detections") else None
if bx:
    x, y, w, h = bx
    t0 = time.time()
    sb = ask({"id": "s2", "method": "segment", "params": {
        "imagePath": str(IMG),
        "prompt": {"box": [round(x + w * 0.2), round(y + h * 0.2), round(w * 0.6), round(h * 0.6)]},
        "topK": 1}})
    dt = time.time() - t0
    rb = sb.get("result") or {}
    print(f"segment box ({dt:.1f}s): count={rb.get('count')} maskPx={rb.get('maskPx')} "
          f"score={rb.get('score')}", flush=True)
    check("segment box ok", sb.get("ok") is True)
    check("box mask non-empty", (rb.get("maskPx") or 0) > 0, f"maskPx={rb.get('maskPx')}")

    # 4 text+box 组合面
    t0 = time.time()
    cb = ask({"id": "s3", "method": "segment", "params": {
        "imagePath": str(IMG),
        "prompt": {"text": "person", "box": [round(x + w * 0.15), round(y + h * 0.15),
                                              round(w * 0.7), round(h * 0.7)]},
        "topK": 1}})
    dt = time.time() - t0
    rc = cb.get("result") or {}
    print(f"segment text+box ({dt:.1f}s): count={rc.get('count')} maskPx={rc.get('maskPx')}", flush=True)
    check("text+box combo ok", cb.get("ok") is True and (rc.get("maskPx") or 0) > 0,
          f"maskPx={rc.get('maskPx')}")
else:
    check("person 检出框可用作 box 测试", False)

# 5 analyze → UNSUPPORTED
a = ask({"id": "a1", "method": "analyze", "params": {"imagePath": str(IMG), "instruction": "describe"}})
print(f"analyze: {json.dumps(a, ensure_ascii=False)[:300]}", flush=True)
check("analyze unsupported", a.get("ok") is False and a.get("error", {}).get("code") == "UNSUPPORTED")

# 6 points → UNSUPPORTED
pt = ask({"id": "p1", "method": "segment", "params": {
    "imagePath": str(IMG), "prompt": {"points": [{"x": 100, "y": 100, "label": "include"}]}}})
check("points unsupported", pt.get("ok") is False and pt.get("error", {}).get("code") == "UNSUPPORTED")

# 7 未知 method
mn = ask({"id": "m1", "method": "nope"})
check("method not found", mn.get("ok") is False and mn.get("error", {}).get("code") == "METHOD_NOT_FOUND")

# 8 坏 JSON
bad = ask(raw="{not json")
try:
    bj = json.loads(json.dumps(bad))  # ask 返回已解析对象
    check("parse error", bj.get("ok") is False and bj.get("error", {}).get("code") == "PARSE_ERROR")
except Exception:  # noqa: BLE001
    check("parse error", False, str(bad)[:150])

# 9 缺图
miss = ask({"id": "e1", "method": "segment", "params": {
    "imagePath": "/nonexistent.jpg", "prompt": {"text": "person"}}})
check("image error", miss.get("ok") is False and miss.get("error", {}).get("code") == "IMAGE_ERROR")

# 10 status
st = ask({"id": "st", "method": "status"})
rs = st.get("result") or {}
print(f"status: {json.dumps(rs, ensure_ascii=False)}", flush=True)
check("status loaded+counts", rs.get("loaded") is True and (rs.get("requests") or 0) >= 9)

# 11 stop
print("== stop.sh ==", flush=True)
r = subprocess.run([str(BASE / "stop.sh")], capture_output=True, text=True)
print(r.stdout.strip(), flush=True)
check("stop ok", r.returncode == 0)
check("pidfile removed", not (BASE / "sam3-service.pid").exists())

print(f"\n=== {'ALL PASS' if not FAILS else 'FAILURES: ' + str(FAILS)} ===", flush=True)
sys.exit(1 if FAILS else 0)
