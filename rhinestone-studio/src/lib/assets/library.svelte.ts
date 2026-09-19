/**
 * 素材库 UI 数据层（add-asset-library tasks 2.1-2.4 / 3.1）：
 * assetStore 之上的响应式投影 + 文件操作编排（toast 反馈在动作完成处收口）。
 *
 * 正交意图：
 * 1. [2026-09-19 State] 节点全集 + objectURL 解析缓存（$state；refresh 全量重读，url 逐节点补齐）。
 * 2. [2026-09-19 Migration] ensureLibraryReady：启动迁移幂等触发 + 迁移态（顶部细进度条依据）。
 * 3. [2026-09-19 Selectors] 派生查询：childrenOf/pathOf/回收站与生成结果计数/存储估算/引用计数/最近集合。
 * 4. [2026-09-19 Ops] 文件操作编排：上传（三段式失败 toast / 重名后缀不打断 / 已在库中回报）、
 *    新建/重命名/移动/递归软删/清空（引用保护明细回报）/下载。
 * 5. [2026-09-19 Tests] 测试复位与迁移态注入。
 */

import {
  createFolder,
  emptyTrash,
  getDownloadSource,
  ingestAsset,
  listAllNodes,
  listContentHashes,
  moveAsset,
  objectUrlForAsset,
  renameAsset,
  runAssetMigration,
  trashAsset,
  type AssetFolder,
  type AssetImage,
  type AssetMigrationReport,
  type AssetNode,
  type ContentRecord,
  type EmptyTrashResult,
} from '$lib/persistence/assetStore'
import { showToast } from '$lib/stores/toast.svelte'

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let nodes = $state<AssetNode[]>([])
/** assetId → objectURL（undefined=未解析，null=blob 已失效，string=可渲染）。 */
let urls = $state<Record<string, string | null>>({})
let contentRecords = $state<ContentRecord[]>([])
let ready = $state(false)
let migrationRunning = $state(false)
let migrationReport = $state<AssetMigrationReport | null>(null)
let readyPromise: Promise<void> | null = null

// ---------------------------------------------------------------------------
// 迁移与刷新
// ---------------------------------------------------------------------------

/** 首次触达即跑启动迁移（幂等，并发共享同一轮）；迁移态供 AssetsView 进度条消费。
 * 失败静默保留可重跑态（下次进入视图重试；弹 toast 会因 Tabs 惰性挂载在各视图重复打扰）。 */
export function ensureLibraryReady(): Promise<void> {
  if (!readyPromise) {
    migrationRunning = true
    readyPromise = (async () => {
      try {
        migrationReport = await runAssetMigration()
        await refresh()
        ready = true
      } catch {
        // 失败保留可重跑态：迁移本身幂等（如 jsdom 无 IndexedDB 的冒烟环境）。
        readyPromise = null
      } finally {
        migrationRunning = false
      }
    })()
  }
  return readyPromise
}

export async function refresh(): Promise<void> {
  const [all, records] = await Promise.all([listAllNodes(), listContentHashes()])
  nodes = all
  contentRecords = records
  await resolveUrls(all)
}

