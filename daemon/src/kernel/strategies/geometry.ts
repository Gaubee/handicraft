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
 *   star   星射线 { rays 射线数(缺省=径向签名峰数自动检测), innerRadiusRatio 内半径比,
 *          rotationDeg 旋转, centerOffsetPx 圆心偏移(可选), sparseness 沿射线步长倍数 }
 *          ——close-paving-backlog T1 原位升级（Owner 四参数全暴露+r(θ) 逐角边界调制）：
 *          凹口射线按径向签名收短（min(r(θ)×0.98, rMax)——杜绝统一 rMax 后掩膜过滤的
 *          穿出岛点）；圆心=掩膜质心（落掩膜外退最大内切圆心近似）+可选偏移；
 *          稀疏度=density 推导基准 ×sparseness 显式倍数（两通道正交）。
 *   heart  心 { aspectRatio 宽高比, dentDepth 凹陷深 }（嵌套缩心填充）。
 *   circle 圆 / rect 矩 / ellipse 椭圆（基础——嵌套环/回字环/椭圆环填充，无族参数）。
 *   spiral 螺旋 { turns 匝数, pitchMm 螺距(缺省=密度推导), decay 衰减 }（阿基米德式
 *          r(θ)=R·(θ/θmax)^decay）。
 *
 * 确定性：全参数化纯函数（本族无随机——ctx.rng 留给 P1.2/P1.4 族），同输入同输出。
 * 可读兜底下限守卫：kept < MIN_READABLE_GEMS（3——真链走查 P1 修正：声明密度优先，
 * 极小产出才降级）→ 不自产钻，声明式降级引擎 hex（engineStrategy 通道——P3 接线
 * 消费，见 registry.ts adapter 契约；降级保目标密度——density-absolute 语义）。
 * Owner 补充定调（2026-09-24 晚）：硬算法「机械感」顾客不要——环间相位用黄金角比例
 * 偏移，避免径向/轴向对齐的机械观感；几何族生成间距 s=密度推导，硬门=钻径切距。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import type { TreeBBox, TreeMask2D } from '../vision/tree-to-blocks.js';
import { radialSignatureAndPetals, signatureAt } from './radial_signature.js';
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
  /**
   * 掩码最大连通域（8 邻接）外边界游走（Moore 邻域——close-paving-backlog T3 新增，
   * along-path outline 边框的消费基座）。返回顺时针有序边界点链（画布全局像素坐标，
   * maskCentroid 同系）；孤点组件返回单点链。
   */
  boundaryTrace(mask: TreeMask2D, bbox: TreeBBox): Vec2[];
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
  boundaryTrace(mask, bbox) {
    const pts = boundaryTraceLocal(mask);
    return pts.map((q) => ({ x: bbox.x + q.x, y: bbox.y + q.y }));
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

// ------------------------------------------------- 边界游走/最大内切圆心（close-paving-backlog）

/** Moore 邻域方位序（顺时针——像素系 x 右 y 下：E→SE→S→SW→W→NW→N→NE）。 */
const MOORE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * 掩码最大连通域（8 邻接 BFS 标记，像素数最多者）外边界游走（Moore 邻域顺时针 +
 * Jacob 停止准则——回起点且回溯方位重现即闭合）。返回**局部像素坐标**有序点链
 * （boundaryTrace 注入面负责 +bbox 全局化）；空掩码返回空链（上游 P0.2 保证不空）。
 * 沙箱镜像：worker.cjs makeGeometry 同构投影——等价性由 strategies-sandbox 对拍把守。
 */
export function boundaryTraceLocal(mask: TreeMask2D): Vec2[] {
  const { w, h, bits } = mask;
  // —— 最大连通域标记（8 邻接 BFS——栈代队列免递归；标签即成员位图）
  const label = new Int32Array(w * h).fill(-1);
  let bestLabel = -1;
  let bestArea = 0;
  let next = 0;
  for (let seed = 0; seed < w * h; seed++) {
    if (bits[seed] !== 1 || label[seed] !== -1) continue;
    const labelId = next++;
    let area = 0;
    const stack: number[] = [seed];
    label[seed] = labelId;
    while (stack.length > 0) {
      const i = stack.pop()!;
      area++;
      const x = i % w;
      const y = (i / w) | 0;
      for (const [dx, dy] of MOORE_DIRS) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (bits[j] === 1 && label[j] === -1) {
          label[j] = labelId;
          stack.push(j);
        }
      }
    }
    if (area > bestArea) {
      bestArea = area;
      bestLabel = labelId;
    }
  }
  if (bestLabel < 0) return [];
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === bestLabel;
  // —— 起点：组件内最小 y（平手最小 x）——上方与左侧恒背景，初始回溯方位=西（4）
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return [];
  // —— Moore 游走：从回溯方位（背景）的下一邻起顺时针找首个前景；回溯更新式
  //    back' = (⌊found/2⌋·2 + 6) mod 8（found 前一背景邻相对新像素的方位——推导见测试）
  const pts: Vec2[] = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  let back = 4;
  const initialBack = 4;
  const guard = w * h * 4 + 8; // 停止保险（理论周界 ≤ 4·面积+4——防病态摆动）
  for (let step = 0; step < guard; step++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const n = (back + k) % 8;
      const [dx, dy] = MOORE_DIRS[n]!;
      if (at(cx + dx, cy + dy)) {
        found = n;
        break;
      }
    }
    if (found < 0) break; // 孤点组件（无前景邻）
    cx += MOORE_DIRS[found]![0];
    cy += MOORE_DIRS[found]![1];
    if (cx === sx && cy === sy && ((Math.floor(found / 2) * 2 + 6) % 8) === initialBack) {
      break; // Jacob 停止准则：回起点且回溯方位重现=外边界闭合
    }
    pts.push({ x: cx, y: cy });
    back = (Math.floor(found / 2) * 2 + 6) % 8;
  }
  return pts;
}

