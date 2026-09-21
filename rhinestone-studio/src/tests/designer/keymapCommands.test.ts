/*
 * [2026-09-21 redesign-designer-workbench 3.x Test] 键位全表（design §3 编辑/变换/视图组，
 * 本切片接线面）：⌘C/⌘X/⌘V（原位偏移一格累进）/⌘D/Delete·Backspace（单颗直删、批量
 * 确认公共件）/方向键三档回归/[ ] 旋转 ±15°（⇧=5°）/⌘A 全选当前层/⌘+ ⌘- ⌘0 ⌘1/
 * Tab 折叠右面板列/? 键位速查/⌘Y 重做/表单聚焦放行。全部经命令总线（菜单/面板同源）。
 * [6.1 余项] 图层操作组（design §3.5）：⌘⇧N 新建/⌘E 向下合并（mergeDownTargetOf 同源）/
 * ⌘[ ⌘] ⌘⇧[ ⌘⇧] 层排序（z 序数组序 op——与面板上下移按钮同命令）+ 速查表图层操作组登记。
 * [rework R4.1/R4.2 显式更新] ⌘T=enter-transform 键面（进入/确认/取消/键位让位全链见
 * transformMode.test.ts 与 transformHandles.test.ts）；速查表 ⌘T 自由变换行 + Shift/Alt
 * 框选加减选行随 §3.1/§3.5 同步断言。
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
import { resetWorkbenchForTests, setCurrentLayerId, getCurrentLayerId, getTool, getBrushSettings, effectiveBrushDiameterMm } from '$lib/designer/workbench.svelte'
import { execDesignerCommand } from '$lib/designer/commands'
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

/** [R3.2 §3.3 重映射] ⌥[ ⌥] 细旋转（旋转键自 [ ] 迁移 Alt——返回事件供 defaultPrevented 断言）。 */
function altKey(k: string, mods: { shift?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
    altKey: true,
    shiftKey: mods.shift ?? false,
  })
  window.dispatchEvent(event)
  return event
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
  // [R3.2 显式更新——design §3.3 重映射裁决，非断言腐化] [ ] 已让渡笔刷直径，旋转键
  // 迁移 ⌥[ ⌥]（±15°；⇧ 细档 5°；'{' '}' 布局变体同键收录）。
  it('⌥[ / ⌥] 旋转 ±15°（圆钻亦可批量朝向——逐钻字段）；⇧ 细档 5°', async () => {
    const view = mountView()
    await tick()
    setSelection(['g00001'])

    altKey(']')
    await tick()
    expect(gem('g00001').rotationDeg).toBe(15)
    altKey('[')
    await tick()
    expect(gem('g00001').rotationDeg ?? 0).toBe(0)
    altKey('[', { shift: true })
    await tick()
    expect(gem('g00001').rotationDeg).toBe(355) // 归一 [0,360)
    altKey(']', { shift: true })
    await tick()
    expect(gem('g00001').rotationDeg).toBe(0)
    // '{' '}' 布局变体（Alt+Shift 组合同键位产出）同效
    altKey('}', { shift: true })
    await tick()
    expect(gem('g00001').rotationDeg).toBe(5)

    view.unmount()
  })

  it('⌥ 细旋转空选集放行（defaultPrevented false——命令门槛语义保持）', async () => {
    const view = mountView()
    await tick()
    const e = altKey(']')
    await tick()
    expect(e.defaultPrevented).toBe(false)
    expect(getUndoDepths().undo).toBe(0)

    view.unmount()
  })

  // [R3.2 新增] [ ] 让渡笔刷直径（design §4.3 + §3.3）：画笔/橡皮工具下生效、⇧=粗档、
  // 读数/光标源即时联动、会话态不产 undo 组、非画笔工具不放行。
  it('[ / ] 笔刷直径 −/+（画笔工具下；⇧=粗档；连按 ] 两档）：读数与光标源即时反映、不产 undo 组', async () => {
    const view = mountView()
    await tick()
    view.q('designer-tool-draw')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getTool()).toBe('draw')

    const before = getUndoDepths().undo
    const specScenario = new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true })
    window.dispatchEvent(specScenario) // spec 场景：画笔下连按 ] 两次
    expect(specScenario.defaultPrevented).toBe(true)
    key(']')
    await tick()
    // 2.8 → 3.3 → 3.8（细档 0.5mm 两档——spec Scenario「笔刷直径键」）
    expect(getBrushSettings().diameterMm).toBeCloseTo(3.8, 10)
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(3.8, 10) // 光标圈/落子同读单源
    expect(view.q('designer-status-brush')!.textContent).toContain('笔刷 3.8mm · 流量 100%')

    key(']', { shift: true }) // 粗档 +2
    await tick()
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(5.8, 10)
    key('[') // −0.5
    await tick()
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(5.3, 10)
    key('{', { shift: true }) // '{' 变体粗档 −2
    await tick()
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(3.3, 10)

    expect(getUndoDepths().undo).toBe(before) // 会话态写入：零 undo 组
    expect(gem('g00001').x).toBeCloseTo(4) // 未选中钻不受影响
    expect(view.q('designer-status-brush')!.textContent).toContain('笔刷 3.3mm')

    view.unmount()
  })

  it('[ / ] 下限夹取（规格钻径）再缩放行；select 工具不放行（仅画笔/橡皮下生效）', async () => {
    const view = mountView()
    await tick()

    // select 工具：[ ] 不劫持（放行浏览器默认）
    const eSelect = new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true })
    window.dispatchEvent(eSelect)
    expect(eSelect.defaultPrevented).toBe(false)
    expect(getBrushSettings().diameterMm).toBeNull()

    // 橡皮工具下生效
    view.q('designer-tool-erase')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    key(']')
    await tick()
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(3.3, 10)

    // 下限夹取：缩回规格径（2.8）后再 [ = 无位移放行
    key('[', { shift: true }) // −2 → 夹到 2.8（贴下限 = 回跟随规格语义）
    await tick()
    expect(getBrushSettings().diameterMm).toBeNull()
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(2.8, 10)
    const eFloor = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true })
    window.dispatchEvent(eFloor)
    expect(eFloor.defaultPrevented).toBe(false)

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

  it('? 键位速查：开关面板 + 关闭钮 + [6.3] 顶栏「⌨」按钮入口（同 viewState 单真源）', async () => {
    const view = mountView()
    await tick()
    expect(getShortcutsHelpOpen()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))
    await tick()
    expect(getShortcutsHelpOpen()).toBe(true)
    expect(view.q('designer-shortcuts-help')).not.toBeNull()
    expect(document.body.textContent).toContain('键位速查')
    // [R3.2 显式更新] 速查表随 §3.3 重映射同步：[ ] = 笔刷直径（画笔/橡皮下）；旋转迁移 ⌥[ ⌥]
    expect(document.body.textContent).toContain('笔刷直径 − / +（画笔/橡皮工具下；⇧ = 粗档）')
    expect(document.body.textContent).toContain('⌥[ / ⌥]')
    expect(document.body.textContent).toContain('旋转 15°')
    // [R4.1/R4.2 显式更新] 速查表随 §3.1/§3.5 同步：⌘T 自由变换行 + Shift/Alt 框选加减选行
    expect(document.body.textContent).toContain('⌘T')
    expect(document.body.textContent).toContain('自由变换（角柄等比缩放 Ø / 外柄旋转；⇧ = 15° 步进；Enter 确认 · Esc 取消）')
    expect(document.body.textContent).toContain('框选并入选区 / 从选区减去')

    ;(view.q('designer-shortcuts-help-close') as HTMLElement).click()
    await tick()
    expect(getShortcutsHelpOpen()).toBe(false)
    expect(view.q('designer-shortcuts-help')).toBeNull()

    // [6.3/§3.7] DocBar「⌨」按钮入口（与「?」键同源——viewState 单真源 toggle）
    ;(view.q('designer-shortcuts-help-button') as HTMLElement).click()
    await tick()
    expect(getShortcutsHelpOpen()).toBe(true)
    expect(view.q('designer-shortcuts-help')).not.toBeNull()
    ;(view.q('designer-shortcuts-help-button') as HTMLElement).click() // 再点关闭（toggle）
    await tick()
    expect(getShortcutsHelpOpen()).toBe(false)

    view.unmount()
  })
})

