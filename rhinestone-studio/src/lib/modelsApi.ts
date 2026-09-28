/*
 * 模型服务 RPC 面（zhumo 方案移植块 A——models 六端点 + bootstrap.modelRoute
 * 投影的前台客户端）。复用 agentApi 的传输形态（@orpc/client RPCLink over 同源
 * /ws/rpc?token= + 匿名 token 解析 + 单连接复用），但独立于 AgentApi 接口
 * （设置面生命周期与会话面解耦——打开设置页才建连）。
 * 守门：全部输出经 contracts zod schema parse（漂移响应在 façade 层拒绝）。
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import {
  ModelCatalogOutputSchema,
  ModelRouteInfoSchema,
  ModelsAvailableOutputSchema,
  ModelsConfigOutputSchema,
  ModelsTestOutputSchema,
  type ModelCatalogOutput,
  type ModelRouteInfo,
  type ModelsAvailableOutput,
  type ModelsConfigOutput,
  type ModelsTestOutput,
} from '@handicraft/contracts'
import type { DshModelRoute, ModelsSettings } from './components/models/route-meta.js'

/** orpc 客户端的窄结构类型（真实类型经输出 schema parse 收敛）。 */
interface ModelsRpcClient {
  bootstrap(): Promise<unknown>
  models: {
    get(): Promise<unknown>
    save(input: unknown): Promise<unknown>
    catalog(): Promise<unknown>
    catalogRefresh(): Promise<unknown>
    test(input: unknown): Promise<unknown>
    available(): Promise<unknown>
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

class ModelsApiClient {
  private client: ModelsRpcClient | null = null
  private connecting: Promise<ModelsRpcClient> | null = null
  private readonly baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? globalThis.location?.origin ?? 'http://127.0.0.1:8317').replace(/\/$/, '')
  }

  private async resolveToken(): Promise<string | undefined> {
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
  }

  private rpc(): Promise<ModelsRpcClient> {
    if (this.client) return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<ModelsRpcClient> {
    const token = (await this.resolveToken()) ?? undefined
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/rpc${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const websocket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      websocket.addEventListener('open', () => resolve(), { once: true })
      websocket.addEventListener('error', () => reject(new Error('WS 连接失败——daemon 不可达或未启动')), { once: true })
    })
    websocket.addEventListener('close', () => {
      if (this.client !== null) this.client = null // 断线重建（下次调用重连）
    })
    const link = new RPCLink({ websocket: websocket as unknown as WebSocket })
    this.client = createORPCClient(link) as unknown as ModelsRpcClient
    return this.client
  }

  private async call<T>(
    what: string,
    invoke: (client: ModelsRpcClient) => Promise<unknown>,
    schema: { parse(input: unknown): T },
  ): Promise<T> {
    const client = await this.rpc()
    return parseOrThrow(schema, await invoke(client), what)
  }

  /** 多路由配置读面（hasKey 投影；密钥零回显）。 */
  async getModels(): Promise<ModelsSettings> {
    return this.call('models.get', (client) => client.models.get(), ModelsConfigOutputSchema)
  }

  /** 保存面：apiKey 字段仅在非空时上送（空=保留旧密钥）；hasKey 不上行。 */
  async saveModels(next: ModelsSettings): Promise<void> {
    await this.call('models.save', (client) => client.models.save({
      routes: next.routes.map((route: DshModelRoute) => ({
        provider: route.provider,
        api: route.api,
        baseURL: route.baseURL,
        ...(route.iconUrl !== undefined ? { iconUrl: route.iconUrl } : {}),
        models: route.models,
        ...(route.apiKey !== undefined && route.apiKey.length > 0 ? { apiKey: route.apiKey } : {}),
      })),
      default: next.default,
    }), ModelsConfigOutputSchema)
  }

  /** 预设目录（zcode 策展恒在 + models.dev 缓存追加）。 */
  async getModelsCatalog(): Promise<ModelCatalogOutput> {
    return this.call('models.catalog', (client) => client.models.catalog(), ModelCatalogOutputSchema)
  }

  /** models.dev 在线刷新（网络失败中文报错不伤旧缓存）。 */
  async refreshModelsCatalog(): Promise<ModelCatalogOutput> {
    return this.call('models.catalogRefresh', (client) => client.models.catalogRefresh(), ModelCatalogOutputSchema)
  }

  /** 连接测试（apiKey 直传优先；缺省由 daemon 从已存密钥注入）。 */
  async testModelRoute(input: {
    api: string
    baseURL: string
    modelId: string
    apiKey?: string
    provider?: string
  }): Promise<ModelsTestOutput> {
    return this.call('models.test', (client) => client.models.test(input), ModelsTestOutputSchema)
  }

  /** 可用模型清单（对话 composer 模型 chip 数据源）。 */
  async getAvailableModels(): Promise<ModelsAvailableOutput> {
    return this.call('models.available', (client) => client.models.available(), ModelsAvailableOutputSchema)
  }

  /** 生效路由信息（头部「生效路由」来源透明行——settings/env）。 */
  async getModelRoute(): Promise<ModelRouteInfo | null> {
    const client = await this.rpc()
    const raw = (await client.bootstrap()) as { modelRoute?: unknown }
    // 旧 daemon 未带 modelRoute 字段时归一 null（向导退化为自由配置）。
    return ModelRouteInfoSchema.nullable().parse(raw?.modelRoute ?? null)
  }
}

/** 单例（设置页与 composer 模型 chip 共享一条连接）。 */
let instance: ModelsApiClient | null = null

export function modelsApi(baseUrl?: string): ModelsApiClient {
  if (!instance) instance = new ModelsApiClient(baseUrl)
  return instance
}
