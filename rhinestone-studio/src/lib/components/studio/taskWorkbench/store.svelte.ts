/*
 * 任务详情·排钻工作台 store（add-task-detail-layer-workbench 2.2-2.5——Svelte 5
 * runes，工作台唯一状态源；add-workbench-pro 2.1-2.3 增量）。
 * 装载：task.detail RPC（数据源各自可空——按在场渲染；波 2a 三新面 viewState/
 * maskEdits/exportGate 在此消费）+ baseImage/gems 两工件字节经 tasks.artifact 附件
 * 通道拉取（dataUrl/JSON doc）。
 * 写操作（人类主权面——D-1 直接生效）：
 *   layer.split（拆层）/layer.rename（inline 重命名提交）/layer.strategy.set
 *   （策略直改）/layer.mask.patch（笔刷遮罩编辑——2.3 最小编辑闭环）。
 * 视图态（2.1 服务端所有权）：显隐/折叠/锁定=task 级服务端工件（view.state.set 全量
 * 快照写透+装载读回——刷新/换端不丢）；本地 Set 仅为即时渲染投影。
 * 导出门（2.1）：exportGate 呈现+task.export 下载（门阻=按钮禁用+blockers 列表）。
 */

import {
  derivePixelsPerMm,
  WORKBENCH_BRUSH_RADIUS_MAX_PX,
  type BrushPoint,
  type BrushStroke,
  type ExportBlocker,
  type ExportGate,
  type KernelStrategyKind,
  type MaskEditStatus,
  type ObjectNode,
  type StrategyAssignment,
  type TaskDetailResponse,
  type TreeVersion,
  type ViewStateNode,
} from '@handicraft/contracts'
import { getBoundAgentApi } from '$lib/agentApi/store.svelte'
import { StrategyGemsViewSchema, type StrategyGemsView } from '$lib/strategyDesigner/artifacts.js'
import { showToast } from '$lib/stores/toast.svelte'
import type { StrategyCanvasModel } from '$lib/components/strategy/canvasModel.js'
import { maskOverlayOf } from './maskViz.js'
import { getMaskEntryOf, requestNodeMasks, resetMaskEntriesForTask } from './maskBits.svelte.js'
import { isInSubtreeOf, siblingMovePayload, subtreeIdsOf } from './layerTree.js'
import {
  noteCommittedMaskVersion,
  noteUndoAction,
  popParamUndo,
  popViewUndo,
  pushParamUndo,
  pushViewUndoSnapshot,
  reseedStructureVersions,
  resetUndoDomainsForTests,
  resolveUndoDomain,
  structureUndoTarget,
  structureVersionsOf,
  UNDO_DOMAIN_LABELS,
} from './undoDomains.svelte.js'

/** 装载四态（idle=尚未发起装载——视图按 loading 呈现）。 */
export type WorkbenchPhase = 'idle' | 'loading' | 'error' | 'ready'

let taskId = $state<string | null>(null)
let phase = $state<WorkbenchPhase>('idle')
let loadError = $state<string | null>(null)
let detail = $state<TaskDetailResponse | null>(null)
/** 可演进树（split/rename/mask.patch 就地改；task.detail 重装载覆盖）。 */
let nodes = $state<ObjectNode[]>([])
let assignments = $state<StrategyAssignment[]>([])
let gemsDoc = $state<StrategyGemsView | null>(null)
let baseImageUrl = $state<string | null>(null)

let selectedNodeId = $state<string | null>(null)
/** 视图态三面（服务端 view.state.set 写透；本地 Set=即时渲染投影）。 */
let hiddenNodes = $state<ReadonlySet<string>>(new Set())
let collapsedNodes = $state<ReadonlySet<string>>(new Set())
let lockedNodes = $state<ReadonlySet<string>>(new Set())
/** 视图态 CAS 基线（null=尚无工件——首写缺省 expectedRevision）。 */
let viewRevision = $state<number | null>(null)
let viewSyncing = $state(false)
/** mask 编辑留痕面（task.detail.maskEdits 读回+patch 响应 upsert——告警徽标源）。 */
let maskEdits = $state<MaskEditStatus[]>([])
let baseVisible = $state(true)
let baseOpacity = $state(0.6)
let showBoxes = $state(true)
let showMasks = $state(false)

let splitting = $state(false)
let splitError = $state<string | null>(null)
let applying = $state(false)
let applyError = $state<string | null>(null)
let renameError = $state<string | null>(null)

let exporting = $state(false)
let exportError = $state<string | null>(null)

// ---------------------------------------------------------------- 2c 增量：命令面板/确认面/历史面（UI 态）

