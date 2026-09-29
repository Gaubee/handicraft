/*
 * Agent 会话 store（Svelte 5 runes——W3.1 Agent 主面的唯一状态源）。
 * 职责：会话列表/活跃会话/帧流缓冲（task 域 seq 去重——断线重连重订阅后
 * afterSeq 游标回放无缺失无重复）/审批应答/取消与清空/结果获取/连接态投影。
 * mock 与 rpc 双模式经 AgentApi 注入（默认 mock——W4 接线换 rpc）。
 */

import type { Frame, SessionSummary } from '@handicraft/contracts'
import { getSessionUser } from '$lib/stores/session.svelte'
import { showToast } from '$lib/stores/toast.svelte'
import { defaultAgentApiFactory } from './index.js'
import type { AgentApi, AgentConnectionState, AgentResultView, AgentTaskView } from './types.js'
import type { AttachmentMeta } from './attachments.js'

export interface PendingApproval {
  requestId: string
  tool: string
  proposalId: string
  summary: string
  expiresAt: string
  preview: { before: string; after: string }
  taskId: string
  /** [W6 6.2] 归属项目（会话标题或 sessionId 短码——批准挂项目域的归属呈现；可选=旧 daemon 帧）。 */
  projectLabel?: string
}

/**
 * 投递队列条目（add-agent-three-channel 2.3；zhumo 方案移植块 B 2026-09-28 升级）。
 * 贴钻队列=前端持有的待发外环（后端无 next-turn inbox 面的一次 followup=一个
 * task，运行中常规发送若立即投递会并行开任务）：消息在当前任务结束后按序自动
 * 以常规 followup 开跑（「当前轮结束后自动开跑」）。
 * mode 语义（zhumo W10k/W10m 单一有序序列同款）：queue=开轮锚点（下一轮逐条
 * 发送）；steer=引导（运行中投递进当前任务内核会话——下一 step 边界生效；
 * idle 等价开新轮）；inject=注入（作为上下文补充不唤醒——在下一次实际投递时
 * 以前缀并入，等价 zhumo「等下一次活动轮」的外环形态）。
 * held=暂停段边界标记（该条及其后暂停自动投递；zhumo lockBoundary 单源同款）。
 */
export interface AgentQueueItem {
  id: string
  text: string
  mode: 'queue' | 'steer' | 'inject'
  queuedAt: string
  /** 暂停段边界（唯一 held 条=边界；其后派生被动暂停）。 */
  held?: boolean
  /** [split-admin-portal 2.6] 图片附件元数据（纯图队列条目 text 可为空——契约
   * 「text 或 attachments 至少其一」；投递时映射为 followup attachments: blobRef[]）。 */
  attachments?: AttachmentMeta[]
}

let api: AgentApi | null = null
let mode = $state<'mock' | 'rpc'>('mock')
let connection = $state<AgentConnectionState>('mock')
let sessions = $state<SessionSummary[]>([])
let listCursor = $state<string | undefined>(undefined)
let activeSessionId = $state<string | null>(null)
/**
 * 会话代数（[Codex W10 P1-1]）：每次 openSession 自增——异步响应（会话详情/followup/
 * 队列开跑）只允许写入发起时的代数；中途切会话（代数漂移）的迟到响应整段丢弃，
 * 旧会话的任务/帧不得污染新会话视图。
 */
let sessionGeneration = 0
let activeTasks = $state<AgentTaskView[]>([])
let framesByTask = $state<Record<string, Frame[]>>({})
let resultBySession = $state<Record<string, AgentResultView>>({})
let sending = $state(false)
let creating = $state(false)
let clearing = $state(false)
let cancelling = $state(false)
let storeError = $state<string | null>(null)
let initialized = $state(false)

