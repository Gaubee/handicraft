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
 *   [5] workbench-pro 波 2a 契约冻结（2026-09-26，Codex 二轮 CONDITIONAL-GO 放行条件）：
 *       layer.reorder / layer.delete / layer.mask.patch 三写 RPC（CAS+版本返回+typed
 *       错误码冻结）+ mask 编辑状态机 + exportGate 导出门 + task.export 导出接线
 *       （P0-1——门阻 typed 拒 export-blocked）+ view-state 服务端所有权
 *       （锁定语义+节点归属校验 P0-2）+ undo 四域（design 附录 D-3）。
 * mask 语义：tree.nodes 复用 ObjectNode（inline|blob 二态 Mask2DRef——不发明新格式）；
 * 指派复用 StrategyAssignment（stones=StonePick 真源——stoneIdx 仅是 RPC 入参锚，
 * 服务端回填后进 plan）。
 */
import { z } from 'zod';
import { BlobRefSchema, IdSchema, IsoDateTimeSchema, TaskStatusSchema } from './common.js';
import {
  CanvasCmSchema,
  KernelStrategyKindSchema,
  NodeBBoxSchema,
  NodeIdSchema,
  ObjectNodeSchema,
  StrategyAssignmentSchema,
} from './kernel.js';
import { StoneLintResultSchema, StoneLintSummarySchema } from './task-project.js';

// ---------------------------------------------------------------- 具名常量

/**
 * 工作台 stoneIdx 上界（与 strategy.design 候选上限同值——MAX_STONE_CANDIDATES 200
 * 是 daemon 侧 prompt 有界缺省；契约面同值冻结，两处语义同源不互相 import）。
 */
export const WORKBENCH_STONE_IDX_MAX = 200;

/** 工作台提示/命名长度上界（人读文本——SAM text 提示与图层名共用档）。 */
export const WORKBENCH_TEXT_MAX = 500;

/**
 * tree 版本来源九值（tree_versions.cause 冻结面——v9 迁移 CHECK 同源）。
 * 前三值=add-task-detail-layer-workbench v6 既有；中间三值=add-workbench-pro 波 2a
 * 扩展（reorder 重排/delete 删除/mask-patch 笔刷编辑——三者都改写树工件，必入史）；
 * journey=add-workbench-pro v3 扩展（Owner 走查整改：Agent 会话产树（识图/循环/
 * 重跑）不落工作台链——历史面板对 journey 任务恒空=「事务历史不工作」根因；tree.history
 * 读取时对「链未覆盖的电流树」播种 journey 基线版本，链连续可回退）。
 * tree-merge/tree-refine=realize-scene-understanding T2 扩展（Agent 经 MCP 树工具
 * 组装/迭代 treeView——Owner 2026-09-28 架构定调；每次树写=版本链入史）。
 * undo 域归属（design 附录 D-3）：segment-one/rename/reorder/delete/revert/journey/
 * tree-merge/tree-refine=tree-structure 域；mask-patch=mask-edit 域；view-state 写
 * **不入本链**（独立 revision 链=tree-view 域）。
 */
export const TREE_VERSION_CAUSE_SCHEMA = z.enum([
  'segment-one',
  'rename',
  'reorder',
  'delete',
  'mask-patch',
  'revert',
  'journey',
  'tree-merge',
  'tree-refine',
]);
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

/**
 * 钻候选行（add-workbench-pro v3 Owner 整改：工作台钻选择器数据面——
 * daemon projectStoneCandidates 投影（共享库稳定序）与 strategy.design 候选表同源；
 * idx=layer.strategy.set stoneIdx 的引用键（1 基）。空数组=owner 无可用钻（UI 引导
 * 入库，不阻塞 task.detail）。
 */
export const StoneCandidateRowSchema = z
  .object({
    idx: z.number().int().positive().describe('候选 idx（1 基——layer.strategy.set stoneIdx 引用键）'),
    resourceId: z.string().min(1),
    sku: z.string(),
    supplier: z.string(),
    /** 尺寸 mm（未声明=null——无尺寸钻不可单独承载排钻指派）。 */
    sizeMm: z.number().nullable(),
    colorHex: z.string(),
    family: z.string(),
  })
  .strict();
export type StoneCandidateRow = z.infer<typeof StoneCandidateRowSchema>;

/**
 * 项目钻清单摘要（add-task-stones-manifest-export 0.4——arch-decisions A1「task.detail
 * 增加 manifest 摘要（revision/count/sourceSet）」）：session-project 状态行+manifest
 * blob 的读面投影。job 任务无会话/会话尚无项目行=null（前端按在场渲染）。
 * lint：W0 无计算——恒 null 占位（形状冻结 StoneLintSummary；W3 lint 单源接线后填充）。
 */
export const TaskDetailProjectStonesSchema = z
  .object({
    /** 当前 session-project manifest revision（CAS 锚——stones.add 前后对比）。 */
    revision: z.number().int().positive(),
    /** manifest 条目数（已引入/已讨论的钻数）。 */
    entryCount: z.number().int().nonnegative(),
    /** 溯源集合名（sourceSet?.name；跳过集合/纯手工追加=null）。 */
    sourceSetName: z.string().nullable(),
    /** lint 摘要（W0 恒 null——W3 stones-lint.json 工件接线后填充）。 */
    lint: StoneLintSummarySchema.nullable(),
  })
  .strict();
