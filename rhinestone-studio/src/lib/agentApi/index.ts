/*
 * Agent API façade 入口（design §2 RPC 行 / §3.5——W3.1）。
 * 模式选择：localStorage `handicraft.agentApi` = 'rpc' 显式切换服务端；缺省与
 * 未知值一律 mock（W4 接线前的产品默认——mock 完成不构成 MVP）。
 */

import { MockAgentApi } from './mock.js'
import { RpcAgentApi } from './rpc.js'
import type { AgentApi } from './types.js'

export * from './types.js'
export { MockAgentApi } from './mock.js'
export { RpcAgentApi } from './rpc.js'
export { FIXTURE_BLOB_REFS, FIXTURE_BUNDLE_BYTES } from './fixtures.js'

export const AGENT_API_MODE_KEY = 'handicraft.agentApi'

export type AgentApiFactory = () => AgentApi

/** 生产工厂：读模式键构造实现（mock 固定 fixture / rpc 同源服务端）。 */
export const defaultAgentApiFactory: AgentApiFactory = () => {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AGENT_API_MODE_KEY) : null
  return raw === 'rpc' ? new RpcAgentApi() : new MockAgentApi()
}

/**
 * 显式写模式键（[unify-studio-routing sweep ②] 顶栏「连接服务器」开关消费面）：
 * 'rpc'=连服务器（写键）；'mock'=演示数据（**删键**回缺省——键空间不留 'mock' 值，
 * 与工厂「缺省与未知值一律 mock」的读面互逆）。写后经页面重载生效（boot 工厂
 * 读键重建 WS/会话/订阅——`?api=rpc` 深链引导同键，两条入口共享同一持久面）。
 * 存储不可用（隐私模式等）静默降级——保持现模式。
 */
export function setAgentApiMode(mode: 'mock' | 'rpc'): void {
  try {
    if (mode === 'rpc') localStorage.setItem(AGENT_API_MODE_KEY, 'rpc')
    else localStorage.removeItem(AGENT_API_MODE_KEY)
  } catch {
    // 同 daemonToken 静默降级口径。
  }
}