// 投递队列（三通道 2.2/2.3）：活跃会话域（openSession 切换即清）；editing=暂离
// 编辑中的条目 id（编辑期间自动开跑暂停——W10b 冻结语义的前端形态）。
let queueItems = $state<AgentQueueItem[]>([])
let queueEditingId = $state<string | null>(null)
let queueSeq = 0
let queueDispatchInFlight = false
/** 拖动排序进行中（zhumo W10m：帧驱动刷新与自动投递暂停——松手重排落定后恢复）。 */
let queueReordering = $state(false)
/** 投递失败熔断（失败条目放回队头后暂停自动开跑——防连败死循环；用户动作/新 done 帧复位）。 */
let queueDispatchBlocked = false

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

/**
 * 活跃会话的会话流：按任务序拼接全部帧（对话连续视图——无归属面消费方使用）。
 * v6 复核 P1-5：任务溯源面（done 卡/审批应答/artifact 归属）一律走
 * getActiveSessionTaskFrames（taskId 随组透传），不从压平流取全局最新任务。
 */
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

/** 投递队列（活跃会话域；按生效序）。 */
export function getAgentQueue(): AgentQueueItem[] {
  return queueItems
}

/** 暂离编辑中的条目 id（null=非编辑态）。 */
export function getAgentQueueEditingId(): string | null {
  return queueEditingId
}

/** 暂停段边界条 id（null=未暂停；zhumo lockBoundary 同源语义）。 */
export function getAgentQueueLockBoundary(): string | null {
  return queueItems.find((item) => item.held === true)?.id ?? null
}

/** 拖动排序进行中（QueueDrawer 的 onreordering 回调置位）。 */
export function getAgentQueueReordering(): boolean {
  return queueReordering
}

export function setAgentQueueReordering(value: boolean): void {
  queueReordering = value
}

/** 队列重排（拖动落定——外环本地真源，全量 id 序回写）。 */
export function reorderAgentQueue(orderedIds: string[]): void {
  const byId = new Map(queueItems.map((item) => [item.id, item]))
  const next: AgentQueueItem[] = []
  for (const id of orderedIds) {
    const item = byId.get(id)
    if (item) {
      next.push(item)
      byId.delete(id)
    }
  }
  // 未回传的条目（编辑中被移除等）按原序追加，不丢消息。
  queueItems = [...next, ...byId.values()]
  maybeDispatchAgentQueue()
}

/** 行级改投递方式（zhumo W10m：点模式徽标改 queue/steer/inject）。 */
export function setAgentQueueItemMode(id: string, mode: AgentQueueItem['mode']): void {
  queueItems = queueItems.map((item) => (item.id === id ? { ...item, mode } : item))
  // 改为 steer 且已脱离暂停段：运行中立即投递（下一 step 边界生效的贴钻外环
  // 形态——followup(mode=steer) 投递进运行中任务的内核会话）；idle 走 dispatch。
  maybeDispatchAgentQueue()
}

/** 暂停/恢复（zhumo W10m 显式化）：null=全段放回；id=边界移到该条（该条起
 * 暂停、其前恢复——单源=唯一 held 标记，段内被动暂停由位置派生）。 */
export function lockAgentQueue(messageId: string | null): void {
  if (messageId === null) {
    queueItems = queueItems.map((item) => ({ ...item, held: undefined }))
    maybeDispatchAgentQueue()
    return
  }
  queueItems = queueItems.map((item) => ({ ...item, held: item.id === messageId ? true : undefined }))
}

/** 活跃会话是否有运行中任务（排队通道的触发条件）。 */
export function isAgentTaskRunning(): boolean {
  const task = getActiveTask()
  return task !== null && (task.status === 'running' || task.status === 'queued')
}

/** 活跃会话最新任务（followup 产生的正在进行的任务）。 */
export function getActiveTask(): AgentTaskView | null {
  return activeTasks.length > 0 ? (activeTasks[activeTasks.length - 1] ?? null) : null
}

export function getSessionResult(sessionId: string | null): AgentResultView | null {
  if (sessionId === null) return null
  return resultBySession[sessionId] ?? null
}

/**
 * 未应答审批（approval-request 无对应 approval-resolved——会话流内派生）。
 * taskId=审批帧的**来源任务**（v6 复核 P1-5：按任务分组扫描，不由全局最新任务
 * 顶替——历史任务的审批应答/操作目标保持来源任务）。
 */
