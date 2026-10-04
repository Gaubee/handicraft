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
import { newTaskSessionTitles } from './newTaskComposer.js'
import { parseResumeRunNotice } from './resumeRun.js'
import { sessionAnchorOfHash, isNewTaskAnchorOfHash, startSessionRouteSync, writeSessionHash } from './sessionRoute.svelte.js'
import { bindViewRouteSessionSource } from '$lib/stores/view.svelte'

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
 * [中栏迁移 2026-10-02] 新建态（`#/new`——中栏 composer 表单）：路由派发/深链
 * 首开置位（openComposerView）；任何 openSession 置否。与 activeSessionId===null
 * （无会话空态——列表空/未知锚复位）同向但不等价：空态也呈表单（zhumo「未选中
 * =表单」），但 URL 是裸 `#/` 非 `#/new`。
 */
let composerActive = $state(false)
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
/**
 * [product-polish-w1 T2] 会话级自动批准开关（活跃会话域乐观真源——openSession 从
 * session.get 的 autoApprove 投影回读对齐；UI 开关本地即时翻转，随下一条 followup
 * 透传服务端持久化（最后写入者胜）。排队条目按投递时刻的现值携带——免值守跑批中
 * 翻转开关，后续轮次即跟随新值）。
 */
let sessionAutoApprove = $state(false)
/**
 * [product-polish-w2 T2 补抄 zhumo 强度 chip] 任务级模型/强度覆盖（zhumo 语义：
 * null=跟随默认）：会话域内存真源——随下一次 followup 携带（开任务那一刻锁定，
 * 贴钻「一次 followup=一个 task」语义下的任务级粒度；无 zhumo setTaskModel 热切
 * 面）。排队条目按投递时刻现值携带（与 autoApprove 同式）。openSession 切换即清。
 */
let modelOverride = $state<{ provider: string; model: string } | null>(null)
let effortOverride = $state<string | null>(null)
/**
 * 后台默认模型投影（effort-only 覆盖的模型身份来源——SessionStream 拉取
 * models.available 后回填；null=无已配路由，此时 effort-only 覆盖无投放面）。
 */
let sessionDefaultModel = $state<{ provider: string; model: string } | null>(null)
/**
 * [product-polish-w2 T3] 跳过的审批（本地清卡——requestId 集）。[w19-critic P2]
 * 会话域 Map+sessionStorage 持久化：此前单 Set 在 openSession（重开/重挂/路由
 * 往返）整体清空——过期卡「跳过」后重开即复活。改为按会话键存+落 sessionStorage
 * （重开同会话不再复活；帧真源不动——approval-request 帧保留在转录流）。
 */
let skippedApprovalsBySession = $state<Record<string, string[]>>(readSkippedApprovals())

const SKIPPED_APPROVALS_STORAGE_KEY = 'rhinestone-studio.skipped-approvals.v1'

function readSkippedApprovals(): Record<string, string[]> {
  try {
    const raw = sessionStorage.getItem(SKIPPED_APPROVALS_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [sessionId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) out[sessionId] = ids
    }
    return out
  } catch {
    return {}
  }
}

function writeSkippedApprovals(): void {
  try {
    sessionStorage.setItem(SKIPPED_APPROVALS_STORAGE_KEY, JSON.stringify(skippedApprovalsBySession))
  } catch {
    // 隐私模式/配额拒写——内存集仍生效（本页生命周期内不复活）。
  }
}

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

