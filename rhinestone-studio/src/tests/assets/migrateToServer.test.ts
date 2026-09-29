/*
 * [split-admin-portal 4.3/4.5] IDB→服务端迁移核验测试（合成 IDB fixture→上行→核对）。
 * 覆盖：
 *   [1] 全链：目录树先行（拓扑序）+内容后行（分批）→migrateVerify match=true
 *       （数量/字节/digest 三面——fake 服务端按 daemon 同算法重算）。
 *   [2] 重试幂等：整链重跑→全部 existing；节点零新增。
 *   [3] 跳过面：软删/外链/项目节点/sys-trash 目录根不入迁移清单（skipped 如实上报）。
 *   [4] 红线：迁移后 IDB 原数据仍在（listAllNodes 数量不变——不删本地）。
 *   [5] 核验不符：服务端清单缺一张→match=false+missing-on-server 不符清单
 *       （内容 hash 对齐）。
 *   [6] 中断面：migrateBatch 抛错→error 如实上报（可重跑收敛）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assetsLibManifestPayload,
  type AssetsLibMigrateBatchOutput,
  type AssetsLibMigrateItem,
  type AssetsLibMigrateVerifyInput,
  type AssetsLibMigrateVerifyOutput,
} from '@handicraft/contracts'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'
import {
  createFolder,
  ingestAsset,
  listAllNodes,
  resetAssetStoreForTests,
  runAssetMigration,
  trashAsset,
  type AssetNode,
} from '$lib/persistence/assetStore'
import { migrateAssetsToServer } from '$lib/persistence/migrateToServer'

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

function pngBlob(bytes: number[]): Blob {
  // PNG 魔数（嗅探面）+差异字节（内容 hash 区分）
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes])], { type: 'image/png' })
}

/** 仿 daemon 服务端（确定性 id+同算法 digest——fake 与实现两端算法一致性前提）。 */
function makeServerFixture() {
  const nodes = new Map<string, { name: string; isDir: boolean; parentId: string | null; blobHash: string | null; bytes: number }>()
  const calls = {
    batches: [] as AssetsLibMigrateItem[][],
    verifies: [] as AssetsLibMigrateVerifyInput[],
  }
  const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
    // slice() 产出独立 ArrayBuffer（BufferSource 精确类型——不改调用方字节）。
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  const base64ToBytes = (dataBase64: string): Uint8Array => {
    const binary = atob(dataBase64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
    return out
  }
  const idOf = (clientId: string) => `al-user:${clientId}`
  return {
    calls,
    nodes,
    async migrateBatch(items: AssetsLibMigrateItem[]): Promise<AssetsLibMigrateBatchOutput> {
      calls.batches.push(items)
      const results = []
      for (const item of items) {
        const id = idOf(item.clientId)
        if (nodes.has(id)) {
          results.push({ clientId: item.clientId, status: 'existing' as const, id })
          continue
        }
        nodes.set(id, {
          name: item.name,
          isDir: item.isDir,
          parentId: item.parentClientId !== null ? idOf(item.parentClientId) : null,
          blobHash: item.isDir ? null : await sha256Hex(base64ToBytes(item.dataBase64)),
          bytes: item.isDir ? 0 : base64ToBytes(item.dataBase64).byteLength,
        })
        results.push({ clientId: item.clientId, status: 'created' as const, id })
      }
      return { results }
    },
    async migrateVerify(input: AssetsLibMigrateVerifyInput): Promise<AssetsLibMigrateVerifyOutput> {
      calls.verifies.push(input)
      const serverNodes = [...nodes.entries()]
        .filter(([, node]) => !node.isDir && node.blobHash !== null)
        .map(([id, node]) => ({ id, name: node.name, blobHash: node.blobHash!, bytes: node.bytes }))
      const digest = await sha256Hex(new TextEncoder().encode(assetsLibManifestPayload(serverNodes)))
      const serverBytes = serverNodes.reduce((sum, node) => sum + node.bytes, 0)
      return {
        match:
          serverNodes.length === input.declaredCount &&
          serverBytes === input.declaredBytes &&
          digest === input.declaredDigest,
        serverCount: serverNodes.length,
        serverBytes,
        serverDigest: digest,
        serverNodes,
      }
    },
  }
}

/** 合成 IDB fixture：跑资产迁移种子（系统目录/外链案例/钻形 seed）+用户目录树+图片。 */
async function seedIdbFixture(): Promise<number> {
  await runAssetMigration()
  const uploadsLike = await createFolder(null, '上传')
  const outer = await createFolder(null, '手办')
  const inner = await createFolder(outer.id, '细节')
  await ingestAsset({ blob: pngBlob([1]), name: 'p1.png', width: 4, height: 4, parentId: uploadsLike.id, source: 'upload' })
  await ingestAsset({ blob: pngBlob([2]), name: 'p2.png', width: 4, height: 4, parentId: outer.id, source: 'upload' })
  await ingestAsset({ blob: pngBlob([1]), name: 'p1-副本.png', width: 4, height: 4, parentId: inner.id, source: 'upload' })
  const trashed = await ingestAsset({ blob: pngBlob([9]), name: '旧图.png', width: 4, height: 4, parentId: uploadsLike.id, source: 'upload' })
  await trashAsset(trashed.node.id)
  return (await listAllNodes()).length
}

describe('[1][3][4] 全链迁移+跳过面+红线（不删本地）', () => {
  it('目录树先行+内容后行→核验 match=true；skipped 如实；IDB 原数据不动', async () => {
    const idbNodeCount = await seedIdbFixture()
    const server = makeServerFixture()
    const report = await migrateAssetsToServer({
      migrateBatch: (items) => server.migrateBatch(items),
      migrateVerify: (input) => server.migrateVerify(input),
    })

    expect(report.error).toBeNull()
    // 迁移面=本地图片素材：用户 3 张（第 4 张软删跳过）
    expect(report.imagesPlanned).toBe(3)
    // 跳过面（按 IDB 实况动态断言——系统种子外链/项目/软删/回收站根不入迁移面）
    const allNodes: AssetNode[] = await listAllNodes()
    const reasons = new Set(report.skipped.map((item) => item.reason))
    expect(reasons.has('trashed')).toBe(true)
    expect(reasons.has('trash-root')).toBe(true)
    if (allNodes.some((node) => node.type === 'image' && node.refKind === 'external')) {
      expect(reasons.has('external')).toBe(true)
    }
    if (allNodes.some((node) => node.type === 'project')) {
      expect(reasons.has('project')).toBe(true)
    }
    // 目录树先行：首批只含目录
    const firstBatch = server.calls.batches[0]!
    expect(firstBatch.length > 0 && firstBatch.every((item) => item.isDir)).toBe(true)
    // 拓扑序：父目录先于子目录上行
    const outerIdx = firstBatch.findIndex((item) => item.name === '手办')
    const innerIdx = firstBatch.findIndex((item) => item.name === '细节')
    expect(outerIdx).toBeGreaterThanOrEqual(0)
    expect(innerIdx).toBeGreaterThan(outerIdx)
    // 同内容去重：p1 与 p1-副本 服务端同 hash（不同节点行）
    const imageNodes = [...server.nodes.values()].filter((node) => !node.isDir)
    expect(imageNodes).toHaveLength(3)
    expect(new Set(imageNodes.map((node) => node.blobHash)).size).toBe(2)
    // 核验三面 match（数量/字节/digest）
    expect(report.verify?.match).toBe(true)
    expect(report.verify?.serverCount).toBe(3)
    expect(report.mismatches).toEqual([])
    // 红线：IDB 原数据未删（节点数不变——清理归 Owner 人工裁决）
    expect((await listAllNodes()).length).toBe(idbNodeCount)
  })
})

describe('[2] 重试幂等', () => {
  it('整链重跑→existing 全命中+服务端节点零新增', async () => {
    await seedIdbFixture()
    const server = makeServerFixture()
    const deps = {
      migrateBatch: (items: AssetsLibMigrateItem[]) => server.migrateBatch(items),
      migrateVerify: (input: AssetsLibMigrateVerifyInput) => server.migrateVerify(input),
    }
    const first = await migrateAssetsToServer(deps)
    expect(first.created).toBeGreaterThan(0)
    const nodeCountAfterFirst = server.nodes.size
    const second = await migrateAssetsToServer(deps)
    expect(second.created).toBe(0)
    expect(second.existing).toBe(first.created + first.existing)
    expect(server.nodes.size).toBe(nodeCountAfterFirst)
    expect(second.verify?.match).toBe(true)
  })
})

describe('[5] 核验不符面', () => {
  it('服务端清单缺一张→match=false+missing-on-server 清单（内容 hash 对齐）', async () => {
    await seedIdbFixture()
    const server = makeServerFixture()
    const report = await migrateAssetsToServer({
      migrateBatch: (items) => server.migrateBatch(items),
      migrateVerify: async (input) => {
        const out = await server.migrateVerify(input)
        // 构造服务端缺一张的核验面（模拟上行半途丢失——核验必须抓住）
        return {
          ...out,
          match: false,
          serverCount: out.serverCount - 1,
          serverNodes: out.serverNodes.filter((node) => node.name !== 'p2.png'),
        }
      },
    })
    expect(report.error).toBeNull()
    expect(report.verify?.match).toBe(false)
    expect(report.mismatches.length).toBeGreaterThan(0)
    expect(report.mismatches.some((item) => item.kind === 'missing-on-server' && item.name === 'p2.png')).toBe(true)
  })
})

describe('[6] 中断面（可重跑收敛）', () => {
  it('migrateBatch 抛错→error 如实上报；不删本地', async () => {
    const idbNodeCount = await seedIdbFixture()
    let calls = 0
    const report = await migrateAssetsToServer({
      migrateBatch: () => {
        calls += 1
        if (calls > 1) return Promise.reject(new Error('WS 断连'))
        return Promise.resolve({ results: [] })
      },
      migrateVerify: () => Promise.reject(new Error('不可达')),
    })
    expect(report.error).toContain('WS 断连')
    expect(report.batchesSent).toBe(1)
    expect(report.verify).toBeNull()
    expect((await listAllNodes()).length).toBe(idbNodeCount)
  })
})
