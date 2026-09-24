/*
 * [add-backend-platform W3.3 测试分类②] App 脚手架冒烟——UI-only 测试默认照跑：
 * 涉及旧三工作台/BYOK 面的用例在测试内显式开旗标（resetDevFlagForTests(true)）后
 * mount，断言与既有口径一致；默认无旗标的 Agent 主面断言归 agentFace.test.ts ①。
 * 默认落地/导航隐藏的双模式口径见 devFlag 消费面（App.svelte）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import App from '../App.svelte'
import { clearHandoff, setHandoff } from '../lib/stores/handoff.svelte'
import { getView, resetViewForTests, setView } from '../lib/stores/view.svelte'
import { resetDevFlagForTests } from '../lib/stores/devFlag.svelte'
import { getSettings, updateSettings, resetLabForTests } from '../lib/stores/lab.svelte'
import { isSettingsOpen, closeSettings } from '../lib/stores/settingsDialog.svelte'
import { getToasts, resetToastsForTests } from '../lib/stores/toast.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'

// jsdom 未实现 ResizeObserver；bits-ui Slider（排钻工作台面板）内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}
// 会话流自动滚动（AgentView）——jsdom 未实现，桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

beforeEach(() => {
  localStorage.clear()
  resetDevFlagForTests(true) // 本文件为开旗标冒烟（分类②）——Agent 主面默认态归 agentFace
  resetViewForTests('agent')
  resetAgentStoreForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  resetLabForTests()
  resetToastsForTests()
})

function mountApp(): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

/** 保证冷启动（未配置 BYOK）的前置状态；返回恢复函数 */
function forceColdStart(): () => void {
  const s = getSettings()
  const saved = { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model }
  updateSettings({ baseUrl: '', apiKey: '', model: '' })
  return () => updateSettings(saved)
}

describe('App 脚手架冒烟（开旗标——分类②，UI-only 照跑）', () => {
  it('挂载后渲染顶栏标题与七视图 Tab（Agent 居首+素材库+装饰钻库+仓储管理+三工作台）', () => {
    const restore = forceColdStart()
    const { target, unmount } = mountApp()

    expect(document.body.textContent).toContain('贴钻工作台')
    // 视图切换 Tab 断言限定顶栏 header（[lab-ux 6] 起实验室视图内含嵌套 Tabs——高级参数编辑器；
    // 全局 [role=tab] 收集会把内层 tab 一并卷入）
    const triggers = [...document.body.querySelectorAll('header [role="tab"]')]
    expect(triggers.map((t) => t.textContent?.trim())).toEqual([
      'Agent',
      '素材库',
      '装饰钻库',
      '仓储管理',
      '提示词实验室',
      '排钻工作台',
      '设计师工作台',
    ])
    // 底部移动端导航（lg 以下）与顶栏 Tabs 并存；Agent 居首
    const mobileNav = document.querySelector('nav[aria-label="模块切换"]')
    expect(mobileNav?.textContent).toContain('素材库')
    expect(mobileNav?.querySelector('button')?.textContent?.trim()).toBe('Agent')
    expect(document.querySelector('[data-testid="byok-chip"]')).not.toBeNull()

    unmount()
    target.remove()
    restore()
  })

  it('默认落地 Agent 主面（view store 默认 agent——旗标只加旧入口不改默认路由）', async () => {
    const { unmount } = mountApp()
    await tick()

    expect(getView()).toBe('agent')
    expect(document.querySelector('[data-testid="agent-view"]')).not.toBeNull()

    unmount()
  })

  it('点击「素材库」Tab 后挂载素材库视图（树 + 状态条骨架）', async () => {
    const { unmount } = mountApp()
    await tick()

    const assetsTrigger = [...document.body.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent?.trim() === '素材库',
    )
    assetsTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(getView()).toBe('assets')
    expect(document.querySelector('[data-testid="assets-view"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="assets-tree"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="assets-statusbar"]')).not.toBeNull()

    unmount()
    setView('agent')
  })

  it('点击「仓储管理」Tab 后挂载仓储管理工作台（平铺区+侧栏骨架）', async () => {
    // fixture 注入（生产 RPC 面 jsdom 不可达——store 装载走内存面，骨架断言不依赖 daemon）
    const { makeWarehouseClient } = await import('./warehouse/fixtures')
    const { bindWarehouseClient, resetWarehouseForTests } = await import('../lib/warehouse/store.svelte')
    resetWarehouseForTests()
    bindWarehouseClient(makeWarehouseClient().client)
    const { unmount } = mountApp()
    await tick()

    const warehouseTrigger = [...document.body.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent?.trim() === '仓储管理',
    )
    warehouseTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(getView()).toBe('warehouse')
    expect(document.querySelector('[data-testid="warehouse-view"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="warehouse-flow-scroll"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="warehouse-set-sidebar"]')).not.toBeNull()

    resetWarehouseForTests()
    unmount()
    setView('agent')
  })

  it('点击「排钻工作台」Tab 后显示排钻工作台（模块 B 已就绪）', async () => {
    const { unmount } = mountApp()
    await tick()

    const studioTrigger = [...document.body.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent?.trim() === '排钻工作台',
    )
    studioTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(getView()).toBe('studio')
    // [studio-layers 2.7] 模块 B 四区骨架：画布空态 + 左列（图层|历史）+ 状态条（胶片带整区废除）
    expect(document.body.textContent).toContain('还没有数字油画')
    expect(document.querySelector('[data-testid="strategy-film-strip"]')).toBeNull()
    expect(document.querySelector('[data-testid="studio-left-column"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="status-bar"]')).not.toBeNull()

    unmount()
    setView('agent')
  })

  it('送排钻 handoff 置位后自动切换到排钻工作台（旗标开）', async () => {
    setView('lab')
    const { unmount } = mountApp()
    await tick()
    expect(getView()).toBe('lab')

    setHandoff({ assetId: 'ast-smoke-missing', name: '冒烟测试.png' })
    await tick()

    expect(getView()).toBe('studio')
    expect(document.body.textContent).toContain('还没有数字油画')

    clearHandoff()
    unmount()
    resetViewForTests('agent')
  })

  it('无旗标时 handoff 不切旧工作台（Agent 主面不受旧动线影响）', async () => {
    resetDevFlagForTests(false)
    const { unmount } = mountApp()
    await tick()
    expect(getView()).toBe('agent')

    setHandoff({ assetId: 'ast-smoke-missing', name: '冒烟测试.png' })
    await tick()
    expect(getView()).toBe('agent')

    clearHandoff()
    unmount()
    resetDevFlagForTests(true)
  })
})

