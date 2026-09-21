/*
 * [2026-09-21 rework-designer-manual-rhinestone R5.2 走查回修 Test] P1-1/P1-2「读数≠效果」
 * 渲染链回归（jsdom 层——真浏览器效果归重走查）：
 *
 * 走查实证的断链形态：拖角柄读数气泡算出 288% 而画布零实时预览、Enter 后视觉直径实测
 * 不变；非圆形状/朝向不反映到画布。根因＝sprite 帧 miss（真浏览器资产链断/负缓存）时
 * 渲染循环走几何回退，而回退**忽略 pending 直径、忽略 shapeId、忽略 rotationDeg**（恒
 * 网格半径正圆）；外加重绘 effect 对 pending 写入无确定性失效。
 *
 * 本文件以 getContext 录制替身（Proxy spy）+ sprite 依赖注入（resolveTexture 恒 null
 * = 永久帧 miss）驱动**真实渲染循环**，断言修复后全链：
 * ①拖拽中 pending 写入 → 重绘消费（回退几何按 pending 直径描形——文档未写、视觉已变）；
 * ②Enter → 文档落值 → 重绘仍按（现在的文档）直径描形；
 * ③非圆形状走剪影描形（bezier 序列）、朝向走 ctx.rotate（角度弧度）；
 * ④pending 失效信号 transformPendingTick 随拖拽递增（显式失效面）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setView } from '$lib/stores/view.svelte'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  applyPatch,
  getEditDoc,
  loadFromHandoff,
  resetEditForTests,
  setSelection,
  type DesignerGem,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import {
  getTransformMode,
  getTransformPendingTick,
  isTransformModeActive,
  resetInteractionForTests,
} from '$lib/designer/interaction.svelte'
import { execDesignerCommand } from '$lib/designer/commands'
import { resetGemSpritesForTests, setGemSpriteDepsForTests, type GemSpriteDeps } from '$lib/designer/gemSprites'
import { resetSpecSelectorForTests } from '$lib/designer/specSelector.svelte'
import { resetViewStateForTests } from '$lib/designer/viewState.svelte'
import { resetViewportForTests } from '$lib/designer/viewport.svelte'
import { computeFit } from '../../components/Studio/fit'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
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

const FIT = computeFit(600, 420, 64, 64)
/** SS10 半径 px（2.8mm × 2.5px/mm ÷ 2）。 */
const R = 3.5

// ---------------------------------------------------------------------------
// 录制 ctx（Proxy spy——组件任意 2d 调用面零枚举全收；方法调用记序，样式写入存值）
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
          // layers effect 消费返回值（px[i] 写入）——结构满足即真实语义不变（gemSprites.test 同式）
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

/** 落在钻心附近的方法调用（浮点容差匹配前两参）。 */
function callsAt(calls: RecordedCall[], op: string, x: number, y: number): RecordedCall[] {
  return calls.filter((c) => {
    if (c.op !== op) return false
    const [ax, ay] = c.args as number[]
    return typeof ax === 'number' && typeof ay === 'number' && Math.abs(ax - x) < 1e-6 && Math.abs(ay - y) < 1e-6
  })
}

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

function pointerDown(el: Element, at: { x: number; y: number }): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: c.clientX,
      clientY: c.clientY,
    }),
  )
}

function windowPointer(type: string, at: { x: number; y: number }): void {
  const c = clientOf(at.x, at.y)
  window.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: c.clientX,
      clientY: c.clientY,
    }),
  )
}

function key(k: string, mods: { meta?: boolean } = {}): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      metaKey: mods.meta ?? false,
    }),
  )
}

function gem(id: string): DesignerGem {
  const doc = getEditDoc()!
  return doc.gems.find((g) => g.id === id)!
}

/** flush 微任务链（sprite 异步 miss 落负缓存 + 通知重绘）。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext
/** 画布元素 → 录制替身（patched getContext 安装期注册——断言面同源）。 */
const ctxByCanvas = new WeakMap<HTMLCanvasElement, { ctx: CanvasRenderingContext2D; calls: RecordedCall[] }>()

/** 挂载视图（getContext 打桩为录制替身；sprite 依赖恒 miss → 确定性几何回退路径）。 */
function mountView(): { q: (testid: string) => Element | null; unmount: () => void } {
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function patched(this: HTMLCanvasElement) {
    let made = ctxByCanvas.get(this)
    if (made === undefined) {
      made = createRecordingCtx(this)
      ctxByCanvas.set(this, made)
    }
    return made.ctx
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    q: (testid) => target.querySelector(`[data-testid="${testid}"]`),
    unmount: () => {
      unmount(app)
      target.remove()
      HTMLCanvasElement.prototype.getContext = originalGetContext
    },
  }
}

