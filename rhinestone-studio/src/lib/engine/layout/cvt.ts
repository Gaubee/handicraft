/*
Orthogonal intents (max 3):
1. [2026-09-18 Strategy S5] cvt：密度场加权 Voronoi 点画（Secord 2002 谱系）——块密度构成标量场 ρ(x,y) ∝ d，d3-delaunay Voronoi + 像素累加密度加权 Lloyd，唯一非阶跃的密度语义（design.md §3）。
2. [2026-09-18 Convergence] 上限 50 轮，max 位移 < pitch×0.01 早停；站点零质量（跑出掩码并集）即淘汰。
3. [2026-09-18 Monotonic] 每块站点数 N_b = round(六方满容量×d×松弛系数)——容量基准 = 全局冻结晶格落掩码点数（与 hex-pitch 同基准），N(d) 对 d 解析单调，站点经投影恒在掩码内 → 块钻数单调。
*/

import { Delaunay } from "d3-delaunay";
import { ringSearchNearest, SpatialIndex } from "../ops";
import type { Block, Gem } from "../types";
import { blockRect, enforceMinDistanceCounted, hexLattice, inBlockMask, labelAt, makeGem, typeRankCompare, type StrategyOutput, type LayoutCtx } from "./common";
import { applyRepulsion } from "./relax";

const MAX_ITER = 50;
const EARLY_STOP_FACTOR = 0.01; // × pitch
/** 每多少轮 Lloyd 做一次间距修复（终局必修复） */
const REPAIR_EVERY = 10;

/**
 * 目标计数松弛系数：N_b = 满容量_b × d × f。
 * 满容量 = 全局冻结晶格（基准 pitch）落块掩码的点数——与 hex-pitch 的产出同基准
 * （area/(p²·√3/2) 会低估 3~4%：边界晶格点的 Voronoi 胞元半悬于区域外）。
 * f=1（满容量）时 Lloyd 收敛点集饱和：质心位移的边界行压缩累积成近阈值残对
 * （间距 ∈ [pitch−ε, pitch×0.999)），点集无全局扩张自由度，修复推不动，
 * enforceMinDistance 成批删站（实测满密度丢 ~48%，评审 B1）。
 * f=0.92 → 站点目标间距 ≈ pitch/√0.92 ≈ 1.043×pitch，为周期性间距修复
 * （repairSpacing）留出推挤余量，消解归零；同时保住满密度产出 ≥ hex-pitch 的
 * 90%（验收见 cvt-density.test.ts）。取区间上端 0.92：在修复可兜底的前提下产量最大。
 */
const COUNT_SLACK = 0.92;

/** 块的六方满容量：全局冻结晶格（锚 (0,0)，基准 pitch）落入掩码的点数 */
function latticeCapacity(block: Block, pitch: number): number {
  const pts = hexLattice(blockRect(block, Math.ceil(pitch)), pitch);
  let c = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (inBlockMask(block, pts[i], pts[i + 1])) c += 1;
  }
  return c;
}

/** 每块目标站点数：容量基准在 d=1 一次测得，d 解析缩放（floor(x+0.5) 对 d 单调） */
function targetCount(ctx: LayoutCtx, bi: number): number {
  const cap = latticeCapacity(ctx.blocks[bi], ctx.pitchPx);
  return Math.floor(cap * ctx.densities[bi] * COUNT_SLACK + 0.5);
}

/** 六方种子：目标密度匹配的冻结晶格族（锚 (0,0)，间距 pitch/√(d·f)）光栅序取前 N，不足用块内随机像素补齐；按占用像素去重（同像素双站点 = 零质量死亡） */
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
  // 不足则从掩码像素随机补（确定性：预生成随机序列后逐个尝试）
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

export function cvt(ctx: LayoutCtx): StrategyOutput {
  // 种子
  let sites: number[] = [];
  ctx.blocks.forEach((_, bi) => {
    sites.push(...seedSites(ctx, bi));
  });
  if (sites.length === 0) return { gems: [], dropped: 0 };
  const pitch = ctx.pitchPx;

  // Lloyd 主循环
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const n = sites.length / 2;
    const del = new Delaunay(Float64Array.from(sites));
    const w = new Float64Array(n);
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    // 像素累加：每像素归属最近站点，权重 = 所属块密度（掩码外 ρ=0 不累加）
    // find 的 hint 参数（上一像素的站点）把逐像素 walk 剪枝成近邻步进
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
    const next: number[] = [];
    let maxDisp = 0;
    // 位置去重：完全重合的站点 → 后到者零质量死亡。质心保持连续坐标（免像素抖动），
    // 只有出掩码回拉/重合避让才落像素中心（此时用占用集）
    const seenPos = new Set<string>();
    const pixelTaken = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (w[i] <= 0) continue; // 零质量站点淘汰（唯一性保障下应为空集）
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
      // 重合避让 / 凹胞元质心出并集：环形找最近空闲并集像素
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
      // 找不到空闲并集像素（掩码满占）→ 站点淘汰
    }
    sites = next;
    if (sites.length === 0) return { gems: [], dropped: 0 };
    // 可行性维持（F1 关键）：质心位移累积数轮后把 < pitch 的对推回 ≥ pitch（并集内）。
    // 收敛态 CVT 的边界行压缩若累积到终局才修复，点集已饱和（无全局扩张自由度），
    // 斥力解不动、enforceMinDistance 成批删站；周期性维持则压缩永不达到饱和。
    if (iter % REPAIR_EVERY === REPAIR_EVERY - 1) {
      sites = repairSpacing(ctx, sites);
      if (sites.length === 0) return { gems: [], dropped: 0 };
    }
    if (maxDisp < pitch * EARLY_STOP_FACTOR) break;
  }
  sites = repairSpacing(ctx, sites);

  let out: Gem[] = [];
  for (let i = 0; i < sites.length; i += 2) {
    const b = labelAt(ctx, sites[i], sites[i + 1]);
    if (b >= 0) out.push(makeGem(ctx.blocks[b].id, sites[i], sites[i + 1]));
  }
  // 终局连续修复（保数）+ 确定性消解兜底（逐轮维持后残余应近零）
  out = applyRepulsion(out, ctx).gems;
  return enforceMinDistanceCounted(out, pitch, typeRankCompare(ctx));
}

/** 站点坐标数组 → 并集内斥力修复（< pitch 对互推至 pitch，出掩码并集回弹），保数返回修复后坐标 */
function repairSpacing(ctx: LayoutCtx, sites: number[]): number[] {
  const pitch = ctx.pitchPx;
  const threshold = pitch * 0.999;
  const n = sites.length / 2;
  const cur = sites.slice();
  const inUnion = (x: number, y: number): boolean => labelAt(ctx, x, y) >= 0;

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
    const ps = pairs();
    if (ps.length === 0) break;
    for (const [i, j] of ps) {
      let dx = cur[j * 2] - cur[i * 2];
      let dy = cur[j * 2 + 1] - cur[i * 2 + 1];
      let d = Math.hypot(dx, dy);
      if (d < 1e-9) {
        dx = 1; // 重合点：确定性默认方向
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
        // 单侧被并集锁死：可动侧补推另一半
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
