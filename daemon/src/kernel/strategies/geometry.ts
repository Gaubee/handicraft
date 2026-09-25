/**
 * 参数化几何族（add-subject-sam-pipeline design §4.1——P1.1；Owner 定调主文：
 * 「星状的、心形的、方形、圆形、矩形、椭圆形、螺旋形……这些基本的几何也是要支持的」）。
 *
 * 引擎红线纪律：**不 import 不改动** rhinestone-studio/engine——本文件按引擎
 * types.ts Gem/SHAPE_IDS、layout/common.ts inBlockMask/enforceMinDistance 的已文档
 * 语义同构自实现（同 P0.2 先例）；钻径/判距最终仍过引擎校验门（design §0——本族
 * 生成级自保证 ≥ 钻径切距，见 characteristicSpacingPx）。
 *
 * 六形状（briefing 冻结参数面）：
 *   star   星射线 { rays 射线数, innerRadiusRatio 内半径比, rotationDeg 旋转 }
 *          ——Owner 四参数的圆心=掩膜质心自动锚定（树管线节点即主体，不手填）、
 *          稀疏度=ctx 密度推导间距（StrategyAssignment.densityPerCm2 通道）。
 *   heart  心 { aspectRatio 宽高比, dentDepth 凹陷深 }（嵌套缩心填充）。
 *   circle 圆 / rect 矩 / ellipse 椭圆（基础——嵌套环/回字环/椭圆环填充，无族参数）。
 *   spiral 螺旋 { turns 匝数, pitchMm 螺距(缺省=密度推导), decay 衰减 }（阿基米德式
 *          r(θ)=R·(θ/θmax)^decay）。
 *
 * 确定性：全参数化纯函数（本族无随机——ctx.rng 留给 P1.2/P1.4 族），同输入同输出。
 * §9 回流 4：可读下限守卫——kept < MIN_READABLE_GEMS（或星每射线 < 3）→ 不自产钻，
 * 声明式降级引擎 hex（engineStrategy 通道——P3 接线消费，见 registry.ts adapter 契约）。
 * Owner 补充定调（2026-09-24 晚）：硬算法「机械感」顾客不要——环间相位用黄金角比例
 * 偏移，避免径向/轴向对齐的机械观感；几何族生成间距 s=密度推导，硬门=钻径切距。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import type { TreeBBox, TreeMask2D } from '../vision/tree-to-blocks.js';
import type { KernelStrategy } from './registry.js';

// ---------------------------------------------------------------- 几何帮助库（ctx.geometry 注入面）

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 几何帮助库注入面（StrategyContext.geometry——P1.4 自由代码沙箱同一注入面的内核侧
 * 单源；本文件既是默认实现也是首个消费者）。
 */
export interface GeometryHelpers {
  dist(ax: number, ay: number, bx: number, by: number): number;
  /** 掩膜质心（画布全局像素坐标——成员像素坐标均值）。 */
  maskCentroid(mask: TreeMask2D, bbox: TreeBBox): Vec2;
  /** 掩膜最大半径（质心到成员像素的最大距离，px）。 */
  maskMaxRadius(mask: TreeMask2D, bbox: TreeBBox, c: Vec2): number;
  /** 全局像素坐标 ∈ 掩膜（像素中心取整判定——引擎 inBlockMask 同构语义）。 */
  inMask(mask: TreeMask2D, bbox: TreeBBox, x: number, y: number): boolean;
  /** 开折线按弧长等距重采样（spacing 步进；phase 起点弧长偏移；含首点不含尾）。 */
  resampleOpen(pts: Vec2[], spacing: number, phase: number): Vec2[];
  /** 闭曲线按弧长等距重采样（首尾相接不重复；phase∈[0,1) 周期相位偏移）。 */
  resampleClosed(pts: Vec2[], spacing: number, phase: number): Vec2[];
  /** 确定性 keep-earlier 最小间距过滤（引擎 enforceMinDistance 同构语义，O(n²)——预览量级）。 */
  enforceMinSpacing(pts: Vec2[], minPx: number): Vec2[];
  /** 单位心形轮廓（高归一 [−1,1]；dent 凹陷深∈[0,1]；aspect 宽高比缩放；n 弧长均匀采样点）。 */
  heartOutline(dent: number, aspect: number, n: number): Vec2[];
}

