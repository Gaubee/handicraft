/**
 * 自由代码输出强制引擎校验门（add-subject-sam-pipeline P1.4——design §4.4：
 * 「输出 Zod 校验必须为合法 Gem[]，然后强制过引擎校验门（最小间距）——不合格即
 * 策略失败回 LLM 重写」）。
 *
 * 引擎红线纪律：**不 import 不改动** rhinestone-studio/engine——判据按引擎
 * exportGate.ts/validate.ts 已文档语义同构自实现（同 P1.1 先例）：
 *   [1] spacing：逐对中心距 ≥ 所需中心距×0.999（exportGate requiredOfPair 同因子；
 *       内核钻 uniform 径 → 所需中心距=gemDiameterPx）；
 *   [2] mask：钻心像素中心取整落在所属块掩膜内（exportGate mask 面同中心点规则）。
 * 剔除策略=keep-earlier（与 geometry.ts enforceMinSpacing 同构语义——确定性回放
 * 前提：同输入同剔除序）。违例颗剔除+warnings（StrategyWarningKind 'spacing'/'mask'）；
 * 全灭 → typed error（gate-empty——非法输出有界重试回 LLM）。
 *
 * 本校验器即 strategies-geometry.test.ts assertGemsBlock 断言束（掩膜内+两两间距）的
 * 生产化抽出——断言规格与校验规格同源，测试不再各自复述。
 *
 * [闸门口径单源，2026-10-01 真链走查 P0-1] 导出闸门（engine exportGate）与 daemon 侧
 * 校验门/策略判距必须**同一换算**：本文件是 daemon 侧间距口径的唯一常量与公式源——
 *   - EXPORT_GATE_GRID_GAP_MM：导出门判距 gap（喂 task-layout.grid.gapMm → 引擎
 *     exportGate requiredCenterDistancePx）。0=钻径切距判据（与全部 daemon 门
 *     ×0.999 无 gap 语义一致；布局拾取间隙是**排布面**参数——引擎委派晶格
 *     ENGINE_DELEGATION_GAP_MM=0.4 在 design.ts，不进判距）。
 *   - gateRequiredPairPx：((a+b)/2 + EXPORT_GATE_GRID_GAP_MM)×ppm×0.999——引擎
 *     requiredCenterDistancePx×0.999 的同构镜像（gap=0 且 a=b 时与既有
 *     gemDiameterPx×0.999 逐位等价）。闸门-引擎一致性由
 *     tests/gate-engine-alignment.test.ts 直接对引擎函数断言把守。
 */
import type { TreeBBox, TreeMask2D } from '../../vision/tree-to-blocks.js';
import type { KernelGem } from '../registry.js';

/**
 * 导出门判距 gap（mm）——闸门-引擎同一换算的单源常量（P0-1）。
 * 消费面：gateRequiredPairPx（本文件）+ design.ts executeStrategyPlan 判距 +
 * task-layout.grid.gapMm（writeTaskLayoutForExecution 唯一传值面）。
 * 语义边界：这是**安全门**口径（钻不重叠/不互相嵌入）；转移膜拾取间隙（0.4mm）
 * 是排布策略面（ENGINE_DELEGATION_GAP_MM——引擎委派晶格 pitch），不混入门判距。
 */
export const EXPORT_GATE_GRID_GAP_MM = 0;

/**
 * 两钻所需最小中心距（px）——引擎 exportGate requiredOfPair 同构镜像（P0-1 单源）：
 * ((a.diameterMm + b.diameterMm)/2 + EXPORT_GATE_GRID_GAP_MM) × ppm × 0.999
 * （×0.999=引擎 v1 同口径浮点容差）。等径退化=(d+gap)×ppm×0.999。
 */
export function gateRequiredPairPx(diameterAmm: number, diameterBmm: number, pixelsPerMm: number): number {
  return ((diameterAmm + diameterBmm) / 2 + EXPORT_GATE_GRID_GAP_MM) * pixelsPerMm * 0.999;
}

/** 剔除记录（warnings 素材——index/id 溯源到用户原始输出序）。 */
export interface GemPlacementCulprit {
  index: number;
  id: string;
  kind: 'spacing' | 'mask';
  detail: string;
}

export interface GemPlacementVerdict {
  /** 依序存留的合法钻（keep-earlier——确定性）。 */
  kept: KernelGem[];
  culled: GemPlacementCulprit[];
}

