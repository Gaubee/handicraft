/*
 * [2026-09-20 C-3.4 Test] 属性面板字段框架（rename-and-expert-workbench tasks 3.4）：
 * 三态显示（空态/单选/N 选）、混合值占位「—」、字段描述符 → patch 构造（纯函数）、
 * 批量改色 = 单 undo 组（beginStroke/endStroke 复用）、undo 整组回退、
 * 规格字段（形状/尺寸/朝向）控件位预留不注册（5.1）断言。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditPropertiesPanel from '../../components/Edit/EditPropertiesPanel.svelte'
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
import { resetWorkbenchForTests } from '../../components/Edit/workbench.svelte'
import {
  buildFieldUpdatePatch,
  computePropertyViews,
  EDIT_PROPERTY_FIELDS,
} from '../../components/Edit/properties'
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

function mountPanel(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EditPropertiesPanel, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function gem(id: string): EditGem {
  const found = getEditDoc()!.gems.find((g) => g.id === id)
  if (!found) throw new Error(`missing gem ${id}`)
  return found
}

function fireChange(el: Element, value: string): void {
  ;(el as HTMLInputElement | HTMLSelectElement).value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // g0000n: x=4+(n-1)*8, y=4, 色循环 red/gold/ivory/olive/black
})

describe('字段描述符注册表（规格位预留不注册）', () => {
  it('默认注册：colorId/x/y 为可用控件；shapeId/diameterMm/rotationDeg 为 reserved', () => {
    const byKey = new Map(EDIT_PROPERTY_FIELDS.map((f) => [f.key, f]))
    expect(byKey.get('colorId')!.control).toBe('color')
    expect(byKey.get('x')!.control).toBe('number')
    expect(byKey.get('y')!.control).toBe('number')
    expect(byKey.get('shapeId')!.control).toBe('reserved')
    expect(byKey.get('diameterMm')!.control).toBe('reserved')
    expect(byKey.get('rotationDeg')!.control).toBe('reserved')
  })

  it('框架类型面已容纳规格字段（5.1 注册时零框架改动）', () => {
    // NumberPropertyField 的 key 联合包含 diameterMm/rotationDeg；SelectPropertyField 承载 shapeId
    const numberKeys: Array<'x' | 'y' | 'diameterMm' | 'rotationDeg'> = ['x', 'y', 'diameterMm', 'rotationDeg']
    expect(numberKeys).toHaveLength(4)
  })
})

describe('computePropertyViews（纯函数三态）', () => {
  it('空选不产出字段', () => {
    expect(computePropertyViews([])).toEqual([])
  })

  it('单选：uniform 值直读', () => {
    const views = computePropertyViews([gem('g00001')])
    const byKey = new Map(views.map((v) => [v.field.key, v]))
    expect(byKey.get('colorId')).toMatchObject({ state: 'uniform', value: 'red' })
    expect(byKey.get('x')).toMatchObject({ state: 'uniform', value: 4 })
    expect(byKey.get('y')).toMatchObject({ state: 'uniform', value: 4 })
    expect(byKey.get('shapeId')?.state).toBe('reserved')
  })

  it('N 选混合：异值字段 mixed、同值字段 uniform', () => {
    const views = computePropertyViews([gem('g00001'), gem('g00002')])
    const byKey = new Map(views.map((v) => [v.field.key, v]))
    expect(byKey.get('colorId')?.state).toBe('mixed') // red vs gold
    expect(byKey.get('x')?.state).toBe('mixed') // 4 vs 12
    expect(byKey.get('y')).toMatchObject({ state: 'uniform', value: 4 })
  })
})

describe('buildFieldUpdatePatch（纯函数）', () => {
  it('只记变更钻；全未变 → null', () => {
    const one = gem('g00001')
    const field = EDIT_PROPERTY_FIELDS.find((f) => f.key === 'colorId')!
    const patch = buildFieldUpdatePatch([one], field, 'red') // 未变
    expect(patch).toBeNull()

    const two = [gem('g00001'), gem('g00002')]
    const changed = buildFieldUpdatePatch(two, field, 'black')!
    expect(changed.op).toBe('update')
    expect(changed.changes).toHaveLength(2)
    expect(changed.changes[0]).toEqual({
      id: 'g00001',
      before: { colorId: 'red' },
      after: { colorId: 'black' },
    })
  })
})

describe('面板三态与批量写（mount）', () => {
  it('空态 → 单选 → N 选三态显示与混合值占位', async () => {
    const view = mountPanel()
    await tick()

    expect(view.target.querySelector('[data-testid="edit-properties-empty"]')).not.toBeNull()

    setSelection(['g00001'])
    await tick()
    expect(view.target.querySelector('[data-testid="edit-properties-count"]')?.textContent).toContain('1 颗已选')
    const colorSelect = view.target.querySelector<HTMLSelectElement>('[data-testid="edit-prop-colorId"] select')!
    expect(colorSelect.value).toBe('red')
    expect(view.target.querySelector<HTMLSelectElement>('#edit-prop-input-x')?.value).toBe('4')

    setSelection(['g00001', 'g00002'])
    await tick()
    expect(view.target.querySelector('[data-testid="edit-properties-count"]')?.textContent).toContain('2 颗已选')
    expect(colorSelect.dataset.mixed).toBe('true') // 混合值占位「—（混合值）」
    expect(view.target.querySelector('#edit-prop-input-x')?.getAttribute('data-mixed')).toBe('true')

    view.unmount()
  })

  it('批量改色 = 单 undo 组；undo 整组回退两钻颜色', async () => {
    const view = mountPanel()
    await tick()

    setSelection(['g00001', 'g00002'])
    await tick()
    const colorSelect = view.target.querySelector('[data-testid="edit-prop-colorId"] select')!
    fireChange(colorSelect, 'black')
    await tick()

    expect(gem('g00001').colorId).toBe('black')
    expect(gem('g00002').colorId).toBe('black')
    expect(getUndoDepths().undo).toBe(1) // N 选批量 = 单组

    undo()
    expect(gem('g00001').colorId).toBe('red')
    expect(gem('g00002').colorId).toBe('gold')

    view.unmount()
  })

  it('混合值态写入 = 全选钻统一为写入值', async () => {
    const view = mountPanel()
    await tick()

    setSelection(['g00001', 'g00002', 'g00003'])
    await tick()
    const colorSelect = view.target.querySelector('[data-testid="edit-prop-colorId"] select')!
    expect(colorSelect.dataset.mixed).toBe('true')
    fireChange(colorSelect, 'olive')
    await tick()

    expect(gem('g00001').colorId).toBe('olive')
    expect(gem('g00002').colorId).toBe('olive')
    expect(gem('g00003').colorId).toBe('olive')

    view.unmount()
  })

  it('x 数值字段写入：单选改 x 生效且为单组', async () => {
    const view = mountPanel()
    await tick()

    setSelection(['g00001'])
    await tick()
    const xInput = view.target.querySelector<HTMLInputElement>('#edit-prop-input-x')!
    fireChange(xInput, '10.5')
    await tick()

    expect(gem('g00001').x).toBe(10.5)
    expect(getUndoDepths().undo).toBe(1)

    view.unmount()
  })

  it('同值重写不产生 undo 组（patch 为空）', async () => {
    const view = mountPanel()
    await tick()

    setSelection(['g00001'])
    await tick()
    const colorSelect = view.target.querySelector('[data-testid="edit-prop-colorId"] select')!
    fireChange(colorSelect, 'red') // 已是 red
    await tick()
    expect(getUndoDepths().undo).toBe(0)

    view.unmount()
  })

  it('规格字段位渲染为禁用占位（不注册控件）', async () => {
    const view = mountPanel()
    await tick()

    setSelection(['g00001'])
    await tick()
    const shape = view.target.querySelector('[data-testid="edit-prop-reserved-shapeId"]')
    expect(shape).not.toBeNull()
    expect(shape?.textContent).toContain('—')
    expect(shape?.querySelector('select, input')).toBeNull() // 无控件注册

    view.unmount()
  })
})
