/**
 * 素材库数据层（虚拟文件系统，openspec add-asset-library design §1-§4）。
 *
 * 正交意图：
 * 1. [2026-09-19 Source] design.md §1 数据契约（AssetNode 树 / path 派生 / 资产不可变 / 环不可能）。
 * 2. [2026-09-19 Resolve] §1.1 解析出口冻结：assetId → blob/objectURL 只经本模块，调用方禁止拼 blob key。
 * 3. [2026-09-19 Dedup] §1.0 内容寻址去重：同字节内容全库一份 blob，AssetImage 节点 = 内容的符号链接。
 * 4. [2026-09-19 Lifecycle] §4 文件操作 + active-reference pin 表：删除/清空单事务，引用保护在 store 层裁决。
 * 5. [2026-09-19 Migration] §3 启动幂等迁移（全部步骤成功才置 flag，失败保留可重跑态）。
 *
 * 约束：纯数据深模块——不 import Svelte 组件；IDB 裸 API（共享 opener 见 imageStore.openDb）。
 */

import { ACCEPTED_IMAGE_MIME_TYPES } from '$lib/api/imageInput'
import {
  ASSET_NODES_STORE,
  CONTENT_HASHES_STORE,
  getImageBlob,
  IMAGES_STORE,
  listImages,
  openDb,
} from '$lib/persistence/imageStore'
import {
  LEGACY_RUN_ID,
  loadTaskMetas,
  loadVariants,
  type PersistedTaskMeta,
} from '$lib/persistence/taskStore'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'

// ---------------------------------------------------------------------------
// 类型（design §1，冻结）
// ---------------------------------------------------------------------------

export type AssetNodeId = string // 'ast-' + crypto.randomUUID()；preset 节点固定 'ast-preset-<presetId>-src' / '-res'
export type SystemFolderId = 'sys-cases' | 'sys-generated' | 'sys-uploads' | 'sys-exports' | 'sys-trash'

export interface AssetNodeBase {
  id: AssetNodeId
  /** 同父内唯一；冲突自动后缀 ' (2)'。 */
  name: string
  /** null = 根层；系统目录固定 null。 */
  parentId: string | null
  createdAt: number
  /** '最近'集合排序键。 */
  updatedAt: number
}

export interface AssetFolder extends AssetNodeBase {
  type: 'folder'
  /** 系统目录：本身禁删/改名/移动；唯 sys-cases 条目完全只读。 */
  system?: SystemFolderId
}

export type AssetSource = 'upload' | 'lab-generate' | 'edit-export' | 'preset' | 'migrated'

export interface AssetMeta {
  runId?: string
  variantName?: string
  candidateIndex?: number
  prompt?: string
  originNote?: string
}

export interface AssetImage extends AssetNodeBase {
  type: 'image'
  refKind: 'blob' | 'external'
  /** refKind='blob'：images store 的物理键（复用不搬）；仅 assetStore 内部触达。 */
  blobKey?: string
  /** refKind='external'：静态资源直址（案例图，不入 IDB）。 */
  externalUrl?: string
  mime: string
  width: number
  height: number
  bytes: number
  source: AssetSource
  meta?: AssetMeta
  /** 非空 = 在回收站（软删）。 */
  trashedAt?: number
}

export type AssetNode = AssetFolder | AssetImage

/** 内容注册表（去重真源，§1.0）：一内容一条。 */
export interface ContentRecord {
  /** SHA-256 hex，keyPath。 */
  hash: string
  /** images store 物理键。 */
  physicalKey: string
  bytes: number
  mime: string
}

// ---------------------------------------------------------------------------
// 错误与常量
// ---------------------------------------------------------------------------

export class AssetStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetStoreError'
  }
}

export const SYSTEM_FOLDER_IDS: readonly SystemFolderId[] = [
  'sys-cases',
  'sys-generated',
  'sys-uploads',
  'sys-exports',
  'sys-trash',
]

const SYSTEM_FOLDER_NAMES: Record<SystemFolderId, string> = {
  'sys-cases': '内置案例',
  'sys-generated': '生成图',
  'sys-uploads': '上传',
  'sys-exports': '导出',
  'sys-trash': '回收站',
}

/** 回收站内建 id（软删目标的逻辑归置位；节点仍保留原 parentId，靠 trashedAt 归类）。 */
export const TRASH_FOLDER_ID: SystemFolderId = 'sys-trash'

/** objectURL LRU 缓存上限（design §2）。 */
export const ASSET_OBJECT_URL_CACHE_LIMIT = 200
let objectUrlCacheLimit = ASSET_OBJECT_URL_CACHE_LIMIT

