/*
 * [rework-workbench-rail-drawers 1.3/2.1/2.3] PS 式轨道 Drawer 组件 jsdom 聚焦测试：
 *   [A] rail 骨架——左右 rail 在场+三 toggle testid；画布工具条自 Stage 外提
 *       （workbench-canvas-toolbar 退役，工具按钮在左 rail 内）；
 *   [B] Drawer 开合——点击图层 toggle→左 Drawer data-open 翻转（内容常驻 DOM——
 *       jsdom 无布局/ResizeObserver 桩空操作=恒窄档：缺省全收起，可手动展开）；
 *   [C] 右侧互斥——属性/历史同侧至多一开；
 *   [D] 命令总线不回归——rail 工具按钮（V/H/Z 语义位/笔刷）点击仍走 commands.ts
 *       单源（工具状态真源在 store/canvasStage）；
 *   [E] 快捷键帮助经 rail（help.toggle 同一总线）+紧凑态摘要条在场（摘要+空态引导）。
 * 挂载模式沿 workbench.v3.test.ts 先例（MockAgentApi speed=0）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  getBrushSession,
  resetWorkbenchForTests,
  selectNode,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { getWorkbenchTool, resetCanvasStageForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountView<P extends Record<string, unknown>>(component: Component<P>, props: Partial<P> = {}): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const instance = mount(component, { target, props: props as P })
  mountedDisposers.push(() => {
    unmount(instance)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

function q(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector)
}

function qq(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
}

function click(selector: string): void {
  const el = q(selector)
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

/** Drawer 生效开合（jsdom 无布局——断言 data-open 语义位，不做视觉断言）。 */
function drawerOpen(testid: string): boolean {
  return q(`[data-testid="${testid}"]`)?.getAttribute('data-open') === 'true'
}

beforeEach(() => {
  resetAgentStoreForTests()
  initAgentStore()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  resetViewForTests('studio')
  resetWorkbenchForTests()
  resetCanvasStageForTests()
  resetToastsForTests()
  document.body.innerHTML = ''
})

