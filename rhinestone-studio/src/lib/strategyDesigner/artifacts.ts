/*
 * 策略设计器数据面（add-subject-sam-pipeline P3.2——策略层 UI「左对话右实时画布」）。
 *
 * 冻结引用：owner-directive-20260924 两层编辑铁律——「Agent 对话=策略层图层级参数、
 * 设计师工作台=单钻微调」；本模块只服务图层级（策略/参数/密度/钻/预览开关）。
 *
 * 工件获取通道现状（W2/W4.2 读后登记）：帧流（artifact 帧）只携带 {name, blobRef}；
 * 审批帧 preview 也是 blobRef——**UI 侧暂无通用 blob 读通道**（daemon rpc.ts 无
 * blobs.read；/api 仅 stones 贴图与分享包）。故本波以 provider 注入面承载结构化
 * 工件内容（缺省 mock fixture），真实通道（blob 读 RPC / 工件 GET）后续波接线时
 * 只换 provider 实现——视图/组件零改动。
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

/** 帧流派生的当前工件引用集（会话内最新一份；缺=null——该步未发生）。 */
export interface StrategyArtifactRefs {
  readonly tree: string | null
  readonly treePreview: string | null
  readonly plan: string | null
  readonly gems: string | null
  readonly gemsPreview: string | null
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
   * 原图叠加源（可选 URL/dataURL）。缺口登记：ObjectTree 工件缺 imageBlobRef 字段
   * （P3.1 已登记）——UI 面能从任务输入图拿到时由此位补入；缺省 null=开关降级态。
   */
  sourceImageUrl: string | null
}

/** 工件内容 provider（缺省 mock fixture；真实通道后续波换实现——视图零改动）。 */
export interface StrategyArtifactsProvider {
  load(refs: StrategyArtifactRefs): Promise<StrategyArtifactsBundle | null>
}

/** 空引用集（会话无任何策略工件帧）。 */
export function emptyStrategyArtifactRefs(): StrategyArtifactRefs {
  return { tree: null, treePreview: null, plan: null, gems: null, gemsPreview: null }
}