export type TaskDetailProjectStones = z.infer<typeof TaskDetailProjectStonesSchema>;

/**
 * 预览三模式（add-workbench-pro v3 Owner 整改：画布点阵渲染变体——服务端化入
 * view-state 工件刷新保持）。rendered=钻渲染到孔（缺省——当前效果增强）；holes=
 * 只有孔洞（底图淡化+冲孔视觉）；numbered=孔洞+按图层分色分组编号。
 */
export const WORKBENCH_PREVIEW_MODE_SCHEMA = z.enum(['rendered', 'holes', 'numbered']);
export type WorkbenchPreviewMode = z.infer<typeof WORKBENCH_PREVIEW_MODE_SCHEMA>;

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
    /** 图层视图态（显隐/折叠/锁定——服务端 task 级工件；尚无=null。workbench-pro 波 2a）。 */
    viewState: z.lazy(() => ViewStateSchema).nullable(),
    /** mask 编辑状态面（存在编辑留痕的节点——含 incomplete/stale 告警态；无=空数组）。 */
    maskEdits: z.array(z.lazy(() => MaskEditStatusSchema)),
    /** 导出门（mask incomplete/stale/重算失败必阻——allowed=false 时导出 RPC 必拒）。 */
    exportGate: z.lazy(() => ExportGateSchema),
    /** 钻候选表（owner 共享库稳定序投影——v3 钻选择器数据面；无可用钻=空数组）。 */
    stoneCandidates: z.array(z.lazy(() => StoneCandidateRowSchema)),
    /** 项目钻清单摘要（session-project manifest——W0 0.4；无会话/无项目行=null）。 */
    projectStones: z.lazy(() => TaskDetailProjectStonesSchema).nullable(),
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
    /**
     * 项目钻 lint（add-task-stones-manifest-export W3 3.1——A3：layer.strategy.set
     * 成功结果内嵌；无 session-project manifest（无项目语义）=null。unintroduced=
     * warning 不把直改变 error；unresolvable=hard（分类呈现——政策裁决归导出面）。
     * optional 妥协声明：rhinestone-studio mock 构造面本波零碰（change 红线），
     * 旧构造（无 lint 键）保持合法；daemon 真身恒携带（null=无项目）。
     */
    lint: z.lazy(() => StoneLintResultSchema).nullable().optional(),
  })
  .strict();
export type LayerStrategySetOutput = z.infer<typeof LayerStrategySetOutputSchema>;

// ---------------------------------------------------------------- [4] tree 操作

export const LayerRenameInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1),
    objectName: z.string().min(1).max(64).describe('新图层名（中文语义名——ObjectNode.objectName）'),
    /** 值得贴标注（可选写透——Agent rename 工具/人类面共用；缺省=不改）。 */
    drillWorthy: z.boolean().optional(),
    /**
     * 显式重分类（v6 复核 P1-1：B2 三态语义的升级动作——refinement 临时节点经
     * VLM 重入确认后升 semantic；semantic 误标可降回 refinement。根/画布与组节点
     * typed 拒（内核守卫）；缺省=不改 relation（纯改名面）。
     */
    relation: z.enum(['semantic', 'refinement']).optional(),
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

// ================================================================ workbench-pro 波 2a 契约冻结
//
// 决策源：design.md v2 §1 + Codex 二轮评审 CONDITIONAL-GO 放行条件（2026-09-26）+
// 附录 D-2 盲点裁定（羽化 P1 延期/blob mask 全链归 2b/4096 incomplete 禁导出/根与
// 画布节点不可删/父层显隐传递 P1/多选批量降 P1）。本段=契约行为冻结（实现体波 2b+）：
// CAS/幂等/错误码/状态机语义以下述 schema+jsdoc 为唯一真源，daemon 端点与测试固化。
//
// 通用写语义（三写 RPC 共面——layer.reorder / layer.delete / layer.mask.patch）：
//   [CAS]    expectedTreeBlobRef 必填：调用方以其**本地当前树工件引用**为编辑基线；
//            服务端与帧流最新 object-tree.json 比对，漂移必拒（'cas-mismatch'——与
//            segment-one anchor-mismatch「锚点漂移必拒」语义同源：不猜测、不合并）。
//            错误面携带 currentTreeBlobRef（daemon TaskWorkbenchError 字段/RPC data）。
//   [幂等]   无独立幂等键：三 RPC 均为「基线+意图」的确定性函数（同基线同输入同产物，
//            内容寻址工件）。首次成功后电流树已推进，同 expectedTreeBlobRef 重试必被
//            CAS 拒——**不产生重复副作用**；客户端以错误面 currentTreeBlobRef 比对
//            自己上次响应的 treeBlobRef 即可区分「已生效」（放弃重试）与「他写」
//            （刷新后重放意图）。
//   [权限]   与既有六端点同门：requireActiveUser 登录态+task owner 归属（admin 豁免），
//            操作者 actorId 入 tree_versions 版本史。
//   [版本]   响应必含新 treeBlobRef+previewBlobRef+version（tree_versions 主键半）；
//            审计版本入史（cause=reorder/delete/mask-patch——六值枚举）。
//   [fence]  cancelled/cleared 任务拒写（既有 ArtifactFenceError → typed 'fence'）。

/** 笔刷半径上界（px——防弹半径全图擦写；典型笔刷 4-32px）。 */
export const WORKBENCH_BRUSH_RADIUS_MAX_PX = 128;

