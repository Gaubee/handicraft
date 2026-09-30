/*
 * [restructure-materials-story W2b] MyTasksSection（我的材料→我的任务）jsdom 测试。
 * fake MyTasksClient 注入（listSessions 翻页真切+getSession 任务投影）——覆盖：
 *   [1] 行清单：会话标题/更新时间/最新任务状态徽标（session.get 惰性补齐——
 *       末位任务=最新；无任务行=「无任务」；补齐失败=「—」）。
 *   [2] 加载更多：nextCursor→第二页追加。
 *   [3] 空态文案。
 *   [4] 进入会话：agentApi store openSession（前台活跃会话真源）+navigate('#/')。
 *   [5] 只读红线：无任何会话/任务写面调用（fake 面不实现写方法——编译期即无）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { SessionListInput, SessionListOutput, SessionSummary, TaskStatus } from '@handicraft/contracts'
import type { AgentApi, AgentTaskView } from '$lib/agentApi/types'
import MyTasksSection from '../../components/my-materials/MyTasksSection.svelte'
import { resetMyTasksForTests, type MyTasksClient } from '$lib/myMaterials/tasks.svelte'
import { bindAgentApi, getActiveSessionId, initAgentStore, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { resetSessionForTests } from '$lib/stores/session.svelte'
import { resetRouterForTests } from '$lib/router.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function sessionOf(id: string, title: string, updatedAt: string): SessionSummary {
  return { id, title, status: 'active', createdAt: updatedAt, updatedAt }
}

interface TasksFixtureOptions {
  sessions: SessionSummary[]
  /** 第二页（存在即启用游标翻页）。 */
  moreSessions?: SessionSummary[]
  /** 每会话任务投影（缺省=无任务行）。 */
  tasksBySession?: Record<string, Array<{ taskId: string; status: TaskStatus }>>
  /** 补齐失败名单（getSession 抛错——徽标落「—」）。 */
  failSessions?: string[]
}

function makeTasksFixture(options: TasksFixtureOptions): { client: MyTasksClient; calls: { list: Array<SessionListInput | undefined>; get: string[] } } {
  const calls = { list: [] as Array<SessionListInput | undefined>, get: [] as string[] }
  const client: MyTasksClient = {
    async listSessions(input?: SessionListInput): Promise<SessionListOutput> {
      calls.list.push(input)
      if (input?.cursor === undefined) {
        const hasMore = options.moreSessions !== undefined
        return {
          sessions: options.sessions,
          ...(hasMore ? { nextCursor: 'cursor-page-2' } : {}),
        }
      }
      return { sessions: options.moreSessions ?? [] }
    },
    async getSession(sessionId: string): Promise<{ tasks: Array<{ taskId: string; status: TaskStatus }> }> {
      calls.get.push(sessionId)
      if (options.failSessions?.includes(sessionId)) throw new Error(`会话不存在：${sessionId}`)
      return { tasks: options.tasksBySession?.[sessionId] ?? [] }
    },
  }
  return { client, calls }
}

function mountSection(client: MyTasksClient): void {
  resetMyTasksForTests(client)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(MyTasksSection, { target })
  mountedDisposers.push(() => {
    unmount(app)
    target.remove()
  })
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `选择器 ${selector} 应命中`).not.toBeNull()
  return el as HTMLElement
}

/** agentApi store stub（进入会话断言用——sessionUserSync.test 同式最小面）。 */
function stubAgentApi(sessions: SessionSummary[]): AgentApi {
  return {
    mode: 'mock',
    connection: () => 'mock' as const,
    onConnectionChange: () => () => {},
    listSessions: async () => ({ sessions }),
    createSession: async () => {
      throw new Error('本测试不触达')
    },
    getSession: async (sessionId: string) => {
      const found = sessions.find((candidate) => candidate.id === sessionId)
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
}

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  sessionStorage.clear()
  localStorage.clear()
  resetRouterForTests('#/admin/resources')
  resetAgentStoreForTests()
  resetSessionForTests({ username: 'boss', role: 'admin' })
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  resetMyTasksForTests()
  resetAgentStoreForTests()
})

