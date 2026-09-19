/*
 * cvt 优化变体（/tmp/cvt-rd 研究代码，不进 src）。
 * 三条可组合路线，每条都以「逐语句等价变换」构造，用 JSON.stringify 全量快照做逐位验收：
 *  - gridPairs (A)  : repairSpacing.pairs() 的 Map+spread SpatialIndex → 定容两遍计数均匀网格
 *                     （cell 同为 pitch、同 3×3 扫描序 dy 外 dx 内、桶内按插入序 → pair 列表逐位同序）
 *  - pixelList (C1) : Lloyd 像素累加的全图双循环+labelMap 判跳 → 预计算掩码像素光栅序列表
 *                     （同一 (x,y,d) 序列、同一累加次序 → 浮点逐位不变）
 *  - densMap (C3)   : 逐像素密度查表（Float64 一次性预计算，消每像素 Int16→块索引→密度二级间接）
 *  - inlineFind (C2): d3-delaunay find/_step 的逐语句内联副本（单态化 typed 数组、
 *                     Math.pow(v,2)→v*v —— 已实测 V8 上逐位相等）
 */
import { Delaunay } from "d3-delaunay";
import { ringSearchNearest, SpatialIndex } from "/Users/kzf/Pictures/贴钻/rhinestone-studio/src/lib/engine/ops";
import type { Block, Gem } from "/Users/kzf/Pictures/贴钻/rhinestone-studio/src/lib/engine/types";
import {
  blockRect,
  enforceMinDistanceCounted,
  hexLattice,
  inBlockMask,
  labelAt,
  makeGem,
  typeRankCompare,
  type LayoutCtx,
} from "/Users/kzf/Pictures/贴钻/rhinestone-studio/src/lib/engine/layout/common";
import { applyRepulsionOpt } from "./relax-opt";

const MAX_ITER = 50;
const EARLY_STOP_FACTOR = 0.01;
const REPAIR_EVERY = 10;
const COUNT_SLACK = 0.92;

export interface CvtOptFlags {
  gridPairs: boolean;
  pixelList: boolean;
  densMap: boolean;
  inlineFind: boolean;
}

export const optStats = {
  pixelMs: 0,
  lloydRepairMs: 0,
  finalRepairMs: 0,
  repulsionMs: 0,
  totalMs: 0,
};
export function resetOptStats(): void {
  optStats.pixelMs = 0;
  optStats.lloydRepairMs = 0;
  optStats.finalRepairMs = 0;
  optStats.repulsionMs = 0;
  optStats.totalMs = 0;
}

// ---------- OPT-A: 定容两遍计数均匀网格（替代 Map 版 SpatialIndex，序完全保持） ----------

interface GridWs {
  counts: Int32Array;
  starts: Int32Array;
  cursor: Int32Array;
  items: Int32Array;
  cxs: Int32Array;
  cys: Int32Array;
  pairArr: Int32Array;
  pairLen: number;
}

/** 与 SpatialIndex 相同语义：cell 尺寸 cell、query 3×3、桶内插入序。违规对以扁平 [i,j,...] 缓冲返回（追加序 = 原元组列表序） */
function gridPairs(
  cur: number[],
  n: number,
  cell: number,
  threshold: number,
  ws: GridWs,
): void {
  const { cxs, cys } = ws;
  let minCx = 0x7fffffff;
  let maxCx = -0x7fffffff;
  let minCy = 0x7fffffff;
  let maxCy = -0x7fffffff;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(cur[i * 2] / cell);
    const cy = Math.floor(cur[i * 2 + 1] / cell);
    cxs[i] = cx;
    cys[i] = cy;
    if (cx < minCx) minCx = cx;
    if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
  }
  // 外扩 2 格余量（query 会访问 ±1，且空桶无害）
  const ox = minCx - 2;
  const oy = minCy - 2;
  const gw = maxCx - minCx + 5;
  const gh = maxCy - minCy + 5;
  const nCells = gw * gh;
  const counts = ws.counts.length >= nCells ? ws.counts : new Int32Array(nCells);
  counts.fill(0, 0, nCells);
  for (let i = 0; i < n; i++) counts[(cys[i] - oy) * gw + (cxs[i] - ox)]++;
  const starts = ws.starts.length >= nCells ? ws.starts : new Int32Array(nCells + 1);
  let acc = 0;
  for (let c = 0; c < nCells; c++) {
    starts[c] = acc;
    acc += counts[c];
  }
  starts[nCells] = acc;
  const cursor = ws.cursor.length >= nCells ? ws.cursor : new Int32Array(nCells);
  cursor.set(starts.subarray(0, nCells));
  const items = ws.items.length >= n ? ws.items : new Int32Array(n);
  for (let i = 0; i < n; i++) items[cursor[(cys[i] - oy) * gw + (cxs[i] - ox)]++] = i;

  const thr2 = threshold * threshold;
  let out = ws.pairArr;
  let len = 0;
  for (let i = 0; i < n; i++) {
    const xi = cur[i * 2];
    const yi = cur[i * 2 + 1];
    const cx = cxs[i] - ox;
    const cy = cys[i] - oy;
    for (let dy = -1; dy <= 1; dy++) {
      const ry = cy + dy;
      if (ry < 0 || ry >= gh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const rx = cx + dx;
        if (rx < 0 || rx >= gw) continue;
        const id = ry * gw + rx;
        for (let k = starts[id]; k < starts[id + 1]; k++) {
          const j = items[k];
          if (j <= i) continue;
          const ddx = cur[j * 2] - xi;
          const ddy = cur[j * 2 + 1] - yi;
          if (ddx * ddx + ddy * ddy < thr2) {
            if (len + 2 > out.length) {
              const grown = new Int32Array(out.length * 2);
              grown.set(out);
              out = grown;
            }
            out[len++] = i;
            out[len++] = j;
          }
        }
      }
    }
  }
  ws.pairArr = out;
  ws.pairLen = len;
}

