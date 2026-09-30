/*
 * RPC 适配器（@orpc/client RPCLink over 同源 /ws/rpc?token= + /ws/tasks/:id 帧流）。
 * W3.1 交付传输层与契约对齐的 façade；服务端 session.followup/answer 归 W4 接线——
 * 本层不 mock 服务端行为，只在真实 daemon 同源部署时可用（mode 选择见 index.ts）。
 * 连接管理：匿名 token 解析（POST /api/auth/anonymous，sessionStorage 缓存）+
 * WS 断线重连（指数退避，上限 15s；首连失败同样进入重连状态机——不卡 connecting）
 * + 帧订阅重挂（调用方持 afterSeq 游标）。
 * 守门（W3 评审 P2-2）：读面与 mutation 输出全部经对应 contracts 输出 schema parse——
 * 漂移响应在 façade 层拒绝，不穿透到 UI。
 */

import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import {
  FrameSchema,
  LayerDeleteOutputSchema,
  LayerReorderOutputSchema,
  LayerRenameOutputSchema,
  SessionAnswerOutputSchema,
  SessionCancelOutputSchema,
  SessionClearOutputSchema,
  SessionCreateOutputSchema,
  SessionFollowupOutputSchema,
  SessionGetOutputSchema,
  SessionListOutputSchema,
  SessionReplayOutputSchema,
  SessionResultOutputSchema,
  AssetsUploadOutputSchema,
  SegmentOneOutputSchema,
  TaskArtifactOutputSchema,
  TaskDetailResponseSchema,
  TaskExportOutputSchema,
  TaskResultOutputSchema,
  TaskStopOutputSchema,
  TreeHistoryOutputSchema,
  TreeRevertOutputSchema,
  LayerStrategySetOutputSchema,
  LayerMaskPatchOutputSchema,
  MaskEditDiscardOutputSchema,
  MaskEditRetryOutputSchema,
  ViewStateSetOutputSchema,
  type AssetsUploadInput,
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
  type MaskEditDiscardInput,
  type MaskEditDiscardOutput,
  type MaskEditRetryInput,
  type MaskEditRetryOutput,
  type SegmentOneOutput,
  type SessionListInput,
  type SessionListOutput,
  type TaskArtifactInput,
  type TaskArtifactOutput,
  type TaskDetailResponse,
  type TaskExportInput,
  type TaskExportOutput,
  type TreeHistoryInput,
  type TreeHistoryOutput,
  type TreeRevertInput,
  type TreeRevertOutput,
  type ViewStateSetInput,
  type ViewStateSetOutput,
} from '@handicraft/contracts'
import type { SessionExportsOutput, SessionImagesOutput } from '../myMaterials/schemas.js'
import type { AgentApi, AgentConnectionState, AgentResultView, AgentSessionView, AgentSetSummary, AgentTaskView } from './types.js'
import type { AttachmentMeta } from './attachments.js'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_CONVERT_CANVAS_PX,
  blobToBase64,
  convertImageToPng,
  decodeImageDimensions,
  fileToBase64,
  pngFilenameOf,
  sniffImageMime,
} from './attachments.js'
import { clearStoredToken, currentStoredToken, fetchAnonymousToken, getAnonymousStoredToken, getStoredToken } from '../daemonToken.js'
// [add-task-stones-manifest-export 1.2] sets.list 输出守门 schema——复用 warehouse
// 前端守门面（SetsListOutputSchema 全部组合自 @handicraft/contracts 冻结原语，
// 本文件不重复发明输出形状）。[product-polish-w1 T1] copyFromMarket 输出=create
// 全形（SetsCreateOutputSchema 同一守门面——name/memberCount 投影给 chip/刷新）。
import { SetsCreateOutputSchema, SetsListOutputSchema } from '../warehouse/schemas.js'
// [product-polish-w1 归档环] 我的材料读面守门（session.exports/session.images——
// 守门 schema 组合自 contracts 冻结原语，见 lib/myMaterials/schemas.ts）。
import { SessionExportsOutputSchema, SessionImagesOutputSchema } from '../myMaterials/schemas.js'