/** 主画布调用日志（getContext 打桩安装后有效）。 */
function getCanvasCalls(canvas: HTMLCanvasElement): RecordedCall[] {
  const made = ctxByCanvas.get(canvas)
  expect(made).toBeDefined()
  return made!.calls
}

beforeEach(() => {
  setView('edit') // [R2 A] DesignerView 键盘分派活动视图守卫（挂载即 edit 语义——App 内编辑 Tab 激活等价）
  resetEditForTests()
  resetWorkbenchForTests()
  resetInteractionForTests()
  resetToastsForTests()
  resetSpecSelectorForTests()
  resetViewStateForTests()
  resetViewportForTests()
  resetGemSpritesForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n.x = 4 + (n-1)*8, y = 4；SS10 2.8mm → 半径 3.5px
  // sprite 依赖注入：纹理解析恒 null（真浏览器帧 miss 的确定性等价——负缓存生效）
  const deps: GemSpriteDeps = {
    resolveTexture: async () => null,
    loadImage: async () => {
      throw new Error('不应进解码（纹理恒 miss）')
    },
    createCanvas: () => {
      const canvas = document.createElement('canvas')
      const made = createRecordingCtx(canvas)
      return { canvas, ctx: made.ctx }
    },
  }
  setGemSpriteDepsForTests(deps)
})

afterEach(() => {
  setGemSpriteDepsForTests(null)
})

describe('P1-1 ⌘T 变换渲染链（帧 miss 回退路径全链）', () => {
  it('拖拽中：pending 写入 → 重绘消费（回退几何按 pending 直径描形，文档未写）——读数＝效果', async () => {
    const view = mountView()
    await tick()
    await flushAsync()
    const canvas = view.q('designer-canvas-canvas') as HTMLCanvasElement
    const calls = getCanvasCalls(canvas)
    // 基线：回退路径按文档值 2.8mm 描（半径 3.5px）——帧 miss 下初始即几何符号
    await tick()
    const baselineArcs = callsAt(calls, 'arc', 4, 4)
    expect(baselineArcs.some((c) => Math.abs((c.args[2] as number) - R) < 1e-6)).toBe(true)

    setSelection(['g00001'])
    await tick()
    execDesignerCommand({ kind: 'enter-transform' })
    await tick()
    const tickBefore = getTransformPendingTick()
    const markBeforeDrag = calls.length

    pointerDown(view.q('designer-transform-handle-se')!, { x: 4 + R, y: 4 + R })
    windowPointer('pointermove', { x: 4 + R * 2, y: 4 + R * 2 }) // ×2 → 5.6mm
    await tick()
    await flushAsync()

    // 失效信号递增（显式失效面——渲染循环可感知 pending 写入）
    expect(getTransformPendingTick()).toBeGreaterThan(tickBefore)
    // 文档未写（松手前 pending 语义）
    expect(gem('g00001').diameterMm).toBeCloseTo(2.8)
    // 渲染循环已按 pending 直径描形：半径 = 5.6mm × 2.5 ÷ 2 = 7px（回退几何不再恒网格半径）
    const liveArcs = callsAt(calls.slice(markBeforeDrag), 'arc', 4, 4)
    expect(liveArcs.some((c) => Math.abs((c.args[2] as number) - 7) < 1e-6)).toBe(true)
    // 选中环随有效半径外扩（7 × 1.4）
    expect(liveArcs.some((c) => Math.abs((c.args[2] as number) - 7 * 1.4) < 1e-6)).toBe(true)
    // 拖拽后不再按旧尺寸描本体（3.5px 本体 / 4.9px 旧环径在拖拽后切片中绝迹）
    expect(liveArcs.some((c) => Math.abs((c.args[2] as number) - R) < 1e-6)).toBe(false)
    expect(liveArcs.some((c) => Math.abs((c.args[2] as number) - R * 1.4) < 1e-6)).toBe(false)

    windowPointer('pointerup', { x: 4 + R * 2, y: 4 + R * 2 })
    key('Enter')
    await tick()
    await flushAsync()
    // Enter：文档落值 + 渲染仍按 7px 描（现在来自文档值而非 pending）
    expect(gem('g00001').diameterMm).toBeCloseTo(5.6)
    expect(isTransformModeActive()).toBe(false)
    expect(getTransformMode()).toBeNull()
    const settledArcs = callsAt(calls, 'arc', 4, 4)
    expect(settledArcs.some((c) => Math.abs((c.args[2] as number) - 7) < 1e-6)).toBe(true)
    view.unmount()
  })
})

