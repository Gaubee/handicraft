/*
 * [unify-studio-routing] App 级 URL 同步（jsdom）：Owner 验收口径「工作台/排钻/
 * 任务详情 tabs 切换 URL 变更且刷新/回退还原同状态」的端到端断言。
 * 覆盖：顶栏 tab 切换=URL 变更；重挂载（刷新还原）；history.back 回退还原；
 * 引擎实验/任务上下文深链；无旗标 dev 视图深链回退（replace #/）。
 * 面板 tab 的 URL 断言在 viewRoute（store 面）+ taskDetailTabs（组件面）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import App from '../../App.svelte'
import { getView, openStudioTask, resetViewForTests } from '../../lib/stores/view.svelte'
import { resetDevFlagForTests } from '../../lib/stores/devFlag.svelte'
import { resetLabForTests } from '../../lib/stores/lab.svelte'
import { resetToastsForTests } from '../../lib/stores/toast.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'

// jsdom 未实现（setup.jsdom.ts 只桩 ResizeObserver；此处补挂载面缺口）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

function mountApp(): { unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function clickTab(label: string): void {
  const trigger = [...document.body.querySelectorAll('header [role="tab"]')].find((t) =>
    t.textContent?.trim().includes(label),
  )
  expect(trigger, `顶栏 tab「${label}」应在场`).not.toBeNull()
  trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetDevFlagForTests(true)
  resetViewForTests('agent')
  resetAgentStoreForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  resetLabForTests()
  resetToastsForTests()
})

describe('App 级 URL 同步（unify-studio-routing）', () => {
  it('①顶栏切「排钻工作台」→ URL=#/studio；切回 Agent → URL 回 agent 锚', async () => {
    const { unmount } = mountApp()
    await tick()

    clickTab('排钻工作台')
    await tick()
    expect(getView()).toBe('studio')
    expect(location.hash).toBe('#/studio')
    expect(document.querySelector('[data-testid="studio-mode-select"]')).not.toBeNull()

    clickTab('Agent')
    await tick()
    expect(getView()).toBe('agent')
    // AgentView 挂载即 initAgentStore 自动打开 mock 最新会话——切回 Agent 的镜像
    // 经 provider 回填该会话锚（#/t/{id}；无会话时为裸 #/——两种皆合法 agent 锚）。
    expect(location.hash).toMatch(/^#\/(t\/.*)?$/)
    unmount()
  })

  it('②刷新还原：#/studio 重挂载仍是排钻工作台（startViewRouteSync 调用即同步）', async () => {
    const first = mountApp()
    await tick()
    clickTab('排钻工作台')
    await tick()
    expect(location.hash).toBe('#/studio')
    first.unmount()

    // 刷新模拟：同 hash 重挂载——视图态还原（此前组件态刷新即丢）。
    const second = mountApp()
    await tick()
    expect(getView()).toBe('studio')
    expect(document.querySelector('[data-testid="studio-mode-select"]')).not.toBeNull()
    second.unmount()
  })

  it('③回退还原：studio → history.back 回 Agent（URL 与视图同步回退）', async () => {
    const { unmount } = mountApp()
    await tick()
    clickTab('排钻工作台')
    await tick()
    expect(location.hash).toBe('#/studio')

    history.back()
    await vi.waitFor(() => expect(getView()).toBe('agent'))
    expect(location.hash === '' || location.hash === '#/').toBe(true)
    unmount()
  })

  it('④引擎实验深链：#/studio/engine 挂载即引擎面（URL 与视图一致）', async () => {
    location.hash = '#/studio/engine'
    const { unmount } = mountApp()
    await tick()
    expect(getView()).toBe('studio')
    expect(document.querySelector('[data-testid="studio-engine-wrap"]')).not.toBeNull()
    // 返回模式选择=导航回 #/studio
    const exit = document.querySelector('[data-testid="studio-engine-exit"]') as HTMLButtonElement
    exit.click()
    await tick()
    expect(location.hash).toBe('#/studio')
    expect(document.querySelector('[data-testid="studio-mode-select"]')).not.toBeNull()
    unmount()
  })

  it('⑤openStudioTask=URL #/studio/task/{id}（任务上下文路由化——刷新还原同任务）', async () => {
    const { unmount } = mountApp()
    await tick()
    openStudioTask('tk-url-1')
    await tick()
    expect(location.hash).toBe('#/studio/task/tk-url-1')
    expect(document.querySelector('[data-testid="task-workbench"]')).not.toBeNull()
    unmount()

    const second = mountApp()
    await tick()
    expect(location.hash).toBe('#/studio/task/tk-url-1')
    expect(document.querySelector('[data-testid="task-workbench"]')).not.toBeNull()
    second.unmount()
  })

  it('⑥无旗标 dev 视图深链回退：#/lab → replace #/（URL 与可见视图归一）', async () => {
    resetDevFlagForTests(false)
    location.hash = '#/lab'
    const { unmount } = mountApp()
    await vi.waitFor(() => expect(getView()).toBe('agent'))
    expect(location.hash).toBe('#/')
    expect(document.querySelector('[data-testid="agent-view"]')).not.toBeNull()
    unmount()
  })
})
