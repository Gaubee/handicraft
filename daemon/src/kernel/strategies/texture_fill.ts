/**
 * 纹理贴图法族（add-subject-sam-pipeline design §4.2/§10——P1.2；Owner 定调主文：
 * 「纹理贴图法顺枝条」=flow 模式沿等亮度线（切向⊥梯度）布点）。
 *
 * 算法真源：experiments/texture-spike-20260924（2026-09-24 throwaway spike——RESEARCH.md
 * 13 论文选型 + REPORT.md 横评硬数字）。本文件按其已文档语义工程化移植（同 P0.2
 * 「文档语义抄录」纪律——spike 代码只读参考，自实现）：
 *   scatter = 技法 B 加权 Voronoi 点画：Secord 2002 亮度→密度（节点内直方图 CDF 分位，
 *            极性 dark-dense 默认）+ 密度加权 Lloyd 松弛（受限迭代预算 lloydIters≤16，
 *            空胞 ρ 加权重生；spike 实测覆盖 cov≈1.00）。
 *   flow    = 技法 A ETF 流线：结构张量（Sobel→张量平滑→主特征向+90°切向）+ ETF 投票
 *            精炼（Kang 2007 简化：φ=|∇I|/max，w_d=|t̂x·t̂y|³）→ RK2 双向追迹根流线
 *            + Hausner 式 offset 环 BFS（「offset 定种、追迹定形」）→ 沿线局部 pitch 步长
 *            + 相位半格错开 = 顺流六边形点阵（spike 实测方向跟随 18-32° vs 各向同性 45°）。
 *   hybrid  = §10 回流 1 路由定稿方向「B 打底+A 描线」：flow 线以分离度 s/lineShare 描线
 *            （线上份额≈lineShare），scatter 全域打底，合并按 keep-earlier 间距门去重。
 *
 * 亮度场输入面：StrategyApplyInput 无像素通道（冻结接口——node/block/params/canvas 四面），
 * 亮度经 **params.lumaB64**（w*h 灰度字节 base64——contracts mask bitsB64 同型数据通道）
 * 注入；缺省时 scatter 退化为均匀密度（ρ≡1=目标密度直排），flow 退化为掩膜形状流
 * （模糊掩膜的等值线切向——顺掩膜轮廓），均出 'degraded' warning 明示。
 *
 * 密度/钻径贯穿 ctx（densityPerCm2 缺省 2.3/cm²——Owner 定调；gemDiameterPx=判距硬门）。
 * 确定性：全随机源 ctx.rng(mixSeed(stringToSeed(nodeId),saltA,saltB))——同 node 同参同果，
 * 禁 Math.random（§4.4 可回放）。ρ∈[0.32,1.0]（spike config.json defaults）⇒ 局部 pitch
 * ∈[s,1.77s] 恒 ≥ 钻径（生成级自保证，终裁仍过 enforceMinSpacing 硬门）。
 * 色彩族完整性硬门位（§10 回流 3）：params.colorFamily 预留约束字段 + warning 输出位
 * （选色归 P3 策略设计器——本族 colorId 恒 ''）。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import type { TreeMask2D } from '../vision/tree-to-blocks.js';
import { MIN_READABLE_GEMS } from './geometry.js';
import { mixSeed, stringToSeed } from './rng.js';
import type { KernelStrategy } from './registry.js';

// ---------------------------------------------------------------- 参数 schema（Zod 冻结）

/** 亮度场 base64 校验（宽容标准字母表；长度语义 w*h 在 apply 内验——schema 不知 w/h）。 */
const lumaB64Field = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'lumaB64 须为标准 base64');

/** ρ 密度场极性（design §4.2 target bright|dark|both 的密度语义化）。 */
const polarityField = z.enum(['dark-dense', 'bright-dense', 'flat']).default('dark-dense');

/** 色彩族完整性硬门预留位（§10 回流 3——P3 策略设计器消费，本波仅记录+warning）。 */
const colorFamilyField = z.string().min(1).max(64).optional();

/** 几何族同款声明式降级目标（§9 回流 4 可读下限不足时）。 */
const fallbackEngineStrategyField = StrategyIdSchema.default('hex-pitch');

const ScatterParamsSchema = z
  .object({
    mode: z.literal('scatter'),
    polarity: polarityField,
    /** 受限 Lloyd 迭代预算（≤16——spike defaults 8；0=跳过松弛） */
    lloydIters: z.number().int().min(0).max(16).default(8),
    lumaB64: lumaB64Field.optional(),
    colorFamily: colorFamilyField,
    fallbackEngineStrategy: fallbackEngineStrategyField,
  })
  .strict();

