#!/usr/bin/env python3
"""P1.2 语义拟合族 fixture 生成器（add-subject-sam-pipeline tasks P1.2——一次性离线跑，测试只读产物）。

数据源：四客户参考图（experiments/sam3-spike-20260924 原稿 736×736≈20×20cm，PPM=3.68）：
  2a0c 小丑 / 5836 花束 / f5c7 地精 / ebdc 圣诞树+雪橇
产出：daemon/tests/fixtures/p1-semantic/*.json——每族一份真实裁片掩膜（+texture 族亮度场）：
  { family, source, cropRect, w, h, maskB64(w*h 字节 0/1——TreeMask2D 同构),
    lumaB64(w*h 灰度字节——texture-fill params.lumaB64 通道), meta }
物理标度：native PPM=3.68（736px/200mm）——测试侧 canvas.pixelsPerMm 用 meta.ppm。

分割规则（PIL/numpy 确定性阈值+连通域，纯程序无视觉判读）：
  texture-costume  2a0c 小丑服裁片   gray<228 最大连通域（棕布褶皱——亮度场+方向感）
  texture-sleigh   ebdc 水晶雪橇裁片  gray<210 最大连通域（晶体亮暗面——bright 方向场）
  softcurve-stems  5836 花茎裁片     绿显性 (g>r+10 且 g>b+10) ∪ 暗绿线，中值3去噪
  flower-bloom     5836 雪滴花裁片    边界洪水填充非背景（花瓣+花茎+叶的瓣状复合体）
  straightline-hat f5c7 地精帽裁片    主体规则（通道极差>25 或 明度<190）最大连通域（三角刚硬）

用法：python3 generate-p1-semantic.py   （在 daemon/tests/fixtures/ 下落 p1-semantic/*.json）
"""
import base64
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
# fixtures → tests → daemon → 贴钻-backend → Pictures/贴钻（跨仓只读源——生成时一次性）
SRC = HERE.parent.parent.parent.parent / "贴钻" / "experiments" / "sam3-spike-20260924"
OUT = HERE / "p1-semantic"
PPM = 736 / 200  # 3.68 px/mm

IMGS = {
    "2a0c": "2a0c3c0e1d8affecab84fe2f18c681e3.jpg",
    "5836": "5836eeaf1001d6a1e8d9dd245f641099.jpg",
    "f5c7": "f5c755f7d070c9e2160841396b23a2f8.jpg",
    "ebdc": "ebdc69029a822eebdf537491995d503b.jpg",
}


def load(img_key: str) -> Image.Image:
    return Image.open(SRC / IMGS[img_key]).convert("RGB")


def largest_cc(m: np.ndarray) -> np.ndarray:
    """8 连通最大连通域（纯 BFS）。"""
    h, w = m.shape
    lab = np.zeros((h, w), dtype=int)
    cur, best, bestn = 0, 0, 0
    for y in range(h):
        for x in range(w):
            if m[y, x] and lab[y, x] == 0:
                cur += 1
                dq = deque([(y, x)])
                lab[y, x] = cur
                n = 0
                while dq:
                    cy, cx = dq.popleft()
                    n += 1
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            if dy == 0 and dx == 0:
                                continue
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and lab[ny, nx] == 0:
                                lab[ny, nx] = cur
                                dq.append((ny, nx))
                if n > bestn:
                    bestn, best = n, cur
    return lab == best


def drop_small_ccs(m: np.ndarray, min_px: int) -> np.ndarray:
    h, w = m.shape
    lab = np.zeros((h, w), dtype=int)
    cur = 0
    sizes = {}
    for y in range(h):
        for x in range(w):
            if m[y, x] and lab[y, x] == 0:
                cur += 1
                dq = deque([(y, x)])
                lab[y, x] = cur
                n = 0
                while dq:
                    cy, cx = dq.popleft()
                    n += 1
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            if dy == 0 and dx == 0:
                                continue
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and lab[ny, nx] == 0:
                                lab[ny, nx] = cur
                                dq.append((ny, nx))
                sizes[cur] = n
    keep = {k for k, v in sizes.items() if v >= min_px}
    return np.isin(lab, list(keep))


