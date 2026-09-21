/*
 * [2026-09-21 redesign-designer-workbench 8.1 Test] 移动端降级（design §1.4 + spec「移动端
 * 降级」Requirement）：断点冒烟（lg 断点类断言——真实断点视觉归 9.2b/9.3 真浏览器走查）+
 * 触摸手势映射决策核（lib/designer/touchGestures 纯函数：单指=当前工具行为分派 / 双指两态
 * 捏合缩放·拖动平移 / 长按判定 / 捏合方向 / viewport 档位夹取单源）+ 底部工具条命令总线
 * 同源（set-tool/undo/redo/set-snap——写实现单源 workbench/edit store，禁第二实现）+
 * Canvas 触摸接线（单指=工具行为不劫持平移、长按→既有 DesignerContextMenu 两态树；jsdom
 * 假时钟——真实双指手势归真浏览器走查）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { applyPatch, getEditDoc, loadFromHandoff, resetEditForTests, setSelection } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { getSnap, getTool, resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import {
  getViewState,
  resetViewportForTests,
  setViewState,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
} from '$lib/designer/viewport.svelte'
import { execDesignerCommand } from '$lib/designer/commands'
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  longPressDecision,
  singleTouchDispatch,
  twoFingerDecision,
} from '$lib/designer/touchGestures'
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

// 装载后 fit（clientWidth=0 → 600×420 回退——同 viewportNav 手法）
const FIT = computeFit(600, 420, 64, 64)

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

/** 触摸指针序列（pointerType='touch'——mouse-only 假设清理后的统一面验证）。 */
function touchPointer(
  el: Element,
  type: string,
  at: { x: number; y: number },
  extra: { pointerId?: number } = {},
): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: extra.pointerId ?? 1,
      pointerType: 'touch',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: c.clientX,
      clientY: c.clientY,
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

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetViewportForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12))
})

// ---------------------------------------------------------------------------
// 触摸手势映射决策核（纯函数——design §1.4「触摸手势映射」逐条）
// ---------------------------------------------------------------------------

describe('决策核：单指 = 当前工具行为（singleTouchDispatch）', () => {
  it('select/draw/erase/zoom → 工具管线（既有 pointer 分派，禁第二实现）；hand → 平移', () => {
    expect(singleTouchDispatch('select')).toEqual({ kind: 'tool' })
    expect(singleTouchDispatch('draw')).toEqual({ kind: 'tool' })
    expect(singleTouchDispatch('erase')).toEqual({ kind: 'tool' })
    expect(singleTouchDispatch('zoom')).toEqual({ kind: 'tool' })
    expect(singleTouchDispatch('hand')).toEqual({ kind: 'pan' })
  })
})

describe('决策核：长按判定（longPressDecision）', () => {
  it('≥500ms 且累计位移 ≤8px → context-menu；时长不足/超 slop/非法输入 → pending', () => {
    expect(LONG_PRESS_MS).toBe(500)
    expect(LONG_PRESS_SLOP_PX).toBe(8)
    expect(longPressDecision(499, 0)).toBe('pending')
    expect(longPressDecision(500, 0)).toBe('context-menu')
    expect(longPressDecision(1200, 8)).toBe('context-menu') // 边界含等（≤ slop）
    expect(longPressDecision(1200, 8.01)).toBe('pending')
    expect(longPressDecision(1200, 30)).toBe('pending')
    expect(longPressDecision(Number.NaN, 0)).toBe('pending')
    expect(longPressDecision(500, Number.POSITIVE_INFINITY)).toBe('pending')
  })
})

