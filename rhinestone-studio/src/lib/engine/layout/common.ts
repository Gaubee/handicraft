/*
Orthogonal intents (max 4):
1. [2026-09-18 Context] LayoutCtx：五策略共享的分块上下文（labelMap/密度解析/子种子 PRNG），块 A 参数变化不影响块 B 的随机序列。
2. [2026-09-18 Lattice] 全局冻结六方晶格（行向水平、错行半距，锚定原点 (0,0)：同 pitch 的相邻块天然对齐且零跨块冲突——design.md §3 裁决）。
3. [2026-09-18 Invariant] enforceMinDistance：确定性 keep-earlier 冲突消解（构造策略的最后防线，保证不变量 1 在默认输出恒真）。
*/

import { mixSeed, mulberry32 } from "../rng";
import { resolveGreedy } from "../conflict";
import type { Block, BlockType, DensitySpec, Gem, GridSpec } from "../types";

/** LayoutOptionsSchema.parse 后的规范化形态（z.output 的显式等价） */
export interface ParsedLayoutOptions {
  density: DensitySpec;
  seed: number;
  relax: { boundary: boolean; repulsion: boolean };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutCtx {
  blocks: Block[];
  grid: GridSpec;
  seed: number;
  /** 基准 pitch（px）——不变量与校验的最小间距，密度只放大间距 */
  pitchPx: number;
  /** 每块密度（按块索引） */
  densities: number[];
  /** 图像包围盒尺寸（块 bbox 的并集） */
  W: number;
  H: number;
  /** 像素 → 块索引（-1 = 无）。CCL 分块天然不重叠；人工改掩码导致重叠时后块覆盖 */
  labelMap: Int16Array;
  unionRect: Rect;
  rngFor(blockIndex: number, tag: number): () => number;
}

export function buildLayoutCtx(
  blocks: Block[],
  opts: ParsedLayoutOptions,
  grid: GridSpec,
): LayoutCtx {
  const W = Math.max(1, ...blocks.map((b) => b.bbox.x + b.bbox.w));
  const H = Math.max(1, ...blocks.map((b) => b.bbox.y + b.bbox.h));
  const labelMap = new Int16Array(W * H).fill(-1);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  blocks.forEach((b, bi) => {
    const { x, y, w, h } = b.bbox;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (b.mask.bits[dy * w + dx] === 1) labelMap[(y + dy) * W + (x + dx)] = bi;
      }
    }
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w - 1);
    y1 = Math.max(y1, y + h - 1);
  });
  const densities = blocks.map((b) => resolveDensity(opts.density, b.id));
  return {
    blocks,
    grid,
    seed: opts.seed,
    pitchPx: grid.pitchMm * grid.pixelsPerMm,
    densities,
    W,
    H,
    labelMap,
    unionRect: { x0, y0, x1, y1 },
    rngFor: (blockIndex, tag) => mulberry32(mixSeed(opts.seed, blockIndex, tag)),
  };
}

/** Record 形态缺省块默认 1.0 */
function resolveDensity(density: DensitySpec, blockId: string): number {
  if (typeof density === "number") return density;
  return density[blockId] ?? 1;
}

/** labelMap 查询：浮点坐标 → 像素中心 */
export function labelAt(ctx: LayoutCtx, x: number, y: number): number {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= ctx.W || iy >= ctx.H) return -1;
  return ctx.labelMap[iy * ctx.W + ix];
}

/** 全局点是否在指定块掩码内 */
export function inBlockMask(block: Block, x: number, y: number): boolean {
  const ix = Math.round(x) - block.bbox.x;
  const iy = Math.round(y) - block.bbox.y;
  if (ix < 0 || iy < 0 || ix >= block.bbox.w || iy >= block.bbox.h) return false;
  return block.mask.bits[iy * block.bbox.w + ix] === 1;
}

/**
 * 全局冻结六方晶格（锚定 (0,0)，水平行，奇数行偏移半距）。
 * 行距 p·√3/2，列距 p。
 */
