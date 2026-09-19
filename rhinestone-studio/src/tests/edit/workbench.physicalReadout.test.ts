/*
 * [2026-09-20 D-5.7 Test] 画幅物理读数接线（rename-and-expert-workbench tasks 5.7）：
 * EditStatusBar canvas prop 接 EditView 真值（doc.physicalCanvas——studio-layers ③段
 * handoff v2 贯通后 loadFromHandoff 装载文档态恒携带）：
 * - declared 锚：画幅 mm 直读 + px/mm，无「缺省锚」标注；
 * - default 锚（v1 形态载荷无键 → defaultPhysicalCanvasOf 合成）：「缺省锚」显式可见；
 * - 降采样锚不变量（消费端呈现）：declared 画幅与网格一致时 px/mm × widthMm = 画幅像素宽
 *   （pixelsPerMmFromCanvas 单源派生）；
 * - null 兜底（防御位）：保持「未锚定」占位——缺真源不显示假值。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import EditStatusBar from '../../components/Edit/EditStatusBar.svelte'
import {
  getEditDoc,
  loadFromHandoff,
  resetEditForTests,
} from '$lib/stores/edit.svelte'
import { pixelsPerMmFromCanvas, type PhysicalCanvas } from '$lib/engine'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '../../components/Edit/workbench.svelte'
import { makeHandoff } from './helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountView(component: typeof EditView | typeof EditStatusBar): {
  target: HTMLElement
  unmount: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(component, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function readoutOf(target: HTMLElement): string {
  return target.querySelector('[data-testid="edit-canvas-readout"]')?.textContent ?? ''
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
})

describe('5.7 画幅物理读数：declared / default 两态（EditView 真值接线）', () => {
  it('declared 锚：画幅 mm + px/mm 直读，无「缺省锚」标注', async () => {
    const declared: PhysicalCanvas = { widthMm: 210, heightMm: 148, anchorSource: 'declared' }
    loadFromHandoff(makeHandoff(12, { physicalCanvas: declared }))
    expect(getEditDoc()!.physicalCanvas).toEqual(declared) // 文档态携带（handoff v2 贯通）

    const view = mountView(EditView)
    await tick()
    const text = readoutOf(view.target)
    expect(text).toContain('画幅')
    expect(text).toContain('210×148mm')
    expect(text).toContain('2.5px/mm') // grid.pixelsPerMm 读数
    expect(text).not.toContain('缺省锚')
    view.unmount()
  })

  it('default 锚（载荷无键 → 合成）：读数显式标「缺省锚」——回退可见不静默', async () => {
    loadFromHandoff(makeHandoff(12)) // v1 形态载荷：无 physicalCanvas 键
    const doc = getEditDoc()!
    expect(doc.physicalCanvas.anchorSource).toBe('default')
    // 合成口径：像素宽 / grid.pixelsPerMm（64px / 2.5 = 25.6mm）
    expect(doc.physicalCanvas.widthMm).toBeCloseTo(25.6, 10)

    const view = mountView(EditView)
    await tick()
    const text = readoutOf(view.target)
    expect(text).toContain('25.6×25.6mm')
    expect(text).toContain('缺省锚')
    view.unmount()
  })
})

describe('5.7 降采样锚不变量（消费端呈现）', () => {
  it('declared 画幅与网格一致：px/mm × widthMm = 画幅像素宽（pixelsPerMmFromCanvas 单源）', async () => {
    // 64px 画幅 @2.5px/mm → declared 25.6mm（与 default 合成口径逐位一致——锚定实际画幅像素宽）
    const declared: PhysicalCanvas = { widthMm: 25.6, heightMm: 25.6, anchorSource: 'declared' }
    loadFromHandoff(makeHandoff(12, { physicalCanvas: declared }))

    const view = mountView(EditView)
    await tick()
    const doc = getEditDoc()!
    // 不变量：declared 锚下 pixelsPerMmFromCanvas 还原参考网格换算（非 PIXELS_PER_MM 兜底）
    expect(pixelsPerMmFromCanvas(doc.width, doc.physicalCanvas)).toBeCloseTo(doc.grid.pixelsPerMm, 10)
    expect(readoutOf(view.target)).toContain('2.5px/mm')
    view.unmount()
  })
})

describe('5.7 null 兜底（防御位）', () => {
  it('canvas null → 「未锚定」占位（缺真源不显示假值）', async () => {
    const view = mountView(EditStatusBar) // 不传 canvas（默认 null）
    await tick()
    expect(readoutOf(view.target)).toContain('未锚定')
    view.unmount()
  })
})
