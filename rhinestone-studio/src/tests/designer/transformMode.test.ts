/*
 * [2026-09-21 rework-designer-manual-rhinestone R4.1 Test] ⌘T 自由变换态（design §3.1）：
 * 纯决策核（包围盒/柄锚点/缩放系数/组旋转增量/变更构造）+ 命令门控（enter/confirm/cancel）
 * + jsdom pointer 序列（角柄缩放/外柄旋转/复合/取消）+ **§2 尺寸安全红线 invariant**
 * （变换前后全钻 (x,y) 逐位相等——任何面不得移动钻位/触发重吸附；含 apply-spec 批量面）。
 * 单选专用 P6/P7 柄已退役（形态矩阵见 transformHandles.test.ts）。
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
  type DesignerGem,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import {
  getTransformMode,
  getTransformReadout,
  isTransformModeActive,
  resetInteractionForTests,
} from '$lib/designer/interaction.svelte'
import { execDesignerCommand } from '$lib/designer/commands'
import {
  buildTransformChanges,
  handleAnchorOf,
  isRotateHandle,
  rotationDeltaFromDrag,
  scaleFromDrag,
  scaledDiameterMm,
  selectionBoundsOf,
} from '$lib/designer/gestures'
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
/** SS10 半径 px（2.8mm × 2.5px/mm ÷ 2）。 */
const R = 3.5

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

/** 柄上 pointerdown（client 坐标 = 图像坐标经 FIT 换算）。 */
function pointerDown(el: Element, at: { x: number; y: number }, alt = false): void {
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
      altKey: alt,
    }),
  )
}

/** 会话 move/up 走 window（组件会话监听面）。 */
function windowPointer(
  type: string,
  at: { x: number; y: number },
  shift = false,
): void {
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
      shiftKey: shift,
    }),
  )
}

function key(k: string, mods: { meta?: boolean; shift?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
  })
  window.dispatchEvent(event)
  return event
}

function gem(id: string) {
  const doc = getEditDoc()!
  return doc.gems.find((g) => g.id === id)!
}

/** 全钻 (x,y) 快照（红线 invariant 断言基线）。 */
function positions(): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  for (const g of getEditDoc()!.gems) out[g.id] = { x: g.x, y: g.y }
  return out
}

/** 红线断言：全钻 (x,y) 与基线**逐位相等**（toBe——零容差）。 */
function expectPositionsFrozen(before: Record<string, { x: number; y: number }>): void {
  const after = positions()
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  for (const [id, p] of Object.entries(before)) {
    expect(after[id].x).toBe(p.x)
    expect(after[id].y).toBe(p.y)
  }
}

/** 选中钻改非 round 形（旋转语义可见）。 */
function makeSquare(ids: string[]): void {
  applyPatch({
    op: 'update',
    changes: ids.map((id) => ({ id, before: { shapeId: 'round' as const }, after: { shapeId: 'square' as const } })),
  })
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
  resetInteractionForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n.x = 4 + (n-1)*8, y = 4；SS10 直径 2.8mm → 半径 3.5px
})

// ---------------------------------------------------------------------------
// P9 纯决策核
// ---------------------------------------------------------------------------

/** 纯核测试钻构造（buildTransformChanges/selectionBoundsOf 只读规格与几何字段）。 */
function mkGem(overrides: Partial<DesignerGem> & { id: string }): DesignerGem {
  return {
    x: 0,
    y: 0,
    colorId: 'c1',
    blockId: null,
    origin: 'manual',
    moved: false,
    shapeId: 'round',
    diameterMm: 2.8,
    layerId: 'L1',
    ...overrides,
  }
}

describe('P9 纯决策核：包围盒/柄锚点', () => {
  it('selectionBoundsOf：空选集 null；逐钻外扩半径取 min/max', () => {
    expect(selectionBoundsOf([], () => R)).toBeNull()
    // 两颗 (4,4)/(20,4) 半径 3.5 → [0.5, 23.5]×[0.5, 7.5]
    const bounds = selectionBoundsOf([mkGem({ id: 'a', x: 4, y: 4 }), mkGem({ id: 'b', x: 20, y: 4 })], () => R)!
    expect(bounds.x0).toBeCloseTo(0.5)
    expect(bounds.x1).toBeCloseTo(23.5)
    expect(bounds.y0).toBeCloseTo(0.5)
    expect(bounds.y1).toBeCloseTo(7.5)
  })

  it('handleAnchorOf：角柄 = 盒角；外柄 = 边中点；isRotateHandle 分族', () => {
    const bounds = { x0: 0, y0: 0, x1: 40, y1: 10 }
    expect(handleAnchorOf(bounds, 'nw')).toEqual({ x: 0, y: 0 })
    expect(handleAnchorOf(bounds, 'se')).toEqual({ x: 40, y: 10 })
    expect(handleAnchorOf(bounds, 'n')).toEqual({ x: 20, y: 0 })
    expect(handleAnchorOf(bounds, 'e')).toEqual({ x: 40, y: 5 })
    expect(isRotateHandle('n')).toBe(true)
    expect(isRotateHandle('w')).toBe(true)
    expect(isRotateHandle('nw')).toBe(false)
    expect(isRotateHandle('se')).toBe(false)
  })
})