/** ? 帮助面板开合（命令总线驱动——命令清单单源）。 */
let helpOpen = $state(false)
/** 删除确认面（破坏性操作=确认——全局纪律；count=子树节点数）。 */
let pendingDelete = $state<{ nodeId: string; count: number } | null>(null)
/** tree.revert 确认面（D-3 透明化：结构域回退=整树快照——一并回退的中间操作如实列出）。 */
let pendingTreeRevert = $state<{ targetVersion: number; entries: TreeVersion[] } | null>(null)
/** 图层面板·事务历史区（tree.history——按需拉取）。 */
let treeHistory = $state<{ open: boolean; loading: boolean; versions: TreeVersion[]; error: string | null }>({
  open: false,
  loading: false,
  versions: [],
  error: null,
})
/** F2 重命名触发（命令总线→面板 inline 编辑——计数值变化驱动 $effect）。 */
let renameRequestId = $state(0)
/** 结构域版本链游标已种（懒播种：首次结构 undo/历史面拉取时自 tree.history 重种）。 */
let structureSeeded = false
/** 笔刷域 redo 栈（撤销的笔画——新落笔即清空，标准 undo 栈语义）。 */
let strokeRedo: BrushStroke[] = []

// ---------------------------------------------------------------- 笔刷（2.3 最小编辑闭环）

export type BrushOp = 'add' | 'remove'

/** 笔刷会话态（进入=选中层+笔刷按钮/B 键；提交前本地笔画栈——undo 域 2c）。 */
export interface BrushSession {
  active: boolean
  op: BrushOp
  radiusPx: number
  /** 已收笔的本地笔画（未提交——撤销最近一笔即 pop）。 */
  strokes: BrushStroke[]
  /** 在途笔画（pointerdown→pointerup 间收集）。 */
  previewPoints: BrushPoint[]
  painting: boolean
}

let brush = $state<BrushSession>({
  active: false,
  op: 'add',
  radiusPx: 12,
  strokes: [],
  previewPoints: [],
  painting: false,
})
let brushSubmitting = $state(false)
let brushError = $state<string | null>(null)

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

/** 视图态装载投影（服务端工件 → 本地三面 Set+CAS 基线）。 */
function applyViewState(state: TaskDetailResponse['viewState']): void {
  const hidden = new Set<string>()
  const collapsed = new Set<string>()
  const locked = new Set<string>()
  if (state !== null) {
    for (const node of state.nodes) {
      if (node.visible === false) hidden.add(node.nodeId)
      if (node.collapsed === true) collapsed.add(node.nodeId)
      if (node.locked === true) locked.add(node.nodeId)
    }
    viewRevision = state.revision
  } else {
    viewRevision = null
  }
  hiddenNodes = hidden
  collapsedNodes = collapsed
  lockedNodes = locked
}

/** 导出门本地重算（maskEdits 纯函数——与 daemon exportGateOf 同式：patch 后即时刷新）。 */
function recomputeExportGate(): ExportGate {
  const blockers = new Set<ExportBlocker>()
  for (const edit of maskEdits) {
    if (edit.incomplete) blockers.add('mask-incomplete')
    if (edit.state === 'stale') blockers.add('mask-stale')
    if (edit.state === 'error') blockers.add('mask-recompute-error')
  }
  const sorted = [...blockers].sort()
  return { allowed: sorted.length === 0, blockers: sorted }
}

/**
 * 装载/重试（taskId 变化或重试按钮——loadSeq 作废迟到结果）。refresh=true 保留
 * 选中/笔刷会话（笔刷提交后的定向刷新——画布/图层行/gems/三新面一次读齐）。
 */
