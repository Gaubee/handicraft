/*
Orthogonal intents (max 3):
1. [2026-09-18 Export] exportSvg/exportBom：分层 SVG（按色 <g> 分组、viewBox=图像尺寸，块边界可选）与 BOM CSV——模板生产流交付物（tech-research §3.3）。
2. [2026-09-20 gem-catalog 1.3] 逐钻规格渲染：round circle 快路径保留；异形按目录 vectorPath
   （归一化单位框 0..1 × diameterMm×pixelsPerMm 缩放）；custom `<image>` dataUrl 引用
   （并存导出优先矢量）；custom 资产未解析 = 占位渲染（data-missing 标记——导出前置由
   exportGate missing-asset 面硬阻断，本层不静默降级）。BOM 聚合键 colorId → canonical
   `specKey×colorId`（表头 规格,形状,尺寸,色名,hex,数量；同规格不同自定义资产 assetId 区分行）。
3. [2026-09-18 Contract] design.md §2 签名的落地出口；width/height/palette 为必要扩展（viewBox 与填色所需，design 未列，报告已注记）。
*/

import { gemShapeDisplayName, gemSpecIdentityOf } from "./catalog";
import { baseSpecDiameterMm, gemRadiusPx } from "./grid";
import { traceContour } from "./ops";
import { findPaletteColor } from "./palette";
import type { Block, Gem, GemSpecFields, GridSpec, LayoutResult, Palette } from "./types";
import { GridSpecSchema } from "./types";

/** 逐钻形渲染数据（内存目录解析产物——素材库 .gemshape 真源经 hydrate；并存时矢量优先）。 */
export interface GemshapeRenderData {
  /** 归一化 SVG path（单位框 0..1）——渲染加速与清晰矢量导出的优先路径 */
  vectorPath?: string;
  /** 贴图 dataUrl（custom 资产 `<image>` 引用） */
  image?: { dataUrl: string; width: number; height: number };
}

/**
 * 形目录解析回调（运行时接线归 2.2 vertical slice / studio gate——engine gate 交付纯函数面）：
 * 返回 undefined = 该钻无可解析目录条目（builtin 非 round 按圆包络占位；custom 记 missing 标记）。
 */
export type ShapeResolver = (gem: Gem & GemSpecFields) => GemshapeRenderData | undefined;

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
  /** 可选：逐钻形目录解析（异形矢量/贴图渲染 + custom missing 标记——gem-catalog 1.3）。 */
  resolveShape?: ShapeResolver;
}

/** BOM 可选项（gem-catalog 1.3）：形目录解析——custom 资产未解析时规格列标注 missing（gate 6 清单标注面）。 */
export interface BomOptions {
  resolveShape?: ShapeResolver;
}

/** 未映射/色板缺失时的占位色 */
const FALLBACK_FILL = "#9CA3AF";

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** SVG 字符串构造（测试与 Blob 包装共用；圆点数 ≡ 钻数——逐钻规格渲染，round 走 circle 快路径）。 */
export function buildSvg(gems: (Gem & GemSpecFields)[], grid: GridSpec, opts: SvgExportOptions): string {
  const g = GridSpecSchema.parse(grid);
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
  // 按色分组（colorId 排序，确定性）；组内逐钻按规格渲染
  const groups = new Map<string, (Gem & GemSpecFields)[]>();
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
      lines.push(renderGem(gem, g, opts.resolveShape));
    }
    lines.push(`</g>`);
  }
  lines.push(`</svg>`);
  return lines.join("\n");
}

