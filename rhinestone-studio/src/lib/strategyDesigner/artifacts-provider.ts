/*
 * 策略工件真实通道 provider（add-subject-sam-pipeline P3.2-channel——P3.2 登记缺口
 * 闭合）。装配链：agentApi 任务帧收集 artifact {name, blobRef, taskId}（store
 * getStrategyRefs——引用带任务溯源）→ 按 {taskId, blobRef} 经 tasks.artifact RPC
 * 拉 dataBase64 → JSON 工件 contracts schema 守门（ObjectTree/StrategyPlan/
 * StrategyGemsView/CodeStrategyArtifact——P3.2 形态）→ bundle；预览/原图走 PNG
 * dataUrl。依赖全注入（read/framesByTask）——测试以 stub 通道走同一装配链。
 *
 * 降级形态（沿 P3.2 既有约定）：
 *   - 三结构化工件（tree/plan/gems）引用任一缺席 → null（旅程未到位，非错误）。
 *   - 引用齐备但拉取失败/parse 失败 → throw（store 记 loadError——视图显式注记）。
 *   - 预览 PNG/原图附件拉取失败 → 该位 null（非致命——两态降级，不拖垮装配）。
 */

import {
  CodeStrategyArtifactSchema,
  ObjectTreeSchema,
  StrategyPlanSchema,
  type CodeStrategyArtifact,
  type Frame,
  type TaskArtifactInput,
  type TaskArtifactOutput,
} from '@handicraft/contracts'
import { StrategyGemsViewSchema } from './artifacts.js'
import type {
  StrategyArtifactRef,
  StrategyArtifactRefs,
  StrategyArtifactsBundle,
  StrategyArtifactsProvider,
} from './artifacts.js'

/** 字节读面（tasks.artifact RPC 的窄投影——AgentApi.taskArtifact 同形）。 */
export interface StrategyArtifactReader {
  taskArtifact(input: TaskArtifactInput): Promise<TaskArtifactOutput>
}

/** 真实通道依赖束（store 默认装配注入 agentApi 绑定面；测试注入 stub）。 */
export interface StrategyArtifactChannel {
  readonly read: StrategyArtifactReader
  /** 会话按任务帧组（附件注记解析/任务溯源）。 */
  framesByTask(): Array<{ taskId: string; frames: Frame[] }>
}

const FIRST_ISSUE_MAX = 160

/** zod issue 首条摘要（loadError 显式降级注记的因）。 */
function issueSummary(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues
  const first = issues?.[0]
  if (first === undefined) return String(error)
  return `${first.path.join('.')}: ${first.message}`
}

