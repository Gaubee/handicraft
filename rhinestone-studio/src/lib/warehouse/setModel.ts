/*
 * 集合侧栏纯模型（add-stone-library S7.4——design §7.6/§7.1）。
 * 聚合（成员数/总数量/缺失计数）、限定名展示投影（编号冲突自动区分的落点）、
 * update patch 构建（新增/移除/字段级更新/CAS 基线）——全部纯函数，jsdom 直测。
 * 语义锚点：
 *   - quantity 缺省=「按设计用量另计」（§7.1）——聚合不猜测，未声明计数显式呈现。
 *   - 缺失成员**不剔除**（§7.1 引用集不变量）——五态缺失计数+红边徽标的数据面。
 *   - revision 漂移（CAS）→ 刷新提示态，不盲写（§1.6 同规——design §7.6 保存）。
 */

import { qualifiedSku } from '@handicraft/contracts'
import type { StoneGridCell } from '@handicraft/contracts'
import type { StoneRefState } from '$lib/stonePicker/source.js'
import type { SetMemberResolution } from './schemas.js'

/** 侧栏成员行（解析投影+行内编辑面——quantity/note 是草稿态，保存才落库）。 */
export interface WarehouseMember {
  stoneRef: string
  state: StoneRefState
  quantity?: number
  note?: string
  /** 解析投影限定名（服务端回填；新加入成员由 catalog 即时构造）。 */
  qualifiedSku?: string
  standardId?: string
  /** resolved 态贴图 URL（成员贴图墙；缺失态缺席）。 */
  textureUrl?: string
}

/** 成员聚合（侧栏汇总行——成员数/总数量/缺失警示）。 */
export interface MembersAggregate {
  memberCount: number
  /** 已声明数量之和（仅 quantity 在场的成员）。 */
  totalQuantity: number
  /** 未声明数量的成员数（「按设计用量另计」——显式计数不猜测）。 */
  undeclaredQuantityCount: number
  /** 非 resolved 成员数（五态缺失——不剔除，警示呈现）。 */
  missingCount: number
}

export function aggregateMembers(members: readonly WarehouseMember[]): MembersAggregate {
  let totalQuantity = 0
  let undeclaredQuantityCount = 0
  let missingCount = 0
  for (const member of members) {
    if (member.quantity === undefined) undeclaredQuantityCount += 1
    else totalQuantity += member.quantity
    if (member.state !== 'resolved') missingCount += 1
  }
  return { memberCount: members.length, totalQuantity, undeclaredQuantityCount, missingCount }
}

/**
 * 成员限定名展示：`<标准ID>/<SKU>`（Owner 定调五「编号可能冲突，自动加入标准
 * ID」）。优先服务端解析投影（qualifiedSku 与 standardId 同源成对回填/缺席）；
 * 平铺区新加入成员用 catalog cell 即时构造（contracts qualifiedSku 同源纯函数）；
 * 双缺（wrong-kind/not-found 行已删）→ 短 ref 兜底——缺失态本就要人眼处理，
 * 不伪造名字。
 */
export function memberQualifiedName(member: WarehouseMember, catalogCell?: StoneGridCell): string {
  if (member.qualifiedSku !== undefined && member.qualifiedSku !== '') return member.qualifiedSku
  if (catalogCell !== undefined) return qualifiedSku(catalogCell.supplier, catalogCell.sku)
  // 解析投影与 catalog 双缺（wrong-kind/not-found——行已不在）：短 ref 兜底，
  // 缺失态本就要人眼处理，不伪造名字。
  return `未解析/${member.stoneRef.slice(0, 8)}`
}

/** 平铺区 cell → 侧栏成员（加入集合的即时投影——贴图/限定名零二次请求）。 */
export function memberFromCell(cell: StoneGridCell): WarehouseMember {
  return {
    stoneRef: cell.resourceId,
    state: 'resolved',
    standardId: cell.supplier,
    qualifiedSku: qualifiedSku(cell.supplier, cell.sku),
    textureUrl: cell.textureUrl,
  }
}