export const geometryHelpers: GeometryHelpers = {
  dist(ax, ay, bx, by) {
    return Math.hypot(bx - ax, by - ay);
  },
  maskCentroid(mask, bbox) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (mask.bits[y * mask.w + x] !== 1) continue;
        sx += bbox.x + x;
        sy += bbox.y + y;
        n++;
      }
    }
    if (n === 0) throw new RangeError('maskCentroid：全零掩膜（P0.2 保证不产空块——上游契约破裂）');
    return { x: sx / n, y: sy / n };
  },
  maskMaxRadius(mask, bbox, c) {
    let rMax = 0;
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (mask.bits[y * mask.w + x] !== 1) continue;
        const r = Math.hypot(bbox.x + x - c.x, bbox.y + y - c.y);
        if (r > rMax) rMax = r;
      }
    }
    return rMax;
  },
  inMask(mask, bbox, x, y) {
    const ix = Math.round(x) - bbox.x;
    const iy = Math.round(y) - bbox.y;
    if (ix < 0 || iy < 0 || ix >= mask.w || iy >= mask.h) return false;
    return mask.bits[iy * mask.w + ix] === 1;
  },
  resampleOpen(pts, spacing, phase) {
    if (!(spacing > 0) || pts.length < 2) return pts.length <= 1 ? [...pts] : [pts[0]!];
    // 累积弧长 → 目标弧长处线性插值
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1]! + geometryHelpers.dist(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y));
    }
    const total = cum[cum.length - 1]!;
    const out: Vec2[] = [];
    let seg = 0;
    for (let t = phase; t <= total; t += spacing) {
      while (seg < cum.length - 2 && cum[seg + 1]! < t) seg++;
      const a = pts[seg]!;
      const b = pts[seg + 1] ?? a;
      const len = cum[seg + 1]! - cum[seg]!;
      const f = len > 0 ? (t - cum[seg]!) / len : 0;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return out;
  },
  resampleClosed(pts, spacing, phase) {
    if (pts.length < 3) return [...pts];
    const closed = [...pts, pts[0]!];
    const total = polylineLen(closed);
    // floor：点距恒 ≥ spacing（round 会上取整致点距略 < spacing，被 enforceMinSpacing 误删半环）
    const n = Math.max(3, Math.floor(total / spacing));
    const out: Vec2[] = [];
    for (let j = 0; j < n; j++) {
      const t = ((j / n + phase) % 1) * total; // 周期相位（j/n+phase——整 j 的 %1 恒 0，勿写 (j+phase)%1）
      out.push(pointAtLen(closed, t));
    }
    return out;
  },
  enforceMinSpacing(pts, minPx) {
    const kept: Vec2[] = [];
    outer: for (const p of pts) {
      for (const q of kept) {
        if (geometryHelpers.dist(p.x, p.y, q.x, q.y) < minPx) continue outer;
      }
      kept.push(p);
    }
    return kept;
  },
  heartOutline(dent, aspect, n) {
    // 经典参数化心形；dent ∈[0,1] 控制顶部凹陷：dent=1 经典心、0 凹陷抹平（圆顶化）
    const raw: Vec2[] = [];
    for (let i = 0; i < 720; i++) {
      const t = (i / 720) * 2 * Math.PI;
      const x = 16 * Math.sin(t) ** 3;
      let y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      const lobe = 12; // 顶部圆瓣高度近似（t≈±1.0 处 y≈12）
      const bump = Math.max(0, Math.cos(t)) ** 2; // 凹陷提升核（t=0 顶部中央峰）
      y = y + (1 - dent) * bump * (lobe - y);
      raw.push({ x, y });
    }
    // 归一：原始 y∈[−17,12] → 高 29；平移居中 + 高度归一 [−1,1] + aspect 宽向缩放
    const cy = (12 + -17) / 2;
    const scale = 2 / 29;
    const natural = raw.map((p) => ({ x: p.x * scale * aspect, y: (p.y - cy) * scale }));
    return geometryHelpers.resampleClosed(natural, polylineLen([...natural, natural[0]!]) / n, 0);
  },
};

function polylineLen(pts: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += geometryHelpers.dist(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y);
  return len;
}