export async function loadWorkbench(nextTaskId: string, options: { refresh?: boolean } = {}): Promise<void> {
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
      // 定向刷新时同 ref 不重拉（baseImage 稳定——省一次附件通道往返）
      const refUnchanged = options.refresh === true && detail?.baseImage?.blobRef === response.baseImage.blobRef
      nextBaseImageUrl = refUnchanged ? baseImageUrl : await (async () => {
        const artifact = await client.taskArtifact({ taskId: nextTaskId, blobRef: response.baseImage!.blobRef })
        return `data:${artifact.mime};base64,${artifact.dataBase64}`
      })()
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
    applyViewState(response.viewState)
    maskEdits = response.maskEdits.map((edit) => ({ ...edit }))
    if (options.refresh !== true) {
      selectedNodeId = null
      resetMaskEntriesForTask()
      exitBrushMode()
      // 域游标随任务重置（快照栈属会话内操作史——换任务不跨任务回退）；结构链懒重种。
      resetUndoDomainsInStore()
      treeHistory = { open: false, loading: false, versions: [], error: null }
    }
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

/** 图层树行集（DFS 先序——根=画布在前；折叠节点子树跳过）。 */
export function getWorkbenchLayerRows(): WorkbenchLayerRow[] {
  if (nodes.length === 0) return []
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const assignmentById = new Map(assignments.map((assignment) => [assignment.nodeId, assignment] as const))
  const rows: WorkbenchLayerRow[] = []
  const walk = (id: string, depth: number): void => {
    const node = byId.get(id)
    if (node === undefined) return
    rows.push({ node, depth, assignment: assignmentById.get(id) ?? null })
    if (collapsedNodes.has(id)) return
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
  // 选中层切换=笔刷目标切换：未提交笔画不跨层携带（笔画坐标属旧层 bbox）
  if (brush.active) resetBrushStrokes()
}

// ---------------------------------------------------------------- 视图态（服务端所有权——写透+装载读回）

export function isNodeVisible(nodeId: string): boolean {
  return !hiddenNodes.has(nodeId)
}

export function isNodeCollapsed(nodeId: string): boolean {
  return collapsedNodes.has(nodeId)
}

export function isNodeLocked(nodeId: string): boolean {
  return lockedNodes.has(nodeId)
}

export function isViewSyncing(): boolean {
  return viewSyncing
}

/** 视图态快照序列化（仅非默认覆盖——默认=可见/未折叠/未锁定不入工件）。 */
function viewStateSnapshot(): ViewStateNode[] {
  const snapshot: ViewStateNode[] = []
  const ids = new Set([...hiddenNodes, ...collapsedNodes, ...lockedNodes])
  for (const id of ids) {
    snapshot.push({
      nodeId: id,
      ...(hiddenNodes.has(id) ? { visible: false } : {}),
      ...(collapsedNodes.has(id) ? { collapsed: true } : {}),
      ...(lockedNodes.has(id) ? { locked: true } : {}),
    })
  }
  return snapshot
}

/** 快照 → 本地三面 Set（tree-view 域 undo 回放时重建投影）。 */
function setsFromSnapshot(snapshot: ViewStateNode[]): {
  hidden: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  locked: ReadonlySet<string>
} {
  const hidden = new Set<string>()
  const collapsed = new Set<string>()
  const locked = new Set<string>()
  for (const node of snapshot) {
    if (node.visible === false) hidden.add(node.nodeId)
    if (node.collapsed === true) collapsed.add(node.nodeId)
    if (node.locked === true) locked.add(node.nodeId)
  }
  return { hidden, collapsed, locked }
}

/**
 * 视图态写透（view.state.set 全量快照+CAS；失败回滚本地并提示——不静默丢弃）。
 * nodesOverride=指定快照写回（tree-view 域 undo 回放）；缺省=当前三面投影。
 */
async function syncViewState(
  previous: { hidden: ReadonlySet<string>; collapsed: ReadonlySet<string>; locked: ReadonlySet<string> },
  nodesOverride?: ViewStateNode[],
): Promise<void> {
  if (taskId === null || phase !== 'ready') return
  viewSyncing = true
  try {
    const output = await api().viewStateSet({
      taskId,
      nodes: nodesOverride ?? viewStateSnapshot(),
      ...(viewRevision !== null ? { expectedRevision: viewRevision } : {}),
    })
    viewRevision = output.revision
  } catch (error) {
    // 写失败：回滚本地投影（服务端真源未变——下次操作重新走透）
    hiddenNodes = previous.hidden
    collapsedNodes = previous.collapsed
    lockedNodes = previous.locked
    const message = error instanceof Error ? error.message : String(error)
    showToast(`视图态保存失败：${message}`)
    // CAS 漂移（他写）→ 重装载读回最新视图态
    if (message.includes('cas-mismatch') && taskId !== null) await loadWorkbench(taskId)
  } finally {
    viewSyncing = false
  }
}

/** tree-view 域操作三连：前值入 undo 栈 → 本地投影变更 → 服务端写透。 */
function performViewToggle(apply: () => void): void {
  const previous = { hidden: hiddenNodes, collapsed: collapsedNodes, locked: lockedNodes }
  pushViewUndoSnapshot(viewStateSnapshot())
  apply()
  noteUndoAction('tree-view')
  void syncViewState(previous)
}

export function toggleNodeVisible(nodeId: string): void {
  performViewToggle(() => {
    const next = new Set(hiddenNodes)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    hiddenNodes = next
  })
}

export function toggleNodeCollapsed(nodeId: string): void {
  performViewToggle(() => {
    const next = new Set(collapsedNodes)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    collapsedNodes = next
  })
}

export function toggleNodeLocked(nodeId: string): void {
  performViewToggle(() => {
    const next = new Set(lockedNodes)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    lockedNodes = next
  })
}

// ---------------------------------------------------------------- mask 编辑留痕+导出门（2.1）

export function getMaskEditOf(nodeId: string): MaskEditStatus | null {
  return maskEdits.find((edit) => edit.nodeId === nodeId) ?? null
}

export function getExportGate(): ExportGate {
  return detail?.exportGate ?? { allowed: true, blockers: [] }
}

export function isExporting(): boolean {
  return exporting
}

export function getExportError(): string | null {
  return exportError
}

/**
 * 任务导出（task.export——服务端以 mask_edit_states 重算门：门阻 typed 拒）。
 * 放行→strategy-gems.json 工件字节经 Blob+anchor 下载。
 */
export async function exportTask(): Promise<boolean> {
  if (taskId === null || exporting) return false
  if (getExportGate().allowed === false) {
    exportError = `导出被门阻（${getExportGate().blockers.join('、')}）——先处理遮罩编辑告警`
    return false
  }
  exporting = true
  exportError = null
  try {
    const output = await api().taskExport({ taskId })
    // 浏览器下载通道（尽力而为——jsdom 的 createObjectURL 为残桩/无下载语义，
    // 下载面失败不视为导出失败：产物字节已在手，真实浏览器按 anchor 落盘）
    if (typeof URL.createObjectURL === 'function') {
      try {
        const binary = atob(output.dataBase64)
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = output.filename
        anchor.click()
        URL.revokeObjectURL(url)
      } catch {
        // 下载通道缺席（非浏览器环境）——跳过落盘
      }
    }
    showToast(`已导出 ${output.gemCount} 颗——${output.filename}`)
    return true
  } catch (error) {
    exportError = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    exporting = false
  }
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

// ---------------------------------------------------------------- mask 位面请求（组件 $effect 驱动）

/** 供 TaskWorkbenchView 的 $effect 消费（nodes/tree 变化→渐进请求位面）。 */
export function requestNodeMasksForTree(): void {
  if (taskId === null) return
  requestNodeMasks(nodes, {
    treeBlobRef: detail?.tree?.blobRef ?? null,
    fetchMaskBlob: async (blobRef) => {
      const artifact = await api().taskArtifact({ taskId: taskId!, blobRef })
      const binary = atob(artifact.dataBase64)
      return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    },
  })
}

export { getMaskEntryOf } from './maskBits.svelte.js'

// ---------------------------------------------------------------- 画布投影（StrategyCanvas 喂数）

/**
 * 画布模型（组件 $derived 内调用即响应式——显隐/蒙版/点阵版本变化自动重渲）。
 * 纯函数投影（strategyDesigner store 同式）：不用模块级 $derived——跨视图卸载/重挂
 * 的无主派生会滞留旧值（gated 装载测试实证），读取时现场计算即正确。
 * mask 叠加=位面缓存投影（inline|blob 两态统一——blob 渐进就绪不阻塞其余层；
 * 选中层=高亮填充语义由 overlay.selected 携带）。
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
        .map((node) => {
          const entry = getMaskEntryOf(node.id)
          if (entry.phase !== 'ready' || entry.bits === null) return null
          try {
            return maskOverlayOf(node, entry.bits, node.id === selectedNodeId)
          } catch {
            // 单层坏 mask 降级：该层叠加跳过（错误徽标在图层行）——不炸整画布
            return null
          }
        })
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
    } else if (output.children.length === 0) {
      // 零检出也 toast（真环境走查实证：静默成功=用户「点了没反应」——体验断路）
      showToast('零检出：该提示在选中层内没有可拆出的区域——换个更具体的提示词试试')
    }
    noteStructureWrite()
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
    noteStructureWrite()
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
  options: { undoSilent?: boolean } = {},
): Promise<boolean> {
  if (taskId === null || applying) return false
  applying = true
  applyError = null
  // strategy-param 域 undo：前值入栈（undo 回放本身不入栈——undoSilent）
  if (options.undoSilent !== true) {
    const existing = assignments.find((assignment) => assignment.nodeId === nodeId)
    pushParamUndo({
      nodeId,
      strategyKind: existing?.strategyKind ?? null,
      // JSON 深拷贝脱离 $state proxy（回放载荷可被服务端 structuredClone——proxy 不可克隆）
      params: JSON.parse(JSON.stringify(existing?.params ?? {})) as Record<string, unknown>,
      densityPerCm2: existing?.densityPerCm2 ?? 2.3,
    })
  }
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
    noteUndoAction('strategy-param')
    return true
  } catch (error) {
    applyError = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    applying = false
  }
}

// ---------------------------------------------------------------- 笔刷（2.3 最小编辑闭环）

export function getBrushSession(): BrushSession {
  return brush
}

export function isBrushSubmitting(): boolean {
  return brushSubmitting
}

export function getBrushError(): string | null {
  return brushError
}

/** 进入笔刷模式（需选中层；锁定层拒——服务端同拒，前端就近提示）。 */
export function enterBrushMode(): boolean {
  if (selectedNodeId === null || phase !== 'ready') {
    showToast('先在图层树选择一个图层再进入笔刷编辑')
    return false
  }
  if (lockedNodes.has(selectedNodeId)) {
    showToast('该图层已锁定（锁定=遮罩面冻结）——先解锁再编辑')
    return false
  }
  brushError = null
  brush = { ...brush, active: true, strokes: [], previewPoints: [], painting: false }
  return true
}

export function exitBrushMode(): void {
  brush = { ...brush, active: false, strokes: [], previewPoints: [], painting: false }
  brushError = null
}

export function setBrushOp(op: BrushOp): void {
  brush = { ...brush, op }
}

/** 半径直设（数值框输入——契约上界 128px 夹取）。 */
export function setBrushRadius(radiusPx: number): void {
  const next = Math.min(WORKBENCH_BRUSH_RADIUS_MAX_PX, Math.max(1, Math.round(radiusPx * 10) / 10))
  brush = { ...brush, radiusPx: next }
}

/** 半径可调（[/] 键步进 2px；契约上界 128px 夹取）。 */
export function adjustBrushRadius(deltaPx: number): void {
  const next = Math.min(WORKBENCH_BRUSH_RADIUS_MAX_PX, Math.max(1, Math.round((brush.radiusPx + deltaPx) * 10) / 10))
  brush = { ...brush, radiusPx: next }
}

function resetBrushStrokes(): void {
  brush = { ...brush, strokes: [], previewPoints: [], painting: false }
}

/** 落笔（画布 px 坐标——与 daemon BrushPoint 同一坐标系）；新笔画清空 redo 分支。 */
export function beginStroke(point: BrushPoint): void {
  if (!brush.active) return
  strokeRedo = []
  brush = { ...brush, painting: true, previewPoints: [point] }
}

/** 拖笔（≥1px 距离采样——契约 512 点上界由提交面截断）。 */
export function extendStroke(point: BrushPoint): void {
  if (!brush.active || !brush.painting) return
  const last = brush.previewPoints[brush.previewPoints.length - 1]
  if (last !== undefined && Math.abs(point.x - last.x) < 1 && Math.abs(point.y - last.y) < 1) return
  if (brush.previewPoints.length >= 512) return
  brush = { ...brush, previewPoints: [...brush.previewPoints, point] }
}

/** 收笔（在途笔画入本地栈——提交前可撤销）。 */
export function endStroke(): void {
  if (!brush.active || !brush.painting) return
  const stroke: BrushStroke = { op: brush.op, radiusPx: brush.radiusPx, points: brush.previewPoints }
  if (stroke.points.length > 0 && brush.strokes.length < 16) {
    brush = { ...brush, strokes: [...brush.strokes, stroke], previewPoints: [], painting: false }
  } else {
    brush = { ...brush, previewPoints: [], painting: false }
  }
}

/** 撤销最近一笔（本地笔画栈→redo 栈；提交后栈空——完整 undo 域路由见 undoCurrentDomain）。 */
export function undoLastStroke(): boolean {
  if (brush.strokes.length === 0) return false
  const popped = brush.strokes[brush.strokes.length - 1]!
  strokeRedo = [...strokeRedo, popped]
  brush = { ...brush, strokes: brush.strokes.slice(0, -1) }
  return true
}

/**
 * 提交笔刷（layer.mask.patch——ops=本地笔画序列；CAS 基线=本地树工件引用）：
 * 服务端 mask 重写+bbox/effectiveMm 重算+版本入史+可选 recomputeStrategy 重算
 * →定向刷新（loadWorkbench refresh=true：树/位面缓存键换新/gems/maskEdits/
 * exportGate 一次读齐——选中与会话保留）。
 */
export async function commitBrushStrokes(recomputeStrategy: boolean): Promise<boolean> {
  if (taskId === null || selectedNodeId === null || brushSubmitting) return false
  if (brush.strokes.length === 0) return false
  const currentTreeRef = detail?.tree?.blobRef ?? null
  if (currentTreeRef === null) {
    brushError = '尚无图层树——笔刷编辑需要 object-tree 工件'
    return false
  }
  brushSubmitting = true
  brushError = null
  const ops = brush.strokes.map((stroke) => ({ op: stroke.op, radiusPx: stroke.radiusPx, points: stroke.points }))
  try {
    const output = await api().layerMaskPatch({
      taskId,
      nodeId: selectedNodeId,
      ops,
      expectedTreeBlobRef: currentTreeRef,
      recomputeStrategy,
    })
    // maskEdits 即时 upsert（badge 即刻反映 ready/incomplete——完整三新面随定向刷新读齐）
    maskEdits = [
      ...maskEdits.filter((edit) => edit.nodeId !== selectedNodeId),
      {
        nodeId: selectedNodeId,
        state: output.editState,
        runCount: output.maskRunCount,
        incomplete: output.incomplete,
        baseVersion: output.version,
        error: null,
        updatedAt: new Date().toISOString(),
      },
    ]
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
        exportGate: recomputeExportGate(),
      }
    }
    resetBrushStrokes()
    await loadWorkbench(taskId, { refresh: true })
    noteCommittedMaskVersion(output.version)
    noteUndoAction('mask-edit')
    showToast(
      `遮罩已更新（${output.editState === 'ready' ? '重算完成' : `状态 ${output.editState}`}${output.incomplete ? '·行程超限已告警' : ''}）` +
        (output.gems !== null ? `——重算 ${output.gems.count} 颗` : ''),
    )
    return true
  } catch (error) {
    brushError = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    brushSubmitting = false
  }
}

// ---------------------------------------------------------------- 2c：图层结构写（重排/删除——layer.reorder/layer.delete 消费）

/** 结构域写发生（版本链待重种+域路由推动；历史面开着则同步刷新）。 */
function noteStructureWrite(): void {
  noteUndoAction('tree-structure')
  structureSeeded = false
  if (treeHistory.open) void fetchTreeHistory()
}

function resetUndoDomainsInStore(): void {
  resetUndoDomainsForTests()
  structureSeeded = false
  strokeRedo = []
}

/**
 * 图层重排（layer.reorder 消费）：根保护/环路/锁定 UI 预判先行（服务端同拒兜底）
 * → CAS 基线=本地树工件引用 → 定向刷新（选中/笔刷保留）。payload 语义见 layerTree.ts。
 */
export async function reorderLayerNode(
  nodeId: string,
  payload: { newParentId: string; index: number },
): Promise<boolean> {
  if (taskId === null || phase !== 'ready') return false
  const node = getNodeOf(nodeId)
  if (node === null) return false
  if (node.parent === null) {
    showToast('root-protected：根/画布节点不可重排（单根树结构锚）')
    return false
  }
  if (isInSubtreeOf(nodes, payload.newParentId, nodeId)) {
    showToast('cycle 预判：新父在目标子树内（树成环必拒）——换个落点')
    return false
  }
  if (lockedNodes.has(nodeId)) {
    showToast(`node-locked 预判：「${node.objectName}」已锁定（结构+遮罩面冻结）——先解锁再移动`)
    return false
  }
  const baseline = detail?.tree?.blobRef ?? null
  if (baseline === null) {
    showToast('尚无图层树工件——不能重排')
    return false
  }
  try {
    const output = await api().layerReorder({
      taskId,
      nodeId,
      newParentId: payload.newParentId,
      index: payload.index,
      expectedTreeBlobRef: baseline,
    })
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
      }
    }
    await loadWorkbench(taskId, { refresh: true })
    noteStructureWrite()
    return true
  } catch (error) {
    showToast(`重排失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** 同父序移（Alt+↑↓ 键盘等价——a11y）：已在顶/底端返回 false（键位层放行）。 */
export function moveSelectedLayer(direction: -1 | 1): boolean {
  if (phase !== 'ready' || selectedNodeId === null) return false
  const payload = siblingMovePayload(nodes, selectedNodeId, direction)
  if (payload === null) return false
  void reorderLayerNode(selectedNodeId, payload)
  return true
}

/**
 * 删除请求（行内按钮/Delete 键）：根保护+子树锁定 UI 预判 → 确认面（破坏性=确认
 * ——全局纪律；count=子树节点数）。确认后走 layer.delete RPC。
 */
export function requestDeleteLayer(nodeId: string): boolean {
  if (phase !== 'ready') return false
  const node = getNodeOf(nodeId)
  if (node === null) return false
  if (node.parent === null) {
    showToast('root-protected：根/画布节点不可删（单根树结构锚）')
    return true
  }
  const subtreeIds = subtreeIdsOf(nodes, nodeId)
  const lockedHit = subtreeIds.find((id) => lockedNodes.has(id))
  if (lockedHit !== undefined) {
    const lockedNode = getNodeOf(lockedHit)
    showToast(`node-locked 预判：子树内含锁定层「${lockedNode?.objectName ?? lockedHit}」——先解锁再删`)
    return true
  }
  pendingDelete = { nodeId, count: subtreeIds.length }
  return true
}

export function cancelPendingDelete(): void {
  pendingDelete = null
}

/**
 * 删除确认执行（layer.delete）：子树全集出树+指派收敛+gems 重算 → 定向刷新。
 * 失败确认面驻留（重试=再次确认；取消=cancelPendingDelete）。
 */
export async function confirmDeleteLayer(): Promise<boolean> {
  const target = pendingDelete
  if (target === null || taskId === null) return false
  const baseline = detail?.tree?.blobRef ?? null
  if (baseline === null) {
    showToast('尚无图层树工件——不能删除')
    return false
  }
  const name = getNodeOf(target.nodeId)?.objectName ?? target.nodeId
  try {
    const output = await api().layerDelete({ taskId, nodeId: target.nodeId, expectedTreeBlobRef: baseline })
    pendingDelete = null
    if (selectedNodeId !== null && output.removedNodeIds.includes(selectedNodeId)) {
      selectedNodeId = null
      exitBrushMode()
    }
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
      }
    }
    await loadWorkbench(taskId, { refresh: true })
    noteStructureWrite()
    showToast(
      `已删除「${name}」子树（${output.removedNodeIds.length} 节点${output.gems !== null ? `·重算 ${output.gems.count} 颗` : '·无剩余指派产物'}）`,
    )
    return true
  } catch (error) {
    showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export function getPendingDelete(): { nodeId: string; count: number } | null {
  return pendingDelete
}

// ---------------------------------------------------------------- 2c：层命中测试（mask 位面命中——鼠标 P0）

/**
 * 画布 px 坐标 → 命中层 id（逆 DFS：最深层/后序兄弟优先——最具体者胜）。
 * mask 就绪层=位面精确命中（非仅 bbox）；mask 未就绪/坏态层=bbox 兜底（渐进可用）。
 * 隐藏层不可命中（与画布投影过滤同式）。
 */
export function hitTestNodeAt(x: number, y: number): string | null {
  if (nodes.length === 0) return null
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const order: string[] = []
  const walk = (id: string): void => {
    const node = byId.get(id)
    if (node === undefined) return
    order.push(id)
    for (const child of node.children) walk(child)
  }
  const root = nodes.find((node) => node.parent === null)
  if (root !== undefined) walk(root.id)
  else for (const node of nodes) walk(node.id)
  for (let i = order.length - 1; i >= 0; i--) {
    const node = byId.get(order[i]!)
    if (node === undefined || hiddenNodes.has(node.id)) continue
    const { bbox } = node
    if (x < bbox.x || y < bbox.y || x >= bbox.x + bbox.w || y >= bbox.y + bbox.h) continue
    const entry = getMaskEntryOf(node.id)
    if (entry.phase === 'ready' && entry.bits !== null) {
      const bits = entry.bits
      const lx = Math.min(bits.w - 1, Math.max(0, Math.floor(((x - bbox.x) / bbox.w) * bits.w)))
      const ly = Math.min(bits.h - 1, Math.max(0, Math.floor(((y - bbox.y) / bbox.h) * bits.h)))
      if (bits.bits[ly * bits.w + lx] === 1) return node.id
      continue // 位面未命中——继续试探外层（mask 位面命中而非仅 bbox）
    }
    return node.id // 位面未就绪/坏态——bbox 兜底
  }
  return null
}

// ---------------------------------------------------------------- 2c：tree.history 事务历史面 + tree.revert（W10 复核补齐的前端 API）

export function getTreeHistoryState(): { open: boolean; loading: boolean; versions: TreeVersion[]; error: string | null } {
  return treeHistory
}

/** 历史面开合（开=拉取最新链并重种结构域游标）。 */
export function toggleTreeHistoryPanel(): void {
  if (treeHistory.open) {
    treeHistory = { ...treeHistory, open: false }
    return
  }
  treeHistory = { ...treeHistory, open: true }
  void fetchTreeHistory()
}

export async function fetchTreeHistory(): Promise<void> {
  if (taskId === null || treeHistory.loading) return
  treeHistory = { ...treeHistory, loading: true, error: null }
  try {
    const output = await api().treeHistory({ taskId })
    treeHistory = { open: treeHistory.open, loading: false, versions: output.versions, error: null }
    reseedStructureVersions(structureVersionsOf(output.versions))
    structureSeeded = true
  } catch (error) {
    treeHistory = { ...treeHistory, loading: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function getPendingTreeRevert(): { targetVersion: number; entries: TreeVersion[] } | null {
  return pendingTreeRevert
}

/**
 * 发起整树回退确认（tree.revert——D-3 透明化：结构域回退=整树快照，target 之后
 * 的全部中间操作（含遮罩/重排交错）一并回退——确认面如实列出）。
 */
export async function requestTreeRevert(targetVersion: number): Promise<void> {
  if (taskId === null) return
  if (!structureSeeded) await fetchTreeHistory()
  pendingTreeRevert = {
    targetVersion,
    entries: treeHistory.versions.filter((version) => version.version > targetVersion),
  }
}

export function cancelPendingTreeRevert(): void {
  pendingTreeRevert = null
}

/** 确认执行整树回退（tree.revert——revert 自身入史，历史只增不删）。 */
export async function confirmTreeRevert(): Promise<boolean> {
  const target = pendingTreeRevert
  if (target === null || taskId === null) return false
  try {
    const output = await api().treeRevert({ taskId, version: target.targetVersion })
    pendingTreeRevert = null
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
      }
    }
    await loadWorkbench(taskId, { refresh: true })
    noteStructureWrite()
    showToast(`已回退到 v${target.targetVersion} 时刻的树（revert 以 v${output.version} 入史——历史只增不删）`)
    return true
  } catch (error) {
    showToast(`回退失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// ---------------------------------------------------------------- 2c：undo/redo 域路由（D-3——命令总线消费）

export async function undoCurrentDomain(): Promise<boolean> {
  if (phase !== 'ready' || taskId === null) return false
  const domain = resolveUndoDomain(brush.active)
  switch (domain) {
    case 'mask-edit': {
      if (brush.strokes.length === 0) {
        showToast('遮罩域已无可回退（本地笔画为空；已提交遮罩的精确逆=前驱快照节点面替换，2d 契约扩展——可经「图层历史」整树回退）')
        return true
      }
      undoLastStroke()
      return true
    }
    case 'tree-view': {
      const previous = popViewUndo()
      if (previous === null) {
        showToast('视图态域已无可回退')
        return true
      }
      const currentSets = { hidden: hiddenNodes, collapsed: collapsedNodes, locked: lockedNodes }
      const sets = setsFromSnapshot(previous)
      hiddenNodes = sets.hidden
      collapsedNodes = sets.collapsed
      lockedNodes = sets.locked
      noteUndoAction('tree-view')
      await syncViewState(currentSets, previous)
      showToast('视图态已回退到上一步')
      return true
    }
    case 'strategy-param': {
      const previous = popParamUndo()
      if (previous === null) {
        showToast('策略参数域已无可回退')
        return true
      }
      if (previous.strategyKind === null) {
        showToast('该层此前未指派——首指派没有「取消指派」写面（策略域回退到前值需要既有指派）')
        return true
      }
      await applyLayerStrategy(previous.nodeId, previous.strategyKind, previous.params, previous.densityPerCm2, {
        undoSilent: true,
      })
      showToast(`策略参数已回退（${previous.strategyKind} 前值重放）`)
      return true
    }
    case 'tree-structure': {
      if (!structureSeeded) await fetchTreeHistory()
      const target = structureUndoTarget()
      if (target === null) {
        showToast('图层结构域已无可回退（版本链已到最早结构版本）')
        return true
      }
      await requestTreeRevert(target)
      return true
    }
  }
}

export async function redoCurrentDomain(): Promise<boolean> {
  if (phase !== 'ready' || taskId === null) return false
  const domain = resolveUndoDomain(brush.active)
  if (domain === 'mask-edit') {
    if (redoLastStroke()) return true
    showToast('遮罩域已无可重做')
    return true
  }
  showToast('该域重做将在 2d 交付（本波遮罩域先行——D-3 实现波次）')
  return true
}

/** 状态栏/帮助面读数：当前 undo 目标域（路由判定同 Ctrl+Z——所见即所撤）。 */
export function getCurrentUndoDomainLabel(): string {
  return UNDO_DOMAIN_LABELS[resolveUndoDomain(brush.active)]
}

/** 笔刷域 redo（撤销的笔画重入栈——Shift+⌘Z 遮罩域先行）。 */
export function redoLastStroke(): boolean {
  const stroke = strokeRedo[strokeRedo.length - 1]
  if (stroke === undefined) return false
  strokeRedo = strokeRedo.slice(0, -1)
  brush = { ...brush, strokes: [...brush.strokes, stroke] }
  return true
}

// ---------------------------------------------------------------- 2c：F2 重命名触发 + ? 帮助面

/** F2（命令总线）→ 图层面板 inline 编辑（计数值变化驱动 $effect）。 */
export function requestRenameSelected(): boolean {
  if (phase !== 'ready' || selectedNodeId === null) return false
  renameRequestId += 1
  return true
}

export function getRenameRequestId(): number {
  return renameRequestId
}

export function isHelpOpen(): boolean {
  return helpOpen
}

export function setHelpOpen(open: boolean): void {
  helpOpen = open
}

export function toggleHelpOpen(): void {
  helpOpen = !helpOpen
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
  collapsedNodes = new Set()
  lockedNodes = new Set()
  viewRevision = null
  viewSyncing = false
  maskEdits = []
  baseVisible = true
  baseOpacity = 0.6
  showBoxes = true
  showMasks = false
  splitting = false
  splitError = null
  applying = false
  applyError = null
  renameError = null
  exporting = false
  exportError = null
  brush = { active: false, op: 'add', radiusPx: 12, strokes: [], previewPoints: [], painting: false }
  brushSubmitting = false
  brushError = null
  loadSeq = 0
  helpOpen = false
  pendingDelete = null
  pendingTreeRevert = null
  treeHistory = { open: false, loading: false, versions: [], error: null }
  renameRequestId = 0
  resetUndoDomainsInStore()
}
