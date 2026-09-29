/*
 * [波 5 P2-5] 会话列表随登录用户重取（登出换登录后旧用户列表残留修复）。
 * 覆盖：用户漂移（登录/登出/换号）→ 列表重取+活跃视图复位（首会话自动打开/
 * 空列表清视图）；未漂移 no-op（不重取）；AgentView 重挂载路径（initAgentStore
 * 二次调用）与显式 syncAgentSessionsForUser 双入口同语义。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@handicraft/contracts'
import {
  bindAgentApi,
  getActiveSessionId,
  getAgentSessions,
  initAgentStore,
  resetAgentStoreForTests,
  syncAgentSessionsForUser,
} from '$lib/agentApi/store.svelte'
import { resetSessionForTests } from '$lib/stores/session.svelte'
import type { AgentApi, AgentTaskView } from '$lib/agentApi/types'

function sessionOf(id: string, title: string): SessionSummary {
  const now = new Date().toISOString()
  return { id, title, status: 'active', createdAt: now, updatedAt: now }
}

/**
 * 用户域 stub API：list 可换（模拟 daemon 按 token 归属返回不同列表）；
 * listCalls 计数供 no-op 断言。getSession/replay/subscribeTask 最小面
 * （openSession 只消费这三者+sessionResult）。
 */
function stubApi(): { api: AgentApi; setList(next: SessionSummary[]): void; listCalls(): number } {
  let list: SessionSummary[] = []
  let calls = 0
  const api = {
    mode: 'mock',
    connection: () => 'mock' as const,
    onConnectionChange: () => () => {},
    listSessions: async () => {
      calls += 1
      return { sessions: [...list] }
    },
    createSession: async () => {
      throw new Error('本测试不触达')
    },
    getSession: async (sessionId: string) => {
      const found = list.find((candidate) => candidate.id === sessionId)
      if (!found) throw new Error(`会话不存在：${sessionId}`)
      const tasks: AgentTaskView[] = []
      return { session: found, tasks }
    },
    replay: async () => ({ frames: [], nextSeq: 0 }),
    subscribeTask: () => () => {},
    sessionResult: async () => {
      throw new Error('无结果')
    },
  } as unknown as AgentApi
  return { api, setList: (next) => (list = next), listCalls: () => calls }
}

beforeEach(() => {
  resetAgentStoreForTests()
  resetSessionForTests()
})

describe('会话列表随登录用户重取（P2-5）', () => {
  it('换号：列表重取为新用户域+活跃视图切到其首会话；登出：空域清视图', async () => {
    const stub = stubApi()
    bindAgentApi(stub.api)
    stub.setList([sessionOf('boss-1', '管理员会话'), sessionOf('boss-2', '管理员第二条')])
    resetSessionForTests({ username: 'boss', role: 'admin' })
    await initAgentStore()

    expect(getAgentSessions().map((s) => s.id)).toEqual(['boss-1', 'boss-2'])
    expect(getActiveSessionId()).toBe('boss-1')

    // 换号登录（走查场景：登出→登录页→换账号）：daemon 按新 token 返回其列表。
    stub.setList([sessionOf('worker-1', '成员会话')])
    resetSessionForTests({ username: 'worker', role: 'user' })
    await syncAgentSessionsForUser()

    expect(getAgentSessions().map((s) => s.id)).toEqual(['worker-1'])
    expect(getActiveSessionId()).toBe('worker-1')

    // 登出且匿名关（未登录域=空列表）：视图复位为空（旧用户残影不驻留）。
    stub.setList([])
    resetSessionForTests(null, false)
    await syncAgentSessionsForUser()

    expect(getAgentSessions()).toEqual([])
    expect(getActiveSessionId()).toBeNull()
  })

  it('未漂移 no-op：同一用户重复 sync 不重取列表', async () => {
    const stub = stubApi()
    bindAgentApi(stub.api)
    stub.setList([sessionOf('u-1', '会话')])
    resetSessionForTests({ username: 'boss', role: 'admin' })
    await initAgentStore()
    const callsAfterInit = stub.listCalls()

    await syncAgentSessionsForUser()
    await syncAgentSessionsForUser()
    expect(stub.listCalls()).toBe(callsAfterInit)
  })

  it('重挂载路径：AgentView 登录页往返重挂（initAgentStore 二次调用）同样对齐新用户', async () => {
    const stub = stubApi()
    bindAgentApi(stub.api)
    stub.setList([sessionOf('a-1', 'A 用户会话')])
    resetSessionForTests({ username: 'a', role: 'user' })
    await initAgentStore()

    // 登录页往返：AgentView 卸载→重挂（initialized 已真——旧实现在此直接 return，
    // 列表残留旧用户）。
    stub.setList([sessionOf('b-1', 'B 用户会话')])
    resetSessionForTests({ username: 'b', role: 'user' })
    await initAgentStore()

    expect(getAgentSessions().map((s) => s.id)).toEqual(['b-1'])
    expect(getActiveSessionId()).toBe('b-1')
  })
})
