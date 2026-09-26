/**
 * 任务详情·排钻工作台 RPC 契约（add-task-detail-layer-workbench tasks 1.1 /
 * design 核心契约冻结面——2026-09-26）。
 * 决策源：design.md「核心契约（实现波冻结面）」+ D-1 裁定（人类在工作台改贴钻
 * 策略=直接生效；Agent 对话场景保持提案→批准铁律——两场景各自独立入口）。
 * 正交意图：
 *   [1] task.detail 组装面（task+session+原图+tree+指派+gems+预览——六个数据源
 *       各自可空：管线未跑到该步时对应字段 null，前端按在场渲染）。
 *   [2] segmentOne 原子入出参（内核原子——Agent 工具面与人类 RPC 共用；RPC 面
 *       layer.split 只带 {taskId,nodeId,hint}，工件引用由服务端解析后直调原子）。
 *   [3] layer.strategy.set（D-1 直接生效：单节点指派替换进当前 plan→execute 真身
 *       重算→新 gems+全图预览）。
 *   [4] tree 操作（layer.rename 直接生效；tree.history/tree.revert=版本化历史首版，
 *       撤销重做首版=revert）。
 * mask 语义：tree.nodes 复用 ObjectNode（inline|blob 二态 Mask2DRef——不发明新格式）；
 * 指派复用 StrategyAssignment（stones=StonePick 真源——stoneIdx 仅是 RPC 入参锚，
 * 服务端回填后进 plan）。
 */
import { z } from 'zod';
import { BlobRefSchema, IdSchema, IsoDateTimeSchema, TaskStatusSchema } from './common.js';
import {
  CanvasCmSchema,
  KernelStrategyKindSchema,
  ObjectNodeSchema,
  StrategyAssignmentSchema,
} from './kernel.js';

// ---------------------------------------------------------------- 具名常量

/**
 * 工作台 stoneIdx 上界（与 strategy.design 候选上限同值——MAX_STONE_CANDIDATES 200
 * 是 daemon 侧 prompt 有界缺省；契约面同值冻结，两处语义同源不互相 import）。
 */
export const WORKBENCH_STONE_IDX_MAX = 200;

/** 工作台提示/命名长度上界（人读文本——SAM text 提示与图层名共用档）。 */
export const WORKBENCH_TEXT_MAX = 500;

/** tree 版本来源三值（tree_versions.cause 冻结面——v6 迁移 CHECK 同源）。 */
export const TREE_VERSION_CAUSE_SCHEMA = z.enum(['segment-one', 'rename', 'revert']);
export type TreeVersionCause = z.infer<typeof TREE_VERSION_CAUSE_SCHEMA>;

// ---------------------------------------------------------------- [1] task.detail

export const TaskDetailInputSchema = z
  .object({
    taskId: IdSchema.describe('任务 id（agent 会话任务——工作台上下文）'),
  })
  .strict();
export type TaskDetailInput = z.infer<typeof TaskDetailInputSchema>;

/** 任务摘要（title 派生：会话标题优先，agent 首条输入文本兜底——均无=null）。 */
export const TaskDetailTaskSchema = z
  .object({
    id: IdSchema,
    title: z.string().nullable(),
    status: TaskStatusSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type TaskDetailTask = z.infer<typeof TaskDetailTaskSchema>;

/** 会话摘要（job 任务无会话=null）。 */
export const TaskDetailSessionSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
  })
  .strict();
export type TaskDetailSession = z.infer<typeof TaskDetailSessionSchema>;

/**
 * 归一底图锚（S0+S1：blobRef+像素尺寸+画布声明——scene-analysis.json 工件读回；
 * 尚无识图工件=null）。
 */
export const TaskDetailBaseImageSchema = z
  .object({
    blobRef: BlobRefSchema,
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    canvasCm: CanvasCmSchema,
  })
  .strict();
export type TaskDetailBaseImage = z.infer<typeof TaskDetailBaseImageSchema>;

/** 图层树（object-tree.json 工件读回——nodes 含 mask inline|blob 二态；尚无=null）。 */
export const TaskDetailTreeSchema = z
  .object({
    blobRef: BlobRefSchema,
    nodes: z.array(ObjectNodeSchema).min(1),
  })
  .strict();
export type TaskDetailTree = z.infer<typeof TaskDetailTreeSchema>;

/** 排钻产物摘要（strategy-gems.json 工件读回；尚无=null）。 */
export const TaskDetailGemsSchema = z
  .object({
    blobRef: BlobRefSchema,
    count: z.number().int().nonnegative(),
    excludedRegions: z.number().int().nonnegative(),
  })
  .strict();
export type TaskDetailGems = z.infer<typeof TaskDetailGemsSchema>;

/** 叠加预览（strategy-gems-preview.png 优先，object-tree-preview.png 兜底；均无=null）。 */
export const TaskDetailPreviewSchema = z
  .object({
    blobRef: BlobRefSchema,
  })
  .strict();
export type TaskDetailPreview = z.infer<typeof TaskDetailPreviewSchema>;

export const TaskDetailResponseSchema = z
  .object({
    task: TaskDetailTaskSchema,
    session: TaskDetailSessionSchema.nullable(),
    baseImage: TaskDetailBaseImageSchema.nullable(),
    tree: TaskDetailTreeSchema.nullable(),
    /** 当前生效指派（最新 strategy-plan.json 的 assignments；尚无 plan=空数组）。 */
    assignments: z.array(StrategyAssignmentSchema),
    gems: TaskDetailGemsSchema.nullable(),
    preview: TaskDetailPreviewSchema.nullable(),
  })
  .strict();
export type TaskDetailResponse = z.infer<typeof TaskDetailResponseSchema>;

// ---------------------------------------------------------------- [2] segmentOne / layer.split

