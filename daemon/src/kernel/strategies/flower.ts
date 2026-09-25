/**
 * 花形族（add-subject-sam-pipeline design §4.2——P1.2；Owner 定调主文：「花形的要抓住
 * 花心和花瓣」）。极坐标分解（design §4.2「节点内极坐标分解（花心=距心最近聚类核，
 * 花瓣=角度扇区）」的工程化）：
 *   花心=掩膜质心（geometry.maskCentroid——树管线节点即主体，圆布同心环到 coreRatio×rMax）；
 *   花瓣=径向边界签名 r(θ)（逐角 bin 掩膜成员最大半径+循环平滑）去均值后的峰位=花瓣
 *   极角、峰数=花瓣数（自动检测可被 params.petals 覆写）——花瓣区按同心弧线布点，
 *   弧上仅取掩膜内角度段（弧线自然贴合花瓣瓣形——瓣凸处弧长、瓣凹处收短）。
 *
 * 参数（design §4.2 参数≤5）：petals（花瓣数——缺省自动检测，界 [3,64]）/
 * coreRadiusRatio（花心占比 r0/rMax）/ petalDensity（花瓣布点密度——弧向间距缩放倒数）。
 * 密度/钻径贯穿 ctx（特征间距 s=characteristicSpacingPx；花心环距=s、花瓣弧向间距=
 * s/petalDensity）；钻径=判距硬门。环/弧相位黄金角错开消径向机械对齐（geometry 同哲学）。
 * 色彩族完整性硬门位（§10 回流 3）：colorFamily 预留+warning（选色归 P3）。
 * 确定性：纯算法无随机（同输入同输出——§4.4）。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import type { TreeMask2D } from '../vision/tree-to-blocks.js';
import { MIN_READABLE_GEMS, characteristicSpacingPx } from './geometry.js';
import type { KernelStrategy } from './registry.js';

// ---------------------------------------------------------------- 参数 schema（Zod 冻结）

export const FlowerParamsSchema = z
  .object({
    /** 花瓣数（缺省=径向签名自动检测；界 [3,64]——检测出界时钳制并 warning） */
    petals: z.number().int().min(3).max(64).optional(),
    /** 花心占比：花心圆布半径 = coreRadiusRatio × rMax */
    coreRadiusRatio: z.number().gt(0.05).lt(0.8).default(0.3),
    /** 花瓣布点密度（弧向间距=s/petalDensity——>1 花瓣更密） */
    petalDensity: z.number().min(0.2).max(5).default(1),
    colorFamily: z.string().min(1).max(64).optional(),
    fallbackEngineStrategy: StrategyIdSchema.default('hex-pitch'),
  })
  .strict();
export type FlowerParams = z.output<typeof FlowerParamsSchema>;

// ---------------------------------------------------------------- 径向签名与花瓣检测

/** 循环盒式平滑（1D 环信号）。 */
function circularSmooth(sig: Float64Array, r: number): Float64Array {
  const n = sig.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let d = -r; d <= r; d++) acc += sig[(i + d + n * 4) % n]!;
    out[i] = acc / (2 * r + 1);
  }
  return out;
}

/**
 * 径向边界签名 r(θ)（K 个角 bin 的掩膜成员最大半径）+ 花瓣自动检测（去均值峰计数，
 * 显著性 ≥ max(12% 峰谷差, 4.5% rMax)——绝对 px 下限抗栅格化涟漪；循环平滑 K/24≈15°）。
 * 返回签名与检测花瓣数（未检测出=0）。导出面：花瓣检测数断言复用同一真源。
 */
