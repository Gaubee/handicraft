/*
Orthogonal intents (max 4):
1. [2026-09-19 Contract] 专家工作台契约的引擎侧出口（add-manual-edit-mode design.md §1/§4）：
   toEditGem/fromEditGem 边界转换 + validateEditable/isExportableEditable 双层校验 +
   resolveConflicts 显式一键修复——签名冻结，全部从 index.ts 公共面导出。
2. [2026-09-19 Layers] 校验双层拆分：spacing=物理硬门（任意两钻中心距 ≥ pitch，恒查、阻断导出）；
   mask-hint=归属提示（仅 origin='layout' 且 !moved 的来源钻，钻心在来源块掩码内——
   手工钻/移动钻天然脱离掩码约束，豁免）。与工作台 validate/isExportable 并存，互不影响。
3. [2026-09-19 Shared] resolveConflicts 与 layout 内部消解（common.ts enforceMinDistanceCounted）
   共用同一贪心核心（conflict.ts resolveGreedy）——零语义漂移；纯 Gem[]（无 meta 字段）
   退化为 layout 现行为（稳定输入序）。
4. [2026-09-19 Boundary] 引擎不依赖编辑器：本文件只依赖 types/ops/conflict 公共类型与纯函数。
*/

import { resolveGreedy } from "./conflict";
import { effectiveSpecOf, maxCellPx } from "./geometry";
import type { GemSpecFields } from "./geometry";
import { SpatialIndex } from "./ops";
import type { Block, ConflictMeta, EditGem, EditWarning, Gem, GridSpec } from "./types";
import { GridSpecSchema } from "./types";

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

/**
 * 编辑器双层校验（design.md §1 冻结签名）。
 * spacing：任意两钻中心距 < pitch×0.999（与 validate 同口径的浮点容差；spatial hash
 * cell = maxCellPx——tasks 1.1，等径 = pitch，v1 行为零变化）——恒查，物理硬门。
 * mask-hint：仅 origin='layout' 且 !moved 的来源钻，钻心须在来源块（blockId）掩码内——
 * 手工钻（origin='manual'）与被移动钻（moved=true）豁免；提示级，不阻断导出。
 * blocks 缺省时只查 spacing。确定性输出（对遍历序稳定）。
 */
export function validateEditable(
  gems: (EditGem & GemSpecFields)[],
  grid: GridSpec,
  blocks?: Block[],
): EditWarning[] {
  const g = GridSpecSchema.parse(grid);
  const pitch = g.pitchMm * g.pixelsPerMm;
  const threshold = pitch * 0.999;
  const warnings: EditWarning[] = [];

  // ---- spacing（spatial hash；cell = maxCellPx——tasks 1.1，手法与 validate 一致） ----
  const specs = gems.map((gem) => effectiveSpecOf(gem, g));
  const index = new SpatialIndex<number>(maxCellPx(specs, g));
  gems.forEach((gem, i) => index.insert(gem.x, gem.y, i));
  const seenPairs = new Set<number>();
  for (let i = 0; i < gems.length; i++) {
    for (const j of index.query(gems[i].x, gems[i].y)) {
      if (j <= i) continue;
      const dx = gems[j].x - gems[i].x;
      const dy = gems[j].y - gems[i].y;
      if (dx * dx + dy * dy >= threshold * threshold) continue;
      const key = i * gems.length + j;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const d = Math.sqrt(dx * dx + dy * dy);
      warnings.push({
        kind: "spacing",
        detail: `钻 ${gems[i].id} 与 ${gems[j].id} 中心距 ${d.toFixed(2)}px < pitch ${pitch.toFixed(2)}px`,
        gemIds: [gems[i].id, gems[j].id],
      });
    }
  }

  // ---- mask-hint（归属层：仅来源钻且未移动；掩码判定与 validate/island 同中心点规则） ----
  if (blocks) {
    const byId = new Map(blocks.map((b) => [b.id, b] as const));
    for (const gem of gems) {
      if (gem.origin !== "layout" || gem.moved) continue; // 手工钻/移动钻豁免
      if (gem.blockId === null) continue; // 无来源块引用 → 无从校验，跳过
      const block = byId.get(gem.blockId);
      if (!block) {
        warnings.push({
          kind: "mask-hint",
          detail: `钻 ${gem.id} 引用不存在的来源块 ${gem.blockId}`,
          gemIds: [gem.id],
        });
        continue;
      }
      const ix = Math.round(gem.x) - block.bbox.x;
      const iy = Math.round(gem.y) - block.bbox.y;
      const inside =
        ix >= 0 &&
        iy >= 0 &&
        ix < block.bbox.w &&
        iy < block.bbox.h &&
        block.mask.bits[iy * block.bbox.w + ix] === 1;
      if (!inside) {
        warnings.push({
          kind: "mask-hint",
          detail: `钻 ${gem.id} 中心 (${gem.x.toFixed(1)},${gem.y.toFixed(1)}) 越出来源块 ${block.id} 掩码`,
          gemIds: [gem.id],
        });
      }
    }
  }

  return warnings;
}

/** 编辑导出门：仅 spacing 阻断（mask-hint 是提示级；island 语义在编辑器外另行提示放行）。 */
export function isExportableEditable(warnings: EditWarning[]): boolean {
  return !warnings.some((w) => w.kind === "spacing");
}

/**
 * 显式一键修复（design.md §4 冻结签名）：确定性冲突消解，绝不默认静默丢钻——
 * 被删钻全量列出于 removed（gem + 中文 reason，指明与哪个保留钻间距不足），供 UI 预览确认。
 * 保留优先级四级：origin manual > moved layout > unmoved layout > 稳定输入序
 * （同优先级并列时输入在前者保留）。与 layout 内部消解共用同一实现（conflict.ts）；
 * 纯 Gem[]（无 origin/moved 字段）全员同级 → 稳定排序即输入序，退化为 layout 现行为。
 * 返回 gems 保持输入顺序。
 */
export function resolveConflicts<T extends { id: string; x: number; y: number } & ConflictMeta>(
  gems: T[],
  grid: GridSpec,
): { gems: T[]; removed: Array<{ gem: T; reason: string }> } {
  const g = GridSpecSchema.parse(grid);
  const pitch = g.pitchMm * g.pixelsPerMm;
  return resolveGreedy(gems, pitch, editPriorityCompare);
}

/** 保留优先级比较器：manual(0) > moved layout(1) > 其余(2，含 unmoved layout 与无 origin 字段的纯 Gem)。 */
function editPriorityCompare(a: ConflictMeta, b: ConflictMeta): number {
  return priorityRank(a) - priorityRank(b);
}

function priorityRank(gem: ConflictMeta): number {
  if (gem.origin === "manual") return 0;
  if (gem.origin === "layout") return gem.moved ? 1 : 2;
  return 2;
}