// ---------- OPT-C2: d3-delaunay find/_step 逐语句内联副本 ----------

interface Finder {
  (x: number, y: number, i: number): number;
}

function makeFinder(del: Delaunay): Finder {
  const inedges = del.inedges;
  const hull = del.hull;
  const hullIndex = (del as unknown as { _hullIndex: Int32Array })._hullIndex;
  const halfedges = del.halfedges;
  const triangles = del.triangles;
  const points = del.points;
  const nPts = points.length >> 1;

  const step = (i: number, x: number, y: number): number => {
    if (inedges[i] === -1 || !points.length) return (i + 1) % nPts;
    let c = i;
    let dxi = x - points[i * 2];
    let dyi = y - points[i * 2 + 1];
    let dc = dxi * dxi + dyi * dyi;
    const e0 = inedges[i];
    let e = e0;
    do {
      const t = triangles[e];
      const dxt = x - points[t * 2];
      const dyt = y - points[t * 2 + 1];
      const dt = dxt * dxt + dyt * dyt;
      if (dt < dc) {
        dc = dt;
        c = t;
      }
      e = e % 3 === 2 ? e - 2 : e + 1;
      if (triangles[e] !== i) break;
      e = halfedges[e];
      if (e === -1) {
        e = hull[(hullIndex[i] + 1) % hull.length];
        if (e !== t) {
          const dxe = x - points[e * 2];
          const dye = y - points[e * 2 + 1];
          if (dxe * dxe + dye * dye < dc) return e;
        }
        break;
      }
    } while (e !== e0);
    return c;
  };

  return (x: number, y: number, i: number): number => {
    const i0 = i;
    let c;
    while ((c = step(i, x, y)) >= 0 && c !== i && c !== i0) i = c;
    return c;
  };
}

// ---------- 主体（与 src cvt.ts 逐语句一致，仅在 flagged 分支处替换等价实现） ----------

function latticeCapacity(block: Block, pitch: number): number {
  const pts = hexLattice(blockRect(block, Math.ceil(pitch)), pitch);
  let c = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (inBlockMask(block, pts[i], pts[i + 1])) c += 1;
  }
  return c;
}

function targetCount(ctx: LayoutCtx, bi: number): number {
  const cap = latticeCapacity(ctx.blocks[bi], ctx.pitchPx);
  return Math.floor(cap * ctx.densities[bi] * COUNT_SLACK + 0.5);
}

function seedSites(ctx: LayoutCtx, bi: number): number[] {
  const block = ctx.blocks[bi];
  const d = ctx.densities[bi];
  const n = targetCount(ctx, bi);
  if (n <= 0) return [];
  const sb = ctx.pitchPx / Math.sqrt(Math.max(d * COUNT_SLACK, 1e-9));
  const rng = ctx.rngFor(bi, 5);
  const pts: number[] = [];
  const occupied = new Set<number>();
  const push = (x: number, y: number): boolean => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (!inBlockMask(block, px, py)) return false;
    const key = py * ctx.W + px;
    if (occupied.has(key)) return false;
    occupied.add(key);
    pts.push(x, y);
    return true;
  };
  const lattice = hexLattice(blockRect(block, Math.ceil(sb)), sb);
  for (let i = 0; i < lattice.length && pts.length / 2 < n; i += 2) {
    push(lattice[i] + (rng() - 0.5) * 0.2, lattice[i + 1] + (rng() - 0.5) * 0.2);
  }
  if (pts.length / 2 < n) {
    const maskPixels: number[] = [];
    for (let i = 0; i < block.mask.bits.length; i++) {
      if (block.mask.bits[i] === 1) maskPixels.push(i);
    }
    let guard = n * 60;
    while (pts.length / 2 < n && guard-- > 0 && maskPixels.length > 0) {
      const idx = maskPixels[Math.floor(rng() * maskPixels.length) % maskPixels.length];
      push(
        block.bbox.x + (idx % block.bbox.w),
        block.bbox.y + Math.floor(idx / block.bbox.w),
      );
    }
  }
  return pts;
}