def tight_bbox(m: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(m)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def border_flood_not_bg(gray: np.ndarray, tau: int) -> np.ndarray:
    """边界可达白（≥tau）为背景；不可达=前景（包围结构——花瓣内部等）。"""
    h, w = gray.shape
    white = gray >= tau
    bg = np.zeros_like(white, dtype=bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and white[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True
                dq.append((ny, nx))
    return ~bg


def emit(family: str, source: str, img: Image.Image, crop: tuple[int, int, int, int],
         mask_full: np.ndarray, gray_full: np.ndarray, meta: dict) -> None:
    x0, y0, x1, y1 = crop
    m = mask_full[y0:y1, x0:x1]
    g = gray_full[y0:y1, x0:x1]
    tx0, ty0, tx1, ty1 = tight_bbox(m)  # 掩膜紧 bbox（块几何=内容几何）
    m = m[ty0:ty1, tx0:tx1]
    g = g[ty0:ty1, tx0:tx1]
    h, w = m.shape
    rec = {
        "family": family,
        "source": source,
        "sourceFile": IMGS[source],
        "cropRect": [x0 + int(tx0), y0 + int(ty0), x0 + int(tx1), y0 + int(ty1)],
        "w": int(w),
        "h": int(h),
        "maskB64": base64.b64encode(m.astype(np.uint8).tobytes()).decode(),
        "lumaB64": base64.b64encode(g.astype(np.uint8).tobytes()).decode(),
        "meta": {"ppm": round(PPM, 4), "maskPx": int(m.sum()), **meta},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{family}.json").write_text(json.dumps(rec))
    print(f"{family}: {w}x{h} maskPx={int(m.sum())} cov={m.mean():.2f} crop={rec['cropRect']}")


def main() -> None:
    # ---- texture-costume（2a0c 小丑服：褶皱亮度场+方向感）----
    im = load("2a0c")
    a = np.asarray(im).astype(float)
    gray = a.mean(2)
    mask = largest_cc(gray < 228)
    emit("texture-costume", "2a0c", im, (250, 420, 500, 650), mask, gray,
         {"rule": "gray<228 largest-CC", "note": "小丑服棕布褶皱——scatter 亮度加权/flow 方向场"})

    # ---- texture-sleigh（ebdc 水晶雪橇：亮暗晶面方向场）----
    im = load("ebdc")
    a = np.asarray(im).astype(float)
    gray = a.mean(2)
    mask = largest_cc(gray < 210)
    emit("texture-sleigh", "ebdc", im, (380, 430, 560, 560), mask, gray,
         {"rule": "gray<210 largest-CC", "note": "水晶雪橇晶面——flow 方向跟随（spike e-sleigh 同源区）"})

    # ---- softcurve-stems（5836 花茎：细弯条带——骨架分支）----
    im = load("5836")
    a = np.asarray(im).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    gray = a.mean(2)
    green = (g > r + 10) & (g > b + 10)
    dark_green = (g >= r - 2) & (g >= b - 2) & (gray < 150)  # 暗部绿线（茎痕）
    m = green | dark_green
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(3))) > 127
    m = drop_small_ccs(m, 30)
    emit("softcurve-stems", "5836", im, (335, 390, 455, 505), m, gray,
         {"rule": "green-dominant ∪ dark-green, median3, CC>=30px", "note": "花茎细弯条带群——Zhang-Suen 骨架分支"})

    # ---- flower-bloom（5836 雪滴花：瓣状复合体——极坐标分解）----
    # 洪水填充按裁片边界（全图边界被装饰框占据——从图边界发洪会全前景）
    crop = (186, 98, 244, 186)
    x0, y0, x1, y1 = crop
    m_crop = border_flood_not_bg(gray[y0:y1, x0:x1], 215)
    m_full = np.zeros_like(gray, dtype=bool)
    m_full[y0:y1, x0:x1] = m_crop
    m_full = largest_cc(m_full)
    emit("flower-bloom", "5836", im, crop, m_full, gray,
         {"rule": "crop-border-flood not-bg(tau=215) largest-CC", "note": "雪滴花头+茎+叶复合体——径向签名花瓣检测"})

    # ---- straightline-hat（f5c7 地精帽：三角刚硬面——PCA 主轴）----
    im = load("f5c7")
    a = np.asarray(im).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    gray = a.mean(2)
    subject = (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) > 25) | (gray < 190)
    subject = np.asarray(Image.fromarray((subject * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))) > 127
    subject = np.asarray(Image.fromarray((subject * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 127
    mask = largest_cc(subject)
    emit("straightline-hat", "f5c7", im, (50, 5, 150, 140), mask, gray,
         {"rule": "channel-range>25 | gray<190, close(3), largest-CC", "note": "地精帽三角——掩膜主轴平行线族"})


if __name__ == "__main__":
    main()
