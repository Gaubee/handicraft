/*
 * 仓储管理工作台输出契约（add-stone-library S7.4——sets RPC 六端点 372be0d 的
 * 前端守门面）。沿 stonesAdmin/schemas.ts 纪律（W3 评审 P2-2）：读/写面输出全部
 * 经 zod parse，漂移响应在 façade 层拒绝，不穿透到 UI。
 * 全部组合自 @handicraft/contracts 冻结原语（ProductionSetFileSchema/
 * ProductionSetMemberSchema/ProductionSetOriginSchema）+ daemon rpc.ts 输出形状
 * 是唯一对齐目标，本文件不发明字段。
 * 注：成员五态与限定名回填=SetMemberResolution（sets-service 读时解析投影）。
 */

import { z } from 'zod'
import {
  ProductionSetFileSchema,
  type ProductionSetOrigin,
  type ProductionSetFile,
} from '@handicraft/contracts'

/** 成员引用五态（soft-deleted/blob-missing/wrong-kind/not-found——§7.1 不剔除）。 */
export const SetMemberStateSchema = z.enum(['resolved', 'soft-deleted', 'blob-missing', 'wrong-kind', 'not-found'])
export type SetMemberState = z.infer<typeof SetMemberStateSchema>

/** sets.get 成员解析投影（限定名 standardId/qualifiedSku 同源成对回填/缺席）。 */
export const SetMemberResolutionSchema = z
  .object({
    stoneRef: z.string().min(1),
    state: SetMemberStateSchema,
    quantity: z.number().int().positive().optional(),
    note: z.string().optional(),
    standardId: z.string().optional(),
    qualifiedSku: z.string().optional(),
    textureUrl: z.string().optional(),
  })
  .strict()
export type SetMemberResolution = z.infer<typeof SetMemberResolutionSchema>

// ---------------------------------------------------------------- list

export const SetSummarySchema = z
  .object({
    resourceId: z.string().min(1),
    setId: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().optional(),
    origin: z.object({
      kind: z.enum(['manual-pick', 'bom-derived', 'clone']),
      sourceTaskId: z.string().optional(),
      fromSetId: z.string().optional(),
    }),
    memberCount: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    path: z.string(),
    trashed: z.boolean(),
    updatedAt: z.string(),
  })
  .strict()
export type SetSummary = z.infer<typeof SetSummarySchema>

export const SetsListOutputSchema = z
  .object({
    sets: z.array(SetSummarySchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  })
  .strict()
export type SetsListOutput = z.infer<typeof SetsListOutputSchema>

export interface SetsListInput {
  name?: string
  purpose?: string
  originKind?: 'manual-pick' | 'bom-derived' | 'clone'
  includeTrashed?: boolean
  page?: number
  pageSize?: number
}

// ---------------------------------------------------------------- get

export const SetsGetOutputSchema = z
  .object({
    resourceId: z.string().min(1),
    setId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    path: z.string(),
    trashed: z.boolean(),
    set: ProductionSetFileSchema,
    members: z.array(SetMemberResolutionSchema),
  })
  .strict()
export type SetsGetOutput = z.infer<typeof SetsGetOutputSchema>

// ---------------------------------------------------------------- create / update / delete

export const SetsCreateOutputSchema = z
  .object({
    resourceId: z.string().min(1),
    setId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    path: z.string(),
    memberCount: z.number().int().nonnegative(),
    setJsonBlobRef: z.string().min(1),
  })
  .strict()
export type SetsCreateOutput = z.infer<typeof SetsCreateOutputSchema>

export const SetsUpdateOutputSchema = z
  .object({
    resourceId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    path: z.string(),
    memberCount: z.number().int().nonnegative(),
  })
  .strict()
export type SetsUpdateOutput = z.infer<typeof SetsUpdateOutputSchema>

export const SetsDeleteOutputSchema = z
  .object({
    resourceId: z.string().min(1),
    trashedRows: z.number().int().nonnegative(),
    note: z.string(),
  })
  .strict()
export type SetsDeleteOutput = z.infer<typeof SetsDeleteOutputSchema>

// ---------------------------------------------------------------- 写面输入（daemon rpc.ts 对齐）

export interface SetsCreateInput {
  name: string
  purpose?: string
  members?: Array<{ stoneRef: string; quantity?: number; note?: string }>
  origin: ProductionSetOrigin
}

export interface SetsUpdateInput {
  resourceId: string
  baseRevision: number
  patch: {
    name?: string
    purpose?: string | null
    addMembers?: Array<{ stoneRef: string; quantity?: number; note?: string }>
    removeMembers?: string[]
    updateMembers?: Array<{ stoneRef: string; quantity?: number | null; note?: string | null }>
  }
}

/** 侧栏消费的组合文件视图（sets.get 的 set 投影直通）。 */
export type ProductionSetFileView = ProductionSetFile
