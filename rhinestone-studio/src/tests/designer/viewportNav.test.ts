/*
 * [2026-09-21 redesign-designer-workbench 3.x Test] P8-P12 视图导航（design §2 逐行）：
 * 双击两态（钻=属性面板定位滚动高亮 / 空白=100%⇄适配）/ 滚轮光标锚缩放档位 [10%,1600%] /
 * 空格·中键平移（继承面回归）/ 缩放工具点击放大·Alt 缩小·拖框放大区域 / 视图命令宿主
 * （viewport 模块——⌘ 档命令转发单源）。沿 marquee 测试模式（FIT 换算）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { loadFromHandoff, resetEditForTests, setSelection, getEditDoc } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests, setTool } from '$lib/designer/workbench.svelte'
import { resetInteractionForTests, getPropertiesFocus } from '$lib/designer/interaction.svelte'
import {
  getViewState,
  resetViewportForTests,
  viewportFit,
  viewportZoomStep,
  viewportZoomTo,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
  clampZoomScale,
} from '$lib/designer/viewport.svelte'
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

const FIT = computeFit(600, 420, 64, 64)

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

function pointer(
  el: Element | Window,
  type: string,
  at: { x: number; y: number },
  extra: { shiftKey?: boolean; altKey?: boolean; button?: number; buttons?: number } = {},
): void {
  const c = clientOf(at.x, at.y)
  ;(el as Element).dispatchEvent?.(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: extra.button ?? 0,
      buttons: extra.buttons ?? (type === 'pointerup' ? 0 : 1),
      clientX: c.clientX,
      clientY: c.clientY,
      shiftKey: extra.shiftKey ?? false,
      altKey: extra.altKey ?? false,
    }),
  )
}

function mountView(): {
  target: HTMLElement
  canvas: () => HTMLCanvasElement | null
  q: (testid: string) => Element | null
  unmount: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    canvas: () => target.querySelector<HTMLCanvasElement>('[data-testid="designer-canvas-canvas"]'),
    q: (testid: string) => target.querySelector(`[data-testid="${testid}"]`),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function dblclick(el: Element, at: { x: number; y: number }): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: c.clientX, clientY: c.clientY }),
  )
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetInteractionForTests()
  resetViewportForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12))
})

describe('P10 档位值域（纯函数）', () => {
  it('clampZoomScale：[10%, 1600%] 夹取；非法输入兜底下界', () => {
    expect(ZOOM_MIN_SCALE).toBe(0.1)
    expect(ZOOM_MAX_SCALE).toBe(16)
    expect(clampZoomScale(0.05)).toBe(0.1)
    expect(clampZoomScale(20)).toBe(16)
    expect(clampZoomScale(1)).toBe(1)
    expect(clampZoomScale(Number.NaN)).toBe(0.1)
  })
})

describe('P8 双击两态', () => {
  it('双击钻：选该钻 + 属性面板定位焦点（字段容器 data-focus-gem 高亮）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setSelection(['g00005']) // 先选别的
    await tick()

    dblclick(canvas, { x: 12, y: 4 }) // g00002
    await tick()
    expect([...getEditDoc()!.selection]).toEqual(['g00002'])
    const focus = getPropertiesFocus()
    expect(focus?.gemId).toBe('g00002')
    expect(view.q('designer-properties-fields')?.getAttribute('data-focus-gem')).toBe('g00002')

    view.unmount()
  })

  it('双击空白：100% ⇄ 适配（当前=fit → 切 100%；再双击回 fit）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    // 装载后 fit（clientWidth=0 → 600×420 回退——FIT 同参）
    expect(getViewState().scale).toBeCloseTo(FIT.scale)
    dblclick(canvas, { x: 60, y: 60 })
    await tick()
    expect(getViewState().scale).toBeCloseTo(1) // fit → 100%

    dblclick(canvas, { x: 60, y: 60 })
    await tick()
    expect(getViewState().scale).toBeCloseTo(FIT.scale) // 100% → 适配

    view.unmount()
  })

  it('双击锁定层钻 = 空白语义（视图切换，不产属性定位）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const doc = getEditDoc()!
    doc.layers[0].locked = true

    dblclick(canvas, { x: 12, y: 4 })
    await tick()
    expect(getPropertiesFocus()).toBeNull()
    expect(getViewState().scale).toBeCloseTo(1) // 走空白分支

    view.unmount()
  })
})

describe('P10 滚轮光标锚缩放（档位）', () => {
  it('放大夹上界 1600%；锚点保持（图像坐标稳定）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    // 大幅放大：多次滚轮 → 夹 1600%
    for (let i = 0; i < 40; i++) {
      const c = clientOf(32, 32)
      canvas.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: c.clientX, clientY: c.clientY, deltaY: -240 }),
      )
    }
    await tick()
    expect(getViewState().scale).toBeCloseTo(ZOOM_MAX_SCALE)

    // 锚点：缩放后光标下的图像点仍在光标位（（32,32）中心附近取样验证换算）
    const c = clientOf(32, 32)
    const v = getViewState()
    const rect = canvas.getBoundingClientRect()
    const imgX = (c.clientX - rect.left - v.x) / v.scale
    expect(imgX).toBeCloseTo(32, 0)

    view.unmount()
  })

  it('缩小夹下界 10%', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    for (let i = 0; i < 80; i++) {
      const c = clientOf(32, 32)
      canvas.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: c.clientX, clientY: c.clientY, deltaY: 240 }),
      )
    }
    await tick()
    expect(getViewState().scale).toBeCloseTo(ZOOM_MIN_SCALE)
    view.unmount()
  })
})

describe('P11 平移（继承面回归）', () => {
  it('空格按住拖 = 平移（工具不变）；中键拖同效', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const x0 = getViewState().x

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    pointer(canvas, 'pointerdown', { x: 30, y: 30 })
    pointer(canvas, 'pointermove', { x: 40, y: 36 })
    pointer(canvas, 'pointerup', { x: 40, y: 36 })
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }))
    await tick()
    expect(getViewState().x).toBeGreaterThan(x0)

    // 中键拖
    const x1 = getViewState().x
    pointer(canvas, 'pointerdown', { x: 30, y: 30 }, { button: 1 })
    pointer(canvas, 'pointermove', { x: 20, y: 30 }, { button: 1 })
    pointer(canvas, 'pointerup', { x: 20, y: 30 }, { button: 1 })
    await tick()
    expect(getViewState().x).toBeLessThan(x1)

    view.unmount()
  })
})

describe('P12 缩放工具（点击 / Alt 点击 / 拖框放大）', () => {
  it('点击放大一档、Alt+点击缩小一档', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setTool('zoom')
    await tick()

    const s0 = getViewState().scale
    pointer(canvas, 'pointerdown', { x: 32, y: 32 })
    pointer(canvas, 'pointerup', { x: 32, y: 32 })
    await tick()
    expect(getViewState().scale).toBeGreaterThan(s0)

    const s1 = getViewState().scale
    pointer(canvas, 'pointerdown', { x: 32, y: 32 }, { altKey: true })
    pointer(canvas, 'pointerup', { x: 32, y: 32 }, { altKey: true })
    await tick()
    expect(getViewState().scale).toBeLessThan(s1)

    view.unmount()
  })

  it('拖框放大该区域：框域 contain 取景（比例 = 容器 85% / 框宽）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setTool('zoom')
    await tick()

    // 框 16×16 图像像素（中心 32,32）→ 600×420 回退容器 85%：scale = min(510/16, 357/16) = 22.3 → 夹 16
    pointer(canvas, 'pointerdown', { x: 24, y: 24 })
    pointer(canvas, 'pointermove', { x: 40, y: 40 })
    await tick()
    pointer(canvas, 'pointerup', { x: 40, y: 40 })
    await tick()
    expect(getViewState().scale).toBeCloseTo(ZOOM_MAX_SCALE)
    // 框心 (32,32) 居中：图像点 32 应映射到画布中心 (300, 210)
    const v = getViewState()
    expect(32 * v.scale + v.x).toBeCloseTo(300, 0)
    expect(32 * v.scale + v.y).toBeCloseTo(210, 0)

    view.unmount()
  })

  it('框更大的域：比例按域宽计算不夹上界', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setTool('zoom')
    await tick()

    // 框 60 宽 × 20 高（宽约束主导：510/60 = 8.5 < 357/20）→ 不夹上界
    pointer(canvas, 'pointerdown', { x: 2, y: 2 })
    pointer(canvas, 'pointermove', { x: 62, y: 22 })
    pointer(canvas, 'pointerup', { x: 62, y: 22 })
    await tick()
    expect(getViewState().scale).toBeCloseTo(8.5, 1)

    view.unmount()
  })
})

describe('视图命令宿主（viewport 模块——命令总线单源）', () => {
  it('画布挂载后：viewportFit/zoomStep/zoomTo 生效（⌘ 档命令转发面）', async () => {
    const view = mountView()
    await tick()

    expect(viewportZoomTo(1)).toBe(true)
    expect(getViewState().scale).toBeCloseTo(1)
    expect(viewportZoomStep(1.25)).toBe(true)
    expect(getViewState().scale).toBeCloseTo(1.25)
    expect(viewportFit()).toBe(true)
    expect(getViewState().scale).toBeCloseTo(FIT.scale)

    view.unmount()
  })

  it('画布卸载后：宿主注销（返回 false 放行）', async () => {
    const view = mountView()
    await tick()
    view.unmount()
    await tick()
    expect(viewportZoomTo(1)).toBe(false)
    expect(viewportFit()).toBe(false)
  })
})
