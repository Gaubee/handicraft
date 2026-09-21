/*
 * [2026-09-21 rework-designer-manual-rhinestone 走查3 P1-1 Test] PNG 离屏渲染器
 * （lib/designer/pngRender）：jsdom 无真光栅——经依赖注入面（离屏画布工厂/参考图
 * resolver/toBlob/sprite 请求面）断言：underlay 三源绘制顺序与源级透明度（DesignerCanvas
 * 同口径）、隐藏层剔除（渲染器层分组口径）、sprite miss 几何回退（normal 投影常量 +
 * gemVisual 剪影）、sprite 帧命中绘制（含旋转）、层透明度；末段端到端经
 * editDocumentService.exportPng（真 gate → 可见层投影 → 渲染器 → mock canvas toBlob）。
 * 真帧视觉归走查门（设计明示 jsdom 不可测真光栅）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SvelteSet } from 'svelte/reactivity'
import { toEditGem } from '$lib/engine'
import { renderEditDocumentPng, setPngRenderDepsForTests, type PngReferenceImage } from '$lib/designer/pngRender'
import type { GemSpriteFrame, GemSpriteRequest } from '$lib/designer/gemSprites'
import type { DesignerGem, EditDocument } from '$lib/stores/edit.svelte'
import { editDocumentService } from '$lib/services/documentService'
import {
  addGemLayer,
  applyPatch,
  getEditDoc,
  loadFromHandoff,
  resetEditForTests,
  setGemLayerVisible,
} from '$lib/stores/edit.svelte'
import { makeHandoff, fullBlock } from '../edit/helpers'

// jsdom 缺 ImageData 构造器（gemSprites.test.ts 同式最小 polyfill——结构满足即真实语义不变）
class ImageDataStub {
  constructor(
    public readonly data: Uint8ClampedArray,
    public readonly width: number,
    public readonly height: number,
  ) {}
}
if (typeof globalThis.ImageData === 'undefined') {
  ;(globalThis as { ImageData?: unknown }).ImageData = ImageDataStub
}

// ---------------------------------------------------------------------------
// 录制 ctx（canvas 2d 替身——渲染 op 序列断言面）
// ---------------------------------------------------------------------------

interface RecordedCall {
  op: string
  source?: unknown
  args: unknown[]
}

class RecordingCtx {
  #globalAlpha = 1
  #fillStyle = ''
  #strokeStyle = ''
  #shadowColor = 'transparent'
  #shadowBlur = 0
  #shadowOffsetY = 0
  #lineWidth = 1
  readonly calls: RecordedCall[] = []
  readonly styleLog: Array<{ prop: string; value: unknown }> = []
  constructor(readonly canvas: HTMLCanvasElement) {}
  get globalAlpha(): number {
    return this.#globalAlpha
  }
  set globalAlpha(v: number) {
    this.#globalAlpha = v
    this.styleLog.push({ prop: 'globalAlpha', value: v })
  }
  get fillStyle(): string {
    return this.#fillStyle
  }
  set fillStyle(v: string) {
    this.#fillStyle = v
    this.styleLog.push({ prop: 'fillStyle', value: v })
  }
  get strokeStyle(): string {
    return this.#strokeStyle
  }
  set strokeStyle(v: string) {
    this.#strokeStyle = v
    this.styleLog.push({ prop: 'strokeStyle', value: v })
  }
  get shadowColor(): string {
    return this.#shadowColor
  }
  set shadowColor(v: string) {
    this.#shadowColor = v
    this.styleLog.push({ prop: 'shadowColor', value: v })
  }
  get shadowBlur(): number {
    return this.#shadowBlur
  }
  set shadowBlur(v: number) {
    this.#shadowBlur = v
    this.styleLog.push({ prop: 'shadowBlur', value: v })
  }
  get shadowOffsetY(): number {
    return this.#shadowOffsetY
  }
  set shadowOffsetY(v: number) {
    this.#shadowOffsetY = v
    this.styleLog.push({ prop: 'shadowOffsetY', value: v })
  }
  get lineWidth(): number {
    return this.#lineWidth
  }
  set lineWidth(v: number) {
    this.#lineWidth = v
    this.styleLog.push({ prop: 'lineWidth', value: v })
  }
  drawImage(source: unknown, ...args: unknown[]): void {
    this.calls.push({ op: 'drawImage', source, args })
  }
  putImageData(...args: unknown[]): void {
    this.calls.push({ op: 'putImageData', args })
  }
  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  }
  save(): void {
    this.calls.push({ op: 'save', args: [] })
  }
  restore(): void {
    this.calls.push({ op: 'restore', args: [] })
  }
  translate(...args: unknown[]): void {
    this.calls.push({ op: 'translate', args })
  }
  rotate(...args: unknown[]): void {
    this.calls.push({ op: 'rotate', args })
  }
  beginPath(): void {
    this.calls.push({ op: 'beginPath', args: [] })
  }
  closePath(): void {
    this.calls.push({ op: 'closePath', args: [] })
  }
  arc(...args: unknown[]): void {
    this.calls.push({ op: 'arc', args })
  }
  moveTo(...args: unknown[]): void {
    this.calls.push({ op: 'moveTo', args })
  }
  lineTo(...args: unknown[]): void {
    this.calls.push({ op: 'lineTo', args })
  }
  bezierCurveTo(...args: unknown[]): void {
    this.calls.push({ op: 'bezierCurveTo', args })
  }
  fill(): void {
    this.calls.push({ op: 'fill', args: [] })
  }
  stroke(): void {
    this.calls.push({ op: 'stroke', args: [] })
  }
  opCalls(op: string): RecordedCall[] {
    return this.calls.filter((c) => c.op === op)
  }
  drawImageCalls(): RecordedCall[] {
    return this.opCalls('drawImage')
  }
}

// ---------------------------------------------------------------------------
// 替身依赖工厂 + 文档 fixture
// ---------------------------------------------------------------------------

interface RenderDepsDouble {
  ctxs: () => RecordingCtx[]
  resolveReference: ReturnType<typeof vi.fn>
  canvasToBlob: ReturnType<typeof vi.fn>
  requestSprite: ReturnType<typeof vi.fn>
  reference: PngReferenceImage
  released: () => number
}

function makeRenderDeps(options: { frame?: GemSpriteFrame } = {}): RenderDepsDouble {
  const ctxs: RecordingCtx[] = []
  let released = 0
  const reference: PngReferenceImage = {
    image: { toString: () => 'ref-bitmap' } as unknown as CanvasImageSource,
    width: 10,
    height: 10,
    release: () => {
      released += 1
    },
  }
  const resolveReference = vi.fn(async () => reference)
  const canvasToBlob = vi.fn(
    async (canvas: HTMLCanvasElement) => new Blob([`png:${canvas.width}x${canvas.height}`], { type: 'image/png' }),
  )
  const requestSprite = vi.fn((request: GemSpriteRequest) => options.frame ?? null)
  setPngRenderDepsForTests({
    createCanvas: () => {
      const canvas = document.createElement('canvas')
      const ctx = new RecordingCtx(canvas)
      ctxs.push(ctx)
      return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D }
    },
    resolveReference,
    canvasToBlob,
    requestSprite,
    onSpritesChanged: () => () => {},
    spriteAwaitDeadlineMs: 0, // 单波次即回退（miss 路径零等待——限期语义见 PNG_SPRITE_AWAIT_MS）
  })
  return { ctxs: () => ctxs, resolveReference, canvasToBlob, requestSprite, reference, released: () => released }
}

/** 渲染文档 fixture（4 颗 L1 round 钻 + 三源全可见 + reference 资产引用）。 */
function renderDoc(overrides: Partial<EditDocument> = {}): EditDocument {
  const handoff = makeHandoff(4)
  return {
    gems: handoff.gems.map((g) => ({ ...toEditGem(g), layerId: 'L1' })),
    blocks: handoff.blocks,
    palette: handoff.palette,
    grid: handoff.grid,
    width: handoff.width,
    height: handoff.height,
    layers: [{ id: 'L1', name: '图层 1', visible: true, locked: false }],
    underlay: {
      sources: [
        { key: 'painting', visible: true, opacity: 1 },
        { key: 'reference', visible: true, opacity: 0.8 },
        { key: 'blocks', visible: true, opacity: 0.9 },
      ],
    },
    selection: new SvelteSet<string>(),
    paintingSnapshot: handoff.paintingSnapshot,
    physicalCanvas: {
      widthMm: handoff.width / handoff.grid.pixelsPerMm,
      heightMm: handoff.height / handoff.grid.pixelsPerMm,
      anchorSource: 'default',
    },
    referenceAssetId: 'ast-ref',
    sourceSummary: handoff.sourceSummary,
    docId: null,
    name: '渲染测试',
    createdAt: 0,
    savedAt: null,
    provenance: { origin: 'studio-bake' },
    ...overrides,
  }
}