/** orpc 客户端的窄结构类型（ws-e2e 同式——真实类型经输出 schema parse 收敛）。 */
interface RpcClientLike {
  session: {
    create(input: { title?: string }): Promise<unknown>
    list(input: SessionListInput): Promise<unknown>
    get(input: { sessionId: string }): Promise<unknown>
    followup(input: { sessionId: string; text: string; mode?: 'followup' | 'steer'; attachments?: string[]; sourceSetId?: string }): Promise<unknown>
    answer(input: { sessionId: string; requestId: string; approved: boolean }): Promise<unknown>
    cancel(input: { sessionId?: string; taskId?: string }): Promise<unknown>
    clear(input: { sessionId: string }): Promise<unknown>
    replay(input: { sessionId: string; taskId: string; afterSeq?: number }): Promise<unknown>
    result(input: { sessionId: string }): Promise<unknown>
    exports(input: { sessionId: string }): Promise<unknown>
    images(): Promise<unknown>
  }
  assets: {
    upload(input: AssetsUploadInput): Promise<unknown>
  }
  sets: {
    list(input: unknown): Promise<unknown>
    copyFromMarket(input: unknown): Promise<unknown>
  }
  tasks: {
    result(input: { taskId: string }): Promise<unknown>
    artifact(input: TaskArtifactInput): Promise<unknown>
    stop(input: { taskId: string }): Promise<unknown>
  }
  task: {
    detail(input: { taskId: string }): Promise<unknown>
    export(input: TaskExportInput): Promise<unknown>
  }
  layer: {
    split(input: LayerSplitInput): Promise<unknown>
    rename(input: LayerRenameInput): Promise<unknown>
    reorder(input: LayerReorderInput): Promise<unknown>
    delete(input: LayerDeleteInput): Promise<unknown>
    strategy: {
      set(input: LayerStrategySetInput): Promise<unknown>
    }
    mask: {
      patch(input: LayerMaskPatchInput): Promise<unknown>
    }
  }
  maskEdit: {
    retry(input: MaskEditRetryInput): Promise<unknown>
    discard(input: MaskEditDiscardInput): Promise<unknown>
  }
  tree: {
    history(input: TreeHistoryInput): Promise<unknown>
    revert(input: TreeRevertInput): Promise<unknown>
  }
  view: {
    state: {
      set(input: ViewStateSetInput): Promise<unknown>
    }
  }
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

function parseOrThrow<T>(schema: { parse(input: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error(`${what} 响应不符合契约：${String(error)}`)
  }
}

/**
 * 401 判别（add-workbench-pro 2.6 走查遗留：token 过期/失效自愈）：orpc 客户端将
 * 非 2xx 响应收敛为 Error（message=状态短语，如 "Unauthorized"）——按 message/
 * 结构化 data.status/code 多形态宽容匹配（不赌单一内部结构）。
 */
function isUnauthorizedError(error: unknown): boolean {
  const record = error as { data?: { status?: unknown; code?: unknown }; status?: unknown; code?: unknown; message?: unknown } | null
  if (record?.data?.status === 401 || record?.status === 401) return true
  if (record?.data?.code === 'UNAUTHORIZED' || record?.code === 'UNAUTHORIZED') return true
  return typeof record?.message === 'string' && /\b401\b|unauthorized/i.test(record.message)
}

export interface RpcAgentApiOptions {
  /** 同源缺省（daemon 托管 SPA——design §2）；测试可注入绝对 base。 */
  baseUrl?: string
  /** token 解析面（缺省走匿名登录；测试注入）。 */
  resolveToken?: () => Promise<string | undefined>
}

export class RpcAgentApi implements AgentApi {
  readonly mode = 'rpc' as const
  private state: AgentConnectionState = 'closed'
  private ws: WebSocket | null = null
  private client: RpcClientLike | null = null
  private connecting: Promise<RpcClientLike> | null = null
  private token: string | undefined
  /** 当前 token 是否来源于存储层（代际漂移检测仅对该来源生效——见 syncTokenEpoch）。 */
  private tokenFromStore = false
  private readonly baseUrl: string
  private readonly resolveToken: () => Promise<string | undefined>
  private readonly connectionListeners = new Set<(state: AgentConnectionState) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 连续重连失败计数（成功 open 归零——有界指数退避的指数输入）。 */
  private reconnectAttempts = 0
  private disposed = false

  constructor(options: RpcAgentApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? globalThis.location?.origin ?? 'http://127.0.0.1:8317').replace(/\/$/, '')
    // [split-admin-portal 1.5] token 生命周期升级（最小侵入）：缺省解析面走
    // daemonToken 存储层——有登录态（登录页/会话 store 写入 sessionStorage 既有
    // 键位）用登录 token；无则匿名兜底（POST /api/auth/anonymous，allowAnonymous
    // 开时可用）。缓存优先逻辑与 W3.1 行为等价，仅收敛为共享模块单点。
    this.resolveToken =
      options.resolveToken ??
      (async (): Promise<string | undefined> => fetchAnonymousToken(this.baseUrl))
  }

  connection(): AgentConnectionState {
    return this.state
  }

  onConnectionChange(listener: (state: AgentConnectionState) => void): () => void {
    this.connectionListeners.add(listener)
    listener(this.state)
    return () => this.connectionListeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.setState('closed')
  }

  // ---------------------------------------------------------------- RPC 面

  private rpc(): Promise<RpcClientLike> {
    if (this.client && this.state === 'open') return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<RpcClientLike> {
    this.setState('connecting')
    this.token = (await this.resolveToken()) ?? undefined
    // 存储来源=登录键位或匿名键位（匿名 token 独立键位后两键都属存储层）。
    this.tokenFromStore =
      this.token !== undefined && (getStoredToken() === this.token || getAnonymousStoredToken() === this.token)
    if (this.disposed) throw new Error('已释放')
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/rpc${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`
    const websocket = new WebSocket(url)
    this.ws = websocket
    try {
      await new Promise<void>((resolve, reject) => {
        websocket.addEventListener('open', () => resolve(), { once: true })
        websocket.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true })
      })
    } catch (error) {
      // 首连失败（daemon 初次不可达）：不再卡在 connecting——进入重连状态机
      // （断线可见 + 有界退避重试），错误仍向当次调用方传播。
      this.client = null
      this.scheduleReconnect()
      throw error
    }
    const link = new RPCLink({ websocket: websocket as unknown as WebSocket })
    this.client = createORPCClient(link) as unknown as RpcClientLike
    this.reconnectAttempts = 0
    this.setState('open')
    websocket.addEventListener('close', () => {
      if (this.ws === websocket) {
        this.client = null
        this.scheduleReconnect()
      }
    })
    return this.client
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    // 单一重连轨道：connect 失败与重试驱动 catch 可能先后到达——已排程则不重复
    // 调度（否则失败风暴指数繁殖定时器）。
    if (this.reconnectTimer !== null) return
    this.setState('closed')
    // 有界指数退避：500ms 起步、每失败一次翻倍、上限 15s（计数封顶防溢出）。
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 16)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.rpc().catch(() => this.scheduleReconnect())
    }, delay)
  }

  private setState(state: AgentConnectionState): void {
    this.state = state
    for (const listener of this.connectionListeners) listener(state)
  }

  private async call<T>(what: string, invoke: (client: RpcClientLike) => Promise<unknown>, schema: { parse(input: unknown): T }, allowSelfHeal = true): Promise<T> {
    this.syncTokenEpoch()
    const client = await this.rpc()
    try {
      return parseOrThrow(schema, await invoke(client), what)
    } catch (error) {
      // 401 自愈（2.6 走查遗留）：token 过期/失效 → 弃缓存 token+弃连接 → resolveToken
      // 重新登录一次（登录态优先+匿名兜底）→ 新连接重放原请求（会话中途 token 失效
      // 不卡死；只自愈一次，仍 401 则穿透——避免坏端点死循环）。
      if (allowSelfHeal && isUnauthorizedError(error)) {
        clearStoredToken()
        this.token = undefined
        this.tokenFromStore = false
        this.client = null
        this.ws?.close()
        this.ws = null
        this.setState('closed')
        return this.call(what, invoke, schema, false)
      }
      throw error
    }
  }

  /**
   * [split-admin-portal 1.5] token 代际自检：登录/登出改写存储 token 后，旧 WS
   * 连接仍以旧身份运行（管理面收 403/会话归属漂移）——调用前检测漂移，弃连走
   * 重连（resolveToken 取新 token：登录 token 优先，匿名兜底）。
   * 漂移判定仅对「token 来源于存储层」的连接生效（tokenFromStore——含登录与
   * 匿名两个键位：匿名 token 独立键位后匿名连接也是存储来源）：注入式
   * resolveToken（测试）不经存储层，不做代际比较（否则每调用都误判重连）。
   */
  private syncTokenEpoch(): void {
    if (this.disposed) return
    if (!this.tokenFromStore) return
    if ((this.token ?? null) === currentStoredToken()) return
    this.token = undefined
    this.tokenFromStore = false
    this.client = null
    this.ws?.close()
    this.ws = null
    this.setState('closed')
  }

  async listSessions(input: SessionListInput = {}): Promise<SessionListOutput> {
    return this.call('session.list', (client) => client.session.list(input), SessionListOutputSchema)
  }

  async createSession(input: { title?: string }): Promise<{ sessionId: string; createdAt: string }> {
    return this.call('session.create', (client) => client.session.create(input), SessionCreateOutputSchema)
  }

  async getSession(sessionId: string): Promise<{ session: AgentSessionView; tasks: AgentTaskView[] }> {
    return this.call('session.get', (client) => client.session.get({ sessionId }), SessionGetOutputSchema)
  }

  async followup(
    sessionId: string,
    text: string,
    mode?: 'followup' | 'steer',
    attachments?: string[],
    sourceSetId?: string,
    autoApprove?: boolean,
  ): Promise<{ taskId: string }> {
    // 三通道 2.1（对齐 shufa b6cec8a）：steer 才显式携带——缺省 followup 与既有
    // 契约（mode optional）保持同一线上形状。2.6.3 同式：无附件不带 attachments
    // 键（纯文本消息与既有线上形状零漂移）。1.2 同式：未选集合不带 sourceSetId
    // 键（跳过=空 manifest，与纯文本线上形状零漂移；仅首条常规 followup 携带——
    // UI 侧选择器只在新会话首条输入态出现，越权携带由服务端 typed 拒）。
    // [product-polish-w1 T2] autoApprove 同为可选透传：undefined 不带键（旧
    // store/测试调用形状零漂移）；开关状态在时恒带（true/false 都是权威写入——
    // 关闭也要让服务端真源翻回 false）。
    return this.call(
      'session.followup',
      (client) =>
        client.session.followup({
          sessionId,
          text,
          ...(mode === 'steer' ? { mode } : {}),
          ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
          ...(sourceSetId !== undefined ? { sourceSetId } : {}),
          ...(autoApprove !== undefined ? { autoApprove } : {}),
        }),
      SessionFollowupOutputSchema,
    )
  }

  /**
   * [add-task-stones-manifest-export 1.2] 集合候选读面：sets.list（agent WS 同
   * 路由——最短路径，不另起 warehouse 客户端连接）→摘要投影。includeTrashed=
   * false（回收站组合不可作为新项目来源）；pageSize 顶格 200（契约上限——单页
   * 覆盖候选面，搜索过滤在前端本地做）。
   * [product-polish-w1 T3] 分组拉取（N1 动线「挑组合」）：scope=owner（我的组合
   * ——置顶组，admin 同样收窄本人）+ scope=market（材料市场组合——admin 所建
   * 只读快照组）。市场组拉取失败（旧 daemon 无 scope 面）降级为空——选择器仍
   * 可用（我的组不阻塞）；与我的组同 resourceId 去重（admin 自有组合进我的组）。
   */
  async listSets(): Promise<AgentSetSummary[]> {
    const project = (
      out: { sets: Array<{ resourceId: string; setId: string; name: string; memberCount: number; updatedAt: string; trashed: boolean }> },
      scope: 'mine' | 'market',
    ): AgentSetSummary[] =>
      out.sets
        .filter((set) => !set.trashed)
        .map(({ resourceId, setId, name, memberCount, updatedAt }) => ({ resourceId, setId, name, memberCount, updatedAt, scope }))
    const mineOut = await this.call(
      'sets.list',
      (client) => client.sets.list({ scope: 'owner', includeTrashed: false, page: 1, pageSize: 200 }),
      SetsListOutputSchema,
    )
    const mine = project(mineOut, 'mine')
    let market: AgentSetSummary[] = []
    try {
      const marketOut = await this.call(
        'sets.list',
        (client) => client.sets.list({ scope: 'market', includeTrashed: false, page: 1, pageSize: 200 }),
        SetsListOutputSchema,
      )
      market = project(marketOut, 'market')
    } catch {
      // 旧 daemon 无 scope=market 面——市场组降级为空（我的组不受影响）。
      market = []
    }
    const mineIds = new Set(mine.map((set) => set.resourceId))
    return [...mine, ...market.filter((set) => !mineIds.has(set.resourceId))]
  }

  /**
   * [product-polish-w1 T1] 市场组合→我的材料（sets.copyFromMarket）：源 owner=admin
   * 白名单门在 daemon 服务层；副本 origin={kind:'clone', fromSetId} 溯源+成员快照
   * 复制。Composer 发送链消费（选中市场组合→先复制→副本 resourceId 绑定
   * sourceSetId——服务端 followup 按 owner 展开，市场源必拒副本合法）。
   */
  async copyMarketSet(resourceId: string): Promise<{ resourceId: string; memberCount: number }> {
    const out = await this.call(
      'sets.copyFromMarket',
      (client) => client.sets.copyFromMarket({ resourceId }),
      SetsCreateOutputSchema,
    )
    return { resourceId: out.resourceId, memberCount: out.memberCount }
  }

  /**
   * [split-admin-portal 2.6.1] 图片上传（Composer 附件面通道）：file→base64→
   * assets.upload RPC→BlobRef；宽高经 Image 解码（帧元数据/缩略展示用）。
   * [W5 走查 P0-2] 非 PNG 归一：scene/segment/pave 管线全要 PNG——jpeg/webp（及
   * 可解码的 gif/bmp/svg 等）先经 canvas→toBlob('image/png') 转 PNG 再上传（blobRef
   * 即 PNG sha；EXIF 方向经 img 解码方向自然归一），文件名后缀改 .png+convertedToPng
   * 标记（chip「已转 PNG」）；4MiB 门 PNG 直传按原始字节、转换路径按转换后产物判；
   * 4096px 单边门两路同款（[收官终评 P2] 直传分支解码宽高后同判——与
   * convertImageToPng 同门同文案；此前压缩后 <4MiB、单边 >4096 的原生 PNG 绕过）。
   * MIME 判定魔数嗅探优先（不信 file.type
   * 标签——误标 PNG 的 JPEG 字节同样归一），嗅探未命中回退 file.type。
   */
  async uploadAssetImage(file: File): Promise<AttachmentMeta> {
    const dataBase64 = await fileToBase64(file)
    const sniffed = sniffImageMime(dataBase64)
    const mime = sniffed !== 'application/octet-stream' ? sniffed : file.type !== '' ? file.type : sniffed
    if (mime !== 'image/png') {
      const converted = await convertImageToPng(`data:${mime};base64,${dataBase64}`)
      if (converted.blob.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`「${file.name}」转换为 PNG 后为 ${Math.round(converted.blob.size / 1024)}KiB，超过 4MiB 上限，未上传`)
      }
      const convertedBase64 = await blobToBase64(converted.blob)
      const name = pngFilenameOf(file.name)
      const out = await this.call(
        'assets.upload',
        (client) => client.assets.upload({ filename: name, dataBase64: convertedBase64 }),
        AssetsUploadOutputSchema,
      )
      return {
        blobRef: out.blobRef,
        name: out.filename,
        mime: 'image/png',
        width: converted.width,
        height: converted.height,
        convertedToPng: true,
      }
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`「${file.name}」超过 4MiB 上限，未上传`)
    }
    const { width, height } = await decodeImageDimensions(`data:${mime};base64,${dataBase64}`)
    // [收官终评 P2] 原生 PNG 直传同款 4096 单边门（与 convertImageToPng 同门同文案）：
    // 此前直传分支只查 4MiB 字节不查像素——压缩后 <4MiB、单边 >4096 的 PNG 绕过
    // 转码画布的像素边界（4096 门只在 convertImageToPng）。
    if (width > MAX_CONVERT_CANVAS_PX || height > MAX_CONVERT_CANVAS_PX) {
      throw new Error(`「${file.name}」尺寸 ${width}×${height} 超出 ${MAX_CONVERT_CANVAS_PX}px 上限——请压缩后上传`)
    }
    const out = await this.call(
      'assets.upload',
      (client) => client.assets.upload({ filename: file.name, dataBase64 }),
      AssetsUploadOutputSchema,
    )
    return { blobRef: out.blobRef, name: out.filename, mime, width, height }
  }

  /** 打断当前轮（三通道 2.1）：tasks.stop → TaskView（守门 parse 后丢弃——收口帧经帧流）。 */
  async stopTask(taskId: string): Promise<void> {
    await this.call('tasks.stop', (client) => client.tasks.stop({ taskId }), TaskStopOutputSchema)
  }

  async answer(sessionId: string, requestId: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.call('session.answer', (client) => client.session.answer({ sessionId, requestId, approved }), SessionAnswerOutputSchema)
  }

  async cancel(input: { sessionId?: string; taskId?: string }): Promise<{ ok: boolean }> {
    return this.call('session.cancel', (client) => client.session.cancel(input), SessionCancelOutputSchema)
  }

  async clear(sessionId: string): Promise<{ ok: boolean; status: 'cleared' | 'clearing' }> {
    return this.call('session.clear', (client) => client.session.clear({ sessionId }), SessionClearOutputSchema)
  }

  async replay(sessionId: string, taskId: string, afterSeq: number): Promise<{ frames: Frame[]; nextSeq: number }> {
    return this.call(
      'session.replay',
      (client) => client.session.replay({ sessionId, taskId, afterSeq }),
      SessionReplayOutputSchema,
    )
  }

  async sessionResult(sessionId: string): Promise<AgentResultView> {
    return this.call('session.result', (client) => client.session.result({ sessionId }), SessionResultOutputSchema)
  }

  /**
   * [product-polish-w1 T1] 会话导出历史（我的任务行展开——每图三件套回看）。
   * 守门 schema=SessionExportsOutputSchema（myMaterials 域本地组合冻结原语）。
   */
  async listSessionExports(sessionId: string): Promise<SessionExportsOutput> {
    return this.call('session.exports', (client) => client.session.exports({ sessionId }), SessionExportsOutputSchema)
  }

  /**
   * [product-polish-w1 T2] 会话主图集分组（我的文件「会话图片」虚拟目录）。
   * 守门 schema=SessionImagesOutputSchema（同上）。
   */
  async listSessionImages(): Promise<SessionImagesOutput> {
    return this.call('session.images', (client) => client.session.images(), SessionImagesOutputSchema)
  }

  async taskResult(taskId: string): Promise<{ found: boolean } & Partial<AgentResultView>> {
    const out = await this.call('tasks.result', (client) => client.tasks.result({ taskId }), TaskResultOutputSchema)
    return out as { found: boolean } & Partial<AgentResultView>
  }

  async taskArtifact(input: TaskArtifactInput): Promise<TaskArtifactOutput> {
    return this.call('tasks.artifact', (client) => client.tasks.artifact(input), TaskArtifactOutputSchema)
  }

  // ---------------------------------------------------------------- 任务详情·排钻工作台（2.6）

  async taskDetail(taskId: string): Promise<TaskDetailResponse> {
    return this.call('task.detail', (client) => client.task.detail({ taskId }), TaskDetailResponseSchema)
  }

  async layerSplit(input: LayerSplitInput): Promise<SegmentOneOutput> {
    return this.call('layer.split', (client) => client.layer.split(input), SegmentOneOutputSchema)
  }

  async layerRename(input: LayerRenameInput): Promise<LayerRenameOutput> {
    return this.call('layer.rename', (client) => client.layer.rename(input), LayerRenameOutputSchema)
  }

  async layerStrategySet(input: LayerStrategySetInput): Promise<LayerStrategySetOutput> {
    return this.call('layer.strategy.set', (client) => client.layer.strategy.set(input), LayerStrategySetOutputSchema)
  }

  async treeHistory(input: TreeHistoryInput): Promise<TreeHistoryOutput> {
    return this.call('tree.history', (client) => client.tree.history(input), TreeHistoryOutputSchema)
  }

  // ---------------- workbench-pro 波 2a 契约消费（2b 前端接线）

  async layerMaskPatch(input: LayerMaskPatchInput): Promise<LayerMaskPatchOutput> {
    return this.call('layer.mask.patch', (client) => client.layer.mask.patch(input), LayerMaskPatchOutputSchema)
  }

  async viewStateSet(input: ViewStateSetInput): Promise<ViewStateSetOutput> {
    return this.call('view.state.set', (client) => client.view.state.set(input), ViewStateSetOutputSchema)
  }

  async taskExport(input: TaskExportInput): Promise<TaskExportOutput> {
    return this.call('task.export', (client) => client.task.export(input), TaskExportOutputSchema)
  }

  // workbench-pro 2c 图层管理（layer.reorder/layer.delete）+undo 结构域载体（tree.revert）。

  async layerReorder(input: LayerReorderInput): Promise<LayerReorderOutput> {
    return this.call('layer.reorder', (client) => client.layer.reorder(input), LayerReorderOutputSchema)
  }

  async layerDelete(input: LayerDeleteInput): Promise<LayerDeleteOutput> {
    return this.call('layer.delete', (client) => client.layer.delete(input), LayerDeleteOutputSchema)
  }

  async treeRevert(input: TreeRevertInput): Promise<TreeRevertOutput> {
    return this.call('tree.revert', (client) => client.tree.revert(input), TreeRevertOutputSchema)
  }

  // 终评 P0-1 恢复链（maskEdit.retry/maskEdit.discard——stale/error 重放/放弃）。

  async maskEditRetry(input: MaskEditRetryInput): Promise<MaskEditRetryOutput> {
    return this.call('maskEdit.retry', (client) => client.maskEdit.retry(input), MaskEditRetryOutputSchema)
  }

  async maskEditDiscard(input: MaskEditDiscardInput): Promise<MaskEditDiscardOutput> {
    return this.call('maskEdit.discard', (client) => client.maskEdit.discard(input), MaskEditDiscardOutputSchema)
  }

  // ---------------------------------------------------------------- 帧流

  subscribeTask(taskId: string, afterSeq: number, onFrame: (frame: Frame) => void): () => void {
    let websocket: WebSocket | null = null
    let closed = false
    void (async () => {
      this.syncTokenEpoch()
      if (this.token === undefined) this.token = (await this.resolveToken()) ?? undefined
      if (closed) return
      const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/tasks/${encodeURIComponent(taskId)}?after_seq=${afterSeq}${this.token ? `&token=${encodeURIComponent(this.token)}` : ''}`
      websocket = new WebSocket(url)
      websocket.addEventListener('message', (event) => {
        try {
          const parsed = FrameSchema.safeParse(JSON.parse(String(event.data)))
          if (parsed.success) onFrame(parsed.data)
        } catch {
          // 非 JSON 帧丢弃（守门语义与 daemon FrameStore 一致）。
        }
      })
      websocket.addEventListener('close', () => {
        if (!closed) this.setState('closed')
      })
    })()
    return () => {
      closed = true
      websocket?.close()
    }
  }
}
