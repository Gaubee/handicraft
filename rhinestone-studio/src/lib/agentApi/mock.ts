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
  derivePixelsPerMm,
  decodeInlineMask,
  encodeInlineMask,
  WORKBENCH_MASK_RUN_LIMIT,
  type ExportBlocker,
  type ExportGate,
  type Frame,
  type InlineMask,
  type LayerRenameInput,
  type LayerRenameOutput,
  type LayerSplitInput,
  type LayerStrategySetInput,
  type LayerStrategySetOutput,
  type LayerMaskPatchInput,
  type LayerMaskPatchOutput,
  type MaskEditStatus,
  type ObjectNode,
  type ObjectTree,
  type SegmentOneOutput,
  type SessionListInput,
  type SessionListOutput,
  type StrategyAssignment,
  type TaskDetailResponse,
  type TaskExportInput,
  type TaskExportOutput,
  type TreeHistoryInput,
  type TreeHistoryOutput,
  type TreeVersion,
  type ViewState,
  type ViewStateSetInput,
  type ViewStateSetOutput,
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
import {
  WORKBENCH_FIXTURE_BASE_IMAGE_SVG,
  WORKBENCH_FIXTURE_BLOB_REFS,
  WORKBENCH_FIXTURE_CANVAS_MASK_BITS,
  WORKBENCH_FIXTURE_GEMS,
  WORKBENCH_FIXTURE_PLAN,
  WORKBENCH_FIXTURE_TASK_ID,
  WORKBENCH_FIXTURE_TREE,
  splitInlineMaskHalves,
  stripesMaskOf,
  workbenchRef,
} from './workbenchFixtures.js'
import {
  StrategyGemsViewSchema,
  type StrategyGemsView,
} from '../strategyDesigner/artifacts.js'
import type {
  AgentApi,
  AgentConnectionState,
  AgentResultView,
  AgentSessionView,
  AgentTaskView,
} from './types.js'
import { getDemoDelay } from './demoDelay.svelte.js'
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

/**
 * RLE 行程计数（行主序扁平字节串的「极大同值段」数——WORKBENCH_MASK_RUN_LIMIT
 * 的 incomplete 判定输入；与 daemon countRuns 同式：跨行边界同值续段计一段）。
 */
function countMaskRuns(bits: Uint8Array): number {
  if (bits.length === 0) return 0
  let runs = 1
  let prev = bits[0]!
  for (let i = 1; i < bits.length; i++) {
    const b = bits[i]!
    if (b !== prev) {
      runs += 1
      prev = b
    }
  }
  return runs
}

interface MockSession {
  id: string
  title: string
  status: 'active' | 'clearing' | 'cleared'
  createdAt: string
  updatedAt: string
  tasks: MockTask[]
  result?: { resultId: string; publicId: string; taskId: string }
}

/**
 * 工作台 mock 状态（2.6 mock 通道）：每任务一棵可变树+指派+gems 版本链——
 * split/rename/strategySet 就地演进，后续 taskDetail/treeHistory 反映操作
 * （与真实 daemon 的工件+版本史语义同构；mock 桥秒回）。
 */
interface MockWorkbenchState {
  taskId: string
  /** 树基态（canvasCm/imagePx 供 ppm 与 tree 工件序列化；nodes 与 detail.tree 共享数组）。 */
  treeMeta: { canvasCm: { w: number; h: number }; imagePx: { width: number; height: number }; createdAt: string }
  nodes: ObjectNode[]
  detail: TaskDetailResponse
  /** baseImage 附件字节（SVG——taskArtifact 附件通道）。 */
  baseImageSvg: string | null
  /** gems 工件按 blobRef 版本化（strategySet 落新 ref；taskDetail 取最新）。 */
  gemsByRef: Map<string, StrategyGemsView>
  versions: TreeVersion[]
  seq: number
  /** 视图态工件（workbench-pro 2a：显隐/折叠/锁定=task 级服务端工件；null=尚无）。 */
  viewState: ViewState | null
  /** 视图态当前工件引用（previousBlobRef 回溯链锚——mock ref 派生）。 */
  viewStateBlobRef: string | null
  /** mask 编辑留痕面（layerMaskPatch upsert；task.detail.maskEdits 组装源）。 */
  maskEdits: MaskEditStatus[]
}

export interface MockAgentApiOptions {
  /** 延迟倍率（默认 1；测试传 0=立即发射）。 */
  speed?: number
  /** 时钟注入（默认真实 ISO——测试控制 completedAt 以覆盖确定性选择语义）。 */
  now?: () => string
  /**
   * 走查演示节奏（三通道 2.4，对齐 shufa a3ac820 demoDelay）：>0 时每帧按该间隔
   * 统一发射（替代脚本内建 delayMs×speed）。显式注入优先于 sessionStorage 开关。
   */
  demoDelayMs?: number
}

