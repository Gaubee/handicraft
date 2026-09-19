/**
 * [gem-catalog engine gate 1.2] exportGate 纯函数（design §2.1-3）：
 * 统一 pairwise 判据的**导出前置门**——SVG / BOM / PNG / 送精修共同前置。
 *
 * 语义（R2 §一 P0-2 / §四 P0-3；.gemshape gate 6）：
 * - spacing：逐对圆包络 requiredCenterDistancePx×0.999（与 validate/validateEditable 同判据）；
 * - mask：钻心不在所属块掩码内（blocks 传入时；与 validate 同中心点规则）；
 * - missing-asset：custom 钻引用的 .gemshape 资产非 resolved 态（resolveShapeAsset 传入时）——
 *   禁止静默降级为圆钻轮廓后照常导出（占位渲染 + BOM 标注 missing + **导出硬阻断**）。
 * - **保存允许 warning（文档可存），导出必须阻断**（design §2.1-2 边界与状态语义冻结）：
 *   violations 由保存路径降级呈现（warning），导出路径以 ok=false 硬阻断。
 * - 违规清单确定性排序（kind 秩 → gemId 字典序）——同输入同输出。
 *
 * 多层导出（studio-layers §E.6）：调用方对各层 gems **concat 后**送入门（层序组织归
 * studio-layers；隐藏层包含与硬阻断判据在本函数证明）。布局五策略/relax 输入仍单 spec
 * （design §2.1-2），其产物入文档时由本门强制 pairwise 判据——违规不得自动宣称合规。
 *
 * UI 接线归 studio-layers / rename-and-expert-workbench（design §0.2）——本文件只交付
 * 纯函数 + 测试。
 */

import { effectiveSpecOf, maxCellPx, requiredCenterDistancePx } from "./geometry";
import type { GemSpecFields } from "./geometry";
import { SpatialIndex } from "./ops";
import type { Block, Gem, GridSpec } from "./types";
import { GridSpecSchema } from "./types";

/**
 * custom 资产解析态（.gemshape 引用 missing 四态的 engine 侧镜像——定名与转移矩阵见
 * persistence/gemshapeFile.ts GemshapeRefState / design §3.2-7；engine 不 import persistence）。
 * `null` = 节点不存在（硬清后）。
 */
export type ShapeAssetRefState = 'resolved' | 'soft-deleted' | 'blob-missing' | 'wrong-kind' | null;

export interface ExportGateOptions {
  grid: GridSpec;
  /** 掩码检查（可选；不传则跳过 mask 违规面）。 */
  blocks?: Block[];
  /**
   * custom 资产解析面（gate 6 判据；可选——运行时接线归 2.2 vertical slice / studio gate，
   * 未接线时 missing-asset 检查跳过，不视为合规以外的任何断言）。
   */
  resolveShapeAsset?: (assetId: string) => ShapeAssetRefState;
}

export type ExportViolationKind = 'spacing' | 'mask' | 'missing-asset';

export interface ExportViolation {
  kind: ExportViolationKind
  detail: string
  /** 涉及钻 id（确定性排序键；spacing = 违规对两钻）。 */
  gemIds: string[]
}

export interface ExportGateVerdict {
  /** false = 存在任一违规（导出硬阻断）；true = 可导出。 */
  ok: boolean
  /** 确定性排序（kind 秩 spacing < mask < missing-asset → gemIds 字典序）。 */
  violations: ExportViolation[]
}

const KIND_RANK: Record<ExportViolationKind, number> = { spacing: 0, mask: 1, 'missing-asset': 2 };

function compareViolations(a: ExportViolation, b: ExportViolation): number {
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (byKind !== 0) return byKind;
  const len = Math.min(a.gemIds.length, b.gemIds.length);
  for (let i = 0; i < len; i += 1) {
    if (a.gemIds[i] !== b.gemIds[i]) return a.gemIds[i] < b.gemIds[i] ? -1 : 1;
  }
  return a.gemIds.length - b.gemIds.length;
}

/**
 * 导出前置门（纯函数）。gems 为**全层 concat** 后的钻集（层序组织归调用方）；
 * 结构约束 = Gem + 可选规格物化字段（diameterMm 缺席按 grid 基准规格派生——与
 * validate/resolveGreedy 同一 effectiveSpecOf 单源）。
 */
export function exportGate<T extends Gem & GemSpecFields>(
  gems: readonly T[],
  options: ExportGateOptions,
): ExportGateVerdict {
  const g = GridSpecSchema.parse(options.grid);
  const specs = gems.map((gem) => effectiveSpecOf(gem, g));
  const requiredOfPair = (i: number, j: number): number =>
    requiredCenterDistancePx(specs[i], specs[j], g) * 0.999;
  const violations: ExportViolation[] = [];

  // ---- spacing（cell = maxCellPx；逐对圆包络） ----
  if (gems.length > 0) {
    const index = new SpatialIndex<number>(maxCellPx(specs, g));
    gems.forEach((gem, i) => index.insert(gem.x, gem.y, i));
    const seenPairs = new Set<number>();
    for (let i = 0; i < gems.length; i++) {
      for (const j of index.query(gems[i].x, gems[i].y)) {
        if (j <= i) continue;
        const dx = gems[j].x - gems[i].x;
        const dy = gems[j].y - gems[i].y;
        const threshold = requiredOfPair(i, j);
        if (dx * dx + dy * dy >= threshold * threshold) continue;
        const key = i * gems.length + j;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const d = Math.sqrt(dx * dx + dy * dy);
        violations.push({
          kind: 'spacing',
          detail: `钻 ${gems[i].id} 与 ${gems[j].id} 中心距 ${d.toFixed(2)}px < 所需 ${threshold.toFixed(2)}px`,
          gemIds: [gems[i].id, gems[j].id],
        });
      }
    }
  }

  // ---- mask（钻心在所属块掩码内；与 validate 同中心点规则） ----
  if (options.blocks !== undefined) {
    const byId = new Map(options.blocks.map((b) => [b.id, b] as const));
    for (const gem of gems) {
      const block = byId.get(gem.blockId);
      if (!block) {
        violations.push({
          kind: 'mask',
          detail: `钻 ${gem.id} 引用不存在的块 ${gem.blockId}`,
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
        violations.push({
          kind: 'mask',
          detail: `钻 ${gem.id} 中心 (${gem.x.toFixed(1)},${gem.y.toFixed(1)}) 越出块 ${block.id} 掩码`,
          gemIds: [gem.id],
        });
      }
    }
  }

  // ---- missing-asset（gate 6：custom 引用非 resolved = 硬阻断，禁静默降级导出） ----
  if (options.resolveShapeAsset !== undefined) {
    const reported = new Set<string>();
    for (const gem of gems) {
      if (gem.assetId === undefined) continue;
      if (reported.has(gem.assetId)) continue;
      const state = options.resolveShapeAsset(gem.assetId);
      if (state !== 'resolved') {
        reported.add(gem.assetId);
        violations.push({
          kind: 'missing-asset',
          detail: `钻形资产 ${gem.assetId} 不可用（${state ?? 'not-found'}）：占位渲染 + 清单标注 missing，导出阻断`,
          gemIds: gems.filter((x) => x.assetId === gem.assetId).map((x) => x.id),
        });
      }
    }
  }

  violations.sort(compareViolations);
  return { ok: violations.length === 0, violations };
}
