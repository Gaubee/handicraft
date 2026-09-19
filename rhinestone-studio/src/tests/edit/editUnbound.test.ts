/**
 * 专家工作台页解绑契约（openspec add-project-files tasks 3.2/3.3/3.4，design §1.2 A.2.3/§4/§7.4）：
 *
 * 1. dirty 全集（A.2.3 口径）：patch/图层/重命名 → dirty；保存 → 清；导出不清；undo 不影响；
 *    loadFromHandoff = 未保存新文档、loadFromGemdoc = 干净态。
 * 2. saveGemdoc round-trip：首次 ingestProjectAsset(sys-projects) 记 docId / 再次 CAS 换绑 /
 *    冲突 typed error 零写入且 dirty 保持。
 * 3. loadFromGemdoc：manualCounter 从 gems 派生 max(m-编号)（nextManualId = max+1）/
 *    图层与 provenance 与参考弱引用 round-trip / lease pin reference（硬清被拒、关闭释放）。
 * 4. 四入口 converge 同一文档模型：送精修（既有）/ 图片→quickLayout / gemdoc 直开 /
 *    gemproj→引擎重放烘焙（provenance.gemprojAssetId；与 quickLayout 默认参同图逐字段相等——
 *    重放装配与 studio 管线同构的最强证据）。
 * 5. EditView：空态（主 CTA/次 CTA/上传/最近 ≤4 降序/引导行）/ 守卫三分（beforeunload +
 *    三按钮）/ openIntent gemdoc 消费（成功 ack 清意图；失败单次 toast 留 failed 态）。
 *
 * 环境声明：jsdom 无 canvas/Image → 本文件 stub 合并 projectFile.test 的确定性编解码器
 * （putImageData/toDataURL ↔ Image 解码逐字节还原）与 quickLayout.test 的解码桩
 * （非编解码 dataUrl → 固定 96×64 双矩形 fixture 像素）；fake IDB 支撑 assetStore 全链。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import StudioStatusBar from '../../components/Studio/StudioStatusBar.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import {
  applyPatch,
  buildGemdocExport,
  closeEditDocument,
  getEditDoc,
  getEditProjectIdentity,
  getUndoDepths,
  isEditDirty,
  loadFromGemdoc,
  loadFromHandoff,
  nextManualId,
  resetEditForTests,
  saveGemdoc,
  saveGemdocAs,
  setLayerVisible,
  undo,
} from '$lib/stores/edit.svelte'
import {
  emptyTrash,
  getProject,
  ingestProjectAsset,
  isAssetPinned,
  listChildNodes,
  projectPinRefCount,
  resetAssetStoreForTests,
  runAssetMigration,
  SYS_PROJECTS_FOLDER_ID,
  trashAsset,
  updateProjectAsset,
  ingestAsset,
  type AssetImage,
} from '$lib/persistence/assetStore'
import type { AssetProject } from '$lib/persistence/projectTypes'
import { getImageBlob } from '$lib/persistence/imageStore'
import { ProjectConflictError, PROJECT_MIME } from '$lib/persistence/projectTypes'
import { parseGemdoc } from '$lib/persistence/projectFile'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { peekOpenIntent, resetOpenIntentForTests, setOpenIntent } from '$lib/stores/openIntent.svelte'
import { quickLayoutFromImage } from '$lib/edit/quickLayout'
import { replayGemprojAsset } from '$lib/edit/gemprojReplay'
import {
  buildManualEditHandoff,
  getActiveResult,
  loadFromEngineImage,
  resetStudioForTests,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'
import { makeHandoff } from './helpers'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'
import { STARTER_PALETTE, type EngineImage } from '$lib/engine'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

// ---------------------------------------------------------------------------
// fixture 与 stub 环境（合并 projectFile 编解码器 + quickLayout 解码桩）
// ---------------------------------------------------------------------------

const RED: [number, number, number] = [200, 16, 46]
const BLACK: [number, number, number] = [26, 26, 26]
const FIXTURE_W = 96
const FIXTURE_H = 64

function twoRects(w: number, h: number): EngineImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = x <= Math.floor(w / 2) - 1 ? RED : BLACK
      const i = (y * w + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

const FIXTURE = twoRects(FIXTURE_W, FIXTURE_H)

interface Bitmap {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * stub 合体：canvas ctx 维护位图（putImageData/drawImage 写、getImageData 读），
 * toDataURL 编码「8 字节宽高头 + RGBA」；Image 解码该格式还原像素；其余 dataUrl
 * → 96×64 fixture 像素（quickLayout/gemprojReplay 解码链）。
 */
