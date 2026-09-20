/*
 * [2026-09-20 C-3.2 Test] 逐钻选择交互扩展（rename-and-expert-workbench tasks 3.2）：
 * 纯命中语义（圆-矩形相交）+ jsdom pointer 序列（点选 / Shift 加选减选 / 框选 / Esc 清空）
 * + N 选计数反馈。视图坐标经 computeFit(600,420,64,64) 确定性换算（jsdom clientWidth=0
 * → 画布回退 600×420，fitView 同参）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { loadFromHandoff, resetEditForTests, setSelection, getEditDoc } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests, getMarquee } from '$lib/designer/workbench.svelte'
import { gemIntersectsRect, collectMarqueeItems } from '$lib/designer/selection'
import { SpatialIndex } from '$lib/edit/spatialIndex'
import { computeFit } from '../../components/Studio/fit'
import { makeHandoff } from './helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

/** 画布回退尺寸（jsdom clientWidth/Height=0 → EditCanvas fitView 的 600×420 分支） */
const FIT = computeFit(600, 420, 64, 64)

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

function pointer(
  el: Element,
  type: string,
  at: { x: number; y: number },
  extra: { pointerId?: number; shiftKey?: boolean; pointerType?: string } = {},
): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: extra.pointerId ?? 1,
      pointerType: extra.pointerType ?? 'mouse',
      button: 0,
      buttons: 1,
      clientX: c.clientX,
      clientY: c.clientY,
      shiftKey: extra.shiftKey ?? false,
    }),
  )
}

function selectionIds(): string[] {
  const doc = getEditDoc()
  return doc ? [...doc.selection].sort() : []
}

function mountView(): { target: HTMLElement; canvas: () => HTMLCanvasElement | null; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    canvas: () => target.querySelector<HTMLCanvasElement>('[data-testid="designer-canvas-canvas"]'),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // 12 颗单行六方钻：g0000n.x = 4 + (n-1)*8，y = 4
})

describe('命中语义（纯函数）', () => {
  it('圆-矩形相交：中心在内 / 圆边触界 / 相离三态', () => {
    const rect = { x0: 10, y0: 10, x1: 20, y1: 20 }
    expect(gemIntersectsRect({ id: 'a', x: 15, y: 15 }, 3, rect)).toBe(true) // 中心在内
    expect(gemIntersectsRect({ id: 'b', x: 23, y: 15 }, 3, rect)).toBe(true) // 圆边恰触右界
    expect(gemIntersectsRect({ id: 'c', x: 24, y: 15 }, 3, rect)).toBe(false) // 1px 之外相离
    expect(gemIntersectsRect({ id: 'd', x: 22, y: 22 }, 3, rect)).toBe(true) // 角部圆边相触（dist≈2.83）
    expect(gemIntersectsRect({ id: 'e', x: 24, y: 24 }, 3, rect)).toBe(false) // 角外相离（dist≈5.66）
  })

  it('collectMarqueeItems 与暴力法对账（随机点集）', () => {
    const gems = Array.from({ length: 200 }, (_, i) => ({
      id: `g${i}`,
      x: ((i * 97) % 61) + (i % 7) * 0.5,
      y: ((i * 53) % 59) + (i % 5) * 0.5,
    }))
    const index = new SpatialIndex(8)
    for (const g of gems) index.insert(g)
    const rect = { x0: 20, y0: 15, x1: 40, y1: 35 }
    const radius = 3.5
    const brute = new Set(
      gems.filter((g) => gemIntersectsRect(g, radius, rect)).map((g) => g.id),
    )
    const collected = new Set(collectMarqueeItems(index, rect, radius).map((g) => g.id))
    expect(collected).toEqual(brute)
  })

  it('矩形输入颠倒自动归一', () => {
    const index = new SpatialIndex(8)
    index.insert({ id: 'a', x: 5, y: 5 })
    const hits = collectMarqueeItems(index, { x0: 10, y0: 10, x1: 0, y1: 0 }, 3)
    expect(hits.map((h) => h.id)).toEqual(['a'])
  })
})

describe('pointer 序列（点选 / 加选减选 / 框选 / 清空）', () => {
  it('点选单钻 → selection 精确命中', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    await tick()
    expect(selectionIds()).toEqual(['g00001'])

    view.unmount()
  })

  it('Shift 点选加选 / 再点减选（toggleSelection）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    pointer(canvas, 'pointerdown', { x: 12, y: 4 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 12, y: 4 }, { shiftKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001', 'g00002'])

    pointer(canvas, 'pointerdown', { x: 12, y: 4 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 12, y: 4 }, { shiftKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001'])

    view.unmount()
  })

  it('Shift 点选空白不改选择（无意外清空）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    pointer(canvas, 'pointerdown', { x: 60, y: 60 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 60, y: 60 }, { shiftKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001'])

    view.unmount()
  })

  it('框选：marquee 相交命中 → setSelection；拖拽中矩形读数就位、收笔清零', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 2, y: 2 })
    pointer(canvas, 'pointermove', { x: 14, y: 6 })
    await tick()
    const dragging = getMarquee()
    expect(dragging).not.toBeNull()
    expect(Math.min(dragging!.x0, dragging!.x1)).toBeCloseTo(2)
    expect(Math.max(dragging!.x0, dragging!.x1)).toBeCloseTo(14)

    pointer(canvas, 'pointerup', { x: 14, y: 6 })
    await tick()
    // 半径 3.5：g00001(4,4) g00002(12,4) 圆与 [2,14]×[2,6] 相交；g00003(20,4) 相离
    expect(selectionIds()).toEqual(['g00001', 'g00002'])
    expect(getMarquee()).toBeNull()

    view.unmount()
  })

  it('Shift 框选 = 加选（并入既有选择）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    pointer(canvas, 'pointerdown', { x: 18, y: 2 }, { shiftKey: true })
    pointer(canvas, 'pointermove', { x: 26, y: 10 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 26, y: 10 }, { shiftKey: true })
    await tick()
    // 半径 3.5：g00003(20,4) 中心在内；g00004(28,4) 圆边触右界 26（相交命中语义）
    expect(selectionIds()).toEqual(['g00001', 'g00003', 'g00004'])

    view.unmount()
  })

  it('框选空域 → 清空选择', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001'])
    pointer(canvas, 'pointerdown', { x: 40, y: 40 })
    pointer(canvas, 'pointermove', { x: 50, y: 50 })
    pointer(canvas, 'pointerup', { x: 50, y: 50 })
    await tick()
    expect(selectionIds()).toEqual([])

    view.unmount()
  })

  it('Esc 清空选择（键盘经 DesignerView 分派）', async () => {
    const view = mountView()
    await tick()

    setSelection(['g00001', 'g00002'])
    await tick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(selectionIds()).toEqual([])

    view.unmount()
  })

  it('N 选计数反馈：状态条与属性面板随选择联动', async () => {
    const view = mountView()
    await tick()

    setSelection(['g00001', 'g00002', 'g00003'])
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-selection"]')?.textContent).toContain('已选 3')
    expect(view.target.querySelector('[data-testid="designer-properties-count"]')?.textContent).toContain('3 颗已选')

    view.unmount()
  })

  it('触摸单指 tap 仍点选（平移通道回归护栏）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 4, y: 4 }, { pointerType: 'touch' })
    pointer(canvas, 'pointerup', { x: 4, y: 4 }, { pointerType: 'touch' })
    await tick()
    expect(selectionIds()).toEqual(['g00001'])

    view.unmount()
  })
})