function fakeFrame(size = 12): GemSpriteFrame {
  const canvas = document.createElement('canvas')
  return { canvas, size, contentW: 8, contentH: 8, pad: 2, key: 'fake' }
}

function manualGem(id: string, x: number, layerId: string, extra: Partial<DesignerGem> = {}): DesignerGem {
  return {
    id,
    x,
    y: 32,
    colorId: 'red',
    blockId: null,
    origin: 'manual',
    moved: false,
    shapeId: 'round',
    diameterMm: 2.8,
    layerId,
    ...extra,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetEditForTests()
})

afterEach(() => {
  setPngRenderDepsForTests(null)
})

// ---------------------------------------------------------------------------

describe('underlay 三源合成（DesignerCanvas 同口径）', () => {
  it('绘制顺序 painting → reference → blocks；源级透明度；reference 用后即还', async () => {
    const made = makeRenderDeps({ frame: fakeFrame() })
    const blob = await renderEditDocumentPng(renderDoc())
    expect(await blob.text()).toBe('png:64x64')

    const main = made.ctxs()[0]!
    const paintLayer = made.ctxs()[1]!
    const linesLayer = made.ctxs()[2]!
    const sources = main.drawImageCalls().map((c) => c.source)
    expect(sources[0]).toBe(paintLayer.canvas) // 源 1 painting 先行
    expect(sources[1]).toBe(made.reference.image) // 源 2 reference 位次
    expect(sources[2]).toBe(linesLayer.canvas) // 源 3 blocks 收尾

    // 源级透明度（painting 1 / reference 0.8 / blocks 0.9——写序随绘制序，各还 1）
    const alphas = main.styleLog.filter((s) => s.prop === 'globalAlpha').map((s) => s.value)
    expect(alphas.slice(0, 6)).toEqual([1, 1, 0.8, 1, 0.9, 1])

    // painting 快照原样落离屏（solidImage 红 200,16,46,255）
    const put = paintLayer.opCalls('putImageData')[0]!
    const img = put.args[0] as { data: Uint8ClampedArray }
    expect([img.data[0], img.data[1], img.data[2], img.data[3]]).toEqual([200, 16, 46, 255])

    // blocks 边界描线：满幅块 → 周界像素 alpha 210、内部 0
    const linesPut = linesLayer.opCalls('putImageData')[0]!
    const linesImg = linesPut.args[0] as { data: Uint8ClampedArray }
    expect(linesImg.data[3]).toBe(210) // (0,0) 边界
    expect(linesImg.data[(32 * 64 + 32) * 4 + 3]).toBe(0) // 内部非边界

    // reference 解析一次 + 绘后 release（共享 objectURL 引用计数还账）
    expect(made.resolveReference).toHaveBeenCalledTimes(1)
    expect(made.resolveReference).toHaveBeenCalledWith('ast-ref')
    expect(made.released()).toBe(1)

    // toBlob 走主画布（W×H 文档像素空间）
    expect(made.canvasToBlob).toHaveBeenCalledTimes(1)
    expect(made.canvasToBlob.mock.calls[0]![0]).toBe(main.canvas)
  })

  it('源隐藏/缺席：reference 隐藏不解析；painting 快照尺寸失配透明兜底；源记录缺席跳过', async () => {
    const made = makeRenderDeps() // 无帧（miss 回退）——位图 drawImage 只剩 underlay 源
    await renderEditDocumentPng(
      renderDoc({
        paintingSnapshot: { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(255) },
        underlay: {
          sources: [
            { key: 'painting', visible: true, opacity: 1 },
            { key: 'reference', visible: false, opacity: 0.8 },
          ], // blocks 源记录缺席 → 跳过
        },
      }),
    )
    expect(made.resolveReference).not.toHaveBeenCalled() // 隐藏不解析
    const paintLayer = made.ctxs()[1]!
    const put = paintLayer.opCalls('putImageData')[0]!
    const img = put.args[0] as { data: Uint8ClampedArray; width: number }
    expect(img.width).toBe(64) // 失配快照不进产物——画幅尺寸透明兜底
    expect(img.data.every((b) => b === 0)).toBe(true)
    const main = made.ctxs()[0]!
    expect(main.drawImageCalls()).toHaveLength(1) // 仅 painting（reference 隐藏 + blocks 缺席）
  })
})