function installStubEnv(): () => void {
  const bitmaps = new WeakMap<object, Bitmap>()
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL

  class StubCtx {
    fillStyle = ''
    strokeStyle = ''
    lineWidth = 1
    globalAlpha = 1
    imageSmoothingEnabled = true
    constructor(private readonly canvas: HTMLCanvasElement) {}
    createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    }
    putImageData(imageData: { width: number; height: number; data: Uint8ClampedArray }): void {
      bitmaps.set(this.canvas, { width: imageData.width, height: imageData.height, data: new Uint8ClampedArray(imageData.data) })
    }
    drawImage(source: unknown, _dx: number, _dy: number, dw: number, dh: number): void {
      const pixels = (source as { __stubPixels?: { data: Uint8ClampedArray } }).__stubPixels
      if (pixels) {
        bitmaps.set(this.canvas, { width: dw, height: dh, data: new Uint8ClampedArray(pixels.data.subarray(0, dw * dh * 4)) })
      } else {
        bitmaps.delete(this.canvas)
      }
    }
    getImageData(_x: number, _y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      const bitmap = bitmaps.get(this.canvas)
      if (bitmap && bitmap.width === w && bitmap.height === h) {
        return { width: w, height: h, data: new Uint8ClampedArray(bitmap.data) }
      }
      // 解码链（quickLayout/replay）：非编解码位图 → fixture 像素（96×64 命中，其余纯红）
      if (w === FIXTURE.width && h === FIXTURE.height) {
        return { width: w, height: h, data: new Uint8ClampedArray(FIXTURE.data) }
      }
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = RED[0]
        data[i + 1] = RED[1]
        data[i + 2] = RED[2]
        data[i + 3] = 255
      }
      return { width: w, height: h, data }
    }
    // EditCanvas 渲染路径的 2D 绘制面（jsdom 走不到真实栅格化，no-op 即可）
    setTransform(): void {}
    scale(): void {}
    translate(): void {}
    save(): void {}
    restore(): void {}
    beginPath(): void {}
    closePath(): void {}
    arc(): void {}
    fill(): void {}
    stroke(): void {}
    fillRect(): void {}
    clearRect(): void {}
  }

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return new StubCtx(this) as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, mime?: string) {
    const bitmap = bitmaps.get(this)
    if (!bitmap) throw new Error('stub codec: 空画布无法编码')
    if (mime !== 'image/png') throw new Error('stub codec: 仅支持 image/png')
    const bytes = new Uint8Array(8 + bitmap.data.length)
    new DataView(bytes.buffer).setUint32(0, bitmap.width)
    new DataView(bytes.buffer).setUint32(4, bitmap.height)
    bytes.set(bitmap.data, 8)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return `data:image/png;base64,${btoa(binary)}`
  } as unknown as typeof HTMLCanvasElement.prototype.toDataURL

  /** EditCanvas 渲染路径的 ImageData 替身（jsdom 无该全局；ctx 非空后画布层会走到）。 */
  class StubImageData {
    readonly width: number
    readonly height: number
    readonly data: Uint8ClampedArray
    constructor(data: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
      if (typeof data === 'number') {
        this.width = data
        this.height = widthOrHeight ?? 0
        this.data = new Uint8ClampedArray(this.width * this.height * 4)
      } else {
        this.width = widthOrHeight ?? 0
        this.height = height ?? 0
        this.data = new Uint8ClampedArray(data)
      }
    }
  }
  vi.stubGlobal('ImageData', StubImageData)

  class StubImage {
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    __stubPixels: { data: Uint8ClampedArray } | null = null
    set src(value: string) {
      queueMicrotask(() => {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
        if (match !== null) {
          try {
            const binary = atob(match[1])
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
            const view = new DataView(bytes.buffer)
            const w = view.getUint32(0)
            const h = view.getUint32(4)
            if (bytes.length === 8 + w * h * 4) {
              this.naturalWidth = w
              this.naturalHeight = h
              this.__stubPixels = { data: new Uint8ClampedArray(bytes.subarray(8)) }
              this.onload?.()
              return
            }
          } catch {
            // 坏载荷 → 落到 fixture 分支
          }
        }
        // 非编解码 dataUrl（解码链的来源 blob）：fixture 尺寸 + 像素由 getImageData 兜底
        this.naturalWidth = FIXTURE_W
        this.naturalHeight = FIXTURE_H
        this.onload?.()
      })
    }
  }
  vi.stubGlobal('Image', StubImage)

  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL
    vi.unstubAllGlobals()
  }
}

const PNG_BLOB = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

// ---------------------------------------------------------------------------
// DB/环境装配
// ---------------------------------------------------------------------------

let fake: FakeIndexedDB
let restoreEnv: (() => void) | null = null

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetEditForTests()
  resetStudioForTests()
  resetOpenIntentForTests()
  resetToastsForTests()
  setView('lab')
  localStorage.clear()
  restoreEnv = installStubEnv()
  await runAssetMigration() // seed 系统目录（sys-uploads/sys-projects…）
})

afterEach(() => {
  restoreEnv?.()
  restoreEnv = null
  vi.unstubAllGlobals()
  localStorage.clear()
  setView('lab')
})

