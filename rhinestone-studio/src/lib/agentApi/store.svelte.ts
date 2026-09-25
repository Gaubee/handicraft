/*
 * Agent 会话 store（Svelte 5 runes——W3.1 Agent 主面的唯一状态源）。
 * 职责：会话列表/活跃会话/帧流缓冲（task 域 seq 去重——断线重连重订阅后
 * afterSeq 游标回放无缺失无重复）/审批应答/取消与清空/结果获取/连接态投影。
 * mock 与 rpc 双模式经 AgentApi 注入（默认 mock——W4 接线换 rpc）。
 */

import type { Frame, SessionSummary } from '@handicraft/contracts'
import { defaultAgentApiFactory } from './index.js'
import type { AgentApi, AgentConnectionState, AgentResultView, AgentTaskView } from './types.js'

export interface PendingApproval {
  requestId: string
  tool: string
  proposalId: string
  summary: string
  expiresAt: string
  preview: { before: string; after: string }
  taskId: string
}

let api: AgentApi | null = null
let mode = $state<'mock' | 'rpc'>('mock')
let connection = $state<AgentConnectionState>('mock')
let sessions = $state<SessionSummary[]>([])
let listCursor = $state<string | undefined>(undefined)
let activeSessionId = $state<string | null>(null)
let activeTasks = $state<AgentTaskView[]>([])
let framesByTask = $state<Record<string, Frame[]>>({})
let resultBySession = $state<Record<string, AgentResultView>>({})
let sending = $state(false)
let creating = $state(false)
let clearing = $state(false)
let cancelling = $state(false)
let storeError = $state<string | null>(null)
let initialized = $state(false)

const unsubscribers = new Map<string, () => void>()
let connectionUnsubscribe: (() => void) | null = null

export function getAgentMode(): 'mock' | 'rpc' {
  return mode
}

export function getAgentConnection(): AgentConnectionState {
  return connection
}

export function getAgentSessions(): SessionSummary[] {
  return sessions
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}

export function getActiveSession(): SessionSummary | null {
  return sessions.find((candidate) => candidate.id === activeSessionId) ?? null
}

export function getActiveTasks(): AgentTaskView[] {
  return activeTasks
}

export function isAgentSending(): boolean {
  return sending
}

export function isAgentCreating(): boolean {
  return creating
}

export function isAgentClearing(): boolean {
  return clearing
}

export function isAgentCancelling(): boolean {
  return cancelling
}

export function getAgentError(): string | null {
  return storeError
}

/** 活跃会话的会话流：按任务序拼接全部帧（对话连续视图）。 */
export function getActiveSessionFrames(): Frame[] {
  const out: Frame[] = []
  for (const task of activeTasks) {
    const frames = framesByTask[task.taskId]
    if (frames) out.push(...frames)
  }
  return out
}

/** 活跃会话的按任务帧组（P3.2-channel：工件引用的任务溯源——taskId 随帧透出）。 */
export function getActiveSessionTaskFrames(): Array<{ taskId: string; frames: Frame[] }> {
  return activeTasks.map((task) => ({ taskId: task.taskId, frames: framesByTask[task.taskId] ?? [] }))
}

/** 当前绑定的 API 实现（未绑定 null——策略工件通道等后置消费者守门）。 */
export function getBoundAgentApi(): AgentApi | null {
  return api
}

/** 活跃会话最新任务（followup 产生的正在进行的任务）。 */
export function getActiveTask(): AgentTaskView | null {
  return activeTasks.length > 0 ? (activeTasks[activeTasks.length - 1] ?? null) : null
}

export function getSessionResult(sessionId: string | null): AgentResultView | null {
  if (sessionId === null) return null
  return resultBySession[sessionId] ?? null
}