describe('决策核：双指两态（twoFingerDecision）', () => {
  const BASE_VIEW = { scale: 1, x: 10, y: 20 }

  it('双指拖动 = 平移：span 不变、质心位移 → pan；视口平移 = 质心位移，scale 不变', () => {
    // base：span 200、质心 (200,100)；current：span 200、质心 (230,130)——纯拖动
    const base = { p0: { x: 100, y: 100 }, p1: { x: 300, y: 100 } }
    const cur = { p0: { x: 130, y: 130 }, p1: { x: 330, y: 130 } }
    const d = twoFingerDecision(base, cur, BASE_VIEW)
    expect(d.intent).toBe('pan')
    expect(d.view.scale).toBeCloseTo(1)
    expect(d.view.x).toBeCloseTo(40) // 10 + 质心 Δx 30
    expect(d.view.y).toBeCloseTo(50) // 20 + 质心 Δy 30
  })

  it('双指捏合 = 缩放（方向）：span 张开 → 放大；span 收缩 → 缩小（质心不动）', () => {
    const base = { p0: { x: 100, y: 100 }, p1: { x: 300, y: 100 } } // 质心 (200,100)
    const open = twoFingerDecision(base, { p0: { x: 0, y: 100 }, p1: { x: 400, y: 100 } }, BASE_VIEW)
    expect(open.intent).toBe('zoom')
    expect(open.view.scale).toBeCloseTo(2) // 张开 = 放大
    const close = twoFingerDecision(base, { p0: { x: 150, y: 100 }, p1: { x: 250, y: 100 } }, BASE_VIEW)
    expect(close.intent).toBe('zoom')
    expect(close.view.scale).toBeCloseTo(0.5) // 捏合 = 缩小
  })

  it('捏合缩放锚 = 质心：base 质心下图像点钉在 current 质心屏幕位（捏合+平移合成）', () => {
    const base = { p0: { x: 100, y: 100 }, p1: { x: 300, y: 100 } } // 质心 (200,100)
    const cur = { p0: { x: 30, y: 130 }, p1: { x: 430, y: 130 } } // span ×2、质心 (230,130)
    const d = twoFingerDecision(base, cur, BASE_VIEW)
    expect(d.view.scale).toBeCloseTo(2)
    // base 质心图像点 ((200-10)/1, (100-20)/1) = (190, 80) → 屏幕位 = (230, 130)
    expect(190 * d.view.scale + d.view.x).toBeCloseTo(230)
    expect(80 * d.view.scale + d.view.y).toBeCloseTo(130)
  })

  it('捏合接 viewport 档位夹取单源：极端比值夹 [10%, 1600%]', () => {
    const base = { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 } }
    const up = twoFingerDecision(base, { p0: { x: -5000, y: 0 }, p1: { x: 5100, y: 0 } }, { scale: 1, x: 0, y: 0 })
    expect(up.view.scale).toBe(ZOOM_MAX_SCALE)
    const down = twoFingerDecision(base, { p0: { x: 49, y: 0 }, p1: { x: 51, y: 0 } }, { scale: 1, x: 0, y: 0 })
    expect(down.view.scale).toBe(ZOOM_MIN_SCALE)
  })

  it('退化输入：span=0 / scale≤0 → 原视口（pan）不产 NaN', () => {
    const degenerate = twoFingerDecision(
      { p0: { x: 50, y: 50 }, p1: { x: 50, y: 50 } },
      { p0: { x: 60, y: 60 }, p1: { x: 60, y: 60 } },
      { scale: 1, x: 0, y: 0 },
    )
    expect(degenerate.intent).toBe('pan')
    expect(Number.isFinite(degenerate.view.x)).toBe(true)
    const zeroScale = twoFingerDecision(
      { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 } },
      { p0: { x: 0, y: 0 }, p1: { x: 200, y: 0 } },
      { scale: 0, x: 0, y: 0 },
    )
    expect(zeroScale.view).toEqual({ scale: 0, x: 0, y: 0 })
  })
})

// ---------------------------------------------------------------------------
// 断点冒烟（<lg 移动形态 / ≥lg 桌面四区互补——类断言；视觉走查归 9.2b/9.3）
// ---------------------------------------------------------------------------

