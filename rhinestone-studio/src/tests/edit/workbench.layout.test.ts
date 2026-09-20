/*
 * [2026-09-20 C-3.1 Test] 四区布局骨架冒烟（rename-and-expert-workbench tasks 3.1）：
 * 工具栏（工具三态 + snap 两态 + 撤销/重做）/ 画布 / 属性面板（空态框架）/ 图层面板（四层控件迁入）/
 * 状态条（N 钻 + 画幅读数位占位）占位齐备；移动端右侧栏折叠（骨架期 hidden）。
 * 概念混入禁令断言：属性面板不含排钻参数（密度/策略等）——编辑器永不长参数面板。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import { loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '../../components/Edit/workbench.svelte'
import { makeHandoff } from './helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountView(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EditView, { target })
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
  loadFromHandoff(makeHandoff(12))
})

describe('四区布局骨架（tasks 3.1）', () => {
  it('工具栏：工具三态 + snap 两态 + 撤销/重做按钮齐备（⌘Z/⌘⇧Z 提示）', async () => {
    const { target, unmount } = mountView()
    await tick()

    const toolbar = target.querySelector('[data-testid="edit-toolbar"]')
    expect(toolbar).not.toBeNull()
    for (const id of ['edit-tool-select', 'edit-tool-draw', 'edit-tool-erase']) {
      expect(target.querySelector(`[data-testid="${id}"]`), id).not.toBeNull()
    }
    for (const id of ['edit-snap-grid', 'edit-snap-free']) {
      expect(target.querySelector(`[data-testid="${id}"]`), id).not.toBeNull()
    }
    const undoBtn = target.querySelector<HTMLButtonElement>('[data-testid="edit-undo"]')
    const redoBtn = target.querySelector<HTMLButtonElement>('[data-testid="edit-redo"]')
    expect(undoBtn?.title).toContain('⌘Z')
    expect(redoBtn?.title).toContain('⌘⇧Z')

    unmount()
  })

  it('四区占位：画布 / 右侧栏（属性面板 + 图层面板）/ 状态条齐备；画幅读数位占位不显假值', async () => {
    const { target, unmount } = mountView()
    await tick()

    expect(target.querySelector('[data-testid="edit-canvas"]')).not.toBeNull()
    const rail = target.querySelector('[data-testid="edit-right-rail"]')
    expect(rail).not.toBeNull()
    // 移动端折叠（骨架期 hidden + lg 常驻）
    expect(rail?.className).toContain('hidden')
    expect(rail?.className).toContain('lg:flex')
    expect(rail?.querySelector('[data-testid="edit-properties"]')).not.toBeNull()
    expect(rail?.querySelector('[data-testid="edit-layers-panel"]')).not.toBeNull()

    const status = target.querySelector('[data-testid="edit-status-bar"]')
    expect(status?.textContent).toContain('12 钻')
    const readout = target.querySelector('[data-testid="edit-canvas-readout"]')
    // [5.7 已接线] 无显式画幅 → default 锚显式合成（anchorSource:'default'），
    // 读数显 2.5px/mm 缺省值 + 「（缺省锚）」标注——不再是「未锚定」空占位
    expect(readout?.textContent).toContain('（缺省锚）')
    expect(readout?.textContent).toContain('2.5')

    unmount()
  })

  it('图层面板：[1.1 v3 演进] 钻石层行（L1）+ underlay 源行（painting/blocks；无 reference 载荷不呈现）', async () => {
    const { target, unmount } = mountView()
    await tick()

    // v3：旧固定四行 → 钻石层行（按层 id）+ 源行（按载荷可用性；'gems' 键随四层退役不再存在）
    expect(target.querySelector('[data-testid="edit-layer-visible-L1"]')).not.toBeNull()
    for (const key of ['painting', 'blocks']) {
      expect(
        target.querySelector(`[data-testid="edit-layer-visible-${key}"]`),
        key,
      ).not.toBeNull()
    }
    expect(target.querySelector('[data-testid="edit-layer-visible-reference"]')).toBeNull()
    expect(target.querySelector('[data-testid="edit-layer-visible-gems"]')).toBeNull()

    unmount()
  })

  it('属性面板空态框架：未选中引导；N 选计数位', async () => {
    const { target, unmount } = mountView()
    await tick()

    const panel = target.querySelector('[data-testid="edit-properties"]')!
    expect(panel.querySelector('[data-testid="edit-properties-empty"]')).not.toBeNull()
    expect(panel.querySelector('[data-testid="edit-properties-count"]')?.textContent).toContain('未选中')

    unmount()
  })

  it('概念混入禁令：属性面板不含排钻参数（密度/策略等管线字段）', async () => {
    const { target, unmount } = mountView()
    await tick()

    const text = target.querySelector('[data-testid="edit-properties"]')?.textContent ?? ''
    for (const banned of ['密度', '策略', 'relax', '种子', '六方抽稀']) {
      expect(text, `属性面板不得出现排钻参数「${banned}」`).not.toContain(banned)
    }

    unmount()
  })
})