/** 图片节点逐个解析 objectURL（external 原样；blob 缺失 → null「已失效」）。 */
async function resolveUrls(list: AssetNode[]): Promise<void> {
  const next = { ...urls }
  await Promise.all(
    list
      .filter((n): n is AssetImage => n.type === 'image' && n.trashedAt === undefined)
      .map(async (node) => {
        if (!(node.id in next)) next[node.id] = await objectUrlForAsset(node.id)
      }),
  )
  urls = next
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function getNodes(): AssetNode[] {
  return nodes
}

export function getUrl(assetId: string): string | null | undefined {
  return urls[assetId]
}

export function isReady(): boolean {
  return ready
}

export function isMigrationRunning(): boolean {
  return migrationRunning
}

export function getMigrationReport(): AssetMigrationReport | null {
  return migrationReport
}

export function nodeById(id: string | null): AssetNode | null {
  if (id === null) return null
  return nodes.find((n) => n.id === id) ?? null
}

/** 直系子节点（文件夹置顶，图片按 updatedAt 降序；软删项不出现）。 */
export function childrenOf(parentId: string | null): AssetNode[] {
  return nodes
    .filter((n) => n.parentId === parentId && trashedAtOf(n) === undefined)
    .sort((a, b) => (a.type === b.type ? b.updatedAt - a.updatedAt : a.type === 'folder' ? -1 : 1))
}

/** 回收站内容（软删节点按入站时间倒序）。 */
export function trashedNodes(): AssetNode[] {
  return nodes
    .filter((n) => trashedAtOf(n) !== undefined)
    .sort((a, b) => (trashedAtOf(b) ?? 0) - (trashedAtOf(a) ?? 0))
}

export function trashCount(): number {
  return nodes.filter((n) => trashedAtOf(n) !== undefined).length
}

/** 软删时间戳（递归软删在运行时也给文件夹打 trashedAt；类型上仅 AssetImage 声明，同 assetStore 内部口径）。 */
function trashedAtOf(node: AssetNode): number | undefined {
  return (node as { trashedAt?: number }).trashedAt
}

/** 生成结果计数 = sys-generated 子树内图片数（徽标）。 */
export function generatedCount(): number {
  return descendantsOf('sys-generated').filter((n) => n.type === 'image' && trashedAtOf(n) === undefined).length
}

/** 存储估算 = Σ ContentRecord.bytes（内容寻址天然去重）。 */
export function storageBytes(): number {
  return contentRecords.reduce((acc, record) => acc + record.bytes, 0)
}

/** 「N 处引用」：同 blobKey 的节点数（符号链接共存，含回收站内）。 */
export function referenceCountOf(asset: AssetImage): number {
  if (asset.refKind !== 'blob' || !asset.blobKey) return 1
  return nodes.filter(
    (n) => n.type === 'image' && n.refKind === 'blob' && n.blobKey === asset.blobKey,
  ).length
}

/** 面包屑链（path 为派生量：parentId 链现算）。 */
export function pathOf(folderId: string | null): AssetFolder[] {
  const chain: AssetFolder[] = []
  let cursor = folderId
  let guard = 0
  while (cursor !== null && guard < 64) {
    guard += 1
    const node = nodes.find((n) => n.id === cursor)
    if (!node || node.type !== 'folder') break
    chain.unshift(node)
    cursor = node.parentId
  }
  return chain
}

/** 「最近」集合：updatedAt 降序前 24（选图最高频动线是「刚生成/刚传的那张」；内置案例有独立集合，不混入）。 */
export function recentAssets(limit = 24): AssetImage[] {
  return nodes
    .filter((n): n is AssetImage => n.type === 'image' && trashedAtOf(n) === undefined && n.source !== 'preset')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

/** 空库判定：除系统目录与内置案例外无任何节点（引导卡依据；项目节点暂不计入，type-aware 化见 1.4/4.2 切片）。 */
export function isLibraryEmpty(): boolean {
  return !nodes.some((n) => (n.type === 'folder' ? n.system === undefined : n.type === 'image' && n.source !== 'preset'))
}

/** 全部可见项数（非软删、不含系统目录本身；状态条「共 N 项」）。 */
export function visibleItemCount(): number {
  return nodes.filter((n) => trashedAtOf(n) === undefined && n.type === 'folder' && n.system === undefined).length +
    nodes.filter((n) => trashedAtOf(n) === undefined && n.type === 'image').length
}

/** 子树统计（含根本身；用于删除确认「N 图 M 夹」）。 */
export function subtreeStats(rootId: string): { images: number; folders: number } {
  const root = nodes.find((n) => n.id === rootId)
  const all = [...(root ? [root] : []), ...descendantsOf(rootId)]
  return {
    images: all.filter((n) => n.type === 'image').length,
    folders: all.filter((n) => n.type === 'folder').length,
  }
}

/** 是否为系统目录节点。 */
export function isSystemFolderNode(node: AssetNode | null): node is AssetFolder & { system: string } {
  return node !== null && node.type === 'folder' && node.system !== undefined
}

function descendantsOf(rootId: string): AssetNode[] {
  const byParent = new Map<string | null, AssetNode[]>()
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? []
    list.push(node)
    byParent.set(node.parentId, list)
  }
  const collected: AssetNode[] = []
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const node of byParent.get(current) ?? []) {
      collected.push(node)
      if (node.type === 'folder') queue.push(node.id)
    }
  }
  return collected
}

// ---------------------------------------------------------------------------
// 文件操作编排（design §4 + PM §2.3 状态矩阵）
// ---------------------------------------------------------------------------

export interface UploadOutcome {
  created: AssetImage[]
  /** 同目录同内容去重命中的既有条目（调用方 toast「已在库中」+ 定位）。 */
  duplicates: AssetImage[]
  /** 落点目录（快捷集合视图下回退 sys-uploads；定位导航用）。 */
  targetFolderId: string | null
}

