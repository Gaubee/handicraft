/*
 * 任务详情·排钻工作台 store（add-task-detail-layer-workbench 2.2-2.5——Svelte 5
 * runes，工作台唯一状态源）。
 * 装载：task.detail RPC（六数据源各自可空——按在场渲染）+ baseImage/gems 两工件
 * 字节经 tasks.artifact 附件通道拉取（dataUrl/JSON doc）。
 * 写操作（人类主权面——D-1 直接生效）：
 *   layer.split（拆层：子层入树+自动选中新子层）/layer.rename（inline 重命名提交）/
 *   layer.strategy.set（策略直改：指派替换+gems 工件按新 ref 重拉——点阵即刻刷新）。
 * 视图态：选中层/逐节点显隐/原图开关透明度/框线/蒙版可视化——全部图层级。
 */

import {
  derivePixelsPerMm,
  type KernelStrategyKind,
  type ObjectNode,
  type StrategyAssignment,
  type TaskDetailResponse,
} from '@handicraft/contracts'
import { getBoundAgentApi } from '$lib/agentApi/store.svelte'
import { StrategyGemsViewSchema, type StrategyGemsView } from '$lib/strategyDesigner/artifacts.js'
import { showToast } from '$lib/stores/toast.svelte'
import type { StrategyCanvasModel } from '$lib/components/strategy/canvasModel.js'
import { maskOverlayOf } from './maskViz.js'

/** 装载四态（idle=尚未发起装载——视图按 loading 呈现）。 */
export type WorkbenchPhase = 'idle' | 'loading' | 'error' | 'ready'

let taskId = $state<string | null>(null)
let phase = $state<WorkbenchPhase>('idle')
let loadError = $state<string | null>(null)
let detail = $state<TaskDetailResponse | null>(null)
/** 可演进树（split/rename 就地改；task.detail 重装载覆盖）。 */
let nodes = $state<ObjectNode[]>([])
let assignments = $state<StrategyAssignment[]>([])
let gemsDoc = $state<StrategyGemsView | null>(null)
let baseImageUrl = $state<string | null>(null)

let selectedNodeId = $state<string | null>(null)
let hiddenNodes = $state<ReadonlySet<string>>(new Set())
let baseVisible = $state(true)
let baseOpacity = $state(0.6)
let showBoxes = $state(true)
let showMasks = $state(false)

let splitting = $state(false)
let splitError = $state<string | null>(null)
let applying = $state(false)
let applyError = $state<string | null>(null)
let renameError = $state<string | null>(null)

let loadSeq = 0

function api() {
  const bound = getBoundAgentApi()
  if (bound === null) throw new Error('Agent API 未绑定——任务详情通道不可用')
  return bound
}

