/*
 * 策略设计器 store（add-subject-sam-pipeline P3.2——Svelte 5 runes，策略层唯一状态源）。
 * 数据双源：
 *   [1] 帧流（真通道）：agentApi 会话帧 → 工件引用集（taskId 溯源）/旅程步骤/
 *       strategy-design 审批派生（getStrategyRefs/getStrategyJourney/
 *       getStrategyProposalRows——组件 $derived 内调用即响应式）。
 *   [2] 工件内容（真实通道——P3.2-channel 反转）：缺省 RpcStrategyArtifacts
 *       （tasks.artifact RPC 拉 dataBase64→schema 守门→装配）；mock 仅测试注入。
 * 视图态：选中图层/逐节点显隐/原图开关与透明度/框线开关——全部图层级（两层编辑
 * 铁律：单钻微调不在本面）。
 */

import {
  derivePixelsPerMm,
  type Frame,
  type KernelStrategyKind,
  type ObjectNode,
  type StrategyAssignment,
} from '@handicraft/contracts'
import { getActiveSessionFrames, getActiveSessionTaskFrames, getBoundAgentApi } from '$lib/agentApi/store.svelte'
import { queueComposerText } from '$lib/agentApi/composerOutbox.svelte'
import {
  STRATEGY_ARTIFACT_NAMES,
  type StrategyArtifactsBundle,
  type StrategyArtifactsProvider,
  type StrategyArtifactRef,
  type StrategyArtifactRefs,
} from './artifacts.js'
import { RpcStrategyArtifacts } from './artifacts-provider.js'
import { STRATEGY_FORM_SPECS, composeAdjustInstruction, summarizeParams } from './paramsSchema.js'

/** strategy.design 工具面名（daemon STRATEGY_DESIGN_TOOL_NAME 字面同源）。 */
export const STRATEGY_DESIGN_TOOL = 'studio.strategy.design'

/** 七族中文短标（paramsSchema STRATEGY_FORM_SPECS.label 单源——树行/指派表徽标共用）。 */
function kindLabelOf(kind: KernelStrategyKind): string {
  return STRATEGY_FORM_SPECS[kind]?.label ?? kind
}

// ---------------------------------------------------------------- 帧派生投影

/** 会话帧 → 工件引用集（各 canonical 名取最新一帧；引用携带任务溯源——RPC 入参）。 */
export function getStrategyRefs(): StrategyArtifactRefs {
  const latest = new Map<string, StrategyArtifactRef>()
  for (const { taskId, frames } of getActiveSessionTaskFrames()) {
    for (const frame of frames) {
      if (frame.kind !== 'artifact') continue
      const { name, blobRef } = frame.payload
      if (name === undefined || blobRef === undefined) continue
      latest.set(name, { blobRef, taskId })
    }
  }
  return {
    tree: latest.get(STRATEGY_ARTIFACT_NAMES.tree) ?? null,
    treePreview: latest.get(STRATEGY_ARTIFACT_NAMES.treePreview) ?? null,
    plan: latest.get(STRATEGY_ARTIFACT_NAMES.plan) ?? null,
    gems: latest.get(STRATEGY_ARTIFACT_NAMES.gems) ?? null,
    gemsPreview: latest.get(STRATEGY_ARTIFACT_NAMES.gemsPreview) ?? null,
  }
}

export interface JourneyStep {
  key: 'input' | 'analyze' | 'segment' | 'design' | 'execute' | 'preview'
  label: string
  status: 'pending' | 'active' | 'done'
  artifactName?: string
  blobRef?: string
  note?: string
}

/**
 * 旅程链（P3.3 验收地基）：各步经 Agent 对话工具调用自然发生——UI 只按帧在场
 * 呈现工件卡（不驱动不伪造）。analyze/segment 两步产物并入 object-tree 工件
 * （scene.analyze 留存归 DATA_ROOT，非任务工件帧——以树工件回填状态）。
 */