/** 附件注记（kernel followup prompt 注入的文本面投影）→ blobRef 集。 */
export function parseAttachmentAnnotation(text: string): string[] {
  // 形态：`[附件 2 个：<64hex>, <64hex>（W4.1 文本面投影；物料桥归 W4.2）]`
  const refs: string[] = []
  for (const match of text.matchAll(/\[附件 \d+ 个：([0-9a-f]{64}(?:, [0-9a-f]{64})*)（/g)) {
    refs.push(...match[1]!.split(', '))
  }
  return refs
}

/**
 * 原图输入引用：取**最新一组**附件注记的首个 blob（上传图是会话输入面第一附件
 * ——cm 尺寸声明在文本）。帧按任务序（activeTasks 顺序）+帧内顺序扫描，后见胜出。
 */
export function sourceImageRefOf(channel: StrategyArtifactChannel): { taskId: string; blobRef: string } | null {
  let latest: { taskId: string; blobRef: string } | null = null
  for (const { taskId, frames } of channel.framesByTask()) {
    for (const frame of frames) {
      if (frame.kind !== 'transcript' || frame.payload.role !== 'user') continue
      const refs = parseAttachmentAnnotation(frame.payload.text)
      if (refs.length > 0) latest = { taskId, blobRef: refs[0]! }
    }
  }
  return latest
}

/** 拉取+JSON parse+schema 守门（typed 失败消息带工件名——loadError 直观）。 */
async function fetchJsonArtifact<T>(
  channel: StrategyArtifactChannel,
  ref: StrategyArtifactRef,
  what: string,
  parse: (value: unknown) => T,
): Promise<T> {
  let out: TaskArtifactOutput
  try {
    out = await channel.read.taskArtifact({ taskId: ref.taskId, blobRef: ref.blobRef })
  } catch (error) {
    throw new Error(`工件 ${what}（${ref.blobRef.slice(0, 12)}…）拉取失败：${String(error)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(atobUtf8(out.dataBase64))
  } catch (error) {
    throw new Error(`工件 ${what}（${out.name}）非合法 JSON：${String(error)}`)
  }
  try {
    return parse(value)
  } catch (error) {
    throw new Error(`工件 ${what}（${out.name}）不符合 schema：${issueSummary(error)}`)
  }
}

/** 拉取+PNG dataUrl（非致命——失败返回 null 不拖垮装配）。 */
async function fetchPngDataUrl(channel: StrategyArtifactChannel, ref: StrategyArtifactRef): Promise<string | null> {
  try {
    const out = await channel.read.taskArtifact({ taskId: ref.taskId, blobRef: ref.blobRef })
    if (!out.mime.startsWith('image/')) return null
    return `data:${out.mime};base64,${out.dataBase64}`
  } catch {
    return null
  }
}

/** UTF-8 安全 base64 解码（JSON 工件含中文——atob 直解产乱码）。 */
function atobUtf8(dataBase64: string): string {
  const binary = atob(dataBase64)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** 真实通道 provider（缺省装配——store.svelte.ts；mock 仅测试注入）。 */
export class RpcStrategyArtifacts implements StrategyArtifactsProvider {
  constructor(private readonly channel: StrategyArtifactChannel) {}

  async load(refs: StrategyArtifactRefs): Promise<StrategyArtifactsBundle | null> {
    // 三结构化工件引用任一缺席=旅程未到位（显式 null——不进入拉取/装配）。
    if (refs.tree === null || refs.plan === null || refs.gems === null) return null

    const [tree, plan, gems] = await Promise.all([
      fetchJsonArtifact(this.channel, refs.tree, 'object-tree', (v) => ObjectTreeSchema.parse(v)),
      fetchJsonArtifact(this.channel, refs.plan, 'strategy-plan', (v) => StrategyPlanSchema.parse(v)),
      // StrategyGemsViewSchema 为本包字面镜像（daemon 不可 import 红线——artifacts.ts 头注）
      fetchJsonArtifact(this.channel, refs.gems, 'strategy-gems', (v) => StrategyGemsViewSchema.parse(v)),
    ])

    // free-code 指派源码工件（plan.assignments[].codeArtifactRef 去重逐一拉取）。
    const codeRefs = [
      ...new Set(plan.assignments.flatMap((a) => (a.codeArtifactRef !== undefined ? [a.codeArtifactRef] : []))),
    ]
    const codeArtifacts: Record<string, CodeStrategyArtifact> = {}
    for (const codeRef of codeRefs) {
      const owning = refs.plan // 源码工件与 plan 同任务落档（design.ts emit 同任务帧流）
      codeArtifacts[codeRef] = await fetchJsonArtifact(this.channel, { blobRef: codeRef, taskId: owning.taskId }, 'free-code', (v) =>
        CodeStrategyArtifactSchema.parse(v),
      )
    }

    // 预览 PNG（非致命）+ 原图附件通道（两态——无注记/拉取失败均 null）。
    const [treePreviewUrl, gemsPreviewUrl, sourceImageUrl] = await Promise.all([
      refs.treePreview !== null ? fetchPngDataUrl(this.channel, refs.treePreview) : Promise.resolve(null),
      refs.gemsPreview !== null ? fetchPngDataUrl(this.channel, refs.gemsPreview) : Promise.resolve(null),
      this.fetchSourceImageUrl(),
    ])

    return { tree, plan, gems, codeArtifacts, sourceImageUrl, treePreviewUrl, gemsPreviewUrl }
  }

  private async fetchSourceImageUrl(): Promise<string | null> {
    const ref = sourceImageRefOf(this.channel)
    if (ref === null) return null
    try {
      const out = await this.channel.read.taskArtifact({ taskId: ref.taskId, blobRef: ref.blobRef })
      if (!out.mime.startsWith('image/')) return null
      return `data:${out.mime};base64,${out.dataBase64}`
    } catch {
      return null // 附件已不在引用集（会话清理竞态）——降级态
    }
  }
}