describe('P1-2 非圆形状与朝向渲染（帧 miss 回退路径）', () => {
  it('马眼 + 60°：剪影描形（bezier）+ 围钻心旋转（rotate 弧度）——不再退化为正圆', async () => {
    applyPatch({
      op: 'update',
      changes: [
        { id: 'g00001', before: { shapeId: 'round' as const }, after: { shapeId: 'marquise' as const, rotationDeg: 60 } },
      ],
    })
    const view = mountView()
    await tick()
    await flushAsync()
    await tick()
    const canvas = view.q('designer-canvas-canvas') as HTMLCanvasElement
    const calls = getCanvasCalls(canvas)

    // 剪影路径：马眼四段 bezier（本体不再走 arc 圆）
    expect(calls.filter((c) => c.op === 'bezierCurveTo').length).toBeGreaterThanOrEqual(4)
    // 朝向：rotate(60°) 弧度调用
    const rad60 = (60 * Math.PI) / 180
    expect(calls.some((c) => c.op === 'rotate' && Math.abs((c.args[0] as number) - rad60) < 1e-9)).toBe(true)
    // 本体不走 arc（选中环是 arc、本体是剪影——(4,4) 处 arc 半径只能是环径 4.9 而非本体 3.5）
    const arcs = callsAt(calls, 'arc', 4, 4)
    expect(arcs.filter((c) => Math.abs((c.args[2] as number) - R) < 1e-6)).toHaveLength(0)
    // 方钻剪影（直线闭环路径——与圆/马眼可分辨）：g00002 (12,4) 尺寸 7 → 首条 lineTo (12+0.46×7, 4-0.46×7)
    applyPatch({
      op: 'update',
      changes: [{ id: 'g00002', before: { shapeId: 'round' as const }, after: { shapeId: 'square' as const } }],
    })
    await tick()
    const lineTos = callsAt(getCanvasCalls(canvas), 'lineTo', 12 + 0.46 * 7, 4 - 0.46 * 7)
    expect(lineTos.length).toBeGreaterThanOrEqual(1)
    view.unmount()
  })


  it('马眼剪影内容盒按 2:1 纵横比（R2 B）：最宽点 x=±0.46×宽（非正方盒 ±0.46×直径）', async () => {
    applyPatch({
      op: 'update',
      changes: [
        { id: 'g00001', before: { shapeId: 'round' as const }, after: { shapeId: 'marquise' as const } },
      ],
    })
    const view = mountView()
    await tick()
    await flushAsync()
    await tick()
    const canvas = view.q('designer-canvas-canvas') as HTMLCanvasElement
    const calls = getCanvasCalls(canvas)
    // g00001 (4,4) 直径 7px → 长轴半径 3.5、内容盒 {w:3.5, h:7}（aspect 0.5）
    // 最宽段 bezier 终点 (0.96,0.5) → x = 4+0.46×3.5 = 5.61、y = 4（旧正方盒为 7.22）
    const wide = calls.filter(
      (c) =>
        c.op === 'bezierCurveTo' &&
        Math.abs((c.args[4] as number) - (4 + 0.46 * 3.5)) < 1e-6 &&
        Math.abs((c.args[5] as number) - 4) < 1e-6,
    )
    expect(wide.length, '马眼最宽点按纵横比宽 3.5px 落位（真 2:1 透镜）').toBeGreaterThanOrEqual(2)
    const squareBox = calls.filter(
      (c) =>
        c.op === 'bezierCurveTo' &&
        Math.abs((c.args[4] as number) - (4 + 0.46 * 7)) < 1e-6 &&
        Math.abs((c.args[5] as number) - 4) < 1e-6,
    )
    expect(squareBox.length, '正方盒宽透镜（旧退化形态）不得出现').toBe(0)
    view.unmount()
  })

  it('⌘T pending 旋转：回退路径实时随角度（rotate 弧度跟手）', async () => {
    applyPatch({
      op: 'update',
      changes: [
        { id: 'g00001', before: { shapeId: 'round' as const }, after: { shapeId: 'marquise' as const } },
      ],
    })
    const view = mountView()
    await tick()
    await flushAsync()
    setSelection(['g00001'])
    await tick()
    execDesignerCommand({ kind: 'enter-transform' })
    await tick()
    // 单选包围盒 x∈[0.5,7.5] y∈[0.5,7.5]——盒心 (4,4)、e 外柄锚 (7.5,4)
    pointerDown(view.q('designer-transform-rotate-e')!, { x: 7.5, y: 4 })
    windowPointer('pointermove', { x: 4, y: 19.5 }) // 指针角 90°（盒心正下）
    await tick()
    await flushAsync()
    const canvas = view.q('designer-canvas-canvas') as HTMLCanvasElement
    const calls = getCanvasCalls(canvas)
    const rad90 = Math.PI / 2
    expect(calls.some((c) => c.op === 'rotate' && Math.abs((c.args[0] as number) - rad90) < 1e-9)).toBe(true)
    expect(getTransformMode()!.pending['g00001']!.rotationDeg).toBe(90)
    windowPointer('pointerup', { x: 4, y: 19.5 })
    key('Enter')
    await tick()
    expect(gem('g00001').rotationDeg).toBe(90)
    view.unmount()
  })
})
