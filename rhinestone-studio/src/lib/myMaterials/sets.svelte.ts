/*
 * 「我的材料 → 我的贴砖组合」store（restructure-materials-story W2b，2026-09-30）。
 * 原始需求（Owner 故事·组套/归档环）：王老板的自建组合跟着账号走——对内私有域，
 * 读写均按 owner（daemon 评审 D-1 同规）。
 * 数据面：sets.list 六端点读面（warehouse client 复用——不另起连接）+ sets.delete
 * 软删（回收站语义）。owner 收窄语义：
 *   - admin 身份：显式传 owner=本人 username（daemon 缺省 admin=全量——我的材料
 *     恒本人域，admin 全量属材料市场管理面，不在此）。
 *   - 普通/匿名身份：不传 owner（daemon 恒收窄自己——前端不重复造过滤）。
 * 正交意图：
 *   [1] 本人组合清单（loading/ready/error 全生命周期态）。
 *   [2] 软删（确认 Dialog 后调用——组件层负责确认，本 store 只管调用+刷新）。
 *   [3] 组合详情直通读面（getMySetDetail——Owner 验收 2026-09-30：点卡片开详情
 *       Sheet；状态机归 SetDetailSheet 组件，本 store 只供绑定 client 直通）。
 *   [4] 市场组合面（product-polish-w1 T1/T4）：scope=market 只读清单+copyMarketSetToMy
 *       复制为本人组合（副本进我的组——「挑组合」一步进「开工」）。
 *   [5] 编辑面（product-polish-w1 T4）：updateMySet 直通 sets.update（SetPatch+
 *       CAS——SetDetailSheet 编辑态保存链；状态机归组件）。
 */

import { getSessionUser } from '$lib/stores/session.svelte'
import {
  defaultWarehouseSetsClientFactory,
  type SetsCreateResult,
  type WarehouseSetsClient,
} from '$lib/warehouse/client'
import type {
  SetsGetOutput,
  SetsListInput,
  SetsUpdateInput,
  SetsUpdateOutput,
  SetSummary,
} from '$lib/warehouse/schemas'

export type MySetsLoadState = 'idle' | 'loading' | 'ready' | 'error'

let client: WarehouseSetsClient | null = null
let sets = $state<SetSummary[]>([])
let state = $state<MySetsLoadState>('idle')
let errorMessage = $state<string | null>(null)
/** 删除 busy 锁（软删串行化——杜绝幽灵操作）。 */
let deleting = $state(false)
let initialized = false

/** 材料市场组合清单（product-polish-w1 T1/T4——scope=market 只读快照组）。 */
let marketSets = $state<SetSummary[]>([])
let marketState = $state<MySetsLoadState>('idle')
let marketErrorMessage = $state<string | null>(null)
let marketInitialized = false
/** 市场复制 busy 锁（copyFromMarket 串行化）。 */
let copyingMarket = $state(false)

/** 测试/装配注入（warehouse store bindWarehouseClient 同式）。 */
export function bindMySetsClient(next: WarehouseSetsClient): void {
  client = next
}

function clientOf(): WarehouseSetsClient {
  if (!client) client = defaultWarehouseSetsClientFactory()
  return client
}

/** owner 收窄入参（见文件头——admin 显式本人，其余身份交服务端恒收窄）。 */
function listInput(): SetsListInput {
  const user = getSessionUser()
  const owner = user !== null && user.role === 'admin' ? user.username : undefined
  return {
    ...(owner !== undefined ? { owner } : {}),
    includeTrashed: false,
    page: 1,
    pageSize: 200, // 契约上限（组合数量级远小于钻原子——单页覆盖，无翻页 UI）
  }
}

/** 市场组合入参（T1——scope=market：admin 所建组合；服务端 ownerIds 投影）。 */
function marketListInput(): SetsListInput {
  return { scope: 'market', includeTrashed: false, page: 1, pageSize: 200 }
}

// ---------------------------------------------------------------- 读面

export function getMySets(): SetSummary[] {
  return sets
}

export function getMySetsState(): MySetsLoadState {
  return state
}

export function getMySetsError(): string | null {
  return errorMessage
}

export function isMySetsDeleting(): boolean {
  return deleting
}

// ---------------------------------------------------------------- 生命周期

/** 面板挂载初始化（幂等——重复调用仅首次拉取；显式刷新走 refreshMySets）。 */
export async function initMySets(): Promise<void> {
  if (initialized) return
  initialized = true
  await refreshMySets()
}

export async function refreshMySets(): Promise<void> {
  state = 'loading'
  errorMessage = null
  try {
    const out = await clientOf().list(listInput())
    sets = out.sets.filter((summary) => !summary.trashed)
    state = 'ready'
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
    state = 'error'
  }
}

/** 组合详情直通读面（sets.get 成员解析快照——调用方持有状态机，复用绑定 client）。 */
export function getMySetDetail(resourceId: string): Promise<SetsGetOutput> {
  return clientOf().get(resourceId)
}

/** 软删组合（回收站语义——成员弱引用零变更）；成功后刷新清单。 */
export async function deleteMySet(resourceId: string): Promise<boolean> {
  deleting = true
  try {
    await clientOf().delete(resourceId)
    await refreshMySets()
    return true
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    deleting = false
  }
}

// ---------------------------------------------------------------- 市场组合面（T1/T4）

export function getMarketSets(): SetSummary[] {
  return marketSets
}

export function getMarketSetsState(): MySetsLoadState {
  return marketState
}

export function getMarketSetsError(): string | null {
  return marketErrorMessage
}

export function isMarketSetCopying(): boolean {
  return copyingMarket
}

/** 市场组清单初始化（幂等；失败不阻断我的组——分区独立错误面）。 */
export async function initMarketSets(): Promise<void> {
  if (marketInitialized) return
  marketInitialized = true
  await refreshMarketSets()
}

export async function refreshMarketSets(): Promise<void> {
  marketState = 'loading'
  marketErrorMessage = null
  try {
    const out = await clientOf().list(marketListInput())
    marketSets = out.sets.filter((summary) => !summary.trashed)
    marketState = 'ready'
  } catch (error) {
    marketErrorMessage = error instanceof Error ? error.message : String(error)
    marketState = 'error'
  }
}

/**
 * 市场组合→我的材料（T1 复制语义：scope=market 只读快照复制为本人组合——
 * origin={kind:'clone', fromSetId} 溯源+成员快照；白名单门在 daemon 服务层）。
 * 成功后刷新两清单（副本进我的组）并返回创建结果。
 */
export async function copyMarketSetToMy(resourceId: string): Promise<SetsCreateResult | null> {
  copyingMarket = true
  try {
    const created = await clientOf().copyFromMarket({ resourceId })
    await Promise.all([refreshMySets(), refreshMarketSets()])
    return created
  } catch (error) {
    marketErrorMessage = error instanceof Error ? error.message : String(error)
    return null
  } finally {
    copyingMarket = false
  }
}

// ---------------------------------------------------------------- 编辑面（T4——SetPatch 保存链）

/** 更新本人组合（成员增删/数量/移除——CAS baseRevision 由编辑面持有）。 */
export function updateMySet(input: SetsUpdateInput): Promise<SetsUpdateOutput> {
  return clientOf().update(input)
}

export function resetMySetsForTests(next?: WarehouseSetsClient): void {
  client = next ?? null
  sets = []
  state = 'idle'
  errorMessage = null
  deleting = false
  initialized = false
  marketSets = []
  marketState = 'idle'
  marketErrorMessage = null
  marketInitialized = false
  copyingMarket = false
}
