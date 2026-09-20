/**
 * 任务画廊并集 store（openspec add-project-files 4.5，design §7.3/§9.2 B7 + 补充稿 §B.2/§B.3）。
 *
 * 正交意图：
 * 1. [2026-09-19 Union] GalleryEntry 并集模型（B7 身份冻结）：数据面 = 会话任务（活账本）
 *    ∪ 库内 gemgen（未软删、未被任何 task.assetId 认领）；key 冻结 `asset:<id>` / `task:<id>`，
 *    活任务状态覆盖只读投影（precedence 活任务 > 库档案）；活任务指向缺失/非 gemgen 节点 →
 *    按活任务态展示 + 缺失角标；库源 runId 取 provenance.runId；legacy（无 templateAssetId）
 *    只进「全部」；重试产新档旧档按 createdAt 降序并存（assetId 身份之外不去重）。
 * 2. [2026-09-19 Chips] 过滤态自持（会话内存，浏览意图——与左面板编辑焦点两概念）：
 *    '__all__' | templateAssetId | '__deleted__'（孤儿聚合，仅存在孤儿 entry 时出现 chip）；
 *    过滤后仍按 runId 组建（分组算法沿 lab 旧 getTaskGroups：组间最新在前、组内发起序、
 *    批次总序号在**未过滤全集**上编号——过滤切换不重编号）。
 * 3. [2026-09-19 TwoState] 卡片展开集合 = 会话内存（模块 $state：切视图保留、刷新复位整洁默认）；
 *    批次组折叠态同口径收纳于此；只读卡 imageUrl 经 getGemgenImageBlob 异步解析 + 会话缓存
 *    （序号守卫防过时回写）。
 *
 * 边界：不 import Svelte 组件；lab store 只读消费（getTasks/clearHistory/sendToStudio），
 * templates store 只读消费（列表序 = chips 排序源）；库扫描自驱（refreshGallery 直读
 * listAllNodes，不依赖素材库视图挂载）。4.6 openIntent 消费接缝见文件尾注释。
 */

