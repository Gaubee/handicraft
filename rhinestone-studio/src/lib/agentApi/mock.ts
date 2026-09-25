/*
 * Mock 适配器（design §3.5 开发序：W3 UI 按固定 fixture 帧序列开发）。
 * mock 完成不构成 MVP——W4 接线联调（W4.4）才是产品验收门。
 * 行为面：固定 fixture 会话（含已完成结果）+ followup 脚本流（transcript→
 * progress→approval-request 门→resolved 分支→artifact→done）+ afterSeq 回放 +
 * cancel/clear 状态投影 + 审批应答门。时间倍率 speed 供测试加速（0=立即）。
 */

import {
  replayWindow,
  selectSessionResult,
  type Frame,
  type SessionListInput,
  type SessionListOutput,
} from '@handicraft/contracts'
import {
  FIXTURE_APPROVED_TAIL,
  FIXTURE_BLOB_REFS,
  FIXTURE_FOLLOWUP_SCRIPT,
  FIXTURE_REJECTED_TAIL,
  FIXTURE_SESSIONS,
  fixtureResultFor,
  type FixtureScriptFrame,
} from './fixtures.js'
import {
  STRATEGY_FIXTURE_BLOB_REFS,
  STRATEGY_FIXTURE_CODE_ARTIFACT,
  STRATEGY_FIXTURE_GEMS,
  STRATEGY_FIXTURE_PLAN,
  STRATEGY_FIXTURE_TREE,
} from '../strategyDesigner/fixtures.js'
import type {
  AgentApi,
  AgentConnectionState,
  AgentResultView,
  AgentSessionView,
  AgentTaskView,
} from './types.js'
import type { TaskArtifactInput, TaskArtifactOutput } from '@handicraft/contracts'

interface MockTask {
  id: string
  status: AgentTaskView['status']
  frames: Frame[]
  /** 完成时刻（ISO——status 转入 done 时记录；sessionResult 的确定性选择输入）。 */
  completedAt?: string
  script?: {
    queue: FixtureScriptFrame[]
    timer: ReturnType<typeof setTimeout> | null
    /** 审批门挂起态（requestId → resolve）。 */
    gate: { requestId: string; resolve: (approved: boolean) => void } | null
  } | null
}

/** 1×1 透明 PNG（工件字节 mock——预览/原图 dataUrl 形态即可，jsdom 不解码像素）。 */
const MOCK_PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

interface MockSession {
  id: string
  title: string
  status: 'active' | 'clearing' | 'cleared'
  createdAt: string
  updatedAt: string
  tasks: MockTask[]
  result?: { resultId: string; publicId: string; taskId: string }
}

export interface MockAgentApiOptions {
  /** 延迟倍率（默认 1；测试传 0=立即发射）。 */
  speed?: number
  /** 时钟注入（默认真实 ISO——测试控制 completedAt 以覆盖确定性选择语义）。 */
  now?: () => string
}

export class MockAgentApi implements AgentApi {
  readonly mode = 'mock' as const
  private readonly sessions: MockSession[]
  private readonly listeners = new Map<string, Set<(frame: Frame) => void>>()
  private readonly connectionListeners = new Set<(state: AgentConnectionState) => void>()
  private readonly speed: number
  private readonly now: () => string
  private seq = 0

  constructor(options: MockAgentApiOptions = {}) {
    this.speed = options.speed ?? 1
    this.now = options.now ?? (() => new Date().toISOString())
    this.sessions = FIXTURE_SESSIONS.map((seed) => ({
      ...seed,
      tasks: seed.tasks.map((task) => ({
        ...task,
        frames: [...task.frames],
        // 预置已完成任务的 completedAt 从其 done 帧时间戳派生（确定性回放）。
        ...(task.status === 'done' && task.frames.length > 0
          ? { completedAt: new Date(task.frames[task.frames.length - 1]!.ts).toISOString() }
          : {}),
      })),
    }))
  }

  connection(): AgentConnectionState {
    return 'mock'
  }

  onConnectionChange(listener: (state: AgentConnectionState) => void): () => void {
    this.connectionListeners.add(listener)
    listener('mock')
    return () => this.connectionListeners.delete(listener)
  }

  // ---------------------------------------------------------------- 会话生命周期

