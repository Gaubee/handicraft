/*
 * [2026-09-21 redesign-designer-workbench 4.1 Test] 图层面板完整功能（design §2 P15-P17/§3.5/§4.3）：
 * 双击重命名 / 向下合并（目标=下一可见未锁层；单 op；层配置冲突取目标层；当前层修复）/
 * 移入选中钻（单 op；禁用态按真实归属 + 锁定/隐藏目标禁用）/ Alt 孤立显示（其余全隐藏，
 * 再按恢复——快照存 workbench 真源）/ z 序上下移不改 gems[] 真源序纪律 /
 * underlay 三源行：独立透明度滑杆（源级态）+ 源展开详情（载荷摘要）。
 * 面板骨架面（行列表/显隐/锁定/新建/删除确认/聚合眼睛）由 2.x panels.test.ts 覆盖，不重复。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerLayersPanel from '../../components/Designer/DesignerLayersPanel.svelte'
import {
  addGemLayer,
  applyPatch,
  getEditDoc,
  getUndoDepths,
  loadFromHandoff,
  nextManualId,
  resetEditForTests,
  setGemLayerLocked,
  setGemLayerVisible,
  setSelection,
  undo,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  getCurrentLayerId,
  getIsolateSnapshot,
  resetWorkbenchForTests,
} from '$lib/designer/workbench.svelte'
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
  const app = mount(DesignerLayersPanel, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

/** 在指定层落 n 颗手工钻（错开 x 防间距违规干扰无关断言——面板面不校验，仅保持整洁）。 */
function addManualGems(layerId: string, count: number): string[] {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = nextManualId()
    ids.push(id)
    applyPatch({
      op: 'add',
      gems: [
        {
          id,
          x: 40 + i * 12,
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
  }
  return ids
}

function altClick(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12))
})

describe('重命名（P15/§3.5：双击层名 → 行内输入）', () => {
  it('双击进入输入态：Enter 提交改名 store 生效；Esc 取消保持原名', async () => {
    const view = mountPanel()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-name-L1"]')!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    )
    await tick()
    const input = view.target.querySelector<HTMLInputElement>('[data-testid="designer-layer-rename-input-L1"]')
    expect(input).not.toBeNull()

    input!.value = '描边层'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick()
    expect(getEditDoc()!.layers[0].name).toBe('描边层')
    expect(view.target.querySelector('[data-testid="designer-layer-rename-input-L1"]')).toBeNull()
    expect(view.target.querySelector('[data-testid="designer-layer-name-L1"]')?.textContent).toContain('描边层')

    // Esc 取消：双击后清空草稿按 Esc → 原名保持
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-name-L1"]')!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    )
    await tick()
    const input2 = view.target.querySelector<HTMLInputElement>('[data-testid="designer-layer-rename-input-L1"]')!
    input2.value = ''
    input2.dispatchEvent(new Event('input', { bubbles: true }))
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(getEditDoc()!.layers[0].name).toBe('描边层')

    view.unmount()
  })
})