/** [中栏迁移] 新建态（`#/new` 路由派生）——AgentView 据此切换中栏表单。 */
export function isComposerActive(): boolean {
  return composerActive
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

/** [product-polish-w1 T2] 活跃会话的自动批准开关（乐观真源——随下一条 followup 透传）。 */
export function getSessionAutoApprove(): boolean {
  return sessionAutoApprove
}

/**
 * [product-polish-w1 T2 → prod-run-8317 复盘修订，2026-10-03] 开关翻转：本地即时
 * （乐观）+ **活跃会话域即刻落库**（session.setAutoApprove RPC）。原实现只随下一
 * 条 followup 透传——免值守场景「提交后开开关」再无用户消息，服务端真源停在 0，
 * propose 不签发 grant 卡死整轮（8317 生产实测 10m41s 停滞）。落库失败回滚本地态
 * 并走 storeError 既有呈现面；followup 携带保留（同值幂等，最后写入者胜不漂移）。
 * 免值守语义：开启后**新发起**的 proposal 自动批（服务端单点只对 propose 时刻生效
 * ——历史积压不追补）。
 */
export function setSessionAutoApprove(value: boolean): void {
  const previous = sessionAutoApprove
  sessionAutoApprove = value
  const sessionId = activeSessionId
  if (sessionId === null || api === null) return
  void guard(async () => {
    try {
      await api!.setAutoApprove(sessionId, value)
    } catch (error) {
      if (sessionAutoApprove === value) sessionAutoApprove = previous // 回滚（用户此间又翻转则不覆盖）
      throw error
    }
  })
}

// --------------------------------------------- 任务级模型/强度覆盖（product-polish-w2 T2）

/** 任务级模型覆盖（null=跟随后台默认）。 */
export function getAgentModelOverride(): { provider: string; model: string } | null {
  return modelOverride
}

/** 任务级强度覆盖（null=跟随默认档）。 */
export function getAgentEffortOverride(): string | null {
  return effortOverride
}

/** 后台默认模型回填（SessionStream 拉 models.available 后注入——effort-only 覆盖的身份源）。 */
export function setAgentDefaultModel(value: { provider: string; model: string } | null): void {
  sessionDefaultModel = value
}

/** [task-detail-tabs] 后台默认模型读面（详情元数据行——null=未回填/无已配路由）。 */
export function getAgentDefaultModel(): { provider: string; model: string } | null {
  return sessionDefaultModel
}

/**
 * 任务级模型覆盖写入（ComposerCard 模型 chip）——新模型不在当前强度档目录时
 * 同步清强度覆盖（悬空档不留，防发送期 typed 拒）。
 */
export function setAgentModelOverride(provider: string, model: string): void {
  modelOverride = { provider, model }
  if (effortOverride !== null) {
    // 悬空防御：目录校验在 chip 选择器层有（efforts 只来自当前模型目录），此处
    // 兜底清档（切换后旧档不跨模型携带）。
    effortOverride = null
  }
}

/** 任务级强度覆盖写入（null=回跟默认；zhumo 语义「跟随默认」选项）。 */
export function setAgentEffortOverride(effort: string | null): void {
  effortOverride = effort
}

/** followup 载荷的 model 投影（undefined=不带键——跟随后台默认的线上形状零漂移）。 */
function followupModelPayload(): { provider: string; model: string; effort?: string } | undefined {
  const identity = modelOverride ?? sessionDefaultModel
  if (identity === null) return undefined
  if (effortOverride === null && modelOverride === null) return undefined
  return { provider: identity.provider, model: identity.model, ...(effortOverride !== null ? { effort: effortOverride } : {}) }
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
 * 全部未应答审批（[product-polish-w2 T3] 审批 zStack 数据面：**帧序排列=按帧序
 * 排队逐个处理**（Owner 指令「多个审批按顺序一个个来」）；本地跳过的（过期/
 * 终态卡）不计入）。taskId=审批帧的**来源任务**（v6 复核 P1-5）。
 */
export function getPendingApprovals(): PendingApproval[] {
  const pending: PendingApproval[] = []
  const resolved = new Set<string>()
  const skipped = new Set(skippedApprovalsBySession[activeSessionId ?? ''] ?? [])
  for (const group of getActiveSessionTaskFrames()) {
    for (const frame of group.frames) {
      if (frame.kind === 'approval-request') {
        pending.push({
          requestId: frame.payload.requestId,
          tool: frame.payload.tool,
          proposalId: frame.payload.proposalId,
          summary: frame.payload.summary,
          expiresAt: frame.payload.expiresAt,
          preview: { before: frame.payload.preview.before, after: frame.payload.preview.after },
          taskId: group.taskId,
          ...(frame.payload.projectLabel !== undefined ? { projectLabel: frame.payload.projectLabel } : {}),
        })
      } else if (frame.kind === 'approval-resolved') {
        resolved.add(frame.payload.requestId)
      }
    }
  }
  return pending.filter((item) => !resolved.has(item.requestId) && !skipped.has(item.requestId))
}

/**
 * 未应答审批（单卡兼容面——旧消费者；队首=最旧帧序）。
 */
export function getPendingApproval(): PendingApproval | null {
  return getPendingApprovals()[0] ?? null
}

/**
 * [product-polish-w2 T3] 跳过审批卡（本地清卡不入审批账）：服务端 TTL 已过/
 * 任务已终态的未决 proposal 天然失效（authorization consume 必拒 proposal-expired
 * ——跳过不 answer 不入账）；帧真源不动（approval-request 帧保留在转录流）。
 * [w19-critic P2] 按会话键存+持久化——openSession 重开/组件重挂/重订阅不再复活。
 */
export function skipPendingApproval(requestId: string): void {
  if (activeSessionId === null) return
  const current = skippedApprovalsBySession[activeSessionId] ?? []
  if (current.includes(requestId)) return
  skippedApprovalsBySession = { ...skippedApprovalsBySession, [activeSessionId]: [...current, requestId] }
  writeSkippedApprovals()
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
    // [Owner 报障 2026-10-03「会话列表加载不出来」] 首载恰落断线窗口（如服务端重启）
    // → listSessions 失败、列表空，此后重连恢复也无重试路径——侧栏永久空。连接
    // open（含重连）时列表仍空则补拉（in-flight 由 refreshSessions 内部分流：在途
    // →记 pending 于 finally 自动补拉，不在此处挡——挡了 pending 通路就断）。
    if (state === 'open' && initialized && sessions.length === 0) {
      void refreshSessions()
    }
  })
  connection = next.connection()
}

