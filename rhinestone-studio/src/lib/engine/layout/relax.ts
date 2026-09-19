/*
Orthogonal intents (max 4):
1. [2026-09-18 Relax-Boundary] 边界 1D Lloyd：最外圈钻投影到块边界曲线，沿闭合弧长均匀重排（迭代 ≤30，max 位移 < 0.5px 早停）——修复冻结晶格在弯曲边界的锯齿（design.md §3 松弛钩子）。
2. [2026-09-18 Relax-Repulsion] Verlet 式斥力修复：违规对互推（单轮 ≤ pitch），越块掩码即回滚该步（迭代 ≤50）；修不掉的残留留给 validate 报 spacing warning 并阻断导出。
3. [2026-09-18 Determinism] 全流程块序/光栅序固定，同输入逐位重放。
*/

import { dist, distanceTransform, traceContour } from "../ops";
import type { Block, Gem } from "../types";
import { inBlockMask, labelAt, type LayoutCtx } from "./common";

const BOUNDARY_MAX_ITER = 30;
const BOUNDARY_EPS_PX = 0.5;
const REPULSION_MAX_ITER = 50;

interface BlockGeom {
  contour: { x: number; y: number }[];
  cum: number[]; // 轮廓像素累计弧长（闭合：L = cum[n-1] + 闭边）
  arcLen: number;
  dt: Float32Array;
}

function blockGeom(block: Block): BlockGeom | undefined {
  const contour = traceContour(block.mask);
  if (contour.length === 0) return undefined;
  const cum: number[] = [0];
  for (let i = 1; i < contour.length; i++) {
    cum.push(cum[i - 1] + dist(contour[i - 1].x, contour[i - 1].y, contour[i].x, contour[i].y));
  }
  const arcLen =
    cum[cum.length - 1] +
    dist(
      contour[contour.length - 1].x,
      contour[contour.length - 1].y,
      contour[0].x,
      contour[0].y,
    );
  return { contour, cum, arcLen, dt: distanceTransform(block.mask) };
}

/** 弧长 → 轮廓插值点（闭合环） */
function pointAtArc(g: BlockGeom, s: number): { x: number; y: number } {
  const { contour, cum, arcLen } = g;
  const n = contour.length;
  let u = s;
  while (u < 0) u += arcLen;
  while (u >= arcLen) u -= arcLen;
  // 线性扫描（迭代次数少、环长有限；如需优化再换二分）
  for (let i = 1; i < n; i++) {
    if (u <= cum[i]) {
      const t = (u - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return {
        x: contour[i - 1].x + (contour[i].x - contour[i - 1].x) * t,
        y: contour[i - 1].y + (contour[i].y - contour[i - 1].y) * t,
      };
    }
  }
  // 闭边（最后一点 → 起点）
  const t = (u - cum[n - 1]) / (arcLen - cum[n - 1] || 1);
  return {
    x: contour[n - 1].x + (contour[0].x - contour[n - 1].x) * t,
    y: contour[n - 1].y + (contour[0].y - contour[n - 1].y) * t,
  };
}

/**
 * boundary 钩子：每块 DT ≤ pitch/2 的钻判定为最外圈 → 投影到边界弧长 → 均匀 1D 重排。
 * 周长不足以等距容纳边界钻（L/K < pitch）时跳过该块（留给 repulsion/validate）。
 * 返回新数组（仅被移动的钻生成新对象，保持其余引用稳定）。
 */
export function applyBoundary(gems: Gem[], ctx: LayoutCtx): Gem[] {
  const geoms = new Map<string, BlockGeom>();
  const byBlock = new Map<string, number[]>(); // blockId -> gem 下标
  gems.forEach((g, i) => {
    const arr = byBlock.get(g.blockId);
    if (arr) arr.push(i);
    else byBlock.set(g.blockId, [i]);
  });
  const result = [...gems];
  const pitch = ctx.pitchPx;

  for (const [blockId, idxs] of byBlock) {
    const block = ctx.blocks.find((b) => b.id === blockId);
    if (!block) continue;
    let geom = geoms.get(blockId);
    if (!geom) {
      geom = blockGeom(block);
      if (!geom) continue;
      geoms.set(blockId, geom);
    }
    const { dt, arcLen } = geom;
    // 最外圈：钻心到边界的距离 ≤ pitch/2
    const ring = idxs.filter((i) => {
      const ix = Math.round(gems[i].x) - block.bbox.x;
      const iy = Math.round(gems[i].y) - block.bbox.y;
      return dt[iy * block.bbox.w + ix] <= pitch / 2;
    });
    if (ring.length < 3) continue;
    if (arcLen / ring.length < pitch * 0.999) continue; // 装不下 → 跳过该块

    // 投影到最近轮廓像素 → 弧长坐标
    const arcs = ring.map((i) => {
      const g = gems[i];
      let best = 0;
      let bestD = Infinity;
      geom!.contour.forEach((p, ci) => {
        const dd = (p.x + block.bbox.x - g.x) ** 2 + (p.y + block.bbox.y - g.y) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = ci;
        }
      });
      return { idx: i, s: geom!.cum[best] };
    });
    arcs.sort((a, b) => a.s - b.s);

    // 1D Lloyd：保序均匀化（origin = 首钻弧位，避免环回跳变）
    const K = arcs.length;
    const step = arcLen / K;
    const origin = arcs[0].s;
    for (let iter = 0; iter < BOUNDARY_MAX_ITER; iter++) {
      let maxMove = 0;
      for (let j = 0; j < K; j++) {
        const target = ((origin + (j + 0.5) * step) % arcLen + arcLen) % arcLen;
        const p = pointAtArc(geom!, target);
        const gx = block.bbox.x + p.x;
        const gy = block.bbox.y + p.y;
        const old = result[arcs[j].idx];
        // 掩码内钳制：凹轮廓的线性插值点可能落在掩码外（对角轮廓步的中点），
        // 出掩码点回退原钻位（isExportable 已把 mask 违规列为导出阻断）
        if (!inBlockMask(block, gx, gy)) continue;
        maxMove = Math.max(maxMove, dist(old.x, old.y, gx, gy));
        result[arcs[j].idx] = { ...old, x: gx, y: gy };
      }
      if (maxMove < BOUNDARY_EPS_PX) break;
    }
  }
  return result;
}

