/*
[2026-09-19 Test / redesign-studio-layout 任务 0.1] drawPreview 预览纯函数基准：
1. Golden：旧 CompareGrid.renderPreview 管线（重构前 51a116c L71-175 的逐语句本地复刻）与 drawPreview
   在同一确定性软栅格器上逐字节一致（旧管线可脱离组件实例化 → 走 golden 强对照，无需哈希快照兜底）。
2. 自稳定：同输入两次绘制 / 同画布重绘逐字节一致（clearRect 全清不残留）。
3. 防黑图：三模式 × 有/无参考图 × 方形/非方形 × dpr 1/2/1.25 全矩阵非透明像素比例过阈；
   几何探针独立锚定语义（钻心像素 = 色板色；叠稿像素 = 0.5 alpha 期望混合值）。

环境声明：jsdom 的 canvas.getContext('2d') 为 null（未装 canvas npm 包）→ 本文件自带 Stub2D
确定性软栅格器（仅实现 drawPreview/gemPaint 触达的原语子集，轴对齐缩放假设）。对
CanvasRenderingContext2D 的 as unknown as 断言是测试专用结构子集的逃生舱，全程零 any。
*/

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { STARTER_PALETTE, layout, mapColors, segment, type Block, type EngineImage, type GridSpec, type Palette } from '$lib/engine'
import { paintGems, paintingImageData } from '../../components/Studio/gemPaint'
import { drawPreview, type PreviewRenderInput } from '$lib/studio/previewRender'
import type { PreviewMode, StrategyResult } from '$lib/stores/studio.svelte'
import { SEG_OPTS, fixtureShapes, fixtureSolid, standardGrid } from '../engine/helpers'

// ---------------------------------------------------------------------------
// 确定性软栅格器：StubCanvas / Stub2D（jsdom 无 canvas 实现，drawPreview 触达原语的最小闭环）
// ---------------------------------------------------------------------------

// 本 jsdom 版本同样缺 ImageData 构造器（gemPaint.paintingImageData 触达）→ 最小 polyfill：
// putImageData 只读 width/height/data，结构满足即真实语义不变。
class ImageDataStub {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.width = width
    this.height = height
    this.data = data
  }
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = ImageDataStub as unknown as typeof ImageData
}

/** 软栅格器可采样的像素面协议（StubCanvas / FakeReferenceBitmap 共用） */
interface StubPixels {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

interface StubImageSource {
  readonly __stubPixels: StubPixels
}

function isStubSource(src: unknown): src is StubImageSource {
  return typeof src === 'object' && src !== null && '__stubPixels' in src
}

function parseColor(v: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) {
    return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
  }
  const rgb = /^rgb\((\d+)[,\s]+(\d+)[,\s]+(\d+)\)$/.exec(v.replace(/\s+/g, ' ').trim())
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  throw new Error(`Stub2D: 无法解析颜色 "${v}"`)
}

/** source-over（直 alpha）：两路径共用 → golden 与 drawPreview 的舍入完全一致 */
function compositeOver(
  buf: Uint8ClampedArray,
  i: number,
  sr: number,
  sg: number,
  sb: number,
  srcAlpha: number,
  alphaMul: number,
): void {
  const a = srcAlpha * alphaMul
  const dstA = buf[i + 3] / 255
  const outA = a + dstA * (1 - a)
  if (outA <= 0) {
    buf[i] = 0
    buf[i + 1] = 0
    buf[i + 2] = 0
    buf[i + 3] = 0
    return
  }
  const r = (sr / 255) * a + (buf[i] / 255) * dstA * (1 - a)
  const g = (sg / 255) * a + (buf[i + 1] / 255) * dstA * (1 - a)
  const b = (sb / 255) * a + (buf[i + 2] / 255) * dstA * (1 - a)
  buf[i] = Math.round((r / outA) * 255)
  buf[i + 1] = Math.round((g / outA) * 255)
  buf[i + 2] = Math.round((b / outA) * 255)
  buf[i + 3] = Math.round(outA * 255)
}