const FlowParamsSchema = z
  .object({
    mode: z.literal('flow'),
    polarity: polarityField,
    lumaB64: lumaB64Field.optional(),
    colorFamily: colorFamilyField,
    fallbackEngineStrategy: fallbackEngineStrategyField,
  })
  .strict();

const HybridParamsSchema = z
  .object({
    mode: z.literal('hybrid'),
    /** 描线预算占比 ∈(0,1]：flow 线上钻数占总数比例（线分离度=s/lineShare） */
    lineShare: z.number().gt(0).lte(1).default(0.4),
    polarity: polarityField,
    lloydIters: z.number().int().min(0).max(16).default(8),
    lumaB64: lumaB64Field.optional(),
    colorFamily: colorFamilyField,
    fallbackEngineStrategy: fallbackEngineStrategyField,
  })
  .strict();

export const TextureFillParamsSchema = z.discriminatedUnion('mode', [
  ScatterParamsSchema,
  FlowParamsSchema,
  HybridParamsSchema,
]);
export type TextureFillParams = z.output<typeof TextureFillParamsSchema>;

// ---------------------------------------------------------------- 数值场（bbox 局部坐标）

const RHO_MIN = 0.32; // spike config.json defaults（pitch ∈[s,1.77s]）
const RHO_MAX = 1.0;

/** 可分离盒式模糊（running sum，边界 clamp，passes 次≈高斯——spike lib.mts boxBlur 语义）。 */
function boxBlur(src: Float32Array, w: number, h: number, r: number, passes: number): Float32Array {
  if (r <= 0 || passes <= 0) return src;
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const hz = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += cur[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        hz[y * w + x] = sum / (2 * r + 1);
        sum -= cur[y * w + Math.min(w - 1, Math.max(0, x - r))];
        sum += cur[y * w + Math.min(w - 1, Math.max(0, x + r + 1))];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += hz[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / (2 * r + 1);
        sum -= hz[Math.min(h - 1, Math.max(0, y - r)) * w + x];
        sum += hz[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
      }
    }
    cur = out;
  }
  return cur;
}

/** 亮度场（0-255 浮点）：lumaB64 有则解码+平滑；无则平坦 128（均匀密度）。 */
export function lumaField(p: TextureFillParams, mask: TreeMask2D): Float32Array {
  const n = mask.w * mask.h;
  if (p.lumaB64 !== undefined) {
    const raw = Buffer.from(p.lumaB64, 'base64');
    if (raw.length !== n) {
      throw new RangeError(`lumaB64 解码长度 ${raw.length} ≠ 掩膜 w*h=${n}（亮度场与掩膜同 bbox 语义）`);
    }
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = raw[i];
    const blurPx = Math.max(1, Math.min(8, Math.round(Math.min(mask.w, mask.h) / 24)));
    return boxBlur(f, mask.w, mask.h, blurPx, 2);
  }
  return new Float32Array(n).fill(128);
}

/**
 * 密度场 ρ（spike lib.mts densityField 语义）：掩膜内亮度直方图 CDF 分位 t∈[0,1] →
 * 极性翻转（dark-dense：暗=密）→ ρ∈[RHO_MIN,RHO_MAX]；flat→ρ≡1（目标密度直排）。
 * 轻平滑避免钻距突变；pitchAt=s/√ρ ∈[s,1.77s]。
 */
interface DensityField {
  rho: Float32Array;
  pitchAt(x: number, y: number): number;
}
export function densityField(p: TextureFillParams, mask: TreeMask2D, luma: Float32Array, s: number): DensityField {
  const { w, h } = mask;
  const hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask.bits[i] === 1) {
      hist[Math.min(255, Math.max(0, Math.round(luma[i])))]++;
      n++;
    }
  }
  const cdf = new Float64Array(256);
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    cdf[v] = acc / Math.max(1, n);
  }
  const rho = new Float32Array(w * h);
  if (p.polarity === 'flat') {
    for (let i = 0; i < w * h; i++) if (mask.bits[i] === 1) rho[i] = 1;
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mask.bits[i] !== 1) continue;
        const q = cdf[Math.min(255, Math.max(0, Math.round(luma[i])))]; // 0=最暗 1=最亮
        const t = p.polarity === 'bright-dense' ? q : 1 - q; // t 大=更密
        rho[i] = RHO_MIN + (RHO_MAX - RHO_MIN) * t;
      }
    }
  }
  const smooth = boxBlur(rho, w, h, 3, 1);
  return {
    rho: smooth,
    pitchAt(x, y) {
      const ix = Math.round(x);
      const iy = Math.round(y);
      const r = ix >= 0 && iy >= 0 && ix < w && iy < h ? smooth[iy * w + ix] : RHO_MIN;
      return s / Math.sqrt(Math.max(0.05, r));
    },
  };
}

