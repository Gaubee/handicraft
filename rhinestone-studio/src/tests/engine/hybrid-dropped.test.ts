/*
[2026-09-19 Test] hybrid 照片类输入 dropped 回归（修复：linear 生成期贪心过滤）+ Codex 复核补强（8/10 GO，P1 测试契约闭合）。
- 归因实证（400×400 boston 照片派生图，k=8——刻意密于 smoke 的 k=6：照片量化后 linear 块更多，压测骨架噪声路径）：
  修复前 31 块中 26 块为 linear，骨架短刺链森林 + 共享节点重复发射 → 块内消解剔除 3146/3510 候选（89.8%），
  hybrid dropped=3390（候选占比 63%）。
- 修复后：块内 dropped=0（生成期同阈值过滤，源头不产冲突），仅剩跨块真实边界冲突计入 dropped（同块全局剔除=0，
  断言锁定；量级 11% < poisson 同图 19%）。
- 等价性锁定：镜像修复前旧路径（候选全发 → 逐块消解 → 全局消解）作参考实现，断言新旧 [blockId,x,y] 序列与
  dropped 完全相等——坐标/发射序/跨块优先级任一漂移都会被抓住，而非只看 dropped 比例。
- 相邻 fill 块守护：全局锚定晶格（hexLattice 锚 (0,0)）下同密度相邻宽块零跨块冲突 → hybrid dropped=0。
- 分支覆盖：水平 1px 线（骨架上整点为主）与斜线（重采样分数点走 snapToMask 吸附）两 fixture。
*/

import { describe, expect, it } from "vitest";
import { gridFromSs, layout, segment, type Block, type Gem, type GridSpec } from "$lib/engine";
import { resolveGreedy } from "$lib/engine/conflict";
import { buildLayoutCtx, inBlockMask, makeGem, typeRankCompare, type ParsedLayoutOptions } from "$lib/engine/layout/common";
import { hexFillBlock } from "$lib/engine/layout/hex-pitch";
import { resampleChain } from "$lib/engine/layout/hybrid";
import { skeletonChains, skeletonize } from "$lib/engine/layout/skeleton";
import { snapToMask } from "$lib/engine/ops";
import { expectInvariants, loadBostonPhotoPainting, makeImage, SEG_OPTS } from "./helpers";

const IVORY: [number, number, number] = [255, 252, 240];
const RED: [number, number, number] = [200, 16, 46];

/** 修复前旧路径的镜像参考实现：linear 候选全量发射 → 逐块消解 → 全局消解（fill/element 与现实现同源）。
 *  返回分层计数：localRemoved=旧块内消解剔除（噪声候选，修复后不再生成故不再计数）；
 *  globalRemoved=全局阶段剔除（跨块真实冲突，与现实现 dropped 逐位相等）。 */
function referenceOldHybrid(
  blocks: Block[],
  opts: ParsedLayoutOptions,
  grid: GridSpec,
): { gems: Gem[]; globalRemoved: number; localRemoved: number; sameBlockGlobalRemoved: number } {
  const ctx = buildLayoutCtx(blocks, opts, grid);
  const produced: Gem[] = [];
  let localRemoved = 0;
  blocks.forEach((block, bi) => {
    if (block.suggested === "fill") {
      produced.push(...hexFillBlock(ctx, block, bi));
      return;
    }
    if (block.suggested === "linear") {
      const s = ctx.pitchPx / Math.sqrt(ctx.densities[bi]);
      const raw: Gem[] = [];
      for (const chain of skeletonChains(skeletonize(block.mask))) {
        for (const p of resampleChain(chain, s)) {
          const gx = block.bbox.x + p.x;
          const gy = block.bbox.y + p.y;
          if (inBlockMask(block, gx, gy)) {
            raw.push(makeGem(block.id, gx, gy));
          } else {
            const q = snapToMask(block.mask, p.x, p.y);
            if (q) raw.push(makeGem(block.id, block.bbox.x + q.x, block.bbox.y + q.y));
          }
        }
      }
      const local = resolveGreedy(raw, ctx.pitchPx, typeRankCompare(ctx));
      produced.push(...local.gems);
      localRemoved += local.removed.length;
      return;
    }
    // element：质心单点（与 hybrid.ts elementGem 同式；照片 fixture 无 element 块，镜像保全）
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
    if (n === 0) return;
    let gx = block.bbox.x + sx / n;
    let gy = block.bbox.y + sy / n;
    if (!inBlockMask(block, gx, gy)) {
      const q = snapToMask(block.mask, sx / n, sy / n);
      if (!q) return;
      gx = block.bbox.x + q.x;
      gy = block.bbox.y + q.y;
    }
    produced.push(makeGem(block.id, gx, gy));
  });
  const global = resolveGreedy(produced, ctx.pitchPx, typeRankCompare(ctx));
  const threshold = ctx.pitchPx * 0.999;
  const sameBlockGlobalRemoved = global.removed.filter(({ gem }) =>
    global.gems.some((kept) => kept.blockId === gem.blockId && Math.hypot(kept.x - gem.x, kept.y - gem.y) < threshold),
  ).length;
  return { gems: global.gems, globalRemoved: global.removed.length, localRemoved, sameBlockGlobalRemoved };
}

