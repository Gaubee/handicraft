/*
 * RPC 适配器（@orpc/client RPCLink over 同源 /ws/rpc?token= + /ws/tasks/:id 帧流）。
 * W3.1 交付传输层与契约对齐的 façade；服务端 session.followup/answer 归 W4 接线——
 * 本层不 mock 服务端行为，只在真实 daemon 同源部署时可用（mode 选择见 index.ts）。
 * 连接管理：匿名 token 解析（POST /api/auth/anonymous，sessionStorage 缓存）+
 * WS 断线重连（指数退避，上限 15s）+ 帧订阅重挂（调用方持 afterSeq 游标）。
 */

import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import {
  FrameSchema,
  SessionCreateOutputSchema,
  SessionGetOutputSchema,
  SessionListOutputSchema,
  SessionReplayOutputSchema,
  SessionResultOutputSchema,
  TaskResultOutputSchema,
  type Frame,
  type SessionListInput,
  type SessionListOutput,
} from '@handicraft/contracts'
import type { AgentApi, AgentConnectionState, AgentResultView, AgentSessionView, AgentTaskView } from './types.js'

/** orpc 客户端的窄结构类型（ws-e2e 同式——真实类型经输出 schema parse 收敛）。 */
interface RpcClientLike {
  session: {
    create(input: { title?: string }): Promise<unknown>
    list(input: SessionListInput): Promise<unknown>
    get(input: { sessionId: string }): Promise<unknown>
    followup(input: { sessionId: string; text: string }): Promise<{ taskId: string }>
    answer(input: { sessionId: string; requestId: string; approved: boolean }): Promise<{ ok: boolean }>
    cancel(input: { sessionId?: string; taskId?: string }): Promise<{ ok: boolean }>
    clear(input: { sessionId: string }): Promise<{ ok: boolean }>
    replay(input: { sessionId: string; taskId: string; afterSeq?: number }): Promise<unknown>
    result(input: { sessionId: string }): Promise<unknown>
  }
  tasks: {
    result(input: { taskId: string }): Promise<unknown>
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
    await new Promise<void>((resolve, reject) => {
      websocket.addEventListener('open', () => resolve(), { once: true })
      websocket.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true })
    })
    const link = new RPCLink({ websocket: websocket as unknown as WebSocket })
    this.client = createORPCClient(link) as unknown as RpcClientLike
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
    this.setState('closed')
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.floor(Math.random() * 3), RECONNECT_MAX_MS)
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
    const client = await this.rpc()
    return client.session.followup({ sessionId, text })
  }

  async answer(sessionId: string, requestId: string, approved: boolean): Promise<{ ok: boolean }> {
    const client = await this.rpc()
    return client.session.answer({ sessionId, requestId, approved })
  }

  async cancel(input: { sessionId?: string; taskId?: string }): Promise<{ ok: boolean }> {
    const client = await this.rpc()
    return client.session.cancel(input)
  }

  async clear(sessionId: string): Promise<{ ok: boolean }> {
    const client = await this.rpc()
    return client.session.clear({ sessionId })
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
