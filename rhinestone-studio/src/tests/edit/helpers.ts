/*
 * [2026-09-19 Test] 专家工作台测试共用手具：程序化 ManualEditHandoff（满幅单块 + 六方格位钻）。
 * 脱离 studio 管线构造交接快照——edit store 单测不需要跑 segment/layout。
 * [2026-09-20 studio-layers 1.4] + installCodecStubEnv：jsdom canvas/Image 编解码桩
 * （editUnbound.test 同式合体——ctx 位图 / toDataURL「8 字节宽高头 + RGBA」/ Image 解码回读；
 * 供 handoff v2 的 gemdoc round-trip 与 quickLayout 兼容例复用）。
 */

import { vi } from 'vitest'
import { STARTER_PALETTE, gridFromSs, type Block, type EngineImage, type Gem, type GridSpec } from '$lib/engine'
import type { ManualEditHandoff } from '$lib/stores/edit.svelte'

export const TEST_PITCH = 8 // SS10 + 2.5px/mm + gap 0.4 → pitch 8px（引擎标准网格）

export function testGrid(): GridSpec {
  return gridFromSs('SS10', 2.5)
}

/** 满幅单块（0,0,w,h 全 1 掩码；编辑器只读参考用，几何细节不影响 store 语义测试） */
export function fullBlock(w: number, h: number, id = 'blk-1'): Block {
  return {
    id,
    label: `测试块 ${id}`,
    mask: { w, h, bits: new Uint8Array(w * h).fill(1) },
    colorRgb: [200, 16, 46],
    areaPx: w * h,
    bbox: { x: 0, y: 0, w, h },
    widthPx: { max: Math.min(w, h), mean: Math.min(w, h) },
    suggested: 'fill',
  }
}

/** 纯色像素快照（红色），尺寸 w×h */
export function solidImage(w: number, h: number): EngineImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200
    data[i + 1] = 16
    data[i + 2] = 46
    data[i + 3] = 255
  }
  return { width: w, height: h, data }
}

/** 六方格位钻（pitch 8，jitter=0 确定性）；gemCount 颗，id 沿用 layout 的 g##### 形态 */
export function hexGems(gemCount: number, blockId = 'blk-1'): Gem[] {
  const gems: Gem[] = []
  const pitch = TEST_PITCH
  const cols = Math.ceil(gemCount / Math.max(1, Math.ceil(gemCount / 64)))
  let row = 0
  while (gems.length < gemCount) {
    const offset = row % 2 === 0 ? 0 : pitch / 2
    for (let col = 0; col < cols && gems.length < gemCount; col++) {
      gems.push({
        id: `g${String(gems.length + 1).padStart(5, '0')}`,
        x: 4 + col * pitch + offset,
        y: 4 + row * pitch * 0.866,
        colorId: STARTER_PALETTE[gems.length % STARTER_PALETTE.length].id,
        blockId,
        shapeId: 'round',
        diameterMm: 2.8,
      })
    }
    row++
  }
  return gems
}

/** 标准测试交接：64×64 单块 + hexGems(count) + 起步色板 */
export function makeHandoff(gemCount = 12, overrides: Partial<ManualEditHandoff> = {}): ManualEditHandoff {
  return {
    gems: hexGems(gemCount),
    blocks: [fullBlock(64, 64)],
    palette: STARTER_PALETTE.map((c) => ({ ...c })),
    grid: testGrid(),
    width: 64,
    height: 64,
    sourceSummary: '六方抽稀 · 密度 100% · SS10 · 12 钻',
    paintingSnapshot: solidImage(64, 64),
    ...overrides,
  }
}

/** 深快照（plain 对象数组，供 JSON 对账） */
export function plainGems(gems: ReadonlyArray<unknown>): unknown[] {
  return JSON.parse(JSON.stringify(gems))
}

// ---------------------------------------------------------------------------
// jsdom canvas/Image 编解码桩（studio-layers 1.4——editUnbound.test 同式合体）
// ---------------------------------------------------------------------------

interface StubBitmap {
  width: number
  height: number
  data: Uint8ClampedArray
}

const STUB_RED: [number, number, number] = [200, 16, 46]

/**
 * canvas ctx 维护位图（putImageData/drawImage 写、getImageData 读），toDataURL 编码
 * 「8 字节宽高头 + RGBA」；Image 解码该格式还原像素；其余 dataUrl → 96×64 纯红 fixture
 * （解码链兜底）。返回还原函数。
 */
export function installCodecStubEnv(): () => void {
  const bitmaps = new WeakMap<object, StubBitmap>()
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
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = STUB_RED[0]
        data[i + 1] = STUB_RED[1]
        data[i + 2] = STUB_RED[2]
        data[i + 3] = 255
      }
      return { width: w, height: h, data }
    }
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

  HTMLCanvasElement.prototype.getContext = function patched(this: HTMLCanvasElement) {
    return new StubCtx(this) as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toDataURL = function patched(this: HTMLCanvasElement, mime?: string) {
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

  class StubImage {
    naturalWidth = 96
    naturalHeight = 64
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
            // 坏载荷 → 落到默认尺寸分支
          }
        }
        this.naturalWidth = 96
        this.naturalHeight = 64
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
