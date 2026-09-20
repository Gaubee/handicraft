/*
 * [2026-09-21 redesign-designer-workbench 3.x Test] P6/P7 变换手柄（design §2.1 + §2 逐行）：
 * 纯决策核（旋转角/15° 步进/直径值域 (0,50] 越域 null）+ 视图接线（手柄形态矩阵：单选非圆
 * =旋转柄+双直径柄、圆钻旋转柄隐藏、多选无手柄、非选择工具无手柄；拖拽会话：实时读数、
 * 松手单 patch 单 undo 组、直径越域回滚、Esc 取消）。沿 marquee 测试模式（FIT 换算）。
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
import { resetWorkbenchForTests, setTool } from '$lib/designer/workbench.svelte'
import {
  resetInteractionForTests,
  getTransformPreview,
} from '$lib/designer/interaction.svelte'
import { diameterFromDrag, rotationFromDrag, buildRotationChange } from '$lib/designer/gestures'
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
const PX_PER_MM = 2.5 // 测试网格 pixelsPerMm（gridFromSs('SS10', 2.5)）

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

/** 手柄上的 pointerdown（client 坐标 = 图像坐标经 FIT 换算）。 */
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

/** 会话 move/up 走 window（组件会话监听面）。 */
function windowPointer(type: string, at: { x: number; y: number }, shift = false): void {
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

function gem(id: string) {
  const doc = getEditDoc()!
  return doc.gems.find((g) => g.id === id)!
}

/** 直径预览读数（类型窄化助手）。 */
function diameterPreviewMm(): number {
  const p = getTransformPreview()
  if (p === null || p.kind !== 'diameter') throw new Error('预览类型不符')
  return p.valueMm
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

describe('P6/P7 纯决策核', () => {
  it('rotationFromDrag：角位移合成 + Shift 15° 步进 + 归一 [0,360)', () => {
    expect(
      rotationFromDrag({ startPointerAngle: 90, pointerAngle: 180, startRotationDeg: 0, shift: false }),
    ).toBeCloseTo(90)
    // Shift 步进：raw 47 → 最近 45
    expect(
      rotationFromDrag({ startPointerAngle: 0, pointerAngle: 47, startRotationDeg: 0, shift: true }),
    ).toBe(45)
    // 负角归一：起 10° 逆时针拉 20° → 350
    expect(
      rotationFromDrag({ startPointerAngle: 0, pointerAngle: -10, startRotationDeg: 0, shift: false }),
    ).toBeCloseTo(350)
  })

  it('diameterFromDrag：px→mm 换算；值域 (0,50] 越界/非法 = null', () => {
    expect(diameterFromDrag(3.5, PX_PER_MM)).toBeCloseTo(2.8) // 半径 3.5px → 2.8mm
    expect(diameterFromDrag(62.5, PX_PER_MM)).toBe(50) // 恰上界
    expect(diameterFromDrag(62.5001, PX_PER_MM)).toBeNull() // 越上界
    expect(diameterFromDrag(0, PX_PER_MM)).toBeNull() // 非正
    expect(diameterFromDrag(Number.NaN, PX_PER_MM)).toBeNull()
    expect(diameterFromDrag(10, 0)).toBeNull() // 非法换算系数
  })

  it('buildRotationChange：值未变 = null；缺省 rotation 视作 0', () => {
    expect(buildRotationChange({ ...gem('g00001'), rotationDeg: undefined }, 0)).toBeNull()
    const c = buildRotationChange({ ...gem('g00001'), rotationDeg: undefined }, 90)!
    expect(c.before).toEqual({ rotationDeg: 0 })
    expect(c.after).toEqual({ rotationDeg: 90 })
  })
})

describe('P6/P7 手柄形态矩阵（design §2.1）', () => {
  it('单选非圆钻：旋转柄 + 水平/垂直双直径柄', async () => {
    applyPatch({ op: 'update', changes: [{ id: 'g00001', before: { shapeId: 'round' }, after: { shapeId: 'square' } }] })
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    expect(view.q('designer-handles')).not.toBeNull()
    expect(view.q('designer-handle-rotate')).not.toBeNull()
    expect(view.q('designer-handle-size-e')).not.toBeNull()
    expect(view.q('designer-handle-size-s')).not.toBeNull()
    view.unmount()
  })

  it('圆钻：旋转柄隐藏（改径柄保留）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001']) // hexGems 全 round
    await tick()
    expect(view.q('designer-handles')).not.toBeNull()
    expect(view.q('designer-handle-rotate')).toBeNull()
    expect(view.q('designer-handle-size-e')).not.toBeNull()
    expect(view.q('designer-handle-size-s')).not.toBeNull()
    view.unmount()
  })

  it('多选：无手柄（对齐/分布替代——design §2.1 裁断）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001', 'g00002'])
    await tick()
    expect(view.q('designer-handles')).toBeNull()
    view.unmount()
  })

  it('非选择工具：无手柄', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    setTool('draw')
    await tick()
    expect(view.q('designer-handles')).toBeNull()
    view.unmount()
  })
})

