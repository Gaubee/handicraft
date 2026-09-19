/*
 * [2026-09-20 C-3.6 Test] C 轨验收（rename-and-expert-workbench tasks 3.6）：
 * ① jsdom 全序列走查：笔刷手势（D-5.5 算法接线——落点撞行钻拒画）→ 框选 → Shift 加选
 *    → nudge 会话 → 对齐 → 批量改色 → undo 逐组回退到初态；
 * ② 1 万钻选择/框选性能抽查（60fps 基线 = 16.6ms/帧预算；vitest 计时宽松上限
 *    抓病态回归——真实帧率留浏览器走查，口径同 bench.test.ts）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import {
  getEditDoc,
  getGemCount,
  getUndoDepths,
  loadFromHandoff,
  resetEditForTests,
  undo,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { onBrushStroke, resetWorkbenchForTests } from '../../components/Edit/workbench.svelte'
import { collectMarqueeItems } from '../../components/Edit/selection'
import { buildSpatialIndex } from '$lib/edit/spatialIndex'
import { computeFit } from '../../components/Studio/fit'
import { STARTER_PALETTE, gemRadiusPx, pitchPx, type EditGem } from '$lib/engine'
import { makeHandoff } from './helpers'

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

function pointer(el: Element, type: string, at: { x: number; y: number }, extra: { shiftKey?: boolean } = {}): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: c.clientX,
      clientY: c.clientY,
      shiftKey: extra.shiftKey ?? false,
    }),
  )
}

function key(k: { key: string; shiftKey?: boolean }): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: k.key, shiftKey: k.shiftKey ?? false, bubbles: true, cancelable: true }),
  )
}

/** 六方密排钻集（bench.test.ts 同构生成） */
function hexGems(count: number): EditGem[] {
  const pitch = 8
  const cols = Math.ceil(Math.sqrt(count * (Math.sqrt(3) / 2)))
  const gems: EditGem[] = []
  let row = 0
  while (gems.length < count) {
    const offset = row % 2 === 0 ? 0 : pitch / 2
    for (let col = 0; col < cols && gems.length < count; col++) {
      gems.push({
        id: `g${gems.length + 1}`,
        x: col * pitch + offset,
        y: row * pitch * 0.866,
        colorId: STARTER_PALETTE[gems.length % STARTER_PALETTE.length].id,
        blockId: 'blk-1',
        origin: 'layout',
        moved: false,
        shapeId: 'round',
        diameterMm: 2.8,
      })
    }
    row++
  }
  return gems
}

function timeMin(fn: () => void, runs = 5): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12))
})

describe('C 轨验收：全序列走查', () => {
  it('笔刷 → 框选 → 加选 → nudge → 对齐 → 改色 → undo 逐组回退到初态', async () => {
    const view = mountView()
    await tick()
    const initial = getEditDoc()!.gems.map((g) => ({ id: g.id, x: g.x, y: g.y, colorId: g.colorId }))
    const canvas = view.target.querySelector<HTMLCanvasElement>('[data-testid="edit-canvas-canvas"]')!

    // ① 笔刷手势（draw + grid）：意图流出口 + [D-5.5] 算法接线（落点撞 fixture 行 → 拒画闪红不落钻）
    view.target.querySelector<HTMLButtonElement>('[data-testid="edit-tool-draw"]')!.click()
    await tick()
    const strokes: unknown[] = []
    const unsubscribe = onBrushStroke((e) => strokes.push(e.phase))
    pointer(canvas, 'pointerdown', { x: 10, y: 10 })
    pointer(canvas, 'pointermove', { x: 20, y: 10 })
    pointer(canvas, 'pointerup', { x: 20, y: 10 })
    expect(strokes).toEqual(['begin', 'move', 'end'])
    expect(getGemCount()).toBe(12)
    unsubscribe()

    // ② 回选择工具：框选 g00001-g00003
    view.target.querySelector<HTMLButtonElement>('[data-testid="edit-tool-select"]')!.click()
    await tick()
    pointer(canvas, 'pointerdown', { x: 2, y: 2 })
    pointer(canvas, 'pointermove', { x: 24, y: 8 })
    pointer(canvas, 'pointerup', { x: 24, y: 8 })
    await tick()
    expect([...getEditDoc()!.selection].sort()).toEqual(['g00001', 'g00002', 'g00003'])

    // ③ Shift 点选加选 g00004
    pointer(canvas, 'pointerdown', { x: 28, y: 4 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 28, y: 4 }, { shiftKey: true })
    await tick()
    expect(getEditDoc()!.selection.size).toBe(4)

    // ④ nudge 会话（两次方向键 = 一组）
    key({ key: 'ArrowLeft' })
    key({ key: 'ArrowLeft' })
    await new Promise((r) => setTimeout(r, 560))
    const afterNudge = getEditDoc()!.gems.find((g) => g.id === 'g00001')!
    expect(afterNudge.x).toBe(2)
    expect(getUndoDepths().undo).toBe(1)

    // ⑤ 对齐左（一组）
    view.target.querySelector<HTMLButtonElement>('[data-testid="edit-align-left"]')!.click()
    await tick()
    expect(getUndoDepths().undo).toBe(2)

    // ⑥ 批量改色（一组）
    const colorSelect = view.target.querySelector<HTMLSelectElement>('[data-testid="edit-prop-colorId"] select')!
    colorSelect.value = 'black'
    colorSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getUndoDepths().undo).toBe(3)

    // ⑦ undo 到底 = 回初态
    while (getUndoDepths().undo > 0) undo()
    const doc = getEditDoc()!
    expect(
      doc.gems.map((g) => ({ id: g.id, x: g.x, y: g.y, colorId: g.colorId })),
    ).toEqual(initial)

    view.unmount()
  })
})

describe('C 轨验收：1 万钻选择/框选性能抽查', () => {
  it('10,000 钻：索引构建 / 点选命中 / 框选收集均在帧预算内（宽松上限）', () => {
    const grid = makeHandoff().grid
    const pitch = pitchPx(grid)
    const radius = gemRadiusPx(grid)
    const gems = hexGems(10_000)
    expect(gems).toHaveLength(10_000)

    const buildMs = timeMin(() => buildSpatialIndex(gems, pitch))
    const index = buildSpatialIndex(gems, pitch)

    // 点选命中（queryCircle r=1.5×半径，1000 次取均值）
    const hitMs = timeMin(() => {
      for (let q = 0; q < 1000; q++) {
        index.queryCircle((q * 13.7) % 740, (q * 29.3) % 740, radius * 1.5)
      }
    })

    // 框选收集（四分之一域 marquee）
    const marqueeMs = timeMin(() => {
      collectMarqueeItems(index, { x0: 0, y0: 0, x1: 370, y1: 370 }, radius)
    })
    const hits = collectMarqueeItems(index, { x0: 0, y0: 0, x1: 370, y1: 370 }, radius)
    expect(hits.length).toBeGreaterThan(1000) // 命中面非空（约 1/4 域）

    // 60fps 帧预算 16.6ms；上限放宽抓病态回归（数字进任务报告）
    expect(buildMs).toBeLessThan(100)
    expect(hitMs / 1000).toBeLessThan(1)
    expect(marqueeMs).toBeLessThan(16.6)
  })
})

function mountView(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EditView, { target })
  return { target, unmount: () => { unmount(app); target.remove() } }
}
