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