/** 单笔刷笔迹采样点上界（一次拖拽的插值点序列）。 */
export const WORKBENCH_BRUSH_POINTS_MAX = 512;

/** 单次 mask.patch 笔迹条数上界（一笔=一个 add/remove 操作）。 */
export const WORKBENCH_MASK_OPS_MAX = 16;

/**
 * 笔迹坐标绝对上界（px——Codex 2bfix/2c 合并复评建议二）：契约层 typed 拒
 * Number.MAX_VALUE 级坐标（finite/nonnegative 之外的数值上界），使极值坐标不进入
 * daemon/mock 的插值循环。真实图像像素坐标必远小于此界；界内/界外的业务语义
 * （0..imagePx）由 daemon/mock 侧 brushWorkloadError 判定。
 */
export const WORKBENCH_BRUSH_COORD_MAX_PX = 65536;

/**
 * 相邻采样点段长上界（px——插值资源上限）：超过此段的折线段必拒（无意义长段
 * 不得进步长扫掠循环）。
 */
export const WORKBENCH_BRUSH_SEGMENT_MAX_PX = 65536;

/** 单笔笔迹插值步数上界（Σ段长/步长——CPU 有界；步长≥max(radius/2, 0.5)）。 */
export const WORKBENCH_BRUSH_STROKE_STEPS_MAX = 16384;

/**
 * 单次 patch 涂写工作量预算（px——每次 stamp 在 mask 界内覆盖的像素数累计上界；
 * 大半径×长笔画的有界工作量面。典型 16px 半径 2000px 路径 ≈ 20 万 px——预算留
 * 20 倍余量）。
 */
export const WORKBENCH_BRUSH_PAINT_BUDGET_PX = 4_194_304;

/**
 * 笔迹工作量校验（纯函数——daemon/mock 三侧同源，Codex 复评建议二）：
 *   [1] 坐标 0..imagePx 界内（画布像素坐标系——界外无效，typed 拒不静默裁剪）；
 *   [2] 相邻采样点段长 ≤ WORKBENCH_BRUSH_SEGMENT_MAX_PX；
 *   [3] 单笔插值步数（Σ ceil(段长/max(半径/2, 0.5))）≤ WORKBENCH_BRUSH_STEPS_MAX。
 * 返回 null=合法；非 null=拒因（调用方以 mask-invalid typed 拒）。
 * 涂写工作量预算（[4] WORKBENCH_BRUSH_PAINT_BUDGET_PX）依赖光栅循环的界内裁剪
 * 面积，由 daemon/mock 在扫掠循环内累计判定（同上限常量）。
 */
export function brushWorkloadError(
  ops: Array<{ radiusPx: number; points: Array<{ x: number; y: number }> }>,
  imagePx: { width: number; height: number },
): string | null {
  for (const stroke of ops) {
    const stepLen = Math.max(stroke.radiusPx / 2, 0.5);
    let steps = 0;
    let prev: { x: number; y: number } | null = null;
    for (const point of stroke.points) {
      if (point.x < 0 || point.y < 0 || point.x > imagePx.width || point.y > imagePx.height) {
        return `笔迹坐标 (${point.x}, ${point.y}) 超出画布 ${imagePx.width}×${imagePx.height}px 界（画布像素坐标系——bbox 外无效，不跨界改兄弟层）`;
      }
      if (prev !== null) {
        const dist = Math.hypot(point.x - prev.x, point.y - prev.y);
        if (dist > WORKBENCH_BRUSH_SEGMENT_MAX_PX) {
          return `笔迹相邻采样点段长 ${dist.toFixed(0)}px 超上限 ${WORKBENCH_BRUSH_SEGMENT_MAX_PX}px（无意义长段——分段提交）`;
        }
        steps += Math.max(1, Math.ceil(dist / stepLen));
      }
      prev = point;
    }
    if (steps > WORKBENCH_BRUSH_STROKE_STEPS_MAX) {
      return `单笔插值步数 ${steps} 超上限 ${WORKBENCH_BRUSH_STROKE_STEPS_MAX}（半径 ${stroke.radiusPx}px 的扫掠步数有界——缩小笔画或增大半径）`;
    }
  }
  return null;
}

/**
 * mask 行程编码（RLE run）上限：编辑后 mask 的行主序扁平字节串中「极大同值段」数
 * 超过此值=incomplete（4096——design §1 既有裁定）。incomplete 的 mask **如实持久化**
 * （所见即所得——不静默截断），但导出门必阻（'mask-incomplete'）+ UI 显式告警，
 * 直到编辑收敛回限内。盲点裁定 D-2：4096 incomplete=禁止导出。
 */
export const WORKBENCH_MASK_RUN_LIMIT = 4096;

/** 视图态工件帧名（latest-by-name 即「当前视图态」——与 object-tree.json 同约定）。 */
export const WORKBENCH_VIEW_STATE_ARTIFACT_NAME = 'workbench-view-state.json';

/**
 * workbench-pro 三写 RPC 的 typed 错误码冻结面（daemon TaskWorkbenchError kind 增量
 * 并集——RPC data.code 可编程判别；既有码 invalid-input/task-missing/tree-missing/
 * tree-invalid/node-not-found/fence 等沿用不重复列）。
 */
