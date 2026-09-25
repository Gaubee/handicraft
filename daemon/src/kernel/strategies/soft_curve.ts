/**
 * 柔和曲线布艺族（add-subject-sam-pipeline design §4.2——P1.2；Owner 定调主文：
 * 「柔和曲线布艺」——缎带/褶皱/枝条沿线柔排，multistrat-spike §9 实测「柔和曲线最出效果
 * （缎带顺褶皱）」）。
 *
 * 算法：形态学骨架化（Zhang-Suen 两子迭代细化至稳定——design §4.2「节点中轴/骨架
 * （距离变换脊线或形态学）」的形态学路线）→ 骨架像素 8 邻接图 → 端点(度1)/交叉点(度≥3)
 * 切分分支 → 最短长度筛选 → 各分支等弧长布点（弧长线性插值；分支间黄金角比例相位错开
 * 消机械对齐——geometry.ts loopPhase 同哲学）。
 *
 * 参数（design §4.2 参数≤5）：minBranchLengthMm（分支筛选最短长度——短于值 的碎枝弃）
 * / pointSpacingMm（点距——缺省=密度推导间距 s=characteristicSpacingPx）。
 * 密度/钻径贯穿 ctx；钻径=判距硬门（enforceMinSpacing 终裁）。
 * 色彩族完整性硬门位（§10 回流 3）：colorFamily 预留+warning（选色归 P3）。
 * 确定性：纯算法无随机（同输入同输出——§4.4）。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import { MIN_READABLE_GEMS, characteristicSpacingPx } from './geometry.js';
import type { KernelStrategy } from './registry.js';

// ---------------------------------------------------------------- 参数 schema（Zod 冻结）

export const SoftCurveParamsSchema = z
  .object({
    /** 分支筛选最短长度（mm——弧长低于此值的骨架碎枝弃；缺省=0.7×特征间距[一颗钻容不下即弃]） */
    minBranchLengthMm: z.number().min(0).max(500).optional(),
    /** 沿骨架点距（mm——缺省=密度推导间距） */
    pointSpacingMm: z.number().min(0.01).max(500).optional(),
    colorFamily: z.string().min(1).max(64).optional(),
    fallbackEngineStrategy: StrategyIdSchema.default('hex-pitch'),
  })
  .strict();
export type SoftCurveParams = z.output<typeof SoftCurveParamsSchema>;

// ---------------------------------------------------------------- 骨架化（Zhang-Suen）

/** 3×3 多数滤波（≥5 邻居为 1 则 1）——掩膜边缘阶梯/毛刺压制（骨架毛刺源头）。 */
function majority(bits: Uint8Array, w: number, h: number, passes = 2): Uint8Array {
  let cur = new Uint8Array(bits);
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
            if (cur[yy * w + xx] === 1) cnt++;
          }
        }
        out[y * w + x] = cnt >= 5 ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}

