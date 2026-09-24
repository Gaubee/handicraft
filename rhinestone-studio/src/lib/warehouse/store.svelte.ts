/*
 * 仓储管理工作台 store（add-stone-library S7.4——design §7.6 第三产品工作台）。
 * 原始需求 2026-09-24（Owner 定调五）：标准平铺（多标准纵向分组流+段内筛选+
 * 虚拟滚动）→ 框选/点选 → 添加/删除到集合 → 集合侧栏（限定名/数量/备注/汇总/
 * 缺失警示）→ 存为组合（manual-pick）/改既有组合（成员增删 revision CAS——
 * 漂移→刷新提示重载，不盲写）。独立状态源（区别于 stonesAdmin 管理视图与
 * stonePicker 组件库自持 store）；数据面=stones.tree/list（S3.3 客户端复用）+
 * sets 六端点（本波 client.ts）。
 * 正交意图：
 *   [1] 平铺区（供应商段=cells+filter+collapsed；family 选项段内派生）。
 *   [2] 选择集（staged——框选 commit/点选 toggle 跨标准累加；与成员集分离：
 *       Owner「选择→添加/删除到集合中」两步）。
 *   [3] 集合草稿（成员 Map+name/purpose；切换器 sets.list；activeSetId=null 新建）。
 *   [4] 保存面（create=manual-pick 直发；update=buildUpdatePatch+baseRevision CAS；
 *       revision-conflict→staleDrift 提示态；reloadAfterDrift 显式重载）。
 */

import type { StoneGridCell } from '@handicraft/contracts'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { defaultStonesClientFactory, type StonesAdminClient } from '$lib/stonesAdmin/client.js'
import {
  defaultWarehouseSetsClientFactory,
  type WarehouseSetsClient,
} from './client.js'
import type { SetSummary } from './schemas.js'
import {
  buildUpdatePatch,
  memberFromCell,
  memberFromResolution,
  isRevisionConflict,
  type SetSnapshot,
  type WarehouseMember,
} from './setModel.js'

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

/** 段内筛选（每标准独立——色系/尺寸/搜索）。 */
export interface WarehouseSectionFilter {
  family?: string
  sizeMm?: number
  q?: string
}

export interface WarehouseSection {
  supplier: string
  state: LoadState
  cells: StoneGridCell[]
  filter: WarehouseSectionFilter
  collapsed: boolean
}

/** 组合客户端（stones 面复用 S3.3 形态 + sets 面）。 */
export interface WarehouseClient {
  stones: Pick<StonesAdminClient, 'tree' | 'list'>
  sets: WarehouseSetsClient
}

export function defaultWarehouseClientFactory(): WarehouseClient {
  return { stones: defaultStonesClientFactory(), sets: defaultWarehouseSetsClientFactory() }
}

let client: WarehouseClient | null = null
let sectionsState = $state<LoadState>('idle')
let sections = $state<WarehouseSection[]>([])
let selection = new SvelteSet<string>()
let setsListState = $state<LoadState>('idle')
let setsList = $state<SetSummary[]>([])
let activeSetId = $state<string | null>(null)
let activeSetTrashed = $state(false)
let draftName = $state('')
let draftPurpose = $state('')
let draftMembers = new SvelteMap<string, WarehouseMember>()
let snapshot = $state<SetSnapshot | null>(null)
let baseRevision = $state<number | null>(null)
let staleDrift = $state(false)
let saving = $state(false)
let storeError = $state<string | null>(null)
let initialized = false

// ---------------------------------------------------------------- 读面

export function getWarehouseSectionsState(): LoadState {
  return sectionsState
}

export function getWarehouseSections(): WarehouseSection[] {
  return sections
}

export function getWarehouseSelection(): string[] {
  return [...selection]
}

export function isWarehouseSelected(resourceId: string): boolean {
  return selection.has(resourceId)
}

export function getWarehouseSetsListState(): LoadState {
  return setsListState
}

export function getWarehouseSetsList(): SetSummary[] {
  return setsList
}

export function getWarehouseActiveSetId(): string | null {
  return activeSetId
}

export function isWarehouseActiveSetTrashed(): boolean {
  return activeSetTrashed
}

export function getWarehouseDraftName(): string {
  return draftName
}

export function getWarehouseDraftPurpose(): string {
  return draftPurpose
}

/** 草稿成员（插入序——侧栏贴图墙行序与加入顺序一致）。 */
export function getWarehouseDraftMembers(): WarehouseMember[] {
  return [...draftMembers.values()]
}

