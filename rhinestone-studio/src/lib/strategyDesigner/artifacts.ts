/*
 * 策略设计器数据面（add-subject-sam-pipeline P3.2——策略层 UI「左对话右实时画布」）。
 *
 * 冻结引用：owner-directive-20260924 两层编辑铁律——「Agent 对话=策略层图层级参数、
 * 设计师工作台=单钻微调」；本模块只服务图层级（策略/参数/密度/钻/预览开关）。
 *
 * 工件获取通道（P3.2-channel 已闭合）：daemon tasks.artifact RPC（归属校验+引用集
 * 验证+8MiB 上限）按 {taskId, blobRef|name} 读回字节；合法引用集=任务 artifact 帧 ∪
 * 所属会话附件 blob（原图叠加通道）。缺省 provider=RpcStrategyArtifacts（真实通道
 * ——artifacts-provider.ts）；MockStrategyArtifacts 仅测试注入。
 *
 * StrategyGemsView 为 daemon StrategyGemsDoc（strategies/design.ts）的**字面镜像**
 * （红线纪律同 KERNEL_GEM_SHAPE_IDS：daemon 不可 import，schema 字段/界逐字抄录；
 * contracts 冻结归后续波——daemon 头注自陈「本地 schema 把守」）。
 */

import { z } from 'zod'
import { CodeStrategyArtifactSchema, type CodeStrategyArtifact, type ObjectTree, type StrategyPlan } from '@handicraft/contracts'

/** 管线工件名约定（daemon emit 层单源——tree-persist.ts / strategies/design.ts）。 */
export const STRATEGY_ARTIFACT_NAMES = {
  tree: 'object-tree.json',
  treePreview: 'object-tree-preview.png',
  plan: 'strategy-plan.json',
  gems: 'strategy-gems.json',
  gemsPreview: 'strategy-gems-preview.png',
} as const

export type StrategyArtifactName = (typeof STRATEGY_ARTIFACT_NAMES)[keyof typeof STRATEGY_ARTIFACT_NAMES]

/** 工件引用（含任务溯源——tasks.artifact RPC 入参需要 taskId+blobRef 成对）。 */
export interface StrategyArtifactRef {
  readonly blobRef: string
  readonly taskId: string
}

/** 帧流派生的当前工件引用集（会话内最新一份；缺=null——该步未发生）。 */
export interface StrategyArtifactRefs {
  readonly tree: StrategyArtifactRef | null
  readonly treePreview: StrategyArtifactRef | null
  readonly plan: StrategyArtifactRef | null
  readonly gems: StrategyArtifactRef | null
  readonly gemsPreview: StrategyArtifactRef | null
}

/** strategy-gems.json 工件视图（daemon StrategyGemsDocSchema 字面镜像——头注）。 */
export const StrategyGemsViewSchema = z
  .object({
    kind: z.literal('strategy-gems'),
    formatVersion: z.literal(1),
    planRef: z.string().regex(/^[0-9a-f]{64}$/),
    canvasCm: z.object({ w: z.number().positive(), h: z.number().positive() }),
    imagePx: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    gems: z.array(
      z.object({
        id: z.string().min(1),
        x: z.number(),
        y: z.number(),
        colorId: z.string(),
        blockId: z.string().min(1),
        shapeId: z.enum(['round', 'square', 'drop', 'heart', 'marquise', 'custom']),
        diameterMm: z.number().positive(),
        rotationDeg: z.number().min(0).max(360).optional(),
        assetId: z.string().min(1).optional(),
      }),
    ),
    excludedRegions: z.array(
      z.object({
        nodeId: z.string().min(1),
        label: z.string().min(1),
        reason: z.string().min(1),
        areaCm2: z.number().nonnegative(),
      }),
    ),
    warnings: z.array(z.object({ kind: z.enum(['excluded', 'degraded', 'spacing', 'mask', 'geometry']), detail: z.string().min(1) })),
    createdAt: z.string().min(1),
  })
  .strict()
export type StrategyGemsView = z.infer<typeof StrategyGemsViewSchema>

/** 结构化工件束（provider 单次装载——tree/plan/gems 同 plan 代际）。 */
export interface StrategyArtifactsBundle {
  tree: ObjectTree
  plan: StrategyPlan
  gems: StrategyGemsView
  /** free-code 指派的源码工件（codeArtifactRef → 工件；只读预览）。 */
  codeArtifacts: Record<string, CodeStrategyArtifact>
  /**
   * 原图叠加源（dataUrl——会话附件 blob 经 tasks.artifact 附件通道拉取）。
   * 现状（P3.2-channel 实证）：任务面（SessionTaskSummary）无输入图字段；真实
   * daemon 模式下 followup 附件注记（kernel prompt 注入 `[附件 N 个：ref…]`）随
   * user transcript 帧回显——按注记解析取最新一组的首个附件。无注记=null（降级态）。
   */
  sourceImageUrl: string | null
  /** 树预览 PNG dataUrl（P3.2-channel 拉取；缺席=null——旅程卡可选消费）。 */
  treePreviewUrl?: string | null
  /** 钻点阵叠加预览 PNG dataUrl（同上）。 */
  gemsPreviewUrl?: string | null
}

/**
 * 工件内容 provider。缺省=RpcStrategyArtifacts（真实通道——P3.2-channel 反转：
 * mock 仅测试注入）。三结构化工件引用齐备才装配；任一缺失=null（旅程未到位，
 * 非错误）；拉取/schema 守门失败=throw（store 记 loadError——显式降级注记）。
 */
export interface StrategyArtifactsProvider {
  load(refs: StrategyArtifactRefs): Promise<StrategyArtifactsBundle | null>
}

/** 空引用集（会话无任何策略工件帧）。 */
export function emptyStrategyArtifactRefs(): StrategyArtifactRefs {
  return { tree: null, treePreview: null, plan: null, gems: null, gemsPreview: null }
}