export function getStrategyJourney(): JourneyStep[] {
  const frames = getActiveSessionFrames()
  const refs = getStrategyRefs()
  const hasUser = frames.some((frame) => frame.kind === 'transcript' && frame.payload.role === 'user')
  const designFrame = [...frames].reverse().find(
    (frame): frame is Extract<Frame, { kind: 'approval-request' }> =>
      frame.kind === 'approval-request' && frame.payload.tool === STRATEGY_DESIGN_TOOL,
  )
  const designSeen = designFrame !== undefined
  const designResolved = frames.some(
    (frame) =>
      frame.kind === 'approval-resolved' &&
      designFrame !== undefined &&
      frame.payload.requestId === designFrame.payload.requestId,
  )
  const steps: JourneyStep[] = [
    {
      key: 'input',
      label: '上传图 + cm 尺寸',
      status: hasUser ? 'done' : 'pending',
      note: hasUser ? undefined : '在 Agent 对话中上传图并声明厘米尺寸',
    },
    {
      key: 'analyze',
      label: '全图语义分析 scene.analyze',
      status: refs.tree !== null ? 'done' : 'pending',
      note: refs.tree === null ? '产物并入 object-tree 工件呈现' : undefined,
    },
    {
      key: 'segment',
      label: '迭代抠图 subject.segment',
      status: refs.tree !== null ? 'done' : 'pending',
      artifactName: refs.tree !== null ? STRATEGY_ARTIFACT_NAMES.tree : undefined,
      blobRef: refs.tree?.blobRef,
    },
    {
      key: 'design',
      label: '策略设计 strategy.design',
      status: designResolved ? 'done' : designSeen ? 'active' : 'pending',
      artifactName: refs.plan !== null ? STRATEGY_ARTIFACT_NAMES.plan : undefined,
      blobRef: refs.plan?.blobRef,
      note: designSeen && !designResolved ? '指派表待批准' : undefined,
    },
    {
      key: 'execute',
      label: '逐图层排钻执行',
      status: refs.gems !== null ? 'done' : 'pending',
      artifactName: refs.gems !== null ? STRATEGY_ARTIFACT_NAMES.gems : undefined,
      blobRef: refs.gems?.blobRef,
    },
    {
      key: 'preview',
      label: '叠加预览',
      status: refs.gemsPreview !== null ? 'done' : 'pending',
      artifactName: refs.gemsPreview !== null ? STRATEGY_ARTIFACT_NAMES.gemsPreview : undefined,
      blobRef: refs.gemsPreview?.blobRef,
    },
  ]
  return steps
}

/** 指派表行（proposal 卡与图层树共用投影——daemon assignmentTable 同形摘要）。 */
export interface ProposalAssignmentRow {
  nodeId: string
  objectName: string
  strategyKind: KernelStrategyKind
  kindLabel: string
  paramsSummary: string
  densityPerCm2: number
  stoneCount: number
  primaryStone: { sku: string; colorHex: string; sizeMm: number | null } | null
  engineStrategy?: string
  codeArtifactRef?: string
  rationale: string
}

// ---------------------------------------------------------------- 状态本体

let artifacts = $state<StrategyArtifactsBundle | null>(null)
let loading = $state(false)
let loadError = $state<string | null>(null)
let selectedNodeId = $state<string | null>(null)
let hiddenNodes = $state<ReadonlySet<string>>(new Set())
let baseImageVisible = $state(true)
let baseImageOpacity = $state(0.6)
let showBoxes = $state(true)

/**
 * 缺省 provider（P3.2-channel 反转）：真实通道——字节读面/帧源均**延迟**解析到
 * agentApi 当前绑定实现（bindAgentApi 在视图 init 前完成；load 时未绑定=编程错误
 * 显式抛）。mock fixture 仅测试经 bindStrategyArtifactsProvider 注入。
 */
function defaultProvider(): StrategyArtifactsProvider {
  return new RpcStrategyArtifacts({
    read: {
      taskArtifact: (input) => {
        const api = getBoundAgentApi()
        if (api === null) return Promise.reject(new Error('Agent API 未绑定——策略工件通道不可用'))
        return api.taskArtifact(input)
      },
    },
    framesByTask: () => getActiveSessionTaskFrames(),
  })
}

let provider: StrategyArtifactsProvider = defaultProvider()
let loadedKey: string | null = null
let loadSeq = 0

export function bindStrategyArtifactsProvider(next: StrategyArtifactsProvider): void {
  provider = next
  loadedKey = null
}

export function getStrategyArtifacts(): StrategyArtifactsBundle | null {
  return artifacts
}

export function isStrategyLoading(): boolean {
  return loading
}

