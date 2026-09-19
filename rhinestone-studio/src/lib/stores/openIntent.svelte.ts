/**
 * openIntent 统一意图通道（openspec add-project-files design §7.3/§9.2 B3，切片 0.7）。
 *
 * 四 kind（gemproj/gemdoc/gemtpl/gemgen）共用单 store 的一次性打开意图，沿 handoff
 * store 的模块单例模式，但语义不同（R2 推翻 peek/consumeSuccess，改原子 claim/ack）：
 *
 * 状态机：pending → claimed(token) → succeeded（ackSuccess 清意图，无驻留终态）
 *                            └──────→ failed（ackFailed 不清意图 + reason 供诊断）
 *
 * - 原子 claim：claim 的检查+置位在同一同步块（无 await 间隙——Svelte $state 非事务，
 *   以同步临界区保证互斥）——并发两个 claimer（如多个 $effect 同一 flush 内竞争）至多
 *   一个成功，败者得 null。
 * - 新 intent replace 旧：pending/claimed/failed 任何阶段来了新意图即整体替换；旧 claim
 *   随之作废——旧 token 的一切 ack = 'stale' no-op。
 * - ack 仅认 token：非 claimer token（含被替换的旧 token / 伪造 token）的 ackSuccess/
 *   ackFailed 均 no-op 返回 'stale'；ackSuccess 清意图；ackFailed **不清意图**（保留
 *   failed 态与 reason，可诊断）；failed 是该 claim 的终态——同 token 再 ackSuccess 亦
 *   'stale'，重试请置新意图。
 * - 消费协议：peek() 只读（App $effect 切视图用，不清不 claim）；实际执行方 claim →
 *   动线完成 ackSuccess / 任一步失败 ackFailed（单次提示归调用方，本 store 不发 toast）。
 * - 刷新语义：纯内存 $state，**不持久化**——刷新/关闭页面即丢弃内存意图。这是设计裁决
 *   （design §9.2 B3 明文），不是遗漏；与 handoff store 同口径。
 *
 * UI 动线接线是 4.6 切片（AssetsView 双击先 parse 成功再置意图 / App 只切视图不清意图 /
 * LabView 七步定位-展开后 ackSuccess）；本文件只做 store 与状态机。
 */

import type { ProjectKind } from '$lib/persistence/projectTypes'

/** 统一意图载荷：四 kind 单 store，{kind, assetId}。 */
export interface OpenIntentPayload {
  kind: ProjectKind
  assetId: string
}

/** claim 成功凭证：payload 快照 + 一次性 token（ack 的唯一钥匙）。 */
export interface OpenIntentClaim {
  kind: ProjectKind
  assetId: string
  token: string
}

export type OpenIntentPhase = 'pending' | 'claimed' | 'failed'

/** peek() 快照（只读协议；token 仅 failed 诊断保留，pending 为 null）。 */
export interface OpenIntentSnapshot {
  phase: OpenIntentPhase
  kind: ProjectKind
  assetId: string
  token: string | null
  /** ackFailed 的诊断原因（仅 failed 阶段存在）。 */
  reason?: string
}

export type OpenIntentAckResult = 'consumed' | 'failed' | 'stale'

let intent = $state<OpenIntentSnapshot | null>(null)

function newIntentToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `intent-${crypto.randomUUID()}`
  return `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 置意图（replace 语义）：任何阶段的既有意图（含 claimed/failed）整体作废。 */
export function setOpenIntent(payload: OpenIntentPayload): void {
  intent = { phase: 'pending', kind: payload.kind, assetId: payload.assetId, token: null }
}

/** 只读窥视（不清不 claim）：无意图 → null。App $effect 切视图消费此口。 */
export function peekOpenIntent(): OpenIntentSnapshot | null {
  return intent
}

/**
 * 原子 claim：pending → claimed(token)。同步临界区（检查+置位无 await 间隙），并发
 * claimer 至多一个成功；无意图 / 已 claimed / 已 failed → null。
 */
export function claimOpenIntent(): OpenIntentClaim | null {
  const current = intent
  if (current === null || current.phase !== 'pending') return null
  const token = newIntentToken()
  intent = { phase: 'claimed', kind: current.kind, assetId: current.assetId, token }
  return { kind: current.kind, assetId: current.assetId, token }
}

/**
 * 成功 ack（仅 claimer token）：清意图，返回 'consumed'。非当前 claimer token /
 * 已终态（failed / 意图已被替换或清空）→ 'stale' no-op，不抛错。
 */
export function ackOpenIntentSuccess(token: string): OpenIntentAckResult {
  const current = intent
  if (current === null || current.phase !== 'claimed' || current.token !== token) return 'stale'
  intent = null
  return 'consumed'
}

/**
 * 失败 ack（仅 claimer token）：**不清意图**——转 failed 并保留 reason 供诊断（单次
 * 提示归调用方），返回 'failed'。非当前 claimer token / 已终态 → 'stale' no-op。
 */
export function ackOpenIntentFailure(token: string, reason: string): OpenIntentAckResult {
  const current = intent
  if (current === null || current.phase !== 'claimed' || current.token !== token) return 'stale'
  intent = { phase: 'failed', kind: current.kind, assetId: current.assetId, token, reason }
  return 'failed'
}

/** 测试专用：复位模块意图（「刷新=内存丢弃」的 store 层等价物：重新初始化后意图为空）。 */
export function resetOpenIntentForTests(): void {
  intent = null
}
