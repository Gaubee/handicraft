/*
Orthogonal intents (max 3):
1. [2026-09-18 Export] exportSvg/exportBom：分层 SVG（按色 <g><circle>，viewBox=图像尺寸，块边界可选）与 BOM CSV（色名,hex,ss,数量 + 合计行）——模板生产流交付物（tech-research §3.3）。
2. [2026-09-18 Contract] design.md §2 签名的落地出口；width/height/palette 为必要扩展（viewBox 与填色所需，design 未列，报告已注记）。
*/

import { gemRadiusPx } from "./grid";
import { traceContour } from "./ops";
import { findPaletteColor } from "./palette";
import type { Block, Gem, GridSpec, LayoutResult, Palette } from "./types";
import { GridSpecSchema } from "./types";

export interface SvgExportOptions {
  /** 图像像素尺寸（viewBox） */
  width: number;
  height: number;
  /** 钻色 hex 回查；未映射 colorId 回退灰阶占位 */
  palette: Palette;
  /** 可选：画块边界轮廓（模板对位用） */
  showBoundaries?: boolean;
  blocks?: Block[];
  background?: string;
}

/** 未映射/色板缺失时的占位色 */
const FALLBACK_FILL = "#9CA3AF";

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** SVG 字符串构造（测试与 Blob 包装共用；圆点数 ≡ 钻数） */
export function buildSvg(gems: Gem[], grid: GridSpec, opts: SvgExportOptions): string {
  const g = GridSpecSchema.parse(grid);
  const r = gemRadiusPx(g);
  const { width, height, palette } = opts;
  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  );
  if (opts.background) {
    lines.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${opts.background}"/>`);
  }
  if (opts.showBoundaries && opts.blocks) {
    lines.push(`<g fill="none" stroke="#00000033" stroke-width="1" data-layer="block-boundaries">`);
    for (const block of opts.blocks) {
      const contour = traceContour(block.mask);
      if (contour.length === 0) continue;
      const pts = contour
        .map((p) => `${block.bbox.x + p.x + 0.5},${block.bbox.y + p.y + 0.5}`)
        .join(" ");
      lines.push(`<polygon points="${pts}"/>`);
    }
    lines.push(`</g>`);
  }
  // 按色分组（colorId 排序，确定性）
  const groups = new Map<string, Gem[]>();
  for (const gem of gems) {
    const arr = groups.get(gem.colorId);
    if (arr) arr.push(gem);
    else groups.set(gem.colorId, [gem]);
  }
  const blockById = new Map((opts.blocks ?? []).map((b) => [b.id, b] as const));
  for (const colorId of [...groups.keys()].sort()) {
    const members = groups.get(colorId)!;
    const entry = findPaletteColor(palette, colorId);
    let fill = FALLBACK_FILL;
    if (entry) {
      fill = entry.hex;
    } else {
      // 未映射：用块代表色（mapColors 前的预览）
      const block = blockById.get(members[0].blockId);
      if (block) fill = rgbToHex(block.colorRgb);
    }
    lines.push(`<g fill="${fill}" data-color-id="${colorId}">`);
    for (const gem of members) {
      // 像素中心坐标 → SVG 栅格空间（+0.5）
      lines.push(
        `<circle cx="${(gem.x + 0.5).toFixed(2)}" cy="${(gem.y + 0.5).toFixed(2)}" r="${r.toFixed(2)}"/>`,
      );
    }
    lines.push(`</g>`);
  }
  lines.push(`</svg>`);
  return lines.join("\n");
}

/** BOM CSV 字符串构造（UTF-8 BOM 前缀便于 Excel 中文；合计行 = 钻总数） */
export function buildBom(gems: Gem[], palette: Palette, grid: GridSpec): string {
  const g = GridSpecSchema.parse(grid);
  const counts = new Map<string, number>();
  for (const gem of gems) counts.set(gem.colorId, (counts.get(gem.colorId) ?? 0) + 1);
  const rows: string[] = ["色名,hex,ss,数量"];
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [colorId, count] of sorted) {
    const entry = findPaletteColor(palette, colorId);
    const name = entry ? entry.name : colorId || "未映射";
    const hex = entry ? entry.hex : FALLBACK_FILL;
    rows.push(`${name},${hex},${g.ss},${count}`);
  }
  rows.push(`合计,,${g.ss},${gems.length}`);
  return "\uFEFF" + rows.join("\r\n") + "\r\n";
}

export function exportSvg(
  result: LayoutResult,
  grid: GridSpec,
  opts: SvgExportOptions,
): Blob {
  return new Blob([buildSvg(result.gems, grid, opts)], { type: "image/svg+xml" });
}

export function exportBom(result: LayoutResult, palette: Palette, grid: GridSpec): Blob {
  return new Blob([buildBom(result.gems, palette, grid)], { type: "text/csv;charset=utf-8" });
}
