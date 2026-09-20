/*
 * [2026-09-21 redesign-designer-workbench 3.x Test] 键位全表（design §3 编辑/变换/视图组，
 * 本切片接线面）：⌘C/⌘X/⌘V（原位偏移一格累进）/⌘D/Delete·Backspace（单颗直删、批量
 * 确认公共件）/方向键三档回归/[ ] 旋转 ±15°（⇧=5°）/⌘A 全选当前层/⌘+ ⌘- ⌘0 ⌘1/
 * Tab 折叠右面板列/? 键位速查/⌘Y 重做/表单聚焦放行。全部经命令总线（菜单/面板同源）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  getEditDoc,
  getUndoDepths,
  loadFromHandoff,
  redo,
  resetEditForTests,
  setSelection,
  undo,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { resetInteractionForTests } from '$lib/designer/interaction.svelte'
import { getViewState, resetViewportForTests } from '$lib/designer/viewport.svelte'
import {
  getRightRailCollapsed,
  getShortcutsHelpOpen,
  resetViewStateForTests,
} from '$lib/designer/viewState.svelte'
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

function key(k: string, mods: { meta?: boolean; shift?: boolean } = {}): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      metaKey: mods.meta ?? false,
      ctrlKey: false,
      shiftKey: mods.shift ?? false,
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

function mountView(): {
  target: HTMLElement
  q: (testid: string) => Element | null
  unmount: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
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
  resetClipboardForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n.x = 4 + (n-1)*8, y = 4；round 2.8mm
})

describe('编辑组（§3.2）', () => {
  it('⌘C → ⌘V：粘贴原位偏移一格（副本归当前层 manual 语义）+ 再贴累进两格', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])

    key('c', { meta: true })
    expect(clipboardSize()).toBe(1)
    key('v', { meta: true })
    await tick()
    const first = getEditDoc()!.gems.find((g) => g.id.startsWith('m-'))!
    expect(first.x).toBeCloseTo(4 + TEST_PITCH)
    expect(first.y).toBeCloseTo(4 + TEST_PITCH)
    expect(first.layerId).toBe('L1')
    expect(selectionIds()).toEqual([first.id])

    key('v', { meta: true })
    await tick()
    const copies = getEditDoc()!.gems.filter((g) => g.id.startsWith('m-'))
    expect(copies).toHaveLength(2)
    expect(copies[1].x).toBeCloseTo(4 + 2 * TEST_PITCH)

    view.unmount()
  })

  it('⌘X 剪切：移除可撤销；⌘D 取消选择', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00002'])

    key('x', { meta: true })
    await tick()
    expect(getEditDoc()!.gems.some((g) => g.id === 'g00002')).toBe(false)
    undo()
    await tick()
    expect(gem('g00002').x).toBeCloseTo(12)

    setSelection(['g00001', 'g00003'])
    key('d', { meta: true })
    await tick()
    expect(selectionIds()).toEqual([])

    view.unmount()
  })

  it('Delete 单颗直删（无确认弹窗）+ 可撤销；Backspace 同效', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    const before = getUndoDepths().undo

    key('Delete')
    await tick()
    expect(getEditDoc()!.gems.some((g) => g.id === 'g00001')).toBe(false)
    expect(view.q('designer-delete-confirm')).toBeNull()
    expect(getUndoDepths().undo).toBe(before + 1)
    undo()
    await tick()
    expect(gem('g00001').x).toBeCloseTo(4)

    // Backspace 同效（撤销恢复后重选——删除命令会清空选集）
    setSelection(['g00001'])
    key('Backspace')
    await tick()
    expect(getEditDoc()!.gems.some((g) => g.id === 'g00001')).toBe(false)

    view.unmount()
  })

  it('Delete 批量：确认弹窗（键位与菜单同源）——确认删除单组撤销恢复全部', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001', 'g00002'])
    const before = getUndoDepths().undo

    key('Delete')
    await tick()
    expect(view.q('designer-delete-confirm')).not.toBeNull()
    ;(view.q('designer-delete-confirm') as HTMLElement).click()
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(10)
    expect(getUndoDepths().undo).toBe(before + 1)
    undo()
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(12)

    view.unmount()
  })

  it('⌘Y 重做（⌘⇧Z 同面回归）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    key('Delete')
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(11)
    key('z', { meta: true })
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(12)
    key('y', { meta: true })
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(11)
    redo() // 幂等（栈已空）
    expect(getEditDoc()!.gems).toHaveLength(11)

    view.unmount()
  })
})

describe('变换组（§3.3）', () => {
  it('[ / ] 旋转 ±15°（圆钻亦可批量朝向——逐钻字段）；⇧ 细档 5°', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])

    key(']')
    await tick()
    expect(gem('g00001').rotationDeg).toBe(15)
    key('[')
    await tick()
    expect(gem('g00001').rotationDeg ?? 0).toBe(0)
    key('[', { shift: true })
    await tick()
    expect(gem('g00001').rotationDeg).toBe(355) // 归一 [0,360)
    key(']', { shift: true })
    await tick()
    expect(gem('g00001').rotationDeg).toBe(0)

    view.unmount()
  })

  it('⌘A 全选当前层（非全文档）——跨层选集面只取当前层钻', async () => {
    const view = mountView()
    await tick()
    const doc = getEditDoc()!
    const layersBefore = doc.layers.map((l) => ({ ...l }))
    void layersBefore
    // 把 g00001 移入新层并设为当前层——⌘A 只应选 L1 的 11 颗
    const { applyPatch } = await import('$lib/stores/edit.svelte')
    applyPatch({
      op: 'layers',
      before: doc.layers.map((l) => ({ ...l })),
      after: [...doc.layers.map((l) => ({ ...l })), { id: 'L2', name: '图层 2', visible: true, locked: false }],
    })
    applyPatch({ op: 'update', changes: [{ id: 'g00001', before: { layerId: 'L1' }, after: { layerId: 'L2' } }] })
    const { setCurrentLayerId } = await import('$lib/designer/workbench.svelte')
    setCurrentLayerId('L2', getEditDoc())

    key('a', { meta: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001']) // 当前层 L2 只有一颗

    view.unmount()
  })

  it('方向键三档回归（1px / ⇧=pitch / Alt=0.1mm）', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])
    const pxPerMm = 2.5

    key('ArrowRight')
    await tick()
    expect(gem('g00001').x).toBeCloseTo(5)
    key('ArrowRight', { shift: true })
    await tick()
    expect(gem('g00001').x).toBeCloseTo(5 + TEST_PITCH)
    const altEvent = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, altKey: true })
    window.dispatchEvent(altEvent)
    await tick()
    expect(gem('g00001').x).toBeCloseTo(5 + TEST_PITCH + 0.1 * pxPerMm)

    view.unmount()
  })
})

describe('视图组（§3.4）+ 速查（§3.7）', () => {
  it('⌘+ / ⌘- 缩放一档（画布中心锚）；⌘1 100%；⌘0 适配', async () => {
    const view = mountView()
    await tick()
    expect(getViewState().scale).toBeCloseTo(FIT.scale)

    key('1', { meta: true })
    await tick()
    expect(getViewState().scale).toBeCloseTo(1)
    key('=', { meta: true })
    await tick()
    expect(getViewState().scale).toBeCloseTo(1.25)
    key('-', { meta: true })
    await tick()
    expect(getViewState().scale).toBeCloseTo(1)
    key('+', { meta: true })
    await tick()
    expect(getViewState().scale).toBeCloseTo(1.25)
    key('0', { meta: true })
    await tick()
    expect(getViewState().scale).toBeCloseTo(FIT.scale)

    view.unmount()
  })

  it('Tab 折叠/展开右侧面板列（rail 消失/复现 + preventDefault）', async () => {
    const view = mountView()
    await tick()
    expect(getRightRailCollapsed()).toBe(false)
    expect(view.q('designer-right-rail')).not.toBeNull()

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    window.dispatchEvent(tab)
    await tick()
    expect(tab.defaultPrevented).toBe(true)
    expect(getRightRailCollapsed()).toBe(true)
    expect(view.q('designer-right-rail')).toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await tick()
    expect(getRightRailCollapsed()).toBe(false)
    expect(view.q('designer-right-rail')).not.toBeNull()

    view.unmount()
  })

  it('? 键位速查：开关面板 + 关闭钮', async () => {
    const view = mountView()
    await tick()
    expect(getShortcutsHelpOpen()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))
    await tick()
    expect(getShortcutsHelpOpen()).toBe(true)
    expect(view.q('designer-shortcuts-help')).not.toBeNull()
    expect(document.body.textContent).toContain('键位速查')
    expect(document.body.textContent).toContain('旋转 15°')

    ;(view.q('designer-shortcuts-help-close') as HTMLElement).click()
    await tick()
    expect(getShortcutsHelpOpen()).toBe(false)
    expect(view.q('designer-shortcuts-help')).toBeNull()

    view.unmount()
  })
})

describe('纪律面', () => {
  it('表单聚焦放行（⌘C/⌘V/⌘A/Tab 不劫持输入控件）', async () => {
    const view = mountView()
    await tick()
    const input = document.createElement('input')
    view.target.appendChild(input)
    input.focus()

    const kc = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true, metaKey: true })
    input.dispatchEvent(kc)
    expect(kc.defaultPrevented).toBe(false)
    const kv = new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true, metaKey: true })
    input.dispatchEvent(kv)
    expect(kv.defaultPrevented).toBe(false)
    const ka = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, metaKey: true })
    input.dispatchEvent(ka)
    expect(ka.defaultPrevented).toBe(false)
    const kt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input.dispatchEvent(kt)
    expect(kt.defaultPrevented).toBe(false)
    expect(getRightRailCollapsed()).toBe(false)

    view.unmount()
  })

  it('空选集/空剪贴板：命令门槛不满足返回 false（浏览器默认放行）', async () => {
    const view = mountView()
    await tick()
    const before = getUndoDepths().undo

    const kv = new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true, metaKey: true })
    window.dispatchEvent(kv)
    expect(kv.defaultPrevented).toBe(false) // 空剪贴板
    const kd = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    window.dispatchEvent(kd)
    expect(kd.defaultPrevented).toBe(false) // 空选集
    expect(getUndoDepths().undo).toBe(before)

    view.unmount()
  })
})
