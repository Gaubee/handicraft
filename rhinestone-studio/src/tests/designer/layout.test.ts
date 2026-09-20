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
import { getTool, resetWorkbenchForTests, setTool } from '$lib/designer/workbench.svelte'
import { handleToolKeydown, TOOL_KEY_BINDINGS } from '$lib/designer/keymap'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountView(component: typeof DesignerView | typeof DesignerToolbar = DesignerView): {
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

  it('顶部文档栏：未保存徽标 + 撤销/重做（⌘Z/⌘⇧Z 提示）+ 智能排布命令位（有参考底图可用）', async () => {
    const view = mountView()
    await tick()

    expect(view.target.querySelector('[data-testid="designer-doc-name"]')?.textContent).toContain('精修')
    expect(view.target.querySelector('[data-testid="designer-dirty-badge"]')).not.toBeNull()
    expect(view.target.querySelector('[data-testid="designer-undo"]')?.title).toContain('⌘Z')
    expect(view.target.querySelector('[data-testid="designer-redo"]')?.title).toContain('⌘⇧Z')
    const smart = view.target.querySelector<HTMLButtonElement>('[data-testid="designer-smart-layout"]')
    expect(smart).not.toBeNull()
    expect(smart?.disabled).toBe(false) // 送精修产物恒带 painting 快照 = 参考底图在

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
