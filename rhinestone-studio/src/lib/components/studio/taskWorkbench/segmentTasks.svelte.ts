/*
 * 抠图任务描述 store（add-vision-pipeline-v2 T5/D6——任务详情形态，队列预埋）。
 * Owner 定调（2026-10-03）：「未来我们可能会有一个抠图任务队列，Dialog 就是任务详情：
 * 如果我们要支持同时多个抠图的话……架构是要预先埋好的。」
 * 形态：任务数组+activeId——**store 持任务数组**，v1 单任务同步执行（trial/land 一次
 * 一个，Dialog 只渲染 active），但结构队列就绪：未来多任务并发/微服务拆分只加消费者
 * （执行器循环+并发度），任务描述结构与本 store 的读写面零改。
 * 状态机：draft（编辑中）→ trialing（试跑中——SAM 真跑 1-2 分钟）→ preview-ready
 * （试跑结果在场——可改指令/参数重跑、可命名落地）→ landing（落地中）→ done（终态）；
 * failed=试跑/落地失败（error 驻留——同参重试或改参重跑）。落地/试跑共用
 * store.svelte 的 trialSegmentLayer/landSegmentLayer 原语（fence/树应用单源）。
 * 纯度：仅前端 UI 态——树真源在 workbench store（落地成功经其 applySegmentOutput）。
 */
import type { AgentImagePreview, ObjectNode, SegmentPrecision, WorkbenchWarning } from '@handicraft/contracts'
import { getSelectedNodeId, landSegmentLayer, trialSegmentLayer } from './store.svelte'

/** 任务状态（D6——draft|trialing|preview-ready|landing|done|failed）。 */
export type SegmentTaskStatus = 'draft' | 'trialing' | 'preview-ready' | 'landing' | 'done' | 'failed'

/** 试跑结果（trial 面载荷+试跑构造的子层——树未变）。 */
export interface SegmentTrialResult {
  children: ObjectNode[]
  warnings: WorkbenchWarning[]
  preview: AgentImagePreview
  /** 账本回放标记（true=服务端零桥调用——试跑→确认幂等的可观测面）。 */
  replayed: boolean
}

/**
 * 试跑基态快照（Codex R1 P1——预览绑定确认语义）：试跑成功时记录产生该预览的
 * 有效请求面（instruction/precision/targetNodeId）+树基态（treeBlobRef——试跑响应
 * 原样回传的当前树引用）。确认守卫：任一漂移=预览作废（回 draft 重试跑）；树基态
 * 漂移（试跑后树被别处改过）=禁确认+提示重跑；确认请求携带 trialTreeBlobRef=
 * 快照树引用（服务端 typed 拒 trial-stale-tree——双保险）。layerName 不入快照
 * （T5 账本语义：不入指纹——改名不需要重试跑）。
 */
export interface SegmentTrialSnapshot {
  instruction: string
  precision: SegmentPrecision | null
  targetNodeId: string
  treeBlobRef: string
}

/**
 * 抠图任务描述（队列预埋单源——未来换真队列/微服务执行器不改此结构）：
 * targetNodeId+instruction+precision=请求三要素（同参确认的幂等键）；layerName 只在
 * 落地时生效（不参与服务端请求哈希）。
 */
export interface SegmentTask {
  id: string
  targetNodeId: string
  /** 抠图指令（自由文本——服务端记 segmentPrompt 原文）。 */
  instruction: string
  /** 精度覆写（null=跟随服务端配置——参数区空显示语义）。 */
  precision: SegmentPrecision | null
  /** 落地自定义图层名（空=服务端提示语命名链）。 */
  layerName: string
  status: SegmentTaskStatus
  trialResult: SegmentTrialResult | null
  /** 试跑基态快照（Codex R1 P1——preview-ready 时在场；参数变更即作废清空）。 */
  trialSnapshot: SegmentTrialSnapshot | null
  /** 试跑作废提示（参数变更离开 preview-ready 时在场——「参数已变更，请重新试跑」）。 */
  staleNote: string | null
  error: string | null
  createdAt: number
}