export function getStrategyLoadError(): string | null {
  return loadError
}

/**
 * 帧引用集 → 工件装载（幂等守卫：refs key 不变不重装；会话切走/清空=卸载）。
 * 视图 $effect 内调用（refs 为响应式依赖——新工件帧落地即自动续装）。
 */
export function syncStrategyArtifacts(): void {
  const refs = getStrategyRefs()
  const key =
    refs.tree === null && refs.plan === null && refs.gems === null
      ? null
      : `${refs.tree?.blobRef}|${refs.plan?.blobRef}|${refs.gems?.blobRef}`
  if (key === loadedKey) return
  loadedKey = key
  const seq = ++loadSeq
  if (key === null) {
    artifacts = null
    selectedNodeId = null
    hiddenNodes = new Set()
    loadError = null
    return
  }
  loading = true
  loadError = null
  void provider
    .load(refs)
    .then((bundle) => {
      if (seq !== loadSeq) return
      artifacts = bundle
      selectedNodeId = null
      hiddenNodes = new Set()
    })
    .catch((error: unknown) => {
      if (seq !== loadSeq) return
      artifacts = null
      loadError = error instanceof Error ? error.message : String(error)
    })
    .finally(() => {
      if (seq === loadSeq) loading = false
    })
}

// ---------------------------------------------------------------- 树/指派投影

export interface LayerRow {
  node: ObjectNode
  depth: number
  assignment: StrategyAssignment | null
}

/** 图层树行集（DFS 先序——根=画布在前；assignment=指派缺席 null）。 */
export function getStrategyLayerRows(): LayerRow[] {
  if (artifacts === null) return []
  const byId = new Map(artifacts.tree.nodes.map((node) => [node.id, node] as const))
  const assignmentById = new Map(artifacts.plan.assignments.map((assignment) => [assignment.nodeId, assignment] as const))
  const rows: LayerRow[] = []
  const walk = (id: string, depth: number): void => {
    const node = byId.get(id)
    if (node === undefined) return
    rows.push({ node, depth, assignment: assignmentById.get(id) ?? null })
    for (const child of node.children) walk(child, depth + 1)
  }
  const root = artifacts.tree.nodes.find((node) => node.parent === null)
  if (root !== undefined) walk(root.id, 0)
  return rows
}

export function getStrategyAssignmentRows(): ProposalAssignmentRow[] {
  if (artifacts === null) return []
  const names = new Map(artifacts.tree.nodes.map((node) => [node.id, node.objectName] as const))
  return artifacts.plan.assignments.map((assignment) => {
    const primary = assignment.stones[0] ?? null
    return {
      nodeId: assignment.nodeId,
      objectName: names.get(assignment.nodeId) ?? assignment.nodeId,
      strategyKind: assignment.strategyKind,
      kindLabel: kindLabelOf(assignment.strategyKind),
      paramsSummary: summarizeParams(assignment.strategyKind, assignment.params),
      densityPerCm2: assignment.densityPerCm2,
      stoneCount: assignment.stones.length,
      primaryStone:
        primary === null
          ? null
          : { sku: primary.sku, colorHex: primary.colorHex, sizeMm: primary.sizeMm },
      ...(assignment.engineStrategy !== undefined ? { engineStrategy: assignment.engineStrategy } : {}),
      ...(assignment.codeArtifactRef !== undefined ? { codeArtifactRef: assignment.codeArtifactRef } : {}),
      rationale: assignment.rationale,
    }
  })
}

export function getAssignmentOf(nodeId: string): StrategyAssignment | null {
  if (artifacts === null) return null
  return artifacts.plan.assignments.find((assignment) => assignment.nodeId === nodeId) ?? null
}

export function getNodeOf(nodeId: string): ObjectNode | null {
  if (artifacts === null) return null
  return artifacts.tree.nodes.find((node) => node.id === nodeId) ?? null
}

// ---------------------------------------------------------------- 画布投影

/** 画布 ppm（contracts derivePixelsPerMm 同源；树纵横比不吻合时回退 1 并注记）。 */
export function getStrategyPpm(): { ppm: number; exact: boolean } {
  if (artifacts === null) return { ppm: 1, exact: true }
  const derived = derivePixelsPerMm({ canvasCm: artifacts.tree.canvasCm, imagePx: artifacts.tree.imagePx })
  return derived.ok ? { ppm: derived.pixelsPerMm, exact: true } : { ppm: 1, exact: false }
}

