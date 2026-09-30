/*
 * [restructure-materials-story W2b] MyTasksSection（我的材料→我的任务）jsdom 测试。
 * fake MyTasksClient 注入（listSessions 翻页真切+getSession 任务投影）——覆盖：
 *   [1] 行清单：会话标题/更新时间/最新任务状态徽标（session.get 惰性补齐——
 *       末位任务=最新；无任务行=「无任务」；补齐失败=「—」）。
 *   [2] 加载更多：nextCursor→第二页追加。
 *   [3] 空态文案。
 *   [4] 进入会话：agentApi store openSession（前台活跃会话真源）+navigate('#/')。
 *   [5] 只读红线：无任何会话/任务写面调用（fake 面不实现写方法——编译期即无）。
 * [product-polish-w1 T1] 行展开导出三件套（listSessionExports fake）——覆盖：
 *   [6] 展开：惰性取数一次（缓存——收起再展开不重复调）→按 imageId 分组渲染
 *       （图 1 标签/PNG 缩略 src/三下载链接/导出时间）；多图多组。
 *   [7] 空=「无导出产物」；失败=行内错误+重试；刷新=导出缓存重置。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { SessionListInput, SessionListOutput, SessionSummary, TaskStatus } from '@handicraft/contracts'
import type { AgentApi, AgentTaskView } from '$lib/agentApi/types'
import MyTasksSection from '../../components/my-materials/MyTasksSection.svelte'
import { refreshMyTasks, resetMyTasksForTests, type MyTasksClient } from '$lib/myMaterials/tasks.svelte'
import type { SessionExportRow } from '$lib/myMaterials/schemas'
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

/** 导出历史行 fixture（SessionExportRow——createdAt 控制每图最新取舍）。 */
function exportRow(input: Partial<SessionExportRow> & Pick<SessionExportRow, 'resultId' | 'publicId' | 'imageId'>): SessionExportRow {
  return {
    exportedByTaskId: 't-exporter',
    sourceTaskId: 't-source',
    createdAt: '2026-10-01T08:00:00.000Z',
    expiresAt: null,
    download: `/r/${input.publicId}`,
    ...input,
  }
}

interface TasksFixtureOptions {
  sessions: SessionSummary[]
  /** 第二页（存在即启用游标翻页）。 */
  moreSessions?: SessionSummary[]
  /** 每会话任务投影（缺省=无任务行）。 */
  tasksBySession?: Record<string, Array<{ taskId: string; status: TaskStatus }>>
  /** 补齐失败名单（getSession 抛错——徽标落「—」）。 */
  failSessions?: string[]
  /** 每会话导出历史（缺省=空清单——「无导出产物」）。 */
  exportsBySession?: Record<string, SessionExportRow[]>
  /** 导出历史失败名单（listSessionExports 抛错——行内错误+重试）。 */
  failExports?: string[]
}

