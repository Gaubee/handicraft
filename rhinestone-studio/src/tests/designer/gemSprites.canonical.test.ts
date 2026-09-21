/*
 * [2026-09-21 rework-designer-manual-rhinestone R5.2 复验-R2 B/C Test] 形级规范回退解析
 * + miss 诊断面（生产 resolveGemshapeTexture 真路径——gemSprites.test 的注入替身测不到）。
 *
 * 根因（复验实证 + IDB 实况对照）：sys-shapes seed 只落 20 个固定档（round-ssXX + 四异形
 * 常用 mm 档），而钻直径连续——⌘T 缩放/属性改尺寸产出的 `marquise-13.43` 等精确档
 * **永远无节点** → 旧解析直接 definitive miss → 永久几何回退（「马眼退化圆角方块/
 * 不即时刷新」表象的真根）。内置形贴图艺术品与档位无关（seedOf 同形各档共用同一
 * SEED_TEXTURES 图）——精确档 miss 应回退同形 canonical 档纹理（本修复）。
 *
 * C 诊断面：miss 分类 console.warn / 帧就绪 console.info（真浏览器 resource 面板看不见
 * data: 纹理请求——data: URL 不走网络栈；console 是复验正通道）。
 *
 * 环境：vi.mock 持久层（assetStore/imageStore）注入 IDB 替身——runAssetMigration 完成、
 * 节点/blob 可编程；parseGemshape/serializeGemshape 走真实实现（合法字节全 gate 过）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeGemshape } from '$lib/persistence/gemshapeFile'
import { onGemSpritesChanged, requestGemSprite, resetGemSpritesForTests, gemSpriteCacheKeys } from '$lib/designer/gemSprites'

const marquise5Node = {
  id: 'ast-shape-marquise-5',
  type: 'project',
  projectKind: 'gemshape',
  blobKey: 'blob-marquise-5',
  mime: 'application/vnd.rhinestone-studio.gemshape+json',
  name: '马眼 5×2.5mm',
  parentId: 'sys-shapes',
}

const exactNode = (id: string, blobKey: string) => ({
  id,
  type: 'project' as const,
  projectKind: 'gemshape' as const,
  blobKey,
  mime: 'application/vnd.rhinestone-studio.gemshape+json',
  name: id,
  parentId: 'sys-shapes',
})

/** gemshape 字节（真实 serialize 口径——parseGemshape 全 gate 过）。 */
function gemshapeBytes(specKey: string, widthMm: number, heightMm: number): Blob {
  return new Blob(
    [
      serializeGemshape({
        appVersion: '0.1.0',
        createdAt: 1735689600000,
        savedAt: 1735689600000,
        name: specKey,
        texture: { mime: 'image/png', dataUrl: 'data:image/png;base64,QUJDRA==', width: 40, height: 80 },
        physical: { widthMm, heightMm },
        specKey,
        calibration: { mode: 'direct' },
      }),
    ],
    { type: 'application/vnd.rhinestone-studio.gemshape+json' },
  )
}

const assetStoreMock = vi.hoisted(() => {
  const state = {
    nodes: new Map<string, unknown>(),
    listed: [] as unknown[],
    blobByKey: (_key: string): Blob | null => null,
  }
  return state
})
vi.mock('$lib/persistence/assetStore', () => ({
  runAssetMigration: vi.fn(async () => ({ ran: false, completed: true, steps: [], missingBlobNodeIds: [] })),
  getProject: vi.fn(async (id: string) => assetStoreMock.nodes.get(id) ?? null),
  listChildNodes: vi.fn(async () => assetStoreMock.listed),
  gemshapeNodeIdOfSpecKey: (specKey: string) => `ast-shape-${specKey}`,
  SYS_SHAPES_FOLDER_ID: 'sys-shapes',
}))
vi.mock('$lib/persistence/imageStore', () => ({
  getImageBlob: vi.fn(async (key: string) => assetStoreMock.blobByKey(key)),
}))

// ---------------------------------------------------------------------------
// 烘焙依赖替身（生产 loadImage/createCanvas 经 DOM 面——Image/2d ctx 桩到「可完成」）
// ---------------------------------------------------------------------------