describe('P9 纯决策核：缩放系数/缩放直径', () => {
  const center = { x: 20, y: 4 }
  const anchor = { x: 39.5, y: 7.5 } // se 角柄（距盒心 19.5×3.5）

  it('scaleFromDrag：柄位起拖 = 1；径向比出系数；退化基距/非法 = 1', () => {
    expect(scaleFromDrag({ center, startAnchor: anchor, pointer: anchor })).toBeCloseTo(1)
    // ×1.2：指针 = 盒心 + (柄-盒心)×1.2
    const p120 = { x: 20 + 19.5 * 1.2, y: 4 + 3.5 * 1.2 }
    expect(scaleFromDrag({ center, startAnchor: anchor, pointer: p120 })).toBeCloseTo(1.2)
    expect(scaleFromDrag({ center, startAnchor: center, pointer: anchor })).toBe(1) // 基距 0
    expect(scaleFromDrag({ center, startAnchor: anchor, pointer: { x: Number.NaN, y: 4 } })).toBe(1)
  })

  it('scaledDiameterMm：等比缩放两位量化；值域 [0.01,50] 夹取；非法系数原样', () => {
    expect(scaledDiameterMm(2.8, 1.2)).toBe(3.36)
    expect(scaledDiameterMm(2.8, 100)).toBe(50) // 上界夹取
    expect(scaledDiameterMm(2.8, 0.0001)).toBe(0.01) // 下界夹取
    expect(scaledDiameterMm(2.8, 0)).toBe(2.8) // 非法系数
  })
})

describe('P9 纯决策核：组旋转增量', () => {
  it('rotationDeltaFromDrag：角位移；Shift = 15° 步进格（组语义步进增量）；两位小数', () => {
    expect(rotationDeltaFromDrag({ startPointerAngle: 0, pointerAngle: 90, shift: false })).toBe(90)
    // 100° → 步进最近格 105°
    expect(rotationDeltaFromDrag({ startPointerAngle: 0, pointerAngle: 100, shift: true })).toBe(105)
    // 逆时针负增量
    expect(rotationDeltaFromDrag({ startPointerAngle: 90, pointerAngle: 30, shift: false })).toBe(-60)
    // 非步进档保留两位小数
    expect(rotationDeltaFromDrag({ startPointerAngle: 0, pointerAngle: 10.12345, shift: false })).toBe(10.12)
  })
})

describe('P9 变更构造（buildTransformChanges）+ §2 红线字段冻结', () => {
  it('changes 只含 diameterMm/rotationDeg 字段——x/y 恒不入（红线冻结面）', () => {
    const gems = [
      mkGem({ id: 'a', x: 4, y: 4, shapeId: 'square', rotationDeg: 10 }),
      mkGem({ id: 'b', x: 12, y: 4 }),
    ]
    const changes = buildTransformChanges(gems, {
      a: { diameterMm: 3.36, rotationDeg: 100 },
      b: { diameterMm: 3.36, rotationDeg: 999 }, // round：rotationDeg 恒不写
    })
    expect(changes).toHaveLength(2)
    for (const c of changes) {
      expect(Object.keys(c.before).every((k) => k === 'diameterMm' || k === 'rotationDeg')).toBe(true)
      expect(Object.keys(c.after).every((k) => k === 'diameterMm' || k === 'rotationDeg')).toBe(true)
    }
    expect(changes[0].after).toEqual({ diameterMm: 3.36, rotationDeg: 100 })
    // round 钻只有直径变更——旋转字段被裁掉（design §3.1 裁断）
    expect(changes[1].after).toEqual({ diameterMm: 3.36 })
  })

  it('值未变/无 pending 的钻不入 changes；悬空 id 忽略', () => {
    const gems = [mkGem({ id: 'a', shapeId: 'square' })]
    expect(buildTransformChanges(gems, {})).toEqual([])
    expect(buildTransformChanges(gems, { a: { diameterMm: 2.8 } })).toEqual([]) // 值未变
    expect(buildTransformChanges(gems, { ghost: { diameterMm: 9 } })).toEqual([]) // 悬空 id
  })
})

