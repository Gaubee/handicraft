/*
 * 仓储管理工作台 RPC 客户端（add-stone-library S7.4——sets 六端点 372be0d）。
 * 原始需求 2026-09-24：sets.list/get/create/update/delete 的浏览器通道——沿 S3.3
 * RpcStonesClient 形态（oRPC RPCLink over 同源 /ws/rpc?token=：匿名 token 解析 +
 * sessionStorage 缓存 + 惰性单连接；断线清客户端、下次调用重连）。createFromBom
 * 是接口位冻结 501（内核 P3 依赖）——工作台不调用，客户端不出线。
 * 错误面：ORPCError.data.code（typed 码——revision-conflict 等）归一为
 * WarehouseSetsError.code，供 setModel.isRevisionConflict 纯判别。
 * stones 面（平铺区数据）不在此重造——复用 S3.3 RpcStonesClient（store 组合注入）。
 */

import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import {
  SetsCreateOutputSchema,
  SetsDeleteOutputSchema,
  SetsGetOutputSchema,
  SetsListOutputSchema,
  SetsUpdateOutputSchema,
  type SetsCreateInput,
  type SetsDeleteOutput,
  type SetsGetOutput,
  type SetsListInput,
  type SetsListOutput,
  type SetsUpdateInput,
  type SetsUpdateOutput,
} from './schemas.js'

/** orpc 客户端的窄结构类型（真实类型经输出 schema parse 收敛——同 S3.3 手法）。 */
interface SetsRpcClientLike {
  sets: {
    list(input: unknown): Promise<unknown>
    get(input: { resourceId: string }): Promise<unknown>
    create(input: unknown): Promise<unknown>
    update(input: unknown): Promise<unknown>
    delete(input: { resourceId: string }): Promise<unknown>
  }
}

const TOKEN_KEY = 'handicraft.daemon.token'

/** typed 错误（daemon SetServiceError → ORPCError data.code 归一）。 */
export class WarehouseSetsError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'WarehouseSetsError'
  }
}

function parseOrThrow<T>(schema: { parse(input: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error(`${what} 响应不符合契约：${String(error)}`)
  }
}

/** ORPCError → WarehouseSetsError（data.code 保留——CAS/空成员等可编程判别）。 */
function normalizeRpcError(error: unknown): never {
  if (error instanceof WarehouseSetsError) throw error
  const orpc = error as { data?: { code?: unknown }; message?: unknown } | null
  const code = orpc?.data !== null && typeof orpc?.data === 'object' && orpc?.data !== undefined
    ? (orpc.data as { code?: unknown }).code
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  throw new WarehouseSetsError(message, typeof code === 'string' ? code : undefined)
}

export interface WarehouseSetsClient {
  list(input?: SetsListInput): Promise<SetsListOutput>
  get(resourceId: string): Promise<SetsGetOutput>
  create(input: SetsCreateInput): Promise<SetsCreateResult>
  update(input: SetsUpdateInput): Promise<SetsUpdateOutput>
  delete(resourceId: string): Promise<SetsDeleteOutput>
}

/** create 输出（full 形——工作台创建后立即切换需要 resourceId）。 */
export type SetsCreateResult = {
  resourceId: string
  setId: string
  revision: number
  path: string
  memberCount: number
  setJsonBlobRef: string
}

export interface RpcWarehouseSetsClientOptions {
  /** 同源缺省（daemon 托管 SPA）；测试可注入绝对 base。 */
  baseUrl?: string
  resolveToken?: () => Promise<string | undefined>
  socketFactory?: (url: string) => WebSocket
}

export class RpcWarehouseSetsClient implements WarehouseSetsClient {
  private readonly baseUrl: string
  private readonly resolveToken: () => Promise<string | undefined>
  private readonly socketFactory: (url: string) => WebSocket
  private client: SetsRpcClientLike | null = null
  private connecting: Promise<SetsRpcClientLike> | null = null

  constructor(options: RpcWarehouseSetsClientOptions = {}) {
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
  private rpc(): Promise<SetsRpcClientLike> {
    if (this.client !== null) return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<SetsRpcClientLike> {
    const token = await this.resolveToken()
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/rpc${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const websocket = this.socketFactory(url)
    await new Promise<void>((resolve, reject) => {
      websocket.addEventListener('open', () => resolve(), { once: true })
      websocket.addEventListener('error', () => reject(new Error('仓储管理 RPC 连接失败（daemon 不可达）')), { once: true })
    })
    const link = new RPCLink({ websocket: websocket as unknown as WebSocket })
    const client = createORPCClient(link) as unknown as SetsRpcClientLike
    websocket.addEventListener('close', () => {
      if (this.client === client) this.client = null
    })
    this.client = client
    return client
  }

  async list(input: SetsListInput = {}): Promise<SetsListOutput> {
    try {
      const client = await this.rpc()
      return parseOrThrow(SetsListOutputSchema, await client.sets.list(input), 'sets.list')
    } catch (error) {
      normalizeRpcError(error)
    }
  }

  async get(resourceId: string): Promise<SetsGetOutput> {
    try {
      const client = await this.rpc()
      return parseOrThrow(SetsGetOutputSchema, await client.sets.get({ resourceId }), 'sets.get')
    } catch (error) {
      normalizeRpcError(error)
    }
  }

  async create(input: SetsCreateInput): Promise<SetsCreateResult> {
    try {
      const client = await this.rpc()
      return parseOrThrow(SetsCreateOutputSchema, await client.sets.create(input), 'sets.create')
    } catch (error) {
      normalizeRpcError(error)
    }
  }

  async update(input: SetsUpdateInput): Promise<SetsUpdateOutput> {
    try {
      const client = await this.rpc()
      return parseOrThrow(SetsUpdateOutputSchema, await client.sets.update(input), 'sets.update')
    } catch (error) {
      normalizeRpcError(error)
    }
  }

  async delete(resourceId: string): Promise<SetsDeleteOutput> {
    try {
      const client = await this.rpc()
      return parseOrThrow(SetsDeleteOutputSchema, await client.sets.delete({ resourceId }), 'sets.delete')
    } catch (error) {
      normalizeRpcError(error)
    }
  }
}

export type WarehouseSetsClientFactory = () => WarehouseSetsClient

/** 生产工厂：同源 daemon RPC（开发者旗标视图——无 mock 双模）。 */
export const defaultWarehouseSetsClientFactory: WarehouseSetsClientFactory = () => new RpcWarehouseSetsClient()
