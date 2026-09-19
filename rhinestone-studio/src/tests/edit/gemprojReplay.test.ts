/*
 * [2026-09-20 studio-layers 1.5] gemprojReplay v2 六步链（P0-4 验收对象）：
 * - v1 fixture 逐位相等：v1 工程（顶层 physics/activeStrategy/overrides）经 W0 迁移入口
 *   parseGemproj → 六步链输出 vs **旧 replay 路径**（改造前 replayGemproj 的等值复刻——
 *   gridFromSs/rest 层物理单策略布局/层覆写/色覆写）逐位对照：钻位/颜色（含颜色覆写）/
 *   悬空覆写清点/块集/网格/dimsMismatch 逐项相等（单 rest 层 ⇔ 旧整图单策略）；
 * - 六步链全链：多显式层 + rest（异策略/异 spec/异 gap）→ 逐层 concat、层序 onProgress
 *   带层名、AbortSignal 取消（ComputeAbortedError）、jointGate 摘要、physicalCanvas 贯通；
 * - 非圆钻 specKey 直消费：v1 读面 typed 拒绝解除（square-3.5 层真排布 + custom 注入目录
 *   四态：resolved 物化 / missing typed 上浮禁静默降级）；
 * - 悬空覆写键逐层清点合计。
 *
 * 环境声明：jsdom canvas/Image 不可用 → 本地解码桩（editUnbound 同式：ctx 位图 +
 * toDataURL「8 字节头 + RGBA」+ Image 解码回读；非编解码 dataUrl → 96×64 双矩形 fixture
 * 像素——两块确定性分块，多显式层用例的前提）。fake IDB 仅为 assetStore 迁移 seed 惰性装配。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  PIXELS_PER_MM,
  gridFromSs,
  mapColors,
  ssOfRoundSpecKey,
  type Block,
  type EngineImage,
  type Gem,
  type GridSpec,
  type SSKey,
  type StrategyId,
} from '$lib/engine'
import {
  parseGemproj,
  serializeGemproj,
  type GemprojFile,
  type GemprojFileInput,
  type LayerRecord,
} from '$lib/persistence/projectFile'
import { replayGemproj, SpecKeyResolveError, type GemprojReplayOptions } from '$lib/edit/gemprojReplay'
import { runCompute } from '$lib/workers/computeClient'
import { ComputeAbortedError, type ComputeProgress } from '$lib/workers/computeCore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'
import { resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import { resetEditForTests } from '$lib/stores/edit.svelte'

// ---------------------------------------------------------------------------
// fixture：96×64 双矩形（左半红右半黑——segment k=8 确定性两块）
// ---------------------------------------------------------------------------

const RED: [number, number, number] = [200, 16, 46]
const BLACK: [number, number, number] = [26, 26, 26]
const FIXTURE_W = 96
const FIXTURE_H = 64

function twoRects(): EngineImage {
  const data = new Uint8ClampedArray(FIXTURE_W * FIXTURE_H * 4)
  for (let y = 0; y < FIXTURE_H; y++) {
    for (let x = 0; x < FIXTURE_W; x++) {
      const [r, g, b] = x <= Math.floor(FIXTURE_W / 2) - 1 ? RED : BLACK
      const i = (y * FIXTURE_W + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { width: FIXTURE_W, height: FIXTURE_H, data }
}

const FIXTURE = twoRects()

interface StubBitmap {
  width: number
  height: number
  data: Uint8ClampedArray
}

let restoreEnv: (() => void) | null = null

function installStubEnv(): void {
  const bitmaps = new WeakMap<object, StubBitmap>()
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL

  class StubCtx {
    constructor(private readonly canvas: HTMLCanvasElement) {}
    createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    }
    putImageData(imageData: { width: number; height: number; data: Uint8ClampedArray }): void {
      bitmaps.set(this.canvas, { width: imageData.width, height: imageData.height, data: new Uint8ClampedArray(imageData.data) })
    }
    drawImage(source: unknown, _dx: number, _dy: number, dw: number, dh: number): void {
      const pixels = (source as { __stubPixels?: { data: Uint8ClampedArray } }).__stubPixels
      if (pixels) bitmaps.set(this.canvas, { width: dw, height: dh, data: new Uint8ClampedArray(pixels.data.subarray(0, dw * dh * 4)) })
      else bitmaps.delete(this.canvas)
    }
    getImageData(_x: number, _y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      const bitmap = bitmaps.get(this.canvas)
      if (bitmap && bitmap.width === w && bitmap.height === h) {
        return { width: w, height: h, data: new Uint8ClampedArray(bitmap.data) }
      }
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
  }

  HTMLCanvasElement.prototype.getContext = function patched(this: HTMLCanvasElement) {
    return new StubCtx(this) as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toDataURL = function patched(this: HTMLCanvasElement, mime?: string) {
    const bitmap = bitmaps.get(this)
    if (!bitmap || mime !== 'image/png') return 'data:image/png;base64,'
    const bytes = new Uint8Array(8 + bitmap.data.length)
    new DataView(bytes.buffer).setUint32(0, bitmap.width)
    new DataView(bytes.buffer).setUint32(4, bitmap.height)
    bytes.set(bitmap.data, 8)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:image/png;base64,${btoa(binary)}`
  } as unknown as typeof HTMLCanvasElement.prototype.toDataURL

  class StubImage {
    naturalWidth = FIXTURE_W
    naturalHeight = FIXTURE_H
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
            // 坏载荷 → 默认尺寸
          }
        }
        this.naturalWidth = FIXTURE_W
        this.naturalHeight = FIXTURE_H
        this.onload?.()
      })
    }
  }
  vi.stubGlobal('Image', StubImage)

  restoreEnv = () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL
    vi.unstubAllGlobals()
  }
}

// ---------------------------------------------------------------------------
// 工程夹具
// ---------------------------------------------------------------------------

let fake: FakeIndexedDB

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetEditForTests()
  await runAssetMigration()
  installStubEnv()
})

afterEach(() => {
  restoreEnv?.()
  restoreEnv = null
  vi.unstubAllGlobals()
})

const SOURCE_BLOB = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

/** v1 工程 JSON（顶层 physics/activeStrategy/overrides——W0 迁移入口的输入形态）。 */
function makeV1Text(overrides: Record<string, unknown> = {}, strategy: StrategyId = 'cvt', ss: SSKey = 'SS12'): string {
  return JSON.stringify({
    kind: 'gemproj',
    formatVersion: 1,
    appVersion: '0.1.0',
    engineVersion: 1,
    createdAt: 1,
    savedAt: 2,
    name: '旧工程',
    source: { kind: 'embedded', name: '双矩形.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', width: FIXTURE_W, height: FIXTURE_H, downscale: 1 },
    segment: { k: 8, seed: 1 },
    overrides: { disabled: {}, density: {}, type: {}, color: {}, ...overrides },
    physics: { ss, gapMm: 0.5, globalDensity: 0.8, relax: { boundary: false, repulsion: true } },
    palette: [
      { id: 'red', name: '红', hex: '#c8102e' },
      { id: 'black', name: '黑', hex: '#1a1a1a' },
    ],
    activeStrategy: strategy,
  })
}

