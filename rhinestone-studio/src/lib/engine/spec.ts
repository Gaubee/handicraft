/**
 * canonical 钻规格类型模块（v2 契约唯一真源）。
 *
 * 规范来源：openspec add-gem-catalog-and-sizes design §1.1（W0 0.1，R2 终审 §三-2 定案）+
 * §1.5（物理锚）；专家稿 v1.1 §A.1 已冻结契约经图层稿 §E.2 合流后由本 change 承接。
 *
 * 纪律（本模块级冻结，违反 = 契约破坏）：
 * 1. 本文件是 BaseSpec / GemSpecSnapshot / PhysicalCanvas / GemSpec 的**唯一定义点**
 *    （禁止第二定义点；UI 消费一律经 `$lib/engine` 公共出口 re-export，不深入实现路径）。
 * 2. **specKey 是唯一持久身份**；「specId」身份字段/持久化别名全库清零（exact-key 禁令，
 *    grep 断言见 src/tests/engine/spec.contract.test.ts）。豁免：`refSpecId`——.gemshape
 *    校准来源的**独立引用字段**（persistence/gemshapeFile.ts 单独定义），不计入禁令命中。
 * 3. **身份不由显示码/浮点径反推**：BOM 键、四格式迁移、SVG/BOM 渲染一律消费 canonical
 *    specKey 快照，不从 R10/SQ35 显示码或 diameterMm 浮点反推（gemspec R1 议题 2 裁决）。
 * 4. GridSpec v2（由 BaseSpec 派生的几何上下文）定义在 types.ts v2 区（同 gate 冻结），
 *    构造入口见 grid.ts gridFromSpec（标准）/ gridFromSs（圆钻特例，降位）。
 */

import { z } from "zod";
import { SS_KEYS, type SSKey } from "./types";

// ---------------------------------------------------------------------------
// P0 形枚举（内置五形 + custom；P1 oval/star 增条目不改本枚举语义）
// ---------------------------------------------------------------------------

export const SHAPE_IDS = ["round", "square", "drop", "heart", "marquise", "custom"] as const;
export type ShapeId = (typeof SHAPE_IDS)[number];

// ---------------------------------------------------------------------------
// canonical 类型（design §1.1 逐字段冻结；注释即契约）
// ---------------------------------------------------------------------------

/** 整图/层级基础规格：形 × 尺寸（无身份字段——身份只在 GemSpecSnapshot.specKey）。 */
export interface BaseSpec {
  /** 'round' | 'square' | 'drop' | 'heart' | 'marquise'（P0）| 'custom' */
  shapeId: ShapeId;
  /** 仅显示用（'SS10' / '3.5mm'），不参与身份 */
  sizeLabel: string;
  /** 最大径（圆=直径；方=边长；水滴/心/马眼=长轴）——间距与渲染的唯一物理依据 */
  diameterMm: number;
  /** 异形/自定义附宽（内置形可由纵横比常量派生） */
  widthMm?: number;
  heightMm?: number;
  /** shapeId='custom' 时的 .gemshape 资产弱引用（missing 四态容忍，见 gemshapeFile） */
  assetId?: string;
}

/**
 * 序列化/归档/BOM 的稳定身份快照（不可变；每次 run/gemgen 持久化）。
 *
 * rotationDeg 归属裁决（design §1.1）：**非身份字段**——不参与 specKey 身份、不参与 BOM
 * 聚合键（聚合键恒 `specKey × colorId`）；快照内为可选随附（物化产物），`Gem`/`EditGem`
 * 逐钻字段同步携带（engine gate 1.4 落地）。圆钻恒缺省。
 */
export interface GemSpecSnapshot {
  /** canonical 稳定键，唯一持久身份：builtin 确定性（'round-ss10' / 'square-3.5'）；custom = 'custom-<gemshapeAssetId>' */
  specKey: string;
  /** 清单序号 1..n（蓝图编号即此）；ordinal→specKey 映射随 run/gemgen 持久化（gemgen.gemSpecs 数组即此映射） */
  ordinal: number;
  shapeId: ShapeId;
  sizeLabel: string;
  diameterMm: number;
  widthMm?: number;
  heightMm?: number;
  assetId?: string;
  /** 逐钻物化时随附；非身份（见上）；不参与 BOM 聚合键 */
  rotationDeg?: number;
}

