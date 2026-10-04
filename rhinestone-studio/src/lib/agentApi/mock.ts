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
  WORKBENCH_BRUSH_PAINT_BUDGET_PX,
  WORKBENCH_MASK_RUN_LIMIT,
  brushWorkloadError,
  nodeProducesBlock,
  type ExportBlocker,
  type ExportGate,
  type Frame,
  type LayerDeleteInput,
  type LayerDeleteOutput,
  type LayerReorderInput,
  type LayerReorderOutput,
  type LayerRenameInput,
  type LayerRenameOutput,
  type LayerSplitInput,
  type LayerStrategySetInput,
  type LayerStrategySetOutput,
  type LayerMaskPatchInput,
  type LayerMaskPatchOutput,
  type InlineMask,
  type MaskEditDiscardInput,
  type MaskEditDiscardOutput,
  type MaskEditRetryInput,
  type MaskEditRetryOutput,
  type MaskEditStatus,
  type NodeBBox,
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
  type TreeRevertInput,
  type TreeRevertOutput,
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
  FIXTURE_SET_SUMMARIES,
  FIXTURE_TASK_LAYOUT,
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
  WORKBENCH_FIXTURE_STONE_CANDIDATES,
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
  AgentSetSummary,
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

/** mask 位面 inline 持久化阈值（daemon MASK_INLINE_PERSIST_MAX_BYTES 同值镜像——产物形态判定）。 */
const MASK_INLINE_PERSIST_MAX_BYTES = 4096

/** 1×1 透明 PNG（工件字节 mock——预览/原图 dataUrl 形态即可，jsdom 不解码像素）。 */
const MOCK_PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * mock 断点账本键集（add-vision-pipeline-v2 T5——layer.split 试跑→确认同参回放标记：
 * daemon 侧 segment-ledger reqHash 语义的 mock 投影；只记「跑过」不存掩码——
 * 回放零桥调语义的实证在 daemon/tests/segment-one.test.ts）。
 * add-sam-playbook T2：box/excludeBox/instances 入键（daemon reqHash 投影含 prompt
 * 整体+topK——改排除区/正框/实例模式=不同键不串账）。
 */
function segmentLedgerKeyOf(input: {
  taskId: string
  nodeId: string
  hint?: string
  box?: { x: number; y: number; w: number; h: number }
  excludeBox?: { x: number; y: number; w: number; h: number }
  instances?: 'best' | 'all'
  precision?: unknown
}): string {
  return [
    input.taskId,
    input.nodeId,
    input.hint ?? '',
    JSON.stringify(input.box ?? null),
    JSON.stringify(input.excludeBox ?? null),
    input.instances ?? 'best',
    JSON.stringify(input.precision ?? null),
  ].join('|')
}

/**
 * add-sam-playbook T2 mock 拆层几何（daemon segment-one 语义同构投影）：
 * 基线=左半掩码（既有确定性）；box 正框=框外像素清零（聚焦裁剪）；excludeBox=框内
 * 像素清零（D2 像素减法同构——矩形内直接扣）；instances='all'=存活区域纵向三分带
 * 逐实例（D1 扇出投影——每实例独立紧外接）。全画布坐标入、节点局部坐标算。
 */
interface MockSplitShape {
  mask: InlineMask
  bbox: { x: number; y: number; w: number; h: number }
  /** 实例序（1 基——instances='all' 在场；best 缺席）。 */
  n?: number
}

