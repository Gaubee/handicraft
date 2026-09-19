/**
 * 唯一几何 helper（签名冻结——gem-catalog W0 0.2，design §1.2；R2 §三-1 定案签名）。
 *
 * 纪律（全库冻结，违反 = 契约破坏）：
 * 1. `requiredCenterDistancePx(a, b, grid)` 三参**唯一签名**——不得另立二参/别名/同义函数；
 *    `validate`/`validateEditable`/`resolveConflicts`/`exportGate`/布局产物 gate（engine gate 1.2）
 *    全部消费本定义。
 * 2. **单位恒 px**：mm→px 换算只发生在本文件内部（经 grid.pixelsPerMm）——禁止 mm 裸传
 *    SpatialIndex（cell 换用 maxCellPx，engine gate 1.1 落地；px 坐标系传 mm 会漏邻居）。
 * 3. 判据 = 圆包络：`dist ≥ requiredCenterDistancePx(a, b, grid)` 即合规。
 */

import type { GemSpecSnapshot } from "./spec";
import type { GridSpec } from "./types";

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
  a: GemSpecSnapshot,
  b: GemSpecSnapshot,
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
export function maxCellPx(specs: readonly GemSpecSnapshot[], grid: GridSpec): number {
  if (specs.length === 0) return 0
  let maxDiameterMm = specs[0].diameterMm
  for (const spec of specs) {
    if (spec.diameterMm > maxDiameterMm) maxDiameterMm = spec.diameterMm
  }
  return (maxDiameterMm + grid.gapMm) * grid.pixelsPerMm
}
