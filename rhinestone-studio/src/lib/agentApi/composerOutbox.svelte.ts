/*
 * 对话输入注入通道（add-subject-sam-pipeline P3.2——策略层人机面专用）。
 * 用途：策略参数表单「生成调整指令」→ 结构化指令文本注入会话输入框（人调参数→
 * Agent 重新提案→批准——不做旁路直写）。SessionStream 以 $effect 消费并清空；
 * 单槽（后到覆盖先到——表单逐次显式触发）。
 * [product-polish-w1 T2] 组合预选注入槽（同款单槽语义）：我的材料组合卡「开工」→
 * createSession(标题=组合名)+queueComposerSetPreset(组合摘要)→SessionStream 消费
 * →ComposerCard.presetSet 预选集合（N1 动线「挑组合→开工」一步进首条消息）。
 */

import type { AgentSetSummary } from './types.js'

let pendingText = $state<string | null>(null)
let pendingSet = $state<AgentSetSummary | null>(null)

export function peekComposerText(): string | null {
  return pendingText
}

export function queueComposerText(text: string): void {
  pendingText = text
}

export function clearComposerText(): void {
  pendingText = null
}

export function peekComposerSetPreset(): AgentSetSummary | null {
  return pendingSet
}

export function queueComposerSetPreset(set: AgentSetSummary): void {
  pendingSet = set
}

export function clearComposerSetPreset(): void {
  pendingSet = null
}

export function resetComposerOutboxForTests(): void {
  pendingText = null
  pendingSet = null
}