export function radialSignatureAndPetals(mask: TreeMask2D, cx: number, cy: number): {
  sig: Float64Array;
  detected: number;
} {
  const K = 256;
  const maxR = new Float64Array(K);
  const { w, h } = mask;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask.bits[y * w + x] !== 1) continue;
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const bin = Math.floor((((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * K);
      if (r > maxR[bin]!) maxR[bin] = r;
    }
  }
  const sig = circularSmooth(maxR, Math.max(2, Math.round(K / 24)));
  // 去均值（花心圆对称基线）→ 峰计数（显著性含绝对 px 下限——像素盘边界涟漪不计数）
  let mean = 0;
  for (let i = 0; i < K; i++) mean += sig[i]!;
  mean /= K;
  const detrended = new Float64Array(K);
  for (let i = 0; i < K; i++) detrended[i] = sig[i]! - mean;
  let lo = Infinity;
  let hi = -Infinity;
  let sigMax = 0;
  for (let i = 0; i < K; i++) {
    if (detrended[i]! < lo) lo = detrended[i]!;
    if (detrended[i]! > hi) hi = detrended[i]!;
    if (sig[i]! > sigMax) sigMax = sig[i]!;
  }
  const prom = Math.max((hi - lo) * 0.12, sigMax * 0.045);
  let peaks = 0;
  for (let i = 0; i < K; i++) {
    const v = detrended[i]!;
    if (v < prom) continue;
    const prev = detrended[(i - 1 + K) % K]!;
    const next = detrended[(i + 1) % K]!;
    if (v >= prev && v > next) peaks++;
  }
  return { sig, detected: peaks };
}

// ---------------------------------------------------------------- 策略实现

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 黄金角比例相位（环/弧间错位——消径向对齐机械感）。 */
function ringPhase(k: number): number {
  return (k * 0.618033988749895) % 1;
}