export const WORKBENCH_WRITE_ERROR_CODE_SCHEMA = z.enum([
  /** expectedTreeBlobRef ≠ 电流树工件（携带 currentTreeBlobRef——幂等重试判别锚）。 */
  'cas-mismatch',
  /** 目标节点（delete：或其子树内任一节点）被视图态锁定——锁定=结构+遮罩面冻结。 */
  'node-locked',
  /** 根/画布节点不可删/不可重排（layer.delete typed 拒——D-2 盲点裁定）。 */
  'root-protected',
  /** layer.reorder 环路：newParentId ∈ nodeId 自身或其子树（树成环必拒）。 */
  'cycle',
  /** newParentId 不在当前树。 */
  'parent-invalid',
  /** mask.patch 语义拒：笔刷后 mask 全空（节点必须保有非空掩码）/坐标越全图界。 */
  'mask-invalid',
  /** view.state.set 语义拒：nodes 含重复 nodeId/非法覆盖组合。 */
  'view-state-invalid',
  /**
   * layer.strategy.set 语义拒（v5 Owner 裁定 2026-09-28）：目标节点有 children
   * （组/中间节点恒不产钻——图层=PS 图层、钻=图层特效，拆分后只有子图层可套钻）。
   */
  'node-not-leaf',
  /** 导出被门阻（blockers 非空——exportGate.allowed=false 时的导出 RPC typed 拒）。 */
  'export-blocked',
]);
export type WorkbenchWriteErrorCode = z.infer<typeof WORKBENCH_WRITE_ERROR_CODE_SCHEMA>;

// ---------------------------------------------------------------- mask 编辑状态机

/**
 * mask 编辑状态机（冻结——契约枚举+语义，P0 daemon 为同步闭环：accepted/recomputing
 * 两态为异步路径保留位，同步链一次调用直达终态）：
 *   accepted    —— 笔迹校验通过+CAS 过门+树版本已入史（mask 重写落盘），重算未开始。
 *   recomputing —— effectiveMm/tightBBox/gems 重算进行中（异步路径；同步链不驻留）。
 *   ready       —— 重算完成：mask/节点摘要/（若指派）gems 三面一致，可导出。
 *   stale       —— 编辑基线已漂移：重算未完成期间树被其他操作推进（版本链非
 *                  mask-patch cause 落新版本）——编辑结果对新树不再保证一致；导出
 *                  必阻，直到重放重算或确认放弃。
 *   error       —— 重算失败（引擎校验门/execute 链 typed 失败）：mask 已落盘但
 *                  gems 与 mask 可能不一致；导出必阻，可重试（重算幂等——同 plan
 *                  同树确定性重放）。
 */
export const MASK_EDIT_STATE_SCHEMA = z.enum(['accepted', 'recomputing', 'ready', 'stale', 'error']);
export type MaskEditState = z.infer<typeof MASK_EDIT_STATE_SCHEMA>;