describe('向下合并（design §4.3：目标=下一可见未锁层；单 op；配置冲突取目标层）', () => {
  it('合并入下一可见未锁层：钻归属改写 + 源层记录删除 + 一次撤销恢复全部', async () => {
    addGemLayer('上层')
    addManualGems('L2', 2)
    const view = mountPanel()
    await tick()
    const depthBefore = getUndoDepths().undo

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-merge-L2"]')!.click()
    await tick()
    const doc = getEditDoc()!
    expect(doc.layers.map((l) => l.id)).toEqual(['L1']) // 源层记录删除
    expect(doc.gems.every((g) => g.layerId === 'L1')).toBe(true) // 归属批量改写目标层
    expect(getUndoDepths().undo).toBe(depthBefore + 1) // 单 op（本操作一组）

    undo()
    const restored = getEditDoc()!
    expect(restored.layers.map((l) => l.id)).toEqual(['L1', 'L2'])
    expect(restored.layers[1].name).toBe('上层')
    expect(restored.gems.filter((g) => g.id.startsWith('m-')).every((g) => g.layerId === 'L2')).toBe(true)

    view.unmount()
  })

  it('层配置冲突取目标层：源层隐藏态随记录弃置，并入钻即刻处于目标层（可见）配置下', async () => {
    addGemLayer('隐藏源层')
    addManualGems('L2', 1)
    setGemLayerVisible('L2', false)
    const view = mountPanel()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-merge-L2"]')!.click()
    await tick()
    const doc = getEditDoc()!
    expect(doc.layers).toHaveLength(1) // 隐藏源层（配置随删除弃置）不复存
    expect(doc.layers[0]).toMatchObject({ id: 'L1', visible: true }) // 目标层配置原样
    expect(doc.gems.every((g) => g.layerId === 'L1' && doc.layers[0].visible)).toBe(true)

    view.unmount()
  })

  it('目标解析「下一可见未锁层」：跳过隐藏/锁定层；最底层无目标禁用；合并后当前层修复', async () => {
    addGemLayer() // L2（将锁定）
    addGemLayer() // L3（将隐藏）
    addGemLayer() // L4
    setGemLayerLocked('L2', true)
    setGemLayerVisible('L3', false)
    // z 序（数组序）：L1 < L2(锁) < L3(隐) < L4 —— L4 向下应跳过 L3/L2 落 L1
    const view = mountPanel()
    await tick()

    // 显式选中 L4 为当前层（合并源被删 → 当前层改指目标层，不持悬空 id）
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-name-L4"]')!.click()
    await tick()
    expect(getCurrentLayerId()).toBe('L4')

    const mergeL4 = view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-merge-L4"]')!
    expect(mergeL4.title).toContain('图层 1')
    mergeL4.click()
    await tick()
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L1', 'L2', 'L3'])
    expect(getEditDoc()!.gems.every((g) => g.layerId !== 'L4')).toBe(true)
    expect(getCurrentLayerId()).toBe('L1') // 源层=旧当前层 → 修复为目标层

    // L1（最底层，向下无层）合并按钮禁用
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-merge-L1"]')?.disabled).toBe(true)

    // L1 也锁定后：L2/L3 向下均无可见未锁目标 → 禁用
    setGemLayerLocked('L1', true)
    await tick()
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-merge-L3"]')?.disabled).toBe(true)
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-merge-L2"]')?.disabled).toBe(true)
    // 解锁 L1：L2 恢复可用（目标 L1）
    setGemLayerLocked('L1', false)
    await tick()
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-merge-L2"]')?.disabled).toBe(false)

    view.unmount()
  })
})

describe('移入选中钻（design §4.3：单 op；禁用态按真实归属 + 锁定/隐藏目标禁用）', () => {
  it('选中钻移入目标层：批量归属改写 + 一次撤销回原层；目标层钻不变', async () => {
    addGemLayer('目标层')
    addManualGems('L1', 0) // 无
    const ids = getEditDoc()!.gems.slice(0, 2).map((g) => g.id)
    setSelection(ids)
    const view = mountPanel()
    await tick()
    const depthBefore = getUndoDepths().undo

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-intake-L2"]')!.click()
    await tick()
    const doc = getEditDoc()!
    expect(doc.gems.filter((g) => ids.includes(g.id)).every((g) => g.layerId === 'L2')).toBe(true)
    expect(getUndoDepths().undo).toBe(depthBefore + 1) // 单 op

    undo()
    expect(getEditDoc()!.gems.every((g) => g.layerId === 'L1')).toBe(true)

    view.unmount()
  })

  it('禁用态按真实归属：无选中/已全在该层禁用；锁定或隐藏目标禁用', async () => {
    addGemLayer('目标层')
    const ids = getEditDoc()!.gems.slice(0, 2).map((g) => g.id)
    const view = mountPanel()
    await tick()

    const intakeL1 = () => view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-intake-L1"]')!
    const intakeL2 = () => view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-intake-L2"]')!

    // 无选中：两行皆禁用
    expect(intakeL1().disabled).toBe(true)
    expect(intakeL2().disabled).toBe(true)

    // 选中 L1 钻：L1 行（已全在该层）禁用、L2 行可用
    setSelection(ids)
    await tick()
    expect(intakeL1().disabled).toBe(true)
    expect(intakeL2().disabled).toBe(false)

    // 锁定目标 → 禁用
    setGemLayerLocked('L2', true)
    await tick()
    expect(intakeL2().disabled).toBe(true)
    setGemLayerLocked('L2', false)

    // 隐藏目标 → 禁用
    setGemLayerVisible('L2', false)
    await tick()
    expect(intakeL2().disabled).toBe(true)

    view.unmount()
  })
})

