/*
 * [2026-09-21 rework-designer-manual-rhinestone Codex 终审 P1-1 Test] blocks 边界描线
 * 共享 helper（lib/designer/blockOutline）——旧缺陷：四邻 label 读取无网格边界守卫，
 * gx=0 的 `-1` 读上一行末列、gx=W-1 的 `+1` 读下一行首列（跨行索引）→ 满宽块中间行
 * 左/右竖边漏画（PNG 导出与画布同错），且边界结果随相邻行内容漂移。断言面：
 * ①满宽块中间行左右竖边在位；②满高块上下横边在位；③边界结果不随相邻行内容漂移
 * （跨行换行位置内容变化不影响本行边界判定）；④画布消费面（DesignerCanvas layers
 * effect 经 getContext 录制替身读 blocks 缓存层 putImageData 像素）；⑤PNG 消费面
 * 断言见 pngRender.test.ts（同 helper 注入面）。真浏览器像素归 Owner 走查（9.3 非阻塞⑤）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setView } from '$lib/stores/view.svelte'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { resetInteractionForTests } from '$lib/designer/interaction.svelte'
import { resetSpecSelectorForTests } from '$lib/designer/specSelector.svelte'
import { resetViewStateForTests } from '$lib/designer/viewState.svelte'
import { resetViewportForTests } from '$lib/designer/viewport.svelte'
import { resetGemSpritesForTests, setGemSpriteDepsForTests } from '$lib/designer/gemSprites'
import {
  BLOCK_OUTLINE_ALPHA,
  buildBlockLabelMap,
  isBlockBoundaryAt,
  paintBlockOutlinePixels,
} from '$lib/designer/blockOutline'
import { fullBlock, makeHandoff } from '../edit/helpers'
import type { Block } from '$lib/engine'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
}

// jsdom 缺 ImageData 构造器（gemSprites.test.ts 同式最小 polyfill——layers effect 触达）。
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

/** 局部块（bbox x,y 起 w×h 全 1 掩码——跨行漂移用例构造）。 */
function bandBlock(x: number, y: number, w: number, h: number, id: string): Block {
  return {
    ...fullBlock(w, h, id),
    bbox: { x, y, w, h },
  }
}

/** 描线像素缓冲 → (gx,gy) 处 alpha。 */
function outlineOf(blocks: readonly Block[], W: number, H: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4)
  paintBlockOutlinePixels(px, blocks, W, H)
  return px
}
function alphaAt(px: Uint8ClampedArray, W: number, gx: number, gy: number): number {
  return px[(gy * W + gx) * 4 + 3]
}

describe('helper 纯函数：边界像素语义（越界邻居恒非本块）', () => {
  it('满宽块中间行左右竖边在位（旧跨行索引漏画位）+ 满高块上下横边在位', () => {
    // 64×64 满幅单块（满宽且满高——同时覆盖两组边缘）
    const W = 64
    const H = 64
    const px = outlineOf([fullBlock(W, H)], W, H)
    // 左右竖边中点（旧算法 gx=0 读上行末列 / gx=63 读下行首列 → 误判内部漏画）
    expect(alphaAt(px, W, 0, 32)).toBe(BLOCK_OUTLINE_ALPHA)
    expect(alphaAt(px, W, 63, 32)).toBe(BLOCK_OUTLINE_ALPHA)
    // 上下横边中点
    expect(alphaAt(px, W, 32, 0)).toBe(BLOCK_OUTLINE_ALPHA)
    expect(alphaAt(px, W, 32, 63)).toBe(BLOCK_OUTLINE_ALPHA)
    // 内部非边界
    expect(alphaAt(px, W, 32, 32)).toBe(0)
  })

  it('边界结果不随相邻行内容漂移（换行跨界位内容变化不影响本行判定）', () => {
    const W = 8
    const H = 8
    // 配置甲：单块满宽占 2..5 行——探针 (0,4) 左邻跨行读 (7,3)∈同块（旧算法漏画位）
    const a = outlineOf([bandBlock(0, 2, W, 4, 'blk-a')], W, H)
    // 配置乙：2..3 行换为另一块——探针 (0,4) 属下块，(7,3) 属上块（旧算法此形反画得出）
    const b = outlineOf([bandBlock(0, 2, W, 2, 'blk-top'), bandBlock(0, 4, W, 2, 'blk-btm')], W, H)
    // 修复后两配置同判：左/右竖边在位（与上行归属何块无关）
    expect(alphaAt(a, W, 0, 4)).toBe(BLOCK_OUTLINE_ALPHA)
    expect(alphaAt(b, W, 0, 4)).toBe(BLOCK_OUTLINE_ALPHA)
    expect(alphaAt(a, W, 7, 4)).toBe(BLOCK_OUTLINE_ALPHA)
    expect(alphaAt(b, W, 7, 4)).toBe(BLOCK_OUTLINE_ALPHA)
    // 乙配置两块交界行（3/4 行间）水平界线在位（同列上下异块）
    expect(alphaAt(b, W, 3, 3)).toBe(BLOCK_OUTLINE_ALPHA)
    expect(alphaAt(b, W, 3, 4)).toBe(BLOCK_OUTLINE_ALPHA)
  })

  it('isBlockBoundaryAt：网格边界四向守卫（0/末行/末列探针恒边界）', () => {
    const W = 4
    const H = 4
    const label = buildBlockLabelMap([fullBlock(W, H)], W, H)
    // 四角与四边中点：越界方向恒「非本块」→ 边界
    expect(isBlockBoundaryAt(label, W, H, 0, 0, 0)).toBe(true)
    expect(isBlockBoundaryAt(label, W, H, W - 1, H - 1, 0)).toBe(true)
    expect(isBlockBoundaryAt(label, W, H, 0, 2, 0)).toBe(true) // 左边界中点（gx=0 不读 gx-1）
    expect(isBlockBoundaryAt(label, W, H, W - 1, 2, 0)).toBe(true) // 右边界中点（gx=W-1 不读 gx+1）
    expect(isBlockBoundaryAt(label, W, H, 2, 0, 0)).toBe(true) // 上边界中点
    expect(isBlockBoundaryAt(label, W, H, 2, H - 1, 0)).toBe(true) // 下边界中点
    expect(isBlockBoundaryAt(label, W, H, 2, 2, 0)).toBe(false) // 内部四邻同块
  })
})