/** 首次进入 Agent 主面：拉列表 + 自动打开最近会话（已绑定 API 不重复绑定——测试注入面）。 */
export async function initAgentStore(next?: AgentApi): Promise<void> {
  if (next) bindAgentApi(next)
  else if (!api) bindAgentApi(defaultAgentApiFactory())
  if (!api) throw new Error('Agent API 未绑定')
  // [unify-studio-routing] view 路由镜像的会话段回填源（provider 注入——view store
  // 格式化 agent 路由时读活跃会话/composer 态；store→view 单向，view 不反向依赖）。
  bindViewRouteSessionSource({ session: getActiveSessionId, composer: isComposerActive })
  if (initialized) {
    // 重挂载（登录页往返——AgentView 随前台壳卸载/重挂）：会话归属用户可能已漂移，
    // 对齐检查（波 5 P2-5：登出换登录后列表残留旧用户）。
    await syncAgentSessionsForUser()
    return
  }
  initialized = true
  await refreshSessions()
  sessionsUserKey = agentSessionUserKey()
  // [product-polish-w1 T1] 反向同步启动（hashchange/popstate → openSession——幂等；
  // 未初始化窗口的深链由下方首开直接消费）。[中栏迁移] `#/new` 派发 openComposer
  // （清选中视图进中栏表单态——不创建会话、不回写 hash）。
  startSessionRouteSync({
    openSession,
    activeSessionId: () => activeSessionId,
    initialized: () => initialized,
    openLatest: () => {
      const first = sessions[0]
      if (first && first.id !== activeSessionId) void openSession(first.id, { fromHash: true })
    },
    openComposer: openComposerView,
  })
  // 首开深链 `#/new`（zhumo 三态）：新建态——不开任何会话（中栏表单），hash 不动。
  if (isNewTaskAnchorOfHash(location.hash)) {
    composerActive = true
    return
  }
  // 首开：深链锚**只在列表内**才打开它；未知锚（mock→rpc 模式切换残留的 fixture
  // id / 已删会话——[fixture 边界 2026-10-02]）=清锚回列表态，不 fallback 渲染
  // 任何会话（融合形态下中栏呈新任务表单）；无锚=列表序第一（zhumo `#/`
  // 默认最新）。空列表=无会话态，hash 回裸 `#/`。
  const anchor = sessionAnchorOfHash(location.hash)
  if (anchor !== null && !sessions.some((candidate) => candidate.id === anchor)) {
    writeSessionHash(null)
    return
  }
  const first = anchor !== null ? (sessions.find((candidate) => candidate.id === anchor) ?? null) : (sessions[0] ?? null)
  if (first) await openSession(first.id)
  else writeSessionHash(null)
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
    resetActiveSessionView()
    // 跳过集（会话键 Map）不清：会话 id 服务端唯一（用户域隔离），残留键无害。
  }
}