/**
 * segmentOne 原子入参（内核面）：指定节点+文本提示做单次细分。hint 透传 SAM text
 * 提示（中英文均可——mock 桥哈希派生/S3 真桥语义提示）；imageBlobRef/treeBlobRef
 * 由调用方解析（RPC 面=帧流最新工件；Agent 面=工具面自备）。
 */
export const SegmentOneInputSchema = z
  .object({
    taskId: IdSchema,
    imageBlobRef: BlobRefSchema.describe('归一底图（S0 产物——掩码交集/预览渲染的锚）'),
    treeBlobRef: BlobRefSchema.describe('当前 object-tree.json 工件（单步细分的树基态）'),
    nodeId: z.string().min(1).describe('目标节点 id（在该节点掩码内做一次细分）'),
    hint: z.string().min(1).max(WORKBENCH_TEXT_MAX).describe('文本提示（如「把帽子拆出来」/"hat"）'),
  })
  .strict();
export type SegmentOneInput = z.infer<typeof SegmentOneInputSchema>;

/** layer.split 人类直调面（RPC 入参——工件引用服务端解析；design 冻结三字段）。 */
export const LayerSplitInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1),
    hint: z.string().min(1).max(WORKBENCH_TEXT_MAX),
  })
  .strict();
export type LayerSplitInput = z.infer<typeof LayerSplitInputSchema>;

/** 工作台警告（人读留痕——兄弟互斥/score 缺失等；与循环层 SegmentLoopWarning 同源语义）。 */
export const WorkbenchWarningSchema = z
  .object({
    reason: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();
export type WorkbenchWarning = z.infer<typeof WorkbenchWarningSchema>;

export const SegmentOneOutputSchema = z
  .object({
    /** 新子节点（含 mask——持久化形态 inline|blob 二态；空数组=零检出/被兄弟吞没，见 warnings）。 */
    children: z.array(ObjectNodeSchema),
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    warnings: z.array(WorkbenchWarningSchema),
  })
  .strict();
export type SegmentOneOutput = z.infer<typeof SegmentOneOutputSchema>;

// ---------------------------------------------------------------- [3] layer.strategy.set

/**
 * 单节点策略直改（D-1 直接生效）：strategyKind+params 经 registry 逐项校验；
 * stoneIdx 锚定候选表（与 strategy.design 无过滤缺省面同源——服务端回填 StonePick
 * 真源）；densityPerCm2 缺省 Owner 基线 2.3。替换进当前 plan 后走 execute 真身
 * 重算（引擎校验门照走），产新 gems+全图预览。
 */
export const LayerStrategySetInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1),
    strategyKind: KernelStrategyKindSchema,
    params: z.record(z.string(), z.unknown()),
    stoneIdx: z
      .array(z.number().int().min(1).max(WORKBENCH_STONE_IDX_MAX))
      .max(64)
      .optional()
      .describe('候选钻 idx（1 基——候选表=stone_index 稳定序共享库投影；exclusion 可省略）'),
    densityPerCm2: z.number().positive().optional(),
  })
  .strict();
export type LayerStrategySetInput = z.infer<typeof LayerStrategySetInputSchema>;

export const LayerStrategySetOutputSchema = z
  .object({
    gems: z
      .object({
        blobRef: BlobRefSchema,
        count: z.number().int().nonnegative(),
      })
      .strict(),
    preview: z
      .object({
        blobRef: BlobRefSchema,
      })
      .strict(),
  })
  .strict();
export type LayerStrategySetOutput = z.infer<typeof LayerStrategySetOutputSchema>;

// ---------------------------------------------------------------- [4] tree 操作

export const LayerRenameInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1),
    objectName: z.string().min(1).max(64).describe('新图层名（中文语义名——ObjectNode.objectName）'),
  })
  .strict();
export type LayerRenameInput = z.infer<typeof LayerRenameInputSchema>;

export const LayerRenameOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    /** 本次落定的 tree 版本号（tree_versions 主键半——tree.revert 的寻址键）。 */
    version: z.number().int().positive(),
  })
  .strict();
export type LayerRenameOutput = z.infer<typeof LayerRenameOutputSchema>;

export const TreeHistoryInputSchema = z
  .object({
    taskId: IdSchema,
  })
  .strict();
export type TreeHistoryInput = z.infer<typeof TreeHistoryInputSchema>;

/** tree 版本行（工作台写操作的快照链——segment-one/rename/revert 三来源）。 */
export const TreeVersionSchema = z
  .object({
    version: z.number().int().positive(),
    cause: TREE_VERSION_CAUSE_SCHEMA,
    detail: z.string().nullable(),
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type TreeVersion = z.infer<typeof TreeVersionSchema>;

export const TreeHistoryOutputSchema = z
  .object({
    versions: z.array(TreeVersionSchema),
    /** 当前树工件（帧流最新 object-tree.json——工作台版本链外的 agent 写也推进它）。 */
    currentTreeBlobRef: BlobRefSchema.nullable(),
    /** 工作台版本链最新号（零操作=null——revert 寻址以 versions 为准）。 */
    currentVersion: z.number().int().positive().nullable(),
  })
  .strict();
export type TreeHistoryOutput = z.infer<typeof TreeHistoryOutputSchema>;

export const TreeRevertInputSchema = z
  .object({
    taskId: IdSchema,
    version: z.number().int().positive().describe('目标版本（tree.history 的 versions[].version）'),
  })
  .strict();
export type TreeRevertInput = z.infer<typeof TreeRevertInputSchema>;

export const TreeRevertOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    /** revert 自身落定的新版本号（撤销也入史——历史只增不删）。 */
    version: z.number().int().positive(),
  })
  .strict();
export type TreeRevertOutput = z.infer<typeof TreeRevertOutputSchema>;
