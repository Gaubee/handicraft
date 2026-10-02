/**
 * 沿路径族 along-path（close-paving-backlog T3——Owner 2026-09-21 原话「路径功能
 * 意味着要能编辑路径…你可以预留一个 change，后续再做」预留兑现；outline 模式同时
 * 承接边框花环（tech-research B3——映射承接见 change design §0）。2026-10-02）。
 *
 * 两路径源（design §3）：
 *   outline（缺省）=掩码最大连通域外边界游走（ctx.geometry.boundaryTrace——Moore 邻域，
 *                  GeometryHelpers 注入面新增共享件）+法向内缩 outlineInsetPx
 *                  （缺省 0.5×钻径——边框钻心不压边；简化内缩，自交由判距门吸收
 *                  +warning 留痕）；恒闭合。
 *   custom         =pathPts 显式折线（画布坐标——LLM/用户编辑路径面；closed 可选）。
 *
 * 布点：**等弧长重采样直接消费 ctx.geometry.resampleOpen/resampleClosed**（既有共享件
 * ——soft_curve 内嵌等弧长与骨架分支耦合不提取不动，R1-P2-1）；步长 spacing（缺省=
 * characteristicSpacingPx）；掩膜过滤+enforceMinSpacing(gemDiameterPx×0.999)（四策略
 * 同式单源先例）；角度=路径切线（soft_curve 前后窗差分同式）。
 * 可读下限守卫=MIN_READABLE_GEMS 全族统一（geometry 同款声明式降级）。
 * 确定性：纯算法无随机（同输入同输出——§4.4）。
 */
import { z } from 'zod';
import { StrategyIdSchema } from '@handicraft/contracts';
import type { TreeBBox } from '../vision/tree-to-blocks.js';
import { MIN_READABLE_GEMS, characteristicSpacingPx, compassRotationDeg, type Vec2 } from './geometry.js';
import type { KernelStrategy, StrategyResult } from './registry.js';

// ---------------------------------------------------------------- 参数 schema（Zod 冻结）

const PathPtSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export const AlongPathParamsSchema = z
  .object({
    /** 路径源：outline=掩码边界等距线（边框花环承接）；custom=pathPts 显式折线。 */
    pathSource: z.enum(['outline', 'custom']).default('outline'),
    /**
     * outline 法向内缩 px（缺省 0.5×钻径——边框钻心不压边）。简化内缩：边界点沿
     * 内向法线平移；窄条掩膜自交/越界由掩膜过滤+判距门吸收（warning 留痕）。
     */
    outlineInsetPx: z.number().gte(0).lte(500).optional(),
    /** custom 路径点列（画布坐标折线——custom 必填 ≥2 点；outline 携带=typed 拒）。 */
    pathPts: z.array(PathPtSchema).min(2).max(4096).optional(),
    /** 沿线步长 px（缺省=characteristicSpacingPx——密度推导间距）。 */
    spacing: z.number().gt(0).lte(100000).optional(),
    /** 折线闭合（custom 专用；outline 恒 true）。 */
    closed: z.boolean().default(false),
    fallbackEngineStrategy: StrategyIdSchema.default('hex-pitch'),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.pathSource === 'custom' && p.pathPts === undefined) {
      ctx.addIssue({ code: 'custom', message: 'pathSource=custom 必携 pathPts（≥2 点折线——空路径不可布点）' });
    }
    if (p.pathSource === 'outline' && p.pathPts !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'pathSource=outline 不携带 pathPts（边界由掩码提取——显式折线用 custom）' });
    }
  });
export type AlongPathParams = z.output<typeof AlongPathParamsSchema>;

// ---------------------------------------------------------------- 路径源

/** 折线弧长。 */
function polylineLen(pts: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return len;
}

/**
 * outline 边界提取+法向内缩：ctx.geometry.boundaryTrace（画布全局像素坐标顺时针链）
 * → 局部系 → 逐点切向（前后邻差分，环回）→ 内向法线平移 inset。像素系 y 向下、
 * 顺时针外边界链的内侧=切向顺时针旋 90°（(tx,ty)→(−ty,tx)——2×2 方块闭式推导见
 * tests/strategies-along-path.test.ts）。返回局部像素坐标链。
 */
function insetOutlinePath(
  boundaryGlobal: Vec2[],
  bbox: TreeBBox,
  inset: number,
): Vec2[] {
  const boundary = boundaryGlobal.map((q) => ({ x: q.x - bbox.x, y: q.y - bbox.y }));
  const n = boundary.length;
  if (n < 3) return boundary;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = boundary[(i - 1 + n) % n]!;
    const next = boundary[(i + 1) % n]!;
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const m = Math.hypot(tx, ty) || 1;
    tx /= m;
    ty /= m;
    const p = boundary[i]!;
    // 内向法线（顺时针链右手内侧）(−ty,tx)×inset
    out.push({ x: p.x + -ty * inset, y: p.y + tx * inset });
  }
  return out;
}