afterEach(() => {
  mountedDisposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------- [A] rail 骨架

describe('rail 骨架（左=画布工具+图层；右=属性/历史/帮助）', () => {
  it('左右 rail 在场+三 toggle testid；画布工具条退役（工具按钮迁入左 rail）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(q('[data-testid="workbench-rail-left"]')).not.toBeNull()
    expect(q('[data-testid="workbench-rail-right"]')).not.toBeNull()
    expect(q('[data-testid="rail-layers-toggle"]')).not.toBeNull()
    expect(q('[data-testid="rail-inspector-toggle"]')).not.toBeNull()
    expect(q('[data-testid="rail-history-toggle"]')).not.toBeNull()
    expect(q('[data-testid="rail-help-toggle"]')).not.toBeNull()

    // Stage 内工具条退役；工具按钮（含缩放档位）在左 rail 内承载
    expect(q('[data-testid="workbench-canvas-toolbar"]')).toBeNull()
    const rail = q('[data-testid="workbench-rail-left"]')!
    for (const id of ['workbench-tool-select', 'workbench-tool-hand', 'workbench-tool-zoom', 'workbench-brush-toggle', 'workbench-zoom-out', 'workbench-zoom-in', 'workbench-zoom-fit', 'workbench-zoom-100', 'workbench-zoom-readout']) {
      expect(rail.querySelector(`[data-testid="${id}"]`), `${id} 应在左 rail 内`).not.toBeNull()
    }
    // 画布本体不受工具条外提影响
    expect(q('[data-testid="workbench-canvas-stage"]')).not.toBeNull()
    expect(q('[data-testid="workbench-layer-stage"]')).not.toBeNull()
  })

  it('rail 按钮 tooltip（title）与 aria-pressed 语义位在场', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(q('[data-testid="rail-layers-toggle"]')?.getAttribute('title')).toContain('图层')
    expect(q('[data-testid="rail-inspector-toggle"]')?.getAttribute('title')).toContain('属性')
    expect(q('[data-testid="rail-history-toggle"]')?.getAttribute('title')).toContain('历史')
    // 缺省全收起（jsdom 窄档）→ toggle 均 aria-pressed=false
    expect(q('[data-testid="rail-layers-toggle"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(q('[data-testid="rail-inspector-toggle"]')?.getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------- [B] Drawer 开合

describe('Drawer 开合（窄档缺省收起+手动展开；内容常驻 DOM）', () => {
  it('缺省（窄档）三 Drawer 收起；面板内容常驻 DOM（开合=类切换非卸载）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(drawerOpen('workbench-layer-slot')).toBe(false)
    expect(drawerOpen('workbench-inspector-slot')).toBe(false)
    expect(drawerOpen('workbench-history-slot')).toBe(false)
    // 内容挂载（WorkbenchLayerPanel/Inspector/HistoryDock 根 testid）
    expect(q('[data-testid="workbench-layer-panel"]')).not.toBeNull()
    expect(q('[data-testid="workbench-inspector"]')).not.toBeNull()
    expect(q('[data-testid="workbench-tree-history"]')).not.toBeNull()
  })

  it('点击图层 toggle→左 Drawer 开（aria-pressed=true）→再点收起', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="rail-layers-toggle"]')
    await flush()
    expect(drawerOpen('workbench-layer-slot')).toBe(true)
    expect(q('[data-testid="rail-layers-toggle"]')?.getAttribute('aria-pressed')).toBe('true')

    click('[data-testid="rail-layers-toggle"]')
    await flush()
    expect(drawerOpen('workbench-layer-slot')).toBe(false)
    expect(q('[data-testid="rail-layers-toggle"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('收起态 Drawer 语义类（invisible+pointer-events-none——非模态门），开态复位', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    const closed = q('[data-testid="workbench-layer-slot"]')!
    expect(closed.className).toContain('invisible')
    expect(closed.className).toContain('pointer-events-none')
    expect(closed.className).toContain('-translate-x-full')
    expect(closed.className).toContain('backdrop-blur-md')

    click('[data-testid="rail-layers-toggle"]')
    await flush()
    const opened = q('[data-testid="workbench-layer-slot"]')!
    expect(opened.className).not.toContain('invisible')
    expect(opened.className).not.toContain('pointer-events-none')
    expect(opened.className).toContain('translate-x-0')
  })

  it('[w19-critic P2] 历史 Drawer 开面即时间线在场（不再要求二次点击 dock 内展开）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // fixture 任务 journey 基线版预置——计数徽标常显。
    await waitUntil(() => (q('[data-testid="workbench-tree-history-count"]')?.textContent ?? '').match(/\d+ 版/) !== null)
    // 抽屉未开：dock 体不在场（此前面板内部 open 缺省 false——抽屉打开也只见计数行，
    // 时间线体要再点一次 dock 标题才出现=「5 版列表渲染空」体感）。
    expect(q('[data-testid="workbench-tree-history-body"]')).toBeNull()

    click('[data-testid="rail-history-toggle"]')
    await waitUntil(() => drawerOpen('workbench-history-slot'))
    // 抽屉开=时间线体直接在场+行渲染（外控 open 并集——无二次点击）。
    await waitUntil(() => qq('[data-testid="workbench-tree-history-row"]').length > 0)
    expect(q('[data-testid="workbench-tree-history-toggle"]')?.getAttribute('aria-expanded')).toBe('true')

    // dock 标题行走外控（收抽屉——体随之退场，不产生「抽屉开+体收起」的中间态）。
    click('[data-testid="workbench-tree-history-toggle"]')
    await flush()
    expect(drawerOpen('workbench-history-slot')).toBe(false)
    expect(q('[data-testid="workbench-tree-history-body"]')).toBeNull()
  })
})

// ---------------------------------------------------------------- [C] 右侧互斥

describe('右侧互斥（属性/历史同侧至多一开）', () => {
  it('开属性→再开历史=属性收；反向同理', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="rail-inspector-toggle"]')
    await flush()
    expect(drawerOpen('workbench-inspector-slot')).toBe(true)
    expect(drawerOpen('workbench-history-slot')).toBe(false)

    click('[data-testid="rail-history-toggle"]')
    await flush()
    expect(drawerOpen('workbench-history-slot')).toBe(true)
    expect(drawerOpen('workbench-inspector-slot')).toBe(false)
    expect(q('[data-testid="rail-inspector-toggle"]')?.getAttribute('aria-pressed')).toBe('false')

    click('[data-testid="rail-inspector-toggle"]')
    await flush()
    expect(drawerOpen('workbench-inspector-slot')).toBe(true)
    expect(drawerOpen('workbench-history-slot')).toBe(false)
  })

  it('左缘开合不影响右缘（互斥仅在右侧组内）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="rail-inspector-toggle"]')
    await flush()
    click('[data-testid="rail-layers-toggle"]')
    await flush()
    expect(drawerOpen('workbench-layer-slot')).toBe(true)
    expect(drawerOpen('workbench-inspector-slot')).toBe(true)
  })

  it('⋯ 菜单历史入口与 rail 同一状态源（开历史=属性收）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="rail-inspector-toggle"]')
    await flush()
    click('[data-testid="workbench-more-menu"]')
    await flush()
    click('[data-testid="workbench-more-history"]')
    await flush()
    expect(drawerOpen('workbench-history-slot')).toBe(true)
    expect(drawerOpen('workbench-inspector-slot')).toBe(false)
    // rail toggle 的 aria-pressed 同步（单一状态源——无第二写路径）
    expect(q('[data-testid="rail-history-toggle"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

// ---------------------------------------------------------------- [D] 命令总线不回归

describe('画布工具命令不回归（rail 按钮=命令总线触发器）', () => {
  it('工具组：hand→zoom→select 切换（store 真源）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(getWorkbenchTool()).toBe('select')

    click('[data-testid="workbench-tool-hand"]')
    await flush()
    expect(getWorkbenchTool()).toBe('hand')

    click('[data-testid="workbench-tool-zoom"]')
    await flush()
    expect(getWorkbenchTool()).toBe('zoom')

    click('[data-testid="workbench-tool-select"]')
    await flush()
    expect(getWorkbenchTool()).toBe('select')
  })

  it('笔刷开关：选中层后可进入/退出（brush 会话真源）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(q('[data-testid="workbench-brush-toggle"]')).not.toBeNull()

    selectNode('n-hat')
    await flush()
    click('[data-testid="workbench-brush-toggle"]')
    await flush()
    expect(getBrushSession().active).toBe(true)

    click('[data-testid="workbench-brush-toggle"]')
    await flush()
    expect(getBrushSession().active).toBe(false)
  })

  it('缩放档位命令（zoom.in/out/fit/100——CanvasView 真源推进）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="workbench-zoom-in"]')
    await flush()
    const afterIn = q('[data-testid="workbench-zoom-readout"]')?.textContent
    expect(afterIn).toMatch(/%\s*$/)
    click('[data-testid="workbench-zoom-out"]')
    await flush()
    click('[data-testid="workbench-zoom-100"]')
    await flush()
    expect(q('[data-testid="workbench-zoom-readout"]')?.textContent).toContain('100%')
  })
})

// ---------------------------------------------------------------- [E] 帮助 + 紧凑摘要

describe('快捷键帮助 + 紧凑态摘要（Drawer 布局下保留）', () => {
  it('rail 帮助按钮→速查面板开（help.toggle 同一总线）→再点收', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="rail-help-toggle"]')
    await flush()
    expect(q('[data-testid="workbench-shortcuts-help"]')).not.toBeNull()

    click('[data-testid="rail-help-toggle"]')
    await flush()
    expect(q('[data-testid="workbench-shortcuts-help"]')).toBeNull()
  })

  it('紧凑态：未选层=空态引导；选中层=摘要+策略直改条在场', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(q('[data-testid="workbench-compact-summary-empty"]')).not.toBeNull()
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-compact-summary"]') !== null)
    expect(q('[data-testid="workbench-compact-summary"]')?.textContent).toContain('帽子')
    expect(q('[data-testid="workbench-compact-strategy"]')).not.toBeNull()
    expect(q('[data-testid="workbench-compact-summary-empty"]')).toBeNull()
  })
})