class Stub2D {
  readonly canvas: StubCanvas
  globalAlpha = 1
  #fill: [number, number, number] = [0, 0, 0]
  #transform = [1, 0, 0, 1, 0, 0]
  #circles: Array<[number, number, number]> = []

  constructor(canvas: StubCanvas) {
    this.canvas = canvas
  }

  set fillStyle(v: string) {
    this.#fill = parseColor(v)
  }

  get fillStyle(): string {
    const [r, g, b] = this.#fill
    return `rgb(${r} ${g} ${b})`
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (b !== 0 || c !== 0) throw new Error('Stub2D 仅支持轴对齐缩放变换（drawPreview/paintGems 契约）')
    this.#transform = [a, b, c, d, e, f]
  }

  /** 设备像素中心 (X+0.5, Y+0.5) 落入设备空间矩形 [x0,x1)×[y0,y1) 内的像素回调 */
  #forEachPixel(x0: number, y0: number, x1: number, y1: number, cb: (i: number, X: number, Y: number) => void): void {
    const w = this.canvas.width
    const h = this.canvas.height
    const xs = Math.max(0, Math.ceil(x0 - 0.5))
    const xe = Math.min(w - 1, Math.ceil(x1 - 0.5) - 1)
    const ys = Math.max(0, Math.ceil(y0 - 0.5))
    const ye = Math.min(h - 1, Math.ceil(y1 - 0.5) - 1)
    for (let Y = ys; Y <= ye; Y++) {
      for (let X = xs; X <= xe; X++) {
        cb((Y * w + X) * 4, X, Y)
      }
    }
  }

  /** 当前设备像素缓冲（背板 resize 会换实例 → 每次取现值） */
  #buf(): Uint8ClampedArray {
    return this.canvas.__stubPixels.data
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const [a, , , d, e, f] = this.#transform
    this.#forEachPixel(a * x + e, d * y + f, a * (x + w) + e, d * (y + h) + f, (i) => {
      const buf = this.#buf()
      buf[i] = 0
      buf[i + 1] = 0
      buf[i + 2] = 0
      buf[i + 3] = 0
    })
  }

  putImageData(img: ImageData, dx = 0, dy = 0): void {
    const buf = this.#buf()
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4
        const di = ((y + dy) * this.canvas.width + x + dx) * 4
        buf[di] = img.data[si]
        buf[di + 1] = img.data[si + 1]
        buf[di + 2] = img.data[si + 2]
        buf[di + 3] = img.data[si + 3]
      }
    }
  }

  drawImage(src: CanvasImageSource | StubImageSource, dx: number, dy: number, dw: number, dh: number): void {
    if (!isStubSource(src)) throw new Error('Stub2D: 不认识的绘制源（测试只允许 StubCanvas/FakeReferenceBitmap）')
    const px = src.__stubPixels
    const [a, , , d, e, f] = this.#transform
    this.#forEachPixel(a * dx + e, d * dy + f, a * (dx + dw) + e, d * (dy + dh) + f, (i, X, Y) => {
      const cssX = (X + 0.5 - e) / a
      const cssY = (Y + 0.5 - f) / d
      if (cssX < dx || cssX >= dx + dw || cssY < dy || cssY >= dy + dh) return
      const sx = Math.min(px.width - 1, Math.max(0, Math.floor(((cssX - dx) / dw) * px.width)))
      const sy = Math.min(px.height - 1, Math.max(0, Math.floor(((cssY - dy) / dh) * px.height)))
      const si = (sy * px.width + sx) * 4
      compositeOver(this.#buf(), i, px.data[si], px.data[si + 1], px.data[si + 2], px.data[si + 3] / 255, this.globalAlpha)
    })
  }

  beginPath(): void {
    this.#circles = []
  }

  arc(cx: number, cy: number, r: number, _startAngle = 0, _endAngle = Math.PI * 2): void {
    // 管线只画整圆（paintGems 与预铺非零内容）→ 角度参数忽略
    this.#circles.push([cx, cy, r])
  }

  fill(): void {
    const [a, , , d, e, f] = this.#transform
    if (a < 0 || d < 0 || a !== d) throw new Error('Stub2D 仅支持正均匀缩放（setTransform(dpr,...) 契约）')
    const [fr, fg, fb] = this.#fill
    const alpha = this.globalAlpha
    for (const [cx, cy, r] of this.#circles) {
      const dx0 = a * cx + e
      const dy0 = d * cy + f
      const rDev = r * a
      this.#forEachPixel(dx0 - rDev, dy0 - rDev, dx0 + rDev, dy0 + rDev, (i, X, Y) => {
        const ddx = X + 0.5 - dx0
        const ddy = Y + 0.5 - dy0
        if (ddx * ddx + ddy * ddy <= rDev * rDev) {
          compositeOver(this.#buf(), i, fr, fg, fb, 1, alpha)
        }
      })
    }
  }
}