/** 方向场（spike lib.mts orientField 语义）：结构张量+ETF 投票精炼；无 luma 用模糊掩膜代。
 * 导出面：flow 方向一致性测试（gem→最近邻向量 vs 局部切向夹角中位）复用同一真源。 */
interface OrientField {
  tx: Float32Array;
  ty: Float32Array;
  /** 场源是否为真实亮度（false=掩膜形状流退化——warning 依据） */
  fromLuma: boolean;
}
export function orientationField(p: TextureFillParams, mask: TreeMask2D): OrientField {
  const { w, h } = mask;
  let L: Float32Array;
  let fromLuma = true;
  if (p.lumaB64 !== undefined) {
    L = lumaField(p, mask);
    L = boxBlur(L, w, h, 2, 1); // preBlur
  } else {
    // 退化：模糊掩膜（值 0/1）的等值线切向=顺掩膜形状流
    fromLuma = false;
    const mf = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) mf[i] = mask.bits[i];
    L = boxBlur(mf, w, h, Math.max(2, Math.min(8, Math.round(Math.min(w, h) / 16))), 2);
  }
  // Sobel 梯度
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const gm = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = L[i - w - 1];
      const b = L[i - w];
      const c = L[i - w + 1];
      const d = L[i - 1];
      const f = L[i + 1];
      const g = L[i + w - 1];
      const hh = L[i + w];
      const k = L[i + w + 1];
      const sx = c + 2 * f + k - (a + 2 * d + g);
      const sy = g + 2 * hh + k - (a + 2 * b + c);
      gx[i] = sx;
      gy[i] = sy;
      gm[i] = Math.hypot(sx, sy);
    }
  }
  const tb = Math.max(2, Math.min(7, Math.round(Math.min(w, h) / 20))); // tensorBlur（spike 7）
  const mul = (a: Float32Array, b: Float32Array): Float32Array => {
    const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i];
    return o;
  };
  const Jxx = boxBlur(mul(gx, gx), w, h, tb, 2);
  const Jxy = boxBlur(mul(gx, gy), w, h, tb, 2);
  const Jyy = boxBlur(mul(gy, gy), w, h, tb, 2);
  const tx = new Float32Array(w * h);
  const ty = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const major = 0.5 * Math.atan2(2 * Jxy[i], Jxx[i] - Jyy[i]); // 主轴（梯度向）
    tx[i] = -Math.sin(major);
    ty[i] = Math.cos(major); // 切向 = 主轴 + 90°
  }
  // ETF 投票精炼（Kang 2007 简化）：t'(x) ∝ Σ φ(y)·sgn·t(y)，φ=|∇I|/max，w_d=|dot|³
  const r = Math.max(3, Math.min(5, Math.floor(Math.min(w, h) / 20))); // etfRadius（spike 5）
  const etfIters = 2;
  let gmax = 0;
  for (let i = 0; i < w * h; i++) if (gm[i] > gmax) gmax = gm[i];
  if (gmax <= 0) gmax = 1;
  let cx = tx;
  let cy = ty;
  for (let it = 0; it < etfIters; it++) {
    const nx = new Float32Array(w * h);
    const ny = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let sx = 0;
        let sy = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const j = yy * w + xx;
            const phi = gm[j] / gmax;
            if (phi < 1e-4) continue;
            const dot = cx[i] * cx[j] + cy[i] * cy[j];
            const sgn = dot >= 0 ? 1 : -1; // 对齐符号（切向 ± 等价）
            const wgt = phi * Math.abs(dot) * Math.abs(dot) * Math.abs(dot);
            sx += wgt * sgn * cx[j];
            sy += wgt * sgn * cy[j];
          }
        }
        const nn = Math.hypot(sx, sy);
        if (nn > 1e-9) {
          nx[i] = sx / nn;
          ny[i] = sy / nn;
        } else {
          nx[i] = cx[i];
          ny[i] = cy[i];
        }
      }
    }
    cx = nx;
    cy = ny;
  }
  return { tx: cx, ty: cy, fromLuma };
}

// ---------------------------------------------------------------- 技法 B：加权 Voronoi 点画（stipple）

