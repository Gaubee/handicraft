/*
 * [rework-layer-model 1.1] cutout 抠图层合成管线单元测试：
 *   [A] 缓存键内容寻址（baseImageRef/maskRef/bbox 任一变化=新键）；
 *   [B] 纯合成面（stub 上下文）：drawImage 源区域=bbox、destination-in 通路、
 *       mask alpha 位图按位面采样（上采样场景）；
 *   [C] requestCutouts：缓存命中（同键不重合成+canvas 身份稳定）/失效（maskRef 换键
 *       重合成）/缩略图派生（≤48px 高）；
 *   [D] LRU 逐出（>96 键最旧逐出+持有条目降级 idle）；
 *   [E] 坏输入降级：mask 位面长度错→error（不炸批）、原图不可解码→error、
 *       环境无 canvas→idle 静默。
 *   [F] v4 修复轮 F4（Codex P1-4）：请求集收缩（隐藏层出集——store 按可见集传入）
 *       =条目释放 idle+重显示同键热命中；LRU 字节预算（4K 级位图超 512MiB 逐出最旧）。
 * jsdom 无 2d canvas——宿主注入 stub（cutoutRuntime.host，同 perf.gate stub 先例）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectNode } from '@handicraft/contracts'
import type { MaskBits, MaskEntry } from '$lib/components/studio/taskWorkbench/maskBits.svelte.js'
import {
  assertMaskBitsHealthy,
  composeCutoutSurfaces,
  cutoutKey,
  CUTOUT_CACHE_MAX,
  getCutoutCacheBytes,
  getCutoutEntryOf,
  requestCutouts,
  resetCutoutsForTests,
  setCutoutCacheBytesMaxForTests,
  thumbSizeOf,
  type Cutout2dContext,
  type CutoutHost,
} from '$lib/components/studio/taskWorkbench/cutout.svelte.js'

// ---------------------------------------------------------------- stub 宿主

interface CtxCall {
  op: 'drawImage' | 'putImageData' | 'clearRect'
  args: number[]
}

interface StubCtx extends Cutout2dContext {
  calls: CtxCall[]
  lastPut: { data: Uint8ClampedArray } | null
}

interface StubCanvas {
  width: number
  height: number
  ctx: StubCtx
}

function makeStubCtx(): StubCtx {
  const ctx: StubCtx = {
    globalCompositeOperation: 'source-over',
    calls: [],
    lastPut: null,
    drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
      ctx.calls.push({ op: 'drawImage', args: [sx, sy, sw, sh, dx, dy, dw, dh] })
    },
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(w * h * 4) }
    },
    putImageData(image) {
      ctx.lastPut = image
      ctx.calls.push({ op: 'putImageData', args: [image.data.length / 4] })
    },
    clearRect() {
      ctx.calls.push({ op: 'clearRect', args: [] })
    },
  }
  return ctx
}

/** 合成计数（缓存命中断言锚——每次真合成 +1）。 */
let composeCount = 0
let noCanvas = false

const stubHost: CutoutHost = {
  createCanvas(): HTMLCanvasElement | null {
    if (noCanvas) return null
    const ctx = makeStubCtx()
    const canvas = { width: 0, height: 0, ctx } satisfies StubCanvas as unknown as HTMLCanvasElement
    return canvas
  },
  contextOf(canvas: HTMLCanvasElement): Cutout2dContext | null {
    return (canvas as unknown as StubCanvas).ctx
  },
  loadImage: async (): Promise<({ width: number; height: number } & unknown) | null> => {
    composeCount += 1
    return { width: 120, height: 160 }
  },
}

const READY_MASK: MaskEntry = {
  phase: 'ready',
  bits: { w: 2, h: 2, bits: new Uint8Array([1, 0, 0, 1]) },
  error: null,
  ref: 'blob:mask-a',
}