// ---------------------------------------------------------------------------
// 命令门控（enter/confirm/cancel）
// ---------------------------------------------------------------------------

describe('⌘T 命令门控', () => {
  it('空选集 ⌘T no-op（命令 false + 键位放行浏览器默认）', async () => {
    const view = mountView()
    await tick()
    expect(execDesignerCommand({ kind: 'enter-transform' })).toBe(false)
    const e = key('t', { meta: true })
    expect(e.defaultPrevented).toBe(false)
    expect(isTransformModeActive()).toBe(false)
    view.unmount()
  })

  it('⌘T 单选 round：进态成功 + rotationEnabled=false；⌘T 二按 no-op', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    expect(execDesignerCommand({ kind: 'enter-transform' })).toBe(true)
    const mode = getTransformMode()!
    expect(mode.gemIds).toEqual(['g00001'])
    expect(mode.rotationEnabled).toBe(false) // round-only
    expect(mode.bounds.x0).toBeCloseTo(4 - R)
    expect(mode.bounds.x1).toBeCloseTo(4 + R)
    // ⌘T 二按 no-op
    expect(execDesignerCommand({ kind: 'enter-transform' })).toBe(false)
    view.unmount()
  })

  it('Enter 无拖拽 = 收起变换盒（零 patch，选集保持）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001', 'g00002'])
    execDesignerCommand({ kind: 'enter-transform' })
    const before = getUndoDepths().undo
    expect(execDesignerCommand({ kind: 'confirm-transform' })).toBe(true)
    expect(isTransformModeActive()).toBe(false)
    expect(getUndoDepths().undo).toBe(before)
    expect([...getEditDoc()!.selection].sort()).toEqual(['g00001', 'g00002'])
    view.unmount()
  })

  it('Esc 键取消：零 patch 退态、选集保持（取消链变换态最优先）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    execDesignerCommand({ kind: 'enter-transform' })
    const before = getUndoDepths().undo
    key('Escape')
    await tick()
    expect(isTransformModeActive()).toBe(false)
    expect(getUndoDepths().undo).toBe(before)
    expect(gem('g00001').diameterMm).toBeCloseTo(2.8)
    expect([...getEditDoc()!.selection]).toEqual(['g00001']) // 取消优先于清空选择
    view.unmount()
  })
})

// ---------------------------------------------------------------------------
// pointer 序列：角柄缩放 / 外柄旋转 / 复合 / 取消（含 §2 红线 invariant）
// ---------------------------------------------------------------------------

/** 五颗选集（g00001-g00005）包围盒：x [0.5, 39.5]，y [0.5, 7.5]，盒心 (20, 4)。 */
const FIVE = ['g00001', 'g00002', 'g00003', 'g00004', 'g00005'] as const
const SE_ANCHOR = { x: 39.5, y: 7.5 }
const CENTER = { x: 20, y: 4 }