describe('钻石层（sprite 帧 / 几何回退 / 层口径）', () => {
  it('帧命中：normal 态请求（dpr=1）+ 帧中心对齐绘制 + 旋转围钻心', async () => {
    const frame = fakeFrame(12)
    const made = makeRenderDeps({ frame })
    const doc = renderDoc()
    doc.gems[0] = { ...doc.gems[0]!, rotationDeg: 30 }
    await renderEditDocumentPng(doc)

    // 请求面：normal 态 + dpr 1（文档像素空间——导出无选中/悬停反馈）
    for (const call of made.requestSprite.mock.calls) {
      const request = call[0] as GemSpriteRequest
      expect(request.state).toBe('normal')
      expect(request.dpr).toBe(1)
    }
    expect(made.requestSprite).toHaveBeenCalled()

    const main = made.ctxs()[0]!
    const gemDraws = main.drawImageCalls().filter((c) => c.source === frame.canvas)
    expect(gemDraws).toHaveLength(4)
    // 旋转钻（g0 rotationDeg=30）：save → translate(x,y) → rotate(π/6) → drawImage(-6,-6,12,12) → restore
    const saveIdx = main.calls.findIndex((c) => c.op === 'save')
    const translateIdx = main.calls.findIndex((c) => c.op === 'translate')
    const rotateIdx = main.calls.findIndex((c) => c.op === 'rotate')
    expect(translateIdx).toBeGreaterThan(saveIdx)
    expect(rotateIdx).toBeGreaterThan(translateIdx)
    expect((main.calls[rotateIdx]!.args as number[])[0]).toBeCloseTo((30 * Math.PI) / 180, 10)
    expect(main.drawImageCalls().some((c) => c.source === frame.canvas && (c.args as number[])[0] === -6)).toBe(true)
    // 非旋转钻：直接位（x - size/2, y - size/2, size, size）
    const g1 = doc.gems[1]!
    expect(
      main.drawImageCalls().some(
        (c) => c.source === frame.canvas && (c.args as number[])[0] === g1.x - 6 && (c.args as number[])[1] === g1.y - 6,
      ),
    ).toBe(true)
  })

  it('sprite miss 回退：几何符号（normal 投影常量 + 描边）——不阻断导出', async () => {
    const made = makeRenderDeps() // requestSprite 恒 null（deadline 0 单波次）
    await renderEditDocumentPng(renderDoc())
    const main = made.ctxs()[0]!
    const paintLayer = made.ctxs()[1]!
    const linesLayer = made.ctxs()[2]!
    // 4 颗 round 钻 → 4 次 arc 回退；无帧 drawImage（主画布位图源只有三源离屏层与 reference）
    expect(main.opCalls('arc')).toHaveLength(4)
    expect(main.drawImageCalls().every((c) => c.source === paintLayer.canvas || c.source === made.reference.image || c.source === linesLayer.canvas)).toBe(true)
    // normal 柔投影常量（GEM_SPRITE_STYLE 单源——与画布帧 miss 期同视觉语言）
    expect(main.styleLog).toContainEqual({ prop: 'shadowColor', value: 'rgba(0,0,0,0.35)' })
    expect(main.styleLog).toContainEqual({ prop: 'strokeStyle', value: 'rgba(0,0,0,0.28)' })
    expect(main.opCalls('fill')).toHaveLength(4)
    expect(main.opCalls('stroke')).toHaveLength(4)
  })

  it('异形剪影回退：marquise 按 2.5/5 纵横比落盒 + 旋转', async () => {
    const made = makeRenderDeps()
    const doc = renderDoc({
      gems: [manualGem('m-1', 32, 'L1', { shapeId: 'marquise', diameterMm: 5, rotationDeg: 30 })],
    })
    await renderEditDocumentPng(doc)
    const main = made.ctxs()[0]!
    expect(main.opCalls('bezierCurveTo').length).toBeGreaterThanOrEqual(4) // 马眼四段 bezier
    expect(main.opCalls('rotate')).toHaveLength(1)
    expect(main.opCalls('arc')).toHaveLength(0) // 异形不走圆快路径
  })

  it('隐藏层剔除（渲染器层分组口径）+ 层透明度消费', async () => {
    const made = makeRenderDeps()
    const base = renderDoc()
    const doc = renderDoc({
      layers: [
        { id: 'L1', name: '底', visible: true, locked: false, opacity: 0.5 },
        { id: 'L2', name: '隐藏层', visible: false, locked: false },
      ],
      gems: [...base.gems, manualGem('m-h1', 20, 'L2'), manualGem('m-h2', 24, 'L2')],
    })
    await renderEditDocumentPng(doc)
    const main = made.ctxs()[0]!
    expect(main.opCalls('arc')).toHaveLength(4) // 仅 L1 四钻——L2 隐藏不入图（投影在 service，此处层分组防御同构）
    expect(main.styleLog).toContainEqual({ prop: 'globalAlpha', value: 0.5 })
    const alphaLog = main.styleLog.filter((s) => s.prop === 'globalAlpha').map((s) => s.value)
    expect(alphaLog[alphaLog.length - 1]).toBe(1) // 收尾复位
  })
})