export function cvtOpt(ctx: LayoutCtx, flags: CvtOptFlags): { gems: Gem[]; dropped: number } {
  const T0 = performance.now();
  let sites: number[] = [];
  ctx.blocks.forEach((_, bi) => {
    sites.push(...seedSites(ctx, bi));
  });
  if (sites.length === 0) return { gems: [], dropped: 0 };
  const pitch = ctx.pitchPx;

  // OPT-C1/C3 预计算：掩码像素光栅序列表 + 坐标 + 逐像素密度（一次，Lloyd 各轮复用）
  let pxIdx = new Int32Array(0);
  let pxX = new Int32Array(0);
  let pxY = new Int32Array(0);
  let pxD = new Float64Array(0);
  if (flags.pixelList) {
    let count = 0;
    for (let p = 0; p < ctx.labelMap.length; p++) if (ctx.labelMap[p] >= 0) count++;
    pxIdx = new Int32Array(count);
    pxX = new Int32Array(count);
    pxY = new Int32Array(count);
    pxD = new Float64Array(count);
    let c = 0;
    for (let y = 0; y < ctx.H; y++) {
      for (let x = 0; x < ctx.W; x++) {
        const b = ctx.labelMap[y * ctx.W + x];
        if (b < 0) continue;
        pxIdx[c] = y * ctx.W + x;
        pxX[c] = x;
        pxY[c] = y;
        pxD[c] = ctx.densities[b];
        c++;
      }
    }
  }

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const n = sites.length / 2;
    const del = new Delaunay(Float64Array.from(sites));
    const w = new Float64Array(n);
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    const tPix = performance.now();
    if (flags.pixelList) {
      const count = pxIdx.length;
      if (flags.inlineFind) {
        const find = makeFinder(del);
        let hint = 0;
        for (let k = 0; k < count; k++) {
          const x = pxX[k];
          const y = pxY[k];
          const i = find(x, y, hint);
          hint = i;
          const d = pxD[k];
          w[i] += d;
          sx[i] += d * x;
          sy[i] += d * y;
        }
      } else {
        let hint = 0;
        for (let k = 0; k < count; k++) {
          const x = pxX[k];
          const y = pxY[k];
          const i = del.find(x, y, hint);
          hint = i;
          const d = pxD[k];
          w[i] += d;
          sx[i] += d * x;
          sy[i] += d * y;
        }
      }
    } else if (flags.inlineFind) {
      const find = makeFinder(del);
      let hint = 0;
      for (let y = 0; y < ctx.H; y++) {
        for (let x = 0; x < ctx.W; x++) {
          const b = ctx.labelMap[y * ctx.W + x];
          if (b < 0) continue;
          const i = find(x, y, hint);
          hint = i;
          w[i] += ctx.densities[b];
          sx[i] += ctx.densities[b] * x;
          sy[i] += ctx.densities[b] * y;
        }
      }
    } else {
      let hint = 0;
      for (let y = 0; y < ctx.H; y++) {
        for (let x = 0; x < ctx.W; x++) {
          const b = ctx.labelMap[y * ctx.W + x];
          if (b < 0) continue;
          const i = del.find(x, y, hint);
          hint = i;
          w[i] += ctx.densities[b];
          sx[i] += ctx.densities[b] * x;
          sy[i] += ctx.densities[b] * y;
        }
      }
    }
    optStats.pixelMs += performance.now() - tPix;
    const next: number[] = [];
    let maxDisp = 0;
    const seenPos = new Set<string>();
    const pixelTaken = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (w[i] <= 0) continue;
      const nx = sx[i] / w[i];
      const ny = sy[i] / w[i];
      const ox = sites[i * 2];
      const oy = sites[i * 2 + 1];
      const disp = Math.hypot(nx - ox, ny - oy);
      if (disp > maxDisp) maxDisp = disp;
      const inUnion = labelAt(ctx, nx, ny) >= 0;
      const key = `${nx},${ny}`;
      if (inUnion && !seenPos.has(key)) {
        seenPos.add(key);
        next.push(nx, ny);
        continue;
      }
      const s = ringSearchNearest(
        ctx.W,
        ctx.H,
        (ix, iy) => ctx.labelMap[iy * ctx.W + ix] >= 0 && !pixelTaken.has(iy * ctx.W + ix),
        nx,
        ny,
      );
      if (s) {
        pixelTaken.add(s.y * ctx.W + s.x);
        next.push(s.x, s.y);
      }
    }
    sites = next;
    if (sites.length === 0) return { gems: [], dropped: 0 };
    if (iter % REPAIR_EVERY === REPAIR_EVERY - 1) {
      const t = performance.now();
      sites = repairSpacing(ctx, sites, flags);
      optStats.lloydRepairMs += performance.now() - t;
      if (sites.length === 0) return { gems: [], dropped: 0 };
    }
    if (maxDisp < pitch * EARLY_STOP_FACTOR) break;
  }
  {
    const t = performance.now();
    sites = repairSpacing(ctx, sites, flags);
    optStats.finalRepairMs += performance.now() - t;
  }

  let out: Gem[] = [];
  for (let i = 0; i < sites.length; i += 2) {
    const b = labelAt(ctx, sites[i], sites[i + 1]);
    if (b >= 0) out.push(makeGem(ctx.blocks[b].id, sites[i], sites[i + 1]));
  }
  {
    const t = performance.now();
    out = applyRepulsionOpt(out, ctx, flags).gems;
    optStats.repulsionMs += performance.now() - t;
  }
  const r = enforceMinDistanceCounted(out, pitch, typeRankCompare(ctx));
  optStats.totalMs = performance.now() - T0;
  return r;
}

