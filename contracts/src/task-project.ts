/**
 * 项目域契约（add-task-stones-manifest-export W0——arch-decisions.md A1/A3/B2 冻结）。
 * 原始需求 2026-09-29（Owner 两裁决：钻清单=复制/展开关系非引用+lint 警告；导出工具化）。
 * 项目锚裁定（A1/A5 偏差 6）：一个 session = 一个项目（projectId ≡ sessionId）；
 * 首波任务清单跨后续 task 延续（session-project 状态行=权威指针，task 工件帧=审计面）。
 * 正交意图：
 *   [1] StonesManifestSchema（A1）：stones-manifest.json 版本化 blob——集合展开/
 *       手工追加的**物化快照**（StonePick+stoneRevision+三 blobRef 冻结；集合后续
 *       漂移不影响项目字节）；revision 正整数=CAS 键（无行=0 仅为内存约定，不落盘）。
 *   [2] StoneLintSchema（A3）：stones-lint.json 工件——四分类条目+三源锚
 *       （manifestRevision/planRef/sourceTaskId/imageId）；读面发现锚漂移即重算。
 *   [3] TaskLayoutSchema（B2）：task-layout.<imageId>.json 渲染快照——SVG/PNG/BOM
 *       三件套的最小真值（gems 带物料身份 stoneRef/sku/supplier/colorHex）。
 *   [4] imageId 稳定分配规则（A5）：首条常规 followup 的附件按输入顺序分配
 *       image-1..image-N；后续轮次附件=讨论插图不进图集（裁定冻结，见
 *       TASK_IMAGE_ID 分配规则注）。
 */
import { z } from 'zod';
import { BlobRefSchema, IdSchema, IsoDateTimeSchema } from './common.js';
import { CanvasCmSchema, Mask2DRefSchema, NodeBBoxSchema } from './kernel.js';
import { StonePickSchema } from './stones.js';

// ---------------------------------------------------------------- imageId 稳定分配（A5）

/** 任务主图集 imageId 线格式：`image-<N>`（N≥1 十进制、无前导零——确定性分配键）。 */
export const TASK_IMAGE_ID_PATTERN = /^image-[1-9][0-9]*$/;
export const TaskImageIdSchema = z.string().regex(TASK_IMAGE_ID_PATTERN);
export type TaskImageId = z.infer<typeof TaskImageIdSchema>;

/**
 * 首波 imageId 分配规则（Owner 语义经 A5 裁定冻结，2026-09-29）：
 *   - **仅首条常规 followup** 的附件按输入顺序分配 imageId（image-1 起 1 基单调），
 *     构成任务的**主图集**——各图的 scene/tree/plan/gems/layout 工件必须带 imageId，
 *     避免 latest-by-name 覆盖前一张图（B2 多图接线前提）。
 *   - **后续轮次**的附件=讨论插图，不进图集：不分配 imageId、不产 per-image 工件。
 *   - steer 通道不带附件（既有裁定），自然不产生 imageId。
 * 分配实现在 daemon 首条创建流（W1）；本常量+assignTaskImageIds 为冻结的确定性单源。
 */
export function assignTaskImageIds(attachmentCount: number): TaskImageId[] {
  if (!Number.isInteger(attachmentCount) || attachmentCount < 0) {
    throw new RangeError(`attachmentCount 必须为非负整数：${attachmentCount}`);
  }
  return Array.from({ length: attachmentCount }, (_, i) => `image-${i + 1}`);
}

// ---------------------------------------------------------------- A1 stones-manifest

/** manifest 溯源：展开时刻的集合锚（**只做溯源，不作为运行时引用**——A1）。 */
export const StonesManifestSourceSetSchema = z
  .object({
    /** resources 行 id（集合目录行——owner/revision CAS 锚）。 */
    resourceId: z.string().min(1),
    /** set.json 的 id（'set-' + uuid）。 */
    setId: z.string().min(1),
    /** 展开时刻的集合 revision（此后集合增删改不影响项目——复制语义）。 */
    setRevision: z.number().int().positive(),
    /** 展开时刻的集合名（展示/审计投影）。 */
    name: z.string().min(1),
  })
  .strict();
export type StonesManifestSourceSet = z.infer<typeof StonesManifestSourceSetSchema>;

