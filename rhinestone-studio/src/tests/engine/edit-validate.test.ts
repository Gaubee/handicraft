/*
[2026-09-19 Test] add-manual-edit-mode task 1.2：编辑器双层校验。
spacing=物理硬门（恒查、阻断导出）；mask-hint=归属提示（仅 origin='layout' 且 !moved 的来源钻，
手工钻/移动钻豁免，不阻断导出）；blocks 缺省时只查 spacing。
*/

import { describe, expect, it } from "vitest";
import {
  gridFromSs,
  isExportableEditable,
  validateEditable,
  type Block,
  type EditGem,
  type EditWarning,
} from "$lib/engine";

const grid = gridFromSs("SS10", 2.5); // pitch 8px（阈值 8×0.999=7.992）

function egem(id: string, x: number, y: number, over?: Partial<EditGem>): EditGem {
  return { id, x, y, colorId: "red", blockId: "blk-a", origin: "layout", moved: false, ...over };
}

function rectBlock(id: string, x: number, y: number, w: number, h: number, holes: Array<[number, number]> = []): Block {
  const bits = new Uint8Array(w * h).fill(1);
  for (const [hx, hy] of holes) bits[hy * w + hx] = 0;
  return {
    id,
    label: id,
    mask: { w, h, bits },
    colorRgb: [200, 16, 46],
    areaPx: w * h,
    bbox: { x, y, w, h },
    widthPx: { max: Math.min(w, h), mean: Math.min(w, h) },
    suggested: "fill",
  };
}

describe("validateEditable：spacing 物理硬门（恒查）", () => {
  it("中心距 < pitch×0.999 → spacing，gemIds 为冲突对", () => {
    const warnings = validateEditable([egem("g-1", 0, 0), egem("g-2", 7, 0)], grid);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("spacing");
    expect(warnings[0].gemIds).toEqual(["g-1", "g-2"]);
    expect(warnings[0].detail).toContain("g-1");
    expect(warnings[0].detail).toContain("g-2");
  });

  it("恰好等于 pitch → 无 warning", () => {
    expect(validateEditable([egem("g-1", 0, 0), egem("g-2", 8, 0)], grid)).toEqual([]);
  });

  it("spacing 阻断导出（isExportableEditable=false），即使只有一项", () => {
    const warnings = validateEditable([egem("g-1", 0, 0), egem("g-2", 3, 4)], grid); // d=5 < 7.992
    expect(warnings.some((w) => w.kind === "spacing")).toBe(true);
    expect(isExportableEditable(warnings)).toBe(false);
  });

  it("无违规 → isExportableEditable=true", () => {
    expect(isExportableEditable(validateEditable([egem("g-1", 0, 0), egem("g-2", 8, 0)], grid))).toBe(true);
  });
});

describe("validateEditable：mask-hint 归属层（提示级）", () => {
  const blocks = [rectBlock("blk-a", 0, 0, 10, 10)];

  it("unmoved 来源钻钻心越出掩码 → mask-hint，不阻断导出", () => {
    const warnings = validateEditable([egem("g-1", 20, 20)], grid, blocks);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("mask-hint");
    expect(warnings[0].gemIds).toEqual(["g-1"]);
    expect(isExportableEditable(warnings)).toBe(true);
  });

  it("钻心落在掩码孔洞上 → mask-hint", () => {
    const holed = [rectBlock("blk-a", 0, 0, 10, 10, [[5, 5]])];
    const warnings = validateEditable([egem("g-1", 5, 5)], grid, holed);
    expect(warnings.map((w) => w.kind)).toEqual(["mask-hint"]);
  });

  it("钻心在掩码内 → 无 warning", () => {
    expect(validateEditable([egem("g-1", 5, 5)], grid, blocks)).toEqual([]);
  });

  it("手工钻（origin='manual'）豁免 mask 检查——即使 blockId 指向块", () => {
    const warnings = validateEditable(
      [egem("m-1", 20, 20, { origin: "manual", blockId: "blk-a" })],
      grid,
      blocks,
    );
    expect(warnings).toEqual([]);
  });

  it("移动钻（moved=true）豁免 mask 检查", () => {
    const warnings = validateEditable([egem("g-1", 20, 20, { moved: true })], grid, blocks);
    expect(warnings).toEqual([]);
  });

  it("来源钻引用不存在的块 → mask-hint", () => {
    const warnings = validateEditable([egem("g-1", 5, 5, { blockId: "blk-x" })], grid, blocks);
    expect(warnings.map((w) => w.kind)).toEqual(["mask-hint"]);
    expect(warnings[0].detail).toContain("blk-x");
  });

  it("mask-hint 不阻断导出（与 spacing 并存时仅 spacing 阻断）", () => {
    const warnings = validateEditable(
      [egem("g-1", 20, 20), egem("g-2", 22, 20)], // 双双越掩码 + 相互间距 2px
      grid,
      blocks,
    );
    expect(warnings.map((w) => w.kind).sort()).toEqual(["mask-hint", "mask-hint", "spacing"]);
    expect(isExportableEditable(warnings)).toBe(false);
  });
});

describe("validateEditable：blocks 缺省 → 只有 spacing 层", () => {
  it("不传 blocks 时越界钻不产生任何 warning", () => {
    expect(validateEditable([egem("g-1", 500, 500)], grid)).toEqual([]);
  });

  it("不传 blocks 时 spacing 照查（含手工钻）", () => {
    const warnings = validateEditable(
      [egem("m-1", 0, 0, { origin: "manual", blockId: null }), egem("g-1", 1, 0)],
      grid,
    );
    expect(warnings.map((w: EditWarning) => w.kind)).toEqual(["spacing"]);
  });
});

describe("validateEditable：与工作台 validate 零影响（并存不干扰）", () => {
  it("spacing 判定口径与 validate 一致（阈值 = pitch×0.999 = 7.992）", () => {
    const below = [egem("g-1", 0, 0), egem("g-2", 7.99, 0)]; // 7.99 < 7.992
    expect(validateEditable(below, grid).some((w) => w.kind === "spacing")).toBe(true);
    const above = [egem("g-1", 0, 0), egem("g-2", 7.993, 0)]; // 7.993 > 7.992
    expect(validateEditable(above, grid)).toEqual([]);
  });
});
