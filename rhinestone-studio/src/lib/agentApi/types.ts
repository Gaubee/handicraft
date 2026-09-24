/*
 * Agent API façade 类型层（design §2 RPC 行 / §3.5 冻结契约——W3.1）。
 * 类型全部自 @handicraft/contracts zod 推导（前后端唯一真源）；façade 的每个
 * 读面输出在实现侧过对应 schema parse（type-safe 即 runtime-safe）。
 * 双实现：MockAgentApi（固定 fixture 帧序列——W4 接线前 UI 开发真源）与
 * RpcAgentApi（@orpc/client RPCLink over /ws/rpc + /ws/tasks/:id 帧流）。
 */

import type {
  Frame,
  SessionListInput,
  SessionListOutput,
  SessionSummary,
  TaskStatus,
} from '@handicraft/contracts'

/** façade 连接态（mock=本地恒可用；rpc=WS 生命周期）。 */
export type AgentConnectionState = 'mock' | 'connecting' | 'open' | 'closed' | 'error'

/** 会话任务投影（契约 SessionTaskSummary 同形）。 */
export interface AgentTaskView {
  taskId: string
  status: TaskStatus
  lastSeq: number
  frameCount: number
}

/** 结果视图（契约 session.result / task.result 的 found 分支同形）。 */
export interface AgentResultView {
  resultId: string
  taskId: string
  publicId?: string
  bundle: { svg: string; bom: string; png: string }
}

export type AgentSessionView = SessionSummary

export interface AgentApi {
  /** 传输模式（mock 固定 fixture / rpc 服务端同源）。 */
  readonly mode: 'mock' | 'rpc'
  /** 当前连接态 + 订阅面（UI 状态条消费）。 */
  connection(): AgentConnectionState
  onConnectionChange(listener: (state: AgentConnectionState) => void): () => void

  listSessions(input?: SessionListInput): Promise<SessionListOutput>
  createSession(input: { title?: string }): Promise<{ sessionId: string; createdAt: string }>
  getSession(sessionId: string): Promise<{ session: AgentSessionView; tasks: AgentTaskView[] }>
  /** 一次 followup = 一个 type=agent 的 task；帧经 subscribeTask 流入。 */
  followup(sessionId: string, text: string): Promise<{ taskId: string }>
  answer(sessionId: string, requestId: string, approved: boolean): Promise<{ ok: boolean }>
  cancel(input: { sessionId?: string; taskId?: string }): Promise<{ ok: boolean }>
  /** clear 输出（契约同形）：status 区分已清理完成/仍在清理（文件删除失败待重试）。 */
  clear(sessionId: string): Promise<{ ok: boolean; status: 'cleared' | 'clearing' }>
  /** 回放游标以 task 为域（afterSeq 之后无缺失无重复）。 */
  replay(sessionId: string, taskId: string, afterSeq: number): Promise<{ frames: Frame[]; nextSeq: number }>
  sessionResult(sessionId: string): Promise<AgentResultView>
  taskResult(taskId: string): Promise<{ found: boolean } & Partial<AgentResultView>>
  /**
   * 帧订阅：先回放 afterSeq 之后的持久帧，再续收实时帧（断线重连由调用方持
   * lastSeq 游标重订阅）。返回退订函数。
   */
  subscribeTask(taskId: string, afterSeq: number, onFrame: (frame: Frame) => void): () => void
}