export function getPendingApproval(): PendingApproval | null {
  let pending: PendingApproval | null = null
  const resolved = new Set<string>()
  for (const group of getActiveSessionTaskFrames()) {
    for (const frame of group.frames) {
      if (frame.kind === 'approval-request') {
        pending = {
          requestId: frame.payload.requestId,
          tool: frame.payload.tool,
          proposalId: frame.payload.proposalId,
          summary: frame.payload.summary,
          expiresAt: frame.payload.expiresAt,
          preview: { before: frame.payload.preview.before, after: frame.payload.preview.after },
          taskId: group.taskId,
          ...(frame.payload.projectLabel !== undefined ? { projectLabel: frame.payload.projectLabel } : {}),
        }
      } else if (frame.kind === 'approval-resolved') {
        resolved.add(frame.payload.requestId)
        if (pending?.requestId === frame.payload.requestId) pending = null
      }
    }
  }
  if (pending !== null && resolved.has(pending.requestId)) return null
  return pending
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
  if (initialized) {
    // 重挂载（登录页往返——AgentView 随前台壳卸载/重挂）：会话归属用户可能已漂移，
    // 对齐检查（波 5 P2-5：登出换登录后列表残留旧用户）。
    await syncAgentSessionsForUser()
    return
  }
  initialized = true
  await refreshSessions()
  sessionsUserKey = agentSessionUserKey()
  const first = sessions[0]
  if (first) await openSession(first.id)
}

/**
 * 会话列表的登录用户键（username+role；null=未登录）。会话行 owner 域——列表/
 * 详情/帧全部按当前用户隔离，用户漂移（登录/登出/换号）时旧列表是旧用户残影。
 */
function agentSessionUserKey(): string | null {
  const user = getSessionUser()
  return user === null ? null : `${user.role}:${user.username}`
}

/** 列表当前归属的用户键（undefined=从未拉取）。 */
let sessionsUserKey: string | null | undefined

/**
 * 会话列表与登录用户对齐（波 5 P2-5：登出换登录后前台会话列表残留旧用户空态）。
 * 用户键漂移时重取列表+复位活跃视图（首会话自动打开；空列表清视图）；未漂移
 * no-op。双入口：initAgentStore（AgentView 重挂载）与 AgentView 的用户 effect
 * （挂载存续期间的登录/登出）——token 代际由 rpc 层自处理，此处只管列表真源。
 */
