/*
Orthogonal intents (max 5):
1. [2026-09-18 Segmentation] 数字油画 → Block[]：sRGB→Lab、k-means(k=6..10) 量化、逐色掩码、4-连通域、块属性（面积/bbox/中位色/距离变换宽度）与类型推断（原始需求：design.md §2 + tasks 2.1）。
2. [2026-09-18 Determinism] 固定 seed 的 k-means++ 初始化 + 光栅序全流程，同输入同输出。
3. [2026-09-18 Robustness] 微小聚类（<0.2% 像素）并入最近主色、小面积连通域（<minAreaPx）丢弃，抑制照片噪点。
*/

import { labFromRgb, rgbFromLab, type Lab } from "./color";
import { connectedComponents, distanceTransform } from "./ops";
import { mulberry32 } from "./rng";
import type { Block, BlockType, BBox, EngineImage, Mask2D, SegmentOptions } from "./types";
import { SegmentOptionsSchema } from "./types";

// ---------- Lab 缓存（按 24bit RGB，量化图/合成图颜色数有限） ----------

class LabCache {
  private readonly map = new Map<number, Lab>();

  get(r: number, g: number, b: number): Lab {
    const key = (r << 16) | (g << 8) | b;
    let lab = this.map.get(key);
    if (!lab) {
      lab = labFromRgb(r, g, b);
      this.map.set(key, lab);
    }
    return lab;
  }
}

function sqLabDist(a: Lab, b: Lab): number {
  const dl = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

// ---------- k-means（Lab 空间，k-means++ 种子） ----------

function kmeansPlusPlus(samples: Lab[], k: number, rng: () => number): Lab[] {
  const n = samples.length;
  const centroids: Lab[] = [samples[Math.floor(rng() * n) % n]];
  const d2 = new Float64Array(n);
  for (let q = 0; q < n; q++) d2[q] = sqLabDist(samples[q], centroids[0]);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let q = 0; q < n; q++) sum += d2[q];
    let pick = n - 1;
    if (sum > 0) {
      const r = rng() * sum;
      let acc = 0;
      for (let q = 0; q < n; q++) {
        acc += d2[q];
        if (acc >= r) {
          pick = q;
          break;
        }
      }
    }
    centroids.push(samples[pick]);
    for (let q = 0; q < n; q++) {
      const nd = sqLabDist(samples[q], centroids[c]);
      if (nd < d2[q]) d2[q] = nd;
    }
  }
  return centroids;
}