interface Site {
  x: number;
  y: number;
}

/**
 * 加权 Voronoi stippling（spike stipple.mts 语义）：目标 N=Σρ/s² → 六边形网格+密度感知
 * 抖动初始化 → 密度加权 Lloyd（质心=Σρ·x/Σρ；空间哈希 per-pixel 归属；前半迭代 stride2
 * 加速；空胞 ρ 加权前缀和重生；meanMove<0.15 收敛早停）。站点 bbox 局部坐标。
 */
function stipple(
  mask: TreeMask2D,
  dens: DensityField,
  s: number,
  rand: () => number,
  lloydIters: number,
): { sites: Site[]; itersRun: number; finalMeanMove: number } {
  const { w, h } = mask;
  const bits = mask.bits;
  let rhoSum = 0;
  let maskN = 0;
  for (let i = 0; i < w * h; i++) {
    if (bits[i] === 1) {
      rhoSum += dens.rho[i];
      maskN++;
    }
  }
  const nTarget = Math.min(20000, Math.round(rhoSum / (s * s)));
  if (nTarget <= 0) return { sites: [], itersRun: 0, finalMeanMove: 0 };

  // 六边形网格 + 密度感知抖动（比 rejection sampling 方差低）
  const sites: Site[] = [];
  const rowH = s * Math.sin(Math.PI / 3);
  let row = 0;
  for (let y = rowH / 2; y < h; y += rowH, row++) {
    const off = row % 2 === 0 ? 0 : s / 2;
    for (let x = off; x < w; x += s) {
      const pd = dens.pitchAt(x, y);
      const jx = x + (rand() - 0.5) * pd * 0.7;
      const jy = y + (rand() - 0.5) * pd * 0.7;
      const ix = Math.round(jx);
      const iy = Math.round(jy);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h || bits[iy * w + ix] !== 1) continue;
      sites.push({ x: jx, y: jy });
    }
  }
  if (sites.length === 0) return { sites: [], itersRun: 0, finalMeanMove: 0 };

  // 掩膜像素坐标预取（前半迭代 stride 2 加速）
  const pixFull = new Int32Array(maskN * 2);
  {
    let p = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (bits[y * w + x] === 1) {
          pixFull[p++] = x;
          pixFull[p++] = y;
        }
      }
    }
  }
  const pixHalf: number[] = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (bits[y * w + x] === 1) {
        pixHalf.push(x, y);
      }
    }
  }
  const pixHalfArr = new Int32Array(pixHalf);

  // ρ 加权重生点表（空胞重生）：前缀和二分采样
  const cum = new Float64Array(pixFull.length / 2);
  {
    let acc2 = 0;
    for (let i = 0; i < cum.length; i++) {
      acc2 += dens.rho[pixFull[i * 2 + 1] * w + pixFull[i * 2]];
      cum[i] = acc2;
    }
  }
  const respawnTotal = cum[cum.length - 1] ?? 0;
  const respawn = (): Site => {
    const t = rand() * respawnTotal;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return { x: pixFull[lo * 2]! + 0.5, y: pixFull[lo * 2 + 1]! + 0.5 };
  };

  // 加权 Lloyd 迭代（空间哈希加速 per-pixel 最近站点归属）
  const cell = s * 2;
  const gw = Math.ceil((w + 1) / cell) + 1;
  const gh = Math.ceil((h + 1) / cell) + 1;
  let itersRun = 0;
  let finalMove = 0;
  for (let it = 0; it < lloydIters; it++) {
    const buckets: number[][] = Array.from({ length: gw * gh }, () => []);
    sites.forEach((st, i) => {
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(st.x / cell)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(st.y / cell)));
      buckets[gy * gw + gx]!.push(i);
    });
    const accX = new Float64Array(sites.length);
    const accY = new Float64Array(sites.length);
    const accW = new Float64Array(sites.length);
    const pix = it < lloydIters / 2 ? pixHalfArr : pixFull;
    for (let p = 0; p < pix.length; p += 2) {
      const px = pix[p]! + 0.5;
      const py = pix[p + 1]! + 0.5; // 像素中心
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(px / cell)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(py / cell)));
      let best = -1;
      let bd = Infinity;
      for (let ring = 1; ring <= 2 && best < 0; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (ring === 2 && Math.abs(dx) !== 2 && Math.abs(dy) !== 2) continue; // 只查新增外圈
            const b = buckets[(gy + dy) * gw + (gx + dx)];
            if (!b) continue;
            for (const si of b) {
              const st = sites[si]!;
              const d = (st.x - px) ** 2 + (st.y - py) ** 2;
              if (d < bd) {
                bd = d;
                best = si;
              }
            }
          }
        }
      }
      if (best < 0) continue;
      const wgt = dens.rho[pix[p + 1]! * w + pix[p]!];
      accX[best] += wgt * px;
      accY[best] += wgt * py;
      accW[best] += wgt;
    }
    let moveSum = 0;
    let moved = 0;
    for (let i = 0; i < sites.length; i++) {
      if (accW[i] < 1e-6) {
        const r2 = respawn();
        moveSum += Math.hypot(r2.x - sites[i]!.x, r2.y - sites[i]!.y);
        sites[i] = r2;
        moved++;
        continue;
      }
      const nx2 = accX[i]! / accW[i]!;
      const ny2 = accY[i]! / accW[i]!;
      moveSum += Math.hypot(nx2 - sites[i]!.x, ny2 - sites[i]!.y);
      sites[i] = { x: nx2, y: ny2 };
      moved++;
    }
    itersRun = it + 1;
    finalMove = moveSum / Math.max(1, moved);
    if (finalMove < 0.15) break; // 收敛
  }
  return { sites, itersRun, finalMeanMove: finalMove };
}

