/*
[2026-09-18 Test] 评审 B1 回归：CVT 密度单调性 + 满密度容量。
- 单调性：多块 fixture（fixtureShapes）全局密度 1.0→0.1 步长 0.1 全区间细扫描，
  钻数单调不减（复现评审探针序列：修复前 1.0 反而最少且区间内非单调）。
- 容量：d=1.0 时 cvt 消解后钻数 ≥ hex-pitch 同场景的 90%（修复前仅 ~50%，静默丢弃约半数钻）。
- 消解丢弃可视化契约：默认路径 dropped 应为 0（终局消解只兜松弛残余）。
*/

import { describe, expect, it } from "vitest";
import { layout, segment, STRATEGY_IDS, type StrategyId } from "$lib/engine";
import { expectInvariants, fixtureShapes, SEG_OPTS, standardGrid } from "./helpers";

const PITCH = 8;

describe("cvt 密度单调性（多块 fixture，步长 0.1 全区间细扫描）", () => {
  const blocks = segment(fixtureShapes(), SEG_OPTS);
  const grid = standardGrid();

  it("全局密度 1.0→0.1 逐级递减，钻数单调不减（评审探针序列修正）", () => {
    const ladder = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
    const counts = ladder.map((d) => layout(blocks, "cvt", { density: d, seed: 1 }, grid).gems.length);
    // 修复前实测：135,163,204,182,156,129,104,78,53（d=1.0 最少、区间非单调）
    expect(counts[0]).toBeGreaterThan(0);
    for (let i = 1; i < ladder.length; i++) {
      expect(
        counts[i],
        `d=${ladder[i]} 的钻数 ${counts[i]} 不应高于 d=${ladder[i - 1]} 的 ${counts[i - 1]}`,
      ).toBeLessThanOrEqual(counts[i - 1]);
    }
  });

  it.each([3, 5, 7])("seed=%s 下单调性同样成立（非特定 seed 巧合）", (seed: number) => {
    const ladder = [1, 0.8, 0.6, 0.4, 0.2];
    const counts = ladder.map((d) => layout(blocks, "cvt", { density: d, seed }, grid).gems.length);
    for (let i = 1; i < ladder.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});

describe("cvt 满密度容量（评审 B1：修复前仅 hex-pitch 的 ~51%）", () => {
  const blocks = segment(fixtureShapes(), SEG_OPTS);
  const grid = standardGrid();

  it("d=1.0 消解后钻数 ≥ hex-pitch 同场景的 90%", () => {
    const hexCount = layout(blocks, "hex-pitch", { density: 1, seed: 1 }, grid).gems.length;
    const cvtCount = layout(blocks, "cvt", { density: 1, seed: 1 }, grid).gems.length;
    expect(hexCount).toBeGreaterThan(0);
    expect(cvtCount).toBeGreaterThanOrEqual(Math.ceil(hexCount * 0.9));
  });

  it("d=1.0 输出仍满足全部硬不变量且零 spacing/mask 违规", () => {
    const { gems, warnings } = layout(blocks, "cvt", { density: 1, seed: 1 }, grid);
    expectInvariants(gems, blocks, PITCH, "cvt-full-density");
    expect(warnings.filter((w) => w.kind === "spacing" || w.kind === "mask")).toEqual([]);
  });
});

describe("LayoutResult.dropped（消解丢弃计数，N4）", () => {
  const blocks = segment(fixtureShapes(), SEG_OPTS);
  const grid = standardGrid();

  // 冻结晶格策略同 pitch 零跨块冲突 → 默认路径零丢弃；
  // poisson（块间独立采样）/ hybrid（骨架链交汇）存在少量真实跨块/交汇冲突，
  // 按确定性消解丢弃并计入 dropped（可视化呈现，而非静默）
  const ZERO_DROP: StrategyId[] = ["hex-thin", "hex-pitch", "cvt"];

  it.each(ZERO_DROP)("%s：默认路径 dropped = 0（不静默删钻）", (sid: StrategyId) => {
    const { dropped, gems } = layout(blocks, sid, { density: 1, seed: 1 }, grid);
    expect(gems.length).toBeGreaterThan(0);
    expect(dropped).toBe(0);
  });

  it.each(STRATEGY_IDS.filter((s) => !ZERO_DROP.includes(s)) as StrategyId[])(
    "%s：dropped 为非负整数（真实跨块冲突的确定性消解计数）",
    (sid: StrategyId) => {
      const { dropped, gems } = layout(blocks, sid, { density: 1, seed: 1 }, grid);
      expect(gems.length).toBeGreaterThan(0);
      expect(Number.isInteger(dropped)).toBe(true);
      expect(dropped).toBeGreaterThanOrEqual(0);
    },
  );

  it("空块集返回空结果且 dropped = 0", () => {
    const { gems, dropped } = layout([], "cvt", { density: 1, seed: 1 }, grid);
    expect(gems).toEqual([]);
    expect(dropped).toBe(0);
  });
});