function layerRecord(partial: Partial<LayerRecord> & Pick<LayerRecord, 'id'>): LayerRecord {
  return {
    name: `图层 ${partial.id}`,
    blockIds: 'rest',
    strategy: 'hybrid',
    physics: { specKey: 'round-ss10', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } },
    overrides: { disabled: {}, density: {}, type: {}, color: {} },
    ...partial,
  }
}

function gemprojInputOf(layers: LayerRecord[], physicalCanvas?: GemprojFileInput['physicalCanvas']): GemprojFileInput {
  return {
    appVersion: '0.1.0',
    createdAt: 1,
    savedAt: 2,
    name: '层化工程',
    source: { kind: 'embedded', name: '双矩形.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', width: FIXTURE_W, height: FIXTURE_H, downscale: 1 },
    segment: { k: 8, seed: 1 },
    layers,
    ...(physicalCanvas !== undefined ? { physicalCanvas } : {}),
    palette: [
      { id: 'red', name: '红', hex: '#c8102e' },
      { id: 'black', name: '黑', hex: '#1a1a1a' },
    ],
  }
}

async function decodeImage(): Promise<EngineImage> {
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(SOURCE_BLOB)
  })
  const img = await new Promise<HTMLImageElement>((resolve) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight)
  const data = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight)
  return { width: img.naturalWidth, height: img.naturalHeight, data: data.data }
}

const CTX = { gemprojAssetId: 'ast-test', gemprojName: '层化工程.gemproj' }

// ---------------------------------------------------------------------------
// 旧 replay 路径复刻（改造前 replayGemproj 的等值实现——v1 fixture 对照 oracle）
// ---------------------------------------------------------------------------