describe('断点冒烟（design §1.4：移动形态 <lg / 桌面四区 ≥lg 互补）', () => {
  it('顶栏第二行（lg:hidden）：画幅/缩放读数并入；缩放读 viewport 真源', async () => {
    const view = mountView()
    await tick()

    const row = view.q('designer-mobile-status-row')!
    expect(row).not.toBeNull()
    expect(row.className).toContain('lg:hidden')
    expect(row.querySelector('[data-testid="designer-mobile-canvas-readout"]')?.textContent).toContain('画幅')
    expect(row.querySelector('[data-testid="designer-mobile-canvas-readout"]')?.textContent).toContain('缺省锚')

    setViewState({ scale: 2.5, x: 0, y: 0 })
    await tick()
    expect(row.querySelector('[data-testid="designer-mobile-status-zoom"]')?.textContent).toBe('250%')

    view.unmount()
  })

  it('第二行画幅读数与状态栏 popover 同源：点击弹画幅 popover（viewState 单真源）', async () => {
    const view = mountView()
    await tick()
    expect(view.q('designer-canvas-popover')).toBeNull()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-mobile-canvas-readout"]')!.click()
    await tick()
    expect(view.q('designer-canvas-popover')).not.toBeNull()

    view.unmount()
  })

  it('底部状态栏画幅/缩放读数 <lg 让位（并入顶栏第二行）；其余读数与状态栏本体不移除', async () => {
    const view = mountView()
    await tick()

    const readout = view.target.querySelector('[data-testid="designer-canvas-readout"]')!
    expect(readout.className).toContain('hidden')
    expect(readout.className).toContain('lg:inline-flex')
    const zoom = view.target.querySelector('[data-testid="designer-status-zoom"]')!
    expect(zoom.className).toContain('hidden')
    expect(zoom.className).toContain('lg:inline')
    // 移动适配不吞桌面读数面：状态栏本体与钻数/规格读数仍在（桌面 ≥lg 原样）
    expect(view.q('designer-status-bar')).not.toBeNull()
    expect(view.q('designer-status-total')).not.toBeNull()
    expect(view.q('designer-status-spec')).not.toBeNull()

    view.unmount()
  })

  it('底部工具条 / 竖排工具栏 / 右面板列互补断点（lg:hidden ↔ hidden lg:flex）', async () => {
    const view = mountView()
    await tick()

    const bar = view.q('designer-mobile-toolbar')!
    expect(bar.className).toContain('lg:hidden')
    const vertical = view.q('designer-toolbar')!
    expect(vertical.parentElement!.className).toContain('hidden')
    expect(vertical.parentElement!.className).toContain('lg:flex')
    const rail = view.q('designer-right-rail')!
    expect(rail.className).toContain('hidden')
    expect(rail.className).toContain('lg:flex')

    view.unmount()
  })
})

// ---------------------------------------------------------------------------
// 底部工具条经命令总线（design §7.2 同源纪律——禁第二实现）
// ---------------------------------------------------------------------------

describe('底部工具条经命令总线（set-tool/undo/redo/set-snap）', () => {
  it('工具/吸附：工具条按钮与总线直调同效（workbench 真源单实现）', async () => {
    const view = mountView()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-mobile-tool-erase"]')!.click()
    await tick()
    expect(getTool()).toBe('erase')
    expect(execDesignerCommand({ kind: 'set-tool', tool: 'draw' })).toBe(true)
    expect(getTool()).toBe('draw')

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-mobile-snap"]')!.click()
    await tick()
    expect(getSnap()).toBe('free') // 缺省 grid → 点击切自由
    expect(execDesignerCommand({ kind: 'set-snap', snap: 'grid' })).toBe(true)
    expect(getSnap()).toBe('grid')

    view.unmount()
  })

  it('撤销/重做：工具条按钮经总线驱动 edit store（与 ⌘Z/DocBar 按钮同源）', async () => {
    const view = mountView()
    await tick()

    const doc = getEditDoc()!
    const gem = doc.gems[0]
    const x0 = gem.x
    const ok = applyPatch({ op: 'update', changes: [{ id: gem.id, before: { x: x0 }, after: { x: x0 + 5 } }] })
    expect(ok.ok).toBe(true)
    await tick()
    expect(getEditDoc()!.gems[0].x).toBe(x0 + 5)

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-mobile-undo"]')!.click()
    await tick()
    expect(getEditDoc()!.gems[0].x).toBe(x0)

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-mobile-redo"]')!.click()
    await tick()
    expect(getEditDoc()!.gems[0].x).toBe(x0 + 5)

    view.unmount()
  })

  it('无文档门槛：set-tool/set-snap 返回 false（与键位「无文档不切换」同口径）', () => {
    resetEditForTests()
    expect(execDesignerCommand({ kind: 'set-tool', tool: 'draw' })).toBe(false)
    expect(execDesignerCommand({ kind: 'set-snap', snap: 'free' })).toBe(false)
    expect(getTool()).toBe('select')
    expect(getSnap()).toBe('grid')
  })
})

