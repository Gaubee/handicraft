/*
 * [unify-studio-routing sweep ②] Agent 数据源开关（rpc 入口可发现）测试。
 * 覆盖：键写面互逆（setAgentApiMode：rpc=写键 / mock=删键——与工厂读面
 * 「缺省与未知值一律 mock」互逆）；App 顶栏芯片常驻（状态可见：mock=「演示数据」/
 * rpc=「服务器」）；点击切换=写键+toast（重载由 jsdom 降级为 no-op——键面即
 * 持久断言面）；`?api=rpc` 深链同键兼容（urlFlags 引导与开关共享持久面）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from '../../App.svelte'
import { AGENT_API_MODE_KEY, defaultAgentApiFactory, setAgentApiMode } from '../../lib/agentApi/index'
import { MockAgentApi } from '$lib/agentApi/mock'
import type { AgentApi } from '$lib/agentApi/types'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { resetDevFlagForTests } from '../../lib/stores/devFlag.svelte'
import { resetLabForTests } from '../../lib/stores/lab.svelte'
import { resetViewForTests } from '../../lib/stores/view.svelte'
import { getToasts, resetToastsForTests } from '../../lib/stores/toast.svelte'

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

/** mode='rpc' 最小桩（连接面全静默——芯片显示面只读 mode 投影，不触真 WS）。 */
function stubRpcApi(): AgentApi {
  const unimplemented = (name: string): never => {
    throw new Error(`stub 未实现：${name}`)
  }
  return {
    mode: 'rpc',
    connection: () => 'error',
    onConnectionChange: () => () => {},
    listSessions: async () => ({ sessions: [] }),
    getSession: unimplemented.bind(null, 'getSession'),
  } as unknown as AgentApi
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

describe('setAgentApiMode（键写面）', () => {
  it('rpc=写键；mock=删键（回缺省——键空间不留 mock 值）', () => {
    setAgentApiMode('rpc')
    expect(localStorage.getItem(AGENT_API_MODE_KEY)).toBe('rpc')
    setAgentApiMode('mock')
    expect(localStorage.getItem(AGENT_API_MODE_KEY)).toBeNull()
  })

  it('写面与工厂读面互逆：rpc 键→mode rpc；删键→mode mock', () => {
    setAgentApiMode('rpc')
    expect(defaultAgentApiFactory().mode).toBe('rpc')
    setAgentApiMode('mock')
    expect(defaultAgentApiFactory().mode).toBe('mock')
  })

  it('`?api=rpc` 深链同键兼容：urlFlags 引导写同一持久面（开关读/写不互踩）', () => {
    // urlFlags 为副作用 import（main.ts 首位）——此处验证共享键语义：深链引导落地
    // 的键值即开关的读面真源；开关切回删键后工厂回落 mock。
    localStorage.setItem(AGENT_API_MODE_KEY, 'rpc')
    expect(localStorage.getItem(AGENT_API_MODE_KEY)).toBe('rpc')
    expect(defaultAgentApiFactory().mode).toBe('rpc')
    setAgentApiMode('mock')
    expect(defaultAgentApiFactory().mode).toBe('mock')
  })
})

describe('App 顶栏「连接服务器」芯片', () => {
  it('mock 模式：芯片常驻+显示「演示数据」；点击=写 rpc 键+切换 toast（键持久）', async () => {
    const { unmount } = mountApp()
    await tick()

    const chip = document.querySelector('[data-testid="agent-api-mode-toggle"]') as HTMLButtonElement | null
    expect(chip, '数据源芯片应常驻顶栏（rpc 入口可发现）').not.toBeNull()
    expect(document.querySelector('[data-testid="agent-api-mode-label"]')?.textContent?.trim()).toBe('演示数据')

    chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(localStorage.getItem(AGENT_API_MODE_KEY)).toBe('rpc')
    expect(getToasts().some((toast) => toast.message.includes('连接服务器'))).toBe(true)
    unmount()
  })

  it('rpc 模式：芯片显示「服务器」；点击=删键回 mock+切换 toast', async () => {
    bindAgentApi(stubRpcApi())
    const { unmount } = mountApp()
    await tick()

    expect(document.querySelector('[data-testid="agent-api-mode-label"]')?.textContent?.trim()).toBe('服务器')
    const chip = document.querySelector('[data-testid="agent-api-mode-toggle"]') as HTMLButtonElement
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(localStorage.getItem(AGENT_API_MODE_KEY)).toBeNull()
    expect(getToasts().some((toast) => toast.message.includes('演示数据'))).toBe(true)
    unmount()
  })
})