/** 单节点 mask 编辑留痕（task 级持久行——task.detail.maskEdits 面的元素）。 */
export const MaskEditStatusSchema = z
  .object({
    nodeId: NodeIdSchema,
    state: MASK_EDIT_STATE_SCHEMA,
    /** 编辑后 mask 的 RLE 行程数（incomplete 判定的唯一输入）。 */
    runCount: z.number().int().nonnegative(),
    /** runCount > WORKBENCH_MASK_RUN_LIMIT——4096 截断告警态（禁导出）。 */
    incomplete: z.boolean(),
    /** 编辑落定的 tree 版本号（stale 判定锚——其后出现非 mask-patch 版本即漂移）。 */
    baseVersion: z.number().int().positive(),
    /** state=error 时的失败文本（人读；重试指引）；余=null。 */
    error: z.string().nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type MaskEditStatus = z.infer<typeof MaskEditStatusSchema>;

// ---------------------------------------------------------------- 导出门（exportGate）

/**
 * 导出阻断因子（冻结枚举）：mask incomplete（4096 截断——D-2 裁定禁止导出）/
 * mask stale（编辑基线漂移）/mask-recompute-error（重算失败——gems 与 mask 可能
 * 不一致，与 stale 同属「编辑结果不可信」类，单列以求可诊断）。
 */
export const EXPORT_BLOCKER_SCHEMA = z.enum(['mask-incomplete', 'mask-stale', 'mask-recompute-error']);
export type ExportBlocker = z.infer<typeof EXPORT_BLOCKER_SCHEMA>;

/**
 * 导出门（task.detail 组装面——服务端按 maskEdits 计算的纯函数）：blockers 非空 ⇒
 * allowed=false ⇒ 导出 RPC 必 typed 拒（'export-blocked'，data.blockers 原样携带）。
 * 门只增不减语义：后续波次新增阻断因子=枚举扩展（契约变更），不做客户端豁免口。
 */
export const ExportGateSchema = z
  .object({
    allowed: z.boolean(),
    /** 去重升序（确定性——同输入同输出）。 */
    blockers: z.array(EXPORT_BLOCKER_SCHEMA),
  })
  .strict();
export type ExportGate = z.infer<typeof ExportGateSchema>;

// ---------------------------------------------------------------- task.export（导出门接线）

/**
 * 任务导出 RPC（workbench-pro 波 2a P0-1——Codex 复核放行条件「门阻时导出 RPC typed
 * 拒」的真实接线）：服务端以 mask_edit_states 为真源**重算**导出门（不信任客户端
 * 缓存的 task.detail.exportGate），allowed=false 时 BAD_REQUEST
 * data.code='export-blocked'+data.blockers 完整清单（门只增不减——无客户端豁免口）。
 * 放行时导出内容=帧流最新 strategy-gems.json 工件字节**按当前 object-tree.json 叶子
 * 口径过滤**后的排钻设计文档（v5 修复轮 R1：父层（组）旧钻不进导出字节——
 * task.detail gems 面与前端渲染三面同源；blobRef 恒与返回字节内容寻址一致）。
 * **资源域边界（v5 修复轮 R2，Owner 裁定方案 1）**：task.export 是 v5 树语义（组恒
 * 不产钻）的**唯一任务导出入口**——它只读任务帧流的 strategy-gems/object-tree 工件。
 * capability 面的 BOM/SVG/PNG（studio.bom/studio.export）读**独立的 layout resource**
 * （W2 pave 真值域——LayoutDocument，经 publishLayoutDocument 显式发布，与任务工件
 * 流零交叠），不承载 workbench v4 存量工件、也不做树语义过滤；两域互不回退兜底
 * （layout resource 缺席时 capability 拒绝，绝不改读任务 strategy-gems 工件字节）。
 * 后续导出格式扩展=显式契约变更。
 * 输出形状沿既有导出代码形态（resources.export 的 filename/kind/dataBase64）
 * +blobRef/gemCount 摘要。
 */
export const TaskExportInputSchema = z
  .object({
    taskId: IdSchema,
  })
  .strict();
export type TaskExportInput = z.infer<typeof TaskExportInputSchema>;

export const TaskExportOutputSchema = z
  .object({
    filename: z.string().min(1).describe('下载文件名（含 taskId——确定性，不含用户输入）'),
    kind: z.literal('strategy-gems'),
    dataBase64: z.string().min(1).describe('strategy-gems.json 工件字节（base64）'),
    /** 导出的 gems 工件引用（帧流 latest-by-name——内容寻址）。 */
    blobRef: BlobRefSchema,
    /** gems 颗数（工件读回摘要——UI 呈现/断言锚）。 */
    gemCount: z.number().int().nonnegative(),
  })
  .strict();
export type TaskExportOutput = z.infer<typeof TaskExportOutputSchema>;

// ---------------------------------------------------------------- view-state（视图态所有权）

/** 单节点视图覆盖（未列出的节点=默认：可见/未折叠/未锁定）。 */
export const ViewStateNodeSchema = z
  .object({
    nodeId: NodeIdSchema,
    /** 显隐（false=隐藏层）。 */
    visible: z.boolean().optional(),
    /** 折叠（图层树子级收起）。 */
    collapsed: z.boolean().optional(),
    /** 锁定（true=结构+遮罩面冻结：reorder/mask.patch 必拒；delete 该节点或含它的子树必拒）。 */
    locked: z.boolean().optional(),
  })
  .strict();
export type ViewStateNode = z.infer<typeof ViewStateNodeSchema>;

/**
 * 图层视图态工件（task 级服务端持久化——task 级 JSON blob 工件
 * workbench-view-state.json；操作历史=revision 单调链+previousBlobRef 内容寻址回溯，
 * **不入 tree_versions**——undo tree-view 域沿本链，与 tree-structure 域解耦）。
 * 所有权：显隐/折叠/锁定是**task 工件**非浏览器本地态（重载/换端不丢——修复
 * store.svelte.ts hiddenNodes 本地态漂移）。
 */
export const ViewStateSchema = z
  .object({
    kind: z.literal('workbench-view-state'),
    formatVersion: z.literal(1),
    nodes: z.array(ViewStateNodeSchema),
    /** 单调递增（首写=1；view.state.set 每次成功+1——tree-view 域 undo 游标）。 */
    revision: z.number().int().nonnegative(),
    /** 前一版工件引用（内容寻址回溯链；首写=null）。 */
    previousBlobRef: BlobRefSchema.nullable(),
    /** 预览三模式（v3：画布渲染变体的服务端化持久面；缺省=rendered——旧工件无此键）。 */
    previewMode: WORKBENCH_PREVIEW_MODE_SCHEMA.optional(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((state, ctx) => {
    const seen = new Set<string>();
    for (const n of state.nodes) {
      if (seen.has(n.nodeId)) {
        ctx.addIssue({ code: 'custom', message: `视图态节点重复：${n.nodeId}` });
      }
      seen.add(n.nodeId);
    }
  });
export type ViewState = z.infer<typeof ViewStateSchema>;

export const ViewStateSetInputSchema = z
  .object({
    taskId: IdSchema,
    /** 全量快照语义（非增量）：以本表整体替换上一版——幂等性同三写 RPC（CAS 门）。 */
    nodes: z.array(ViewStateNodeSchema).max(512),
    /**
     * CAS 基线=当前视图态 revision：在场必须等于既有工件 revision，缺省仅当尚无
     * 工件（有既有且缺省=cas-mismatch——并发双开工作台不静默覆盖）。
     */
    expectedRevision: z.number().int().nonnegative().optional(),
    /** 预览模式写透（v3；缺省=保留服务端现值——纯节点面写不冲刷模式）。 */
    previewMode: WORKBENCH_PREVIEW_MODE_SCHEMA.optional(),
  })
  .strict();
export type ViewStateSetInput = z.infer<typeof ViewStateSetInputSchema>;

export const ViewStateSetOutputSchema = z
  .object({
    blobRef: BlobRefSchema,
    /** 新落定的 revision（=旧+1；tree-view 域 undo 寻址键）。 */
    revision: z.number().int().positive(),
  })
  .strict();
export type ViewStateSetOutput = z.infer<typeof ViewStateSetOutputSchema>;

// ---------------------------------------------------------------- [5] layer.reorder

export const LayerReorderInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1).describe('移动目标（非根——根/画布节点不可重排 root-protected）'),
    newParentId: z.string().min(1).describe('新父（须在树内 parent-invalid；属 nodeId 子树或自身=cycle 拒）'),
    /** 插入位（0 基——newParent.children 移出 nodeId 后的目标下标；越界=invalid-input）。 */
    index: z.number().int().nonnegative(),
    expectedTreeBlobRef: BlobRefSchema.describe('CAS 基线（调用方本地当前树工件——漂移必拒 cas-mismatch）'),
  })
  .strict();
export type LayerReorderInput = z.infer<typeof LayerReorderInputSchema>;

/**
 * 树重排（父变更+序位）。语义冻结：
 *   - 重排不增删节点 ⇒ 产块节点集不变 ⇒ assignments/gems **零触碰**（design §1
 *     「assignments 跟随产块节点集收敛」在 reorder 上是恒等收敛——无指派变化无重算）。
 *   - 同父重排合法（newParentId=旧 parent，仅序位变化）。
 *   - 锁定语义：目标节点 locked=node-locked 拒；移动**祖先**携带锁定后代=允许
 *     （整树搬运不改锁定节点自身结构/遮罩——与 delete「含锁定即拒」的差别：
 *     delete 破坏锁定节点本体，reorder 保子树完整）。
 */
export const LayerReorderOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    /** 本次落定的 tree 版本号（cause='reorder'）。 */
    version: z.number().int().positive(),
  })
  .strict();
