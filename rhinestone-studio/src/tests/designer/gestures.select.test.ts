/*
 * [2026-09-21 redesign-designer-workbench 3.x Test] P1-P4 选择系（design §2 逐行）：
 * 纯可选性判定（锁定=视为空白 / 隐藏不可选）+ jsdom pointer 序列（单选替换 / Shift 加减选 /
 * 框选跳锁定层 / 点击空白清空）。沿 workbench.selection.test.ts 模式：视图坐标经
 * computeFit(600,420,64,64) 确定性换算（jsdom clientWidth=0 → 画布回退 600×420）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  applyPatch,
  getEditDoc,
  loadFromHandoff,
  resetEditForTests,
  setSelection,
  toggleSelection,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { getMarqueeHitCount, resetInteractionForTests } from '$lib/designer/interaction.svelte'
import { isGemSelectable, selectabilityFilter } from '$lib/designer/gestures'
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

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

function pointer(
  el: Element,
  type: string,
  at: { x: number; y: number },
  extra: { shiftKey?: boolean; altKey?: boolean } = {},
): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: c.clientX,
      clientY: c.clientY,
      shiftKey: extra.shiftKey ?? false,
      altKey: extra.altKey ?? false,
    }),
  )
}

function selectionIds(): string[] {
  const doc = getEditDoc()
  return doc ? [...doc.selection].sort() : []
}

function mountView(): { target: HTMLElement; canvas: () => HTMLCanvasElement | null; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    canvas: () => target.querySelector<HTMLCanvasElement>('[data-testid="designer-canvas-canvas"]'),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

/** 锁层/隐层工具：改 L1 态或把指定钻移入新层。 */
function layerStateOf(doc: NonNullable<ReturnType<typeof getEditDoc>>, id: string) {
  return doc.layers.find((l) => l.id === id)
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetInteractionForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // 12 颗单行六方钻：g0000n.x = 4 + (n-1)*8，y = 4
})

describe('P1 纯判定：可选性（锁定/隐藏/悬空层）', () => {
  it('isGemSelectable：可见未锁=true；锁定/隐藏/层缺席=false', () => {
    const layers = [
      { id: 'L1', visible: true, locked: false },
      { id: 'L2', visible: true, locked: true },
      { id: 'L3', visible: false, locked: false },
    ]
    expect(isGemSelectable({ layerId: 'L1' }, layers)).toBe(true)
    expect(isGemSelectable({ layerId: 'L2' }, layers)).toBe(false) // 锁定=视为空白（P1）
    expect(isGemSelectable({ layerId: 'L3' }, layers)).toBe(false) // 隐藏不渲染不可选
    expect(isGemSelectable({ layerId: 'LX' }, layers)).toBe(false) // 悬空归属
    const filter = selectabilityFilter(layers)
    expect(filter({ layerId: 'L2' })).toBe(false)
    expect(filter({ layerId: 'L1' })).toBe(true)
  })
})

