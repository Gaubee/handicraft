/*
 * 转录投影（zhumo 方案移植块 B，2026-09-28——zhumo stores/tasks.svelte 的
 * TranscriptItem/projectFrames 语义适配贴钻 Frame 契约）。
 * 帧 → 转录条目：
 * - transcript 三角色：user → UserBubble 位；assistant → 全宽 markstream 正文
 *   （贴钻帧无 delta 流——streaming 恒 false 定稿态）；tool → AgentToolRow
 *   （payload.text 整段为结果文本）。
 * - progress → status 行；error → 失败明文卡；done → turn-end 药丸（时长按帧
 *   时间戳差推导——贴钻帧无 usage）+ done 卡（打开任务详情入口）并存。
 * - artifact 连续段 → 相邻同名去重 + 超 3 枚余量并成单行「+N 个工件已入工作域」
 *   （T2 工件墙收敛）。
 * - 贴钻石有帧（approval-request/approval-resolved/artifact）保留原 FrameView
 *   渲染分支（审批卡/策略提案卡/产物 chip——组件级 1:1 换装不丢贴钻语义）。
 * 任务溯源（v6 复核 P1-5）：投影入参=按任务分组的帧（taskId 随组透传）——frame
 * 条目携带所属 taskId（done 卡「打开任务详情」/审批应答目标=来源任务，不由组件
 * 接收全局最新任务 id——历史任务帧只影响其自身任务的 UI 面）。
 * seq 唯一性：投影全局序（任务域 seq 跨任务会重复）。
 */
import type { Frame } from '@handicraft/contracts'
import { attachmentMetasOf, type AttachmentMeta } from './attachments.js'
import { extractUserAnnotations } from './userAnnotations.js'
import { parseResumeRunNotice, resumeRunStatusLabel } from './resumeRun.js'
import { parseToolCallText, parseToolResultText, toolDisplayName } from './toolNames.js'