function minAreaForOld(image: EngineImage): number {
  return Math.min(4000, Math.max(12, Math.round(image.width * image.height * 0.0005)))
}

async function oldReplayPath(file: GemprojFile, image: EngineImage, blocks: Block[]) {
  const rest = file.layers.find((l) => l.blockIds === 'rest')!
  const ss = ssOfRoundSpecKey(rest.physics.specKey) as SSKey
  const grid: GridSpec = gridFromSs(ss, PIXELS_PER_MM, rest.physics.gapMm)
  const relax = { ...rest.physics.relax }
  const overrides = rest.overrides
  const segmentOpts = { k: file.segment.k, seed: file.segment.seed, gemDiameterPx: 7, minAreaPx: minAreaForOld(image) }

  const blockIds = new Set(blocks.map((b) => b.id))
  let droppedOverrides = 0
  for (const key of [...Object.keys(overrides.disabled), ...Object.keys(overrides.density), ...Object.keys(overrides.type), ...Object.keys(overrides.color)]) {
    if (!blockIds.has(key)) droppedOverrides += 1
  }
  const effectiveBlocks = blocks
    .filter((b) => overrides.disabled[b.id] !== true)
    .map((b) => {
      const typeOverride = overrides.type[b.id]
      return typeOverride !== undefined && typeOverride !== b.suggested ? { ...b, suggested: typeOverride } : b
    })
  const density: Record<string, number> = {}
  for (const b of effectiveBlocks) {
    const d = overrides.density[b.id] ?? rest.physics.density
    if (d !== 1) density[b.id] = d
  }
  const output = await runCompute({
    image,
    segmentOpts,
    strategies: [rest.strategy],
    layoutOpts: { density, seed: 1, relax },
    grid,
    blocks: effectiveBlocks.map((b) => ({ ...b })),
  }).promise
  const gems: Gem[] = output.results[rest.strategy].gems.map((g) => ({ ...g }))
  if (gems.length > 0 && file.palette.length > 0) mapColors(gems, effectiveBlocks, file.palette.map((c) => ({ ...c })))
  for (const gem of gems) {
    const override = overrides.color[gem.blockId]
    if (override !== undefined) gem.colorId = override
  }
  return { gems, effectiveBlocks, grid, droppedOverrides }
}

/** segment 空轮（与六步链第 1 步同式——测试侧自取块集）。 */
async function segmentBlocks(file: GemprojFile, image: EngineImage): Promise<Block[]> {
  const output = await runCompute({
    image,
    segmentOpts: { k: file.segment.k, seed: file.segment.seed, gemDiameterPx: 7, minAreaPx: minAreaForOld(image) },
    strategies: [],
    layoutOpts: { density: {}, seed: 1, relax: { boundary: false, repulsion: false } },
    grid: { pitchMm: 7, gapMm: 0, rowAngleDeg: 0, pixelsPerMm: PIXELS_PER_MM },
  }).promise
  return output.blocks
}

// ---------------------------------------------------------------------------
// v1 fixture 逐位相等（主断言）
// ---------------------------------------------------------------------------