/** 条目来源：set=首条集合展开；manual-add=MCP studio.task.stones.add 手工追加（A4）。 */
export const StonesManifestEntryOriginSchema = z.enum(['set', 'manual-add']);
export type StonesManifestEntryOrigin = z.infer<typeof StonesManifestEntryOriginSchema>;

/** manifest 条目：全局身份键 stoneRef + 展开时刻的原子物化快照（A1/A2）。 */
export const StonesManifestEntrySchema = z
  .object({
    /** 全局身份键（= pick.resourceId——superRefine 锁一致；库内现存 stone 的 resourceId）。 */
    stoneRef: z.string().min(1),
    /** StonePick 物化快照（展开/追加时服务端回填——SKU/供应商/尺寸/颜色，A2）。 */
    pick: StonePickSchema,
    /** 展开时刻 stone.json 的 resources.revision（原子来源版本审计）。 */
    stoneRevision: z.number().int().positive(),
    /** stone.json blob 引用（内容寻址——项目引用账本持有，防标准库删除后悬空）。 */
    stoneJsonBlobRef: BlobRefSchema,
    /** 贴图 blob 引用（同上——渲染资源冻结）。 */
    textureBlobRef: BlobRefSchema,
    /** custom 形资产 blob 引用（无 custom 形=null；有则冻结，渲染资源同账本）。 */
    shapeAssetBlobRef: BlobRefSchema.nullable(),
    /** 备料参考数量（正整数；**非库存锁定、非策略可用性约束**——A2 偏差 3）。 */
    quantity: z.number().int().nonnegative(),
    /** 条目备注（沿集合成员 note 语义，可缺省）。 */
    note: z.string().optional(),
    origin: StonesManifestEntryOriginSchema,
  })
  .strict();
export type StonesManifestEntry = z.infer<typeof StonesManifestEntrySchema>;

/**
 * stones-manifest.json（A1 契约冻结）：版本化 blob 内容；权威指针与 CAS revision 在
 * daemon session_projects 状态行（按 sessionId 唯一）。跳过集合=sourceSet null +
 * entries []（revision 仍为 1 起）。revision 由 manifest service 单源管理（写者不可
 * 伪造——schema 层冻结正整数；CAS 语义=服务端 UPDATE ... WHERE revision=?）。
 */
export const StonesManifestSchema = z
  .object({
    kind: z.literal('stones-manifest'),
    formatVersion: z.literal(1),
    /** 项目锚 ≡ sessionId（A5 偏差 6——一个 session 一个项目的首波解释）。 */
    projectId: IdSchema,
    /** 最后写入该 manifest 的 task（行动者审计/补帧定位）。 */
    updatedByTaskId: IdSchema,
    /** CAS revision（正整数；无状态行=内存约定 0，落盘恒 ≥1）。 */
    revision: z.number().int().positive(),
    updatedAt: IsoDateTimeSchema,
    /** 溯源集合（null=跳过集合/纯手工追加）。 */
    sourceSet: StonesManifestSourceSetSchema.nullable(),
    entries: z.array(StonesManifestEntrySchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const [i, entry] of manifest.entries.entries()) {
      if (entry.stoneRef !== entry.pick.resourceId) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'stoneRef'],
          message: `stoneRef 与 pick.resourceId 不一致：${entry.stoneRef} ≠ ${entry.pick.resourceId}`,
        });
      }
      if (seen.has(entry.stoneRef)) {
        ctx.addIssue({ code: 'custom', path: ['entries', i, 'stoneRef'], message: `stoneRef 重复条目：${entry.stoneRef}` });
      }
      seen.add(entry.stoneRef);
      if (entry.origin === 'set' && manifest.sourceSet === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i, 'origin'],
          message: 'origin=set 的条目要求 sourceSet 非空（集合展开必有溯源锚）',
        });
      }
    }
  });
export type StonesManifest = z.infer<typeof StonesManifestSchema>;

// ---------------------------------------------------------------- A3 stones-lint

/** lint 四分类（A3）：unintroduced=warning；unresolvable=hard error；introduced=通过；unused=信息。 */
export const StoneLintCategorySchema = z.enum(['unintroduced', 'unresolvable', 'introduced', 'unused']);
export type StoneLintCategory = z.infer<typeof StoneLintCategorySchema>;

/** lint 条目：stoneRef+明细（库内可解析时给 sku/supplier；unresolvable 可缺）。 */
export const StoneLintItemSchema = z
  .object({
    category: StoneLintCategorySchema,
    stoneRef: z.string().min(1),
    sku: z.string().min(1).optional(),
    supplier: z.string().min(1).optional(),
    /** 命中该 stoneRef 的计划节点（unintroduced 的定位面；其余分类可空）。 */
    nodeIds: z.array(z.string().min(1)),
  })
  .strict();
