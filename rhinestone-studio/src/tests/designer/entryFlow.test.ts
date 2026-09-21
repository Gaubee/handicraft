/*
 * [2026-09-21 redesign-designer-workbench 5.1 Test] 空态入口（design §5.1；R5.2 走查 P2-7
 * 口径修正为四入口：选图新建/空白新建/打开/上传图片新建）：
 * - 选图新建（主）：参考底图 + **0 颗钻**（绝不动算法——纠偏 add-project-files 3.3 的
 *   scenario 断言）+ default 画幅锚（px ÷ 2.5，anchorSource 显式）+ underlay 仅 reference 源。
 * - 空白新建：缺省画幅 200×200mm（占位缺省，可改）+ 无 underlay 源 + 0 颗钻。
 * - 上传路径：先入库 sys-uploads 再同一构造链（ingest 失败显式报错）。
 * - UI 面：四入口齐备；旧「选图即排稿」话术退役（自动排稿文案不出现）；
 *   主入口点击链（assetPicker → getHandoffImageBlob → 0 钻文档）。
 *
 * 环境声明：entry 解码链只测 Image natural 尺寸（无 canvas 2d）——本文件 stub Image
 * 返回固定尺寸；assetPicker/handoffImage/ingestAsset 经 vi.mock 注入替身（不开 IDB）。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  BLANK_CANVAS_MM,
  UNTITLED_DOC_NAME,
  createBlankDocument,
  createDocumentFromImage,
  createDocumentFromUpload,
} from '$lib/designer/entry'
import { getEditDoc, isEditDirty, resetEditForTests } from '$lib/stores/edit.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

// ---------------------------------------------------------------------------
// Image 替身：任意 dataUrl → 固定 natural 尺寸（entry 解码链只需尺寸，无像素消费）
// ---------------------------------------------------------------------------

let stubNatural = { width: 500, height: 300 }

class StubImage {
  naturalWidth = 0
  naturalHeight = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    const dims = stubNatural
    queueMicrotask(() => {
      this.naturalWidth = dims.width
      this.naturalHeight = dims.height
      this.onload?.()
    })
  }
}
vi.stubGlobal('Image', StubImage)

function setStubImageSize(width: number, height: number): void {
  stubNatural = { width, height }
}

// ---------------------------------------------------------------------------
// 依赖替身：assetPicker / getHandoffImageBlob / ingestAsset（mock 工厂经 hoisted 变量
// 与测试体共享同一 mock 实例；factory 内不引用模块级 const——vi.mock 提升早于模块体）
// ---------------------------------------------------------------------------

const { ingestAssetMock, handoffBlobMock } = vi.hoisted(() => ({
  ingestAssetMock: vi.fn(
    async (_options: {
      blob: Blob
      name: string
      width: number
      height: number
      parentId: string | null
      source: string
    }) => ({ node: { id: 'ast-up', name: '上传.png' }, status: 'created' as const }),
  ),
  handoffBlobMock: vi.fn(async () => new Blob([new Uint8Array([9, 9])], { type: 'image/png' })),
}))

vi.mock('$lib/assets/controller.svelte', () => ({
  assetPicker: {
    open: vi.fn(async () => [{ id: 'ast-pick', name: '选图.png' }]),
    openForProjects: vi.fn(async () => null),
  },
}))

vi.mock('$lib/persistence/handoffImage', () => ({
  getHandoffImageBlob: handoffBlobMock,
}))

vi.mock('$lib/persistence/assetStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/persistence/assetStore')>()
  return { ...actual, ingestAsset: ingestAssetMock }
})

// ---------------------------------------------------------------------------

function mountView(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * [6/7 批加固] 选图新建链有界轮询等待（断言不变，只换等待方式）：assetPicker →
 * blob 读取 → FileReader dataUrl → Image onload → 文档装载是长异步链——固定 20ms
 * settle 在并行测试负载下偶发未完成（getEditDoc 仍 null）。轮询至文档就位或 3s 截止。
 */
