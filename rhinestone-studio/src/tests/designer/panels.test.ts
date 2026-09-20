/*
 * [2026-09-21 redesign-designer-workbench 2.x Test] 右面板列骨架（design §1.2/§4）：
 * 图层面板——钻石层行（z 序倒排展示/选当前层/显隐/锁定/上下移排序占位/新建/删除确认
 * （ConfirmDialog 公共件，含钻数文案；末层保底；层内钻随层删=单 undo 组））+
 * 参考底层钉底行（聚合眼睛 = 派生 AND、点击全开/全关；展开三源行独立眼睛/透明度）；
 * 属性面板所属图层字段（单选层名 / 跨层混合占位）。
 * 完整图层语义（拖排/合并/移入/Alt 孤立/双击重命名）归 4.x 断言面。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerLayersPanel from '../../components/Designer/DesignerLayersPanel.svelte'
import DesignerPropertiesPanel from '../../components/Designer/DesignerPropertiesPanel.svelte'
import {
  addGemLayer,
  applyPatch,
  getEditDoc,
  getUndoDepths,
  isEditDirty,
  loadFromHandoff,
  nextManualId,
  resetEditForTests,
  setSelection,
  undo,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { currentLayerIdOf, getCurrentLayerId, resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountPanel(component: typeof DesignerLayersPanel | typeof DesignerPropertiesPanel = DesignerLayersPanel): {
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

function addManualGem(layerId: string): void {
  applyPatch({
    op: 'add',
    gems: [
      {
        id: nextManualId(),
        x: 40,
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

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12))
})

describe('钻石层行（design §4：z 序倒排 + 当前层 + 显隐/锁定/排序占位）', () => {
  it('行列表 z 序倒排（上=最上层）；默认当前层兜底首层 L1（currentLayerIdOf）', async () => {
    addGemLayer()
    await tick()
    const view = mountPanel()
    await tick()

    const rows = [...view.target.querySelectorAll('[data-testid^="designer-layer-row-"]')]
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'designer-layer-row-L2',
      'designer-layer-row-L1',
    ])
    // 未显式选层：当前层兜底首层（z 序最底 = L1）
    expect(currentLayerIdOf(getEditDoc())).toBe('L1')
    expect(rows[1].getAttribute('data-current')).toBe('true')

    view.unmount()
  })

  it('点层名设当前层：workbench 真源 + 行高亮联动', async () => {
    addGemLayer()
    const view = mountPanel()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-name-L2"]')!.click()
    await tick()
    expect(getCurrentLayerId()).toBe('L2')
    expect(currentLayerIdOf(getEditDoc())).toBe('L2')
    expect(view.target.querySelector('[data-testid="designer-layer-row-L2"]')?.getAttribute('data-current')).toBe('true')
    expect(view.target.querySelector('[data-testid="designer-layer-row-L1"]')?.getAttribute('data-current')).toBe('false')

    view.unmount()
  })

  it('显隐/锁定切换：store 层记录随动 + dirty（文档态字段）', async () => {
    const view = mountPanel()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-visible-L1"]')!.click()
    await tick()
    expect(getEditDoc()!.layers[0].visible).toBe(false)

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-lock-L1"]')!.click()
    await tick()
    expect(getEditDoc()!.layers[0].locked).toBe(true)
    expect(isEditDirty()).toBe(true)

    view.unmount()
  })

  it('z 序上下移（排序占位）：数组序 op 单组可撤销；边界（顶/底）无效', async () => {
    addGemLayer()
    const view = mountPanel()
    await tick()

    // L2 上移（已是顶部，z 序末位=最上）无效；L1 上移一位 → 数组序 [L2, L1] → [L1, L2]
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-up-L2"]')!.click()
    await tick()
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L1', 'L2'])

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-up-L1"]')!.click()
    await tick()
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L2', 'L1'])
    expect(getUndoDepths().undo).toBe(2) // 新建层（结构 op）+ 上移（数组序 op）各一组

    undo()
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L1', 'L2'])

    view.unmount()
  })
})

describe('新建 / 删除（ConfirmDialog 公共件 + 末层保底）', () => {
  it('新建层：行数 +1，递增命名「图层 N」，落 z 序最上', async () => {
    const view = mountPanel()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-new"]')!.click()
    await tick()
    const doc = getEditDoc()!
    expect(doc.layers).toHaveLength(2)
    expect(doc.layers[1]).toMatchObject({ id: 'L2', name: '图层 2', visible: true, locked: false })

    view.unmount()
  })

  it('删除确认流：弹窗含钻数文案；取消零变化；确认层+层内钻同删且单 undo 组恢复', async () => {
    addGemLayer()
    addManualGem('L2')
    const view = mountPanel()
    await tick()
    expect(getEditDoc()!.gems).toHaveLength(13)

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-delete-L2"]')!.click()
    await tick()
    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-testid="designer-layer-delete-confirm"]')
    expect(confirmBtn).not.toBeNull()
    expect(document.body.textContent).toContain('该图层含 1 颗钻')

    // 取消：零变化
    document.querySelector<HTMLButtonElement>('[data-testid="designer-layer-delete-cancel"]')!.click()
    await tick()
    expect(getEditDoc()!.layers).toHaveLength(2)
    expect(getEditDoc()!.gems).toHaveLength(13)

    // 确认：层 + 层内钻同删（remove + layers 双 patch = 单 undo 组；前置造档两组在其下）
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-delete-L2"]')!.click()
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="designer-layer-delete-confirm"]')!.click()
    await tick()
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L1'])
    expect(getEditDoc()!.gems).toHaveLength(12)
    expect(getUndoDepths().undo).toBe(3) // 新建层 + 落钻 + 删除层（删除本身单组）

    undo()
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L1', 'L2'])
    expect(getEditDoc()!.gems).toHaveLength(13)

    view.unmount()
  })

  it('末层保底：单层时删除按钮禁用', async () => {
    const view = mountPanel()
    await tick()

    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-layer-delete-L1"]')?.disabled).toBe(true)

    view.unmount()
  })
})

describe('参考底层钉底行（design §4.2：聚合眼睛派生 AND + 三源独立态）', () => {
  it('聚合眼睛 = 各源 visible 之 AND；点击全关/全开（批量写源级 visible）', async () => {
    const view = mountPanel()
    await tick()

    const aggregate = view.target.querySelector<HTMLButtonElement>('[data-testid="designer-underlay-visible"]')!
    expect(aggregate.getAttribute('aria-pressed')).toBe('true') // painting + blocks 均可见

    aggregate.click()
    await tick()
    const doc = getEditDoc()!
    expect(doc.underlay.sources.every((s) => s.visible)).toBe(false)
    expect(aggregate.getAttribute('aria-pressed')).toBe('false')

    aggregate.click()
    await tick()
    expect(getEditDoc()!.underlay.sources.every((s) => s.visible)).toBe(true)

    view.unmount()
  })

  it('展开三源行：每源独立眼睛 + 透明度滑杆（源级态，R1-P0-3）', async () => {
    const view = mountPanel()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-underlay-expand"]')!.click()
    await tick()
    // makeHandoff 载荷：painting + blocks 两源（无 reference 资产不呈现）
    expect(view.target.querySelector('[data-testid="designer-underlay-source-painting"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-underlay-source-blocks"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-underlay-source-reference"]')).toBeNull()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-underlay-source-visible-painting"]')!.click()
    await tick()
    const painting = getEditDoc()!.underlay.sources.find((s) => s.key === 'painting')!
    expect(painting.visible).toBe(false)
    // 单源隐藏 → 聚合眼睛熄灭
    expect(view.target.querySelector('[data-testid="designer-underlay-visible"]')?.getAttribute('aria-pressed')).toBe('false')

    view.unmount()
  })
})

describe('属性面板所属图层字段（properties 注册表扩展）', () => {
  it('单选显示层名；跨层双选显示「—（跨层）」混合占位', async () => {
    addGemLayer()
    addManualGem('L2')
    const view = mountPanel(DesignerPropertiesPanel)
    await tick()

    setSelection(['g00001'])
    await tick()
    expect(view.target.querySelector('[data-testid="designer-prop-layerId"]')?.textContent).toContain('图层 1')

    setSelection(['g00001', 'm-1'])
    await tick()
    const layerField = view.target.querySelector('[data-testid="designer-prop-layerId"]')!
    expect(layerField.querySelector('[data-mixed]')?.getAttribute('data-mixed')).toBe('true')
    expect(layerField.textContent).toContain('跨层')

    view.unmount()
  })
})