describe('Alt 孤立显示（P17：其余全隐藏，再按恢复）', () => {
  it('Alt+点眼睛 = 只显该层；孤立态再 Alt+点（任意眼睛）按快照恢复', async () => {
    addGemLayer()
    addGemLayer()
    const view = mountPanel()
    await tick()
    // 初始三层全可见
    expect(getEditDoc()!.layers.every((l) => l.visible)).toBe(true)

    altClick(view.target.querySelector('[data-testid="designer-layer-visible-L2"]')!)
    await tick()
    let doc = getEditDoc()!
    expect(doc.layers.find((l) => l.id === 'L1')?.visible).toBe(false)
    expect(doc.layers.find((l) => l.id === 'L2')?.visible).toBe(true)
    expect(doc.layers.find((l) => l.id === 'L3')?.visible).toBe(false)
    expect(getIsolateSnapshot()).toEqual({ L1: true, L2: true, L3: true }) // 快照存 workbench 真源
    expect(view.target.querySelector('[data-testid="designer-layers-panel"]')?.getAttribute('data-isolating')).toBe('true')

    // 孤立态再 Alt+点另一层的眼睛 = 按快照恢复全部
    altClick(view.target.querySelector('[data-testid="designer-layer-visible-L3"]')!)
    await tick()
    doc = getEditDoc()!
    expect(doc.layers.every((l) => l.visible)).toBe(true)
    expect(getIsolateSnapshot()).toBeNull()
    expect(view.target.querySelector('[data-testid="designer-layers-panel"]')?.getAttribute('data-isolating')).toBe('false')

    view.unmount()
  })

  it('孤立前各层异态：快照按原值恢复（含本就隐藏的层保持隐藏）', async () => {
    addGemLayer()
    setGemLayerVisible('L1', false) // L1 本就隐藏
    const view = mountPanel()
    await tick()

    altClick(view.target.querySelector('[data-testid="designer-layer-visible-L2"]')!)
    await tick()
    expect(getEditDoc()!.layers.map((l) => l.visible)).toEqual([false, true])

    altClick(view.target.querySelector('[data-testid="designer-layer-visible-L2"]')!)
    await tick()
    expect(getEditDoc()!.layers.map((l) => l.visible)).toEqual([false, true]) // 恢复 = 回孤立前态

    view.unmount()
  })

  it('普通点击眼睛不触发孤立（无 Alt）', async () => {
    const view = mountPanel()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-visible-L1"]')!.click()
    await tick()
    expect(getEditDoc()!.layers[0].visible).toBe(false)
    expect(getIsolateSnapshot()).toBeNull()

    view.unmount()
  })
})

describe('z 序排序纪律（P16：层序不影响真源序）', () => {
  it('上下移只改 layers 数组序：gems[] 顺序与归属不变；undo 恢复层序', async () => {
    addGemLayer()
    const gemsBefore = getEditDoc()!.gems.map((g) => g.id).join(',')
    const view = mountPanel()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-up-L1"]')!.click()
    await tick()
    const doc = getEditDoc()!
    expect(doc.layers.map((l) => l.id)).toEqual(['L2', 'L1'])
    expect(doc.gems.map((g) => g.id).join(',')).toBe(gemsBefore) // 真源序稳定

    undo()
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L1', 'L2'])

    view.unmount()
  })
})

