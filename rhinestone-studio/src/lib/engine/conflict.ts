/*
Orthogonal intents (max 3):
1. [2026-09-19 Shared] 确定性冲突消解的唯一实现：layout 内部消解（common.ts enforceMinDistance
   系）与编辑器一键修复（edit.ts resolveConflicts）共用同一贪心核心——零语义漂移
   （add-manual-edit-mode design.md §4："与内部消解共用同一实现"）。
2. [2026-09-19 Determinism] keep-earlier 贪心 + 稳定优先级排序：同输入同输出；被删钻携带
   "与哪个保留钻冲突"的可解释 reason（显式、可撤销的一键修复前提）。
3. [2026-09-19 Boundary] 结构化最小约束 { id, x, y }：纯 Gem[] 与 EditGem[] 均可作 T 传入，
   不依赖具体钻位形态。
*/

import { SpatialIndex } from "./ops";

export interface ConflictResolution<T> {
  /** 保留子集（保持输入顺序——enforceMinDistance 的既有语义，layout 逐位不变） */
  gems: T[];
  /** 被删明细（输入顺序），reason 中文可解释 */
  removed: Array<{ gem: T; reason: string }>;
}

/**
 * 贪心冲突消解核心（原 enforceMinDistance 的算法体，逐语句保持不变）：
 * 按优先级序（compare < 0 = a 先保留；缺省 = 输入序，即"现行为"）逐钻判定，
 * 与任一已保留钻中心距 < pitch×0.999（浮点容差，与 validate 同口径）者删除。
 * threshold 判定、稳定排序、SpatialIndex(cell=pitch) 手法与改造前完全一致。
 */
export function resolveGreedy<T extends { id: string; x: number; y: number }>(
  gems: T[],
  pitch: number,
  compare?: (a: T, b: T) => number,
): ConflictResolution<T> {
  const threshold = pitch * 0.999;
  const order = gems.map((_, i) => i);
  if (compare) order.sort((x, y) => compare(gems[x], gems[y])); // sort 稳定，同优先级保持原序
  const keepMask = new Uint8Array(gems.length);
  const blocker = new Array<T | undefined>(gems.length); // 判定期记录：删它时所对的保留钻
  const index = new SpatialIndex<T>(pitch);
  for (const oi of order) {
    const g = gems[oi];
    const near = index.query(g.x, g.y);
    let conflict: T | undefined = undefined;
    for (const other of near) {
      const dx = other.x - g.x;
      const dy = other.y - g.y;
      if (dx * dx + dy * dy < threshold * threshold) {
        conflict = other;
        break;
      }
    }
    if (conflict) {
      blocker[oi] = conflict;
    } else {
      keepMask[oi] = 1;
      index.insert(g.x, g.y, g);
    }
  }
  const removed: Array<{ gem: T; reason: string }> = [];
  gems.forEach((gem, i) => {
    const b = blocker[i];
    if (b) {
      const d = Math.hypot(b.x - gem.x, b.y - gem.y);
      removed.push({ gem, reason: `与 ${b.id} 间距不足（中心距 ${d.toFixed(2)}px < pitch ${pitch.toFixed(2)}px）` });
    }
  });
  return { gems: gems.filter((_, i) => keepMask[i] === 1), removed };
}
