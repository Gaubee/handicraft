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
  it('挂载后渲染顶栏标题与两个视图切换 Tab', () => {
    const restore = forceColdStart()
    const { target, unmount } = mountApp()

    expect(document.body.textContent).toContain('贴钻工作台')
    const triggers = [...document.body.querySelectorAll('[role="tab"]')]
    expect(triggers.map((t) => t.textContent?.trim())).toEqual(['提示词实验室', '转化工作台', '手动编辑'])
    // 底部移动端导航（lg 以下）与顶栏 Tabs 并存，承载同一组模块入口
    expect(document.querySelector('[data-testid="byok-chip"]')).not.toBeNull()

    unmount()
    target.remove()
    restore()
  })

  it('默认显示提示词实验室视图', () => {
    const { unmount } = mountApp()

    expect(document.body.textContent).toContain('提示词变体组')

    unmount()
  })

  it('点击「转化工作台」Tab 后显示转化工作台（模块 B 已就绪）', async () => {
    const { unmount } = mountApp()

    const studioTrigger = [...document.body.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent?.trim() === '转化工作台',
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

  it('送转化 handoff 置位后自动切换到转化工作台', async () => {
    setView('lab')
    const { unmount } = mountApp()
    expect(getView()).toBe('lab')

    setHandoff({ image: 'data:image/png;base64,iVBORw0KGgo=', name: '冒烟测试.png' })
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

describe('全局 toast（R3：送转化确认）', () => {
  it('toast store push 后由 ToastStack 渲染，可点击关闭', async () => {
    resetToastsForTests()
    const { unmount } = mountApp()

    expect(getToasts()).toHaveLength(0)
    const { showToast } = await import('../lib/stores/toast.svelte')
    showToast('已送入转化工作台')
    await tick()

    expect(getToasts()).toHaveLength(1)
    const stack = document.querySelector('[data-testid="toast-stack"]')
    expect(stack?.textContent).toContain('已送入转化工作台')

    stack?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getToasts()).toHaveLength(0)

    unmount()
    resetToastsForTests()
  })
})