/**
 * 活跃视图复位到列表态（无选中）：清订阅/任务/帧/队列+会话域开关+锚（`#/`）。
 * 消费方：用户漂移后的空列表、[fixture 边界 2026-10-02] 未知会话 id 的
 * openSession 失败复位（rpc 下 hash 残留指向 fixture/已删会话——不留幽灵
 * 选中态、不清锚即每轮重进都打一次注定失败的会话读）。
 */
function resetActiveSessionView(): void {
  unsubscribeAll()
  activeSessionId = null
  activeTasks = []
  framesByTask = {}
  queueItems = []
  queueEditingId = null
  queueDispatchBlocked = false
  sessionAutoApprove = false
  modelOverride = null
  effortOverride = null
  composerActive = false
  writeSessionHash(null)
}

/**
 * [中栏迁移 2026-10-02] 进入新建态（`#/new` 反向派发/深链首开）：清选中视图
 * （订阅/任务/帧/队列/会话域开关）不创建任何会话——zhumo route.composer 分支
 * 同款（selectedId=null+frames 清空）。**不回写 hash**（URL 是该向真源——回写
 * 会把 `#/new` 改掉）。幂等：已在新建态 no-op（重复 hashchange/回退往返）。
 */
export function openComposerView(): void {
  if (composerActive && activeSessionId === null) return
  unsubscribeAll()
  activeSessionId = null
  activeTasks = []
  framesByTask = {}
  queueItems = []
  queueEditingId = null
  queueDispatchBlocked = false
  sessionAutoApprove = false
  modelOverride = null
  effortOverride = null
  composerActive = true
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
  composerActive = false
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
  sessionAutoApprove = false
  modelOverride = null
  effortOverride = null
  sessionDefaultModel = null
  skippedApprovalsBySession = {}
  try {
    sessionStorage.removeItem(SKIPPED_APPROVALS_STORAGE_KEY)
  } catch {
    // 非可写存储环境——内存集已清即可。
  }
}

async function guard(run: () => Promise<void>): Promise<void> {
  storeError = null
  try {
    await run()
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error)
  }
}

/**
 * [2026-10-03 连接恢复补拉] 列表拉取 in-flight 守卫（防首载与重连补拉并发重复）。
 * [Codex P1-2 同日] open 事件恰逢首载在途会被守卫跳过、此后首载失败且无新 open
 * → 列表永久空的交错：跳过时记 pending，finally 里列表仍空则自动补拉一次（自愈
 * 不依赖后续事件）。
 */
let sessionsRefreshing = false
let sessionsRefreshPending = false

export async function refreshSessions(): Promise<void> {
  if (sessionsRefreshing) {
    sessionsRefreshPending = true
    return
  }
  sessionsRefreshing = true
  try {
    await guard(async () => {
      const out = await api!.listSessions({ limit: 100 })
      sessions = out.sessions
      listCursor = out.nextCursor
    })
  } finally {
    sessionsRefreshing = false
    if (sessionsRefreshPending && sessions.length === 0) {
      sessionsRefreshPending = false
      void refreshSessions()
    } else {
      sessionsRefreshPending = false
    }
  }
}

/**
 * 打开（切换）会话。opts.fromHash（T1）=本次打开由 hash 反向派发（回退/深链/
 * 手改 URL）——不回写 hash（URL 是该向真源）；程序化/UI 选中（缺省）写 hash
 * 镜像 `#/t/{id}`（replaceState 防历史污染——见 sessionRoute.svelte.ts）。
 * opts.pushHistory（[中栏迁移] composer 创建成功链）=pushState 在 `#/new` 之上
 * 叠新会话锚——浏览器后退可回新建态（zhumo navigate 进栈同款）。
 * 任何 openSession 都退出新建态（composerActive=false——中栏切回对话流）。
 * [T2] 会话详情回读 autoApprove 投影对齐本地开关（服务端真源——刷新/重开保持）。
 */
