/*
 * [add-backend-platform W3 评审 P2-2] RpcAgentApi 传输层测试。
 * 覆盖：①mutation 输出经 contracts schema 守门（漂移响应在 façade 拒绝——followup
 * 类型漂移 / clear 多余字段 strict 拒绝）；②首连失败不卡 connecting——进入重连状态机
 * （断线可见 + 有界指数退避），恢复后新调用可用；③重连退避有界（连续失败不超过上限）。
 * 传输桩：FakeWebSocket 以 oRPC standard-server-peer 线协议（{i,p:{u,b:{json}}} ↔
 * {i,p:{b:{json}}}）应答——不需要真实 daemon。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcAgentApi } from '$lib/agentApi/rpc'
import type { AgentConnectionState } from '$lib/agentApi/types'

/** 每测试注入的服务端行为（url → 结果；缺省路径返回 {}）。 */
let serve: (url: string, input: unknown) => unknown
/** 连接脚本：第 n 次（1 起）连接的行为；缺省 'serve'。 */
let connectScript: (attempt: number) => 'fail' | 'serve'
let connectCount = 0

interface FakeEvent {
  type: string
  data?: string
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly url: string
  readyState = 0
  private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>()

  constructor(url: string) {
    this.url = url
    connectCount += 1
    queueMicrotask(() => {
      if (connectScript(connectCount) === 'fail') {
        this.readyState = 3
        this.dispatch('error')
        this.dispatch('close')
      } else {
        this.readyState = 1
        this.dispatch('open')
      }
    })
  }

