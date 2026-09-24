/*
 * 装饰钻库管理视图 RPC 客户端（add-stone-library S3.3——design §4.1）。
 * 原始需求 2026-09-24：stones.tree/list/get 三端点的浏览器通道——oRPC RPCLink over
 * 同源 /ws/rpc?token=（与 agentApi/rpc.ts W2 既有通道同形态：匿名 token 解析 +
 * sessionStorage 缓存 + 惰性单连接；断线清客户端、下次调用重连——管理视图按需
 * 重连即可，不做会话面的自动重连风暴）。
 * 守门：三个读面输出全部经 schemas.ts 输出 schema parse（漂移即拒，同 W3 P2-2）。
 * 写面（import/delete/restore）不在本客户端——浏览器 RPC 无对应端点（design §4.1
 * 只冻结三读端点），UI 以显式占位态呈现，不伪造。
 */

import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import {
  StoneDetailSchema,
  StonesListOutputSchema,
  StonesTreeOutputSchema,
  type StoneDetail,
  type StonesListInput,
  type StonesListOutput,
  type StonesTreeOutput,
} from './schemas.js'

/** orpc 客户端的窄结构类型（真实类型经输出 schema parse 收敛——ws-e2e 同式）。 */
interface StonesRpcClientLike {
  stones: {
    tree(input: { rootId?: string; includeTrashed: boolean }): Promise<unknown>
    list(input: StonesListInput): Promise<unknown>
    get(input: { resourceId: string }): Promise<unknown>
  }
}

const TOKEN_KEY = 'handicraft.daemon.token'

function parseOrThrow<T>(schema: { parse(input: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error(`${what} 响应不符合契约：${String(error)}`)
  }
}

export interface StonesAdminClient {
  tree(input?: { rootId?: string; includeTrashed?: boolean }): Promise<StonesTreeOutput>
  list(input: StonesListInput): Promise<StonesListOutput>
  get(resourceId: string): Promise<StoneDetail>
}

export interface RpcStonesClientOptions {
  /** 同源缺省（daemon 托管 SPA）；测试可注入绝对 base。 */
  baseUrl?: string
  /** token 解析面（缺省走匿名登录——与 agentApi 同键复用缓存）。 */
  resolveToken?: () => Promise<string | undefined>
  /** 测试注入 WebSocket 构造器。 */
  socketFactory?: (url: string) => WebSocket
}

export class RpcStonesClient implements StonesAdminClient {
  private readonly baseUrl: string
  private readonly resolveToken: () => Promise<string | undefined>
  private readonly socketFactory: (url: string) => WebSocket
  private client: StonesRpcClientLike | null = null
  private connecting: Promise<StonesRpcClientLike> | null = null

  constructor(options: RpcStonesClientOptions = {}) {
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
    this.socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url))
  }

  /** 惰性单连接：open 期间复用；断线（close 事件）即弃——下次调用重建。 */
  private rpc(): Promise<StonesRpcClientLike> {
    if (this.client !== null) return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<StonesRpcClientLike> {
    const token = await this.resolveToken()
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/rpc${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const websocket = this.socketFactory(url)
    await new Promise<void>((resolve, reject) => {
      websocket.addEventListener('open', () => resolve(), { once: true })
      websocket.addEventListener('error', () => reject(new Error('装饰钻库 RPC 连接失败（daemon 不可达）')), { once: true })
    })
    const link = new RPCLink({ websocket: websocket as unknown as WebSocket })
    const client = createORPCClient(link) as unknown as StonesRpcClientLike
    websocket.addEventListener('close', () => {
      if (this.client === client) this.client = null
    })
    this.client = client
    return client
  }

  async tree(input: { rootId?: string; includeTrashed?: boolean } = {}): Promise<StonesTreeOutput> {
    const payload = { includeTrashed: input.includeTrashed ?? false, ...(input.rootId !== undefined ? { rootId: input.rootId } : {}) }
    const client = await this.rpc()
    return parseOrThrow(StonesTreeOutputSchema, await client.stones.tree(payload), 'stones.tree')
  }

  async list(input: StonesListInput): Promise<StonesListOutput> {
    const client = await this.rpc()
    return parseOrThrow(StonesListOutputSchema, await client.stones.list(input), 'stones.list')
  }

  async get(resourceId: string): Promise<StoneDetail> {
    const client = await this.rpc()
    return parseOrThrow(StoneDetailSchema, await client.stones.get({ resourceId }), 'stones.get')
  }
}

export type StonesClientFactory = () => StonesAdminClient

/** 生产工厂：同源 daemon RPC（管理视图只在开发者旗标后出现——无 mock 双模）。 */
export const defaultStonesClientFactory: StonesClientFactory = () => new RpcStonesClient()
