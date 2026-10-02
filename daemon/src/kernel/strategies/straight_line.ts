/**
 * 直线刚硬族（add-subject-sam-pipeline design §4.2——P1.2；Owner 定调主文：「直线的那
 * 就刚硬的（比如剑/杆/栅栏）」）。掩膜主轴（成员像素协方差 PCA——最大特征值特征向量）
 * → 平行线族布点：线方向=主轴+角度偏移，线距=lineSpacingMm（缺省=密度推导间距 s），
 * 线上点距=s 等距（同相位对齐——刚硬观感，不消机械对齐：Owner 明要机械刚硬）。
 *
 * close-paving-backlog T4（2026-10-02——multistrat §8-5 回流：PCA 全局取向对曲面刚体
 * 只能平行直线族）：增 orientation 取向场双模——
 *   global-pca（缺省）=现状平行线族（**逐位不变**——分支零改动）；
 *   gradient-field   =**布点核替换**（非扩参级）：方向场（orientation_field.ts 共享件
 *                     ——texture_fill 同一张量计算单源）驱动的 seed+RK 步进延伸弯曲
 *                     折线族；种子=法向等距线排布（lineSpacingMm 法向分离——平行线的
 *                     轴向间距语义在弯曲模式不复用），逐点沿局部主方向步进，曲率突变
 *                     （步向夹角 >75°）断线；亮度经 params.lumaB64 注入（缺省退化掩膜
 *                     形状流+degraded warning——「曲面贴合」原始诉求依赖真实纹理）。
 *
 * 参数：lineSpacingMm（线距/法向分离）/ angleOffsetDeg（global-pca 主轴角度偏移）/
 * orientation / lumaB64。密度/钻径贯穿 ctx；钻径=判距硬门（生成级自保证，终裁
 * enforceMinSpacing）。确定性：纯算法无随机（同输入同输出——§4.4）。
 * 色彩族完整性硬门位（§10 回流 3）：colorFamily 预留+warning（选色归 P3）。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import type { TreeMask2D } from '../vision/tree-to-blocks.js';
import { MIN_READABLE_GEMS, characteristicSpacingPx, compassRotationDeg } from './geometry.js';
import { orientationField } from './orientation_field.js';
import type { KernelStrategy } from './registry.js';

// ---------------------------------------------------------------- 参数 schema（Zod 冻结）

/** 亮度场 base64 校验（texture_fill 同款——宽容标准字母表；长度语义 w*h 在 apply 内验）。 */
const lumaB64Field = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'lumaB64 须为标准 base64');

export const StraightLineParamsSchema = z
  .object({
    /**
     * 取向模式（T4）：global-pca=现状平行线族（缺省——逐位不变）；gradient-field=
     * 方向场驱动弯曲折线族（曲面贴合——multistrat §8-5 回流）。
     */
    orientation: z.enum(['global-pca', 'gradient-field']).default('global-pca'),
    /**
     * 线距（mm）：global-pca=平行线轴向间距；gradient-field=弯曲折线族法向分离。
     * 缺省=密度推导间距 s；下限=max(钻径mm, 0.05)。
     */
    lineSpacingMm: z.number().min(0.05).max(200).optional(),
    /** 主轴角度偏移（deg——线方向=PCA 主轴+偏移；±90 等价取模。仅 global-pca 消费）。 */
    angleOffsetDeg: z.number().min(-90).max(90).default(0),
    /**
     * 亮度场（w*h 灰度字节 base64——gradient-field 的方向场输入；缺席退化掩膜形状流
     * +degraded warning。texture_fill.ts:18-21 同款数据通道）。
     */
    lumaB64: lumaB64Field.optional(),
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

// ---------------------------------------------------------------- gradient-field 布点核（T4）

/** 线点空间哈希（法向分离判据——cell=lineSep，3×3 邻域查距；独立实现不共享 texture 追踪器）。 */
class SeparationHash {
  private m = new Map<number, { x: number; y: number }[]>();
  constructor(private cellPx: number) {}
  private key(cx: number, cy: number): number {
    return cy * 1000000 + cx;
  }
  add(x: number, y: number): void {
    const k = this.key(Math.floor(x / this.cellPx), Math.floor(y / this.cellPx));
    let arr = this.m.get(k);
    if (!arr) {
      arr = [];
      this.m.set(k, arr);
    }
    arr.push({ x, y });
  }
  /** (x,y) 与任一已存点距 < minPx 即被占。 */
  blocked(x: number, y: number, minPx: number): boolean {
    const cx = Math.floor(x / this.cellPx);
    const cy = Math.floor(y / this.cellPx);
    const reach = Math.ceil(minPx / this.cellPx) + 1;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const arr = this.m.get(this.key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const q of arr) {
          if ((q.x - x) ** 2 + (q.y - y) ** 2 < minPx * minPx) return true;
        }
      }
    }
    return false;
  }
}