// ---------------------------------------------------------------- 策略实现

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export const alongPathStrategy: KernelStrategy = {
  kind: 'along-path',
  status: 'implemented',
  paramsSchema: AlongPathParamsSchema,
  apply(input, ctx) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = AlongPathParamsSchema.parse(input.params ?? {});
    const block = input.block;
    const mask = block.mask;
    const ppm = input.canvas.pixelsPerMm;
    const s = characteristicSpacingPx(ctx.gemDiameterPx, ctx.densityPerCm2, ppm);
    const spacing = p.spacing ?? s;
    const inset = p.outlineInsetPx ?? 0.5 * ctx.gemDiameterPx;

    const warnings: Array<{ kind: 'geometry' | 'mask' | 'degraded'; detail: string }> = [];
    const degrade = (detail: string): StrategyResult => ({
      gems: [],
      warnings: [
        ...warnings,
        {
          kind: 'degraded' as const,
          detail:
            `${detail} < 可读下限 ${MIN_READABLE_GEMS}（极小产出可读性兜底——声明密度优先）`
            + `——降级引擎 ${p.fallbackEngineStrategy}（目标密度不变，仅形态兜底）`,
        },
      ],
      engineStrategy: {
        engineStrategy: p.fallbackEngineStrategy,
        reason: 'geometry-min-size' as const,
        note: `${block.label}：沿路径低于可读兜底下限，声明式降级 ${p.fallbackEngineStrategy}（P3 接线消费）`,
      },
    });

    // —— 路径源（局部像素坐标——掩膜同系）
    let pathLocal: Vec2[];
    let closed: boolean;
    if (p.pathSource === 'outline') {
      pathLocal = insetOutlinePath(ctx.geometry.boundaryTrace(mask, block.bbox), block.bbox, inset);
      closed = true;
    } else {
      pathLocal = (p.pathPts ?? []).map((q) => ({ x: q.x - block.bbox.x, y: q.y - block.bbox.y }));
      closed = p.closed;
    }
    const pathLen = closed ? polylineLen([...pathLocal, pathLocal[0]!]) : polylineLen(pathLocal);
    if (pathLocal.length < 2 || pathLen < spacing * (MIN_READABLE_GEMS - 1)) {
      return degrade(`along-path ${p.pathSource} 路径产出不足（${pathLocal.length} 点/弧长 ${Math.round(pathLen)}px——一步 ${Math.round(spacing)}px）`);
    }

    // —— 等弧长重采样（直接消费既有共享件——soft_curve 零改动，design §3/R1-P2-1）
    const pts = closed
      ? ctx.geometry.resampleClosed(pathLocal, spacing, 0)
      : ctx.geometry.resampleOpen(pathLocal, spacing, 0);
    // 首尾钻守卫（开路径 resampleOpen 含首不含尾——尾段剩余弧长 ≥0.75×spacing 时补
    // 尾点，端点不缺钻；间距硬门终裁贴尾情形）
    let sampled = pts;
    if (!closed && pts.length >= 1) {
      const end = pathLocal[pathLocal.length - 1]!;
      const last = pts[pts.length - 1]!;
      const tailGap = Math.hypot(end.x - last.x, end.y - last.y);
      if (tailGap >= 0.75 * spacing) sampled = [...pts, { ...end }];
    }

    // —— 掩膜过滤（内缩自交/越界点由门吸收）+ 角度=路径切线（soft_curve 前后窗差分同式）
    const inMaskAt = (x: number, y: number): boolean => {
      const ix = Math.round(x);
      const iy = Math.round(y);
      return ix >= 0 && iy >= 0 && ix < mask.w && iy < mask.h && mask.bits[iy * mask.w + ix] === 1;
    };
    const m = sampled.length;
    const raw: { x: number; y: number; rotDeg: number }[] = [];
    for (let i = 0; i < m; i++) {
      const q = sampled[i]!;
      if (!inMaskAt(q.x, q.y)) continue;
      const pa = closed ? sampled[(i - 1 + m) % m]! : sampled[Math.max(0, i - 1)]!;
      const pb = closed ? sampled[(i + 1) % m]! : sampled[Math.min(m - 1, i + 1)]!;
      let dx = pb.x - pa.x;
      let dy = pb.y - pa.y;
      if (Math.hypot(dx, dy) < 1e-9) {
        // 单点退化（弧长 < 步长）——路径整体方向兜底（soft_curve 同款）
        dx = pathLocal[pathLocal.length - 1]!.x - pathLocal[0]!.x;
        dy = pathLocal[pathLocal.length - 1]!.y - pathLocal[0]!.y;
      }
      raw.push({ x: q.x, y: q.y, rotDeg: compassRotationDeg(dx, dy) });
    }
    if (raw.length < sampled.length / 2) {
      warnings.push({
        kind: 'mask',
        detail: `along-path ${p.pathSource} 重采样 ${sampled.length} 点中仅 ${raw.length} 落在掩膜内（内缩 ${Math.round(inset)}px 自交/越界——窄条掩膜建议降 outlineInsetPx）`,
      });
    }

    // —— 钻径硬门（四策略同式单源先例——keep-earlier）
    const spaced = ctx.geometry.enforceMinSpacing(raw, ctx.gemDiameterPx * 0.999);
    if (spaced.length < MIN_READABLE_GEMS) {
      return degrade(`along-path 布点 ${spaced.length} 颗`);
    }

    const diameterMm = round6(ctx.gemDiameterPx / ppm);
    // enforceMinSpacing keep-earlier 保留原对象引用（geometry.ts 单源语义）——切线角随钻存活
    const gems = (spaced as { x: number; y: number; rotDeg: number }[]).map((q, i) => ({
      id: `${block.id}#p${String(i + 1).padStart(4, '0')}`,
      x: block.bbox.x + q.x,
      y: block.bbox.y + q.y,
      colorId: '',
      blockId: block.id,
      shapeId: 'round' as const,
      diameterMm,
      rotationDeg: round6(q.rotDeg),
    }));
    return { gems, warnings };
  },
};