describe('⌘T 角柄缩放 → Enter（spec Scenario：多选批量改尺寸不挪位）', () => {
  it('5 颗 ×1.2：直径字段放大、角度不变、(x,y) 逐位相等、单 undo 组一次恢复', async () => {
    const view = mountView()
    await tick()
    setSelection([...FIVE])
    execDesignerCommand({ kind: 'enter-transform' })
    await tick()
    const frozen = positions()
    const before = getUndoDepths().undo

    const handle = view.q('designer-transform-handle-se')!
    pointerDown(handle, SE_ANCHOR)
    windowPointer('pointermove', { x: CENTER.x + 19.5 * 1.2, y: CENTER.y + 3.5 * 1.2 })
    await tick()
    // 拖拽中：pending 实时累积 + 读数气泡（%/mm 惯例）
    expect(getTransformMode()!.pending['g00001']!.diameterMm).toBeCloseTo(3.36)
    expect(getTransformReadout()).toEqual({ kind: 'scale', percent: 120, mm: null })
    expect(view.q('designer-transform-readout')!.textContent).toContain('%')
    windowPointer('pointerup', { x: CENTER.x + 19.5 * 1.2, y: CENTER.y + 3.5 * 1.2 })
    await tick()
    // 松手保持预览（多柄连拖语义）——文档未写
    expect(gem('g00001').diameterMm).toBeCloseTo(2.8)

    key('Enter')
    await tick()
    for (const id of FIVE) {
      expect(gem(id).diameterMm).toBeCloseTo(3.36)
      expect(gem(id).rotationDeg ?? 0).toBe(0)
    }
    expectPositionsFrozen(frozen) // 红线：钻位逐位不动
    expect(getUndoDepths().undo).toBe(before + 1) // 单 patch 单 undo 组
    expect(isTransformModeActive()).toBe(false)

    undo()
    await tick()
    for (const id of FIVE) expect(gem(id).diameterMm).toBeCloseTo(2.8)
    expectPositionsFrozen(frozen)
    view.unmount()
  })

  it('单选缩放读数附 mm（Ø）；画布按下 = 确认提交（PS 框外点击应用）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    execDesignerCommand({ kind: 'enter-transform' })
    await tick()
    const frozen = positions()

    const handle = view.q('designer-transform-handle-se')!
    pointerDown(handle, { x: 4 + R, y: 4 + R })
    windowPointer('pointermove', { x: 4 + R * 2, y: 4 + R * 2 }) // ×2
    await tick()
    expect(view.q('designer-transform-readout')!.textContent).toContain('mm')
    windowPointer('pointerup', { x: 4 + R * 2, y: 4 + R * 2 })

    // 画布空白按下 → 先确认变换再让位手势（模式退出 + 单 patch）
    const canvas = view.canvas()!
    const c = clientOf(50, 50)
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', button: 0, buttons: 1, clientX: c.clientX, clientY: c.clientY }),
    )
    await tick()
    expect(gem('g00001').diameterMm).toBeCloseTo(5.6)
    expect(isTransformModeActive()).toBe(false)
    expectPositionsFrozen(frozen)
    view.unmount()
  })
})

describe('⌘T 外柄旋转 → Enter', () => {
  it('混合选集 +90°（Shift 步进）：非 round 旋至 90、round 恒 0、(x,y) 逐位相等、直径不变', async () => {
    makeSquare(['g00001', 'g00002']) // g00003 保持 round → 混合选集
    const view = mountView()
    await tick()
    setSelection(['g00001', 'g00002', 'g00003'])
    const frozen = positions()
    const before = getUndoDepths().undo
    // 三颗选集包围盒：x [0.5, 23.5] × y [0.5, 7.5]——盒心 (12, 4)，e 外柄锚 (23.5, 4)
    const center3 = { x: 12, y: 4 }

    // ⌘T 后混合选集 rotationEnabled=true（非 round-only）
    key('t', { meta: true })
    await tick()
    expect(getTransformMode()!.rotationEnabled).toBe(true)

    const handle = view.q('designer-transform-rotate-e')!
    pointerDown(handle, { x: 23.5, y: 4 }) // e 外柄锚（起角 0°）
    windowPointer('pointermove', { x: center3.x, y: center3.y + 15.5 }, true) // 指针角 90°（Shift 步进格）
    await tick()
    expect(getTransformMode()!.pending['g00001']!.rotationDeg).toBe(90)
    expect(getTransformMode()!.pending['g00003']).toBeUndefined() // round 不入 pending 旋转
    expect(view.q('designer-transform-readout')!.textContent).toContain('°')
    windowPointer('pointerup', { x: center3.x, y: center3.y + 15.5 }, true)

    key('Enter')
    await tick()
    expect(gem('g00001').rotationDeg).toBe(90)
    expect(gem('g00002').rotationDeg).toBe(90)
    expect(gem('g00003').rotationDeg ?? 0).toBe(0) // round 旋转值恒 0
    for (const id of ['g00001', 'g00002', 'g00003']) expect(gem(id).diameterMm).toBeCloseTo(2.8)
    expectPositionsFrozen(frozen)
    expect(getUndoDepths().undo).toBe(before + 1)
    view.unmount()
  })

  it('round-only 选集：旋转柄禁用（data-disabled）不 armed，角柄缩放可用', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001', 'g00002'])
    key('t', { meta: true })
    await tick()
    expect(getTransformMode()!.rotationEnabled).toBe(false)
    for (const id of ['n', 'e', 's', 'w']) {
      const el = view.q(`designer-transform-rotate-${id}`)!
      expect(el.getAttribute('data-disabled')).toBe('true')
      expect(el.getAttribute('aria-disabled')).toBe('true')
    }
    expect(view.q('designer-transform-handle-se')!.getAttribute('data-disabled')).toBeNull()
    view.unmount()
  })
})