export function hexLattice(rect: Rect, pitch: number): number[] {
  const pts: number[] = [];
  const rowH = (pitch * Math.sqrt(3)) / 2;
  const jMin = Math.floor((rect.y0 - 1) / rowH);
  const jMax = Math.ceil((rect.y1 + 1) / rowH);
  for (let j = jMin; j <= jMax; j++) {
    const y = j * rowH;
    const off = (j & 1) === 1 ? pitch / 2 : 0; // 负 j 用位与取奇偶（二补码正确）
    const iMin = Math.ceil((rect.x0 - 1 - off) / pitch);
    const iMax = Math.floor((rect.x1 + 1 - off) / pitch);
    for (let i = iMin; i <= iMax; i++) {
      pts.push(i * pitch + off, y);
    }
  }
  return pts;
}

let gemSeq = 0; // 候选期临时 id（layout 出口统一重编号）
export function makeGem(blockId: string, x: number, y: number): Gem {
  return { id: `c${gemSeq++}`, x, y, colorId: "", blockId };
}

/**
 * 确定性冲突消解：可选比较器决定保留优先级（生效密度高者 > element > linear > fill，
 * tech-research §3.4 预算/冲突下"氛围优先删"的生产优先级）；无比较器按给定顺序。
 * 返回保持原顺序的保留子集。只在构造策略默认路径与策略内部（跨块/交汇处）使用；
 * repulsion 开启时由斥力修复替代（保数不保净）。
 * 算法体已抽至 conflict.ts resolveGreedy（与编辑器 resolveConflicts 共用同一实现，
 * add-manual-edit-mode design.md §4）——本函数是 layout 侧的薄包装，行为逐位不变。
 * [gem-catalog 1.2] 参数单一 pitch（px）→ GridSpec（内部逐对圆包络判据；布局输入恒单 spec
 * ——等径退化与 v1 单一 pitch 判据逐位等价，黄金守卫证据）。
 */
export function enforceMinDistance(
  gems: Gem[],
  grid: GridSpec,
  compare?: (a: Gem, b: Gem) => number,
): Gem[] {
  return resolveGreedy(gems, grid, compare).gems;
}

/** 策略内部产出（gems + 本策略消解丢弃计数，layout 统一汇总进 LayoutResult.dropped） */
export interface StrategyOutput {
  gems: Gem[];
  dropped: number;
}

/** enforceMinDistance 的计数包装（N4：消解丢弃可视化） */
export function enforceMinDistanceCounted(
  gems: Gem[],
  grid: GridSpec,
  compare?: (a: Gem, b: Gem) => number,
): StrategyOutput {
  const kept = enforceMinDistance(gems, grid, compare);
  return { gems: kept, dropped: gems.length - kept.length };
}

const TYPE_RANK: Record<BlockType, number> = { element: 0, linear: 1, fill: 2 };

/**
 * 冲突消解优先级比较器：生效密度高者优先保留（跨块冲突对让位方 = 密度较低的一方，
 * 评审 B2：A 块调密度不应波动相邻 B 块的钻数）；同密度回退类型优先级
 * （element > linear > fill，tech-research §3.4"氛围优先删"），同级再回退块索引。
 * 三级键全部确定性 → 同输入同序，确定性重放不受影响。
 */
export function typeRankCompare(ctx: LayoutCtx): (a: Gem, b: Gem) => number {
  const idxById = new Map(ctx.blocks.map((b, i) => [b.id, i] as const));
  const rank = (blockId: string): number => idxById.get(blockId) ?? 0;
  return (a, b) => {
    const ia = rank(a.blockId);
    const ib = rank(b.blockId);
    return (
      ctx.densities[ib] - ctx.densities[ia] ||
      TYPE_RANK[ctx.blocks[ia]?.suggested ?? "fill"] - TYPE_RANK[ctx.blocks[ib]?.suggested ?? "fill"] ||
      ia - ib
    );
  };
}

/** 块 bbox 外扩 margin 的晶格搜索域 */
export function blockRect(block: Block, margin: number): Rect {
  return {
    x0: block.bbox.x - margin,
    y0: block.bbox.y - margin,
    x1: block.bbox.x + block.bbox.w - 1 + margin,
    y1: block.bbox.y + block.bbox.h - 1 + margin,
  };
}