// ---------------------------------------------------------------------------
// 画布消费面：DesignerCanvas layers effect → blocks 缓存层 putImageData 像素
// （getContext 录制替身——transformRenderChain 同式；PNG 消费面断言在 pngRender.test.ts）
// ---------------------------------------------------------------------------

interface RecordedCall {
  op: string
  args: unknown[]
}

function createRecordingCtx(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy(
    { canvas },
    {
      get(target, prop) {
        if (prop === 'canvas') return target.canvas
        if (prop === 'createImageData') {
          return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
        }
        if (typeof prop === 'string' && prop in props) return props[prop]
        return (...args: unknown[]) => {
          calls.push({ op: String(prop), args })
        }
      },
      set(_target, prop, value) {
        props[String(prop)] = value
        return true
      },
    },
  )
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext
/** 画布元素 → 录制替身（patched getContext 安装期注册——断言面同源；数组化供全量扫描）。 */
const ctxByCanvas = new WeakMap<HTMLCanvasElement, { ctx: CanvasRenderingContext2D; calls: RecordedCall[] }>()
const recordedCanvases: HTMLCanvasElement[] = []

function installRecordingGetContext(): void {
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function patched(this: HTMLCanvasElement) {
    let made = ctxByCanvas.get(this)
    if (made === undefined) {
      made = createRecordingCtx(this)
      ctxByCanvas.set(this, made)
      recordedCanvases.push(this)
    }
    return made.ctx
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
}

function mountView(): { unmount: () => void } {
  installRecordingGetContext()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    unmount: () => {
      unmount(app)
      target.remove()
      HTMLCanvasElement.prototype.getContext = originalGetContext
    },
  }
}

beforeEach(() => {
  setView('edit')
  resetEditForTests()
  resetWorkbenchForTests()
  resetInteractionForTests()
  resetToastsForTests()
  resetSpecSelectorForTests()
  resetViewStateForTests()
  resetViewportForTests()
  resetGemSpritesForTests()
  recordedCanvases.length = 0
  loadFromHandoff(makeHandoff(4)) // 满幅单块 fullBlock(64,64)——满宽且满高
  // sprite 依赖注入：纹理解析恒 null（确定性帧 miss——几何回退路径，与描线断言正交）
  setGemSpriteDepsForTests({
    resolveTexture: async () => null,
    loadImage: async () => {
      throw new Error('不应进解码（纹理恒 miss）')
    },
    createCanvas: () => {
      const canvas = document.createElement('canvas')
      return { canvas, ctx: createRecordingCtx(canvas).ctx }
    },
  })
})

afterEach(() => {
  setGemSpriteDepsForTests(null)
})

describe('画布消费面：DesignerCanvas blocks 缓存层描线', () => {
  it('满幅块四边中点全部落 alpha 210（含旧算法漏画的中间行左右竖边）', async () => {
    const W = 64
    const H = 64
    const view = mountView()
    await tick()
    // blocks 缓存层 putImageData：全 ctx 中找含 alpha 210 的位图（painting 层恒 255、主画布无 putImageData）
    const puts = recordedCanvases.flatMap((canvas) =>
      ctxByCanvas.get(canvas)!.calls.filter((c) => c.op === 'putImageData'),
    )
    const linesPut = puts.find((c) => {
      const img = c.args[0] as { data: Uint8ClampedArray }
      return img.data.some((b, i) => i % 4 === 3 && b === BLOCK_OUTLINE_ALPHA)
    })
    expect(linesPut, 'blocks 描线层必须产出含 alpha 210 的 putImageData').toBeDefined()
    const px = (linesPut!.args[0] as { data: Uint8ClampedArray }).data
    expect(alphaAt(px, W, 0, 32)).toBe(BLOCK_OUTLINE_ALPHA) // 左竖边中点（P1-1 漏画位）
    expect(alphaAt(px, W, 63, 32)).toBe(BLOCK_OUTLINE_ALPHA) // 右竖边中点（P1-1 漏画位）
    expect(alphaAt(px, W, 32, 0)).toBe(BLOCK_OUTLINE_ALPHA) // 上横边中点
    expect(alphaAt(px, W, 32, 63)).toBe(BLOCK_OUTLINE_ALPHA) // 下横边中点
    expect(alphaAt(px, W, 32, 32)).toBe(0) // 内部非边界
    view.unmount()
  })
})