describe('冷启动动线（R2：sticky CTA 变体——开旗标，实验室挂载）', () => {
  it('未配置 BYOK 时生成按钮变「配置连接」，点击一步打开设置 Dialog', async () => {
    const restore = forceColdStart()
    setView('lab')
    const { unmount } = mountApp()
    await tick()

    const runButton = document.querySelector('[data-testid="run-button"]')
    expect(runButton).not.toBeNull()
    expect(runButton!.textContent).toContain('配置连接')

    runButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(isSettingsOpen()).toBe(true)
    // Dialog 内容确已挂载（表单三件套可达）
    expect(document.body.textContent).toContain('BYOK 连接设置')

    closeSettings()
    await tick()
    unmount()
    restore()
    resetViewForTests('agent')
  })

  it('已配置 BYOK 时生成按钮恢复「开始生成」文案', async () => {
    const restore = forceColdStart()
    updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
    setView('lab')
    const { unmount } = mountApp()
    await tick()

    const runButton = document.querySelector('[data-testid="run-button"]')
    expect(runButton!.textContent).toContain('开始生成')

    unmount()
    restore()
    resetViewForTests('agent')
  })
})

describe('全局 toast（R3：送排钻确认）', () => {
  it('toast store push 后由 ToastStack 渲染，可点击关闭', async () => {
    resetToastsForTests()
    const { unmount } = mountApp()

    expect(getToasts()).toHaveLength(0)
    const { showToast } = await import('../lib/stores/toast.svelte')
    showToast('已送入排钻工作台')
    await tick()

    expect(getToasts()).toHaveLength(1)
    const stack = document.querySelector('[data-testid="toast-stack"]')
    expect(stack?.textContent).toContain('已送入排钻工作台')

    stack?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getToasts()).toHaveLength(0)

    unmount()
    resetToastsForTests()
  })
})