class StubCanvas {
  #w = 300
  #h = 150
  #ctx: Stub2D | null = null
  #buffer = new Uint8ClampedArray(300 * 150 * 4)
  /** 旧管线从布局尺寸取 CSS 宽高（drawPreview 由调用方显式传 size） */
  clientWidth = 0
  clientHeight = 0

  get width(): number {
    return this.#w
  }

  set width(v: number) {
    this.#resize(v, this.#h)
  }

  get height(): number {
    return this.#h
  }

  set height(v: number) {
    this.#resize(this.#w, v)
  }

  /** 背板尺寸变更 = 整面清零（浏览器同语义） */
  #resize(w: number, h: number): void {
    if (w === this.#w && h === this.#h) return
    this.#w = w
    this.#h = h
    this.#buffer = new Uint8ClampedArray(w * h * 4)
  }

  getContext(kind: '2d'): Stub2D | null {
    if (kind !== '2d') return null
    if (!this.#ctx) this.#ctx = new Stub2D(this)
    return this.#ctx
  }

  get __stubPixels(): StubPixels {
    return { width: this.#w, height: this.#h, data: this.#buffer }
  }
}

/** 结构化实现 ImageBitmap（可作 PreviewRenderInput.referenceBitmap 传入），确定性渐变图案 */
class FakeReferenceBitmap implements ImageBitmap {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8ClampedArray

  constructor(width: number, height: number, paint: (x: number, y: number) => [number, number, number]) {
    this.width = width
    this.height = height
    this.pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = paint(x, y)
        const i = (y * width + x) * 4
        this.pixels[i] = r
        this.pixels[i + 1] = g
        this.pixels[i + 2] = b
        this.pixels[i + 3] = 255
      }
    }
  }

  close(): void {}

  get __stubPixels(): StubPixels {
    return { width: this.width, height: this.height, data: this.pixels }
  }
}

// document.createElement('canvas') → StubCanvas（drawPreview/旧管线复刻的离屏底图层都走这里）
const realCreateElement = document.createElement.bind(document)
let createElementSpy: ReturnType<typeof vi.spyOn> | null = null

function installCanvasStub(): void {
  createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag.toLowerCase() === 'canvas') return new StubCanvas() as unknown as HTMLElement
    return realCreateElement(tag)
  })
}

function setDpr(dpr: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true })
}

// ---------------------------------------------------------------------------
// 旧 CompareGrid.renderPreview 管线复刻（golden 基准，重构前 51a116c 逐语句）
// ---------------------------------------------------------------------------

/** 旧 paintLayer 构造（旧组件 $effect 内的离屏底图层） */
function oldPaintLayer(p: EngineImage): StubCanvas | null {
  const canvas = document.createElement('canvas') as unknown as StubCanvas
  canvas.width = p.width
  canvas.height = p.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }
  ctx.putImageData(paintingImageData(p), 0, 0)
  return canvas
}

interface OldRenderOpts {
  painting: EngineImage | null
  paintLayer: StubCanvas | null
  refImg: StubImageSource | null
  res: StrategyResult | null
  palette: Palette
  blocks: Block[]
  grid: GridSpec
  mode: PreviewMode
  opacity: number
}