export interface GemPlacementDeps {
  mask: TreeMask2D;
  bbox: TreeBBox;
  /** 逐对最小中心距 px（调用方：gemDiameterPx×0.999——exportGate 同因子）。 */
  minPx: number;
}

/** 钻心掩膜内判定（像素中心取整——引擎 inBlockMask/exportGate mask 面同构）。 */
export function gemInMask(mask: TreeMask2D, bbox: TreeBBox, x: number, y: number): boolean {
  const ix = Math.round(x) - bbox.x;
  const iy = Math.round(y) - bbox.y;
  if (ix < 0 || iy < 0 || ix >= mask.w || iy >= mask.h) return false;
  return mask.bits[iy * mask.w + ix] === 1;
}

/**
 * 强制校验门（O(n²) 逐对——预览量级，同 enforceMinSpacing 复杂度注记）。
 * 顺序：逐颗先 mask 后 spacing（对已存留集判距——与「先掩膜过滤后间距过滤」
 * 两阶段等价：kept 集排除掩膜违例颗后判距，结果集与两阶段一致）。
 */
export function validateGemPlacement(gems: readonly KernelGem[], deps: GemPlacementDeps): GemPlacementVerdict {
  const { mask, bbox, minPx } = deps;
  const kept: KernelGem[] = [];
  const culled: GemPlacementCulprit[] = [];
  for (let i = 0; i < gems.length; i++) {
    const g = gems[i]!;
    if (!gemInMask(mask, bbox, g.x, g.y)) {
      culled.push({
        index: i,
        id: g.id,
        kind: 'mask',
        detail: `钻 ${g.id} 中心 (${g.x.toFixed(1)}, ${g.y.toFixed(1)}) 越出块掩膜（引擎校验门 mask 面）`,
      });
      continue;
    }
    let tooClose = false;
    for (const q of kept) {
      if (Math.hypot(q.x - g.x, q.y - g.y) < minPx) {
        tooClose = true;
        culled.push({
          index: i,
          id: g.id,
          kind: 'spacing',
          detail: `钻 ${g.id} 与 ${q.id} 中心距 < ${minPx.toFixed(2)}px（引擎校验门 spacing 面）`,
        });
        break;
      }
    }
    if (!tooClose) kept.push(g);
  }
  return { kept, culled };
}

/**
 * 跨节点间距剔除（P0-1——真链走查「2 条真跨节点重叠」的剔除责任落位）：
 * executeStrategyPlan 的逐节点 P1.4 门只对本节点的已存留集判距，节点间重叠无人
 * 负责——本函数在全部节点 gems 汇总后做**跨节点对**的 keep-earlier 剔除（确定性：
 * 同 plan 同节点序同输出；逐对阈值=gateRequiredPairPx(双方钻径)——与导出门同源，
 * 混径节点对按 (a+b)/2 判）。掩膜面不查（每颗已过所属节点的 mask 门）。
 * O(n²) 逐对（预览量级——同 validateGemPlacement 复杂度注记）。
 */
export function validateCrossNodeGemSpacing(
  gems: readonly KernelGem[],
  pixelsPerMm: number,
): { kept: KernelGem[]; culled: GemPlacementCulprit[] } {
  const kept: KernelGem[] = [];
  const culled: GemPlacementCulprit[] = [];
  for (let i = 0; i < gems.length; i++) {
    const g = gems[i]!;
    let blocker: KernelGem | null = null;
    let required = 0;
    for (const q of kept) {
      if (q.blockId === g.blockId) continue; // 同节点对归 P1.4 门（已判）——本门只管跨节点
      const need = gateRequiredPairPx(q.diameterMm, g.diameterMm, pixelsPerMm);
      if (Math.hypot(q.x - g.x, q.y - g.y) < need) {
        blocker = q;
        required = need;
        break;
      }
    }
    if (blocker === null) {
      kept.push(g);
    } else {
      culled.push({
        index: i,
        id: g.id,
        kind: 'spacing',
        detail: `钻 ${g.id}（节点 ${g.blockId}）与 ${blocker.id}（节点 ${blocker.blockId}）中心距 < ${required.toFixed(2)}px（跨节点重叠——keep-earlier 剔除）`,
      });
    }
  }
  return { kept, culled };
}
