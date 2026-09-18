/**
 * assetStore §1 契约全量（add-asset-library design §1-§4）：
 * 解析四态 / 环检测 / 递归软删原子性 / 重名后缀 / 系统目录保护 / pin 表 /
 * dedup 全场景（同内容二传零新增 blob、同目录一条、跨目录链接、清一条另一条存活、
 * 全清才删字节、objectURL 共享）/ objectURL LRU / 迁移种子辅助。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASSET_OBJECT_URL_CACHE_LIMIT,
  createFolder,
  emptyTrash,
  getAsset,
  getAssetBlob,
  getDownloadSource,
  ingestAsset,
  isAssetPinned,
  listAllNodes,
  listChildNodes,
  listContentHashes,
  listPinnedAssetIds,
  moveAsset,
  objectUrlForAsset,
  pinAsset,
  releaseObjectUrl,
  renameAsset,
  resetAssetStoreForTests,
  runAssetMigration,
  setObjectUrlCacheLimitForTests,
  trashAsset,
  unpinAsset,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { listImages } from '$lib/persistence/imageStore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let objectUrlCounter = 0
let createObjectUrl: ReturnType<typeof vi.fn>
let revokeObjectUrl: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  setObjectUrlCacheLimitForTests(ASSET_OBJECT_URL_CACHE_LIMIT)
  localStorage.clear()
  objectUrlCounter = 0
  createObjectUrl = vi.fn(() => `blob:asset-${(objectUrlCounter += 1)}`)
  revokeObjectUrl = vi.fn()
  vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

function png(bytes: number[], name = 'pic.png'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

async function ingestRoot(bytes: number[], name = 'pic.png'): Promise<AssetImage> {
  const result = await ingestAsset({
    blob: png(bytes, name),
    name,
    width: 10,
    height: 20,
    parentId: null,
    source: 'upload',
  })
  return result.node
}

/** 需要系统目录存在的用例：先跑一轮迁移 seed（也顺带覆盖 seed 步）。 */
async function seedSystemFolders(): Promise<void> {
  await runAssetMigration()
}

describe('IDB v2 upgrade 与 index（design §2）', () => {
  it('首个 assetStore 操作触发 v2 upgrade：assetNodes+contentHashes 建齐、四 index 可查、images 共存', async () => {
    await ingestRoot([1])
    expect(fake.version).toBe(2)

    const nodes = await listAllNodes()
    expect(nodes.every((n) => typeof n.id === 'string' && typeof n.updatedAt === 'number')).toBe(true)

    const rootChildren = await listChildNodes(null)
    expect(rootChildren.map((n) => n.id)).toContain((await listAllNodes())[0].id)

    // updatedAt / trashedAt / blobKey index 经真实查询路径覆盖（listContentHashes 走 contentHashes store）
    expect(await listContentHashes()).toHaveLength(1)

    // images store 不动：内容哈希键记录共存
    expect((await listImages()).map((r) => r.id)).toHaveLength(1)
  })
})

describe('解析出口四态（design §1.1，签名冻结）', () => {
  it('blob 节点：getAsset 带模型字段，getAssetBlob 返回原字节', async () => {
    const node = await ingestRoot([1, 2, 3], 'wreath.png')
    const asset = await getAsset(node.id)
    expect(asset).toMatchObject({
      id: node.id,
      type: 'image',
      refKind: 'blob',
      name: 'wreath.png',
      parentId: null,
      width: 10,
      height: 20,
      bytes: 3,
      source: 'upload',
    })
    const blob = await getAssetBlob(node.id)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.size).toBe(3)
    expect(blob?.type).toBe('image/png')
    const url = await objectUrlForAsset(node.id)
    expect(url).toBe('blob:asset-1')
  })

  it('外链节点：getAssetBlob → null；objectUrlForAsset 原样返回 externalUrl', async () => {
    await seedSystemFolders()
    const external = (await listChildNodes('sys-cases')).find((n) => n.type === 'image') as AssetImage
    expect(external.refKind).toBe('external')
    expect(await getAssetBlob(external.id)).toBeNull()
    expect(await objectUrlForAsset(external.id)).toBe(external.externalUrl)
  })

  it('缺失 blob（key 无记录）：getAssetBlob/objectUrlForAsset → null，节点仍在', async () => {
    const node = await ingestRoot([9])
    // 直接删底层 images 记录（绕过引用计数，模拟浏览器存储被清理）
    const { deleteImage } = await import('$lib/persistence/imageStore')
    await deleteImage(node.blobKey as string)
    expect(await getAsset(node.id)).not.toBeNull()
    expect(await getAssetBlob(node.id)).toBeNull()
    expect(await objectUrlForAsset(node.id)).toBeNull()
    expect(await getDownloadSource(node.id)).toBeNull()
  })

  it('软删节点：getAsset 仍返回（含 trashedAt），getAssetBlob/objectUrlForAsset → null', async () => {
    const node = await ingestRoot([5])
    await trashAsset(node.id)
    const asset = await getAsset(node.id)
    expect(asset).not.toBeNull()
    expect(asset?.trashedAt).toBeGreaterThan(0)
    expect(await getAssetBlob(node.id)).toBeNull()
    expect(await objectUrlForAsset(node.id)).toBeNull()
  })

  it('文件夹/未知 id：getAsset → null', async () => {
    const folder = await createFolder(null, 'F')
    expect(await getAsset(folder.id)).toBeNull()
    expect(await getAsset('ast-nonexistent')).toBeNull()
  })
})