async function waitForDocument(): Promise<void> {
  const deadline = Date.now() + 3000
  while (getEditDoc() === null && Date.now() < deadline) {
    await settle(20)
  }
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  setStubImageSize(500, 300)
  ingestAssetMock.mockReset()
  ingestAssetMock.mockImplementation(
    async () => ({ node: { id: 'ast-up', name: '上传.png' }, status: 'created' as const }),
  )
  handoffBlobMock.mockReset()
  handoffBlobMock.mockImplementation(async () => new Blob([new Uint8Array([9, 9])], { type: 'image/png' }))
})

afterEach(() => {
  vi.stubGlobal('Image', StubImage)
})

/** 直连 API 测试用 blob（不经过 handoffImage 替身）。 */
const testBlob = new Blob([new Uint8Array([7])], { type: 'image/png' })

// ---------------------------------------------------------------------------

describe('选图新建（design §5.1 主入口）：参考底图 + 0 颗钻', () => {
  it('选图后钻数 = 0（绝不动算法）+ underlay 仅 reference 源 + default 画幅锚 + 未保存新文档', async () => {
    await createDocumentFromImage({ assetId: 'ast-1', blob: testBlob, name: '蝴蝶.png' })
    const doc = getEditDoc()
    expect(doc).not.toBeNull()
    // 纠偏 scenario 的硬断言：绝不自动生成钻
    expect(doc!.gems).toHaveLength(0)
    expect(doc!.blocks).toHaveLength(0)
    // §4.2 空白起步：underlay 只增 reference 源（visible/1.0），painting/blocks 无源
    expect(doc!.underlay.sources).toEqual([{ key: 'reference', visible: true, opacity: 1 }])
    expect(doc!.referenceAssetId).toBe('ast-1')
    expect(doc!.layers.map((l) => l.id)).toEqual(['L1'])
    // §5.2 画幅 default 锚：px ÷ 2.5 px/mm，anchorSource 显式
    expect(doc!.physicalCanvas).toEqual({ widthMm: 200, heightMm: 120, anchorSource: 'default' })
    expect(doc!.width).toBe(500)
    expect(doc!.height).toBe(300)
    expect(doc!.grid.pixelsPerMm).toBe(2.5)
    // 身份面：未保存新文档（dirty）+ 缺省名 + origin=blank + 溯源带 sourceAssetId
    expect(isEditDirty()).toBe(true)
    expect(doc!.docId).toBeNull()
    expect(doc!.name).toBe(UNTITLED_DOC_NAME)
    expect(doc!.provenance.origin).toBe('blank')
    expect(doc!.provenance.sourceAssetId).toBe('ast-1')
  })

  it('大图降采样 ≤1024 长边（与 quickLayout MAX_IMAGE_DIM 同式）——锚定降采样后像素', async () => {
    setStubImageSize(3000, 1000)
    await createDocumentFromImage({ assetId: 'ast-big', blob: testBlob, name: '大图.png' })
    const doc = getEditDoc()!
    expect(doc.width).toBe(1024)
    expect(doc.height).toBe(341) // round(1000 × 1024/3000)
    expect(doc.physicalCanvas).toEqual({ widthMm: 409.6, heightMm: 136.4, anchorSource: 'default' })
    expect(doc.gems).toHaveLength(0)
  })

  it('坏图（解码失败）显式报错，不产生半装配文档', async () => {
    class BrokenImage {
      naturalWidth = 0
      naturalHeight = 0
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('Image', BrokenImage)
    await expect(
      createDocumentFromImage({ assetId: 'ast-bad', blob: testBlob, name: '坏图.png' }),
    ).rejects.toThrowError(/解码失败/)
    expect(getEditDoc()).toBeNull()
  })
})

describe('空白新建（design §5.1 次入口）：缺省 200×200mm 占位画幅', () => {
  it('0 颗钻 + 无任何 underlay 源 + default 锚 200×200 + 500px @2.5px/mm + 未保存', () => {
    createBlankDocument()
    const doc = getEditDoc()
    expect(doc).not.toBeNull()
    expect(doc!.gems).toHaveLength(0)
    expect(doc!.underlay.sources).toEqual([]) // 无参考图：painting/blocks/reference 全无源
    expect(doc!.referenceAssetId).toBeNull()
    expect(doc!.physicalCanvas).toEqual({
      widthMm: BLANK_CANVAS_MM,
      heightMm: BLANK_CANVAS_MM,
      anchorSource: 'default',
    })
    expect(doc!.width).toBe(500)
    expect(doc!.height).toBe(500)
    expect(isEditDirty()).toBe(true)
    expect(doc!.name).toBe(UNTITLED_DOC_NAME)
    expect(doc!.provenance.origin).toBe('blank')
  })

  it('画笔可在空白文档直接落钻（0 起步可用性：参考网格/色板就位）', () => {
    createBlankDocument()
    const doc = getEditDoc()!
    expect(doc.grid.pitchMm).toBeGreaterThan(0)
    expect(doc.palette.length).toBeGreaterThan(0)
  })
})

describe('上传路径：先入库 sys-uploads 再同一构造链', () => {
  it('上传 → ingestAsset(parentId=sys-uploads) → 以资产引用作参考底图（0 颗钻）', async () => {
    const file = new File([new Uint8Array([1, 2])], '上传.png', { type: 'image/png' })
    await createDocumentFromUpload(file)
    expect(ingestAssetMock).toHaveBeenCalledTimes(1)
    const options = ingestAssetMock.mock.calls[0][0]
    expect(options.parentId).toBe('sys-uploads')
    expect(options.source).toBe('upload')
    expect(options.width).toBe(500)
    expect(options.height).toBe(300)
    const doc = getEditDoc()!
    expect(doc.gems).toHaveLength(0)
    expect(doc.referenceAssetId).toBe('ast-up')
    expect(doc.underlay.sources).toEqual([{ key: 'reference', visible: true, opacity: 1 }])
  })

  it('入库失败显式报错（不静默降级为无参考文档）', async () => {
    ingestAssetMock.mockRejectedValueOnce(new Error('IDB 不可用'))
    const file = new File([new Uint8Array([1])], '失败.png', { type: 'image/png' })
    await expect(createDocumentFromUpload(file)).rejects.toThrowError(/IDB/)
    expect(getEditDoc()).toBeNull()
  })
})

describe('空态 UI（design §5.1 四入口 + 旧入口退役）', () => {
  it('四入口齐备（选图/空白/打开/上传——P2-7 口径修正）；空白新建标注缺省画幅可改；旧「自动排稿」话术退役', async () => {
    const view = mountView()
    await tick()
    const empty = view.target.querySelector('[data-testid="designer-empty"]')
    expect(empty).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-empty-pick-image"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-empty-new-blank"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-empty-open-project"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-empty-upload"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-empty-guide"]')?.textContent).toContain('想先调密度与策略')

    const blank = view.target.querySelector<HTMLButtonElement>('[data-testid="designer-empty-new-blank"]')!
    expect(blank.title).toContain('200×200mm')
    expect(blank.title).toContain('可改')

    // 旧入口退役：空态不再出现「选图即排稿」承诺（design §5.1：选图 ≠ 排稿）
    const text = empty?.textContent ?? ''
    expect(text).not.toContain('自动智能排布')
    expect(text).not.toContain('自动排稿')
    expect(text).not.toContain('自动按默认参数')

    view.unmount()
  })

  it('主入口点击链：素材库选图 → 0 颗钻参考底图文档就位', async () => {
    const view = mountView()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-empty-pick-image"]')!.click()
    await tick()
    await waitForDocument()
    const doc = getEditDoc()
    expect(doc).not.toBeNull()
    expect(doc!.gems).toHaveLength(0)
    expect(doc!.referenceAssetId).toBe('ast-pick')
    expect(doc!.physicalCanvas.anchorSource).toBe('default')
    // 失败路径零 toast（成功链不应报错）
    expect(getToasts()).toHaveLength(0)
    view.unmount()
  })

  it('空白新建点击 → 200×200mm 空文档就位（未保存徽标可期：dirty）', async () => {
    const view = mountView()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-empty-new-blank"]')!.click()
    await tick()
    const doc = getEditDoc()
    expect(doc).not.toBeNull()
    expect(doc!.gems).toHaveLength(0)
    expect(doc!.physicalCanvas).toEqual({ widthMm: 200, heightMm: 200, anchorSource: 'default' })
    expect(isEditDirty()).toBe(true)
    view.unmount()
  })
})