import {
  getAssetBlob,
  listAllNodes,
  trashAsset,
  type AssetNode,
  type AssetNodeId,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { getGemgenImageBlob } from '$lib/persistence/handoffImage'
import { parseGemgen, type GemgenFile } from '$lib/persistence/labFile'
import type { AssetProject } from '$lib/persistence/projectTypes'
import { LEGACY_RUN_ID } from '$lib/persistence/taskStore'
import {
  clearHistory,
  getTasks,
  getReference,
  sendToStudio,
  type LabTask,
  type TaskStatus,
} from './lab.svelte'
import { getTemplateAssetIds, getTemplateRecord, isTemplatesReady } from './templates.svelte'
import { setHandoff } from './handoff.svelte'
import { showToast } from './toast.svelte'

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 过滤态哨兵（templateAssetId 恒为 'ast-' 前缀，命名空间不冲突）。 */
export const GALLERY_FILTER_ALL = '__all__'
/** 「已删模板」聚合过滤键（templateAssetId 不在模板列表的孤儿 entry）。 */
export const GALLERY_FILTER_DELETED = '__deleted__'

export type GalleryFilter = string

/**
 * 画廊条目（会话任务活卡 / 库内 gemgen 只读卡的统一投影）。
 * key 冻结（B7）：有 assetId → `asset:<id>`（同 id 活任务覆盖只读投影）；无 → `task:<id>`。
 */
export interface GalleryEntry {
  key: string
  /** true = 会话任务活卡（可交互：取消/重试/复用参数）；false = 库来源只读卡（角标「库」）。 */
  live: boolean
  /** 活任务本体（live=true 时非空；动作行经 lab store 原 API 消费）。 */
  task?: LabTask
  /** 生成结果档案节点 id（活任务 = task.assetId；只读卡 = gemgen 节点 id）。 */
  assetId?: AssetNodeId
  /** 活任务 assetId 指向缺失/非 gemgen/已软删节点（库扫描完成后才判；缺失角标）。 */
  assetMissing?: boolean
  /** 模板过滤键（活 = 任务快照；只读 = provenance；legacy = undefined 仅进「全部」）。 */
  templateAssetId?: string
  /** 模板名快照（模板已删时的显示兜底）。 */
  templateName: string
  /** 批次分组键（活 = task.runId；只读 = provenance.runId，缺省归 legacy 合成组）。 */
  runId: string
  candidateIndex: number
  /** 活 = 任务态；只读 = 固定 'success' 投影。 */
  status: TaskStatus
  /** 排序键（活 = task.createdAt；只读 = 档案 createdAt = 任务发起时刻）。 */
  createdAt: number
  /** 参考原图资产 id（对比器参考图解析兜底；活 = task 快照，只读 = provenance）。 */
  referenceAssetId?: string
  /** 提示词全文快照（审计展示；只读卡从 provenance 取）。 */
  composedPrompt?: string
  /** 只读卡档案解析失败（损坏/版本超前 → 卡片占位「档案无法读取」）。 */
  parseError?: string
}

/** 画廊分组 = 批次（runId）：算法沿 lab 旧 getTaskGroups（组间最新在前、组内发起序）。 */
export interface GalleryGroup {
  runId: string
  /** legacy 合成组（组头「更早」，不参与「第 N 次运行」编号）。 */
  legacy: boolean
  /** 批次总序号（1 起，按创建先后；在未过滤全集上编号——过滤不重编号；legacy 为 undefined）。 */
  runIndex?: number
  /** 组内最早 entry createdAt（组头 HH:mm 显示用）。 */
  startedAt: number
  /** 组内最新 entry createdAt（组间逆序排序键）。 */
  latestCreatedAt: number
  /** 组内条目，createdAt 升序 = 发起顺序稳定。 */
  entries: GalleryEntry[]
}

/** 画廊头部单选 chip（浏览意图过滤；chips = 过滤态外显）。 */
export interface GalleryChip {
  filter: GalleryFilter
  label: string
  count: number
  /** 「已删模板」聚合 chip 的成员模板名快照（title 提示用，按名排序）。 */
  orphanTemplateNames?: string[]
}

/** 库内 gemgen 扫描记录（解析产物缓存；blobKey 不变不重解析——gemgen 不可变，恒命中）。 */
interface GemgenRecord {
  node: AssetProject
  file: GemgenFile | null
  parseError: string | null
}

// ---------------------------------------------------------------------------
// 模块状态（全部会话内存；刷新 = 整体复位回整洁默认）
// ---------------------------------------------------------------------------

let gemgenRecords = $state<Record<string, GemgenRecord>>({})
/** 库扫描是否完成过（assetMissing 只在完成后判定，防扫描前误报）。 */
let scanned = $state(false)
/** 过滤态（chips 自持；'__all__' 初始）。 */
let filter = $state<GalleryFilter>(GALLERY_FILTER_ALL)
/** 卡片展开集合（key = entry.key）。 */
let expandedKeys = $state<Record<string, boolean>>({})
/** 批次组折叠态（key = runId；沿旧 TaskQueue 组件内先例上移为会话内存）。 */
let collapsedRuns = $state<Record<string, boolean>>({})
/** 只读卡 imageUrl 会话缓存：assetId → objectURL（null = 解析失败占位）。 */
let readonlyUrls = $state<Record<string, string | null>>({})
/** 异步解析竞态序号守卫（过时回写丢弃）。 */
const readonlyUrlSeq = new Map<string, number>()
const readonlyUrlJobs = new Map<string, Promise<void>>()
/** 本 store 创建的 objectURL（reset 时统一回收；解析失败缓存 null 不占 URL）。 */
const createdUrls = new Set<string>()
/** 对比器参考图解析缓存（referenceAssetId → objectURL / null=失败）。 */
const referenceUrls = new Map<string, string | null>()
/** scheduleGalleryRefresh 合并位。 */
let refreshScheduled = false

// ---------------------------------------------------------------------------
// 库扫描（gemgen 投影）
// ---------------------------------------------------------------------------

async function parseGemgenRecord(node: AssetProject): Promise<GemgenRecord> {
  try {
    const blob = await getImageBlob(node.blobKey)
    if (blob === null) throw new Error('档案字节缺失（物理记录丢失）')
    const file = parseGemgen(await blob.text(), { mime: node.mime })
    return { node, file, parseError: null }
  } catch (error) {
    return { node, file: null, parseError: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 全量重扫库内 gemgen（hydrate/挂载/任务指纹变化/清空历史后调用）：
 * - 只收未软删的 gemgen 项目节点（任意目录——导入到用户目录的 gemgen 同样有家）；
 * - blobKey 不变复用既有解析（gemgen 不可变 → 稳定命中）；
 * - 消失节点（软删/硬清）的只读 url 缓存随记录一并回收。
 * IDB 不可用 → 静默保留旧投影（scanned 不置位，assetMissing 不误报）。
 */
export async function refreshGallery(): Promise<void> {
  let nodes: AssetNode[]
  try {
    nodes = await listAllNodes()
  } catch {
    return
  }
  const next: Record<string, GemgenRecord> = {}
  for (const node of nodes) {
    if (node.type !== 'project' || node.projectKind !== 'gemgen' || node.trashedAt !== undefined) continue
    const prev = gemgenRecords[node.id]
    if (prev && prev.node.blobKey === node.blobKey) {
      next[node.id] = prev
      continue
    }
    next[node.id] = await parseGemgenRecord(node)
  }
  for (const id of Object.keys(gemgenRecords)) {
    if (id in next) continue
    const url = readonlyUrls[id]
    if (url) {
      URL.revokeObjectURL(url)
      createdUrls.delete(url)
    }
    delete readonlyUrls[id]
  }
  gemgenRecords = next
  scanned = true
}

/** 合并式刷新调度（同 tick 多次触发只跑一轮；供组件 $effect 消费）。 */
export function scheduleGalleryRefresh(): void {
  if (refreshScheduled) return
  refreshScheduled = true
  setTimeout(() => {
    refreshScheduled = false
    void refreshGallery()
  }, 0)
}

// ---------------------------------------------------------------------------
// 并集模型（B7）
// ---------------------------------------------------------------------------

/**
 * 会话任务 ∪ 库内 gemgen（活任务覆盖只读投影）：
 * - 活任务：assetId 认领库内同 id gemgen（去重键 `task.assetId === gemgen.id`）；
 *   指向缺失/非 gemgen 节点 → 按活任务态展示 + assetMissing 角标（仅扫描完成后判定）；
 * - 只读投影：未被认领的库内 gemgen（localStorage 50 条裁剪史洞由库补全、导入档案亦有家）；
 *   解析失败 → parseError 占位（templateName/candidateIndex 取 summary 展示缓存兜底），
 *   runId 不可考 → 归 legacy 合成组（「更早」）。
 */
export function getGalleryEntries(): GalleryEntry[] {
  const tasks = getTasks()
  const claimed = new Set<string>()
  const entries: GalleryEntry[] = []
  for (const task of tasks) {
    if (task.assetId !== undefined) claimed.add(task.assetId)
    entries.push({
      key: task.assetId !== undefined ? `asset:${task.assetId}` : `task:${task.id}`,
      live: true,
      task,
      assetId: task.assetId,
      assetMissing:
        scanned && task.assetId !== undefined && !(task.assetId in gemgenRecords),
      templateAssetId: task.templateAssetId,
      templateName: task.variantName,
      runId: task.runId,
      candidateIndex: task.candidateIndex,
      status: task.status,
      createdAt: task.createdAt,
      referenceAssetId: task.referenceAssetId,
      composedPrompt: task.composedPrompt,
    })
  }
  for (const id of Object.keys(gemgenRecords)) {
    if (claimed.has(id)) continue // 活任务覆盖只读投影（B7 precedence）
    const record = gemgenRecords[id]
    const file = record.file
    entries.push({
      key: `asset:${id}`,
      live: false,
      assetId: id,
      templateAssetId: file?.provenance.templateAssetId,
      templateName:
        file?.provenance.templateName ?? record.node.summary.templateName ?? record.node.name,
      runId: file?.provenance.runId ?? LEGACY_RUN_ID,
      candidateIndex: file?.provenance.candidateIndex ?? record.node.summary.candidateIndex ?? 0,
      status: 'success',
      createdAt: file?.createdAt ?? record.node.createdAt,
      referenceAssetId: file?.provenance.referenceAssetId,
      composedPrompt: file?.provenance.composedPrompt,
      ...(record.parseError !== null ? { parseError: record.parseError } : {}),
    })
  }
  return entries
}

export function getGalleryEntry(key: string): GalleryEntry | undefined {
  return getGalleryEntries().find((entry) => entry.key === key)
}

/** 4.6 双击 gemgen 定位接缝：assetId → entry（含活任务覆盖态）。 */
export function findEntryByAssetId(assetId: string): GalleryEntry | undefined {
  return getGalleryEntries().find((entry) => entry.assetId === assetId)
}

function entryMatchesFilter(entry: GalleryEntry, active: GalleryFilter, templateIds: string[]): boolean {
  if (active === GALLERY_FILTER_ALL) return true
  // legacy（无 templateAssetId）只在「全部」出现（B.2.2）
  if (entry.templateAssetId === undefined) return false
  if (active === GALLERY_FILTER_DELETED) return templateIds.length > 0 && !templateIds.includes(entry.templateAssetId)
  return entry.templateAssetId === active
}

/**
 * 过滤后仍按 runId 组建（B.2.1）：组结构/排序/编号算法沿 lab 旧 getTaskGroups——
 * 批次总序号在**未过滤全集**上按创建先后编号（过滤切换不重编号），过滤只裁组内
 * entry 并丢弃空组（「过滤=某模板时：仅含该模板卡片的批次序列」）。
 */
export function getGalleryGroups(active?: GalleryFilter): GalleryGroup[] {
  const effective = active ?? filter
  const byRun = new Map<string, GalleryGroup>()
  for (const entry of getGalleryEntries()) {
    let group = byRun.get(entry.runId)
    if (!group) {
      group = {
        runId: entry.runId,
        legacy: entry.runId === LEGACY_RUN_ID,
        startedAt: entry.createdAt,
        latestCreatedAt: entry.createdAt,
        entries: [],
      }
      byRun.set(entry.runId, group)
    }
    group.entries.push(entry)
    if (entry.createdAt < group.startedAt) group.startedAt = entry.createdAt
    if (entry.createdAt > group.latestCreatedAt) group.latestCreatedAt = entry.createdAt
  }
  const chronological = [...byRun.values()].sort((a, b) => a.latestCreatedAt - b.latestCreatedAt)
  let runNumber = 0
  for (const group of chronological) {
    group.entries.sort((a, b) => a.createdAt - b.createdAt)
    if (!group.legacy) {
      runNumber += 1
      group.runIndex = runNumber
    }
  }
  chronological.reverse()
  if (effective === GALLERY_FILTER_ALL) return chronological
  const templateIds = getTemplateAssetIds()
  return chronological
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => entryMatchesFilter(entry, effective, templateIds)),
    }))
    .filter((group) => group.entries.length > 0)
}

