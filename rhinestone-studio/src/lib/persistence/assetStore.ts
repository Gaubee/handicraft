/**
 * 素材库数据层（虚拟文件系统，openspec add-asset-library design §1-§4）。
 *
 * 正交意图：
 * 1. [2026-09-19 Source] design.md §1 数据契约（AssetNode 树 / path 派生 / 资产不可变 / 环不可能）。
 * 2. [2026-09-19 Resolve] §1.1 解析出口冻结：assetId → blob/objectURL 只经本模块，调用方禁止拼 blob key。
 * 3. [2026-09-19 Dedup] §1.0 内容寻址去重：同字节内容全库一份 blob，AssetImage 节点 = 内容的符号链接。
 * 4. [2026-09-19 Lifecycle] §4 文件操作 + active-reference pin 表：删除/清空单事务，引用保护在 store 层裁决。
 * 5. [2026-09-19 Migration] §3 启动幂等迁移（全部步骤成功才置 flag，失败保留可重跑态）。
 * 6. [2026-09-19 ProjectFiles] add-project-files design §2/§9.1 B5：AssetProject 入
 *    AssetNode union 三分化 + ingestProjectAsset + 生命周期 lease（引用计数 pin）+
 *    updateProjectAsset CAS 换绑。类型/签名/错误的唯一定义在 projectTypes.ts，本模块只实现。
 *
 * 约束：纯数据深模块——不 import Svelte 组件；IDB 裸 API（共享 opener 见 imageStore.openDb）。
 */

import { ACCEPTED_IMAGE_MIME_TYPES } from '$lib/api/imageInput'
import { APP_VERSION } from '$lib/appVersion'
import { GEMSHAPE_SEEDS, customSpecKey, gemshapeSeedNodeId, planGemshapeSeeds, type GemshapeSeedSpec } from '$lib/engine'
import {
  ASSET_NODES_STORE,
  CONTENT_HASHES_STORE,
  getImageBlob,
  IMAGES_STORE,
  listImages,
  openDb,
} from '$lib/persistence/imageStore'
import {
  bakeCalibrationPhysical,
  canvasTextureDecoder,
  parseGemshape,
  serializeGemshape,
  verifyGemshapeTexture,
  type CalibrationBakeInput,
  type GemshapeCalibration,
  type GemshapeFile,
  type GemshapeRefState,
  type GemshapeTextureDecoder,
} from '$lib/persistence/gemshapeFile'
import {
  ProjectConflictError,
  PROJECT_MIME,
  projectKindOfMime,
  type AssetProject,
  type CloseProject,
  type CloseProjectResult,
  type OpenProject,
  type ProjectKind,
  type ProjectLease,
  type ProjectSummary,
  type ProjectThumbMeta,
  type UpdateProjectAsset,
  type UpdateProjectAssetOptions,
} from '$lib/persistence/projectTypes'
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
export type SystemFolderId =
  | 'sys-cases'
  | 'sys-templates'
  | 'sys-shapes'
  | 'sys-generated'
  | 'sys-uploads'
  | 'sys-exports'
  | 'sys-projects'
  | 'sys-trash'

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
  /** 生成时的原图资产 id（[Owner 2026-09-19]：效果图↔原图配对跨刷新保持；预览可跳转） */
  referenceAssetId?: string
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

/**
 * AssetNode union 三分化（add-project-files design §2）：图片 / 文件夹 / 项目
 * （AssetProject 形状与可变性豁免的唯一定义在 projectTypes.ts）。
 * 本切片的数据层兼容口径：项目节点在既有图片路径下「不可见但不报错」——
 * getAsset/getAssetBlob/objectUrlForAsset 等图片出口对其返回 null；库 UI 的
 * type-aware 消费是后续 1.4/4.2 切片，不在本模块范围。
 */
export type AssetNode = AssetFolder | AssetImage | AssetProject

/** AssetProject 判别守卫（union 三分化消费点统一入口）。 */
export function isAssetProject(node: AssetNode): node is AssetProject {
  return node.type === 'project'
}

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
  'sys-templates',
  'sys-shapes',
  'sys-generated',
  'sys-uploads',
  'sys-exports',
  'sys-projects',
  'sys-trash',
]

const SYSTEM_FOLDER_NAMES: Record<SystemFolderId, string> = {
  'sys-cases': '内置案例',
  'sys-templates': '模板',
  'sys-shapes': '钻形',
  'sys-generated': '生成结果',
  'sys-uploads': '上传',
  'sys-exports': '精修导出',
  'sys-projects': '项目',
  'sys-trash': '回收站',
}

/** 项目默认目录（design §2：首次 ingestProjectAsset 落此；seed 幂等 = SYSTEM_FOLDER_IDS + seedSystemFolders 既有机制）。 */
export const SYS_PROJECTS_FOLDER_ID: SystemFolderId = 'sys-projects'

/**
 * 模板目录（add-project-files 4.2，design §7.1/补充稿 C.1：插「生成结果」之前）。
 * **仅目录**在本模块 seed（SYSTEM_FOLDER_IDS + seedSystemFolders 既有机制，沿 sys-projects
 * 先例）；preset → gemtpl **条目** seed 在 lab hydrate（域管线归域 store——物化需
 * materializePresetEffectRef 案例管线，assetStore 不 import lab 逻辑，补充稿 A.4.1）。
 */
export const SYS_TEMPLATES_FOLDER_ID: SystemFolderId = 'sys-templates'

