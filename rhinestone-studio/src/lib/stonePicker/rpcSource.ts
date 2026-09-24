/**
 * 钻表选择器默认数据源（oRPC RPCLink over 同源 /ws/rpc?token=——沿 agentApi/rpc.ts 传输形态）。
 * S5 交付面=纯组件库：本适配器是 P3.2 接线的缺省实现，测试经 injectTransport 注入
 * 假传输（jsdom 无 WebSocket）；连接管理走最简懒连+单飞（重连退避归 P3.2 页面接线
 * 按需补强——选择器是嵌入式面板，不独占连接策略）。
 *
 * 协议判定落地（source.ts 头注）：stones.list RPC 面无 nearColor/activeSetId——
 * 本适配器出线前剥离两协议位；nearColor 在场时以客户端 ΔE 排序回退（当前页内，
 * P3.2 接线服务端排序后删除回退）；activeSetId 现阶段忽略（组合投影归 set RPC 端点）。
 * 守门（沿 agentApi W3 评审 P2-2）：list/get 输出经 zod parse——漂移响应在适配层拒绝。
 */
import { z } from 'zod'
import { StoneGridCellSchema } from '@handicraft/contracts'
import { sortCellsByNearColor, type StoneGetOutcome, type StoneListQuery, type StoneListResult, type StonePickerSource } from './source.js'

const TOKEN_KEY = 'handicraft.daemon.token'

/** RPC 传输端口（真身=WS RPCLink；测试注入假实现——jsdom 无 WebSocket）。 */
export interface RpcTransport {
  call(proc: 'stones.list' | 'stones.get', input: unknown): Promise<unknown>
}

/** oRPC 客户端的窄结构类型（沿 agentApi RpcClientLike 手法——真实类型经输出 schema 收敛）。 */
interface RpcClientLike {
  stones: {
    list(input: unknown): Promise<unknown>
    get(input: unknown): Promise<unknown>
  }
}

export interface RpcStonePickerSourceOptions {
  /** 同源缺省（daemon 托管 SPA）；测试可注入绝对 base。 */
  baseUrl?: string
  /** token 解析面（缺省走匿名登录——与 agentApi/rpc.ts 同键同法，共享会话缓存）。 */
  resolveToken?: () => Promise<string | undefined>
  /** 传输注入（测试）；缺省=WS RPCLink 懒连。 */
  transport?: RpcTransport
}

/** WS RPCLink 传输：懒连 + 单飞（并发调用共用一次连接握手）。 */
function createWsTransport(options: RpcStonePickerSourceOptions): RpcTransport {
  const baseUrl = (options.baseUrl ?? globalThis.location?.origin ?? 'http://127.0.0.1:8317').replace(/\/$/, '')
  let client: RpcClientLike | null = null
  let connecting: Promise<RpcClientLike> | null = null

  async function resolveToken(): Promise<string | undefined> {
    if (options.resolveToken !== undefined) return options.resolveToken()
    const cached = globalThis.sessionStorage?.getItem(TOKEN_KEY)
    if (cached) return cached
    try {
      const response = await fetch(`${baseUrl}/api/auth/anonymous`, { method: 'POST' })
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
  }

  async function connect(): Promise<RpcClientLike> {
    if (client !== null) return client
    if (connecting === null) {
      connecting = (async () => {
        // 动态 import：保持选择器组件库零 WS 强依赖（纯消费方可只注入 transport）。
        const { createORPCClient } = await import('@orpc/client')
        const { RPCLink } = await import('@orpc/client/websocket')
        const token = await resolveToken()
        const url = `${baseUrl.replace(/^http/, 'ws')}/ws/rpc${token ? `?token=${encodeURIComponent(token)}` : ''}`
        const websocket = new WebSocket(url)
        await new Promise<void>((resolve, reject) => {
          websocket.addEventListener('open', () => resolve(), { once: true })
          websocket.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true })
        })
        websocket.addEventListener('close', () => {
          if (client !== null) client = null
        })
        const link = new RPCLink({ websocket })
        client = createORPCClient(link) as unknown as RpcClientLike
        return client
      })().finally(() => {
        connecting = null
      })
    }
    return connecting
  }

  return {
    async call(proc, input) {
      const c = await connect()
      return proc === 'stones.list' ? c.stones.list(input) : c.stones.get(input)
    },
  }
}

// ---------------------------------------------------------------- 输出守门 schema

const StoneListResponseSchema = z.object({
  cells: z.array(StoneGridCellSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  groupKeys: z.array(z.string()).optional(),
  /** 共享读标注（评审 D-1）——漂移即拒（守门语义沿 agentApi）。 */
  readScope: z.literal('shared-library'),
})

const StoneGetResponseSchema = z.object({
  resourceId: z.string().min(1),
  state: z.enum(['resolved', 'soft-deleted', 'blob-missing', 'wrong-kind']),
  stone: z
    .object({
      gemshapeRef: z.string().min(1).optional(),
    })
    .optional(),
})

function parseOrThrow<T>(schema: { parse(input: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error(`${what} 响应不符合契约：${String(error)}`)
  }
}

/**
 * 默认数据源工厂。nearColor/activeSetId 不出线（RPC 面暂无）；nearColor 在场时
 * 客户端 ΔE 排序回退——P3.2 接线服务端排序后删除（S5.2 协议位说明见 source.ts）。
 */
export function createRpcStonePickerSource(options: RpcStonePickerSourceOptions = {}): StonePickerSource {
  const baseUrl = (options.baseUrl ?? globalThis.location?.origin ?? 'http://127.0.0.1:8317').replace(/\/$/, '')
  const transport = options.transport ?? createWsTransport(options)

  return {
    async list(query: StoneListQuery): Promise<StoneListResult> {
      const { nearColor, activeSetId: _activeSetId, ...rpcInput } = query
      const parsed = parseOrThrow(StoneListResponseSchema, await transport.call('stones.list', rpcInput), 'stones.list')
      const { readScope: _readScope, ...result } = parsed
      return nearColor === undefined ? result : { ...result, cells: sortCellsByNearColor(result.cells, nearColor) }
    },

    async get(resourceId: string): Promise<StoneGetOutcome> {
      const parsed = parseOrThrow(
        StoneGetResponseSchema,
        await transport.call('stones.get', { resourceId }),
        'stones.get',
      )
      const outcome: StoneGetOutcome = { resourceId: parsed.resourceId, state: parsed.state }
      if (parsed.stone?.gemshapeRef !== undefined) outcome.gemshapeRef = parsed.stone.gemshapeRef
      return outcome
    },

    resolveTextureUrl(textureUrl: string): string {
      // 相对路径（/api/stones/{id}/texture.png）→ daemon base 绝对化；绝对 URL 原样。
      return textureUrl.startsWith('/') ? `${baseUrl}${textureUrl}` : textureUrl
    },
  }
}
