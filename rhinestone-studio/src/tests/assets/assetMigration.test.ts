/**
 * assetStore 启动迁移（design §3）：幂等五步 + 独立补哈希子 flag。
 * 覆盖：注入中途失败重跑收敛、跑两次一致、v1 旧数据回读、补哈希幂等、
 * blob 缺失节点照建标 missing、flag 置位语义。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listAllNodes,
  listContentHashes,
  resetAssetStoreForTests,
  runAssetMigration,
  type AssetImage,
  type AssetMigrationReport,
} from '$lib/persistence/assetStore'
import { getImageBlob, listImages } from '$lib/persistence/imageStore'
import {
  LEGACY_RUN_ID,
  loadTaskMetas,
  saveTaskMetas,
  saveVariants,
  type PersistedTaskMeta,
} from '$lib/persistence/taskStore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

function pngBytes(seed: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([seed, seed + 1, seed + 2])
}

function taskMeta(overrides: Partial<PersistedTaskMeta>): PersistedTaskMeta {
  return {
    id: 'task-a',
    runId: 'run-1',
    variantId: 'var-1',
    variantName: '花环',
    candidateIndex: 0,
    prompt: 'a prompt',
    mode: 'generate',
    model: 'gpt-image-2.5',
    size: '1024x1024',
    advancedJson: '{}',
    status: 'success',
    hasReference: false,
    imageStored: true,
    createdAt: 1700000000000,
    ...overrides,
  }
}

/**
 * 构造 v1 旧库：绕过 imageStore（其 opener 已是 v2），手工以 version=1 打开，
 * 只建 images store 并写入旧物理键记录——模拟老版本用户数据。
 */