export function isWarehouseMember(resourceId: string): boolean {
  return draftMembers.has(resourceId)
}

export function getWarehouseBaseRevision(): number | null {
  return baseRevision
}

export function isWarehouseStaleDrift(): boolean {
  return staleDrift
}

export function isWarehouseSaving(): boolean {
  return saving
}

export function getWarehouseError(): string | null {
  return storeError
}

/** 段内 family 选项（段内 cells 全量键——非过滤切片）。 */
export function getSectionFamilyOptions(supplier: string): string[] {
  const section = sections.find((s) => s.supplier === supplier)
  if (section === undefined) return []
  return [...new Set(section.cells.map((cell) => cell.family))].sort()
}

/** catalog 查询（成员贴图墙/限定名即时投影——平铺区已加载 cell 的全量键）。 */
export function getWarehouseCatalogCell(resourceId: string): StoneGridCell | undefined {
  for (const section of sections) {
    const cell = section.cells.find((c) => c.resourceId === resourceId)
    if (cell !== undefined) return cell
  }
  return undefined
}

/** 草稿成员 → 存储形态（只落 stoneRef/quantity/note——解析投影字段不落库，§7.1）。 */
function plainMembers(): Array<{ stoneRef: string; quantity?: number; note?: string }> {
  return [...draftMembers.values()].map((member) => ({
    stoneRef: member.stoneRef,
    ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
    ...(member.note !== undefined ? { note: member.note } : {}),
  }))
}

/** 改动判定（保存按钮禁用依据——新建=成员+名；编辑=buildUpdatePatch 非空）。 */
export function isWarehouseDraftDirty(): boolean {
  if (activeSetId === null) return draftMembers.size > 0 && draftName.trim() !== ''
  if (snapshot === null) return false
  return (
    buildUpdatePatch(snapshot, {
      name: draftName,
      purpose: draftPurpose === '' ? undefined : draftPurpose,
      members: plainMembers(),
    }) !== null
  )
}

// ---------------------------------------------------------------- 段内过滤（纯）

/** 段内过滤（色系精确/尺寸精确/搜索子串——q 口径对齐服务端小写包含）。 */
export function filterSectionCells(cells: readonly StoneGridCell[], filter: WarehouseSectionFilter): StoneGridCell[] {
  let rows: StoneGridCell[] = [...cells]
  if (filter.family !== undefined && filter.family !== '') rows = rows.filter((cell) => cell.family === filter.family)
  if (filter.sizeMm !== undefined) rows = rows.filter((cell) => cell.sizeMm === filter.sizeMm)
  const q = filter.q?.trim().toLowerCase()
  if (q !== undefined && q !== '') {
    rows = rows.filter((cell) =>
      `${cell.sku} ${cell.supplier} ${cell.family} ${cell.styleName} ${cell.name} ${cell.colorHex}`.toLowerCase().includes(q),
    )
  }
  return rows
}

// ---------------------------------------------------------------- 生命周期

export function bindWarehouseClient(next: WarehouseClient): void {
  client = next
}

export async function initWarehouse(next?: WarehouseClient): Promise<void> {
  if (next) bindWarehouseClient(next)
  else if (!client) bindWarehouseClient(defaultWarehouseClientFactory())
  if (!client) throw new Error('仓储管理客户端未绑定')
  if (initialized) return
  initialized = true
  await Promise.all([refreshSections(), refreshSetsList()])
}