/** 物理画幅锚（画幅级，非层级；承载于 .gemproj/.gemdoc/.gemgen v2 的 physicalCanvas）。 */
export interface PhysicalCanvas {
  widthMm: number;
  heightMm: number;
  /** 成品模式声明 | 2.5 缺省（现状兼容，显式标记——回退必须可见，不静默） */
  anchorSource: "declared" | "default";
}

/** 内存目录条目（非序列化；目录真源 = 素材库 .gemshape 资产，design §3.1——本类型仅解析缓存层）。 */
export interface GemSpec extends Omit<GemSpecSnapshot, "ordinal" | "rotationDeg"> {
  source: "builtin" | "custom";
}

// ---------------------------------------------------------------------------
// specKey 生成规则（design §1.6：engine 保留迁移 bootstrap 规则常量；目录真源在素材库）
// ---------------------------------------------------------------------------

/**
 * builtin 确定性 specKey：`${shapeId}-${归一化 sizeLabel}`。
 * 归一化 = trim + 小写 + 去 'mm' 后缀：'SS10'→'round-ss10'、'3.5mm'→'square-3.5'。
 */
export function builtinSpecKey(shapeId: string, sizeLabel: string): string {
  return `${shapeId}-${sizeLabel.trim().toLowerCase().replace(/mm$/, "")}`;
}

/** custom specKey：canonical 至少含 assetId（'custom-<gemshapeAssetId>'）。 */
export function customSpecKey(assetId: string): string {
  return `custom-${assetId}`;
}

/** 圆钻 SS 档 specKey（v1→v2 迁移 bootstrap 查表派生：SS10 → 'round-ss10'）。 */
export function roundSpecKeyOfSs(ss: SSKey): string {
  return `round-${ss.toLowerCase()}`;
}

const ROUND_SPEC_KEY_RE = /^round-ss(\d{1,2})$/;

/** 'round-ss10' → 'SS10'（SS_KEYS 校验）；非圆钻 SS 档形态返回 null（v1 读面派生用）。 */
export function ssOfRoundSpecKey(specKey: string): SSKey | null {
  const match = ROUND_SPEC_KEY_RE.exec(specKey);
  if (match === null) return null;
  const ss = `SS${match[1]}` as SSKey;
  return SS_KEYS.includes(ss) ? ss : null;
}

// ---------------------------------------------------------------------------
// zod schemas（运行时契约，与接口同源；.gemshape 校准快照 / gemgen.gemSpecs 消费）
// ---------------------------------------------------------------------------

const positiveMm = z.number().positive();
const optionalPositiveMm = z.number().positive().optional();
const optionalAssetId = z.string().min(1).optional();

export const BaseSpecSchema = z
  .object({
    shapeId: z.enum(SHAPE_IDS),
    sizeLabel: z.string().min(1),
    diameterMm: positiveMm,
    widthMm: optionalPositiveMm,
    heightMm: optionalPositiveMm,
    assetId: optionalAssetId,
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.assetId !== undefined && spec.shapeId !== "custom") {
      ctx.addIssue({ code: "custom", path: ["assetId"], message: "assetId 仅在 shapeId='custom' 时允许" });
    }
  });

export const GemSpecSnapshotSchema = z
  .object({
    specKey: z.string().min(1),
    ordinal: z.number().int().positive(),
    shapeId: z.enum(SHAPE_IDS),
    sizeLabel: z.string().min(1),
    diameterMm: positiveMm,
    widthMm: optionalPositiveMm,
    heightMm: optionalPositiveMm,
    assetId: optionalAssetId,
    /** 非身份：[0, 360) */
    rotationDeg: z.number().min(0).lt(360).optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.assetId !== undefined && snapshot.shapeId !== "custom") {
      ctx.addIssue({ code: "custom", path: ["assetId"], message: "assetId 仅在 shapeId='custom' 时允许" });
    }
    if (snapshot.shapeId === "custom" && snapshot.assetId === undefined) {
      ctx.addIssue({ code: "custom", path: ["assetId"], message: "shapeId='custom' 必须携带 assetId（canonical specKey 派生依据）" });
    }
  });

export const PhysicalCanvasSchema = z
  .object({
    widthMm: positiveMm,
    heightMm: positiveMm,
    anchorSource: z.enum(["declared", "default"]),
  })
  .strict();