describe('1.5 v1 fixture 迁移后与旧 replay 逐位相等（R2 §四 P0-3）', () => {
  it('钻位/颜色/悬空覆写清点/块集/网格逐项对照（单 rest 层 ⇔ 旧整图单策略）', async () => {
    const overrides = {
      disabled: { 'b-ghost-1': true },
      density: { 'b-ghost-2': 0.5 },
      type: {},
      color: {},
    }
    const file = parseGemproj(makeV1Text(overrides, 'cvt', 'SS12'))
    expect(file.formatVersion).toBe(2) // W0 迁移入口
    const image = await decodeImage()
    const blocks = await segmentBlocks(file, image)
    expect(blocks.length).toBeGreaterThanOrEqual(2)

    const old = await oldReplayPath(file, image, blocks)
    const result = await replayGemproj(file, SOURCE_BLOB, CTX)

    // 钻位 + 颜色（含 mapColors 最近邻）逐位相等
    expect(result.handoff.gems.map((g) => ({ ...g }))).toEqual(old.gems.map((g) => ({ ...g })))
    // 悬空覆写清点相等（v1 全局清点 → 逐层合计的等值性）
    expect(result.droppedOverrides).toBe(old.droppedOverrides)
    expect(result.droppedOverrides).toBe(2)
    // 块集（disabled 过滤 + type 覆写派生）与网格逐位相等
    expect(result.handoff.blocks.map((b) => b.id)).toEqual(old.effectiveBlocks.map((b) => b.id))
    expect(result.handoff.grid).toEqual(old.grid)
    expect(result.dimsMismatch).toBe(false)
    // v1 工程无 physicalCanvas → default 锚显式合成
    expect(result.handoff.physicalCanvas).toEqual({ widthMm: FIXTURE_W / 2.5, heightMm: FIXTURE_H / 2.5, anchorSource: 'default' })
  })

  it('颜色覆写 + 密度覆写 + disabled 块参与时仍逐位相等（v1 参数空间全覆盖）', async () => {
    const image = await decodeImage()
    const blocks = await segmentBlocks(parseGemproj(makeV1Text()), image)
    const first = blocks[0]!.id
    const second = blocks[1]!.id
    const overrides = {
      disabled: { [second]: true },
      density: { [first]: 0.6 },
      type: {},
      color: { [first]: 'black' },
    }
    const file = parseGemproj(makeV1Text(overrides, 'hybrid', 'SS10'))
    const old = await oldReplayPath(file, image, blocks)
    const result = await replayGemproj(file, SOURCE_BLOB, CTX)
    expect(result.handoff.gems.map((g) => ({ ...g }))).toEqual(old.gems.map((g) => ({ ...g })))
    expect(result.handoff.gems.every((g) => g.blockId === first)).toBe(true) // disabled 块被排除
    expect(result.handoff.gems.some((g) => g.colorId === 'black')).toBe(true) // 颜色覆写生效
    expect(result.handoff.blocks.map((b) => b.id)).toEqual([first])
    expect(result.droppedOverrides).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 六步链全链（多显式层 + rest）
// ---------------------------------------------------------------------------

describe('1.5 六步链全链（多层 v2 工程）', () => {
  async function multiLayerFile(): Promise<GemprojFile> {
    const image = await decodeImage()
    const blocks = await segmentBlocks(parseGemproj(makeV1Text()), image)
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    const first = blocks[0]!.id
    const second = blocks[1]!.id
    const text = serializeGemproj(
      gemprojInputOf(
        [
          layerRecord({
            id: 'L1',
            name: '左幅圆钻',
            blockIds: [first],
            strategy: 'hex-thin',
            physics: { specKey: 'round-ss10', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } },
            overrides: { disabled: { 'ghost-a': true }, density: {}, type: {}, color: {} },
          }),
          layerRecord({
            id: 'L2',
            name: '右幅大钻',
            blockIds: [second],
            strategy: 'poisson',
            physics: { specKey: 'round-ss20', gapMm: 0.6, density: 0.8, relax: { boundary: false, repulsion: false } },
            overrides: { disabled: {}, density: {}, type: {}, color: {} },
          }),
          layerRecord({
            id: 'L-rest',
            name: '兜底层',
            blockIds: 'rest',
            strategy: 'hybrid',
            physics: { specKey: 'round-ss16', gapMm: 0.5, density: 1, relax: { boundary: false, repulsion: false } },
            overrides: { disabled: {}, density: { 'ghost-b': 0.5, 'ghost-c': 0.4 }, type: {}, color: {} },
          }),
        ],
        { widthMm: 96, heightMm: 64, anchorSource: 'declared' },
      ),
    )
    return parseGemproj(text)
  }

  it('逐层 concat + 层序 onProgress 带层名 + jointGate 摘要 + physicalCanvas 贯通', async () => {
    const file = await multiLayerFile()
    const events: ComputeProgress[] = []
    const result = await replayGemproj(file, SOURCE_BLOB, CTX, { onProgress: (p) => events.push({ ...p }) })

    // 逐层 concat：L1 hex-thin ss10（2.8mm）/ L2 poisson ss20（4.8mm）——rest 无成员零钻
    const l1 = result.handoff.gems.filter((g) => g.diameterMm === 2.8)
    const l2 = result.handoff.gems.filter((g) => g.diameterMm === 4.8)
    expect(l1.length).toBeGreaterThan(0)
    expect(l2.length).toBeGreaterThan(0)
    expect(result.handoff.gems.length).toBe(l1.length + l2.length)
    // 跨层 id 全局重编号：concat 后无重复 id（各层引擎产物共用 g##### 序列——层序归并）
    expect(new Set(result.handoff.gems.map((g) => g.id)).size).toBe(result.handoff.gems.length)
    // onProgress：segment「正在分块…」+ 逐层「层「N」排布中…」（层声明序）
    const labels = events.map((e) => e.label)
    expect(labels[0]).toBe('正在分块…')
    expect(labels).toContain('层「左幅圆钻」排布中…')
    expect(labels).toContain('层「右幅大钻」排布中…')
    expect(labels).toContain('层「兜底层」排布中…')
    // jointGate 摘要：双矩形两半在 x=47/48 贴边——L1 右缘列与 L2 左缘钻真实层间碰撞被第 5 步
    // 捕获（八源①相邻块边界的全链形态；层内按本层 gap 判距不误报——无 intra 组）
    expect(result.jointGate.ok).toBe(false)
    expect(result.jointGate.violations).toBeGreaterThan(0)
    expect(result.jointGate.groups).toBe(1) // 仅 L1×L2 inter 组
    // physicalCanvas 贯通（declared → 直通 + pixelsPerMm = 96 ÷ 96 = 1）
    expect(result.handoff.physicalCanvas).toEqual({ widthMm: 96, heightMm: 64, anchorSource: 'declared' })
    expect(result.handoff.grid.pixelsPerMm).toBe(1)
    expect(result.handoff.grid).toEqual({ pitchMm: 4.0 + 0.5, gapMm: 0.5, rowAngleDeg: 0, pixelsPerMm: 1 }) // rest 层 grid（ss16 4.0mm）
    // 悬空覆写逐层清点合计（L1 1 项 + rest 2 项）
    expect(result.droppedOverrides).toBe(3)
    // sourceSummary 层语法
    expect(result.handoff.sourceSummary).toMatch(/^3 层 · 共 \d+ 钻 · 主规格 /)
  })

  it('AbortSignal 预取消 → ComputeAbortedError（typed 身份）', async () => {
    const file = await multiLayerFile()
    const controller = new AbortController()
    controller.abort()
    const options: GemprojReplayOptions = { signal: controller.signal }
    await expect(replayGemproj(file, SOURCE_BLOB, CTX, options)).rejects.toBeInstanceOf(ComputeAbortedError)
  })
})

// ---------------------------------------------------------------------------
// 非圆钻 specKey 直消费（v1 读面 typed 拒绝解除）
// ---------------------------------------------------------------------------

describe('1.5 非圆钻 specKey replay 直消费', () => {
  it('builtin square-3.5 层：真排布 + 逐钻规格快照按层物化（shapeId square/径 3.5）', async () => {
    const text = serializeGemproj(
      gemprojInputOf([
        layerRecord({ id: 'L1', physics: { specKey: 'square-3.5', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } } }),
      ]),
    )
    const file = parseGemproj(text) // v1 读面删除后 parse 不再对非圆钻 specKey typed 拒绝
    const result = await replayGemproj(file, SOURCE_BLOB, CTX)
    expect(result.handoff.gems.length).toBeGreaterThan(0)
    expect(result.handoff.gems.every((g) => g.shapeId === 'square')).toBe(true)
    expect(result.handoff.gems.every((g) => g.diameterMm === 3.5)).toBe(true)
    expect(result.handoff.sourceSummary).toContain('方钻 3.5mm')
  })

  it('custom specKey：注入目录 resolved → 物化（assetId/直径随层）；missing 四态 → typed 上浮禁静默', async () => {
    const text = serializeGemproj(
      gemprojInputOf([
        layerRecord({ id: 'L1', physics: { specKey: 'custom-ast-x1', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } } }),
      ]),
    )
    const file = parseGemproj(text)
    const resolved = await replayGemproj(file, SOURCE_BLOB, CTX, {
      resolveCustom: async () => ({
        state: 'resolved',
        spec: { shapeId: 'custom', sizeLabel: '自定义星形', diameterMm: 4.2, assetId: 'ast-x1' },
      }),
    })
    expect(resolved.handoff.gems.length).toBeGreaterThan(0)
    expect(resolved.handoff.gems.every((g) => g.shapeId === 'custom' && g.assetId === 'ast-x1' && g.diameterMm === 4.2)).toBe(true)

    for (const state of ['soft-deleted', 'blob-missing', 'wrong-kind', null] as const) {
      const error = await replayGemproj(file, SOURCE_BLOB, CTX, { resolveCustom: async () => ({ state }) }).catch((e) => e)
      expect(error).toBeInstanceOf(SpecKeyResolveError)
      expect(error.state).toBe(state)
      expect(error.message).toContain('不回退圆钻')
    }
  })
})