async function ingestFixtureImage(name = '蝴蝶.png'): Promise<AssetImage> {
  const { node } = await ingestAsset({
    blob: PNG_BLOB,
    name,
    width: FIXTURE_W,
    height: FIXTURE_H,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  return node
}

/** 手工钻入文档（add patch），返回新增后的文档。 */
function addManualGems(count: number): void {
  for (let i = 0; i < count; i += 1) {
    applyPatch({
      op: 'add',
      gems: [{ id: nextManualId(), x: 10 + i * 8, y: 12, colorId: 'c1', blockId: null, origin: 'manual', moved: false, shapeId: 'round', diameterMm: 2.8 }],
    })
  }
}

async function gemdocNodes(): Promise<AssetProject[]> {
  const children = await listChildNodes(SYS_PROJECTS_FOLDER_ID)
  return children.filter((n): n is AssetProject => n.type === 'project' && n.projectKind === 'gemdoc')
}

async function nodeBlobText(node: AssetProject): Promise<string> {
  const blob = await getImageBlob(node.blobKey)
  if (blob === null) throw new Error(`物理记录缺失：${node.blobKey}`)
  return blob.text()
}

// ---------------------------------------------------------------------------
// 1. dirty 全集（A.2.3 口径）
// ---------------------------------------------------------------------------

describe('dirty 口径（A.2.3：自上次保存以来有修改）', () => {
  it('loadFromHandoff = 未保存新文档（dirty=true、docId=null、默认名「精修 · <来源摘要>」）', () => {
    loadFromHandoff(makeHandoff(6, { sourceSummary: '语义混合 · 密度 100% · SS10 · 6 钻' }))
    expect(isEditDirty()).toBe(true)
    expect(getEditDoc()!.docId).toBeNull()
    expect(getEditDoc()!.name).toBe('精修 · 语义混合 · 密度 100% · SS10 · 6 钻')
    expect(getEditDoc()!.provenance.origin).toBe('studio-bake') // 缺省 origin（送精修主链零改动）
  })

  it('patch 提交 → dirty；undo 不影响 dirty（撤销≠保存）', () => {
    loadFromHandoff(makeHandoff(4))
    applyPatch({ op: 'update', changes: [{ id: getEditDoc()!.gems[0].id, before: { x: 1 }, after: { x: 2 } }] })
    expect(isEditDirty()).toBe(true)
    undo()
    expect(isEditDirty()).toBe(true) // 内容回到保存前，dirty 口径仍由「保存」清
  })

  it('图层变更（序列化字段）→ dirty；selection 不影响', () => {
    loadFromHandoff(makeHandoff(2))
    setLayerVisible('painting', false)
    expect(isEditDirty()).toBe(true)
  })

  it('保存成功 → dirty=false；导出（.gemdoc 装配）不清 dirty', async () => {
    loadFromHandoff(makeHandoff(3))
    await saveGemdoc({ name: '蝴蝶' })
    expect(isEditDirty()).toBe(false)
    applyPatch({ op: 'update', changes: [{ id: getEditDoc()!.gems[0].id, before: { x: 1 }, after: { x: 5 } }] })
    expect(isEditDirty()).toBe(true)
    const exported = await buildGemdocExport()
    expect(exported.filename).toBe('蝴蝶.gemdoc')
    expect(isEditDirty()).toBe(true) // 导出不清 dirty
  })

  it('loadFromGemdoc → 干净态（dirty=false）；再次 patch → dirty', async () => {
    loadFromHandoff(makeHandoff(3))
    await saveGemdoc({ name: '干净态' })
    const docId = getEditProjectIdentity()!.docId!
    await closeEditDocument()
    await loadFromGemdoc(docId)
    expect(isEditDirty()).toBe(false)
    applyPatch({ op: 'update', changes: [{ id: getEditDoc()!.gems[0].id, before: { x: 1 }, after: { x: 3 } }] })
    expect(isEditDirty()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. saveGemdoc round-trip（首次入库 / CAS 换绑 / 冲突）
// ---------------------------------------------------------------------------

describe('saveGemdoc 写路径', () => {
  it('首次保存：ingestProjectAsset 落 sys-projects 记 docId；blob 可 parse 回且字段对齐', async () => {
    loadFromHandoff(makeHandoff(8, { sourceSummary: '六方抽稀 · 密度 100% · SS10 · 8 钻' }))
    const result = await saveGemdoc({ name: '蝴蝶精修' })
    expect(result.status).toBe('created')
    expect(result.name).toBe('蝴蝶精修')
    const identity = getEditProjectIdentity()!
    expect(identity.docId).toBe(result.docId)
    expect(identity.savedAt).not.toBeNull()
    expect(isEditDirty()).toBe(false)

    const nodes = await gemdocNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('蝴蝶精修.gemdoc')
    expect(nodes[0].parentId).toBe(SYS_PROJECTS_FOLDER_ID)
    expect(nodes[0].summary).toMatchObject({ gemCount: 8 }) // ss 键随 1.4 GridSpec.ss 清零删除

    const file = parseGemdoc(await nodeBlobText(nodes[0]), { mime: PROJECT_MIME.gemdoc })
    expect(file.name).toBe('蝴蝶精修')
    expect(file.gems).toHaveLength(8)
    expect(file.provenance.sourceSummary).toBe('六方抽稀 · 密度 100% · SS10 · 8 钻')
    expect(file.blocks).toHaveLength(1)
    expect(file.width).toBe(64)
    expect(file.height).toBe(64)
  })

  it('再次保存：CAS 换绑同一节点（不建新节点），内容随修改更新', async () => {
    loadFromHandoff(makeHandoff(4))
    await saveGemdoc({ name: '换绑' })
    addManualGems(2) // m-1 / m-2（dirty）
    const result = await saveGemdoc()
    expect(result.status).toBe('updated')
    expect(result.docId).toBe(getEditProjectIdentity()!.docId)

    const nodes = await gemdocNodes()
    expect(nodes).toHaveLength(1)
    const file = parseGemdoc(await nodeBlobText(nodes[0]), { mime: PROJECT_MIME.gemdoc })
    expect(file.gems).toHaveLength(6)
    expect(file.gems.filter((g) => g.origin === 'manual')).toHaveLength(2)
    expect(isEditDirty()).toBe(false)
  })

  it('CAS 冲突：外部换绑后保存 → ProjectConflictError，零写入且 dirty 保持', async () => {
    loadFromHandoff(makeHandoff(4))
    const created = await saveGemdoc({ name: '冲突' })
    const nodeBefore = await getProject(created.docId)

    // 背后换绑（另一入口先保存了新内容）
    const otherBlob = new Blob([JSON.stringify({ kind: 'gemdoc', formatVersion: 1, n: 'other' })], { type: PROJECT_MIME.gemdoc })
    await updateProjectAsset(created.docId, { expectedBlobKey: nodeBefore!.blobKey, bytes: otherBlob, summary: {} })

    applyPatch({ op: 'update', changes: [{ id: getEditDoc()!.gems[0].id, before: { x: 1 }, after: { x: 9 } }] })
    await expect(saveGemdoc()).rejects.toBeInstanceOf(ProjectConflictError)
    expect(isEditDirty()).toBe(true)

    const nodeAfter = await getProject(created.docId)
    expect(await nodeBlobText(nodeAfter!)).toBe(JSON.stringify({ kind: 'gemdoc', formatVersion: 1, n: 'other' }))
  })

  it('另存为（fork）：新节点接管 docId，原节点内容保持旧版', async () => {
    loadFromHandoff(makeHandoff(4))
    const first = await saveGemdoc({ name: '原稿' })
    addManualGems(1)
    const forked = await saveGemdocAs('分叉稿')
    expect(forked.status).toBe('created')
    expect(forked.docId).not.toBe(first.docId)
    expect(getEditProjectIdentity()!.docId).toBe(forked.docId)
    expect(isEditDirty()).toBe(false)

    const nodes = await gemdocNodes()
    expect(nodes).toHaveLength(2)
    const original = parseGemdoc(await nodeBlobText((await getProject(first.docId))!), { mime: PROJECT_MIME.gemdoc })
    expect(original.gems).toHaveLength(4) // 原节点未被 fork 带走修改
  })

  it('无文档时保存/导出 → 显式错误', async () => {
    await expect(saveGemdoc()).rejects.toThrowError(/未载入/)
    await expect(buildGemdocExport()).rejects.toThrowError(/未载入/)
  })
})

// ---------------------------------------------------------------------------
// 3. loadFromGemdoc（manualCounter 派生 / round-trip / lease pin）
// ---------------------------------------------------------------------------

describe('loadFromGemdoc 打开链路', () => {
  async function seedGemdocWithManualGems(): Promise<string> {
    loadFromHandoff(makeHandoff(3))
    addManualGems(3) // m-1 / m-2 / m-3
    setLayerVisible('painting', false) // 图层文档态 round-trip
    const result = await saveGemdoc({ name: '手工钻' })
    await closeEditDocument()
    return result.docId
  }

  it('manualCounter 从 gems 派生 max(m-编号)：m-3 后下一个 id = m-4', async () => {
    const docId = await seedGemdocWithManualGems()
    await loadFromGemdoc(docId)
    expect(nextManualId()).toBe('m-4')
    expect(getEditDoc()!.gems).toHaveLength(6)
    expect(isEditDirty()).toBe(false)
    expect(getUndoDepths()).toEqual({ undo: 0, redo: 0 })
  })

  it('图层/provenance/参考弱引用 round-trip；reference 被 lease pin（硬清被拒、关闭放行）', async () => {
    const ref = await ingestFixtureImage('参考.png')
    loadFromHandoff(makeHandoff(4, { referenceAssetId: ref.id }))
    await saveGemdoc({ name: '带参考' })
    const docId = getEditProjectIdentity()!.docId!
    await closeEditDocument()
    expect(isAssetPinned(ref.id)).toBe(false)

    await loadFromGemdoc(docId)
    const doc = getEditDoc()!
    expect(doc.layers.painting.visible).toBe(true)
    expect(doc.referenceAssetId).toBe(ref.id)
    expect(doc.docId).toBe(docId)
    expect(projectPinRefCount(ref.id)).toBe(1) // lease 维度 pin（bool-pin 不叠加）
    expect(isAssetPinned(ref.id)).toBe(true)

    // 软删 + 硬清：pinned 跳过；关闭文档后再清才删
    await trashAsset(ref.id)
    const first = await emptyTrash()
    expect(first.deletedNodeIds).toEqual([])
    expect(first.skipped.map((s) => s.reason)).toContain('pinned')

    await closeEditDocument()
    expect(projectPinRefCount(ref.id)).toBe(0)
    const second = await emptyTrash()
    expect(second.deletedNodeIds).toEqual([ref.id])
  })

  it('失败分支：缺失 / 非 gemdoc 节点 / 已软删 各自显式错误（当前文档保持）', async () => {
    loadFromHandoff(makeHandoff(2))
    // 缺失（含图片节点——getProject 口径下不是项目节点即缺失）
    await expect(loadFromGemdoc('ast-not-exist')).rejects.toThrowError(/不存在/)
    const image = await ingestFixtureImage('误选.png')
    await expect(loadFromGemdoc(image.id)).rejects.toThrowError(/不存在/)
    // 类型不符：gemproj 节点按 gemdoc 打开
    const gemproj = await ingestProjectAsset({
      blob: new Blob([JSON.stringify({ kind: 'gemproj', formatVersion: 1 })], { type: PROJECT_MIME.gemproj }),
      name: '误开.gemproj',
      projectKind: 'gemproj',
    })
    await expect(loadFromGemdoc(gemproj.node.id)).rejects.toThrowError(/不是精修项目/)

    loadFromHandoff(makeHandoff(3))
    const created = await saveGemdoc({ name: '回收站' })
    await trashAsset(created.docId)
    await expect(loadFromGemdoc(created.docId)).rejects.toThrowError(/回收站/)

    // 失败路径当前文档保持原样
    expect(getEditDoc()!.gems).toHaveLength(3)
    expect(getEditProjectIdentity()!.name).toBe('回收站')
  })

  it('覆盖语义：gemdoc 打开后再送精修（loadFromHandoff）→ 旧 lease 释放、dirty=true、docId 置空', async () => {
    const ref = await ingestFixtureImage('参考2.png')
    loadFromHandoff(makeHandoff(3, { referenceAssetId: ref.id }))
    await saveGemdoc({ name: 'lease 换绑' })
    const docId = getEditProjectIdentity()!.docId!
    await loadFromGemdoc(docId)
    expect(projectPinRefCount(ref.id)).toBe(1)

    loadFromHandoff(makeHandoff(5, { referenceAssetId: ref.id }))
    expect(projectPinRefCount(ref.id)).toBe(0) // bool-pin 语义接管（同一资产 pin 不叠加计数）
    expect(getEditDoc()!.docId).toBeNull()
    expect(isEditDirty()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. 四入口 converge（同一文档模型断言）
// ---------------------------------------------------------------------------

describe('四入口 converge（design §4：①送精修 ②图片→quickLayout ③gemdoc ④gemproj 重放）', () => {
  function assertDocumentModel(expectations: {
    dirty: boolean
    docId: string | null
    origin: string
    gemsMin: number
  }): void {
    const doc = getEditDoc()
    expect(doc).not.toBeNull()
    expect(doc!.gems.length).toBeGreaterThanOrEqual(expectations.gemsMin)
    expect(doc!.blocks.length).toBeGreaterThan(0)
    expect(doc!.palette.length).toBeGreaterThan(0)
    expect(doc!.paintingSnapshot.data.length).toBe(doc!.width * doc!.height * 4)
    expect(isEditDirty()).toBe(expectations.dirty)
    expect(doc!.docId).toBe(expectations.docId)
    expect(doc!.provenance.origin).toBe(expectations.origin)
    expect(doc!.name.length).toBeGreaterThan(0)
  }

  it('① 送精修（既有主链）：origin=studio-bake、未保存新文档', async () => {
    loadFromEngineImage(fixtureShapes(), '送精修.png', 'handoff')
    await waitForStudioIdle()
    const handoff = buildManualEditHandoff()
    expect(handoff).not.toBeNull()
    loadFromHandoff(handoff!)
    assertDocumentModel({ dirty: true, docId: null, origin: 'studio-bake', gemsMin: 1 })
  })

  it('② 图片→快速排稿：origin=quick-layout、库选带 sourceAssetId、未保存新文档', async () => {
    const asset = await ingestFixtureImage('直入.png')
    const blob = await getImageBlob(asset.blobKey!)
    expect(blob).not.toBeNull()
    const { handoff, provenance } = await quickLayoutFromImage(blob!)
    expect(provenance.origin).toBe('quick-layout')
    loadFromHandoff(handoff, { origin: 'quick-layout', sourceAssetId: asset.id, name: `精修 · ${handoff.sourceSummary}` })
    assertDocumentModel({ dirty: true, docId: null, origin: 'quick-layout', gemsMin: 1 })
    expect(getEditDoc()!.provenance.sourceAssetId).toBe(asset.id)
  })

  it('③ gemdoc 直开：干净态续作（docId 记账）', async () => {
    loadFromHandoff(makeHandoff(5))
    const saved = await saveGemdoc({ name: '续作' })
    await closeEditDocument()
    await loadFromGemdoc(saved.docId)
    assertDocumentModel({ dirty: false, docId: saved.docId, origin: 'studio-bake', gemsMin: 5 })
  })

  it('④ gemproj→引擎重放烘焙：provenance.gemprojAssetId 溯源 + 与 quickLayout 默认参同图逐字段相等', async () => {
    // 合成 gemproj 入库（source=asset 引用同一 fixture 图；参数与 quickLayout 默认参一致）
    const source = await ingestFixtureImage('重放源.png')
    const gemprojText = JSON.stringify({
      kind: 'gemproj',
      formatVersion: 1,
      appVersion: '0.1.0',
      engineVersion: 1,
      createdAt: 1,
      savedAt: 2,
      name: '蝴蝶排钻',
      source: { kind: 'asset', assetId: source.id, name: source.name, width: FIXTURE_W, height: FIXTURE_H, downscale: 1 },
      segment: { k: 8, seed: 1 },
      overrides: { disabled: {}, density: {}, type: {}, color: {} },
      physics: { ss: 'SS10', gapMm: 0.4, globalDensity: 1, relax: { boundary: false, repulsion: false } },
      palette: STARTER_PALETTE.map((c) => ({ ...c })),
      activeStrategy: 'hybrid',
    })
    const ingested = await ingestProjectAsset({
      blob: new Blob([gemprojText], { type: PROJECT_MIME.gemproj }),
      name: '蝴蝶排钻.gemproj',
      projectKind: 'gemproj',
    })

    const result = await replayGemprojAsset(ingested.node.id)
    expect(result.provenance).toEqual({
      origin: 'studio-bake',
      sourceSummary: result.handoff.sourceSummary,
      gemprojAssetId: ingested.node.id,
    })
    expect(result.droppedOverrides).toBe(0)

    // 与 quickLayout 默认参同图同出（重放装配 = studio 管线同构的最强证据）
    const quick = await quickLayoutFromImage(PNG_BLOB)
    expect(result.handoff).toEqual(quick.handoff)

    loadFromHandoff(result.handoff, {
      origin: result.provenance.origin,
      gemprojAssetId: result.provenance.gemprojAssetId,
      name: `精修 · ${result.handoff.sourceSummary}`,
    })
    assertDocumentModel({ dirty: true, docId: null, origin: 'studio-bake', gemsMin: 1 })
    expect(getEditDoc()!.provenance.gemprojAssetId).toBe(ingested.node.id)
  })

  it('④ 漂移诚实：悬空覆写键计数（块 id 不存在 → droppedOverrides）；来源缺失显式失败', async () => {
    const source = await ingestFixtureImage('漂移源.png')
    const gemprojText = JSON.stringify({
      kind: 'gemproj',
      formatVersion: 1,
      appVersion: '0.1.0',
      engineVersion: 1,
      createdAt: 1,
      savedAt: 2,
      name: '漂移排钻',
      source: { kind: 'asset', assetId: source.id, name: source.name, width: FIXTURE_W, height: FIXTURE_H, downscale: 1 },
      segment: { k: 8, seed: 1 },
      overrides: {
        disabled: { 'b-ghost-1': true },
        density: { 'b-ghost-2': 0.5 },
        type: {},
        color: {},
      },
      physics: { ss: 'SS10', gapMm: 0.4, globalDensity: 1, relax: { boundary: false, repulsion: false } },
      palette: STARTER_PALETTE.map((c) => ({ ...c })),
      activeStrategy: 'hybrid',
    })
    const ingested = await ingestProjectAsset({
      blob: new Blob([gemprojText], { type: PROJECT_MIME.gemproj }),
      name: '漂移排钻.gemproj',
      projectKind: 'gemproj',
    })
    const result = await replayGemprojAsset(ingested.node.id)
    expect(result.droppedOverrides).toBe(2)

    // 来源缺失：gemproj 引用已硬删的图 → 转化失败（typed missing 错误上浮）
    const dead = JSON.parse(gemprojText) as { source: { kind: 'asset'; assetId: string } }
    dead.source.assetId = 'ast-deleted'
    const deadIngested = await ingestProjectAsset({
      blob: new Blob([JSON.stringify(dead)], { type: PROJECT_MIME.gemproj }),
      name: '断链排钻.gemproj',
      projectKind: 'gemproj',
    })
    await expect(replayGemprojAsset(deadIngested.node.id)).rejects.toThrowError(/缺失|不存在/)
  })
})

// ---------------------------------------------------------------------------
// 5. EditView：空态 / 守卫三分 / openIntent 消费
// ---------------------------------------------------------------------------

function mountEditView(): () => void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EditView, { target })
  return () => {
    unmount(app)
    target.remove()
  }
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('EditView 空态重设计（tasks 3.3）', () => {
  it('三入口按钮 + 引导行齐备；引导可切排钻设计页', async () => {
    const cleanup = mountEditView()
    try {
      await tick()
      const root = document.body
      expect(root.querySelector('[data-testid="edit-empty"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="edit-empty-pick-image"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="edit-empty-open-project"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="edit-empty-upload"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="edit-empty-guide"]')?.textContent).toContain('想先调密度与策略')
      root.querySelector<HTMLButtonElement>('[data-testid="edit-empty-goto-studio"]')!.click()
      await tick()
      expect(getView()).toBe('studio')
    } finally {
      cleanup()
    }
  })

  it('最近精修项目 ≤4、updatedAt 降序（sys-projects 下 gemdoc）', async () => {
    // 两个 gemdoc（间隔 5ms 保证 updatedAt 严格降序）+ 一个 gemproj（不进最近）
    for (const name of ['较早.gemdoc', '较新.gemdoc']) {
      await ingestProjectAsset({
        blob: new Blob([JSON.stringify({ kind: 'gemdoc', formatVersion: 1 })], { type: PROJECT_MIME.gemdoc }),
        name,
        projectKind: 'gemdoc',
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await ingestProjectAsset({
      blob: new Blob([JSON.stringify({ kind: 'gemproj', formatVersion: 1 })], { type: PROJECT_MIME.gemproj }),
      name: '排钻.gemproj',
      projectKind: 'gemproj',
    })

    const cleanup = mountEditView()
    try {
      await settle()
      const recents = [...document.querySelectorAll('[data-testid="edit-empty-recent"]')]
      expect(recents).toHaveLength(2)
      expect(recents[0].textContent).toContain('较新')
      expect(recents[1].textContent).toContain('较早')
      expect(document.querySelector('[data-testid="edit-empty-recents"]')?.textContent).not.toContain('排钻')
    } finally {
      cleanup()
    }
  })
})

describe('守卫三分（tasks 3.4：beforeunload + 三按钮；切 Tab 不弹为 store 语义）', () => {
  it('dirty 时 beforeunload 阻止默认；干净/无文档不阻止', async () => {
    const cleanup = mountEditView()
    try {
      const dispatch = (): Event => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event
      }
      expect(dispatch().defaultPrevented).toBe(false) // 无文档

      loadFromHandoff(makeHandoff(3))
      await tick()
      expect(dispatch().defaultPrevented).toBe(true) // dirty

      await saveGemdoc({ name: '干净' })
      await tick()
      expect(dispatch().defaultPrevented).toBe(false) // 干净
    } finally {
      cleanup()
    }
  })

  it('关闭文档三按钮：取消保留 → 不保存直接关 → 保存并继续 = 先入库再关', async () => {
    loadFromHandoff(makeHandoff(4))
    const cleanup = mountEditView()
    try {
      await tick()
      document.querySelector<HTMLButtonElement>('[data-testid="edit-doc-menu-toggle"]')!.click()
      await tick()
      document.querySelector<HTMLButtonElement>('[data-testid="edit-menu-close"]')!.click()
      await settle()
      expect(document.querySelector('[data-testid="edit-guard-dialog"]')).not.toBeNull()

      // 取消：文档保持
      document.querySelector<HTMLButtonElement>('[data-testid="edit-guard-cancel"]')!.click()
      await settle()
      expect(getEditDoc()).not.toBeNull()
      expect(document.querySelector('[data-testid="edit-guard-dialog"]')).toBeNull()

      // 不保存：直接关闭
      document.querySelector<HTMLButtonElement>('[data-testid="edit-doc-menu-toggle"]')!.click()
      await tick()
      document.querySelector<HTMLButtonElement>('[data-testid="edit-menu-close"]')!.click()
      await settle()
      document.querySelector<HTMLButtonElement>('[data-testid="edit-guard-discard"]')!.click()
      await settle()
      expect(getEditDoc()).toBeNull()
      expect(await gemdocNodes()).toHaveLength(0) // 未入库

      // 保存并继续（未保存新文档 → 以默认名入库后再关）
      loadFromHandoff(makeHandoff(5))
      await tick()
      document.querySelector<HTMLButtonElement>('[data-testid="edit-doc-menu-toggle"]')!.click()
      await tick()
      document.querySelector<HTMLButtonElement>('[data-testid="edit-menu-close"]')!.click()
      await settle()
      document.querySelector<HTMLButtonElement>('[data-testid="edit-guard-save"]')!.click()
      await settle(120)
      expect(getEditDoc()).toBeNull()
      const nodes = await gemdocNodes()
      expect(nodes).toHaveLength(1)
      expect(nodes[0].summary.gemCount).toBe(5)
    } finally {
      cleanup()
    }
  })
})

describe('openIntent gemdoc 消费（tasks 3.4 / §7.4，可见性门）', () => {
  it('成功：claim → loadFromGemdoc → ackSuccess 清意图、文档就位', async () => {
    loadFromHandoff(makeHandoff(3))
    const saved = await saveGemdoc({ name: '意图打开' })
    await closeEditDocument()

    setOpenIntent({ kind: 'gemdoc', assetId: saved.docId })
    const cleanup = mountEditView()
    try {
      setView('edit')
      await settle()
      expect(peekOpenIntent()).toBeNull() // ackSuccess 清意图
      expect(getEditDoc()).not.toBeNull()
      expect(getEditProjectIdentity()!.docId).toBe(saved.docId)
      expect(isEditDirty()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('失败：单次 toast + 意图留 failed 可诊断态（不清 token）', async () => {
    setOpenIntent({ kind: 'gemdoc', assetId: 'ast-missing' })
    const cleanup = mountEditView()
    try {
      setView('edit')
      await settle()
      const snapshot = peekOpenIntent()
      expect(snapshot?.phase).toBe('failed')
      expect(getToasts()).toHaveLength(1)
      expect(getToasts()[0].message).toContain('打开精修项目失败')
      expect(getEditDoc()).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('dirty 时先过守卫：取消 → ackFailure（意图作废）不加载', async () => {
    loadFromHandoff(makeHandoff(3))
    const saved = await saveGemdoc({ name: '守卫意图' })
    await closeEditDocument()

    // 现有未保存文档 + gemdoc 意图 → 守卫弹窗
    loadFromHandoff(makeHandoff(4))
    setOpenIntent({ kind: 'gemdoc', assetId: saved.docId })
    const cleanup = mountEditView()
    try {
      setView('edit')
      await settle()
      expect(document.querySelector('[data-testid="edit-guard-dialog"]')).not.toBeNull()
      expect(getEditDoc()!.gems).toHaveLength(4) // 未加载目标

      document.querySelector<HTMLButtonElement>('[data-testid="edit-guard-cancel"]')!.click()
      await settle()
      const snapshot = peekOpenIntent()
      expect(snapshot?.phase).toBe('failed')
      expect(snapshot?.reason).toBe('gemdoc-open-guard-cancelled')
      expect(getEditDoc()!.gems).toHaveLength(4)
    } finally {
      cleanup()
    }
  })
})

// 「已保存（干净）时再次送精修直通无确认」（StudioStatusBar 口径接缝端到端）
describe('覆盖确认口径接缝（dirty 替换 hasEdits）', () => {
  it('干净文档：送精修直通（无确认弹窗）；未保存文档：弹覆盖确认', async () => {
    // 送精修按钮需要排钻设计有结果（fixture 同 lifecycle 管线）
    loadFromEngineImage(fixtureShapes(), '口径.png', 'handoff')
    await waitForStudioIdle()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const bar = mount(StudioStatusBar, { target })
    const sendButton = (): HTMLButtonElement | null =>
      target.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')
    try {
      // 干净态（gemdoc 打开后未修改）
      loadFromHandoff(makeHandoff(3))
      const saved = await saveGemdoc({ name: '直通' })
      await closeEditDocument()
      await loadFromGemdoc(saved.docId)
      expect(isEditDirty()).toBe(false)

      sendButton()!.click()
      await settle(80)
      expect(document.body.textContent ?? '').not.toContain('覆盖当前精修内容')
      expect(getView()).toBe('edit')
      expect(getEditDoc()).not.toBeNull()

      // 未保存（送精修即 dirty）→ 再次送精修：覆盖确认弹窗，取消保持文档
      setView('studio')
      await tick()
      sendButton()!.click()
      await settle(80)
      expect(getView()).toBe('studio') // 确认前不切视图
      expect(document.body.textContent ?? '').toContain('覆盖当前精修内容')
      document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit-cancel"]')!.click()
      await settle()
      expect(document.body.textContent ?? '').not.toContain('覆盖当前精修内容')
      expect(isEditDirty()).toBe(true) // 取消保持文档
    } finally {
      unmount(bar)
      target.remove()
    }
  })
})