function nodeOf(id: string, bbox: { x: number; y: number; w: number; h: number }, overrides: Partial<ObjectNode> = {}): ObjectNode {
  return {
    id,
    objectName: id,
    category: 'clothing',
    mask: { kind: 'inline', w: 2, h: 2, dataBase64: '' },
    bbox,
    parent: 'root',
    children: [],
    effectiveMm: 10,
    labVariance: 8,
    drillWorthy: true,
    origin: 'test',
    ...overrides,
  } as ObjectNode
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  composeCount = 0
  noCanvas = false
  resetCutoutsForTests(stubHost)
})

afterEach(() => {
  resetCutoutsForTests()
})

// ---------------------------------------------------------------- [A] 缓存键

describe('cutout 缓存键（内容寻址）', () => {
  it('baseImageRef/maskRef/bbox 任一变化=新键；全同=同键', () => {
    const bbox = { x: 24, y: 28, w: 72, h: 104 }
    const base = cutoutKey('base-1', 'blob:mask-a', bbox)
    expect(cutoutKey('base-1', 'blob:mask-a', bbox)).toBe(base)
    expect(cutoutKey('base-2', 'blob:mask-a', bbox)).not.toBe(base)
    expect(cutoutKey('base-1', 'blob:mask-b', bbox)).not.toBe(base)
    expect(cutoutKey('base-1', 'blob:mask-a', { ...bbox, w: 73 })).not.toBe(base)
    expect(cutoutKey(null, 'inline:t:n', bbox)).not.toBe(base)
  })
})

// ---------------------------------------------------------------- [B] 纯合成面

describe('composeCutoutSurfaces（stub 上下文）', () => {
  it('drawImage 源区域=bbox、蒙版 alpha 按位面中心采样、destination-in 合入', () => {
    const ctx = makeStubCtx()
    const maskCtx = makeStubCtx()
    const image = { width: 120, height: 160 }
    // 2×2 位面对角 1，bbox 4×4 → 上采样：中心采样落在对角单元
    const bits: MaskBits = { w: 2, h: 2, bits: new Uint8Array([1, 0, 0, 1]) }
    composeCutoutSurfaces(ctx, maskCtx, { maskCanvas: true } as unknown as object, image, bits, { x: 10, y: 20, w: 4, h: 4 })

    // 主面：清屏+原图 bbox 区域绘制（源坐标 10,20,4,4 → 目标 0,0,4,4）
    const draws = ctx.calls.filter((call) => call.op === 'drawImage')
    expect(draws[0]?.args).toEqual([10, 20, 4, 4, 0, 0, 4, 4])
    // 蒙版面：alpha 位图 putImageData（4×4=16 像素）
    const put = maskCtx.calls.find((call) => call.op === 'putImageData')
    expect(put?.args[0]).toBe(16)
    expect(maskCtx.lastPut?.data.length).toBe(16 * 4)
    // 象限中心采样（4×4 ← 2×2 上采样）：左上象限=位面(0,0)=1、右上=位面(1,0)=0、
    // 左下=位面(0,1)=0、右下=位面(1,1)=1
    const alphaAt = (x: number, y: number): number => maskCtx.lastPut!.data[(y * 4 + x) * 4 + 3]!
    expect(alphaAt(0, 0)).toBe(255)
    expect(alphaAt(1, 1)).toBe(255)
    expect(alphaAt(2, 2)).toBe(255)
    expect(alphaAt(3, 0)).toBe(0)
    expect(alphaAt(0, 3)).toBe(0)
    expect(alphaAt(1, 2)).toBe(0)
    expect(alphaAt(2, 1)).toBe(0)
    // destination-in 合入蒙版画布（第二次 drawImage 目标 0,0,4,4）
    expect(draws[1]?.args).toEqual([0, 0, 4, 4, 0, 0, 4, 4])
    const gcoTimeline = maskCtx.globalCompositeOperation
    expect(gcoTimeline).toBe('source-over') // 蒙版面自身恒 source-over
    expect(draws.length).toBe(2)
  })

  it('assertMaskBitsHealthy：长度≠w*h typed 拒', () => {
    expect(() => assertMaskBitsHealthy({ w: 2, h: 2, bits: new Uint8Array([1, 0, 0]) })).toThrow(RangeError)
    expect(() => assertMaskBitsHealthy({ w: 0, h: 2, bits: new Uint8Array() })).toThrow(RangeError)
    expect(() => assertMaskBitsHealthy({ w: 1, h: 1, bits: new Uint8Array([1]) })).not.toThrow()
  })

  it('thumbSizeOf：高 ≤48 等比', () => {
    expect(thumbSizeOf(96, 96)).toEqual({ w: 48, h: 48 })
    expect(thumbSizeOf(24, 96)).toEqual({ w: 12, h: 48 })
    expect(thumbSizeOf(30, 30)).toEqual({ w: 30, h: 30 })
  })
})

