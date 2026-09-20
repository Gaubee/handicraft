/*
 * [2026-09-21 redesign-designer-workbench 3.x Test] P5 拖移（design §2 逐行）：纯决策核
 * （轴约束/格位吸附/变更构造/副本构造 design §4.1 复制行）+ jsdom pointer 序列（拖移预览
 * ghost 读数、松手单 patch 单 undo 组、Shift 轴约束、Alt 拖拽复制完整副本语义、Esc 取消
 * 不产 undo 组、锁定层钻不可拖）。沿 marquee 测试模式：FIT 换算 + pointer 助手。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  applyPatch,
  getEditDoc,
  getUndoDepths,
  loadFromHandoff,
  resetEditForTests,
  setSelection,
  undo,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests, setCurrentLayerId, setSnap } from '$lib/designer/workbench.svelte'
import {
  resetInteractionForTests,
  getMovePreview,
  hasActiveGesture,
} from '$lib/designer/interaction.svelte'
import {
  buildGemCopies,
  buildMoveChanges,
  createMoveDragSession,
  resolveMoveDelta,
} from '$lib/designer/gestures'
import { hexSnapPoint } from '$lib/designer/hexSnap'
import { computeFit } from '../../components/Studio/fit'
import { makeHandoff, TEST_PITCH } from '../edit/helpers'

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
  el: Element,
  type: string,
  at: { x: number; y: number },
  extra: { shiftKey?: boolean; altKey?: boolean } = {},
): void {
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
      altKey: extra.altKey ?? false,
    }),
  )
}

function gem(id: string) {
  const doc = getEditDoc()!
  return doc.gems.find((g) => g.id === id)!
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
  resetInteractionForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n.x = 4 + (n-1)*8, y = 4
})

describe('P5 纯决策核', () => {
  it('resolveMoveDelta：Shift 轴约束按主方向锁定（x 主 → 水平）', () => {
    const r = resolveMoveDelta({
      rawDx: 20,
      rawDy: 3,
      shift: true,
      axis: null,
      snapMode: 'free',
      pitch: TEST_PITCH,
      anchor: { x: 4, y: 4 },
    })
    expect(r.axis).toBe('x')
    expect(r.dy).toBe(0)
    expect(r.dx).toBe(20)
  })

  it('resolveMoveDelta：Shift 松开解锁（自由增量）', () => {
    const r = resolveMoveDelta({
      rawDx: 5,
      rawDy: 7,
      shift: false,
      axis: 'x',
      snapMode: 'free',
      pitch: TEST_PITCH,
      anchor: { x: 4, y: 4 },
    })
    expect(r.axis).toBeNull()
    expect(r.dx).toBe(5)
    expect(r.dy).toBe(7)
  })

  it('resolveMoveDelta：grid 吸附 = 锚钻落点吸附六方格位回算增量', () => {
    const r = resolveMoveDelta({
      rawDx: 3.2, // 非格位整倍数
      rawDy: 2.9,
      shift: false,
      axis: null,
      snapMode: 'grid',
      pitch: TEST_PITCH,
      anchor: { x: 4, y: 4 },
    })
    const snapped = hexSnapPoint(4 + 3.2, 4 + 2.9, TEST_PITCH)
    expect(r.dx).toBeCloseTo(snapped.x - 4)
    expect(r.dy).toBeCloseTo(snapped.y - 4)
  })

  it('buildMoveChanges：零位移钻不入（全零 → null）', () => {
    const g1 = { ...gem('g00001') }
    expect(buildMoveChanges([g1], { dx: 0, dy: 0 })).toBeNull()
    const changes = buildMoveChanges([g1], { dx: 8, dy: 0 })!
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({
      id: 'g00001',
      before: { x: 4, y: 4 },
      after: { x: 12, y: 4 },
    })
  })

  it('buildGemCopies：design §4.1 复制行逐字段（id m- 自增/origin manual/blockId null/moved 重置/归目标层/平移）', () => {
    const src = gem('g00001')
    let seq = 0
    const copies = buildGemCopies([src], 'L9', { dx: 8, dy: -8 }, () => `m-${++seq}`)
    expect(copies).toHaveLength(1)
    const c = copies[0]
    expect(c.id).toBe('m-1')
    expect(c.x).toBeCloseTo(src.x + 8)
    expect(c.y).toBeCloseTo(src.y - 8)
    expect(c.origin).toBe('manual')
    expect(c.blockId).toBeNull()
    expect(c.moved).toBe(false)
    expect(c.layerId).toBe('L9')
    // 源钻不受污染
    expect(src.layerId).toBe('L1')
    expect(src.x).toBe(4)
  })
})

describe('P5 会话核（依赖注入假面）', () => {
  function fakeDeps() {
    const applied: unknown[] = []
    const selections: string[][] = []
    let seq = 0
    let layer = 'L1'
    return {
      applied,
      selections,
      setLayer(id: string) {
        layer = id
      },
      deps: {
        applyPatch: (patch: unknown) => {
          applied.push(patch)
          return { ok: true as const }
        },
        setSelection: (ids: Iterable<string>) => {
          selections.push([...ids])
        },
        nextId: () => `m-${++seq}`,
        currentLayerId: () => layer,
        onPreview: () => {},
      },
    }
  }

  it('拖移提交 = 单 update patch；空拖移（未越 slop 后无位移）不产 patch', () => {
    const f = fakeDeps()
    const s = createMoveDragSession(f.deps)
    const g1 = { ...gem('g00001') }
    s.start({ selected: [g1], grabbedId: 'g00001', alt: false, snapMode: 'free', pitch: TEST_PITCH })
    s.update(8, 0, false)
    expect(s.commit()).toBe(true)
    expect(f.applied).toHaveLength(1)
    expect((f.applied[0] as { op: string }).op).toBe('update')
  })

  it('Alt 复制提交 = 单 add patch（副本归当前目标层）+ 选集切副本', () => {
    const f = fakeDeps()
    f.setLayer('L2')
    const s = createMoveDragSession(f.deps)
    s.start({
      selected: [{ ...gem('g00001') }, { ...gem('g00002') }],
      grabbedId: 'g00001',
      alt: true,
      snapMode: 'free',
      pitch: TEST_PITCH,
    })
    s.update(16, 8, false)
    expect(s.commit()).toBe(true)
    expect(f.applied).toHaveLength(1)
    const patch = f.applied[0] as { op: string; gems: Array<{ layerId: string; origin: string }> }
    expect(patch.op).toBe('add')
    expect(patch.gems.every((g) => g.layerId === 'L2' && g.origin === 'manual')).toBe(true)
    expect(f.selections[0]).toHaveLength(2)
  })

  it('cancel 丢弃（不产 patch，预览清零）', () => {
    const f = fakeDeps()
    const s = createMoveDragSession(f.deps)
    s.start({ selected: [{ ...gem('g00001') }], grabbedId: 'g00001', alt: false, snapMode: 'free', pitch: TEST_PITCH })
    s.update(8, 0, false)
    s.cancel()
    expect(f.applied).toHaveLength(0)
    expect(s.active).toBe(false)
  })
})

describe('P5 pointer 序列（视图接线）', () => {
  it('拖移选集：预览 ghost 读数就位 → 松手单 patch 单 undo 组 → 撤销复位', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001', 'g00002'])
    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointermove', { x: 12, y: 4 })
    await tick()
    const preview = getMovePreview()
    expect(preview).not.toBeNull()
    expect(preview!.dx).toBeGreaterThan(0)
    expect(preview!.copy).toBe(false)
    expect(hasActiveGesture()).toBe(true)

    const before = getUndoDepths().undo
    pointer(canvas, 'pointerup', { x: 12, y: 4 })
    await tick()
    expect(getMovePreview()).toBeNull()
    expect(gem('g00001').x).toBeCloseTo(12)
    expect(gem('g00002').x).toBeCloseTo(20)
    expect(getUndoDepths().undo).toBe(before + 1) // 一个 undo 组

    undo()
    await tick()
    expect(gem('g00001').x).toBeCloseTo(4)
    expect(gem('g00002').x).toBeCloseTo(12)

    view.unmount()
  })

  it('未选钻上起拖 = 即时替换选集并拖移（PS 惯例）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00005'])
    pointer(canvas, 'pointerdown', { x: 12, y: 4 }) // g00002 未选
    pointer(canvas, 'pointermove', { x: 20, y: 4 })
    pointer(canvas, 'pointerup', { x: 20, y: 4 })
    await tick()
    // 只有 g00002 被拖移（选集在 down 时已替换为 [g00002]）
    expect(gem('g00002').x).toBeCloseTo(20)
    expect(gem('g00005').x).toBeCloseTo(36)
    expect(selectionIds()).toEqual(['g00002'])

    view.unmount()
  })

  it('Shift 拖起未选钻：并入选集成组移动', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001'])
    pointer(canvas, 'pointerdown', { x: 12, y: 4 }, { shiftKey: true }) // g00002 未选
    pointer(canvas, 'pointermove', { x: 20, y: 4 }, { shiftKey: false }) // 起拖后松 Shift
    pointer(canvas, 'pointerup', { x: 20, y: 4 })
    await tick()
    expect(gem('g00001').x).toBeCloseTo(12)
    expect(gem('g00002').x).toBeCloseTo(20)
    expect(selectionIds()).toEqual(['g00001', 'g00002'])

    view.unmount()
  })

  it('Shift 按住拖移 = 轴约束（水平主向 → dy=0）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001'])
    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointermove', { x: 20, y: 7 }, { shiftKey: true }) // x 主向
    pointer(canvas, 'pointerup', { x: 20, y: 7 }, { shiftKey: true })
    await tick()
    expect(gem('g00001').y).toBeCloseTo(4) // 垂直分量被约束
    expect(gem('g00001').x).toBeGreaterThan(4)

    view.unmount()
  })

  it('Alt 拖拽复制：原钻原位、副本落点、副本语义（manual/blockId null/moved 重置/归当前目标层/id m-）+ 选集切副本', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setSnap('free') // 几何确定性（格位吸附归纯决策核测试面）
    const doc = getEditDoc()!
    applyPatch({
      op: 'layers',
      before: doc.layers.map((l) => ({ ...l })),
      after: [...doc.layers.map((l) => ({ ...l })), { id: 'L2', name: '图层 2', visible: true, locked: false }],
    })
    setCurrentLayerId('L2', getEditDoc())

    setSelection(['g00001'])
    pointer(canvas, 'pointerdown', { x: 4, y: 4 }, { altKey: true })
    pointer(canvas, 'pointermove', { x: 12, y: 12 }, { altKey: true })
    await tick()
    expect(getMovePreview()!.copy).toBe(true)
    pointer(canvas, 'pointerup', { x: 12, y: 12 }, { altKey: true })
    await tick()

    const src = gem('g00001')
    expect(src.x).toBeCloseTo(4) // 原钻原位
    expect(src.layerId).toBe('L1') // 归属不变
    const copy = getEditDoc()!.gems.find((g) => g.id.startsWith('m-'))!
    expect(copy).toBeDefined()
    expect(copy.x).toBeCloseTo(12)
    expect(copy.y).toBeCloseTo(12)
    expect(copy.origin).toBe('manual')
    expect(copy.blockId).toBeNull()
    expect(copy.moved).toBe(false)
    expect(copy.layerId).toBe('L2') // 副本归当前目标层
    expect(selectionIds()).toEqual([copy.id]) // 选集切副本

    undo()
    await tick()
    expect(getEditDoc()!.gems.some((g) => g.id === copy.id)).toBe(false) // 单组撤销移除副本

    view.unmount()
  })

  it('跨层选集 Alt 复制：副本统一归当前层（原钻归属不变）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setSnap('free') // 几何确定性
    const doc = getEditDoc()!
    applyPatch({
      op: 'layers',
      before: doc.layers.map((l) => ({ ...l })),
      after: [...doc.layers.map((l) => ({ ...l })), { id: 'L2', name: '图层 2', visible: true, locked: false }],
    })
    applyPatch({
      op: 'update',
      changes: [{ id: 'g00002', before: { layerId: 'L1' }, after: { layerId: 'L2' } }],
    })
    setCurrentLayerId('L2', getEditDoc())

    setSelection(['g00001', 'g00002'])
    pointer(canvas, 'pointerdown', { x: 4, y: 4 }, { altKey: true })
    pointer(canvas, 'pointermove', { x: 12, y: 4 }, { altKey: true })
    pointer(canvas, 'pointerup', { x: 12, y: 4 }, { altKey: true })
    await tick()

    const copies = getEditDoc()!.gems.filter((g) => g.id.startsWith('m-'))
    expect(copies).toHaveLength(2)
    expect(copies.every((c) => c.layerId === 'L2')).toBe(true) // 跨层选集统一归当前层
    expect(gem('g00001').layerId).toBe('L1')
    expect(gem('g00002').layerId).toBe('L2')

    view.unmount()
  })

  it('Esc 取消进行中拖移：不产 patch、选择保持、无 undo 组', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001'])
    const before = getUndoDepths().undo
    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointermove', { x: 20, y: 4 })
    await tick()
    expect(getMovePreview()).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
    expect(getMovePreview()).toBeNull()
    expect(gem('g00001').x).toBeCloseTo(4)
    expect(getUndoDepths().undo).toBe(before)
    expect(selectionIds()).toEqual(['g00001']) // 取消优先于清空选择

    view.unmount()
  })

  it('锁定层钻不可拖（视为空白：tap 清空/拖为框选）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const doc = getEditDoc()!
    doc.layers[0].locked = true

    setSelection(['g00005'])
    pointer(canvas, 'pointerdown', { x: 4, y: 4 }) // 锁定层 g00001 上
    pointer(canvas, 'pointermove', { x: 12, y: 4 })
    pointer(canvas, 'pointerup', { x: 12, y: 4 })
    await tick()
    // 锁定层 = 空白 → 框选收集（全锁 → 命中空 → 清空）；无论如何 g00001 不被拖移
    expect(gem('g00001').x).toBeCloseTo(4)

    view.unmount()
  })

  it('slop 内 up = tap（无拖移 patch）——钻上 tap 幂等保持选集', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001'])
    const before = getUndoDepths().undo
    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 5, y: 4 }) // slop 内
    await tick()
    expect(getUndoDepths().undo).toBe(before)
    expect(selectionIds()).toEqual(['g00001'])

    view.unmount()
  })
})
