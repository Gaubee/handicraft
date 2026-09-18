/**
 * 纵向数据链 tracer（add-asset-library 任务 0.2，store 级无 UI）：
 * 入库(去重) → task meta 带 referenceAssetId → 模块重置+hydrate →
 * 按 id 解析重试输入 → 软删+清空（引用保护/pin/计数）。
 * 含 missing 分支（设计稿 §7 GO 前置验收的最小纵向链路）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearHistory,
  getReferenceAssetId,
  getTasks,
  hydrate,
  resetLabForTests,
  retryTask,
  setReference,
  startRun,
  updateSettings,
  updateVariant,
} from '$lib/stores/lab.svelte'
import {
  emptyTrash,
  isAssetPinned,
  listChildNodes,
  pinAsset,
  resetAssetStoreForTests,
  runAssetMigration,
  trashAsset,
  unpinAsset,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { listImages } from '$lib/persistence/imageStore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: { message: 'relay exploded' } }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let fake: FakeIndexedDB
let objectUrlCounter = 0
let fetchMock: ReturnType<typeof vi.fn>
let editCalls: FormData[]

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  localStorage.clear()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  // jsdom 的 Image 不解码：桩掉让 prepareReferenceImage 走「解码不可用回退原文件」路径
  class OkImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)

  editCalls = []
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/images/edits')) {
      editCalls.push(init?.body as FormData)
      return okResponse()
    }
    return okResponse()
  })
  vi.stubGlobal('fetch', fetchMock)

  resetLabForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
  // 启动迁移先行（真实首屏语义：系统目录就绪后用户才可能上传）
  await runAssetMigration()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 只留一个无案例绑定的变体、一个候选：edit 模式完全由参考原图驱动。 */
async function setupBareVariant(): Promise<string> {
  const { getVariants, removeVariant } = await import('$lib/stores/lab.svelte')
  const first = getVariants()[0]
  for (const v of [...getVariants()]) {
    if (v.id !== first.id) removeVariant(v.id)
  }
  updateVariant(first.id, { candidates: 1, prompt: 'tracer prompt', effectRef: null })
  return first.id
}

function persistedTasks(): Array<{ id: string; referenceAssetId?: string }> {
  return JSON.parse(localStorage.getItem('rhinestone-studio:tasks') ?? '[]') as Array<{
    id: string
    referenceAssetId?: string
  }>
}

