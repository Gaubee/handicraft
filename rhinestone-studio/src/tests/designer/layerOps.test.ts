/*
 * [2026-09-21 redesign-designer-workbench 4.2 Test] 层操作命令面 + 属性面板层字段（design §4.3/§1.2）：
 * mergeGemLayersBatch 多源单 op（一次撤销恢复全部源层与归属）/ 层配置冲突取目标层 /
 * 属性面板所属图层字段只读→可改（下拉选层 = 移入语义 moveGemsToLayer 单 op——与图层面板
 * 移入按钮/右键菜单同命令面）/ 多选混合层「混合」占位不直写（显式选层才移入全部）/
 * 锁定·隐藏目标 option 禁用（design §2.2 移入图层禁用纪律）。
 * 面板按钮面（合并/移入/排序/重命名）由 4.1 layersPanel.test.ts 覆盖，不重复。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerPropertiesPanel from '../../components/Designer/DesignerPropertiesPanel.svelte'
import {
  addGemLayer,
  applyPatch,
  getEditDoc,
  getUndoDepths,
  loadFromHandoff,
  mergeGemLayersBatch,
  nextManualId,
  resetEditForTests,
  setGemLayerLocked,
  setGemLayerVisible,
  setSelection,
  undo,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountPanel(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerPropertiesPanel, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function addManualGem(layerId: string, x = 40): string {
  const id = nextManualId()
  applyPatch({
    op: 'add',
    gems: [
      {
        id,
        x,
        y: 40,
        colorId: 'red',
        blockId: null,
        origin: 'manual',
        moved: false,
        shapeId: 'round',
        diameterMm: 2.8,
        layerId,
      },
    ],
  })
  return id
}

/** 模拟 select onchange（jsdom：设 value + dispatch change——Svelte onchange 收到）。 */
function selectLayer(target: HTMLElement, testid: string, value: string): void {
  const select = target.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)!
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(6))
})

describe('mergeGemLayersBatch：多源合并单 op（design §4.3「合并」行 + 4.1 批量形态）', () => {
  it('多选源层并入目标层：全部归属改写 + 全部源层删除，仍单 op（一次撤销恢复全部）', () => {
    const l2 = addGemLayer('源层 A')!
    const l3 = addGemLayer('源层 B')!
    addManualGem(l2)
    addManualGem(l3)
    // L1 也挪一颗到 L3（多源各持不同量钻）
    applyPatch({ op: 'update', changes: [{ id: getEditDoc()!.gems[0].id, before: { layerId: 'L1' }, after: { layerId: l3 } }] })

    const depthBefore = getUndoDepths().undo
    expect(mergeGemLayersBatch([l2, l3], 'L1').ok).toBe(true)
    let doc = getEditDoc()!
    expect(doc.layers.map((l) => l.id)).toEqual(['L1']) // 两源层记录同删
    expect(doc.gems.every((g) => g.layerId === 'L1')).toBe(true)
    expect(getUndoDepths().undo).toBe(depthBefore + 1) // 单 op：一次撤销恢复全部

    undo()
    doc = getEditDoc()!
    expect(doc.layers.map((l) => l.id)).toEqual(['L1', 'L2', 'L3'])
    expect(doc.layers.find((l) => l.id === l2)?.name).toBe('源层 A')
    expect(doc.gems.filter((g) => g.id.startsWith('m-')).length).toBe(2) // 源层钻恢复原归属
    expect(doc.gems.filter((g) => g.id.startsWith('m-') && g.layerId === l2).length).toBe(1)
    expect(doc.gems.filter((g) => g.layerId === l3).length).toBe(2) // 手工 1 颗 + L1 挪入 1 颗
  })

  it('拒绝面：目标∈源 / 源不存在 / 目标不存在 / 空源集 no-op', () => {
    const l2 = addGemLayer()!
    expect(mergeGemLayersBatch([l2, 'L1'], 'L1').ok).toBe(false) // 目标在源集中
    expect(mergeGemLayersBatch(['L9'], 'L1').ok).toBe(false) // 源不存在
    expect(mergeGemLayersBatch(['L2'], 'L9').ok).toBe(false) // 目标不存在
    const depth = getUndoDepths().undo
    expect(mergeGemLayersBatch([], 'L1').ok).toBe(true) // 空源集 no-op 不产组
    expect(getUndoDepths().undo).toBe(depth)
  })
})

