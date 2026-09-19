/*
Orthogonal intents (max 2):
1. [2026-09-18 Strategy S3] poisson：Bridson 2007 变径 Poisson disk，r = r0 × d^(-1/2)，密度调制最小间距（tech-research §2.1：天然满足间距硬约束的 Decorative 散点模块）。
2. [2026-09-18 Determinism] 每块独立子种子 PRNG + 光栅序初始样本 + 固定尝试序列（k=30），同 seed 逐位重放。
*/

import { SpatialIndex } from "../ops";
import type { Block, Gem } from "../types";
import { enforceMinDistanceCounted, inBlockMask, makeGem, typeRankCompare, type StrategyOutput, type LayoutCtx } from "./common";

const ATTEMPTS = 30; // Bridson 经典常数

/** 单块 Bridson 变径采样（返回全局坐标点） */
export function poissonBlock(ctx: LayoutCtx, block: Block, blockIndex: number): { x: number; y: number }[] {
  const d = ctx.densities[blockIndex];
  const r = ctx.pitchPx / Math.sqrt(d);
  const rng = ctx.rngFor(blockIndex, 3);
  const { x: bx, y: by, w: bw, h: bh } = block.bbox;

  // 光栅序第一个掩码像素作为初始样本（确定性）
  let startIdx = -1;
  for (let i = 0; i < block.mask.bits.length; i++) {
    if (block.mask.bits[i] === 1) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return [];

  const xs: number[] = [];
  const ys: number[] = [];
  const push = (x: number, y: number): number => {
    xs.push(x);
    ys.push(y);
    return xs.length - 1;
  };
  const index = new SpatialIndex<number>(r);
  const insert = (i: number): void => index.insert(xs[i], ys[i], i);
  const ok = (x: number, y: number): boolean => {
    if (x < bx || y < by || x > bx + bw - 1 || y > by + bh - 1) return false;
    if (!inBlockMask(block, x, y)) return false;
    const near = index.query(x, y);
    for (const j of near) {
      const dx = xs[j] - x;
      const dy = ys[j] - y;
      if (dx * dx + dy * dy < r * r) return false;
    }
    return true;
  };

  push(bx + (startIdx % bw), by + Math.floor(startIdx / bw));
  insert(0);
  const active: number[] = [0];
  // 容量护栏：密排上限 2/(√3 r²) × 面积，防退化死循环
  const maxSamples = Math.ceil((bw * bh) / (r * r * 0.4)) + 64;

  while (active.length > 0 && xs.length < maxSamples) {
    const ai = Math.floor(rng() * active.length);
    const idx = active[ai];
    let placed = false;
    for (let t = 0; t < ATTEMPTS; t++) {
      const ang = rng() * Math.PI * 2;
      const rad = r * (1 + rng()); // 环带 [r, 2r]
      const x = xs[idx] + Math.cos(ang) * rad;
      const y = ys[idx] + Math.sin(ang) * rad;
      if (ok(x, y)) {
        const ni = push(x, y);
        insert(ni);
        active.push(ni);
        placed = true;
        break;
      }
    }
    if (!placed) active.splice(ai, 1);
  }

  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < xs.length; i++) pts.push({ x: xs[i], y: ys[i] });
  return pts;
}

export function poisson(ctx: LayoutCtx): StrategyOutput {
  const out: Gem[] = [];
  ctx.blocks.forEach((block, bi) => {
    for (const p of poissonBlock(ctx, block, bi)) {
      out.push(makeGem(block.id, p.x, p.y));
    }
  });
  // 块内 ≥ r ≥ pitch 恒真；跨块冲突确定性消解
  return enforceMinDistanceCounted(out, ctx.grid, typeRankCompare(ctx));
}