/** 未应答审批（approval-request 无对应 approval-resolved——会话流内派生）。 */
export function getPendingApproval(): PendingApproval | null {
  const frames = getActiveSessionFrames()
  let pending: PendingApproval | null = null
  const resolved = new Set<string>()
  for (const frame of frames) {
    if (frame.kind === 'approval-request') {
      pending = {
        requestId: frame.payload.requestId,
        tool: frame.payload.tool,
        proposalId: frame.payload.proposalId,
        summary: frame.payload.summary,
        expiresAt: frame.payload.expiresAt,
        preview: { before: frame.payload.preview.before, after: frame.payload.preview.after },
        taskId: activeTaskOfFrame(frame)?.taskId ?? '',
      }
    } else if (frame.kind === 'approval-resolved') {
      resolved.add(frame.payload.requestId)
      if (pending?.requestId === frame.payload.requestId) pending = null
    }
  }
  if (pending !== null && resolved.has(pending.requestId)) return null
  return pending
}

function activeTaskOfFrame(_frame: Frame): AgentTaskView | null {
  return getActiveTask()
}

// ---------------------------------------------------------------- 生命周期

/** 注入 API 实现（生产走 factory；测试注 mock 实例）。幂等——重复调用仅换实现。 */
export function bindAgentApi(next: AgentApi): void {
  if (connectionUnsubscribe) connectionUnsubscribe()
  for (const unsub of unsubscribers.values()) unsub()
  unsubscribers.clear()
  api = next
  mode = next.mode
  connectionUnsubscribe = next.onConnectionChange((state) => {
    const wasOpen = connection === 'open'
    connection = state
    // rpc 断线重连后：活跃任务按 lastSeq 游标重订阅（回放补齐窗口内帧）。
    if (state === 'open' && wasOpen) resubscribeActiveTasks()
  })
  connection = next.connection()
}

/** 首次进入 Agent 主面：拉列表 + 自动打开最近会话（已绑定 API 不重复绑定——测试注入面）。 */
export async function initAgentStore(next?: AgentApi): Promise<void> {
  if (next) bindAgentApi(next)
  else if (!api) bindAgentApi(defaultAgentApiFactory())
  if (!api) throw new Error('Agent API 未绑定')
  if (initialized) return
  initialized = true
  await refreshSessions()
  const first = sessions[0]
  if (first) await openSession(first.id)
}

export function resetAgentStoreForTests(): void {
  if (connectionUnsubscribe) connectionUnsubscribe()
  for (const unsub of unsubscribers.values()) unsub()
  unsubscribers.clear()
  connectionUnsubscribe = null
  api = null
  mode = 'mock'
  connection = 'mock'
  sessions = []
  listCursor = undefined
  activeSessionId = null
  activeTasks = []
  framesByTask = {}
  resultBySession = {}
  sending = false
  creating = false
  clearing = false
  cancelling = false
  storeError = null
  initialized = false
}

async function guard(run: () => Promise<void>): Promise<void> {
  storeError = null
  try {
    await run()
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error)
  }
}

export async function refreshSessions(): Promise<void> {
  await guard(async () => {
    const out = await api!.listSessions({ limit: 100 })
    sessions = out.sessions
    listCursor = out.nextCursor
  })
}

export async function openSession(sessionId: string): Promise<void> {
  await guard(async () => {
    unsubscribeAll()
    activeSessionId = sessionId
    framesByTask = {}
    const detail = await api!.getSession(sessionId)
    activeTasks = detail.tasks
    for (const task of detail.tasks) {
      const replay = await api!.replay(sessionId, task.taskId, 0)
      framesByTask[task.taskId] = replay.frames
      subscribeTask(task.taskId, replay.nextSeq)
    }
    await tryLoadResult(sessionId)
  })
}

export async function createSession(title?: string): Promise<void> {
  await guard(async () => {
    creating = true
    try {
      const created = await api!.createSession({ title })
      await refreshSessions()
      await openSession(created.sessionId)
    } finally {
      creating = false
    }
  })
}

