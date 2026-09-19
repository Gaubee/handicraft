/*
[2026-09-18 Test] tasks 2.4：mapColors Lab ΔE 最近邻断言、色板增删改、exportSvg 圆点数=钻数、exportBom 合计=钻数。
*/

import { describe, expect, it } from "vitest";
import {
  buildBom,
  buildSvg,
  deltaE76,
  exportBom,
  exportSvg,
  labFromRgb,
  mapColors,
  removePaletteColor,
  STARTER_PALETTE,
  upsertPaletteColor,
  type Block,
  type Gem,
  type GridSpec,
  type Palette,
} from "$lib/engine";
import { standardGrid } from "./helpers";

function makeBlock(id: string, rgb: [number, number, number], w = 10, h = 10): Block {
  return {
    id,
    label: id,
    mask: { w, h, bits: new Uint8Array(w * h).fill(1) },
    colorRgb: rgb,
    areaPx: w * h,
    bbox: { x: 0, y: 0, w, h },
    widthPx: { max: w, mean: w },
    suggested: "fill",
  };
}

function makeGems(block: Block, n: number): Gem[] {
  const gems: Gem[] = [];
  for (let i = 0; i < n; i++) {
    gems.push({ id: `t${i}`, x: (i % 5) * 2, y: Math.floor(i / 5) * 2, colorId: "", blockId: block.id });
  }
  return gems;
}

describe("mapColors（Lab ΔE CIE76 最近邻）", () => {
  const cases: Array<[[number, number, number], string]> = [
    [[255, 0, 0], "red"], // 纯红 → 红
    [[212, 175, 55], "gold"], // 金 → 金
    [[250, 250, 245], "ivory"], // 近白 → 象牙白
    [[85, 107, 47], "olive"], // 橄榄绿 → 橄榄绿
    [[10, 10, 10], "black"], // 近黑 → 黑
  ];
  it.each(cases)("块色 %j → %s", (rgb: [number, number, number], expectId: string) => {
    const block = makeBlock("b", rgb);
    const gems = makeGems(block, 3);
    mapColors(gems, [block], STARTER_PALETTE);
    expect(gems.every((g) => g.colorId === expectId)).toBe(true);
  });

  it("纯红与红的 ΔE 小于与黑的 ΔE（匹配合理性）", () => {
    const red = labFromRgb(255, 0, 0);
    const palRed = STARTER_PALETTE.find((c) => c.id === "red")!;
    const labRed = labFromRgb(
      Number.parseInt(palRed.hex.slice(1, 3), 16),
      Number.parseInt(palRed.hex.slice(3, 5), 16),
      Number.parseInt(palRed.hex.slice(5, 7), 16),
    );
    const labBlack = labFromRgb(0x1a, 0x1a, 0x1a);
    expect(deltaE76(red, labRed)).toBeLessThan(deltaE76(red, labBlack));
  });

  it("空色板抛错", () => {
    const block = makeBlock("b", [255, 0, 0]);
    const gems = makeGems(block, 1);
    expect(() => mapColors(gems, [block], [])).toThrow();
  });
});

describe("色板增删改", () => {
  it("upsert 追加与覆写、remove 删除", () => {
    const palette: Palette = [...STARTER_PALETTE];
    upsertPaletteColor(palette, { id: "navy", name: "藏青", hex: "#1B2A4A" });
    expect(palette).toHaveLength(6);
    upsertPaletteColor(palette, { id: "navy", name: "深藏青", hex: "#14213D" });
    expect(palette).toHaveLength(6);
    expect(palette.find((c) => c.id === "navy")!.name).toBe("深藏青");
    expect(removePaletteColor(palette, "navy")).toBe(true);
    expect(palette).toHaveLength(5);
    expect(removePaletteColor(palette, "navy")).toBe(false);
  });
});

describe("导出", () => {
  const grid: GridSpec = standardGrid();
  const redBlock = makeBlock("red-b", [200, 16, 46]);
  const blackBlock = makeBlock("black-b", [26, 26, 26]);
  const goldBlock = makeBlock("gold-b", [212, 175, 55]);
  const gems: Gem[] = [
    ...makeGems(redBlock, 5),
    ...makeGems(blackBlock, 4),
    ...makeGems(goldBlock, 3),
  ];
  mapColors(gems, [redBlock, blackBlock, goldBlock], STARTER_PALETTE);

  it("SVG 圆点数 = 钻数，按色分组", () => {
    const svg = buildSvg(gems, grid, { width: 100, height: 80, palette: STARTER_PALETTE });
    expect((svg.match(/<circle /g) ?? []).length).toBe(12);
    expect((svg.match(/<g fill=/g) ?? []).length).toBe(3);
    expect(svg).toContain('viewBox="0 0 100 80"');
    expect(svg).toContain('fill="#C8102E"');
  });

  it("BOM 合计 = 钻数，行数 = 色数 + 表头 + 合计（gem-catalog 1.3 新表头/聚合键）", () => {
    const csv = buildBom(gems, STARTER_PALETTE, grid);
    const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("规格,形状,尺寸,色名,hex,数量");
    expect(lines).toHaveLength(5); // 表头 + 3 色 + 合计
    const total = lines[lines.length - 1];
    expect(total.startsWith("合计,,,,,")).toBe(true);
    expect(Number(total.split(",")[5])).toBe(12);
    const sum = lines.slice(1, -1).reduce((s, l) => s + Number(l.split(",")[5]), 0);
    expect(sum).toBe(12);
    // v1 圆钻（无规格字段）按 grid 基准规格派生 → round-ss10 行
    expect(lines[1].startsWith("round-ss10,圆钻,SS10,")).toBe(true);
  });

  it("Blob 包装（exportSvg/exportBom）", () => {
    const svgBlob = exportSvg({ gems, warnings: [] }, grid, {
      width: 100,
      height: 80,
      palette: STARTER_PALETTE,
    });
    const bomBlob = exportBom({ gems, warnings: [] }, STARTER_PALETTE, grid);
    expect(svgBlob).toBeInstanceOf(Blob);
    expect(bomBlob).toBeInstanceOf(Blob);
    expect(svgBlob.size).toBeGreaterThan(0);
    expect(bomBlob.size).toBeGreaterThan(0);
  });
});