export async function syncAgentSessionsForUser(): Promise<void> {
  if (!initialized || api === null) return
  const key = agentSessionUserKey()
  if (key === sessionsUserKey) return
  sessionsUserKey = key
  await refreshSessions()
  const first = sessions[0]
  if (first) {
    await openSession(first.id)
  } else {
    unsubscribeAll()
    activeSessionId = null
    activeTasks = []
    framesByTask = {}
    queueItems = []
    queueEditingId = null
    queueDispatchBlocked = false
  }
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
  sessionGeneration = 0
  queueItems = []
  queueEditingId = null
  queueSeq = 0
  queueDispatchInFlight = false
  queueDispatchBlocked = false
  queueReordering = false
  sessionsUserKey = undefined
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
  const generation = ++sessionGeneration
  await guard(async () => {
    unsubscribeAll()
    activeSessionId = sessionId
    framesByTask = {}
    // 队列为活跃会话域（三通道 2.3）：切换即清（含编辑态）。
    queueItems = []
    queueEditingId = null
    queueDispatchBlocked = false
    const detail = await api!.getSession(sessionId)
    // [Codex W10 P1-1] 中途切会话：迟到响应作废（不写入新会话视图）。
    if (sessionGeneration !== generation) return
    activeTasks = detail.tasks
    for (const task of detail.tasks) {
      const replay = await api!.replay(sessionId, task.taskId, 0)
      if (sessionGeneration !== generation) return
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

/**
 * 发送（三通道 2.2）：
 * - 常规（缺省 followup）：会话有运行中任务 → 进投递队列（当前轮结束后自动开跑——
 *   贴钻一次 followup=一个 task，不并行开跑）；idle → 立即开新任务。
 * - steer（引导）：立即投递（运行中任务的下一 step 边界消费——同 taskId；idle 等价
 *   常规发送）。
 * [split-admin-portal 2.6.3] attachments：图片附件随消息同行——纯图消息（空文本+
 * 有附件）放行（契约「text 或 attachments 至少其一」）；运行中纯图=入队携带附件。
 * [add-task-stones-manifest-export 1.2] sourceSetId：仅会话首个常规 followup 有效
 * （选择器只在新会话首条输入态出现）；运行中 followup 走入队路径时丢弃（会话已有
 * 任务=首条早过，携带必被服务端 typed 拒——不进队列元数据）。
 * [add-task-stones-manifest-export 6.1] 新会话首条多图 → 自动拆会话（Owner 裁决
 * 2026-09-30）：触发门与 sourceSetId 仅首条同款（无任务行+无队列=首条输入态）；
 * 已开谈的会话多图=讨论插图语义不拆；单图/steer 走原路径零变化。
 */
export async function sendFollowup(
  text: string,
  mode: 'followup' | 'steer' = 'followup',
  attachments: AttachmentMeta[] = [],
  sourceSetId?: string,
): Promise<void> {
  const trimmed = text.trim()
  if (trimmed === '' && attachments.length === 0) return
  if (mode === 'followup' && isAgentTaskRunning()) {
    enqueueAgentQueue(trimmed, attachments)
    return
  }
  if (
    mode === 'followup' &&
    attachments.length > 1 &&
    activeSessionId !== null &&
    activeTasks.length === 0 &&
    queueItems.length === 0
  ) {
    await splitMultiImageFirstMessage(trimmed, attachments, sourceSetId)
    return
  }
  await deliverFollowup(trimmed, mode, attachments, sourceSetId)
}

/**
 * [6.1] 多图首条拆会话编排（studio 侧——daemon 零改动，复用 createSession+
 * followup 既有链）：N 张图=N 个新会话，每会话单图（image-1 语义天然成立——
 * 「导出第二张图=拒」提示随单图化自然消亡）。循环 N 次「createSession+
 * followup（同文本+图 i+同 sourceSetId）」。部分失败不强事务：已完成会话保留，
 * toast 报告成败明细；完成后刷新会话列表并打开第 1 个新会话。
 */
async function splitMultiImageFirstMessage(
  trimmed: string,
  attachments: AttachmentMeta[],
  sourceSetId?: string,
): Promise<void> {
  const created: string[] = []
  const failures: Array<{ index: number; message: string }> = []
  sending = true
  try {
    for (let i = 0; i < attachments.length; i += 1) {
      const image = attachments[i]!
      try {
        const session = await api!.createSession({
          title: (trimmed.length > 0 ? trimmed : image.name).slice(0, 48),
        })
        await api!.followup(session.sessionId, trimmed, 'followup', [image.blobRef], sourceSetId)
        created.push(session.sessionId)
      } catch (error) {
        failures.push({ index: i, message: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    sending = false
  }
  await refreshSessions()
  const first = created[0]
  if (first !== undefined) await openSession(first)
  if (failures.length === 0) {
    showToast(`已按图拆分为 ${attachments.length} 个会话`)
    return
  }
  const detail = failures.map((failure) => `第 ${failure.index + 1} 张：${failure.message}`).join('；')
  showToast(
    created.length > 0
      ? `已按图拆分：成功 ${created.length} 个、失败 ${failures.length} 个（${detail}）`
      : `按图拆会话全部失败（${detail}）`,
  )
}

/** 真实投递（新任务路径；steer idle 复用同路径）。返回 false=被守卫/失败拦截。 */
async function deliverFollowup(
  trimmed: string,
  mode: 'followup' | 'steer' = 'followup',
  attachments: AttachmentMeta[] = [],
  sourceSetId?: string,
): Promise<boolean> {
  const sessionId = activeSessionId
  const generation = sessionGeneration
  if (sessionId === null || sending) return false
  let ok = true
  await guard(async () => {
    sending = true
    try {
      const { taskId } = await api!.followup(
        sessionId,
        trimmed,
        mode,
        attachments.length > 0 ? attachments.map((meta) => meta.blobRef) : undefined,
        sourceSetId,
      )
      // [Codex W10 P1-1] 中途切会话：响应只写发起时的会话——代数漂移即丢弃
      // （旧会话任务由切回时的 openSession 重载，不污染当前视图/不挂泄漏订阅）。
      if (sessionGeneration !== generation || activeSessionId !== sessionId) return
      // steer 命中运行中任务 → 同 taskId（不新增行，帧走既有订阅）；新任务才登记。
      if (!activeTasks.some((task) => task.taskId === taskId)) {
        framesByTask[taskId] = []
        activeTasks = [...activeTasks, { taskId, status: 'running', lastSeq: 0, frameCount: 0 }]
        subscribeTask(taskId, 0)
      }
    } catch {
      ok = false
    } finally {
      sending = false
    }
  })
  return ok
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

/**
 * 打断当前轮（三通道 2.2，对齐 shufa b6cec8a stopPrompt）：tasks.stop → 任务回 done
 * （可续聊）；done 收口帧由帧流到达。乐观联动任务态（帧到前窗口期 composer 即离
 * running 态）；打断后队列按序自动开跑（[Codex W10 P0-2 裁定=前端外环] 队列延续由
 * 前端唯一真源负责——后端 inbox 不承诺，「当前轮结束」含打断收口）。
 */
export async function stopActiveTask(): Promise<void> {
  const task = getActiveTask()
  if (task === null || (task.status !== 'running' && task.status !== 'queued')) return
  await guard(async () => {
    await api!.stopTask(task.taskId)
    activeTasks = activeTasks.map((candidate) =>
      candidate.taskId === task.taskId ? { ...candidate, status: 'done' } : candidate,
    )
    maybeDispatchAgentQueue()
  })
}

// ---------------------------------------------------------------- 投递队列（三通道 2.3）

function enqueueAgentQueue(text: string, attachments: AttachmentMeta[] = []): void {
  queueSeq += 1
  queueItems = [
    ...queueItems,
    {
      id: `queue-${queueSeq}`,
      text,
      mode: 'queue',
      queuedAt: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  ]
  queueDispatchBlocked = false
}

/** 暂离编辑（W10b 语义的前端形态）：该条文本回填输入框（调用方校验输入框无草稿）；
 * 编辑期间自动开跑暂停（冻结），确认按原序放回。已有编辑/条目不在队返回 null。 */
export function beginAgentQueueEdit(id: string): string | null {
  if (queueEditingId !== null) return null
  const item = queueItems.find((candidate) => candidate.id === id)
  if (item === undefined) return null
  queueEditingId = id
  return item.text
}

/** 确认编辑：该条原位更新（原序不变），解除冻结并恢复自动开跑判定。 */
export function confirmAgentQueueEdit(text: string): void {
  const trimmed = text.trim()
  if (queueEditingId === null) return
  if (trimmed !== '') {
    queueItems = queueItems.map((item) => (item.id === queueEditingId ? { ...item, text: trimmed } : item))
  }
  queueEditingId = null
  queueDispatchBlocked = false
  maybeDispatchAgentQueue()
}

/** 取消编辑：队列按原样保留，解除冻结。 */
export function cancelAgentQueueEdit(): void {
  if (queueEditingId === null) return
  queueEditingId = null
  maybeDispatchAgentQueue()
}

/** 逐条删除（不在队幂等）。 */
export function removeAgentQueueItem(id: string): void {
  queueItems = queueItems.filter((item) => item.id !== id)
  if (queueEditingId === id) queueEditingId = null
}

/** 清空队列（编辑态一并解除）。 */
export function clearAgentQueue(): void {
  queueItems = []
  queueEditingId = null
}

/**
 * 自动开跑判定（zhumo W10k 单一有序序列的外环形态）：
 * - 暂停段：队头落在暂停段内（边界条或其后）→ 不跑（编辑/删除/拖动仍可）。
 * - 队头 inject：不唤醒（zhumo「作为上下文补充，等下一次活动轮」）——只有当
 *   其后出现可投递条目时，累积的 inject 文本以前缀并入该次投递。
 * - 队头 steer 且任务运行中：立即投递（followup(mode=steer) 投递进运行中任务的
 *   内核会话——下一 step 边界生效）；idle 等价常规开跑。
 * - 队头 queue：任务非运行（done 或无任务）才开跑。failed/cancelled 保守持有；
 *   投递失败条目放回队头并熔断（用户动作或下一次 done 复位——防连败死循环）。
 */
/** 队列消费序附件合并（blobRef 去重保序——inject 前缀与投递条目的附件同行投递）。 */
function mergeQueueAttachments(items: AgentQueueItem[]): AttachmentMeta[] {
  const byRef = new Map<string, AttachmentMeta>()
  for (const item of items) {
    for (const meta of item.attachments ?? []) {
      if (!byRef.has(meta.blobRef)) byRef.set(meta.blobRef, meta)
    }
  }
  return [...byRef.values()]
}

function maybeDispatchAgentQueue(): void {
  if (queueDispatchInFlight || queueEditingId !== null || queueDispatchBlocked || queueReordering) return
  if (queueItems.length === 0 || sending || activeSessionId === null) return
  const task = getActiveTask()
  const running = task !== null && (task.status === 'running' || task.status === 'queued')

  // 从队头扫描：跳过 inject（累积为上下文前缀）；命中首个 queue/steer 决定投递。
  let dispatchIndex = -1
  let dispatchMode: 'followup' | 'steer' = 'followup'
  for (let i = 0; i < queueItems.length; i += 1) {
    const item = queueItems[i]!
    if (item.held === true) break // 暂停段边界：其后整段不自动投递
    if (item.mode === 'inject') continue
    if (item.mode === 'steer') {
      dispatchIndex = i
      dispatchMode = 'steer'
      break
    }
    dispatchIndex = i
    dispatchMode = 'followup'
    break
  }
  if (dispatchIndex === -1) return // 全 inject/整段暂停：不唤醒（zhumo 语义原样）
  if (dispatchMode === 'followup' && running) return // queue：等当前轮结束
  if (dispatchMode === 'steer' && !running) dispatchMode = 'followup' // idle 引导等价开新轮

  // 投递条目 + 其前累积的 inject 前缀一并消费（按序移出队列）；附件按消费序
  // 合并去重（2.6——纯图队列条目 text 为空，附件即载荷本体）。
  const consumed = queueItems.slice(0, dispatchIndex + 1)
  const head = consumed[consumed.length - 1]!
  const injectPrefix = consumed
    .filter((item) => item.mode === 'inject')
    .map((item) => `[上下文补充] ${item.text}`)
    .join('\n')
  const payload = injectPrefix.length > 0 ? `${injectPrefix}\n\n${head.text}` : head.text
  const dispatchAttachments = mergeQueueAttachments(consumed)

  const generation = sessionGeneration
  queueItems = queueItems.slice(dispatchIndex + 1)
  queueDispatchInFlight = true
  void deliverFollowup(payload, dispatchMode, dispatchAttachments).then((ok) => {
    // [Codex W10 P1-1] 中途切会话：失败条目不回填进新会话的队列（代数漂移即丢弃）。
    if (!ok && sessionGeneration === generation) {
      queueItems = [...consumed, ...queueItems]
      queueDispatchBlocked = true
    }
  }).finally(() => {
    queueDispatchInFlight = false
    maybeDispatchAgentQueue()
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
      queueItems = []
      queueEditingId = null
      queueDispatchBlocked = false
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
    // 投递队列（三通道）：自然收口（done）后队头自动开跑；error 保守持有（上面
    // status→failed 已使 maybeDispatch 的 done 判定不通过）。
    if (frame.kind === 'done') {
      queueDispatchBlocked = false
      maybeDispatchAgentQueue()
    }
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
