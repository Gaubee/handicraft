/*
 * [2026-09-21 redesign-designer-workbench 5.2 Test] 画幅锚定 + 状态栏（design §5.2 裁决 6 /
 * §1.2 底栏规格）：
 * - anchorSource 两态流转：default（选图/空白新建的缺省锚）→ declared（popover 宽/高 mm
 *   直输入）——px 尺寸不变，px/mm 随声明重定（widthPx÷widthMm 单源 canvasPixelsPerMm）。
 * - popover 读数：宽/高 mm + px/mm + 锚来源标识；非法值拒绝（0/空/超上限）不改文档。
 * - 间距徽标：当前规格 pitch（文档基准派生 → brushSpec 覆盖随规格重算）。
 * - 其余读数（缩放比/钻数/规格码）随 2.x 已覆盖（layout.test），本文件只断言 5.2 增量面。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerStatusBar from '../../components/Designer/DesignerStatusBar.svelte'
import { createBlankDocument } from '$lib/designer/entry'
import {
  MAX_CANVAS_MM,
  canvasPixelsPerMm,
  setDeclaredCanvas,
} from '$lib/designer/canvasAnchor'
import { loadFromHandoff, getEditDoc, isEditDirty, resetEditForTests } from '$lib/stores/edit.svelte'
import { resetWorkbenchForTests, setBrushSpec } from '$lib/designer/workbench.svelte'
import { resetViewportForTests } from '$lib/designer/viewport.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountBar(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerStatusBar, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function openPopover(target: HTMLElement): Promise<Element> {
  target.querySelector<HTMLButtonElement>('[data-testid="designer-canvas-readout"]')!.click()
  await tick()
  const popover = target.querySelector('[data-testid="designer-canvas-popover"]')
  if (popover === null) throw new Error('画幅 popover 未打开')
  return popover
}

function setInput(target: HTMLElement, testid: string, value: string): void {
  const input = target.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function applyPopover(target: HTMLElement): Promise<void> {
  target.querySelector<HTMLButtonElement>('[data-testid="designer-canvas-apply"]')!.click()
  await tick()
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetViewportForTests()
  resetToastsForTests()
})

// ---------------------------------------------------------------------------

describe('px/mm 单源（canvasPixelsPerMm：锚定换算 widthPx÷widthMm）', () => {
  it('default 锚 = 2.5（px=mm×2.5 构造式下逐位回推）；declared 后随声明重定；无文档回退缺省', () => {
    expect(canvasPixelsPerMm(null)).toBe(2.5)
    createBlankDocument() // 500px ÷ 200mm
    expect(canvasPixelsPerMm(getEditDoc())).toBe(2.5)
    expect(setDeclaredCanvas(100, 80).ok).toBe(true) // 500px ÷ 100mm
    expect(canvasPixelsPerMm(getEditDoc())).toBe(5)
  })
})

describe('setDeclaredCanvas（declared 写入口直测）', () => {
  it('合法值：整组替换 + anchorSource=declared + dirty；px 尺寸不变', () => {
    loadFromHandoff(makeHandoff(3))
    const before = { width: getEditDoc()!.width, height: getEditDoc()!.height }
    expect(setDeclaredCanvas(210, 297)).toEqual({ ok: true })
    expect(getEditDoc()!.physicalCanvas).toEqual({ widthMm: 210, heightMm: 297, anchorSource: 'declared' })
    expect(getEditDoc()!.width).toBe(before.width)
    expect(getEditDoc()!.height).toBe(before.height)
    expect(isEditDirty()).toBe(true)
  })

  it('非法值拒绝且文档不变：0/负值/NaN/超上限/无文档', () => {
    expect(setDeclaredCanvas(0, 100).ok).toBe(false)
    expect(setDeclaredCanvas(100, -5).ok).toBe(false)
    expect(setDeclaredCanvas(Number.NaN, 100).ok).toBe(false)
    expect(setDeclaredCanvas(MAX_CANVAS_MM + 1, 100).ok).toBe(false)
    expect(setDeclaredCanvas(100, 100).ok).toBe(false) // 无文档
  })
})

describe('画幅 popover（状态栏读数点击——design §5.2 裁决 6「不强制弹窗」）', () => {
  it('anchorSource 两态流转：default（缺省锚）→ 改声明 → declared（声明锚）+ 读数/px-mm 随之更新', async () => {
    loadFromHandoff(makeHandoff(12)) // 64px 无 physicalCanvas → default 锚 25.6×25.6mm
    const view = mountBar()
    await tick()

    const popover = await openPopover(view.target)
    expect(popover.getAttribute('role')).toBe('dialog')
    expect(popover.querySelector('[data-testid="designer-canvas-anchor-source"]')?.textContent).toContain('缺省锚')
    // 预填当前值：64px ÷ 2.5 = 25.6mm
    expect(popover.querySelector<HTMLInputElement>('[data-testid="designer-canvas-width-input"]')?.value).toBe('25.6')
    expect(popover.querySelector('[data-testid="designer-canvas-pxmm"]')?.textContent).toBe('2.5px/mm')

    setInput(view.target, 'designer-canvas-width-input', '32')
    setInput(view.target, 'designer-canvas-height-input', '20')
    await applyPopover(view.target)

    const doc = getEditDoc()!
    expect(doc.physicalCanvas).toEqual({ widthMm: 32, heightMm: 20, anchorSource: 'declared' })
    expect(isEditDirty()).toBe(true)
    // popover 读数联动：声明锚 + px/mm = 64÷32 = 2
    const updated = view.target.querySelector('[data-testid="designer-canvas-popover"]')!
    expect(updated.querySelector('[data-testid="designer-canvas-anchor-source"]')?.textContent).toContain('声明锚')
    expect(updated.querySelector('[data-testid="designer-canvas-pxmm"]')?.textContent).toBe('2px/mm')
    expect(updated.textContent).toContain('32')
    // 主读数位联动（declared 后不再带「缺省锚」标注）
    const readout = view.target.querySelector('[data-testid="designer-canvas-readout"]')!.textContent ?? ''
    expect(readout).toContain('32×20mm')
    expect(readout).not.toContain('缺省锚')

    view.unmount()
  })

  it('再次改声明保持 declared（两态流转单向一次）+ 重开 popover 预填当前声明值', async () => {
    loadFromHandoff(makeHandoff(3))
    const view = mountBar()
    await tick()
    await openPopover(view.target)
    setInput(view.target, 'designer-canvas-width-input', '40')
    setInput(view.target, 'designer-canvas-height-input', '40')
    await applyPopover(view.target)
    expect(getEditDoc()!.physicalCanvas.anchorSource).toBe('declared')

    // 关闭再开：预填 = 已声明值
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-canvas-readout"]')!.click()
    await tick()
    expect(view.target.querySelector('[data-testid="designer-canvas-popover"]')).toBeNull()
    await openPopover(view.target)
    expect(
      view.target.querySelector<HTMLInputElement>('[data-testid="designer-canvas-width-input"]')?.value,
    ).toBe('40')

    setInput(view.target, 'designer-canvas-width-input', '50')
    setInput(view.target, 'designer-canvas-height-input', '25')
    await applyPopover(view.target)
    expect(getEditDoc()!.physicalCanvas).toEqual({ widthMm: 50, heightMm: 25, anchorSource: 'declared' })

    view.unmount()
  })

  it('非法输入拒绝：行内错误可见 + 画幅不变（不产半执行）', async () => {
    loadFromHandoff(makeHandoff(3))
    const view = mountBar()
    await tick()
    await openPopover(view.target)
    const before = getEditDoc()!.physicalCanvas

    setInput(view.target, 'designer-canvas-width-input', '0')
    setInput(view.target, 'designer-canvas-height-input', '100')
    await applyPopover(view.target)
    expect(getEditDoc()!.physicalCanvas).toEqual(before)
    expect(view.target.querySelector('[data-testid="designer-canvas-error"]')?.textContent).toContain('mm')

    setInput(view.target, 'designer-canvas-width-input', String(MAX_CANVAS_MM + 1))
    await applyPopover(view.target)
    expect(getEditDoc()!.physicalCanvas).toEqual(before)

    view.unmount()
  })
})

describe('间距徽标（当前规格 pitch——brushSnapPitchPx 同单源随规格重算）', () => {
  it('文档基准派生 3.2mm（SS10 径 2.8+gap 0.4）→ brushSpec 覆盖 SQ5 随规格重算', async () => {
    loadFromHandoff(makeHandoff(3))
    const view = mountBar()
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-pitch"]')?.textContent).toContain('3.2mm')

    setBrushSpec({ shapeId: 'square', diameterMm: 5, colorId: 'black' })
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-pitch"]')?.textContent).toContain('5.4mm')

    view.unmount()
  })

  it('无文档不显示间距徽标（缺真源不显示假值）', async () => {
    const view = mountBar()
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-pitch"]')).toBeNull()
    view.unmount()
  })
})