let tasks = $state<SegmentTask[]>([])
let activeTaskId = $state<string | null>(null)
let seq = 0

/** 当前活动任务（Dialog 渲染源——null=关闭）。 */
export function getActiveSegmentTask(): SegmentTask | null {
  return tasks.find((task) => task.id === activeTaskId) ?? null
}

/** 任务数组（队列观察面——历史任务驻留数组，active 切换即「任务详情」切换）。 */
export function getSegmentTasks(): readonly SegmentTask[] {
  return tasks
}

function taskOf(id: string): SegmentTask | null {
  return tasks.find((task) => task.id === id) ?? null
}

function patchTask(id: string, patch: Partial<SegmentTask>): void {
  const index = tasks.findIndex((task) => task.id === id)
  if (index === -1) return
  tasks[index] = { ...tasks[index], ...patch }
}

/**
 * 打开抠图任务（入口=图层面板「拆分」按钮——目标=当前选中节点；画布根同权）。
 * v1 单任务：已有 trialing/landing 在途时不再新开（同步执行纪律）；
 * draft/preview-ready/failed 的旧任务被新任务顶替为非活动（数组驻留——队列史）。
 */
export function openSegmentTask(targetNodeId: string): void {
  if (tasks.some((task) => task.status === 'trialing' || task.status === 'landing')) return
  seq += 1
  const task: SegmentTask = {
    id: `seg-task-${seq}`,
    targetNodeId,
    instruction: '',
    precision: null,
    layerName: '',
    status: 'draft',
    trialResult: null,
    trialSnapshot: null,
    staleNote: null,
    error: null,
    createdAt: Date.now(),
  }
  tasks = [...tasks, task]
  activeTaskId = task.id
}

/** 关闭任务详情（取消——draft/preview-ready/failed 关闭=放弃本次；数组驻留可追溯）。 */
export function closeSegmentTask(): void {
  activeTaskId = null
}

/** precision 等值（null↔null / 字段逐一对比——快照比对面）。 */
function precisionEqual(a: SegmentPrecision | null, b: SegmentPrecision | null): boolean {
  if (a === null || b === null) return a === b
  return a.maskMaxSide === b.maskMaxSide && a.confThreshold === b.confThreshold
}

/**
 * 任务草稿编辑（instruction/precision/layerName——trialing/landing 中禁改）。
 * Codex R1 P1：preview-ready 时改 instruction/precision（与试跑快照对比——含从空到
 * 有/有到空）=旧预览作废（状态回 draft+trialResult/快照清空+staleNote 提示重试跑+
 * 确认按钮自然禁用）。layerName 不参与（不入指纹——改名不需要重试跑）。
 */
export function updateSegmentTask(
  id: string,
  patch: Partial<Pick<SegmentTask, 'instruction' | 'precision' | 'layerName'>>,
): void {
  const task = taskOf(id)
  if (task === null || task.status === 'trialing' || task.status === 'landing' || task.status === 'done') return
  const next: SegmentTask = { ...task, ...patch }
  if (
    task.status === 'preview-ready' &&
    task.trialSnapshot !== null &&
    (next.instruction.trim() !== task.trialSnapshot.instruction ||
      !precisionEqual(next.precision, task.trialSnapshot.precision) ||
      next.targetNodeId !== task.trialSnapshot.targetNodeId)
  ) {
    // 参数漂移：预览与参数必须同源——作废旧预览，回 draft 待重试跑
    patchTask(id, {
      ...patch,
      status: 'draft',
      trialResult: null,
      trialSnapshot: null,
      staleNote: '参数已变更，请重新试跑',
    })
    return
  }
  patchTask(id, patch)
}