export function resetWarehouseForTests(): void {
  client = null
  sectionsState = 'idle'
  sections = []
  selection.clear()
  setsListState = 'idle'
  setsList = []
  activeSetId = null
  activeSetTrashed = false
  draftName = ''
  draftPurpose = ''
  draftMembers.clear()
  snapshot = null
  baseRevision = null
  staleDrift = false
  saving = false
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

/** 平铺区装载：树（供应商清单）→ 各供应商全量 cell（pageSize 200 翻页）。 */
export async function refreshSections(): Promise<void> {
  if (!client) return
  await guard(async () => {
    sectionsState = 'loading'
    const tree = await client!.stones.tree({ includeTrashed: false })
    const suppliers =
      tree.node !== null && tree.node.kind === 'dir'
        ? tree.node.children.filter((child) => child.kind === 'dir').map((child) => child.name)
        : []
    const loaded: WarehouseSection[] = []
    for (const supplier of suppliers) {
      loaded.push({ supplier, state: 'loading', cells: [], filter: {}, collapsed: false })
    }
    sections = loaded
    sectionsState = 'ready'
    await Promise.all(
      suppliers.map(async (supplier, index) => {
        const cells = await loadSupplierCells(supplier)
        const current = sections[index]
        if (current === undefined || current.supplier !== supplier) return
        sections[index] = { ...current, cells, state: 'ready' }
      }),
    )
  })
  if (sectionsState !== 'ready') sectionsState = 'error'
}

/** 供应商全量 cell：stones.list 翻页聚合（tuzuan 623 量级 → 4 页）。 */
async function loadSupplierCells(supplier: string): Promise<StoneGridCell[]> {
  const pageSize = 200
  const out: StoneGridCell[] = []
  let page = 1
  for (;;) {
    const result = await client!.stones.list({ supplier, page, pageSize, includeTrashed: false })
    out.push(...result.cells)
    if (out.length >= result.total || result.cells.length === 0 || page > 50) break
    page += 1
  }
  return out
}

export async function setSectionFilter(supplier: string, patch: Partial<WarehouseSectionFilter>): Promise<void> {
  const index = sections.findIndex((s) => s.supplier === supplier)
  if (index === -1) return
  const current = sections[index]!
  sections[index] = { ...current, filter: { ...current.filter, ...patch } }
}

export function clearSectionFilter(supplier: string): void {
  void setSectionFilter(supplier, { family: undefined, sizeMm: undefined, q: undefined })
}

export function toggleSectionCollapsed(supplier: string): void {
  const index = sections.findIndex((s) => s.supplier === supplier)
  if (index === -1) return
  const current = sections[index]!
  sections[index] = { ...current, collapsed: !current.collapsed }
}

// ---------------------------------------------------------------- 选择集（staged）

/** 点选 toggle（进出选择集——Ctrl 累加同式：toggle 语义对单元素等价）。 */
export function toggleWarehouseCell(resourceId: string): void {
  if (selection.has(resourceId)) selection.delete(resourceId)
  else selection.add(resourceId)
}

/** 框选 commit（命中并集累加——跨标准持续可见，不清既有选择）。 */
export function addWarehouseSelection(resourceIds: readonly string[]): void {
  for (const id of resourceIds) selection.add(id)
}

export function clearWarehouseSelection(): void {
  selection.clear()
}

// ---------------------------------------------------------------- 集合草稿

/** 添加所选到集合（Owner「选择→添加到集合」——已成员跳过；catalog cell 即时投影）。 */
export function addSelectedToSet(): number {
  let added = 0
  for (const resourceId of [...selection]) {
    if (draftMembers.has(resourceId)) continue
    const cell = getWarehouseCatalogCell(resourceId)
    if (cell === undefined) continue
    draftMembers.set(resourceId, memberFromCell(cell))
    added += 1
  }
  return added
}

/** 从集合移除所选（双向动作的删向——仅作用于已是成员的所选）。 */
export function removeSelectedFromSet(): number {
  let removed = 0
  for (const resourceId of [...selection]) {
    if (draftMembers.delete(resourceId)) removed += 1
  }
  return removed
}

export function removeWarehouseMember(stoneRef: string): void {
  draftMembers.delete(stoneRef)
}

/** 数量行内编辑（null=清除→「按设计用量另计」；非正整数拒收不变）。 */
export function setWarehouseMemberQuantity(stoneRef: string, value: number | null): void {
  const member = draftMembers.get(stoneRef)
  if (member === undefined) return
  if (value === null) {
    const next = { ...member }
    delete next.quantity
    draftMembers.set(stoneRef, next)
    return
  }
  if (!Number.isInteger(value) || value <= 0) return
  draftMembers.set(stoneRef, { ...member, quantity: value })
}

export function setWarehouseMemberNote(stoneRef: string, value: string | null): void {
  const member = draftMembers.get(stoneRef)
  if (member === undefined) return
  const next = { ...member }
  if (value === null || value === '') delete next.note
  else next.note = value
  draftMembers.set(stoneRef, next)
}

export function setWarehouseDraftName(name: string): void {
  draftName = name
}

export function setWarehouseDraftPurpose(purpose: string): void {
  draftPurpose = purpose
}

// ---------------------------------------------------------------- 切换器 / 装载

export async function refreshSetsList(): Promise<void> {
  if (!client) return
  await guard(async () => {
    setsListState = 'loading'
    const result = await client!.sets.list({ includeTrashed: true, pageSize: 200 })
    // 活跃组合在前、回收站在尾（软删=只读呈现，S3.3 回收站形态）。
    setsList = [...result.sets].sort((a, b) => Number(a.trashed) - Number(b.trashed))
    setsListState = 'ready'
  })
  if (setsListState !== 'ready') setsListState = 'error'
}

/** 切换组合（null=新建草稿）。装载=sets.get 读时解析（限定名/缺失态真源）。 */
export async function switchWarehouseSet(resourceId: string | null): Promise<void> {
  if (!client) return
  if (resourceId === null) {
    activeSetId = null
    activeSetTrashed = false
    draftName = ''
    draftPurpose = ''
    draftMembers.clear()
    snapshot = null
    baseRevision = null
    staleDrift = false
    return
  }
  await guard(async () => {
    const detail = await client!.sets.get(resourceId)
    activeSetId = resourceId
    activeSetTrashed = detail.trashed
    baseRevision = detail.revision
    staleDrift = false
    draftName = detail.set.name
    draftPurpose = detail.set.purpose ?? ''
    // 就地清+填（SvelteMap 变更可追踪；重赋变量会断开既有 derived 订阅）。
    draftMembers.clear()
    for (const resolution of detail.members) draftMembers.set(resolution.stoneRef, memberFromResolution(resolution))
    snapshot = {
      name: detail.set.name,
      ...(detail.set.purpose !== undefined ? { purpose: detail.set.purpose } : {}),
      members: detail.members.map((m) => ({
        stoneRef: m.stoneRef,
        ...(m.quantity !== undefined ? { quantity: m.quantity } : {}),
        ...(m.note !== undefined ? { note: m.note } : {}),
      })),
    }
  })
}

/** CAS 漂移后的显式重载（丢弃本地草稿编辑——用户确认动作，非静默覆写）。 */
export async function reloadAfterDrift(): Promise<void> {
  if (activeSetId === null) return
  await switchWarehouseSet(activeSetId)
}

// ---------------------------------------------------------------- 保存面

/** 新建组合（manual-pick——S7.4 人工直发写面）。成功后切到新组合（canonical 解析）。 */
export async function saveNewWarehouseSet(): Promise<void> {
  if (!client) return
  const name = draftName.trim()
  if (name === '') {
    storeError = '组合名不能为空'
    return
  }
  if (draftMembers.size === 0) {
    storeError = '组合至少一个成员（空组合无生产语义——§7.1）'
    return
  }
  await guard(async () => {
    saving = true
    const created = await client!.sets.create({
      name,
      ...(draftPurpose.trim() !== '' ? { purpose: draftPurpose.trim() } : {}),
      members: plainMembers(),
      origin: { kind: 'manual-pick' },
    })
    saving = false
    await refreshSetsList()
    await switchWarehouseSet(created.resourceId)
  })
  if (saving) saving = false
}

/** 改既有组合（成员增删/数量/备注/改名——baseRevision CAS；漂移→提示态不盲写）。 */
export async function saveWarehouseChanges(): Promise<void> {
  if (!client || activeSetId === null || snapshot === null || baseRevision === null) return
  if (staleDrift) return // 漂移后盲写防线——必须先刷新重载
  if (draftMembers.size === 0) {
    storeError = '组合至少一个成员（删空请走删除组合）'
    return
  }
  const patch = buildUpdatePatch(snapshot, {
    name: draftName,
    purpose: draftPurpose === '' ? undefined : draftPurpose,
    members: plainMembers(),
  })
  if (patch === null) return
  await guard(async () => {
    saving = true
    try {
      await client!.sets.update({ resourceId: activeSetId!, baseRevision: baseRevision!, patch })
    } catch (error) {
      saving = false
      if (isRevisionConflict(error)) {
        // 漂移：本地草稿保留（用户可对照），提示刷新重载——不盲写不静默覆写。
        staleDrift = true
        return
      }
      throw error
    }
    saving = false
    // 成功：重装载 canonical 解析（revision/限定名/缺失态刷新+快照重冻结）。
    await switchWarehouseSet(activeSetId!)
    await refreshSetsList()
  })
  if (saving) saving = false
}

/** 软删组合（回收站语义——成员弱引用零变更）；成功后回落新建草稿。 */
export async function softDeleteActiveWarehouseSet(): Promise<void> {
  if (!client || activeSetId === null || activeSetTrashed) return
  await guard(async () => {
    saving = true
    await client!.sets.delete(activeSetId!)
    saving = false
    await refreshSetsList()
    await switchWarehouseSet(null)
  })
  if (saving) saving = false
}
