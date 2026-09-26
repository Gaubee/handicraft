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

  it('默认 heart 任务不在工作台引用集→轻量面板错误态驻留+动作区仍可用（完整工作台有独立错误面）', async () => {
    mountView()
    await waitUntil(() => q('[data-testid="task-detail-error"]') !== null)
    expect(q('[data-testid="task-detail-error"]')?.textContent).toContain('详情装载失败')
    expect(q('[data-testid="task-detail-retry"]')).not.toBeNull()
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

describe('轻量详情内容态（clown fixture）+ 动作区', () => {
  beforeEach(async () => {
    media = stubMatchMedia(true)
    await openSession('fixt-session-clown')
  })

  afterEach(() => {
    media.restore()
  })

  it('标题/状态徽章/gems 计数/预览缩略/图层摘要（5 只读行——名字+策略徽标）', async () => {
    mountView()
    await waitUntil(() => q('[data-testid="task-detail-title"]') !== null)

    expect(q('[data-testid="task-detail-title"]')?.textContent).toContain('小丑贴钻·工作台')
    expect(q('[data-testid="task-detail-status"]')?.textContent).toContain('已完成')
    expect(q('[data-testid="task-detail-gems"]')?.textContent).toContain('20')
    // 预览缩略图：taskArtifact 附件通道 dataUrl（strategy-gems-preview.png）。
    const preview = q('[data-testid="task-detail-preview"]') as HTMLImageElement | null
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('src')?.startsWith('data:image/')).toBe(true)
    // 图层摘要只读行：5 节点 DFS（画布→小丑→帽子/脸蛋/蝴蝶结）。
    const rows = qq('[data-testid="task-detail-layer-row"]')
    expect(rows).toHaveLength(5)
    const hat = rows.find((row) => row.getAttribute('data-node-id') === 'n-hat')
    expect(hat?.textContent).toContain('帽子')
    expect(hat?.textContent).toContain('texture-fill')
  })

  it('眼睛显隐切换仅视觉：行划线+aria-pressed 翻转，预览 src 不变（不做编辑/重渲）', async () => {
    mountView()
    await waitUntil(() => qq('[data-testid="task-detail-layer-row"]').length === 5)
    const previewBefore = (q('[data-testid="task-detail-preview"]') as HTMLImageElement).getAttribute('src')
    const eye = q('[data-testid="task-detail-layer-visible-n-hat"]') as HTMLButtonElement
    expect(eye.getAttribute('aria-pressed')).toBe('true')

    eye.click()
    await tick()
    expect(eye.getAttribute('aria-pressed')).toBe('false')
    const nameSpan = q('[data-testid="task-detail-layer-row"][data-node-id="n-hat"] span')
    expect(nameSpan?.className).toContain('line-through')
    // 仅视觉——预览缩略图字节不动。
    expect((q('[data-testid="task-detail-preview"]') as HTMLImageElement).getAttribute('src')).toBe(previewBefore)

    eye.click()
    await tick()
    expect(eye.getAttribute('aria-pressed')).toBe('true')
  })

  it('动作区「打开完整工作台」→ studio 视图+任务上下文（openStudioTask 既有通道）', async () => {
    mountView()
    await waitUntil(() => q('[data-testid="task-detail-title"]') !== null)
    click('[data-testid="task-detail-open-workbench"]')
    await tick()

    expect(getView()).toBe('studio')
    expect(getStudioTaskId()).toBe(WORKBENCH_FIXTURE_TASK_ID)
  })

  it('动作区「继续对话」→ 聚焦对话输入框（第三栏桌面常驻不收）', async () => {
    mountView()
    await waitUntil(() => q('[data-testid="task-detail-title"]') !== null)
    click('[data-testid="task-detail-back-chat"]')
    await tick()

    const composer = q('[data-testid="agent-composer"]') as HTMLTextAreaElement | null
    expect(composer).not.toBeNull()
    expect(document.activeElement).toBe(composer)
    expect(q('[data-testid="agent-pane-detail"]')).not.toBeNull()
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
    await waitUntil(() => q('[data-testid="task-detail-title"]') !== null)
    expect(qq('[data-testid="task-detail-panel"]')).toHaveLength(1)
    expect(q('[data-testid="agent-detail-sheet"]')?.textContent).toContain('任务详情')

    // ESC 收抽屉（svelte:window 守卫）。
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await waitUntil(() => q('[data-testid="agent-detail-sheet"]') === null)
    expect(q('[data-testid="task-detail-panel"]')).toBeNull()
  })

  it('「继续对话」收 Sheet 抽屉+聚焦输入框', async () => {
    media = stubMatchMedia(false)
    await openSession('fixt-session-clown')
    mountView()
    await waitUntil(() => q('[data-testid="agent-detail-toggle"]') !== null)
    click('[data-testid="agent-detail-toggle"]')
    await waitUntil(() => q('[data-testid="task-detail-title"]') !== null)

    click('[data-testid="task-detail-back-chat"]')
    await waitUntil(() => q('[data-testid="agent-detail-sheet"]') === null)
    const composer = q('[data-testid="agent-composer"]') as HTMLTextAreaElement | null
    expect(composer).not.toBeNull()
    // 抽屉关闭后 bits-ui 焦点归还触发按钮——backToChat 延迟 240ms 压过后聚焦输入框。
    await waitUntil(() => document.activeElement === composer)
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