// ---------------------------------------------------------------------------
// chips（过滤态外显；排序 = sys-templates 列表序，尾部聚合「已删模板」）
// ---------------------------------------------------------------------------

export function getGalleryChips(): GalleryChip[] {
  const entries = getGalleryEntries()
  if (!isTemplatesReady()) return [{ filter: GALLERY_FILTER_ALL, label: '全部', count: entries.length }]
  const templateIds = getTemplateAssetIds()
  const counts = new Map<string, number>()
  const orphanNames = new Set<string>()
  for (const entry of entries) {
    if (entry.templateAssetId === undefined) continue
    counts.set(entry.templateAssetId, (counts.get(entry.templateAssetId) ?? 0) + 1)
    if (!templateIds.includes(entry.templateAssetId)) orphanNames.add(entry.templateName)
  }
  const chips: GalleryChip[] = [{ filter: GALLERY_FILTER_ALL, label: '全部', count: entries.length }]
  for (const id of templateIds) {
    chips.push({
      filter: id,
      label: getTemplateRecord(id)?.name || '未命名模板',
      count: counts.get(id) ?? 0,
    })
  }
  if (orphanNames.size > 0) {
    chips.push({
      filter: GALLERY_FILTER_DELETED,
      label: '已删模板',
      count: [...entries].filter(
        (entry) =>
          entry.templateAssetId !== undefined && !templateIds.includes(entry.templateAssetId),
      ).length,
      orphanTemplateNames: [...orphanNames].sort(),
    })
  }
  return chips
}