describe('P1 pointer：锁定层钻点击=空白（不选中）', () => {
  it('锁定层整层后点击原命中位 → 视为空白 → 清空选集', async () => {
    const doc = getEditDoc()!
    layerStateOf(doc, 'L1')!.locked = true
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00002'])
    pointer(canvas, 'pointerdown', { x: 4, y: 4 }) // g00001 位（锁定层）
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    await tick()
    expect(selectionIds()).toEqual([]) // P1：锁定层钻上点击 = 空白 → P2 清空

    view.unmount()
  })

  it('隐藏层钻点击=空白', async () => {
    const doc = getEditDoc()!
    layerStateOf(doc, 'L1')!.visible = false
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    await tick()
    expect(selectionIds()).toEqual([])

    view.unmount()
  })

  it('Shift 点锁定层钻 → 选择不变（不加不减）', async () => {
    const doc = getEditDoc()!
    layerStateOf(doc, 'L1')!.locked = true
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    toggleSelection('g00002') // 悬空构造既有选集（锁定层仍可持遗留选集）
    pointer(canvas, 'pointerdown', { x: 4, y: 4 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 4, y: 4 }, { shiftKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00002'])

    view.unmount()
  })
})

describe('P1-P3 pointer：单选替换 / Shift 加减选 / 空白清空', () => {
  it('P1 单击钻 → 替换现选集', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00005'])
    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    await tick()
    expect(selectionIds()).toEqual(['g00001'])

    view.unmount()
  })

  it('P2 单击空白 → 清空选集', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001'])
    pointer(canvas, 'pointerdown', { x: 60, y: 60 })
    pointer(canvas, 'pointerup', { x: 60, y: 60 })
    await tick()
    expect(selectionIds()).toEqual([])

    view.unmount()
  })

  it('P3 Shift 点选加选 / 再点减选', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 4, y: 4 })
    pointer(canvas, 'pointerup', { x: 4, y: 4 })
    pointer(canvas, 'pointerdown', { x: 12, y: 4 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 12, y: 4 }, { shiftKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001', 'g00002'])

    pointer(canvas, 'pointerdown', { x: 12, y: 4 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 12, y: 4 }, { shiftKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001'])

    view.unmount()
  })
})

describe('P4 pointer：框选跳锁定层（Shift 拖 = 并入现选集）', () => {
  it('框选只收集未锁定层钻：锁定子层钻不入选', async () => {
    const doc = getEditDoc()!
    // 拆两层：g00001-g00002 留 L1（未锁），g00003+ 移入新层并锁定
    applyPatch({
      op: 'layers',
      before: doc.layers.map((l) => ({ ...l })),
      after: [
        ...doc.layers.map((l) => ({ ...l })),
        { id: 'L2', name: '图层 2', visible: true, locked: true },
      ],
    })
    applyPatch({
      op: 'update',
      changes: doc.gems.slice(2).map((g) => ({ id: g.id, before: { layerId: 'L1' }, after: { layerId: 'L2' } })),
    })
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    // 从空白（y=-6 行上方无钻）起拖，框住 g00001-g00003 圆域
    pointer(canvas, 'pointerdown', { x: 0, y: -6 })
    pointer(canvas, 'pointermove', { x: 24, y: 10 })
    pointer(canvas, 'pointerup', { x: 24, y: 10 })
    await tick()
    expect(selectionIds()).toEqual(['g00001', 'g00002']) // g00003 在锁定层 → 跳过

    view.unmount()
  })

  it('隐藏层钻同样不入框选', async () => {
    const doc = getEditDoc()!
    applyPatch({
      op: 'layers',
      before: doc.layers.map((l) => ({ ...l })),
      after: [
        ...doc.layers.map((l) => ({ ...l })),
        { id: 'L2', name: '图层 2', visible: false, locked: false },
      ],
    })
    applyPatch({
      op: 'update',
      changes: doc.gems.slice(0, 2).map((g) => ({ id: g.id, before: { layerId: 'L1' }, after: { layerId: 'L2' } })),
    })
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    pointer(canvas, 'pointerdown', { x: 0, y: -6 })
    pointer(canvas, 'pointermove', { x: 24, y: 10 })
    pointer(canvas, 'pointerup', { x: 24, y: 10 })
    await tick()
    // g00001/g00002 隐藏层跳过，其余（g00003 起）按相交收集
    const doc2 = getEditDoc()!
    const expected = doc2.gems
      .filter((g) => g.layerId === 'L1')
      .filter((g) => g.x - 3.5 <= 24 && g.x + 3.5 >= 0)
      .map((g) => g.id)
      .sort()
    expect(selectionIds()).toEqual(expected)

    view.unmount()
  })

  it('Shift 框选 = 并入现选集（命中空保持原选）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00005'])
    pointer(canvas, 'pointerdown', { x: 0, y: -6 }, { shiftKey: true })
    pointer(canvas, 'pointermove', { x: 10, y: 10 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 10, y: 10 }, { shiftKey: true })
    await tick()
    // g00001(4,4) 中心在内；g00002(12,4) 圆边触右界 10；g00005 预选并入
    expect(selectionIds()).toEqual(['g00001', 'g00002', 'g00005'])

    view.unmount()
  })
})

