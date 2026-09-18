/*
[2026-09-18 Test] tasks 2.3：CVT 密度连续性——相邻块 0.6 / 0.7 交界处钻距连续过渡（无阶跃）。
容差依据（注释依据要求）：
- 局部解析间距 = pitch×d^(-1/2)：d=0.6 → 1.291p，d=0.7 → 1.195p，理论比 1.08；
- Lloyd 收敛后站点为准六方，实测不规则度 ±15% 量级；像素吸附与交界处 Voronoi 胞元切换再放大少许；
- 上界取 1.8p（理论 1.29p × ~1.4 不规则余量），两侧均值差 ≤ 25%（阶跃判据：硬边界会给出 ≥ 2 倍差）。
*/

import { describe, expect, it } from "vitest";
import { layout, segment } from "$lib/engine";
import { expectInvariants, fixtureTwoRects, SEG_OPTS, standardGrid } from "./helpers";

const PITCH = 8;
const BOUNDARY_X = 47.5; // 两矩形交界（x 0..47 | 48..95）
const BAND = 2 * PITCH;

describe("cvt 密度连续性（0.6 | 0.7）", () => {
  const blocks = segment(fixtureTwoRects(), SEG_OPTS);
  const grid = standardGrid();
  const left = blocks.find((b) => b.bbox.x === 0)!;
  const right = blocks.find((b) => b.bbox.x === 48)!;

  it("交界带钻距连续（无阶跃），且全局硬约束恒真", () => {
    const { gems, warnings } = layout(
      blocks,
      "cvt",
      { density: { [left.id]: 0.6, [right.id]: 0.7 }, seed: 5 },
      grid,
    );
    expect(warnings.filter((w) => w.kind === "spacing" || w.kind === "mask")).toEqual([]);
    expectInvariants(gems, blocks, PITCH, "cvt-continuity");

    // 交界带：|x - 47.5| ≤ 2×pitch
    const band = gems.filter((g) => Math.abs(g.x - BOUNDARY_X) <= BAND);
    expect(band.length).toBeGreaterThan(6);

    // 每钻最近邻距离（对全体钻求 NN，交界带钻的读数）
    const nn = (g: (typeof gems)[number]): number => {
      let best = Infinity;
      for (const other of gems) {
        if (other === g) continue;
        const d = Math.hypot(other.x - g.x, other.y - g.y);
        if (d < best) best = d;
      }
      return best;
    };
    const nnAll = band.map((g) => nn(g));
    for (const d of nnAll) {
      // 下界 = 不变量 1；上界 = 连续性容差（依据见文件头）
      expect(d).toBeGreaterThanOrEqual(PITCH * 0.999);
      expect(d).toBeLessThanOrEqual(PITCH * 1.8);
    }
    // 阶跃判据：交界带左半 vs 右半的 NN 均值差 ≤ 25%
    const leftSide = band.filter((g) => g.x < BOUNDARY_X).map(nn);
    const rightSide = band.filter((g) => g.x >= BOUNDARY_X).map(nn);
    const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
    const ml = mean(leftSide);
    const mr = mean(rightSide);
    expect(Math.abs(ml - mr) / Math.min(ml, mr)).toBeLessThan(0.25);
  });
});