/** 一次 followup=一个 task：建任务后从 seq 0 订阅（user transcript 帧由流返回）。 */
export async function sendFollowup(text: string): Promise<void> {
  const sessionId = activeSessionId
  const trimmed = text.trim()
  if (sessionId === null || trimmed === '' || sending) return
  await guard(async () => {
    sending = true
    try {
      const { taskId } = await api!.followup(sessionId, trimmed)
      framesByTask[taskId] = []
      activeTasks = [...activeTasks, { taskId, status: 'running', lastSeq: 0, frameCount: 0 }]
      subscribeTask(taskId, 0)
    } finally {
      sending = false
    }
  })
}

export async function answerApproval(requestId: string, approved: boolean): Promise<void> {
  const sessionId = activeSessionId
  if (sessionId === null) return
  await guard(async () => {
    await api!.answer(sessionId, requestId, approved)
  })
}

export async function cancelActiveTask(): Promise<void> {
  const task = getActiveTask()
  if (task === null) return
  await guard(async () => {
    cancelling = true
    try {
      await api!.cancel({ taskId: task.taskId })
      activeTasks = activeTasks.map((candidate) =>
        candidate.taskId === task.taskId ? { ...candidate, status: 'cancelled' } : candidate,
      )
    } finally {
      cancelling = false
    }
  })
}

export async function clearActiveSession(): Promise<void> {
  const sessionId = activeSessionId
  if (sessionId === null) return
  await guard(async () => {
    clearing = true
    try {
      await api!.clear(sessionId)
      unsubscribeAll()
      activeSessionId = null
      activeTasks = []
      framesByTask = {}
      delete resultBySession[sessionId]
      await refreshSessions()
      // clearing 中会话（文件删除失败待重试）仍在列表——不复打开被清空的那个。
      const first = sessions.find((candidate) => candidate.id !== sessionId)
      if (first) await openSession(first.id)
    } finally {
      clearing = false
    }
  })
}

/** 复制分享链接（结果存在时）。 */
export function shareUrlOf(result: AgentResultView): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:8317'
  return `${origin}/r/${result.publicId ?? ''}`
}

// ---------------------------------------------------------------- 帧摄入

function subscribeTask(taskId: string, afterSeq: number): void {
  const unsub = api!.subscribeTask(taskId, afterSeq, (frame) => ingestFrame(taskId, frame))
  unsubscribers.set(taskId, unsub)
}

function ingestFrame(taskId: string, frame: Frame): void {
  // task 域 seq 单调去重：重连回放窗口与实时流可能交叠——seq 不前进即丢弃。
  const buffer = framesByTask[taskId] ?? []
  const lastSeq = buffer.length > 0 ? buffer[buffer.length - 1]!.seq : 0
  if (frame.seq <= lastSeq) return
  framesByTask[taskId] = [...buffer, frame]
  activeTasks = activeTasks.map((task) =>
    task.taskId === taskId
      ? { ...task, lastSeq: frame.seq, frameCount: frame.seq, status: task.status === 'queued' ? 'running' : task.status }
      : task,
  )
  if (frame.kind === 'done' || frame.kind === 'error') {
    activeTasks = activeTasks.map((task) => (task.taskId === taskId ? { ...task, status: frame.kind === 'done' ? 'done' : 'failed' } : task))
    if (frame.kind === 'done' && activeSessionId !== null) void tryLoadResult(activeSessionId)
  }
}

function resubscribeActiveTasks(): void {
  if (activeSessionId === null) return
  for (const task of activeTasks) {
    const buffer = framesByTask[task.taskId] ?? []
    const lastSeq = buffer.length > 0 ? buffer[buffer.length - 1]!.seq : 0
    const existing = unsubscribers.get(task.taskId)
    if (existing) existing()
    subscribeTask(task.taskId, lastSeq)
  }
}

async function tryLoadResult(sessionId: string): Promise<void> {
  try {
    const result = await api!.sessionResult(sessionId)
    resultBySession[sessionId] = result
  } catch {
    // 无结果是常态（未完成/无产物）——不占用错误面。
  }
}

function unsubscribeAll(): void {
  for (const unsub of unsubscribers.values()) unsub()
  unsubscribers.clear()
}
