/*
 * 装饰钻库管理 store（add-stone-library S3.3——design §4 后台资源管理器）。
 * 原始需求 2026-09-24：树导航+样卡网格+详情+回收站的数据面唯一状态源
 * （Svelte 5 runes；数据源=daemon resources 经 StonesAdminClient，区别于
 * 素材库的本地 IDB——stone 单一真源在 daemon）。
 * 写面诚实性（brief S3.3）：restore/import/delete 走授权桥，浏览器 RPC 无端点
 * ——store 不提供伪造动作，UI 呈显式占位态。
 * 正交意图：
 *   [1] 客户端绑定与初始化（生产 RPC factory / 测试注入 fixture）。
 *   [2] 树状态（standards 目录树——includeTrashed 开关联动回收站视图）。
 *   [3] list/filter 状态（filter 全集+分页+groupBy，变更即重载、page 归 1）。
 *   [4] 详情状态（四态解析+竞态降级投影 detailViewOf；关闭竞态丢弃陈旧响应）。
 *   [5] 回收站视图（tree(includeTrashed) 遍历 trashed 叶——list 分页面无
 *       trashed-only 过滤，树遍历是全量正确面；恢复动作占位不伪造）。
 */

import type { StoneGridCell } from '@handicraft/contracts'
import { defaultStonesClientFactory, type StonesAdminClient } from './client.js'
import { detailViewOf, type StoneDetailView, type StonesListInput, type StonesListOutput, type StonesTreeOutput } from './schemas.js'

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

let client: StonesAdminClient | null = null
let connection = $state<'idle' | 'open'>('idle')
let treeState = $state<LoadState>('idle')
let tree = $state<StonesTreeOutput | null>(null)
let listState = $state<LoadState>('idle')
let list = $state<StonesListOutput | null>(null)
let filter = $state<StonesListInput>({ page: 1, pageSize: 60, includeTrashed: false })
let detailId = $state<string | null>(null)
let detailState = $state<LoadState>('idle')
let detailView = $state<StoneDetailView | null>(null)
let trashMode = $state(false)
let trashState = $state<LoadState>('idle')
let trashItems = $state<StoneGridCell[]>([])
let storeError = $state<string | null>(null)
let initialized = false

// ---------------------------------------------------------------- 读面

export function getStonesConnection(): 'idle' | 'open' {
  return connection
}

export function getStonesTreeState(): LoadState {
  return treeState
}

export function getStonesTree(): StonesTreeOutput | null {
  return tree
}

export function getStonesListState(): LoadState {
  return listState
}

export function getStonesList(): StonesListOutput | null {
  return list
}

export function getStonesFilter(): StonesListInput {
  return filter
}

export function getStonesDetailId(): string | null {
  return detailId
}

export function getStonesDetailView(): StoneDetailView | null {
  return detailView
}

export function getStonesDetailState(): LoadState {
  return detailState
}

export function isStonesTrashMode(): boolean {
  return trashMode
}

export function getStonesTrashState(): LoadState {
  return trashState
}

export function getStonesTrashItems(): StoneGridCell[] {
  return trashItems
}

export function getStonesAdminError(): string | null {
  return storeError
}

/** 总页数（list 未载=1——分页控件下界）。 */
export function getStonesTotalPages(): number {
  if (list === null) return 1
  return Math.max(1, Math.ceil(list.total / list.pageSize))
}

/** 色系筛选项：树内 supplier 半径下的全部色系目录（全量键——非当前页切片）。 */
export function getStonesFamilyOptions(): string[] {
  if (tree === null || tree.node === null || tree.node.kind !== 'dir') return []
  const out = new Set<string>()
  for (const supplier of tree.node.children) {
    if (supplier.kind !== 'dir') continue
    if (filter.supplier !== undefined && supplier.name !== filter.supplier) continue
    for (const family of supplier.children) {
      if (family.kind === 'dir') out.add(family.name)
    }
  }
  return [...out].sort()
}

// ---------------------------------------------------------------- 生命周期

/** 注入客户端（生产走 factory；测试注 fixture）。幂等——重复调用仅换实现。 */
export function bindStonesClient(next: StonesAdminClient): void {
  client = next
  connection = 'open'
}

/** 首次进入管理视图：绑客户端（缺省 RPC factory）+ 拉树/首页/回收站计数。 */
export async function initStonesAdmin(next?: StonesAdminClient): Promise<void> {
  if (next) bindStonesClient(next)
  else if (!client) bindStonesClient(defaultStonesClientFactory())
  if (!client) throw new Error('装饰钻库客户端未绑定')
  if (initialized) return
  initialized = true
  await Promise.all([refreshTree(), refreshStonesList(), refreshTrashCount()])
}

