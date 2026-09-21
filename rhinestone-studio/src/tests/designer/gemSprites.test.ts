/*
 * [2026-09-21 rework-designer-manual-rhinestone R2.1 Test] 水钻贴图 sprite 烘焙管线
 * （design §1.1/§1.2）：jsdom 无真光栅——经依赖注入面（Image 工厂/离屏画布工厂/纹理
 * resolver）断言：三态烘焙 op 序列（含方案 A multiply 着色链）、LRU 逐出、missing 负缓存、
 * miss→异步烘焙→就绪通知→二次取帧、cache 键维度（specKey/直径/dpr/态/着色）。
 * 真帧视觉归走查门（设计明示 jsdom 不可测真帧率/真光栅）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount as unmountComponent } from 'svelte'
import DesignerCanvas from '../../components/Designer/DesignerCanvas.svelte'
import { findPaletteColor } from '$lib/engine'
import { getEditDoc, loadFromHandoff, resetEditForTests, setSelection, type DesignerGem } from '$lib/stores/edit.svelte'
import { getViewState, setViewState } from '$lib/designer/viewport.svelte'
import { setMovePreview } from '$lib/designer/interaction.svelte'
import { setBrushCursor, setBrushSpec, setMarquee, setTool, resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import {
  gemSpriteKeyOf,
  gemSpriteCacheKeys,
  GEM_SPRITE_CACHE_LIMIT,
  GEM_SPRITE_MISSING_RETRY_MS,
  GEM_SPRITE_TRANSIENT_RETRY_MS,
  onGemSpritesChanged,
  requestGemSprite,
  resetGemSpritesForTests,
  setGemSpriteDepsForTests,
  type DecodedTexture,
  type GemSpriteDeps,
  type GemTextureSource,
} from '$lib/designer/gemSprites'
import { makeHandoff } from '../edit/helpers'

// jsdom 缺 ImageData 构造器（previewRender.test.ts 同式最小 polyfill——putImageData
// 只读 width/height/data，结构满足即真实语义不变；仅 getContext 打桩后的 layers effect 触达）。
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
// 录制 ctx（canvas 2d 替身——烘焙 op 序列断言面）
// ---------------------------------------------------------------------------

interface RecordedCall {
  op: string
  source?: unknown
  args: unknown[]
}

class RecordingCtx {
  #fillStyle = ''
  #strokeStyle = ''
  #shadowColor = 'transparent'
  #shadowBlur = 0
  #shadowOffsetY = 0
  #gco = 'source-over'
  readonly calls: RecordedCall[] = []
  readonly styleLog: Array<{ prop: string; value: unknown }> = []
  constructor(readonly canvas: HTMLCanvasElement) {}
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
  get globalCompositeOperation(): string {
    return this.#gco
  }
  set globalCompositeOperation(v: string) {
    this.#gco = v
    this.styleLog.push({ prop: 'globalCompositeOperation', value: v })
  }
  setTransform(...args: unknown[]): void {
    this.calls.push({ op: 'setTransform', args })
  }
  drawImage(source: unknown, ...args: unknown[]): void {
    this.calls.push({ op: 'drawImage', source, args })
  }
  fillRect(...args: unknown[]): void {
    this.calls.push({ op: 'fillRect', args })
  }
  // 渲染路径其余 op：记录（arc/stroke/fill 计数 = 几何符号路径断言面），无位图语义
  save(): void {}
  restore(): void {}
  translate(...args: unknown[]): void {
    this.calls.push({ op: 'translate', args })
  }
  scale(...args: unknown[]): void {
    this.calls.push({ op: 'scale', args })
  }
  beginPath(): void {}
  closePath(): void {}
  arc(...args: unknown[]): void {
    this.calls.push({ op: 'arc', args })
  }
  moveTo(...args: unknown[]): void {
    this.calls.push({ op: 'moveTo', args })
  }
  lineTo(...args: unknown[]): void {
    this.calls.push({ op: 'lineTo', args })
  }
  stroke(): void {
    this.calls.push({ op: 'stroke', args: [] })
  }
  fill(): void {
    this.calls.push({ op: 'fill', args: [] })
  }
  strokeRect(...args: unknown[]): void {
    this.calls.push({ op: 'strokeRect', args })
  }
  clearRect(...args: unknown[]): void {
    this.calls.push({ op: 'clearRect', args })
  }
  fillText(...args: unknown[]): void {
    this.calls.push({ op: 'fillText', args })
  }
  setLineDash(...args: unknown[]): void {
    this.calls.push({ op: 'setLineDash', args })
  }
  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  }
  putImageData(...args: unknown[]): void {
    this.calls.push({ op: 'putImageData', args })
  }
  drawImageCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.op === 'drawImage')
  }
  opCalls(op: RecordedCall['op']): RecordedCall[] {
    return this.calls.filter((c) => c.op === op)
  }
  /** 日志位点（多轮重绘累积的 log 上做「最后一轮」切片断言）。 */
  mark(): { calls: number; styles: number } {
    return { calls: this.calls.length, styles: this.styleLog.length }
  }
  callsSince(mark: { calls: number; styles: number }): RecordedCall[] {
    return this.calls.slice(mark.calls)
  }
  stylesSince(mark: { calls: number; styles: number }): Array<{ prop: string; value: unknown }> {
    return this.styleLog.slice(mark.styles)
  }
}