/**
 * 最大内切圆心近似（close-paving-backlog T1.2 新写——R1 纠偏：geometry helpers 现无
 * 此函数）。工程近似两步（design §1：粗网格采样掩膜内点取最大清亮半径者）：
 *   [1] 3-4 chamfer 距离变换（两遍扫描 O(w×h)——每像素到最近背景的距离场）；
 *   [2] 粗网格采样（步长 ≈ min(w,h)/64，≥2px）取距离场最大者（平手取扫描序先到——
 *       行序确定，同输入同输出）。
 * 返回**局部像素坐标**；全零掩码返回 null（上游契约破裂面，调用方防御）。
 * 不进 GeometryHelpers 注入面（沙箱 geo.* 不扩容——radial_signature 同裁量）。
 */
export function maxInscribedCenterApprox(mask: TreeMask2D): Vec2 | null {
  const { w, h, bits } = mask;
  const INF = 1e12;
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = bits[i] === 1 ? INF : 0;
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i]! === 0) continue;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + D1);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + D1);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + D2);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + D2);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i]! === 0) continue;
      let v = d[i]!;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + D1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + D1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + D2);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + D2);
      }
      d[i] = v;
    }
  }
  const step = Math.max(2, Math.round(Math.min(w, h) / 64));
  let best: Vec2 | null = null;
  let bestR = -1;
  for (let y = Math.floor(step / 2); y < h; y += step) {
    for (let x = Math.floor(step / 2); x < w; x += step) {
      const i = y * w + x;
      if (bits[i] !== 1) continue;
      if (d[i]! > bestR) {
        bestR = d[i]!;
        best = { x, y };
      }
    }
  }
  return best;
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
    /**
     * 射线数（Owner 参数 3「它需要射多少条线出来」）——缺省=径向签名峰数自动检测
     * （星角数，同 flower petals 检测先例；检测 <3 退 legacy 缺省 5+warning）；
     * 显式覆写优先。
     */
    rays: z.number().int().min(3).max(64).optional(),
    /** 内半径比 r0/R（星心留空比例——稀疏度的形状面） */
    innerRadiusRatio: z.number().gt(0).lt(1).default(0.4),
    /** 初始角度 deg（Owner 参数 4「这些线的初始角度」；缺省 270=指上（像素 y 向下） */
    rotationDeg: z.number().min(0).max(360).default(270),
    /**
     * 圆心显式偏移 px（Owner 参数 1「圆心在哪里」的微调面——LLM/用户覆写；
     * 缺省质心自动锚定）。掩膜局部系（bbox 内像素坐标——与质心同系后相加）。
     */
    centerOffsetPx: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
      })
      .strict()
      .optional(),
    /**
     * 沿射线步长倍数 [0.2,5]（Owner 参数 2「稀疏度如何」显式面——步长=
     * characteristicSpacingPx×sparseness；与 density 推导通道正交：density 定 s 基准，
     * sparseness 在基准上缩放）。缺省 1=现状间距。
     */
    sparseness: z.number().gte(0.2).lte(5).default(1),
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

// ---------------------------------------------------------------- 可读兜底下限（§9 回流 4 → 真链走查 P1 修正）