// ---------------------------------------------------------------- [C] requestCutouts

describe('requestCutouts（缓存命中/失效/竞态）', () => {
  it('同键二次请求=缓存命中（不重合成，canvas 身份稳定）；缩略图随行派生', async () => {
    const node = nodeOf('n-hat', { x: 36, y: 28, w: 48, h: 30 })
    const opts = {
      baseImageUrl: 'data:image/png;base64,xxx',
      baseImageRef: 'base-1',
      getMaskEntry: () => READY_MASK,
    }
    requestCutouts([node], opts)
    expect(getCutoutEntryOf('n-hat').phase).toBe('loading')
    await flush()
    const first = getCutoutEntryOf('n-hat')
    expect(first.phase).toBe('ready')
    expect(first.canvas).not.toBeNull()
    expect(first.thumb).not.toBeNull()
    expect((first.canvas as unknown as StubCanvas).width).toBe(48)
    expect((first.thumb as unknown as StubCanvas).height).toBeLessThanOrEqual(48)
    expect(composeCount).toBe(1)

    // 二次（同键）——缓存命中：不重合成、canvas 同身份
    requestCutouts([node], opts)
    await flush()
    expect(composeCount).toBe(1)
    expect(getCutoutEntryOf('n-hat').canvas).toBe(first.canvas)
  })

  it('maskRef 变化（树推进）=新键重合成；bbox 变化同式', async () => {
    const node = nodeOf('n-hat', { x: 36, y: 28, w: 48, h: 30 })
    const maskB: MaskEntry = { ...READY_MASK, ref: 'blob:mask-b' }
    let current = READY_MASK
    const opts = {
      baseImageUrl: 'data:image/png;base64,xxx',
      baseImageRef: 'base-1',
      getMaskEntry: () => current,
    }
    requestCutouts([node], opts)
    await flush()
    expect(getCutoutEntryOf('n-hat').phase).toBe('ready')
    expect(composeCount).toBe(1)

    current = maskB
    requestCutouts([node], opts)
    await flush()
    expect(composeCount).toBe(2)
    expect(getCutoutEntryOf('n-hat').phase).toBe('ready')
  })

  it('根节点不合成（背景层=原图承担）；孤儿条目随树收缩', async () => {
    const root = nodeOf('root', { x: 0, y: 0, w: 120, h: 160 }, { parent: null })
    const child = nodeOf('n-hat', { x: 36, y: 28, w: 48, h: 30 })
    requestCutouts([root, child], { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: () => READY_MASK })
    await flush()
    expect(getCutoutEntryOf('root').phase).toBe('idle')
    expect(getCutoutEntryOf('n-hat').phase).toBe('ready')

    requestCutouts([], { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: () => READY_MASK })
    expect(getCutoutEntryOf('n-hat').phase).toBe('idle')
  })

  it('位面未就绪=等待（idle）不请求合成；mask error=entry error', async () => {
    const node = nodeOf('n-a', { x: 0, y: 0, w: 10, h: 10 })
    const loading: MaskEntry = { phase: 'loading', bits: null, error: null, ref: 'blob:x' }
    requestCutouts([node], { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: () => loading })
    await flush()
    expect(getCutoutEntryOf('n-a').phase).toBe('idle')
    expect(composeCount).toBe(0)

    const bad: MaskEntry = { phase: 'error', bits: null, error: '长度 3 ≠ 4', ref: 'blob:bad' }
    requestCutouts([node], { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: () => bad })
    await flush()
    const entry = getCutoutEntryOf('n-a')
    expect(entry.phase).toBe('error')
    expect(entry.error).toContain('mask 位面坏')
    expect(composeCount).toBe(0)
  })
})

