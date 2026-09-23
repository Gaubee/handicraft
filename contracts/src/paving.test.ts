/**
 * 排布参数契约单测（design §3.4/W0.2 任务门）。
 * 对照真源（人工核对，2026-09-23 抄录自 rhinestone-studio/src/lib/engine/types.ts）：
 *   L132: export const STRATEGY_IDS = ["hex-thin", "hex-pitch", "poisson", "hybrid", "cvt"] as const;
 *   L179: const unit = z.number().positive().max(1);
 *   L185: gapMm: z.number().nonnegative(),
 *   L193: density: z.union([unit, z.record(z.string(), unit)]).default(1),
 *   L194: seed: z.number().int().nonnegative().default(1),
 *   L196-200: relax: z.object({ boundary: z.boolean().default(false), repulsion: z.boolean().default(false) })
 * 本包不 import 引擎（独立可发布）——以上字面量即镜像核对基准。
 */
import { describe, expect, it } from 'vitest';
import {
  DensitySpecSchema,
  GapMmSchema,
  PaveParamsSchema,
  ProposalDiffSchema,
  RegionSchema,
  StrategyIdSchema,
} from './paving.js';

const hash = 'a'.repeat(64);
const hash2 = 'b'.repeat(64);

describe('引擎真源镜像对照（字面量断言）', () => {
  it('strategy 五值含 cvt（= engine STRATEGY_IDS 逐字面）', () => {
    // engine types.ts L132: ["hex-thin", "hex-pitch", "poisson", "hybrid", "cvt"]
    expect([...StrategyIdSchema.options]).toEqual(['hex-thin', 'hex-pitch', 'poisson', 'hybrid', 'cvt']);
  });
  it('density 边界 (0,1]（= engine unit = z.number().positive().max(1)）', () => {
    // 开区间下界：0 拒绝、极小正数通过；闭区间上界：1 通过、1+ε 拒绝
    for (const ok of [1, 0.5, 0.001]) expect(DensitySpecSchema.safeParse(ok).success).toBe(true);
    for (const bad of [0, -0.1, 1.0001, 2, NaN, Infinity]) {
      expect(DensitySpecSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('gapMm ≥ 0（= engine GridSpecSchema.gapMm = z.number().nonnegative()；0=相切）', () => {
    for (const ok of [0, 0.4, 10]) expect(GapMmSchema.safeParse(ok).success).toBe(true);
    for (const bad of [-0.001, -1]) expect(GapMmSchema.safeParse(bad).success).toBe(false);
  });
});

describe('非法值显式拒绝（不魔术兜底）', () => {
  it('未知 strategy 拒绝', () => {
    expect(PaveParamsSchema.safeParse({ strategy: 'grid-v9', gapMm: 0 }).success).toBe(false);
    expect(PaveParamsSchema.safeParse({ strategy: 'cvt', gapMm: 0 }).success).toBe(true);
  });
  it('空 region 拒绝；kind 单变体（未知 kind 拒绝）', () => {
    expect(RegionSchema.safeParse({ kind: 'blocks', ids: [] }).success).toBe(false);
    expect(RegionSchema.safeParse({ kind: 'blocks', ids: ['b1'] }).success).toBe(true);
    expect(RegionSchema.safeParse({ kind: 'layer', ids: ['l1'] }).success).toBe(false);
    expect(RegionSchema.safeParse({ ids: ['b1'] }).success).toBe(false);
  });
  it('逐块 density 越界值拒绝（record 形态同边界）', () => {
    expect(DensitySpecSchema.safeParse({ b1: 0.5, b2: 1 }).success).toBe(true);
    expect(DensitySpecSchema.safeParse({ b1: 0, b2: 1 }).success).toBe(false);
    expect(DensitySpecSchema.safeParse({ b1: 1.5 }).success).toBe(false);
  });
  it('PaveParams 默认值对齐引擎（density=1/seed=1/relax 双 false）', () => {
    const parsed = PaveParamsSchema.parse({ strategy: 'hex-pitch', gapMm: 0.4 });
    expect(parsed.density).toBe(1);
    expect(parsed.seed).toBe(1);
    expect(parsed.relax).toEqual({ boundary: false, repulsion: false });
  });
});

describe('proposal diff 契约', () => {
  const diff = {
    region: { kind: 'blocks' as const, ids: ['b1', 'b2'] },
    ops: [
      { op: 'setDensity' as const, target: 'b1', before: 0.6, after: 0.9 },
      { op: 'recolor' as const, target: 'b2', before: 'c-red', after: 'c-gold' },
      {
        op: 'setSpec' as const,
        target: 'b2',
        before: { shapeId: 'round' as const, diameterMm: 3 },
        after: { shapeId: 'drop' as const, diameterMm: 2.5, rotationDeg: 90 },
      },
    ],
    preview: { beforeBlob: hash, afterBlob: hash2 },
    estGemsDelta: 120,
    dropped: 0,
  };
  it('region+ops 三态+preview+estGemsDelta+dropped 全链解析', () => {
    const parsed = ProposalDiffSchema.parse(diff);
    expect(parsed.ops).toHaveLength(3);
    expect(parsed.ops[2].after).toMatchObject({ shapeId: 'drop', diameterMm: 2.5 });
  });
  it('空 ops 拒绝；setDensity 越界 before/after 拒绝；负 dropped 拒绝', () => {
    expect(ProposalDiffSchema.safeParse({ ...diff, ops: [] }).success).toBe(false);
    expect(
      ProposalDiffSchema.safeParse({
        ...diff,
        ops: [{ op: 'setDensity', target: 'b1', before: 0, after: 0.9 }],
      }).success,
    ).toBe(false);
    expect(ProposalDiffSchema.safeParse({ ...diff, dropped: -1 }).success).toBe(false);
  });
});