// ---------------------------------------------------------------- 技法 A：ETF 流线布点（flowlines）

/** 线采样点空间哈希：密度感知的线间距判据（跨亮度突变区不误杀——spike 工程调试 2）。 */
class LineHash {
  private m = new Map<number, { x: number; y: number; pitch: number }[]>();
  constructor(private cellPx = 8) {}
  private key(cx: number, cy: number): number {
    return cy * 100000 + cx;
  }
  add(x: number, y: number, pitch: number): void {
    const k = this.key(Math.floor(x / this.cellPx), Math.floor(y / this.cellPx));
    let arr = this.m.get(k);
    if (!arr) {
      arr = [];
      this.m.set(k, arr);
    }
    arr.push({ x, y, pitch });
  }
  /** (x,y) 处与已有线距离 < factor×min(双局部 pitch) 即被占。 */
  blocked(x: number, y: number, pitch: number, factor: number): boolean {
    const cx = Math.floor(x / this.cellPx);
    const cy = Math.floor(y / this.cellPx);
    const reach = Math.ceil((factor * pitch) / this.cellPx) + 1;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const arr = this.m.get(this.key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const q of arr) {
          const need = factor * Math.min(pitch, q.pitch);
          if ((q.x - x) ** 2 + (q.y - y) ** 2 < need * need) return true;
        }
      }
    }
    return false;
  }
}

/** 钻心覆盖网格（洞检测——半径 0.55×pitchLocal 的占据栅格）。 */
class CoverGrid {
  private g: Uint8Array;
  private gw: number;
  private gh: number;
  constructor(private w: number, private h: number, private cellPx = 2) {
    this.gw = Math.ceil(w / this.cellPx);
    this.gh = Math.ceil(h / this.cellPx);
    this.g = new Uint8Array(this.gw * this.gh);
  }
  stamp(x: number, y: number, r: number): void {
    const cx = Math.floor(x / this.cellPx);
    const cy = Math.floor(y / this.cellPx);
    const rc = Math.ceil(r / this.cellPx);
    for (let dy = -rc; dy <= rc; dy++) {
      for (let dx = -rc; dx <= rc; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) continue;
        if (dx * dx + dy * dy <= rc * rc) this.g[gy * this.gw + gx] = 1;
      }
    }
  }
  covered(x: number, y: number): boolean {
    const gx = Math.floor(x / this.cellPx);
    const gy = Math.floor(y / this.cellPx);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return true;
    return this.g[gy * this.gw + gx] === 1;
  }
}

interface FlowLine {
  poly: { x: number; y: number }[];
  phase: number;
}

/**
 * ETF 流线布点（spike flowlines.mts v2 语义）。sepMult=线分离度乘子（相对局部 pitch）：
 * 纯 flow=1.15、hybrid=s/lineShare/s 向放大（描线预算）。沿线步长=0.95×局部 pitch——
 * 方向度几何（spike 偏差修正）：cross/along=sep/0.95≈1.21>1 ⇒ 每钻最近邻=同线沿链邻点
 * （briefing 门「近邻方向差中位<45°」；spike 的 0.866 顺流六边形按同指标最近邻=跨线
 * 对角、夹角 60-90°，完美跟随也不过门——工程化改版）。钻径硬门兜底：步长与线距均
 * ≥ gemDiameter×1.001。返回流线钻（bbox 局部）+ 线集（测试方向度量复用）。
 */