export function getGalleryFilter(): GalleryFilter {
  return filter
}

/** 过滤态外部设置口（chips 点击 / 4.6 openIntent 动线共用）。 */
export function setGalleryFilter(next: GalleryFilter): void {
  filter = next
}

// ---------------------------------------------------------------------------
// 卡片两态：展开集合 + 批次组折叠（均会话内存）
// ---------------------------------------------------------------------------

export function isEntryExpanded(key: string): boolean {
  return expandedKeys[key] === true
}

export function toggleEntryExpanded(key: string): void {
  expandedKeys[key] = !expandedKeys[key]
}

/** 4.6 定位-展开接缝：目标卡加入展开集合（不动其他卡）。 */
export function expandEntry(key: string): void {
  expandedKeys[key] = true
}

export function isRunCollapsed(runId: string): boolean {
  return collapsedRuns[runId] === true
}

export function toggleRunCollapsed(runId: string): void {
  collapsedRuns[runId] = !collapsedRuns[runId]
}

/** 4.6 定位接缝：目标组折叠先展开（不动其他组）。 */
export function expandRun(runId: string): void {
  collapsedRuns[runId] = false
}

// ---------------------------------------------------------------------------
// 只读卡 imageUrl 解析（getGemgenImageBlob → objectURL 会话缓存；序号守卫）
// ---------------------------------------------------------------------------

