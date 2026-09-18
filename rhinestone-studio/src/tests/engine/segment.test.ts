/*
[2026-09-18 Test] tasks 2.1：合成图像分块数与块属性断言（面积/bbox/中位色/宽度统计/类型推断/确定性）。
*/

import { describe, expect, it } from "vitest";
import { segment } from "$lib/engine";
import { fixtureShapes, SEG_OPTS } from "./helpers";

function serialize(blocks: ReturnType<typeof segment>): string {
  return JSON.stringify(blocks, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
}

describe("segment 分块", () => {
  const blocks = segment(fixtureShapes(), SEG_OPTS);

  it("五色图 → 6 个块（外背景/环内孔/方/环/线/孤点——圆环围出的孔洞是独立 4-连通域）", () => {
    expect(blocks.length).toBe(6);
  });

  it("40×40 红方 → fill，面积与中位色精确", () => {
    const square = blocks.find((b) => b.areaPx === 40 * 40);
    expect(square).toBeDefined();
    expect(square!.suggested).toBe("fill");
    expect(square!.bbox).toEqual({ x: 10, y: 10, w: 40, h: 40 });
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(square!.colorRgb[c] - [200, 16, 46][c])).toBeLessThanOrEqual(6);
    }
  });

  it("3px 细线 → linear，宽度统计远小于面块", () => {
    const square = blocks.find((b) => b.areaPx === 1600)!;
    const line = blocks.find((b) => b.suggested === "linear" && b.colorRgb[1] > b.colorRgb[2]); // 绿色线（G>B）
    expect(line).toBeDefined();
    // 3px 线：DT 最大 2 → width.max ≈ 4（±1 浮点）
    expect(line!.widthPx.max).toBeLessThan(7);
    expect(line!.widthPx.mean).toBeLessThan(square.widthPx.mean);
    expect(square.suggested).toBe("fill");
  });

  it("12px 宽圆环 → linear（宽 < 3 钻径 = 21px）", () => {
    const ring = blocks.find((b) => b.suggested === "linear" && b.colorRgb[0] < 60);
    expect(ring).toBeDefined();
    expect(ring!.widthPx.max).toBeGreaterThan(10);
    expect(ring!.widthPx.max).toBeLessThan(21);
  });

  it("4×4 孤点 → element（面积 < 单钻足迹 ≈38px）", () => {
    const dot = blocks.find((b) => b.areaPx === 16);
    expect(dot).toBeDefined();
    expect(dot!.suggested).toBe("element");
  });

  it("背景大块 → fill 且面积极大（环内孔另成一块）", () => {
    const bg = blocks.reduce((a, b) => (a.areaPx > b.areaPx ? a : b));
    expect(bg.suggested).toBe("fill");
    expect(bg.areaPx).toBeGreaterThan(9_000);
    // 环内孔（π×18² ≈ 1017px，象牙色，独立连通域）
    const hole = blocks.find((b) => b.areaPx > 900 && b.areaPx < 1200);
    expect(hole).toBeDefined();
    expect(hole!.suggested).toBe("fill");
  });

  it("同 seed 重放逐位相同（确定性）", () => {
    const again = segment(fixtureShapes(), SEG_OPTS);
    expect(serialize(again)).toBe(serialize(blocks));
  });
});