// ---------------------------------------------------------------------------
// Canvas 触摸接线（jsdom 指针序列 + 假时钟；真实双指手势归 9.2b/9.3 真浏览器）
// ---------------------------------------------------------------------------

describe('单指 = 当前工具行为接线（触摸不再平移劫持 select）', () => {
  it('触摸单击钻 = 点选（工具管线）；单指不动视图（不平移）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const v0 = { ...getViewState() }

    touchPointer(canvas, 'pointerdown', { x: 12, y: 4 }) // g00002
    touchPointer(canvas, 'pointerup', { x: 12, y: 4 })
    await tick()

    expect([...getEditDoc()!.selection]).toEqual(['g00002'])
    expect(getViewState().x).toBe(v0.x)
    expect(getViewState().y).toBe(v0.y)

    view.unmount()
  })
})

describe('长按 = 上下文菜单接线（接既有 DesignerContextMenu 两态树）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('长按钻 ≥500ms：选中态树（未选先选它）；抬指不吃 tap 语义（选集保持）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    touchPointer(canvas, 'pointerdown', { x: 12, y: 4 }) // g00002
    await vi.advanceTimersByTimeAsync(LONG_PRESS_MS)
    await tick()

    const menu = view.q('designer-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.getAttribute('data-state')).toBe('selection')
    expect([...getEditDoc()!.selection]).toEqual(['g00002'])

    // 抬指不清选集（长按已消费本次手势）
    touchPointer(canvas, 'pointerup', { x: 12, y: 4 })
    await tick()
    expect(getEditDoc()!.selection.has('g00002')).toBe(true)

    view.unmount()
  })

  it('长按空白：空态树；现选集保持不清空', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setSelection(['g00001'])
    await tick()

    touchPointer(canvas, 'pointerdown', { x: 40, y: 40 }) // 空白
    await vi.advanceTimersByTimeAsync(LONG_PRESS_MS)
    await tick()

    const menu = view.q('designer-context-menu')
    expect(menu).not.toBeNull()
    expect(menu!.getAttribute('data-state')).toBe('blank')
    expect(getEditDoc()!.selection.has('g00001')).toBe(true)

    view.unmount()
  })

  it('长按累计位移超 slop：不触发菜单（漂移回位不复活）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    touchPointer(canvas, 'pointerdown', { x: 12, y: 4 })
    // 位移 ≥30 图像 px（≥ 客户端 slop 8px）后回到原位
    touchPointer(canvas, 'pointermove', { x: 42, y: 4 })
    touchPointer(canvas, 'pointermove', { x: 12, y: 4 })
    await vi.advanceTimersByTimeAsync(LONG_PRESS_MS * 2)
    await tick()

    expect(view.q('designer-context-menu')).toBeNull()

    touchPointer(canvas, 'pointerup', { x: 12, y: 4 })
    await tick()
    view.unmount()
  })

  it('按住未满 500ms 抬指：不触发菜单（计时随抬指作废）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    touchPointer(canvas, 'pointerdown', { x: 40, y: 40 })
    await vi.advanceTimersByTimeAsync(LONG_PRESS_MS - 10)
    touchPointer(canvas, 'pointerup', { x: 40, y: 40 })
    await vi.advanceTimersByTimeAsync(LONG_PRESS_MS)
    await tick()

    expect(view.q('designer-context-menu')).toBeNull()
    view.unmount()
  })
})