// [rework R4.2 显式新增] Alt+框选减选 + 框选实时命中数（design §3.2/§3.5 补行；
// Alt 拖复制互斥 = 结构性：marquee 仅空白起拖武装、钻上起拖走 mode='move' 复制分支）。
describe('P4 Alt+框选 = 从选区减去（R4.2）', () => {
  it('spec Scenario：Shift 框 6 颗后 Alt 框 2 颗区域 → 收敛 4 颗；不产生移动或复制', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    const before = getEditDoc()!.gems.map((g) => ({ ...g }))

    // Shift 框选 g00001-G00006（x ∈ [4,44]；右界 47 不触 g00007 圆边 48.5）
    pointer(canvas, 'pointerdown', { x: 0, y: -6 }, { shiftKey: true })
    pointer(canvas, 'pointermove', { x: 47, y: 12 }, { shiftKey: true })
    pointer(canvas, 'pointerup', { x: 47, y: 12 }, { shiftKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001', 'g00002', 'g00003', 'g00004', 'g00005', 'g00006'])

    // Alt 框选 g00001/g00002 区域（g00003 起圆边 16.5 > 14 不相交）
    pointer(canvas, 'pointerdown', { x: -4, y: -6 }, { altKey: true })
    pointer(canvas, 'pointermove', { x: 14, y: 12 }, { altKey: true })
    pointer(canvas, 'pointerup', { x: 14, y: 12 }, { altKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00003', 'g00004', 'g00005', 'g00006']) // 6 − 2 = 4

    // Alt 框选不产生移动或复制：全钻字段与数量逐位不变
    const after = getEditDoc()!.gems
    expect(after).toHaveLength(before.length)
    for (const b of before) {
      const a = after.find((g) => g.id === b.id)!
      expect(a.x).toBe(b.x)
      expect(a.y).toBe(b.y)
      expect(a.diameterMm).toBe(b.diameterMm)
    }
    view.unmount()
  })

  it('Alt 框选命中空 = 选集不变；Alt 减选可清至空集', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    setSelection(['g00001', 'g00002'])
    // 命中空区域（x > 92 末钻之外）
    pointer(canvas, 'pointerdown', { x: 70, y: -6 }, { altKey: true })
    pointer(canvas, 'pointermove', { x: 90, y: -1 }, { altKey: true })
    pointer(canvas, 'pointerup', { x: 90, y: -1 }, { altKey: true })
    await tick()
    expect(selectionIds()).toEqual(['g00001', 'g00002'])

    // 减选命中全部既有选中 → 空集
    pointer(canvas, 'pointerdown', { x: 0, y: -6 }, { altKey: true })
    pointer(canvas, 'pointermove', { x: 20, y: 12 }, { altKey: true })
    pointer(canvas, 'pointerup', { x: 20, y: 12 }, { altKey: true })
    await tick()
    expect(selectionIds()).toEqual([])
    view.unmount()
  })
})

describe('P4 框选实时命中数读数（R4.2）', () => {
  it('拖拽中计数随框扩大递增（interaction 读取面）；抬指清零', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!

    expect(getMarqueeHitCount()).toBeNull()
    pointer(canvas, 'pointerdown', { x: 0, y: -6 })
    pointer(canvas, 'pointermove', { x: 10, y: 10 })
    await tick()
    // 判据与提交同源：g00001（中心在内）+ g00002（圆边触界 10）= 2
    expect(getMarqueeHitCount()).toBe(2)
    pointer(canvas, 'pointermove', { x: 26, y: 10 })
    await tick()
    expect(getMarqueeHitCount()).toBe(4) // g00003(20)/g00004(28) 圆边触界 26/24
    pointer(canvas, 'pointerup', { x: 26, y: 10 })
    await tick()
    expect(getMarqueeHitCount()).toBeNull() // 抬指清场
    view.unmount()
  })
})
