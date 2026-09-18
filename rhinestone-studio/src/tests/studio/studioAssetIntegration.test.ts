/*
 * [add-asset-library 4.5 / 5.1 / 5.2 / 6.3] 工作台资产接入集成测试（fake IDB）：
 * - handoff v2 消费：经 getAssetBlob 解码载入（origin 'handoff' + assetId + pin）；missing 显式出口（错误态+回退空态）
 * - 素材库选择：origin 'library' + assetId；换图解除旧 pin（studio 会话引用生命周期）
 * - 参考原图 asset 化：handoff.referenceAssetId 解析为 {assetId, dataUrl 缓存}
 * - 导出 PNG 入库 sys-exports：source='edit-export' + 命名 `精修 · <来源摘要> · MM-DD HH:mm.png`
 *
 * 环境声明：jsdom canvas 2d / Image 解码均不可用 → 本文件自带最小桩
 * （HTMLCanvasElement.getContext 返回软桩、Image 立即 onload 且带 naturalWidth/Height），
 * 走真实解码管线的同构路径。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveExportedPng,
  clearReferenceImage,
  getLoadError,
  getReferenceImage,
  getSourceImage,
  loadFromHandoff,
  loadFromLibrary,
  resetStudioForTests,
  setReferenceFile,
} from '$lib/stores/studio.svelte'
import { clearHandoff, getHandoff, setHandoff } from '$lib/stores/handoff.svelte'
import {
  getAsset,
  ingestAsset,
  isAssetPinned,
  listChildNodes,
  resetAssetStoreForTests,
  runAssetMigration,
  trashAsset,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let restoreCanvasCtx: (() => void) | null = null

async function ingestPng(bytes: number[], name: string, parentId = 'sys-uploads'): Promise<AssetImage> {
  const { node } = await ingestAsset({
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    name,
    width: 64,
    height: 64,
    parentId,
    source: 'upload',
  })
  return node
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetStudioForTests()
  localStorage.clear()

  // 最小解码桩：Image 立即 onload（带尺寸）；canvas 2d 软桩（drawImage no-op + getImageData 空白面）
  class OkImage {
    naturalWidth = 64
    naturalHeight = 48
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)
  const ctxStub = {
    drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  }
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext
  restoreCanvasCtx = () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }

  await runAssetMigration()
})

afterEach(() => {
  restoreCanvasCtx?.()
  restoreCanvasCtx = null
  vi.unstubAllGlobals()
  localStorage.clear()
  clearHandoff()
})

describe('4.5 handoff v2 消费（getAssetBlob 解码载入 / missing 显式出口）', () => {
  it('载荷资产可解析：经 getAssetBlob → dataUrl → 既有解码管线；origin handoff + assetId + pin', async () => {
    const node = await ingestPng([1, 2, 3], 'gen-1.png', 'sys-generated')
    setHandoff({ assetId: node.id, name: '变体-候选1.png' })

    const ok = await loadFromHandoff()
    expect(ok).toBe(true)
    const source = getSourceImage()
    expect(source?.origin).toBe('handoff')
    expect(source?.assetId).toBe(node.id)
    expect(source?.name).toBe('变体-候选1.png')
    expect(source?.width).toBe(64)
    expect(source?.height).toBe(48)
    // studio 会话引用（§4 引用集②）：载入即 pin
    expect(isAssetPinned(node.id)).toBe(true)
    // handoff 消费后清空
    expect(getHandoff()).toBeNull()
  })

  it('missing 显式出口：资产不可解析 → 错误态 + 回退空态（不是空画布静默）', async () => {
    setHandoff({ assetId: 'ast-hard-deleted', name: 'gone.png' })
    const ok = await loadFromHandoff()
    expect(ok).toBe(false)
    expect(getLoadError()).toContain('素材已缺失')
    expect(getSourceImage()).toBeNull() // 空态（BlockCanvas 双 CTA），而非空画布
    expect(getHandoff()).toBeNull()
  })

  it('handoff.referenceAssetId 解析：参考原图 asset 化落位 {assetId, dataUrl 缓存} + pin', async () => {
    const generated = await ingestPng([1, 2, 3], 'gen-2.png', 'sys-generated')
    const reference = await ingestPng([7, 7], 'ref-original.png')
    setHandoff({ assetId: generated.id, name: 'x.png', referenceAssetId: reference.id })

    const ok = await loadFromHandoff()
    expect(ok).toBe(true)
    const ref = getReferenceImage()
    expect(ref?.assetId).toBe(reference.id)
    expect(ref?.name).toBe('ref-original.png')
    expect(ref?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(isAssetPinned(reference.id)).toBe(true)
    // 参考图 pin 随清除解除
    clearReferenceImage()
    expect(isAssetPinned(reference.id)).toBe(false)
  })
})

describe('5.1 从素材库选择（origin library + pin 生命周期）', () => {
  it('loadFromLibrary：origin library + assetId + pin；换图解除旧引用', async () => {
    const first = await ingestPng([1, 1], 'pick-1.png', 'sys-uploads')
    const ok = await loadFromLibrary({ id: first.id, name: first.name })
    expect(ok).toBe(true)
    expect(getSourceImage()?.origin).toBe('library')
    expect(getSourceImage()?.assetId).toBe(first.id)
    expect(isAssetPinned(first.id)).toBe(true)

    // 换图：旧 pin 解除，新 pin 挂上（studio 会话引用随载入翻转）
    const second = await ingestPng([2, 2], 'pick-2.png', 'sys-uploads')
    await loadFromLibrary({ id: second.id, name: second.name })
    expect(isAssetPinned(first.id)).toBe(false)
    expect(isAssetPinned(second.id)).toBe(true)
    expect(getSourceImage()?.assetId).toBe(second.id)
  })

  it('loadFromLibrary missing：软删资产 → 显式错误态，不动当前已载入图', async () => {
    const live = await ingestPng([3], 'live.png', 'sys-uploads')
    await loadFromLibrary({ id: live.id, name: live.name })
    expect(getSourceImage()?.assetId).toBe(live.id)

    const trashed = await ingestPng([4], 'trashed.png', 'sys-uploads')
    await trashAsset(trashed.id)
    const ok = await loadFromLibrary({ id: trashed.id, name: trashed.name })
    expect(ok).toBe(false)
    expect(getLoadError()).toContain('素材图片已缺失')
    expect(getSourceImage()?.assetId).toBe(live.id) // 未被替换
  })

  it('setReferenceFile：上传即入库（assetId 挂载）+ pin / 清除 unpin', async () => {
    const file = new File([new Uint8Array([9, 9])], 'manual-ref.png', { type: 'image/png' })
    await setReferenceFile(file)
    const ref = getReferenceImage()
    expect(ref?.assetId).toMatch(/^ast-/)
    expect(ref?.name).toBe('manual-ref.png')
    expect(isAssetPinned(ref?.assetId ?? '')).toBe(true)
    clearReferenceImage()
    expect(isAssetPinned(ref?.assetId ?? '')).toBe(false)
  })
})

describe('6.3 导出 PNG 入库 sys-exports', () => {
  it('archiveExportedPng：source=edit-export + 命名 `精修 · <来源摘要> · MM-DD HH:mm.png`', async () => {
    const blob = new Blob([new Uint8Array([5])], { type: 'image/png' })
    const id = await archiveExportedPng(blob, '六方抽稀 · 密度 100% · SS10 · 12 钻', 64, 64)
    expect(id).toMatch(/^ast-/)

    const exports = (await listChildNodes('sys-exports')).filter((n) => n.type === 'image') as AssetImage[]
    expect(exports).toHaveLength(1)
    expect(exports[0].source).toBe('edit-export')
    expect(exports[0].name).toMatch(/^精修 · 六方抽稀 · 密度 100% · SS10 · 12 钻 · \d{2}-\d{2} \d{2}:\d{2}\.png$/)
    expect(exports[0].width).toBe(64)
    const node = await getAsset(id ?? '')
    expect(node?.parentId).toBe('sys-exports')
  })
})
