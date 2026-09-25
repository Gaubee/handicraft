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
 */
import type { TreeBBox, TreeMask2D } from '../../vision/tree-to-blocks.js';
import type { KernelGem } from '../registry.js';

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
