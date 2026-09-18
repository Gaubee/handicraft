/*
Orthogonal intents (max 2):
1. [2026-09-18 Strategy S2] hex-pitch：pitch = pitch0 × d^(-1/2) 重建全局锚定晶格，密度调制间距（design.md §3）。
2. [2026-09-18 Alignment] 同密度相邻块共用同一晶格（锚 (0,0)）→ 行向对齐且零跨块冲突；异密度边界冲突交给 enforceMinDistance。
*/

import type { Block, Gem } from "../types";
import { blockRect, enforceMinDistanceCounted, hexLattice, inBlockMask, makeGem, typeRankCompare, type StrategyOutput, type LayoutCtx } from "./common";

/** 单块 hex 填充（hybrid 的 fill 分支复用） */
export function hexFillBlock(ctx: LayoutCtx, block: Block, blockIndex: number): Gem[] {
  const d = ctx.densities[blockIndex];
  const pb = ctx.pitchPx / Math.sqrt(d); // d=1 → 基准 pitch；d<1 → 间距放大
  const pts = hexLattice(blockRect(block, Math.ceil(pb)), pb);
  const out: Gem[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (inBlockMask(block, x, y)) out.push(makeGem(block.id, x, y));
  }
  return out;
}

export function hexPitch(ctx: LayoutCtx): StrategyOutput {
  const out: Gem[] = [];
  ctx.blocks.forEach((block, bi) => {
    out.push(...hexFillBlock(ctx, block, bi));
  });
  return enforceMinDistanceCounted(out, ctx.pitchPx, typeRankCompare(ctx));
}
