/*
Orthogonal intents (max 5):
1. [2026-09-18 Contract] 引擎唯一公共类型面：UI 与测试只依赖本文件类型 + index.ts 出口（原始需求：design.md §2 深模块契约）。
2. [2026-09-18 Units] px↔mm 桥接落在 GridSpec.pixelsPerMm（design.md 未定义此桥，掩码/钻位坐标一律"像素中心整数制"——像素 (i,j) 的中心即坐标 (i,j)）。
3. [2026-09-18 Density] 密度双形态：全局标量或按块 Record（design.md 标量签名 × spec 块级密度的调和，Record 缺省块默认 1.0）。
4. [2026-09-18 Runtime] zod v4 schema 与类型同源导出（type-safe = runtime-safe，公共入参一律先 parse）。
*/

import { z } from "zod";

// ---------- SS 尺寸键（SS_TABLE 数值在 grid.ts） ----------
export const SS_KEYS = [
  "SS6",
  "SS8",
  "SS10",
  "SS12",
  "SS14",
  "SS16",
  "SS18",
  "SS20",
  "SS22",
  "SS26",
  "SS30",
  "SS34",
] as const;
export type SSKey = (typeof SS_KEYS)[number];

// ---------- 图像输入（结构兼容 DOM ImageData，node 测试可传普通对象） ----------
export interface EngineImage {
  width: number;
  height: number;
  /** RGBA，逐像素 4 字节，长度必须是 width*height*4 */
  data: Uint8ClampedArray | Uint8Array;
}

// ---------- 分块 ----------
/** 块位掩码：bbox 局部坐标（全局像素 (x,y) → 局部 (x-bbox.x, y-bbox.y)），1 = 属于块 */
export interface Mask2D {
  w: number;
  h: number;
  bits: Uint8Array;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BlockType = "fill" | "linear" | "element";

export interface Block {
  id: string;
  label: string;
  mask: Mask2D;
  /** 块代表色（成员像素 Lab 逐通道中位 → sRGB） */
  colorRgb: [number, number, number];
  areaPx: number;
  bbox: BBox;
  /** 距离变换宽度统计（2×到背景的距离，形状宽度近似） */
  widthPx: { max: number; mean: number };
  /** 宽度/面积阈值推断的建议类型，用户可覆写后送 layout */
  suggested: BlockType;
}

// ---------- 钻位 ----------
export interface Gem {
  id: string;
  x: number;
  y: number;
  /** mapColors 写入的色板条目 id；空串 = 未映射 */
  colorId: string;
  blockId: string;
}

export const STRATEGY_IDS = ["hex-thin", "hex-pitch", "poisson", "hybrid", "cvt"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

// ---------- 网格（pitch 推导见 grid.ts） ----------
export interface GridSpec {
  ss: SSKey;
  /** 钻心最小间距（mm）= 钻径 + gap */
  pitchMm: number;
  /** 冻结为 0：行向水平全局一致（实证裁决，不允许其它值） */
  rowAngleDeg: 0;
  /** 像素/毫米，mm↔px 唯一换算系数 */
  pixelsPerMm: number;
}

// ---------- 布局 ----------
export type DensitySpec = number | Record<string, number>;

export interface LayoutResult {
  gems: Gem[];
  warnings: Warning[];
  /** 被确定性冲突消解（enforceMinDistance）剔除的钻计数（N4 可视化用；默认路径应为 0） */
  dropped?: number;
}

export interface Warning {
  kind: "spacing" | "island" | "mask";
  detail: string;
}

// ---------- 色板 ----------
export interface PaletteColor {
  id: string;
  /** 中文名（BOM/图例用） */
  name: string;
  hex: string;
}
export type Palette = PaletteColor[];

// ---------- zod schemas（公共入参的运行时契约） ----------
const unit = z.number().positive().max(1);
const positiveInt = z.number().int().positive();

export const GridSpecSchema = z.object({
  ss: z.enum(SS_KEYS),
  pitchMm: z.number().positive(),
  rowAngleDeg: z.literal(0),
  pixelsPerMm: z.number().positive(),
});

export const StrategyIdSchema = z.enum(STRATEGY_IDS);

export const LayoutOptionsSchema = z.object({
  density: z.union([unit, z.record(z.string(), unit)]).default(1),
  seed: z.number().int().nonnegative().default(1),
  relax: z
    .object({
      boundary: z.boolean().default(false),
      repulsion: z.boolean().default(false),
    })
    .default({ boundary: false, repulsion: false }),
});
export type LayoutOptions = z.input<typeof LayoutOptionsSchema>;

export const SegmentOptionsSchema = z.object({
  /** 量化色数 k，可配 6..10（实证调色板收敛 5~8 色） */
  k: z.number().int().min(6).max(10).default(8),
  seed: z.number().int().nonnegative().default(1),
  /** 钻直径（px），类型推断阈值用（<3 钻径宽 → linear；面积 < 单钻足迹 → element） */
  gemDiameterPx: z.number().positive(),
  /** 连通域最小面积，小于此的组件丢弃（噪点抑制） */
  minAreaPx: positiveInt.default(12),
});
export type SegmentOptions = z.input<typeof SegmentOptionsSchema>;

export const EngineImageSchema = z.object({
  width: positiveInt,
  height: positiveInt,
  data: z.union([z.instanceof(Uint8ClampedArray), z.instanceof(Uint8Array)]),
});
