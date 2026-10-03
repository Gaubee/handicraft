/*
 * [Owner 报障 2026-10-03「左侧会话列表始终加载不出来」] 连接恢复补拉回归。
 * 事故形态：首载 listSessions 恰落服务端重启断线窗口（WS close）→ 列表空 +
 * storeError，此后 rpc 重连恢复（open）也无重试路径——侧栏永久空。
 * 修复语义：连接 open（含重连）时列表仍空则补拉一次；refreshSessions 带
 * in-flight 守卫（首载与补拉不并发重复）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import {
  bindAgentApi,
  getAgentError,
  getAgentSessions,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import type { AgentApi, AgentConnectionState } from '$lib/agentApi/types'
import type { SessionSummary } from '@handicraft/contracts'

function sessionOf(id: string): SessionSummary {
  const iso = new Date().toISOString()
  return { id, title: `会话 ${id}`, status: 'active', createdAt: iso, updatedAt: iso }
}

/** 可控连接态 + 首次 listSessions 失败的 stub（重连 open 后第二次成功）。 */
function flakyApi(): AgentApi & { simulateReconnect(): void } {
  let listCalls = 0
  let state: AgentConnectionState = 'closed'
  const listeners = new Set<(state: AgentConnectionState) => void>()
  return {
    mode: 'rpc',
    connection: () => state,
    onConnectionChange: (listener: (state: AgentConnectionState) => void) => {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    listSessions: async () => {
      listCalls += 1
      if (listCalls === 1) throw new Error('WS 断线：listSessions 失败')
      return { sessions: [sessionOf('s1')] }
    },
    createSession: async () => ({ sessionId: 's-new', createdAt: new Date().toISOString() }),
    getSession: async () => ({ session: sessionOf('s1'), tasks: [] }),
    followup: async () => ({ taskId: 't-x' }),
    setAutoApprove: async () => ({ ok: true, autoApprove: false }),
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
    simulateReconnect: () => {
      state = 'open'
      for (const listener of listeners) listener('open')
    },
  } as unknown as AgentApi & { simulateReconnect: () => void }
}

describe('连接恢复补拉（Owner 报障 2026-10-03）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    resetSessionRouteForTests('')
  })

  afterEach(async () => {
    await tick()
  })

  it('首载失败→列表空+错误；重连 open 后自动补拉恢复列表', async () => {
    const api = flakyApi()
    bindAgentApi(api)
    await initAgentStore()

    // 首载落断线窗口：列表空 + storeError 在场（侧栏加载不出来=事故形态）。
    expect(getAgentSessions()).toEqual([])
    expect(getAgentError()).toContain('WS 断线')

    // rpc 重连恢复（open 事件）→ 列表仍空 → 自动补拉。
    api.simulateReconnect()
    await vi.waitFor(() => expect(getAgentSessions().length).toBe(1))
    expect(getAgentSessions()[0]?.id).toBe('s1')
  })

  it('[Codex P1-2] open 事件恰逢首载在途→首载失败→finally 自动补拉（不依赖新 open）', async () => {
    // 交错时序：listSessions 挂起 → open 到达（in-flight 守卫跳过+记 pending）→
    // 首载 reject → pending 生效自动第二次拉取成功。
    let release: (() => void) | null = null
    let listCalls = 0
    const listeners = new Set<(state: AgentConnectionState) => void>()
    let state: AgentConnectionState = 'closed'
    const api = {
      mode: 'rpc',
      connection: () => state,
      onConnectionChange: (listener: (state: AgentConnectionState) => void) => {
        listeners.add(listener)
        listener(state)
        return () => listeners.delete(listener)
      },
      listSessions: () =>
        new Promise<{ sessions: SessionSummary[] }>((resolve, reject) => {
          listCalls += 1
          if (listCalls === 1) {
            release = () => reject(new Error('首载失败（断线窗口）'))
          } else {
            resolve({ sessions: [sessionOf('s-race')] })
          }
        }),
      createSession: async () => ({ sessionId: 's-new', createdAt: new Date().toISOString() }),
      getSession: async () => ({ session: sessionOf('s-race'), tasks: [] }),
      followup: async () => ({ taskId: 't-x' }),
      setAutoApprove: async () => ({ ok: true, autoApprove: false }),
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
    bindAgentApi(api)
    const initPromise = initAgentStore() // 首载挂起（listSessions pending）
    // open 到达——首载在途，守卫跳过但记 pending。
    state = 'open'
    for (const listener of listeners) listener('open')
    // 首载失败落定 → pending 自动补拉（无新 open 事件）。
    release!()
    await initPromise
    await vi.waitFor(() => expect(getAgentSessions().length).toBe(1))
    expect(getAgentSessions()[0]?.id).toBe('s-race')
    expect(listCalls).toBe(2)
  })

  it('列表非空时重连不补拉（既有数据不闪刷）', async () => {
    let listCalls = 0
    const listeners = new Set<(state: AgentConnectionState) => void>()
    let state: AgentConnectionState = 'open'
    const api = {
      mode: 'rpc',
      connection: () => state,
      onConnectionChange: (listener: (state: AgentConnectionState) => void) => {
        listeners.add(listener)
        listener(state)
        return () => listeners.delete(listener)
      },
      listSessions: async () => {
        listCalls += 1
        return { sessions: [sessionOf('s-ok')] }
      },
      createSession: async () => ({ sessionId: 's-new', createdAt: new Date().toISOString() }),
      getSession: async () => ({ session: sessionOf('s-ok'), tasks: [] }),
      followup: async () => ({ taskId: 't-x' }),
      setAutoApprove: async () => ({ ok: true, autoApprove: false }),
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
    bindAgentApi(api)
    await initAgentStore()
    expect(getAgentSessions().length).toBe(1)

    // 模拟断线→重连全周期：列表已有数据 → 不重复拉。
    state = 'closed'
    for (const listener of listeners) listener('closed')
    state = 'open'
    for (const listener of listeners) listener('open')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(listCalls).toBe(1)
    expect(getAgentSessions()[0]?.id).toBe('s-ok')
  })
})