/** 上传即入库（ingest-on-upload）：MIME 失败三段式 toast、重名后缀不打断、不锁死后续文件。 */
export async function uploadFiles(
  files: Iterable<File>,
  parentId: string | null,
): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { created: [], duplicates: [], targetFolderId: parentId }
  for (const file of files) {
    try {
      const { width, height } = await measureImageSize(file)
      const result = await ingestAsset({
        blob: file,
        name: file.name,
        width,
        height,
        parentId,
        source: 'upload',
      })
      if (result.status === 'in-folder-duplicate') outcome.duplicates.push(result.node)
      else outcome.created.push(result.node)
      if (result.node.name !== file.name) showToast(`「${file.name}」重名，已自动调整为「${result.node.name}」`)
    } catch (error) {
      showToast(uploadFailureMessage(error))
    }
  }
  if (outcome.created.length > 0 || outcome.duplicates.length > 0) await refresh()
  return outcome
}

export async function createFolderOp(parentId: string | null, name = '新建文件夹'): Promise<AssetFolder | null> {
  try {
    const folder = await createFolder(parentId, name)
    if (folder.name !== name) showToast(`同目录已有同名文件夹，已自动调整为「${folder.name}」`)
    await refresh()
    return folder
  } catch (error) {
    showToast(`新建文件夹失败：${errorMessage(error)}`)
    return null
  }
}

export async function renameOp(id: string, name: string): Promise<AssetNode | null> {
  const trimmed = name.trim()
  if (trimmed === '') return null
  try {
    const updated = await renameAsset(id, trimmed)
    await refresh()
    if (updated.name !== trimmed) showToast(`同目录已有同名项，已调整为「${updated.name}」`)
    return updated
  } catch (error) {
    showToast(`重命名失败：${errorMessage(error)}`)
    return null
  }
}

export async function moveOp(ids: string[], target: string | null): Promise<number> {
  let moved = 0
  let failure: string | null = null
  for (const id of ids) {
    try {
      await moveAsset(id, target)
      moved += 1
    } catch (error) {
      failure = errorMessage(error)
    }
  }
  if (moved > 0) await refresh()
  if (failure) showToast(`部分项目未移动：${failure}`)
  return moved
}

/** 递归软删（确认框由调用方先算 subtreeStats 呈现）。 */
export async function trashOp(ids: string[]): Promise<number> {
  let trashed = 0
  let failure: string | null = null
  for (const id of ids) {
    try {
      trashed += await trashAsset(id)
    } catch (error) {
      failure = errorMessage(error)
    }
  }
  if (failure) showToast(`部分项目未删除：${failure}`)
  await refresh()
  return trashed
}

/** 清空回收站（硬删 + 引用保护跳过明细由调用方呈报）。 */
export async function emptyTrashOp(): Promise<EmptyTrashResult | null> {
  try {
    const result = await emptyTrash()
    await refresh()
    return result
  } catch (error) {
    showToast(`清空回收站失败：${errorMessage(error)}`)
    return null
  }
}

/** 下载原 blob（getDownloadSource 冻结出口；文件夹 zip = P2 不做）。 */
export async function downloadOp(ids: string[]): Promise<number> {
  let downloaded = 0
  for (const id of ids) {
    const source = await getDownloadSource(id)
    if (!source) continue
    const anchor = document.createElement('a')
    anchor.href = source.url
    anchor.download = source.node.name.includes('.')
      ? source.node.name
      : `${source.node.name}.${extensionOf(source.node.mime)}`
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    downloaded += 1
  }
  return downloaded
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 解码取宽高；失败（极端环境/损坏图）回退 0×0 不阻断入库。 */
async function measureImageSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') return { width: 0, height: 0 }
  try {
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return { width: 0, height: 0 }
  }
}

/** 三段式（发生了什么 / 为何 / 怎么办）；未入库不留半节点由 ingestAsset 单事务保证。 */
function uploadFailureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '上传失败：浏览器存储空间不足。该图片未入库、无残留。请先到回收站清理后重试。'
  }
  return `上传失败：${errorMessage(error)}。该图片未入库；请换一张 PNG / JPEG / WebP 后重试。`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extensionOf(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

// ---------------------------------------------------------------------------
// 测试专用
// ---------------------------------------------------------------------------

export function resetLibraryForTests(): void {
  nodes = []
  urls = {}
  contentRecords = []
  ready = false
  migrationRunning = false
  migrationReport = null
  readyPromise = null
}

/** 迁移态注入（七态「迁移进行中」细进度条的确定性测试）。 */
export function setMigrationRunningForTests(running: boolean): void {
  migrationRunning = running
}
