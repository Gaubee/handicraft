/**
 * 直线刚硬族（add-subject-sam-pipeline design §4.2——P1.2；Owner 定调主文：「直线的那
 * 就刚硬的（比如剑/杆/栅栏）」）。掩膜主轴（成员像素协方差 PCA——最大特征值特征向量）
 * → 平行线族布点：线方向=主轴+角度偏移，线距=lineSpacingMm（缺省=密度推导间距 s），
 * 线上点距=s 等距（同相位对齐——刚硬观感，不消机械对齐：Owner 明要机械刚硬）。
 *
 * 参数（design §4.2 参数≤5）：lineSpacingMm（线距）/ angleOffsetDeg（主轴角度偏移）。
 * 密度/钻径贯穿 ctx；钻径=判距硬门（线距与点距均 ≥s≥钻径，生成级自保证）。
 * 色彩族完整性硬门位（§10 回流 3）：colorFamily 预留+warning（选色归 P3）。
 * 确定性：纯算法无随机（同输入同输出——§4.4）。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import type { TreeMask2D } from '../vision/tree-to-blocks.js';
import { MIN_READABLE_GEMS, characteristicSpacingPx } from './geometry.js';
import type { KernelStrategy } from './registry.js';

// ---------------------------------------------------------------- 参数 schema（Zod 冻结）

export const StraightLineParamsSchema = z
  .object({
    /** 线距（mm——缺省=密度推导间距 s；下限=max(钻径mm, 0.05)） */
    lineSpacingMm: z.number().min(0.05).max(200).optional(),
    /** 主轴角度偏移（deg——线方向=PCA 主轴+偏移；±90 等价取模） */
    angleOffsetDeg: z.number().min(-90).max(90).default(0),
    colorFamily: z.string().min(1).max(64).optional(),
    fallbackEngineStrategy: StrategyIdSchema.default('hex-pitch'),
  })
  .strict();
export type StraightLineParams = z.output<typeof StraightLineParamsSchema>;

// ---------------------------------------------------------------- 掩膜主轴（PCA）

/** 成员像素协方差 PCA：主轴角+质心（线族锚定=过质心的平行线族——几何中心语义）。 */
function principalAxis(mask: TreeMask2D): { angle: number; cx: number; cy: number } {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (mask.bits[y * mask.w + x] !== 1) continue;
      sx += x;
      sy += y;
      n++;
    }
  }
  if (n === 0) throw new RangeError('principalAxis：全零掩膜（P0.2 保证不产空块——上游契约破裂）');
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (mask.bits[y * mask.w + x] !== 1) continue;
      const dx = x - mx;
      const dy = y - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
  }
  // 对称 2×2 特征向量：θ=½·atan2(2sxy, sxx−syy)（最大特征值方向）
  return { angle: 0.5 * Math.atan2(2 * sxy, sxx - syy), cx: mx, cy: my };
}

