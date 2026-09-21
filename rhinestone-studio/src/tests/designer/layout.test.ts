/*
 * [2026-09-21 redesign-designer-workbench 2.x Test] 四区布局骨架（design §1.1/§1.2）：
 * 竖排工具栏（五工具 V/B/E/H/Z + 吸附开关 + tooltip 键位标注 + 当前工具高亮 + 无文档禁用）、
 * 四区 testid 齐备（文档栏/工具栏/画布/右面板列/状态栏）、工具切换键位（纯函数 + 视图接线）、
 * 空态引导（无文档不渲染四区）、状态栏读数、右面板列断点类（hidden + lg 常驻）。
 * 概念混入禁令断言（沿 workbench.layout 语义迁移）：属性面板不含排钻参数。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import DesignerToolbar from '../../components/Designer/DesignerToolbar.svelte'
import { loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { getTool, resetWorkbenchForTests, setBrushSpec, setTool } from '$lib/designer/workbench.svelte'
import { handleToolKeydown, TOOL_KEY_BINDINGS } from '$lib/designer/keymap'
import { getViewState, resetViewportForTests, setViewState } from '$lib/designer/viewport.svelte'
import DesignerStatusBar from '../../components/Designer/DesignerStatusBar.svelte'
import { setGemLayerVisible } from '$lib/stores/edit.svelte'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountView(
  component: typeof DesignerView | typeof DesignerToolbar | typeof DesignerStatusBar = DesignerView,
): {
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

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetViewportForTests()
  resetToastsForTests()
})

describe('竖排工具栏（design §1.2 五工具 + 吸附开关）', () => {
  it('五工具齐备：tooltip 标注快捷键（选择 (V)…缩放 (Z)）+ 吸附两态', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountView(DesignerToolbar)
    await tick()

    const bar = view.target.querySelector('[data-testid="designer-toolbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-orientation')).toBe('vertical')
    const expected: Array<{ id: string; label: string; key: string }> = [
      { id: 'select', label: '选择', key: 'V' },
      { id: 'draw', label: '画笔', key: 'B' },
      { id: 'erase', label: '橡皮', key: 'E' },
      { id: 'hand', label: '抓手', key: 'H' },
      { id: 'zoom', label: '缩放', key: 'Z' },
    ]
    for (const t of expected) {
      const btn = view.target.querySelector<HTMLButtonElement>(`[data-testid="designer-tool-${t.id}"]`)
      expect(btn, t.id).not.toBeNull()
      expect(btn?.title).toBe(`${t.label} (${t.key})`)
    }
    expect(view.target.querySelector('[data-testid="designer-snap-grid"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-snap-free"]')).not.toBeNull()

    view.unmount()
  })

  it('当前工具高亮（aria-pressed）：点击切换 + 状态随 workbench 真源联动', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountView(DesignerToolbar)
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-tool-draw"]')!.click()
    await tick()
    expect(getTool()).toBe('draw')
    expect(view.target.querySelector('[data-testid="designer-tool-draw"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(view.target.querySelector('[data-testid="designer-tool-select"]')?.getAttribute('aria-pressed')).toBe('false')

    // 真源直写（键位通道）→ 按钮高亮联动
    setTool('hand')
    await tick()
    expect(view.target.querySelector('[data-testid="designer-tool-hand"]')?.getAttribute('aria-pressed')).toBe('true')

    view.unmount()
  })

  it('无文档禁用态：工具与吸附全禁用', async () => {
    const view = mountView(DesignerToolbar)
    await tick()

    for (const id of ['select', 'draw', 'erase', 'hand', 'zoom']) {
      expect(view.target.querySelector<HTMLButtonElement>(`[data-testid="designer-tool-${id}"]`)?.disabled, id).toBe(true)
    }
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-snap-grid"]')?.disabled).toBe(true)
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-snap-free"]')?.disabled).toBe(true)

    view.unmount()
  })
})

describe('工具切换键位（design §3.1：V/B/E/H/Z）', () => {
  const ctx = { hasDocument: () => true, setTool }

  it('键位矩阵：五键各达对应工具；命中 preventDefault', () => {
    for (const binding of TOOL_KEY_BINDINGS) {
      const event = new KeyboardEvent('keydown', { key: binding.key, cancelable: true })
      const handled = handleToolKeydown(event, ctx)
      expect(handled, binding.key).toBe(true)
      expect(event.defaultPrevented).toBe(true)
      expect(getTool()).toBe(binding.tool)
    }
  })

  it('大写/修饰键/表单聚焦/无文档放行（不切换）', () => {
    resetWorkbenchForTests()
    setTool('select')
    // 修饰键（⌘/Ctrl/Alt/Shift）不切工具
    for (const mods of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { key: 'b', cancelable: true, ...mods })
      expect(handleToolKeydown(event, ctx)).toBe(false)
    }
    expect(getTool()).toBe('select')
    // 表单聚焦放行
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const inForm = new KeyboardEvent('keydown', { key: 'b', cancelable: true })
    Object.defineProperty(inForm, 'target', { value: input })
    expect(handleToolKeydown(inForm, ctx)).toBe(false)
    input.remove()
    // 无文档放行
    const noDoc = new KeyboardEvent('keydown', { key: 'b', cancelable: true })
    expect(handleToolKeydown(noDoc, { hasDocument: () => false, setTool })).toBe(false)
    expect(getTool()).toBe('select')
  })

  it('视图接线：窗口 keydown B → 画笔（高亮联动）；V 还原选择', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountView()
    await tick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
    await tick()
    expect(getTool()).toBe('draw')
    expect(view.target.querySelector('[data-testid="designer-tool-draw"]')?.getAttribute('aria-pressed')).toBe('true')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }))
    await tick()
    expect(getTool()).toBe('select')

    view.unmount()
  })
})

describe('底部状态栏读数（design §1.2：画幅 popover/缩放比/含隐藏钻数/规格码）', () => {
  it('缩放比 = viewport 真源派生（视口写者唯一=画布）', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountView(DesignerStatusBar)
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-zoom"]')?.textContent).toBe('100%')

    setViewState({ scale: 2.5, x: 0, y: 0 })
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-zoom"]')?.textContent).toBe('250%')
    expect(getViewState().scale).toBe(2.5)

    view.unmount()
  })

  it('钻数含隐藏口径：隐藏层钻计入「含 N 隐藏」，总量保持', async () => {
    loadFromHandoff(makeHandoff(12))
    setGemLayerVisible('L1', false)
    const view = mountView(DesignerStatusBar)
    await tick()

    const total = view.target.querySelector('[data-testid="designer-status-total"]')
    expect(total?.textContent).toContain('12 钻')
    expect(view.target.querySelector('[data-testid="designer-status-hidden"]')?.textContent).toContain('含 12 隐藏')

    setGemLayerVisible('L1', true)
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-hidden"]')).toBeNull()

    view.unmount()
  })

  it('当前规格码：文档基准派生 R10（SS10 圆钻）；brushSpec 覆盖 SQ3.5', async () => {
    loadFromHandoff(makeHandoff(12))
    const view = mountView(DesignerStatusBar)
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-spec"]')?.textContent).toBe('R10')

    setBrushSpec({ shapeId: 'square', diameterMm: 3.5, colorId: 'red' })
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-spec"]')?.textContent).toBe('SQ3.5')

    view.unmount()
  })

  it('画幅 popover：点击读数弹详情（宽/高 mm + px/mm + 锚来源——本切片只读）', async () => {
    loadFromHandoff(makeHandoff(12, { physicalCanvas: { widthMm: 210, heightMm: 297, anchorSource: 'declared' } }))
    const view = mountView(DesignerStatusBar)
    await tick()
    expect(view.target.querySelector('[data-testid="designer-canvas-popover"]')).toBeNull()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-canvas-readout"]')!.click()
    await tick()
    const popover = view.target.querySelector('[data-testid="designer-canvas-popover"]')
    expect(popover).not.toBeNull()
    expect(popover?.textContent).toContain('210')
    expect(popover?.textContent).toContain('297')
    expect(popover?.textContent).toContain('声明锚')

    view.unmount()
  })
})

describe('移动端降级（design §1.4：底部工具条 + 抽屉面板；断点类断言）', () => {
  beforeEach(() => {
    loadFromHandoff(makeHandoff(12))
  })

  it('底部工具条（lg:hidden）：选择/画笔/橡皮 + 撤销/重做 + 吸附开关；抓手/缩放不占位', async () => {
    const view = mountView()
    await tick()

    const bar = view.target.querySelector('[data-testid="designer-mobile-toolbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.className).toContain('lg:hidden')
    for (const id of ['select', 'draw', 'erase']) {
      expect(bar?.querySelector(`[data-testid="designer-mobile-tool-${id}"]`), id).not.toBeNull()
    }
    // 抓手/缩放不占位（触摸直接双指手势）
    expect(bar?.querySelector('[data-testid="designer-mobile-tool-hand"]')).toBeNull()
    expect(bar?.querySelector('[data-testid="designer-mobile-tool-zoom"]')).toBeNull()
    expect(bar?.querySelector('[data-testid="designer-mobile-undo"]')?.getAttribute('title')).toContain('⌘Z')
    expect(bar?.querySelector('[data-testid="designer-mobile-redo"]')?.getAttribute('title')).toContain('⌘⇧Z')
    expect(bar?.querySelector('[data-testid="designer-mobile-snap"]')).not.toBeNull()

    // 桌面竖排工具栏 hidden lg:flex（与移动条互补）
    const vertical = view.target.querySelector('[data-testid="designer-toolbar"]')
    expect(vertical?.parentElement?.className).toContain('hidden')
    expect(vertical?.parentElement?.className).toContain('lg:flex')

    view.unmount()
  })

  it('移动工具条与竖排工具栏同一真源：点击画笔双处高亮', async () => {
    const view = mountView()
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-mobile-tool-draw"]')!.click()
    await tick()
    expect(getTool()).toBe('draw')
    expect(view.target.querySelector('[data-testid="designer-mobile-tool-draw"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(view.target.querySelector('[data-testid="designer-tool-draw"]')?.getAttribute('aria-pressed')).toBe('true')

    view.unmount()
  })

  it('抽屉：面板入口开底部抽屉（lg:hidden），属性/图层分段切换，收起关闭', async () => {
    const view = mountView()
    await tick()

    expect(view.target.querySelector('[data-testid="designer-drawer"]')).toBeNull()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-drawer-toggle"]')!.click()
    await tick()

    const drawer = view.target.querySelector('[data-testid="designer-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer?.className).toContain('lg:hidden')
    expect(drawer?.querySelector('[data-testid="designer-drawer-tab-properties"]')).not.toBeNull()
    expect(drawer?.querySelector('[data-testid="designer-drawer-tab-layers"]')).not.toBeNull()
    // 默认图层页（入口语义沿旧「图层」入口）
    expect(drawer?.querySelector('[data-testid="designer-layers-panel"]')).not.toBeNull()
    expect(drawer?.querySelector('[data-testid="designer-properties"]')).toBeNull()

    // 分段切属性
    drawer?.querySelector<HTMLButtonElement>('[data-testid="designer-drawer-tab-properties"]')!.click()
    await tick()
    expect(drawer?.querySelector('[data-testid="designer-properties"]')).not.toBeNull()

    // 收起
    drawer?.querySelector<HTMLButtonElement>('[data-testid="designer-drawer-close"]')!.click()
    await tick()
    expect(view.target.querySelector('[data-testid="designer-drawer"]')).toBeNull()

    view.unmount()
  })
})

describe('四区结构（design §1.1 桌面布局）', () => {
  beforeEach(() => {
    loadFromHandoff(makeHandoff(12))
  })

  it('四区 testid 齐备：文档栏 / 竖排工具栏 / 画布 / 右面板列 / 状态栏', async () => {
    const view = mountView()
    await tick()

    expect(view.target.querySelector('[data-testid="designer-workbench"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-doc-bar"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-toolbar"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-canvas"]')).not.toBeNull()

    // 右面板列：桌面常驻 + 移动折叠（hidden + lg:flex——断点类）
    const rail = view.target.querySelector('[data-testid="designer-right-rail"]')
    expect(rail).not.toBeNull()
    expect(rail?.className).toContain('hidden')
    expect(rail?.className).toContain('lg:flex')

    expect(view.target.querySelector('[data-testid="designer-status-bar"]')).not.toBeNull()

    view.unmount()
  })

  it('状态栏读数：钻数总量 + 画幅缺省锚（真值 doc.physicalCanvas）', async () => {
    const view = mountView()
    await tick()

    const status = view.target.querySelector('[data-testid="designer-status-bar"]')
    expect(status?.textContent).toContain('12 钻')
    expect(status?.textContent).toContain('缺省锚')
    expect(status?.textContent).toContain('2.5')

    view.unmount()
  })

  it('顶部文档栏：未保存徽标 + 撤销/重做（⌘Z/⌘⇧Z 提示）+ 无智能排布入口（R1 退役）', async () => {
    const view = mountView()
    await tick()

    expect(view.target.querySelector('[data-testid="designer-doc-name"]')?.textContent).toContain('精修')
    expect(view.target.querySelector('[data-testid="designer-dirty-badge"]')).not.toBeNull()
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-undo"]')?.title).toContain('⌘Z')
    expect(view.target.querySelector<HTMLButtonElement>('[data-testid="designer-redo"]')?.title).toContain('⌘⇧Z')
    // [rework R1] 智能排布入口退役（Owner 2026-09-21：应基于选区=路径编辑，归 add-designer-selection-paths）
    expect(view.target.querySelector('[data-testid="designer-smart-layout"]')).toBeNull()

    view.unmount()
  })

  it('空态：无文档不渲染四区（空态引导页——三入口重设计归 5.x）', async () => {
    resetEditForTests() // 本组 beforeEach 装载了文档——空态用例显式清空
    const view = mountView()
    await tick()

    expect(view.target.querySelector('[data-testid="designer-empty"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-toolbar"]')).toBeNull()
    expect(view.target.querySelector('[data-testid="designer-canvas"]')).toBeNull()

    view.unmount()
  })

  it('概念混入禁令：属性面板不含排钻参数（密度/策略等）', async () => {
    const view = mountView()
    await tick()

    const text = view.target.querySelector('[data-testid="designer-right-rail"]')?.textContent ?? ''
    for (const banned of ['密度', '策略', 'relax', '种子', '六方抽稀']) {
      expect(text, `属性面板不得出现排钻参数「${banned}」`).not.toContain(banned)
    }

    view.unmount()
  })
})
