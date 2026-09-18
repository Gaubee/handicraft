/*
Orthogonal intents (max 2):
1. [2026-09-18 Palette] 内置起步色板（红/金/象牙白/橄榄绿/黑，实证样本调色板收敛 5~6 色）+ 增删改操作。
2. [2026-09-18 Extensibility] Palette 是普通可变数组：真实供应商色卡数字化后直接替换/追加（tech-research §3.2）。
*/

import type { Palette, PaletteColor } from "./types";

/** 起步色板：hex 用于渲染与 ΔE（sRGB→Lab 在 color.ts） */
export const STARTER_PALETTE: Palette = [
  { id: "red", name: "红", hex: "#C8102E" },
  { id: "gold", name: "金", hex: "#D4A017" },
  { id: "ivory", name: "象牙白", hex: "#FFFFF0" },
  { id: "olive", name: "橄榄绿", hex: "#556B2F" },
  { id: "black", name: "黑", hex: "#1A1A1A" },
];

/** 增/改：按 id 覆写，无则追加 */
export function upsertPaletteColor(palette: Palette, color: PaletteColor): void {
  const i = palette.findIndex((c) => c.id === color.id);
  if (i >= 0) {
    palette[i] = color;
  } else {
    palette.push(color);
  }
}

/** 删：按 id 移除，返回是否确实删除 */
export function removePaletteColor(palette: Palette, id: string): boolean {
  const i = palette.findIndex((c) => c.id === id);
  if (i < 0) return false;
  palette.splice(i, 1);
  return true;
}

/** 按 id 查（BOM/SVG 渲染回查） */
export function findPaletteColor(palette: Palette, id: string): PaletteColor | undefined {
  return palette.find((c) => c.id === id);
}
