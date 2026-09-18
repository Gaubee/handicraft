/*
Orthogonal intents (max 3):
1. [2026-09-18 Strategy S4] hybrid：按块建议类型分派——fill → hexFill（hex-pitch 复用）；linear → Zhang-Suen 骨架 → 链化 → 等弧长(pitch×d^-1/2)取点；element → 质心单点（design.md §3，宽度阈值分支来自实证）。
2. [2026-09-18 Dispatch] ts-pattern 对 suggested 做穷尽分派（类型安全 = 无遗漏分支）。
3. [2026-09-18 Invariant] 链交汇处/共享节点/噪声短刺链的近点在生成期贪心过滤（同 resolveGreedy 阈值与序，输出逐位不变）；块内 + 全局两级确定性消解仅作兜底。
*/

import { match } from "ts-pattern";
import { SpatialIndex, snapToMask } from "../ops";
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

/**
 * linear 块：骨架 → 链 → 等弧长点（全局坐标，落点吸附回掩码）。
 * 生成期贪心过滤（源头不产冲突）：候选按发射序逐点对照已接受钻（与 resolveGreedy
 * 同阈值 pitch×0.999、同平方距离严格小于判定），冲突者不生成——照片类输入的噪声
 * 骨架会产生短刺链森林与共享节点重复点（占候选 ~90%），此前由块内消解事后剔除并
 * 计入 dropped，现于生成侧直接跳过。保留序与 keep-earlier 消解逐位一致（输出不变）。
 */
function linearGems(ctx: LayoutCtx, block: Block, blockIndex: number): StrategyOutput {
  const d = ctx.densities[blockIndex];
  const s = ctx.pitchPx / Math.sqrt(d);
  const sk = skeletonize(block.mask);
  const chains = skeletonChains(sk);
  const gems: Gem[] = [];
  const threshold = ctx.pitchPx * 0.999;
  const index = new SpatialIndex<Gem>(ctx.pitchPx);
  const tryPlace = (x: number, y: number): void => {
    for (const other of index.query(x, y)) {
      const dx = other.x - x;
      const dy = other.y - y;
      if (dx * dx + dy * dy < threshold * threshold) return; // 必被消解剔除 → 不生成
    }
    const gem = makeGem(block.id, x, y);
    gems.push(gem);
    index.insert(x, y, gem);
  };
  for (const chain of chains) {
    const pts = resampleChain(chain, s);
    for (const p of pts) {
      const gx = block.bbox.x + p.x;
      const gy = block.bbox.y + p.y;
      // 插值点吸附到最近掩码像素中心（骨架属掩码，插值步长 ≤ √2px，吸附必命中）
      if (inBlockMask(block, gx, gy)) {
        tryPlace(gx, gy);
      } else {
        const snapped = snapToMask(block.mask, p.x, p.y);
        if (snapped) {
          tryPlace(block.bbox.x + snapped.x, block.bbox.y + snapped.y);
        }
      }
    }
  }
  // 块内兜底消解（防御性，生成侧已同阈值过滤 → dropped 恒 0）
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