export class MockAgentApi implements AgentApi {
  readonly mode = 'mock' as const
  private readonly sessions: MockSession[]
  private readonly listeners = new Map<string, Set<(frame: Frame) => void>>()
  private readonly connectionListeners = new Set<(state: AgentConnectionState) => void>()
  private readonly speed: number
  private readonly now: () => string
  /** 演示节奏（ms；0=按脚本 delayMs×speed）。运行中可经 setDemoDelay 复位（退出演示）。 */
  private demoDelayMs: number
  private readonly workbenchStates = new Map<string, MockWorkbenchState>()
  private seq = 0

  constructor(options: MockAgentApiOptions = {}) {
    this.speed = options.speed ?? 1
    this.now = options.now ?? (() => new Date().toISOString())
    this.demoDelayMs = options.demoDelayMs ?? getDemoDelay()
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

  /** 走查演示节奏运行中复位（0=退出演示，回到脚本内建 delayMs×speed）。 */
  setDemoDelay(delayMs: number): void {
    this.demoDelayMs = Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0
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

  async followup(
    sessionId: string,
    text: string,
    mode?: 'followup' | 'steer',
  ): Promise<{ taskId: string }> {
    const session = this.require(sessionId)
    if (session.status !== 'active') throw new Error(session.status === 'clearing' ? '会话正在清理，拒绝新输入' : '会话已清理')
    // 引导通道（三通道 2.1，对齐 kernel followup(mode) 分流）：会话内有运行中任务 →
    // 投进该任务（同 taskId 返回，不新开任务行）；idle 等价常规发送（下方新任务路径）。
    if (mode === 'steer') {
      const live = [...session.tasks].reverse().find((candidate) => candidate.status === 'running')
      if (live) {
        this.append(live, 'transcript', {
          role: 'assistant',
          text: `（引导已并入当前任务）收到引导：${text}——下一步按此调整。`,
        })
        return { taskId: live.id }
      }
    }
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
      if (task) this.settleTask(task, 'cancelled')
      return { ok: true }
    }
    if (!input.sessionId) throw new Error('sessionId 与 taskId 必须二选一')
    const session = this.require(input.sessionId)
    for (const task of session.tasks) this.settleTask(task, 'cancelled')
    return { ok: true }
  }

  /**
   * 打断当前轮（三通道 2.1，对齐 daemon tasksStop——打断≠终态取消）：running → 脚本
   * 停发 + done 帧收口（贴钻无 status 帧，stop 收口=done 帧）+ 行置 done；非 running
   * 幂等 no-op；已取消任务拒绝（与后端「已取消拒绝」面一致）。
   */
  async stopTask(taskId: string): Promise<void> {
    const task = this.sessions.flatMap((s) => s.tasks).find((candidate) => candidate.id === taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)
    if (task.status === 'cancelled') throw new Error('已取消的任务不可操作')
    if (task.status !== 'running' && task.status !== 'queued') return
    this.haltScript(task)
    task.status = 'done'
    task.completedAt = this.now()
    this.append(task, 'done', {})
  }

  async clear(sessionId: string): Promise<{ ok: boolean; status: 'cleared' | 'clearing' }> {
    const session = this.require(sessionId)
    if (session.status === 'cleared') return { ok: true, status: 'cleared' }
    for (const task of session.tasks) this.settleTask(task, 'cancelled')
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
    // 工作台状态引用优先（原色底图/按版本演进的 gems/当前树与指派——mock 与真实
    // daemon 的「工件随写操作落新 ref」语义同构）。
    const workbench = this.tryWorkbench(input.taskId)
    if (workbench !== null && input.blobRef !== undefined) {
      if (input.blobRef === WORKBENCH_FIXTURE_BLOB_REFS.baseImage && workbench.baseImageSvg !== null) {
        return this.svgArtifact('base-image.svg', workbench.baseImageSvg)
      }
      // blob 态掩码字节（画布层 120×160 位面——blob mask 全链 mock 桥：拉取→LRU→渲染）
      if (input.blobRef === WORKBENCH_FIXTURE_BLOB_REFS.canvasMaskBlob) {
        return this.bytesArtifact('mask-blob.bin', WORKBENCH_FIXTURE_CANVAS_MASK_BITS)
      }
      const gemsDoc = workbench.gemsByRef.get(input.blobRef)
      if (gemsDoc !== undefined) return this.jsonArtifact('strategy-gems.json', gemsDoc)
      if (input.blobRef === WORKBENCH_FIXTURE_BLOB_REFS.treeJson) {
        return this.jsonArtifact('object-tree.json', {
          kind: 'object-tree',
          formatVersion: 1,
          canvasCm: workbench.treeMeta.canvasCm,
          imagePx: workbench.treeMeta.imagePx,
          nodes: workbench.nodes,
          createdAt: workbench.treeMeta.createdAt,
        } satisfies ObjectTree)
      }
      if (input.blobRef === WORKBENCH_FIXTURE_BLOB_REFS.planJson) {
        return this.jsonArtifact('strategy-plan.json', {
          kind: 'strategy-plan',
          formatVersion: 1,
          objectTreeRef: WORKBENCH_FIXTURE_BLOB_REFS.treeJson,
          assignments: workbench.detail.assignments,
          createdAt: workbench.treeMeta.createdAt,
        })
      }
      // [add-workbench-pro 1.3] 预览 PNG：静态两 ref + 演进版本 ref（split/rename/
      // strategySet 落新 preview ref——detail.preview 与版本链皆可寻址；轻量详情
      // 面板的缩略图通道，字节面=1×1 PNG 同策略 fixture）。
      if (input.blobRef === WORKBENCH_FIXTURE_BLOB_REFS.gemsPreview) {
        return this.pngArtifact('strategy-gems-preview.png')
      }
      if (input.blobRef === WORKBENCH_FIXTURE_BLOB_REFS.treePreview) {
        return this.pngArtifact('object-tree-preview.png')
      }
      if (
        (workbench.detail.preview !== null && workbench.detail.preview.blobRef === input.blobRef) ||
        workbench.versions.some((version) => version.previewBlobRef === input.blobRef)
      ) {
        return this.pngArtifact('strategy-gems-preview.png')
      }
    }
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

  private svgArtifact(name: string, svg: string): TaskArtifactOutput {
    const bytes = new TextEncoder().encode(svg)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { name, mime: 'image/svg+xml', dataBase64: btoa(binary) }
  }

  /** 二进制工件（mask blob 位面 0/1 字节——application/octet-stream）。 */
  private bytesArtifact(name: string, bytes: Uint8Array): TaskArtifactOutput {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { name, mime: 'application/octet-stream', dataBase64: btoa(binary) }
  }

  // ---------------------------------------------------------------- 任务详情·排钻工作台 mock（2.6）

  /** mock 工作台覆盖的任务（小丑全量 fixture + 柳树降级 fixture）；其余=null（回落静态引用表）。 */
  private tryWorkbench(taskId: string): MockWorkbenchState | null {
    const cached = this.workbenchStates.get(taskId)
    if (cached !== undefined) return cached
    if (taskId === WORKBENCH_FIXTURE_TASK_ID) {
      const state = this.buildClownState()
      this.workbenchStates.set(taskId, state)
      return state
    }
    if (taskId === 'fixt-task-willow-1') {
      const state = this.buildWillowState()
      this.workbenchStates.set(taskId, state)
      return state
    }
    return null
  }

  private requireWorkbench(taskId: string): MockWorkbenchState {
    const state = this.tryWorkbench(taskId)
    if (state === null) throw new Error(`任务不在 mock 工作台引用集内：${taskId}`)
    return state
  }

  private buildClownState(): MockWorkbenchState {
    const tree = structuredClone(WORKBENCH_FIXTURE_TREE)
    const assignments = structuredClone(WORKBENCH_FIXTURE_PLAN.assignments)
    const gems = structuredClone(WORKBENCH_FIXTURE_GEMS)
    const detail: TaskDetailResponse = {
      task: {
        id: WORKBENCH_FIXTURE_TASK_ID,
        title: '小丑贴钻·工作台',
        status: 'done',
        createdAt: tree.createdAt,
      },
      session: { id: 'fixt-session-clown', title: '小丑贴钻·工作台' },
      baseImage: {
        blobRef: WORKBENCH_FIXTURE_BLOB_REFS.baseImage,
        widthPx: tree.imagePx.width,
        heightPx: tree.imagePx.height,
        canvasCm: tree.canvasCm,
      },
      tree: { blobRef: WORKBENCH_FIXTURE_BLOB_REFS.treeJson, nodes: tree.nodes },
      assignments,
      gems: {
        blobRef: WORKBENCH_FIXTURE_BLOB_REFS.gemsJson,
        count: gems.gems.length,
        excludedRegions: gems.excludedRegions.length,
      },
      preview: { blobRef: WORKBENCH_FIXTURE_BLOB_REFS.gemsPreview },
      viewState: null,
      // 走查演示造数（workbench-pro 2b）：一条 stale（编辑基线漂移）+一条 incomplete
      //（行程 4096 超限）——exportGate 阻断面/UI 告警徽标的可复现通道；笔刷编辑
      // 落盘后按真实状态机 upsert（ready）刷新。
      maskEdits: [
        {
          nodeId: 'n-face',
          state: 'stale',
          runCount: 96,
          incomplete: false,
          baseVersion: 1,
          error: null,
          updatedAt: tree.createdAt,
        },
        {
          nodeId: 'n-bow',
          state: 'ready',
          runCount: 9999,
          incomplete: true,
          baseVersion: 1,
          error: null,
          updatedAt: tree.createdAt,
        },
      ],
      exportGate: { allowed: false, blockers: ['mask-incomplete', 'mask-stale'] },
    }
    return {
      taskId: WORKBENCH_FIXTURE_TASK_ID,
      treeMeta: { canvasCm: tree.canvasCm, imagePx: tree.imagePx, createdAt: tree.createdAt },
      nodes: tree.nodes,
      detail,
      baseImageSvg: WORKBENCH_FIXTURE_BASE_IMAGE_SVG,
      gemsByRef: new Map([[WORKBENCH_FIXTURE_BLOB_REFS.gemsJson, gems]]),
      versions: [],
      seq: 0,
      viewState: null,
      viewStateBlobRef: null,
      maskEdits: detail.maskEdits as MaskEditStatus[],
    }
  }

  private buildWillowState(): MockWorkbenchState {
    const tree = structuredClone(STRATEGY_FIXTURE_TREE)
    const assignments = structuredClone(STRATEGY_FIXTURE_PLAN.assignments)
    const gems = structuredClone(STRATEGY_FIXTURE_GEMS)
    const detail: TaskDetailResponse = {
      task: { id: 'fixt-task-willow-1', title: '柳树装饰画·策略设计', status: 'done', createdAt: tree.createdAt },
      session: { id: 'fixt-session-willow', title: '柳树装饰画·策略设计' },
      // 柳树 fixture 无 scene-analysis 锚——baseImage=null（前端降级态覆盖）
      baseImage: null,
      tree: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.treeJson, nodes: tree.nodes },
      assignments,
      gems: {
        blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsJson,
        count: gems.gems.length,
        excludedRegions: gems.excludedRegions.length,
      },
      preview: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsPreview },
      viewState: null,
      maskEdits: [],
      exportGate: { allowed: true, blockers: [] },
    }
    return {
      taskId: 'fixt-task-willow-1',
      treeMeta: { canvasCm: tree.canvasCm, imagePx: tree.imagePx, createdAt: tree.createdAt },
      nodes: tree.nodes,
      detail,
      baseImageSvg: null,
      gemsByRef: new Map([[STRATEGY_FIXTURE_BLOB_REFS.gemsJson, gems]]),
      versions: [],
      seq: 0,
      viewState: null,
      viewStateBlobRef: null,
      maskEdits: [],
    }
  }