// ---------------------------------------------------------------- [D] LRU

describe('cutout LRU（96 上界）', () => {
  it('第 97 键合成后最旧键逐出；持有该位图的条目降级 idle', async () => {
    const nodes: ObjectNode[] = []
    const masks = new Map<string, MaskEntry>()
    for (let i = 0; i < CUTOUT_CACHE_MAX + 1; i += 1) {
      const id = `n-${i}`
      // bbox 逐个不同 → 键逐个不同（同 maskRef 也可——bbox 是键成分）
      nodes.push(nodeOf(id, { x: i, y: 0, w: 8, h: 8 }))
      masks.set(id, { ...READY_MASK, ref: `blob:m${i % 7}` })
    }
    requestCutouts(nodes, {
      baseImageUrl: 'u',
      baseImageRef: 'b',
      getMaskEntry: (id) => masks.get(id) ?? READY_MASK,
    })
    await flush()
    // 第 97 键入缓存→逐出最旧 1 条（n-0：位图被逐→其条目降级 idle）；
    // n-1 仍在缓存内（ready）；最新 n-96 ready
    expect(getCutoutEntryOf('n-0').phase).toBe('idle')
    expect(getCutoutEntryOf('n-1').phase).toBe('ready')
    expect(getCutoutEntryOf('n-96').phase).toBe('ready')
  }, 20_000)
})

// ---------------------------------------------------------------- [E] 降级

describe('cutout 降级（坏输入不炸批）', () => {
  it('位面长度错（合成期发现）→该层 error，其余层照常 ready', async () => {
    const good = nodeOf('n-good', { x: 0, y: 0, w: 4, h: 4 })
    const bad = nodeOf('n-bad', { x: 8, y: 0, w: 4, h: 4 })
    const badMask: MaskEntry = {
      phase: 'ready',
      bits: { w: 3, h: 3, bits: new Uint8Array(8) }, // 长度≠w*h——合成期 assert 拒
      error: null,
      ref: 'blob:badbits',
    }
    const byId = new Map<string, MaskEntry>([
      ['n-good', READY_MASK],
      ['n-bad', badMask],
    ])
    requestCutouts([good, bad], { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: (id) => byId.get(id)! })
    await flush()
    expect(getCutoutEntryOf('n-bad').phase).toBe('error')
    expect(getCutoutEntryOf('n-bad').error).toContain('≠')
    expect(getCutoutEntryOf('n-good').phase).toBe('ready')
  })

  it('原图不可解码→error（背景层不连带）', async () => {
    const node = nodeOf('n-x', { x: 0, y: 0, w: 4, h: 4 })
    const failHost: CutoutHost = { ...stubHost, loadImage: async () => null }
    resetCutoutsForTests(failHost)
    requestCutouts([node], { baseImageUrl: 'broken', baseImageRef: 'b', getMaskEntry: () => READY_MASK })
    await flush()
    expect(getCutoutEntryOf('n-x').phase).toBe('error')
    expect(getCutoutEntryOf('n-x').error).toContain('原图不可解码')
  })

  it('环境无 2d canvas（jsdom 形态）→idle 静默缺位（不 error 不炸）', async () => {
    const node = nodeOf('n-y', { x: 0, y: 0, w: 4, h: 4 })
    noCanvas = true
    requestCutouts([node], { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: () => READY_MASK })
    await flush()
    const entry = getCutoutEntryOf('n-y')
    expect(entry.phase).toBe('idle')
    expect(entry.canvas).toBeNull()
  })
})