function decodeArtifactJson(dataBase64: string): unknown {
  const binary = atob(dataBase64)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** 装载/重试（taskId 变化或重试按钮——loadSeq 作废迟到结果）。 */
export async function loadWorkbench(nextTaskId: string): Promise<void> {
  taskId = nextTaskId
  phase = 'loading'
  loadError = null
  const seq = ++loadSeq
  try {
    const client = api()
    const response = await client.taskDetail(nextTaskId)
    if (seq !== loadSeq || taskId !== nextTaskId) return
    let nextBaseImageUrl: string | null = null
    if (response.baseImage !== null) {
      const artifact = await client.taskArtifact({ taskId: nextTaskId, blobRef: response.baseImage.blobRef })
      nextBaseImageUrl = `data:${artifact.mime};base64,${artifact.dataBase64}`
    }
    let nextGemsDoc: StrategyGemsView | null = null
    if (response.gems !== null) {
      const artifact = await client.taskArtifact({ taskId: nextTaskId, blobRef: response.gems.blobRef })
      nextGemsDoc = StrategyGemsViewSchema.parse(decodeArtifactJson(artifact.dataBase64))
    }
    if (seq !== loadSeq || taskId !== nextTaskId) return
    detail = response
    nodes = response.tree !== null ? response.tree.nodes.map((node) => ({ ...node })) : []
    assignments = response.assignments.map((assignment) => ({ ...assignment }))
    gemsDoc = nextGemsDoc
    baseImageUrl = nextBaseImageUrl
    selectedNodeId = null
    hiddenNodes = new Set()
    phase = 'ready'
  } catch (error) {
    if (seq !== loadSeq || taskId !== nextTaskId) return
    phase = 'error'
    loadError = error instanceof Error ? error.message : String(error)
  }
}

// ---------------------------------------------------------------- 读取器

export function getWorkbenchTaskId(): string | null {
  return taskId
}

export function getWorkbenchPhase(): WorkbenchPhase {
  return phase
}

export function getWorkbenchLoadError(): string | null {
  return loadError
}

export function getWorkbenchDetail(): TaskDetailResponse | null {
  return detail
}

export function getWorkbenchNodes(): ObjectNode[] {
  return nodes
}

export function getWorkbenchAssignments(): StrategyAssignment[] {
  return assignments
}

export function getAssignmentOf(nodeId: string): StrategyAssignment | null {
  return assignments.find((assignment) => assignment.nodeId === nodeId) ?? null
}

export function getNodeOf(nodeId: string): ObjectNode | null {
  return nodes.find((node) => node.id === nodeId) ?? null
}

export interface WorkbenchLayerRow {
  node: ObjectNode
  depth: number
  assignment: StrategyAssignment | null
}

/** 图层树行集（DFS 先序——根=画布在前）。 */
export function getWorkbenchLayerRows(): WorkbenchLayerRow[] {
  if (nodes.length === 0) return []
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const assignmentById = new Map(assignments.map((assignment) => [assignment.nodeId, assignment] as const))
  const rows: WorkbenchLayerRow[] = []
  const walk = (id: string, depth: number): void => {
    const node = byId.get(id)
    if (node === undefined) return
    rows.push({ node, depth, assignment: assignmentById.get(id) ?? null })
    for (const child of node.children) walk(child, depth + 1)
  }
  const root = nodes.find((node) => node.parent === null)
  if (root !== undefined) walk(root.id, 0)
  else for (const node of nodes) walk(node.id, 0)
  return rows
}

export function getSelectedNodeId(): string | null {
  return selectedNodeId
}

export function selectNode(nodeId: string | null): void {
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
  return baseVisible
}

export function setBaseImageVisible(visible: boolean): void {
  baseVisible = visible
}

export function getBaseImageOpacity(): number {
  return baseOpacity
}

export function setBaseImageOpacity(opacity: number): void {
  baseOpacity = Math.min(1, Math.max(0, opacity))
}

export function getShowBoxes(): boolean {
  return showBoxes
}

export function setShowBoxes(visible: boolean): void {
  showBoxes = visible
}

export function getShowMasks(): boolean {
  return showMasks
}

export function setShowMasks(visible: boolean): void {
  showMasks = visible
}

export function isSplitting(): boolean {
  return splitting
}

export function getSplitError(): string | null {
  return splitError
}

export function isApplying(): boolean {
  return applying
}

export function getApplyError(): string | null {
  return applyError
}

export function getRenameError(): string | null {
  return renameError
}

// ---------------------------------------------------------------- 画布投影（StrategyCanvas 喂数）

/**
 * 画布模型（组件 $derived 内调用即响应式——显隐/蒙版/点阵版本变化自动重渲）。
 * 纯函数投影（strategyDesigner store 同式）：不用模块级 $derived——跨视图卸载/重挂
 * 的无主派生会滞留旧值（gated 装载测试实证），读取时现场计算即正确。
 */
export function getWorkbenchCanvasModel(): StrategyCanvasModel | null {
  if (phase !== 'ready' || detail === null) return null
  const imagePx =
    detail.baseImage !== null
      ? { width: detail.baseImage.widthPx, height: detail.baseImage.heightPx }
      : gemsDoc?.imagePx ?? null
  if (imagePx === null) return null
  const canvasCm = detail.baseImage?.canvasCm ?? gemsDoc?.canvasCm ?? { w: imagePx.width / 2, h: imagePx.height / 2 }
  const derived = derivePixelsPerMm({ canvasCm, imagePx })
  const ppm = derived.ok ? derived.pixelsPerMm : 2
  const colorByNode = new Map(
    assignments.map((assignment) => [assignment.nodeId, assignment.stones[0]?.colorHex ?? '#A3A3A3'] as const),
  )
  const excludedNodes = new Set(
    assignments.filter((assignment) => assignment.strategyKind === 'exclusion').map((assignment) => assignment.nodeId),
  )
  const gems = (gemsDoc?.gems ?? [])
    .filter((gem) => !hiddenNodes.has(gem.blockId))
    .map((gem) => ({
      id: gem.id,
      x: gem.x,
      y: gem.y,
      radiusPx: (gem.diameterMm * ppm) / 2,
      colorHex: colorByNode.get(gem.blockId) ?? '#A3A3A3',
      nodeId: gem.blockId,
    }))
  const boxes = nodes
    .filter((node) => !hiddenNodes.has(node.id))
    .map((node) => ({
      nodeId: node.id,
      objectName: node.objectName,
      bbox: node.bbox,
      excluded: excludedNodes.has(node.id) || !node.drillWorthy,
    }))
  const masks = showMasks
    ? nodes
        .filter((node) => !hiddenNodes.has(node.id))
        .map((node) => maskOverlayOf(node))
        .filter((overlay): overlay is NonNullable<typeof overlay> => overlay !== null)
    : []
  return {
    imagePx,
    gems,
    boxes,
    masks,
    ppm: { ppm, exact: derived.ok },
    sourceUrl: baseImageUrl,
    excludedCount: detail.gems?.excludedRegions ?? gemsDoc?.excludedRegions.length ?? 0,
  }
}

// ---------------------------------------------------------------- 写操作（D-1 直接生效）

/**
 * 人类拆层（2.3）：单步 SAM 细分（真桥 1-2 分钟/mock 桥秒回）。成功=子层入树+
 * 画布刷新+自动选中首个新子层；失败=splitError 驻留（重试=再次调用）。
 */
export async function splitLayer(nodeId: string, hint: string): Promise<boolean> {
  if (taskId === null || splitting) return false
  splitting = true
  splitError = null
  try {
    const output = await api().layerSplit({ taskId, nodeId, hint })
    nodes = [...nodes, ...output.children.map((child) => ({ ...child }))]
    const parent = nodes.find((node) => node.id === nodeId)
    if (parent !== undefined) parent.children = [...parent.children, ...output.children.map((child) => child.id)]
    selectedNodeId = output.children[0]?.id ?? nodeId
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
      }
    }
    if (output.warnings.length > 0) {
      showToast(`拆层完成（有警告）：${output.warnings.map((warning) => warning.reason).join('；')}`)
    }
    return true
  } catch (error) {
    splitError = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    splitting = false
  }
}