const MIGRATION_FLAG = 'rhinestone-studio:asset-migration-v2'
const HASH_BACKFILL_FLAG = 'rhinestone-studio:asset-migration-v2-hashes'

function nowMs(): number {
  return Date.now()
}

function newAssetNodeId(): AssetNodeId {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `ast-${crypto.randomUUID()}`
  return `ast-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isSystemFolder(node: AssetNode): node is AssetFolder & { system: SystemFolderId } {
  return node.type === 'folder' && node.system !== undefined
}

/** sys-cases 条目完全只读（design §1/§4）。 */
function isSysCasesEntry(node: AssetNode): boolean {
  return node.parentId === 'sys-cases'
}

// ---------------------------------------------------------------------------
// 事务基建（裸 IDB，请求在 onsuccess 微任务续体里链式下发——idb 库同款模式）
// ---------------------------------------------------------------------------

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败。'))
  })
}

/**
 * 单事务执行器：body 内所有请求同属一个事务；任一请求失败 → 事务中止（写入回滚），
 * promise 拒绝。body 的首个请求必须同步发出（事务激活条件）。
 */
function runTx<T>(storeNames: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction
        try {
          tx = db.transaction(storeNames, mode)
        } catch (error) {
          reject(error)
          return
        }
        let settled = false
        tx.onabort = () => {
          if (!settled) {
            settled = true
            reject(tx.error ?? new AssetStoreError('IndexedDB 事务已中止。'))
          }
        }
        body(tx).then(
          (value) => {
            if (!settled) {
              settled = true
              resolve(value)
            }
          },
          (error) => {
            if (!settled) {
              settled = true
              reject(error)
            }
            try {
              tx.abort()
            } catch {
              // 事务可能已随失败请求中止。
            }
          },
        )
      }),
  )
}

function nodesOf(tx: IDBTransaction): IDBObjectStore {
  return tx.objectStore(ASSET_NODES_STORE)
}

async function getNode(id: string): Promise<AssetNode | null> {
  const db = await openDb()
  const tx = db.transaction([ASSET_NODES_STORE], 'readonly')
  const record = await requestToPromise(nodesOf(tx).get(id))
  return (record as AssetNode | undefined) ?? null
}

/** 同父重名自动后缀 ' (2)'、' (3)'…（design §1/§4）。 */
function uniqueNameAmong(siblings: AssetNode[], desired: string, excludeId?: string): string {
  const taken = new Set(siblings.filter((n) => n.id !== excludeId).map((n) => n.name))
  if (!taken.has(desired)) return desired
  for (let n = 2; ; n += 1) {
    const candidate = `${desired} (${n})`
    if (!taken.has(candidate)) return candidate
  }
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

// ---------------------------------------------------------------------------
// objectURL 统一缓存（design §2：Map<blobKey, url> + LRU 200）
// ---------------------------------------------------------------------------

const objectUrlCache = new Map<string, string>()

function cacheObjectUrl(blobKey: string, url: string): void {
  const existing = objectUrlCache.get(blobKey)
  if (existing !== undefined) {
    // LRU touch：同 key 复用旧 URL，只刷新热度。
    objectUrlCache.delete(blobKey)
    objectUrlCache.set(blobKey, existing)
    return
  }
  objectUrlCache.set(blobKey, url)
  while (objectUrlCache.size > objectUrlCacheLimit) {
    const oldestKey = objectUrlCache.keys().next().value
    if (oldestKey === undefined) break
    const oldestUrl = objectUrlCache.get(oldestKey)
    objectUrlCache.delete(oldestKey)
    if (oldestUrl !== undefined) URL.revokeObjectURL(oldestUrl)
  }
}

// ---------------------------------------------------------------------------
// 解析出口（design §1.1，签名冻结）
// ---------------------------------------------------------------------------

/** 含软删节点（调用方按需过滤）；文件夹/缺失 → null。 */
export async function getAsset(assetId: string): Promise<AssetImage | null> {
  const node = await getNode(assetId)
  return node !== null && node.type === 'image' ? node : null
}

/** refKind='blob' 解析 blobKey 后读取；external/缺失/软删 → null。 */
export async function getAssetBlob(assetId: string): Promise<Blob | null> {
  const node = await getNode(assetId)
  if (node === null || node.type !== 'image' || node.refKind !== 'blob' || !node.blobKey) return null
  if (node.trashedAt !== undefined) return null
  return getImageBlob(node.blobKey).catch(() => null)
}

/** blob → objectURL（按 blobKey 共享 + LRU 缓存）；external → externalUrl 原样；软删/缺失 → null。 */
export async function objectUrlForAsset(assetId: string): Promise<string | null> {
  const node = await getNode(assetId)
  if (node === null || node.type !== 'image' || node.trashedAt !== undefined) return null
  if (node.refKind === 'external') return node.externalUrl ?? null
  if (!node.blobKey) return null
  const cached = objectUrlCache.get(node.blobKey)
  if (cached !== undefined) {
    objectUrlCache.delete(node.blobKey)
    objectUrlCache.set(node.blobKey, cached)
    return cached
  }
  const blob = await getAssetBlob(assetId)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  cacheObjectUrl(node.blobKey, url)
  return url
}

/** 显式释放缓存中的 objectURL（切换参考图等场景）。 */
export function releaseObjectUrl(url: string): void {
  for (const [key, value] of objectUrlCache) {
    if (value === url) {
      objectUrlCache.delete(key)
      URL.revokeObjectURL(url)
      return
    }
  }
}

/** 下载源获取（design §4：原 blob 单图；文件夹 zip = P2 不做）。 */
export async function getDownloadSource(
  assetId: string,
): Promise<{ node: AssetImage; url: string } | null> {
  const node = await getAsset(assetId)
  if (!node) return null
  const url = await objectUrlForAsset(assetId)
  if (!url) return null
  return { node, url }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 直系子节点（path 为派生量：调用方按 parentId 链现算）。 */
export async function listChildNodes(parentId: string | null): Promise<AssetNode[]> {
  return runTx([ASSET_NODES_STORE], 'readonly', async (tx) =>
    requestToPromise(nodesOf(tx).index('parentId').getAll(parentId)),
  )
}

export async function listAllNodes(): Promise<AssetNode[]> {
  return runTx([ASSET_NODES_STORE], 'readonly', async (tx) => requestToPromise(nodesOf(tx).getAll()))
}

export async function listContentHashes(): Promise<ContentRecord[]> {
  return runTx([CONTENT_HASHES_STORE], 'readonly', async (tx) =>
    requestToPromise(tx.objectStore(CONTENT_HASHES_STORE).getAll()),
  )
}

// ---------------------------------------------------------------------------
// 内容寻址去重与入库（design §1.0）
// ---------------------------------------------------------------------------

export interface IngestAssetOptions {
  blob: Blob
  name: string
  width: number
  height: number
  parentId: string | null
  source: AssetSource
  meta?: AssetMeta
}

/** created=新内容新节点；in-folder-duplicate=同目录同内容（返回既有节点）；linked=跨目录符号链接节点。 */
export type IngestStatus = 'created' | 'in-folder-duplicate' | 'linked'

export interface IngestResult {
  node: AssetImage
  status: IngestStatus
}

/**
 * 入库：SHA-256 → contentHashes 命中复用 physicalKey（零写入）/ 未命中同事务
 * putImage(hash 键)+注册；同目录同内容去重为一条；跨目录建符号链接节点。
 * 资产不可变：入库后 blob 与内容永不修改。
 */
export async function ingestAsset(options: IngestAssetOptions): Promise<IngestResult> {
  const mime = options.blob.type
  if (!(ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
    throw new AssetStoreError(`不支持的图片类型：${mime || '未知'}。请使用 PNG、JPEG 或 WebP。`)
  }
  if (options.parentId !== null) {
    const parent = await getNode(options.parentId)
    if (!parent || parent.type !== 'folder') throw new AssetStoreError('入库目标位置不是文件夹。')
  }
  const hash = await sha256OfBlob(options.blob)
  const timestamp = nowMs()

  return runTx([IMAGES_STORE, CONTENT_HASHES_STORE, ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const images = tx.objectStore(IMAGES_STORE)
    const hashes = tx.objectStore(CONTENT_HASHES_STORE)
    const nodes = nodesOf(tx)

    const hashRecord = (await requestToPromise(hashes.get(hash))) as ContentRecord | undefined
    let physicalKey: string
    if (hashRecord) {
      physicalKey = hashRecord.physicalKey
    } else {
      physicalKey = hash
      await requestToPromise(images.put({ id: hash, blob: options.blob, createdAt: timestamp }))
      await requestToPromise(
        hashes.put({ hash, physicalKey, bytes: options.blob.size, mime } satisfies ContentRecord),
      )
    }

    const siblings = (await requestToPromise(nodes.index('parentId').getAll(options.parentId))) as AssetNode[]
    const existing = siblings.find(
      (n): n is AssetImage & { blobKey: string } =>
        n.type === 'image' &&
        n.refKind === 'blob' &&
        n.blobKey === physicalKey &&
        n.trashedAt === undefined,
    )
    if (existing) {
      return { node: existing, status: 'in-folder-duplicate' satisfies IngestStatus }
    }

    const node: AssetImage = {
      id: newAssetNodeId(),
      type: 'image',
      refKind: 'blob',
      blobKey: physicalKey,
      name: uniqueNameAmong(siblings, options.name),
      parentId: options.parentId,
      createdAt: timestamp,
      updatedAt: timestamp,
      mime,
      width: options.width,
      height: options.height,
      bytes: options.blob.size,
      source: options.source,
      ...(options.meta ? { meta: options.meta } : {}),
    }
    await requestToPromise(nodes.put(node))
    return { node, status: (hashRecord ? 'linked' : 'created') satisfies IngestStatus }
  })
}

// ---------------------------------------------------------------------------
// 文件操作（design §4，单事务保证）
// ---------------------------------------------------------------------------

export async function createFolder(parentId: string | null, name: string): Promise<AssetFolder> {
  if (parentId !== null) {
    const parent = await getNode(parentId)
    if (!parent || parent.type !== 'folder') throw new AssetStoreError('目标位置不是文件夹。')
    if (isSystemFolder(parent)) throw new AssetStoreError('系统目录内不能新建文件夹。')
  }
  const timestamp = nowMs()
  return runTx([ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    const siblings = (await requestToPromise(nodes.index('parentId').getAll(parentId))) as AssetNode[]
    const folder: AssetFolder = {
      id: newAssetNodeId(),
      type: 'folder',
      name: uniqueNameAmong(siblings, name),
      parentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await requestToPromise(nodes.put(folder))
    return folder
  })
}

export async function renameAsset(id: string, name: string): Promise<AssetNode> {
  const node = await getNode(id)
  if (!node) throw new AssetStoreError('目标不存在。')
  if (isSystemFolder(node)) throw new AssetStoreError('系统目录不可重命名。')
  if (isSysCasesEntry(node)) throw new AssetStoreError('内置案例条目为只读，不可重命名。')
  return runTx([ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    const siblings = (await requestToPromise(nodes.index('parentId').getAll(node.parentId))) as AssetNode[]
    const updated: AssetNode = { ...node, name: uniqueNameAmong(siblings, name, id), updatedAt: nowMs() }
    await requestToPromise(nodes.put(updated))
    return updated
  })
}

export async function moveAsset(id: string, newParentId: string | null): Promise<AssetNode> {
  const node = await getNode(id)
  if (!node) throw new AssetStoreError('目标不存在。')
  if (isSystemFolder(node)) throw new AssetStoreError('系统目录不可移动。')
  if (isSysCasesEntry(node)) throw new AssetStoreError('内置案例条目为只读，不可移动。')
  if (newParentId === id) throw new AssetStoreError('不能移动到自身。')
  if (newParentId !== null) {
    if (newParentId === TRASH_FOLDER_ID) {
      throw new AssetStoreError('回收站不是移动目标——删除请用「移入回收站」。')
    }
    const target = await getNode(newParentId)
    if (!target || target.type !== 'folder') throw new AssetStoreError('只能移动到文件夹。')
    // 环不可能：沿目标 parentId 链向上查，命中自身即拒绝（store 层，非仅 UI 禁用）。
    let cursor: string | null = newParentId
    while (cursor !== null) {
      if (cursor === id) throw new AssetStoreError('不能移动到自身或其后代。')
      const current: AssetNode | null = await getNode(cursor)
      cursor = current ? current.parentId : null
    }
  }
  return runTx([ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    const siblings = (await requestToPromise(nodes.index('parentId').getAll(newParentId))) as AssetNode[]
    const updated: AssetNode = {
      ...node,
      parentId: newParentId,
      name: uniqueNameAmong(siblings, node.name, id),
      updatedAt: nowMs(),
    }
    await requestToPromise(nodes.put(updated))
    return updated
  })
}

/** 递归收集子树（含自身）：BFS 沿 parentId index。 */
async function collectSubtreeNodes(rootId: string): Promise<AssetNode[]> {
  return runTx([ASSET_NODES_STORE], 'readonly', async (tx) => {
    const index = nodesOf(tx).index('parentId')
    const collected: AssetNode[] = []
    const queue: string[] = [rootId]
    while (queue.length > 0) {
      const current = queue.shift() as string
      const node = await requestToPromise(nodesOf(tx).get(current))
      if (node !== undefined) collected.push(node as AssetNode)
      const children = (await requestToPromise(index.getAll(current))) as AssetNode[]
      for (const child of children) queue.push(child.id)
    }
    return collected
  })
}

/** 软删（递归）：节点+全部后代 trashedAt=now，原子单事务。 */
export async function trashAsset(id: string): Promise<number> {
  const node = await getNode(id)
  if (!node) throw new AssetStoreError('目标不存在。')
  if (isSystemFolder(node)) throw new AssetStoreError('系统目录不可删除。')
  if (isSysCasesEntry(node)) throw new AssetStoreError('内置案例条目为只读，不可删除。')
  // 已软删（含文件夹——递归软删会给整棵子树打 trashedAt）→ 幂等 no-op。
  if ((node as { trashedAt?: number }).trashedAt !== undefined) return 0

  const subtree = await collectSubtreeNodes(id)
  const timestamp = nowMs()
  await runTx([ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    for (const member of subtree) {
      await requestToPromise(nodes.put({ ...member, trashedAt: timestamp, updatedAt: timestamp }))
    }
  })
  return subtree.length
}

export interface EmptyTrashSkip {
  id: string
  name: string
  reason: 'pinned' | 'pinned-descendant' | 'ancestor-of-pinned'
}

export interface EmptyTrashResult {
  deletedNodeIds: string[]
  deletedBlobKeys: string[]
  skipped: EmptyTrashSkip[]
}

/**
 * 清空回收站（硬删）：递归删除软删节点；blob 按 blobKey 扫描全节点统计剩余引用，
 * 归零才删 blob + contentHashes 条目（符号链接共存保护，同事务）。
 * 引用保护：pin 表命中者跳过并明示（不做「自动解除」分支）；任务 meta assetId 为弱引用不阻断。
 */
export async function emptyTrash(): Promise<EmptyTrashResult> {
  const trashed = await runTx([ASSET_NODES_STORE], 'readonly', async (tx) =>
    requestToPromise(nodesOf(tx).index('trashedAt').getAll()),
  )

  const keep = new Set<string>()
  const skipped: EmptyTrashSkip[] = []
  const trashedNodes = trashed as AssetNode[]
  const childrenOf = new Map<string, AssetNode[]>()
  for (const node of trashedNodes) {
    if (node.parentId === null) continue
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node)
    childrenOf.set(node.parentId, list)
  }

  const keepSubtree = (root: AssetNode, reason: EmptyTrashSkip['reason']): void => {
    const queue = [root]
    while (queue.length > 0) {
      const current = queue.shift() as AssetNode
      if (keep.has(current.id)) continue
      keep.add(current.id)
      skipped.push({ id: current.id, name: current.name, reason })
      for (const child of childrenOf.get(current.id) ?? []) queue.push(child)
    }
  }

  for (const node of trashedNodes) {
    if (pinnedAssets.has(node.id)) keepSubtree(node, 'pinned')
  }
  // 被保留节点的祖先仍在回收站内的 → 一并保留（维持树连通，不自动解除引用）。
  for (const node of trashedNodes) {
    if (!keep.has(node.id)) continue
    let cursor = node.parentId
    while (cursor !== null && !keep.has(cursor)) {
      const ancestor = trashedNodes.find((n) => n.id === cursor)
      if (!ancestor) break
      keep.add(ancestor.id)
      skipped.push({ id: ancestor.id, name: ancestor.name, reason: 'ancestor-of-pinned' })
      cursor = ancestor.parentId
    }
  }

  const deletionSet = trashedNodes.filter((n) => !keep.has(n.id)).map((n) => n.id)
  const deletedSet = new Set(deletionSet)
  const blobKeysToCheck = new Set(
    trashedNodes
      .filter(
        (n): n is AssetImage & { blobKey: string } =>
          n.type === 'image' &&
          n.refKind === 'blob' &&
          typeof n.blobKey === 'string' &&
          deletedSet.has(n.id),
      )
      .map((n) => n.blobKey),
  )

  const deletedBlobKeys: string[] = []
  await runTx([ASSET_NODES_STORE, IMAGES_STORE, CONTENT_HASHES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    const images = tx.objectStore(IMAGES_STORE)
    const hashes = tx.objectStore(CONTENT_HASHES_STORE)
    for (const id of deletionSet) {
      await requestToPromise(nodes.delete(id))
    }
    for (const blobKey of blobKeysToCheck) {
      const referencing = (await requestToPromise(nodes.index('blobKey').getAll(blobKey))) as AssetNode[]
      const remaining = referencing.filter((n) => !deletedSet.has(n.id)).length
      if (remaining > 0) continue
      await requestToPromise(images.delete(blobKey))
      const records = (await requestToPromise(hashes.getAll())) as ContentRecord[]
      for (const record of records) {
        if (record.physicalKey === blobKey) {
          await requestToPromise(hashes.delete(record.hash))
        }
      }
      deletedBlobKeys.push(blobKey)
    }
  })

  return { deletedNodeIds: deletionSet, deletedBlobKeys, skipped }
}

// ---------------------------------------------------------------------------
// active-reference pin 表（design §4 冻结：模块级 Set<assetId>）
// ---------------------------------------------------------------------------

const pinnedAssets = new Set<string>()

export function pinAsset(assetId: string): void {
  pinnedAssets.add(assetId)
}

export function unpinAsset(assetId: string): void {
  pinnedAssets.delete(assetId)
}

export function isAssetPinned(assetId: string): boolean {
  return pinnedAssets.has(assetId)
}

export function listPinnedAssetIds(): string[] {
  return [...pinnedAssets]
}

// ---------------------------------------------------------------------------
// 启动幂等迁移（design §3）
// ---------------------------------------------------------------------------

export type AssetMigrationStep =
  | 'seed-system-folders'
  | 'preset-case-nodes'
  | 'task-batch-nodes'
  | 'effectref-nodes'
  | 'backfill-hashes'

export interface AssetMigrationStepResult {
  step: AssetMigrationStep
  status: 'skipped' | 'done' | 'failed'
  detail?: string
}

export interface AssetMigrationReport {
  /** false = 主 flag 已置（此前已完成），本次空跑。 */
  ran: boolean
  completed: boolean
  hashesCompleted: boolean
  steps: AssetMigrationStepResult[]
  /** blob 缺失但照建的任务节点（v1 数据被浏览器清理过）。 */
  missingBlobNodeIds: string[]
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'done'
  } catch {
    return false
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, 'done')
  } catch {
    // 配额/隐私模式：迁移保持可重跑态，代价是下次启动再跑一遍（幂等）。
  }
}

function formatStamp(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function seedSystemFolders(): Promise<void> {
  const timestamp = nowMs()
  await runTx([ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    for (const id of SYSTEM_FOLDER_IDS) {
      const existing = await requestToPromise(nodes.get(id))
      if (existing !== undefined) continue
      await requestToPromise(
        nodes.put({
          id,
          type: 'folder',
          system: id,
          name: SYSTEM_FOLDER_NAMES[id],
          parentId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies AssetFolder),
      )
    }
  })
}

async function upsertPresetCaseNodes(): Promise<void> {
  const timestamp = nowMs()
  await runTx([ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    for (const preset of EFFECT_REF_PRESETS) {
      const roles: Array<{ suffix: 'src' | 'res'; url: string }> = [{ suffix: 'res', url: preset.resImage }]
      if (preset.srcImage) roles.unshift({ suffix: 'src', url: preset.srcImage })
      for (const { suffix, url } of roles) {
        const id = `ast-preset-${preset.id}-${suffix}`
        const existing = (await requestToPromise(nodes.get(id))) as AssetNode | undefined
        const node: AssetImage = {
          id,
          type: 'image',
          refKind: 'external',
          externalUrl: url,
          name: `${preset.name}·${suffix === 'src' ? '原图' : '效果'}`,
          parentId: 'sys-cases',
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          mime: 'image/jpeg',
          width: 0,
          height: 0,
          bytes: 0,
          source: 'preset',
          meta: { originNote: preset.sourceNote },
        }
        await requestToPromise(nodes.put(node))
      }
    }
  })
}

async function ensureFolder(
  tx: IDBTransaction,
  id: string,
  name: string,
  parentId: string,
  timestamp: number,
): Promise<string> {
  const nodes = nodesOf(tx)
  const existing = await requestToPromise(nodes.get(id))
  if (existing === undefined) {
    await requestToPromise(
      nodes.put({
        id,
        type: 'folder',
        name,
        parentId,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies AssetFolder),
    )
  }
  return id
}

/** 成功任务按 runId 建批次夹（sys-generated）+ 每任务一个 image 节点；blob 缺失照建并上报。 */
async function createTaskBatchNodes(missingBlobNodeIds: string[]): Promise<void> {
  const metas = loadTaskMetas().filter((m) => m.status === 'success')
  if (metas.length === 0) return
  const timestamp = nowMs()

  const byRun = new Map<string, PersistedTaskMeta[]>()
  for (const meta of metas) {
    const runId = meta.runId || LEGACY_RUN_ID
    const list = byRun.get(runId) ?? []
    list.push(meta)
    byRun.set(runId, list)
  }
  const runEntries = [...byRun.entries()]
    .filter(([runId]) => runId !== LEGACY_RUN_ID)
    .sort((a, b) => Math.min(...a[1].map((m) => m.createdAt)) - Math.min(...b[1].map((m) => m.createdAt)))

  await runTx([ASSET_NODES_STORE, IMAGES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    const images = tx.objectStore(IMAGES_STORE)
    const folderIdFor = new Map<string, string>()
    if (byRun.has(LEGACY_RUN_ID)) {
      folderIdFor.set(LEGACY_RUN_ID, await ensureFolder(tx, 'ast-batch-legacy', '更早', 'sys-generated', timestamp))
    }
    let runNumber = 0
    for (const [runId, list] of runEntries) {
      runNumber += 1
      const earliest = Math.min(...list.map((m) => m.createdAt))
      const name = `第 ${runNumber} 次生成 · ${formatStamp(earliest)}`
      folderIdFor.set(runId, await ensureFolder(tx, `ast-batch-${runId}`, name, 'sys-generated', timestamp))
    }
    for (const meta of metas) {
      const nodeId = `ast-task-${meta.id}`
      if ((await requestToPromise(nodes.get(nodeId))) !== undefined) continue
      const blobRecord = (await requestToPromise(images.get(meta.id))) as { blob: Blob } | undefined
      if (!blobRecord) missingBlobNodeIds.push(nodeId)
      const node: AssetImage = {
        id: nodeId,
        type: 'image',
        refKind: 'blob',
        blobKey: meta.id,
        name: `${meta.variantName}·候选${meta.candidateIndex + 1}`,
        parentId: folderIdFor.get(meta.runId || LEGACY_RUN_ID) ?? 'sys-generated',
        createdAt: meta.finishedAt ?? meta.createdAt,
        updatedAt: timestamp,
        mime: blobRecord?.blob.type || 'image/png',
        width: 0,
        height: 0,
        bytes: blobRecord?.blob.size ?? 0,
        source: 'migrated',
        meta: {
          runId: meta.runId || LEGACY_RUN_ID,
          variantName: meta.variantName,
          candidateIndex: meta.candidateIndex,
          prompt: meta.prompt,
        },
      }
      await requestToPromise(nodes.put(node))
    }
  })
}

function parseEffectRefKey(key: string): { variantId: string; role: 'src' | 'res' } | null {
  if (!key.startsWith('effectref-')) return null
  const match = key.slice('effectref-'.length).match(/^(.*)-(src|res)-(\d+)$/)
  if (!match) return null
  return { variantId: match[1], role: match[2] as 'src' | 'res' }
}

/** 存量 effectref-* blob 建节点入 sys-uploads（src/res 按 key 后缀配对，blobKey 保留原键可回溯配对）。 */
async function createEffectRefNodes(): Promise<void> {
  const records = await listImages()
  const refRecords = records.filter((r) => parseEffectRefKey(r.id) !== null)
  if (refRecords.length === 0) return
  const timestamp = nowMs()
  const variants = loadVariants() ?? []
  const variantNameOf = (variantId: string): string | undefined =>
    variants.find((v) => v.id === variantId)?.name

  await runTx([ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    for (const record of refRecords) {
      const nodeId = `ast-${record.id}`
      if ((await requestToPromise(nodes.get(nodeId))) !== undefined) continue
      const parsed = parseEffectRefKey(record.id) as { variantId: string; role: 'src' | 'res' }
      const variantName = variantNameOf(parsed.variantId)
      const node: AssetImage = {
        id: nodeId,
        type: 'image',
        refKind: 'blob',
        blobKey: record.id,
        name: `${variantName ? `${variantName}·` : ''}参考${parsed.role === 'src' ? '原图' : '效果'}`,
        parentId: 'sys-uploads',
        createdAt: record.createdAt,
        updatedAt: timestamp,
        mime: record.blob.type || 'image/png',
        width: 0,
        height: 0,
        bytes: record.blob.size,
        source: 'migrated',
        ...(variantName ? { meta: { variantName } satisfies AssetMeta } : {}),
      }
      await requestToPromise(nodes.put(node))
    }
  })
}

/** 存量 blob 分块补内容哈希（子 flag 独立；physicalKey 指回旧键，blob 一律不搬）。 */
async function backfillContentHashes(): Promise<void> {
  const records = await listImages()
  const existing = await listContentHashes()
  const coveredKeys = new Set(existing.map((r) => r.physicalKey))
  const coveredHashes = new Set(existing.map((r) => r.hash))
  const pending = records.filter((r) => !coveredKeys.has(r.id))
  const CHUNK = 16
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK)
    const hashed: Array<{ id: string; hash: string; bytes: number; mime: string }> = []
    for (const record of slice) {
      hashed.push({
        id: record.id,
        hash: await sha256OfBlob(record.blob),
        bytes: record.blob.size,
        mime: record.blob.type || 'image/png',
      })
    }
    await runTx([CONTENT_HASHES_STORE], 'readwrite', async (tx) => {
      const hashes = tx.objectStore(CONTENT_HASHES_STORE)
      for (const item of hashed) {
        if (coveredHashes.has(item.hash)) continue // 同内容已注册（不同物理键）不重复注册
        await requestToPromise(
          hashes.put({ hash: item.hash, physicalKey: item.id, bytes: item.bytes, mime: item.mime } satisfies ContentRecord),
        )
        coveredHashes.add(item.hash)
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0)) // 分块让路，不阻塞首屏
  }
  writeFlag(HASH_BACKFILL_FLAG)
}

async function allNodesExist(ids: string[]): Promise<boolean> {
  return runTx([ASSET_NODES_STORE], 'readonly', async (tx) => {
    const nodes = nodesOf(tx)
    for (const id of ids) {
      if ((await requestToPromise(nodes.get(id))) === undefined) return false
    }
    return true
  })
}

async function doMigration(): Promise<AssetMigrationReport> {
  const hashesAlreadyDone = readFlag(HASH_BACKFILL_FLAG)
  if (readFlag(MIGRATION_FLAG)) {
    return {
      ran: false,
      completed: true,
      hashesCompleted: hashesAlreadyDone,
      steps: [],
      missingBlobNodeIds: [],
    }
  }

  const steps: AssetMigrationStepResult[] = []
  const missingBlobNodeIds: string[] = []
  const mainSteps: Array<{ step: AssetMigrationStep; precheck: () => Promise<boolean>; run: () => Promise<void> }> = [
    {
      step: 'seed-system-folders',
      precheck: () => allNodesExist([...SYSTEM_FOLDER_IDS]),
      run: seedSystemFolders,
    },
    {
      step: 'preset-case-nodes',
      precheck: () =>
        allNodesExist(
          EFFECT_REF_PRESETS.flatMap((p) => [
            `ast-preset-${p.id}-res`,
            ...(p.srcImage ? [`ast-preset-${p.id}-src`] : []),
          ]),
        ),
      run: upsertPresetCaseNodes,
    },
    { step: 'task-batch-nodes', precheck: () => Promise.resolve(false), run: () => createTaskBatchNodes(missingBlobNodeIds) },
    { step: 'effectref-nodes', precheck: () => Promise.resolve(false), run: createEffectRefNodes },
  ]

  let mainOk = true
  for (const { step, precheck, run } of mainSteps) {
    if (mainOk) {
      try {
        const skipped = await precheck()
        if (!skipped) await run()
        steps.push({ step, status: skipped ? 'skipped' : 'done' })
      } catch (error) {
        mainOk = false
        steps.push({
          step,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        })
        // 后续主步骤依赖系统目录存在：中止本轮流迁移（下次启动重跑，已完成步骤按存在即跳过）。
        break
      }
    }
  }

  // 补哈希与主 flag 解耦（独立子 flag，失败下次重跑）。
  let hashesOk = hashesAlreadyDone
  if (hashesAlreadyDone) {
    steps.push({ step: 'backfill-hashes', status: 'skipped' })
  } else {
    try {
      await backfillContentHashes()
      hashesOk = true
      steps.push({ step: 'backfill-hashes', status: 'done' })
    } catch (error) {
      steps.push({
        step: 'backfill-hashes',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (mainOk) writeFlag(MIGRATION_FLAG)
  return { ran: true, completed: mainOk, hashesCompleted: hashesOk, steps, missingBlobNodeIds }
}

let migrationInFlight: Promise<AssetMigrationReport> | null = null

/** 启动迁移入口（幂等、异步、不抛——调用方可直接 void）。并发调用共享同一轮。 */
export function runAssetMigration(): Promise<AssetMigrationReport> {
  if (!migrationInFlight) {
    migrationInFlight = doMigration().finally(() => {
      migrationInFlight = null
    })
  }
  return migrationInFlight
}

// ---------------------------------------------------------------------------
// 测试专用
// ---------------------------------------------------------------------------

/** 模块态复位（objectURL 缓存/pin 表/迁移并发闸）；不动 IndexedDB / localStorage，由测试自理。 */
export function resetAssetStoreForTests(): void {
  for (const url of objectUrlCache.values()) URL.revokeObjectURL(url)
  objectUrlCache.clear()
  pinnedAssets.clear()
  migrationInFlight = null
}

export function setObjectUrlCacheLimitForTests(limit: number): void {
  objectUrlCacheLimit = limit
}