/** 旧 renderPreview 函数体逐语句复刻（cssW/cssH/dpr 取自 window，与旧组件一致） */
function oldRenderPreview(canvas: StubCanvas, opts: OldRenderOpts): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const p = opts.painting
  const cssW = canvas.clientWidth || 240
  const cssH = canvas.clientHeight || 240
  const dpr = window.devicePixelRatio || 1
  const bw = Math.round(cssW * dpr)
  const bh = Math.round(cssH * dpr)
  if (canvas.width !== bw) canvas.width = bw
  if (canvas.height !== bh) canvas.height = bh
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  if (!p) return

  const W = p.width
  const H = p.height
  const s = Math.min(cssW / W, cssH / H)
  const ox = (cssW - W * s) / 2
  const oy = (cssH - H * s) / 2

  if (opts.mode !== 'gems') {
    ctx.globalAlpha = opts.opacity
    if (opts.mode === 'painting' && opts.paintLayer) ctx.drawImage(opts.paintLayer, ox, oy, W * s, H * s)
    if (opts.mode === 'reference' && opts.refImg) ctx.drawImage(opts.refImg, ox, oy, W * s, H * s)
    ctx.globalAlpha = 1
  }

  paintGems(ctx as unknown as CanvasRenderingContext2D, opts.res?.gems ?? [], opts.palette, opts.blocks, opts.grid, {
    scale: s,
    ox,
    oy,
  })
}

// ---------------------------------------------------------------------------
// fixture：fixtureShapes + segment + layout(hybrid) → StrategyResult（与 store 产出口径一致）
// ---------------------------------------------------------------------------

interface Fixture {
  painting: EngineImage
  grid: GridSpec
  blocks: Block[]
  palette: Palette
  result: StrategyResult
}

let FIX: Fixture

beforeAll(() => {
  const painting = fixtureShapes()
  const grid = standardGrid()
  const blocks = segment(painting, SEG_OPTS)
  const { gems, warnings, dropped } = layout(
    blocks,
    'hybrid',
    { density: 1, seed: 1, relax: { boundary: false, repulsion: false } },
    grid,
  )
  const palette = STARTER_PALETTE.map((c) => ({ ...c }))
  mapColors(gems, blocks, palette)
  FIX = {
    painting,
    grid,
    blocks,
    palette,
    result: {
      strategy: 'hybrid',
      gems,
      warnings,
      durationMs: 42,
      spacingCount: warnings.filter((w) => w.kind === 'spacing').length,
      dropped: dropped ?? 0,
    },
  }
})

afterEach(() => {
  createElementSpy?.mockRestore()
  createElementSpy = null
  setDpr(1)
})

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

function ctx2d(canvas: StubCanvas): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('StubCanvas 2d 上下文必然存在')
  return ctx as unknown as CanvasRenderingContext2D
}

function bytesOf(canvas: StubCanvas): Uint8ClampedArray {
  return canvas.__stubPixels.data
}

function expectIdentical(actual: Uint8ClampedArray, expected: Uint8ClampedArray, label: string): void {
  const mismatch = actual.findIndex((v, i) => v !== expected[i])
  expect(
    mismatch === -1 && actual.length === expected.length,
    `${label}: 应逐字节一致（长度 ${actual.length} vs ${expected.length}，首个差异字节 #${mismatch}）`,
  ).toBe(true)
}

function opaqueRatio(buf: Uint8ClampedArray): number {
  let n = 0
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) n++
  return n / (buf.length / 4)
}

function newDrawCanvas(w: number, h: number): StubCanvas {
  const canvas = new StubCanvas()
  canvas.clientWidth = w
  canvas.clientHeight = h
  return canvas
}

function drawOn(canvas: StubCanvas, input: PreviewRenderInput): void {
  drawPreview(ctx2d(canvas), input)
}

const REF = new FakeReferenceBitmap(64, 96, (x, y) => [x * 3 + 7, y * 5 + 11, (x + y) * 2 + 100])

