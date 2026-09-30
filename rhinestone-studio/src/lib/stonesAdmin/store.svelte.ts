/*
 * 材料市场管理 store（restructure-materials-story W1 改名：装饰钻库→材料市场；add-stone-library S3.3——design §4 后台资源管理器）。
 * 原始需求 2026-09-24：树导航+样卡网格+详情+回收站的数据面唯一状态源
 * （Svelte 5 runes；数据源=daemon resources 经 StonesAdminClient，区别于
 * 素材库的本地 IDB——stone 单一真源在 daemon）。
 * 写面（S3.3 占位升级）：trash/restore 调 stones.trash/restore（S1 递归盖戳
 * 服务面直发）；导入执行=uploadAsset 逐页入库→stones.importRun（操作者即
 * 批准人——与 agent 面 proposal 流并存，两者收敛同一 runCardImport）。
 * 正交意图：
 *   [1] 客户端绑定与初始化（生产 RPC factory / 测试注入 fixture）。
 *   [2] 树状态（standards 目录树——includeTrashed 开关联动回收站视图）。
 *   [3] list/filter 状态（filter 全集+分页+groupBy，变更即重载、page 归 1）。
 *   [4] 详情状态（四态解析+竞态降级投影 detailViewOf；关闭竞态丢弃陈旧响应）。
 *   [5] 回收站视图（tree(includeTrashed) 遍历 trashed 叶——list 分页面无
 *       trashed-only 过滤，树遍历是全量正确面）+ 软删/恢复写动作。
 *   [6] 导入执行面（源图页 blob 映射 + importRun 直发——向导执行步的数据底座）。
 */

import type { CardCatalogDraft, StoneGridCell } from '@handicraft/contracts'
import { defaultStonesClientFactory, type StonesAdminClient } from './client.js'
import { detailViewOf, type StoneDetailView, type StonesListInput, type StonesListOutput, type StonesTreeOutput } from './schemas.js'
import {
  defaultWarehouseSetsClientFactory,
  type SetsCreateResult,
  type WarehouseSetsClient,
} from '$lib/warehouse/client.js'
import type { SetSummary, SetsCreateInput, SetsGetOutput } from '$lib/warehouse/schemas.js'

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
/** 写动作进行中（软删/恢复/导入——交互元 Loading 锁，杜绝幽灵操作）。 */
let writing = $state(false)

// ---------------------------------------------------------------- 组合分区状态（W2a）
// sets.* 六端点复用 S7.4 WarehouseSetsClient（lib/warehouse/client.ts——oRPC 通道
// 与错误面 typed code 归一全套现成，本 store 只挂市场视图所需的状态壳）。
// 错误面独立于 stones 的 storeError（组合加载失败不打断钻库浏览——分区各显各的）。
let setsClient: WarehouseSetsClient | null = null
let marketSetsState = $state<LoadState>('idle')
let marketSets = $state<SetSummary[]>([])
let marketSetsError = $state<string | null>(null)
let marketSetsInitialized = false
/** 选中组合（右侧网格切换为成员钻卡——与供应商树选中互斥）。 */
let selectedSetId = $state<string | null>(null)
let selectedSetDetail = $state<SetsGetOutput | null>(null)
let selectedSetState = $state<LoadState>('idle')

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

export function isStonesWriting(): boolean {
  return writing
}

// ---------------------------------------------------------------- 组合分区读面（W2a）

export function getStonesMarketSetsState(): LoadState {
  return marketSetsState
}

export function getStonesMarketSets(): SetSummary[] {
  return marketSets
}

export function getStonesMarketSetsError(): string | null {
  return marketSetsError
}

export function getStonesMarketSelectedSetId(): string | null {
  return selectedSetId
}

export function getStonesMarketSelectedSet(): SetsGetOutput | null {
  return selectedSetDetail
}

export function getStonesMarketSelectedSetState(): LoadState {
  return selectedSetState
}

