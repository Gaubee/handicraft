/*
[2026-09-19 Test] add-manual-edit-mode task 1.3：编辑器色板删除语义。
被引用色禁删（badge 显示引用数）、孤儿色（无钻引用）可删；色不在色板中无可删之物。
getPaletteUsage/countPaletteUsage/canRemovePaletteColor 均结构化最小约束——Gem[] 与 EditGem[] 通用。
*/

import { describe, expect, it } from "vitest";
import {
  canRemovePaletteColor,
  countPaletteUsage,
  getPaletteUsage,
  STARTER_PALETTE,
  toEditGem,
  type Gem,
} from "$lib/engine";

const gems: Gem[] = [
  { id: "g-1", x: 0, y: 0, colorId: "red", blockId: "blk-a" },
  { id: "g-2", x: 8, y: 0, colorId: "red", blockId: "blk-a" },
  { id: "g-3", x: 16, y: 0, colorId: "gold", blockId: "blk-a" },
];

describe("getPaletteUsage / countPaletteUsage", () => {
  it("按 colorId 计数；未引用色不出现在结果中", () => {
    expect(getPaletteUsage(gems)).toEqual({ red: 2, gold: 1 });
  });

  it("空钻集 → 空记录（全员孤儿）", () => {
    expect(getPaletteUsage([])).toEqual({});
  });

  it("countPaletteUsage：被引用返回计数、未引用返回 0（badge 数据源）", () => {
    expect(countPaletteUsage(gems, "red")).toBe(2);
    expect(countPaletteUsage(gems, "ivory")).toBe(0);
  });

  it("EditGem[] 同样适用（结构化约束，含 colorId 为空串的未映射钻）", () => {
    const editGems = gems.map(toEditGem).concat({
      id: "m-1", x: 1, y: 1, colorId: "", blockId: null, origin: "manual", moved: false,
    });
    expect(getPaletteUsage(editGems)).toEqual({ red: 2, gold: 1, "": 1 });
  });
});

describe("canRemovePaletteColor：删除门", () => {
  it("被引用色禁删（red 有 2 钻引用）", () => {
    expect(canRemovePaletteColor(STARTER_PALETTE, gems, "red")).toBe(false);
  });

  it("孤儿色可删（ivory 在色板中且无钻引用）", () => {
    expect(canRemovePaletteColor(STARTER_PALETTE, gems, "ivory")).toBe(true);
  });

  it("空钻集 → 色板全员可删", () => {
    for (const c of STARTER_PALETTE) {
      expect(canRemovePaletteColor(STARTER_PALETTE, [], c.id)).toBe(true);
    }
  });

  it("色不在色板中 → false（无可删之物）", () => {
    expect(canRemovePaletteColor(STARTER_PALETTE, gems, "no-such-color")).toBe(false);
  });

  it("与 removePaletteColor 语义衔接：删孤儿后该 id 转为不在色板中", () => {
    const palette = [...STARTER_PALETTE];
    expect(canRemovePaletteColor(palette, gems, "ivory")).toBe(true);
    expect(palette.filter((c) => c.id === "ivory")).toHaveLength(1);
    expect(canRemovePaletteColor(palette, [], "ivory")).toBe(true);
  });
});