export interface RepulsionResult {
  gems: Gem[];
  /** 收敛后仍违规的对（residual → validate spacing warning） */
  residual: [Gem, Gem][];
}

/**
 * repulsion 钩子：违规对（< pitch×0.999）互推至整 pitch（Gauss-Seidel 顺序解算，快收敛）；
 * 推出所属块掩码则该侧不动（保数不保净），≤50 轮；修不掉的残留返回（layout 终局消解兜底）。
 */
export function applyRepulsion(gems: Gem[], ctx: LayoutCtx): RepulsionResult {
  const pitch = ctx.pitchPx;
  const threshold = pitch * 0.999;
  const blockIndexById = new Map(ctx.blocks.map((b, i) => [b.id, i] as const));
  const current: Gem[] = gems.map((g) => ({ ...g }));
  const n = current.length;

  // 同序定容网格工作区（gem-catalog 1.5：跨 ≤50 轮复用）
  let cxs = new Int32Array(n);
  let cys = new Int32Array(n);
  let counts = new Int32Array(0);
  let starts = new Int32Array(0);
  let cursor = new Int32Array(0);
  let items = new Int32Array(0);

  const canOccupy = (gem: Gem, nx: number, ny: number): boolean => {
    const bi = blockIndexById.get(gem.blockId);
    return bi !== undefined && labelAt(ctx, nx, ny) === bi;
  };
  const tryMove = (i: number, dx: number, dy: number): boolean => {
    const g = current[i];
    const nx = g.x + dx;
    const ny = g.y + dy;
    if (dx === 0 && dy === 0) return true;
    if (!canOccupy(g, nx, ny)) return false; // 掩码投影回弹：越界回滚该侧
    current[i] = { ...g, x: nx, y: ny };
    return true;
  };

  /**
   * [gem-catalog 1.5 / CVT 优化路线 a] 违规对收集：Map 版 SpatialIndex → 同序定容网格
   * （两遍计数；cell 同为 pitch、3×3 同扫描序、桶内同插入序 → pair 列表同序 → 斥力解算
   * 顺序不变，输出逐位不变；研究负结果路线均不采——见 cvt.ts repairSpacing 头注）。
   */
  const violatingPairs = (): [number, number][] => {
    let minCx = 0x7fffffff;
    let maxCx = -0x7fffffff;
    let minCy = 0x7fffffff;
    let maxCy = -0x7fffffff;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(current[i].x / pitch);
      const cy = Math.floor(current[i].y / pitch);
      cxs[i] = cx;
      cys[i] = cy;
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;
    }
    const ox = minCx - 2;
    const oy = minCy - 2;
    const gw = maxCx - minCx + 5;
    const gh = maxCy - minCy + 5;
    const nCells = gw * gh;
    if (counts.length < nCells) counts = new Int32Array(nCells);
    counts.fill(0, 0, nCells);
    for (let i = 0; i < n; i++) counts[(cys[i] - oy) * gw + (cxs[i] - ox)]++;
    if (starts.length < nCells + 1) starts = new Int32Array(nCells + 1);
    let acc = 0;
    for (let c = 0; c < nCells; c++) {
      starts[c] = acc;
      acc += counts[c];
    }
    starts[nCells] = acc;
    if (cursor.length < nCells) cursor = new Int32Array(nCells);
    cursor.set(starts.subarray(0, nCells));
    if (items.length < n) items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[cursor[(cys[i] - oy) * gw + (cxs[i] - ox)]++] = i;

    const thr2 = threshold * threshold;
    const pairs: [number, number][] = [];
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const xi = current[i].x;
      const yi = current[i].y;
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
            const ddx = current[j].x - xi;
            const ddy = current[j].y - yi;
            if (ddx * ddx + ddy * ddy >= thr2) continue;
            const key = i * n + j;
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push(i < j ? [i, j] : [j, i]);
          }
        }
      }
    }
    return pairs;
  };

  for (let iter = 0; iter < REPULSION_MAX_ITER; iter++) {
    const pairs = violatingPairs();
    if (pairs.length === 0) {
      return { gems: current, residual: [] };
    }
    for (const [i, j] of pairs) {
      const a = current[i];
      const b = current[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d < 1e-9) {
        dx = 1; // 重合点：确定性默认方向
        dy = 0;
        d = 1e-9;
      }
      if (d >= threshold) continue; // 前序修复已解
      const push = (pitch - d) / 2; // 目标整 pitch（留出 0.001 容差余量）
      const ux = (dx / d) * push;
      const uy = (dy / d) * push;
      const okA = tryMove(i, -ux, -uy);
      const okB = tryMove(j, ux, uy);
      if (okA !== okB) {
        // 单侧被掩码锁死：可动侧补推另一半
        if (okB) tryMove(j, ux, uy);
        else tryMove(i, -ux, -uy);
      }
    }
  }
  const residualPairs = violatingPairs();
  return { gems: current, residual: residualPairs.map(([i, j]) => [current[i], current[j]]) };
}
