/*
Orthogonal intents (max 3):
1. [2026-09-18 Strategy S4] hybrid：按块建议类型分派——fill → hexFill（hex-pitch 复用）；linear → Zhang-Suen 骨架 → 链化 → 等弧长(pitch×d^-1/2)取点；element → 质心单点（design.md §3，宽度阈值分支来自实证）。
2. [2026-09-18 Dispatch] ts-pattern 对 suggested 做穷尽分派（类型安全 = 无遗漏分支）。
3. [2026-09-18 Invariant] 链交汇处/链与填充边界的近点由块内 + 全局两级确定性消解兜底。
*/

import { match } from "ts-pattern";
import { snapToMask } from "../ops";
import type { Block, Gem } from "../types";
import { enforceMinDistanceCounted, inBlockMask, makeGem, typeRankCompare, type StrategyOutput, type LayoutCtx } from "./common";
import { hexFillBlock } from "./hex-pitch";
import { skeletonChains, skeletonize, type Pt } from "./skeleton";

/** 等弧长重采样：弧长 0, s, 2s…；尾段剩余 ≥ 0.6s 补链尾点（短链保端点不丢） */
export function resampleChain(chain: Pt[], s: number): Pt[] {
  if (chain.length === 0) return [];
  if (chain.length === 1) return [chain[0]];
  const out: Pt[] = [chain[0]];
  let cum = 0;
  let target = s;
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1];
    const b = chain[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const seg = Math.sqrt(dx * dx + dy * dy);
    if (seg === 0) continue;
    while (cum + seg >= target) {
      const t = (target - cum) / seg;
      out.push(lerp(a, b, t));
      target += s;
    }
    cum += seg;
  }
  const last = chain[chain.length - 1];
  const lastOut = out[out.length - 1];
  const tail = Math.hypot(last.x - lastOut.x, last.y - lastOut.y);
  if (tail >= 0.6 * s) out.push(last);
  return out;
}

/** linear 块：骨架 → 链 → 等弧长点（全局坐标，落点吸附回掩码） */
function linearGems(ctx: LayoutCtx, block: Block, blockIndex: number): StrategyOutput {
  const d = ctx.densities[blockIndex];
  const s = ctx.pitchPx / Math.sqrt(d);
  const sk = skeletonize(block.mask);
  const chains = skeletonChains(sk);
  const gems: Gem[] = [];
  for (const chain of chains) {
    const pts = resampleChain(chain, s);
    for (const p of pts) {
      const gx = block.bbox.x + p.x;
      const gy = block.bbox.y + p.y;
      // 插值点吸附到最近掩码像素中心（骨架属掩码，插值步长 ≤ √2px，吸附必命中）
      if (inBlockMask(block, gx, gy)) {
        gems.push(makeGem(block.id, gx, gy));
      } else {
        const snapped = snapToMask(block.mask, p.x, p.y);
        if (snapped) {
          gems.push(makeGem(block.id, block.bbox.x + snapped.x, block.bbox.y + snapped.y));
        }
      }
    }
  }
  // 链交汇/短链近点消解（节点像素被多链共享）
  return enforceMinDistanceCounted(gems, ctx.pitchPx, typeRankCompare(ctx));
}

/** element 块：连通域质心单点（质心可能落在凹形外，吸附回掩码） */
function elementGem(ctx: LayoutCtx, block: Block): Gem | undefined {
  const { w, h, bits } = block.mask;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x] === 1) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  if (n === 0) return undefined;
  const cx = sx / n;
  const cy = sy / n;
  let gx = block.bbox.x + cx;
  let gy = block.bbox.y + cy;
  if (!inBlockMask(block, gx, gy)) {
    const snapped = snapToMask(block.mask, cx, cy);
    if (!snapped) return undefined;
    gx = block.bbox.x + snapped.x;
    gy = block.bbox.y + snapped.y;
  }
  return makeGem(block.id, gx, gy);
}

export function hybrid(ctx: LayoutCtx): StrategyOutput {
  const out: Gem[] = [];
  let dropped = 0;
  ctx.blocks.forEach((block, bi) => {
    match(block.suggested)
      .with("fill", () => {
        out.push(...hexFillBlock(ctx, block, bi));
      })
      .with("linear", () => {
        const res = linearGems(ctx, block, bi);
        out.push(...res.gems);
        dropped += res.dropped;
      })
      .with("element", () => {
        const g = elementGem(ctx, block);
        if (g) out.push(g);
      })
      .exhaustive();
  });
  const final = enforceMinDistanceCounted(out, ctx.pitchPx, typeRankCompare(ctx));
  return { gems: final.gems, dropped: dropped + final.dropped };
}