/** Lloyd 迭代；空簇自然消亡（有效色数 < k 时收敛到实际色数） */
function lloyd(samples: Lab[], init: Lab[], maxIter: number): Lab[] {
  let centroids = init;
  let prevAssign: Int32Array | undefined;
  for (let iter = 0; iter < maxIter; iter++) {
    const assign = new Int32Array(samples.length);
    for (let q = 0; q < samples.length; q++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqLabDist(samples[q], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[q] = best;
    }
    if (prevAssign && arrayEq(assign, prevAssign)) break;
    prevAssign = assign;
    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (let q = 0; q < samples.length; q++) {
      const s = sums[assign[q]];
      s.L += samples[q].L;
      s.a += samples[q].a;
      s.b += samples[q].b;
      s.n++;
    }
    centroids = sums
      .filter((s) => s.n > 0)
      .map((s) => ({ L: s.L / s.n, a: s.a / s.n, b: s.b / s.n }));
  }
  return centroids;
}

function arrayEq(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- 中位色（Lab 逐通道中位 → sRGB） ----------

function medianColor(pixels: Lab[]): [number, number, number] {
  const Ls = pixels.map((p) => p.L).sort((x, y) => x - y);
  const as = pixels.map((p) => p.a).sort((x, y) => x - y);
  const bs = pixels.map((p) => p.b).sort((x, y) => x - y);
  const mid = Ls.length >> 1;
  const med = (arr: number[]) => (arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2);
  const [r, g, b] = rgbFromLab({ L: med(Ls), a: med(as), b: med(bs) });
  return [r, g, b];
}

// ---------- 主入口 ----------

/**
 * 分块：Lab 空间 k-means 量化 → 逐色掩码 4-连通域 → Block 列表（光栅序确定性）。
 * 类型推断：面积 < 单钻足迹(πr²) → element；宽度 < 3 钻径 → linear；否则 fill（用户可覆写 suggested）。
 */
export function segment(image: EngineImage, opts: SegmentOptions): Block[] {
  const o = SegmentOptionsSchema.parse(opts);
  const { width: w, height: h, data } = image;
  if (data.length !== w * h * 4) {
    throw new Error(`segment: data 长度 ${data.length} ≠ width*height*4 = ${w * h * 4}`);
  }
  const total = w * h;
  const cache = new LabCache();
  const labs: Lab[] = new Array(total);
  for (let p = 0; p < total; p++) {
    labs[p] = cache.get(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
  }

  // 采样做 k-means（确定性步进，≤16384 样本足够收敛）
  const stride = Math.max(1, Math.floor(total / 16384));
  const samples: Lab[] = [];
  for (let p = 0; p < total; p += stride) samples.push(labs[p]);
  const rng = mulberry32(o.seed);
  const init = kmeansPlusPlus(samples, o.k, rng);
  let centroids = lloyd(samples, init, 30);

  // 全像素分配
  let labels = new Int16Array(total);
  const assignAll = (): void => {
    for (let p = 0; p < total; p++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqLabDist(labs[p], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      labels[p] = best;
    }
  };
  assignAll();

  // 微小聚类并入最近主色（照片噪点抑制，迭代至无微簇）
  const minCluster = Math.max(3, Math.floor(total * 0.002));
  for (let guard = 0; guard < o.k; guard++) {
    const counts = new Int32Array(centroids.length);
    for (let p = 0; p < total; p++) counts[labels[p]]++;
    const keep: boolean[] = [];
    for (let i = 0; i < centroids.length; i++) keep.push(counts[i] >= minCluster);
    if (keep.every(Boolean)) break;
    centroids = centroids.filter((_, i) => keep[i]);
    if (centroids.length === 0) return [];
    assignAll();
  }

  // 逐色连通域 → 块
  const blocks: Block[] = [];
  const elementAreaPx = Math.max(o.minAreaPx + 1, Math.ceil(Math.PI * (o.gemDiameterPx / 2) ** 2));
  const linearWidthPx = 3 * o.gemDiameterPx;
  for (let c = 0; c < centroids.length; c++) {
    const bits = new Uint8Array(total);
    for (let p = 0; p < total; p++) bits[p] = labels[p] === c ? 1 : 0;
    const comps = connectedComponents({ w, h, bits });
    let compIdx = 0;
    for (const comp of comps) {
      if (comp.indices.length < o.minAreaPx) continue;
      // bbox
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (const idx of comp.indices) {
        const x = idx % w;
        const y = (idx / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const bbox: BBox = { x: minX, y: minY, w: bw, h: bh };
      const mask: Mask2D = { w: bw, h: bh, bits: new Uint8Array(bw * bh) };
      const memberLabs: Lab[] = [];
      for (const idx of comp.indices) {
        const x = idx % w;
        const y = (idx / w) | 0;
        mask.bits[(y - minY) * bw + (x - minX)] = 1;
        memberLabs.push(labs[idx]);
      }
      const dt = distanceTransform(mask);
      let dtMax = 0;
      let dtSum = 0;
      for (const idx of comp.indices) {
        const x = idx % w;
        const y = Math.floor(idx / w);
        const d = dt[(y - minY) * bw + (x - minX)];
        if (d > dtMax) dtMax = d;
        dtSum += d;
      }
      const widthMean = Math.round(((2 * dtSum) / comp.indices.length) * 100) / 100;
      const widthMax = Math.round(2 * dtMax * 100) / 100;
      const areaPx = comp.indices.length;
      const colorRgb = medianColor(memberLabs);
      const suggested: BlockType =
        areaPx < elementAreaPx ? "element" : widthMax < linearWidthPx ? "linear" : "fill";
      const hex = `#${colorRgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      blocks.push({
        id: `b${c}-${compIdx}`,
        label: `#${blocks.length} ${hex}`,
        mask,
        colorRgb,
        areaPx,
        bbox,
        widthPx: { max: widthMax, mean: widthMean },
        suggested,
      });
      compIdx++;
    }
  }
  return blocks;
}
