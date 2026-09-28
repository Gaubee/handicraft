/*
 * 转录投影（zhumo 方案移植块 B，2026-09-28——zhumo stores/tasks.svelte 的
 * TranscriptItem/projectFrames 语义适配贴钻 Frame 契约）。
 * 帧 → 转录条目：
 * - transcript 三角色：user → UserBubble 位；assistant → 全宽 markstream 正文
 *   （贴钻帧无 delta 流——streaming 恒 false 定稿态）；tool → AgentToolRow
 *   （payload.text 整段为结果文本）。
 * - progress → status 行；error → 失败明文卡；done → turn-end 药丸（贴钻帧无
 *   usage/elapsed——只显「任务完成」）。
 * - 贴钻石有帧（approval-request/approval-resolved/artifact）保留原 FrameView
 *   渲染分支（审批卡/策略提案卡/产物 chip——组件级 1:1 换装不丢贴钻语义）。
 * 任务溯源（v6 复核 P1-5）：投影入参=按任务分组的帧（taskId 随组透传）——frame
 * 条目携带所属 taskId（done 卡「打开任务详情」/审批应答目标=来源任务，不由组件
 * 接收全局最新任务 id——历史任务帧只影响其自身任务的 UI 面）。
 * seq 唯一性：投影全局序（任务域 seq 跨任务会重复）。
 */
import type { Frame } from '@handicraft/contracts'

export interface TurnUsagePill {
  in: number
  out: number
  cacheRead?: number
  cacheWrite?: number
}

/** 转录条目（zhumo TranscriptItem 同形 + 贴钻石有帧透传 kind+taskId）。 */
export type TranscriptItem =
  | { kind: 'user'; seq: number; text: string; queued?: string }
  | { kind: 'assistant'; seq: number; text: string; streaming: boolean }
  | { kind: 'reasoning'; seq: number; text: string; streaming: boolean }
  | { kind: 'tool'; seq: number; toolName: string; argsText: string; result: string | null }
  | { kind: 'status'; seq: number; text: string }
  | { kind: 'error'; seq: number; text: string }
  | { kind: 'turn-end'; seq: number; elapsedMs?: number; usage?: TurnUsagePill }
  /** 贴钻石有：审批请求/解决、产物 chip、任务完成（打开任务详情入口）——原帧透传
   *  +来源任务 id（v6 P1-5：逐帧归属，非全局 activeTask）。 */
  | { kind: 'frame'; seq: number; taskId: string; frame: Frame }

/**
 * 帧 → 转录条目（贴钻 FrameKind 全集投影；按任务分组一次调用——taskId 随组
 * 落到 frame 条目，跨任务压平不丢归属）。
 */
export function projectFrames(groups: Array<{ taskId: string; frames: Frame[] }>): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let seq = 0
  for (const group of groups) {
    for (const frame of group.frames) {
      seq += 1
      switch (frame.kind) {
        case 'transcript': {
          const role = frame.payload.role
          if (role === 'user') {
            items.push({ kind: 'user', seq, text: frame.payload.text })
          } else if (role === 'assistant') {
            items.push({ kind: 'assistant', seq, text: frame.payload.text, streaming: false })
          } else {
            // 工具/系统行：整段文本作为工具结果卡（AgentToolRow 承载）。
            items.push({ kind: 'tool', seq, toolName: '工具输出', argsText: '', result: frame.payload.text })
          }
          break
        }
        case 'progress':
          items.push({ kind: 'status', seq, text: frame.payload.text ?? '进行中' })
          break
        case 'error':
          items.push({ kind: 'error', seq, text: frame.payload.message })
          break
        default:
          // approval-request/approval-resolved/artifact/done：贴钻石有帧原样透传
          //（done 卡承载「打开任务详情」入口——taskId=来源任务，不折成 turn-end 药丸）。
          items.push({ kind: 'frame', seq, taskId: group.taskId, frame })
          break
      }
    }
  }
  return items
}

/**
 * 队列待发气泡合并（zhumo W10l 同款语义的外环形态）：队列中尚未消费的消息
 * 追加到转录流尾部，按模式挂状态标签（消费后由真实 user 帧接管）。
 */
export function pendingQueueItems(
  queue: Array<{ id: string; text: string; mode: 'queue' | 'steer' | 'inject' }>,
  base: number,
): TranscriptItem[] {
  const labels: Record<string, string> = {
    queue: '待发 · 下一轮',
    steer: '待发 · 引导',
    inject: '待注入 · 等活动轮',
  }
  return queue.map((item, index) => ({
    kind: 'user' as const,
    seq: base + index + 1,
    text: item.text,
    queued: labels[item.mode] ?? '待发',
  }))
}