export const flowerStrategy: KernelStrategy = {
  kind: 'flower',
  status: 'implemented',
  paramsSchema: FlowerParamsSchema,
  apply(input, ctx) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = FlowerParamsSchema.parse(input.params ?? {});
    const block = input.block;
    const mask = block.mask;
    const ppm = input.canvas.pixelsPerMm;
    const s = characteristicSpacingPx(ctx.gemDiameterPx, ctx.densityPerCm2, ppm);

    // 极坐标基（bbox 局部——gem 输出时加 bbox 偏移）
    const c = ctx.geometry.maskCentroid(mask, { x: 0, y: 0, w: mask.w, h: mask.h });
    const cx = c.x;
    const cy = c.y;
    const rMax = ctx.geometry.maskMaxRadius(mask, { x: 0, y: 0, w: mask.w, h: mask.h }, c);

    const warnings = [];
    const { sig, detected } = radialSignatureAndPetals(mask, cx, cy);
    let petals: number;
    if (p.petals !== undefined) {
      petals = p.petals;
    } else if (detected >= 3) {
      petals = Math.min(64, detected);
    } else {
      petals = 0; // 无显著瓣状结构——花心圆布全域退化（同心环铺满）
      warnings.push({
        kind: 'geometry' as const,
        detail: `径向签名未检出显著花瓣结构（检测峰 ${detected}）——退化为花心同心环全域铺装`,
      });
    }

    const inMaskAt = (x: number, y: number): boolean => {
      const ix = Math.round(x);
      const iy = Math.round(y);
      return ix >= 0 && iy >= 0 && ix < mask.w && iy < mask.h && mask.bits[iy * mask.w + ix] === 1;
    };

    // ---- 花心圆布：同心环到 r0（相位黄金角错开）----
    const raw: { x: number; y: number }[] = [];
    const r0 = p.coreRadiusRatio * rMax;
    for (let k = 0; ; k++) {
      const r = (k + 0.5) * s;
      if (r > r0) break;
      const n = Math.max(1, Math.floor((2 * Math.PI * r) / s));
      for (let j = 0; j < n; j++) {
        const theta = ((j + ringPhase(k)) * 2 * Math.PI) / n;
        const x = cx + r * Math.cos(theta);
        const y = cy + r * Math.sin(theta);
        if (inMaskAt(x, y)) raw.push({ x, y });
      }
    }

    // ---- 花瓣弧线：r0 到 rMax 的同心弧，弧上仅取掩膜内角度段（贴合瓣形；环间相位错开）----
    const arcSpacing = s / p.petalDensity; // 花瓣密度=弧向间距缩放
    for (let k = 0; ; k++) {
      const r = r0 + (k + 0.5) * s;
      if (r > rMax) break;
      // 角域细扫找 in-mask 连续弧段（扫描相位随环错开——消径向对齐）
      const dTheta = Math.min(0.02, Math.max(0.002, s / Math.max(1, r) / 4));
      const marks: boolean[] = [];
      const phase = ringPhase(k) * dTheta * 4;
      for (let t = 0; t < 1; t += dTheta) {
        const theta = phase + t * 2 * Math.PI;
        marks.push(inMaskAt(cx + r * Math.cos(theta), cy + r * Math.sin(theta)));
      }
      // 弧段布点（弧长=弧向间距；段中均布）
      let i = 0;
      const M = marks.length;
      while (i < M) {
        if (!marks[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j < M && marks[j]) j++;
        const arcStart = phase + (i / M) * 2 * Math.PI;
        const arcEnd = phase + (j / M) * 2 * Math.PI;
        const arcLen = r * (arcEnd - arcStart);
        const nPts = Math.floor(arcLen / arcSpacing);
        for (let m = 0; m < nPts; m++) {
          const theta = arcStart + ((m + 0.5) / nPts) * (arcEnd - arcStart); // 段中均布
          raw.push({ x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) });
        }
        i = j;
      }
    }
    // petals 扇区约束（瓣间凹谷带不布：凹谷=相邻花瓣极角中点，排除带半宽 0.35×π/petals
    // ——极角扇区语义的「瓣强调收边」；全覆盖扇（±π/P）恒空转，掩膜已决定弧存在域）
    let sectorPts: { x: number; y: number }[] = raw;
    if (petals > 0) {
      const K = sig.length;
      // 峰位=花瓣极角（覆写 petals 时等分圆）
      const centers: number[] = [];
      if (p.petals !== undefined) {
        for (let k = 0; k < petals; k++) centers.push((k / petals) * 2 * Math.PI);
      } else {
        let mean = 0;
        for (let i = 0; i < K; i++) mean += sig[i]!;
        mean /= K;
        for (let i = 0; i < K; i++) {
          const v = sig[i]! - mean;
          if (v <= 0) continue;
          const prev = sig[(i - 1 + K) % K]! - mean;
          const next = sig[(i + 1) % K]! - mean;
          if (v >= prev && v > next) centers.push((i / K) * 2 * Math.PI);
        }
        // 检测峰数与钳制后 petals 不一致时等分兜底
        if (centers.length !== petals) {
          centers.length = 0;
          for (let k = 0; k < petals; k++) centers.push((k / petals) * 2 * Math.PI);
        }
      }
      centers.sort((a, b) => a - b);
      const valleys = centers.map((c, i) => {
        const next = centers[(i + 1) % centers.length]!;
        return (c + (next > c ? next : next + 2 * Math.PI)) / 2;
      });
      const valleyHalf = (0.35 * Math.PI) / petals;
      const angDist = (a: number, b: number) => {
        let d = Math.abs(a - b) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        return d;
      };
      sectorPts = raw.filter((q) => {
        const r = Math.hypot(q.x - cx, q.y - cy);
        if (r <= r0) return true; // 花心不筛
        const theta = (Math.atan2(q.y - cy, q.x - cx) + 2 * Math.PI) % (2 * Math.PI);
        return !valleys.some((v) => angDist(theta, v % (2 * Math.PI)) <= valleyHalf);
      });
    }

    if (p.colorFamily !== undefined) {
      warnings.push({
        kind: 'degraded' as const,
        detail: `色彩族完整性硬门位（§10 回流 3）：colorFamily=${p.colorFamily} 已记录，选色归 P3 策略设计器（本族 colorId 恒 ''）`,
      });
    }

    // 掩膜内过滤兜底（弧段细扫步长与落点取整的边界差——细结构（花茎）边界摆动）+
    // 钻径硬门（花心环距/弧向间距均 ≥s≥钻径——相邻弧不同相位可能贴近，keep-earlier 终裁）
    const inMask = sectorPts.filter((q) => inMaskAt(q.x, q.y));
    const spaced = ctx.geometry.enforceMinSpacing(inMask, ctx.gemDiameterPx * 0.999);

    if (spaced.length < MIN_READABLE_GEMS) {
      return {
        gems: [],
        warnings: [
          ...warnings,
          {
            kind: 'degraded' as const,
            detail: `flower 布点 ${spaced.length} 颗 < 可读下限 ${MIN_READABLE_GEMS}（节点过小/占比过窄）——降级引擎 ${p.fallbackEngineStrategy}`,
          },
        ],
        engineStrategy: {
          engineStrategy: p.fallbackEngineStrategy,
          reason: 'geometry-min-size' as const,
          note: `${block.label}：花形不足可读下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
        },
      };
    }

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    const gems = spaced.map((q, i) => ({
      id: `${block.id}#f${String(i + 1).padStart(4, '0')}`,
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