/**
 * 全族可读兜底下限（2026-10-01 真链走查 P1 修正，Owner 心算口径裁定）：
 * **声明密度是承诺**——2.3 颗/cm² 就是每 cm² 2.3 颗，小部位颗数少是正确结果
 * （左手 13 颗就是 13 颗，不因「读不出形状」强制改排）；「满铺」只在策略显式
 * 要求时发生。旧值 24（星射线 16 颗读不出星形→取 24 留裕量）把声明密度对小
 * 部门形同虚设（走查实证：3.6cm² 左手 2.3 颗/cm² 应 8-13 颗，被降级 hex 后
 * 满基准 71 颗 +426%）——废止。现语义：<3 颗的极小产出做可读性兜底（降级
 * hex 形态，目标密度不变——density-absolute 语义），warning 如实说明。
 */
export const MIN_READABLE_GEMS = 3;

// ---------------------------------------------------------------- 布点生成（全局像素坐标）

/** 特征间距 px：max(钻径, 密度推导间距 10·ppm/√density)——密度颗/cm² → 等效方格距。 */
export function characteristicSpacingPx(gemDiameterPx: number, densityPerCm2: number, pixelsPerMm: number): number {
  if (!(gemDiameterPx > 0)) throw new RangeError('gemDiameterPx 必须为正');
  if (!(densityPerCm2 > 0)) throw new RangeError('densityPerCm2 必须为正');
  if (!(pixelsPerMm > 0)) throw new RangeError('pixelsPerMm 必须为正');
  return Math.max(gemDiameterPx, (10 * pixelsPerMm) / Math.sqrt(densityPerCm2));
}

// ---------------------------------------------------------------- 角度填充（Owner 统一理论 2026-10-02）

/**
 * 角度归一 [0,360)。钻角度=局部方向场估计（Owner：「线条也有角度，最常用；星/花/圆=
 * 几何拟合后的方向稳定化」）——四策略族共用的角度单源。
 */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * 方向向量 → 钻尖 rotationDeg（罗盘式基准锚定渲染坐标系）：
 * 渲染层 rotationDeg=局部系绕钻心旋转（像素系 x 右 y 下、正向=屏幕顺时针——
 * texture-render.ts drawRotatedTexture / gem-shapes.ts / render.ts 三处同式），
 * 钻形正典朝向=局部 −y（BUILTIN_PATHS drop 尖 'M 0.5 0.02' 顶置；engine Gem 注释
 * 「0=默认朝上」）⇒ 尖方向 (dx,dy) ↔ rotationDeg = atan2(dy,dx)+90（0=上/90=右/
 * 180=下/270=左）。异形（水滴/马眼）长轴沿方向场——「线条纹理」语义。
 */
export function compassRotationDeg(dirX: number, dirY: number): number {
  return normalizeDeg((Math.atan2(dirY, dirX) * 180) / Math.PI + 90);
}

/** 六形状候选点生成（未掩膜过滤；全部确定性；ppm——spiral 显式 pitchMm 换算用）。
 * notes：star 升级面的检测/回退注记（apply 转 warnings；其余形状不写入）。 */
interface DirectedVec2 extends Vec2 {
  /** 钻尖朝向（deg 罗盘式——geometry.compassRotationDeg 基准；无极角结构的形状（heart）
   * 不填=undefined 保持 optional 缺省）。 */
  rotDeg?: number;
}