/**
 * 钻形目录（gem-catalog 2.1，Owner 2026-09-20 裁决一 + design §3.1/§3.2-4）：
 * 「钻形」系统目录**序插「模板」与「生成结果」之间**（配置资产聚簇）；内置规格 seed
 * （`ast-shape-${specKey}` 幂等 create-only——含软删跳过，删除不复活）与用户自定义
 * .gemshape 同域。目录真源 = 本目录下的 .gemshape 资产（engine 仅留迁移 bootstrap）。
 */
export const SYS_SHAPES_FOLDER_ID: SystemFolderId = 'sys-shapes'

/** 回收站内建 id（软删目标的逻辑归置位；节点仍保留原 parentId，靠 trashedAt 归类）。 */
export const TRASH_FOLDER_ID: SystemFolderId = 'sys-trash'

/** objectURL LRU 缓存上限（design §2）。 */
export const ASSET_OBJECT_URL_CACHE_LIMIT = 200
let objectUrlCacheLimit = ASSET_OBJECT_URL_CACHE_LIMIT

const MIGRATION_FLAG = 'rhinestone-studio:asset-migration-v2'
const HASH_BACKFILL_FLAG = 'rhinestone-studio:asset-migration-v2-hashes'
/**
 * sys-shapes seed 独立子 flag（gem-catalog 2.1）：主 MIGRATION_FLAG 已置的既有库也要补
 * 「钻形」目录与内置规格 seed——沿 backfill-hashes 解耦先例（失败保留可重跑态）。
 */
const SYS_SHAPES_SEED_FLAG = 'rhinestone-studio:asset-seed-sys-shapes-v1'

/** seed 数据确定性时间戳（2025-01-01T00:00:00Z——同字节同哈希，重跑零新 blob）。 */
const GEMSHAPE_SEED_EPOCH = 1735689600000

function nowMs(): number {
  return Date.now()
}