function installBakeStubs(): void {
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (function (this: HTMLCanvasElement, type: string) {
    if (type === '2d') {
      const canvas = this
      const ctx: Record<string, unknown> = {
        canvas,
        globalCompositeOperation: 'source-over',
        shadowColor: 'transparent',
        shadowBlur: 0,
        shadowOffsetY: 0,
        setTransform: () => undefined,
        drawImage: () => undefined,
        fillRect: () => undefined,
      }
      return ctx as unknown as CanvasRenderingContext2D
    }
    return origGetContext.call(this, type)
  }) as typeof HTMLCanvasElement.prototype.getContext
  ;(globalThis as { Image?: unknown }).Image = class {
    naturalWidth = 40
    naturalHeight = 80
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
}

const BASE = { dpr: 1, state: 'normal' as const, tintHex: null }

beforeEach(() => {
  assetStoreMock.nodes.clear()
  assetStoreMock.listed = []
  assetStoreMock.blobByKey = () => null
  resetGemSpritesForTests()
  installBakeStubs()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetGemSpritesForTests()
})

/** miss → 异步烘焙 → 通知 → 二次取帧命中 的完整链断言（返回是否最终命中帧）。 */
async function bakeToFrame(request: { specKey: string; diameterPx: number }): Promise<boolean> {
  let notified = false
  const unsub = onGemSpritesChanged(() => {
    notified = true
  })
  const first = requestGemSprite({ ...BASE, ...request })
  await new Promise((r) => setTimeout(r, 20))
  const second = requestGemSprite({ ...BASE, ...request })
  unsub()
  expect(notified, '烘焙完成应经 onGemSpritesChanged 通知（失效通道）').toBe(true)
  return first === null && second !== null
}

describe('形级规范回退解析（R2 B：任意尺寸取形纹理）', () => {
  it('精确档缺席（marquise-13.43）→ 同形 canonical 档（marquise-5）纹理烘焙出帧', async () => {
    assetStoreMock.nodes.set('ast-shape-marquise-5', marquise5Node)
    assetStoreMock.listed = [marquise5Node]
    assetStoreMock.blobByKey = (key: string) => (key === 'blob-marquise-5' ? gemshapeBytes('marquise-5', 2.5, 5) : null)
    const ok = await bakeToFrame({ specKey: 'marquise-13.43', diameterPx: 100 })
    expect(ok, '精确档 miss 后应经形级回退烘焙出帧').toBe(true)
    expect(gemSpriteCacheKeys()[0]).toContain('marquise-13.43')
    // 帧就绪诊断（C 正通道）
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('marquise-13.43'))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('精确档命中优先：exact 节点不被 canonical 抢占（目录列举不触发）', async () => {
    const exact = exactNode('ast-shape-square-4', 'blob-square-4')
    assetStoreMock.nodes.set('ast-shape-square-4', exact)
    assetStoreMock.blobByKey = (key: string) => (key === 'blob-square-4' ? gemshapeBytes('square-4', 4, 4) : null)
    const ok = await bakeToFrame({ specKey: 'square-4', diameterPx: 80 })
    expect(ok).toBe(true)
    expect(assetStoreMock.listed.length).toBe(0) // 未走目录列举（canonical 路径未触发）
  })

  it('canonical 命中后记忆化：同形第二尺寸零目录重列', async () => {
    assetStoreMock.nodes.set('ast-shape-marquise-5', marquise5Node)
    assetStoreMock.listed = [marquise5Node]
    assetStoreMock.blobByKey = (key: string) => (key === 'blob-marquise-5' ? gemshapeBytes('marquise-5', 2.5, 5) : null)
    await bakeToFrame({ specKey: 'marquise-13.43', diameterPx: 100 })
    const { listChildNodes } = await import('$lib/persistence/assetStore')
    const callsAfterFirst = vi.mocked(listChildNodes).mock.calls.length
    await bakeToFrame({ specKey: 'marquise-6', diameterPx: 100 })
    expect(vi.mocked(listChildNodes).mock.calls.length).toBe(callsAfterFirst)
  })

  it('custom 资产精确缺席 = definitive（形级回退不适用）+ miss 分类 warn 诊断', async () => {
    let notified = false
    const unsub = onGemSpritesChanged(() => {
      notified = true
    })
    expect(requestGemSprite({ ...BASE, specKey: 'custom-ast-missing', diameterPx: 50 })).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    unsub()
    expect(notified).toBe(true)
    expect(gemSpriteCacheKeys()).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('custom-ast-missing'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('definitive'))
  })

  it('builtin 形全档缺席 = definitive miss（负缓存语义保持）', async () => {
    assetStoreMock.listed = []
    expect(requestGemSprite({ ...BASE, specKey: 'heart-9.9', diameterPx: 50 })).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(gemSpriteCacheKeys()).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('heart-9.9'))
  })
})