function candidates(
  p: GeometryParams,
  mask: TreeMask2D,
  bbox: TreeBBox,
  s: number,
  g: GeometryHelpers,
  ppm: number,
  notes: string[],
): DirectedVec2[] {
  const c = g.maskCentroid(mask, bbox);
  const rMax = g.maskMaxRadius(mask, bbox, c);
  const center = { x: (bbox.x * 2 + bbox.w) / 2, y: (bbox.y * 2 + bbox.h) / 2 }; // bbox 几何中心（矩/椭/心锚点）

  switch (p.shape) {
    case 'star': {
      // —— 圆心锚定（Owner 参数 1「圆心在哪里」）：缺省质心；质心落掩膜外退最大内切圆心
      //    近似（粗网格工程近似——凹形/环形掩膜质心常落外，直接用会全射线贴边穿界）。
      //    显式 centerOffsetPx 在锚点之上叠加（显式意图优先，不再做掩膜内回退）。
      let cL = { x: c.x - bbox.x, y: c.y - bbox.y };
      const centroidInMask = g.inMask(mask, bbox, c.x, c.y);
      if (!centroidInMask) {
        const approx = maxInscribedCenterApprox(mask);
        if (approx !== null) {
          cL = approx;
          notes.push(
            `star 质心 (${c.x.toFixed(1)}, ${c.y.toFixed(1)}) 落掩膜外——退最大内切圆心近似 (${bbox.x + approx.x}, ${bbox.y + approx.y})（粗网格工程近似）`,
          );
        }
      }
      if (p.centerOffsetPx !== undefined) {
        cL = { x: cL.x + p.centerOffsetPx.x, y: cL.y + p.centerOffsetPx.y };
      }
      const cStar = { x: bbox.x + cL.x, y: bbox.y + cL.y };
      const rMaxStar = g.maskMaxRadius(mask, bbox, cStar);
      // —— r(θ) 逐角边界调制（T1 核心）：径向签名（flower 共享件——局部系）逐射线收短
      //    上界=min(r(θ_射线)×0.98, rMaxStar)——凹口射线止于凹口，不再统一 rMax 后靠
      //    掩膜过滤（杜绝穿出再穿入的岛点；0.98=边界像素半宽安全裕度）。
      const { sig, detected } = radialSignatureAndPetals(mask, cL.x, cL.y);
      // —— 射线数（Owner 参数 3）：缺省峰数自动检测（星角数）；检测 <3 退 legacy 5。
      let rays = p.rays;
      if (rays === undefined) {
        if (detected >= 3) {
          rays = Math.min(64, detected);
        } else {
          rays = 5;
          notes.push(`star rays 缺省自动检测峰数 ${detected} <3（无显著星角结构）——退 legacy 缺省 5`);
        }
      }
      const step = s * p.sparseness; // Owner 参数 2「稀疏度」显式倍数（density 定基准，正交缩放）
      const out: DirectedVec2[] = [];
      const r0 = p.innerRadiusRatio * rMaxStar;
      for (let k = 0; k < rays; k++) {
        const theta = ((p.rotationDeg + (k * 360) / rays) * Math.PI) / 180;
        const bound = Math.min(signatureAt(sig, theta) * 0.98, rMaxStar);
        for (let m = 0; ; m++) {
          const r = r0 + m * step; // 乘法步进（浮点累积漂移会扰动边界点）
          if (r > bound) break;
          // 星射线径向（射线方向——尖朝外，同 flower 花瓣「瓣尖朝外」语义）
          out.push({
            x: cStar.x + r * Math.cos(theta),
            y: cStar.y + r * Math.sin(theta),
            rotDeg: compassRotationDeg(Math.cos(theta), Math.sin(theta)),
          });
        }
      }
      return out;
    }
    case 'circle': {
      const out: DirectedVec2[] = [];
      for (let k = 0; (k + 0.5) * s <= rMax; k++) {
        const r = (k + 0.5) * s;
        const n = Math.max(1, Math.floor((2 * Math.PI * r) / s));
        for (let j = 0; j < n; j++) {
          const theta = ((j + loopPhase(k)) * 2 * Math.PI) / n;
          // 环切向（d/dθ=(−sinθ,cosθ)——环绕语义，同 flower 花心环）
          out.push({
            x: c.x + r * Math.cos(theta),
            y: c.y + r * Math.sin(theta),
            rotDeg: compassRotationDeg(-Math.sin(theta), Math.cos(theta)),
          });
        }
      }
      return out;
    }
    case 'rect': {
      const out: DirectedVec2[] = [];
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
          const p0 = rectPoint(x0, y0, w, h, t);
          // 回字环切向（rectPoint 遍历序：顶边 +x → 右边 +y（下）→ 底边 −x → 左边 −y（上））
          let dirX: number;
          let dirY: number;
          if (t < w) {
            dirX = 1;
            dirY = 0;
          } else if (t < w + h) {
            dirX = 0;
            dirY = 1;
          } else if (t < 2 * w + h) {
            dirX = -1;
            dirY = 0;
          } else {
            dirX = 0;
            dirY = -1;
          }
          out.push({ ...p0, rotDeg: compassRotationDeg(dirX, dirY) });
        }
        k++;
      }
      return out;
    }
    case 'ellipse': {
      const out: DirectedVec2[] = [];
      let k = 0;
      for (;;) {
        const a = bbox.w / 2 - k * s;
        const b = bbox.h / 2 - k * s;
        if (a <= 0 || b <= 0) break;
        const loop = denseEllipse(center.x, center.y, a, b);
        const pts = g.resampleClosed(loop, s, loopPhase(k));
        // 椭圆环切向：由点位反解参数 t=atan2((y−cy)/b,(x−cx)/a) 取解析切向 (−a·sin t, b·cos t)
        //（重采样点在稠密多边形弦上，t 反解误差 <1°；改用相邻重采样点差分会在平坦端
        // （曲率半径 b²/a 小）跨尖角产生 90° 级误差——解析反解=几何拟合后的方向稳定化）
        for (const q of pts) {
          const t = Math.atan2((q.y - center.y) / b, (q.x - center.x) / a);
          out.push({ ...q, rotDeg: compassRotationDeg(-a * Math.sin(t), b * Math.cos(t)) });
        }
        k++;
      }
      return out;
    }
    case 'heart': {
      // 无极角结构的形状不填角度（保持 optional 缺省——briefing 裁定）
      const out: DirectedVec2[] = [];
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
      const cum: number[] = [0];
      let theta = 0;
      while (theta <= thetaMax) {
        const r = R * (theta / thetaMax) ** p.decay;
        const q = { x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) };
        if (dense.length > 0) {
          const prev = dense[dense.length - 1]!;
          cum.push(cum[cum.length - 1]! + Math.hypot(q.x - prev.x, q.y - prev.y));
        }
        dense.push(q);
        theta += Math.min(0.3, 2 / Math.max(1, r)); // 自适应步长（弧段 ≤2px）
      }
      const total = cum[cum.length - 1]!;
      const pts = g.resampleOpen(dense, s, 0);
      // 螺旋转迹切向（线条=通用底座）：重采样弧长 t_i=i·s（phase=0），取稠密折线
      // [t−2px,t+2px] 弧长窗方向（≥2 个稠密段；中心区 r→0 方向退化——视觉无感）
      return pts.map((pt, i) => {
        const t = Math.min(i * s, total);
        const pa = pointAtLen(dense, Math.max(0, t - 2));
        const pb = pointAtLen(dense, Math.min(total, t + 2));
        return { ...pt, rotDeg: compassRotationDeg(pb.x - pa.x, pb.y - pa.y) };
      });
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
    const candidateNotes: string[] = [];
    const raw = candidates(p, input.block.mask, input.block.bbox, s, ctx.geometry, ppm, candidateNotes);

    // 掩膜过滤（点全在掩膜内——design §8 预览测试断言的不变量）
    const kept = raw.filter((q) => ctx.geometry.inMask(input.block.mask, input.block.bbox, q.x, q.y));

    const floor = MIN_READABLE_GEMS;
    const degrade = (keptCount: number, stage: string) => ({
      gems: [],
      warnings: [
        {
          kind: 'degraded' as const,
          detail: `${p.shape} 候选 ${stage}后 ${keptCount} 颗 < 可读下限 ${floor}（极小产出可读性兜底——2026-10-01 真链走查 P1 修正：声明密度优先，小部位颗数少是正确结果）——降级引擎 ${p.fallbackEngineStrategy}（目标密度不变，仅形态兜底）`,
        },
      ],
      engineStrategy: {
        engineStrategy: p.fallbackEngineStrategy,
        reason: 'geometry-min-size' as const,
        note: `${input.block.label}：${p.shape} 低于可读兜底下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
      },
    });

    if (kept.length < floor) return degrade(kept.length, '掩膜过滤');
    // 物理间距硬门=钻径切距（引擎 no-gap 语义——真源校验门在 P3 引擎接线侧带 gap 判）；
    // s 是生成级图案间距（密度目标），非硬门：螺旋相邻匝垂距=s·cos(lead) 天然略低于 s，
    // 以钻径为硬门既保物理不变量又不误删图案合法点
    const spaced = ctx.geometry.enforceMinSpacing(kept, ctx.gemDiameterPx * 0.999);
    if (spaced.length < floor) return degrade(spaced.length, '间距过滤');

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    // enforceMinSpacing keep-earlier 保留原对象引用（本文件单源语义）——角度随钻存活；
    // heart 等无极角结构形状 rotDeg=undefined → rotationDeg 键缺席（optional 缺省保持）
    const gems = (spaced as DirectedVec2[]).map((q, i) => ({
      id: `${input.block.id}#${String(i + 1).padStart(4, '0')}`,
      x: q.x,
      y: q.y,
      colorId: '',
      blockId: input.block.id,
      shapeId: 'round' as const,
      diameterMm,
      ...(q.rotDeg !== undefined ? { rotationDeg: round6(q.rotDeg) } : {}),
    }));

    const warnings: Array<{ kind: 'geometry' | 'mask'; detail: string }> = candidateNotes.map((note) => ({
      kind: 'geometry' as const,
      detail: note,
    }));
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