/**
 * 试跑（dryRun=true——真跑分段不落树）：成功=trialResult 在场+status=preview-ready；
 * 失败=error 驻留+status=failed（同参重试/改参重跑均可）。改指令/参数后再试跑=旧
 * trialResult 失效清空（预览与参数必须同源）。
 */
export async function runSegmentTrial(id: string): Promise<void> {
  const task = taskOf(id)
  if (task === null || task.status === 'trialing' || task.status === 'landing' || task.status === 'done') return
  const instruction = task.instruction.trim()
  if (instruction === '') return
  patchTask(id, { status: 'trialing', error: null, trialResult: null })
  const outcome = await trialSegmentLayer({
    nodeId: task.targetNodeId,
    hint: instruction,
    ...(task.precision !== null ? { precision: task.precision } : {}),
  })
  // 任务可能已被顶替/关闭——patchTask 按 id 定位（不在场=丢弃结果）
  if (outcome.ok) {
    patchTask(id, {
      status: 'preview-ready',
      trialResult: {
        children: outcome.output.children,
        warnings: outcome.output.warnings,
        preview: outcome.output.trial?.preview ?? {
          // 契约保证 dryRun=true 恒带 trial 面；防御回退（schema 演进容错）
          kind: 'trial-mask-overlay',
          blobRef: outcome.output.previewBlobRef,
          mime: 'image/png',
          maxSide: 512,
          dataBase64: '',
        },
        replayed: outcome.output.trial?.replayed ?? false,
      },
      // 试跑基态快照（Codex R1 P1）：产生该预览的请求三要素+树基态（dryRun 响应
      // treeBlobRef=当前树引用原样回传——T5 契约语义）
      trialSnapshot: {
        instruction,
        precision: task.precision,
        targetNodeId: task.targetNodeId,
        treeBlobRef: outcome.output.treeBlobRef,
      },
      staleNote: null,
    })
  } else {
    patchTask(id, { status: 'failed', error: outcome.error })
  }
}

/**
 * 确认落地（同参再调 dryRun=false——服务端断点账本命中试跑掩膜直接回放零二次桥调）：
 * 成功=子层入树（workbench store 应用面）+自动选中新子层+status=done+关闭任务详情。
 * 空检出（试跑 children 为空）仍允许落地调用（服务端如实零检出——warning 面），
 * 但 UI 面确认按钮在空检出时禁用（无意义往返）。
 */
export async function confirmSegmentLanding(id: string): Promise<void> {
  const task = taskOf(id)
  if (task === null || task.status === 'landing' || task.status === 'done') return
  if (task.status !== 'preview-ready') return
  patchTask(id, { status: 'landing', error: null })
  const ok = await landSegmentLayer({
    nodeId: task.targetNodeId,
    hint: task.instruction.trim(),
    ...(task.precision !== null ? { precision: task.precision } : {}),
    ...(task.layerName.trim() !== '' ? { layerName: task.layerName.trim() } : {}),
    // 试跑基线树引用（Codex R1 P1）：服务端与电流树比对——不一致 typed 拒
    // trial-stale-tree（客户端树视图过期竞态的服务端守卫；UI 面另有 treeDrifted 预禁）
    ...(task.trialSnapshot !== null ? { trialTreeBlobRef: task.trialSnapshot.treeBlobRef } : {}),
  })
  if (ok) {
    patchTask(id, { status: 'done' })
    activeTaskId = null // 落地完成即关任务详情（新子层已自动选中）
  } else {
    patchTask(id, { status: 'failed', error: '落地失败（重试或改参重跑试跑）' })
  }
}

/** 打开任务并锚定选中（入口便捷面——图层面板「拆分」按钮）。 */
export function openSegmentTaskForSelection(): void {
  const selected = getSelectedNodeId()
  if (selected !== null) openSegmentTask(selected)
}

/** 测试复位。 */
export function resetSegmentTasksForTests(): void {
  tasks = []
  activeTaskId = null
  seq = 0
}