describe('P6 旋转手柄（pointer 序列）', () => {
  it('拖旋转柄：实时°读数 → 松手单 patch 单 undo 组 → 撤销复位', async () => {
    applyPatch({ op: 'update', changes: [{ id: 'g00001', before: { shapeId: 'round' }, after: { shapeId: 'square' } }] })
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    const handle = view.q('designer-handle-rotate')! as HTMLElement

    // 钻心 (4,4)；旋转柄位于 (4, 4-7)=（4,-3）。起于柄位（角 -90°），拖到右侧（角 0°）= +90°
    pointerDown(handle, { x: 4, y: -3 })
    windowPointer('pointermove', { x: 11.5, y: 4 }) // 钻心右侧
    await tick()
    const preview = getTransformPreview()
    expect(preview).not.toBeNull()
    if (preview === null || preview.kind !== 'rotate') throw new Error('预览类型不符')
    expect(preview.valueDeg).toBeGreaterThan(80)
    expect((view.q('designer-transform-readout') as HTMLElement | null)?.textContent).toContain('°')

    const before = getUndoDepths().undo
    windowPointer('pointerup', { x: 11.5, y: 4 })
    await tick()
    expect(gem('g00001').rotationDeg).toBeGreaterThan(80)
    expect(getUndoDepths().undo).toBe(before + 1) // 一次拖拽会话 = 一个 undo 组
    expect(getTransformPreview()).toBeNull()

    undo()
    await tick()
    expect(gem('g00001').rotationDeg ?? 0).toBe(0)
    view.unmount()
  })

  it('Shift 拖旋转 = 15° 步进', async () => {
    applyPatch({ op: 'update', changes: [{ id: 'g00001', before: { shapeId: 'round' }, after: { shapeId: 'square' } }] })
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    const handle = view.q('designer-handle-rotate')!

    pointerDown(handle, { x: 4, y: -3 })
    // 起角 -90°，拖到方位 -45°（位移 +45）→ Shift 步进恰 45°
    windowPointer('pointermove', { x: 11, y: -3 }, true)
    windowPointer('pointerup', { x: 11, y: -3 }, true)
    await tick()
    expect(gem('g00001').rotationDeg).toBe(45)
    view.unmount()
  })

  it('Esc 取消旋转会话：不产 patch', async () => {
    applyPatch({ op: 'update', changes: [{ id: 'g00001', before: { shapeId: 'round' }, after: { shapeId: 'square' } }] })
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    const handle = view.q('designer-handle-rotate')!
    const before = getUndoDepths().undo

    pointerDown(handle, { x: 4, y: -3 })
    windowPointer('pointermove', { x: 11.5, y: 4 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
    expect(getTransformPreview()).toBeNull()
    expect(gem('g00001').rotationDeg ?? 0).toBe(0)
    expect(getUndoDepths().undo).toBe(before)
    expect([...getEditDoc()!.selection]).toEqual(['g00001']) // 取消优先于清空
    view.unmount()
  })
})

describe('P7 直径手柄（pointer 序列）', () => {
  it('拖直径柄：连续 mm 读数 → 松手改径单 undo 组；不吸附档位', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    const handle = view.q('designer-handle-size-e')! as HTMLElement

    pointerDown(handle, { x: 7.5, y: 4 }) // 柄位 = 钻心+半径
    windowPointer('pointermove', { x: 10.9, y: 4 }) // 新半径 6.9px → 直径 5.52mm
    await tick()
    const preview = getTransformPreview()
    if (preview === null || preview.kind !== 'diameter') throw new Error('预览类型不符')
    expect(preview.valueMm).toBeGreaterThan(5)
    expect(preview.valueMm).toBeLessThan(6)
    expect((view.q('designer-transform-readout') as HTMLElement | null)?.textContent).toContain('mm')

    const before = getUndoDepths().undo
    windowPointer('pointerup', { x: 10.9, y: 4 })
    await tick()
    expect(gem('g00001').diameterMm).toBeGreaterThan(5)
    expect(gem('g00001').diameterMm).toBeLessThan(6)
    expect(getUndoDepths().undo).toBe(before + 1)
    view.unmount()
  })

  it('越域（>50mm）：非法移动不更新预览，松手回滚会话前值（无 patch）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    await tick()
    const handle = view.q('designer-handle-size-e')!
    const before = getUndoDepths().undo

    pointerDown(handle, { x: 7.5, y: 4 })
    // 先到有效值 10mm（半径 12.5px），再越域到 130px 半径（直径 >50mm）
    windowPointer('pointermove', { x: 4 + 12.5, y: 4 })
    await tick()
    expect(diameterPreviewMm()).toBeCloseTo(10)
    windowPointer('pointermove', { x: 4 + 130, y: 4 })
    await tick()
    // 越域 → 回滚至会话前值（design §2 P7：非法回滚本次拖拽会话前值）
    expect(diameterPreviewMm()).toBeCloseTo(2.8)
    windowPointer('pointerup', { x: 4 + 130, y: 4 })
    await tick()
    // 收笔仍非法 → 回滚会话前值 2.8 → 无变更 → 无 patch
    expect(gem('g00001').diameterMm).toBeCloseTo(2.8)
    expect(getUndoDepths().undo).toBe(before)
    view.unmount()
  })
})
