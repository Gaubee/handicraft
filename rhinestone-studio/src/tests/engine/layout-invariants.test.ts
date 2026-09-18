/*
[2026-09-18 Test] tasks 2.2/2.3：五策略 × 不变量全量断言——
间距 ≥ pitch×0.999 / 钻心在掩码内 / 同 seed 逐位重放 / 密度 1.0→0.5→0.25 钻数单调不减 / 其余块钻数稳定。
*/

import { describe, expect, it } from "vitest";
import { layout, segment, STRATEGY_IDS, type Block, type Gem, type StrategyId } from "$lib/engine";
import { expectInvariants, fixtureShapes, fixtureSolid, SEG_OPTS, standardGrid } from "./helpers";

const PITCH = 8; // SS10 @ 2.5px/mm

function gemSignature(gems: Gem[]): string {
  return JSON.stringify(gems);
}

describe.each(STRATEGY_IDS)("策略 %s 不变量", (strategy: StrategyId) => {
  const blocks = segment(fixtureShapes(), SEG_OPTS);
  const grid = standardGrid();

  it("间距 + 掩码 + 零 spacing warning", () => {
    const { gems, warnings } = layout(blocks, strategy, { density: 1, seed: 7 }, grid);
    expect(gems.length).toBeGreaterThan(0);
    expectInvariants(gems, blocks, PITCH, strategy);
    expect(warnings.filter((w) => w.kind === "spacing")).toEqual([]);
    expect(warnings.filter((w) => w.kind === "mask")).toEqual([]);
  });

  it("同 seed 重放逐位相同", () => {
    const a = layout(blocks, strategy, { density: 1, seed: 7 }, grid);
    const b = layout(blocks, strategy, { density: 1, seed: 7 }, grid);
    expect(gemSignature(b.gems)).toBe(gemSignature(a.gems));
    expect(b.warnings).toEqual(a.warnings);
  });

  it("松弛钩子（boundary+repulsion）开启后不变量仍恒真", () => {
    const { gems, warnings } = layout(
      blocks,
      strategy,
      { density: 1, seed: 7, relax: { boundary: true, repulsion: true } },
      grid,
    );
    expectInvariants(gems, blocks, PITCH, `${strategy}+relax`);
    expect(warnings.filter((w) => w.kind === "spacing" || w.kind === "mask")).toEqual([]);
  });

  it("boundary-only（repulsion 关）不变量恒真（构造期消解兜底）", () => {
    const { gems } = layout(
      blocks,
      strategy,
      { density: 1, seed: 7, relax: { boundary: true, repulsion: false } },
      grid,
    );
    expectInvariants(gems, blocks, PITCH, `${strategy}+boundary`);
  });
});

describe("密度单调性（单块 fixture，零跨块干扰）", () => {
  const blocks: Block[] = segment(fixtureSolid(), SEG_OPTS);
  const grid = standardGrid();
  const id = blocks[0].id;

  it.each(STRATEGY_IDS)("%s：1.0 ≥ 0.5 ≥ 0.25 钻数单调不减", (strategy: StrategyId) => {
    const counts = [1, 0.5, 0.25].map(
      (d) => layout(blocks, strategy, { density: { [id]: d }, seed: 7 }, grid).gems.length,
    );
    expect(counts[0]).toBeGreaterThanOrEqual(counts[1]);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[2]);
    expect(counts[0]).toBeGreaterThan(0);
  });
});

describe("块级密度独立（其余块钻数不变）", () => {
  const blocks = segment(fixtureShapes(), SEG_OPTS);
  const grid = standardGrid();
  const square = blocks.find((b) => b.areaPx === 1600)!;
  // cvt 除外：CVT 是全局密度场变分解算器，站点跨块迁移、整体平衡随任一块密度变化而重排——
  // "其余块计数稳定"与"交界连续过渡"（cvt 的存在理由）在数学上不可兼得，构造式四策略保持块独立性。
  const LOCAL_STRATEGIES = STRATEGY_IDS.filter((s) => s !== "cvt") as StrategyId[];

  it.each(LOCAL_STRATEGIES)("%s：只动红方密度，其余块计数逐级不变", (strategy: StrategyId) => {
    const others = (d: number): number[] => {
      const { gems } = layout(blocks, strategy, { density: { [square.id]: d }, seed: 7 }, grid);
      return blocks.filter((b) => b.id !== square.id).map((b) => gems.filter((g) => g.blockId === b.id).length);
    };
    // 注：跨块边界 1 钻内的冲突消解理论上可致相邻块 ±1~2（不同 pitch 相邻时）；
    // 本 fixture 红方与其余块间有 ≥5px 背景缓冲带（同 pitch 邻接为零冲突场景），断言精确稳定。
    expect(others(1)).toEqual(others(0.5));
    expect(others(0.5)).toEqual(others(0.25));
    // 红方自身单调
    const cnt = (d: number): number =>
      layout(blocks, strategy, { density: { [square.id]: d }, seed: 7 }, grid).gems.filter(
        (g) => g.blockId === square.id,
      ).length;
    expect(cnt(1)).toBeGreaterThanOrEqual(cnt(0.5));
    expect(cnt(0.5)).toBeGreaterThanOrEqual(cnt(0.25));
  });
});

describe("hybrid 类型分派语义", () => {
  const blocks = segment(fixtureShapes(), SEG_OPTS);
  const grid = standardGrid();
  const dot = blocks.find((b) => b.suggested === "element")!;
  const line = blocks.find((b) => b.suggested === "linear" && b.colorRgb[1] > 60)!;

  it("element 块恰 1 钻（质心），linear 块沿线出钻", () => {
    const { gems } = layout(blocks, "hybrid", { density: 1, seed: 7 }, grid);
    expect(gems.filter((g) => g.blockId === dot.id).length).toBe(1);
    const lineGems = gems.filter((g) => g.blockId === line.id);
    expect(lineGems.length).toBeGreaterThan(3); // 90px 长线 / pitch 8 → ≥ 8 钻（保守下界）
  });
});