function pointAtLen(pts: Vec2[], t: number): Vec2 {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = geometryHelpers.dist(a.x, a.y, b.x, b.y);
    if (acc + seg >= t && seg > 0) {
      const f = (t - acc) / seg;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    acc += seg;
  }
  return { ...pts[pts.length - 1]! };
}

/** 黄金角比例相位（环间错位——消径向对齐机械感，§9/Owner 补充定调）。 */
function loopPhase(k: number): number {
  return (k * 0.618033988749895) % 1;
}

// ---------------------------------------------------------------- 参数 schema（Zod 冻结）

/** 几何族降级目标（contracts StrategyIdSchema 五值复用——引擎 hex 族缺省 hex-pitch）。 */
export const fallbackEngineStrategyField = StrategyIdSchema.default('hex-pitch');

const StarParamsSchema = z
  .object({
    shape: z.literal('star'),
    /** 射线数（Owner 参数 3「它需要射多少条线出来」） */
    rays: z.number().int().min(3).max(64).default(5),
    /** 内半径比 r0/R（星心留空比例——稀疏度的形状面） */
    innerRadiusRatio: z.number().gt(0).lt(1).default(0.4),
    /** 初始角度 deg（Owner 参数 4「这些线的初始角度」；缺省 270=指上（像素 y 向下） */
    rotationDeg: z.number().min(0).max(360).default(270),
    fallbackEngineStrategy: fallbackEngineStrategyField,
  })
  .strict();

const HeartParamsSchema = z
  .object({
    shape: z.literal('heart'),
    /** 宽高比（1=心形自然比例 32:29；<1 瘦长 >1 宽扁） */
    aspectRatio: z.number().min(0.5).max(2).default(1),
    /** 凹陷深 [0,1]：1=经典心形凹陷，0=顶部抹平 */
    dentDepth: z.number().min(0).max(1).default(1),
    fallbackEngineStrategy: fallbackEngineStrategyField,
  })
  .strict();

const CircleParamsSchema = z
  .object({ shape: z.literal('circle'), fallbackEngineStrategy: fallbackEngineStrategyField })
  .strict();

const RectParamsSchema = z
  .object({ shape: z.literal('rect'), fallbackEngineStrategy: fallbackEngineStrategyField })
  .strict();

const EllipseParamsSchema = z
  .object({ shape: z.literal('ellipse'), fallbackEngineStrategy: fallbackEngineStrategyField })
  .strict();

const SpiralParamsSchema = z
  .object({
    shape: z.literal('spiral'),
    /** 匝数 */
    turns: z.number().gt(0).max(40).default(6),
    /** 螺距 mm（缺省=密度推导间距——spiral R=pitch·turns 时恰以目标密度铺满足迹圆） */
    pitchMm: z.number().positive().max(100).optional(),
    /** 衰减：r(θ)=R·(θ/θmax)^decay（1=阿基米德等螺距；<1 外密内疏；>1 外疏内密） */
    decay: z.number().min(0.2).max(3).default(1),
    fallbackEngineStrategy: fallbackEngineStrategyField,
  })
  .strict();

export const GeometryParamsSchema = z.discriminatedUnion('shape', [
  StarParamsSchema,
  HeartParamsSchema,
  CircleParamsSchema,
  RectParamsSchema,
  EllipseParamsSchema,
  SpiralParamsSchema,
]);
export type GeometryParams = z.output<typeof GeometryParamsSchema>;

// ---------------------------------------------------------------- 可读下限（§9 回流 4）

/** 全族可读下限：星射线 16 颗实测读不出星形（§9 回流 4）→ 下限取 24 留裕量。 */
export const MIN_READABLE_GEMS = 24;
/** 星形另需每射线 ≥3 颗（射线两端+中段——少于此射线断裂）。 */
export const STAR_MIN_PER_RAY = 3;

function readableFloor(p: GeometryParams): number {
  return p.shape === 'star' ? Math.max(MIN_READABLE_GEMS, p.rays * STAR_MIN_PER_RAY) : MIN_READABLE_GEMS;
}

// ---------------------------------------------------------------- 布点生成（全局像素坐标）