describe('我的任务（W2b）', () => {
  it('行清单+惰性补齐：标题/更新时间/最新任务徽标（末位任务=最新；无任务行=无任务）', async () => {
    const now = '2026-09-30T08:00:00.000Z'
    const { client, calls } = makeTasksFixture({
      sessions: [
        sessionOf('s-snow', '圣诞雪人单', now),
        sessionOf('s-plain', '', now), // 空标题→未命名会话
      ],
      tasksBySession: {
        's-snow': [
          { taskId: 't-1', status: 'done' },
          { taskId: 't-2', status: 'running' }, // 末位=最新
        ],
      },
    })
    mountSection(client)
    await flush()

    // 首屏 50 行（limit=50）
    expect(calls.list).toHaveLength(1)
    expect(calls.list[0]).toEqual({ limit: 50 })
    // 行渲染
    const row = q('[data-testid="my-task-row-s-snow"]')
    expect(row.textContent).toContain('圣诞雪人单')
    expect(row.textContent).toContain('更新于')
    expect(q('[data-testid="my-task-row-s-plain"]').textContent).toContain('未命名会话')
    // 徽标：每会话 session.get 惰性补齐
    expect(calls.get.sort()).toEqual(['s-plain', 's-snow'])
    expect(q('[data-testid="my-task-badge-s-snow"]').textContent).toContain('运行中')
    expect(q('[data-testid="my-task-badge-s-plain"]').textContent).toContain('无任务')
    // 无游标=无加载更多
    expect(document.querySelector('[data-testid="my-tasks-load-more"]')).toBeNull()
  })

  it('补齐失败行：徽标落「——」不放大为整区错误', async () => {
    const { client } = makeTasksFixture({
      sessions: [sessionOf('s-gone', '已清理会话', '2026-09-30T08:00:00.000Z')],
      failSessions: ['s-gone'],
    })
    mountSection(client)
    await flush()

    expect(q('[data-testid="my-task-badge-s-gone"]').textContent).toContain('—')
    expect(document.querySelector('[data-testid="my-tasks-error"]')).toBeNull()
  })

  it('加载更多：nextCursor→第二页追加', async () => {
    const { client, calls } = makeTasksFixture({
      sessions: [sessionOf('s-1', '第一页', '2026-09-30T08:00:00.000Z')],
      moreSessions: [sessionOf('s-2', '第二页', '2026-09-29T08:00:00.000Z')],
    })
    mountSection(client)
    await flush()
    expect(q('[data-testid="my-task-row-s-1"]')).toBeDefined()

    q('[data-testid="my-tasks-load-more"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(calls.list).toHaveLength(2)
    expect(calls.list[1]).toEqual({ cursor: 'cursor-page-2', limit: 50 })
    expect(q('[data-testid="my-task-row-s-2"]')).toBeDefined()
    expect(q('[data-testid="my-task-row-s-1"]')).toBeDefined()
    // 第二页无游标=到底
    expect(document.querySelector('[data-testid="my-tasks-load-more"]')).toBeNull()
  })

  it('空态：暂无任务+前台新建会话引导', async () => {
    const { client } = makeTasksFixture({ sessions: [] })
    mountSection(client)
    await flush()

    expect(q('[data-testid="my-tasks-empty"]').textContent).toContain('暂无任务')
    expect(q('[data-testid="my-tasks-empty"]').textContent).toContain('前台新建会话')
  })

  it('进入会话：openSession（agentApi store 活跃会话真源）+hash 回前台壳', async () => {
    const sessions = [sessionOf('s-enter', '要进的会话', '2026-09-30T08:00:00.000Z')]
    const { client } = makeTasksFixture({ sessions })
    mountSection(client)
    await flush()
    // agentApi store 预绑 stub（进入会话动作的前台真源）
    bindAgentApi(stubAgentApi(sessions))
    await initAgentStore()

    q('[data-testid="my-task-enter-s-enter"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(50)

    expect(getActiveSessionId()).toBe('s-enter')
    expect(location.hash).toBe('#/')
  })
})