/** 测试替身依赖工厂：每次 createCanvas 记录新 RecordingCtx；纹理解码为固定 64×64 位图替身。 */
function makeDeps(
  texture: GemTextureSource | null,
): { deps: GemSpriteDeps; ctxs: () => RecordingCtx[]; loadImageCount: () => number } {
  const ctxs: RecordingCtx[] = []
  let loadImageCount = 0
  const fakeBitmap = { toString: () => 'decoded-bitmap' } as unknown as CanvasImageSource
  const deps: GemSpriteDeps = {
    resolveTexture: vi.fn(async () => texture),
    loadImage: vi.fn(async (): Promise<DecodedTexture> => {
      loadImageCount += 1
      return { image: fakeBitmap, width: 64, height: 64 }
    }),
    createCanvas: () => {
      const canvas = document.createElement('canvas')
      const ctx = new RecordingCtx(canvas)
      ctxs.push(ctx)
      return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D }
    },
  }
  setGemSpriteDepsForTests(deps)
  return { deps, ctxs: () => ctxs, loadImageCount: () => loadImageCount }
}

/** flush 微任务链（resolver → loadImage → bake 全异步续体）。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

const ROUND_TEXTURE: GemTextureSource = { dataUrl: 'data:image/png;base64,SEED', aspect: 1 }
const BASE_REQUEST = {
  specKey: 'round-ss10',
  diameterPx: 8,
  dpr: 2,
  state: 'normal' as const,
  tintHex: null,
}

beforeEach(() => {
  resetGemSpritesForTests()
})

afterEach(() => {
  setGemSpriteDepsForTests(null)
})

describe('烘焙管线（miss → 异步烘焙 → 就绪通知 → 命中）', () => {
  it('miss 返回 null 并 kick 异步烘焙；就绪通知后二次取帧命中', async () => {
    const { ctxs } = makeDeps(ROUND_TEXTURE)
    const notified = vi.fn()
    onGemSpritesChanged(notified)

    expect(requestGemSprite(BASE_REQUEST)).toBeNull() // 本帧回退几何符号
    await flushAsync()
    expect(notified).toHaveBeenCalledTimes(1)
    expect(ctxs()).toHaveLength(1) // 无着色 → 单帧 ctx（无 tint 离屏）

    const frame = requestGemSprite(BASE_REQUEST)
    expect(frame).not.toBeNull()
    expect(frame?.key).toBe(gemSpriteKeyOf(BASE_REQUEST))
  })

  it('同 key 二次 miss 在飞去重（单次烘焙单帧入 cache）', async () => {
    const { loadImageCount } = makeDeps(ROUND_TEXTURE)
    requestGemSprite(BASE_REQUEST)
    requestGemSprite(BASE_REQUEST) // 在飞：null 且不再起一炉
    await flushAsync()
    expect(loadImageCount()).toBe(1)
    expect(gemSpriteCacheKeys()).toHaveLength(1)
  })

  it('不同态共享一次纹理解析、各自成帧', async () => {
    const { deps, loadImageCount } = makeDeps(ROUND_TEXTURE)
    for (const state of ['normal', 'hover', 'selected'] as const) {
      requestGemSprite({ ...BASE_REQUEST, state })
    }
    await flushAsync()
    expect(deps.resolveTexture).toHaveBeenCalledTimes(1) // specKey 级去重
    expect(loadImageCount()).toBe(3) // 每帧各自解码（浏览器侧 Image 缓存兜底）
    expect(gemSpriteCacheKeys()).toHaveLength(3)
  })

  it('非法参数（直径/dpr ≤ 0）直接 null，不起烘焙', async () => {
    const { deps } = makeDeps(ROUND_TEXTURE)
    expect(requestGemSprite({ ...BASE_REQUEST, diameterPx: 0 })).toBeNull()
    expect(requestGemSprite({ ...BASE_REQUEST, dpr: -1 })).toBeNull()
    await flushAsync()
    expect(deps.resolveTexture).not.toHaveBeenCalled()
  })
})

describe('三态烘焙 op 序列（design §1.1 逐条）', () => {
  it('normal：柔投影（rgba(0,0,0,.35) blur r·0.4 offsetY r·0.15）+ 单次 drawImage', async () => {
    const { ctxs } = makeDeps(ROUND_TEXTURE)
    requestGemSprite(BASE_REQUEST)
    await flushAsync()
    const ctx = ctxs()[0]
    const r = BASE_REQUEST.diameterPx / 2
    expect(ctx.styleLog).toContainEqual({ prop: 'shadowColor', value: 'rgba(0,0,0,0.35)' })
    expect(ctx.styleLog).toContainEqual({ prop: 'shadowBlur', value: r * 0.4 })
    expect(ctx.styleLog).toContainEqual({ prop: 'shadowOffsetY', value: r * 0.15 })
    expect(ctx.drawImageCalls()).toHaveLength(1)
    // 帧几何：内容盒居中（dx = size/2 - contentW/2）
    const frame = requestGemSprite(BASE_REQUEST)!
    expect(frame.contentW).toBe(8)
    expect(frame.contentH).toBe(8)
    expect(ctx.drawImageCalls()[0]!.args).toEqual([0, 0, 64, 64, frame.size / 2 - 4, frame.size / 2 - 4, 8, 8])
  })

  it('hover：投影增强 + source-atop 叠 rgba(255,255,255,.10) 提亮（复合还原 source-over）', async () => {
    const { ctxs } = makeDeps(ROUND_TEXTURE)
    requestGemSprite({ ...BASE_REQUEST, state: 'hover' })
    await flushAsync()
    const ctx = ctxs()[0]
    const r = BASE_REQUEST.diameterPx / 2
    expect(ctx.styleLog).toContainEqual({ prop: 'shadowColor', value: 'rgba(0,0,0,0.5)' })
    expect(ctx.styleLog).toContainEqual({ prop: 'shadowBlur', value: r * 0.55 })
    expect(ctx.styleLog).toContainEqual({ prop: 'shadowOffsetY', value: r * 0.2 })
    expect(ctx.drawImageCalls()).toHaveLength(1)
    // 提亮叠层：阴影清零 → source-atop → fillStyle rgba(255,255,255,.10) → fillRect → 还原
    const atopIdx = ctx.styleLog.findIndex((s) => s.prop === 'globalCompositeOperation' && s.value === 'source-atop')
    expect(atopIdx).toBeGreaterThan(-1)
    expect(ctx.styleLog).toContainEqual({ prop: 'fillStyle', value: 'rgba(255,255,255,0.10)' })
    expect(ctx.calls).toContainEqual({ op: 'fillRect', args: [0, 0, expect.any(Number), expect.any(Number)] })
    const restoreIdx = ctx.styleLog.findLastIndex(
      (s) => s.prop === 'globalCompositeOperation' && s.value === 'source-over',
    )
    expect(restoreIdx).toBeGreaterThan(atopIdx)
  })

  it('selected：主蓝 #0284C7 blur r·0.6 双 pass 外发光 + normal 投影本体（3 次 drawImage）', async () => {
    const { ctxs } = makeDeps(ROUND_TEXTURE)
    requestGemSprite({ ...BASE_REQUEST, state: 'selected' })
    await flushAsync()
    const ctx = ctxs()[0]
    const r = BASE_REQUEST.diameterPx / 2
    const glowIdx = ctx.styleLog.findIndex((s) => s.prop === 'shadowColor' && s.value === '#0284C7')
    expect(glowIdx).toBeGreaterThan(-1)
    expect(ctx.styleLog).toContainEqual({ prop: 'shadowBlur', value: r * 0.6 })
    expect(ctx.drawImageCalls()).toHaveLength(3) // 双 pass 发光 + 本体投影
    // 本体投影收尾（发光 pass 之后仍回落 normal 投影）
    const bodyIdx = ctx.styleLog.findLastIndex((s) => s.prop === 'shadowColor' && s.value === 'rgba(0,0,0,0.35)')
    expect(bodyIdx).toBeGreaterThan(glowIdx)
  })

  it('异形纵横比：内容盒按 aspect 派生且居中（marquise 0.5）', async () => {
    const { ctxs } = makeDeps({ dataUrl: 'data:image/png;base64,MQ', aspect: 0.5 })
    requestGemSprite({ ...BASE_REQUEST, diameterPx: 10 })
    await flushAsync()
    const frame = requestGemSprite({ ...BASE_REQUEST, diameterPx: 10 })!
    expect(frame.contentW).toBe(5)
    expect(frame.contentH).toBe(10)
    expect(frame.size).toBe(10 + frame.pad * 2)
    const draw = ctxs()[0].drawImageCalls()[0]!
    expect(draw.args).toEqual([0, 0, 64, 64, frame.size / 2 - 2.5, frame.size / 2 - 5, 5, 10])
  })

  it('dpr 栅格化：帧位图像素 = 逻辑尺寸 × dpr', async () => {
    const { ctxs } = makeDeps(ROUND_TEXTURE)
    requestGemSprite(BASE_REQUEST)
    await flushAsync()
    const frame = requestGemSprite(BASE_REQUEST)!
    expect(frame.canvas.width).toBe(Math.round(frame.size * BASE_REQUEST.dpr))
    expect(frame.canvas.height).toBe(Math.round(frame.size * BASE_REQUEST.dpr))
    expect(ctxs()[0].calls[0]!.op).toBe('setTransform')
  })
})

describe('裁断 1.2 = 方案 A（multiply 着色烘进帧）', () => {
  it('tintHex 非空：着色离屏 multiply 铺色 + destination-in 回贴 alpha，帧绘制源 = 着色帧', async () => {
    const { ctxs } = makeDeps(ROUND_TEXTURE)
    requestGemSprite({ ...BASE_REQUEST, tintHex: '#c8102e' })
    await flushAsync()
    expect(ctxs()).toHaveLength(2) // 帧 ctx + 着色离屏 ctx
    const [frameCtx, tintCtx] = ctxs()
    const gco = (v: string) => ({ prop: 'globalCompositeOperation', value: v })
    const sequence = tintCtx!.styleLog.filter((s) => s.prop === 'globalCompositeOperation')
    expect(sequence).toEqual([gco('multiply'), gco('destination-in'), gco('source-over')])
    expect(tintCtx!.styleLog).toContainEqual({ prop: 'fillStyle', value: '#c8102e' })
    expect(tintCtx!.drawImageCalls()).toHaveLength(2) // 缩放铺底 + 回贴 alpha
    // 帧本体只绘着色产物（source = 着色离屏 canvas）
    expect(frameCtx!.drawImageCalls()).toHaveLength(1)
    expect(frameCtx!.drawImageCalls()[0]!.source).toBe(tintCtx!.canvas)
  })

  it('tintHex null：无着色离屏（贴图原样——未映射色）', async () => {
    const { ctxs } = makeDeps(ROUND_TEXTURE)
    requestGemSprite(BASE_REQUEST)
    await flushAsync()
    expect(ctxs()).toHaveLength(1)
  })
})

describe('cache 键与 LRU（上限 256）', () => {
  it('键维度：态/dpr/直径/着色各成一键；量化浮点噪声', () => {
    expect(gemSpriteKeyOf(BASE_REQUEST)).not.toBe(gemSpriteKeyOf({ ...BASE_REQUEST, state: 'hover' }))
    expect(gemSpriteKeyOf(BASE_REQUEST)).not.toBe(gemSpriteKeyOf({ ...BASE_REQUEST, dpr: 1 }))
    expect(gemSpriteKeyOf(BASE_REQUEST)).not.toBe(gemSpriteKeyOf({ ...BASE_REQUEST, diameterPx: 8.01 }))
    expect(gemSpriteKeyOf({ ...BASE_REQUEST, diameterPx: 8.0000001 })).toBe(gemSpriteKeyOf(BASE_REQUEST))
    expect(gemSpriteKeyOf(BASE_REQUEST)).not.toBe(gemSpriteKeyOf({ ...BASE_REQUEST, tintHex: '#c8102e' }))
  })

  it('LRU：超上限逐最旧；命中刷新热度', async () => {
    makeDeps(ROUND_TEXTURE)
    const first = { ...BASE_REQUEST, specKey: 'round-ss6' }
    const victim = { ...BASE_REQUEST, specKey: 'round-ss6-0' }
    requestGemSprite(first)
    requestGemSprite(victim)
    await flushAsync()
    expect(requestGemSprite(first)).not.toBeNull() // touch：first 热度刷新到 victim 之后
    // 再插 254 键 → 总 256；第 257 键触发逐出最旧（= victim，非 touch 过的 first）
    for (let i = 1; i <= 254; i += 1) {
      requestGemSprite({ ...BASE_REQUEST, specKey: `round-ss6-${i}` })
      await flushAsync()
    }
    expect(gemSpriteCacheKeys()).toHaveLength(GEM_SPRITE_CACHE_LIMIT)
    requestGemSprite({ ...BASE_REQUEST, specKey: 'round-ss6-255' })
    await flushAsync()
    const keys = gemSpriteCacheKeys()
    expect(keys).toHaveLength(GEM_SPRITE_CACHE_LIMIT)
    expect(keys).not.toContain(gemSpriteKeyOf(victim)) // 未 touch 的最旧被逐
    expect(keys).toContain(gemSpriteKeyOf(first)) // touch 后存活
    expect(keys).toContain(gemSpriteKeyOf({ ...BASE_REQUEST, specKey: 'round-ss6-255' })) // 新键在列
  })
})

describe('missing-asset 回退（负缓存）', () => {
  it('resolver null → 通知 + specKey 负缓存（不再打资产面）', async () => {
    const { deps } = makeDeps(null)
    const notified = vi.fn()
    onGemSpritesChanged(notified)
    expect(requestGemSprite(BASE_REQUEST)).toBeNull()
    await flushAsync()
    expect(notified).toHaveBeenCalledTimes(1)
    expect(requestGemSprite(BASE_REQUEST)).toBeNull() // 负缓存命中
    expect(requestGemSprite({ ...BASE_REQUEST, state: 'hover' })).toBeNull()
    expect(deps.resolveTexture).toHaveBeenCalledTimes(1) // 只打过一次
    expect(gemSpriteCacheKeys()).toHaveLength(0)
  })

  it('Image 解码失败同负缓存（specKey 粒度）', async () => {
    const ctxs: RecordingCtx[] = []
    const deps: GemSpriteDeps = {
      resolveTexture: async () => ROUND_TEXTURE,
      loadImage: async () => {
        throw new Error('贴图解码失败')
      },
      createCanvas: () => {
        const canvas = document.createElement('canvas')
        const ctx = new RecordingCtx(canvas)
        ctxs.push(ctx)
        return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D }
      },
    }
    setGemSpriteDepsForTests(deps)
    expect(requestGemSprite(BASE_REQUEST)).toBeNull()
    await flushAsync()
    expect(ctxs).toHaveLength(0) // 解码失败未进烘焙
    expect(requestGemSprite(BASE_REQUEST)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // [R5.2 走查 P2-1] 负缓存可重试（TTL）：走查实证「seed hydrate 晚于首渲染 → 永久
  // miss」——miss 不再永久；TTL 过期后重新解析，资产就位（晚播种/回收站找回）即烘焙。
  // -------------------------------------------------------------------------

  it('definitive miss：TTL 内不重打资产面；过期后重解析成功即烘焙', async () => {
    let texture: GemTextureSource | null = null // 可变资产位（晚播种模拟）
    const resolveTexture = vi.fn(async () => texture)
    const fakeBitmap = { toString: () => 'decoded-bitmap' } as unknown as CanvasImageSource
    setGemSpriteDepsForTests({
      resolveTexture,
      loadImage: async () => ({ image: fakeBitmap, width: 64, height: 64 }),
      createCanvas: () => {
        const canvas = document.createElement('canvas')
        const ctx = new RecordingCtx(canvas)
        return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D }
      },
    })
    vi.useFakeTimers()
    try {
      expect(requestGemSprite(BASE_REQUEST)).toBeNull()
      await flushAsync()
      expect(requestGemSprite(BASE_REQUEST)).toBeNull()
      expect(requestGemSprite({ ...BASE_REQUEST, state: 'hover' })).toBeNull()
      expect(resolveTexture).toHaveBeenCalledTimes(1) // TTL 内只打一次资产面

      // 晚播种：资产就位，但 TTL 未过 → 仍 miss
      texture = ROUND_TEXTURE
      expect(requestGemSprite(BASE_REQUEST)).toBeNull()
      await flushAsync()
      expect(resolveTexture).toHaveBeenCalledTimes(1)

      // TTL 过期（30s）→ 重新解析 → 烘焙 → 命中
      vi.setSystemTime(Date.now() + GEM_SPRITE_MISSING_RETRY_MS + 1)
      expect(requestGemSprite(BASE_REQUEST)).toBeNull() // 本帧仍回退（异步烘焙 kick）
      await flushAsync()
      expect(resolveTexture).toHaveBeenCalledTimes(2)
      expect(requestGemSprite(BASE_REQUEST)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('transient miss（解析 throw/未就绪）：短 TTL 重试——不长时间视同缺席', async () => {
    let attempts = 0
    const resolveTexture = vi.fn(async (): Promise<GemTextureSource | null> => {
      attempts += 1
      if (attempts === 1) throw new Error('资产库暂不可用')
      return ROUND_TEXTURE
    })
    const fakeBitmap = { toString: () => 'decoded-bitmap' } as unknown as CanvasImageSource
    setGemSpriteDepsForTests({
      resolveTexture,
      loadImage: async () => ({ image: fakeBitmap, width: 64, height: 64 }),
      createCanvas: () => {
        const canvas = document.createElement('canvas')
        const ctx = new RecordingCtx(canvas)
        return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D }
      },
    })
    vi.useFakeTimers()
    try {
      expect(requestGemSprite(BASE_REQUEST)).toBeNull()
      await flushAsync()
      expect(requestGemSprite(BASE_REQUEST)).toBeNull() // miss 登记（transient 短 TTL）
      vi.setSystemTime(Date.now() + GEM_SPRITE_TRANSIENT_RETRY_MS + 1)
      expect(requestGemSprite(BASE_REQUEST)).toBeNull()
      await flushAsync()
      expect(attempts).toBe(2)
      expect(requestGemSprite(BASE_REQUEST)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// [R2.2 Test] DesignerCanvas 渲染换肤断言（design §1.1/§2）：jsdom 无真光栅——
// getContext 打桩为 RecordingCtx（调用序列 spy）+ sprite 依赖注入，断言：
// ①钻本体全走 drawImage(sprite)（零 arc 几何符号路径）②渲染循环零逐钻 filter
// （shadow* 零写入——投影/发光烘焙进帧）③三态帧选择（selected>hover>normal、
// 框选收集预览、拖移 ghost）④画笔/橡皮光标 = 钻形 footprint（空心圆盘+中心点，
// 规格切换即时变化）⑤missing 回退几何符号（arc 路径保留）。真帧视觉归走查门。
// ---------------------------------------------------------------------------

describe('R2.2 画布换肤（DesignerCanvas 渲染断言）', () => {
  const GEMS = 3 // hexGems(3)：(4,4)/(12,4)/(20,4) 全在 64×64 画幅内

  /** 未卸载挂载的兜底回收（断言抛出时不泄漏 canvas 到后续用例的 document.querySelector）。 */
  const pendingUnmounts: Array<() => void> = []
  afterEach(() => {
    while (pendingUnmounts.length > 0) pendingUnmounts.pop()!()
  })

  function setupRenderEnv(): void {
    resetEditForTests()
    resetWorkbenchForTests()
    loadFromHandoff(makeHandoff(GEMS))
    makeDeps(ROUND_TEXTURE) // 注入 sprite 依赖（resolver/解码/离屏画布替身）
  }

  function mountCanvas(): {
    mainCtx: () => RecordingCtx | undefined
    canvas: () => HTMLCanvasElement | null
    unmount: () => void
  } {
    const ctxByCanvas = new Map<HTMLCanvasElement, RecordingCtx>()
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function patched(this: HTMLCanvasElement) {
      let ctx = ctxByCanvas.get(this)
      if (ctx === undefined) {
        ctx = new RecordingCtx(this)
        ctxByCanvas.set(this, ctx)
      }
      return ctx as unknown as CanvasRenderingContext2D
    } as unknown as typeof HTMLCanvasElement.prototype.getContext
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(DesignerCanvas, { target })
    const canvas = () => target.querySelector<HTMLCanvasElement>('[data-testid="designer-canvas-canvas"]')
    const mainCtx = (): RecordingCtx | undefined => {
      const cv = canvas()
      if (cv === null) return undefined
      let ctx = ctxByCanvas.get(cv)
      if (ctx === undefined) {
        ctx = new RecordingCtx(cv)
        ctxByCanvas.set(cv, ctx)
      }
      return ctx
    }
    const unmount = (): void => {
      unmountComponent(app)
      target.remove()
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
    pendingUnmounts.push(unmount)
    return { mainCtx, canvas, unmount }
  }

  /** 与组件 gemSpriteFor 同参取帧（断言侧复算 key 与 frame canvas 身份）。 */
  function frameOf(gem: DesignerGem, state: 'normal' | 'hover' | 'selected') {
    const doc = getEditDoc()
    if (doc === null) return null
    return requestGemSprite({
      specKey: 'round-ss10',
      diameterPx: gem.diameterMm * doc.grid.pixelsPerMm,
      dpr: window.devicePixelRatio || 1,
      state,
      tintHex: findPaletteColor(doc.palette, gem.colorId)?.hex ?? null,
    })
  }

  async function settle(): Promise<void> {
    await tick()
    await flushAsync()
    await tick()
  }

  /** 触发一次净重绘（视图态同值重赋——不改 hover/选中/光标语义；log 切片断言用）。 */
  async function redrawOnce(): Promise<void> {
    setViewState({ ...getViewState() })
    await tick()
  }

  it('钻本体全走 sprite drawImage：零 arc 几何符号路径 + 渲染循环零逐钻 filter', async () => {
    setupRenderEnv()
    const h = mountCanvas()
    await settle()
    const doc = getEditDoc()!
    const ctx = h.mainCtx()
    expect(ctx).toBeDefined()
    const mark = ctx!.mark()
    await redrawOnce()
    // 每颗可见钻一次 drawImage(sprite)（源 = 帧 canvas 身份）
    const frameSources = new Set<unknown>(doc.gems.map((g) => frameOf(g, 'normal')?.canvas))
    const gemDraws = ctx!.callsSince(mark).filter((c) => c.op === 'drawImage' && frameSources.has(c.source))
    expect(gemDraws).toHaveLength(GEMS)
    // 零 arc 符号路径（本体/选中环/光标均未触发几何路径）
    expect(ctx!.callsSince(mark).filter((c) => c.op === 'arc')).toHaveLength(0)
    // 零逐钻 filter：shadow* 全部烘焙进帧（主画布 ctx 无 shadow 写入）
    expect(ctx!.stylesSince(mark).filter((s) => s.prop.startsWith('shadow'))).toHaveLength(0)
    h.unmount()
  })

  it('selected 三态消费：选中钻换 selected 帧（发光即选中反馈——选中环零补绘）', async () => {
    setupRenderEnv()
    const h = mountCanvas()
    await settle()
    const doc = getEditDoc()!
    const gem = doc.gems[1]!
    setSelection([gem.id])
    await settle()
    const ctx = h.mainCtx()!
    const selectedFrame = frameOf(gem, 'selected')
    expect(selectedFrame).not.toBeNull()
    const mark = ctx.mark()
    await redrawOnce()
    const since = ctx.callsSince(mark)
    expect(since.filter((c) => c.op === 'drawImage' && c.source === selectedFrame!.canvas)).toHaveLength(1)
    expect(gemSpriteCacheKeys()).toContain(selectedFrame!.key)
    expect(since.filter((c) => c.op === 'arc')).toHaveLength(0) // 选中环零补绘（帧内发光承担）
    h.unmount()
  })

  it('hover 态接线：select 工具悬停命中 → hover 帧（pointermove 节流通道）', async () => {
    setupRenderEnv()
    const h = mountCanvas()
    await settle()
    const doc = getEditDoc()!
    const gem = doc.gems[2]!
    const v = getViewState() // jsdom rect=0：client = view.x + imgX·scale
    h.canvas()!.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: v.x + gem.x * v.scale,
        clientY: v.y + gem.y * v.scale,
        pointerId: 9,
        pointerType: 'mouse',
      }),
    )
    await settle()
    const ctx = h.mainCtx()!
    const hoverFrame = frameOf(gem, 'hover')
    expect(hoverFrame).not.toBeNull()
    const mark = ctx.mark()
    await redrawOnce()
    expect(
      ctx.callsSince(mark).some((c) => c.op === 'drawImage' && c.source === hoverFrame!.canvas),
    ).toBe(true)
    h.unmount()
  })

  it('框选收集预览：marquee 内钻以 selected 帧预览（与提交路径同判据）', async () => {
    setupRenderEnv()
    const h = mountCanvas()
    await settle()
    setMarquee({ x0: 0, y0: 0, x1: 64, y1: 64 })
    await settle()
    const doc = getEditDoc()!
    const ctx = h.mainCtx()!
    const mark = ctx.mark()
    await redrawOnce()
    const since = ctx.callsSince(mark)
    for (const gem of doc.gems) {
      const frame = frameOf(gem, 'selected')
      expect(frame).not.toBeNull()
      expect(since.some((c) => c.op === 'drawImage' && c.source === frame!.canvas)).toBe(true)
    }
    h.unmount()
  })

  it('拖移 ghost：sprite 半透明副本按 Δ 偏移绘制（copy = selected 帧区分）', async () => {
    setupRenderEnv()
    const h = mountCanvas()
    await settle()
    const doc = getEditDoc()!
    const gem = doc.gems[0]!
    setSelection([gem.id])
    await settle()
    const mark = h.mainCtx()!.mark()
    setMovePreview({ dx: 5, dy: 3, copy: false })
    await settle()
    const ctx = h.mainCtx()!
    const frame = frameOf(gem, 'normal')!
    const ghostDraw = ctx
      .callsSince(mark)
      .find((c) => c.op === 'drawImage' && c.source === frame.canvas && c.args[0] === gem.x + 5 - frame.size / 2)
    expect(ghostDraw).toBeDefined()
    expect(ghostDraw!.args[1]).toBe(gem.y + 3 - frame.size / 2)
    h.unmount()
  })

  it('笔刷光标 = 笔刷圆盘 footprint：空心圆盘+中心点，规格切换即时变化（默认跟随）；橡皮同圈红色', async () => {
    setupRenderEnv()
    const h = mountCanvas()
    await settle()
    // 基准规格 SS10（2.8mm × 2.5px/mm）→ 半径 3.5；圆盘 + 中心点 = 2 次 arc
    // [R3.2 显式更新] 光标直径改消费 brushSettings（默认=跟随规格径）——规格切换仍即时变化
    let mark = h.mainCtx()!.mark()
    setTool('draw')
    setBrushCursor({ x: 30, y: 30 })
    await settle()
    let arcs = h.mainCtx()!.callsSince(mark).filter((c) => c.op === 'arc')
    expect(arcs).toHaveLength(2)
    expect(arcs[0]!.args[2]).toBe(3.5)
    expect(arcs[1]!.args[2]).toBeGreaterThan(0)
    // 规格切换即时变化（默认跟随态）：4.0mm → 半径 5（可发现性——design §2）
    mark = h.mainCtx()!.mark()
    setBrushSpec({ shapeId: 'round', diameterMm: 4, colorId: getEditDoc()!.palette[0]!.id })
    setBrushCursor({ x: 31, y: 30 })
    await settle()
    arcs = h.mainCtx()!.callsSince(mark).filter((c) => c.op === 'arc')
    expect(arcs).toHaveLength(2)
    expect(arcs[0]!.args[2]).toBe(5)
    // 橡皮：同 footprint 同圈（R3.2——批量擦除与所见光标一致）+ 破坏性红圈 + 中心点
    mark = h.mainCtx()!.mark()
    setTool('erase')
    setBrushCursor({ x: 32, y: 30 })
    await settle()
    const ctx = h.mainCtx()!
    const since = ctx.callsSince(mark)
    const eraseArcs = since.filter((c) => c.op === 'arc')
    expect(eraseArcs).toHaveLength(2)
    expect(eraseArcs[0]!.args[2]).toBe(5) // 跟随规格径 4.0mm（同盘——替换旧恒钻径 3.5）
    expect(ctx.stylesSince(mark).some((s) => s.prop === 'strokeStyle' && s.value === 'rgba(220,38,38,0.9)')).toBe(true)
    h.unmount()
  })

  it('missing 回退：sprite 资产缺席时钻本体回退几何符号（arc 路径保留）', async () => {
    resetEditForTests()
    resetWorkbenchForTests()
    loadFromHandoff(makeHandoff(GEMS))
    setGemSpriteDepsForTests(null) // 生产依赖（jsdom 无 IDB → missing 负缓存）
    const h = mountCanvas()
    await settle()
    const ctx = h.mainCtx()!
    const mark = ctx.mark()
    await redrawOnce()
    expect(ctx.callsSince(mark).filter((c) => c.op === 'arc')).toHaveLength(GEMS) // 每钻一个几何圆（回退路径）
    h.unmount()
  })
})