describe('图层操作组（§3.5——⌘⇧N/⌘E/⌘[ ⌘] ⌘⇧[ ⌘⇧]，与面板按钮同命令）', () => {
  function layerIds(): string[] {
    return getEditDoc()!.layers.map((l) => l.id)
  }

  function addLayers(count: number): void {
    for (let i = 0; i < count; i++) execDesignerCommand({ kind: 'new-layer' })
  }

  it('⌘⇧N 新建图层（尾部追加 = z 序最上）；单组撤销恢复；速查表已登记图层操作组', async () => {
    const view = mountView()
    await tick()
    expect(layerIds()).toEqual(['L1'])
    const before = getUndoDepths().undo

    key('N', { meta: true, shift: true })
    await tick()
    expect(layerIds()).toEqual(['L1', 'L2'])
    expect(getUndoDepths().undo).toBe(before + 1)

    undo()
    await tick()
    expect(layerIds()).toEqual(['L1'])

    // 速查表补组收据（6.1 余项）：图层操作组六行入表
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))
    await tick()
    const text = document.body.textContent ?? ''
    expect(text).toContain('新建图层')
    expect(text).toContain('向下合并（并入下一可见未锁层）')
    expect(text).toContain('当前层下移 / 上移一层（z 序）')
    expect(text).toContain('当前层置底 / 置顶')
    expect(text).toContain('孤立显示该层')

    view.unmount()
  })

  it('⌘E 向下合并：当前层并入下一可见未锁层（单 op 撤销恢复源层与归属；当前层改指目标层）', async () => {
    const view = mountView()
    await tick()
    addLayers(1) // [L1, L2]
    // 把 g00001 移入 L2 并设为当前层——⌘E 应把 L2 并入 L1（归属批量改写）
    const { moveGemsToLayer } = await import('$lib/stores/edit.svelte')
    await moveGemsToLayer(['g00001'], 'L2')
    setCurrentLayerId('L2', getEditDoc())
    const before = getUndoDepths().undo

    key('e', { meta: true })
    await tick()
    expect(layerIds()).toEqual(['L1'])
    expect(gem('g00001').layerId).toBe('L1')
    expect(getCurrentLayerId()).toBe('L1') // 源层被删：当前层不持悬空 id
    expect(getUndoDepths().undo).toBe(before + 1)

    undo()
    await tick()
    expect(layerIds()).toEqual(['L1', 'L2']) // 一次撤销恢复源层与全部归属
    expect(gem('g00001').layerId).toBe('L2')

    view.unmount()
  })

  it('⌘E 无候选（单层 / 下方全锁隐）：返回 false 放行浏览器默认', async () => {
    const view = mountView()
    await tick()
    const before = getUndoDepths().undo

    const ke = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true, metaKey: true })
    window.dispatchEvent(ke)
    expect(ke.defaultPrevented).toBe(false) // 单层无向下目标
    expect(getUndoDepths().undo).toBe(before)

    view.unmount()
  })

  it('⌘] / ⌘[ 当前层上移/下移一层（z 序数组序 op）；⌘⇧] / ⌘⇧[ 置顶/置底；边界无位移返回 false；撤销恢复层序', async () => {
    const view = mountView()
    await tick()
    addLayers(2) // [L1, L2, L3]
    setCurrentLayerId('L1', getEditDoc())
    const before = getUndoDepths().undo

    key(']', { meta: true })
    await tick()
    expect(layerIds()).toEqual(['L2', 'L1', 'L3'])
    key(']', { meta: true })
    await tick()
    expect(layerIds()).toEqual(['L2', 'L3', 'L1'])
    key(']', { meta: true }) // 已最上：无位移
    await tick()
    expect(layerIds()).toEqual(['L2', 'L3', 'L1'])

    key('{', { meta: true, shift: true }) // ⌘⇧[ 置底
    await tick()
    expect(layerIds()).toEqual(['L1', 'L2', 'L3'])
    key('}', { meta: true, shift: true }) // ⌘⇧] 置顶
    await tick()
    expect(layerIds()).toEqual(['L2', 'L3', 'L1'])
    key('[', { meta: true }) // 下移一层
    await tick()
    expect(layerIds()).toEqual(['L2', 'L1', 'L3'])
    expect(getUndoDepths().undo).toBe(before + 5) // 五次有效位移各一组（第三次 ⌘] 已最上无位移不产组）

    // 撤销一次 = 恢复一次位移（数组序 op 逐组可撤销；不改 gems[] 真源序）
    const gemOrderBefore = getEditDoc()!.gems.map((g) => g.id)
    undo()
    await tick()
    expect(layerIds()).toEqual(['L2', 'L3', 'L1'])
    expect(getEditDoc()!.gems.map((g) => g.id)).toEqual(gemOrderBefore) // 真源序不动

    view.unmount()
  })

  it('面板按钮与键位同命令：designer-layer-up 与 ⌘] 同结果（命令总线单源）', async () => {
    const view = mountView()
    await tick()
    addLayers(1) // [L1, L2]

    ;(view.q('designer-layer-up-L1') as HTMLElement).click()
    await tick()
    expect(layerIds()).toEqual(['L2', 'L1'])

    ;(view.q('designer-layer-down-L1') as HTMLElement).click()
    await tick()
    expect(layerIds()).toEqual(['L1', 'L2'])

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