  send(data: string): void {
    const message = JSON.parse(data) as { i: number; p: { u: string; b?: { json?: unknown } } }
    const url = message.p.u
    const input = message.p.b?.json
    const result = serve(url, input)
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatch('message', JSON.stringify({ i: message.i, p: { b: { json: result } } }))
    })
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close')
  }

  private dispatch(type: string, data?: string): void {
    const event: FakeEvent = { type, data }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const stateLog: AgentConnectionState[] = []

function makeApi(): RpcAgentApi {
  return new RpcAgentApi({
    baseUrl: 'http://127.0.0.1:9',
    resolveToken: async () => 'test-token',
  })
}

beforeEach(() => {
  connectCount = 0
  connectScript = () => 'serve'
  serve = () => ({})
  stateLog.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RpcAgentApi：mutation 输出 schema 守门（P2-2）', () => {
  it('followup 类型漂移（taskId 非字符串）被契约拒绝', async () => {
    serve = (url) => (url === '/session/followup' ? { taskId: 12345 } : {})
    const api = makeApi()
    try {
      await expect(api.followup('s1', '漂移')).rejects.toThrow('session.followup 响应不符合契约')
    } finally {
      api.dispose()
    }
  })

  it('clear 多余字段被 strict 契约拒绝（漂移不穿透 façade）', async () => {
    serve = (url) => (url === '/session/clear' ? { ok: true, status: 'cleared', evil: 'drift' } : {})
    const api = makeApi()
    try {
      await expect(api.clear('s1')).rejects.toThrow('session.clear 响应不符合契约')
      // answer/cancel 守门同路径（call() 单点）——冒烟各一条。
      serve = (url) =>
        url === '/session/answer'
          ? { ok: 'yes' }
          : url === '/session/cancel'
            ? { ok: 1 }
            : {}
      await expect(api.answer('s1', 'r1', true)).rejects.toThrow('session.answer 响应不符合契约')
      await expect(api.cancel({ sessionId: 's1' })).rejects.toThrow('session.cancel 响应不符合契约')
    } finally {
      api.dispose()
    }
  })

  it('契约内响应正常通过（clear 返回清理中状态）', async () => {
    serve = (url) => (url === '/session/clear' ? { ok: true, status: 'clearing' } : {})
    const api = makeApi()
    try {
      await expect(api.clear('s1')).resolves.toEqual({ ok: true, status: 'clearing' })
    } finally {
      api.dispose()
    }
  })

  // [add-agent-three-channel 2.5] followup(mode) 透传：steer 显式携带，缺省不带
  // （线上形状与契约 mode optional 对齐——shufa b6cec8a 同式）。
  it('followup steer 模式透传（仅 steer 显式携带）', async () => {
    const seen: unknown[] = []
    serve = (url, input) => {
      if (url === '/session/followup') {
        seen.push(input)
        return { taskId: 't-steer' }
      }
      return {}
    }
    const api = makeApi()
    try {
      await expect(api.followup('s1', '往红偏', 'steer')).resolves.toEqual({ taskId: 't-steer' })
      await expect(api.followup('s1', '普通发送')).resolves.toEqual({ taskId: 't-steer' })
      expect(seen).toEqual([
        { sessionId: 's1', text: '往红偏', mode: 'steer' },
        { sessionId: 's1', text: '普通发送' },
      ])
    } finally {
      api.dispose()
    }
  })

  // [add-agent-three-channel 2.5] stopTask：tasks.stop 调用 + TaskView 输出守门
  // （漂移拒绝——打断≠终态取消，收口帧经帧流到达）。
  it('stopTask：合法 TaskView 通过；类型漂移被契约拒绝', async () => {
    const iso = new Date().toISOString()
    const view = { taskId: 't1', type: 'agent', status: 'done', createdAt: iso, updatedAt: iso }
    let stopCalled = 0
    serve = (url) => {
      if (url === '/tasks/stop') {
        stopCalled += 1
        return stopCalled === 1 ? view : { taskId: 12345 }
      }
      return {}
    }
    const api = makeApi()
    try {
      await expect(api.stopTask('t1')).resolves.toBeUndefined()
      expect(stopCalled).toBe(1)
      await expect(api.stopTask('t1')).rejects.toThrow('tasks.stop 响应不符合契约')
    } finally {
      api.dispose()
    }
  })
})

describe('RpcAgentApi：首连失败 → 重连状态机（P2-2）', () => {
  it('首连失败不卡 connecting：connecting→closed（断线可见）→有界退避→重试恢复 open', async () => {
    vi.useFakeTimers()
    // 前两次连接失败，第三次起可用。
    connectScript = (attempt) => (attempt <= 2 ? 'fail' : 'serve')
    serve = (url) =>
      url === '/session/list' ? { sessions: [] } : {}
    const api = makeApi()
    // onConnectionChange 订阅即快照当前态（初始 closed）——记录含首帧的完整序列。
    const states: AgentConnectionState[] = [api.connection()]
    api.onConnectionChange((state) => states.push(state))
    try {
      // 首次调用经历第一次失败：调用方收到错误，连接进入重连状态机。
      await expect(api.listSessions()).rejects.toThrow('WS 连接失败')
      expect(api.connection()).toBe('closed') // 断线可见（非 connecting 卡死）
      expect(states).toEqual(['closed', 'closed', 'connecting', 'closed']) // 首项=订阅快照

      // 退避 1（500ms）后第二次尝试仍失败 → 再退避（1000ms）。
      await vi.advanceTimersByTimeAsync(500)
      expect(api.connection()).toBe('closed')
      await vi.advanceTimersByTimeAsync(1000)
      // 第三次连接成功：状态收敛 open。
      await vi.advanceTimersByTimeAsync(1)
      expect(api.connection()).toBe('open')
      expect(states).toEqual([
        'closed',
        'closed',
        'connecting',
        'closed',
        'connecting',
        'closed',
        'connecting',
        'open',
      ])

      // 恢复后新调用可用（真实 RPC 往返）。
      await expect(api.listSessions()).resolves.toEqual({ sessions: [] })
    } finally {
      api.dispose()
    }
  })

  it('连续失败退避有界（封顶 15s）且成功后停止重连', async () => {
    vi.useFakeTimers()
    connectScript = () => 'fail'
    const api = makeApi()
    api.onConnectionChange((state) => stateLog.push(state))
    try {
      await expect(api.listSessions()).rejects.toThrow('WS 连接失败')
      // 快进 12 个 15s 窗口：退避 500→1000→…→15000 封顶，持续重试不断链。
      for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(15_000)
      expect(api.connection()).toBe('closed')
      const attemptsAfterStorm = connectCount
      expect(attemptsAfterStorm).toBeGreaterThan(5)

      // 服务恢复：下一次退避到期后连接成功，open 态不再重连。
      connectScript = () => 'serve'
      await vi.advanceTimersByTimeAsync(15_000)
      expect(api.connection()).toBe('open')
      const settled = connectCount
      await vi.advanceTimersByTimeAsync(30_000)
      expect(connectCount).toBe(settled) // open 态不再重连
    } finally {
      api.dispose()
    }
  })
})
