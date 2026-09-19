/*
Orthogonal intents (max 3):
1. [2026-09-19 Shared] 确定性冲突消解的唯一实现：layout 内部消解（common.ts enforceMinDistance
   系）与编辑器一键修复（edit.ts resolveConflicts）共用同一贪心核心——零语义漂移
   （add-manual-edit-mode design.md §4："与内部消解共用同一实现"）。
2. [2026-09-19 Determinism] keep-earlier 贪心 + 稳定优先级排序：同输入同输出；被删钻携带
   "与哪个保留钻冲突"的可解释 reason（显式、可撤销的一键修复前提）。
   [2026-09-20 gem-catalog 1.2] 判据单一 pitch×0.999 → 逐对圆包络 requiredCenterDistancePx×0.999
   （等径圆钻 = v1 判据逐位等价——布局内部单规格路径行为不变，黄金守卫证据）；cell = maxCellPx。
3. [2026-09-19 Boundary] 结构化最小约束 { id, x, y }（+可选规格物化字段）：纯 Gem[] 与
   EditGem[] 均可作 T 传入，不依赖具体钻位形态。
*/

import { effectiveSpecOf, maxCellPx, requiredCenterDistancePx } from "./geometry";
import type { GemSpecFields } from "./geometry";
import { SpatialIndex } from "./ops";
import type { GridSpec } from "./types";
import { GridSpecSchema } from "./types";

export interface ConflictResolution<T> {
  /** 保留子集（保持输入顺序——enforceMinDistance 的既有语义，layout 逐位不变） */
  gems: T[];
  /** 被删明细（输入顺序），reason 中文可解释 */
  removed: Array<{ gem: T; reason: string }>;
}

/**
 * 贪心冲突消解核心（gem-catalog 1.2 混合径化）：
 * 按优先级序（compare < 0 = a 先保留；缺省 = 输入序，即"现行为"）逐钻判定，
 * 与任一已保留钻中心距 < requiredCenterDistancePx(a,b,grid)×0.999（逐对圆包络 + v1 同口径
 * 浮点容差）者删除。逐对判据、稳定排序、SpatialIndex(cell=maxCellPx) 3×3 检索序；
 * 等径圆钻参数空间与改造前（单一 pitch×0.999 / cell=pitch）逐位等价。
 */
export function resolveGreedy<T extends { id: string; x: number; y: number } & GemSpecFields>(
  gems: T[],
  grid: GridSpec,
  compare?: (a: T, b: T) => number,
): ConflictResolution<T> {
  const g = GridSpecSchema.parse(grid);
  const specs = gems.map((gem) => effectiveSpecOf(gem, g));
  /** 逐对判距：圆包络 × v1 同口径 0.999 相对容差。 */
  const requiredOfPair = (i: number, j: number): number =>
    requiredCenterDistancePx(specs[i], specs[j], g) * 0.999;
  const order = gems.map((_, i) => i);
  if (compare) order.sort((x, y) => compare(gems[x], gems[y])); // sort 稳定，同优先级保持原序
  const keepMask = new Uint8Array(gems.length);
  const blocker = new Int32Array(gems.length).fill(-1); // 判定期记录：删它时所对的保留钻下标
  const index = new SpatialIndex<number>(maxCellPx(specs, g));
  for (const oi of order) {
    const gem = gems[oi];
    const near = index.query(gem.x, gem.y);
    let conflict = -1;
    for (const other of near) {
      const dx = gems[other].x - gem.x;
      const dy = gems[other].y - gem.y;
      const threshold = requiredOfPair(oi, other);
      if (dx * dx + dy * dy < threshold * threshold) {
        conflict = other;
        break;
      }
    }
    if (conflict >= 0) {
      blocker[oi] = conflict;
    } else {
      keepMask[oi] = 1;
      index.insert(gem.x, gem.y, oi);
    }
  }
  const removed: Array<{ gem: T; reason: string }> = [];
  gems.forEach((gem, i) => {
    const b = blocker[i];
    if (b >= 0) {
      const d = Math.hypot(gems[b].x - gem.x, gems[b].y - gem.y);
      removed.push({
        gem,
        reason: `与 ${gems[b].id} 间距不足（中心距 ${d.toFixed(2)}px < 所需 ${requiredOfPair(i, b).toFixed(2)}px）`,
      });
    }
  });
  return { gems: gems.filter((_, i) => keepMask[i] === 1), removed };
}
