/*
 * 装饰钻库管理视图输出契约（add-stone-library S3.3——design §4.1）。
 * 原始需求 2026-09-24：daemon stones.tree/list/get 三端点（8bc042c 冻结）的前端
 * 守门面——沿 agentApi/rpc.ts 纪律（W3 评审 P2-2）：读面输出全部经 schema parse，
 * 漂移响应在 façade 层拒绝，不穿透到 UI。
 * 全部组合自 @handicraft/contracts 冻结原语（StoneGridCellSchema/StoneFileSchema）
 * ——daemon rpc.ts 的响应形状是唯一对齐目标，本文件不发明字段。
 * 正交意图：
 *   [1] stones.tree 输出（目录树：dir/stone 递归 union + readScope）。
 *   [2] stones.list 输出（cells + 分页 + groupKeys 可选）。
 *   [3] stones.get 输出（全文态/裸态 union——四态解析 blob-missing/wrong-kind
 *       与竞态降级裸态；soft-deleted 带全文）。
 *   [4] stones admin 写面输出（trash/restore 盖戳计数 + importRun 六字段+report
 *       全文——S3.3 占位升级接线）与 assets.upload 输出（源图页 blob 映射入口）。
 */

import { z } from 'zod'
import { StoneFileSchema, StoneGridCellSchema, type CardCatalogDraft, type StoneGridCell } from '@handicraft/contracts'

/** 共享读标注（评审 D-1：库内容对全部认证用户同一——响应面统一携带）。 */
export const STONES_READ_SCOPE = 'shared-library' as const

// ---------------------------------------------------------------- tree（§4.1）

export interface StoneDirNode {
  kind: 'dir'
  id: string
  name: string
  role?: 'stones-root' | 'standards-root' | 'supplier'
  childCount: number
  children: StoneTreeNode[]
}

export interface StoneStoneNode {
  kind: 'stone'
  cell: StoneGridCell
}

export type StoneTreeNode = StoneDirNode | StoneStoneNode

const StoneStoneNodeSchema = z
  .object({
    kind: z.literal('stone'),
    cell: StoneGridCellSchema,
  })
  .strict()

/** 递归 schema 需显式输出类型注解（zod 推断自指环——TS 层以接口定形）。 */
const StoneDirNodeSchema: z.ZodType<StoneDirNode> = z
  .object({
    kind: z.literal('dir'),
    id: z.string().min(1),
    name: z.string(),
    role: z.enum(['stones-root', 'standards-root', 'supplier']).optional(),
    childCount: z.number().int().nonnegative(),
    children: z.array(z.lazy(() => StoneTreeNodeSchema)),
  })
  .strict()

export const StoneTreeNodeSchema = z.union([StoneDirNodeSchema, StoneStoneNodeSchema])

export const StonesTreeOutputSchema = z
  .object({
    rootId: z.string().nullable(),
    node: StoneTreeNodeSchema.nullable(),
    readScope: z.literal(STONES_READ_SCOPE),
  })
  .strict()
export type StonesTreeOutput = z.infer<typeof StonesTreeOutputSchema>

// ---------------------------------------------------------------- list（§4.2）