export function flowLines(
  mask: TreeMask2D,
  dens: DensityField,
  ori: OrientField,
  s: number,
  gemDiameterPx: number,
  sepMult: number,
  rand: () => number,
): { pts: Site[]; lines: FlowLine[] } {
  const { w, h } = mask;
  const bits = mask.bits;
  const pitchAt = (x: number, y: number) => dens.pitchAt(x, y);
  const gemFloor = gemDiameterPx * 1.001;
  const stepAt = (x: number, y: number) => Math.max(pitchAt(x, y) * 0.95, gemFloor);
  const sep = Math.max(sepMult, (gemDiameterPx * 1.02) / s); // 钻径下限兜底
  const tangAt = (x: number, y: number): { tx: number; ty: number } | null => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 1 || iy < 1 || ix >= w - 1 || iy >= h - 1) return null;
    const i = iy * w + ix;
    const n = Math.hypot(ori.tx[i], ori.ty[i]);
    if (n < 1e-6) return null;
    return { tx: ori.tx[i] / n, ty: ori.ty[i] / n };
  };
  const inside = (x: number, y: number) =>
    x > 1 && y > 1 && x < w - 2 && y < h - 2 && bits[Math.round(y) * w + Math.round(x)] === 1;

  // 线几何判据：rootHash（factor 2.08×sep——根=稀疏骨架隔两环留位）+ lineHash（0.98×sep，
  // 子线在 sep 处合法、真贴近才被拒）
  const rootHash = new LineHash();
  const lineHash = new LineHash();
  const stampLine = (poly: { x: number; y: number }[], isRoot: boolean) => {
    for (const p of poly) {
      const pd = pitchAt(p.x, p.y);
      lineHash.add(p.x, p.y, pd);
      if (isRoot) rootHash.add(p.x, p.y, pd);
    }
  };

  // RK2 双向积分流线（Turk-Banks：出界/折返(72°)/贴近已有线即停）
  const trace = (sx: number, sy: number, hash: LineHash, factor: number): { x: number; y: number }[] => {
    const pts: { x: number; y: number }[] = [{ x: sx, y: sy }];
    for (const dir of [1, -1] as const) {
      let x = sx;
      let y = sy;
      let px = 0;
      let py = 0;
      for (let step = 0; step < 1500; step++) {
        const h0 = Math.max(1.5, Math.min(10, pitchAt(x, y) / 2));
        const k1 = tangAt(x, y);
        if (!k1) break;
        const mx = x + (dir * k1.tx * h0) / 2;
        const my = y + (dir * k1.ty * h0) / 2;
        const k2 = tangAt(mx, my);
        if (!k2) break;
        const nx = x + dir * k2.tx * h0;
        const ny = y + dir * k2.ty * h0;
        if (!inside(nx, ny)) break;
        if (hash.blocked(nx, ny, pitchAt(nx, ny), factor)) break;
        if (px !== 0 || py !== 0) {
          const dot = (px * k2.tx + py * k2.ty) / (Math.hypot(px, py) || 1);
          if (dot < Math.cos((72 * Math.PI) / 180)) break; // 折返
        }
        x = nx;
        y = ny;
        px = k2.tx;
        py = k2.ty;
        pts.push({ x, y });
      }
      if (dir === 1) pts.reverse(); // 前向段反转到头部，保证序列连续
    }
    return pts;
  };
  const polyLen = (poly: { x: number; y: number }[]): number => {
    let len = 0;
    for (let i = 1; i < poly.length; i++) len += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    return len;
  };

  // 种子：stride3 网格，密度优先（ρ+微扰）
  const seeds: { x: number; y: number; pr: number }[] = [];
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      if (bits[y * w + x] !== 1) continue;
      seeds.push({ x, y, pr: dens.rho[y * w + x] + rand() * 0.15 });
    }
  }
  seeds.sort((a, b) => b.pr - a.pr);

  const lines: FlowLine[] = [];
  const queue: FlowLine[] = [];
  for (const sd of seeds) {
    if (rootHash.blocked(sd.x, sd.y, pitchAt(sd.x, sd.y), 2.08 * sep)) continue;
    const poly = trace(sd.x, sd.y, rootHash, 2.08 * sep);
    if (polyLen(poly) < pitchAt(sd.x, sd.y) * 0.7) continue; // 连一颗钻都容不下的碎屑弃
    const line: FlowLine = { poly, phase: rand() };
    lines.push(line);
    queue.push(line);
    stampLine(poly, true);
  }

  // Hausner 式 offset 环扩展（「offset 定种、追迹定形」）：法向偏移找空槽 → 槽中点重追迹
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const side of [1, -1] as const) {
      const cand: { x: number; y: number; ok: boolean }[] = [];
      for (let i = 0; i < parent.poly.length; i++) {
        const p = parent.poly[i]!;
        const a = parent.poly[Math.max(0, i - 1)]!;
        const b = parent.poly[Math.min(parent.poly.length - 1, i + 1)]!;
        let tx = b.x - a.x;
        let ty = b.y - a.y;
        const n = Math.hypot(tx, ty) || 1;
        tx /= n;
        ty /= n;
        const d = pitchAt(p.x, p.y) * sep;
        const q = { x: p.x - ty * d * side, y: p.y + tx * d * side };
        const okq = inside(q.x, q.y) && !lineHash.blocked(q.x, q.y, pitchAt(q.x, q.y), 0.98 * sep);
        cand.push({ x: q.x, y: q.y, ok: okq });
      }
      // 最长 ok 段（允许桥接 1 个坏点）；取中点作重追迹种子
      let best: { s: number; e: number } | null = null;
      let curS = -1;
      let curLen = 0;
      let gap = 0;
      for (let i = 0; i < cand.length; i++) {
        if (cand[i]!.ok) {
          if (curS < 0) {
            curS = i;
            curLen = 0;
            gap = 0;
          }
          curLen++;
          gap = 0;
        } else if (curS >= 0 && gap < 1) {
          gap++;
          curLen++;
        } else {
          if (curS >= 0 && (!best || curLen > best.e - best.s)) best = { s: curS, e: curS + curLen };
          curS = -1;
        }
      }
      if (curS >= 0 && (!best || curLen > best.e - best.s)) best = { s: curS, e: curS + curLen };
      if (!best || best.e - best.s < 2) continue;
      const mid = cand[Math.floor((best.s + best.e) / 2)]!;
      if (polyLen([cand[best.s]!, mid, cand[best.e - 1]!]) < pitchAt(mid.x, mid.y) * 0.7) continue;
      const poly = trace(mid.x, mid.y, lineHash, 0.98 * sep);
      if (polyLen(poly) < pitchAt(mid.x, mid.y) * 0.7) continue;
      const line: FlowLine = { poly, phase: (parent.phase + 0.5) % 1 }; // 相位半格错开=顺流六边形
      lines.push(line);
      queue.push(line);
      stampLine(poly, false);
    }
  }

  // 沿线布钻：0.95×局部 pitch 步长（沿链最近邻——方向度几何，见函数头注）+ 相位
  const pts: Site[] = [];
  const gemCover = new CoverGrid(w, h, 1);
  for (const line of lines) {
    const poly = line.poly;
    const L = polyLen(poly);
    const p0 = stepAt(poly[0]!.x, poly[0]!.y);
    let next = L < p0 ? 0 : line.phase * p0;
    let cum = 0;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1]!;
      const b = poly[i]!;
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      const cumEnd = cum + seg;
      while (next <= cumEnd) {
        const t = seg > 0 ? (next - cum) / seg : 0;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const st = stepAt(x, y);
        pts.push({ x, y });
        gemCover.stamp(x, y, st * 0.62); // 0.62×步长：1.15 分离度线间隙全覆盖（洞=真窟窿而非线缝）
        next += st;
      }
      cum = cumEnd;
    }
  }

  // 洞补点：蓝噪声式贪心（密度优先）——退化场/边缘兜底（上限 0.5×目标+64 有界）
  const hash = new LineHash(); // 复用密度感知哈希做点级判定（cell=8）
  for (const p of pts) hash.add(p.x, p.y, pitchAt(p.x, p.y));
  let rhoSum = 0;
  for (let i = 0; i < w * h; i++) if (bits[i] === 1) rhoSum += dens.rho[i];
  const maxFill = Math.round(0.5 * (rhoSum / (s * s))) + 64;
  const holes: { x: number; y: number; pr: number }[] = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (bits[y * w + x] !== 1) continue;
      if (gemCover.covered(x, y)) continue;
      holes.push({ x, y, pr: dens.rho[y * w + x] + rand() * 0.3 });
    }
  }
  holes.sort((a, b) => b.pr - a.pr);
  let nFill = 0;
  for (const hole of holes) {
    if (nFill >= maxFill) break;
    const pd = pitchAt(hole.x, hole.y);
    const cnd = { x: hole.x + (rand() - 0.5) * pd * 0.4, y: hole.y + (rand() - 0.5) * pd * 0.4 };
    if (!inside(cnd.x, cnd.y)) continue;
    if (hash.blocked(cnd.x, cnd.y, pd, 0.98)) continue;
    hash.add(cnd.x, cnd.y, pd);
    pts.push(cnd);
    nFill++;
  }
  return { pts, lines };
}

