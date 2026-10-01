/*
 * [真链复验 P1-G] 会话改名 UI 测试（AgentView 侧栏行内联编辑）。
 * 覆盖：①双击标题进入编辑（input 预填当前标题）→回车保存→列表行更新；
 * ②铅笔入口进入编辑；③Esc 取消不改；④空标题回车=放弃不改；
 * ⑤store.renameSession 失败面（api 抛错）——行保持编辑态、标题不变。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from '../../App.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import type { AgentApi, AgentConnectionState } from '$lib/agentApi/types'
import {
  bindAgentApi,
  getAgentSessions,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { resetDevFlagForTests } from '$lib/stores/devFlag.svelte'
import { resetOpenIntentForTests } from '$lib/stores/openIntent.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

const mountedDisposers: Array<() => void> = []

function mountApp(): () => void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  const dispose = () => {
    unmount(app)
    target.remove()
  }
  mountedDisposers.push(dispose)
  return dispose
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

function firstSessionButton(): HTMLElement {
  const el = document.querySelector('[data-testid="agent-session-item"]')
  if (!(el instanceof HTMLElement)) throw new Error('会话行不在场')
  return el
}

function renameInput(): HTMLInputElement {
  const el = document.querySelector('[data-testid="agent-session-rename-input"]')
  if (!(el instanceof HTMLInputElement)) throw new Error('改名输入框不在场')
  return el
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressKey(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  localStorage.clear()
  resetDevFlagForTests(false)
  resetViewForTests()
  resetAgentStoreForTests()
  resetToastsForTests()
  resetOpenIntentForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('会话改名（真链复验 P1-G）', () => {
  it('双击标题→内联编辑→回车保存：列表行更新为新标题', async () => {
    const api = new MockAgentApi({ speed: 0 })
    bindAgentApi(api)
    const dispose = mountApp()
    try {
      await waitUntil(() => getAgentSessions().length > 0)
      await flush()
      const before = getAgentSessions()[0]!
      const row = firstSessionButton()
      row.querySelector('[data-testid="agent-session-title"]')!.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      )
      await tick()
      const input = renameInput()
      expect(input.value).toBe(before.title)
      setInputValue(input, '  小丑贴钻·终版  ')
      pressKey(input, 'Enter')
      await waitUntil(() => document.querySelector('[data-testid="agent-session-rename-input"]') === null)
      expect(getAgentSessions()[0]!.title).toBe('小丑贴钻·终版') // 服务端 trim 回显。
      expect(firstSessionButton().textContent).toContain('小丑贴钻·终版')
    } finally {
      dispose()
    }
  })

  it('铅笔入口进入编辑；Esc 取消不改', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    const dispose = mountApp()
    try {
      await waitUntil(() => getAgentSessions().length > 0)
      await flush()
      const before = getAgentSessions()[0]!.title
      const trigger = firstSessionButton().querySelector('[data-testid="agent-session-rename-trigger"]')
      expect(trigger).not.toBeNull()
      ;(trigger as HTMLElement).click()
      await tick()
      const input = renameInput()
      setInputValue(input, '不应生效的标题')
      pressKey(input, 'Escape')
      await waitUntil(() => document.querySelector('[data-testid="agent-session-rename-input"]') === null)
      expect(getAgentSessions()[0]!.title).toBe(before)
      expect(firstSessionButton().textContent).toContain(before)
    } finally {
      dispose()
    }
  })

  it('空标题回车=放弃不改（回退行卡）', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    const dispose = mountApp()
    try {
      await waitUntil(() => getAgentSessions().length > 0)
      await flush()
      const before = getAgentSessions()[0]!.title
      const row = firstSessionButton()
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await tick()
      const input = renameInput()
      setInputValue(input, '   ')
      pressKey(input, 'Enter')
      await waitUntil(() => document.querySelector('[data-testid="agent-session-rename-input"]') === null)
      expect(getAgentSessions()[0]!.title).toBe(before)
    } finally {
      dispose()
    }
  })

  it('rpc 改名失败面：api 抛错——行保持编辑态、标题不变（storeError 呈现）', async () => {
    const iso = new Date().toISOString()
    const calls: Array<{ sessionId: string; title: string }> = []
    const api = {
      mode: 'rpc',
      connection: () => 'open' as AgentConnectionState,
      onConnectionChange: (listener: (state: AgentConnectionState) => void) => {
        listener('open')
        return () => undefined
      },
      listSessions: async () => ({
        sessions: [{ id: 's-rename', title: '原名', status: 'active', createdAt: iso, updatedAt: iso }],
      }),
      getSession: async () => ({ session: { id: 's-rename', title: '原名', status: 'active', createdAt: iso, updatedAt: iso }, tasks: [] }),
      renameSession: async (sessionId: string, title: string) => {
        calls.push({ sessionId, title })
        throw new Error('会话正在清理，拒绝改名')
      },
    } as unknown as AgentApi
    bindAgentApi(api)
    await initAgentStore(api)
    const dispose = mountApp()
    try {
      await flush()
      const row = firstSessionButton()
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await tick()
      const input = renameInput()
      setInputValue(input, '新名')
      pressKey(input, 'Enter')
      await waitUntil(() => calls.length === 1)
      await flush()
      expect(calls[0]).toEqual({ sessionId: 's-rename', title: '新名' })
      // 失败：保持编辑态（输入框在场）、标题未变。
      expect(document.querySelector('[data-testid="agent-session-rename-input"]')).not.toBeNull()
      expect(getAgentSessions()[0]!.title).toBe('原名')
    } finally {
      dispose()
    }
  })
})