async function buildV1Database(
  records: Array<{ id: string; bytes: Uint8Array<ArrayBuffer>; createdAt?: number }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = fake.open('rhinestone-studio', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

  type FakeDb = Awaited<ReturnType<FakeIndexedDB['open']>>['result']
  const opened = await new Promise<FakeDb>((resolve, reject) => {
    const request = fake.open('rhinestone-studio', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  for (const record of records) {
    await new Promise<void>((resolve, reject) => {
      const tx = opened.transaction('images', 'readwrite')
      const put = tx.objectStore('images').put({
        id: record.id,
        blob: new Blob([record.bytes], { type: 'image/png' }),
        createdAt: record.createdAt ?? 1700000000000,
      })
      put.onsuccess = () => resolve()
      put.onerror = () => reject(put.error)
    })
  }
}

async function nodeById(id: string): Promise<AssetImage | null> {
  const found = (await listAllNodes()).find((n) => n.id === id)
  return found && found.type === 'image' ? found : null
}

describe('迁移：fresh 库全链', () => {
  it('空库：seed 七系统目录（含 sys-projects 1.1 / sys-templates 4.2）+ 8 案例 × (src?)+res 外链节点 + 双 flag 置位', async () => {
    const report = await runAssetMigration()

    expect(report.ran).toBe(true)
    expect(report.completed).toBe(true)
    expect(report.hashesCompleted).toBe(true)
    expect(report.missingBlobNodeIds).toEqual([])
    expect(report.steps.map((s) => [s.step, s.status])).toEqual([
      ['seed-system-folders', 'done'],
      ['preset-case-nodes', 'done'],
      ['task-batch-nodes', 'done'],
      ['effectref-nodes', 'done'],
      ['backfill-hashes', 'done'],
    ])

    const nodes = await listAllNodes()
    const folders = nodes.filter((n) => n.type === 'folder')
    expect(folders.map((f) => f.id).sort()).toEqual(
      ['sys-cases', 'sys-templates', 'sys-exports', 'sys-generated', 'sys-projects', 'sys-trash', 'sys-uploads'].sort(),
    )
    // 系统目录 parentId=null + 中文名
    for (const folder of folders) {
      expect(folder.parentId).toBeNull()
      expect(folder.name.length).toBeGreaterThan(0)
    }

    const caseEntries = nodes.filter((n) => n.parentId === 'sys-cases' && n.type === 'image') as AssetImage[]
    // 8 preset：6 组双图 + 2 组仅效果图 = 14
    expect(caseEntries).toHaveLength(14)
    expect(caseEntries.every((n) => n.refKind === 'external' && n.source === 'preset')).toBe(true)
    const src = caseEntries.find((n) => n.id === 'ast-preset-new-orleans-src')
    expect(src?.externalUrl).toBe('/presets/new-orleans-src.jpg')
    expect(src?.meta?.originNote).toBeTruthy()

    expect(localStorage.getItem('rhinestone-studio:asset-migration-v2')).toBe('done')
    expect(localStorage.getItem('rhinestone-studio:asset-migration-v2-hashes')).toBe('done')
  })

  it('跑两次一致：第二轮 ran=false 空跑，节点/哈希计数不变', async () => {
    await runAssetMigration()
    const nodesAfterFirst = (await listAllNodes()).length
    const hashesAfterFirst = (await listContentHashes()).length

    const second = await runAssetMigration()
    expect(second.ran).toBe(false)
    expect(second.completed).toBe(true)
    expect((await listAllNodes()).length).toBe(nodesAfterFirst)
    expect((await listContentHashes()).length).toBe(hashesAfterFirst)
  })
})

describe('迁移：v1 旧数据回读 + 步骤语义', () => {
  beforeEach(async () => {
    await buildV1Database([
      { id: 'task-run1', bytes: pngBytes(1), createdAt: 1700000000000 },
      { id: 'task-run2', bytes: pngBytes(2), createdAt: 1700000100000 },
      { id: 'task-legacy', bytes: pngBytes(3), createdAt: 1699000000000 },
      { id: 'effectref-var-1-src-1700000000001', bytes: pngBytes(4), createdAt: 1700000000001 },
      { id: 'effectref-var-1-res-1700000000001', bytes: pngBytes(5), createdAt: 1700000000002 },
    ])
    saveVariants([{ id: 'var-1', name: '圣诞花环', prompt: 'p', candidates: 2, enabled: true }])
    saveTaskMetas([
      taskMeta({ id: 'task-run1', runId: 'run-1', createdAt: 1700000000000, variantName: '花环' }),
      taskMeta({ id: 'task-run2', runId: 'run-2', createdAt: 1700000100000, variantName: '天使' }),
      taskMeta({ id: 'task-legacy', runId: LEGACY_RUN_ID, createdAt: 1699000000000 }),
      taskMeta({ id: 'task-gone', runId: 'run-1', status: 'success', imageStored: true, createdAt: 1700000050000 }),
      taskMeta({ id: 'task-failed', status: 'error', createdAt: 1700000060000 }),
    ])
  })

  it('批次夹命名/归置、任务节点、effectref 节点、blob 不搬不复制', async () => {
    const report = await runAssetMigration()
    expect(report.completed).toBe(true)
    expect(report.missingBlobNodeIds).toEqual(['ast-task-task-gone']) // blob 缺失照建 + 上报

    const nodes = await listAllNodes()
    const folderNames = new Map(nodes.filter((n) => n.type === 'folder').map((f) => [f.id, f.name]))

    // 批次夹：run-1（更早）= 第 1 次，run-2 = 第 2 次；legacy = 更早
    expect(folderNames.get('ast-batch-run-1')).toMatch(/^第 1 次生成 · \d{2}-\d{2} \d{2}:\d{2}$/)
    expect(folderNames.get('ast-batch-run-2')).toMatch(/^第 2 次生成 · \d{2}-\d{2} \d{2}:\d{2}$/)
    expect(folderNames.get('ast-batch-legacy')).toBe('更早')

    // 任务节点：blobKey 指回旧键（不搬不复制），meta 带 runId；失败任务不建节点
    const run1 = await nodeById('ast-task-task-run1')
    expect(run1?.blobKey).toBe('task-run1')
    expect(run1?.parentId).toBe('ast-batch-run-1')
    expect(run1?.meta?.runId).toBe('run-1')
    expect(run1?.bytes).toBe(3)
    expect(await nodeById('ast-task-task-failed')).toBeNull()
    // blob 缺失节点照建（missing 由解析出口返回 null 体现）
    expect(await nodeById('ast-task-task-gone')).not.toBeNull()

    // effectref 节点入 sys-uploads，配对命名 + 变体名
    const efSrc = await nodeById('ast-effectref-var-1-src-1700000000001')
    const efRes = await nodeById('ast-effectref-var-1-res-1700000000001')
    expect(efSrc?.parentId).toBe('sys-uploads')
    expect(efSrc?.source).toBe('migrated')
    expect(efSrc?.name).toBe('圣诞花环·参考原图')
    expect(efRes?.name).toBe('圣诞花环·参考效果')
    expect(efSrc?.meta?.variantName).toBe('圣诞花环')

    // v1 旧数据回读：images store 记录原样可读（键与字节不变）
    const blob = await getImageBlob('effectref-var-1-res-1700000000001')
    expect(blob?.size).toBe(3)
    expect((await listImages()).map((r) => r.id).sort()).toEqual(
      [
        'task-run1',
        'task-run2',
        'task-legacy',
        'effectref-var-1-src-1700000000001',
        'effectref-var-1-res-1700000000001',
      ].sort(),
    )

    // 补哈希：5 条内容各异 → 5 条注册，physicalKey 全部指回旧键
    const hashes = await listContentHashes()
    expect(hashes).toHaveLength(5)
    expect(new Set(hashes.map((h) => h.physicalKey))).toEqual(
      new Set([
        'task-run1',
        'task-run2',
        'task-legacy',
        'effectref-var-1-src-1700000000001',
        'effectref-var-1-res-1700000000001',
      ]),
    )
  })

  it('注入中途失败（preset 节点 put）→ 主 flag 不置；重跑收敛（已完成步骤存在即跳过）', async () => {
    fake.failNext({ store: 'assetNodes', op: 'put', key: 'ast-preset-new-orleans-res' })
    const first = await runAssetMigration()

    expect(first.completed).toBe(false)
    expect(first.steps.map((s) => [s.step, s.status])).toEqual([
      ['seed-system-folders', 'done'],
      ['preset-case-nodes', 'failed'],
      ['backfill-hashes', 'done'], // 补哈希与主链解耦，独立完成
    ])
    expect(localStorage.getItem('rhinestone-studio:asset-migration-v2')).toBeNull()
    expect(localStorage.getItem('rhinestone-studio:asset-migration-v2-hashes')).toBe('done')

    // seed 已完成（存在即跳过）；preset 全量回滚 → 重跑重建
    const nodesAfterFailure = await listAllNodes()
    expect(nodesAfterFailure.filter((n) => n.parentId === 'sys-cases')).toHaveLength(0)
    expect(nodesAfterFailure.filter((n) => n.type === 'folder' && n.system).length).toBe(7)

    const second = await runAssetMigration()
    expect(second.completed).toBe(true)
    expect(second.steps.map((s) => [s.step, s.status])).toEqual([
      ['seed-system-folders', 'skipped'],
      ['preset-case-nodes', 'done'],
      ['task-batch-nodes', 'done'],
      ['effectref-nodes', 'done'],
      ['backfill-hashes', 'skipped'],
    ])
    expect(localStorage.getItem('rhinestone-studio:asset-migration-v2')).toBe('done')

    // 收敛后状态与一次成功等价
    const nodes = await listAllNodes()
    expect(nodes.filter((n) => n.parentId === 'sys-cases' && n.type === 'image')).toHaveLength(14)
    expect(await nodeById('ast-task-task-run1')).not.toBeNull()
    expect(await listContentHashes()).toHaveLength(5)
  })

  it('主链失败不阻断补哈希；补哈希子 flag 幂等（重跑不再计算）', async () => {
    // 破坏 localStorage 任务元数据读取 → task-batch 步骤前先让 preset 步骤失败
    fake.failNext({ store: 'assetNodes', op: 'put', key: 'ast-preset-boston-res' })
    const first = await runAssetMigration()
    expect(first.completed).toBe(false)
    expect(first.hashesCompleted).toBe(true)
    expect((await listContentHashes()).length).toBe(5)

    // 第二轮：哈希子 flag 已置 → skipped 且计数不变
    const second = await runAssetMigration()
    const hashStep = second.steps.find((s) => s.step === 'backfill-hashes')
    expect(hashStep?.status).toBe('skipped')
    expect(await listContentHashes()).toHaveLength(5)
  })
})

describe('迁移：同内容跨旧键去重注册', () => {
  it('两条同内容旧记录只注册一条哈希（先到先注册，put-if-absent）', async () => {
    await buildV1Database([
      { id: 'old-a', bytes: pngBytes(9) },
      { id: 'old-b', bytes: pngBytes(9) },
    ])
    const report = await runAssetMigration()
    expect(report.hashesCompleted).toBe(true)
    const hashes = await listContentHashes()
    expect(hashes).toHaveLength(1)
    expect(['old-a', 'old-b']).toContain(hashes[0].physicalKey)
  })
})

describe('迁移报告与任务元数据', () => {
  it('loadTaskMetas 往返含 referenceAssetId（B-3/B-4 字段贯通）', async () => {
    saveTaskMetas([taskMeta({ id: 'task-ref', referenceAssetId: 'ast-abc' })])
    const metas = loadTaskMetas()
    expect(metas.find((m) => m.id === 'task-ref')?.referenceAssetId).toBe('ast-abc')
    const report: AssetMigrationReport = await runAssetMigration()
    expect(report.completed).toBe(true)
    const node = await nodeById('ast-task-task-ref')
    expect(node?.blobKey).toBe('task-ref')
    // [Owner] 配对透传：迁移节点 meta 携带参考原图关联
    expect(node?.meta?.referenceAssetId).toBe('ast-abc')
  })
})