/** 逐钻 SVG 元素（像素中心坐标 → SVG 栅格空间 +0.5；确定性字符串）。 */
function renderGem(
  gem: Gem & GemSpecFields,
  grid: GridSpec,
  resolveShape: ShapeResolver | undefined,
): string {
  const cx = (gem.x + 0.5).toFixed(2);
  const cy = (gem.y + 0.5).toFixed(2);
  const shapeId = gem.shapeId ?? "round";
  const diameterMm = gem.diameterMm ?? baseSpecDiameterMm(grid);

  // round：circle 快路径（v1 行为保留——半径/坐标字符串逐位不变）
  if (shapeId === "round") {
    const r = gemRadiusPx({ shapeId, diameterMm }, grid).toFixed(2);
    return `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  }

  const entry = resolveShape?.(gem);
  // custom 资产未解析：占位渲染（虚线圆包络 + data-missing 标记；导出前置由 exportGate 硬阻断）
  if (shapeId === "custom" && (entry === undefined || (entry.vectorPath === undefined && entry.image === undefined))) {
    const r = gemRadiusPx({ shapeId, diameterMm }, grid).toFixed(2);
    const assetId = gem.assetId ?? "unknown";
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill-opacity="0.35" stroke="${FALLBACK_FILL}" stroke-dasharray="2 2" data-gemshape-missing="${assetId}"/>`;
  }
  // 异形矢量（并存优先 vectorPath——清晰矢量优于贴图缩放）：单位框 path × diameterMm×ppm 缩放
  if (entry?.vectorPath !== undefined) {
    const s = diameterMm * grid.pixelsPerMm;
    const half = s / 2;
    const rotate = gem.rotationDeg !== undefined ? ` rotate(${gem.rotationDeg} ${half} ${half})` : "";
    return (
      `<path d="${entry.vectorPath}" ` +
      `transform="translate(${(gem.x + 0.5 - half).toFixed(2)} ${(gem.y + 0.5 - half).toFixed(2)})${rotate} scale(${s} ${s})"/>`
    );
  }
  // custom 贴图：`<image>` dataUrl 引用（旋转绕钻心）
  if (entry?.image !== undefined) {
    const s = diameterMm * grid.pixelsPerMm;
    const x = (gem.x + 0.5 - s / 2).toFixed(2);
    const y = (gem.y + 0.5 - s / 2).toFixed(2);
    const rotate =
      gem.rotationDeg !== undefined ? ` transform="rotate(${gem.rotationDeg} ${cx} ${cy})"` : "";
    return `<image href="${entry.image.dataUrl}" x="${x}" y="${y}" width="${s}" height="${s}"${rotate}/>`;
  }
  // builtin 非 round 且目录未解析（sys-shapes seed 数据归 2.1 接线）：圆包络占位渲染（最大径）
  const r = gemRadiusPx({ shapeId, diameterMm }, grid).toFixed(2);
  return `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
}

/** BOM CSV 字符串构造（UTF-8 BOM 前缀便于 Excel 中文；聚合键 canonical specKey×colorId；合计行 = 钻总数）。 */
export function buildBom(
  gems: (Gem & GemSpecFields)[],
  palette: Palette,
  grid: GridSpec,
  opts?: BomOptions,
): string {
  const g = GridSpecSchema.parse(grid);
  // 单遍聚合：key = specKey × colorId（NUL 分隔——规格键与色 id 均不含 NUL）；行元数据取首遇样本
  interface BomRow {
    count: number;
    identity: ReturnType<typeof gemSpecIdentityOf>;
    colorId: string;
    missing: boolean;
  }
  const rowsByKey = new Map<string, BomRow>();
  for (const gem of gems) {
    const identity = gemSpecIdentityOf(gem, g);
    const key = `${identity.specKey}\u0000${gem.colorId}`;
    const existing = rowsByKey.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    const entry = opts?.resolveShape?.(gem);
    const missing =
      identity.shapeId === "custom" &&
      (entry === undefined || (entry.vectorPath === undefined && entry.image === undefined));
    rowsByKey.set(key, { count: 1, identity, colorId: gem.colorId, missing });
  }
  const out: string[] = ["规格,形状,尺寸,色名,hex,数量"];
  const sorted = [...rowsByKey.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
  for (const [, row] of sorted) {
    const entry = findPaletteColor(palette, row.colorId);
    const name = entry ? entry.name : row.colorId || "未映射";
    const hex = entry ? entry.hex : FALLBACK_FILL;
    const missingMark = row.missing ? "（资产缺失）" : "";
    out.push(
      `${row.identity.specKey}${missingMark},${gemShapeDisplayName(row.identity.shapeId)},${row.identity.sizeLabel},${name},${hex},${row.count}`,
    );
  }
  out.push(`合计,,,,,${gems.length}`);
  return "\uFEFF" + out.join("\r\n") + "\r\n";
}

export function exportSvg(
  result: LayoutResult,
  grid: GridSpec,
  opts: SvgExportOptions,
): Blob {
  return new Blob([buildSvg(result.gems, grid, opts)], { type: "image/svg+xml" });
}

export function exportBom(result: LayoutResult, palette: Palette, grid: GridSpec, opts?: BomOptions): Blob {
  return new Blob([buildBom(result.gems, palette, grid, opts)], { type: "text/csv;charset=utf-8" });
}