export async function openSession(sessionId: string, opts?: { fromHash?: boolean; pushHistory?: boolean }): Promise<void> {
  const generation = ++sessionGeneration
  composerActive = false
  // [fixture 边界 2026-10-02] 会话读失败且 id 不在已知列表（hash 残留指向 fixture/
  // 已删会话）→ 复位到列表态+清锚。已知会话的瞬态失败（网络抖动）保持旧行为：
  // 错误条+选中不动（重连后自愈），不误杀有效锚。
  let unknownSession = false
  await guard(async () => {
    unsubscribeAll()
    activeSessionId = sessionId
    if (opts?.fromHash !== true) writeSessionHash(sessionId, { push: opts?.pushHistory === true })
    framesByTask = {}
    // 队列为活跃会话域（三通道 2.3）：切换即清（含编辑态）；任务级模型/强度
    // 覆盖同为会话域（product-polish-w2）。跳过审批集不再清（[w19-critic P2]
    // 会话键 Map——重开同会话过期卡不复活）。
    queueItems = []
    queueEditingId = null
    queueDispatchBlocked = false
    modelOverride = null
    effortOverride = null
    let detail: Awaited<ReturnType<AgentApi['getSession']>>
    try {
      detail = await api!.getSession(sessionId)
    } catch (error) {
      unknownSession = !sessions.some((candidate) => candidate.id === sessionId)
      throw error
    }
    // [Codex W10 P1-1] 中途切会话：迟到响应作废（不写入新会话视图）。
    if (sessionGeneration !== generation) return
    sessionAutoApprove = detail.session.autoApprove === true
    activeTasks = detail.tasks
    for (const task of detail.tasks) {
      const replay = await api!.replay(sessionId, task.taskId, 0)
      if (sessionGeneration !== generation) return
      framesByTask[task.taskId] = replay.frames
      subscribeTask(task.taskId, replay.nextSeq)
    }
    await tryLoadResult(sessionId)
  })
  if (unknownSession && sessionGeneration === generation) resetActiveSessionView()
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
 * [真链复验 P1-G] 会话改名：服务端 trim 落库后以回显标题就地更新列表行
 * （错误经 guard/storeError 既有呈现面——标题不变）。
 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  await guard(async () => {
    const out = await api!.renameSession(sessionId, title)
    const hit = sessions.find((candidate) => candidate.id === sessionId)
    if (hit) {
      hit.title = out.title
      hit.updatedAt = new Date().toISOString()
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
  const { created, failures } = await createSessionsPerImage({
    images: attachments,
    text: trimmed,
    sourceSetId,
    autoApprove: sessionAutoApprove,
    model: followupModelPayload(),
    titleFor: (_index, image) => (trimmed.length > 0 ? trimmed : image.name),
  })
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

/**
 * [new-task-panel 2026-10-02] 开始新任务面板提交编排（Owner 需求：多图=并发
 * 创建多个会话——不是提示词实现）：每图一个新会话+同一表单参数（首消息模板/
 * sourceSetId/模型覆盖）。标题带序号（newTaskSessionTitles——「贴钻 · 3 张之 2」
 * 或文件名）；单图=正常单会话创建（无汇总 toast，与既有单发同静默）；多图
 * 成功=「已并发创建 N 个会话」。部分失败同 6.1 弱事务语义（保留已建成+明细
 * toast）；返回 true=至少一个会话已创建（面板据此关闭）。
 */
export interface NewTaskSubmission {
  /** 已上传图片元数据（≥1；每会话恰一张走附件面）。 */
  images: AttachmentMeta[]
  /** 模板拼装后的首消息（buildNewTaskFirstMessage 产物）。 */
  firstMessage: string
  /** 用户指令原文（标题基推导用）。 */
  instruction: string
  /** 选定组合（智能选钻=undefined——不绑定 sourceSetId）。 */
  sourceSetId?: string
  /** 任务级模型/强度覆盖（面板 ComposerCard 选择；null=跟随默认）。 */
  model?: { provider: string; model: string; effort?: string }
}

export async function submitNewTask(submission: NewTaskSubmission): Promise<boolean> {
  const { images, firstMessage, instruction, sourceSetId, model } = submission
  if (images.length === 0) return false
  const titles = newTaskSessionTitles(instruction, images)
  const { created, failures } = await createSessionsPerImage({
    images,
    text: firstMessage,
    sourceSetId,
    // [Owner 2026-10-02 裁决] 新建会话继承当前自动批准开关值（无活跃会话时=上次
    // 会话遗留的模块级态——与拆会话路径同源，免值守不因新建断档）。
    autoApprove: sessionAutoApprove,
    model,
    titleFor: (index) => titles[index] ?? '贴钻',
  })
  await refreshSessions()
  const first = created[0]
  // [中栏迁移] 创建成功=pushState 叠新会话锚（`#/new` 之上）——浏览器后退可回
  // 新建态（zhumo openTask navigate 进栈同款；其余 openSession 仍 replaceState）。
  if (first !== undefined) await openSession(first, { pushHistory: true })
  if (failures.length === 0) {
    if (created.length > 1) showToast(`已并发创建 ${created.length} 个会话——每张图独立排钻`)
    return true
  }
  const detail = failures.map((failure) => `第 ${failure.index + 1} 张：${failure.message}`).join('；')
  showToast(
    created.length > 0
      ? `已创建 ${created.length} 个会话、失败 ${failures.length} 个（${detail}）`
      : `创建会话全部失败（${detail}）`,
  )
  return created.length > 0
}

/**
 * 每图一会的批量创建内环（6.1 拆会话与 new-task 面板共用）：循环「createSession
 * （titleFor 命名）→ followup（同文本+图 i 附件+同 sourceSetId/autoApprove/model）」。
 * 部分失败不强事务（错误逐张记账继续）；sending 全程锁定（与单发互斥）。
 */
async function createSessionsPerImage(options: {
  images: AttachmentMeta[]
  text: string
  sourceSetId?: string
  autoApprove?: boolean
  model?: { provider: string; model: string; effort?: string }
  titleFor: (index: number, image: AttachmentMeta) => string
}): Promise<{ created: string[]; failures: Array<{ index: number; message: string }> }> {
  const created: string[] = []
  const failures: Array<{ index: number; message: string }> = []
  sending = true
  try {
    for (let i = 0; i < options.images.length; i += 1) {
      const image = options.images[i]!
      try {
        // 派生预览标题不钉死（titlePinned=false）：即时可辨（多图序号/文件名），
        // 三级自动命名后续可升级为语义标题（识图命名天然按内容区分多图）。
        const session = await api!.createSession({
          title: options.titleFor(i, image).slice(0, 48),
          titlePinned: false,
        })
        await api!.followup(
          session.sessionId,
          options.text,
          'followup',
          [image.blobRef],
          options.sourceSetId,
          options.autoApprove,
          options.model,
        )
        created.push(session.sessionId)
      } catch (error) {
        failures.push({ index: i, message: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    sending = false
  }
  return { created, failures }
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
        // [product-polish-w1 T2] 会话级开关随投递透传（true/false 均为权威写入——
        // 关闭也让服务端真源翻回；排队条目按投递时刻现值携带）。
        sessionAutoApprove,
        // [product-polish-w2 T2] 任务级模型/强度覆盖（仅 followup 通道——steer 是
        // 裸文本改口，模型/强度属新任务面被服务端 typed 拒；排队条目按投递时刻
        // 现值携带，与 autoApprove 同式）。
        mode === 'followup' ? followupModelPayload() : undefined,
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

/**
 * 死 proposal 判定（[unify-studio-routing sweep ⑤] 旧 bundle 残留审批卡收口）：
 * daemon ApprovalService.answer 对过期/已消费/不存在/跨会话的 request 必拒（文案
 * 契约——authorization.ts）。此类拒绝下审批卡留在 zStack 只会「反复请求批准而死
 * 循环」（重放应答必拒）——按拒绝语义本地清卡（同跳过：不入审批账）。
 */
const DEAD_APPROVAL_RE = /审批请求已过期|审批请求已处理|审批请求不存在|审批请求不属于该会话/

export async function answerApproval(requestId: string, approved: boolean): Promise<void> {
  const sessionId = activeSessionId
  if (sessionId === null) return
  await guard(async () => {
    try {
      await api!.answer(sessionId, requestId, approved)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (DEAD_APPROVAL_RE.test(message)) {
        // 消费/过期态判定：服务端已判死——本地清卡（帧真源不动）+toast 告知，不再留卡。
        skipPendingApproval(requestId)
        showToast(`该审批已失效，卡片已移除——${message}`)
        return
      }
      throw error // 瞬态错误（网络/断线）：卡保留可重试
    }
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
      else writeSessionHash(null)
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

/** 会话列表节流刷新（title 最后一公里——前沿节流：首次触发立即拉取，30s 窗口
 * 抑制后续——叙述/终态帧驱动，异步标题升级对驻留页面尽快显形）。 */
let sessionListRefreshAt = 0
function scheduleSessionListRefresh(): void {
  if (Date.now() - sessionListRefreshAt < 30_000) return
  sessionListRefreshAt = Date.now()
  if (sessions.length > 0) void refreshSessions()
}

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
  // [title 最后一公里 2026-10-03] assistant 叙述/终态帧上节流刷新会话列表——异步
  // LLM 标题升级（首轮叙述附近落库）对驻留页面显形（此前 reload 才见）。30s 节流
  // 防高频帧刷表；transcript user 帧（续跑通知）不触发（与标题无关）。
  if (frame.kind === 'done' || frame.kind === 'error' || (frame.kind === 'transcript' && frame.payload.role === 'assistant')) {
    scheduleSessionListRefresh()
  }
  // [P0 批准唤醒可见性 θ] 系统续跑通知帧（daemon 在原任务流上发的 transcript user
  // 帧）：解析出新 taskId → 登记+回放+订阅——服务端发起的续跑轮立即可见（此前
  // 只订阅客户端自开任务，批准后的续跑对 UI 不可见=「点批准后无续跑」感知病灶）。
  if (frame.kind === 'transcript' && frame.payload.role === 'user') {
    const wakeTaskId = parseResumeRunNotice(frame.payload.text)
    if (wakeTaskId !== null) adoptResumeRunTask(wakeTaskId)
  }
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

/**
 * [θ 接线] 登记服务端发起的续跑任务（幂等——已在册/会话已切走即跳过）。replay
 * 归零回放后接续订阅；代数守卫与 deliverFollowup 同式（迟到的 replay 不写入新
 * 会话视图）。void 化：ingestFrame 同步返回，注册链在后台收敛。
 */
function adoptResumeRunTask(wakeTaskId: string): void {
  if (api === null || activeSessionId === null) return
  if (activeTasks.some((task) => task.taskId === wakeTaskId)) return
  if (framesByTask[wakeTaskId] === undefined) framesByTask[wakeTaskId] = []
  activeTasks = [...activeTasks, { taskId: wakeTaskId, status: 'running', lastSeq: 0, frameCount: 0 }]
  const sessionId = activeSessionId
  const generation = sessionGeneration
  void api
    .replay(sessionId, wakeTaskId, 0)
    .then((replay) => {
      // 中途切会话：迟到回放丢弃（切回时 openSession 会重载全量任务）。
      if (sessionGeneration !== generation || activeSessionId !== sessionId) return
      framesByTask[wakeTaskId] = replay.frames
      activeTasks = activeTasks.map((task) =>
        task.taskId === wakeTaskId
          ? { ...task, lastSeq: replay.nextSeq, frameCount: replay.frames.length }
          : task,
      )
      subscribeTask(wakeTaskId, replay.nextSeq)
    })
    .catch(() => {
      // 回放失败（任务行不可见窗口等）：撤登记不留空壳行（下次通知/重开自愈）。
      if (sessionGeneration !== generation || activeSessionId !== sessionId) return
      activeTasks = activeTasks.filter((task) => task.taskId !== wakeTaskId)
    })
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
