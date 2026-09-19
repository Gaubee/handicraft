/*
[2026-09-18 Test] tasks 2.3：松弛钩子——boundary 1D Lloyd 后不变量仍恒真；repulsion 修复注入的违规对（保数、掩码内）。
白盒：applyRepulsion / buildLayoutCtx / hexPitch 深路径 import（UI 仍只准走 $lib/engine）。
*/

import { describe, expect, it } from "vitest";
import { layout, segment, validate, isExportable } from "$lib/engine";
import { buildLayoutCtx } from "$lib/engine/layout/common";
import { hexPitch } from "$lib/engine/layout/hex-pitch";
import { applyRepulsion } from "$lib/engine/layout/relax";
import { expectInvariants, fixtureSolid, SEG_OPTS, standardGrid } from "./helpers";

const PITCH = 8;

describe("repulsion 斥力修复", () => {
  const blocks = segment(fixtureSolid(), SEG_OPTS); // 48×48 单块
  const grid = standardGrid();
  const ctx = buildLayoutCtx(
    blocks,
    { density: 1, seed: 7, relax: { boundary: false, repulsion: false } },
    grid,
  );
  const base = hexPitch(ctx).gems;
  const blockId = blocks[0].id;

  it("注入 0.4×pitch 违规对 → 修复到 ≥ 0.999×pitch，且保数、留在掩码内", () => {
    const injA = { id: "inj-a", x: 24, y: 24, colorId: "", blockId, shapeId: "round" as const, diameterMm: 2.8 };
    const injB = { id: "inj-b", x: 24 + 0.4 * PITCH, y: 24, colorId: "", blockId, shapeId: "round" as const, diameterMm: 2.8 };
    // 保留远离注入点(>2.5×pitch)的基底钻：验证修复发生在真实钻场中且不扰动远场
    const far = base.filter((g) => Math.hypot(g.x - 24, g.y - 24) > 2.5 * PITCH);
    const before = [...far, injA, injB];
    const { gems, residual } = applyRepulsion(before, ctx);
    expect(residual.length).toBe(0);
    const a = gems.find((g) => g.id === "inj-a")!;
    const b = gems.find((g) => g.id === "inj-b")!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(PITCH * 0.999);
    expect(gems.length).toBe(before.length); // 斥力修复不丢钻
    expectInvariants(gems, blocks, PITCH, "repulsion-repair");
    expect(validate(gems, grid, blocks).filter((w) => w.kind === "spacing")).toEqual([]);
  });

  it("越掩码回弹：推向边界外时该步回滚（钻恒在掩码内）", () => {
    // 贴边对：一枚在掩码最右缘，一枚在界外 1px（构造上即将越界的推挤场景）
    const edge = 47;
    const injA = { id: "e-a", x: edge, y: 24, colorId: "", blockId, shapeId: "round" as const, diameterMm: 2.8 };
    const injB = { id: "e-b", x: edge - 3, y: 24, colorId: "", blockId, shapeId: "round" as const, diameterMm: 2.8 };
    const { gems } = applyRepulsion([...base, injA, injB], ctx);
    for (const g of gems) {
      const ix = Math.round(g.x);
      const iy = Math.round(g.y);
      expect(ix >= 0 && ix < 48 && iy >= 0 && iy < 48).toBe(true);
    }
  });
});

describe("boundary 1D Lloyd", () => {
  const blocks = segment(fixtureSolid(), SEG_OPTS);
  const grid = standardGrid();

  it("boundary-only 后不变量恒真（残余冲突由构造期消解兜底）", () => {
    const { gems, warnings } = layout(
      blocks,
      "hex-pitch",
      { density: 1, seed: 7, relax: { boundary: true, repulsion: false } },
      grid,
    );
    expectInvariants(gems, blocks, PITCH, "boundary-only");
    expect(warnings.filter((w) => w.kind === "spacing" || w.kind === "mask")).toEqual([]);
  });

  it("双钩子开启：不变量恒真且可导出", () => {
    const { gems, warnings } = layout(
      blocks,
      "hex-pitch",
      { density: 1, seed: 7, relax: { boundary: true, repulsion: true } },
      grid,
    );
    expectInvariants(gems, blocks, PITCH, "boundary+repulsion");
    expect(isExportable(warnings)).toBe(true);
  });
});
