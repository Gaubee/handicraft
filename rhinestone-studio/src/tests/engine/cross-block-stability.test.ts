/*
[2026-09-18 Test] 评审 B2 回归：改 A 块密度，相邻 B 块钻数不应波动。
fixtureTwoRects（96×64 双矩形交界零缓冲），左块密度 1.0/0.7/0.5/0.3 扫描，
右块（恒 d=1.0）计数逐位恒定。
范围与依据：
- hex-thin / hex-pitch / hybrid：严格逐位恒定。右块候选集密度无关（冻结晶格/全局噪声阈值），
  冲突让位规则（生效密度低者让位，见 common.ts typeRankCompare）保证右块永不让位。
- poisson：d<1 区间恒定（让位规则生效）；左=右=1.0 的同密度并列按确定性固定序裁决，
  右块在 tie 端点可能让位少量边界钻——确定性重放不受影响，属并列裁决的固有语义。
- cvt：豁免。全局 Lloyd 站点跨块迁移，"其余块计数稳定"与"交界连续过渡"（cvt 的存在理由，
  见 cvt-continuity.test.ts）数学上不可兼得——与 layout-invariants.test.ts 的既有豁免同口径。
修复前实测（hex-pitch）：右块计数 60→56→54→57（±10% 波动）。
*/

import { describe, expect, it } from "vitest";
import { layout, segment, type StrategyId } from "$lib/engine";
import { expectInvariants, fixtureTwoRects, SEG_OPTS, standardGrid } from "./helpers";

const LEFT_DENSITIES = [1, 0.7, 0.5, 0.3] as const;
const STRICT_STABLE: StrategyId[] = ["hex-thin", "hex-pitch", "hybrid"];

describe("相邻双块：改左块密度，右块（恒 d=1.0）计数稳定", () => {
  const blocks = segment(fixtureTwoRects(), SEG_OPTS);
  const grid = standardGrid();
  const left = blocks.find((b) => b.bbox.x === 0)!;
  const right = blocks.find((b) => b.bbox.x === 48)!;

  function rightCount(strategy: StrategyId, leftD: number): number {
    const { gems } = layout(
      blocks,
      strategy,
      { density: { [left.id]: leftD }, seed: 5 },
      grid,
    );
    return gems.filter((g) => g.blockId === right.id).length;
  }

  it.each(STRICT_STABLE)("%s：左块 1.0/0.7/0.5/0.3 → 右块计数逐位恒定", (strategy: StrategyId) => {
    const counts = LEFT_DENSITIES.map((d) => rightCount(strategy, d));
    expect(counts[0]).toBeGreaterThan(0);
    for (const c of counts) expect(c).toBe(counts[0]);
  });

  it("poisson：d<1 区间右块计数恒定（让位规则生效）", () => {
    const counts = [0.7, 0.5, 0.3].map((d) => rightCount("poisson", d));
    for (const c of counts) expect(c).toBe(counts[0]);
  });

  it.each([...STRICT_STABLE, "poisson"] as StrategyId[])(
    "%s：左块变化时右块候选与产出仍满足硬不变量",
    (strategy: StrategyId) => {
      for (const d of LEFT_DENSITIES) {
        const { gems, warnings } = layout(
          blocks,
          strategy,
          { density: { [left.id]: d }, seed: 5 },
          grid,
        );
        expectInvariants(gems, blocks, 8, `${strategy}-left-${d}`);
        expect(warnings.filter((w) => w.kind === "spacing" || w.kind === "mask")).toEqual([]);
      }
    },
  );

  it("确定性重放不受让位规则影响（同 seed 逐位相同）", () => {
    const run = (): string => {
      const { gems } = layout(
        blocks,
        "hex-pitch",
        { density: { [left.id]: 0.5 }, seed: 9 },
        grid,
      );
      return JSON.stringify(gems);
    };
    expect(run()).toBe(run());
  });
});