/** 图层重命名（2.2——inline 编辑提交；直接生效+版本入史）。 */
export async function renameLayer(nodeId: string, objectName: string): Promise<boolean> {
  if (taskId === null) return false
  renameError = null
  try {
    const output = await api().layerRename({ taskId, nodeId, objectName })
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (node !== undefined) node.objectName = objectName
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
      }
    }
    return true
  } catch (error) {
    renameError = error instanceof Error ? error.message : String(error)
    showToast(`重命名失败：${renameError}`)
    return false
  }
}

/**
 * 策略直改（2.4——D-1 直接生效）：单节点指派替换→服务端 execute 真身重算→
 * 新 gems 工件按 ref 重拉（点阵/预览即刻刷新）。不注入对话——人类主权面直改。
 */
export async function applyLayerStrategy(
  nodeId: string,
  strategyKind: KernelStrategyKind,
  params: Record<string, unknown>,
  densityPerCm2?: number,
): Promise<boolean> {
  if (taskId === null || applying) return false
  applying = true
  applyError = null
  try {
    const output = await api().layerStrategySet({
      taskId,
      nodeId,
      strategyKind,
      params,
      ...(densityPerCm2 !== undefined ? { densityPerCm2 } : {}),
    })
    const artifact = await api().taskArtifact({ taskId, blobRef: output.gems.blobRef })
    gemsDoc = StrategyGemsViewSchema.parse(decodeArtifactJson(artifact.dataBase64))
    const existing = assignments.find((assignment) => assignment.nodeId === nodeId)
    assignments = [
      ...assignments.filter((assignment) => assignment.nodeId !== nodeId),
      {
        nodeId,
        strategyKind,
        params,
        stones: existing?.stones ?? [],
        densityPerCm2: densityPerCm2 ?? existing?.densityPerCm2 ?? 2.3,
        rationale: existing?.rationale ?? '工作台直改（D-1 直接生效）',
      },
    ]
    if (detail !== null) {
      detail = {
        ...detail,
        gems: {
          blobRef: output.gems.blobRef,
          count: output.gems.count,
          excludedRegions: detail.gems?.excludedRegions ?? 0,
        },
        preview: { blobRef: output.preview.blobRef },
      }
    }
    showToast(`策略已直接生效——全图重算 ${output.gems.count} 颗`)
    return true
  } catch (error) {
    applyError = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    applying = false
  }
}

// ---------------------------------------------------------------- 测试复位

export function resetWorkbenchForTests(): void {
  taskId = null
  phase = 'idle'
  loadError = null
  detail = null
  nodes = []
  assignments = []
  gemsDoc = null
  baseImageUrl = null
  selectedNodeId = null
  hiddenNodes = new Set()
  baseVisible = true
  baseOpacity = 0.6
  showBoxes = true
  showMasks = false
  splitting = false
  splitError = null
  applying = false
  applyError = null
  renameError = null
  loadSeq = 0
}
