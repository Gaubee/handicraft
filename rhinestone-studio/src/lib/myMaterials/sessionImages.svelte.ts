/*
 * 「我的文件 → 会话图片」虚拟目录 store（product-polish-w1 T2——故事：「上传的图
 * …都在我的材料里」）。数据面=session.images RPC（会话主图集审计真源 tasks.params
 * attachments+imageIds——capability/task-images sessionImageSet 同源；本人域按会话
 * 分组）。**不搬数据**进 asset_library（虚拟目录=纯读投影——归档链路零复制零双写，
 * 会话 clear 后自然缺席）；缩略走既有 raw 面（w=600+401 自愈 onerror，归属校验含
 * 本人会话引用）。管理面恒真实 daemon 数据（不随前台 mock 模式键漂移；测试注入 fake）。
 * 只读红线：无任何上传/移动/删除写面（素材库写操作不适用于会话图片域）。
 */

import { RpcAgentApi } from '$lib/agentApi/rpc'
import type { SessionImagesGroup } from './schemas.js'

export type SessionImagesLoadState = 'idle' | 'loading' | 'ready' | 'error'

/** 会话图片区窄客户端（结构兼容 RpcAgentApi——返回 groups 包裹面）。 */
export interface MySessionImagesClient {
  listSessionImages(): Promise<{ groups: SessionImagesGroup[] }>
}

export function defaultMySessionImagesClientFactory(): MySessionImagesClient {
  return new RpcAgentApi()
}

let client: MySessionImagesClient | null = null
let groups = $state<SessionImagesGroup[]>([])
let state = $state<SessionImagesLoadState>('idle')
let errorMessage = $state<string | null>(null)
let initialized = false

/** 测试/装配注入。 */
export function bindMySessionImagesClient(next: MySessionImagesClient): void {
  client = next
}

function clientOf(): MySessionImagesClient {
  if (!client) client = defaultMySessionImagesClientFactory()
  return client
}

// ---------------------------------------------------------------- 读面

export function getSessionImagesGroups(): SessionImagesGroup[] {
  return groups
}

export function getSessionImagesState(): SessionImagesLoadState {
  return state
}

export function getSessionImagesError(): string | null {
  return errorMessage
}

/** 图片总数（状态栏计数——空组不产计数）。 */
export function getSessionImagesCount(): number {
  return groups.reduce((total, group) => total + group.images.length, 0)
}

// ---------------------------------------------------------------- 生命周期

/** 首次进入虚拟目录取数（幂等——显式刷新走 refreshSessionImages）。 */
export async function initSessionImages(): Promise<void> {
  if (initialized) return
  initialized = true
  await refreshSessionImages()
}

export async function refreshSessionImages(): Promise<void> {
  state = 'loading'
  errorMessage = null
  try {
    groups = (await clientOf().listSessionImages()).groups
    state = 'ready'
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
    state = 'error'
  }
}

export function resetSessionImagesForTests(next?: MySessionImagesClient): void {
  client = next ?? null
  groups = []
  state = 'idle'
  errorMessage = null
  initialized = false
}
