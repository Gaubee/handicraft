/*
 * [2026-09-20 C-3.4 / D-5.1 Test] 属性面板字段框架（rename-and-expert-workbench tasks 3.4/5.1）：
 * 三态显示（空态/单选/N 选）、混合值占位「—」、字段描述符 → patch 构造（纯函数）、
 * 批量改色 = 单 undo 组（beginStroke/endStroke 复用）、undo 整组回退；
 * [D-5.1] 规格字段注册：shapeId select（内置五形）/diameterMm/rotationDeg number 控件、
 * 值域守卫（正数径/[0,360) 朝向）、选项守卫、改形/改径/旋转 → gemdoc 序列化回读 round-trip。
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
import { applyGemChanges } from '../../components/Edit/gemCommands'
import { BUILTIN_SHAPES, type EditGem } from '$lib/engine'
import { serializeGemdoc, parseGemdoc } from '$lib/persistence/projectFile'
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

describe('字段描述符注册表（D-5.1 规格字段注册）', () => {
  it('默认注册：colorId/x/y + shapeId(select)/diameterMm/rotationDeg(number)——reserved 位退役', () => {
    const byKey = new Map(EDIT_PROPERTY_FIELDS.map((f) => [f.key, f]))
    expect(byKey.get('colorId')!.control).toBe('color')
    expect(byKey.get('x')!.control).toBe('number')
    expect(byKey.get('y')!.control).toBe('number')
    expect(byKey.get('shapeId')!.control).toBe('select')
    expect(byKey.get('diameterMm')!.control).toBe('number')
    expect(byKey.get('rotationDeg')!.control).toBe('number')
    expect(EDIT_PROPERTY_FIELDS.every((f) => f.control !== 'reserved')).toBe(true)
  })

  it('形状目录 = 内置五形中文名（custom 不在列——assetId 不入 update 白名单）', () => {
    const shape = EDIT_PROPERTY_FIELDS.find((f) => f.key === 'shapeId')!
    if (shape.control !== 'select') throw new Error('shapeId 应为 select 控件')
    expect(shape.options.map((o) => o.value)).toEqual(BUILTIN_SHAPES.map((s) => s.shapeId))
    expect(shape.options.some((o) => o.value === 'custom')).toBe(false)
  })
})

describe('computePropertyViews（纯函数三态）', () => {
  it('空选不产出字段', () => {
    expect(computePropertyViews([])).toEqual([])
  })

  it('单选：uniform 值直读（规格字段：形状 round/尺寸 2.8/朝向缺省 0）', () => {
    const views = computePropertyViews([gem('g00001')])
    const byKey = new Map(views.map((v) => [v.field.key, v]))
    expect(byKey.get('colorId')).toMatchObject({ state: 'uniform', value: 'red' })
    expect(byKey.get('x')).toMatchObject({ state: 'uniform', value: 4 })
    expect(byKey.get('y')).toMatchObject({ state: 'uniform', value: 4 })
    expect(byKey.get('shapeId')).toMatchObject({ state: 'uniform', value: 'round' })
    expect(byKey.get('diameterMm')).toMatchObject({ state: 'uniform', value: 2.8 })
    expect(byKey.get('rotationDeg')).toMatchObject({ state: 'uniform', value: 0 }) // 圆钻缺省朝上
  })

  it('N 选混合：异值字段 mixed、同值字段 uniform', () => {
    const views = computePropertyViews([gem('g00001'), gem('g00002')])
    const byKey = new Map(views.map((v) => [v.field.key, v]))
    expect(byKey.get('colorId')?.state).toBe('mixed') // red vs gold
    expect(byKey.get('x')?.state).toBe('mixed') // 4 vs 12
    expect(byKey.get('y')).toMatchObject({ state: 'uniform', value: 4 })
  })

  it('径异值混合态：改径后的钻与未改径钻同选 → diameterMm mixed', () => {
    applyPatch({
      op: 'update',
      changes: [{ id: 'g00001', before: { diameterMm: 2.8 }, after: { diameterMm: 4.0 } }],
    })
    const views = computePropertyViews([gem('g00001'), gem('g00002')])
    const byKey = new Map(views.map((v) => [v.field.key, v]))
    expect(byKey.get('diameterMm')?.state).toBe('mixed') // 4.0 vs 2.8
    expect(byKey.get('shapeId')?.state).toBe('uniform') // 形未变
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
    const colorSelect = view.target.querySelector<HTMLSelectElement>('[data-testid="edit-prop-colorId"] select')!
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

  it('规格字段渲染为可用控件（select/number——D-5.1 注册）', async () => {
    const view = mountPanel()
    await tick()

    setSelection(['g00001'])
    await tick()
    const shape = view.target.querySelector<HTMLSelectElement>('[data-testid="edit-prop-shapeId"] select')!
    expect(shape.value).toBe('round')
    expect(shape.options.length).toBe(BUILTIN_SHAPES.length)
    const diameter = view.target.querySelector<HTMLInputElement>('#edit-prop-input-diameterMm')!
    expect(diameter.value).toBe('2.8')
    const rotation = view.target.querySelector<HTMLInputElement>('#edit-prop-input-rotationDeg')!
    expect(rotation.value).toBe('0') // 圆钻缺省朝向

    view.unmount()
  })
})

describe('D-5.1 规格字段写入（值域守卫 + 批量单组 + 序列化回读）', () => {
  function fieldOf(key: string) {
    const field = EDIT_PROPERTY_FIELDS.find((f) => f.key === key)
    if (!field) throw new Error(`missing field ${key}`)
    return field
  }

  it('改形/改径/旋转三字段写入生效且 = 单 undo 组；undo 整组回退', () => {
    const selected = [gem('g00001'), gem('g00002')]

    const shapePatch = buildFieldUpdatePatch(selected, fieldOf('shapeId'), 'square')!
    applyGemChanges(shapePatch.changes)
    const diameterPatch = buildFieldUpdatePatch(selected, fieldOf('diameterMm'), 3.5)!
    applyGemChanges(diameterPatch.changes)
    const rotationPatch = buildFieldUpdatePatch(selected, fieldOf('rotationDeg'), 45)!
    applyGemChanges(rotationPatch.changes)

    for (const id of ['g00001', 'g00002']) {
      const g = gem(id)
      expect(g.shapeId).toBe('square')
      expect(g.diameterMm).toBe(3.5)
      expect(g.rotationDeg).toBe(45)
    }
    expect(getUndoDepths().undo).toBe(3) // 三次批量写 = 三个单组

    undo()
    undo()
    undo()
    for (const id of ['g00001', 'g00002']) {
      const g = gem(id)
      expect(g.shapeId).toBe('round')
      expect(g.diameterMm).toBe(2.8)
      // undo 对称性（properties.ts 头注登记）：回写 rotationDeg:0（非删除键）——显示与初态等价（读 0）
      expect(g.rotationDeg).toBe(0)
    }
  })

  it('批量改径 = 单 undo 组（N 选一条 update patch）', () => {
    const selected = [gem('g00001'), gem('g00002'), gem('g00003')]
    const patch = buildFieldUpdatePatch(selected, fieldOf('diameterMm'), 4.8)!
    expect(patch.changes).toHaveLength(3)
    applyGemChanges(patch.changes)
    expect(getUndoDepths().undo).toBe(1)
    undo()
    expect(gem('g00001').diameterMm).toBe(2.8)
  })

  it('值域守卫：diameterMm ≤0 / 非数、rotationDeg ∉[0,360) → patch null（不产脏文档）', () => {
    const selected = [gem('g00001')]
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildFieldUpdatePatch(selected, fieldOf('diameterMm'), bad)).toBeNull()
    }
    for (const bad of [-1, 360, 720]) {
      expect(buildFieldUpdatePatch(selected, fieldOf('rotationDeg'), bad)).toBeNull()
    }
    expect(buildFieldUpdatePatch(selected, fieldOf('diameterMm'), 'abc')).toBeNull()
    expect(getUndoDepths().undo).toBe(0)
  })

  it('选项守卫：select 值 ∉ options（custom/未知形）→ patch null', () => {
    const selected = [gem('g00001')]
    expect(buildFieldUpdatePatch(selected, fieldOf('shapeId'), 'custom')).toBeNull()
    expect(buildFieldUpdatePatch(selected, fieldOf('shapeId'), 'hexagon')).toBeNull()
  })

  it('朝向写入 0 到无 rotationDeg 的圆钻 = 无变更（patch null；保持圆钻恒缺省）', () => {
    const selected = [gem('g00001')]
    expect(gem('g00001').rotationDeg).toBeUndefined()
    expect(buildFieldUpdatePatch(selected, fieldOf('rotationDeg'), 0)).toBeNull()
    expect('rotationDeg' in gem('g00001')).toBe(false)
  })

  it('改形/改径/旋转 → gemdoc 序列化回读 round-trip（字段持久面）', () => {
    const doc = getEditDoc()!
    applyGemChanges(buildFieldUpdatePatch([gem('g00001')], fieldOf('shapeId'), 'marquise')!.changes)
    applyGemChanges(buildFieldUpdatePatch([gem('g00001')], fieldOf('diameterMm'), 4.3)!.changes)
    applyGemChanges(buildFieldUpdatePatch([gem('g00001')], fieldOf('rotationDeg'), 90)!.changes)

    // 序列化载荷与 gemdocLifecycle.serializeCurrentGemdoc 同构（reference 缺席分支）
    // [1.2 v3 演进] 序列化输入面：blocks/painting 顶层键 → underlay 源载荷；layers = 钻石层记录
    const text = serializeGemdoc({
      appVersion: '0.1.0-test',
      createdAt: 0,
      savedAt: 0,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      grid: doc.grid,
      palette: doc.palette,
      gems: doc.gems,
      layers: doc.layers,
      underlay: {
        sources: [
          { key: 'painting', visible: true, opacity: 1, painting: { mime: 'image/png' as const, dataUrl: 'data:image/png;base64,AAAA' } },
          { key: 'blocks', visible: true, opacity: 0.9, blocks: doc.blocks },
        ],
      },
      provenance: { origin: 'studio-bake', sourceSummary: doc.sourceSummary },
    })
    const file = parseGemdoc(text)
    const roundTripped = file.gems.find((g) => g.id === 'g00001')!
    expect(roundTripped.shapeId).toBe('marquise')
    expect(roundTripped.diameterMm).toBe(4.3)
    expect(roundTripped.rotationDeg).toBe(90)
    // 未触及钻保持缺省朝向（无键）
    expect('rotationDeg' in (file.gems.find((g) => g.id === 'g00002')!)).toBe(false)
  })

  it('面板控件写入路径：改径经 select/number 控件 change 生效（jsdom 全链）', async () => {
    const view = mountPanel()
    await tick()

    setSelection(['g00001', 'g00002'])
    await tick()
    const diameter = view.target.querySelector<HTMLInputElement>('#edit-prop-input-diameterMm')!
    fireChange(diameter, '4.0')
    await tick()

    expect(gem('g00001').diameterMm).toBe(4.0)
    expect(gem('g00002').diameterMm).toBe(4.0)
    expect(getUndoDepths().undo).toBe(1)

    // 值域外输入经同一面板路径被拒（不落 patch）
    fireChange(diameter, '-1')
    await tick()
    expect(gem('g00001').diameterMm).toBe(4.0)
    expect(getUndoDepths().undo).toBe(1)

    const shape = view.target.querySelector<HTMLSelectElement>('[data-testid="edit-prop-shapeId"] select')!
    fireChange(shape, 'heart')
    await tick()
    expect(gem('g00001').shapeId).toBe('heart')

    view.unmount()
  })
})