describe('⌘T 复合变换（缩放 + 旋转连拖）单 undo 组', () => {
  it('同态先 ×1.2 缩放再 +90° 旋转：Enter 一次提交整组字段、一组撤销恢复', async () => {
    makeSquare([...FIVE])
    const view = mountView()
    await tick()
    setSelection([...FIVE])
    key('t', { meta: true })
    await tick()
    const frozen = positions()
    const before = getUndoDepths().undo

    // 拖 1：se 角柄 ×1.2
    pointerDown(view.q('designer-transform-handle-se')!, SE_ANCHOR)
    windowPointer('pointermove', { x: CENTER.x + 19.5 * 1.2, y: CENTER.y + 3.5 * 1.2 })
    windowPointer('pointerup', { x: CENTER.x + 19.5 * 1.2, y: CENTER.y + 3.5 * 1.2 })
    await tick()
    // 拖 2：e 外柄 +90°（以拖 1 后的 pending 为基线复合——直径保持 3.36）
    pointerDown(view.q('designer-transform-rotate-e')!, { x: 39.5, y: 4 })
    windowPointer('pointermove', { x: CENTER.x, y: CENTER.y + 15.5 })
    windowPointer('pointerup', { x: CENTER.x, y: CENTER.y + 15.5 })
    await tick()
    expect(getTransformMode()!.pending['g00001']!.diameterMm).toBeCloseTo(3.36)
    expect(getTransformMode()!.pending['g00001']!.rotationDeg).toBe(90)

    key('Enter')
    await tick()
    for (const id of FIVE) {
      expect(gem(id).diameterMm).toBeCloseTo(3.36)
      expect(gem(id).rotationDeg).toBe(90)
    }
    expectPositionsFrozen(frozen)
    expect(getUndoDepths().undo).toBe(before + 1) // 复合仍单组

    undo()
    await tick()
    for (const id of FIVE) {
      expect(gem(id).diameterMm).toBeCloseTo(2.8)
      expect(gem(id).rotationDeg ?? 0).toBe(0)
    }
    expectPositionsFrozen(frozen)
    view.unmount()
  })
})

describe('Esc 取消变换（拖拽中）：零 patch', () => {
  it('拖拽中 Esc：pending 丢弃、文档零变更、选集保持', async () => {
    const view = mountView()
    await tick()
    setSelection([...FIVE])
    key('t', { meta: true })
    await tick()
    const frozen = positions()
    const before = getUndoDepths().undo

    pointerDown(view.q('designer-transform-handle-se')!, SE_ANCHOR)
    windowPointer('pointermove', { x: CENTER.x + 19.5 * 1.2, y: CENTER.y + 3.5 * 1.2 })
    await tick()
    key('Escape')
    await tick()
    expect(isTransformModeActive()).toBe(false)
    expect(getTransformMode()).toBeNull()
    for (const id of FIVE) expect(gem(id).diameterMm).toBeCloseTo(2.8)
    expectPositionsFrozen(frozen)
    expect(getUndoDepths().undo).toBe(before)
    expect([...getEditDoc()!.selection].sort()).toEqual([...FIVE].sort())
    view.unmount()
  })
})

// ---------------------------------------------------------------------------
// §2 尺寸安全红线 invariant（验收门——任何尺寸变更面不得移动钻位/触发重吸附）
// ---------------------------------------------------------------------------

describe('尺寸安全红线 invariant（design §2——跨面冻结）', () => {
  it('apply-spec 批量改规格：全钻 (x,y) 逐位相等（⌘T 面已在上述各流冻结）', async () => {
    const view = mountView()
    await tick()
    const frozen = positions()
    const colorId = getEditDoc()!.palette[0].id
    setSelection(['g00001', 'g00002', 'g00003'])
    expect(
      execDesignerCommand({ kind: 'apply-spec', spec: { shapeId: 'square', diameterMm: 3.5, colorId } }),
    ).toBe(true)
    await tick()
    expect(gem('g00001').shapeId).toBe('square')
    expect(gem('g00001').diameterMm).toBeCloseTo(3.5)
    expectPositionsFrozen(frozen)
    view.unmount()
  })
})
