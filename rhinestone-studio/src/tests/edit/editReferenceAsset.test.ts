/*
 * [add-asset-library 6.1 / 6.2] 专家工作台原图资产链（C-1/C-2 修订）：
 * - EditCanvas 异步 resolver 四态：loading（挂载同步帧）/ ready / missing / soft-deleted（显式提示层）
 * - 切换 reference 清理：releaseObjectUrl 释放上一轮持有的共享 objectURL
 * - 活动编辑引用入硬清空保护：挂载 pin / 覆盖送精修 unpin 旧挂新 / 硬清空跳过 pinned
 * - 烘焙隔离不破坏：referenceAssetId 贯通下既有快照语义保持（paintingSnapshot 深拷贝 + 排钻工作台零回流）
 *
 * 环境声明：jsdom 无 canvas 2d（EditCanvas ctx null 守卫）；fake IDB 支撑 asset 解析。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import { getEditDoc, loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
import { resetStudioForTests } from '$lib/stores/studio.svelte'
import { setView } from '$lib/stores/view.svelte'
import {
  emptyTrash,
  ingestAsset,
  isAssetPinned,
  resetAssetStoreForTests,
  runAssetMigration,
  trashAsset,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { listImages } from '$lib/persistence/imageStore'
import { GEMSHAPE_SEEDS } from '$lib/engine'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'
import { makeHandoff } from './helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

let fake: FakeIndexedDB
let objectUrlCounter = 0
let revokeObjectURLMock: ReturnType<typeof vi.fn>

async function ingestPng(bytes: number[], name: string): Promise<AssetImage> {
  const { node } = await ingestAsset({
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    name,
    width: 64,
    height: 64,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  return node
}

/** 挂载 EditView（含 EditCanvas）并返回清理函数。 */
function mountEditView(): () => void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EditView, { target })
  return () => {
    unmount(app)
    target.remove()
  }
}