/** 特征间距 px：max(钻径, 密度推导间距 10·ppm/√density)——密度颗/cm² → 等效方格距。 */
export function characteristicSpacingPx(gemDiameterPx: number, densityPerCm2: number, pixelsPerMm: number): number {
  if (!(gemDiameterPx > 0)) throw new RangeError('gemDiameterPx 必须为正');
  if (!(densityPerCm2 > 0)) throw new RangeError('densityPerCm2 必须为正');
  if (!(pixelsPerMm > 0)) throw new RangeError('pixelsPerMm 必须为正');
  return Math.max(gemDiameterPx, (10 * pixelsPerMm) / Math.sqrt(densityPerCm2));
}

/** 六形状候选点生成（未掩膜过滤；全部确定性；ppm——spiral 显式 pitchMm 换算用）。 */
function candidates(
  p: GeometryParams,
  mask: TreeMask2D,
  bbox: TreeBBox,
  s: number,
  g: GeometryHelpers,
  ppm: number,
): Vec2[] {
  const c = g.maskCentroid(mask, bbox);
  const rMax = g.maskMaxRadius(mask, bbox, c);
  const center = { x: (bbox.x * 2 + bbox.w) / 2, y: (bbox.y * 2 + bbox.h) / 2 }; // bbox 几何中心（矩/椭/心锚点）

  switch (p.shape) {
    case 'star': {
      const out: Vec2[] = [];
      const r0 = p.innerRadiusRatio * rMax;
      for (let k = 0; k < p.rays; k++) {
        const theta = ((p.rotationDeg + (k * 360) / p.rays) * Math.PI) / 180;
        for (let m = 0; ; m++) {
          const r = r0 + m * s; // 乘法步进（浮点累积漂移会扰动边界点）
          if (r > rMax) break;
          out.push({ x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) });
        }
      }
      return out;
    }
    case 'circle': {
      const out: Vec2[] = [];
      for (let k = 0; (k + 0.5) * s <= rMax; k++) {
        const r = (k + 0.5) * s;
        const n = Math.max(1, Math.floor((2 * Math.PI * r) / s));
        for (let j = 0; j < n; j++) {
          const theta = ((j + loopPhase(k)) * 2 * Math.PI) / n;
          out.push({ x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) });
        }
      }
      return out;
    }
    case 'rect': {
      const out: Vec2[] = [];
      let k = 0;
      for (;;) {
        const x0 = bbox.x + k * s;
        const y0 = bbox.y + k * s;
        const w = bbox.w - 2 * k * s;
        const h = bbox.h - 2 * k * s;
        if (w <= 0 || h <= 0) break;
        const per = 2 * (w + h);
        const n = Math.max(4, Math.floor(per / s));
        for (let j = 0; j < n; j++) {
          const t = ((j + loopPhase(k)) / n) * per;
          out.push(rectPoint(x0, y0, w, h, t));
        }
        k++;
      }
      return out;
    }
    case 'ellipse': {
      const out: Vec2[] = [];
      let k = 0;
      for (;;) {
        const a = bbox.w / 2 - k * s;
        const b = bbox.h / 2 - k * s;
        if (a <= 0 || b <= 0) break;
        const loop = denseEllipse(center.x, center.y, a, b);
        out.push(...g.resampleClosed(loop, s, loopPhase(k)));
        k++;
      }
      return out;
    }
    case 'heart': {
      const out: Vec2[] = [];
      const unit = g.heartOutline(p.dentDepth, p.aspectRatio, 720);
      const hw = Math.max(...unit.map((q) => Math.abs(q.x)));
      const hh = Math.max(...unit.map((q) => Math.abs(q.y)));
      const rUnit = Math.max(...unit.map((q) => Math.hypot(q.x, q.y)));
      const sigma0 = Math.min(bbox.w / (2 * hw), bbox.h / (2 * hh));
      const perUnit = polylineLen([...unit, unit[0]!]);
      let k = 0;
      for (;;) {
        const sigma = sigma0 - (k * s) / rUnit;
        if (sigma <= 0) break;
        const scaled = unit.map((q) => ({ x: center.x + q.x * sigma, y: center.y + q.y * sigma }));
        out.push(...g.resampleClosed(scaled, s, loopPhase(k)));
        k++;
      }
      return out;
    }
    case 'spiral': {
      const pitchPx = p.pitchMm !== undefined ? p.pitchMm * ppm : s; // 缺省=密度间距（足迹圆恰达目标密度）
      const R = pitchPx * p.turns;
      const thetaMax = 2 * Math.PI * p.turns;
      const dense: Vec2[] = [];
      let theta = 0;
      while (theta <= thetaMax) {
        const r = R * (theta / thetaMax) ** p.decay;
        dense.push({ x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) });
        theta += Math.min(0.3, 2 / Math.max(1, r)); // 自适应步长（弧段 ≤2px）
      }
      return g.resampleOpen(dense, s, 0);
    }
  }
}

