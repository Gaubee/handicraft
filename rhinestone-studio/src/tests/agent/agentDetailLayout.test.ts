/*
 * [add-workbench-pro 1.2-1.4] AgentView 三栏/移动 Sheet 响应式布局测试（jsdom
 * 视口模拟——matchMedia 桩控制宽/窄两态，studio.interactions 先例同式）。
 * 覆盖：桌面三栏 PaneGroup（会话|对话|任务详情）与第三栏随活跃任务出现/消失；
 * 轻量详情装载（小丑 fixture：标题/状态/gems 计数/预览缩略/图层摘要只读行+
 * 眼睛显隐仅视觉）；动作区（打开完整工作台→studio 路由+任务上下文；继续对话→
 * 聚焦输入框）；移动窄分支（详情按钮唤起 Sheet 抽屉+单实例断言）；断点穿越
 * （matchMedia change listener 触发布局切换）。SessionStream 单实例（composer
 * 全文仅一份——注入守卫前提不回归）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import AgentView from '$lib/components/agent/AgentView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
  sendFollowup,
} from '$lib/agentApi/store.svelte'
import { getStudioTaskId, getView, resetViewForTests } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/components/studio/taskWorkbench/store.svelte'

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountView(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(AgentView, { target })
  mountedDisposers.push(() => {
    unmount(view)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
  if (!condition()) throw new Error(`waitUntil 超时（${ms}ms）：条件未满足`)
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function qq(selector: string): Element[] {
  return [...document.querySelectorAll(selector)]
}

function click(selector: string): void {
  const el = q(selector) as HTMLButtonElement | null
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

/**
 * matchMedia 桩（jsdom 未实现）：matches 动态可翻（getter——组件 sync 闭包读新值）；
 * addEventListener 捕获 listener 供 set() 广播（断点穿越模拟）。
 */
function stubMatchMedia(initialDesktop: boolean): { set: (desktop: boolean) => void; restore: () => void } {
  const original = window.matchMedia
  let desktop = initialDesktop
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      get matches() {
        return desktop && query === '(min-width: 768px)'
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener)
      },
      dispatchEvent: () => false,
    }) as MediaQueryList
  return {
    set: (next: boolean) => {
      desktop = next
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent)
    },
    restore: () => {
      window.matchMedia = original
    },
  }
}

let media: ReturnType<typeof stubMatchMedia>

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetViewForTests('agent')
  resetToastsForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  await initAgentStore()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('桌面三栏（≥md 768px——matchMedia 宽态）', () => {
  beforeEach(() => {
    media = stubMatchMedia(true)
  })

  afterEach(() => {
    media.restore()
  })

  it('三栏结构：会话列表 | 对话 | 任务详情 Pane（默认 heart 会话有任务→第三栏在）；SessionStream 单实例', async () => {
    mountView()
    await flush()

    expect(q('[data-testid="agent-pane-group"]')).not.toBeNull()
    expect(q('[data-testid="agent-sidebar"]')).not.toBeNull()
    expect(q('[data-testid="agent-pane-chat"]')).not.toBeNull()
    expect(q('[data-testid="agent-pane-detail"]')).not.toBeNull()
    // 单实例：对话流（Composer）与详情面板各只挂一份。
    expect(qq('[data-testid="agent-composer"]')).toHaveLength(1)
    expect(qq('[data-testid="task-detail-panel"]')).toHaveLength(1)
  })

  it('默认 heart 任务不在工作台引用集→mock 演示空态（w17-critic 友好化）+动作区仍可用', async () => {
    mountView()
    // [task-detail-tabs] 工作台=面板第二 tab（详情为缺省）——首开后工作台装载
    await waitUntil(() => q('[data-testid="task-detail-tab-workbench"]') !== null)
    click('[data-testid="task-detail-tab-workbench"]')
    await waitUntil(() => q('[data-testid="workbench-demo-empty"]') !== null)
    expect(q('[data-testid="workbench-demo-empty"]')?.textContent).toContain('演示任务无工作台数据')
    expect(q('[data-testid="task-detail-open-workbench"]')).not.toBeNull()
  })

  it('无任务会话（starry）→第三栏不出现；followup 新任务→第三栏动态出现', async () => {
    await openSession('fixt-session-starry')
    mountView()
    await flush()
    expect(q('[data-testid="agent-pane-detail"]')).toBeNull()
    expect(q('[data-testid="task-detail-panel"]')).toBeNull()

    await sendFollowup('帮我排一颗红钻')
    await waitUntil(() => q('[data-testid="agent-pane-detail"]') !== null)
    expect(q('[data-testid="task-detail-panel"]')).not.toBeNull()
  })
})

