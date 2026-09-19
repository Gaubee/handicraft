/*
Orthogonal intents (max 5):
1. [2026-09-18 Algorithm] 自实现图像算子：精确距离变换（Felzenszwalb 1D EDT×2）、4-连通域、Moore 边界追踪、环形最近点搜索（不引 opencv——tech-research §2.1：opencv.js 无 ximgproc，自实现 ~100 行/个）。
2. [2026-09-18 Index] SpatialIndex 均匀网格：validate / poisson / repulsion / 冲突消解共用的 O(n) 邻域查询。
*/

import type { Mask2D } from "./types";

// ---------- 精确欧氏距离变换（带 1px 背景边框：贴边的形状宽度不虚高） ----------

function edt1d(
  f: Float64Array,
  fOff: number,
  fStride: number,
  n: number,
  d: Float64Array,
  dOff: number,
  dStride: number,
): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const INF = 1e20;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[fOff + q * fStride] + q * q) - (f[fOff + v[k] * fStride] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[fOff + q * fStride] + q * q) - (f[fOff + v[k] * fStride] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[dOff + q * dStride] = (q - v[k]) * (q - v[k]) + f[fOff + v[k] * fStride];
  }
}

/**
 * 掩码内每像素到最近背景（含图像外侧虚拟背景）的欧氏距离，px。
 * 宽度统计约定：形状宽度 ≈ 2×dist（documented approximation，阈值判定用）。
 */
export function distanceTransform(mask: Mask2D): Float32Array {
  const { w, h } = mask;
  const W = w + 2;
  const H = h + 2;
  const INF = 1e20;
  const f = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inner = x >= 1 && y >= 1 && x <= w && y <= h && mask.bits[(y - 1) * w + (x - 1)] === 1;
      f[y * W + x] = inner ? INF : 0;
    }
  }
  // 行方向 1D EDT → 列方向 1D EDT = 精确 2D 平方距离
  const g = new Float64Array(W * H);
  for (let y = 0; y < H; y++) edt1d(f, y * W, 1, W, g, y * W, 1);
  const out2 = new Float64Array(W * H);
  for (let x = 0; x < W; x++) edt1d(g, x, W, H, out2, x, W);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = Math.sqrt(out2[(y + 1) * W + (x + 1)]);
    }
  }
  return out;
}

// ---------- 4-连通域 ----------

export interface Component {
  /** 掩码局部像素下标（y*w+x），光栅序 */
  indices: Int32Array;
}

export function connectedComponents(mask: Mask2D): Component[] {
  const { w, h, bits } = mask;
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const comps: Component[] = [];
  for (let start = 0; start < w * h; start++) {
    if (bits[start] !== 1 || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const indices: number[] = [];
    while (head < tail) {
      const p = queue[head++];
      indices.push(p);
      const px = p % w;
      const py = (p / w) | 0;
      // 4-邻域
      if (px > 0 && bits[p - 1] === 1 && !seen[p - 1]) (seen[p - 1] = 1), (queue[tail++] = p - 1);
      if (px < w - 1 && bits[p + 1] === 1 && !seen[p + 1]) (seen[p + 1] = 1), (queue[tail++] = p + 1);
      if (py > 0 && bits[p - w] === 1 && !seen[p - w]) (seen[p - w] = 1), (queue[tail++] = p - w);
      if (py < h - 1 && bits[p + w] === 1 && !seen[p + w]) (seen[p + w] = 1), (queue[tail++] = p + w);
    }
    comps.push({ indices: Int32Array.from(indices) });
  }
  return comps;
}

// ---------- Moore 边界追踪（8-连通，闭合外轮廓） ----------

/** 返回有序轮廓像素中心序列（首尾不重复，闭合环语义）。自交轮廓提前截断（已知限制，仅用于边界松弛与 SVG 描边） */
export function traceContour(mask: Mask2D): { x: number; y: number }[] {
  const { w, h, bits } = mask;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1;
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return [];
  // 方向表（顺时针，屏幕坐标 y 向下）：0=W 1=NW 2=N 3=NE 4=E 5=SE 6=S 7=SW
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DY = [0, -1, -1, -1, 0, 1, 1, 1];
  const contour: { x: number; y: number }[] = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  let dir = 0; // 初始回溯方向：西（光栅序起点的左邻必是背景）
  const maxSteps = 8 * w * h + 8;
  for (let step = 0; step < maxSteps; step++) {
    let found = -1;
    for (let i = 0; i < 8; i++) {
      const d = (dir + i) & 7;
      if (at(cx + DX[d], cy + DY[d])) {
        found = d;
        break;
      }
    }
    if (found < 0) break; // 孤立像素
    const nx = cx + DX[found];
    const ny = cy + DY[found];
    if (nx === sx && ny === sy) break; // 闭合
    contour.push({ x: nx, y: ny });
    cx = nx;
    cy = ny;
    dir = (found + 5) & 7; // 新回溯方向 = 指回旧点的方向再顺时针进一格
  }
  return contour;
}

// ---------- 最近合法点（环形扩张搜索，确定性） ----------

/**
 * 从 (x,y) 向外逐环搜索第一个满足 pred 的像素中心（Chebyshev 环，环内光栅序）。
 * 用于：element 质心入掩码 / CVT 站点回掩码 / 斥力越界回弹的兜底。
 */
export function ringSearchNearest(
  w: number,
  h: number,
  pred: (ix: number, iy: number) => boolean,
  x: number,
  y: number,
): { x: number; y: number } | undefined {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const maxR = Math.max(w, h) + 2;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const ix = cx + dx;
        const iy = cy + dy;
        if (ix >= 0 && iy >= 0 && ix < w && iy < h && pred(ix, iy)) {
          return { x: ix, y: iy };
        }
      }
    }
  }
  return undefined;
}

/** 掩码内最近点（局部坐标） */
export function snapToMask(mask: Mask2D, x: number, y: number): { x: number; y: number } | undefined {
  return ringSearchNearest(mask.w, mask.h, (ix, iy) => mask.bits[iy * mask.w + ix] === 1, x, y);
}

// ---------- 均匀网格空间索引 ----------

/**
 * cell 尺寸均匀网格（validate/validateEditable/resolveGreedy 用 cell=maxCellPx——tasks 1.1：
 * cell ≥ 文档内任意大小径对的所需距离 → 3×3 邻域检索不漏；等径文档 = pitch，v1 行为零变化；
 * layout 内部单规格路径（poisson/hybrid/cvt/relax）仍以各自基准间距为 cell——布局输入恒单 spec）。
 * query 返回 3×3 邻域 cell 内全部元素。
 * key 用 (cx+2^15)<<16 | (cy+2^15)，坐标 < 32768×cell 内无碰撞。
 */
export class SpatialIndex<T> {
  private readonly cell: number;
  private readonly map = new Map<number, T[]>();

  constructor(cell: number) {
    this.cell = Math.max(cell, 1e-9);
  }

  private static key(cx: number, cy: number): number {
    return (((cx + 32768) & 0xffff) << 16) | ((cy + 32768) & 0xffff);
  }

  insert(x: number, y: number, item: T): void {
    const k = SpatialIndex.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const arr = this.map.get(k);
    if (arr) arr.push(item);
    else this.map.set(k, [item]);
  }

  /** 3×3 邻域 cell 内元素（未按距离过滤，调用方自查距离） */
  query(x: number, y: number): T[] {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const out: T[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.map.get(SpatialIndex.key(cx + dx, cy + dy));
        if (arr) out.push(...arr);
      }
    }
    return out;
  }
}

// ---------- 小工具 ----------

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}
