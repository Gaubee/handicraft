/*
 * 图像处理设置 RPC 面（add-image-processing-settings 2.1，2026-09-28）。
 * modelsApi 同构：独立 WS（@orpc/client RPCLink over 同源 /ws/rpc?token= +
 * 匿名 token 解析 + 单连接复用断线重建）；输出经 contracts zod parse 守门
 * （漂移响应在 façade 层拒绝）。与 modelsApi 各自持有连接——设置面生命周期
 * 解耦（打开设置页才建连）；端点 imageProcessing.get / imageProcessing.save
 * （daemon 侧实现，见 contracts/src/imageProcessing.ts 契约头注）。
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import {
  ImageProcessingGetOutputSchema,
  ImageProcessingSaveOutputSchema,
  type ImageProcessingGetOutput,
  type ImageProcessingSaveInput,
  type ImageProcessingSaveOutput,
} from '@handicraft/contracts'

/** orpc 客户端的窄结构类型（真实类型经输出 schema parse 收敛）。 */
interface ImageProcessingRpcClient {
  imageProcessing: {
    get(): Promise<unknown>
    save(input: unknown): Promise<unknown>
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

class ImageProcessingApiClient {
  private client: ImageProcessingRpcClient | null = null
  private connecting: Promise<ImageProcessingRpcClient> | null = null
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

  private rpc(): Promise<ImageProcessingRpcClient> {
    if (this.client) return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<ImageProcessingRpcClient> {
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
    this.client = createORPCClient(link) as unknown as ImageProcessingRpcClient
    return this.client
  }

  private async call<T>(
    what: string,
    invoke: (client: ImageProcessingRpcClient) => Promise<unknown>,
    schema: { parse(input: unknown): T },
  ): Promise<T> {
    const client = await this.rpc()
    return parseOrThrow(schema, await invoke(client), what)
  }

  /** 读面：生效值+来源（settings|env|default）+ 未保存时 env 透出。 */
  async getImageProcessing(): Promise<ImageProcessingGetOutput> {
    return this.call(
      'imageProcessing.get',
      (client) => client.imageProcessing.get(),
      ImageProcessingGetOutputSchema,
    )
  }

  /** 写面：常规分支（preset；custom 必带 values）或 reset 分支（恢复跟随 env/默认）。 */
  async saveImageProcessing(input: ImageProcessingSaveInput): Promise<ImageProcessingSaveOutput> {
    return this.call(
      'imageProcessing.save',
      (client) => client.imageProcessing.save(input),
      ImageProcessingSaveOutputSchema,
    )
  }
}

/** 单例（设置页「图像处理」分区专用；与 modelsApi 各自连接互不复用）。 */
let instance: ImageProcessingApiClient | null = null

export function imageProcessingApi(baseUrl?: string): ImageProcessingApiClient {
  if (!instance) instance = new ImageProcessingApiClient(baseUrl)
  return instance
}
