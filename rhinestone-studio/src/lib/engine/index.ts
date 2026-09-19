/*
Orthogonal intents (max 2):
1. [2026-09-18 Contract] 引擎公共出口：UI 只准 `import { ... } from "$lib/engine"`，禁止深入实现路径（design.md §2）。
2. [2026-09-18 Surface] 纯数据进出（无 DOM/网络副作用），浏览器与 node 测试同构。
*/

// 类型与 schema
export type {
  BBox,
  Block,
  BlockType,
  ConflictMeta,
  DensitySpec,
  EditGem,
  EditWarning,
  EngineImage,
  Gem,
  GridSpec,
  LayoutOptions,
  LayoutResult,
  Mask2D,
  Palette,
  PaletteColor,
  SegmentOptions,
  SSKey,
  StrategyId,
  Warning,
} from "./types";
export {
  EngineImageSchema,
  GridSpecSchema,
  LayoutOptionsSchema,
  SegmentOptionsSchema,
  SS_KEYS,
  STRATEGY_IDS,
  StrategyIdSchema,
} from "./types";

// 网格/尺寸
export { SS_TABLE, baseSpecDiameterMm, gemRadiusPx, gridFromSpec, gridFromSs, pitchMmFromSs, pitchPx, ssDiameterMm } from "./grid";

// canonical 钻规格类型（v2 契约唯一真源——gem-catalog W0 0.1；唯一定义点 engine/spec.ts）
// + Gem/EditGem zod 公共契约面（engine gate 1.4——宿主 spec.ts，SHAPE_IDS 单源零环）
export type { BaseSpec, GemSpec, GemSpecSnapshot, PhysicalCanvas, ShapeId } from "./spec";
export {
  SHAPE_IDS,
  BaseSpecSchema,
  EditGemSchema,
  GemSchema,
  GemSpecSnapshotSchema,
  PhysicalCanvasSchema,
  PIXELS_PER_MM,
  builtinSpecKey,
  customSpecKey,
  pixelsPerMmFromCanvas,
  roundSpecKeyOfSs,
  ssOfRoundSpecKey,
} from "./spec";

// 唯一几何 helper（签名冻结——gem-catalog W0 0.2；mm→px 换算唯一发生地，单位恒 px）
// + 逐钻判距视图（engine gate 1.1：cell=maxCellPx 消费面 / 1.2：逐对判据消费面）
export { effectiveSpecOf, maxCellPx, requiredCenterDistancePx } from "./geometry";
export type { GemSpecFields, PairwiseSpec } from "./geometry";

// 目录资产 schema + 迁移 bootstrap（gem-catalog W0 0.6；目录真源 = 素材库 .gemshape 资产）
// + 逐钻 canonical specKey 投影（engine gate 1.3：BOM 聚合键唯一入口）
export type { BuiltinShapeMeta, GemshapeSeedPlan, GemshapeSeedSpec, GemSpecIdentity, RoundSsBootstrapRow } from "./catalog";
export {
  BUILTIN_SHAPES,
  ROUND_SS_BOOTSTRAP,
  gemShapeDisplayName,
  gemSpecIdentityOf,
  gemshapeSeedNodeId,
  planGemshapeSeeds,
} from "./catalog";

// 管线
export { segment } from "./segment";
export { layout } from "./layout/index";
export { mapColors, labFromRgb, rgbFromLab, deltaE76, type Lab } from "./color";
export { validate, isExportable } from "./validate";
export {
  buildBom,
  buildSvg,
  exportBom,
  exportSvg,
  type BomOptions,
  type GemshapeRenderData,
  type ShapeResolver,
  type SvgExportOptions,
} from "./export";

// 导出前置门（gem-catalog engine gate 1.2：统一 pairwise 判据——SVG/BOM/PNG/送精修共同前置）
export {
  exportGate,
  type ExportGateOptions,
  type ExportGateVerdict,
  type ExportViolation,
  type ExportViolationKind,
  type GateGem,
  type ShapeAssetRefState,
} from "./exportGate";

// 专家工作台契约（边界转换 + 双层校验 + 显式一键修复；add-manual-edit-mode tasks 1.2/2.1）
export {
  fromEditGem,
  isExportableEditable,
  resolveConflicts,
  toEditGem,
  validateEditable,
} from "./edit";

// 色板
export {
  STARTER_PALETTE,
  canRemovePaletteColor,
  countPaletteUsage,
  findPaletteColor,
  getPaletteUsage,
  removePaletteColor,
  upsertPaletteColor,
} from "./palette";
