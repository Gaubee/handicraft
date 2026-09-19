/*
 * [2026-09-20 C-3.5 Test] nudge 微移与对齐分布（rename-and-expert-workbench tasks 3.5）：
 * 三档步进（1px / Shift=pitch / Alt=0.1mm）、按键会话合组 undo（500ms 静默窗）、
 * 对齐六式 / 等距分布几何（纯函数）、批量 = 单 undo 组、键盘分派（EditView 接线：
 * 方向键/⌘Z/⌘⇧Z/输入控件聚焦放行）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import {
  getEditDoc,
  getUndoDepths,
  loadFromHandoff,
  redo,
  resetEditForTests,
  setSelection,
  undo,
  type EditPatch,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '../../components/Edit/workbench.svelte'
import { NudgeSession, NUDGE_SESSION_IDLE_MS, type NudgeSessionDeps } from '../../components/Edit/nudgeSession'
import { nudgeStepPx, handleWorkbenchKeydown } from '../../components/Edit/editKeyboard'
import { buildAlignChanges, buildDistributeChanges } from '../../components/Edit/alignDistribute'
import { applyGemChanges } from '../../components/Edit/gemCommands'
import type { EditGem } from '$lib/engine'
import { makeHandoff } from './helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function gem(id: string): EditGem {
  const found = getEditDoc()!.gems.find((g) => g.id === id)
  if (!found) throw new Error(`missing gem ${id}`)
  return found
}

function mountView(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EditView, { target })
  return { target, unmount: () => { unmount(app); target.remove() } }
}

function key(keyboard: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }, target?: Element): void {
  const el = target ?? window
  el.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: keyboard.key,
      shiftKey: keyboard.shiftKey ?? false,
      altKey: keyboard.altKey ?? false,
      metaKey: keyboard.metaKey ?? false,
      ctrlKey: keyboard.ctrlKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  )
}

/** 会话静默收组等待（真时钟——mount 域不引入 fake timers） */
async function waitIdle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, NUDGE_SESSION_IDLE_MS + 40))
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n: x=4+(n-1)*8, y=4；grid SS10@2.5 → pitch 8px、ppm 2.5
})

describe('三档步进（nudgeStepPx 纯函数）', () => {
  const grid = makeHandoff().grid

  it('默认 1px；Shift = pitch(px)=8；Alt = 0.1mm×2.5=0.25px', () => {
    expect(nudgeStepPx({ shift: false, alt: false }, grid)).toBe(1)
    expect(nudgeStepPx({ shift: true, alt: false }, grid)).toBeCloseTo(8, 10)
    expect(nudgeStepPx({ shift: false, alt: true }, grid)).toBeCloseTo(0.25, 12)
    expect(nudgeStepPx({ shift: true, alt: true }, grid)).toBeCloseTo(0.25, 12) // Shift+Alt 取精调
  })
})

describe('按键会话合组（NudgeSession + fake timers）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function fakeDeps() {
    const calls = { begin: 0, end: 0, patches: [] as EditPatch[] }
    const deps: NudgeSessionDeps = {
      beginStroke: () => { calls.begin++ },
      endStroke: () => { calls.end++ },
      applyPatch: (patch) => { calls.patches.push(patch); return { ok: true } },
    }
    return { deps, calls }
  }

  const gems = (): EditGem[] => [
    { ...gem('g00001') },
    { ...gem('g00002') },
  ]

  it('窗口内连续按键 = 单组：begin 一次、静默期满 end 一次', () => {
    const { deps, calls } = fakeDeps()
    const session = new NudgeSession(deps)
    session.nudge(gems(), -1, 0)
    vi.advanceTimersByTime(200)
    session.nudge(gems(), -1, 0)
    vi.advanceTimersByTime(200)
    session.nudge(gems(), 0, 1)
    expect(calls.begin).toBe(1)
    expect(calls.end).toBe(0) // 未静默
    vi.advanceTimersByTime(NUDGE_SESSION_IDLE_MS)
    expect(calls.end).toBe(1) // 静默收组
    expect(calls.patches).toHaveLength(3)
  })

  it('静默后再按 = 新组', () => {
    const { deps, calls } = fakeDeps()
    const session = new NudgeSession(deps)
    session.nudge(gems(), 1, 0)
    vi.advanceTimersByTime(NUDGE_SESSION_IDLE_MS)
    session.nudge(gems(), 1, 0)
    expect(calls.begin).toBe(2)
    expect(calls.end).toBe(1)
  })

  it('微移 patch 只记位移轴（dy=0 不写 y）', () => {
    const { deps, calls } = fakeDeps()
    const session = new NudgeSession(deps)
    session.nudge(gems(), -1, 0)
    const patch = calls.patches[0]
    expect(patch.op).toBe('update')
    if (patch.op === 'update') {
      expect(patch.changes[0].before).toEqual({ x: 4 })
      expect(patch.changes[0].after).toEqual({ x: 3 })
    }
  })

  it('空选/零位移 no-op；flush 幂等收组', () => {
    const { deps, calls } = fakeDeps()
    const session = new NudgeSession(deps)
    expect(session.nudge([], 1, 0)).toBe(false)
    expect(session.nudge(gems(), 0, 0)).toBe(false)
    session.nudge(gems(), 1, 0)
    session.flush()
    session.flush()
    expect(calls.end).toBe(1)
  })
})

