/*
 * [product-polish-w1 T2] SessionStream 状态条「自动批准」开关呈现测试（Owner
 * 2026-09-30「chat 面板新增自动批准，免去有人值守」）。覆盖：①rpc 模式状态条
 * 渲染（摘要行附近、title 说明、缺省关态文案）；②开启态醒目色（primary 描边/
 * 底色）+文案切换；③点选开关→store 开关翻转（随下一条 followup 透传——透传
 * 断言见 sessionRoute.test.ts T2）；④mock 演示模式不渲染（无服务端开关真源）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
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

function sessionOf(id: string, extra?: { autoApprove?: boolean }): SessionSummary {
  const iso = new Date().toISOString()
  return { id, title: '自动批准会话', status: 'active', createdAt: iso, updatedAt: iso, ...(extra?.autoApprove !== undefined ? { autoApprove: extra.autoApprove } : {}) }
}

function stubApi(mode: 'mock' | 'rpc', session: SessionSummary): AgentApi {
  const tasks: AgentTaskView[] = []
  const listeners = new Map<string, Set<(frame: unknown) => void>>()
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

describe('SessionStream 自动批准状态条（T2 客户端）', () => {
  it('①rpc 模式渲染：摘要行附近状态条+title 说明；缺省关态（中性色）', async () => {
    await mountStream(stubApi('rpc', sessionOf('s-ap', { autoApprove: false })))

    const bar = document.querySelector('[data-testid="composer-auto-approve"]')
    expect(bar).not.toBeNull()
    expect(bar!.getAttribute('title')).toBe('开启后本会话的排钻/图层/导出等批准自动通过——免值守跑批')
    // 关态=中性配色（无 primary 描边）。
    expect(bar!.className).not.toContain('border-primary')
    expect(bar!.textContent).toContain('自动批准')
    expect(bar!.textContent).toContain('批准需逐步确认')
  })

  it('②开启态醒目色+文案切换（服务端投影回读=开——openSession 对齐）', async () => {
    await mountStream(stubApi('rpc', sessionOf('s-ap-on', { autoApprove: true })))

    const bar = document.querySelector('[data-testid="composer-auto-approve"]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.className).toContain('border-primary')
    expect(bar.textContent).toContain('自动批准·已开启')
    expect(bar.textContent).toContain('批准自动通过，无需值守')
    expect(getSessionAutoApprove()).toBe(true)
  })

  it('③点选开关→store 翻转（随下一条 followup 透传——透传断言在 sessionRoute.test.ts）', async () => {
    await mountStream(stubApi('rpc', sessionOf('s-ap', { autoApprove: false })))

    const sw = document.querySelector('[data-testid="composer-auto-approve-switch"]') as HTMLElement
    expect(sw).not.toBeNull()
    expect(getSessionAutoApprove()).toBe(false)
    sw.click()
    await vi.waitFor(() => expect(getSessionAutoApprove()).toBe(true))
    // 状态条随翻转切换醒目色。
    const bar = document.querySelector('[data-testid="composer-auto-approve"]') as HTMLElement
    await vi.waitFor(() => expect(bar.className).toContain('border-primary'))
  })

  it('④mock 演示模式不渲染（无服务端开关真源——与 attachable 同款门）', async () => {
    await mountStream(stubApi('mock', sessionOf('s-mock')))
    // MockAgentApi 触发 init（bindAgentApi 已注 stub——此处仅断言渲染缺席）。
    expect(document.querySelector('[data-testid="composer-auto-approve"]')).toBeNull()
    expect(getSessionAutoApprove()).toBe(false)
  })
})

void MockAgentApi