describe('内容寻址去重与符号链接（design §1.0）', () => {
  it('同内容二传（同目录）：不建第二条节点，返回既有条目+标记；零新增 blob', async () => {
    const first = await ingestAsset({ blob: png([1, 1, 1], 'a.png'), name: 'a.png', width: 1, height: 1, parentId: null, source: 'upload' })
    expect(first.status).toBe('created')
    const second = await ingestAsset({ blob: png([1, 1, 1], 'copy.png'), name: 'copy.png', width: 1, height: 1, parentId: null, source: 'upload' })
    expect(second.status).toBe('in-folder-duplicate')
    expect(second.node.id).toBe(first.node.id)
    expect(await listImages()).toHaveLength(1)
    expect(await listContentHashes()).toHaveLength(1)
    expect((await listChildNodes(null)).filter((n) => n.type === 'image')).toHaveLength(1)
  })

  it('跨目录同内容：新建符号链接节点（同 blobKey），blob 仍只一份', async () => {
    const folder = await createFolder(null, '目标夹')
    const a = await ingestRoot([7, 7], 'a.png')
    const linked = await ingestAsset({ blob: png([7, 7], 'b.png'), name: 'b.png', width: 1, height: 1, parentId: folder.id, source: 'upload' })
    expect(linked.status).toBe('linked')
    expect(linked.node.id).not.toBe(a.id)
    expect(linked.node.blobKey).toBe(a.blobKey)
    expect(await listImages()).toHaveLength(1)
    expect(await listContentHashes()).toHaveLength(1)
    // 跨目录节点名不冲突：原名保留
    expect(linked.node.name).toBe('b.png')
  })

  it('清一条链接另一条存活：节点删除、blob 与 contentHashes 保留', async () => {
    const folder = await createFolder(null, '目标夹')
    const a = await ingestRoot([3], 'a.png')
    const linked = await ingestAsset({ blob: png([3], 'b.png'), name: 'b.png', width: 1, height: 1, parentId: folder.id, source: 'upload' })

    await trashAsset(linked.node.id)
    const result = await emptyTrash()
    expect(result.deletedNodeIds).toEqual([linked.node.id])
    expect(result.deletedBlobKeys).toEqual([])

    expect(await getAsset(a.id)).not.toBeNull()
    expect(await getAssetBlob(a.id)).not.toBeNull()
    expect(await listImages()).toHaveLength(1)
    expect(await listContentHashes()).toHaveLength(1)
  })

  it('全清才删字节：最后一条引用删除后 blob + contentHashes 同事务清除', async () => {
    const a = await ingestRoot([4], 'a.png')
    await trashAsset(a.id)
    const result = await emptyTrash()
    expect(result.deletedNodeIds).toEqual([a.id])
    expect(result.deletedBlobKeys).toEqual([a.blobKey])
    expect(await listImages()).toHaveLength(0)
    expect(await listContentHashes()).toHaveLength(0)
    expect(await getAssetBlob(a.id)).toBeNull()
  })

  it('objectURL 按 blobKey 共享：两个链接节点取到同一 URL，createObjectURL 只调一次', async () => {
    const folder = await createFolder(null, '目标夹')
    const a = await ingestRoot([8], 'a.png')
    const linked = await ingestAsset({ blob: png([8], 'b.png'), name: 'b.png', width: 1, height: 1, parentId: folder.id, source: 'upload' })
    const urlA = await objectUrlForAsset(a.id)
    const urlB = await objectUrlForAsset(linked.node.id)
    expect(urlA).toBe('blob:asset-1')
    expect(urlB).toBe('blob:asset-1')
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
  })

  it('MIME 白名单：非 png/jpeg/webp 拒绝入库，不留半节点', async () => {
    await expect(
      ingestAsset({ blob: new File([new Uint8Array([1])], 'x.gif', { type: 'image/gif' }), name: 'x.gif', width: 1, height: 1, parentId: null, source: 'upload' }),
    ).rejects.toThrowError(/不支持的图片类型/)
    expect(await listAllNodes()).toHaveLength(0)
    expect(await listImages()).toHaveLength(0)
  })
})