// ---------------------------------------------------------------- 策略实现

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export const straightLineStrategy: KernelStrategy = {
  kind: 'straight-line',
  status: 'implemented',
  paramsSchema: StraightLineParamsSchema,
  apply(input, ctx) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = StraightLineParamsSchema.parse(input.params ?? {});
    const block = input.block;
    const mask = block.mask;
    const { w, h } = mask;
    const ppm = input.canvas.pixelsPerMm;
    const s = characteristicSpacingPx(ctx.gemDiameterPx, ctx.densityPerCm2, ppm);
    const lineSep =
      p.lineSpacingMm !== undefined ? Math.max(ctx.gemDiameterPx, p.lineSpacingMm * ppm) : s;

    // 旋转系：u=线方向（主轴+偏移）、v=法向；锚点=PCA 质心（过质心平行线族）；旋转外接半长
    const axis = principalAxis(mask);
    const phi = axis.angle + (p.angleOffsetDeg * Math.PI) / 180;
    const ux = Math.cos(phi);
    const uy = Math.sin(phi);
    const vx = -Math.sin(phi);
    const vy = Math.cos(phi);
    const cx = axis.cx;
    const cy = axis.cy;
    const corners = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];
    let extU = 0;
    let extV = 0;
    for (const [px, py] of corners) {
      extU = Math.max(extU, Math.abs((px - cx) * ux + (py - cy) * uy));
      extV = Math.max(extV, Math.abs((px - cx) * vx + (py - cy) * vy));
    }

    const inMaskAt = (x: number, y: number): boolean => {
      const ix = Math.round(x);
      const iy = Math.round(y);
      return ix >= 0 && iy >= 0 && ix < w && iy < h && mask.bits[iy * w + ix] === 1;
    };

    // 平行线族：法向 (k+0.5)×lineSep 步进；线上细扫找 in-mask 连续段，段内点距 s 等距同相位
    const raw: { x: number; y: number }[] = [];
    for (let k = 0; (k + 0.5) * lineSep <= extV; k++) {
      for (const side of [1, -1] as const) {
        const t = side * (k + 0.5) * lineSep;
        if (t > extV) continue;
        const bx = cx + vx * t;
        const by = cy + vy * t;
        // 细扫（步长 s/4——段边界精度）
        const step = Math.max(0.5, s / 4);
        const nSteps = Math.ceil((2 * extU) / step);
        let i = 0;
        while (i <= nSteps) {
          const q0 = -extU + i * step;
          const p0 = { x: bx + ux * q0, y: by + uy * q0 };
          if (!inMaskAt(p0.x, p0.y)) {
            i++;
            continue;
          }
          let j = i;
          while (j <= nSteps) {
            const qj = -extU + j * step;
            if (!inMaskAt(bx + ux * qj, by + uy * qj)) break;
            j++;
          }
          // 段 [i, j)（弧长参数 q∈[q0, qj)）——段首对齐同相位（刚硬对齐）：q 从段首的 s 网格
          const qStart = -extU + i * step;
          const qEnd = -extU + j * step;
          const first = Math.ceil(qStart / s) * s;
          for (let q = first; q < qEnd - 1e-9; q += s) {
            raw.push({ x: bx + ux * q, y: by + uy * q });
          }
          i = j;
        }
      }
    }

    const warnings = [];
    if (p.colorFamily !== undefined) {
      warnings.push({
        kind: 'degraded' as const,
        detail: `色彩族完整性硬门位（§10 回流 3）：colorFamily=${p.colorFamily} 已记录，选色归 P3 策略设计器（本族 colorId 恒 ''）`,
      });
    }

    // 钻径硬门（线距/点距 ≥s≥钻径——平行线间垂距=lineSep≥钻径，keep-earlier 终裁边界交角处）；
    // 掩膜内过滤兜底（细扫步长 s/4 与落点像素取整的边界差）
    const inMask = raw.filter((q) => inMaskAt(q.x, q.y));
    const spaced = ctx.geometry.enforceMinSpacing(inMask, ctx.gemDiameterPx * 0.999);

    if (spaced.length < MIN_READABLE_GEMS) {
      return {
        gems: [],
        warnings: [
          ...warnings,
          {
            kind: 'degraded' as const,
            detail: `straight-line 布点 ${spaced.length} 颗 < 可读下限 ${MIN_READABLE_GEMS}（节点过窄/线距过大）——降级引擎 ${p.fallbackEngineStrategy}`,
          },
        ],
        engineStrategy: {
          engineStrategy: p.fallbackEngineStrategy,
          reason: 'geometry-min-size' as const,
          note: `${block.label}：直线族不足可读下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
        },
      };
    }

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    const gems = spaced.map((q, i) => ({
      id: `${block.id}#s${String(i + 1).padStart(4, '0')}`,
      x: block.bbox.x + q.x,
      y: block.bbox.y + q.y,
      colorId: '',
      blockId: block.id,
      shapeId: 'round' as const,
      diameterMm,
    }));
    return { gems, warnings };
  },
};