/** Zhang-Suen 两子迭代细化（8 邻域，迭代至稳定）——输入 w*h 0/1，输出同构骨架。 */
export function zhangSuen(bits: Uint8Array, w: number, h: number): Uint8Array {
  const img = majority(bits, w, h, 2); // 边缘预平滑（阶梯毛刺→骨架短刺的源头压制）
  const N = (x: number, y: number): number[] => {
    // P2..P9 顺时针（P2=上）——Zhang-Suen 记法
    const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : img[yy * w + xx]);
    return [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
  };
  const transitions = (ns: number[]): number => {
    let b = 0;
    for (let i = 0; i < 8; i++) if (ns[i] === 0 && ns[(i + 1) % 8] === 1) b++;
    return b;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [0, 1] as const) {
      const dels: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (img[y * w + x] !== 1) continue;
          const ns = N(x, y);
          const b = transitions(ns);
          if (b !== 1) continue;
          const n1 = ns[0]! + ns[2]! + ns[4]! + ns[6]!;
          if (n1 < 2 || n1 > 3) continue;
          if (step === 0 && ns[0]! * ns[2]! * ns[4]! !== 0) continue; // P2·P4·P6
          if (step === 0 && ns[2]! * ns[4]! * ns[6]! !== 0) continue; // P4·P6·P8
          if (step === 1 && ns[0]! * ns[2]! * ns[6]! !== 0) continue; // P2·P4·P8
          if (step === 1 && ns[0]! * ns[4]! * ns[6]! !== 0) continue; // P2·P6·P8
          dels.push(y * w + x);
        }
      }
      if (dels.length > 0) {
        changed = true;
        for (const i of dels) img[i] = 0;
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------- 分支图提取

/** 骨架分支（像素链——bbox 局部坐标，链上相邻像素 8 连通）。 */
interface Branch {
  pts: { x: number; y: number }[];
}

/**
 * 骨架 → 分支集：度≠2 的像素（端点/交叉点）为节点，节点间路径为分支；纯环（无端点）
 * 在任意度2像素处断开成一条分支。8 邻接度计数。
 */
export function extractBranches(sk: Uint8Array, w: number, h: number): Branch[] {
  const deg = (x: number, y: number): number => {
    let d = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (sk[yy * w + xx] === 1) d++;
      }
    }
    return d;
  };
  const branches: Branch[] = [];
  const visited = new Uint8Array(w * h);
  const skIdx: number[] = [];
  for (let i = 0; i < w * h; i++) if (sk[i] === 1) skIdx.push(i);
  if (skIdx.length === 0) return branches;

  const DIRS: [number, number][] = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  // 从节点（度≠2：端点/交叉点）出发走路径
  for (const i of skIdx) {
    if (visited[i] === 1) continue;
    const x0 = i % w;
    const y0 = (i / w) | 0;
    if (deg(x0, y0) === 2) continue; // 环内部像素——后面统一处理
    visited[y0 * w + x0] = 1;
    for (const [dx0, dy0] of DIRS) {
      // 沿每个未访问邻居走一条分支（多叉交叉点走多条）
      let cx = x0 + dx0;
      let cy = y0 + dy0;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h || visited[cy * w + cx] === 1 || sk[cy * w + cx] !== 1) continue;
      const seg: Branch = { pts: [{ x: x0, y: y0 }] };
      for (;;) {
        visited[cy * w + cx] = 1;
        seg.pts.push({ x: cx, y: cy });
        if (deg(cx, cy) !== 2) break; // 抵达下一节点（端点/交叉点）
        // 走向下一个未访问邻居（度2像素的唯一去向=前向来者已访问）
        let nx = -1;
        let ny = -1;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = cx + dx;
            const yy = cy + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            if (sk[yy * w + xx] === 1 && visited[yy * w + xx] === 0) {
              nx = xx;
              ny = yy;
            }
          }
        }
        if (nx < 0) break; // 链尽（端点或已访问包围）
        cx = nx;
        cy = ny;
      }
      if (seg.pts.length >= 2) branches.push(seg);
    }
  }
  // 纯环（剩余未访问度2像素）
  for (const i of skIdx) {
    if (visited[i] === 1) continue;
    const x0 = i % w;
    const y0 = (i / w) | 0;
    const seg: Branch = { pts: [] };
    let cx = x0;
    let cy = y0;
    for (;;) {
      visited[cy * w + cx] = 1;
      seg.pts.push({ x: cx, y: cy });
      let nx = -1;
      let ny = -1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = cx + dx;
          const yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (sk[yy * w + xx] === 1 && visited[yy * w + xx] === 0) {
            nx = xx;
            ny = yy;
          }
        }
      }
      if (nx < 0) break;
      cx = nx;
      cy = ny;
    }
    if (seg.pts.length >= 3) branches.push(seg);
    else seg.pts.forEach((q) => (visited[q.y * w + q.x] = 1));
  }
  return mergeCollinearBranches(branches);
}

/** 分支端向（端点回退 k 步的单位向量）。 */
function endDir(pts: { x: number; y: number }[], fromEnd: boolean): { x: number; y: number } {
  const n = pts.length;
  const a = fromEnd ? pts[n - 1]! : pts[0]!;
  const b = fromEnd ? pts[Math.max(0, n - 4)]! : pts[Math.min(n - 1, 3)]!;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const m = Math.hypot(dx, dy) || 1;
  return { x: dx / m, y: dy / m };
}

/**
 * 共线分支合并：8 连通细化在对角阶梯处产生伪交叉点（相邻水平+对角邻居互为邻接），
 * 把平滑曲线打断成碎片——端点近邻（≤1.5px）且出向对齐（≥cos45°）的分支接回。
 * 真毛刺（垂直伸出）不满足对齐条件、不被合并，仍由最短长度筛除。
 */
