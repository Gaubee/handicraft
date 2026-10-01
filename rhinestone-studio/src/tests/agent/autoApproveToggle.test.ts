/*
 * [product-polish-w2 T2] 自动批准 toggleButton 测试（Owner Wave 1 验收：「自动批准
 * 放到 InputGroup 的下方/工具行——toggleButton 入工具行」——自状态条迁入）。
 * 覆盖：①rpc 模式渲染在 ComposerCard 工具行内（输入卡域内、role=switch、title
 * 说明、缺省关态中性色+「自动」短label）；②开启态 primary 描边+aria-checked
 * （服务端投影回读=openSession 对齐）；③点选→store 翻转（随下一条 followup 透传
 * ——透传断言见 sessionRoute.test.ts T2）；④mock 演示模式不渲染（无服务端开关真源）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  bindAgentApi,
  getSessionAutoApprove,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import type { AgentApi, AgentConnectionState, AgentTaskView } from '$lib/agentApi/types'
import type { SessionSummary } from '@handicraft/contracts'

// jsdom 缺口桩（同 quickStart.test.ts——挂 SessionStream/TranscriptView）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

function sessionOf(id: string, extra?: { autoApprove?: boolean }): SessionSummary {
  const iso = new Date().toISOString()
  return { id, title: '自动批准会话', status: 'active', createdAt: iso, updatedAt: iso, ...(extra?.autoApprove !== undefined ? { autoApprove: extra.autoApprove } : {}) }
}

function stubApi(mode: 'mock' | 'rpc', session: SessionSummary): AgentApi {
  const tasks: AgentTaskView[] = []
  let connectionState: AgentConnectionState = mode === 'rpc' ? 'open' : 'mock'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
  return {
    mode,
    connection: () => connectionState,
    onConnectionChange: (listener: (state: AgentConnectionState) => void) => {
      connectionListeners.add(listener)
      listener(connectionState)
      return () => connectionListeners.delete(listener)
    },
    listSessions: async () => ({ sessions: [session] }),
    createSession: async () => ({ sessionId: 's-new', createdAt: new Date().toISOString() }),
    getSession: async () => ({ session, tasks }),
    followup: async () => ({ taskId: 't-x' }),
    replay: async () => ({ frames: [], nextSeq: 0 }),
    subscribeTask: () => () => {},
    sessionResult: async () => {
      throw new Error('无结果')
    },
    clear: async () => ({ ok: true, status: 'cleared' as const }),
    cancel: async () => ({ ok: true }),
    answer: async () => ({ ok: true }),
    stopTask: async () => {},
    taskResult: async () => ({ found: false }),
    taskArtifact: async () => {
      throw new Error('本测试不触达')
    },
  } as unknown as AgentApi
}

async function mountStream(api: AgentApi): Promise<void> {
  bindAgentApi(api)
  await initAgentStore()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SessionStream, { target })
  mounted.push(() => {
    unmount(component)
    target.remove()
  })
}

const mounted: Array<() => void> = []

beforeEach(() => {
  resetAgentStoreForTests()
  resetSessionRouteForTests('')
})

afterEach(() => {
  while (mounted.length > 0) {
    const dispose = mounted.pop()!
    dispose()
  }
})

describe('T2 自动批准 toggleButton（迁入 ComposerCard 工具行）', () => {
  it('①rpc 模式渲染：输入卡工具行内 toggle（role=switch+title+短label「自动」）；缺省关态中性色', async () => {
    await mountStream(stubApi('rpc', sessionOf('s-ap', { autoApprove: false })))

    const toggle = document.querySelector('[data-testid="composer-auto-approve"]') as HTMLElement
    expect(toggle).not.toBeNull()
    // 位置：在 ComposerCard 输入卡域内（工具行——不再是 footer 状态条）。
    expect(toggle.closest('[data-testid="composer-dropzone"]')).not.toBeNull()
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('title')).toBe('自动批准：开启后本会话的排钻/图层/导出等批准自动通过——免值守跑批（对开启后的新批准生效）')
    // 关态=中性配色（无 primary 描边）；压缩态短 label「自动」。
    expect(toggle.className).not.toContain('border-primary')
    expect(toggle.textContent).toContain('自动')
    expect(toggle.textContent).not.toContain('已开启')
  })

  it('②开启态 primary 描边+aria-checked（服务端投影回读=开——openSession 对齐）', async () => {
    await mountStream(stubApi('rpc', sessionOf('s-ap-on', { autoApprove: true })))

    const toggle = document.querySelector('[data-testid="composer-auto-approve"]') as HTMLElement
    expect(toggle).not.toBeNull()
    expect(toggle.className).toContain('border-primary')
    expect(toggle.className).toContain('text-primary')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(getSessionAutoApprove()).toBe(true)
  })

  it('③点选 toggle→store 翻转（随下一条 followup 透传——透传断言在 sessionRoute.test.ts）', async () => {
    await mountStream(stubApi('rpc', sessionOf('s-ap', { autoApprove: false })))

    const toggle = document.querySelector('[data-testid="composer-auto-approve"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(getSessionAutoApprove()).toBe(false)
    toggle.click()
    await vi.waitFor(() => expect(getSessionAutoApprove()).toBe(true))
    // toggle 随翻转切换醒目色。
    const flipped = document.querySelector('[data-testid="composer-auto-approve"]') as HTMLElement
    await vi.waitFor(() => expect(flipped.className).toContain('border-primary'))
    expect(flipped.getAttribute('aria-checked')).toBe('true')
  })

  it('④mock 演示模式不渲染（无服务端开关真源——与 attachable 同款门）', async () => {
    await mountStream(stubApi('mock', sessionOf('s-mock')))
    expect(document.querySelector('[data-testid="composer-auto-approve"]')).toBeNull()
    expect(getSessionAutoApprove()).toBe(false)
  })
})

void MockAgentApi