  async listSessions(input: SessionListInput = {}): Promise<SessionListOutput> {
    const limit = input.limit ?? 50
    const visible = this.sessions
      .filter((s) => s.status !== 'cleared')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id.localeCompare(a.id)))
    let page = visible
    if (input.cursor) {
      const anchor = this.sessions.find((s) => s.id === input.cursor)
      if (!anchor) return { sessions: [] }
      page = visible.filter(
        (s) => s.createdAt < anchor.createdAt || (s.createdAt === anchor.createdAt && s.id < anchor.id),
      )
    }
    const slice = page.slice(0, limit).map((s) => this.toSummary(s))
    const nextCursor = page.length > limit ? slice[slice.length - 1]?.id : undefined
    return { sessions: slice, ...(nextCursor !== undefined ? { nextCursor } : {}) }
  }

  async createSession(input: { title?: string }): Promise<{ sessionId: string; createdAt: string }> {
    this.seq += 1
    const session: MockSession = {
      id: `mock-session-${Date.now().toString(36)}-${this.seq}`,
      title: input.title ?? `新会话 ${this.seq}`,
      status: 'active',
      createdAt: this.now(),
      updatedAt: this.now(),
      tasks: [],
    }
    this.sessions.push(session)
    return { sessionId: session.id, createdAt: session.createdAt }
  }

  async getSession(sessionId: string): Promise<{ session: AgentSessionView; tasks: AgentTaskView[] }> {
    const session = this.require(sessionId)
    return {
      session: this.toSummary(session),
      tasks: session.tasks.map((task) => ({
        taskId: task.id,
        status: task.status,
        lastSeq: task.frames.length > 0 ? task.frames[task.frames.length - 1]!.seq : 0,
        frameCount: task.frames.length,
      })),
    }
  }

  // ---------------------------------------------------------------- followup 与帧流

  async followup(sessionId: string, text: string): Promise<{ taskId: string }> {
    const session = this.require(sessionId)
    if (session.status !== 'active') throw new Error(session.status === 'clearing' ? '会话正在清理，拒绝新输入' : '会话已清理')
    this.seq += 1
    const taskId = `mock-task-${Date.now().toString(36)}-${this.seq}`
    const task: MockTask = { id: taskId, status: 'running', frames: [] }
    session.tasks.push(task)
    session.updatedAt = this.now()
    const script = FIXTURE_FOLLOWUP_SCRIPT.map((step) =>
      step.kind === 'transcript' && (step.payload as { role?: string }).role === 'user'
        ? { ...step, payload: { role: 'user' as const, text } }
        : step.kind === 'approval-request'
          ? { ...step, payload: { ...(step.payload as object), requestId: `mock-req-${taskId}` } }
          : step,
    )
    task.script = { queue: script, timer: null, gate: null }
    this.runScript(task)
    return { taskId }
  }

  async answer(sessionId: string, requestId: string, approved: boolean): Promise<{ ok: boolean }> {
    const session = this.require(sessionId)
    const task = session.tasks.find((candidate) => candidate.script?.gate?.requestId === requestId)
    if (!task?.script?.gate) return { ok: false }
    const gate = task.script.gate
    task.script.gate = null
    this.append(task, 'approval-resolved', { requestId, approved, resolvedAt: this.now() })
    gate.resolve(approved)
    return { ok: true }
  }

  async cancel(input: { sessionId?: string; taskId?: string }): Promise<{ ok: boolean }> {
    if (input.taskId) {
      const task = this.sessions.flatMap((s) => s.tasks).find((candidate) => candidate.id === input.taskId)
      if (task) this.stopTask(task, 'cancelled')
      return { ok: true }
    }
    if (!input.sessionId) throw new Error('sessionId 与 taskId 必须二选一')
    const session = this.require(input.sessionId)
    for (const task of session.tasks) this.stopTask(task, 'cancelled')
    return { ok: true }
  }

  async clear(sessionId: string): Promise<{ ok: boolean; status: 'cleared' | 'clearing' }> {
    const session = this.require(sessionId)
    if (session.status === 'cleared') return { ok: true, status: 'cleared' }
    for (const task of session.tasks) this.stopTask(task, 'cancelled')
    session.status = 'cleared'
    session.updatedAt = this.now()
    return { ok: true, status: 'cleared' }
  }

  async replay(sessionId: string, taskId: string, afterSeq: number): Promise<{ frames: Frame[]; nextSeq: number }> {
    this.require(sessionId)
    const task = this.requireTask(sessionId, taskId)
    const frames = replayWindow(task.frames, afterSeq)
    const nextSeq = frames.length > 0 ? frames[frames.length - 1]!.seq : afterSeq
    return { frames, nextSeq }
  }

  subscribeTask(taskId: string, afterSeq: number, onFrame: (frame: Frame) => void): () => void {
    const task = this.sessions.flatMap((s) => s.tasks).find((candidate) => candidate.id === taskId)
    // 先回放持久帧，再挂 live 订阅（同一同步块——无缺失无重复）。
    if (task) for (const frame of replayWindow(task.frames, afterSeq)) onFrame(frame)
    let set = this.listeners.get(taskId)
    if (!set) {
      set = new Set()
      this.listeners.set(taskId, set)
    }
    set.add(onFrame)
    return () => {
      set!.delete(onFrame)
      if (set!.size === 0) this.listeners.delete(taskId)
    }
  }

  // ---------------------------------------------------------------- 结果

  async sessionResult(sessionId: string): Promise<AgentResultView> {
    const session = this.require(sessionId)
    // 预置结果优先（fixture 会话的既有分享）；动态会话回落确定性选择。
    if (session.result && session.tasks.some((task) => task.id === session.result!.taskId && task.status === 'done')) {
      return this.resultView(session.result.resultId, session.result.publicId, session.result.taskId)
    }
    // contracts selectSessionResult 同源（W3 评审 P1-4）：最新 completedAt，平局 taskId
    // 大者——与服务端/W4 共用真源，不再按 taskId 单独比较。
    const best = selectSessionResult(
      session.tasks
        .filter((task) => task.status === 'done' && task.completedAt !== undefined)
        .map((task) => ({ taskId: task.id, completedAt: task.completedAt! })),
    )
    if (best) {
      const fixture = fixtureResultFor(sessionId, best.taskId)
      return this.resultView(fixture.resultId, fixture.publicId, best.taskId)
    }
    throw new Error('会话暂无已完成结果')
  }

  async taskResult(taskId: string): Promise<{ found: boolean } & Partial<AgentResultView>> {
    const task = this.sessions.flatMap((s) => s.tasks).find((candidate) => candidate.id === taskId)
    if (!task || task.status !== 'done') return { found: false }
    const session = this.sessions.find((candidate) => candidate.tasks.includes(task))!
    const fixture = session.result?.taskId === taskId ? session.result : fixtureResultFor(session.id, taskId)
    return { found: true, ...this.resultView(fixture.resultId, fixture.publicId, taskId) }
  }

  // ---------------------------------------------------------------- 工件字节（P3.2-channel）

  /**
   * tasks.artifact mock 面：策略设计 fixture 引用集 → 真字节（JSON 工件=fixture
   * 常量序列化、预览 PNG=1×1 透明 PNG）。真实通道（RpcStrategyArtifacts）在 mock
   * 模式下经此走同一装配链（帧→拉取→parse→bundle）。未知引用=服务端 NOT_FOUND 形态。
   */
  async taskArtifact(input: TaskArtifactInput): Promise<TaskArtifactOutput> {
    const byRef = new Map<string, () => TaskArtifactOutput>([
      [
        STRATEGY_FIXTURE_BLOB_REFS.treeJson,
        () => this.jsonArtifact('object-tree.json', STRATEGY_FIXTURE_TREE),
      ],
      [
        STRATEGY_FIXTURE_BLOB_REFS.planJson,
        () => this.jsonArtifact('strategy-plan.json', STRATEGY_FIXTURE_PLAN),
      ],
      [
        STRATEGY_FIXTURE_BLOB_REFS.gemsJson,
        () => this.jsonArtifact('strategy-gems.json', STRATEGY_FIXTURE_GEMS),
      ],
      [
        STRATEGY_FIXTURE_BLOB_REFS.codeArtifact,
        () => this.jsonArtifact('free-code-artifact.json', STRATEGY_FIXTURE_CODE_ARTIFACT),
      ],
      [STRATEGY_FIXTURE_BLOB_REFS.treePreview, () => this.pngArtifact('object-tree-preview.png')],
      [STRATEGY_FIXTURE_BLOB_REFS.gemsPreview, () => this.pngArtifact('strategy-gems-preview.png')],
    ])
    if (input.blobRef === undefined) {
      // mock 按名取：引用表逆查（fixture 名↔ref 一一对应）
      const byName = new Map<string, string>([
        ['object-tree.json', STRATEGY_FIXTURE_BLOB_REFS.treeJson],
        ['strategy-plan.json', STRATEGY_FIXTURE_BLOB_REFS.planJson],
        ['strategy-gems.json', STRATEGY_FIXTURE_BLOB_REFS.gemsJson],
        ['object-tree-preview.png', STRATEGY_FIXTURE_BLOB_REFS.treePreview],
        ['strategy-gems-preview.png', STRATEGY_FIXTURE_BLOB_REFS.gemsPreview],
      ])
      const ref = input.name !== undefined ? byName.get(input.name) : undefined
      if (ref !== undefined) return byRef.get(ref)!()
    } else {
      const factory = byRef.get(input.blobRef)
      if (factory !== undefined) return factory()
    }
    throw new Error(`工件不存在（mock 引用集外）：${input.name ?? input.blobRef}`)
  }

  private jsonArtifact(name: string, value: unknown): TaskArtifactOutput {
    // UTF-8 安全 base64（fixture JSON 含中文——btoa 直编非 Latin1 抛 InvalidCharacterError）
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { name, mime: 'application/json', dataBase64: btoa(binary) }
  }

  private pngArtifact(name: string): TaskArtifactOutput {
    // 1×1 透明 PNG（IEdev 常量形态——渲染面只消费 dataUrl，不解码像素）
    return { name, mime: 'image/png', dataBase64: MOCK_PNG_1X1_BASE64 }
  }

  // ---------------------------------------------------------------- internals

  private resultView(resultId: string, publicId: string, taskId: string): AgentResultView {
    return {
      resultId,
      taskId,
      publicId,
      bundle: {
        svg: FIXTURE_BLOB_REFS.artifactSvg,
        bom: FIXTURE_BLOB_REFS.artifactBom,
        png: FIXTURE_BLOB_REFS.artifactPng,
      },
    }
  }

  private runScript(task: MockTask): void {
    const script = task.script
    if (!script) return
    const step = script.queue.shift()
    if (!step) {
      task.script = null
      task.status = 'done'
      task.completedAt = this.now() // 完成时记录（P1-4——确定性选择的输入）
      return
    }
    const fire = (): void => {
      this.append(task, step.kind, structuredClone(step.payload))
      if (step.gate === 'approval') {
        const requestId = (step.payload as { requestId: string }).requestId
        // 挂起直至 answer()；取消/清理由 stopTask 兜底 resolve。
        const gatePromise = new Promise<boolean>((resolve) => {
          script.gate = { requestId, resolve }
        })
        void gatePromise.then((approved) => {
          script.queue = [...(approved ? FIXTURE_APPROVED_TAIL : FIXTURE_REJECTED_TAIL)]
          this.runScript(task)
        })
        return
      }
      this.runScript(task)
    }
    const delay = Math.max(0, Math.round(step.delayMs * this.speed))
    if (delay === 0) fire()
    else script.timer = setTimeout(fire, delay)
  }

  private stopTask(task: MockTask, status: MockTask['status']): void {
    if (task.script) {
      if (task.script.timer !== null) clearTimeout(task.script.timer)
      if (task.script.gate) {
        const gate = task.script.gate
        task.script.gate = null
        // 静默释放挂起门（后续脚本不再续跑）。
        void Promise.resolve(false).then(() => gate.resolve(false))
        task.script.queue = []
      }
      task.script = null
    }
    if (task.status === 'running' || task.status === 'queued') task.status = status
  }

  private append(task: MockTask, kind: Frame['kind'], payload: unknown): void {
    const seq = task.frames.length > 0 ? task.frames[task.frames.length - 1]!.seq + 1 : 1
    const frame = { seq, ts: Date.now(), kind, payload } as Frame
    task.frames.push(frame)
    const set = this.listeners.get(task.id)
    if (set) for (const listener of set) listener(frame)
  }

  private require(sessionId: string): MockSession {
    const session = this.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new Error(`会话不存在：${sessionId}`)
    return session
  }

  private requireTask(sessionId: string, taskId: string): MockTask {
    const task = this.require(sessionId).tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error(`任务不属于该会话：${taskId}`)
    return task
  }

  private toSummary(session: MockSession): AgentSessionView {
    return {
      id: session.id,
      title: session.title === '' ? '未命名会话' : session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
  }
}