// ---------------------------------------------------------------- [F] F4：请求集收缩+字节预算

describe('cutout F4（不可见层不合成+LRU 字节预算——Codex P1-4）', () => {
  it('请求集收缩（隐藏层出集）=条目释放 idle；重显示同键热命中（0 重合成）', async () => {
    const hat = nodeOf('n-hat', { x: 36, y: 28, w: 48, h: 30 })
    const face = nodeOf('n-face', { x: 38, y: 64, w: 44, h: 36 })
    const opts = { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: () => READY_MASK }
    // 可见集=[hat, face]——两份合成
    requestCutouts([hat, face], opts)
    await flush()
    expect(getCutoutEntryOf('n-hat').phase).toBe('ready')
    expect(getCutoutEntryOf('n-face').phase).toBe('ready')
    expect(composeCount).toBe(2)

    // 隐藏 hat（store.requestCutoutsForTree 按 hiddenDeep 过滤后传 [face]）——
    // 条目面收缩：entry 引用释放（idle）；缓存保留（内容寻址有界——非泄漏）
    requestCutouts([face], opts)
    expect(getCutoutEntryOf('n-hat').phase).toBe('idle')
    await flush()
    expect(composeCount).toBe(2)

    // 重新显示 hat——同键热命中：不重合成，entry 恢复 ready 且 canvas 同身份
    const before = getCutoutEntryOf('n-face').canvas
    requestCutouts([hat, face], opts)
    await flush()
    expect(composeCount).toBe(2)
    expect(getCutoutEntryOf('n-hat').phase).toBe('ready')
    expect(getCutoutEntryOf('n-face').canvas).toBe(before)
  })

  it('字节预算：超限逐出最旧（测试注入 1MiB 小预算——产品默认 512MiB 同式）', async () => {
    // 256×256 主位图=256KiB+缩略≈256KiB/张；预算 1MiB=4 张——第 5 张入缓存后
    // 超限逐出最旧（big-0 位图→条目降级 idle），bytes 回到 ≤1MiB
    setCutoutCacheBytesMaxForTests(1024 * 1024)
    const perLayerBytes = 256 * 256 * 4 + 48 * 48 * 4
    const nodes: ObjectNode[] = []
    const masks = new Map<string, MaskEntry>()
    for (let i = 0; i < 5; i += 1) {
      const id = `big-${i}`
      nodes.push(nodeOf(id, { x: i, y: 0, w: 256, h: 256 }))
      masks.set(id, { ...READY_MASK, ref: `blob:big-${i}` })
    }
    requestCutouts(nodes, { baseImageUrl: 'u', baseImageRef: 'b', getMaskEntry: (id) => masks.get(id)! })
    await flush()
    // 5 张 ≈1.29MiB > 1MiB → 逐出最旧 2 张（big-0/big-1 位图→条目降级 idle）→ 3 张回界内
    expect(getCutoutCacheBytes()).toBeLessThanOrEqual(1024 * 1024)
    expect(getCutoutCacheBytes()).toBeGreaterThanOrEqual(perLayerBytes * 3 - 1024)
    expect(getCutoutEntryOf('big-0').phase).toBe('idle')
    expect(getCutoutEntryOf('big-1').phase).toBe('idle')
    expect(getCutoutEntryOf('big-2').phase).toBe('ready')
    expect(getCutoutEntryOf('big-4').phase).toBe('ready')
    // 默认预算还原（afterEach resetCutoutsForTests 同式——显式断言防漏）
    resetCutoutsForTests(stubHost)
    expect(getCutoutCacheBytes()).toBe(0)
  })
})