function mockSplitShapesOf(
  node: ObjectNode,
  baseMask: InlineMask,
  input: { box?: NodeBBox; excludeBox?: NodeBBox; instances?: 'best' | 'all' },
): MockSplitShape[] {
  const base = decodeInlineMask(baseMask)
  const bits = new Uint8Array(base.bits) // 写时复制
  const clampRect = (
    rect: { x: number; y: number; w: number; h: number },
  ): { x0: number; y0: number; x1: number; y1: number } => ({
    x0: Math.max(0, rect.x - node.bbox.x),
    y0: Math.max(0, rect.y - node.bbox.y),
    x1: Math.min(base.w, rect.x - node.bbox.x + rect.w),
    y1: Math.min(base.h, rect.y - node.bbox.y + rect.h),
  })
  if (input.box !== undefined) {
    const r = clampRect(input.box)
    for (let y = 0; y < base.h; y++) {
      for (let x = 0; x < base.w; x++) {
        if (x < r.x0 || x >= r.x1 || y < r.y0 || y >= r.y1) bits[y * base.w + x] = 0
      }
    }
  }
  if (input.excludeBox !== undefined) {
    const r = clampRect(input.excludeBox)
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) bits[y * base.w + x] = 0
    }
  }
  const tightOf = (
    region: Uint8Array,
  ): { x: number; y: number; w: number; h: number; bits: Uint8Array } | null => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let y = 0; y < base.h; y++) {
      for (let x = 0; x < base.w; x++) {
        if (region[y * base.w + x] !== 1) continue
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x + 1)
        y1 = Math.max(y1, y + 1)
      }
    }
    if (x1 < x0) return null
    const w = x1 - x0
    const h = y1 - y0
    const cropped = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) cropped[y * w + x] = region[(y0 + y) * base.w + (x0 + x)]!
    }
    return { x: x0, y: y0, w, h, bits: cropped }
  }
  const canvasShapeOf = (
    local: { x: number; y: number; w: number; h: number; bits: Uint8Array },
    n?: number,
  ): MockSplitShape => ({
    mask: encodeInlineMask(local.w, local.h, local.bits),
    bbox: { x: node.bbox.x + local.x, y: node.bbox.y + local.y, w: local.w, h: local.h },
    ...(n !== undefined ? { n } : {}),
  })
  if (input.instances !== 'all') {
    const tight = tightOf(bits)
    return tight === null ? [] : [canvasShapeOf(tight)]
  }
  // instances='all'：存活区域纵向三分带（D1 逐实例扇出投影——确定性）
  const tight = tightOf(bits)
  if (tight === null) return []
  const shapes: MockSplitShape[] = []
  for (let i = 0; i < 3; i++) {
    const bandY0 = tight.y + Math.floor((tight.h * i) / 3)
    const bandY1 = tight.y + Math.floor((tight.h * (i + 1)) / 3)
    if (bandY1 <= bandY0) continue
    const bandBits = new Uint8Array(bits.length)
    for (let y = bandY0; y < bandY1; y++) {
      for (let x = 0; x < base.w; x++) bandBits[y * base.w + x] = bits[y * base.w + x]!
    }
    const bandTight = tightOf(bandBits)
    if (bandTight !== null) shapes.push(canvasShapeOf(bandTight, i + 1))
  }
  return shapes
}

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
  /** 版本→树快照（tree.revert 回放源——pushVersion 时克隆入链）。 */
  snapshots: Map<number, ObjectNode[]>
  seq: number
  /** 视图态工件（workbench-pro 2a：显隐/折叠/锁定=task 级服务端工件；null=尚无）。 */
  viewState: ViewState | null
  /** 视图态当前工件引用（previousBlobRef 回溯链锚——mock ref 派生）。 */
  viewStateBlobRef: string | null
  /** mask 编辑留痕面（layerMaskPatch upsert；task.detail.maskEdits 组装源）。 */
  maskEdits: MaskEditStatus[]
  /**
   * blob 态掩码字节按 ref 版本化（add-workbench-pro 2b 复核 P0-3：blob 节点回写
   * 闭环——patch 读旧位面→光栅化→产物按 daemon MASK_INLINE_PERSIST_MAX_BYTES=4096
   * 同构阈值落新 blob ref 或 inline；taskArtifact 附件通道按 ref 寻址拉回）。
   */
  maskBlobsByRef: Map<string, Uint8Array>
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
  /**
   * [product-polish-w2 T3] followup 脚本形态（测试前置态面）：default=脚本在
   * approval-request 门挂起（审批栈测试面）；hang=发完门前帧后**无审批帧**挂起
   * （任务恒 running、无 pending 审批——审批栈替换 textarea 后，排队/引导/打断类
   * 测试需要「running 且 composer 可用」的会话形态）。
   */
  followupStyle?: 'default' | 'hang'
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
  /** [product-polish-w2 T3] followup 脚本形态（见 MockAgentApiOptions）。 */
  private readonly followupStyle: 'default' | 'hang'
  private readonly workbenchStates = new Map<string, MockWorkbenchState>()
  /** mock 断点账本键集（T5——试跑→确认同参回放标记；daemon segment-ledger 投影）。 */
  private readonly segmentLedgerKeys = new Set<string>()
  private seq = 0

  constructor(options: MockAgentApiOptions = {}) {
    this.speed = options.speed ?? 1
    this.now = options.now ?? (() => new Date().toISOString())
    this.demoDelayMs = options.demoDelayMs ?? getDemoDelay()
    this.followupStyle = options.followupStyle ?? 'default'
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

  async createSession(input: { title?: string; titlePinned?: boolean }): Promise<{
    sessionId: string
    createdAt: string
  }> {
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

  /**
   * [add-task-stones-manifest-export 1.2] 集合候选读面（fixture 摘要——接口
   * 形态对齐；选择器 UI 在否由注入方决定，mock 演示同样可展示候选面）。
   */
  async listSets(): Promise<AgentSetSummary[]> {
    return structuredClone(FIXTURE_SET_SUMMARIES)
  }

  /**
   * [product-polish-w1 T1] 市场组合复制（接口形态对齐——mock 无服务端集合面，
   * 返回确定性副本摘要；演示模式选择器隐藏，本面不进 UI 链路）。
   */
  async copyMarketSet(resourceId: string): Promise<{ resourceId: string; memberCount: number }> {
    const source = FIXTURE_SET_SUMMARIES.find((set) => set.resourceId === resourceId)
    return {
      resourceId: `fixt-copy-${resourceId}`,
      memberCount: source !== undefined ? source.memberCount : 0,
    }
  }

  // ---------------------------------------------------------------- followup 与帧流

  async followup(
    sessionId: string,
    text: string,
    mode?: 'followup' | 'steer',
    // [split-admin-portal 2.6.3] 附件参数形态对齐（接口签名）；mock 演示模式无
    // 服务端素材桥——附件面在 UI 层即隐藏（attachable=rpc 才开），此处接收不消费。
    attachments?: string[],
    // [add-task-stones-manifest-export 1.2] sourceSetId 形态对齐（接口签名）；mock
    // 无服务端集合展开面——选择器在 UI 层即隐藏（rpc 才开），此处接收不消费。
    sourceSetId?: string,
    // [product-polish-w1 T2] autoApprove 形态对齐（接口签名）；mock 演示模式的审批
    // 走脚本流（无服务端开关真源），此处接收不消费。
    autoApprove?: boolean,
    // [product-polish-w2 T2] 任务级模型/强度覆盖形态对齐（接口签名）；mock 演示
    // 模式无内核路由面，此处接收不消费。
    model?: { provider: string; model: string; effort?: string },
  ): Promise<{ taskId: string }> {
    void attachments
    void sourceSetId
    void autoApprove
    void model
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
    // [product-polish-w2 T3] hang 形态：门前帧同步发完+无审批帧恒挂（running 且
    // composer 可用——审批栈在场的会话里排队/引导类测试的前置态）。
    if (this.followupStyle === 'hang') {
      for (const step of script.filter((step) => step.gate !== 'approval')) {
        this.append(task, step.kind, structuredClone(step.payload))
      }
      task.script = { queue: [], timer: null, gate: { requestId: `mock-hold-${taskId}`, resolve: () => {} } }
      return { taskId }
    }
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

  async renameSession(sessionId: string, title: string): Promise<{ ok: boolean; title: string }> {
    const session = this.require(sessionId)
    const trimmed = title.trim()
    if (trimmed === '') throw new Error('标题不能为空')
    session.title = trimmed
    session.updatedAt = this.now()
    return { ok: true, title: trimmed }
  }

  async setAutoApprove(sessionId: string, autoApprove: boolean): Promise<{ ok: boolean; autoApprove: boolean }> {
    // mock 世界开关 UI 不渲染（无服务端真源），接口面补齐即可。
    this.require(sessionId)
    return { ok: true, autoApprove }
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
      // blob 态掩码字节（按 ref 版本化——初始画布位面+patch 落新 ref；blob mask 全链
      // mock 桥：拉取→LRU→渲染→编辑回写同一条链，2b 复核 P0-3）
      const maskBytes = workbench.maskBlobsByRef.get(input.blobRef)
      if (maskBytes !== undefined) {
        return this.bytesArtifact('mask-blob.bin', maskBytes)
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
      // [product-polish-w1 T1/T2] heart 排钻渲染快照——done 卡总钻数行/详情面板徽标的
      // mock 字节面（taskArtifact 附件通道按 ref 寻址拉回）。
      [
        FIXTURE_BLOB_REFS.taskLayout,
        () => this.jsonArtifact('task-layout.image-1.json', FIXTURE_TASK_LAYOUT),
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
        ['task-layout.image-1.json', FIXTURE_BLOB_REFS.taskLayout],
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
      tree: {
        blobRef: WORKBENCH_FIXTURE_BLOB_REFS.treeJson,
        canvasCm: tree.canvasCm,
        imagePx: tree.imagePx,
        nodes: tree.nodes,
      },
      assignments,
      gems: {
        blobRef: WORKBENCH_FIXTURE_BLOB_REFS.gemsJson,
        count: gems.gems.length,
        excludedRegions: gems.excludedRegions.length,
      },
      preview: { blobRef: WORKBENCH_FIXTURE_BLOB_REFS.gemsPreview },
      viewState: null,
      // 项目钻清单摘要（W0 0.4 投影）：mock 无 session-project 真源——显式 null
      //（无项目行形态，契约要求字段在场）。
      projectStones: null,
      // 抠图精度缺省（2026-10-04 走查）：daemon imageProcessingEffective 缺省同形
      //（default=balanced 档——maskMaxSide null=原尺寸 / confThreshold 0.4）。
      segmentDefaults: { maskMaxSide: null, confThreshold: 0.4 },
      // v3 钻选择器数据面（owner 共享库候选表投影——多彩色板）
      stoneCandidates: structuredClone(WORKBENCH_FIXTURE_STONE_CANDIDATES),
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
      // v3：journey 基线版预置（daemon treeHistory 播种语义同构——会话产树入链，
      // 历史面板对 fixture 任务即时可见；后续工作台写从 v2 续链）
      versions: [
        {
          version: 1,
          cause: 'journey',
          detail: 'Agent 会话产树（识图——小丑单基线）',
          treeBlobRef: WORKBENCH_FIXTURE_BLOB_REFS.treeJson,
          previewBlobRef: WORKBENCH_FIXTURE_BLOB_REFS.treePreview,
          createdAt: tree.createdAt,
        },
      ],
      snapshots: new Map([[1, structuredClone(tree.nodes)]]),
      seq: 0,
      viewState: null,
      viewStateBlobRef: null,
      maskEdits: detail.maskEdits as MaskEditStatus[],
      maskBlobsByRef: new Map([[WORKBENCH_FIXTURE_BLOB_REFS.canvasMaskBlob, WORKBENCH_FIXTURE_CANVAS_MASK_BITS]]),
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
      tree: {
        blobRef: STRATEGY_FIXTURE_BLOB_REFS.treeJson,
        canvasCm: tree.canvasCm,
        imagePx: tree.imagePx,
        nodes: tree.nodes,
      },
      assignments,
      gems: {
        blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsJson,
        count: gems.gems.length,
        excludedRegions: gems.excludedRegions.length,
      },
      preview: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsPreview },
      viewState: null,
      // 项目钻清单摘要（W0 0.4 投影）：mock 无 session-project 真源——显式 null。
      projectStones: null,
      // 抠图精度缺省：daemon 缺省同形（default=balanced 档）。
      segmentDefaults: { maskMaxSide: null, confThreshold: 0.4 },
      stoneCandidates: structuredClone(WORKBENCH_FIXTURE_STONE_CANDIDATES),
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
      versions: [
        {
          version: 1,
          cause: 'journey',
          detail: 'Agent 会话产树（策略设计会话基线）',
          treeBlobRef: STRATEGY_FIXTURE_BLOB_REFS.treeJson,
          previewBlobRef: STRATEGY_FIXTURE_BLOB_REFS.treePreview,
          createdAt: tree.createdAt,
        },
      ],
      snapshots: new Map([[1, structuredClone(tree.nodes)]]),
      seq: 0,
      viewState: null,
      viewStateBlobRef: null,
      maskEdits: [],
      maskBlobsByRef: new Map(),
    }
  }

  async taskDetail(taskId: string): Promise<TaskDetailResponse> {
    const state = this.requireWorkbench(taskId)
    this.syncProFaces(state)
    // v5 修复轮 R1：gems.count 走叶子口径（与 daemon effectiveGems 同源——拆层后旧叶
    // 变组的存量钻不计数；「界面=下载」三面一致）
    if (state.detail.gems !== null) {
      state.detail.gems.count = this.effectiveGemCountOf(state)
    }
    return structuredClone(state.detail)
  }

  /** 当前树叶子口径颗数（nodeProducesBlock 单源谓词——mock 侧 detail/export 共用）。 */
  private effectiveGemCountOf(state: MockWorkbenchState): number {
    const gemsDoc =
      state.detail.gems !== null ? state.gemsByRef.get(state.detail.gems.blobRef) : undefined
    if (gemsDoc === undefined) return 0
    const leafIds = new Set(state.nodes.filter(nodeProducesBlock).map((node) => node.id))
    return gemsDoc.gems.filter((gem) => leafIds.has(gem.blockId)).length
  }

  async layerSplit(input: LayerSplitInput): Promise<SegmentOneOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    // Codex R1 P1：确认落地携带试跑基线树引用时与电流树比对（daemon trial-stale-tree 同构）
    if (input.dryRun !== true && input.trialTreeBlobRef !== undefined) {
      const current = state.detail.tree?.blobRef ?? null
      if (input.trialTreeBlobRef !== current) {
        throw new Error(
          `trial-stale-tree：试跑基线树 ${input.trialTreeBlobRef.slice(0, 12)}… ≠ 电流树 ${current?.slice(0, 12) ?? '(无)'}…（试跑后图层树被修改——刷新后重新试跑）`,
        )
      }
    }
    // add-sam-playbook T2：hint 可选（纯框模式留空——box 必在场，schema superRefine 同语义）
    const hint = input.hint ?? ''
    if (hint.trim() === '' && input.box === undefined) {
      throw new Error('hint 与 box 至少提供一项（纯 box 合法；excludeBox 是后处理非提示源，不可单用）')
    }
    // 子层名（daemon childNameForHint 同式）：「把帽子拆出来」→帽子；无匹配回退 hint 原文；
    // 纯框模式（D3）缺省「框选区域」（daemon segment-one 同名同链）
    const parsed = /把(.{1,12}?)(拆|分)/.exec(hint)
    const fallbackName = hint.trim() !== '' ? (parsed?.[1] ?? hint) : '框选区域'
    const promptOrigin =
      hint.trim() !== ''
        ? hint
        : `box[${input.box!.x},${input.box!.y},${input.box!.w},${input.box!.h}]`
    // 几何=左半基线（确定性——试跑与落地同形；daemon 掩膜经账本回放逐位同源）；
    // T2：box 裁剪/excludeBox 扣除/instances 三分带（mockSplitShapesOf——daemon 语义投影）
    const wLeft = Math.max(1, Math.floor(node.bbox.w / 2))
    const baseMask =
      node.mask.kind === 'inline' && node.mask.w >= 2
        ? splitInlineMaskHalves(node.mask).left
        : stripesMaskOf(wLeft, node.bbox.h)
    const classic = input.box === undefined && input.excludeBox === undefined && input.instances !== 'all'
    const shapes: MockSplitShape[] = classic
      ? [{ mask: baseMask, bbox: { x: node.bbox.x, y: node.bbox.y, w: wLeft, h: node.bbox.h } }]
      : mockSplitShapesOf(node, baseMask, input)
    // mock 断点账本（T5）：同参（task|node|hint|box|excludeBox|instances|precision）首跑入账，再跑=回放
    const ledgerKey = segmentLedgerKeyOf(input)
    const replayed = this.segmentLedgerKeys.has(ledgerKey)
    this.segmentLedgerKeys.add(ledgerKey)
    /** 子层构造（id/名在落地时分配——账本只回放掩膜；多实例名=基名+空格序号、segmentPrompt 记原文+[instance-N]——daemon D1 同构）。 */
    const childOf = (shape: MockSplitShape, id: string, name: string): ObjectNode => ({
      id,
      objectName: shape.n !== undefined && shapes.length > 1 ? `${name} ${shape.n}` : name,
      category: node.category,
      mask: structuredClone(shape.mask),
      bbox: { ...shape.bbox },
      parent: node.id,
      children: [],
      effectiveMm: Math.max(0.1, node.effectiveMm * ((shape.bbox.w * shape.bbox.h) / (node.bbox.w * node.bbox.h))),
      labVariance: node.labVariance,
      drillWorthy: node.drillWorthy,
      origin: 'manual-lasso',
      segmentPrompt: shape.n !== undefined && shapes.length > 1 ? `${promptOrigin}[instance-${shape.n}]` : promptOrigin,
    })
    if (input.dryRun === true) {
      // —— 试跑：真跑语义（账本照记）但不落树——树引用原样回传+试跑面载荷 ——
      // T2/D1：instances='all'=逐实例子层+trial.instancePreviews 逐实例缩略（daemon 同构）
      const children = shapes.map((shape, i) =>
        childOf(shape, `${node.id}-s${state.seq + 1}${shape.n !== undefined ? `i${shape.n}` : ['a', 'b', 'c'][i % 3]}`, fallbackName),
      )
      const previewRef = workbenchRef(`split-trial-${state.seq + 1}`)
      const preview = {
        kind: 'trial-mask-overlay',
        nodeId: node.id,
        objectName: node.objectName,
        blobRef: previewRef,
        mime: 'image/png' as const,
        maxSide: 512,
        dataBase64: MOCK_PNG_1X1_BASE64,
      }
      const instancePreviews =
        input.instances === 'all' && children.length > 0
          ? children.map((child) => ({
              kind: 'trial-mask-overlay',
              nodeId: child.id,
              objectName: child.objectName,
              blobRef: workbenchRef(`split-trial-${state.seq + 1}-${child.id}`),
              mime: 'image/png' as const,
              maxSide: 512,
              dataBase64: MOCK_PNG_1X1_BASE64,
            }))
          : undefined
      return {
        children,
        treeBlobRef: state.detail.tree?.blobRef ?? workbenchRef('tree-json'),
        previewBlobRef: previewRef,
        warnings: children.length === 0 ? [{ reason: 'no-instance', detail: `「${node.objectName}」内零可用实例（mock 几何裁剪后为空）——未产生子层` }] : [],
        trial: { preview, replayed, ...(instancePreviews !== undefined ? { instancePreviews } : {}) },
      }
    }
    // —— 落地（dryRun 缺省）：子层入树+版本入史（id/名在落地时分配——账本只回放掩膜） ——
    state.seq += 1
    const children = shapes.map((shape, i) =>
      childOf(shape, `${node.id}-s${state.seq}${shape.n !== undefined ? `i${shape.n}` : ['a', 'b', 'c'][i % 3]}`, input.layerName ?? fallbackName),
    )
    for (const child of children) state.nodes.push(child)
    node.children = [...node.children, ...children.map((child) => child.id)]
    const version = this.pushVersion(state, 'segment-one', `hint=${promptOrigin}`)
    return {
      children: children.map((child) => structuredClone(child)),
      treeBlobRef: version.treeBlobRef,
      previewBlobRef: version.previewBlobRef,
      warnings: children.length === 0 ? [{ reason: 'no-instance', detail: `「${node.objectName}」内零可用实例（mock 几何裁剪后为空）——未产生子层` }] : [],
    }
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
    // v5 Owner 裁定：组（有 children）恒不产钻——直改 typed 拒（daemon node-not-leaf 同构）
    if (node.children.length > 0) {
      throw new Error(`node-not-leaf：节点 ${input.nodeId}「${node.objectName}」是组（有子图层——组不产钻，v5 语义）：拆分后只在子图层指派`)
    }
    const existing = state.detail.assignments.find((assignment) => assignment.nodeId === input.nodeId)
    // v3 钻选择器：stoneIdx → 候选表回填 StonePick 真源（daemon resolveStones 同构；
    // 幻觉 idx typed 拒；缺省=继承既有指派钻——参数微调不强迫重选钻）
    let stones = existing?.stones ?? []
    if (input.stoneIdx !== undefined && input.stoneIdx.length > 0) {
      const byIdx = new Map(state.detail.stoneCandidates.map((candidate) => [candidate.idx, candidate] as const))
      stones = input.stoneIdx.map((idx) => {
        const candidate = byIdx.get(idx)
        if (candidate === undefined) {
          throw new Error(`stone-invalid：stoneIdx=${idx} 不在候选表（1..${state.detail.stoneCandidates.length}）`)
        }
        return {
          resourceId: candidate.resourceId,
          sku: candidate.sku,
          supplier: candidate.supplier,
          sizeMm: candidate.sizeMm,
          colorHex: candidate.colorHex,
        }
      })
      if (input.strategyKind !== 'exclusion' && !stones.some((stone) => stone.sizeMm !== null)) {
        throw new Error('stone-unsized：指派缺少尺寸依据（至少 1 款 sizeMm 非空候选钻）')
      }
    }
    const next: StrategyAssignment = {
      nodeId: input.nodeId,
      strategyKind: input.strategyKind,
      params: input.params,
      stones,
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
    // 笔迹资源上限（Codex 复评建议二——daemon/契约三侧同源纯函数）：坐标 0..imagePx
    // 界内+段长上限+单笔插值步数上限——超限 typed 拒 mask-invalid（极值坐标不进扫掠）。
    const workloadError = brushWorkloadError(input.ops, state.treeMeta.imagePx)
    if (workloadError !== null) {
      throw new Error(`mask-invalid：笔迹工作量超限：${workloadError}`)
    }
    const resolved = this.resolveMaskBitsOf(state, node.mask)
    const { w, h } = resolved
    const bits = new Uint8Array(resolved.bits)
    // 涂写工作量预算（daemon 同式）：stamp 界内覆盖像素累计——超预算 typed 拒。
    let paintedPx = 0
    for (const stroke of input.ops) {
      const value = stroke.op === 'add' ? 1 : 0
      // 圆盘沿折线扫掠（契约语义——2b 复核 P1-2）：相邻采样点线段插值（步长≤半径/2
      // ——pointer 事件间距大于直径时不断笔）；单点笔画退化为单圆盘。daemon 同式。
      const r = stroke.radiusPx
      const stepLen = Math.max(r / 2, 0.5)
      const stamp = (gx: number, gy: number): void => {
        const cx = gx - node.bbox.x
        const cy = gy - node.bbox.y
        const x0 = Math.max(0, Math.floor(cx - r))
        const x1 = Math.min(w - 1, Math.ceil(cx + r))
        const y0 = Math.max(0, Math.floor(cy - r))
        const y1 = Math.min(h - 1, Math.ceil(cy + r))
        if (x1 < x0 || y1 < y0) return
        paintedPx += (x1 - x0 + 1) * (y1 - y0 + 1)
        if (paintedPx > WORKBENCH_BRUSH_PAINT_BUDGET_PX) {
          throw new Error(`mask-invalid：笔迹涂写工作量超预算 ${WORKBENCH_BRUSH_PAINT_BUDGET_PX}px（大半径×长笔画——分多次提交）`)
        }
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const dx = xx + 0.5 - cx
            const dy = yy + 0.5 - cy
            if (dx * dx + dy * dy <= r * r) bits[yy * w + xx] = value
          }
        }
      }
      let prev: { x: number; y: number } | null = null
      for (const p of stroke.points) {
        if (prev !== null) {
          const dist = Math.hypot(p.x - prev.x, p.y - prev.y)
          const steps = Math.max(1, Math.ceil(dist / stepLen))
          for (let k = 1; k <= steps; k++) {
            stamp(prev.x + ((p.x - prev.x) * k) / steps, prev.y + ((p.y - prev.y) * k) / steps)
          }
        } else {
          stamp(p.x, p.y)
        }
        prev = p
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
    // 产物形态（daemon persistTree 同构阈值——MASK_INLINE_PERSIST_MAX_BYTES=4096）：
    // 大位面落新 blob ref（mock 内部 Map 版本化+taskArtifact 可拉回）；小位面 inline。
    node.mask =
      local.w * local.h > MASK_INLINE_PERSIST_MAX_BYTES
        ? { kind: 'blob', w: local.w, h: local.h, blobRef: this.nextMaskBlobRef(state) , }
        : encodeInlineMask(local.w, local.h, cropped)
    if (node.mask.kind === 'blob') state.maskBlobsByRef.set(node.mask.blobRef, cropped)
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
      // v3：previewMode 显式携带=写透；缺省=保留现值（daemon setViewState 同构）
      ...(input.previewMode !== undefined || state.viewState?.previewMode !== undefined
        ? { previewMode: input.previewMode ?? state.viewState?.previewMode }
        : {}),
      updatedAt: this.now(),
    }
    state.viewStateBlobRef = workbenchRef(`wb-${state.taskId}-viewstate-v${revision}`)
    this.syncProFaces(state)
    return { blobRef: state.viewStateBlobRef, revision }
  }

  /**
   * 任务导出 mock（taskExport——导出门真实接线 P0-1 同源）：以 maskEdits 重算门，
   * 阻断=typed 拒（blockers 完整清单）；放行=strategy-gems 工件字节（JSON→base64）
   * **按当前树叶子口径过滤**（v5 修复轮 R1——与 daemon 真身同构：父层旧钻不进
   * 导出字节；无剔除=恒等回放原 ref，有剔除=过滤后新文档+新 ref+degraded warning）。
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
    // v5 叶子口径（与 daemon effectiveGems 同源——nodeProducesBlock 单源谓词）
    const leafIds = new Set(state.nodes.filter(nodeProducesBlock).map((node) => node.id))
    const filtered = gemsDoc.gems.filter((gem) => leafIds.has(gem.blockId))
    if (filtered.length === gemsDoc.gems.length) {
      const bytes = new TextEncoder().encode(JSON.stringify(gemsDoc, null, 1))
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return {
        filename: `task-${input.taskId}-strategy-gems.json`,
        kind: 'strategy-gems',
        dataBase64: btoa(binary),
        blobRef: gemsRef!,
        gemCount: gemsDoc.gems.length,
      }
    }
    state.seq += 1
    const exportRef = workbenchRef(`wb-${input.taskId}-gems-export-v${state.seq}`)
    const exported = StrategyGemsViewSchema.parse({
      ...gemsDoc,
      gems: filtered,
      warnings: [
        ...gemsDoc.warnings,
        {
          kind: 'degraded',
          detail: `v5 叶子口径过滤：剔除 ${gemsDoc.gems.length - filtered.length} 颗父层（组）旧钻——组恒不产钻（与画布/徽标/顶栏读数同口径）`,
        },
      ],
    })
    state.gemsByRef.set(exportRef, exported)
    const bytes = new TextEncoder().encode(JSON.stringify(exported, null, 1))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return {
      filename: `task-${input.taskId}-strategy-gems.json`,
      kind: 'strategy-gems',
      dataBase64: btoa(binary),
      blobRef: exportRef,
      gemCount: filtered.length,
    }
  }

  /** maskEdits upsert（nodeId 主键——同节点后写覆盖）+detail 面同步。 */
  private upsertMaskEdit(state: MockWorkbenchState, edit: MaskEditStatus): void {
    state.maskEdits = [...state.maskEdits.filter((e) => e.nodeId !== edit.nodeId), edit]
    this.syncProFaces(state)
  }

  /**
   * 节点位面解码（inline 直返；blob 从 maskBlobsByRef 读——2b 复核 P0-3 blob 回写
   * 闭环的读面。缺席 ref=工件不可读 typed 拒，不猜测）。
   */
  private resolveMaskBitsOf(state: MockWorkbenchState, mask: ObjectNode['mask']): { w: number; h: number; bits: Uint8Array } {
    if (mask.kind === 'inline') return decodeInlineMask(mask)
    const bytes = state.maskBlobsByRef.get(mask.blobRef)
    if (bytes === undefined) {
      throw new Error(`mask blob 不可读：${mask.blobRef.slice(0, 12)}…（mock 内部位面库缺席）`)
    }
    if (bytes.byteLength !== mask.w * mask.h) {
      throw new RangeError(`mask blob 长度 ${bytes.byteLength} ≠ w*h=${mask.w * mask.h}`)
    }
    return { w: mask.w, h: mask.h, bits: bytes }
  }

  /** patch 产物的 blob ref 派生（版本号寻址——内容演进即新 ref）。 */
  private nextMaskBlobRef(state: MockWorkbenchState): string {
    return workbenchRef(`wb-${state.taskId}-mask-v${state.versions.length + 1}-${state.seq}`)
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
    // 快照入链（tree.revert 回放源——克隆隔离后续就地演进）
    state.snapshots.set(version, structuredClone(state.nodes))
    if (state.detail.tree !== null) {
      state.detail.tree = { ...state.detail.tree, blobRef: treeBlobRef, nodes: state.nodes }
    }
    state.detail.preview = { blobRef: previewBlobRef }
    return { treeBlobRef, previewBlobRef, version }
  }

  // ---------------- workbench-pro 2c 图层管理 mock（layerReorder/layerDelete/treeRevert——与 daemon 端点语义同构）

  /** CAS 门（三写共面——expectedTreeBlobRef ≠ 电流树工件即拒；错误文本携带电流引用）。 */
  private requireCasBaseline(state: MockWorkbenchState, expectedTreeBlobRef: string): void {
    const current = state.detail.tree?.blobRef
    if (current === undefined || current === null || current !== expectedTreeBlobRef) {
      throw new Error(`cas-mismatch：expectedTreeBlobRef ≠ 电流树 ${current ?? '(无)'}（同基线双写只成功一个——比对自己上次响应的 treeBlobRef 区分「已生效」与「他写」）`)
    }
  }

  /** 节点子树全集（含自身，DFS 先序）。 */
  private subtreeIdsOf(state: MockWorkbenchState, rootId: string): string[] {
    const byId = new Map(state.nodes.map((n) => [n.id, n] as const))
    const out: string[] = []
    const walk = (id: string): void => {
      const node = byId.get(id)
      if (node === undefined) return
      out.push(id)
      for (const child of node.children) walk(child)
    }
    walk(rootId)
    return out
  }

  /** 视图态锁定判定（viewState 工件为真源）。 */
  private isNodeLockedInState(state: MockWorkbenchState, nodeId: string): boolean {
    return state.viewState?.nodes.find((n) => n.nodeId === nodeId)?.locked === true
  }

  /**
   * 树重排 mock（layerReorder——与 daemon 真身同构）：CAS 门+根保护（parent===null
   * 拒）+newParent 归属门+环路拒（newParent ∈ 目标子树）+锁定拒（目标本体 locked；
   * 移动携带锁定后代的祖先=放行）。index=「移出 nodeId 后」的目标下标（越界夹取）。
   * 重排不增删节点 ⇒ assignments/gems 零触碰。
   */
  async layerReorder(input: LayerReorderInput): Promise<LayerReorderOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    this.requireCasBaseline(state, input.expectedTreeBlobRef)
    if (node.parent === null) {
      throw new Error(`root-protected：根/画布节点不可重排（单根树结构锚——「${node.objectName}」）`)
    }
    if (this.isNodeLockedInState(state, input.nodeId)) {
      throw new Error(`node-locked：节点「${node.objectName}」已被锁定（锁定=结构+遮罩面冻结——先解锁再移动）`)
    }
    const newParent = state.nodes.find((candidate) => candidate.id === input.newParentId)
    if (newParent === undefined) throw new Error(`parent-invalid：新父不在当前树：${input.newParentId}`)
    if (this.subtreeIdsOf(state, input.nodeId).includes(input.newParentId)) {
      throw new Error(`cycle：新父在目标子树内（${input.newParentId} ∈ ${input.nodeId} 子树——树成环必拒）`)
    }
    // 应用：旧父 children 移出 → 新父 children 目标下标插入（index 相对移出后数组）
    const oldParent = state.nodes.find((candidate) => candidate.id === node.parent)
    if (oldParent !== undefined) oldParent.children = oldParent.children.filter((id) => id !== input.nodeId)
    const siblings = newParent.children.filter((id) => id !== input.nodeId)
    const index = Math.min(Math.max(input.index, 0), siblings.length)
    siblings.splice(index, 0, input.nodeId)
    newParent.children = siblings
    node.parent = input.newParentId
    const version = this.pushVersion(state, 'reorder', `「${node.objectName}」→「${newParent.objectName}」#${index}`)
    return { treeBlobRef: version.treeBlobRef, previewBlobRef: version.previewBlobRef, version: version.version }
  }

  /**
   * 删子树 mock（layerDelete——与 daemon 真身同构）：CAS 门+根保护+锁定（目标或
   * 子树内任一 locked 拒）+子树全集出树+父收口+指派收敛移除+存量 gems 重算（被删
   * 块钻移除；空收敛=不落新 plan，gems=null 如实返回——D-2⑨）。
   */
  async layerDelete(input: LayerDeleteInput): Promise<LayerDeleteOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    this.requireCasBaseline(state, input.expectedTreeBlobRef)
    if (node.parent === null) {
      throw new Error(`root-protected：根/画布节点不可删（单根树结构锚——「${node.objectName}」）`)
    }
    const removedIds = this.subtreeIdsOf(state, input.nodeId)
    const lockedHit = removedIds.find((id) => this.isNodeLockedInState(state, id))
    if (lockedHit !== undefined) {
      const lockedNode = state.nodes.find((n) => n.id === lockedHit)
      throw new Error(`node-locked：子树内含锁定节点「${lockedNode?.objectName ?? lockedHit}」（删除破坏其结构面——先解锁再删）`)
    }
    // 父收口+子树全集出树
    const parent = state.nodes.find((candidate) => candidate.id === node.parent)
    if (parent !== undefined) parent.children = parent.children.filter((id) => id !== input.nodeId)
    state.nodes = state.nodes.filter((n) => !removedIds.includes(n.id))
    state.detail.tree =
      state.detail.tree === null ? null : { ...state.detail.tree, nodes: state.nodes }
    // 指派收敛（被删节点上的既有指派移除）
    const removedAssignmentNodeIds = state.detail.assignments
      .filter((a) => removedIds.includes(a.nodeId))
      .map((a) => a.nodeId)
    state.detail.assignments = state.detail.assignments.filter((a) => !removedIds.includes(a.nodeId))
    // mask 编辑留痕随子树出清
    state.maskEdits = state.maskEdits.filter((e) => !removedIds.includes(e.nodeId))
    // gems 重算：被删块钻移除；空收敛（无可保留钻且无剩余指派）=不落新 plan——gems=null（D-2⑨）
    let gems: LayerDeleteOutput['gems'] = null
    const currentDoc = state.detail.gems !== null ? state.gemsByRef.get(state.detail.gems.blobRef) : undefined
    if (currentDoc !== undefined) {
      const kept = currentDoc.gems.filter((gem) => !removedIds.includes(gem.blockId))
      if (kept.length > 0 || state.detail.assignments.length > 0) {
        state.seq += 1
        const gemsRef = workbenchRef(`wb-${state.taskId}-gems-v${state.seq}`)
        const previewRef = workbenchRef(`wb-${state.taskId}-gems-preview-v${state.seq}`)
        state.gemsByRef.set(gemsRef, StrategyGemsViewSchema.parse({ ...currentDoc, gems: kept }))
        state.detail.gems = { blobRef: gemsRef, count: kept.length, excludedRegions: state.detail.gems?.excludedRegions ?? 0 }
        state.detail.preview = { blobRef: previewRef }
        gems = { blobRef: gemsRef, count: kept.length }
      } else {
        state.detail.gems = null
      }
    }
    const version = this.pushVersion(state, 'delete', `删除「${node.objectName}」子树（${removedIds.length} 节点）`)
    this.syncProFaces(state)
    return {
      treeBlobRef: version.treeBlobRef,
      previewBlobRef: version.previewBlobRef,
      version: version.version,
      removedNodeIds: removedIds,
      removedAssignmentNodeIds,
      gems,
    }
  }

  /**
   * 整树快照回退 mock（treeRevert——undo tree-structure 域载体）：目标版本须在链上
   * （未知版本拒）；电流树替换为目标版本快照；revert 自身入史（快照=目标态克隆——
   * 历史只增不删）。assignments/gems 不回退（版本链只覆盖树结构面——D-3 域分离）。
   */
  async treeRevert(input: TreeRevertInput): Promise<TreeRevertOutput> {
    const state = this.requireWorkbench(input.taskId)
    const target = state.snapshots.get(input.version)
    if (target === undefined) {
      throw new Error(`unknown-version：版本 ${input.version} 不在 tree.history 链上（以 versions[].version 寻址）`)
    }
    state.nodes = structuredClone(target)
    state.detail.tree =
      state.detail.tree === null ? null : { ...state.detail.tree, nodes: state.nodes }
    const version = this.pushVersion(state, 'revert', `回退到 v${input.version}（revert 自身入史）`)
    return { treeBlobRef: version.treeBlobRef, previewBlobRef: version.previewBlobRef, version: version.version }
  }

  // ---------------- 终评 P0-1 恢复链 mock（maskEditRetry/maskEditDiscard——与 daemon 端点语义同构）

  /**
   * stale/error 重放重算 mock（maskEditRetry）：CAS（expectedBaseVersion 漂移拒）+
   * 态门（仅 stale/error）+同步重放（有指派=网格重演 regenGemsForNode——mock 同构
   * 重算面）→ 终态 ready 留痕返回。mock 无 error 态重算路径（作业不失败）——error
   * 态由造数/测试直改 maskEdits 注入。
   */
  async maskEditRetry(input: MaskEditRetryInput): Promise<MaskEditRetryOutput> {
    const state = this.requireWorkbench(input.taskId)
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node === undefined) throw new Error(`节点不存在：${input.nodeId}`)
    const edit = state.maskEdits.find((candidate) => candidate.nodeId === input.nodeId)
    if (edit === undefined) {
      throw new Error(`node-not-found：节点 ${node.objectName} 无编辑留痕（重算入口仅面向 stale/error 留痕）`)
    }
    if (edit.baseVersion !== input.expectedBaseVersion) {
      throw new Error(`cas-mismatch：编辑留痕 base_version 已漂移（期望 ${input.expectedBaseVersion}，电流 ${edit.baseVersion}——同节点新编辑已接管，刷新后以新留痕重入）`)
    }
    if (edit.state !== 'stale' && edit.state !== 'error') {
      throw new Error(`invalid-input：编辑留痕为 ${edit.state}（重算重放仅面向 stale/error）`)
    }
    // 重放重算（mock 同构）：有非排除指派=网格重演产新 gems；重算面成功 → ready。
    const assignment = state.detail.assignments.find((a) => a.nodeId === node.id)
    if (assignment !== undefined && assignment.strategyKind !== 'exclusion') {
      this.regenGemsForNode(state, node, assignment)
    }
    const next: MaskEditStatus = { ...edit, state: 'ready', error: null, updatedAt: this.now() }
    this.upsertMaskEdit(state, next)
    return { edit: structuredClone(next) }
  }

  /**
   * 确认放弃编辑留痕 mock（maskEditDiscard）：仅面向阻断留痕（stale/error/incomplete
   * ——与 daemon 同式）；CAS 漂移拒；行缺席=幂等 discarded:false；删行+detail 面同步
   * （mask 不回滚——门阻断面清空）。
   */
  async maskEditDiscard(input: MaskEditDiscardInput): Promise<MaskEditDiscardOutput> {
    const state = this.requireWorkbench(input.taskId)
    const edit = state.maskEdits.find((candidate) => candidate.nodeId === input.nodeId)
    if (edit === undefined) return { discarded: false }
    if (edit.baseVersion !== input.expectedBaseVersion) {
      throw new Error(`cas-mismatch：编辑留痕 base_version 已漂移（期望 ${input.expectedBaseVersion}，电流 ${edit.baseVersion}——同节点新编辑已接管，刷新后以新留痕重入）`)
    }
    if (edit.state !== 'stale' && edit.state !== 'error' && !edit.incomplete) {
      throw new Error(`invalid-input：编辑留痕为 ${edit.state}（行程 ${edit.runCount} 限内）——无阻断面可放弃（放弃仅面向 stale/error/incomplete 留痕）`)
    }
    state.maskEdits = state.maskEdits.filter((candidate) => candidate.nodeId !== input.nodeId)
    this.syncProFaces(state)
    return { discarded: true }
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