const photoKey = (g: Gem) => `${g.blockId}|${g.x}|${g.y}`;

describe("hybrid 照片类输入 dropped 回归（生成期过滤，源头不产冲突）", () => {
  const painting = loadBostonPhotoPainting();
  const grid = gridFromSs("SS10", 2.5); // pitch 8px
  // k=8 刻意密于 smoke 的 k=6（见文件头注释）
  const blocks = segment(painting, { k: 8, seed: 11, gemDiameterPx: 7, minAreaPx: 350 });
  const opts: ParsedLayoutOptions = { density: 1, seed: 11, relax: { boundary: false, repulsion: false } };

  it("与修复前旧路径逐位等价：[blockId,x,y] 序列相等，全局阶段剔除数 = 现 dropped", () => {
    const current = layout(blocks, "hybrid", opts, grid);
    const reference = referenceOldHybrid(blocks, opts, grid);
    // 钻位序列逐位一致（生成期过滤 ≡ 旧块内消解的 keep-earlier 语义）
    expect(current.gems.map(photoKey)).toEqual(reference.gems.map(photoKey));
    // dropped 语义差是修复本体：旧的 localRemoved（噪声候选）不再生成故不再计数；
    // 全局阶段（跨块真实冲突）剔除数与现实现 dropped 逐位相等
    expect(current.dropped).toBe(reference.globalRemoved);
    expect(reference.localRemoved).toBeGreaterThan(0); // 锁住「修复前确实存在大量块内剔除」的归因事实
  }, 120_000);

  it("剩余 dropped 全部为跨块冲突（同块全局剔除 = 0，断言锁定非注释声明）", () => {
    const reference = referenceOldHybrid(blocks, opts, grid);
    expect(reference.sameBlockGlobalRemoved).toBe(0);
  }, 120_000);

  it("照片输入 dropped 占比降至正常策略量级（修复前 63%）", () => {
    const { gems, dropped: d } = layout(blocks, "hybrid", opts, grid);
    const dropped = d ?? 0;
    expect(gems.length).toBeGreaterThan(150);
    expect(gems.length).toBeGreaterThan(dropped); // 修复前 dropped(3390) ≈ 1.7×gems(1985)
    // 剩余 dropped 为跨块真实边界冲突（poisson 同 fixture 为 19%）；30% 上界留足余量
    expect(dropped / (gems.length + dropped)).toBeLessThan(0.3);
    expectInvariants(gems, blocks, grid.pitchMm * grid.pixelsPerMm, "hybrid-photo");
  }, 120_000);

  it("照片输入密度单调性保持（0.5 / 0.25 不减）", () => {
    const n1 = layout(blocks, "hybrid", { ...opts, density: 1 }, grid).gems.length;
    const n05 = layout(blocks, "hybrid", { ...opts, density: 0.5 }, grid).gems.length;
    const n025 = layout(blocks, "hybrid", { ...opts, density: 0.25 }, grid).gems.length;
    expect(n1).toBeGreaterThanOrEqual(n05);
    expect(n05).toBeGreaterThanOrEqual(n025);
    expect(n1).toBeGreaterThan(0);
  }, 180_000);
});

