"""SAM3-MLX spike：四张 20x20 原图 × 文本概念提示 → 掩码/叠加图/指标全量留存。

断点续跑：每个 (image, prompt) 组合的输出目录若已有 meta.json 则跳过。
所有产物落 ~/sam3-spike/results/，stdout 全量 tee 到 results/run.log。
"""
from __future__ import annotations

import json
import os
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

SPIKE = Path.home() / "sam3-spike"
IMAGES = sorted((SPIKE / "images").glob("*.jpg"))
RESULTS = SPIKE / "results"
PROMPTS = ["person", "hat", "wreath", "sleigh", "gift", "christmas tree"]
CONF = 0.4  # 稍放低阈值，看召回边界（默认 0.5）


def maxrss_gb() -> float:
    # macOS ru_maxrss 单位=字节
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9


def machine_info() -> dict:
    out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
    mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip())
    swap = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout.strip()
    return {"chip": out, "mem_gb": round(mem / 1e9, 1), "swapusage": swap, "os": subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True).stdout.strip()}


def to_np(x):
    import numpy as np
    import mlx.core as mx
    if isinstance(x, mx.array):
        return np.array(x)
    return np.asarray(x)


def main() -> None:
    t0 = time.time()
    print("=== SAM3-MLX spike 启动 ===", flush=True)
    print(json.dumps({"machine": machine_info(), "images": [p.name for p in IMAGES], "prompts": PROMPTS, "conf": CONF}, ensure_ascii=False), flush=True)

    from sam3 import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    t_load = time.time()
    model = build_sam3_image_model()  # 首跑自动下载 ~3.5GB 权重
    print(f"[load] 模型加载+下载完成 耗时 {time.time()-t_load:.1f}s maxRSS={maxrss_gb():.2f}GB", flush=True)
    processor = Sam3Processor(model, confidence_threshold=CONF)

    summary = {"machine": machine_info(), "load_sec": round(time.time() - t_load, 1), "items": []}

    for img_path in IMAGES:
        image = Image.open(img_path).convert("RGB")
        t_img = time.time()
        base_state = processor.set_image(image)
        print(f"[image] {img_path.name} set_image {time.time()-t_img:.2f}s", flush=True)

        for prompt in PROMPTS:
            out_dir = RESULTS / img_path.stem / prompt.replace(" ", "_")
            if (out_dir / "meta.json").exists():
                print(f"[skip] {img_path.stem} / {prompt}（已有输出）", flush=True)
                continue
            out_dir.mkdir(parents=True, exist_ok=True)

            t_p = time.time()
            try:
                state = processor.set_text_prompt(prompt, dict(base_state))  # 浅拷贝防跨提示污染
            except Exception as e:  # noqa: BLE001
                (out_dir / "meta.json").write_text(json.dumps({"error": repr(e)}, ensure_ascii=False))
                print(f"[error] {img_path.stem} / {prompt}: {e!r}", flush=True)
                continue
            dt = time.time() - t_p

            masks = to_np(state["masks"])   # (N,1,H,W)
            boxes = to_np(state["boxes"])   # (N,4)
            scores = [float(s) for s in to_np(state["scores"])]
            n = len(scores)
            print(f"[prompt] {img_path.stem} / {prompt}: {n} 检出 {dt:.2f}s maxRSS={maxrss_gb():.2f}GB", flush=True)

            meta = {"image": img_path.name, "prompt": prompt, "conf": CONF, "n": n,
                    "scores": [round(s, 4) for s in scores],
                    "boxes": [[round(float(v), 1) for v in b] for b in (boxes if n else [])],
                    "sec": round(dt, 2)}
            # 掩码与叠加图（每检出一个文件；上限 8 个防爆盘）
            if n:
                palette = [(255, 60, 60), (60, 160, 255), (80, 220, 90), (255, 200, 40), (200, 80, 255), (60, 220, 220), (255, 120, 160), (120, 120, 120)]
                for i in range(min(n, 8)):
                    m = masks[i]
                    if m.ndim == 3:
                        m = m[0]
                    mask_img = Image.fromarray((m > 0).astype("uint8") * 255)
                    mask_img.save(out_dir / f"mask_{i}.png")
                    overlay = image.copy()
                    color = palette[i % len(palette)]
                    tint = Image.new("RGB", overlay.size, color)
                    overlay = Image.composite(Image.blend(overlay, tint, 0.45), overlay, mask_img)
                    d = ImageDraw.Draw(overlay)
                    if len(boxes) > i:
                        x0, y0, x1, y1 = [float(v) for v in boxes[i]]
                        d.rectangle([x0, y0, x1, y1], outline=color, width=3)
                        d.text((x0 + 4, max(0, y0 - 14)), f"{prompt} {scores[i]:.2f}", fill=color)
                    overlay.save(out_dir / f"overlay_{i}.jpg", quality=92)
            (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
            summary["items"].append({"image": img_path.stem, "prompt": prompt, "n": n, "sec": round(dt, 2)})

    summary["total_sec"] = round(time.time() - t0, 1)
    summary["peak_rss_gb"] = round(maxrss_gb(), 2)
    (RESULTS / "metrics.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print("=== 完成 ===", json.dumps({"total_sec": summary["total_sec"], "peak_rss_gb": summary["peak_rss_gb"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