describe('objectURL LRU 缓存（design §2）', () => {
  it('同 id 复用同 URL；releaseObjectUrl 显式释放后再取重建', async () => {
    const node = await ingestRoot([1], 'a.png')
    const url1 = await objectUrlForAsset(node.id)
    if (url1 === null) throw new Error('url1 缺失')
    const url2 = await objectUrlForAsset(node.id)
    expect(url2).toBe(url1)
    expect(createObjectUrl).toHaveBeenCalledTimes(1)

    releaseObjectUrl(url1)
    expect(revokeObjectUrl).toHaveBeenCalledWith(url1)
    const url3 = await objectUrlForAsset(node.id)
    expect(url3).toBe('blob:asset-2')
    expect(createObjectUrl).toHaveBeenCalledTimes(2)
  })

  it('超限回收最旧（LRU 上限），触达刷新热度', async () => {
    setObjectUrlCacheLimitForTests(2)
    const a = await ingestRoot([1], 'a.png')
    const b = await ingestRoot([2], 'b.png')
    const c = await ingestRoot([3], 'c.png')

    const urlA = await objectUrlForAsset(a.id)
    await objectUrlForAsset(b.id)
    // 触达 a 刷新热度：被挤出的是 b
    await objectUrlForAsset(a.id)
    const urlC = await objectUrlForAsset(c.id)
    expect(urlC).toBe('blob:asset-3')

    const revoked = vi.mocked(revokeObjectUrl).mock.calls.map((call) => call[0])
    expect(revoked).toEqual([`blob:asset-2`])
  })
})

describe('同父重名与系统目录保护（design §1/§4）', () => {
  it('同父重名自动后缀「 (2)」递增；rename 冲突亦后缀', async () => {
    const first = await createFolder(null, '项目')
    const second = await createFolder(null, '项目')
    const third = await createFolder(null, '项目')
    expect(second.name).toBe('项目 (2)')
    expect(third.name).toBe('项目 (3)')
    expect(first.parentId).toBeNull()

    const a = await ingestRoot([1], '图.png')
    const b = await ingestRoot([2], '图.png')
    expect(b.name).toBe('图.png (2)')

    const renamed = await renameAsset(a.id, '项目')
    expect(renamed.name).toBe('项目 (4)')
  })

  it('系统目录禁删/改名/移动；系统目录内禁新建文件夹；sys-cases 条目只读', async () => {
    await seedSystemFolders()
    const sysFolder = (await listAllNodes()).find((n) => n.type === 'folder' && n.system === 'sys-cases')
    expect(sysFolder).toBeDefined()
    await expect(renameAsset('sys-cases', '改名')).rejects.toThrowError(/系统目录/)
    await expect(moveAsset('sys-cases', null)).rejects.toThrowError(/系统目录/)
    await expect(trashAsset('sys-trash')).rejects.toThrowError(/系统目录不可删除/)
    await expect(trashAsset('sys-cases')).rejects.toThrowError(/系统目录不可删除/)
    await expect(createFolder('sys-cases', '新建')).rejects.toThrowError(/系统目录内不能新建文件夹/)

    const caseEntry = (await listChildNodes('sys-cases')).find((n) => n.type === 'image') as AssetImage
    await expect(renameAsset(caseEntry.id, 'x')).rejects.toThrowError(/只读/)
    await expect(moveAsset(caseEntry.id, null)).rejects.toThrowError(/只读/)
    await expect(trashAsset(caseEntry.id)).rejects.toThrowError(/只读/)
  })

  it('rename 正常路径更新 name/updatedAt 且不动其余字段', async () => {
    const node = await ingestRoot([6], 'old.png')
    const renamed = await renameAsset(node.id, 'new.png')
    expect(renamed.type).toBe('image')
    if (renamed.type !== 'image') return
    expect(renamed.name).toBe('new.png')
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(node.updatedAt)
    expect(renamed.blobKey).toBe(node.blobKey)
  })
})

describe('移动与环检测（design §4）', () => {
  it('移入自身/后代被拒（沿 parentId 链）；移入非文件夹被拒；移入回收站被拒', async () => {
    const parent = await createFolder(null, '父')
    const child = await createFolder(parent.id, '子')
    await expect(moveAsset(parent.id, parent.id)).rejects.toThrowError(/自身/)
    await expect(moveAsset(parent.id, child.id)).rejects.toThrowError(/自身或其后代/)

    const img = await ingestRoot([1], 'i.png')
    await expect(moveAsset(parent.id, img.id)).rejects.toThrowError(/只能移动到文件夹/)
    await expect(moveAsset(img.id, 'sys-trash')).rejects.toThrowError(/回收站/)

    const moved = await moveAsset(img.id, child.id)
    expect(moved.parentId).toBe(child.id)
  })

  it('移动进同名目录自动后缀', async () => {
    const folderA = await createFolder(null, 'A')
    await createFolder(null, 'B')
    const x1 = await ingestRoot([1], 'same.png')
    const x2 = await ingestRoot([2], 'same.png')
    await moveAsset(x1.id, folderA.id)
    const moved = await moveAsset(x2.id, folderA.id)
    expect(moved.name).toBe('same.png (2)')
  })
})

