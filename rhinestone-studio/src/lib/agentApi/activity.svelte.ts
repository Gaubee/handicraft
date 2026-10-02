/*
 * 活动时间线投影（[4] 2026-10-02 Owner 需求「任务详情=整个任务会话的投影——图像
 * 处理过程可视化」）。
 * 前端契约同步方式：帧类型/zod 真源= @handicraft/contracts FrameSchema（workspace
 * 直连——rpc.ts 的 WS 帧经 FrameSchema.safeParse 守门，解析失败整帧静默丢弃＝
 * 未知 kind 不炸的既有处置）；本文件只做纯投影（配对合并/耗时人话化/在途计数），
 * 不再拷贝 schema。
 * 投影语义（契约 ActivityPayload 注释同源）：
 * - 条目=一次工具调用：running 开帧 + 终态（ok/error/cancelled）帧按 activityId
 *   配对合并为一行（首见位置=时间线序；终态帧整体覆写字段，running 不回退）。
 * - 未配对 running=进行中（秒表由组件层实时算）；终态帧无 running 前帧（回放
 *   窗口起点截断等）＝按序自成一行（宽容不炸）。
 * - 与 transcript role:'tool' 帧并存不互替：本投影只服务任务详情「活动」tab；
 *   转录流（transcript.svelte）对 activity 帧显式跳过（模型视角不重复渲染）。
 */

import type { Frame } from '@handicraft/contracts'

/** 时间线条目（running+终态配对合并后的行投影）。 */
export interface ActivityEntry {
  /** 配对键（daemon=dsh tool callId）。 */
  activityId: string
  /** 工具名（去 mcp__<server>__ 前缀后的能力名）。 */
  tool: string
  /** 人话短句（如「区域分割 · 左手」）。 */
  label: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
  /** 发起时刻（epoch ms）。 */
  startedAt: number
  /** 耗时（终态携带；running 缺省）。 */
  durationMs?: number
  /** 入参摘要（≤200）。 */
  inputSummary?: string
  /** 产出图/文件的内容寻址引用（缩略→Lightbox 大图）。 */
  outputBlobRef?: string
  /** 产出摘要（≤200）。 */
  outputSummary?: string
  /** 失败简述（error 帧；≤300）。 */
  errorBrief?: string
}

type ActivityFrame = Extract<Frame, { kind: 'activity' }>

/**
 * 帧 → 时间线条目（时间正序：帧首见序即序——seq 单调；终态覆写不移动行位）。
 * 纯函数（组件 $derived 消费——新帧经既有 WS/回放通道到达即重算）。
 */
export function projectActivity(frames: Frame[]): ActivityEntry[] {
  const byId = new Map<string, ActivityEntry>()
  const order: string[] = []
  for (const frame of frames) {
    if (frame.kind !== 'activity') continue
    const payload: ActivityFrame['payload'] = frame.payload
    const existing = byId.get(payload.activityId)
    if (existing === undefined) {
      byId.set(payload.activityId, { ...payload })
      order.push(payload.activityId)
      continue
    }
    // 终态覆写（running 不回退——终态后的迟到 running 帧 no-op）；行位不变。
    if (existing.status === 'running' && payload.status !== 'running') {
      byId.set(payload.activityId, { ...payload })
    }
  }
  return order.map((id) => byId.get(id)!)
}

/** 进行中条目数（未配对 running——tab 触发器 badge 的口径；与投影同源不另立判定）。 */
export function activityRunningCount(frames: Frame[]): number {
  return projectActivity(frames).filter((entry) => entry.status === 'running').length
}

/**
 * 耗时人话化（brief 口径）：<1s→ms、<60s→s、else→m+s（如 `860ms` / `12s` / `2m6s`）。
 */
export function formatActivityDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`
}

/** 进行中条目的实时耗时秒（秒表——组件层 nowTs tick 驱动重算）。 */
export function activityElapsedSec(startedAt: number, nowTs: number): number {
  return Math.max(0, Math.round((nowTs - startedAt) / 1_000))
}

/** 活跃时长口径：相邻帧间隔超过该阈值的段视为空闲，不计入用时（挂机/跨天段剔除）。 */
const ACTIVE_GAP_LIMIT_MS = 30 * 60_000

/**
 * 活跃工作时长（ms）近似（走查 2026-10-02「用时 75222s」跨天帧污染口径修正）：
 * 首尾帧差会把跨天空闲整段算进用时——改为累加相邻帧间隔 < 阈值（30min）的部分。
 * endMs 提供时末帧→endMs 的尾段同口径计入（运行中传 Date.now()；终态缺省=末帧
 * 收口）。frames 空=null；全空闲（无任何 < 阈值段）=0。
 */
export function activeElapsedMs(frames: Frame[], endMs?: number): number | null {
  if (frames.length === 0) return null
  let total = 0
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i]!.ts - frames[i - 1]!.ts
    if (gap > 0 && gap < ACTIVE_GAP_LIMIT_MS) total += gap
  }
  if (endMs !== undefined) {
    const tail = endMs - frames[frames.length - 1]!.ts
    if (tail > 0 && tail < ACTIVE_GAP_LIMIT_MS) total += tail
  }
  return total
}
