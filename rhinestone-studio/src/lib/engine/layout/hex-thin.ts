/*
Orthogonal intents (max 2):
1. [2026-09-18 Strategy S1] hex-thin：全局冻结六方晶格（基准 pitch，与密度无关）+ RIPD 思想相干噪声抽稀，density = 保留概率（design.md §3 裁决表）。
2. [2026-09-18 Monotonic] keep ⟺ valueNoise(p) < d：阈值单调 → 低密度点集嵌套于高密度 → 钻数单调不减（不变量 4）。
*/

import { valueNoise } from "../rng";
import type { Gem } from "../types";
import { enforceMinDistanceCounted, hexLattice, labelAt, makeGem, typeRankCompare, type StrategyOutput, type LayoutCtx } from "./common";

export function hexThin(ctx: LayoutCtx): StrategyOutput {
  const pitch = ctx.pitchPx;
  const pts = hexLattice(ctx.unionRect, pitch);
  const noiseCell = pitch * 2.5; // 抽稀噪声晶格：几倍 pitch，聚簇保留/剔除的蓝噪声观感
  const out: Gem[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    const b = labelAt(ctx, x, y);
    if (b < 0) continue;
    // 全局噪声（块无关）：跨块抽稀图案连续；阈值取该块密度
    if (valueNoise(x, y, noiseCell, ctx.seed) < ctx.densities[b]) {
      out.push(makeGem(ctx.blocks[b].id, x, y));
    }
  }
  // 同一晶格内的点两两 ≥ pitch，跨块亦然；enforce 为统一防线（实际零丢弃）
  return enforceMinDistanceCounted(out, ctx.grid, typeRankCompare(ctx));
}