export const StonesListOutputSchema = z
  .object({
    cells: z.array(StoneGridCellSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    groupKeys: z.array(z.string()).optional(),
    readScope: z.literal(STONES_READ_SCOPE),
  })
  .strict()
export type StonesListOutput = z.infer<typeof StonesListOutputSchema>

/** stones.list 输入（filter 全集 + 分页——与 daemon StonesListInputSchema 对齐）。 */
export interface StonesListInput {
  supplier?: string
  family?: string
  sizeMm?: number
  styleRow?: number
  sku?: string
  q?: string
  groupBy?: 'family' | 'sizeMm' | 'style'
  page: number
  pageSize: number
  includeTrashed: boolean
}

// ---------------------------------------------------------------- get（四态解析）

/** 全文态：resolved / soft-deleted（软删仍可见全文——回收站详情面）。 */
const StoneDetailFullSchema = z
  .object({
    resourceId: z.string().min(1),
    state: z.enum(['resolved', 'soft-deleted']),
    revision: z.number().int(),
    path: z.string(),
    trashed: z.boolean(),
    stone: StoneFileSchema,
    texture: z
      .object({
        blobRef: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        textureUrl: z.string().min(1),
      })
      .strict(),
    readScope: z.literal(STONES_READ_SCOPE),
  })
  .strict()

/**
 * 裸态：blob-missing / wrong-kind / not-found（解析期即终态）与 resolved / soft-deleted
 * 的竞态降级（resolve 与 get 之间 blob 消失——daemon rpc.ts catch 分支）。
 * union 顺序全文在前：全文对象不会滑入裸态分支。
 */
const StoneDetailBareSchema = z
  .object({
    resourceId: z.string().min(1),
    state: z.enum(['resolved', 'soft-deleted', 'blob-missing', 'wrong-kind', 'not-found']),
    readScope: z.literal(STONES_READ_SCOPE),
  })
  .strict()

export const StoneDetailSchema = z.union([StoneDetailFullSchema, StoneDetailBareSchema])
export type StoneDetail = z.infer<typeof StoneDetailSchema>
export type StoneDetailState = StoneDetail['state']

/** 详情 UI 消费的归并态：全文态/裸终态/竞态降级 → 呈现分支。 */
export type StoneDetailView =
  | { view: 'full'; detail: Extract<StoneDetail, { stone: unknown }> }
  | { view: 'blob-missing' }
  | { view: 'wrong-kind' }
  | { view: 'not-found' }
  | { view: 'degraded'; state: 'resolved' | 'soft-deleted' }

export function detailViewOf(detail: StoneDetail): StoneDetailView {
  if ('stone' in detail) return { view: 'full', detail }
  if (detail.state === 'blob-missing') return { view: 'blob-missing' }
  if (detail.state === 'wrong-kind') return { view: 'wrong-kind' }
  if (detail.state === 'not-found') return { view: 'not-found' }
  return { view: 'degraded', state: detail.state }
}

// ---------------------------------------------------------------- 写面（S3.3 占位升级——stones.trash/restore/importRun）

export const StonesTrashOutputSchema = z
  .object({
    resourceId: z.string().min(1),
    trashedRows: z.number().int().nonnegative(),
    trashedStones: z.number().int().nonnegative(),
    note: z.string(),
  })
  .strict()
export type StonesTrashOutput = z.infer<typeof StonesTrashOutputSchema>

export const StonesRestoreOutputSchema = z
  .object({
    resourceId: z.string().min(1),
    restoredRows: z.number().int().nonnegative(),
    restoredStones: z.number().int().nonnegative(),
    note: z.string(),
  })
  .strict()
export type StonesRestoreOutput = z.infer<typeof StonesRestoreOutputSchema>

/** stones.importRun 入参（options 对齐 daemon S2 CardImportOptions——ownerId 服务端注入）。 */
export interface StonesImportRunInput {
  draft: CardCatalogDraft
  options: {
    targetSupplier: string
    supplierDisplayName?: string
    familyPolicy?: { overrides?: Record<string, string>; fallbackFamily?: string }
    qualityFlag?: string
    extraMetadata?: Record<string, unknown>
    backgroundTolerance?: number
    featherPx?: number
  }
  /** 多页源图 blob 映射：页号→assets.upload 所得 blobRef（缺省走草表单页 blobRef 回退）。 */
  sourcePages?: Record<string, string>
}

/** importRun 六字段+report 全文（report=blob 留档的即时读回——管理视图直接渲染）。 */
export const StonesImportRunOutputSchema = z.object({
  created: z.array(z.string()),
  skipped: z.array(z.object({ sku: z.string(), reason: z.string() })),
  failed: z.array(z.object({ sku: z.string(), reason: z.string() })),
  pendingDowngrades: z.array(z.object({ sku: z.string(), reason: z.string() })),
  lowConfidence: z.array(z.object({ sku: z.string(), row: z.number().int() })),
  reportRef: z.string().regex(/^[0-9a-f]{64}$/),
  report: z.object({ kind: z.literal('card-import-report') }).passthrough(),
})
export type StonesImportRunOutput = z.infer<typeof StonesImportRunOutputSchema>

/** assets.upload 输出（源图页入库——importRun sourcePages 的 blobRef 来源）。 */
export const AssetsUploadOutputSchema = z
  .object({
    blobRef: z.string().regex(/^[0-9a-f]{64}$/),
    filename: z.string().min(1),
    size: z.number().int().nonnegative(),
  })
  .strict()
export type AssetsUploadOutput = z.infer<typeof AssetsUploadOutputSchema>
