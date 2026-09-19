/**
 * 快速排稿契约（openspec add-project-files design §4 / tasks 3.1）：
 * 默认参快照（同图同参同出 + 与 buildManualEditHandoff 同参同出——同构性的最强证据）/
 * 载荷字段齐全（gems/blocks/grid/palette/painting/provenance）/ progress 与取消传播
 * （预取消 + 首进度事件取消）/ 参数固定断言（API 导出面白名单 + 冻结常量，不暴露参数入口）/
 * 解码链降采样（>1024px 缩到 1024）与坏图显式失败。
 *
 * 环境声明：jsdom 的 canvas 2d / Image 解码均不可用 → 本文件自带最小桩
 * （Image 立即 onload 带尺寸；canvas 2d 软桩 drawImage no-op + getImageData 返回固定
 * fixture 像素——96×64 双矩形硬边图，与 engine helpers.fixtureTwoRects 同构本地副本）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as quickLayoutModule from '$lib/edit/quickLayout'
import {
  QUICK_LAYOUT_PARAMS,
  quickLayoutFromImage,
  type QuickLayoutResult,
} from '$lib/edit/quickLayout'
import { SS_TABLE, STARTER_PALETTE } from '$lib/engine'
import type { EngineImage } from '$lib/engine'
import {
  buildManualEditHandoff,
  loadFromEngineImage,
  resetStudioForTests,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { ComputeAbortedError } from '$lib/workers/computeCore'

// ---------------------------------------------------------------------------
// fixture：96×64 双矩形硬边图（左半红右半黑——确定性分块；与 studio 交叉对照共用同一像素）
// ---------------------------------------------------------------------------

const RED: [number, number, number] = [200, 16, 46]
const BLACK: [number, number, number] = [26, 26, 26]

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

const FIXTURE_W = 96
const FIXTURE_H = 64
const FIXTURE = twoRects(FIXTURE_W, FIXTURE_H)

// ---------------------------------------------------------------------------
// 解码桩（studioAssetIntegration 同式：OkImage + 软 canvas 2d）
// ---------------------------------------------------------------------------

interface DecodeStubOptions {
  naturalWidth?: number
  naturalHeight?: number
  fail?: boolean
}

let lastGetImageDataSize: { w: number; h: number } | null = null
let restoreCanvasCtx: (() => void) | null = null

function installDecodeStub(options: DecodeStubOptions = {}): void {
  vi.unstubAllGlobals()
  restoreCanvasCtx?.()
  const width = options.naturalWidth ?? FIXTURE_W
  const height = options.naturalHeight ?? FIXTURE_H

  class OkImage {
    naturalWidth = width
    naturalHeight = height
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => {
        if (options.fail) this.onerror?.()
        else this.onload?.()
      })
    }
  }
  class FailImage {
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onerror?.())
    }
  }
  vi.stubGlobal('Image', options.fail ? FailImage : OkImage)

  const ctxStub = {
    drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      lastGetImageDataSize = { w, h }
      // 请求尺寸与 fixture 一致 → 返回 fixture 像素；否则返回纯红面（降采样断言用）
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
    },
  }
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext
  restoreCanvasCtx = () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  }
}

const PNG_BLOB = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

beforeEach(() => {
  installDecodeStub()
})

afterEach(() => {
  restoreCanvasCtx?.()
  restoreCanvasCtx = null
  vi.unstubAllGlobals()
  resetStudioForTests()
})

// ---------------------------------------------------------------------------
// 默认参快照与载荷
// ---------------------------------------------------------------------------

describe('quickLayout 默认参快照', () => {
  it('同图同参同出：两次调用载荷逐字段相等（确定性引擎 + 固定种子）', async () => {
    const first = await quickLayoutFromImage(PNG_BLOB)
    const second = await quickLayoutFromImage(PNG_BLOB)
    expect(second.handoff.gems).toEqual(first.handoff.gems)
    expect(second.handoff.blocks).toEqual(first.handoff.blocks)
    expect(second.handoff.palette).toEqual(first.handoff.palette)
    expect(second.handoff.grid).toEqual(first.handoff.grid)
    expect(second.handoff.width).toBe(first.handoff.width)
    expect(second.handoff.height).toBe(first.handoff.height)
    expect(second.handoff.sourceSummary).toBe(first.handoff.sourceSummary)
    expect(Array.from(second.handoff.paintingSnapshot.data)).toEqual(
      Array.from(first.handoff.paintingSnapshot.data),
    )
    expect(second.provenance).toEqual(first.provenance)
  })

  it('provenance.origin = quick-layout，sourceSummary 与 handoff 同源', async () => {
    const { handoff, provenance } = await quickLayoutFromImage(PNG_BLOB)
    expect(provenance.origin).toBe('quick-layout')
    expect(provenance.sourceSummary).toBe(handoff.sourceSummary)
  })

  it('载荷字段齐全：gems/blocks/grid/palette/painting + 全钻色板映射 + 块引用闭合', async () => {
    const { handoff } = await quickLayoutFromImage(PNG_BLOB)
    expect(handoff.gems.length).toBeGreaterThan(0)
    expect(handoff.blocks.length).toBeGreaterThan(0)
    // 冻结默认参的可见面：SS10@2.5px/mm、gap 0.4 → pitch = SS_TABLE.SS10+0.4；行角字面量 0
    expect(handoff.grid).toEqual({
      ss: 'SS10',
      pitchMm: SS_TABLE.SS10 + 0.4,
      rowAngleDeg: 0,
      pixelsPerMm: 2.5,
    })
    expect(handoff.width).toBe(FIXTURE_W)
    expect(handoff.height).toBe(FIXTURE_H)
    expect(handoff.paintingSnapshot.width).toBe(FIXTURE_W)
    expect(handoff.paintingSnapshot.height).toBe(FIXTURE_H)
    expect(Array.from(handoff.paintingSnapshot.data)).toEqual(Array.from(FIXTURE.data))
    // 色板 = 起步色板；全钻 colorId 均已映射（mapColors 最近邻）
    expect(handoff.palette).toEqual(STARTER_PALETTE)
    const paletteIds = new Set(handoff.palette.map((c) => c.id))
    for (const gem of handoff.gems) {
      expect(paletteIds.has(gem.colorId)).toBe(true)
    }
    const blockIds = new Set(handoff.blocks.map((b) => b.id))
    for (const gem of handoff.gems) {
      expect(blockIds.has(gem.blockId)).toBe(true)
    }
    // 来源摘要 = studio currentSourceSummary 同式
    expect(handoff.sourceSummary).toBe(
      `语义混合 · 密度 100% · SS10 · ${handoff.gems.length} 钻`,
    )
    // 本路径无参考图：referenceAssetId 缺席（键不存在，而非 null）
    expect('referenceAssetId' in handoff).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 与 buildManualEditHandoff 的同构性（design §4：默认参与 studio 初始态同参——同图同出）
// ---------------------------------------------------------------------------

describe('quickLayout ↔ buildManualEditHandoff 同构', () => {
  it('同图同参同出：quickLayout 载荷与 studio 初始态全参重算的 handoff 逐字段相等', async () => {
    // studio 初始态（resetStudioForTests 后）：k=8/seed=1/SS10/gap0.4/密度100%/relax 关/hybrid
    const copy: EngineImage = { width: FIXTURE.width, height: FIXTURE.height, data: new Uint8ClampedArray(FIXTURE.data) }
    loadFromEngineImage(copy, '双矩形.png', 'upload')
    await waitForStudioIdle()
    const studioHandoff = buildManualEditHandoff()
    expect(studioHandoff).not.toBeNull()

    const { handoff } = await quickLayoutFromImage(PNG_BLOB)
    expect(handoff.gems).toEqual(studioHandoff?.gems)
    expect(handoff.blocks).toEqual(studioHandoff?.blocks)
    expect(handoff.palette).toEqual(studioHandoff?.palette)
    expect(handoff.grid).toEqual(studioHandoff?.grid)
    expect(handoff.width).toBe(studioHandoff?.width)
    expect(handoff.height).toBe(studioHandoff?.height)
    expect(handoff.sourceSummary).toBe(studioHandoff?.sourceSummary)
    expect(Array.from(handoff.paintingSnapshot.data)).toEqual(
      Array.from(studioHandoff?.paintingSnapshot.data ?? new Uint8ClampedArray(0)),
    )
    // 差异面唯一：studio 侧恒写 referenceAssetId 键（无参考图时值为 undefined），
    // quickLayout 侧键缺席——剔除 undefined 键后两路径形状一致（JSON 形态等价）
    const studioDefinedKeys = Object.entries(studioHandoff ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .sort()
    expect(Object.keys(handoff).sort()).toEqual(studioDefinedKeys)
  })
})

// ---------------------------------------------------------------------------
// progress 与取消传播
// ---------------------------------------------------------------------------

describe('quickLayout progress 与取消传播', () => {
  it('onProgress 直通 computeClient 阶段事件：segment → layout:hybrid → done（done 单调）', async () => {
    const events: Array<{ stage: string; done: number; total: number }> = []
    await quickLayoutFromImage(PNG_BLOB, {
      onProgress: (p) => events.push({ stage: p.stage, done: p.done, total: p.total }),
    })
    expect(events.map((e) => e.stage)).toEqual(['segment', 'layout:hybrid', 'done'])
    expect(events.map((e) => e.done)).toEqual([0, 1, 2])
    expect(events.every((e) => e.total === 2)).toBe(true)
  })

  it('预取消（signal 已 abort）：直接拒绝 ComputeAbortedError，不产生任何进度事件', async () => {
    const controller = new AbortController()
    controller.abort()
    const events: unknown[] = []
    const error = await captureRejection(
      quickLayoutFromImage(PNG_BLOB, {
        signal: controller.signal,
        onProgress: () => events.push(1),
      }),
    )
    expect(error).toBeInstanceOf(ComputeAbortedError)
    expect(events).toEqual([])
  })

  it('计算中取消（首个进度事件 abort）：拒绝 ComputeAbortedError，done 事件不达', async () => {
    const controller = new AbortController()
    const events: string[] = []
    const error = await captureRejection(
      quickLayoutFromImage(PNG_BLOB, {
        signal: controller.signal,
        onProgress: (p) => {
          events.push(p.stage)
          if (p.stage === 'segment') controller.abort()
        },
      }),
    )
    expect(error).toBeInstanceOf(ComputeAbortedError)
    expect(events).toEqual(['segment'])
  })
})

// ---------------------------------------------------------------------------
// 参数固定（API 形状上不暴露参数入口——概念混入禁令）
// ---------------------------------------------------------------------------

describe('quickLayout 参数固定', () => {
  it('模块导出面 = 白名单（quickLayoutFromImage + 冻结常量；类型导出运行时不占位）', () => {
    expect(Object.keys(quickLayoutModule).sort()).toEqual(['QUICK_LAYOUT_PARAMS', 'quickLayoutFromImage'])
  })

  it('QUICK_LAYOUT_PARAMS 冻结且与 studio 初始态同参（k=8/seed=1/SS10/gap0.4/密度100%/hybrid）', () => {
    expect(Object.isFrozen(QUICK_LAYOUT_PARAMS)).toBe(true)
    expect(Object.isFrozen(QUICK_LAYOUT_PARAMS.relax)).toBe(true)
    expect(QUICK_LAYOUT_PARAMS).toEqual({
      k: 8,
      seed: 1,
      layoutSeed: 1,
      ss: 'SS10',
      gapMm: 0.4,
      globalDensity: 1,
      strategy: 'hybrid',
      relax: { boundary: false, repulsion: false },
    })
  })

  it('载荷 grid/summary 由冻结参数决定（不接受调用方覆写——选项面只有 onProgress/signal）', async () => {
    const { handoff } = await quickLayoutFromImage(PNG_BLOB, { onProgress: undefined, signal: undefined })
    expect(handoff.grid.ss).toBe(QUICK_LAYOUT_PARAMS.ss)
    expect(handoff.grid.pitchMm).toBeCloseTo(3.2, 10)
    expect(handoff.sourceSummary).toContain('密度 100%')
    expect(handoff.sourceSummary).toContain('SS10')
  })
})

// ---------------------------------------------------------------------------
// 解码链（imageToEngineImage 同构：≤1024 降采样；坏图显式失败）
// ---------------------------------------------------------------------------

describe('quickLayout 解码链', () => {
  it('大图（2048×1024）降采样到 1024×512：paintingSnapshot 取降采后尺寸', async () => {
    installDecodeStub({ naturalWidth: 2048, naturalHeight: 1024 })
    const { handoff } = await quickLayoutFromImage(PNG_BLOB)
    expect(handoff.width).toBe(1024)
    expect(handoff.height).toBe(512)
    expect(handoff.paintingSnapshot.width).toBe(1024)
    expect(lastGetImageDataSize).toEqual({ w: 1024, h: 512 })
  })

  it('坏图（解码失败）：显式拒绝（不落成空文档）', async () => {
    installDecodeStub({ fail: true })
    const error = await captureRejection(quickLayoutFromImage(PNG_BLOB))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('图片解码失败')
  })
})

/** 异步捕获：返回 Promise 拒绝的错误实例（断言链保留字段访问）。 */
async function captureRejection(promise: Promise<QuickLayoutResult>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('预期拒绝但已兑现')
}