export type LayerReorderOutput = z.infer<typeof LayerReorderOutputSchema>;

// ---------------------------------------------------------------- [6] layer.delete

export const LayerDeleteInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1).describe('删除目标（子树根；根/画布节点 root-protected 拒）'),
    expectedTreeBlobRef: BlobRefSchema,
  })
  .strict();
export type LayerDeleteInput = z.infer<typeof LayerDeleteInputSchema>;

/**
 * 删子树。语义冻结：
 *   - 子树节点全集出树（removedNodeIds 含目标自身，DFS 先序）；父 children 收口。
 *   - assignments 收敛：被删节点上的既有指派随树收敛移除（removedAssignmentNodeIds），
 *     存量 plan 存在时经 execute 真身重算产新 gems+预览（同 setStrategy 既有语义）；
 *     收敛后指派为空的边界（全删指派节点）不落新 plan 工件——gems=null 如实返回
 *     （StrategyPlan min(1) 边界，工件事表示 2b 裁决——D-2 附录）。
 *   - 锁定语义：目标或其子树内任一节点 locked=node-locked 拒（锁定=冻结其结构面）。
 */
export const LayerDeleteOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    /** 本次落定的 tree 版本号（cause='delete'）。 */
    version: z.number().int().positive(),
    /** 被删子树节点全集（含目标自身；DFS 先序）。 */
    removedNodeIds: z.array(z.string().min(1)).min(1),
    /** 随产块节点集收敛而移除的指派 nodeId 集（无 plan/未指派=空）。 */
    removedAssignmentNodeIds: z.array(z.string().min(1)),
    /** 重算后的 gems 摘要（无 plan 或空收敛=null——见上）。 */
    gems: z
      .object({
        blobRef: BlobRefSchema,
        count: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type LayerDeleteOutput = z.infer<typeof LayerDeleteOutputSchema>;

// ---------------------------------------------------------------- [7] layer.mask.patch

/** 笔迹采样点（画图像素坐标——imagePx 全图坐标系；bbox 外无效，不跨界改兄弟层。坐标绝对上界=WORKBENCH_BRUSH_COORD_MAX_PX）。 */
export const BrushPointSchema = z
  .object({
    x: z.number().finite().nonnegative().max(WORKBENCH_BRUSH_COORD_MAX_PX),
    y: z.number().finite().nonnegative().max(WORKBENCH_BRUSH_COORD_MAX_PX),
  })
  .strict();
export type BrushPoint = z.infer<typeof BrushPointSchema>;

/**
 * 一笔笔迹：op='add'（include——掩码位涂 1）/ 'remove'（exclude——掩码位清 0）；
 * 半径像素圆盘沿 points 折线扫掠。ops 按序应用（后笔覆盖前笔——remove 后可再 add）。
 * P0 二值 mask（0/1）；羽化（alpha/距离场）=P1 延期，接口位见 WORKBENCH 羽化注记。
 */
export const BrushStrokeSchema = z
  .object({
    op: z.enum(['add', 'remove']),
    radiusPx: z.number().finite().positive().max(WORKBENCH_BRUSH_RADIUS_MAX_PX),
    points: z.array(BrushPointSchema).min(1).max(WORKBENCH_BRUSH_POINTS_MAX),
  })
  .strict();
export type BrushStroke = z.infer<typeof BrushStrokeSchema>;

export const LayerMaskPatchInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1),
    ops: z.array(BrushStrokeSchema).min(1).max(WORKBENCH_MASK_OPS_MAX),
    expectedTreeBlobRef: BlobRefSchema,
    /**
     * 可选重算指派（缺省 false=只改 mask+节点摘要——effectiveMm/tightBBox 恒重算，
     * 不触 gems）：true=受影响产块节点的既有指派经 execute 真身重算（编辑后重算
     * 闭环的 gems 面；无 plan=仅 mask 面）。失败不回滚 mask（版本已入史）——
     * editState='error'+导出门阻断，可重试。
     */
    recomputeStrategy: z.boolean().default(false),
  })
  .strict();
