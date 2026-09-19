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
  GRIDSPEC_SS_MIGRATION_CHECKLIST,
  LayoutOptionsSchema,
  SegmentOptionsSchema,
  SS_KEYS,
  STRATEGY_IDS,
  StrategyIdSchema,
} from "./types";

// 网格/尺寸
export { SS_TABLE, gemRadiusPx, gridFromSpec, gridFromSs, pitchMmFromSs, pitchPx, ssDiameterMm } from "./grid";

// canonical 钻规格类型（v2 契约唯一真源——gem-catalog W0 0.1；唯一定义点 engine/spec.ts）
export type { BaseSpec, GemSpec, GemSpecSnapshot, PhysicalCanvas, ShapeId } from "./spec";
export {
  SHAPE_IDS,
  BaseSpecSchema,
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
export { maxCellPx, requiredCenterDistancePx } from "./geometry";

// 管线
export { segment } from "./segment";
export { layout } from "./layout/index";
export { mapColors, labFromRgb, rgbFromLab, deltaE76, type Lab } from "./color";
export { validate, isExportable } from "./validate";
export { buildSvg, buildBom, exportSvg, exportBom, type SvgExportOptions } from "./export";

// 手动编辑契约（边界转换 + 双层校验 + 显式一键修复；add-manual-edit-mode tasks 1.2/2.1）
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