describe('详情=工作台紧凑形态（v4——clown fixture 同 store 会话）', () => {
  beforeEach(async () => {
    media = stubMatchMedia(true)
    await openSession('fixt-session-clown')
  })

  afterEach(() => {
    media.restore()
  })

  it('嵌入工作台紧凑形态：迷你画布+图层列表+embedded 标记（同组件同 store）', async () => {
    mountView()
    // [task-detail-tabs] 工作台 tab 首开后挂载紧凑工作台
    await waitUntil(() => q('[data-testid="task-detail-tab-workbench"]') !== null)
    click('[data-testid="task-detail-tab-workbench"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // 嵌入标记+无自带顶栏（面板头承载动作区）
    const workbench = q('[data-testid="task-workbench"]')
    expect(workbench?.getAttribute('data-embedded')).toBe('true')
    expect(q('[data-testid="workbench-topbar"]')).toBeNull()
    // 紧凑形态内容：迷你画布（图层舞台）+图层列表在场
    expect(q('[data-testid="workbench-layer-stage"]')).not.toBeNull()
    expect(q('[data-testid="workbench-layer-panel"]')).not.toBeNull()
    // v5 PS 面板：钻布局虚拟子行移除——fx 徽标（有钻叶子 ◆+颗数微标）承接
    const fxBadge = q('[data-testid="workbench-layer-fx-n-hat"]')
    expect(fxBadge?.getAttribute('data-gem-count')).toBe('7')
  })

  it('选中层→紧凑摘要（名称/类别/掩码覆盖/策略）——「打开完整工作台」=纯放大同会话', async () => {
    mountView()
    await waitUntil(() => q('[data-testid="task-detail-tab-workbench"]') !== null)
    click('[data-testid="task-detail-tab-workbench"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-compact-summary"]') !== null)
    const summary = q('[data-testid="workbench-compact-summary"]')?.textContent ?? ''
    expect(summary).toContain('帽子')
    expect(summary).toContain('texture-fill')

    click('[data-testid="task-detail-open-workbench"]')
    await tick()
    expect(getView()).toBe('studio')
    expect(getStudioTaskId()).toBe(WORKBENCH_FIXTURE_TASK_ID)
  })

  it('[studio-tab-bar] 面板头清理：桌面零文字钮（继续对话/完整工作台退场）——open icon-button=唯一完整工作台跳转入口+tab 栏单行锁', async () => {
    mountView()
    await waitUntil(() => q('[data-testid="task-detail-open-workbench"]') !== null)

    // 旧两钮退场（Owner 裁决：详情 tab 已有「打开工作台」入口卡，面板头无需重复）。
    expect(q('[data-testid="task-detail-back-chat"]')).toBeNull()
    const open = q('[data-testid="task-detail-open-workbench"]') as HTMLButtonElement
    expect(open.textContent?.trim()).toBe('') // 纯图标钮（无「完整工作台」文字）
    expect(open.getAttribute('title')).toContain('完整工作台')
    // studio-tab-bar 在场：tabs 行 overflow-y 锁死（严格单行——多 tab 只横滚）。
    const list = q('[data-testid="task-detail-tabs"]') as HTMLElement
    expect(list.className).toContain('overflow-y-hidden')
    expect(list.className).toContain('overflow-x-auto')
    expect(q('[data-testid="studio-tab-bar"]')).not.toBeNull()
    // 移动端关闭钮桌面隐藏（md:hidden——CSS 层不显，DOM 常驻供窄态复用）。
    expect(q('[data-testid="task-detail-close"]')?.className).toContain('md:hidden')

    // open icon-button 跳转语义不变（纯放大同会话）。
    open.click()
    await tick()
    expect(getView()).toBe('studio')
    expect(getStudioTaskId()).toBe(WORKBENCH_FIXTURE_TASK_ID)
  })
})