describe('属性面板所属图层字段（4.2：只读→可改，下拉=移入语义单 op）', () => {
  function layerSelect(target: HTMLElement): HTMLSelectElement {
    const select = target.querySelector<HTMLSelectElement>('[data-testid="designer-prop-layerId"] select')
    expect(select).not.toBeNull()
    return select!
  }

  function changeLayer(target: HTMLElement, value: string): void {
    const select = layerSelect(target)
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('单选显示层名；下拉选层 = 移入（单 op，一次撤销回原层）；选当前层 no-op 不产组', async () => {
    addGemLayer('目标层')
    const id = getEditDoc()!.gems[0].id
    setSelection([id])
    const view = mountPanel()
    await tick()

    const select = layerSelect(view.target)
    expect(select.value).toBe('L1')
    expect(select.selectedOptions[0]?.textContent).toContain('图层 1')

    const depthBefore = getUndoDepths().undo
    changeLayer(view.target, 'L2')
    await tick()
    expect(getEditDoc()!.gems[0].layerId).toBe('L2')
    expect(getUndoDepths().undo).toBe(depthBefore + 1) // 单 op

    undo()
    expect(getEditDoc()!.gems[0].layerId).toBe('L1')

    // 选当前层（归属已同）= 无真实变更 no-op，不产撤销组
    const depth = getUndoDepths().undo
    changeLayer(view.target, 'L1')
    await tick()
    expect(getEditDoc()!.gems[0].layerId).toBe('L1')
    expect(getUndoDepths().undo).toBe(depth)

    view.unmount()
  })

  it('多选混合层：显示「混合」占位不直写；显式选层 = 全部选中钻移入（单 op）', async () => {
    addGemLayer('第二层')
    const g1 = getEditDoc()!.gems[0].id
    const m1 = addManualGem('L2')
    setSelection([g1, m1])
    const view = mountPanel()
    await tick()

    const field = view.target.querySelector('[data-testid="designer-prop-layerId"]')!
    const select = layerSelect(view.target)
    expect(select.getAttribute('data-mixed')).toBe('true')
    expect(field.textContent).toContain('跨层')
    expect(select.value).toBe('') // 占位不直写任何层值

    const depthBefore = getUndoDepths().undo
    changeLayer(view.target, 'L2') // 显式选层 = 移入命令（混合态全量移入）
    await tick()
    const doc = getEditDoc()!
    expect(doc.gems.find((g) => g.id === g1)?.layerId).toBe('L2')
    expect(doc.gems.find((g) => g.id === m1)?.layerId).toBe('L2')
    expect(getUndoDepths().undo).toBe(depthBefore + 1) // 一条 update patch = 单组

    undo()
    expect(getEditDoc()!.gems.find((g) => g.id === g1)?.layerId).toBe('L1')

    view.unmount()
  })

  it('锁定/隐藏目标 option 禁用（design §2.2 移入图层禁用纪律）；当前归属层照常显示', async () => {
    addGemLayer('锁定层')
    addGemLayer('隐藏层')
    setGemLayerLocked('L2', true)
    setGemLayerVisible('L3', false)
    const id = getEditDoc()!.gems[0].id
    setSelection([id])
    const view = mountPanel()
    await tick()

    const select = layerSelect(view.target)
    const disabled = [...select.options].filter((o) => o.disabled).map((o) => o.value)
    expect(disabled).toEqual(['L2', 'L3'])
    expect(select.value).toBe('L1') // 当前归属层（可见未锁）正常选中

    view.unmount()
  })
})