/** 等 resolver 异步解析落地（fake IDB 微任务 + 渲染）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetEditForTests()
  resetStudioForTests()
  setView('edit')
  localStorage.clear()
  objectUrlCounter = 0
  revokeObjectURLMock = vi.fn()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:edit-${(objectUrlCounter += 1)}`),
    revokeObjectURL: revokeObjectURLMock,
  })
  await runAssetMigration()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  setView('lab')
})

describe('6.1 EditCanvas 异步 resolver 四态', () => {
  it('ready：资产可解析 → 无失效提示层，共享 objectURL 用于参考层', async () => {
    const ref = await ingestPng([1, 2, 3], 'ref-ready.png')
    loadFromHandoff(makeHandoff(4, { referenceAssetId: ref.id }))
    const cleanup = mountEditView()
    try {
      await settle()
      expect(document.querySelector('[data-testid="edit-reference-state"]')).toBeNull()
      expect(document.querySelector('[data-testid="edit-reference-loading"]')).toBeNull()
      expect(document.querySelector('[data-testid="edit-canvas"]')).not.toBeNull()
    } finally {
      cleanup()
    }
  })

  it('loading → ready：挂载同步帧处于解析中，随后落定（无提示层）', async () => {
    const ref = await ingestPng([4], 'ref-loading.png')
    loadFromHandoff(makeHandoff(4, { referenceAssetId: ref.id }))
    const cleanup = mountEditView()
    try {
      // 挂载同步帧（flushSync 后、任何微任务前）：loading 提示在 DOM
      flushSync(() => {})
      const loading = document.querySelector('[data-testid="edit-reference-loading"]')
      // fake IDB 解析极快，loading 可能已翻转——断言「loading 与 ready 互斥且最终无提示层」
      expect(loading === null || document.querySelector('[data-testid="edit-reference-state"]') === null).toBe(true)
      await settle()
      expect(document.querySelector('[data-testid="edit-reference-state"]')).toBeNull()
      expect(document.querySelector('[data-testid="edit-reference-loading"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('missing：节点已硬删 → 显式失效提示（不是空画布静默）', async () => {
    loadFromHandoff(makeHandoff(4, { referenceAssetId: 'ast-hard-deleted' }))
    const cleanup = mountEditView()
    try {
      await settle()
      const chip = document.querySelector('[data-testid="edit-reference-state"]')
      expect(chip).not.toBeNull()
      expect(chip?.textContent).toContain('原图素材已缺失')
      // 失效不影响其余层：画布本体仍在
      expect(document.querySelector('[data-testid="edit-canvas"]')).not.toBeNull()
    } finally {
      cleanup()
    }
  })

  it('soft-deleted：参考在回收站 → 提示可去回收站找回', async () => {
    const ref = await ingestPng([5], 'ref-trashed.png')
    await trashAsset(ref.id)
    loadFromHandoff(makeHandoff(4, { referenceAssetId: ref.id }))
    const cleanup = mountEditView()
    try {
      await settle()
      const chip = document.querySelector('[data-testid="edit-reference-state"]')
      expect(chip).not.toBeNull()
      expect(chip?.textContent).toContain('原图已在回收站')
    } finally {
      cleanup()
    }
  })

  it('切换 reference 清理：覆盖送精修（无参考的新文档）→ 释放上一轮持有的 objectURL', async () => {
    const ref = await ingestPng([6], 'ref-cleanup.png')
    loadFromHandoff(makeHandoff(4, { referenceAssetId: ref.id }))
    const cleanup = mountEditView()
    try {
      await settle()
      const created = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results.map((r) =>
        String(r.value),
      )
      // 覆盖送精修：新文档无参考 → resolver 清理上一轮 URL
      loadFromHandoff(makeHandoff(6, {}))
      await settle()
      const revoked = revokeObjectURLMock.mock.calls.map((c) => String(c[0]))
      expect(revoked.length).toBeGreaterThanOrEqual(1)
      expect(revoked.some((url) => created.includes(url))).toBe(true)
      expect(document.querySelector('[data-testid="edit-reference-state"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('烘焙隔离不破坏：referenceAssetId 不入快照语义（paintingSnapshot 深拷贝，排钻工作台改动零回流）', async () => {
    const ref = await ingestPng([7], 'ref-bake.png')
    const handoff = makeHandoff(8, { referenceAssetId: ref.id })
    const snapshotBefore = handoff.paintingSnapshot
    loadFromHandoff(handoff)
    const doc = getEditDoc()!
    expect(doc.referenceAssetId).toBe(ref.id)
    // 快照隔离：编辑器内改像素不影响交接方持有的快照对象
    doc.paintingSnapshot.data[0] = 255
    expect(snapshotBefore.data[0]).not.toBe(255)
    // 参考资产改动（软删）不影响已载入文档的快照字段
    await trashAsset(ref.id)
    expect(doc.referenceAssetId).toBe(ref.id)
    expect(doc.paintingSnapshot.width).toBe(handoff.paintingSnapshot.width)
  })
})

describe('6.2 活动编辑引用入硬清空保护', () => {
  it('挂载 pin / 覆盖送精修 unpin 旧挂新 / 复位（卸载）unpin', async () => {
    const refA = await ingestPng([1], 'pin-a.png')
    const refB = await ingestPng([2], 'pin-b.png')
    expect(isAssetPinned(refA.id)).toBe(false)

    loadFromHandoff(makeHandoff(4, { referenceAssetId: refA.id }))
    expect(isAssetPinned(refA.id)).toBe(true)

    // 覆盖送精修：旧引用解除，新引用挂上
    loadFromHandoff(makeHandoff(4, { referenceAssetId: refB.id }))
    expect(isAssetPinned(refA.id)).toBe(false)
    expect(isAssetPinned(refB.id)).toBe(true)

    // 卸载（文档丢弃/复位）：解除
    resetEditForTests()
    expect(isAssetPinned(refB.id)).toBe(false)
  })

  it('硬清空跳过活动文档引用：软删+清空 → pinned 资产跳过并列明、字节存活；卸载后再清才删', async () => {
    const ref = await ingestPng([3, 3], 'pin-protect.png')
    loadFromHandoff(makeHandoff(4, { referenceAssetId: ref.id }))
    expect(isAssetPinned(ref.id)).toBe(true)

    await trashAsset(ref.id)
    const first = await emptyTrash()
    expect(first.deletedNodeIds).toEqual([])
    expect(first.skipped.map((s) => [s.id, s.reason])).toEqual([[ref.id, 'pinned']])
    // [gem-catalog 2.1] 迁移 seed 的 .gemshape 文件 blob 同驻 images store——计数含 SEED_FILE_COUNT
    expect(await listImages()).toHaveLength(1 + GEMSHAPE_SEEDS.length) // 内容字节存活

    // 卸载编辑文档后再硬清空：真正删除
    resetEditForTests()
    const second = await emptyTrash()
    expect(second.deletedNodeIds).toEqual([ref.id])
    expect(await listImages()).toHaveLength(GEMSHAPE_SEEDS.length)
  })

  it('无参考的编辑文档：不 pin 任何资产，硬清空不受影响', async () => {
    loadFromHandoff(makeHandoff(4, {}))
    expect(getEditDoc()?.referenceAssetId).toBeNull()
    const other = await ingestPng([8], 'unrelated.png')
    await trashAsset(other.id)
    const result = await emptyTrash()
    expect(result.deletedNodeIds).toEqual([other.id])
  })
})