function repairSpacing(ctx: LayoutCtx, sites: number[], flags: CvtOptFlags): number[] {
  const pitch = ctx.pitchPx;
  const threshold = pitch * 0.999;
  const n = sites.length / 2;
  const cur = sites.slice();
  const inUnion = (x: number, y: number): boolean => labelAt(ctx, x, y) >= 0;

  let ws: GridWs | undefined;
  if (flags.gridPairs) {
    ws = {
      counts: new Int32Array(0),
      starts: new Int32Array(0),
      cursor: new Int32Array(0),
      items: new Int32Array(0),
      cxs: new Int32Array(n),
      cys: new Int32Array(n),
      pairArr: new Int32Array(1024),
      pairLen: 0,
    };
  }

  const pairs = (): Array<[number, number]> => {
    const index = new SpatialIndex<number>(pitch);
    for (let i = 0; i < n; i++) index.insert(cur[i * 2], cur[i * 2 + 1], i);
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      for (const j of index.query(cur[i * 2], cur[i * 2 + 1])) {
        if (j <= i) continue;
        const dx = cur[j * 2] - cur[i * 2];
        const dy = cur[j * 2 + 1] - cur[i * 2 + 1];
        if (dx * dx + dy * dy < threshold * threshold) out.push([i, j]);
      }
    }
    return out;
  };

  for (let iter = 0; iter < 250; iter++) {
    let ps: Array<[number, number]> | undefined;
    if (ws) {
      gridPairs(cur, n, pitch, threshold, ws);
      if (ws.pairLen === 0) break;
    } else {
      ps = pairs();
      if (ps.length === 0) break;
    }
    const psFlat = ws ? ws.pairArr : undefined;
    const psLen = ws ? ws.pairLen : 0;
    const pairsToVisit: Array<[number, number]> = ps ?? [];
    for (let pk = 0; pk < (ws ? psLen : pairsToVisit.length * 2); pk += 2) {
      const i = ws ? (psFlat as Int32Array)[pk] : pairsToVisit[pk / 2][0];
      const j = ws ? (psFlat as Int32Array)[pk + 1] : pairsToVisit[pk / 2][1];
      let dx = cur[j * 2] - cur[i * 2];
      let dy = cur[j * 2 + 1] - cur[i * 2 + 1];
      let d = Math.hypot(dx, dy);
      if (d < 1e-9) {
        dx = 1;
        dy = 0;
        d = 1e-9;
      }
      const push = (pitch - d) / 2;
      const ux = (dx / d) * push;
      const uy = (dy / d) * push;
      const ax = cur[i * 2] - ux;
      const ay = cur[i * 2 + 1] - uy;
      const bx = cur[j * 2] + ux;
      const by = cur[j * 2 + 1] + uy;
      const okA = inUnion(ax, ay);
      const okB = inUnion(bx, by);
      if (okA) {
        cur[i * 2] = ax;
        cur[i * 2 + 1] = ay;
      }
      if (okB) {
        cur[j * 2] = bx;
        cur[j * 2 + 1] = by;
      }
      if (okA !== okB) {
        if (okB) {
          const bx2 = cur[j * 2] + ux;
          const by2 = cur[j * 2 + 1] + uy;
          if (inUnion(bx2, by2)) {
            cur[j * 2] = bx2;
            cur[j * 2 + 1] = by2;
          }
        } else {
          const ax2 = cur[i * 2] - ux;
          const ay2 = cur[i * 2 + 1] - uy;
          if (inUnion(ax2, ay2)) {
            cur[i * 2] = ax2;
            cur[i * 2 + 1] = ay2;
          }
        }
      }
    }
  }
  return cur;
}