function mergeCollinearBranches(branches: Branch[]): Branch[] {
  let list = branches.filter((b) => b.pts.length >= 2);
  const COS60 = Math.cos((60 * Math.PI) / 180);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const a = list[i]!;
        const b = list[j]!;
        // 四种端接：a尾-b头（顺接）/a尾-b尾/a头-b头/a头-b尾（按需翻转）
        const configs: [boolean, boolean][] = [
          [true, false],
          [true, true],
          [false, false],
          [false, true],
        ];
        for (const [aEnd, bEnd] of configs) {
          const pa = aEnd ? a.pts[a.pts.length - 1]! : a.pts[0]!;
          const pb = bEnd ? b.pts[b.pts.length - 1]! : b.pts[0]!;
          if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > 2.5) continue; // 伪交叉点簇遗留隙 ≤2-3px
          const da = endDir(a.pts, aEnd);
          const db = endDir(b.pts, bEnd);
          const dot = -(da.x * db.x + da.y * db.y); // 接口处出向相反（相向而行）
          if (dot < COS60) continue; // 真毛刺⊥伸出不满足对齐——仍由最短长度筛除
          const bRev = bEnd ? [...b.pts].reverse() : b.pts;
          const merged = aEnd ? [...a.pts, ...bRev.slice(1)] : [...bRev, ...a.pts.slice(1)];
          list[i] = { pts: merged };
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------- 策略实现

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 开折线弧长。 */
function polylineLen(pts: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** 黄金角比例相位（分支间错位——消沿线对齐机械感）。 */
function branchPhase(k: number): number {
  return (k * 0.618033988749895) % 1;
}

export const softCurveStrategy: KernelStrategy = {
  kind: 'soft-curve',
  status: 'implemented',
  paramsSchema: SoftCurveParamsSchema,
  apply(input, ctx) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = SoftCurveParamsSchema.parse(input.params ?? {});
    const block = input.block;
    const mask = block.mask;
    const ppm = input.canvas.pixelsPerMm;
    const s = characteristicSpacingPx(ctx.gemDiameterPx, ctx.densityPerCm2, ppm);
    const spacing = p.pointSpacingMm !== undefined ? Math.max(ctx.gemDiameterPx, p.pointSpacingMm * ppm) : s;
    const minBranchPx =
      p.minBranchLengthMm !== undefined ? p.minBranchLengthMm * ppm : 0.7 * s; // 缺省=一颗钻容不下即弃

    const skeleton = zhangSuen(mask.bits, mask.w, mask.h);
    const branches = extractBranches(skeleton, mask.w, mask.h);
    const keptBranches = branches
      .filter((br) => polylineLen(br.pts) >= minBranchPx)
      .sort((a, b) => polylineLen(b.pts) - polylineLen(a.pts)); // 长分支先入 keep-earlier（主结构优先，碎枝补隙）

    const warnings = [];
    if (branches.length !== keptBranches.length) {
      warnings.push({
        kind: 'geometry' as const,
        detail: `骨架分支 ${branches.length} 条中 ${branches.length - keptBranches.length} 条短于最短长度 ${Math.round(minBranchPx)}px 被筛除`,
      });
    }
    if (p.colorFamily !== undefined) {
      warnings.push({
        kind: 'degraded' as const,
        detail: `色彩族完整性硬门位（§10 回流 3）：colorFamily=${p.colorFamily} 已记录，选色归 P3 策略设计器（本族 colorId 恒 ''）`,
      });
    }

    // 等弧长布点（含首点；分支相位黄金角错开）
    const raw: { x: number; y: number }[] = [];
    keptBranches.forEach((br, k) => {
      const total = polylineLen(br.pts);
      const phase = branchPhase(k) * spacing;
      const out: { x: number; y: number }[] = [];
      let seg = 0;
      let cum = 0;
      const cumArr = [0];
      for (let i = 1; i < br.pts.length; i++) {
        cum += Math.hypot(br.pts[i]!.x - br.pts[i - 1]!.x, br.pts[i]!.y - br.pts[i - 1]!.y);
        cumArr.push(cum);
      }
      for (let t = phase; t <= total; t += spacing) {
        while (seg < cumArr.length - 2 && cumArr[seg + 1]! < t) seg++;
        const a = br.pts[seg]!;
        const b = br.pts[seg + 1] ?? a;
        const len = cumArr[seg + 1]! - cumArr[seg]!;
        const f = len > 0 ? (t - cumArr[seg]!) / len : 0;
        out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      }
      raw.push(...out);
    });

    // 掩膜内过滤（骨架在掩膜内，插值点贴边界可能出掩膜——像素中心判定）+ 钻径硬门
    const inMask = raw.filter((q) => {
      const ix = Math.round(q.x);
      const iy = Math.round(q.y);
      return ix >= 0 && iy >= 0 && ix < mask.w && iy < mask.h && mask.bits[iy * mask.w + ix] === 1;
    });
    const spaced = ctx.geometry.enforceMinSpacing(inMask, ctx.gemDiameterPx * 0.999);

    if (spaced.length < MIN_READABLE_GEMS) {
      return {
        gems: [],
        warnings: [
          ...warnings,
          {
            kind: 'degraded' as const,
            detail: `soft-curve 布点 ${spaced.length} 颗 < 可读下限 ${MIN_READABLE_GEMS}（掩膜过窄/分支过碎）——降级引擎 ${p.fallbackEngineStrategy}`,
          },
        ],
        engineStrategy: {
          engineStrategy: p.fallbackEngineStrategy,
          reason: 'geometry-min-size' as const,
          note: `${block.label}：柔和曲线不足可读下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
        },
      };
    }

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    const gems = spaced.map((q, i) => ({
      id: `${block.id}#c${String(i + 1).padStart(4, '0')}`,
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