/** 网格模式：组合选中（右侧网格=成员钻卡）——供应商树选中互斥的判别位。 */
export function isStonesMarketSetMode(): boolean {
  return selectedSetId !== null
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
  if (!client) throw new Error('材料市场客户端未绑定')
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
  writing = false
  initialized = false
  setsClient = null
  marketSetsState = 'idle'
  marketSets = []
  marketSetsError = null
  marketSetsInitialized = false
  selectedSetId = null
  selectedSetDetail = null
  selectedSetState = 'idle'
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

/** filter 变更：合并补丁 + page 归 1（新过滤集分页从头发）+ 重载。组合选中互斥清位（W2a：任何钻库过滤=回钻型网格）。 */
export async function setStonesFilter(patch: Partial<StonesListInput>): Promise<void> {
  selectedSetId = null
  selectedSetDetail = null
  selectedSetState = 'idle'
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
 * 恢复动作：调 stones.restore（S3.3 占位升级——清子树戳+祖先链重算级联语义在
 * daemon service 层），成功后刷新树/列表/回收站计数。
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

// ---------------------------------------------------------------- 写动作（软删/恢复）

/** 软删原子（stones.trash——S1 递归盖戳；owner 归属校验在 daemon 面）。 */
export async function softDeleteStone(resourceId: string): Promise<void> {
  if (!client) return
  await guard(async () => {
    writing = true
    await client!.trash(resourceId)
    writing = false
  })
  if (writing) writing = false
  if (storeError !== null) return
  await Promise.all([refreshTree(), refreshStonesList(), refreshTrashCount()])
}

/** 恢复原子/子树（stones.restore——清戳+按祖先链重算投影）。 */
export async function restoreStone(resourceId: string): Promise<void> {
  if (!client) return
  await guard(async () => {
    writing = true
    await client!.restore(resourceId)
    writing = false
  })
  if (writing) writing = false
  if (storeError !== null) return
  // 回收站在场则重走 trashed 叶；否则刷新常规树/列表。
  await (trashMode ? setStonesTrashMode(true) : Promise.all([refreshTree(), refreshStonesList(), refreshTrashCount()]))
}

// ---------------------------------------------------------------- 导入执行面（向导执行步数据底座）

/** 向导执行请求（wizard 状态模块 → store 执行——File 页直供）。 */
export interface StoneImportRequest {
  draft: CardCatalogDraft
  targetSupplier: string
  pages: Array<{ page: number; file: File }>
}

/** File → base64（分块 String.fromCharCode 防 apply 栈溢出——32MiB 上限在 daemon 解码门）。 */
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * 执行导入（人工直发）：源图页逐个 uploadAsset 入库（内容寻址去重）→
 * stones.importRun（sourcePages blob 映射；单页草表可空 pages 走服务端 blobRef
 * 回退）。返回 report 全文（向导经 wizardSetReport 校验注入——六字段汇总在
 * report.summary，reportRef 留档真源在 daemon 侧）。
 */
export async function runStoneImport(request: StoneImportRequest): Promise<unknown> {
  if (!client) throw new Error('材料市场客户端未绑定')
  const sourcePages: Record<string, string> = {}
  for (const page of request.pages) {
    const uploaded = await client.uploadAsset(page.file.name, await fileToBase64(page.file))
    sourcePages[String(page.page)] = uploaded.blobRef
  }
  const result = await client.importRun({
    draft: request.draft,
    options: { targetSupplier: request.targetSupplier },
    ...(Object.keys(sourcePages).length > 0 ? { sourcePages } : {}),
  })
  await Promise.all([refreshTree(), refreshStonesList(), refreshTrashCount()])
  return result.report
}

// ---------------------------------------------------------------- 树导航选择

/** 树目录选择 → filter 投影（supplier 半径精确；款式行精度归 family 过滤——不猜测解析行号）。 */
export async function selectStonesTreeDir(patch: { supplier?: string; family?: string }): Promise<void> {
  await setStonesFilter(patch)
}

// ---------------------------------------------------------------- 组合分区（W2a）

/** 组合错误面独立 guard（不写 stones 的 storeError——分区失败不打断钻库浏览）。 */
async function guardSets(run: () => Promise<void>, fail: (message: string) => void): Promise<boolean> {
  try {
    await run()
    return true
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return false
  }
}

/** 注入组合客户端（测试注 fixture；幂等——重复调用仅换实现并作废初始化位）。 */
export function bindStonesMarketSetsClient(next: WarehouseSetsClient): void {
  setsClient = next
  marketSetsInitialized = false
}

/**
 * 组合分区初始化：绑客户端（缺省 S7.4 RPC factory）+ 拉 sets.list。
 * 幂等（已初始化零调用）——视图 onMount 调用；测试先 bind fixture 再显式调用。
 */
export async function initStonesMarketSets(next?: WarehouseSetsClient): Promise<void> {
  if (next) bindStonesMarketSetsClient(next)
  else if (!setsClient) bindStonesMarketSetsClient(defaultWarehouseSetsClientFactory())
  if (!setsClient) throw new Error('组合客户端未绑定')
  if (marketSetsInitialized) return
  marketSetsInitialized = true
  await refreshStonesMarketSets()
}

/** 刷新组合列表（includeTrashed=false——软删组合走回收站语义不进分区；页大小 200 对齐 S7.4 切换器）。 */
export async function refreshStonesMarketSets(): Promise<void> {
  if (!setsClient) return
  marketSetsError = null
  marketSetsState = 'loading'
  const ok = await guardSets(async () => {
    const result = await setsClient!.list({ includeTrashed: false, page: 1, pageSize: 200 })
    marketSets = result.sets
    marketSetsState = 'ready'
  }, (message) => {
    marketSetsError = message
  })
  if (!ok) marketSetsState = 'error'
}

/**
 * 选中组合 → sets.get 装载成员快照（右侧网格切换为成员钻卡）。
 * null=取消选中（回钻型网格）。与供应商树选中互斥由 setStonesFilter 反向清位。
 */
export async function selectStonesMarketSet(resourceId: string | null): Promise<void> {
  if (resourceId === null) {
    selectedSetId = null
    selectedSetDetail = null
    selectedSetState = 'idle'
    return
  }
  if (selectedSetId === resourceId && selectedSetDetail !== null) return
  selectedSetId = resourceId
  selectedSetDetail = null
  selectedSetState = 'loading'
  await guardSets(async () => {
    const detail = await setsClient!.get(resourceId)
    // 竞态丢弃：选择已切换/取消则丢弃陈旧响应。
    if (selectedSetId !== resourceId) return
    selectedSetDetail = detail
    selectedSetState = 'ready'
  }, (message) => {
    if (selectedSetId === resourceId) {
      selectedSetState = 'error'
      marketSetsError = message
    }
  })
}

/** 组合挑选器搜索（CreateSetDialog 数据面——992 款库严禁全量拉：非空 q 才查、页 20）。 */
export const SET_PICKER_PAGE_SIZE = 20

export async function searchStonesForSetPicker(q: string): Promise<StoneGridCell[]> {
  if (!client) bindStonesClient(defaultStonesClientFactory())
  if (!client) throw new Error('材料市场客户端未绑定')
  const trimmed = q.trim()
  if (trimmed === '') return []
  const result = await client.list({ q: trimmed, page: 1, pageSize: SET_PICKER_PAGE_SIZE, includeTrashed: false })
  return result.cells
}

/**
 * 创建组合（CreateSetDialog 提交面——market/personal 两挂载方共用；owner 由
 * 服务端注入当前认证用户，客户端不传——契约见 daemon setsCreate ownerId=context.user）。
 * 成员=ProductionSetMember 语义（stoneRef 弱引用+可选 quantity/note——quantity
 * 缺省=按设计用量另计，§7.1）。
 */
export async function createStoneSet(input: SetsCreateInput): Promise<SetsCreateResult> {
  if (!setsClient) bindStonesMarketSetsClient(defaultWarehouseSetsClientFactory())
  if (!setsClient) throw new Error('组合客户端未绑定')
  return setsClient.create(input)
}