export interface RenderGem {
  id: string
  x: number
  y: number
  radiusPx: number
  colorHex: string
  nodeId: string
}

/** 点阵渲染投影：显隐过滤（hiddenNodes）+ 颜色=指派 StonePick colorHex + 尺寸=mm×ppm。 */
export function getRenderGems(): RenderGem[] {
  if (artifacts === null) return []
  const { ppm } = getStrategyPpm()
  const colorByNode = new Map<string, string>()
  for (const assignment of artifacts.plan.assignments) {
    const primary = assignment.stones[0]
    if (primary !== undefined) colorByNode.set(assignment.nodeId, primary.colorHex)
  }
  return artifacts.gems.gems
    .filter((gem) => !hiddenNodes.has(gem.blockId))
    .map((gem) => ({
      id: gem.id,
      x: gem.x,
      y: gem.y,
      radiusPx: (gem.diameterMm * ppm) / 2,
      colorHex: colorByNode.get(gem.blockId) ?? '#A3A3A3',
      nodeId: gem.blockId,
    }))
}

/** 框线渲染投影（显隐过滤同点阵；排除节点虚线红——排除语义色 P0.4 同系）。 */
export function getRenderBoxes(): Array<{ node: ObjectNode; excluded: boolean }> {
  if (artifacts === null) return []
  const excludedNodes = new Set(
    artifacts.plan.assignments.filter((assignment) => assignment.strategyKind === 'exclusion').map((assignment) => assignment.nodeId),
  )
  return artifacts.tree.nodes
    .filter((node) => !hiddenNodes.has(node.id))
    .map((node) => ({ node, excluded: excludedNodes.has(node.id) || !node.drillWorthy }))
}

// ---------------------------------------------------------------- 视图态动作

export function getSelectedNodeId(): string | null {
  return selectedNodeId
}

export function selectStrategyNode(nodeId: string | null): void {
  selectedNodeId = nodeId
}

export function isNodeVisible(nodeId: string): boolean {
  return !hiddenNodes.has(nodeId)
}

export function toggleNodeVisible(nodeId: string): void {
  const next = new Set(hiddenNodes)
  if (next.has(nodeId)) next.delete(nodeId)
  else next.add(nodeId)
  hiddenNodes = next
}

export function getBaseImageVisible(): boolean {
  return baseImageVisible
}

export function setBaseImageVisible(visible: boolean): void {
  baseImageVisible = visible
}

export function getBaseImageOpacity(): number {
  return baseImageOpacity
}

export function setBaseImageOpacity(opacity: number): void {
  baseImageOpacity = Math.min(1, Math.max(0, opacity))
}

export function getShowBoxes(): boolean {
  return showBoxes
}

export function setShowBoxes(visible: boolean): void {
  showBoxes = visible
}

/**
 * 表单「生成调整指令」：图层级参数 → 结构化指令文本注入对话输入框（策略层人机面
 * ——人调参数→Agent 重新提案→批准；不旁路直写）。
 */
export function queueNodeAdjustInstruction(nodeId: string, params: Record<string, unknown>, densityPerCm2: number): boolean {
  const node = getNodeOf(nodeId)
  const assignment = getAssignmentOf(nodeId)
  if (node === null || assignment === null) return false
  const stonesSummary =
    assignment.stones.length > 0
      ? assignment.stones.map((stone) => `${stone.sku}${stone.sizeMm !== null ? ` ${stone.sizeMm}mm` : ''}`).join('、')
      : ''
  queueComposerText(
    composeAdjustInstruction({
      objectName: node.objectName,
      nodeId,
      kind: assignment.strategyKind,
      params,
      densityPerCm2,
      stonesSummary,
    }),
  )
  return true
}

// ---------------------------------------------------------------- 测试复位

export function resetStrategyDesignerForTests(): void {
  artifacts = null
  loading = false
  loadError = null
  selectedNodeId = null
  hiddenNodes = new Set()
  baseImageVisible = true
  baseImageOpacity = 0.6
  showBoxes = true
  provider = defaultProvider()
  loadedKey = null
  loadSeq = 0
}
