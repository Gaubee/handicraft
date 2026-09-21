/*
 * [2026-09-21 rework-designer-manual-rhinestone R2.1 Test] 水钻贴图 sprite 烘焙管线
 * （design §1.1/§1.2）：jsdom 无真光栅——经依赖注入面（Image 工厂/离屏画布工厂/纹理
 * resolver）断言：三态烘焙 op 序列（含方案 A multiply 着色链）、LRU 逐出、missing 负缓存、
 * miss→异步烘焙→就绪通知→二次取帧、cache 键维度（specKey/直径/dpr/态/着色）。
 * 真帧视觉归走查门（设计明示 jsdom 不可测真帧率/真光栅）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  gemSpriteKeyOf,
  gemSpriteCacheKeys,
  GEM_SPRITE_CACHE_LIMIT,
  onGemSpritesChanged,
  requestGemSprite,
  resetGemSpritesForTests,
  setGemSpriteDepsForTests,
  type DecodedTexture,
  type GemSpriteDeps,
  type GemTextureSource,
} from '$lib/designer/gemSprites'

// ---------------------------------------------------------------------------
// 录制 ctx（canvas 2d 替身——烘焙 op 序列断言面）
// ---------------------------------------------------------------------------

interface RecordedCall {
  op: 'drawImage' | 'fillRect' | 'setTransform'
  source?: unknown
  args: unknown[]
}

class RecordingCtx {
  #fillStyle = ''
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
  drawImageCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.op === 'drawImage')
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
})
