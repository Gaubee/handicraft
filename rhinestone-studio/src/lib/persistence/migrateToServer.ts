/*
 * IDB → 服务端素材库迁移（split-admin-portal 4.3——素材库服务化的搬运面）。
 * 原始需求 2026-09-29（design §5 素材库行 + 简报红线）：
 *   - 可重试：服务端确定性 id（al-<ownerId>:<clientId>）幂等 upsert——中断整链
 *     重跑，已上行项 status='existing' 跳过、blob 引用计数不漂移。
 *   - 核验：migrateVerify 清单 hash 汇总比对（数量/字节/digest 三面）+ 不符清单
 *     （按内容 hash 对齐本地清单 vs 服务端 serverNodes）。
 *   - 红线（Codex）：核验通过前**不删 IDB 原数据**——本模块只读 assetStore，
 *     不触碰任何删除入口（清理动作归 Owner 人工裁决的后续波）。
 * 迁移范围（4.3 首版裁定）：图片素材（type='image' 且 refKind='blob'）；软删/
 *   外链（preset 案例图）/项目节点（gemproj 族——项目域服务化与选取器同挂后续
 *   波）跳过并计入报告 skipped 清单（不静默丢）。
 * 编排（目录树先行+内容后行——父引用批外解析依赖此序）：
 *   [1] collect：listAllNodes 分流（目录/图片/跳过）+ 逐图片内容 sha256（申报
 *       digest 与不符清单的对齐键——同内容多节点天然去重）。
 *   [2] upload：目录按拓扑序（父先于子）分批 migrateBatch；图片按字节量分批
 *       （≤32 项且 ≤8MiB/批）。
 *   [3] verify：declared{count,bytes,digest} → migrateVerify → 报告。
 * 依赖注入：MigrateToServerDeps（adminApi 的两方法闭包——测试注入替身）。
 */
import { assetsLibManifestPayload, type AssetsLibMigrateBatchOutput, type AssetsLibMigrateItem, type AssetsLibMigrateVerifyInput, type AssetsLibMigrateVerifyOutput } from '@handicraft/contracts'
import { getImageBlob } from './imageStore'
import { listAllNodes, TRASH_FOLDER_ID, type AssetNode } from './assetStore'

/** 迁移 RPC 依赖（adminApi.assetsLibMigrateBatch/Verify 的闭包面——测试可注入替身）。 */
export interface MigrateToServerDeps {
  migrateBatch(items: AssetsLibMigrateItem[]): Promise<AssetsLibMigrateBatchOutput>
  migrateVerify(input: AssetsLibMigrateVerifyInput): Promise<AssetsLibMigrateVerifyOutput>
}

/** 进度回调（stage 粒度——UI 进度条/日志用）。 */
export type MigrationProgress = (stage: 'collect' | 'upload-dirs' | 'upload-images' | 'verify', done: number, total: number) => void

/** 跳过项（不静默丢——报告呈现）。 */
export interface MigrationSkip {
  id: string
  name: string
  reason: 'trashed' | 'external' | 'project' | 'trash-root'
}

/** 不符清单项（核验未过时的差集——按内容 hash 对齐）。 */
export interface MigrationMismatch {
  kind: 'missing-on-server' | 'unexpected-on-server'
  name: string
  blobHash: string
  bytes: number
}

export interface MigrationReport {
  dirsPlanned: number
  imagesPlanned: number
  skipped: MigrationSkip[]
  batchesSent: number
  created: number
  existing: number
  verify: AssetsLibMigrateVerifyOutput | null
  mismatches: MigrationMismatch[]
  /** 中断/失败原因（null=跑完核验链）。 */
  error: string | null
}

/** 单批图片项数/字节界（保守——WS 帧与服务端批界之内再收一档）。 */
const IMAGES_PER_BATCH = 32
const IMAGE_BATCH_BYTES = 8 * 1024 * 1024
const DIRS_PER_BATCH = 64

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Blob → 纯 base64（分块 btoa——大图不撑爆参数栈）。 */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** 目录拓扑序（父先于子——parentId 链深度排序；孤儿父（异常态）沉底不阻批）。 */
function dirsInTopologicalOrder(nodes: AssetNode[]): AssetNode[] {
  const dirs = nodes.filter((node) => node.type === 'folder')
  const depthOf = (node: AssetNode): number => {
    let depth = 0
    let cursor = node.parentId
    while (cursor !== null) {
      depth += 1
      const parent = dirs.find((candidate) => candidate.id === cursor)
      if (parent === undefined) return Number.MAX_SAFE_INTEGER
      cursor = parent.parentId
    }
    return depth
  }
  return [...dirs].sort((a, b) => depthOf(a) - depthOf(b))
}

/**
 * 执行迁移（可整链重跑）。失败即停并如实上报（error + 已完成批次计数）——
 * 不回滚不删本地（服务端确定性 id 使重跑收敛）。
 */