describe('参考底层三源行（§4.2/R1-P0-3：源级独立透明度滑杆 + 源展开详情）', () => {
  it('源级透明度滑杆：拖动写源 opacity（jsdom 经 thumb 键盘驱动）；层滑杆互不串扰', async () => {
    const view = mountPanel()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-underlay-expand"]')!.click()
    await tick()

    const paintingRow = view.target.querySelector('[data-testid="designer-underlay-source-painting"]')!
    const blocksBefore = getEditDoc()!.underlay.sources.find((s) => s.key === 'blocks')!.opacity
    const thumb = paintingRow.querySelector('[data-slot="slider-thumb"]')
    expect(thumb).not.toBeNull()
    thumb!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    await tick()

    const painting = getEditDoc()!.underlay.sources.find((s) => s.key === 'painting')!
    expect(painting.opacity).toBeCloseTo(0.01) // 下界 0.01（值域 (0,1] 与序列化同口径）
    const blocks = getEditDoc()!.underlay.sources.find((s) => s.key === 'blocks')!
    expect(blocks.opacity).toBe(blocksBefore) // 他源不受串扰（缺省 0.9 保持原值）

    view.unmount()
  })

  it('源展开详情：每源独立展开载荷摘要（快照尺寸/资产/描线块数）', async () => {
    const view = mountPanel()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-underlay-expand"]')!.click()
    await tick()

    // 未展开：无详情
    expect(view.target.querySelector('[data-testid="designer-underlay-source-detail-painting"]')).toBeNull()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-underlay-source-expand-painting"]')!.click()
    await tick()
    const detail = view.target.querySelector('[data-testid="designer-underlay-source-detail-painting"]')
    expect(detail?.textContent).toContain('64×64px') // makeHandoff 快照 64×64

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-underlay-source-expand-blocks"]')!.click()
    await tick()
    expect(view.target.querySelector('[data-testid="designer-underlay-source-detail-blocks"]')?.textContent).toContain('1 块')

    view.unmount()
  })
})

// ---------------------------------------------------------------------------
// [R5.2 走查 P2-5] 图层2 重命名流程后消失疑点：jsdom 复现尝试（自动化时序——重命名
// 编辑中blur/Enter/Esc/切层/合并连发）。不可复现则走查注记留 9.3（真浏览器复核）。
// ---------------------------------------------------------------------------

describe('重命名时序竞态排查（P2-5 复现尝试）', () => {
  it('新建图层2 → 重命名流程（blur/Enter/Esc/切层连发）：层数不变、行内输入零残留', async () => {
    const view = mountPanel()
    await tick()
    const before = getEditDoc()!.layers.length
    const layer2 = addGemLayer()
    expect(layer2).not.toBeNull()
    await tick()
    expect(getEditDoc()!.layers).toHaveLength(before + 1)

    // 双击进入重命名 → 逐字符输入（automation 高频 input）→ 点击面板外（blur 提交）
    const nameBtn = view.target.querySelector<HTMLButtonElement>(`[data-testid="designer-layer-name-${layer2}"]`)!
    nameBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await tick()
    const input = view.target.querySelector<HTMLInputElement>(`[data-testid="designer-layer-rename-input-${layer2}"]`)
    expect(input).not.toBeNull()
    let draft = ''
    for (const ch of '测试层') {
      draft += ch
      input!.value = draft
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    }
    input!.dispatchEvent(new FocusEvent('blur')) // 外点（自动化点击画布/其他区域）
    await tick()
    expect(getEditDoc()!.layers.find((l) => l.id === layer2)?.name).toBe('测试层')
    expect(getEditDoc()!.layers).toHaveLength(before + 1) // 层未消失
    expect(view.target.querySelector(`[data-testid="designer-layer-rename-input-${layer2}"]`)).toBeNull()

    // 连发竞态：双击 A 层 → 未提交即双击 B 层（切编辑目标）→ Enter → Esc → blur
    const l1 = getEditDoc()!.layers[0].id
    view.target.querySelector<HTMLButtonElement>(`[data-testid="designer-layer-name-${l1}"]`)!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    )
    await tick()
    view.target.querySelector<HTMLButtonElement>(`[data-testid="designer-layer-name-${layer2}"]`)!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    )
    await tick()
    const switched = view.target.querySelector<HTMLInputElement>(`[data-testid="designer-layer-rename-input-${layer2}"]`)
    expect(switched).not.toBeNull() // 编辑目标切换到 B
    switched!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    switched!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    switched!.dispatchEvent(new FocusEvent('blur'))
    await tick()
    expect(getEditDoc()!.layers).toHaveLength(before + 1) // 层未消失
    expect(getEditDoc()!.layers.find((l) => l.id === layer2)?.name).toBe('测试层') // 名未被竞态破坏
    // 行内输入零残留（走查「零尺寸输入框残留」面）
    expect(view.target.querySelector('[data-testid^="designer-layer-rename-input-"]')).toBeNull()

    view.unmount()
  })
})