describe('对齐分布几何（纯函数）', () => {
  it('左/右对齐与水平居中（只消费 x/y）', () => {
    const picks = ['g00001', 'g00002', 'g00003'].map(gem)
    // x = 4 / 12 / 20
    const left = buildAlignChanges(picks, 'left')
    expect(left.map((c) => c.after)).toEqual([{ x: 4 }, { x: 4 }])
    expect(left.every((c) => c.before.x !== undefined && c.after.y === undefined)).toBe(true)

    const right = buildAlignChanges(picks, 'right')
    expect(right.map((c) => c.after)).toEqual([{ x: 20 }, { x: 20 }])

    const centerX = buildAlignChanges(picks, 'center-x')
    expect(centerX.map((c) => c.after.x)).toEqual([12, 12])
  })

  it('水平等距：首尾锚定、中间等距；<3 或退化 → null/空', () => {
    const picks = ['g00001', 'g00002', 'g00003'].map(gem) // x 4/12/20 → 等距已成立（step 8）
    expect(buildDistributeChanges(picks, 'horizontal')).toEqual([])

    // 打乱中间位：g00002 x → 10
    const moved = picks.map((g) => (g.id === 'g00002' ? { ...g, x: 10 } : g))
    const changes = buildDistributeChanges(moved, 'horizontal')!
    expect(changes).toEqual([{ id: 'g00002', before: { x: 10 }, after: { x: 12 } }])

    expect(buildDistributeChanges(picks.slice(0, 2), 'horizontal')).toBeNull()
    const collinear = picks.map((g) => ({ ...g, x: 4 }))
    expect(buildDistributeChanges(collinear, 'horizontal')).toBeNull()
  })

  it('垂直等距与顶/底/垂直居中', () => {
    const picks = [
      { ...gem('g00001'), y: 0 },
      { ...gem('g00002'), y: 5 },
      { ...gem('g00003'), y: 20 },
    ]
    const changes = buildDistributeChanges(picks, 'vertical')!
    expect(changes).toEqual([{ id: 'g00002', before: { y: 5 }, after: { y: 10 } }])
    expect(buildAlignChanges(picks, 'top').map((c) => c.after)).toEqual([{ y: 0 }, { y: 0 }])
    expect(buildAlignChanges(picks, 'center-y').map((c) => c.after.y)).toEqual([10, 10, 10]) // 全体移到中线
    expect(buildAlignChanges(picks, 'bottom').map((c) => c.after)).toEqual([{ y: 20 }, { y: 20 }])
  })
})

describe('键盘分派（EditView 接线 mount）', () => {
  it('方向键三档：默认 1px / Shift 8px / Alt 0.25px', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()

    key({ key: 'ArrowLeft' })
    expect(gem('g00001').x).toBe(3)

    key({ key: 'ArrowRight', shiftKey: true })
    expect(gem('g00001').x).toBe(11)

    key({ key: 'ArrowUp', altKey: true })
    expect(gem('g00001').y).toBeCloseTo(3.75, 12)

    await waitIdle() // 收组，避免悬挂会话影响后续
    view.unmount()
  })

  it('连续按键一会话一组：两次微移 = undo 深度 1，undo 整组回退', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()

    key({ key: 'ArrowLeft' })
    key({ key: 'ArrowLeft' })
    key({ key: 'ArrowDown' })
    expect(gem('g00001').x).toBe(2)
    expect(gem('g00001').y).toBe(5)

    await waitIdle()
    expect(getUndoDepths().undo).toBe(1) // 会话合组：三次按键一组
    undo()
    expect(gem('g00001').x).toBe(4)
    expect(gem('g00001').y).toBe(4)

    view.unmount()
  })

  it('无选中时方向键放行（不产生 undo 组）', async () => {
    const view = mountView()
    await tick()
    key({ key: 'ArrowLeft' })
    expect(getUndoDepths().undo).toBe(0)
    view.unmount()
  })

  it('输入控件聚焦时键盘归表单（不微移）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    key({ key: 'ArrowLeft' }, input)
    expect(gem('g00001').x).toBe(4)
    input.remove()

    await waitIdle()
    view.unmount()
  })

  it('⌘Z / ⌘⇧Z：撤销重做（按钮同命令面）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    key({ key: 'ArrowLeft' })
    await waitIdle()
    expect(gem('g00001').x).toBe(3)

    key({ key: 'z', metaKey: true })
    expect(gem('g00001').x).toBe(4)
    key({ key: 'z', metaKey: true, shiftKey: true })
    expect(gem('g00001').x).toBe(3)

    view.unmount()
  })

  it('对齐/分布命令按钮：几何生效 + 批量单组', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001', 'g00002', 'g00003'])
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="edit-align-left"]')!.click()
    await tick()
    expect(gem('g00002').x).toBe(4)
    expect(gem('g00003').x).toBe(4)
    expect(getUndoDepths().undo).toBe(1)
    undo()
    expect(gem('g00003').x).toBe(20)

    // 等距分布（先破坏等距）
    applyGemChanges([
      { id: 'g00002', before: { x: gem('g00002').x }, after: { x: 10 } },
    ])
    view.target.querySelector<HTMLButtonElement>('[data-testid="edit-distribute-horizontal"]')!.click()
    await tick()
    expect(gem('g00002').x).toBe(12)
    expect(getUndoDepths().undo).toBe(2) // 手动改位一组 + 分布一组

    view.unmount()
  })
})
