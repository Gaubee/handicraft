/**
 * 排布参数契约（design §3.4——引擎真源镜像，W4 capability 工具一等输入）。
 * 原始需求 2026-09-23（R2 按引擎 src/lib/engine/types.ts 真源逐字段冻结）。
 * 独立性：本包**不 import 引擎**（独立可发布）；字段名/边界与引擎 schema 逐字面
 * 一致——对照测试 paving.test.ts 以引擎源码抄录的字面量断言（人工核对注记）。
 * 正交意图：
 *   [1] 五参数：strategy（五值含 cvt）/ density（(0,1] 全局或逐块）/ gapMm（≥0，
 *       0=相切；pitchMm=钻径+gapMm 派生）/ seed（int≥0 默认 1）/ relax（默认双 false）。
 *   [2] region 首版收敛 blocks ID（single variant；引擎无 layer 概念）。
 *   [3] proposal diff：region + ops 三态（setDensity/recolor/setSpec）+ preview +
 *       estGemsDelta + dropped（间距冲突确定性剔除计数——供用户裁决，非 warning）。
 */
import { z } from 'zod';
import { BlobRefSchema } from './common.js';

/** 图块 id（引擎 Block.id——自然语言→区域由 agent 经只读工具查询 blocks 元数据后选定）。 */
export const BlockIdSchema = z.string().min(1);
export type BlockId = z.infer<typeof BlockIdSchema>;

/**
 * strategy 五值。真源：rhinestone-studio/src/lib/engine/types.ts
 * `export const STRATEGY_IDS = ["hex-thin", "hex-pitch", "poisson", "hybrid", "cvt"] as const;`
 * （对照测试逐字面断言——paving.test.ts）。
 */
export const StrategyIdSchema = z.enum(['hex-thin', 'hex-pitch', 'poisson', 'hybrid', 'cvt']);
export type StrategyId = z.infer<typeof StrategyIdSchema>;

/** (0,1] 密度单元。真源：engine types.ts `const unit = z.number().positive().max(1)`。 */
const DensityUnitSchema = z.number().positive().max(1);

/**
 * 密度双形态：全局标量或按块 Record（缺省块默认 1）。真源：engine types.ts
 * `density: z.union([unit, z.record(z.string(), unit)]).default(1)`。
 */
export const DensitySpecSchema = z.union([DensityUnitSchema, z.record(z.string(), DensityUnitSchema)]);
export type DensitySpec = z.infer<typeof DensitySpecSchema>;

/**
 * 钻间隙（mm，≥0；0=相切）。真源：engine types.ts GridSpecSchema
 * `gapMm: z.number().nonnegative()`。钻心最小间距 pitchMm = 钻径 + gapMm（派生，
 * 非独立参数——契约层不暴露 minSpacing 类自造字段）。
 */
export const GapMmSchema = z.number().nonnegative();

/** 伪随机种子。真源：engine LayoutOptionsSchema `seed: z.number().int().nonnegative().default(1)`。 */
export const SeedSchema = z.number().int().nonnegative();

/** 松弛开关。真源：engine LayoutOptionsSchema relax{boundary,repulsion}（默认双 false）。 */
export const RelaxSchema = z
  .object({
    boundary: z.boolean().default(false),
    repulsion: z.boolean().default(false),
  })
  .strict();
export type Relax = z.infer<typeof RelaxSchema>;

/** 区域选择器（首版 single variant：blocks ID）。空 region 显式拒绝（ids min(1)）。 */
export const RegionSchema = z
  .object({
    kind: z.literal('blocks'),
    ids: z.array(BlockIdSchema).min(1),
  })
  .strict();
export type Region = z.infer<typeof RegionSchema>;

/** 排布参数一等输入（capability pave-preview/layout 工具入参；默认值对齐引擎）。 */
export const PaveParamsSchema = z
  .object({
    strategy: StrategyIdSchema,
    density: DensitySpecSchema.default(1),
    gapMm: GapMmSchema,
    seed: SeedSchema.default(1),
    relax: RelaxSchema.default({ boundary: false, repulsion: false }),
    region: RegionSchema.optional(),
  })
  .strict();
export type PaveParams = z.infer<typeof PaveParamsSchema>;

// ---------------------------------------------------------------- proposal diff

/** 单 op 修改前后的钻规格（shapeId/diameterMm 唯一物理依据；rotationDeg/assetId 可选）。 */
export const SpecRefSchema = z
  .object({
    shapeId: z.enum(['round', 'square', 'drop', 'heart', 'marquise', 'custom']),
    diameterMm: z.number().positive(),
    rotationDeg: z.number().optional(),
    /** shapeId='custom' 时的资产弱引用 */
    assetId: z.string().optional(),
  })
  .strict();
export type SpecRef = z.infer<typeof SpecRefSchema>;

/** patch op 三态（design §3.4 proposal diff 字段：{op, target, before, after}）。 */
export const PatchOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('setDensity'),
      target: BlockIdSchema,
      before: DensityUnitSchema,
      after: DensityUnitSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('recolor'),
      target: BlockIdSchema,
      /** 色板条目 id（引擎 colorId——mapColors 写入的色板条目） */
      before: z.string(),
      after: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal('setSpec'),
      target: BlockIdSchema,
      before: SpecRefSchema,
      after: SpecRefSchema,
    })
    .strict(),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

/** proposal diff（design §3.4：不动真值的区域级修改草案）。 */
export const ProposalDiffSchema = z
  .object({
    region: RegionSchema,
    ops: z.array(PatchOpSchema).min(1),
    preview: z
      .object({
        beforeBlob: BlobRefSchema,
        afterBlob: BlobRefSchema,
      })
      .strict(),
    /** 预估钻数变化（after-before；负=减少） */
    estGemsDelta: z.number().int(),
    /** 间距冲突确定性剔除计数（engine LayoutResult.dropped 语义如实呈现） */
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type ProposalDiff = z.infer<typeof ProposalDiffSchema>;