export function resetStonesAdminForTests(): void {
  client = null
  connection = 'idle'
  treeState = 'idle'
  tree = null
  listState = 'idle'
  list = null
  filter = { page: 1, pageSize: 60, includeTrashed: false }
  detailId = null
  detailState = 'idle'
  detailView = null
  trashMode = false
  trashState = 'idle'
  trashItems = []
  storeError = null
  initialized = false
}

async function guard(run: () => Promise<void>): Promise<void> {
  storeError = null
  try {
    await run()
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error)
  }
}

async function refreshTree(): Promise<void> {
  await guard(async () => {
    treeState = 'loading'
    tree = await client!.tree({ includeTrashed: false })
    treeState = 'ready'
  })
  if (treeState !== 'ready') treeState = 'error'
}

export async function refreshStonesList(): Promise<void> {
  await guard(async () => {
    listState = 'loading'
    list = await client!.list(filter)
    listState = 'ready'
  })
  if (listState !== 'ready') listState = 'error'
}

export async function refreshStonesAdmin(): Promise<void> {
  if (!client) return
  await Promise.all([refreshTree(), refreshStonesList(), refreshTrashCount()])
}

// ---------------------------------------------------------------- filter / 分页

/** filter 变更：合并补丁 + page 归 1（新过滤集分页从头发）+ 重载。 */
export async function setStonesFilter(patch: Partial<StonesListInput>): Promise<void> {
  filter = { ...filter, ...patch, page: 1 }
  await refreshStonesList()
}

export async function setStonesPage(page: number): Promise<void> {
  const next = Math.min(Math.max(1, page), getStonesTotalPages())
  if (next === filter.page) return
  filter = { ...filter, page: next }
  await refreshStonesList()
}

export async function setStonesGroupBy(groupBy: StonesListInput['groupBy']): Promise<void> {
  await setStonesFilter({ groupBy })
}

/** 清过滤（树导航「全部」/ 筛选条清除）。 */
export async function clearStonesFilter(): Promise<void> {
  await setStonesFilter({ supplier: undefined, family: undefined, sizeMm: undefined, q: undefined, groupBy: undefined })
}

// ---------------------------------------------------------------- 详情（四态）

export async function openStoneDetail(resourceId: string): Promise<void> {
  detailId = resourceId
  detailView = null
  await guard(async () => {
    detailState = 'loading'
    const detail = await client!.get(resourceId)
    // 关闭竞态：详情已切换/关闭则丢弃陈旧响应。
    if (detailId !== resourceId) return
    detailView = detailViewOf(detail)
    detailState = 'ready'
  })
  if (detailId === resourceId && detailState !== 'ready') detailState = 'error'
}

export function closeStoneDetail(): void {
  detailId = null
  detailView = null
  detailState = 'idle'
}

// ---------------------------------------------------------------- 回收站

/** includeTrashed 树遍历 trashed 叶（回收站列表与树侧计数共用）。 */
async function walkTrashed(): Promise<StoneGridCell[]> {
  const out = await client!.tree({ includeTrashed: true })
  const items: StoneGridCell[] = []
  const walk = (node: NonNullable<StonesTreeOutput['node']>): void => {
    if (node.kind === 'stone') {
      if (node.cell.trashed) items.push(node.cell)
      return
    }
    for (const child of node.children) walk(child)
  }
  if (out.node !== null) walk(out.node)
  return items
}

/** 回收站计数刷新（init/refresh 面——不切换视图模式）。 */
async function refreshTrashCount(): Promise<void> {
  await guard(async () => {
    trashItems = await walkTrashed()
  })
}

/**
 * 回收站视图：tree(includeTrashed=true) 全量遍历 trashed 叶。
 * 恢复动作：S1 restore 在 daemon service，无浏览器 RPC 端点——只读呈现 +
 * 「恢复待 admin API」占位，不伪造恢复。
 */
export async function setStonesTrashMode(on: boolean): Promise<void> {
  trashMode = on
  if (!on) {
    await refreshTree()
    return
  }
  await guard(async () => {
    trashState = 'loading'
    trashItems = await walkTrashed()
    trashState = 'ready'
  })
  if (trashState !== 'ready') trashState = 'error'
}

// ---------------------------------------------------------------- 树导航选择

/** 树目录选择 → filter 投影（supplier 半径精确；款式行精度归 family 过滤——不猜测解析行号）。 */
export async function selectStonesTreeDir(patch: { supplier?: string; family?: string }): Promise<void> {
  await setStonesFilter(patch)
}