/** undefined = 解析中；null = 解析失败（档案缺失/损坏占位）；string = 可渲染。 */
export function getReadonlyImageUrl(assetId: string): string | null | undefined {
  return readonlyUrls[assetId]
}

/**
 * 幂等触发只读卡 imageUrl 解析（组件挂载/展开时调用）：
 * - 解析失败的历史直接短路（不重试——gemgen 不可变，失败不会自愈）；
 * - 序号守卫：过时轮次的结果丢弃（刷新期间的极端交错）。
 */
export function ensureEntryImageUrl(entry: GalleryEntry): void {
  if (entry.live || entry.assetId === undefined) return
  const assetId = entry.assetId
  if (assetId in readonlyUrls || readonlyUrlJobs.has(assetId)) return
  if (entry.parseError !== undefined) {
    readonlyUrls[assetId] = null // 档案不可解析：直接失败占位（不可变档案不会自愈，不重试）
    return
  }
  const seq = (readonlyUrlSeq.get(assetId) ?? 0) + 1
  readonlyUrlSeq.set(assetId, seq)
  const job = (async (): Promise<void> => {
    try {
      const blob = await getGemgenImageBlob(assetId)
      if (readonlyUrlSeq.get(assetId) !== seq) return
      const url = URL.createObjectURL(blob)
      createdUrls.add(url)
      readonlyUrls[assetId] = url
    } catch {
      if (readonlyUrlSeq.get(assetId) !== seq) return
      readonlyUrls[assetId] = null
    } finally {
      readonlyUrlJobs.delete(assetId)
    }
  })()
  readonlyUrlJobs.set(assetId, job)
}

/** 等待在途解析落定（测试/对话框打开场景）。 */
export async function whenGalleryUrlsIdle(): Promise<void> {
  while (readonlyUrlJobs.size > 0) {
    await Promise.allSettled([...readonlyUrlJobs.values()])
  }
}

// ---------------------------------------------------------------------------
// 对比器参考图解析（会话 reference ?? 任务/档案 referenceAssetId → getAssetBlob）
// ---------------------------------------------------------------------------

/**
 * PreviewDialog 参考图来源扩展（B.2.3）：会话参考图优先（沿用 previewUrl），
 * 兜底 entry.referenceAssetId 经 getAssetBlob 解析为 objectURL（会话缓存）；
 * 两级都不可得 → null（调用方走既有「无参考图」分支）。
 */
export async function resolveEntryReferenceUrl(entry: GalleryEntry): Promise<string | null> {
  const session = getReference()
  if (session) return session.previewUrl
  const assetId = entry.referenceAssetId
  if (assetId === undefined) return null
  if (referenceUrls.has(assetId)) return referenceUrls.get(assetId) ?? null
  const blob = await getAssetBlob(assetId).catch(() => null)
  if (blob === null) {
    referenceUrls.set(assetId, null)
    return null
  }
  const url = URL.createObjectURL(blob)
  createdUrls.add(url)
  referenceUrls.set(assetId, url)
  return url
}

// ---------------------------------------------------------------------------
// 只读卡动作（送排钻 / 下载；活卡动作走 lab store 原 API）
// ---------------------------------------------------------------------------

/** 送排钻统一口：活卡委托 lab.sendToStudio（含入库校验）；只读卡直接以档案资产交接。 */
export async function sendGalleryEntry(key: string): Promise<boolean> {
  const entry = getGalleryEntry(key)
  if (!entry) return false
  if (entry.live) {
    if (!entry.task) return false
    return sendToStudio(entry.task.id)
  }
  if (entry.assetId === undefined || entry.parseError !== undefined) return false
  setHandoff({
    assetId: entry.assetId,
    name: `${entry.templateName}-候选${entry.candidateIndex + 1}.png`,
    ...(entry.referenceAssetId !== undefined ? { referenceAssetId: entry.referenceAssetId } : {}),
  })
  showToast('已送入排钻工作台')
  return true
}