const MODES: PreviewMode[] = ['gems', 'painting', 'reference']
const SHAPES: Array<{ label: string; w: number; h: number; dpr: number }> = [
  { label: '方形 dpr1', w: 240, h: 240, dpr: 1 },
  { label: '方形 dpr2', w: 240, h: 240, dpr: 2 },
  { label: '宽幅 letterbox dpr1.25', w: 320, h: 140, dpr: 1.25 },
]

/** golden 全矩阵：三模式 × 有/无参考图 × 三尺寸/dpr */
const GOLDEN_CASES: Array<{ mode: PreviewMode; hasRef: boolean; shape: (typeof SHAPES)[number] }> = []
for (const mode of MODES) {
  for (const hasRef of [true, false]) {
    for (const shape of SHAPES) GOLDEN_CASES.push({ mode, hasRef, shape })
  }
}

// ---------------------------------------------------------------------------
// 1. Golden 全矩阵：drawPreview ≡ 旧管线复刻（逐字节 + 背板尺寸）
// ---------------------------------------------------------------------------

describe('drawPreview · golden 对照（旧 CompareGrid.renderPreview 管线）', () => {
  it.each(GOLDEN_CASES)('模式 $mode × 参考 $hasRef × $shape.label：逐字节一致', ({ mode, hasRef, shape }) => {
    installCanvasStub()
    setDpr(shape.dpr)
    const input = {
      painting: FIX.painting,
      referenceBitmap: hasRef ? REF : undefined,
      result: FIX.result,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode,
      overlayOpacity: 0.5,
      size: { width: shape.w, height: shape.h },
      dpr: shape.dpr,
    }

    const next = newDrawCanvas(shape.w, shape.h)
    drawOn(next, input)

    const golden = newDrawCanvas(shape.w, shape.h)
    oldRenderPreview(golden, {
      painting: FIX.painting,
      paintLayer: oldPaintLayer(FIX.painting),
      refImg: hasRef ? REF : null,
      res: FIX.result,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode,
      opacity: 0.5,
    })

    expectIdentical(bytesOf(next), bytesOf(golden), `${mode}/${hasRef}/${shape.label}`)
    expect(next.width, '背板宽 = round(cssW×dpr)').toBe(Math.round(shape.w * shape.dpr))
    expect(next.height).toBe(Math.round(shape.h * shape.dpr))
  })

  it('result 为 null/undefined 时等价于空钻集（旧 res?.gems ?? [] 语义）', () => {
    installCanvasStub()
    setDpr(1)
    const base = {
      painting: FIX.painting,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode: 'gems' as PreviewMode,
      overlayOpacity: 0.5,
      size: { width: 240, height: 240 },
      dpr: 1,
    }
    const withNull = newDrawCanvas(240, 240)
    drawOn(withNull, { ...base, result: null })
    const withEmpty = newDrawCanvas(240, 240)
    drawOn(withEmpty, { ...base, result: { ...FIX.result, gems: [] } })
    expectIdentical(bytesOf(withNull), bytesOf(withEmpty), 'null result ≡ 空 gems')
  })

  it('无 painting：清屏即止，整面透明（旧 if (!p) return 语义）', () => {
    installCanvasStub()
    setDpr(1)
    const canvas = newDrawCanvas(240, 240)
    // 先铺一层非零内容，验证 drawPreview 确实先清屏
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('unreachable')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#336699'
    ctx.beginPath()
    ctx.arc(120, 120, 100, 0, Math.PI * 2)
    ctx.fill()
    drawOn(canvas, {
      painting: undefined,
      result: FIX.result,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode: 'gems',
      overlayOpacity: 0.5,
      size: { width: 240, height: 240 },
      dpr: 1,
    })
    expect(bytesOf(canvas).every((v) => v === 0), '无 painting = 全透明').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. 自稳定：同输入两次绘制 / 同画布重绘不残留
// ---------------------------------------------------------------------------

describe('drawPreview · 自稳定', () => {
  it('同输入两块画布逐字节一致', () => {
    installCanvasStub()
    setDpr(1)
    for (const mode of MODES) {
      const a = newDrawCanvas(240, 240)
      const b = newDrawCanvas(240, 240)
      const input = {
        painting: FIX.painting,
        referenceBitmap: REF,
        result: FIX.result,
        palette: FIX.palette,
        blocks: FIX.blocks,
        grid: FIX.grid,
        mode,
        overlayOpacity: 0.5,
        size: { width: 240, height: 240 },
        dpr: 1,
      }
      drawOn(a, input)
      drawOn(b, input)
      expectIdentical(bytesOf(a), bytesOf(b), `自稳定/${mode}`)
    }
  })

  it('同画布重绘（含半透明叠稿）不残留：二帧 = 一帧', () => {
    installCanvasStub()
    setDpr(1)
    const canvas = newDrawCanvas(240, 240)
    const input = {
      painting: FIX.painting,
      referenceBitmap: REF,
      result: FIX.result,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode: 'painting' as PreviewMode,
      overlayOpacity: 0.5,
      size: { width: 240, height: 240 },
      dpr: 1,
    }
    drawOn(canvas, input)
    const first = new Uint8ClampedArray(bytesOf(canvas))
    drawOn(canvas, input)
    expectIdentical(bytesOf(canvas), first, '重绘不残留（clearRect 全清）')
  })

  it('底图层记忆按 painting 对象身份：换图后内容不同，换回后与首绘一致', () => {
    installCanvasStub()
    setDpr(1)
    const base = {
      result: null,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode: 'painting' as PreviewMode,
      overlayOpacity: 0.5,
      size: { width: 240, height: 240 },
      dpr: 1,
    }
    const a = newDrawCanvas(240, 240)
    drawOn(a, { ...base, painting: FIX.painting })
    const bytesA = new Uint8ClampedArray(bytesOf(a))

    const other = fixtureSolid()
    const b = newDrawCanvas(240, 240)
    drawOn(b, { ...base, painting: other })
    const bytesB = bytesOf(b)
    expect(bytesOf(a).some((v, i) => v !== bytesB[i]), '不同 painting 输出不同').toBe(true)

    const a2 = newDrawCanvas(240, 240)
    drawOn(a2, { ...base, painting: FIX.painting })
    expectIdentical(bytesOf(a2), bytesA, '同 painting 复绘一致')
  })
})

// ---------------------------------------------------------------------------
// 3. 防黑图 + 模式区分 + 几何探针
// ---------------------------------------------------------------------------

describe('drawPreview · 防黑图与模式语义', () => {
  const BLACKGUARD_CASES: Array<{ mode: PreviewMode; hasRef: boolean }> = []
  for (const mode of MODES) for (const hasRef of [true, false]) BLACKGUARD_CASES.push({ mode, hasRef })

  it.each(BLACKGUARD_CASES)('$mode × 参考 $hasRef：非透明像素比例过阈（防黑图）', ({ mode, hasRef }) => {
      installCanvasStub()
      setDpr(1)
      const canvas = newDrawCanvas(240, 240)
      drawOn(canvas, {
        painting: FIX.painting,
        referenceBitmap: hasRef ? REF : undefined,
        result: FIX.result,
        palette: FIX.palette,
        blocks: FIX.blocks,
        grid: FIX.grid,
        mode,
        overlayOpacity: 0.5,
        size: { width: 240, height: 240 },
        dpr: 1,
      })
      const ratio = opaqueRatio(bytesOf(canvas))
      // reference 无位图 = 仅钻点（旧管线语义）→ 与 gems 同阈
      const threshold = mode === 'gems' || (mode === 'reference' && !hasRef) ? 0.25 : 0.9
      expect(ratio, `${mode} 非透明占比 ${ratio.toFixed(3)} 应 > ${threshold}`).toBeGreaterThan(threshold)
    },
  )

  it('三模式互不相同；gems 不受参考图影响；缺参考图的 reference ≡ gems', () => {
    installCanvasStub()
    setDpr(1)
    const shots = new Map<string, Uint8ClampedArray>()
    for (const mode of MODES) {
      for (const hasRef of [true, false]) {
        const canvas = newDrawCanvas(240, 240)
        drawOn(canvas, {
          painting: FIX.painting,
          referenceBitmap: hasRef ? REF : undefined,
          result: FIX.result,
          palette: FIX.palette,
          blocks: FIX.blocks,
          grid: FIX.grid,
          mode,
          overlayOpacity: 0.5,
          size: { width: 240, height: 240 },
          dpr: 1,
        })
        shots.set(`${mode}:${hasRef}`, new Uint8ClampedArray(bytesOf(canvas)))
      }
    }
    const distinct = (x: string, y: string) => shots.get(x)!.some((v, i) => v !== shots.get(y)![i])
    expect(distinct('gems:true', 'painting:true'), 'gems ≠ painting').toBe(true)
    expect(distinct('painting:true', 'reference:true'), 'painting ≠ reference').toBe(true)
    expectIdentical(shots.get('gems:true')!, shots.get('gems:false')!, 'gems 模式忽略参考图')
    expectIdentical(shots.get('reference:false')!, shots.get('gems:false')!, '缺位图的 reference = 仅钻点')
  })

  it('几何探针：钻心设备像素 = 色板色（不依赖 golden 复刻的独立语义锚）', () => {
    installCanvasStub()
    setDpr(1)
    const W = 240
    const H = 240
    const s = Math.min(W / FIX.painting.width, H / FIX.painting.height)
    const ox = (W - FIX.painting.width * s) / 2
    const oy = (H - FIX.painting.height * s) / 2
    const canvas = newDrawCanvas(W, H)
    drawOn(canvas, {
      painting: FIX.painting,
      result: FIX.result,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode: 'gems',
      overlayOpacity: 0.5,
      size: { width: W, height: H },
      dpr: 1,
    })
    const buf = bytesOf(canvas)
    const hexOf = (id: string) => FIX.palette.find((c) => c.id === id)?.hex
    // fixture 首钻 + 中位钻：钻心 = ox + (x+0.5)*s（paintGems arc 圆心），设备像素 = floor(css×dpr)
    const probes = [FIX.result.gems[0], FIX.result.gems[Math.floor(FIX.result.gems.length / 2)]]
    for (const gem of probes) {
      const hex = hexOf(gem.colorId)
      if (!hex) continue
      const px = Math.floor((ox + (gem.x + 0.5) * s) * 1)
      const py = Math.floor((oy + (gem.y + 0.5) * s) * 1)
      const i = (py * W + px) * 4
      const [r, g, b] = parseColor(hex)
      expect([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]], `钻 ${gem.id}(${px},${py}) 圆心像素 = ${hex}`).toEqual([r, g, b, 255])
    }
    expect(opaqueRatio(buf), '探针画布本身也要过防黑阈').toBeGreaterThan(0.25)
  })

  it('叠稿探针：painting 模式 0.5 透明度下已知像素 = 期望混合值（240² contain 全幅 → src=fixture 原像素）', () => {
    installCanvasStub()
    setDpr(1)
    const canvas = newDrawCanvas(240, 240)
    drawOn(canvas, {
      painting: FIX.painting,
      result: null,
      palette: FIX.palette,
      blocks: FIX.blocks,
      grid: FIX.grid,
      mode: 'painting',
      overlayOpacity: 0.5,
      size: { width: 240, height: 240 },
      dpr: 1,
    })
    const buf = bytesOf(canvas)
    // css(5.5,5.5) → src (2,2)：fixtureShapes 象牙底 (255,252,240)；0.5 over 透明（直 alpha 表示，
    // 与真实 canvas getImageData 的非预乘读数一致）→ RGB 保真 + alpha 128
    const i = (5 * 240 + 5) * 4
    expect([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]], '叠稿半透明混合值').toEqual([255, 252, 240, 128])
  })
})