export type LayerMaskPatchInput = z.infer<typeof LayerMaskPatchInputSchema>;

/**
 * 最小遮罩编辑闭环（同步 P0 链：accepted→(recomputing)→ready/error 一次调用达终态）：
 * 笔迹光栅化→mask 重写（inline|blob 二态随 tree-persist 阈值）→tightBBox/effectiveMm
 * 重算→版本入史（cause='mask-patch'）→（recomputeStrategy）gems 重算。
 * 空掩码（remove 涂空全节点）=mask-invalid 拒（节点必须保有非空掩码）。
 * 羽化 P1 接口位：届时 BrushStrokeSchema 增可选 featherPx（契约变更显式扩展，
 * 不在 P0 二值面偷开——D-2 裁定）。
 */
export const LayerMaskPatchOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    /** 本次落定的 tree 版本号（cause='mask-patch'）。 */
    version: z.number().int().positive(),
    /** 编辑后节点摘要（tightBBox 重锚+effectiveMm 重算——响应面即所见）。 */
    node: z
      .object({
        bbox: NodeBBoxSchema,
        effectiveMm: z.number().nonnegative(),
      })
      .strict(),
    /** 编辑后 mask 的 RLE 行程数。 */
    maskRunCount: z.number().int().nonnegative(),
    /** 行程超限告警（WORKBENCH_MASK_RUN_LIMIT——禁导出+UI 显式告警，mask 已如实落盘）。 */
    incomplete: z.boolean(),
    /** 编辑状态机终态（同步链='ready' 或 'error'；异步路径（2b+）见状态机 jsdoc）。 */
    editState: MASK_EDIT_STATE_SCHEMA,
    /** recomputeStrategy=true 时的重算产物（false/失败=null——失败详情见 task.detail.maskEdits.error）。 */
    gems: z
      .object({
        blobRef: BlobRefSchema,
        count: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type LayerMaskPatchOutput = z.infer<typeof LayerMaskPatchOutputSchema>;

// ---------------------------------------------------------------- [8] maskEdit.retry / maskEdit.discard（恢复链——终评 P0-1）

/**
 * stale/error 恢复链（2d 收尾轮——Codex 终评 P0-1 闭合）：mask 编辑状态机的
 * 「直到重放重算或确认放弃才解除」产品面。两入口均以**调用方现读的编辑留痕
 * baseVersion 为 CAS 基线**（task.detail.maskEdits[].baseVersion）——漂移必拒
 * cas-mismatch（同节点新 patch 已接管行时，旧留痕的重放/放弃不得错配新编辑）；
 * 服务端条件 UPDATE 落空（SELECT 后行被覆盖——竞态）时重读行现值直接返回，
 * **不执行重算副作用**（不基于过期基线树发布工件）。
 */
export const MaskEditRetryInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1).describe('目标节点（须有 stale/error 编辑留痕）'),
    /**
     * CAS 基线=调用方现读的留痕 baseVersion（task.detail.maskEdits 现值）：漂移必拒
     * cas-mismatch——行已被同节点新 patch 覆盖时，UI 刷新后以新留痕重入。
     */
    expectedBaseVersion: z.number().int().positive(),
  })
  .strict();
export type MaskEditRetryInput = z.infer<typeof MaskEditRetryInputSchema>;

/**
 * 重放重算输出：重放后的编辑留痕行（终态 ready/error；竞态中被新编辑接管时=新行
 * 现值——state 可能非终态，UI 以行现值呈现并刷新）。
 */
export const MaskEditRetryOutputSchema = z
  .object({
    edit: z.lazy(() => MaskEditStatusSchema),
  })
  .strict();
export type MaskEditRetryOutput = z.infer<typeof MaskEditRetryOutputSchema>;

export const MaskEditDiscardInputSchema = z
  .object({
    taskId: IdSchema,
    nodeId: z.string().min(1),
    /** CAS 基线（同 retry——漂移必拒 cas-mismatch，不误弃新编辑留痕）。 */
    expectedBaseVersion: z.number().int().positive(),
  })
  .strict();
export type MaskEditDiscardInput = z.infer<typeof MaskEditDiscardInputSchema>;

/**
 * 确认放弃输出：discarded=true 本次实际删行；false=行已不在（幂等成功——留痕已被
 * 删除/新 patch 接管后收敛）。放弃语义：mask 已落盘如实不回滚，仅清编辑留痕/
 * 门阻断面（用户显式接受当前 mask/gems 现状）。
 */
export const MaskEditDiscardOutputSchema = z
  .object({
    discarded: z.boolean(),
  })
  .strict();
export type MaskEditDiscardOutput = z.infer<typeof MaskEditDiscardOutputSchema>;

// ---------------------------------------------------------------- [9] Agent 树组装工具（realize-scene-understanding T2）