function newAssetNodeId(): AssetNodeId {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `ast-${crypto.randomUUID()}`
  return `ast-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 随机 token（lease token / thumb 物理键）；'ast-thumb-*' 前缀与内容哈希键（SHA-256 hex）命名空间隔离。 */
function randomToken(prefix: 'lease' | 'ast-thumb'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
 * 单事务执行器（openspec add-project-files design §9.1 B1，终态语义冻结）：
 * - body 内所有请求同属一个事务；任一请求失败 → 事务中止（写入回滚）。body 的首个
 *   请求必须同步发出（事务激活条件）。
 * - 完成语义：body 返回值暂存，`tx.oncomplete` 之后才 resolve——成功值在事务真正
 *   落盘前对调用方不可见；`onabort`/`onerror`（含提交期错误，如配额溢出）/body
 *   reject 一律 reject。
 * - 首终态规则：仅首个到达的终态生效；其后任何事件（迟到的 oncomplete/onabort/
 *   onerror）不二次 settle。
 * - body 约束：body 只能 await 本事务的 IDB request，不得跨 timer/IO/worker 再发
 *   request。body resolve 之后新发出的 request 不被本执行器等待——执行器只认事务
 *   终态事件（真实 IDB 中事务随请求队列清空自动提交，迟到 request 会得到
 *   TransactionInactiveError）。裸 IDB 无统一拦截点，迟到 request 的运行时检测
 *   不可靠，以本注释为契约边界。
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
        // 首终态守卫：三个失败入口（onabort/onerror/body reject）与一个成功入口
        // （oncomplete × body 已返回值）都先查 settled，终态后到达的事件一律忽略。
        let settled = false
        let completeFired = false
        let bodyOutcome: { value: T } | null = null
        const settleReject = (error: unknown): void => {
          if (settled) return
          settled = true
          reject(error)
        }
        tx.onabort = () => settleReject(tx.error ?? new AssetStoreError('IndexedDB 事务已中止。'))
        tx.onerror = () => settleReject(tx.error ?? new AssetStoreError('IndexedDB 事务出错。'))
        tx.oncomplete = () => {
          if (settled) return
          completeFired = true
          if (bodyOutcome !== null) {
            settled = true
            resolve(bodyOutcome.value)
          }
          // body 未决而事务先完结（body 违约跨宏任务等待的兜底）：留给 body 分支收尾。
        }
        body(tx).then(
          (value) => {
            if (settled) return
            bodyOutcome = { value }
            // 可见性契约：暂存返回值，挂起等待 oncomplete；仅当事务已先完结才立即 resolve。
            if (completeFired) {
              settled = true
              resolve(value)
            }
          },
          (error) => {
            settleReject(error)
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

/** 项目节点读取（含软删，与 getAsset 口径一致）；非项目/缺失 → null。实际内容消费必读 blob（parse），summary 仅卡片缓存。 */
export async function getProject(projectId: string): Promise<AssetProject | null> {
  const node = await getNode(projectId)
  return node !== null && isAssetProject(node) ? node : null
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

/** 显式释放缓存中的 objectURL（切换原图等场景）。 */
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
// 项目资产（add-project-files design §2/§9.1 B5；契约签名/类型见 projectTypes.ts 唯一定义）
// ---------------------------------------------------------------------------

/**
 * 文件内 kind 探针：blob 可 JSON 解析且根对象带字符串 `kind` 时返回之；
 * 解析失败 / 无 kind 字段 → null（交叉校验按 MIME 兜底）。真实 parser（formatVersion
 * 校验等）在 projectFile/labFile 切片，此处只做最保守的 kind 抽取。
 */
async function probeFileProjectKind(blob: Blob): Promise<string | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await blob.text())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || !('kind' in parsed)) return null
  const kind = (parsed as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

/** 系统目录节点的 create-only 确保（存在即跳过；迁移路径的显示名同步见 seedSystemFolders）。 */
async function ensureSystemFolderNode(tx: IDBTransaction, id: SystemFolderId, timestamp: number): Promise<void> {
  const nodes = nodesOf(tx)
  const existing = await requestToPromise(nodes.get(id))
  if (existing !== undefined) return
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

export interface IngestProjectAssetOptions {
  blob: Blob
  name: string
  /** 声明的项目类型；须与 blob.type（PROJECT_MIME）与文件内 kind（可解析时）三方一致。 */
  projectKind: ProjectKind
  /** 卡片摘要缓存（非真源）；缺省空对象。 */
  summary?: ProjectSummary
  /** 落点目录；缺省 = sys-projects（不存在时本事务内幂等 seed——老库迁移 flag 已置也兜得住）。 */
  parentId?: string | null
  /**
   * 确定性节点 id（迁移路径用，如 'ast-tpl-<presetId>'）：目标 id 已存在（含软删）即跳过，
   * 返回既有节点不写任何内容（普通入库缺省随机 id，不用此语义）。
   */
  id?: string
  /** gemgen 缩略物理记录（256px PNG）；键 'ast-thumb-*'，不注册 contentHashes（派生物不去重）。 */
  thumb?: { bytes: Blob; meta: Omit<ProjectThumbMeta, 'key' | 'bytes'> }
}

export type ProjectIngestStatus = 'created' | 'existing-id'

export interface ProjectIngestResult {
  node: AssetProject
  status: ProjectIngestStatus
}

/**
 * 项目入库（与 ingestAsset 平行）：PROJECT_MIME 白名单 + projectKind × mime × 文件内 kind
 * 交叉校验（blob 可解析出 kind 时必须一致；解析失败按 MIME 兜底）。项目节点不做同目录
 * 同内容去重（同字节也是两份文档——fork 语义）；物理 blob 仍走内容寻址共享 + 引用计数 GC。
 */
export async function ingestProjectAsset(options: IngestProjectAssetOptions): Promise<ProjectIngestResult> {
  const mime = options.blob.type
  if (projectKindOfMime(mime) === null) {
    throw new AssetStoreError(
      `不支持的项目文件类型：${mime || '未知'}。请使用本应用导出的 .gemproj / .gemdoc / .gemtpl / .gemgen / .gemshape 文件。`,
    )
  }
  if (PROJECT_MIME[options.projectKind] !== mime) {
    throw new AssetStoreError(`项目类型与文件类型不符：按 ${options.projectKind} 导入，但文件是 ${mime}。`)
  }
  const fileKind = await probeFileProjectKind(options.blob)
  if (fileKind !== null && fileKind !== options.projectKind) {
    throw new AssetStoreError(`文件内容声明为 ${fileKind}，与导入类型 ${options.projectKind} 不一致。`)
  }

  const parentId = options.parentId ?? SYS_PROJECTS_FOLDER_ID
  // 系统目录直落位（sys-projects 默认 / sys-templates·sys-shapes 显式指定）不走存在性预检：
  // 目录节点由下方事务内 ensure 幂等补建——老库迁移 flag 已置、seedSystemFolders
  // 不再重跑时同样兜得住（沿 sys-projects 先例，sys-templates/sys-shapes 为后加目录全靠此路径）。
  if (parentId !== SYS_PROJECTS_FOLDER_ID && parentId !== SYS_TEMPLATES_FOLDER_ID && parentId !== SYS_SHAPES_FOLDER_ID) {
    const parent = await getNode(parentId)
    if (!parent || parent.type !== 'folder') throw new AssetStoreError('入库目标位置不是文件夹。')
  }

  const hash = await sha256OfBlob(options.blob)
  const timestamp = nowMs()

  return runTx([IMAGES_STORE, CONTENT_HASHES_STORE, ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const images = tx.objectStore(IMAGES_STORE)
    const hashes = tx.objectStore(CONTENT_HASHES_STORE)
    const nodes = nodesOf(tx)

    // 确定性 id 幂等口径：get 存在（含软删）即跳过——「ingest 成功、完成集写入前崩溃」的重试不重复建节点。
    if (options.id !== undefined) {
      const existing = (await requestToPromise(nodes.get(options.id))) as AssetNode | undefined
      if (existing !== undefined) {
        if (!isAssetProject(existing)) throw new AssetStoreError(`节点 id 冲突：${options.id} 已被非项目节点占用。`)
        return { node: existing, status: 'existing-id' satisfies ProjectIngestStatus }
      }
    }
    if (parentId === SYS_PROJECTS_FOLDER_ID || parentId === SYS_TEMPLATES_FOLDER_ID || parentId === SYS_SHAPES_FOLDER_ID) {
      await ensureSystemFolderNode(tx, parentId, timestamp)
    }

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

    let thumbKey: string | undefined
    let thumb: ProjectThumbMeta | undefined
    if (options.thumb) {
      thumbKey = randomToken('ast-thumb')
      await requestToPromise(images.put({ id: thumbKey, blob: options.thumb.bytes, createdAt: timestamp }))
      thumb = { key: thumbKey, bytes: options.thumb.bytes.size, ...options.thumb.meta }
    }

    const siblings = (await requestToPromise(nodes.index('parentId').getAll(parentId))) as AssetNode[]
    const node: AssetProject = {
      id: options.id ?? newAssetNodeId(),
      type: 'project',
      projectKind: options.projectKind,
      refKind: 'blob',
      blobKey: physicalKey,
      ...(thumbKey !== undefined && thumb !== undefined ? { thumbKey, thumb } : {}),
      name: uniqueNameAmong(siblings, options.name),
      parentId,
      createdAt: timestamp,
      updatedAt: timestamp,
      summaryUpdatedAt: timestamp,
      mime,
      summary: options.summary ?? {},
    }
    await requestToPromise(nodes.put(node))
    return { node, status: 'created' satisfies ProjectIngestStatus }
  })
}

/**
 * CAS 换绑保存（design §9.1 B5 事务顺序冻结）：读节点及 expected key → 写新 blob（含
 * thumb）→ 更新 node → 扫描旧物理记录（blob + thumb）全节点引用 → 删除无引用物理记录。
 * expectedBlobKey 不符 = ProjectConflictError 且**不写任何一项**（孤儿 blob 由后续 GC
 * 回收，冲突路径不盲删）；gemgen 不可变，调用即抛错。新内容与旧内容同哈希时 blob 零写入、
 * GC 自然空转（扫描时节点已指向同键）。
 */
export const updateProjectAsset: UpdateProjectAsset = async (projectId, options: UpdateProjectAssetOptions) => {
  const hash = await sha256OfBlob(options.bytes)
  const timestamp = nowMs()

  return runTx([IMAGES_STORE, CONTENT_HASHES_STORE, ASSET_NODES_STORE], 'readwrite', async (tx) => {
    const images = tx.objectStore(IMAGES_STORE)
    const hashes = tx.objectStore(CONTENT_HASHES_STORE)
    const nodes = nodesOf(tx)

    // ① 读节点及 expectedBlobKey（冲突判定先于一切写入）。
    const existingRecord = (await requestToPromise(nodes.get(projectId))) as AssetNode | undefined
    if (existingRecord === undefined) throw new AssetStoreError('项目不存在。')
    if (!isAssetProject(existingRecord)) throw new AssetStoreError('目标不是项目节点。')
    if (existingRecord.projectKind === 'gemgen') {
      throw new AssetStoreError('生成档案（gemgen）不可变：生成即定稿，重试会产生新档案。')
    }
    if (existingRecord.projectKind === 'gemshape') {
      // [gem-catalog 2.2 / R3 P0-2] 内容不可变：texture/vectorPath/physical/calibration/specKey
      // 任何变更 = 另存新资产（新 assetId/新 specKey）——本格式无 blobKey 换绑入口。
      throw new AssetStoreError(
        '钻形资产（gemshape）不可变：修改请「另存为自定义副本」，任何内容变更都会产生新资产。',
      )
    }
    if (existingRecord.blobKey !== options.expectedBlobKey) {
      throw new ProjectConflictError(projectId, options.expectedBlobKey, existingRecord.blobKey)
    }

    // ② 写新 blob（内容寻址：同内容命中既有物理记录 = 零写入）；thumb 换绑物理记录随写。
    const hashRecord = (await requestToPromise(hashes.get(hash))) as ContentRecord | undefined
    const newBlobKey = hashRecord?.physicalKey ?? hash
    if (hashRecord === undefined) {
      await requestToPromise(images.put({ id: hash, blob: options.bytes, createdAt: timestamp }))
      await requestToPromise(
        hashes.put({ hash, physicalKey: newBlobKey, bytes: options.bytes.size, mime: existingRecord.mime } satisfies ContentRecord),
      )
    }

    let newThumbKey: string | undefined
    let newThumb: ProjectThumbMeta | undefined
    if (options.thumb) {
      newThumbKey = randomToken('ast-thumb')
      await requestToPromise(images.put({ id: newThumbKey, blob: options.thumb.bytes, createdAt: timestamp }))
      newThumb = { key: newThumbKey, bytes: options.thumb.bytes.size, ...options.thumb.meta }
    }

    // ③ 更新 node（blobKey/summary/summaryUpdatedAt/updatedAt；thumb 换绑同随）。
    const updated: AssetProject = {
      ...existingRecord,
      blobKey: newBlobKey,
      summary: options.summary,
      summaryUpdatedAt: timestamp,
      updatedAt: timestamp,
      ...(newThumbKey !== undefined && newThumb !== undefined ? { thumbKey: newThumbKey, thumb: newThumb } : {}),
    }
    await requestToPromise(nodes.put(updated))

    // ④ 扫描旧物理记录（含 thumb）全节点引用 → 无引用才删（须在 ③ 写入之后，同事务可见）。
    if (existingRecord.blobKey !== newBlobKey) {
      await deleteUnreferencedPhysicalRecord(tx, existingRecord.blobKey)
    }
    if (existingRecord.thumbKey !== undefined && existingRecord.thumbKey !== newThumbKey) {
      await deleteUnreferencedPhysicalRecord(tx, existingRecord.thumbKey)
    }
    return updated
  })
}

// ---------------------------------------------------------------------------
// gemshape 资产面（gem-catalog 2.2 vertical slice——八面中 persistence 侧：
// ingest / 另存副本 / 引用四态解析 / 校准参考 pin；内容不可变纪律见 updateProjectAsset 拒绝面）
// ---------------------------------------------------------------------------

export interface IngestGemshapeOptions {
  /** 节点名（缺省 = 文件内 name）。 */
  name?: string
  /** 落点（缺省 = sys-shapes——用户自定义钻形与内置规格同域，裁决一）。 */
  parentId?: string | null
  /** 贴图解码器（六 gate 的异步实测面）；缺省 = canvasTextureDecoder，测试注入确定性替身。 */
  decode?: GemshapeTextureDecoder
  /** 校准物化（向导数据面，design §3.2-8）：direct 输 mm / reference 以既有规格反推物理宽高。 */
  calibration?: CalibrationBakeInput
}

export interface GemshapeAssetResult {
  node: AssetProject
  /** 落库文件的最终形态（specKey 物化 custom-<assetId> / 校准烘焙后的 physical 等）。 */
  file: GemshapeFile
}

/** 引用四态 + not-found 的解析面（gate 6 判据；导出前置的 resolveShapeAsset 数据源）。 */
export async function resolveGemshapeRefState(assetId: string): Promise<GemshapeRefState | null> {
  const node = await getNode(assetId)
  if (node === null) return null
  if (!isAssetProject(node) || node.projectKind !== 'gemshape') return 'wrong-kind'
  if (node.trashedAt !== undefined) return 'soft-deleted'
  const blob = await getImageBlob(node.blobKey).catch(() => null)
  if (blob === null) return 'blob-missing'
  try {
    parseGemshape(await blob.text(), { mime: node.mime })
  } catch {
    return 'wrong-kind' // 四态定义：wrong-kind/invalid 涵盖 parse 失败档
  }
  return 'resolved'
}

/**
 * 批量解析 → 同步 resolver（exportGate.resolveShapeAsset 的接线数据面：
 * 引擎门是同步纯函数，异步解析在此预收集为 Map 快照）。
 */
export async function gemshapeRefResolver(
  assetIds: Iterable<string>,
): Promise<(assetId: string) => GemshapeRefState | null> {
  const states = new Map<string, GemshapeRefState | null>()
  for (const id of new Set(assetIds)) {
    states.set(id, await resolveGemshapeRefState(id))
  }
  return (assetId) => states.get(assetId) ?? null
}

/** specKey → 资产节点 id（校准参考 pin 的解析：seed 档 ast-shape-<specKey> / custom-<assetId> 反解）。 */
export function gemshapeNodeIdOfSpecKey(specKey: string): string {
  return specKey.startsWith('custom-') ? specKey.slice('custom-'.length) : gemshapeSeedNodeId(specKey)
}

/**
 * 编辑期 pin 校准参考资产（design §3.2-7）：参考资产存在才 pin（悬空 ref 不 pin 不报错——
 * 可审计性由内嵌 refSpecSnapshot 保证）；返回被 pin 的节点 id（未命中 = null）。
 * 只保护校准参考，不把文档弱引用升级为硬 pin。
 */
export async function pinGemshapeCalibrationRef(refSpecId: string): Promise<string | null> {
  const nodeId = gemshapeNodeIdOfSpecKey(refSpecId)
  const node = await getNode(nodeId)
  if (node === null) return null
  pinAsset(nodeId)
  return nodeId
}

/** 对应解除（关闭编辑器时收口；token 无关的布尔 pin，重复 unpin 安全）。 */
export function unpinGemshapeCalibrationRef(refSpecId: string): void {
  unpinAsset(gemshapeNodeIdOfSpecKey(refSpecId))
}

/** 校准记录（另存/校准物化时写入文件的出处）。 */
function calibrationRecordOf(input: CalibrationBakeInput): GemshapeCalibration {
  if (input.mode === 'direct') return { mode: 'direct' }
  // reference：记 refSpecId（可解析档）；refSpecSnapshot 由消费方在持有完整快照时补充。
  return { mode: 'reference', refSpecId: input.refSpec.specKey }
}

/**
 * 导入 .gemshape（六 gate 全量：parse 同步面 + verify 贴图解码实测面）→ 落库为**新资产**。
 * specKey 条件矩阵（design §1.4）：文件内可缺席，落库时物化 `custom-<assetId>`；
 * 校准输入给定则烘焙 physical（bakeCalibrationPhysical）并记出处。内容不可变——落库后无换绑。
 */
export async function ingestGemshapeFile(blob: Blob, options: IngestGemshapeOptions = {}): Promise<GemshapeAssetResult> {
  const file = parseGemshape(await blob.text(), blob.type === '' ? undefined : { mime: blob.type })
  const verification = await verifyGemshapeTexture(file, options.decode ?? canvasTextureDecoder)
  const physical =
    options.calibration === undefined
      ? file.physical
      : bakeCalibrationPhysical(verification.bounds, options.calibration)
  const calibration =
    options.calibration === undefined ? file.calibration : calibrationRecordOf(options.calibration)

  const nodeId = newAssetNodeId()
  const specKey = file.specKey ?? customSpecKey(nodeId)
  const text = serializeGemshape({
    appVersion: file.appVersion,
    createdAt: file.createdAt,
    savedAt: file.savedAt,
    name: options.name ?? file.name,
    texture: file.texture,
    ...(file.vectorPath !== undefined ? { vectorPath: file.vectorPath } : {}),
    physical,
    specKey,
    calibration,
  })
  const { node } = await ingestProjectAsset({
    blob: new Blob([text], { type: PROJECT_MIME.gemshape }),
    name: options.name ?? file.name,
    projectKind: 'gemshape',
    parentId: options.parentId ?? SYS_SHAPES_FOLDER_ID,
    id: nodeId,
    summary: { size: `${Math.max(physical.widthMm, physical.heightMm)}mm` },
  })
  return { node, file: parseGemshape(text) }
}

/**
 * 另存为自定义副本（design §1.6 身份纪律：编辑 = 另存副本）——新 assetId + 新 specKey
 * `custom-<newAssetId>`；texture/vectorPath 原样携带（内容不动的副本），校准输入给定则
 * 重新烘焙 physical。原资产不参与（不换绑、不修改）。
 */
export async function forkGemshapeAsset(
  assetId: string,
  options: { name?: string; decode?: GemshapeTextureDecoder; calibration?: CalibrationBakeInput } = {},
): Promise<GemshapeAssetResult> {
  const node = await getProject(assetId)
  if (node === null || !isAssetProject(node) || node.projectKind !== 'gemshape') {
    throw new AssetStoreError('目标不是钻形资产，无法另存副本。')
  }
  const blob = await getImageBlob(node.blobKey).catch(() => null)
  if (blob === null) throw new AssetStoreError('钻形资产字节缺失（物理记录丢失），无法另存副本。')
  const file = parseGemshape(await blob.text(), { mime: node.mime })
  // 校准物化：reference 需要 alpha bounds（解码实测）反推；direct 只消费声明 mm，不触解码
  // （贴图 gate 已在原始入库时刻执行——fork 不重复解码，副本内容零漂移）。
  let physical = file.physical
  let calibration = file.calibration
  if (options.calibration !== undefined) {
    calibration = calibrationRecordOf(options.calibration)
    if (options.calibration.mode === 'reference') {
      const verification = await verifyGemshapeTexture(file, options.decode ?? canvasTextureDecoder)
      physical = bakeCalibrationPhysical(verification.bounds, options.calibration)
    } else {
      physical = bakeCalibrationPhysical({ w: 0, h: 0 }, options.calibration)
    }
  }

  const newNodeId = newAssetNodeId()
  const text = serializeGemshape({
    appVersion: file.appVersion,
    createdAt: file.createdAt,
    savedAt: Date.now(),
    name: options.name ?? `${file.name} 副本`,
    texture: file.texture,
    ...(file.vectorPath !== undefined ? { vectorPath: file.vectorPath } : {}),
    physical,
    specKey: customSpecKey(newNodeId),
    calibration,
  })
  const result = await ingestProjectAsset({
    blob: new Blob([text], { type: PROJECT_MIME.gemshape }),
    name: options.name ?? `${file.name} 副本`,
    projectKind: 'gemshape',
    parentId: node.parentId ?? SYS_SHAPES_FOLDER_ID,
    id: newNodeId,
    summary: { size: `${Math.max(physical.widthMm, physical.heightMm)}mm` },
  })
  return { node: result.node, file: parseGemshape(text) }
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
 * 物理记录引用计数 GC（emptyTrash 硬清与项目换绑共用）：按 blobKey index + thumbKey
 * 字段双扫描全节点（含项目节点与 thumb 引用），无引用才删 images 记录及指向它的
 * contentHashes 条目（thumb 键不注册哈希，哈希清理自然空转）。必须在引用方节点的
 * 删除/换绑写入**之后**同事务调用（同事务读得见未提交写入）。
 */
async function deleteUnreferencedPhysicalRecord(tx: IDBTransaction, key: string): Promise<boolean> {
  const nodes = nodesOf(tx)
  const images = tx.objectStore(IMAGES_STORE)
  const blobRefs = (await requestToPromise(nodes.index('blobKey').getAll(key))) as AssetNode[]
  if (blobRefs.length > 0) return false
  const allNodes = (await requestToPromise(nodes.getAll())) as AssetNode[]
  if (allNodes.some((n) => isAssetProject(n) && n.thumbKey === key)) return false
  await requestToPromise(images.delete(key))
  const hashes = tx.objectStore(CONTENT_HASHES_STORE)
  const records = (await requestToPromise(hashes.getAll())) as ContentRecord[]
  for (const record of records) {
    if (record.physicalKey === key) await requestToPromise(hashes.delete(record.hash))
  }
  return true
}

/**
 * 清空回收站（硬删）：递归删除软删节点；blob 按 blobKey 扫描全节点统计剩余引用，
 * 归零才删 blob + contentHashes 条目（符号链接共存保护，同事务）；项目节点的
 * blobKey/thumbKey 一并纳入物理键检查（thumb 物理记录随硬清 GC）。
 * 引用保护：pin 命中（布尔 pin 或 lease 计数 >0）者跳过并明示（不做「自动解除」分支）；
 * 任务 meta assetId 为弱引用不阻断。
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
    if (isAssetPinned(node.id)) keepSubtree(node, 'pinned')
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
  const blobKeysToCheck = new Set<string>()
  for (const node of trashedNodes) {
    if (!deletedSet.has(node.id)) continue
    if (node.type === 'image' && node.refKind === 'blob' && typeof node.blobKey === 'string') {
      blobKeysToCheck.add(node.blobKey)
    } else if (isAssetProject(node)) {
      blobKeysToCheck.add(node.blobKey)
      if (node.thumbKey !== undefined) blobKeysToCheck.add(node.thumbKey)
    }
  }

  const deletedBlobKeys: string[] = []
  await runTx([ASSET_NODES_STORE, IMAGES_STORE, CONTENT_HASHES_STORE], 'readwrite', async (tx) => {
    const nodes = nodesOf(tx)
    for (const id of deletionSet) {
      await requestToPromise(nodes.delete(id))
    }
    for (const key of blobKeysToCheck) {
      if (await deleteUnreferencedPhysicalRecord(tx, key)) deletedBlobKeys.push(key)
    }
  })

  return { deletedNodeIds: deletionSet, deletedBlobKeys, skipped }
}

// ---------------------------------------------------------------------------
// active-reference pin 表（design §4 布尔 pin + add-project-files §9.1 B5 lease 引用计数）
// ---------------------------------------------------------------------------

/** 布尔 pin（studio/edit 现行直连 pinAsset/unpinAsset 的单宿主语义；与 lease 计数并集保护）。 */
const pinnedAssets = new Set<string>()

/** lease 真源：token → lease（closeProject 的权威判定；released 后移除，过期 token 查无）。 */
const projectLeases = new Map<string, ProjectLease>()

/** lease 维度引用计数表：assetId → pin 该资产的 lease token 集（计数 = 集合大小，任何 >0 即保护）。 */
const leasePinRefs = new Map<string, Set<string>>()

export function pinAsset(assetId: string): void {
  pinnedAssets.add(assetId)
}

export function unpinAsset(assetId: string): void {
  pinnedAssets.delete(assetId)
}

/** lease 维度引用计数（差分 pin/复测观测口；不含 pinAsset 布尔 pin）。 */
export function projectPinRefCount(assetId: string): number {
  return leasePinRefs.get(assetId)?.size ?? 0
}

export function isAssetPinned(assetId: string): boolean {
  return pinnedAssets.has(assetId) || projectPinRefCount(assetId) > 0
}

export function listPinnedAssetIds(): string[] {
  const ids = new Set<string>(pinnedAssets)
  for (const id of leasePinRefs.keys()) ids.add(id)
  return [...ids]
}

function pinForLease(assetId: string, token: string): void {
  const refs = leasePinRefs.get(assetId)
  if (refs !== undefined) {
    refs.add(token)
    return
  }
  leasePinRefs.set(assetId, new Set([token]))
}

function unpinForLease(assetId: string, token: string): void {
  const refs = leasePinRefs.get(assetId)
  if (refs === undefined) return
  refs.delete(token)
  if (refs.size === 0) leasePinRefs.delete(assetId)
}

/**
 * 打开项目（design §9.1 B5）：差分 pin 的引用集合由**调用方**按
 * 「gemproj: source+reference；gemdoc: 仅 reference；gemtpl/gemgen: 不 pin」构造传入
 * （pinnedAssetIds 参数）——实现不过度校验集合与 kind 的对应关系（gemdoc 传 source 也
 * 照 pin，集合语义归调用方）。每次 open 生成唯一 token；同一 owner 重复 open =
 * 多个独立引用各自计数。
 */
export const openProject: OpenProject = async (id, projectKind, ownerId, pinnedAssetIds) => {
  const node = await getNode(id)
  if (node === null || !isAssetProject(node)) throw new AssetStoreError('目标不是项目节点。')
  if (node.projectKind !== projectKind) {
    throw new AssetStoreError(`项目类型不符：节点是 ${node.projectKind}，不能按 ${projectKind} 打开。`)
  }
  const token = randomToken('lease')
  const lease: ProjectLease = {
    projectId: id,
    ownerId,
    token,
    pinnedAssetIds: [...new Set(pinnedAssetIds)],
    closed: false,
  }
  projectLeases.set(token, lease)
  for (const assetId of lease.pinnedAssetIds) pinForLease(assetId, token)
  return lease
}

/**
 * 关闭项目（幂等）：重复 close 与过期/未知 token = no-op 返回 'stale' 不抛错；
 * 有效 close 只解除**本 token** 的 pin 计数——其他 lease/owner 仍持有同一资产时
 * （计数 >0）保护不解除，最后一个有效计数关闭才放行硬清。
 */
export const closeProject: CloseProject = async (lease) => {
  if (lease.closed) return 'stale' satisfies CloseProjectResult
  const live = projectLeases.get(lease.token)
  if (live === undefined || live.projectId !== lease.projectId) {
    lease.closed = true
    return 'stale' satisfies CloseProjectResult
  }
  projectLeases.delete(lease.token)
  for (const assetId of live.pinnedAssetIds) unpinForLease(assetId, lease.token)
  lease.closed = true
  live.closed = true
  return 'released' satisfies CloseProjectResult
}

/**
 * source/reference 重绑的差分 pin/unpin（design §9.1 B5）：next 与 lease 当前集合求差，
 * 新增即为本 token 增计、移除即减计，lease.pinnedAssetIds 换为新集合（真源对象原地更新）。
 * 已关闭/未知 token 的 lease 重绑 = 调用方编程错误，显式抛错（与 closeProject 的幂等语义不同）。
 */
export function rebindProjectPins(lease: ProjectLease, nextPinnedAssetIds: readonly string[]): void {
  if (lease.closed || !projectLeases.has(lease.token)) {
    throw new AssetStoreError('租约已关闭或失效，不能重绑 pin 集合。')
  }
  const next = [...new Set(nextPinnedAssetIds)]
  const previous = new Set(lease.pinnedAssetIds)
  for (const assetId of next) {
    if (!previous.has(assetId)) pinForLease(assetId, lease.token)
  }
  for (const assetId of previous) {
    if (!next.includes(assetId)) unpinForLease(assetId, lease.token)
  }
  lease.pinnedAssetIds = next
}

// ---------------------------------------------------------------------------
// 启动幂等迁移（design §3）
// ---------------------------------------------------------------------------

export type AssetMigrationStep =
  | 'seed-system-folders'
  | 'preset-case-nodes'
  | 'task-batch-nodes'
  | 'effectref-nodes'
  | 'seed-sys-shapes'
  | 'backfill-hashes'

export interface AssetMigrationStepResult {
  step: AssetMigrationStep
  status: 'skipped' | 'done' | 'failed'
  detail?: string
}

export interface AssetMigrationReport {
  /** false = 主 flag 已置（此前已完成）——独立子步骤（sys-shapes seed）仍可能在本轮补跑。 */
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
      // 幂等重跑时同步显示名（文案演进不残留旧名；system id 恒定所以引用零影响）
      if (existing !== undefined) {
        if (existing.name !== SYSTEM_FOLDER_NAMES[id]) {
          await requestToPromise(nodes.put({ ...existing, name: SYSTEM_FOLDER_NAMES[id], updatedAt: timestamp }))
        }
        continue
      }
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
          referenceAssetId: meta.referenceAssetId,
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
        name: `${variantName ? `${variantName}·` : ''}${parsed.role === 'src' ? '原图' : '参考效果'}`,
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

// ---------------------------------------------------------------------------
// sys-shapes 内置规格 seed（gem-catalog 2.1——目录真源落库，Owner 裁决一）
// ---------------------------------------------------------------------------

export interface SysShapesSeedOutcome {
  /** 本轮新建的 specKey（声明序）。 */
  created: readonly string[]
  /** 已存在（含软删——删除不复活）而跳过的节点 id。 */
  skipped: readonly string[]
}

/** seed 条目 → .gemshape 文件字节（确定性：固定 epoch + APP_VERSION + 声明序序列化；
 *  seed 走 serialize 同口径校验，custom ingest 的异步贴图解码 gate 不在此路径——
 *  seed 贴图为嵌入常量，其六 gate 由 specCatalog/sysShapesSeed 测试以同一 verify 面证明）。 */
function gemshapeSeedBlob(seed: GemshapeSeedSpec): Blob {
  const text = serializeGemshape({
    appVersion: APP_VERSION,
    createdAt: GEMSHAPE_SEED_EPOCH,
    savedAt: GEMSHAPE_SEED_EPOCH,
    name: seed.nameZh,
    texture: seed.texture,
    ...(seed.vectorPath !== undefined ? { vectorPath: seed.vectorPath } : {}),
    physical: seed.physical,
    specKey: seed.specKey,
    calibration: { mode: 'direct' },
  })
  return new Blob([text], { type: PROJECT_MIME.gemshape })
}

/**
 * 幂等 seed「钻形」目录（planGemshapeSeeds create-only 计划 → ingestProjectAsset 确定性
 * 节点 id `ast-shape-${specKey}` 落 sys-shapes；节点存在（含软删）即跳过——删除不复活）。
 * 目录节点本身由 ingest 事务内 ensure 幂等补建（老库主迁移 flag 已置也兜得住）。
 */
export async function seedSysShapesCatalog(): Promise<SysShapesSeedOutcome> {
  const all = await listAllNodes()
  const plan = planGemshapeSeeds(GEMSHAPE_SEEDS, new Set(all.map((node) => node.id)))
  for (const seed of plan.create) {
    await ingestProjectAsset({
      blob: gemshapeSeedBlob(seed),
      name: seed.nameZh,
      projectKind: 'gemshape',
      parentId: SYS_SHAPES_FOLDER_ID,
      id: gemshapeSeedNodeId(seed.specKey),
      summary: { size: seed.shortCode },
    })
  }
  return { created: plan.create.map((seed) => seed.specKey), skipped: plan.skipped }
}

/** 独立子步骤执行器（成功置 flag；失败不置——下次启动重跑，幂等）。 */
async function runSysShapesSeedStep(): Promise<AssetMigrationStepResult> {
  try {
    await seedSysShapesCatalog()
    writeFlag(SYS_SHAPES_SEED_FLAG)
    return { step: 'seed-sys-shapes', status: 'done' }
  } catch (error) {
    return {
      step: 'seed-sys-shapes',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function doMigration(): Promise<AssetMigrationReport> {
  const hashesAlreadyDone = readFlag(HASH_BACKFILL_FLAG)
  const shapesAlreadySeeded = readFlag(SYS_SHAPES_SEED_FLAG)
  if (readFlag(MIGRATION_FLAG)) {
    // 既有库：主 flag 已置，但 sys-shapes seed 是独立子 flag（gem-catalog 2.1 后加）——仍要补跑。
    const steps: AssetMigrationStepResult[] = []
    if (!shapesAlreadySeeded) steps.push(await runSysShapesSeedStep())
    return { ran: false, completed: true, hashesCompleted: hashesAlreadyDone, steps, missingBlobNodeIds: [] }
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

  // sys-shapes seed（独立子 flag，与主 flag 解耦——失败下次重跑；置入 steps 供诊断可见）。
  if (!shapesAlreadySeeded) {
    steps.push(await runSysShapesSeedStep())
  } else {
    steps.push({ step: 'seed-sys-shapes', status: 'skipped' })
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

/** 模块态复位（objectURL 缓存/pin 表与 lease 计数表/迁移并发闸）；不动 IndexedDB / localStorage，由测试自理。 */
export function resetAssetStoreForTests(): void {
  for (const url of objectUrlCache.values()) URL.revokeObjectURL(url)
  objectUrlCache.clear()
  pinnedAssets.clear()
  projectLeases.clear()
  leasePinRefs.clear()
  migrationInFlight = null
}

export function setObjectUrlCacheLimitForTests(limit: number): void {
  objectUrlCacheLimit = limit
}

/**
 * [add-project-files 0.4] runTx 契约测试专用出口（design §9.1 B1 终态语义）：
 * 生产代码勿用——直接驱动事务执行器以构造「body 已返回值但事务未提交」等终态竞争。
 */
export const runTxForTests = runTx