function makeTasksFixture(options: TasksFixtureOptions): {
  client: MyTasksClient
  calls: { list: Array<SessionListInput | undefined>; get: string[]; exports: string[] }
} {
  const calls = { list: [] as Array<SessionListInput | undefined>, get: [] as string[], exports: [] as string[] }
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
    async listSessionExports(sessionId: string): Promise<{ exports: SessionExportRow[] }> {
      calls.exports.push(sessionId)
      if (options.failExports?.includes(sessionId)) throw new Error(`导出历史不可读：${sessionId}`)
      return { exports: options.exportsBySession?.[sessionId] ?? [] }
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

describe('我的任务 · 行展开导出三件套（product-polish-w1 T1）', () => {
  it('展开：惰性取数一次→按 imageId 分组渲染（图 1 标签/PNG 缩略/三下载链接/时间）；多图多组+每图取最新', async () => {
    const { client, calls } = makeTasksFixture({
      sessions: [sessionOf('s-snow', '雪人单', '2026-09-30T08:00:00.000Z')],
      tasksBySession: { 's-snow': [{ taskId: 't-2', status: 'done' }] },
      exportsBySession: {
        's-snow': [
          // image-1 重导出两组（createdAt 更晚者胜）+ image-2 一组 → 两图两组。
          exportRow({ resultId: 'r-old', publicId: 'pubold', imageId: 'image-1', createdAt: '2026-09-29T08:00:00.000Z' }),
          exportRow({ resultId: 'r-new', publicId: 'pubnew', imageId: 'image-1', createdAt: '2026-09-30T08:00:00.000Z' }),
          exportRow({ resultId: 'r-two', publicId: 'pubtwo', imageId: 'image-2', createdAt: '2026-09-29T08:00:00.000Z' }),
        ],
      },
    })
    mountSection(client)
    await flush()
    // 未展开=不取数
    expect(calls.exports).toHaveLength(0)

    q('[data-testid="my-task-toggle-s-snow"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(calls.exports).toEqual(['s-snow'])
    const panel = q('[data-testid="my-task-exports-s-snow"]')
    // 两图两组；image-1 取最新 r-new（pubnew）
    expect(panel.querySelectorAll('[data-testid^="my-task-export-group-"]')).toHaveLength(2)
    expect(panel.textContent).toContain('图 1')
    expect(panel.textContent).toContain('图 2')
    const png = q('[data-testid="my-task-export-image-1-png"]') as HTMLAnchorElement
    expect(png.getAttribute('href')).toBe('/r/pubnew/files/png')
    expect(png.querySelector('img')?.getAttribute('src')).toBe('/r/pubnew/files/png')
    expect(q('[data-testid="my-task-export-image-1-svg"]').getAttribute('href')).toBe('/r/pubnew/files/svg')
    expect(q('[data-testid="my-task-export-image-1-svg"]').textContent).toContain('layout.svg')
    expect(q('[data-testid="my-task-export-image-1-bom"]').getAttribute('href')).toBe('/r/pubnew/files/bom')
    expect(q('[data-testid="my-task-export-image-1-bom"]').textContent).toContain('bom.csv')
    expect(q('[data-testid="my-task-export-image-2-png"]').getAttribute('href')).toBe('/r/pubtwo/files/png')
    expect(panel.textContent).toContain('导出于')

    // 收起再展开：缓存命中（不重复调）
    q('[data-testid="my-task-toggle-s-snow"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    q('[data-testid="my-task-toggle-s-snow"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(calls.exports).toHaveLength(1)
  })

  it('无导出=「无导出产物」不占空间；失败=行内错误+重试再取', async () => {
    const { client, calls } = makeTasksFixture({
      sessions: [sessionOf('s-none', '没导出的单', '2026-09-30T08:00:00.000Z'), sessionOf('s-bad', '读不出的单', '2026-09-30T08:00:00.000Z')],
      failExports: ['s-bad'],
    })
    mountSection(client)
    await flush()

    // 空清单：如实「无导出产物」
    q('[data-testid="my-task-toggle-s-none"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(q('[data-testid="my-task-exports-s-none"]').textContent).toContain('无导出产物')

    // 失败：行内错误（不放大为整区错误）+重试
    q('[data-testid="my-task-toggle-s-bad"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(q('[data-testid="my-task-exports-error-s-bad"]').textContent).toContain('导出清单加载失败')
    expect(document.querySelector('[data-testid="my-tasks-error"]')).toBeNull()
    q('[data-testid="my-task-exports-retry-s-bad"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(calls.exports.filter((id) => id === 's-bad')).toHaveLength(2)
  })

  it('显式刷新重置导出缓存（已展开行重新取数）', async () => {
    const { client, calls } = makeTasksFixture({
      sessions: [sessionOf('s-fresh', '要刷新的单', '2026-09-30T08:00:00.000Z')],
      exportsBySession: {
        's-fresh': [exportRow({ resultId: 'r-1', publicId: 'pub1', imageId: 'image-1' })],
      },
    })
    mountSection(client)
    await flush()
    q('[data-testid="my-task-toggle-s-fresh"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(calls.exports).toEqual(['s-fresh'])

    await refreshMyTasks()
    await flush()
    // 刷新后行仍在清单（fixture 同款）——展开态收起（视图本地），再次展开重取
    q('[data-testid="my-task-toggle-s-fresh"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    q('[data-testid="my-task-toggle-s-fresh"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    q('[data-testid="my-task-toggle-s-fresh"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(calls.exports).toEqual(['s-fresh', 's-fresh'])
  })
})