/**
 * studio.tree.* 五工具契约（Owner 2026-09-28 架构定调：MCP 提供 treeView，Agent
 * 灵活组装/迭代而非硬编码程序生成；design §2 工具面表）。语义冻结：
 *   - 复用 workbench 内核 CAS 写路径（expectedTreeBlobRef vs 帧流电流树——漂移必拒
 *     cas-mismatch 携 currentTreeBlobRef）；每次树写=版本链入史（tree_versions）。
 *   - inspect=读面（树+判据数据——停止判据四条的消费数据：effectiveMm≈钻径量级/
 *     labVariance 色容差低/SAM 自认不可拆/迭代硬顶）；merge/refine/reparent/rename=
 *     写面（子→父吸收/SAM 再拆分/子树移动/名+标注）。
 *   - 权威标注（authority）语义：inspect=readonly 直调；四写工具=proposal 标注的
 *     直效写（Owner Agent 循环定调：口头反馈即审批面——版本链即撤销面；区别于
 *     approved-mutation 的策略/资源变更授权桥）。
 */

/** inspect 节点行（树结构+判据数据+掩码引用——Agent 自评停止条件的观测面）。 */
export const TreeInspectNodeSchema = z
  .object({
    id: NodeIdSchema,
    objectName: z.string().min(1),
    category: z.string().min(1),
    parent: NodeIdSchema.nullable(),
    children: z.array(NodeIdSchema),
    /** 挂靠关系（旧树缺省=未标注——null）。 */
    relation: z.enum(['semantic', 'refinement']).nullable(),
    origin: z.string().min(1),
    /** 停止判据数据（design §0 四条的字段面）。 */
    effectiveMm: z.number().nonnegative(),
    labVariance: z.number().nonnegative(),
    drillWorthy: z.boolean(),
    bbox: NodeBBoxSchema,
    /** 掩码引用（inline=w×h 内联；blob=内容寻址引用）。 */
    mask: z.union([
      z.object({ kind: z.literal('inline'), w: z.number().int().positive(), h: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal('blob'), blobRef: BlobRefSchema }).strict(),
    ]),
  })
  .strict();
export type TreeInspectNode = z.infer<typeof TreeInspectNodeSchema>;

export const TreeInspectInputSchema = z
  .object({
    taskId: IdSchema,
    /** 树工件引用（缺省=帧流最新 object-tree.json——与 CAS 电流树同源）。 */
    treeBlobRef: BlobRefSchema.optional(),
  })
  .strict();
export type TreeInspectInput = z.infer<typeof TreeInspectInputSchema>;

export const TreeInspectOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    /** 工件数组序（DFS 先序=产物序）。 */
    nodes: z.array(TreeInspectNodeSchema),
    /** 版本链最新号（零操作=null——回退寻址面）。 */
    currentVersion: z.number().int().positive().nullable(),
    stopCriteriaHint: z.string().min(1),
  })
  .strict();
export type TreeInspectOutput = z.infer<typeof TreeInspectOutputSchema>;

export const TreeMergeInputSchema = z
  .object({
    taskId: IdSchema,
    /** CAS 基线（调用方现持树工件——漂移必拒 cas-mismatch）。 */
    expectedTreeBlobRef: BlobRefSchema,
    /** 吸收目标（存活节点；不得在任一 source 子树内）。 */
    targetNodeId: NodeIdSchema,
    /** 被吸收节点（同树非根节点；mask 并入 target、children 移交、自身出树）。 */
    sourceNodeIds: z.array(NodeIdSchema).min(1).max(32),
  })
  .strict();
export type TreeMergeInput = z.infer<typeof TreeMergeInputSchema>;

export const TreeMergeOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    version: z.number().int().positive(),
    /** 出树节点（=sourceNodeIds——指派收敛面）。 */
    removedNodeIds: z.array(NodeIdSchema),
    /** target 吸收后变组（有 children）时被收敛掉的 target 旧指派节点（v5 组不产钻）。 */
    demotedNodeIds: z.array(NodeIdSchema),
    /** 指派收敛重算产物（存量 plan 在场且确有收敛时；否则缺席）。 */
    gems: z
      .object({ blobRef: BlobRefSchema, count: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export type TreeMergeOutput = z.infer<typeof TreeMergeOutputSchema>;

export const TreeRefineInputSchema = z
  .object({
    taskId: IdSchema,
    /** CAS 基线（首步前校验；后续步链式推进）。 */
    expectedTreeBlobRef: BlobRefSchema,
    /** 再拆分目标（掩码区域=限定域——子掩码=父∩子）。 */
    nodeId: NodeIdSchema,
    /** SAM 提示清单（逐条一次 segmentOne——组合提示 text+父 bbox 锚定）。 */
    hints: z.array(z.string().min(1).max(WORKBENCH_TEXT_MAX)).min(1).max(8),
  })
  .strict();
export type TreeRefineInput = z.infer<typeof TreeRefineInputSchema>;

export const TreeRefineOutputSchema = z
  .object({
    treeBlobRef: BlobRefSchema,
    previewBlobRef: BlobRefSchema,
    /** 每提示一步的版本号（链式入史——序=hints 序）。 */
    versions: z.array(z.number().int().positive()),
    /** 实际入树子节点（origin=refinement/relation=refinement——B2 临时细分节点）。 */
    children: z.array(z.lazy(() => ObjectNodeSchema)),
    warnings: z.array(z.object({ reason: z.string().min(1), detail: z.string().min(1) }).strict()),
  })
  .strict();
export type TreeRefineOutput = z.infer<typeof TreeRefineOutputSchema>;
