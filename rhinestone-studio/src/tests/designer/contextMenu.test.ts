/*
 * [2026-09-21 redesign-designer-workbench 3.x Test] P12-P14 右键上下文菜单（design §2.2
 * 两态树）+ 命令总线（同源纪律）：两态树形态（选中态=复制/剪切/粘贴/删除+对齐▸(≥2)/
 * 分布▸(≥3)/移入图层▸；空态=粘贴/全选当前层/适配/100%）+ 命令执行（剪贴板原位偏移一格
 * 累进/剪切/删除单颗直删·批量确认公共件/对齐/移入图层单 op）。沿 marquee 测试模式。
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
import { resetWorkbenchForTests, setCurrentLayerId } from '$lib/designer/workbench.svelte'
import { resetInteractionForTests } from '$lib/designer/interaction.svelte'
import { resetViewportForTests } from '$lib/designer/viewport.svelte'
// [6.2] 空态树缺口（智能排布…/画幅设置…）——共享态（viewState popover / smartLayout 开合）随复位
import { getCanvasPopoverOpen, resetViewStateForTests } from '$lib/designer/viewState.svelte'
import { getSmartLayoutOpen, resetSmartLayoutForTests } from '$lib/designer/smartLayout.svelte'
import { createBlankDocument } from '$lib/designer/entry'
import { clipboardSize, resetClipboardForTests } from '$lib/designer/clipboard'
import { computeFit } from '../../components/Studio/fit'
import { TEST_PITCH, makeHandoff } from '../edit/helpers'

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

function contextmenu(el: Element, at: { x: number; y: number }): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: c.clientX, clientY: c.clientY, button: 2 }),
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
    q: (testid: string) => document.querySelector(`[data-testid="${testid}"]`),
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
  resetViewportForTests()
  resetViewStateForTests()
  resetSmartLayoutForTests()
  resetClipboardForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n.x = 4 + (n-1)*8, y = 4
})

describe('P14 空态树缺口（§2.2：智能排布…/画幅设置…——[6.2] 接线）', () => {
  it('空态树含智能排布…与画幅设置…（§2.2 树形补全；选中态树不含此二项）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    expect(view.q('designer-menu-smart-layout')).not.toBeNull()
    expect(view.q('designer-menu-canvas')).not.toBeNull()

    contextmenu(canvas, { x: 4, y: 4 }) // 钻上 → 选中态树：空态项不显
    await tick()
    expect(view.q('designer-context-menu')!.getAttribute('data-state')).toBe('selection')
    expect(view.q('designer-menu-smart-layout')).toBeNull()
    expect(view.q('designer-menu-canvas')).toBeNull()

    view.unmount()
  })

  it('画幅设置…：经命令总线打开 5.2 canvas popover（与状态栏读数点击同源）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    ;(view.q('designer-menu-canvas') as HTMLElement).click()
    await tick()
    expect(view.q('designer-context-menu')).toBeNull() // 命令执行即关闭
    expect(getCanvasPopoverOpen()).toBe(true)
    expect(view.q('designer-canvas-popover')).not.toBeNull() // 5.2 popover 同一实例

    view.unmount()
  })

  it('智能排布…：经命令总线打开 7.2 参数小窗态（painting 底图可用；面板随 7.2 装配渲染）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    ;(view.q('designer-menu-smart-layout') as HTMLElement).click()
    await tick()
    expect(view.q('designer-context-menu')).toBeNull()
    expect(getSmartLayoutOpen()).toBe(true)

    view.unmount()
  })

  it('无参考底图禁用态（空白起步文档：智能排布…禁用 + tooltip「需要参考底图」）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    createBlankDocument() // underlay 零源——smartLayoutUnderlayReady false（单源判据）
    await tick()

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    const item = view.q('designer-menu-smart-layout') as HTMLButtonElement
    expect(item.disabled).toBe(true)
    expect(item.title).toBe('需要参考底图')
    // 画幅设置…不受底图门槛（画幅恒有）
    expect((view.q('designer-menu-canvas') as HTMLButtonElement).disabled).toBe(false)

    view.unmount()
  })
})

describe('P13 右键钻：两态树（选中态）', () => {
  it('右键未选钻 → 先选它 + 选中态树（复制/剪切/粘贴/删除；对齐 <2 不显）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    contextmenu(canvas, { x: 4, y: 4 })
    await tick()
    expect(selectionIds()).toEqual(['g00001'])
    const menu = view.q('designer-context-menu') as HTMLElement | null
    expect(menu).not.toBeNull()
    expect(menu!.getAttribute('data-state')).toBe('selection')
    expect(view.q('designer-menu-copy')).not.toBeNull()
    expect(view.q('designer-menu-cut')).not.toBeNull()
    expect(view.q('designer-menu-paste')).not.toBeNull()
    expect(view.q('designer-menu-delete')).not.toBeNull()
    expect(view.q('designer-menu-align')).toBeNull() // 单选：对齐子树不显（≥2）
    expect(view.q('designer-menu-move-layer')).not.toBeNull()

    view.unmount()
  })

  it('锁定层钻上右键 = 空态树（P1 约束：锁定视为空白）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    getEditDoc()!.layers[0].locked = true

    contextmenu(canvas, { x: 4, y: 4 })
    await tick()
    expect(view.q('designer-context-menu')!.getAttribute('data-state')).toBe('blank')
    expect(view.q('designer-menu-select-all')).not.toBeNull()

    view.unmount()
  })
})

describe('P14 右键空白：空态树（选集保持）', () => {
  it('空白右键 → 空态树（粘贴/全选当前层/适配画幅/100%）；现选集不清空', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setSelection(['g00003'])

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    expect(view.q('designer-context-menu')!.getAttribute('data-state')).toBe('blank')
    expect(view.q('designer-menu-paste')).not.toBeNull()
    expect(view.q('designer-menu-select-all')).not.toBeNull()
    expect(view.q('designer-menu-fit')).not.toBeNull()
    expect(view.q('designer-menu-100')).not.toBeNull()
    expect(view.q('designer-menu-copy')).toBeNull()
    expect(selectionIds()).toEqual(['g00003']) // 空白右键不清选集

    view.unmount()
  })

  it('全选当前层：⌘A 语义（当前层全部钻入选择）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    ;(view.q('designer-menu-select-all') as HTMLElement).click()
    await tick()
    expect(selectionIds()).toHaveLength(12)
    expect(view.q('designer-context-menu')).toBeNull() // 命令执行即关闭

    view.unmount()
  })

  it('空态视图命令：适配画幅 / 100%（经 viewport 宿主同源）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    ;(view.q('designer-menu-100') as HTMLElement).click()
    await tick()
    // jsdom getBoundingClientRect 宽 0 → zoomBy 中心锚 = 0/0；只断言 scale 到 1（fit 起点）
    expect(getEditDoc() !== null).toBe(true)
    const viewState = (await import('$lib/designer/viewport.svelte')).getViewState()
    expect(viewState.scale).toBeCloseTo(1)

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    ;(view.q('designer-menu-fit') as HTMLElement).click()
    await tick()
    const after = (await import('$lib/designer/viewport.svelte')).getViewState()
    expect(after.scale).toBeCloseTo(FIT.scale)

    view.unmount()
  })
})

describe('剪贴板（⌘C/⌘X/⌘V 同源面）', () => {
  it('菜单复制 → 粘贴：原位偏移一格；重复粘贴累进偏移；副本归当前层 + manual 语义', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    contextmenu(canvas, { x: 4, y: 4 }) // 选中 g00001
    await tick()
    ;(view.q('designer-menu-copy') as HTMLElement).click()
    await tick()
    expect(clipboardSize()).toBe(1)

    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    ;(view.q('designer-menu-paste') as HTMLElement).click()
    await tick()
    const first = getEditDoc()!.gems.find((g) => g.id.startsWith('m-'))!
    expect(first.x).toBeCloseTo(4 + TEST_PITCH) // 一格偏移
    expect(first.y).toBeCloseTo(4 + TEST_PITCH)
    expect(first.origin).toBe('manual')
    expect(first.blockId).toBeNull()
    expect(first.moved).toBe(false)
    expect(first.layerId).toBe('L1')
    expect(selectionIds()).toEqual([first.id])

    // 第二次粘贴：累进两格
    contextmenu(canvas, { x: 60, y: 60 })
    await tick()
    ;(view.q('designer-menu-paste') as HTMLElement).click()
    await tick()
    const second = getEditDoc()!.gems.filter((g) => g.id.startsWith('m-'))
    expect(second).toHaveLength(2)
    expect(second[1].x).toBeCloseTo(4 + 2 * TEST_PITCH)

    view.unmount()
  })

  it('菜单剪切：源钻移除（单组撤销）+ 粘贴副本语义重建', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const before = getUndoDepths().undo

    contextmenu(canvas, { x: 4, y: 4 })
    await tick()
    ;(view.q('designer-menu-cut') as HTMLElement).click()
    await tick()
    expect(getEditDoc()!.gems.some((g) => g.id === 'g00001')).toBe(false)
    expect(getUndoDepths().undo).toBe(before + 1)
    expect(clipboardSize()).toBe(1)

    undo()
    await tick()
    expect(gem('g00001').x).toBeCloseTo(4) // 剪切可撤销

    view.unmount()
  })
})

describe('删除（单颗直删 / 批量确认公共件）', () => {
  it('单颗删除：直删不经确认弹窗，单组可撤销', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const before = getUndoDepths().undo

    contextmenu(canvas, { x: 4, y: 4 }) // 单选 g00001
    await tick()
    ;(view.q('designer-menu-delete') as HTMLElement).click()
    await tick()
    expect(getEditDoc()!.gems.some((g) => g.id === 'g00001')).toBe(false)
    expect(view.q('designer-delete-confirm')).toBeNull() // 单颗不弹窗
    expect(getUndoDepths().undo).toBe(before + 1)

    undo()
    await tick()
    expect(gem('g00001').x).toBeCloseTo(4)

    view.unmount()
  })

  it('批量删除：确认弹窗（公共件）——取消保留、确认删除、单组撤销恢复全部', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const before = getUndoDepths().undo
    setSelection(['g00001', 'g00002', 'g00003'])

    contextmenu(canvas, { x: 4, y: 4 }) // 钻上（已选中→不换选集）
    await tick()
    ;(view.q('designer-menu-delete') as HTMLElement).click()
    await tick()
    expect(selectionIds()).toHaveLength(3) // 未确认前不动
    const confirm = view.q('designer-delete-confirm') as HTMLElement | null
    expect(confirm).not.toBeNull()
    expect(document.body.textContent).toContain('3 颗')

    ;(view.q('designer-delete-cancel') as HTMLElement).click()
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(12) // 取消 = 零删除
    expect(getUndoDepths().undo).toBe(before)

    contextmenu(canvas, { x: 4, y: 4 })
    await tick()
    ;(view.q('designer-menu-delete') as HTMLElement).click()
    await tick()
    ;(view.q('designer-delete-confirm') as HTMLElement).click()
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(9)
    expect(getUndoDepths().undo).toBe(before + 1)

    undo()
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(12) // 一次撤销恢复全部

    view.unmount()
  })
})

describe('对齐 / 移入图层（子树命令）', () => {
  it('≥2 选中：对齐子树（左对齐 → x 全等；菜单入口与属性面板同源 applyGemChanges）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    setSelection(['g00001', 'g00003'])

    contextmenu(canvas, { x: 4, y: 4 })
    await tick()
    const alignGroup = view.q('designer-menu-align') as HTMLElement
    expect(alignGroup).not.toBeNull()
    ;(alignGroup.querySelector('button') as HTMLElement).click() // 展开
    await tick()
    ;(view.q('designer-menu-align-left') as HTMLElement).click()
    await tick()
    expect(gem('g00001').x).toBeCloseTo(4)
    expect(gem('g00003').x).toBeCloseTo(4)

    view.unmount()
  })

  it('移入图层子树：当前层标记、锁定目标禁用、执行 = 单 op 移入', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const doc = getEditDoc()!
    applyPatch({
      op: 'layers',
      before: doc.layers.map((l) => ({ ...l })),
      after: [
        ...doc.layers.map((l) => ({ ...l })),
        { id: 'L2', name: '图层 2', visible: true, locked: false },
        { id: 'L3', name: '图层 3', visible: true, locked: true },
      ],
    })
    setCurrentLayerId('L2', getEditDoc())
    setSelection(['g00001'])

    contextmenu(canvas, { x: 4, y: 4 })
    await tick()
    const moveGroup = view.q('designer-menu-move-layer') as HTMLElement
    ;(moveGroup.querySelector('button') as HTMLElement).click()
    await tick()
    const l2Item = view.q('designer-menu-move-layer-L2') as HTMLButtonElement
    const l3Item = view.q('designer-menu-move-layer-L3') as HTMLButtonElement
    expect(l2Item.textContent).toContain('当前层')
    expect(l3Item.disabled).toBe(true) // 锁定层禁用

    ;(view.q('designer-menu-move-layer-L2') as HTMLElement).click()
    await tick()
    expect(gem('g00001').layerId).toBe('L2')

    undo()
    await tick()
    expect(gem('g00001').layerId).toBe('L1') // 单组撤销恢复归属

    view.unmount()
  })
})