/** 下载统一口：活卡用会话 objectURL；只读卡经 getGemgenImageBlob 取原始字节。 */
export async function downloadGalleryEntry(key: string): Promise<boolean> {
  const entry = getGalleryEntry(key)
  if (!entry) return false
  const name = `${entry.templateName}-候选${entry.candidateIndex + 1}.png`
  let url: string | null = null
  let temporary = false
  if (entry.live) {
    url = entry.task?.imageUrl ?? null
  } else if (entry.assetId !== undefined && entry.parseError === undefined) {
    await whenGalleryUrlsIdle() // 在途解析先落定，避免同档案重复取字节
    const cached = getReadonlyImageUrl(entry.assetId)
    if (cached !== undefined && cached !== null) {
      url = cached
    } else {
      const blob = await getGemgenImageBlob(entry.assetId).catch(() => null)
      if (blob !== null) {
        url = URL.createObjectURL(blob)
        temporary = true
      }
    }
  }
  if (url === null) {
    showToast('下载失败：生成结果字节不可得（档案缺失或已损坏）。')
    return false
  }
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  if (temporary) {
    const finalUrl = url
    setTimeout(() => {
      URL.revokeObjectURL(finalUrl)
      createdUrls.delete(finalUrl)
    }, 30_000)
  }
  return true
}

// ---------------------------------------------------------------------------
// 「清空历史」升级（B.3：并集口径下语义显式化——可选同时软删库内生成结果）
// ---------------------------------------------------------------------------

/** sys-generated 子树内的未软删 gemgen（二次确认计数 + 软删目标）。 */
async function generatedGemgenNodes(): Promise<AssetProject[]> {
  let nodes: AssetNode[]
  try {
    nodes = await listAllNodes()
  } catch {
    return []
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const underGenerated = (node: AssetNode): boolean => {
    let cursor: AssetNode | undefined = node
    let guard = 0
    while (cursor !== undefined && guard < 64) {
      guard += 1
      if (cursor.parentId === 'sys-generated') return true
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    return false
  }
  return nodes.filter(
    (node): node is AssetProject =>
      node.type === 'project' &&
      node.projectKind === 'gemgen' &&
      node.trashedAt === undefined &&
      underGenerated(node),
  )
}

/** 确认 Dialog 二次确认列数量的数据源。 */
export async function countGeneratedGemgens(): Promise<number> {
  return (await generatedGemgenNodes()).length
}

/**
 * 清空历史执行体：先清会话任务账本（lab.clearHistory：取消在途 + 等归档链落定 + 清 meta），
 * 可选同时软删 sys-generated 下 gemgen（进回收站，可还原）；收尾重扫画廊。
 */
export async function clearGalleryHistory(options: { trashGemgens?: boolean } = {}): Promise<void> {
  await clearHistory()
  if (options.trashGemgens === true) {
    const targets = await generatedGemgenNodes()
    let trashed = 0
    let failure: string | null = null
    for (const node of targets) {
      try {
        await trashAsset(node.id)
        trashed += 1
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    if (trashed > 0) showToast(`已将 ${trashed} 个生成结果档案移入回收站`)
    if (failure !== null) showToast(`部分生成结果未能移入回收站：${failure}`)
  }
  await refreshGallery()
}

// ---------------------------------------------------------------------------
// 测试专用（会话内存整体复位；objectURL 统一回收）
// ---------------------------------------------------------------------------

export function resetGalleryForTests(): void {
  gemgenRecords = {}
  scanned = false
  filter = GALLERY_FILTER_ALL
  expandedKeys = {}
  collapsedRuns = {}
  readonlyUrls = {}
  readonlyUrlSeq.clear()
  readonlyUrlJobs.clear()
  for (const url of createdUrls) URL.revokeObjectURL(url)
  createdUrls.clear()
  referenceUrls.clear()
  refreshScheduled = false
}

/*
 * [4.6 接缝清单——本切片不消费，实现冻结口]
 * - entry key → DOM：卡片根节点 `data-testid="gallery-entry"` + `data-entry-key={entry.key}`
 *   （key 形态 `asset:<id>` / `task:<id>`，B7 冻结）；scrollIntoView 目标由此定位。
 * - 过滤态外部设置：setGalleryFilter(templateAssetId | GALLERY_FILTER_ALL)；
 *   定位失败降级（模板已删 → '全部' + toast）归 4.6 动线编排。
 * - 定位-展开：findEntryByAssetId / expandEntry / expandRun（目标组折叠先展开）。
 */