export interface TurnUsagePill {
  in: number
  out: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * 用户帧系统注记元数据（w17-critic T1：taskId 绑定/图片映射注记移出正文——
 * 气泡角落小图标 title 承载，正文保持用户原话）。
 */
export interface UserFrameNote {
  /** 注记原文聚合（title 悬浮）。 */
  title: string
  /** 任务绑定注记的 taskId（无=null——图标按此分流语义）。 */
  taskId: string | null
}

/** 转录条目（zhumo TranscriptItem 同形 + 贴钻石有帧透传 kind+taskId）。 */
export type TranscriptItem =
  /** ts=帧时间戳（消息级工具条时间戳用——reasoning/tool 不带，Owner 只要消息级）。 */
  | { kind: 'user'; seq: number; text: string; queued?: string; attachments?: AttachmentMeta[]; ts?: number; note?: UserFrameNote }
  | { kind: 'assistant'; seq: number; text: string; streaming: boolean; ts?: number }
  | { kind: 'reasoning'; seq: number; text: string; streaming: boolean }
  | { kind: 'tool'; seq: number; toolName: string; argsText: string; result: string | null; rawToolName?: string }
  | { kind: 'status'; seq: number; text: string }
  | { kind: 'error'; seq: number; text: string }
  | { kind: 'turn-end'; seq: number; elapsedMs?: number; usage?: TurnUsagePill }
  /** 贴钻石有：审批请求/解决、产物 chip、任务完成（打开任务详情入口）——原帧透传
   *  +来源任务 id（v6 P1-5：逐帧归属，非全局 activeTask）。 */
  | { kind: 'frame'; seq: number; taskId: string; frame: Frame }

/**
 * 帧 → 转录条目（贴钻 FrameKind 全集投影；按任务分组一次调用——taskId 随组
 * 落到 frame 条目，跨任务压平不丢归属）。
 * [zhumo 对照清单 T2/T7 2026-09-28]：
 * - artifact 连续段收敛：相邻同名去重 → 超过 3 枚时余量合并为单行 status 汇总
 *   「+N 个工件已入工作域」（走查实拍：53 枚重复 chip 独占行 ≈6 屏的工件墙）。
 * - done 帧 = 任务轮终点 → 先投影 turn-end 药丸行（本轮完成 · 时长——契约
 *   DonePayload 无 usage，时长按任务首帧与 done 帧时间戳差推导；明细进 title），
 *   done 卡（打开任务详情入口）随其后保留，归属语义不变（v6 P1-5）。
 */
export const ARTIFACT_INLINE_MAX = 3

function artifactNameOf(frame: Frame): string {
  return frame.kind === 'artifact' ? (frame.payload.name ?? '') : ''
}

/** 分发型 Omit（判别联合上直接 Omit 会塌成公共键——分布后逐成员去 seq）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 连续 artifact 段投影：相邻同名去重 → 前 3 枚 chip + 余量单行汇总。 */
function projectArtifactRun(
  run: Frame[],
  taskId: string,
  emit: (item: DistributiveOmit<TranscriptItem, 'seq'>) => void,
): void {
  const kept: Frame[] = []
  for (const frame of run) {
    const prev = kept[kept.length - 1]
    if (prev !== undefined && artifactNameOf(prev) === artifactNameOf(frame)) continue
    kept.push(frame)
  }
  for (const frame of kept.slice(0, ARTIFACT_INLINE_MAX)) {
    emit({ kind: 'frame', taskId, frame })
  }
  const overflow = kept.length - ARTIFACT_INLINE_MAX
  if (overflow > 0) {
    emit({ kind: 'status', text: `+${overflow} 个工件已入工作域` })
  }
}

/**
 * 消息时间戳格式（T2/T3 工具条）：当天 HH:mm；距「现在」>24h 判跨天 → M-D HH:mm。
 * 无 ts 由调用方不渲染（历史帧回放前无时间戳的宽容位）。
 */
export function formatMessageTime(ts: number, now: number = Date.now()): string {
  const date = new Date(ts)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (Math.abs(now - ts) > 24 * 60 * 60 * 1000) return `${date.getMonth() + 1}-${date.getDate()} ${hhmm}`
  return hhmm
}

export function projectFrames(groups: Array<{ taskId: string; frames: Frame[] }>): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let seq = 0
  const emit = (item: DistributiveOmit<TranscriptItem, 'seq'>): void => {
    seq += 1
    items.push({ ...item, seq })
  }
  for (const group of groups) {
    const frames = group.frames
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      if (frame !== undefined && frame.kind === 'artifact') {
        // 连续 artifact 段收集（段内 chip 墙收敛投影——T2）。
        let end = i
        while (end + 1 < frames.length && frames[end + 1]?.kind === 'artifact') end += 1
        const run = frames.slice(i, end + 1) as Array<Extract<Frame, { kind: 'artifact' }>>
        projectArtifactRun(run, group.taskId, emit)
        i = end
        continue
      }
      switch (frame.kind) {
        case 'transcript': {
          const role = frame.payload.role
          if (role === 'user') {
            // [θ 接线] 系统续跑通知帧（daemon 在原任务流上发的系统通知）：渲染为
            // status 行——不是用户原话，不进用户气泡（裸 taskId 同步降噪）。
            if (parseResumeRunNotice(frame.payload.text) !== null) {
              emit({ kind: 'status', text: resumeRunStatusLabel() })
              break
            }
            // [split-admin-portal 2.6.4] 用户帧附件元数据宽容读取（契约
            // TranscriptPayloadSchema 放宽并行中——形态不符即省略，回放不崩）。
            const attachments = attachmentMetasOf(frame.payload as { attachments?: unknown })
            // [w17-critic T1] 系统注记（任务绑定/图片映射）移出正文：body=用户原话，
            // 注记聚合进 note（气泡角落图标 title——正文零 dev-speak）。
            const { body, notes, taskId } = extractUserAnnotations(frame.payload.text)
            emit({
              kind: 'user',
              text: body,
              ...(attachments !== undefined ? { attachments } : {}),
              ts: frame.ts,
              ...(notes.length > 0 ? { note: { title: notes.join('\n'), taskId } } : {}),
            })
          } else if (role === 'assistant') {
            emit({ kind: 'assistant', text: frame.payload.text, streaming: false, ts: frame.ts })
          } else {
            // 工具/系统行（daemon 把调用/结果压进 text）：解析回结构化工具行
            // （名称走中文映射、参数/结果入展开卡）；非该形态整段作为结果卡兜底。
            const call = parseToolCallText(frame.payload.text)
            if (call !== null) {
              emit({ kind: 'tool', toolName: toolDisplayName(call.name), argsText: call.args, result: null, rawToolName: call.name })
              break
            }
            const result = parseToolResultText(frame.payload.text)
            if (result !== null) {
              emit({ kind: 'tool', toolName: toolDisplayName(result.name), argsText: '', result: result.text, rawToolName: result.name })
              break
            }
            emit({ kind: 'tool', toolName: '工具输出', argsText: '', result: frame.payload.text })
          }
          break
        }
        case 'progress':
          emit({ kind: 'status', text: frame.payload.text ?? '进行中' })
          break
        case 'activity':
          // [4] 活动帧=任务详情「活动」tab 的时间线投影域（activity.svelte 配对
          // 合并）；转录流保持模型视角（tool 角色帧既有呈现不变——契约「并存
          // 不互替」）。跳过＝对话流不重复渲染工具行。
          break
        case 'error':
          emit({ kind: 'error', text: frame.payload.message })
          break
        case 'done': {
          // turn-end 药丸（T7）：任务首帧→done 帧的时间戳差=本轮时长。
          const first = frames[0]
          const elapsedMs = first !== undefined ? Math.max(0, frame.ts - first.ts) : undefined
          emit({ kind: 'turn-end', ...(elapsedMs !== undefined ? { elapsedMs } : {}) })
          // done 卡（贴钻石有帧——「打开任务详情」入口，不折进药丸）。
          emit({ kind: 'frame', taskId: group.taskId, frame })
          break
        }
        default:
          // approval-request/approval-resolved：贴钻石有帧原样透传（审批卡/策略
          // 提案卡——taskId=来源任务）。
          emit({ kind: 'frame', taskId: group.taskId, frame })
          break
      }
    }
  }
  return items
}

/**
 * 队列待发气泡合并（zhumo W10l 同款语义的外环形态）：队列中尚未消费的消息
 * 追加到转录流尾部，按模式挂状态标签（消费后由真实 user 帧接管）。
 * [split-admin-portal 2.6] 附件随条目透传（纯图队列条目=空文本+chip 行）。
 */
export function pendingQueueItems(
  queue: Array<{ id: string; text: string; mode: 'queue' | 'steer' | 'inject'; attachments?: AttachmentMeta[] }>,
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
    ...(item.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
  }))
}