describe('移动窄分支（<md——matchMedia 窄态）+ 断点穿越', () => {
  afterEach(() => {
    media?.restore()
  })

  it('无 PaneGroup；对话全宽；「详情」按钮唤起 Sheet 抽屉承载面板（单实例）', async () => {
    media = stubMatchMedia(false)
    await openSession('fixt-session-clown')
    mountView()
    await waitUntil(() => q('[data-testid="agent-stream"]') !== null)

    expect(q('[data-testid="agent-pane-group"]')).toBeNull()
    expect(q('[data-testid="agent-detail-toggle"]')).not.toBeNull()
    // 抽屉未开：面板不在场（Sheet 内容按需挂载）。
    expect(q('[data-testid="task-detail-panel"]')).toBeNull()

    click('[data-testid="agent-detail-toggle"]')
    await waitUntil(() => q('[data-testid="agent-detail-sheet"]') !== null)
    await waitUntil(() => q('[data-testid="task-detail-open-workbench"]') !== null)
    expect(qq('[data-testid="task-detail-panel"]')).toHaveLength(1)
    expect(q('[data-testid="agent-detail-sheet"]')?.textContent).toContain('任务详情')

    // ESC 收抽屉（svelte:window 守卫）。
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await waitUntil(() => q('[data-testid="agent-detail-sheet"]') === null)
    expect(q('[data-testid="task-detail-panel"]')).toBeNull()
  })

  it('[studio-tab-bar] 移动端关闭钮（tab 栏右端动作区）收详情 Sheet 抽屉', async () => {
    media = stubMatchMedia(false)
    await openSession('fixt-session-clown')
    mountView()
    await waitUntil(() => q('[data-testid="agent-detail-toggle"]') !== null)
    click('[data-testid="agent-detail-toggle"]')
    await waitUntil(() => q('[data-testid="task-detail-open-workbench"]') !== null)

    // [studio-tab-bar] 关闭钮在 tab 栏动作区（zhumo 同位——移动端收抽屉回对话）。
    expect(q('[data-testid="task-detail-close"]')).not.toBeNull()
    click('[data-testid="task-detail-close"]')
    await waitUntil(() => q('[data-testid="agent-detail-sheet"]') === null)
    expect(q('[data-testid="task-detail-panel"]')).toBeNull()
    const composer = q('[data-testid="agent-composer"]') as HTMLTextAreaElement | null
    expect(composer).not.toBeNull()
  })

  it('无任务会话（starry）窄态：无「详情」按钮（无上下文不唤起空抽屉）', async () => {
    media = stubMatchMedia(false)
    await openSession('fixt-session-starry')
    mountView()
    await waitUntil(() => q('[data-testid="agent-stream"]') !== null)
    expect(q('[data-testid="agent-detail-toggle"]')).toBeNull()
  })

  it('断点穿越（resize）：桌面三栏 → 窄态堆叠+抽屉 → 回桌面三栏（matchMedia change 广播）', async () => {
    media = stubMatchMedia(true)
    await openSession('fixt-session-clown')
    mountView()
    await waitUntil(() => q('[data-testid="agent-pane-detail"]') !== null)

    // 窄化：PaneGroup 卸载、移动堆叠+详情按钮出现；SessionStream 仍单实例。
    media.set(false)
    await waitUntil(() => q('[data-testid="agent-pane-group"]') === null)
    await waitUntil(() => q('[data-testid="agent-detail-toggle"]') !== null)
    expect(qq('[data-testid="agent-composer"]')).toHaveLength(1)

    // 回宽：三栏恢复、详情按钮自抑制（桌面第三栏常驻）。
    media.set(true)
    await waitUntil(() => q('[data-testid="agent-pane-group"]') !== null)
    await waitUntil(() => q('[data-testid="agent-pane-detail"]') !== null)
    expect(q('[data-testid="agent-detail-toggle"]')).toBeNull()
    expect(qq('[data-testid="task-detail-panel"]')).toHaveLength(1)
    expect(qq('[data-testid="agent-composer"]')).toHaveLength(1)
  })
})