describe('失败面（typed Error，不产半成品）', () => {
  it('画幅无效 / 2D 上下文不可用', async () => {
    await expect(renderEditDocumentPng(renderDoc({ width: 0 }))).rejects.toThrow('画幅尺寸无效')
    setPngRenderDepsForTests({ createCanvas: () => null })
    await expect(renderEditDocumentPng(renderDoc())).rejects.toThrow('2D 上下文')
  })
})

describe('端到端：editDocumentService.exportPng（gate → 可见层投影 → 渲染器 → mock toBlob）', () => {
  it('默认实例产物 = 渲染器 blob；隐藏层钻不入图；文件名 .png', async () => {
    const made = makeRenderDeps()
    // 画幅 96（hexGems(12) 单行 x=4..92 全入块掩码——gate mask 面与 documentService.test 同式）
    loadFromHandoff(makeHandoff(12, { blocks: [fullBlock(96, 64)], width: 96 }))
    addGemLayer('隐藏层')
    applyPatch({ op: 'add', gems: [manualGem('m-h1', 20, 'L2'), manualGem('m-h2', 24, 'L2')] })
    setGemLayerVisible('L2', false)
    expect(getEditDoc()!.gems).toHaveLength(14)

    const result = await editDocumentService.exportPng()
    expect(result.status).toBe('exported')
    if (result.status !== 'exported') throw new Error('expected exported')
    expect(result.filename.endsWith('.png')).toBe(true)
    expect(await result.blob.text()).toBe('png:96x64')
    const main = made.ctxs()[0]!
    expect(main.opCalls('arc')).toHaveLength(12) // 可见 12 钻回退绘制；隐藏 2 颗不进渲染
  })
})
