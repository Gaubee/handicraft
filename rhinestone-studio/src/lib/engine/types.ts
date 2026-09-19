/*
Orthogonal intents (max 5):
1. [2026-09-18 Contract] 引擎唯一公共类型面：UI 与测试只依赖本文件类型 + index.ts 出口（原始需求：design.md §2 深模块契约）。
2. [2026-09-18 Units] px↔mm 桥接落在 GridSpec.pixelsPerMm（design.md 未定义此桥，掩码/钻位坐标一律"像素中心整数制"——像素 (i,j) 的中心即坐标 (i,j)）。
3. [2026-09-18 Density] 密度双形态：全局标量或按块 Record（design.md 标量签名 × spec 块级密度的调和，Record 缺省块默认 1.0）。
4. [2026-09-18 Runtime] zod v4 schema 与类型同源导出（type-safe = runtime-safe，公共入参一律先 parse）。
*/

import { z } from "zod";

// ---------- SS 尺寸键（SS_TABLE 数值在 grid.ts） ----------
/**
 * [2026-09-20 gem-catalog 2.1] SS24 补档入列（SS22→SS26 原跳档；行业标准 SS24≈5.3mm，中置信）。
 * 纪律（design §3.1）：同参同出——既有档位（SS6..SS34 除 24）的参数输出逐位不变，仅新增
 * 可选档位，按 version.ts bump 纪律**不构成强制 ENGINE_VERSION bump**（登记于 grid.ts SS_TABLE）。
 */
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
  "SS24",
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
/**
 * [gem-catalog engine gate 1.4] 规格物化字段落地（design §2.3）：shapeId/diameterMm 必填、
 * rotationDeg?/assetId? 可选。diameterMm 是**唯一物理依据**（逐钻物化快照字段——不引目录 IO，
 * 深模块契约不变；直径随钻位走，目录可变而文档稳定）；v1 迁移补 'round'。
 * zod 契约面见 spec.ts GemSchema（SHAPE_IDS 单源——spec.ts ↔ types.ts 值导入环规避）。
 */
export interface Gem {
  id: string;
  x: number;
  y: number;
  /** mapColors 写入的色板条目 id；空串 = 未映射 */
  colorId: string;
  blockId: string;
  /** 形 id（'round' | 'square' | 'drop' | 'heart' | 'marquise' | 'custom'） */
  shapeId: import("./spec").ShapeId;
  /** 唯一物理依据（mm；逐钻判距/渲染经 effectiveSpecOf / gemRadiusPx 消费） */
  diameterMm: number;
  /** 异形朝向（0=默认朝上；圆钻恒缺省；非身份、不参与 BOM 聚合键） */
  rotationDeg?: number;
  /** shapeId='custom' 时的 .gemshape 弱引用（missing 四态 + gemshapeFile gate 6） */
  assetId?: string;
}

// ---------- 专家工作台契约（add-manual-edit-mode，Codex R1-R4 冻结） ----------
/** 编辑器钻位：独立类型（不 extends Gem——blockId 可空与 Gem.blockId: string 冲突）。 */
export interface EditGem {
  /** 手工钻 = 'm-' 前缀编辑器自增；来源钻沿用 layout 输出 id（命名空间不重叠）。 */
  id: string;
  x: number;
  y: number;
  colorId: string;
  /** 语义 = "来源块"引用，不代表几何归属；手工钻为 null。 */
  blockId: string | null;
  /** 来源钻（layout 产出）vs 手工钻（编辑器新增）。 */
  origin: "layout" | "manual";
  /** layout 钻被移动过即 true（选块填充只替换 origin='layout' 且 !moved 的钻）。 */
  moved: boolean;
  /** [gem-catalog 1.4] 规格物化字段（与 Gem 同步扩展；origin/moved 语义不变）。 */
  shapeId: import("./spec").ShapeId;
  diameterMm: number;
  rotationDeg?: number;
  assetId?: string;
}

/** 编辑器双层校验：spacing=物理硬门（阻断导出）；mask-hint=归属提示（不阻断）。 */
export interface EditWarning {
  kind: "spacing" | "mask-hint";
  detail: string;
  gemIds: string[];
}

/** resolveConflicts 的结构化最小约束（EditGem 与纯 Gem[] 均满足）。 */
export interface ConflictMeta {
  origin?: "manual" | "layout";
  moved?: boolean;
}


export const STRATEGY_IDS = ["hex-thin", "hex-pitch", "poisson", "hybrid", "cvt"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

// ---------- 网格（GridSpec v2——由 BaseSpec 派生的几何上下文，W0 0.1 冻结） ----------
/**
 * v2 重定义（design §1.1）：不携带 `ss` 身份语义（v1 过渡读面 ss? 已随 engine gate 1.3/1.4
 * 三处消费者迁移清零而删除——buildBom 新键 / ProjectSummary / edit store 摘要）；pitch/间距/
 * 渲染的唯一物理依据是 BaseSpec.diameterMm；`gapMm` 为 pairwise 判据与 maxCellPx 的 gap 单一来源。
 * 构造入口：`gridFromSpec(spec, gapMm, pixelsPerMm)`（标准）/ `gridFromSs(...)`（圆钻特例，降位）。
 * 旧 v1/v2 过渡文件 grid 内的 ss 键由 persistence 层 parseGrid 容忍并剥离（信息无损——pitch+gap 可派生）。
 */
export interface GridSpec {
  /** 钻心最小间距（mm）= 钻径 + gap（由 BaseSpec 派生：gridFromSpec） */
  pitchMm: number;
  /** pairwise 判据与 maxCellPx 的 gap 单一来源（mm）；requiredCenterDistancePx 经 grid 消费 */
  gapMm: number;
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
  pitchMm: z.number().positive(),
  /** v2：gap ≥ 0（0 = 相切；pairwise 判据单一来源） */
  gapMm: z.number().nonnegative(),
  rowAngleDeg: z.literal(0),
  pixelsPerMm: z.number().positive(),
}).strict();

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
