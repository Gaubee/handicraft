/**
 * AssetProject 数据层契约（openspec add-project-files design §2/§9.1 B5，切片 1.1）：
 *
 * 1. ingest：PROJECT_MIME 白名单 / projectKind × mime × 文件内 kind 交叉校验（解析失败按
 *    MIME 兜底）/ 重名后缀 / 确定性 id 存在（含软删）即跳过 / 四 kind 各一落 sys-projects。
 * 2. lease（B5）：同 asset 两 owner 各自计数、单 owner 重复 close = stale no-op、过期
 *    token = stale、最后有效计数关闭才放行 emptyTrash 硬清、重绑集合差分 pin 增减。
 * 3. CAS（B5 事务顺序冻结）：正常换绑旧 blob 无引用被清（含 contentHashes）、共享引用
 *    不删、冲突零写入（ProjectConflictError）、提交期失败全保持（failNextCommit）、
 *    gemgen 拒绝、thumb 换绑随旧记录引用清理。
 * 4. seed：sys-projects 幂等（迁移 seedSystemFolders 既有机制 + ingest 内 ensure）。
 * 5. 数据层兼容：项目节点在既有图片出口「不可见但不报错」；硬清 GC 覆盖 blob+thumb。
 *
 * 契约类型/错误唯一来源：$lib/persistence/projectTypes.ts（本文件只消费不重定义）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeProject,
  emptyTrash,
  getAsset,
  getAssetBlob,
  getProject,
  ingestAsset,
  ingestProjectAsset,
  isAssetPinned,
  isAssetProject,
  listAllNodes,
  listContentHashes,
  listPinnedAssetIds,
  objectUrlForAsset,
  openProject,
  projectPinRefCount,
  rebindProjectPins,
  resetAssetStoreForTests,
  runAssetMigration,
  SYS_PROJECTS_FOLDER_ID,
  trashAsset,
  updateProjectAsset,
  type IngestProjectAssetOptions,
} from '$lib/persistence/assetStore'
import { ProjectConflictError, PROJECT_MIME, type AssetProject, type ProjectKind } from '$lib/persistence/projectTypes'
import { getImageBlob, listImages } from '$lib/persistence/imageStore'
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

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

const FOUR_KINDS: readonly ProjectKind[] = ['gemproj', 'gemdoc', 'gemtpl', 'gemgen']

function projectFile(kind: ProjectKind, payload: Record<string, unknown> = {}): Blob {
  return new Blob([JSON.stringify({ kind, formatVersion: 1, ...payload })], { type: PROJECT_MIME[kind] })
}

async function ingestProj(
  kind: ProjectKind,
  name: string,
  payload: Record<string, unknown> = {},
  extra: Partial<IngestProjectAssetOptions> = {},
) {
  return ingestProjectAsset({ blob: projectFile(kind, payload), name, projectKind: kind, ...extra })
}

function thumbBlob(seed: number): Blob {
  return new Blob([new Uint8Array([seed, seed + 1, seed + 2])], { type: 'image/png' })
}

const THUMB_META = { mime: 'image/png' as const, width: 256, height: 256 }

function png(bytes: number[], name = 'pic.png'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

async function ingestImage(bytes: number[], name = 'pic.png') {
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

async function blobText(key: string): Promise<string> {
  const blob = await getImageBlob(key)
  if (blob === null) throw new Error(`物理记录缺失：${key}`)
  return blob.text()
}

function sysProjectsFolders(nodes: { id: string }[]): unknown[] {
  return nodes.filter((n) => n.id === SYS_PROJECTS_FOLDER_ID)
}

// ---------------------------------------------------------------------------
// ingest（design §2：白名单 + 三方交叉校验 + 确定性 id）
// ---------------------------------------------------------------------------

describe('ingestProjectAsset：校验四防线', () => {
  it('四 kind 各一：默认落 sys-projects，节点/blob/哈希齐备且字节原样', async () => {
    for (const kind of FOUR_KINDS) {
      const result = await ingestProj(kind, `花环.${kind}`, { n: kind })
      expect(result.status).toBe('created')
      const node = result.node
      expect(node).toMatchObject({
        type: 'project',
        projectKind: kind,
        refKind: 'blob',
        mime: PROJECT_MIME[kind],
        name: `花环.${kind}`,
        parentId: SYS_PROJECTS_FOLDER_ID,
        summary: {},
      })
      expect(node.trashedAt).toBeUndefined()
      expect(node.summaryUpdatedAt).toBeGreaterThan(0)
      expect(await blobText(node.blobKey)).toBe(JSON.stringify({ kind, formatVersion: 1, n: kind }))
    }
    expect((await listAllNodes()).filter((n) => isAssetProject(n))).toHaveLength(4)
    expect(await listImages()).toHaveLength(4)
    expect(await listContentHashes()).toHaveLength(4)
    const folders = sysProjectsFolders(await listAllNodes())
    expect(folders).toHaveLength(1)
  })

  it('重名后缀：同目录同名单击两次 → 「 (2)」', async () => {
    const first = await ingestProj('gemproj', '花环.gemproj')
    const second = await ingestProj('gemproj', '花环.gemproj', { n: 2 })
    expect(first.node.name).toBe('花环.gemproj')
    expect(second.node.name).toBe('花环.gemproj (2)')
    // 项目节点不做同目录同内容去重（fork 语义）：两节点即使字节相同也各自成立
    expect(second.node.id).not.toBe(first.node.id)
  })

  it('非 PROJECT_MIME 拒绝：零节点/零 blob/零哈希（含图片 MIME）', async () => {
    for (const mime of ['application/json', 'image/png', '']) {
      await expect(
        ingestProjectAsset({
          blob: new Blob(['{"kind":"gemproj"}'], { type: mime }),
          name: 'x.gemproj',
          projectKind: 'gemproj',
        }),
      ).rejects.toThrowError(/不支持的项目文件类型/)
    }
    expect(await listAllNodes()).toHaveLength(0)
    expect(await listImages()).toHaveLength(0)
    expect(await listContentHashes()).toHaveLength(0)
  })

  it('projectKind × mime 交叉不符拒绝（kind=gemproj 但文件是 gemdoc MIME）', async () => {
    await expect(
      ingestProjectAsset({
        blob: new Blob([JSON.stringify({ kind: 'gemdoc' })], { type: PROJECT_MIME.gemdoc }),
        name: 'x.gemdoc',
        projectKind: 'gemproj',
      }),
    ).rejects.toThrowError(/类型与文件类型不符/)
    expect(await listAllNodes()).toHaveLength(0)
  })

  it('文件内 kind 与导入类型不一致拒绝；解析失败按 MIME 兜底放行', async () => {
    await expect(
      ingestProjectAsset({
        blob: new Blob([JSON.stringify({ kind: 'gemproj', formatVersion: 1 })], { type: PROJECT_MIME.gemdoc }),
        name: 'x.gemdoc',
        projectKind: 'gemdoc',
      }),
    ).rejects.toThrowError(/不一致/)
    // 非 JSON 字节（探针失败）→ 只按 MIME 校验
    const fallback = await ingestProjectAsset({
      blob: new Blob(['###not-json###'], { type: PROJECT_MIME.gemproj }),
      name: 'raw.gemproj',
      projectKind: 'gemproj',
    })
    expect(fallback.status).toBe('created')
  })

  it('确定性 id：目标存在（含软删）即跳过返回既有节点，零新增写入', async () => {
    const first = await ingestProj('gemtpl', '模板.gemtpl', { body: 'v1' }, { id: 'ast-tpl-demo' })
    expect(first.status).toBe('created')
    expect(first.node.id).toBe('ast-tpl-demo')

    const imagesAfterFirst = (await listImages()).length
    const hashesAfterFirst = (await listContentHashes()).length

    const retry = await ingestProj('gemtpl', '改名.gemtpl', { body: 'v2' }, { id: 'ast-tpl-demo' })
    expect(retry.status).toBe('existing-id')
    expect(retry.node.id).toBe('ast-tpl-demo')
    expect(retry.node.blobKey).toBe(first.node.blobKey)
    expect(retry.node.name).toBe('模板.gemtpl') // 内容零变化
    expect(await listImages()).toHaveLength(imagesAfterFirst)
    expect(await listContentHashes()).toHaveLength(hashesAfterFirst)

    // 软删后仍视为存在（删除不复活）
    await trashAsset('ast-tpl-demo')
    const afterTrash = await ingestProj('gemtpl', '再试.gemtpl', {}, { id: 'ast-tpl-demo' })
    expect(afterTrash.status).toBe('existing-id')
    expect(afterTrash.node.trashedAt).toBeGreaterThan(0)
    expect(await listImages()).toHaveLength(imagesAfterFirst)
  })

  it('gemgen 入库带 thumb：物理记录独立、元组齐备；parentId 可指定系统目录', async () => {
    await runAssetMigration()
    const result = await ingestProj('gemgen', '档案.gemgen', { runId: 'r1' }, {
      parentId: 'sys-generated',
      thumb: { bytes: thumbBlob(9), meta: THUMB_META },
      summary: { templateName: 'T', candidateIndex: 2 },
    })
    const node = result.node
    expect(node.parentId).toBe('sys-generated')
    expect(node.thumbKey).toBeDefined()
    expect(node.thumb).toMatchObject({ mime: 'image/png', width: 256, height: 256, bytes: 3, key: node.thumbKey })
    expect((await listImages()).map((r) => r.id)).toContain(node.thumbKey)
    expect(await blobText(node.thumbKey as string)).toBe(await thumbBlob(9).text())
    expect(node.summary).toEqual({ templateName: 'T', candidateIndex: 2 })
  })
})

// ---------------------------------------------------------------------------
// lease（design §9.1 B5：引用计数 / 幂等 close / 差分 pin）
// ---------------------------------------------------------------------------

describe('项目生命周期 lease（B5）', () => {
  async function setup() {
    const project = (await ingestProj('gemproj', '工程.gemproj')).node
    const a = await ingestImage([1], 'a.png')
    const b = await ingestImage([2], 'b.png')
    return { project, a, b }
  }

  it('同 asset 两 owner 打开各自计数；最后一个有效计数关闭才解除保护并放行硬清', async () => {
    const { project, a, b } = await setup()
    const lease1 = await openProject(project.id, 'gemproj', 'studio-page', [a.id])
    const lease2 = await openProject(project.id, 'gemproj', 'edit-page', [a.id])
    expect(lease1.token).not.toBe(lease2.token)
    expect(projectPinRefCount(a.id)).toBe(2)
    expect(isAssetPinned(a.id)).toBe(true)

    await trashAsset(a.id)
    await closeProject(lease1)
    expect(projectPinRefCount(a.id)).toBe(1)
    const first = await emptyTrash() // 仍有 lease 持有 → 保护
    expect(first.deletedNodeIds).toEqual([])
    expect(first.skipped).toEqual([{ id: a.id, name: 'a.png', reason: 'pinned' }])
    expect(await getImageBlob(a.blobKey as string)).not.toBeNull()

    await closeProject(lease2)
    expect(projectPinRefCount(a.id)).toBe(0)
    expect(isAssetPinned(a.id)).toBe(false)
    expect(listPinnedAssetIds()).toEqual([])
    const second = await emptyTrash() // 最后计数已关 → 硬清
    expect(second.deletedNodeIds).toEqual([a.id])
    expect(second.deletedBlobKeys).toEqual([a.blobKey])
    // 幸存物理记录 = 未软删的 b + 项目自身 blob
    expect((await listImages()).map((r) => r.id).sort()).toEqual([b.blobKey as string, project.blobKey].sort())
  })

  it('单 owner 重复 close = stale no-op 不抛错', async () => {
    const { project, a } = await setup()
    const lease = await openProject(project.id, 'gemproj', 'studio-page', [a.id])
    await expect(closeProject(lease)).resolves.toBe('released')
    await expect(closeProject(lease)).resolves.toBe('stale')
    expect(isAssetPinned(a.id)).toBe(false)
  })

  it('过期/未知 token close = stale；不触碰计数表', async () => {
    const { project, a } = await setup()
    const ghost: Parameters<typeof closeProject>[0] = {
      projectId: project.id,
      ownerId: 'ghost-page',
      token: 'lease-nonexistent',
      pinnedAssetIds: [a.id],
      closed: false,
    }
    await expect(closeProject(ghost)).resolves.toBe('stale')
    expect(isAssetPinned(a.id)).toBe(false)
    expect(projectPinRefCount(a.id)).toBe(0)
  })

  it('同一 lease 的 pinned 集合去重：同 id 重复传入只计一档', async () => {
    const { project, a } = await setup()
    const lease = await openProject(project.id, 'gemproj', 'studio-page', [a.id, a.id])
    expect(lease.pinnedAssetIds).toEqual([a.id])
    expect(projectPinRefCount(a.id)).toBe(1)
  })

  it('差分 pin：重绑集合变化时增减（gemproj 重绑 source/reference 的机制面）', async () => {
    const { project, a, b } = await setup()
    const lease = await openProject(project.id, 'gemproj', 'studio-page', [a.id])
    rebindProjectPins(lease, [b.id])
    expect(projectPinRefCount(a.id)).toBe(0)
    expect(projectPinRefCount(b.id)).toBe(1)
    expect(lease.pinnedAssetIds).toEqual([b.id])

    await trashAsset(a.id)
    await trashAsset(b.id)
    const result = await emptyTrash() // a 已不被 pin → 删；b 仍被 pin → 保护
    expect(result.deletedNodeIds).toEqual([a.id])
    expect(result.skipped).toEqual([{ id: b.id, name: 'b.png', reason: 'pinned' }])
    expect(await getImageBlob(b.blobKey as string)).not.toBeNull()

    await closeProject(lease)
    rebindProjectPinsExpectClosed(lease)
  })

  it('已关闭/未知 token 的 lease 重绑 = 显式抛错（区别于 close 的幂等）', async () => {
    const { project } = await setup()
    const lease = await openProject(project.id, 'gemproj', 'studio-page', [])
    await closeProject(lease)
    expect(() => rebindProjectPins(lease, ['x'])).toThrowError(/租约已关闭或失效/)
    const ghost: Parameters<typeof rebindProjectPins>[0] = {
      projectId: project.id,
      ownerId: 'ghost-page',
      token: 'lease-nonexistent',
      pinnedAssetIds: [],
      closed: false,
    }
    expect(() => rebindProjectPins(ghost, ['x'])).toThrowError(/租约已关闭或失效/)
  })

  it('openProject 校验：缺失/图片节点/类型不符均拒绝', async () => {
    const { project, a } = await setup()
    const gemdoc = (await ingestProj('gemdoc', '文档.gemdoc')).node
    await expect(openProject('ast-nonexistent', 'gemproj', 'o', [])).rejects.toThrowError(/不是项目节点/)
    await expect(openProject(a.id, 'gemproj', 'o', [])).rejects.toThrowError(/不是项目节点/)
    await expect(openProject(gemdoc.id, 'gemproj', 'o', [])).rejects.toThrowError(/类型不符/)
    await expect(openProject(project.id, 'gemproj', 'o', [])).resolves.toMatchObject({
      projectId: project.id,
      ownerId: 'o',
      closed: false,
    })
  })
})

function rebindProjectPinsExpectClosed(lease: Parameters<typeof rebindProjectPins>[0]): void {
  expect(() => rebindProjectPins(lease, [])).toThrowError(/租约已关闭或失效/)
}

// ---------------------------------------------------------------------------
// CAS 换绑（design §9.1 B5：事务顺序冻结 + 冲突零写入）
// ---------------------------------------------------------------------------

describe('updateProjectAsset：CAS 换绑事务', () => {
  it('正常换绑：旧 blob 无引用被清（含哈希条目）、新字节可读、summary 重写', async () => {
    const v1 = projectFile('gemproj', { n: 1 })
    const node = (await ingestProjectAsset({ blob: v1, name: '工程.gemproj', projectKind: 'gemproj', summary: { gemCount: 1 } })).node

    const v2Text = JSON.stringify({ kind: 'gemproj', formatVersion: 1, n: 2 })
    const updated = await updateProjectAsset(node.id, {
      expectedBlobKey: node.blobKey,
      bytes: new Blob([v2Text], { type: PROJECT_MIME.gemproj }),
      summary: { gemCount: 5 },
    })
    expect(updated.blobKey).not.toBe(node.blobKey)
    expect(updated.summary).toEqual({ gemCount: 5 })
    expect(updated.summaryUpdatedAt).toBeGreaterThanOrEqual(node.summaryUpdatedAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(node.updatedAt)
    expect(updated.name).toBe(node.name) // 换绑不动身份字段
    expect(await blobText(updated.blobKey)).toBe(v2Text)

    // 旧物理记录无引用 → 连同 contentHashes 条目删除
    expect((await listImages()).map((r) => r.id)).toEqual([updated.blobKey])
    expect((await listContentHashes()).map((r) => r.physicalKey)).toEqual([updated.blobKey])
  })

  it('共享引用不删：fork 出的第二个节点仍指向旧 blob', async () => {
    const same = projectFile('gemproj', { n: 1 })
    const a = (await ingestProjectAsset({ blob: same, name: 'a.gemproj', projectKind: 'gemproj' })).node
    const b = (await ingestProjectAsset({ blob: same, name: 'b.gemproj', projectKind: 'gemproj' })).node
    expect(b.blobKey).toBe(a.blobKey) // 内容寻址：物理记录共享

    const updated = await updateProjectAsset(a.id, {
      expectedBlobKey: a.blobKey,
      bytes: projectFile('gemproj', { n: 2 }),
      summary: {},
    })
    expect((await listImages()).map((r) => r.id).sort()).toEqual([a.blobKey, updated.blobKey].sort())
    expect(await blobText(b.blobKey)).toBe(await same.text()) // b 的字节原样存活
    expect((await listContentHashes()).map((r) => r.physicalKey).sort()).toEqual([a.blobKey, updated.blobKey].sort())
  })

  it('冲突零写入：expectedBlobKey 不符 = ProjectConflictError，节点/blob/哈希全保持', async () => {
    const node = (await ingestProj('gemproj', '工程.gemproj', { n: 1 })).node
    const updated = await updateProjectAsset(node.id, {
      expectedBlobKey: node.blobKey,
      bytes: projectFile('gemproj', { n: 2 }),
      summary: { gemCount: 2 },
    })

    // 用过期 expected 再存（真实并发场景：读到的是旧 key）
    const conflict = updateProjectAsset(node.id, {
      expectedBlobKey: node.blobKey,
      bytes: projectFile('gemproj', { n: 3 }),
      summary: { gemCount: 3 },
    })
    await expect(conflict).rejects.toBeInstanceOf(ProjectConflictError)
    await conflict.catch((error: ProjectConflictError) => {
      expect(error.projectId).toBe(node.id)
      expect(error.expectedBlobKey).toBe(node.blobKey)
      expect(error.actualBlobKey).toBe(updated.blobKey)
    })

    expect((await getProject(node.id) as AssetProject).blobKey).toBe(updated.blobKey)
    expect((await listImages()).map((r) => r.id)).toEqual([updated.blobKey]) // v3 blob 未盲写
    expect((await listContentHashes()).map((r) => r.physicalKey)).toEqual([updated.blobKey])
  })

  it('提交期失败全保持（failNextCommit）：旧节点/旧 blob/旧哈希原样，新 blob 不落盘', async () => {
    const node = (await ingestProj('gemproj', '工程.gemproj', { n: 1 })).node
    fake.failNextCommit({ store: 'assetNodes' })
    await expect(
      updateProjectAsset(node.id, {
        expectedBlobKey: node.blobKey,
        bytes: projectFile('gemproj', { n: 2 }),
        summary: {},
      }),
    ).rejects.toBeTruthy()
    const after = await getProject(node.id)
    expect(after?.blobKey).toBe(node.blobKey)
    expect(after?.summary).toEqual({})
    expect((await listImages()).map((r) => r.id)).toEqual([node.blobKey])
    expect((await listContentHashes()).map((r) => r.physicalKey)).toEqual([node.blobKey])
    expect(await getImageBlob(node.blobKey)).not.toBeNull()
  })

  it('gemgen 调用即拒（不可变）：节点与物理记录零变化', async () => {
    const node = (await ingestProj('gemgen', '档案.gemgen', { runId: 'r1' }, {
      thumb: { bytes: thumbBlob(1), meta: THUMB_META },
    })).node
    await expect(
      updateProjectAsset(node.id, {
        expectedBlobKey: node.blobKey,
        bytes: projectFile('gemgen', { runId: 'r2' }),
        summary: {},
      }),
    ).rejects.toThrowError(/不可变/)
    expect((await getProject(node.id))?.blobKey).toBe(node.blobKey)
    expect((await listImages()).map((r) => r.id).sort()).toEqual([node.blobKey, node.thumbKey as string].sort())
  })

  it('thumb 换绑同随：新记录落盘、旧记录无引用被清；不传 thumb 则原样保留', async () => {
    const node = (await ingestProj('gemproj', '工程.gemproj', { n: 1 })).node
    const first = await updateProjectAsset(node.id, {
      expectedBlobKey: node.blobKey,
      bytes: projectFile('gemproj', { n: 2 }),
      summary: {},
      thumb: { bytes: thumbBlob(1), meta: THUMB_META },
    })
    expect(first.thumbKey).toBeDefined()
    expect((await listImages()).map((r) => r.id).sort()).toEqual([first.blobKey, first.thumbKey as string].sort())

    const second = await updateProjectAsset(first.id, {
      expectedBlobKey: first.blobKey,
      bytes: projectFile('gemproj', { n: 3 }),
      summary: {},
      thumb: { bytes: thumbBlob(2), meta: THUMB_META },
    })
    expect(second.thumbKey).not.toBe(first.thumbKey)
    expect((await listImages()).map((r) => r.id).sort()).toEqual([second.blobKey, second.thumbKey as string].sort())

    const third = await updateProjectAsset(second.id, {
      expectedBlobKey: second.blobKey,
      bytes: projectFile('gemproj', { n: 4 }),
      summary: {},
    })
    expect(third.thumbKey).toBe(second.thumbKey) // 未传 thumb → 不动
    expect(third.thumb).toEqual(second.thumb)
  })

  it('缺失/非项目节点拒绝', async () => {
    const img = await ingestImage([7], 'i.png')
    await expect(
      updateProjectAsset('ast-nonexistent', { expectedBlobKey: 'k', bytes: projectFile('gemproj'), summary: {} }),
    ).rejects.toThrowError(/项目不存在/)
    await expect(
      updateProjectAsset(img.id, { expectedBlobKey: 'k', bytes: projectFile('gemproj'), summary: {} }),
    ).rejects.toThrowError(/不是项目节点/)
  })
})

// ---------------------------------------------------------------------------
// seed 与数据层兼容
// ---------------------------------------------------------------------------

describe('sys-projects seed 幂等与项目节点的既有路径兼容', () => {
  it('runAssetMigration 两次：sys-projects 恰一个（迁移 seed 既有机制）', async () => {
    await runAssetMigration()
    await runAssetMigration()
    const nodes = await listAllNodes()
    expect(sysProjectsFolders(nodes)).toHaveLength(1)
    const folder = nodes.find((n) => n.id === SYS_PROJECTS_FOLDER_ID)
    expect(folder).toMatchObject({ type: 'folder', name: '项目', parentId: null, system: 'sys-projects' })
  })

  it('重跑真 seed（清 flag 后）：仍一目录不重复建', async () => {
    await runAssetMigration()
    localStorage.removeItem('rhinestone-studio:asset-migration-v2') // 强制 seedSystemFolders 真跑
    await runAssetMigration()
    expect(sysProjectsFolders(await listAllNodes())).toHaveLength(1)
  })

  it('未跑迁移直接 ingest：sys-projects 自动落位且幂等', async () => {
    await ingestProj('gemproj', '工程.gemproj')
    await ingestProj('gemdoc', '文档.gemdoc')
    const nodes = await listAllNodes()
    expect(sysProjectsFolders(nodes)).toHaveLength(1)
    expect(nodes.filter((n) => isAssetProject(n)).map((n) => n.parentId)).toEqual([
      SYS_PROJECTS_FOLDER_ID,
      SYS_PROJECTS_FOLDER_ID,
    ])
  })

  it('项目节点在图片出口不可见但不报错：getAsset/getAssetBlob/objectUrlForAsset → null', async () => {
    const node = (await ingestProj('gemproj', '工程.gemproj')).node
    expect(await getAsset(node.id)).toBeNull()
    expect(await getAssetBlob(node.id)).toBeNull()
    expect(await objectUrlForAsset(node.id)).toBeNull()
    expect(await getProject(node.id)).toMatchObject({ id: node.id, type: 'project' })
    expect(isAssetProject(node)).toBe(true)
  })

  it('硬清回收站 GC 覆盖项目 blob + thumb 物理记录与哈希', async () => {
    const node = (await ingestProj('gemgen', '档案.gemgen', {}, {
      thumb: { bytes: thumbBlob(5), meta: THUMB_META },
    })).node
    await trashAsset(node.id)
    const result = await emptyTrash()
    expect(result.deletedNodeIds).toEqual([node.id])
    expect(result.deletedBlobKeys.sort()).toEqual([node.blobKey, node.thumbKey as string].sort())
    expect(await listImages()).toHaveLength(0)
    expect(await listContentHashes()).toHaveLength(0)
  })
})