export type StoneLintItem = z.infer<typeof StoneLintItemSchema>;

/**
 * stones-lint.json 工件（A3）：lintTaskStoneRefs 单源函数的持久化形态。锚=
 * manifestRevision/planRef/sourceTaskId/imageId——读面发现任一来源漂移即重算，
 * 不得展示旧结果（A3 风险节）。计算与三处接线归 W3；本波冻结形状。
 */
export const StoneLintSchema = z
  .object({
    kind: z.literal('stones-lint'),
    formatVersion: z.literal(1),
    /** 计算时的 session-project manifest revision（锚 1/3）。 */
    manifestRevision: z.number().int().positive(),
    /** 计算时的 strategy-plan.json blob（锚 2/3——assignments.stones.resourceId 真源）。 */
    planRef: BlobRefSchema,
    /** 被配置/导出的排钻真值 task（锚——与 plan 同 task 域）。 */
    sourceTaskId: IdSchema,
    /** 主图集 imageId（多图任务按图独立 lint）。 */
    imageId: TaskImageIdSchema,
    items: z.array(StoneLintItemSchema),
    computedAt: IsoDateTimeSchema,
  })
  .strict();
export type StoneLint = z.infer<typeof StoneLintSchema>;

/** lint 摘要（task.detail.projectStones.lint 投影——W0 占位 null，W3 计算后填充）。 */
export const StoneLintSummarySchema = z
  .object({
    computedAt: IsoDateTimeSchema,
    manifestRevision: z.number().int().positive(),
    counts: z
      .object({
        unintroduced: z.number().int().nonnegative(),
        unresolvable: z.number().int().nonnegative(),
        introduced: z.number().int().nonnegative(),
        unused: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type StoneLintSummary = z.infer<typeof StoneLintSummarySchema>;

// ---------------------------------------------------------------- B2 task-layout

/**
 * 形枚举镜像：engine spec.ts SHAPE_IDS（contracts 不 import 引擎——镜像纪律同
 * paving.ts STRATEGY_IDS，task-project.test.ts 字面量断言锁死）。
 */
export const GEM_SHAPE_IDS = ['round', 'square', 'drop', 'heart', 'marquise', 'custom'] as const;
export const GemShapeIdSchema = z.enum(GEM_SHAPE_IDS);
export type GemShapeId = z.infer<typeof GemShapeIdSchema>;

/** 网格基规格（grid 派生锚——pitchMm = diameterMm + gapMm，engine GridSpec v2 同构）。 */
export const TaskLayoutBaseSpecSchema = z
  .object({
    shapeId: GemShapeIdSchema,
    diameterMm: z.number().positive(),
  })
  .strict();
export type TaskLayoutBaseSpec = z.infer<typeof TaskLayoutBaseSpecSchema>;

/**
 * 渲染网格（engine GridSpec 的持久化子集）：pixelsPerMm（px↔mm 唯一换算）+ gapMm
 * （pairwise 判据单源）+ baseSpec（pitch 派生依据）。rowAngleDeg 引擎冻结为 0，不落盘。
 */
export const TaskLayoutGridSchema = z
  .object({
    pixelsPerMm: z.number().positive(),
    gapMm: z.number().nonnegative(),
    baseSpec: TaskLayoutBaseSpecSchema,
  })
  .strict();
export type TaskLayoutGrid = z.infer<typeof TaskLayoutGridSchema>;

/** 色板条目（B2：colorId → 名称+hex；hex 大写 #RRGGBB——与 StonePick.colorHex 同口径）。 */
export const TaskLayoutPaletteColorSchema = z
  .object({
    name: z.string().min(1),
    hex: z.string().regex(/^#[0-9A-F]{6}$/),
  })
  .strict();
export type TaskLayoutPaletteColor = z.infer<typeof TaskLayoutPaletteColorSchema>;

/** 渲染块（导出门/边界需要时携带 mask；id=节点/块寻址键——gems.blockId 引用目标）。 */
export const TaskLayoutBlockSchema = z
  .object({
    id: z.string().min(1),
    bbox: NodeBBoxSchema,
    mask: Mask2DRefSchema.optional(),
  })
  .strict();
export type TaskLayoutBlock = z.infer<typeof TaskLayoutBlockSchema>;

/**
 * 渲染钻位（B2 最小真值）：几何身份（id/x/y/blockId/shapeId/diameterMm/rotationDeg/
 * assetId）+**物料身份**（stoneRef/sku/supplier/colorHex——排钻当时确定，不从颜色或
 * 候选顺序猜）。custom 形必带 assetId 且 shapeAssets 有对应 blob（superRefine 锁）。
 */
export const TaskLayoutGemSchema = z
  .object({
    id: z.string().min(1),
    x: z.number(),
    y: z.number(),
    blockId: z.string().min(1),
    shapeId: GemShapeIdSchema,
    diameterMm: z.number().positive(),
    rotationDeg: z.number().optional(),
    assetId: z.string().min(1).optional(),
    stoneRef: z.string().min(1),
    sku: z.string().min(1),
    supplier: z.string().min(1),
    colorHex: z.string().regex(/^#[0-9A-F]{6}$/),
  })
  .strict();
export type TaskLayoutGem = z.infer<typeof TaskLayoutGemSchema>;

/**
 * task-layout.<imageId>.json（B2 契约冻结）：策略执行同真值链生成的渲染快照，以
 * planRef/treeRef/manifestRevision 绑定（三件套 SVG+PNG+BOM 的唯一输入——防多工具
 * 调用的版本漂移）。隐藏层不参与生产导出（B2 裁定：与前端精修文档导出同口径——
 * 生成器在写本工件前完成可见层投影，本 schema 只收最终集）。
 */
export const TaskLayoutSchema = z
  .object({
    kind: z.literal('task-layout'),
    formatVersion: z.literal(1),
    source: z
      .object({
        /** 项目锚（≡ sessionId）。 */
        projectId: IdSchema,
        /** 排钻真值所属 task（必须与 plan/tree 同 task 域）。 */
        sourceTaskId: IdSchema,
        imageId: TaskImageIdSchema,
        planRef: BlobRefSchema,
        treeRef: BlobRefSchema,
        manifestRevision: z.number().int().positive(),
      })
      .strict(),
    imageWidth: z.number().int().positive(),
    imageHeight: z.number().int().positive(),
    canvasCm: CanvasCmSchema,
    grid: TaskLayoutGridSchema,
    palette: z.record(z.string().min(1), TaskLayoutPaletteColorSchema),
    blocks: z.array(TaskLayoutBlockSchema),
    gems: z.array(TaskLayoutGemSchema),
    /** custom 形资产（assetId → blobRef——渲染解析器的寻址面）。 */
    shapeAssets: z.record(z.string().min(1), BlobRefSchema),
  })
  .strict()
  .superRefine((layout, ctx) => {
    const blockIds = new Set<string>();
    for (const [i, block] of layout.blocks.entries()) {
      if (blockIds.has(block.id)) {
        ctx.addIssue({ code: 'custom', path: ['blocks', i, 'id'], message: `block id 重复：${block.id}` });
      }
      blockIds.add(block.id);
    }
    const gemIds = new Set<string>();
    for (const [i, gem] of layout.gems.entries()) {
      if (gemIds.has(gem.id)) {
        ctx.addIssue({ code: 'custom', path: ['gems', i, 'id'], message: `gem id 重复：${gem.id}` });
      }
      gemIds.add(gem.id);
      if (!blockIds.has(gem.blockId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['gems', i, 'blockId'],
          message: `gem.blockId 不在 blocks 中：${gem.blockId}`,
        });
      }
      if (gem.shapeId === 'custom' && gem.assetId === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['gems', i, 'shapeId'],
          message: `custom 形 gem 必须携带 assetId（engine customAssetIdMissing 同构）：${gem.id}`,
        });
      }
      if (gem.assetId !== undefined && !(gem.assetId in layout.shapeAssets)) {
        ctx.addIssue({
          code: 'custom',
          path: ['shapeAssets'],
          message: `gem ${gem.id} 的 assetId=${gem.assetId} 缺 shapeAssets blob 引用`,
        });
      }
    }
  });
export type TaskLayout = z.infer<typeof TaskLayoutSchema>;

/** task-layout 工件文件名（daemon 生成器/读面共用——B2：按 imageId 命名防多图覆盖）。 */
export function taskLayoutArtifactName(imageId: TaskImageId): string {
  return `task-layout.${imageId}.json`;
}
