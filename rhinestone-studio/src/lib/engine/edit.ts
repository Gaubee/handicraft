/*
Orthogonal intents (max 2):
1. [2026-09-19 Contract] 手动编辑契约的边界转换纯函数（Gem↔EditGem）——类型已在 types.ts 冻结，
   本文件承载可执行部分；validateEditable/resolveConflicts 按 tasks 2.1 落地于此（签名见
   openspec/changes/add-manual-edit-mode/design.md §4）。
2. [2026-09-19 Boundary] 引擎不依赖编辑器：本文件只依赖 types.ts 公共类型。
*/

import type { EditGem, Gem } from "./types";

/** 快照进入：layout 产出钻 → 编辑钻（origin='layout'、未移动、blockId 直传）。 */
export function toEditGem(gem: Gem): EditGem {
  return {
    id: gem.id,
    x: gem.x,
    y: gem.y,
    colorId: gem.colorId,
    blockId: gem.blockId,
    origin: "layout",
    moved: false,
  };
}

/** 导出边界：编辑钻 → 引擎钻。blockId 为 null 时以 '__manual' 占位——
 *  exportSvg/BOM 只消费 colorId，占位不影响产物；导出前不跑归属校验。 */
export function fromEditGem(gem: EditGem): Gem {
  return {
    id: gem.id,
    x: gem.x,
    y: gem.y,
    colorId: gem.colorId,
    blockId: gem.blockId ?? "__manual",
  };
}
