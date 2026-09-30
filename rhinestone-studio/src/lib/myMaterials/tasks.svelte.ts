/*
 * 「我的材料 → 我的任务」store（restructure-materials-story W2b，2026-09-30）。
 * 原始需求（Owner 故事·归档环）：每一单的任务随时回看——只读管理面。
 * 数据面（daemon 零改）：
 *   - 行清单：sessions.list（本人域——daemon listSessionsByOwner 按 owner 收窄，
 *     cursor+limit 翻页；投影=SessionSummary{id,title,status,createdAt,updatedAt}，
 *     **不含任务状态**）。
 *   - 最新任务状态：sessions.list 投影缺任务行 → 每会话 session.get 惰性补
 *     （tasks 按 created_at,id 升序——末位即最新；design §2.4 惰性补路径）。
 *     失败的会话行徽标落「—」，不放大为整区错误。
 * 进入会话：initAgentStore（幂等绑定）→ openSession（前台活跃会话真源）→
 * navigate('#/')（hash 路由回前台壳——前台无会话子路由，会话选择归 view/agentApi
 * store，router.svelte.ts 顶层三分发）。
 * 只读红线：本 store 不做任何任务/会话写操作（取消/清理属前台会话域）。
 * 正交意图：
 *   [1] 会话行清单（首屏 50+加载更多——cursor 翻页）。
 *   [2] 最新任务状态惰性补齐（有界并发+代数守卫）。
 *   [3] 进入会话导航。
 */

import type { SessionListInput, SessionListOutput, SessionSummary, TaskStatus } from '@handicraft/contracts'
import { navigate } from '$lib/router.svelte'
import { initAgentStore, openSession } from '$lib/agentApi/store.svelte'
import { RpcAgentApi } from '$lib/agentApi/rpc'

export type MyTasksLoadState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 任务区窄客户端（结构兼容 RpcAgentApi——管理面恒真实 daemon 数据，不随前台
 * mock 模式键漂移；测试注入 fake）。
 */
export interface MyTasksClient {
  listSessions(input?: SessionListInput): Promise<SessionListOutput>
  getSession(sessionId: string): Promise<{ tasks: Array<{ taskId: string; status: TaskStatus }> }>
}

export function defaultMyTasksClientFactory(): MyTasksClient {
  return new RpcAgentApi()
}

/** 最新任务投影（undefined=补齐中/失败——徽标落「—」；none=会话无任务行）。 */
export type LatestTaskView = { taskId: string; status: TaskStatus } | 'none'

/** 惰性补齐并发上限（首屏 50 行——分批避免单 WS 瞬时打满）。 */
const FILL_CHUNK = 8

let client: MyTasksClient | null = null
let sessions = $state<SessionSummary[]>([])
let nextCursor = $state<string | undefined>(undefined)
let loadingMore = $state(false)
let state = $state<MyTasksLoadState>('idle')
let errorMessage = $state<string | null>(null)
let latestBySession = $state<Record<string, LatestTaskView>>({})
/** 惰性补齐代数（清单刷新自增——迟到响应不写入新清单）。 */
let fillGeneration = 0
let initialized = false

/** 测试/装配注入。 */
export function bindMyTasksClient(next: MyTasksClient): void {
  client = next
}

function clientOf(): MyTasksClient {
  if (!client) client = defaultMyTasksClientFactory()
  return client
}

// ---------------------------------------------------------------- 读面

export function getMyTaskSessions(): SessionSummary[] {
  return sessions
}

export function getMyTasksNextCursor(): string | undefined {
  return nextCursor
}

export function getMyTasksState(): MyTasksLoadState {
  return state
}

export function getMyTasksError(): string | null {
  return errorMessage
}

export function isMyTasksLoadingMore(): boolean {
  return loadingMore
}

/** 会话行的最新任务投影（undefined=补齐中/失败）。 */
export function getMyTaskLatest(sessionId: string): LatestTaskView | undefined {
  return latestBySession[sessionId]
}

// ---------------------------------------------------------------- 生命周期

/** 面板挂载初始化（幂等——重复调用仅首次拉取；显式刷新走 refreshMyTasks）。 */
export async function initMyTasks(): Promise<void> {
  if (initialized) return
  initialized = true
  await refreshMyTasks()
}

export async function refreshMyTasks(): Promise<void> {
  state = 'loading'
  errorMessage = null
  fillGeneration += 1
  latestBySession = {} // 显式刷新=状态重新补齐（旧投影不留残影）
  try {
    const out = await clientOf().listSessions({ limit: 50 })
    sessions = out.sessions
    nextCursor = out.nextCursor
    state = 'ready'
    void fillLatestTasks()
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
    state = 'error'
  }
}

/** 加载更多（cursor 追加——无游标=已到底，no-op）。 */
export async function loadMoreMyTasks(): Promise<void> {
  if (nextCursor === undefined || loadingMore) return
  loadingMore = true
  try {
    const out = await clientOf().listSessions({ cursor: nextCursor, limit: 50 })
    sessions = [...sessions, ...out.sessions]
    nextCursor = out.nextCursor
    void fillLatestTasks()
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
  } finally {
    loadingMore = false
  }
}

/** 最新任务状态惰性补齐（有界并发分批+代数守卫——失败行留 undefined 呈「—」）。 */
async function fillLatestTasks(): Promise<void> {
  const generation = fillGeneration
  const pending = sessions.filter((session) => latestBySession[session.id] === undefined)
  for (let index = 0; index < pending.length; index += FILL_CHUNK) {
    if (generation !== fillGeneration) return
    const chunk = pending.slice(index, index + FILL_CHUNK)
    await Promise.all(
      chunk.map(async (session) => {
        try {
          const detail = await clientOf().getSession(session.id)
          if (generation !== fillGeneration) return
          const last = detail.tasks[detail.tasks.length - 1]
          latestBySession[session.id] = last === undefined ? 'none' : { taskId: last.taskId, status: last.status }
        } catch {
          // 单行补齐失败不放大（徽标落「—」——显式刷新可重试）。
        }
      }),
    )
  }
}

/**
 * 进入会话（「我的任务」行链接唯一动作）：先在前台会话真源（agentApi store）
 * 打开会话，再切路由回前台壳——次序保证 AgentView 挂载时 store 已初始化且
 * 活跃会话已定（initAgentStore 幂等；auto-open-first 被随后的 openSession 覆盖）。
 */
export async function enterMyTaskSession(sessionId: string): Promise<void> {
  await initAgentStore()
  await openSession(sessionId)
  navigate('#/')
}

export function resetMyTasksForTests(next?: MyTasksClient): void {
  client = next ?? null
  sessions = []
  nextCursor = undefined
  loadingMore = false
  state = 'idle'
  errorMessage = null
  latestBySession = {}
  fillGeneration = 0
  initialized = false
}