  async taskDetail(taskId: string): Promise<TaskDetailResponse> {
    const state = this.requireWorkbench(taskId)
    this.syncProFaces(state)
    return structuredClone(state.detail)
  }

  async layerSplit(input: LayerSplitInput): Promise<SegmentOneOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    // 提示语派生子层名（「把帽子拆出来」→ 帽子 / 帽子·余部）；无匹配回退父层名。
    const parsed = /把(.{1,12}?)(拆|分)/.exec(input.hint)
    const baseName = parsed?.[1] ?? node.objectName
    state.seq += 1
    const idA = `${node.id}-s${state.seq}a`
    const idB = `${node.id}-s${state.seq}b`
    const wLeft = Math.max(1, Math.floor(node.bbox.w / 2))
    const wRight = Math.max(1, node.bbox.w - wLeft)
    const halves =
      node.mask.kind === 'inline' && node.mask.w >= 2
        ? splitInlineMaskHalves(node.mask)
        : { left: stripesMaskOf(node.bbox.w, node.bbox.h), right: stripesMaskOf(node.bbox.w, node.bbox.h) }
    const children: ObjectNode[] = [
      {
        id: idA,
        objectName: baseName,
        category: node.category,
        mask: halves.left,
        bbox: { x: node.bbox.x, y: node.bbox.y, w: wLeft, h: node.bbox.h },
        parent: node.id,
        children: [],
        effectiveMm: node.effectiveMm / 2,
        labVariance: node.labVariance,
        drillWorthy: node.drillWorthy,
        origin: 'manual-lasso',
      },
      {
        id: idB,
        objectName: `${baseName}·余部`,
        category: node.category,
        mask: halves.right,
        bbox: { x: node.bbox.x + wLeft, y: node.bbox.y, w: wRight, h: node.bbox.h },
        parent: node.id,
        children: [],
        effectiveMm: node.effectiveMm / 2,
        labVariance: node.labVariance,
        drillWorthy: node.drillWorthy,
        origin: 'manual-lasso',
      },
    ]
    node.children = [...node.children, idA, idB]
    state.nodes.push(...children)
    const version = this.pushVersion(state, 'segment-one', `hint=${input.hint}`)
    return { children: structuredClone(children), treeBlobRef: version.treeBlobRef, previewBlobRef: version.previewBlobRef, warnings: [] }
  }

  async layerRename(input: LayerRenameInput): Promise<LayerRenameOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    node.objectName = input.objectName
    const version = this.pushVersion(state, 'rename', `nodeId=${input.nodeId} → ${input.objectName}`)
    return { treeBlobRef: version.treeBlobRef, previewBlobRef: version.previewBlobRef, version: version.version }
  }

  async layerStrategySet(input: LayerStrategySetInput): Promise<LayerStrategySetOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    const existing = state.detail.assignments.find((assignment) => assignment.nodeId === input.nodeId)
    const next: StrategyAssignment = {
      nodeId: input.nodeId,
      strategyKind: input.strategyKind,
      params: input.params,
      stones: existing?.stones ?? [],
      densityPerCm2: input.densityPerCm2 ?? existing?.densityPerCm2 ?? 2.3,
      rationale: existing?.rationale ?? '工作台直改（D-1 直接生效）',
    }
    state.detail.assignments = [
      ...state.detail.assignments.filter((assignment) => assignment.nodeId !== input.nodeId),
      next,
    ]
    // 点阵重演：该层旧钻移除 + 非排除层按密度网格重生成（确定性——同参同钻）。
    const currentDoc = state.detail.gems !== null ? state.gemsByRef.get(state.detail.gems.blobRef) : undefined
    const baseDoc = currentDoc ?? [...state.gemsByRef.values()][0]
    if (baseDoc !== undefined) {
      const kept = baseDoc.gems.filter((gem) => gem.blockId !== input.nodeId)
      if (input.strategyKind !== 'exclusion') {
        const derived = derivePixelsPerMm({ canvasCm: state.treeMeta.canvasCm, imagePx: state.treeMeta.imagePx })
        const ppm = derived.ok ? derived.pixelsPerMm : 2
        const spacing = Math.max(2, ppm / Math.sqrt(next.densityPerCm2))
        const diameterMm = next.stones[0]?.sizeMm ?? 3
        for (let y = node.bbox.y + spacing / 2, row = 0; y < node.bbox.y + node.bbox.h; y += spacing, row += 1) {
          for (let x = node.bbox.x + spacing / 2 + (row % 2) * (spacing / 2), i = 0; x < node.bbox.x + node.bbox.w; x += spacing, i += 1) {
            if (kept.length >= 400) break
            kept.push({
              id: `${input.nodeId}#gen${row}-${i}`,
              x: Math.round(x * 100) / 100,
              y: Math.round(y * 100) / 100,
              colorId: '',
              blockId: input.nodeId,
              shapeId: 'round',
              diameterMm,
            })
          }
        }
      }
      state.seq += 1
      const gemsRef = workbenchRef(`wb-${input.taskId}-gems-v${state.seq}`)
      const previewRef = workbenchRef(`wb-${input.taskId}-gems-preview-v${state.seq}`)
      state.gemsByRef.set(gemsRef, StrategyGemsViewSchema.parse({ ...baseDoc, gems: kept }))
      state.detail.gems = {
        blobRef: gemsRef,
        count: kept.length,
        excludedRegions: state.detail.gems?.excludedRegions ?? 0,
      }
      state.detail.preview = { blobRef: previewRef }
      return { gems: { blobRef: gemsRef, count: kept.length }, preview: { blobRef: previewRef } }
    }
    state.seq += 1
    const previewRef = workbenchRef(`wb-${input.taskId}-gems-preview-v${state.seq}`)
    return { gems: { blobRef: workbenchRef(`wb-${input.taskId}-gems-v${state.seq}`), count: 0 }, preview: { blobRef: previewRef } }
  }

  async treeHistory(input: TreeHistoryInput): Promise<TreeHistoryOutput> {
    const state = this.requireWorkbench(input.taskId)
    return {
      versions: structuredClone(state.versions),
      currentTreeBlobRef: state.detail.tree?.blobRef ?? null,
      currentVersion: state.versions.length > 0 ? state.versions[state.versions.length - 1]!.version : null,
    }
  }

  // ---------------- workbench-pro 波 2a 契约 mock 通道（2b 前端接线——与 daemon 端点语义同构）

  /**
   * 导出门纯函数（mask 编辑状态面→blockers——与 daemon exportGateOf 同式）：
   * incomplete→mask-incomplete / stale→mask-stale / error→mask-recompute-error，
   * 去重升序。
   */
  private exportGateOf(edits: MaskEditStatus[]): ExportGate {
    const blockers = new Set<ExportBlocker>()
    for (const edit of edits) {
      if (edit.incomplete) blockers.add('mask-incomplete')
      if (edit.state === 'stale') blockers.add('mask-stale')
      if (edit.state === 'error') blockers.add('mask-recompute-error')
    }
    return { allowed: blockers.size === 0, blockers: [...blockers].sort() }
  }

  /** detail 三新面同步（maskEdits/exportGate/viewState 从可变态源组装——读面始终新鲜）。 */
  private syncProFaces(state: MockWorkbenchState): void {
    state.detail.maskEdits = structuredClone(state.maskEdits)
    state.detail.exportGate = this.exportGateOf(state.maskEdits)
    state.detail.viewState = state.viewState === null ? null : structuredClone(state.viewState)
  }

  /**
   * 笔刷遮罩编辑 mock（layerMaskPatch——与 daemon 真身同构的同步闭环）：CAS 门+
   * 锁定拒+笔迹光栅化（画布 px→bbox 局部，圆盘按像素中心判定）+涂空拒+紧外接重锚+
   * 行程计数（incomplete 判定）+版本入史（cause=mask-patch）+maskEdits upsert+
   * 可选指派重算（网格重演——editState ready）。
   */
  async layerMaskPatch(input: LayerMaskPatchInput): Promise<LayerMaskPatchOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    const currentRef = state.detail.tree?.blobRef
    if (currentRef === undefined || currentRef !== input.expectedTreeBlobRef) {
      throw new Error(`cas-mismatch：expectedTreeBlobRef ≠ 电流树 ${currentRef ?? '(无)'}（mock 通道——树已被推进）`)
    }
    if (state.viewState?.nodes.find((n) => n.nodeId === node.id)?.locked === true) {
      throw new Error(`node-locked：节点「${node.objectName}」已被锁定（锁定=结构+遮罩面冻结，先解锁再编辑）`)
    }
    const resolved = decodeInlineMask(this.inlineMaskOf(node.mask))
    const { w, h } = resolved
    const bits = new Uint8Array(resolved.bits)
    for (const stroke of input.ops) {
      const value = stroke.op === 'add' ? 1 : 0
      for (const p of stroke.points) {
        const cx = p.x - node.bbox.x
        const cy = p.y - node.bbox.y
        const r = stroke.radiusPx
        for (let yy = Math.max(0, Math.floor(cy - r)); yy <= Math.min(h - 1, Math.ceil(cy + r)); yy++) {
          for (let xx = Math.max(0, Math.floor(cx - r)); xx <= Math.min(w - 1, Math.ceil(cx + r)); xx++) {
            const dx = xx + 0.5 - cx
            const dy = yy + 0.5 - cy
            if (dx * dx + dy * dy <= r * r) bits[yy * w + xx] = value
          }
        }
      }
    }
    let popcount = 0
    for (const b of bits) popcount += b
    if (popcount === 0) {
      throw new Error('mask-invalid：笔迹后节点掩码为空（remove 涂空全节点非法——整层移除请用 layer.delete）')
    }
    // 紧外接重锚+裁剪（tightBBox 同式扫描）
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (bits[y * w + x] !== 1) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const local = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    const cropped = new Uint8Array(local.w * local.h)
    for (let y = 0; y < local.h; y++) {
      for (let x = 0; x < local.w; x++) cropped[y * local.w + x] = bits[(y + local.y) * w + (x + local.x)]!
    }
    const runCount = countMaskRuns(cropped)
    const derived = derivePixelsPerMm({ canvasCm: state.treeMeta.canvasCm, imagePx: state.treeMeta.imagePx })
    const ppm = derived.ok ? derived.pixelsPerMm : 2
    node.mask = encodeInlineMask(local.w, local.h, cropped)
    node.bbox = { x: node.bbox.x + local.x, y: node.bbox.y + local.y, w: local.w, h: local.h }
    node.effectiveMm = Math.max(1, Math.round((Math.max(local.w, local.h) / ppm) * 10) / 10)

    const version = this.pushVersion(state, 'mask-patch', `笔刷编辑「${node.objectName}」（${input.ops.length} 笔）`)
    this.upsertMaskEdit(state, {
      nodeId: node.id,
      state: 'ready',
      runCount,
      incomplete: runCount > WORKBENCH_MASK_RUN_LIMIT,
      baseVersion: version.version,
      error: null,
      updatedAt: this.now(),
    })

    let gems: LayerMaskPatchOutput['gems'] = null
    if (input.recomputeStrategy) {
      const assignment = state.detail.assignments.find((a) => a.nodeId === node.id)
      if (assignment !== undefined && assignment.strategyKind !== 'exclusion') {
        const outcome = this.regenGemsForNode(state, node, assignment)
        gems = { blobRef: outcome.blobRef, count: outcome.count }
      }
    }
    return {
      treeBlobRef: version.treeBlobRef,
      previewBlobRef: version.previewBlobRef,
      version: version.version,
      node: { bbox: node.bbox, effectiveMm: node.effectiveMm },
      maskRunCount: runCount,
      incomplete: runCount > WORKBENCH_MASK_RUN_LIMIT,
      editState: 'ready',
      gems,
    }
  }

  /**
   * 视图态全量快照写 mock（viewStateSet——与 daemon 真身同构）：重复 nodeId 拒+
   * 节点归属门（幽灵节点拒——P0-2 同源）+CAS（expectedRevision 漂移拒）+revision
   * 单调链+previousBlobRef 回溯。
   */
  async viewStateSet(input: ViewStateSetInput): Promise<ViewStateSetOutput> {
    const state = this.requireWorkbench(input.taskId)
    const seen = new Set<string>()
    for (const n of input.nodes) {
      if (seen.has(n.nodeId)) throw new Error(`view-state-invalid：视图态节点重复：${n.nodeId}`)
      seen.add(n.nodeId)
    }
    const ids = new Set(state.nodes.map((n) => n.id))
    const ghosts = input.nodes.filter((n) => !ids.has(n.nodeId)).map((n) => n.nodeId)
    if (ghosts.length > 0) {
      throw new Error(`view-state-invalid：视图态含不在当前树的节点：${ghosts.slice(0, 5).join(', ')}`)
    }
    const current = state.viewState
    if (current !== null) {
      if (input.expectedRevision === undefined || input.expectedRevision !== current.revision) {
        throw new Error(`cas-mismatch：expectedRevision=${input.expectedRevision ?? '(缺省)'} ≠ 电流 revision=${current.revision}（并发双开不静默覆盖）`)
      }
    } else if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
      throw new Error('cas-mismatch：尚无视图态工件（首写 revision=1——缺省或 0 均合法）')
    }
    const revision = (current?.revision ?? 0) + 1
    const previousBlobRef = state.viewStateBlobRef
    state.viewState = {
      kind: 'workbench-view-state',
      formatVersion: 1,
      nodes: structuredClone(input.nodes),
      revision,
      previousBlobRef,
      updatedAt: this.now(),
    }
    state.viewStateBlobRef = workbenchRef(`wb-${state.taskId}-viewstate-v${revision}`)
    this.syncProFaces(state)
    return { blobRef: state.viewStateBlobRef, revision }
  }

  /**
   * 任务导出 mock（taskExport——导出门真实接线 P0-1 同源）：以 maskEdits 重算门，
   * 阻断=typed 拒（blockers 完整清单）；放行=strategy-gems 工件字节（JSON→base64）。
   */
  async taskExport(input: TaskExportInput): Promise<TaskExportOutput> {
    const state = this.requireWorkbench(input.taskId)
    const gate = this.exportGateOf(state.maskEdits)
    if (!gate.allowed) {
      throw new Error(`export-blocked：导出被门阻（${gate.blockers.join('、')}）——先在工作台处理遮罩编辑告警`)
    }
    const gemsRef = state.detail.gems?.blobRef
    const gemsDoc = gemsRef !== undefined ? state.gemsByRef.get(gemsRef) : undefined
    if (gemsDoc === undefined) throw new Error('尚无排钻产物（strategy-gems 工件缺席）')
    const bytes = new TextEncoder().encode(JSON.stringify(gemsDoc, null, 1))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return {
      filename: `task-${input.taskId}-strategy-gems.json`,
      kind: 'strategy-gems',
      dataBase64: btoa(binary),
      blobRef: gemsRef!,
      gemCount: state.detail.gems?.count ?? gemsDoc.gems.length,
    }
  }

  /** maskEdits upsert（nodeId 主键——同节点后写覆盖）+detail 面同步。 */
  private upsertMaskEdit(state: MockWorkbenchState, edit: MaskEditStatus): void {
    state.maskEdits = [...state.maskEdits.filter((e) => e.nodeId !== edit.nodeId), edit]
    this.syncProFaces(state)
  }

  /** mock 树掩码恒 inline（persistTree 的 blob 阈值转换不进 mock——两态解码面由真桥覆盖）。 */
  private inlineMaskOf(mask: ObjectNode['mask']): InlineMask {
    if (mask.kind === 'inline') return mask
    throw new Error(`mock 工作台掩码不支持 blob 态：${mask.blobRef.slice(0, 12)}…（真桥通道覆盖）`)
  }

  /**
   * 指派重算 mock（mask.patch recomputeStrategy 面——layerStrategySet 的单节点
   * 网格重演抽出共用）：该层旧钻移除+新 bbox 上按密度网格重生成+gems 工件落新 ref。
   */
  private regenGemsForNode(
    state: MockWorkbenchState,
    node: ObjectNode,
    assignment: StrategyAssignment,
  ): { blobRef: string; count: number } {
    const currentDoc = state.detail.gems !== null ? state.gemsByRef.get(state.detail.gems.blobRef) : undefined
    const baseDoc = currentDoc ?? [...state.gemsByRef.values()][0]
    if (baseDoc === undefined) throw new Error('尚无 gems 基线工件（mock 重算需要既有 plan）')
    const kept = baseDoc.gems.filter((gem) => gem.blockId !== node.id)
    const derived = derivePixelsPerMm({ canvasCm: state.treeMeta.canvasCm, imagePx: state.treeMeta.imagePx })
    const ppm = derived.ok ? derived.pixelsPerMm : 2
    const spacing = Math.max(2, ppm / Math.sqrt(assignment.densityPerCm2))
    const diameterMm = assignment.stones[0]?.sizeMm ?? 3
    for (let y = node.bbox.y + spacing / 2, row = 0; y < node.bbox.y + node.bbox.h; y += spacing, row += 1) {
      for (let x = node.bbox.x + spacing / 2 + (row % 2) * (spacing / 2), i = 0; x < node.bbox.x + node.bbox.w; x += spacing, i += 1) {
        if (kept.length >= 400) break
        kept.push({
          id: `${node.id}#mask${row}-${i}`,
          x: Math.round(x * 100) / 100,
          y: Math.round(y * 100) / 100,
          colorId: '',
          blockId: node.id,
          shapeId: 'round',
          diameterMm,
        })
      }
    }
    state.seq += 1
    const gemsRef = workbenchRef(`wb-${state.taskId}-gems-v${state.seq}`)
    const previewRef = workbenchRef(`wb-${state.taskId}-gems-preview-v${state.seq}`)
    state.gemsByRef.set(gemsRef, StrategyGemsViewSchema.parse({ ...baseDoc, gems: kept }))
    state.detail.gems = { blobRef: gemsRef, count: kept.length, excludedRegions: state.detail.gems?.excludedRegions ?? 0 }
    state.detail.preview = { blobRef: previewRef }
    return { blobRef: gemsRef, count: kept.length }
  }

  private pushVersion(
    state: MockWorkbenchState,
    cause: TreeVersion['cause'],
    detailText: string,
  ): { treeBlobRef: string; previewBlobRef: string; version: number } {
    state.seq += 1
    const treeBlobRef = workbenchRef(`wb-${state.taskId}-tree-v${state.seq}`)
    const previewBlobRef = workbenchRef(`wb-${state.taskId}-preview-v${state.seq}`)
    const version = state.versions.length + 1
    state.versions.push({ version, cause, detail: detailText, treeBlobRef, previewBlobRef, createdAt: this.now() })
    if (state.detail.tree !== null) state.detail.tree = { blobRef: treeBlobRef, nodes: state.nodes }
    state.detail.preview = { blobRef: previewBlobRef }
    return { treeBlobRef, previewBlobRef, version }
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
    const delay =
      this.demoDelayMs > 0 ? this.demoDelayMs : Math.max(0, Math.round(step.delayMs * this.speed))
    if (delay === 0) fire()
    else script.timer = setTimeout(fire, delay)
  }

  /** 脚本停发（timer 清除+挂起门静默释放；行状态由调用方收敛）。 */
  private haltScript(task: MockTask): void {
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
  }

  private settleTask(task: MockTask, status: MockTask['status']): void {
    this.haltScript(task)
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
