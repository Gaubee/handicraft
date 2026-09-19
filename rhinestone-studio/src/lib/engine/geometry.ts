/**
 * 唯一几何 helper（签名冻结——gem-catalog W0 0.2，design §1.2；R2 §三-1 定案签名）。
 *
 * 纪律（全库冻结，违反 = 契约破坏）：
 * 1. `requiredCenterDistancePx(a, b, grid)` 三参**唯一签名**——不得另立二参/别名/同义函数；
 *    `validate`/`validateEditable`/`resolveConflicts`/`exportGate`/布局产物 gate（engine gate 1.2）
 *    全部消费本定义。
 * 2. **单位恒 px**：mm→px 换算只发生在本文件内部（经 grid.pixelsPerMm）——禁止 mm 裸传
 *    SpatialIndex（cell 换用 maxCellPx，engine gate 1.1 落地；px 坐标系传 mm 会漏邻居）。
 * 3. 判据 = 圆包络：`dist ≥ requiredCenterDistancePx(a, b, grid)` 即合规；消费侧统一附
 *    v1 同口径浮点容差（×0.999 相对容差——等径退化 = v1 单一 pitch×0.999 判据逐位等价，
 *    ENGINE_VERSION bump 护栏依据，design §2.5）。
 */

import { baseSpecDiameterMm } from "./grid";
import { CustomAssetIdMissingError, customAssetIdMissing } from "./spec";
import type { GemSpecSnapshot } from "./spec";
import type { GridSpec } from "./types";

/**
 * 判距输入的最小结构（engine gate 1.1/1.2）：helper 只消费 diameterMm——
 * GemSpecSnapshot 满足；Gem/EditGem 的规格物化字段视图（effectiveSpecOf 产物）亦满足。
 * 参数取结构子集不改三参唯一签名（W0 0.2 冻结的是签名/单位/公式，本文件仍为唯一定义点）。
 */
export type PairwiseSpec = Pick<GemSpecSnapshot, "diameterMm">;

/** 逐钻规格物化字段的可选结构面（Gem/EditGem 于 tasks 1.4 落地为必填字段；结构兼容过渡）。 */
export interface GemSpecFields {
  shapeId?: string;
  diameterMm?: number;
  rotationDeg?: number;
  assetId?: string;
}

/**
 * 逐钻有效判距视图：diameterMm 缺席（v1 无规格字段的钻 / 未物化路径）时按 grid 基准规格
 * 派生（pitchMm − gapMm，量化 1e-6 消回推 ULP 尾差——gridFromSs/gridFromSpec 构造式下
 * 与原 diameterMm 逐位相等）。基准直径单源见 grid.ts baseSpecDiameterMm。
 *
 * [R5-P1 统一契约] custom 无 assetId → CustomAssetIdMissingError typed invalid（fail-fast
 * 上浮——validate/validateEditable/resolveConflicts 等全消费面统一拒绝，不静默按判距放行）。
 */
export function effectiveSpecOf(gem: GemSpecFields, grid: GridSpec): PairwiseSpec {
  if (customAssetIdMissing(gem)) {
    throw new CustomAssetIdMissingError(`effectiveSpecOf 判距视图（diameterMm=${gem.diameterMm ?? "缺席"}）`);
  }
  return { diameterMm: gem.diameterMm ?? baseSpecDiameterMm(grid) };
}

/**
 * 圆包络判据：两钻所需最小中心距（px）。
 *
 * `(a.diameterMm + b.diameterMm) / 2 + grid.gapMm`（mm）× `grid.pixelsPerMm` → px。
 * - 等径退化：`diameterMm + gapMm` = pitch（对单规格圆钻参数空间与 v1 单一 pitch 判据等价
 *   ——ENGINE_VERSION bump 的护栏依据，design §2.5）；
 * - 大小径包络：判据由两钻径共同决定，非全局单一阈值；
 * - rotationDeg 不参与（圆包络不变性：旋转不改变 diameterMm 包络——异形按最大径圆包络判距）。
 */
export function requiredCenterDistancePx(
  a: PairwiseSpec,
  b: PairwiseSpec,
  grid: GridSpec,
): number {
  return ((a.diameterMm + b.diameterMm) / 2 + grid.gapMm) * grid.pixelsPerMm
}

/**
 * spatial hash cell 尺寸（px）：`(max(specs.diameterMm) + grid.gapMm) × grid.pixelsPerMm`。
 *
 * cell 取 max 后 3×3 邻域检索不漏（检索不漏 ≠ 分区结果几何合规——后者由逐对
 * requiredCenterDistancePx 判定）。空清单 = 0（无钻无 cell；消费方自行处理空文档）。
 */
export function maxCellPx(specs: readonly PairwiseSpec[], grid: GridSpec): number {
  if (specs.length === 0) return 0
  let maxDiameterMm = specs[0].diameterMm
  for (const spec of specs) {
    if (spec.diameterMm > maxDiameterMm) maxDiameterMm = spec.diameterMm
  }
  return (maxDiameterMm + grid.gapMm) * grid.pixelsPerMm
}
