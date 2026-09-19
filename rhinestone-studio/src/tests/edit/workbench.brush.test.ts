/*
 * [2026-09-20 C-3.3 / D-5.5 Test] 笔刷手势层（rename-and-expert-workbench tasks 3.3/5.5）：
 * 意图流形状（begin/move/end × 落点序列 + 工具 + snap 态、落点去重、快照安全）、
 * 六方格位吸附纯函数、起收组（beginStroke/endStroke 语义挂在意图生命周期上）、
 * 光标/吸附高亮读数、工具/snap 分派。
 * [D-5.5] 算法已落地（EditCanvas 挂载 attachBrushEngine）：本文件落点均撞 fixture 行
 * （吸附格心距行钻 2.93px < 判距 7.99px）→ 拒画闪红而非落钻——落钻/擦除正测归
 * workbench.brushEngine.test.ts（本文件保持手势层读数断言）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import { loadFromHandoff, resetEditForTests, getGemCount } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  getBrushCursor,
  getBrushRejections,
  getSnapIndicator,
  getSnap,
  getTool,
  onBrushStroke,
  resetWorkbenchForTests,
  setSnap,
} from '../../components/Edit/workbench.svelte'
import { createBrushGesture, type BrushIntentEvent } from '../../components/Edit/brushGesture'
import { hexSnapPoint } from '../../components/Edit/hexSnap'
import { pitchPx } from '$lib/engine'
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

const FIT = computeFit(600, 420, 64, 64)
const PITCH = pitchPx(makeHandoff().grid) // SS10 @2.5 → 8px

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

function pointer(el: Element, type: string, at: { x: number; y: number }): void {
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
    }),
  )
}

function mountView(): { target: HTMLElement; canvas: () => HTMLCanvasElement | null; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EditView, { target })
  return {
    target,
    canvas: () => target.querySelector<HTMLCanvasElement>('[data-testid="edit-canvas-canvas"]'),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function clickTool(target: HTMLElement, id: string): Promise<void> {
  target.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click()
  await tick()
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12))
})

describe('意图流形状（纯手势会话）', () => {
  it('begin → move（去重）→ end：事件序与落点序列', () => {
    const events: BrushIntentEvent[] = []
    const session = createBrushGesture((e) => events.push(e))

    session.begin('draw', 'grid', { x: 1, y: 2 })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      phase: 'begin',
      intent: { tool: 'draw', snap: 'grid', points: [{ x: 1, y: 2 }] },
    })

    expect(session.move({ x: 3, y: 4 })).toBe(true)
    expect(events).toHaveLength(2)
    expect(events[1].phase).toBe('move')
    if (events[1].phase === 'move') {
      expect(events[1].appended).toEqual([{ x: 3, y: 4 }])
      expect(events[1].intent.points).toHaveLength(2)
    }

    // 完全相同落点去重：不产事件
    expect(session.move({ x: 3, y: 4 })).toBe(false)
    expect(events).toHaveLength(2)

    const ended = session.end()
    expect(ended).toEqual({ tool: 'draw', snap: 'grid', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })
    expect(events).toHaveLength(3)
    expect(events[2].phase).toBe('end')

    // 收笔后再收：no-op
    expect(session.end()).toBeNull()
    expect(events).toHaveLength(3)
  })

  it('事件快照安全：外部改事件 points 不渗入会话', () => {
    const session = createBrushGesture(() => {})
    session.begin('erase', 'free', { x: 0, y: 0 })
    const snapshot = session.intent!
    snapshot.points.push({ x: 99, y: 99 })
    session.move({ x: 5, y: 5 })
    expect(session.intent!.points).toHaveLength(2) // 外部污染未渗入
  })

  it('会话中重复 begin：沿用当前会话（防御）', () => {
    const session = createBrushGesture(() => {})
    session.begin('draw', 'grid', { x: 1, y: 1 })
    session.begin('erase', 'free', { x: 2, y: 2 }) // 忽略
    expect(session.intent!.tool).toBe('draw')
    expect(session.intent!.points).toHaveLength(1)
  })

  it('未起笔的 move/end：no-op', () => {
    const session = createBrushGesture(() => {})
    expect(session.move({ x: 1, y: 1 })).toBe(false)
    expect(session.end()).toBeNull()
    expect(session.active).toBe(false)
  })
})

describe('六方格位吸附（现行 GridSpec 临时格）', () => {
  it('格位上的点吸附回自身（不动）', () => {
    const rowH = (PITCH * Math.sqrt(3)) / 2
    const p = hexSnapPoint(4 + 2 * PITCH, rowH, PITCH) // 奇数行格位
    expect(p.x).toBeCloseTo(4 + 2 * PITCH, 10)
    expect(p.y).toBeCloseTo(rowH, 10)
  })

  it('格间点吸附到最近格位', () => {
    const p = hexSnapPoint(PITCH * 1.05, PITCH * 0.1, PITCH)
    expect(p.x).toBeCloseTo(PITCH, 10) // 偶数行 col=1
    expect(p.y).toBeCloseTo(0, 10)
  })
})

describe('画布手势分派（jsdom pointer 序列 → 意图流）', () => {
  it('画钻工具 + 格位吸附：事件流携带吸附落点；光标/吸附高亮读数就位', async () => {
    const view = mountView()
    await tick()
    await clickTool(view.target, 'edit-tool-draw')
    expect(getTool()).toBe('draw')
    expect(getSnap()).toBe('grid')

    const events: BrushIntentEvent[] = []
    const unsubscribe = onBrushStroke((e) => events.push(e))

    const canvas = view.canvas()!
    const snapped1 = hexSnapPoint(10, 10, PITCH)
    const snapped2 = hexSnapPoint(20, 10, PITCH)
    pointer(canvas, 'pointerdown', { x: 10, y: 10 })
    pointer(canvas, 'pointermove', { x: 20, y: 10 })
    pointer(canvas, 'pointermove', { x: 20, y: 10 }) // 去重
    pointer(canvas, 'pointerup', { x: 20, y: 10 })

    expect(events.map((e) => e.phase)).toEqual(['begin', 'move', 'end'])
    expect(events[0].intent.tool).toBe('draw')
    expect(events[0].intent.snap).toBe('grid')
    expect(events[0].intent.points).toEqual([snapped1])
    expect(events[2].intent.points).toEqual([snapped1, snapped2])
    expect(events[2].intent.points).toHaveLength(2) // 吸附去重后一笔两点

    // 光标与吸附格位高亮读数（收笔后保留 hover 位；高亮 = 当前位置的吸附格位）
    expect(getBrushCursor()).toEqual(snapped2)
    expect(getSnapIndicator()).toEqual(snapped2)

    // [D-5.5] 算法接线：两吸附格心距 fixture 行钻 2.93px < 判距 7.99px → 拒画闪红不落钻
    expect(getGemCount()).toBe(12)
    expect(getBrushRejections()).toEqual([snapped1, snapped2])

    unsubscribe()
    view.unmount()
  })

  it('snap=自由：落点为原始坐标（不吸附）', async () => {
    const view = mountView()
    await tick()
    await clickTool(view.target, 'edit-tool-draw')
    setSnap('free')

    const events: BrushIntentEvent[] = []
    const unsubscribe = onBrushStroke((e) => events.push(e))

    const canvas = view.canvas()!
    pointer(canvas, 'pointerdown', { x: 10.25, y: 10.5 })
    pointer(canvas, 'pointerup', { x: 10.25, y: 10.5 })

    expect(events[0].intent.points).toEqual([{ x: 10.25, y: 10.5 }])
    expect(getSnapIndicator()).toBeNull() // 自由模式无格位高亮

    unsubscribe()
    view.unmount()
  })

  it('擦除工具：tool=erase、恒自由落点（吸附会漏自由位钻）', async () => {
    const view = mountView()
    await tick()
    await clickTool(view.target, 'edit-tool-erase')

    const events: BrushIntentEvent[] = []
    const unsubscribe = onBrushStroke((e) => events.push(e))

    const canvas = view.canvas()!
    pointer(canvas, 'pointerdown', { x: 10.25, y: 10.5 })
    pointer(canvas, 'pointerup', { x: 10.25, y: 10.5 })

    expect(events[0].intent.tool).toBe('erase')
    expect(events[0].intent.snap).toBe('grid') // snap 态随流携带（擦除不消费）
    expect(events[0].intent.points).toEqual([{ x: 10.25, y: 10.5 }])
    expect(getGemCount()).toBe(12) // [D-5.5] 落点距最近钻 6.73px > 命中圈 5.25px——未命中不删

    unsubscribe()
    view.unmount()
  })

  it('选择工具：pointer 序列不产笔刷意图流', async () => {
    const view = mountView()
    await tick()
    expect(getTool()).toBe('select')

    const events: BrushIntentEvent[] = []
    const unsubscribe = onBrushStroke((e) => events.push(e))

    const canvas = view.canvas()!
    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointermove', { x: 20, y: 10 })
    pointer(canvas, 'pointerup', { x: 20, y: 10 })
    expect(events).toHaveLength(0)

    unsubscribe()
    view.unmount()
  })
})