describe("hybrid linear 分支路径覆盖（水平线 = 骨架整点为主；斜线 = 分数点走 snapToMask）", () => {
  const grid: GridSpec = gridFromSs("SS10", 2.5);

  it("水平 1px 线：产出钻链，不变量成立（dropped 仅跨块合法冲突）", () => {
    // y=30 的 1px 高水平线（长 60px < 3 钻径 21px×3 → linear；背景 IVORY 为 fill 块）
    const image = makeImage(80, 60, (x, y) => (y === 30 && x >= 10 && x <= 69 ? RED : IVORY));
    const blocks = segment(image, SEG_OPTS);
    const { gems, dropped, linearBlocks } = {
      ...layout(blocks, "hybrid", { density: 1, seed: 7, relax: { boundary: false, repulsion: false } }, grid),
      linearBlocks: blocks.filter((b) => b.suggested === "linear").length,
    };
    expect(linearBlocks).toBeGreaterThanOrEqual(1);
    expect(gems.length).toBeGreaterThan(3);
    expect(dropped ?? 0).toBeLessThan(gems.length); // 线块↔背景 fill 的边界碰撞为合法跨块计数
    expectInvariants(gems, blocks, grid.pitchMm * grid.pixelsPerMm, "hybrid-h-line");
  });

  it("2px 斜线（4-连通 + 阶梯骨架分数重采样点 → snapToMask 吸附路径）：产出钻链，不变量成立", () => {
    // 双行阶梯保证 4-连通（单像素 45° 阶梯只有 8-连通，会被连通域打散成孤点）
    const image = makeImage(80, 80, (x, y) => (x >= 10 && x <= 69 && (y === x + 10 || y === x + 11) ? RED : IVORY));
    const blocks = segment(image, SEG_OPTS);
    const { gems, dropped } = layout(blocks, "hybrid", { density: 1, seed: 7, relax: { boundary: false, repulsion: false } }, grid);
    expect(blocks.filter((b) => b.suggested === "linear").length).toBeGreaterThanOrEqual(1);
    expect(gems.length).toBeGreaterThan(3);
    expect(dropped ?? 0).toBeLessThan(gems.length);
    expectInvariants(gems, blocks, grid.pitchMm * grid.pixelsPerMm, "hybrid-diag-line");
  });
});

describe("hybrid 相邻宽块晶格守护（全局锚定晶格 → 零跨块冲突）", () => {
  const grid: GridSpec = gridFromSs("SS10", 2.5);

  it("两相邻同密度 fill 块：hybrid dropped = 0（严格相邻断言：共享边界 + 等纵向范围）", () => {
    // 两块 60×40 纯色矩形共享 40px 竖边：均为 fill（宽 60 > 3 钻径 21px）
    const image = makeImage(101, 60, (x) => (x <= 50 ? RED : IVORY));
    const blocks: Block[] = segment(image, SEG_OPTS);
    const fills = blocks
      .filter((b) => b.suggested === "fill")
      .sort((a, b) => a.bbox.x - b.bbox.x);
    expect(fills.length).toBe(2);
    // 严格相邻：左块右缘 = 右块左缘（±1 容差），且纵向范围一致
    expect(fills[0].bbox.x + fills[0].bbox.w).toBeGreaterThanOrEqual(fills[1].bbox.x - 1);
    expect(fills[0].bbox.x + fills[0].bbox.w).toBeLessThanOrEqual(fills[1].bbox.x + 1);
    expect(fills[0].bbox.y).toBe(fills[1].bbox.y);
    expect(fills[0].bbox.h).toBe(fills[1].bbox.h);
    const { gems, dropped: d } = layout(blocks, "hybrid", { density: 1, seed: 7, relax: { boundary: false, repulsion: false } }, grid);
    expect(gems.length).toBeGreaterThan(30);
    expect(d ?? 0).toBe(0); // 共享全局晶格（锚 (0,0)）→ 边界两侧晶格点重合于同一格点系，无冲突
    expectInvariants(gems, blocks, grid.pitchMm * grid.pixelsPerMm, "hybrid-adjacent-fill");
  });
});