describe('递归软删与原子性（design §4）', () => {
  it('软删递归标记全部后代（trashedAt=同值）；对已软删节点幂等', async () => {
    const folder = await createFolder(null, 'F')
    const child = await createFolder(folder.id, 'C')
    const img1 = await ingestAsset({ blob: png([1], '1.png'), name: '1.png', width: 1, height: 1, parentId: folder.id, source: 'upload' })
    const img2 = await ingestAsset({ blob: png([2], '2.png'), name: '2.png', width: 1, height: 1, parentId: child.id, source: 'upload' })

    const count = await trashAsset(folder.id)
    expect(count).toBe(4)
    const all = await listAllNodes()
    const trashed = all.filter((n) => n.type === 'image' && n.trashedAt !== undefined)
    expect(trashed.map((n) => n.id).sort()).toEqual([img1.node.id, img2.node.id].sort())

    await expect(trashAsset(folder.id)).resolves.toBe(0) // 已软删 → no-op
  })

  it('中途失败注入：整棵子树零软删（单事务原子性）', async () => {
    const folder = await createFolder(null, 'F')
    const img1 = await ingestAsset({ blob: png([1], '1.png'), name: '1.png', width: 1, height: 1, parentId: folder.id, source: 'upload' })
    const img2 = await ingestAsset({ blob: png([2], '2.png'), name: '2.png', width: 1, height: 1, parentId: folder.id, source: 'upload' })

    fake.failNext({ store: 'assetNodes', op: 'put', key: img2.node.id })
    await expect(trashAsset(folder.id)).rejects.toBeTruthy()

    const after = await listAllNodes()
    expect(after.every((n) => !(n.type === 'image' && n.trashedAt !== undefined))).toBe(true)
    const folderNode = after.find((n) => n.id === folder.id)
    expect(folderNode && 'trashedAt' in folderNode ? folderNode.trashedAt : undefined).toBeUndefined()
    // blob 也未被触碰（资产不可变）
    expect(await getAssetBlob(img1.node.id)).not.toBeNull()
  })
})

describe('清空回收站与引用保护（design §4 pin 表冻结）', () => {
  it('pin 表：pin/unpin 状态与硬清空跳过并列明', async () => {
    const node = await ingestRoot([1], 'a.png')
    pinAsset(node.id)
    expect(isAssetPinned(node.id)).toBe(true)

    await trashAsset(node.id)
    const result = await emptyTrash()
    expect(result.deletedNodeIds).toEqual([])
    expect(result.skipped).toEqual([{ id: node.id, name: 'a.png', reason: 'pinned' }])
    // 软删节点解析出口为 null（§1.1），但字节存活（引用保护未删 blob）
    expect(await getAssetBlob(node.id)).toBeNull()
    expect(await listImages()).toHaveLength(1)

    unpinAsset(node.id)
    expect(isAssetPinned(node.id)).toBe(false)
    const second = await emptyTrash()
    expect(second.deletedNodeIds).toEqual([node.id])
    expect(second.deletedBlobKeys).toEqual([node.blobKey])
  })

  it('pinned 节点位于软删文件夹内：其后代与祖先一并保留（不自动解除）', async () => {
    const folder = await createFolder(null, 'F')
    const img = await ingestAsset({ blob: png([5], 'x.png'), name: 'x.png', width: 1, height: 1, parentId: folder.id, source: 'upload' })
    pinAsset(img.node.id)
    await trashAsset(folder.id)

    const result = await emptyTrash()
    expect(result.deletedNodeIds).toEqual([])
    const reasons = result.skipped.map((s) => [s.id, s.reason])
    expect(reasons).toContainEqual([img.node.id, 'pinned'])
    expect(reasons).toContainEqual([folder.id, 'ancestor-of-pinned'])
    // blob 因被保护节点存活而保留
    expect(await listImages()).toHaveLength(1)
  })

  it('任务 meta assetId 是弱引用：不 pin 则照删（missing 展示由调用方负责）', async () => {
    const node = await ingestRoot([1], 'weak.png')
    await trashAsset(node.id)
    const result = await emptyTrash()
    expect(result.deletedNodeIds).toEqual([node.id])
  })
})