describe('0.2 纵向 tracer：上传 → 生成 → 刷新 → 按 id 重试 → 清理', () => {
  it('入库去重 → 失败任务携带 referenceAssetId → reset+hydrate → 重试按 id 解析成功', async () => {
    // 1. 上传参考原图（入库 sys-uploads）
    await setReference(new File([new Uint8Array([1, 2, 3])], 'wreath.png', { type: 'image/png' }))
    const assetId = getReferenceAssetId()
    expect(assetId).toMatch(/^ast-/)

    // 2. 同内容二次上传 → 同目录去重为一条（既有条目复用）
    await setReference(new File([new Uint8Array([1, 2, 3])], 'duplicate.png', { type: 'image/png' }))
    expect(getReferenceAssetId()).toBe(assetId)
    const uploads = (await listChildNodes('sys-uploads')).filter((n) => n.type === 'image') as AssetImage[]
    expect(uploads).toHaveLength(1)
    expect(uploads[0].name).toBe('wreath.png') // 首个名字保留，去重不建第二节点

    // 3. 发起 edit 任务 → API 失败 → 终态持久化带 referenceAssetId
    await setupBareVariant()
    fetchMock.mockImplementationOnce(async () => errorResponse())
    const result = startRun()
    expect(result.ok).toBe(true)
    await waitFor(() => getTasks()[0]?.status === 'error')
    const persisted = persistedTasks()
    expect(persisted).toHaveLength(1)
    expect(persisted[0].referenceAssetId).toBe(assetId)

    // 4. 模拟刷新：模块复位（IDB/localStorage 保留）→ hydrate 恢复任务
    resetLabForTests()
    expect(getReferenceAssetId()).toBeNull()
    await hydrate()
    const restored = getTasks()[0]
    expect(restored?.referenceAssetId).toBe(assetId)
    expect(restored?.status).toBe('error')

    // 5. 重试：无会话引用，按 id 解析回 File → edits 请求首图 = 素材节点名
    retryTask(restored.id)
    await waitFor(() => getTasks()[0]?.status === 'success')
    expect(editCalls).toHaveLength(1)
    const images = editCalls[0].getAll('image') as File[]
    expect(images.map((f) => f.name)).toEqual(['wreath.png'])
    expect(images[0].size).toBe(3)
    expect(images[0].type).toBe('image/png')

    // 6. 清空历史解耦前奏：任务 blob 与素材 blob 是两份不同内容（任务键 vs 内容哈希键）
    expect((await listImages()).map((r) => r.id)).toHaveLength(2)
  })

  it('缺失分支：资产被硬清空 → hydrate 后重试给「参考原图已失效」错误态，不发请求', async () => {
    await setReference(new File([new Uint8Array([9])], 'gone.png', { type: 'image/png' }))
    const assetId = getReferenceAssetId()
    expect(assetId).toMatch(/^ast-/)

    await setupBareVariant()
    fetchMock.mockImplementationOnce(async () => errorResponse())
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')

    // 模拟刷新 + 素材库侧清理（软删 + 硬清空，无 pin）
    resetLabForTests()
    await hydrate()
    await trashAsset(assetId as string)
    const cleanup = await emptyTrash()
    expect(cleanup.deletedNodeIds).toEqual([assetId])

    const restored = getTasks()[0]
    expect(editCalls).toHaveLength(0)
    retryTask(restored.id)
    await waitFor(() => getTasks()[0]?.status === 'error')
    expect(getTasks()[0].error).toContain('参考原图已失效')
    expect(editCalls).toHaveLength(0) // 显式失效：不发请求，不是静默空画布
  })

  it('软删（未清空）同样失效：getAssetBlob 对 trashedAt 节点返回 null', async () => {
    await setReference(new File([new Uint8Array([7])], 'trashed.png', { type: 'image/png' }))
    const assetId = getReferenceAssetId() as string
    await setupBareVariant()
    fetchMock.mockImplementationOnce(async () => errorResponse())
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')
    resetLabForTests()
    await hydrate()
    await trashAsset(assetId)

    retryTask(getTasks()[0].id)
    await waitFor(() => getTasks()[0]?.status === 'error')
    expect(getTasks()[0].error).toContain('参考原图已失效')
  })

  it('pin 引用保护：硬清空跳过 pinned 资产并列明；unpin 后才真正删字节', async () => {
    await setReference(new File([new Uint8Array([5, 5])], 'pinned.png', { type: 'image/png' }))
    const assetId = getReferenceAssetId() as string

    await setupBareVariant()
    fetchMock.mockImplementationOnce(async () => errorResponse())
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')
    resetLabForTests()
    await hydrate()

    // studio/编辑会话语义：pin 后软删 + 清空 → 跳过并列明、字节存活（节点保持软删态，不自动解除）
    pinAsset(assetId)
    expect(isAssetPinned(assetId)).toBe(true)
    await trashAsset(assetId)
    const cleanup = await emptyTrash()
    expect(cleanup.deletedNodeIds).toEqual([])
    expect(cleanup.skipped.map((s) => [s.id, s.reason])).toEqual([[assetId, 'pinned']])
    // 内容字节存活（去重真源未删）
    expect(await listImages()).toHaveLength(1)

    // 软删节点对解析出口失效（§1.1）：重试给显式失效态，而非静默空输入
    retryTask(getTasks()[0].id)
    await waitFor(() => getTasks()[0]?.status === 'error')
    expect(getTasks()[0].error).toContain('参考原图已失效')
    expect(editCalls).toHaveLength(0)

    // unpin 后再清空：真正删除（引用计数归零 → 删字节 + contentHashes）
    unpinAsset(assetId)
    const final = await emptyTrash()
    expect(final.deletedNodeIds).toEqual([assetId])
    expect(final.deletedBlobKeys).toHaveLength(1)
    expect(await listImages()).toHaveLength(0)
  })

  it('清空历史不动资产（B-1 方向锚点：素材与任务史解耦的存储事实）', async () => {
    await setReference(new File([new Uint8Array([4])], 'keep.png', { type: 'image/png' }))
    const assetId = getReferenceAssetId() as string
    await setupBareVariant()
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'success')

    await clearHistory()
    expect(getTasks()).toHaveLength(0)
    // 参考素材仍在库（字节与节点都未被任务史清理触碰）
    const uploads = (await listChildNodes('sys-uploads')).filter((n) => n.type === 'image') as AssetImage[]
    expect(uploads.map((n) => n.id)).toEqual([assetId])
    expect((await listImages()).map((r) => r.id)).toContain(uploads[0].blobKey)
  })
})
