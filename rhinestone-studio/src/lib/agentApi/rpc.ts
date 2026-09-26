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
  SegmentOneOutputSchema,
  TaskArtifactOutputSchema,
  TaskDetailResponseSchema,
  TaskResultOutputSchema,
  TreeHistoryOutputSchema,
  LayerStrategySetOutputSchema,
  type Frame,
  type LayerRenameInput,
  type LayerRenameOutput,
  type LayerSplitInput,
  type LayerStrategySetInput,
  type LayerStrategySetOutput,
  type SegmentOneOutput,
  type SessionListInput,
  type SessionListOutput,
  type TaskArtifactInput,
  type TaskArtifactOutput,
  type TaskDetailResponse,
  type TreeHistoryInput,
  type TreeHistoryOutput,
} from '@handicraft/contracts'
import type { AgentApi, AgentConnectionState, AgentResultView, AgentSessionView, AgentTaskView } from './types.js'

/** orpc 客户端的窄结构类型（ws-e2e 同式——真实类型经输出 schema parse 收敛）。 */
interface RpcClientLike {
  session: {
    create(input: { title?: string }): Promise<unknown>
    list(input: SessionListInput): Promise<unknown>
    get(input: { sessionId: string }): Promise<unknown>
    followup(input: { sessionId: string; text: string }): Promise<unknown>
    answer(input: { sessionId: string; requestId: string; approved: boolean }): Promise<unknown>
    cancel(input: { sessionId?: string; taskId?: string }): Promise<unknown>
    clear(input: { sessionId: string }): Promise<unknown>
    replay(input: { sessionId: string; taskId: string; afterSeq?: number }): Promise<unknown>
    result(input: { sessionId: string }): Promise<unknown>
  }
  tasks: {
    result(input: { taskId: string }): Promise<unknown>
    artifact(input: TaskArtifactInput): Promise<unknown>
  }
  task: {
    detail(input: { taskId: string }): Promise<unknown>
  }
  layer: {
    split(input: LayerSplitInput): Promise<unknown>
    rename(input: LayerRenameInput): Promise<unknown>
    strategy: {
      set(input: LayerStrategySetInput): Promise<unknown>
    }
  }
  tree: {
    history(input: TreeHistoryInput): Promise<unknown>
  }
}

const TOKEN_KEY = 'handicraft.daemon.token'
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

function parseOrThrow<T>(schema: { parse(input: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error(`${what} 响应不符合契约：${String(error)}`)
  }
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
  private readonly baseUrl: string
  private readonly resolveToken: () => Promise<string | undefined>
  private readonly connectionListeners = new Set<(state: AgentConnectionState) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 连续重连失败计数（成功 open 归零——有界指数退避的指数输入）。 */
  private reconnectAttempts = 0
  private disposed = false

  constructor(options: RpcAgentApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? globalThis.location?.origin ?? 'http://127.0.0.1:8317').replace(/\/$/, '')
    this.resolveToken =
      options.resolveToken ??
      (async (): Promise<string | undefined> => {
        const cached = globalThis.sessionStorage?.getItem(TOKEN_KEY)
        if (cached) return cached
        try {
          const response = await fetch(`${this.baseUrl}/api/auth/anonymous`, { method: 'POST' })
          if (!response.ok) return undefined
          const body = (await response.json()) as { token?: string }
          if (body.token) {
            globalThis.sessionStorage?.setItem(TOKEN_KEY, body.token)
            return body.token
          }
          return undefined
        } catch {
          return undefined
        }
      })
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

  private async call<T>(what: string, invoke: (client: RpcClientLike) => Promise<unknown>, schema: { parse(input: unknown): T }): Promise<T> {
    const client = await this.rpc()
    return parseOrThrow(schema, await invoke(client), what)
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

  async followup(sessionId: string, text: string): Promise<{ taskId: string }> {
    return this.call('session.followup', (client) => client.session.followup({ sessionId, text }), SessionFollowupOutputSchema)
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

  // ---------------------------------------------------------------- 帧流

  subscribeTask(taskId: string, afterSeq: number, onFrame: (frame: Frame) => void): () => void {
    let websocket: WebSocket | null = null
    let closed = false
    void (async () => {
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