/** 弯曲折线族布点核输出（bbox 局部坐标——apply 侧统一过滤/判距）。 */
interface CurvedLineResult {
  pts: { x: number; y: number; rotDeg: number }[];
}

/**
 * gradient-field 布点核（design §4——seed+RK 步进延伸弯曲折线族）：
 *   [1] 方向场=orientationField 共享件（lumaB64 缺席=掩膜形状流，fromLuma=false）；
 *   [2] 种子线=过 PCA 质心、沿主轴法向的等距排布（(k+0.5)×lineSep 双侧——首线不压
 *       质心钉死对称；法向分离 lineSpacingMm）；
 *   [3] 逐种子双向 RK2 步进（方向取中点场向——二阶精度；步长=max(1.5, lineSep/2)
 *       有界）：出掩膜/贴近已有线点（0.98×lineSep——法向分离判据）/曲率突变
 *       （步向夹角 >75°）即停；
 *   [4] 沿线步长 s 等距布点，钻角=局部场向切线（compassRotationDeg 罗盘式）。
 * 确定性：种子序/步进序全确定（同输入同输出）；不共享 texture flow 的 BFS 追踪器
 * （全域流线语义不同——R1-P2-3）。
 */
function curvedLineFamily(
  mask: TreeMask2D,
  lumaB64: string | undefined,
  s: number,
  lineSep: number,
  extV: number,
  axis: { angle: number; cx: number; cy: number },
): CurvedLineResult {
  const { w, h, bits } = mask;
  const ori = orientationField(lumaB64, mask);
  const tangAt = (x: number, y: number): { tx: number; ty: number } | null => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 1 || iy < 1 || ix >= w - 1 || iy >= h - 1) return null;
    const i = iy * w + ix;
    const n = Math.hypot(ori.tx[i]!, ori.ty[i]!);
    if (n < 1e-6) return null;
    return { tx: ori.tx[i]! / n, ty: ori.ty[i]! / n };
  };
  const inside = (x: number, y: number): boolean =>
    x > 1 && y > 1 && x < w - 2 && y < h - 2 && bits[Math.round(y) * w + Math.round(x)] === 1;

  // 种子线：法向 v（主轴 +90°）等距排布（(k+0.5)×lineSep——k 双侧）
  const vx = -Math.sin(axis.angle);
  const vy = Math.cos(axis.angle);
  const seeds: { x: number; y: number }[] = [];
  for (let k = 0; (k + 0.5) * lineSep <= extV; k++) {
    for (const side of [1, -1] as const) {
      const t = side * (k + 0.5) * lineSep;
      const q = { x: axis.cx + vx * t, y: axis.cy + vy * t };
      if (inside(q.x, q.y)) seeds.push(q);
    }
  }

  const hash = new SeparationHash(lineSep);
  const sepMin = 0.98 * lineSep; // 法向分离判据（真贴近才拒——同线沿链点距=步长 ≥ 判据不自杀）
  const stepLen = Math.max(1.5, Math.min(8, lineSep / 2));
  const cos75 = Math.cos((75 * Math.PI) / 180); // 曲率突变断线阈（步向夹角 >75°）

  /** 单向 RK2 步进延伸（dir=±1 定向）；返回有序段（起点=seed）。 */
  const trace = (seed: { x: number; y: number }, dir: 1 | -1): { x: number; y: number }[] => {
    const seg: { x: number; y: number }[] = [];
    let x = seed.x;
    let y = seed.y;
    let px = 0;
    let py = 0;
    for (let step = 0; step < 20000; step++) {
      const k1 = tangAt(x, y);
      if (!k1) break;
      const mx = x + (dir * k1.tx * stepLen) / 2;
      const my = y + (dir * k1.ty * stepLen) / 2;
      const k2 = tangAt(mx, my);
      if (!k2) break;
      const nx = x + dir * k2.tx * stepLen;
      const ny = y + dir * k2.ty * stepLen;
      if (!inside(nx, ny)) break;
      if (hash.blocked(nx, ny, sepMin)) break;
      if (px !== 0 || py !== 0) {
        const dot = (px * k2.tx + py * k2.ty) / (Math.hypot(px, py) || 1);
        if (dot < cos75) break; // 曲率突变断线
      }
      x = nx;
      y = ny;
      px = k2.tx;
      py = k2.ty;
      seg.push({ x, y });
    }
    return seg;
  };

  const pts: { x: number; y: number; rotDeg: number }[] = [];
  for (const seed of seeds) {
    if (hash.blocked(seed.x, seed.y, sepMin)) continue; // 种子落已有线法向域内——弃
    const forward = trace(seed, 1);
    const backward = trace(seed, -1).reverse();
    const poly = [seed, ...backward, ...forward];
    for (const q of poly) hash.add(q.x, q.y);
    if (poly.length < 2) continue;
    // 沿线等距布点（弧长步进 s；首点=相位 0——刚硬同相位语义）；钻角=局部场向
    let next = 0;
    let prev = poly[0]!;
    let acc = 0;
    const emit = (q: { x: number; y: number }): void => {
      const t = tangAt(q.x, q.y);
      if (!t) return;
      pts.push({ x: q.x, y: q.y, rotDeg: compassRotationDeg(t.tx, t.ty) });
    };
    emit(prev);
    for (let i = 1; i < poly.length; i++) {
      const cur = poly[i]!;
      const seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      acc += seg;
      while (next + s <= acc) {
        next += s;
        const f = (next - (acc - seg)) / seg;
        emit({ x: prev.x + (cur.x - prev.x) * f, y: prev.y + (cur.y - prev.y) * f });
      }
      prev = cur;
    }
  }
  return { pts };
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

    const warnings: Array<{ kind: 'degraded' | 'geometry'; detail: string }> = [];
    let raw: { x: number; y: number; rotDeg?: number }[];
    if (p.orientation === 'global-pca') {
      // —— 现状平行线族（T4 缺省分支——**逐位不变**：线方向=PCA 主轴+偏移，线上点距 s 等距同相位）
      raw = [];
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
    } else {
      // —— gradient-field 布点核替换（T4）：方向场弯曲折线族；luma 缺席退化掩膜形状流
      if (p.lumaB64 !== undefined) {
        const raw2 = Buffer.from(p.lumaB64, 'base64');
        if (raw2.length !== w * h) {
          throw new RangeError(`lumaB64 解码长度 ${raw2.length} ≠ 掩膜 w*h=${w * h}（亮度场与掩膜同 bbox 语义）`);
        }
      } else {
        warnings.push({
          kind: 'degraded',
          detail: 'straight-line gradient-field 无 lumaB64 亮度输入——方向场退化为掩膜形状流（顺掩膜等值线；真实曲面方向需指派附亮度场）',
        });
      }
      raw = curvedLineFamily(mask, p.lumaB64, s, lineSep, extV, axis).pts;
    }

    if (p.colorFamily !== undefined) {
      warnings.push({
        kind: 'degraded',
        detail: `色彩族完整性硬门位（§10 回流 3）：colorFamily=${p.colorFamily} 已记录，选色归 P3 策略设计器（本族 colorId 恒 ''）`,
      });
    }

    // 钻径硬门（线距/点距 ≥s≥ 钻径——平行线间垂距=lineSep≥钻径，keep-earlier 终裁边界交角处）；
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
            detail: `straight-line 布点 ${spaced.length} 颗 < 可读下限 ${MIN_READABLE_GEMS}（极小产出可读性兜底——声明密度优先）——降级引擎 ${p.fallbackEngineStrategy}（目标密度不变，仅形态兜底）`,
          },
        ],
        engineStrategy: {
          engineStrategy: p.fallbackEngineStrategy,
          reason: 'geometry-min-size' as const,
          note: `${block.label}：直线族低于可读兜底下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
        },
      };
    }

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    // 角度填充（Owner 统一理论 2026-10-02）：rotationDeg=线方向（主轴+偏移）的罗盘角
    // ——平行线族内所有钻同角（刚硬语义：异形长轴沿线方向，线条纹理观感）；
    // gradient-field 逐钻=局部场向切线（curvedLineFamily 已带 rotDeg——fallback 缺省
    // 不发生：布点核每点必带角；类型面 optional 仅容缺省分支）。
    const globalRotationDeg = round6(compassRotationDeg(ux, uy));
    const gems = spaced.map((q, i) => {
      const rot = (q as { rotDeg?: number }).rotDeg;
      return {
        id: `${block.id}#s${String(i + 1).padStart(4, '0')}`,
        x: block.bbox.x + q.x,
        y: block.bbox.y + q.y,
        colorId: '',
        blockId: block.id,
        shapeId: 'round' as const,
        diameterMm,
        rotationDeg: rot !== undefined ? round6(rot) : globalRotationDeg,
      };
    });
    return { gems, warnings };
  },
};