// ---------------------------------------------------------------- 策略实现

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export const textureFillStrategy: KernelStrategy = {
  kind: 'texture-fill',
  status: 'implemented',
  paramsSchema: TextureFillParamsSchema,
  apply(input, ctx) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = TextureFillParamsSchema.parse(input.params ?? { mode: 'scatter' });
    const block = input.block;
    const mask = block.mask;
    const ppm = input.canvas.pixelsPerMm;
    // 特征间距：max(钻径, 密度推导)——ρ∈[0.32,1] ⇒ 局部 pitch∈[s,1.77s] 恒 ≥ 钻径
    const s = Math.max(ctx.gemDiameterPx, (10 * ppm) / Math.sqrt(ctx.densityPerCm2));
    const rand = ctx.rng(mixSeed(stringToSeed(block.id), 101, 202)); // spike seedSaltA/B

    const luma = lumaField(p, mask);
    const dens = densityField(p, mask, luma, s);

    let raw: { x: number; y: number }[];
    if (p.mode === 'scatter') {
      raw = stipple(mask, dens, s, rand, p.lloydIters).sites;
    } else {
      const ori = orientationField(p, mask);
      const sepMult = p.mode === 'hybrid' ? 1 / Math.min(4, p.lineShare) : 1.15; // hybrid 线分离=s/lineShare；flow=1.15（方向度几何）
      const flow = flowLines(mask, dens, ori, s, ctx.gemDiameterPx, sepMult, rand);
      if (p.mode === 'hybrid') {
        // B 打底+A 描线（§10 回流 1）：flow 线 keep-earlier 优先，scatter 打底补隙
        const base = stipple(mask, dens, s, rand, p.lloydIters).sites;
        raw = [...flow.pts, ...base];
      } else {
        raw = flow.pts;
      }
    }

    // 掩膜内过滤 + 钻径硬门（keep-earlier——stipple 站点/流线点已 ≥s≥钻径，此处终裁边界/合并冲突）
    const bbox = block.bbox;
    const inMask = raw.filter((q) => {
      const ix = Math.round(q.x);
      const iy = Math.round(q.y);
      return ix >= 0 && iy >= 0 && ix < mask.w && iy < mask.h && mask.bits[iy * mask.w + ix] === 1;
    });
    const spaced = ctx.geometry.enforceMinSpacing(inMask, ctx.gemDiameterPx * 0.999);

    const warnings = [];
    if (p.lumaB64 === undefined && p.mode !== 'scatter') {
      warnings.push({
        kind: 'degraded' as const,
        detail: `texture-fill ${p.mode} 无 lumaB64 亮度输入——方向场退化为掩膜形状流（顺掩膜等值线；真实纹理方向需 S6 指派附亮度场）`,
      });
    }
    if (p.colorFamily !== undefined) {
      warnings.push({
        kind: 'degraded' as const,
        detail: `色彩族完整性硬门位（§10 回流 3）：colorFamily=${p.colorFamily} 已记录，选色归 P3 策略设计器（本族 colorId 恒 ''）`,
      });
    }

    // 可读下限守卫（§9 回流 4 同款声明式降级）
    if (spaced.length < MIN_READABLE_GEMS) {
      return {
        gems: [],
        warnings: [
          ...warnings,
          {
            kind: 'degraded' as const,
            detail: `texture-fill ${p.mode} 间距过滤后 ${spaced.length} 颗 < 可读下限 ${MIN_READABLE_GEMS}——降级引擎 ${p.fallbackEngineStrategy}`,
          },
        ],
        engineStrategy: {
          engineStrategy: p.fallbackEngineStrategy,
          reason: 'geometry-min-size' as const,
          note: `${block.label}：纹理 ${p.mode} 不足可读下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
        },
      };
    }

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    const gems = spaced.map((q, i) => ({
      id: `${block.id}#t${String(i + 1).padStart(4, '0')}`,
      x: bbox.x + q.x,
      y: bbox.y + q.y,
      colorId: '',
      blockId: block.id,
      shapeId: 'round' as const,
      diameterMm,
    }));
    return { gems, warnings };
  },
};