/** 回字环周界参数点（t∈[0,per)：顶边→右边→底边→左边，顺时针）。 */
function rectPoint(x0: number, y0: number, w: number, h: number, t: number): Vec2 {
  if (t < w) return { x: x0 + t, y: y0 };
  t -= w;
  if (t < h) return { x: x0 + w, y: y0 + t };
  t -= h;
  if (t < w) return { x: x0 + w - t, y: y0 + h };
  t -= w;
  return { x: x0, y: y0 + h - t };
}

/** 椭圆稠密采样（弧段 ≤2px——供弧长重采样）。 */
function denseEllipse(cx: number, cy: number, a: number, b: number): Vec2[] {
  const pts: Vec2[] = [];
  const roughPer = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const n = Math.max(32, Math.ceil(roughPer / 2));
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push({ x: cx + a * Math.cos(t), y: cy + b * Math.sin(t) });
  }
  return pts;
}

// ---------------------------------------------------------------- 策略实现

export const geometryStrategy: KernelStrategy = {
  kind: 'geometry',
  status: 'implemented',
  paramsSchema: GeometryParamsSchema,
  apply(input, ctx) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = GeometryParamsSchema.parse(input.params ?? {});
    const ppm = input.canvas.pixelsPerMm;
    const s = characteristicSpacingPx(ctx.gemDiameterPx, ctx.densityPerCm2, ppm);
    const raw = candidates(p, input.block.mask, input.block.bbox, s, ctx.geometry, ppm);

    // 掩膜过滤（点全在掩膜内——design §8 预览测试断言的不变量）
    const kept = raw.filter((q) => ctx.geometry.inMask(input.block.mask, input.block.bbox, q.x, q.y));

    const floor = readableFloor(p);
    const degrade = (keptCount: number, stage: string) => ({
      gems: [],
      warnings: [
        {
          kind: 'degraded' as const,
          detail: `${p.shape} 候选 ${stage}后 ${keptCount} 颗 < 可读下限 ${floor}（§9 回流 4：星射线 16 颗读不出星形）——降级引擎 ${p.fallbackEngineStrategy}`,
        },
      ],
      engineStrategy: {
        engineStrategy: p.fallbackEngineStrategy,
        reason: 'geometry-min-size' as const,
        note: `${input.block.label}：${p.shape} 不足可读下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
      },
    });

    if (kept.length < floor) return degrade(kept.length, '掩膜过滤');
    // 物理间距硬门=钻径切距（引擎 no-gap 语义——真源校验门在 P3 引擎接线侧带 gap 判）；
    // s 是生成级图案间距（密度目标），非硬门：螺旋相邻匝垂距=s·cos(lead) 天然略低于 s，
    // 以钻径为硬门既保物理不变量又不误删图案合法点
    const spaced = ctx.geometry.enforceMinSpacing(kept, ctx.gemDiameterPx * 0.999);
    if (spaced.length < floor) return degrade(spaced.length, '间距过滤');

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    const gems = spaced.map((q, i) => ({
      id: `${input.block.id}#${String(i + 1).padStart(4, '0')}`,
      x: q.x,
      y: q.y,
      colorId: '',
      blockId: input.block.id,
      shapeId: 'round' as const,
      diameterMm,
    }));

    const warnings = [];
    if (kept.length < raw.length / 2) {
      warnings.push({
        kind: 'mask' as const,
        detail: `${p.shape} 候选 ${raw.length} 中仅 ${kept.length} 落在掩膜内（形状与节点几何偏差大——建议核对策略/节点匹配）`,
      });
    }
    return { gems, warnings };
  },
};

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