/** sets.get 成员解析投影 → 侧栏成员（读时解析——草稿编辑面初始值）。 */
export function memberFromResolution(resolution: SetMemberResolution): WarehouseMember {
  const member: WarehouseMember = {
    stoneRef: resolution.stoneRef,
    state: resolution.state,
  }
  if (resolution.quantity !== undefined) member.quantity = resolution.quantity
  if (resolution.note !== undefined) member.note = resolution.note
  if (resolution.standardId !== undefined) member.standardId = resolution.standardId
  if (resolution.qualifiedSku !== undefined) member.qualifiedSku = resolution.qualifiedSku
  if (resolution.textureUrl !== undefined) member.textureUrl = resolution.textureUrl
  return member
}

// ---------------------------------------------------------------- update patch

/** 字段级成员更新（undefined=不动；null=清除——daemon SetsUpdateInputSchema 同语义）。 */
export interface MemberFieldPatch {
  stoneRef: string
  quantity?: number | null
  note?: string | null
}

export interface SetPatchDraft {
  name?: string
  purpose?: string | null
  addMembers?: Array<{ stoneRef: string; quantity?: number; note?: string }>
  removeMembers?: string[]
  updateMembers?: MemberFieldPatch[]
}

/** 组合快照（CAS 对比基线——switchSet 时从 sets.get 冻结）。 */
export interface SetSnapshot {
  name: string
  purpose?: string
  members: ReadonlyArray<{ stoneRef: string; quantity?: number; note?: string }>
}

function sameMember(a: { quantity?: number; note?: string }, b: { quantity?: number; note?: string }): boolean {
  return a.quantity === b.quantity && a.note === b.note
}

/**
 * 草稿 vs 快照 → update patch（无变更=null——保存按钮禁用依据）。成员编辑转
 * 字段级 updateMembers（null=清除），新增/移除转 addMembers/removeMembers——
 * 与 daemon SetsUpdateInputSchema 的 patch 形状一一对应。
 */
export function buildUpdatePatch(snapshot: SetSnapshot, draft: { name: string; purpose?: string; members: ReadonlyArray<{ stoneRef: string; quantity?: number; note?: string }> }): SetPatchDraft | null {
  const patch: SetPatchDraft = {}
  if (draft.name !== snapshot.name) patch.name = draft.name
  const purposeChanged =
    (snapshot.purpose ?? undefined) !== (draft.purpose === '' ? undefined : draft.purpose)
  if (purposeChanged) patch.purpose = draft.purpose === undefined || draft.purpose === '' ? null : draft.purpose

  const before = new Map(snapshot.members.map((m) => [m.stoneRef, m]))
  const after = new Map(draft.members.map((m) => [m.stoneRef, m]))
  const addMembers: Array<{ stoneRef: string; quantity?: number; note?: string }> = []
  const removeMembers: string[] = []
  const updateMembers: MemberFieldPatch[] = []
  for (const member of draft.members) {
    if (!before.has(member.stoneRef)) addMembers.push({ ...member })
  }
  for (const member of snapshot.members) {
    if (!after.has(member.stoneRef)) removeMembers.push(member.stoneRef)
  }
  for (const member of draft.members) {
    const prior = before.get(member.stoneRef)
    if (prior === undefined || sameMember(prior, member)) continue
    const field: MemberFieldPatch = { stoneRef: member.stoneRef }
    if (prior.quantity !== member.quantity) {
      field.quantity = member.quantity === undefined ? null : member.quantity
    }
    if (prior.note !== member.note) {
      field.note = member.note === undefined || member.note === '' ? null : member.note
    }
    updateMembers.push(field)
  }
  if (addMembers.length > 0) patch.addMembers = addMembers
  if (removeMembers.length > 0) patch.removeMembers = removeMembers
  if (updateMembers.length > 0) patch.updateMembers = updateMembers

  const hasChange =
    patch.name !== undefined ||
    patch.purpose !== undefined ||
    addMembers.length > 0 ||
    removeMembers.length > 0 ||
    updateMembers.length > 0
  return hasChange ? patch : null
}

// ---------------------------------------------------------------- CAS 漂移

/** typed 错误码载体（client 抛出的错误实现此形——duck-typing 保持本文件零依赖）。 */
export interface CodedErrorShape {
  code?: unknown
}

/** revision 漂移判定（daemon SetServiceError code='revision-conflict'——CAS 拒）。 */
export function isRevisionConflict(error: unknown): boolean {
  const coded = error as CodedErrorShape | null
  return typeof coded?.code === 'string' && (coded as { code: string }).code === 'revision-conflict'
}