export async function migrateAssetsToServer(
  deps: MigrateToServerDeps,
  onProgress: MigrationProgress = () => {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    dirsPlanned: 0,
    imagesPlanned: 0,
    skipped: [],
    batchesSent: 0,
    created: 0,
    existing: 0,
    verify: null,
    mismatches: [],
    error: null,
  };
  try {
    // ---- [1] collect：分流 + 内容 hash。
    const nodes = await listAllNodes()
    const dirs = dirsInTopologicalOrder(nodes).filter((node) => {
      if (node.id === TRASH_FOLDER_ID) {
        report.skipped.push({ id: node.id, name: node.name, reason: 'trash-root' })
        return false
      }
      return true
    })
    report.dirsPlanned = dirs.length
    const images: Array<{ node: AssetNode & { type: 'image' }; blob: Blob; hash: string }> = []
    let collected = 0
    for (const node of nodes) {
      if (node.type === 'folder') continue
      if (node.trashedAt !== undefined) {
        report.skipped.push({ id: node.id, name: node.name, reason: 'trashed' })
        continue
      }
      if (node.type === 'project') {
        report.skipped.push({ id: node.id, name: node.name, reason: 'project' })
        continue
      }
      if (node.refKind === 'external') {
        report.skipped.push({ id: node.id, name: node.name, reason: 'external' })
        continue
      }
      const blob = await getImageBlob(node.blobKey ?? '')
      if (blob === null) {
        report.skipped.push({ id: node.id, name: node.name, reason: 'external' })
        continue
      }
      images.push({ node, blob, hash: await sha256OfBlob(blob) })
      collected += 1
      onProgress('collect', collected, nodes.length)
    }
    report.imagesPlanned = images.length

    // ---- [2a] 目录树先行（拓扑序分批）。
    for (let offset = 0; offset < dirs.length; offset += DIRS_PER_BATCH) {
      const items: AssetsLibMigrateItem[] = dirs.slice(offset, offset + DIRS_PER_BATCH).map((dir) => ({
        clientId: dir.id,
        name: dir.name,
        parentClientId: dir.parentId,
        isDir: true as const,
      }))
      const out = await deps.migrateBatch(items)
      report.batchesSent += 1
      for (const result of out.results) {
        if (result.status === 'created') report.created += 1
        else report.existing += 1
      }
      onProgress('upload-dirs', Math.min(offset + DIRS_PER_BATCH, dirs.length), dirs.length)
    }

    // ---- [2b] 内容后行（字节量分批）。
    let batchItems: AssetsLibMigrateItem[] = []
    let batchBytes = 0
    const flushImages = async (): Promise<void> => {
      if (batchItems.length === 0) return
      const out = await deps.migrateBatch(batchItems)
      report.batchesSent += 1
      for (const result of out.results) {
        if (result.status === 'created') report.created += 1
        else report.existing += 1
      }
      onProgress('upload-images', report.existing + report.created - dirs.length, images.length)
      batchItems = []
      batchBytes = 0
    }
    let uploaded = 0
    for (const entry of images) {
      const dataBase64 = await blobToBase64(entry.blob)
      batchItems.push({
        clientId: entry.node.id,
        name: entry.node.name,
        parentClientId: entry.node.parentId,
        isDir: false as const,
        dataBase64,
        ...(entry.node.width > 0 ? { width: entry.node.width } : {}),
        ...(entry.node.height > 0 ? { height: entry.node.height } : {}),
      })
      batchBytes += entry.blob.size
      uploaded += 1
      if (batchItems.length >= IMAGES_PER_BATCH || batchBytes >= IMAGE_BATCH_BYTES) await flushImages()
      onProgress('upload-images', uploaded, images.length)
    }
    await flushImages()

    // ---- [3] verify：申报清单（count=图片节点数；bytes=节点字节和；digest=去重内容清单）。
    const declaredDigestSource = assetsLibManifestPayload(
      [...new Map(images.map((entry) => [entry.hash, { blobHash: entry.hash, bytes: entry.blob.size }])).values()],
    )
    const declaredBytes = images.reduce((sum, entry) => sum + entry.blob.size, 0)
    const declared: AssetsLibMigrateVerifyInput = {
      declaredCount: images.length,
      declaredBytes,
      declaredDigest: await sha256OfBlob(new Blob([declaredDigestSource])),
    }
    const verify = await deps.migrateVerify(declared)
    report.verify = verify
    onProgress('verify', 1, 1)

    // ---- 不符清单（内容 hash 对齐——本地 vs serverNodes）。
    if (!verify.match) {
      const localHashes = new Set(images.map((entry) => entry.hash))
      const serverHashes = new Set(verify.serverNodes.map((node) => node.blobHash))
      for (const entry of images) {
        if (!serverHashes.has(entry.hash)) {
          report.mismatches.push({ kind: 'missing-on-server', name: entry.node.name, blobHash: entry.hash, bytes: entry.blob.size })
        }
      }
      for (const node of verify.serverNodes) {
        if (!localHashes.has(node.blobHash)) {
          report.mismatches.push({ kind: 'unexpected-on-server', name: node.name, blobHash: node.blobHash, bytes: node.bytes })
        }
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  }
  return report
}
