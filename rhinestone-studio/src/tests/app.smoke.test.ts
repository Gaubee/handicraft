import { describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import App from '../App.svelte'
import { clearHandoff, setHandoff } from '../lib/stores/handoff.svelte'
import { getView, setView } from '../lib/stores/view.svelte'
import { getSettings, updateSettings } from '../lib/stores/lab.svelte'
import { isSettingsOpen, closeSettings } from '../lib/stores/settingsDialog.svelte'
import { getToasts, resetToastsForTests } from '../lib/stores/toast.svelte'

// jsdom 未实现 ResizeObserver；bits-ui Slider（工作台面板）内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

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

describe('App 脚手架冒烟', () => {
  it('挂载后渲染顶栏标题与四个视图切换 Tab（[Owner] 素材库居首）', () => {
    const restore = forceColdStart()
    const { target, unmount } = mountApp()

    expect(document.body.textContent).toContain('贴钻工作台')
    const triggers = [...document.body.querySelectorAll('[role="tab"]')]
    expect(triggers.map((t) => t.textContent?.trim())).toEqual([
      '素材库',
      '提示词实验室',
      '排钻设计',
      '专家工作台',
    ])
    // 底部移动端导航（lg 以下）与顶栏 Tabs 并存；素材库同样居首（folder 图标入口）
    const mobileNav = document.querySelector('nav[aria-label="模块切换"]')
    expect(mobileNav?.textContent).toContain('素材库')
    expect(mobileNav?.querySelector('button')?.textContent?.trim()).toBe('素材库')
    expect(document.querySelector('[data-testid="byok-chip"]')).not.toBeNull()

    unmount()
    target.remove()
    restore()
  })

  it('默认显示提示词实验室视图（素材库居首但落地视图不变）', () => {
    const { unmount } = mountApp()

    expect(getView()).toBe('lab')
    expect(document.body.textContent).toContain('模板')

    unmount()
  })

  it('点击「素材库」Tab 后挂载素材库视图（树 + 状态条骨架）', async () => {
    const { unmount } = mountApp()

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
    setView('lab')
  })

  it('点击「排钻设计」Tab 后显示排钻设计（模块 B 已就绪）', async () => {
    const { unmount } = mountApp()

    const studioTrigger = [...document.body.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent?.trim() === '排钻设计',
    )
    studioTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(getView()).toBe('studio')
    // 模块 B 五区骨架可见（redesign-studio-layout 方案 A）：画布空态 + 胶片带 + 状态条
    expect(document.body.textContent).toContain('还没有数字油画')
    expect(document.querySelector('[data-testid="strategy-film-strip"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="status-bar"]')).not.toBeNull()

    unmount()
    setView('lab')
  })

  it('送排钻 handoff 置位后自动切换到排钻设计', async () => {
    setView('lab')
    const { unmount } = mountApp()
    expect(getView()).toBe('lab')

    setHandoff({ assetId: 'ast-smoke-missing', name: '冒烟测试.png' })
    await tick()

    expect(getView()).toBe('studio')
    expect(document.body.textContent).toContain('还没有数字油画')

    clearHandoff()
    unmount()
    setView('lab')
  })
})

describe('冷启动动线（R2：sticky CTA 变体）', () => {
  it('未配置 BYOK 时生成按钮变「配置连接」，点击一步打开设置 Dialog', async () => {
    const restore = forceColdStart()
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
  })

  it('已配置 BYOK 时生成按钮恢复「开始生成」文案', async () => {
    const restore = forceColdStart()
    updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
    const { unmount } = mountApp()
    await tick()

    const runButton = document.querySelector('[data-testid="run-button"]')
    expect(runButton!.textContent).toContain('开始生成')

    unmount()
    restore()
  })
})

describe('全局 toast（R3：送排钻确认）', () => {
  it('toast store push 后由 ToastStack 渲染，可点击关闭', async () => {
    resetToastsForTests()
    const { unmount } = mountApp()

    expect(getToasts()).toHaveLength(0)
    const { showToast } = await import('../lib/stores/toast.svelte')
    showToast('已送入排钻设计')
    await tick()

    expect(getToasts()).toHaveLength(1)
    const stack = document.querySelector('[data-testid="toast-stack"]')
    expect(stack?.textContent).toContain('已送入排钻设计')

    stack?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getToasts()).toHaveLength(0)

    unmount()
    resetToastsForTests()
  })
})
