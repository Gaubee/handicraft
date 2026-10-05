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
  nodeProducesBlock,
  WORKBENCH_BRUSH_RADIUS_MAX_PX,
  type BrushPoint,
  type BrushStroke,
  type ExportBlocker,
  type ExportGate,
  type KernelStrategyKind,
  type MaskEditStatus,
  type NodeBBox,
  type ObjectNode,
  type SegmentOneOutput,
  type SegmentPrecision,
  type StoneCandidateRow,
  type StrategyAssignment,
  type TaskDetailResponse,
  type TreeVersion,
  type ViewStateNode,
  type WorkbenchPreviewMode,
} from '@handicraft/contracts'
import { getBoundAgentApi } from '$lib/agentApi/store.svelte'
import { PIXELS_PER_MM } from '$lib/engine'
import { StrategyGemsViewSchema, type StrategyGemsView } from '$lib/strategyDesigner/artifacts.js'
import { showToast } from '$lib/stores/toast.svelte'
import { maskRunsOf } from './maskViz.js'
import { getMaskEntriesIdentity, getMaskEntryOf, requestNodeMasks, resetMaskEntriesForTask } from './maskBits.svelte.js'
import { getCutoutEntriesIdentity, requestCutouts, resetCutoutsForTask } from './cutout.svelte.js'
import {
  countVisibleGems,
  GEM_GROUP_PALETTE,
  type LayerRenderModel,
  type LayerRenderRow,
} from './layerRender.svelte.js'
import { isInSubtreeOf, hiddenDeepIdsOf, siblingMovePayload, subtreeIdsOf } from './layerTree.js'
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
/**
 * gems 工件文档（2d 性能门·终评 P1-2 修复）：$state.raw 不可变快照语义——仅整体
 * 替换（parse 新工件/刷新复用），深层 $state 代理对 100k 颗文档的逐元素代理在
 * 每次热装载写回时 ~100ms/次（身份未变也走代理包覆）——raw 后写回 ~0ms。
 */
let gemsDoc = $state.raw<StrategyGemsView | null>(null)
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
/**
 * 蒙版行程叠加（presentation U2/Codex E1：**退役为 dev-only**——产品 UI 的「蒙版」
 * checkbox 已被 trim/ps 缩略双模式 segmented 替换；本面保留为测试注入/诊断入口，
 * 渲染链（WorkbenchLayerStage/WorkbenchLayerItem 叠加）不动）。
 */
let showMasks = $state(false)
/** 预览三模式（v3——服务端化入 view-state 工件；缺省 rendered。写透同视图态队列）。 */
let previewMode = $state<WorkbenchPreviewMode>('rendered')

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
/**
 * CAS 失败读回的服务端电流树引用（Codex 2b 复核 P1-3）：重试基线锚——错误面
 * currentTreeBlobRef（mock 消息提取/rpc 结构化 data）落地后「基于新基线重放」可用；
 * null=无 CAS 漂移挂起（正常态/非 CAS 错误）。
 */
let brushCasRef = $state<string | null>(null)

let loadSeq = 0
/**
 * 上次装载完成的三工件引用（2d 终评 P1-2 身份保持判定锚）：仅 loadWorkbench 完成
 * 时更新——写路径（reorder/delete/patch/revert）的乐观 detail.tree/blobRef 推进不
 * 参与判定（防「乐观新 ref==服务端新 ref」误判未变而保住旧 nodes）。
 */
let lastLoadedTreeRef: string | null = null
let lastLoadedBaseImageRef: string | null = null
let lastLoadedGemsRef: string | null = null
/**
 * 本地 nodes 相对上次装载快照的漂移标志（Codex v3 复核后 MainAgent 走查 B3——revert
 * 短路根因）：内容寻址工件下 revert 把服务端电流树 ref **回拨到历史值**——若恰等于
 * lastLoadedTreeRef 而 nodes 已被写路径就地演进（rename/split），「ref 未变 ⇒ 节点集
 * 未变」判定被击穿（真浏览器走查实证：回退 v1 后左栏仍显 v8 名）。任何结构写
 * （noteStructureWrite 统一收口）置位；loadWorkbench 完成时清零。
 */
let nodesDirtySinceLoad = false

function api() {
  const bound = getBoundAgentApi()
  if (bound === null) throw new Error('Agent API 未绑定——任务详情通道不可用')
  return bound
}

function decodeArtifactJson(dataBase64: string): unknown {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** base64 → bytes（手工循环——Uint8Array.from+回调在 15MB 级工件上慢 2-3 倍；2d 性能门）。 */
function bytesFromBase64(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 视图态装载投影（服务端工件 → 本地三面 Set+CAS 基线；内容等价时保持 Set 身份——投影缓存热命中）。
 * v4 修复轮 F5（树根=背景层）：根节点（画布）的 hidden 行在读回时剔除——背景显隐
 * 真源=baseVisible 本地表（树根行眼睛与工具栏背景簇双向同源）；旧工件若含
 * root.visible=false 遗留行，投影不得把整树标隐藏（hiddenDeep 从根传播=全部图层消失）。 */
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
    previewMode = state.previewMode ?? 'rendered'
  } else {
    viewRevision = null
    previewMode = 'rendered'
  }
  const rootId = nodes.find((node) => node.parent === null)?.id
  if (rootId !== undefined) hidden.delete(rootId)
  hiddenNodes = sameSetContents(hiddenNodes, hidden) ? hiddenNodes : hidden
  collapsedNodes = sameSetContents(collapsedNodes, collapsed) ? collapsedNodes : collapsed
  lockedNodes = sameSetContents(lockedNodes, locked) ? lockedNodes : locked
}

/** Set 内容等价（同大小+互含——身份保持的判定；O(n) 小集合）。 */
function sameSetContents(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return true
}

/** 指派表内容等价（小表 stringify 对比——身份保持的判定；序不同/字段变=false）。 */
function sameAssignments(a: StrategyAssignment[], b: StrategyAssignment[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return JSON.stringify(a) === JSON.stringify(b)
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
  const prev = options.refresh === true ? detail : null
  try {
    const client = api()
    const response = await client.taskDetail(nextTaskId)
    if (seq !== loadSeq || taskId !== nextTaskId) return
    let nextBaseImageUrl: string | null = null
    // 底图引用（2026-10-05 Owner 实弹补固）：任务主图集 baseImage 优先；缺席时回退
    // 树锚图（tree.imageBlobRef——树编辑/领养任务同源锚；adopt 已保证锚在任务工件
    // 合法引用集内）。双缺=null（画布无底图——既有语义）。
    const treeAnchorRef = response.tree !== null ? (response.tree.imageBlobRef ?? null) : null
    const baseImageRef = response.baseImage !== null ? response.baseImage.blobRef : treeAnchorRef
    if (baseImageRef !== null) {
      // 定向刷新时同 ref 不重拉（baseImage 稳定——省一次附件通道往返）+旧对象身份
      // 保持（投影缓存热命中——内容寻址引用相同 ⇒ 字节相同）。判定锚=lastLoaded*
      // （仅装载完成时更新——写路径的乐观 detail.tree/blobRef 推进不参与判定，防
      // 「乐观新 ref == 服务端新 ref」误判成未变而保住旧 nodes）。
      const refUnchanged = options.refresh === true && lastLoadedBaseImageRef === baseImageRef
      if (refUnchanged && prev?.baseImage != null && response.baseImage !== null) {
        response.baseImage = prev.baseImage
      }
      nextBaseImageUrl = refUnchanged ? baseImageUrl : await (async () => {
        const artifact = await client.taskArtifact({ taskId: nextTaskId, blobRef: baseImageRef })
        return `data:${artifact.mime};base64,${artifact.dataBase64}`
      })()
    }
    let nextGemsDoc: StrategyGemsView | null = null
    if (response.gems !== null) {
      // 定向刷新时同 ref 不重解析（baseImage 同式——内容寻址工件字节稳定；2d 性能门：
      // 100k 颗 strategy-gems 工件 JSON.parse+zod ~1.4s，热载入复用已解析文档）
      const refUnchanged = options.refresh === true && lastLoadedGemsRef === response.gems.blobRef
      if (refUnchanged && gemsDoc !== null) {
        nextGemsDoc = gemsDoc
      } else {
        const artifact = await client.taskArtifact({ taskId: nextTaskId, blobRef: response.gems.blobRef })
        nextGemsDoc = StrategyGemsViewSchema.parse(decodeArtifactJson(artifact.dataBase64))
      }
    }
    if (seq !== loadSeq || taskId !== nextTaskId) return
    // 树工件身份保持（treeUnchanged ⇒ 节点集未变——本地工作副本 nodes 沿用旧身份，
    // 100k 颗点阵投影缓存热命中）。判定锚=lastLoadedTreeRef（同上——树推进
    // （patch/split/rename/reorder/delete/revert）必换新 ref ⇒ 必重建，语义不回退）+
    // !nodesDirtySinceLoad（revert 把 ref 回拨到 lastLoadedTreeRef 历史值的窗口——
    // 本地 nodes 已被就地演进时必须强制重建，见字段注）。
    const treeUnchanged =
      options.refresh === true &&
      !nodesDirtySinceLoad &&
      response.tree !== null &&
      lastLoadedTreeRef === response.tree.blobRef
    if (treeUnchanged && prev?.tree != null) response.tree = prev.tree
    detail = response
    nodes = response.tree !== null ? (treeUnchanged ? nodes : response.tree.nodes.map((node) => ({ ...node }))) : []
    assignments = prev !== null && sameAssignments(prev.assignments, response.assignments)
      ? assignments
      : response.assignments.map((assignment) => ({ ...assignment }))
    gemsDoc = nextGemsDoc
    baseImageUrl = nextBaseImageUrl
    applyViewState(response.viewState)
    maskEdits = response.maskEdits.map((edit) => ({ ...edit }))
    lastLoadedTreeRef = response.tree?.blobRef ?? null
    // 底图去重锚跟随实际装载引用（含树锚回退形态——与 nextBaseImageUrl 取用同源）
    lastLoadedBaseImageRef = baseImageRef
    lastLoadedGemsRef = response.gems?.blobRef ?? null
    // 装载完成：本地 nodes 已对齐 lastLoadedTreeRef 快照（treeUnchanged 保身份分支
    // 同样对齐——ref 相同+装载后未漂移），漂移标志清零。
    nodesDirtySinceLoad = false
    if (options.refresh !== true) {
      selectedNodeId = null
      resetMaskEntriesForTask()
      resetCutoutsForTask()
      exitBrushMode()
      // T6 参考图层动作面随任务重置（pending 订阅拆除——不跨任务续听）
      teardownReferenceFrames()
      resetReferenceAction()
      pendingReferenceDisable = false
      referenceThumb = null
      // 换任务清确认面（Codex 四轮 P1）：A 的删除/回退确认不得残留到 B 并以 B 的
      // taskId 执行。
      pendingDelete = null
      pendingTreeRevert = null
      // 域游标随任务重置（快照栈属会话内操作史——换任务不跨任务回退）；结构链懒重种。
      resetUndoDomainsInStore()
      treeHistory = { open: false, loading: false, versions: [], error: null }
      // v3：收起态版本计数预取（dock 可见性——不展开也见规模；journey 基线播种在
      // 服务端 treeHistory 读面内完成）
      void fetchTreeHistory()
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

/**
 * 图层树行集（**自然树序——Owner 定调 2026-10-04**：父在上、子在下缩进，根「画布」
 * 恒在面板顶部；v5 的 PS 面板逆序类比废弃——那是图层**堆叠序**的呈现惯例，本树是
 * 对象**包含树**，拿堆叠序套包含树致「parent 沉底」拧巴，Owner 明确不取）。
 * 折叠节点子树跳过。assignment 携带：v5 读面降级——父层（组）旧指派标注失效
 * （isStaleGroupAssignment 派生面，UI 显「组不产钻——已失效」）。
 */
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
  return rows // 前序 DFS=父先子后（自然树序——不再 reverse；z 序语义归画布渲染，面板只讲包含关系）
}

/** 指派是否为父层旧指派（v5 读面降级判定：判定单源=contracts nodeProducesBlock——组不产钻——已失效）。 */
export function isStaleGroupAssignment(nodeId: string): boolean {
  const node = nodes.find((candidate) => candidate.id === nodeId)
  return node !== undefined && !nodeProducesBlock(node)
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
 * 视图态写透队列（Codex 2b 复核 P1-4）：连续快速操作（显隐/折叠/锁定连点）串行化
 * ——pending 链上每个写等前一个完成（届时 CAS 基线 viewRevision 已新鲜）再发。
 * 旧并发形态下后发写带同基线必被 CAS 拒并按旧快照回滚（丢意图窗口+失败 toast 噪音）。
 */
let viewWriteChain: Promise<void> = Promise.resolve()

/**
 * previewMode 意图代次（Codex v3 复核 P1-2——写队列 generation）：每次
 * setPreviewMode 递增。队列中旧请求失败回滚 previewMode 仅在「本请求代次仍是最新」
 * 时生效——连续快速切换（rendered→holes→numbered）首笔失败时不得用旧回滚值覆盖
 * 队列尾部的最终意图。previewMode 不进任何 undo 域（产品语义：预览模式是观察面
 * 而非编辑面——Ctrl+Z 不路由到它）。
 */
let previewModeSeq = 0

/**
 * 视图态写透（view.state.set 全量快照+CAS；失败回滚本地并提示——不静默丢弃）。
 * nodesOverride=指定快照写回（tree-view 域 undo 回放）；缺省=当前三面投影。
 * previewMode 恒随快照携带（v3——模式服务端化）。requestedPreviewMode=请求体携带
 * 值（**调用时捕获**——执行体不再读可变全局：连续入队时后续意图不污染前笔请求）；
 * previousPreviewMode=写失败回滚面（previewModeGen=捕获时的意图代次——仅当本请求
 * 仍是最新代次才回滚，队列尾部更新意图保留）。
 * 写入经 viewWriteChain 串行排队（P1-4——返回排队后的链尾）。
 * H2（v4 修复轮三/Codex 三轮 P1-2）：入队时绑定 {requestTaskId, epoch=loadSeq}——
 * 排队中的旧意图在任务已换（A 切 B）或代次漂移（中途装载过）后**不发出**（不得以
 * 新任务 id 执行 A 的快照，也不得以过期 viewRevision 基线发出）；响应写 viewRevision
 * 与失败回滚/触发重载前均先验栅栏（旧快照回滚当前全局=跨任务污染面）。
 */
function syncViewState(
  previous: { hidden: ReadonlySet<string>; collapsed: ReadonlySet<string>; locked: ReadonlySet<string> },
  nodesOverride?: ViewStateNode[],
  previousPreviewMode?: WorkbenchPreviewMode,
  requestedPreviewMode: WorkbenchPreviewMode = previewMode,
  previewModeGen: number = previewModeSeq,
): Promise<void> {
  const requestTaskId = taskId
  const epoch = loadSeq
  const run = async (): Promise<void> => {
    if (requestTaskId === null || phase !== 'ready') return
    // 入队→执行间任务/代次已漂移：过期项不发出（H2——服务端持久串任务风险闭合）
    if (!commandFenceValid(requestTaskId, epoch)) return
    viewSyncing = true
    try {
      const output = await api().viewStateSet({
        taskId: requestTaskId,
        nodes: nodesOverride ?? viewStateSnapshot(),
        previewMode: requestedPreviewMode,
        ...(viewRevision !== null ? { expectedRevision: viewRevision } : {}),
      })
      // 响应迟到（在途期间切任务/重装载）——不得把 A 的 revision 写进 B 的 CAS 基线
      if (!commandFenceValid(requestTaskId, epoch)) return
      viewRevision = output.revision
    } catch (error) {
      // 失败回滚前验栅栏：旧快照/旧 previewMode 不得覆盖新任务或新装载的投影
      if (!commandFenceValid(requestTaskId, epoch)) return
      // 写失败：回滚本地投影（服务端真源未变——下次操作重新走透）
      hiddenNodes = previous.hidden
      collapsedNodes = previous.collapsed
      lockedNodes = previous.locked
      // previewMode 回滚仅在本请求仍是最新意图代次时生效（P1-2：队列中已有更新
      // 意图时旧请求的失败回滚不得覆盖最终意图——最新代次请求自会带最终值写透）
      if (previousPreviewMode !== undefined && previewModeGen === previewModeSeq) previewMode = previousPreviewMode
      const message = error instanceof Error ? error.message : String(error)
      showToast(`视图态保存失败：${message}`)
      // CAS 漂移（他写）→ 重装载读回最新视图态（栅栏已验——requestTaskId 即当前任务）
      if (message.includes('cas-mismatch')) await loadWorkbench(requestTaskId)
    } finally {
      viewSyncing = false
    }
  }
  viewWriteChain = viewWriteChain.then(run, run)
  return viewWriteChain
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

/**
 * 展开/收起全部组（v5 PS 面板底部操作条）：所有有子节点的组（包括画布根）
 * 统一置折叠态；单笔视图态写透（tree-view 域 undo 一并入栈）。
 */
export function setAllGroupsCollapsed(collapsed: boolean): void {
  const next = new Set(collapsedNodes)
  const groupIds = nodes
    .filter((node) => node.children.length > 0)
    .map((node) => node.id)
  if (collapsed) {
    for (const id of groupIds) next.add(id)
  } else {
    for (const id of groupIds) next.delete(id)
  }
  if (sameSetContents(collapsedNodes, next)) return // 幂等——无变化不写不入 undo 栈
  const previous = { hidden: hiddenNodes, collapsed: collapsedNodes, locked: lockedNodes }
  pushViewUndoSnapshot(viewStateSnapshot())
  collapsedNodes = next
  noteUndoAction('tree-view')
  void syncViewState(previous)
}

// ---------------------------------------------------------------- 预览三模式（v3——服务端化写透）

export function getPreviewMode(): WorkbenchPreviewMode {
  return previewMode
}

/**
 * 模式切换（本地即时投影+view.state.set 写透——刷新/换端保持）。每笔携带意图代次
 * （previewModeSeq——失败回滚仅最新代次生效，见 syncViewState 注）；previewMode
 * 不进 undo 域（产品语义——纯观察面）。
 */
export function setPreviewMode(mode: WorkbenchPreviewMode): void {
  if (mode === previewMode) return
  const previous = { hidden: hiddenNodes, collapsed: collapsedNodes, locked: lockedNodes }
  const previousMode = previewMode
  const seq = ++previewModeSeq
  previewMode = mode
  void syncViewState(previous, undefined, previousMode, mode, seq)
}

// ---------------------------------------------------------------- 缩略双模式（presentation U2/Codex E1——观察态）

/** 缩略观察模式：trim=内容 bbox contain（小图层可读）；ps=整画布坐标放回（保留 parent/child 空间关系）。 */
export type WorkbenchThumbMode = 'trim' | 'ps'

/**
 * 图层缩略双模式（Codex E1）：**view-state 观察态**——不进 tree-structure 域（换
 * 模式不产生树版本/undo 快照），也不进 tree-view 域（与显隐/折叠/锁定不同类——
 * 纯呈现偏好）。语义=面板重渲染与任务重新加载后保持一致（模块级会话态满足 Codex
 * E1 最低验收）；服务端 view.state 工件写透需 contracts ViewState 增 thumbMode 字段
 * （strict schema）——属后续契约波，本表现层波不越权改 contracts/daemon。
 */
let thumbMode = $state<WorkbenchThumbMode>('trim')

export function getThumbMode(): WorkbenchThumbMode {
  return thumbMode
}

export function setThumbMode(mode: WorkbenchThumbMode): void {
  thumbMode = mode
}

// ---------------------------------------------------------------- numbered 组色描边（v4——本地视图偏好）

/**
 * numbered 模式组色描边开关（design §3：可选开关，缺省关——回归纯视图）。
 * 纯本地观察面：不入 undo 域、不写服务端视图态。
 */
let numberedGroupStrokes = $state(false)

export function getNumberedGroupStrokes(): boolean {
  return numberedGroupStrokes
}

export function setNumberedGroupStrokes(enabled: boolean): void {
  numberedGroupStrokes = enabled
}

/** 钻候选表（task.detail 投影——v3 钻选择器数据面；owner 无钻=空数组）。 */
export function getStoneCandidates(): StoneCandidateRow[] {
  return detail?.stoneCandidates ?? []
}

/**
 * 当前指派钻反查候选 idx（选中态高亮锚——resourceId 匹配；不在候选表=不亮）。
 */
export function stoneIdxOfAssignment(nodeId: string): number[] {
  const assignment = getAssignmentOf(nodeId)
  if (assignment === null) return []
  const byResourceId = new Map(getStoneCandidates().map((candidate) => [candidate.resourceId, candidate.idx] as const))
  return assignment.stones
    .map((stone) => byResourceId.get(stone.resourceId))
    .filter((idx): idx is number => idx !== undefined)
}

/** 选中层掩码覆盖率（位面就绪时 0..1——inspector 基本信息面；未就绪=null）。 */
export function getLayerMaskCoverage(nodeId: string): number | null {
  const entry = getMaskEntryOf(nodeId)
  if (entry.phase !== 'ready' || entry.bits === null) return null
  const { bits } = entry
  if (bits.w * bits.h === 0) return null
  let popcount = 0
  for (let i = 0; i < bits.bits.length; i += 1) popcount += bits.bits[i]
  return popcount / (bits.w * bits.h)
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

// ---------------------------------------------------------------- mask 编辑恢复链（终评 P0-1：stale/error 重放/放弃）

/** 恢复链执行态（单飞——retry/discard 进行中的 nodeId；按钮禁用面）。 */
let maskEditActionBusy = $state<string | null>(null)

export function getMaskEditActionBusy(): string | null {
  return maskEditActionBusy
}

/**
 * stale/error 重放重算（maskEdit.retry——CAS=现读留痕 baseVersion）：响应留痕行即时
 * upsert（徽标即刻反映终态）+门本地重算 → 定向刷新读齐三新面。竞态（被新编辑接管）
 * 时响应=新行现值——如实呈现后刷新；CAS 拒面（baseVersion 漂移）刷新后由用户以新
 * 留痕重入。
 */
export async function retryMaskEditNode(nodeId: string): Promise<boolean> {
  if (taskId === null || phase !== 'ready' || maskEditActionBusy !== null) return false
  const edit = getMaskEditOf(nodeId)
  if (edit === null || (edit.state !== 'stale' && edit.state !== 'error')) return false
  const requestTaskId = taskId
  const epoch = loadSeq
  maskEditActionBusy = nodeId
  try {
    const output = await api().maskEditRetry({ taskId: requestTaskId, nodeId, expectedBaseVersion: edit.baseVersion })
    // H2（Codex 三轮 P1-2）：迟到响应不得把 A 的留痕行 upsert 进 B 的 maskEdits
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    maskEdits = [...maskEdits.filter((candidate) => candidate.nodeId !== nodeId), { ...output.edit }]
    if (detail !== null) detail = { ...detail, exportGate: recomputeExportGate() }
    const name = getNodeOf(nodeId)?.objectName ?? nodeId
    if (output.edit.state === 'ready') {
      showToast(`重算完成——「${name}」编辑留痕已收敛（行程 ${output.edit.runCount} 段）`)
    } else if (output.edit.state === 'error') {
      showToast(`重算仍失败（${output.edit.error ?? '原因见留痕'}）——可再试或确认放弃`)
    } else {
      showToast(`重算未落定（状态 ${output.edit.state}——留痕已被新编辑接管，按新留痕重入）`)
    }
    await loadWorkbench(requestTaskId, { refresh: true })
    return output.edit.state === 'ready'
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    const message = error instanceof Error ? error.message : String(error)
    showToast(`重算失败：${message}`)
    if (message.includes('cas-mismatch')) await loadWorkbench(requestTaskId, { refresh: true })
    return false
  } finally {
    maskEditActionBusy = null
  }
}

/**
 * 确认放弃编辑留痕（maskEdit.discard——删阻断留痕行；mask 已落盘如实不回滚，仅清
 * 告警/门阻断面）：行移除+门本地重算 → 定向刷新。行已不在（幂等）同样收敛到刷新。
 */
export async function discardMaskEditNode(nodeId: string): Promise<boolean> {
  if (taskId === null || phase !== 'ready' || maskEditActionBusy !== null) return false
  const edit = getMaskEditOf(nodeId)
  if (edit === null) return false
  const blocking = edit.state === 'stale' || edit.state === 'error' || edit.incomplete
  if (!blocking) return false
  const requestTaskId = taskId
  const epoch = loadSeq
  maskEditActionBusy = nodeId
  try {
    await api().maskEditDiscard({ taskId: requestTaskId, nodeId, expectedBaseVersion: edit.baseVersion })
    // H2（Codex 三轮 P1-2）：迟到响应不得动 B 的 maskEdits/exportGate
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    maskEdits = maskEdits.filter((candidate) => candidate.nodeId !== nodeId)
    if (detail !== null) detail = { ...detail, exportGate: recomputeExportGate() }
    showToast(`已放弃「${getNodeOf(nodeId)?.objectName ?? nodeId}」编辑告警（mask 保持现状——导出门重估）`)
    await loadWorkbench(requestTaskId, { refresh: true })
    return true
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    const message = error instanceof Error ? error.message : String(error)
    showToast(`放弃失败：${message}`)
    if (message.includes('cas-mismatch')) await loadWorkbench(requestTaskId, { refresh: true })
    return false
  } finally {
    maskEditActionBusy = null
  }
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
  const requestTaskId = taskId
  const requestSeq = loadSeq
  exporting = true
  exportError = null
  try {
    const output = await api().taskExport({ taskId: requestTaskId })
    // 完整栅栏（Codex 四轮 P1）：跨任务或同任务代次漂移（重装载）——产物在手但
    // 不下载/toast，不落入新任务的 UI 面。
    if (requestTaskId !== taskId || loadSeq !== requestSeq) return true
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
    // 失败面同栅栏：A 的迟到失败不得写进 B（或重装载后）的错误面。
    if (requestTaskId === taskId && loadSeq === requestSeq) {
      exportError = error instanceof Error ? error.message : String(error)
    }
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

// ---------------------------------------------------------------- T6 参考图层操作面（D6——add-flat-aux-segmentation）

/** 参考图层动作态（授权流+loading 呈现——regenerate 双模/disable/enable 共用）。 */
export interface ReferenceLayerActionState {
  /** idle=无动作；proposing=发起提案；pending=等待会话审批（批准后自动执行或再点执行）；executing=生成中；done=刚完成（消息短暂驻留）。 */
  phase: 'idle' | 'proposing' | 'pending' | 'executing' | 'done'
  /** pending 态的提案键（approval-resolved 帧自动执行锚+再点执行入口）。 */
  proposalId: string | null
  requestId: string | null
  /** 人读状态/错误文案（pending 指引或失败原因；null=不渲染行）。 */
  message: string | null
  error: boolean
}

let referenceAction = $state<ReferenceLayerActionState>({ phase: 'idle', proposalId: null, requestId: null, message: null, error: false })
/** 禁用确认面（破坏性=确认——pendingDelete 同款 store 级旗）。 */
let pendingReferenceDisable = $state(false)
/** 缩略/大图 dataUrl（referenceBlobRef 内容寻址缓存——换 ref 才重拉）。 */
let referenceThumb = $state<{ ref: string; url: string } | null>(null)
/** pending 审批的帧订阅退订器（approval-resolved 自动执行；任务切换/终态即拆）。 */
let referenceFrameUnsub: (() => void) | null = null

export function getReferenceLayerAction(): ReferenceLayerActionState {
  return referenceAction
}

export function getPendingReferenceDisable(): boolean {
  return pendingReferenceDisable
}

/** 参考图层读面（task.detail 投影三态：absent/active(disabled?)/generated）。 */
export function getWorkbenchReferenceLayer(): TaskDetailResponse['referenceImage'] {
  return detail?.referenceImage ?? null
}

/** 缩略 dataUrl（ensureReferenceThumb 拉取后在此读；未就绪=null——组件占位）。 */
export function getReferenceThumbUrl(): string | null {
  return referenceThumb?.url ?? null
}

/** 拉取参考图层工件字节为 dataUrl（ref 未变=缓存直读；调用方 $effect 驱动——
 * 完成仅要求任务未切换：detail 旧快照不拦截（内容寻址字节按 ref 恒真）。 */
export async function ensureReferenceThumb(ref: string | null): Promise<void> {
  if (ref === null) {
    referenceThumb = null
    return
  }
  if (taskId === null) return
  if (referenceThumb?.ref === ref) return
  const requestTaskId = taskId
  try {
    const artifact = await api().taskArtifact({ taskId: requestTaskId, blobRef: ref })
    if (requestTaskId !== taskId) return
    referenceThumb = { ref, url: `data:${artifact.mime};base64,${artifact.dataBase64}` }
  } catch {
    // 工件不可读（旧任务 blob 回收等）——缩略占位不阻塞条目
  }
}

function resetReferenceAction(): void {
  referenceAction = { phase: 'idle', proposalId: null, requestId: null, message: null, error: false }
}

/** 帧订阅拆除（任务切换/提案终态——loadWorkbench 换任务与本域完成时调用）。 */
function teardownReferenceFrames(): void {
  referenceFrameUnsub?.()
  referenceFrameUnsub = null
}

/** 执行已批准/待批准的提案（自动执行与用户再点同路径；结果统一 refresh 呈现）。 */
async function executeReferenceProposal(proposalId: string, requestTaskId: string): Promise<void> {
  referenceAction = { ...referenceAction, phase: 'executing', message: '生成中…（image-edit 外呼，分钟级）', error: false }
  try {
    const output = await api().taskReferenceRegenerate({ taskId: requestTaskId, proposalId })
    if (requestTaskId !== taskId) return
    teardownReferenceFrames()
    if (output.mode === 'executed' && output.outcome === 'generated') {
      referenceAction = {
        phase: 'done',
        proposalId: null,
        requestId: null,
        message: `参考图层已重新生成${output.consistency !== undefined ? `（IoU ${output.consistency.iou.toFixed(3)} · ${output.consistency.model}）` : ''}`,
        error: false,
      }
    } else {
      const reason = output.mode === 'executed' ? output.warning ?? output.outcome : '未执行'
      referenceAction = { phase: 'idle', proposalId: null, requestId: null, message: `重新生成未生效：${reason}`, error: true }
    }
    await loadWorkbench(requestTaskId, { refresh: true })
  } catch (error) {
    if (requestTaskId !== taskId) return
    const message = error instanceof Error ? error.message : String(error)
    // grant-missing=用户尚未批准（回到 pending 态等待）；其余=错误面
    if (message.includes('grant-missing') || message.includes('尚未获用户批准')) {
      referenceAction = { ...referenceAction, phase: 'pending', message: '等待批准——在会话审批卡批准后自动执行（或再点「重新生成」）', error: false }
    } else {
      teardownReferenceFrames()
      referenceAction = { phase: 'idle', proposalId: null, requestId: null, message: `重新生成失败：${message}`, error: true }
    }
  }
}

/**
 * 重新生成（approved-mutation 双模 UI 审批流）：
 * - 无 pending → 发起提案；autoApprove 会话立即执行（loading）；
 * - pending 在身 → 本点击=执行尝试（已批准即跑，未批准回 pending 提示）；
 * - pending 期间 approval-resolved 帧到达（自动批准监听）→ 自动执行。
 */
export async function regenerateReferenceLayer(): Promise<void> {
  if (taskId === null) return
  if (referenceAction.phase === 'proposing' || referenceAction.phase === 'executing') return
  const requestTaskId = taskId
  // pending 在身：本点击=执行（批准后手动路径）
  if (referenceAction.phase === 'pending' && referenceAction.proposalId !== null) {
    await executeReferenceProposal(referenceAction.proposalId, requestTaskId)
    return
  }
  referenceAction = { phase: 'proposing', proposalId: null, requestId: null, message: '发起审批…', error: false }
  try {
    const proposed = await api().taskReferenceRegenerate({ taskId: requestTaskId })
    if (requestTaskId !== taskId) return
    if (proposed.mode === 'executed') {
      // 旧 daemon 直执行形态（防御）——按执行结果呈现
      referenceAction = { phase: 'idle', proposalId: null, requestId: null, message: null, error: false }
      await loadWorkbench(requestTaskId, { refresh: true })
      return
    }
    if (proposed.autoApproved === true) {
      await executeReferenceProposal(proposed.proposalId, requestTaskId)
      return
    }
    // 手动批准路径：pending+帧监听（approval-resolved(approved) 自动执行；拒绝=收面）
    referenceAction = {
      phase: 'pending',
      proposalId: proposed.proposalId,
      requestId: proposed.requestId,
      message: '等待批准——在会话审批卡批准后自动执行（或再点「重新生成」）',
      error: false,
    }
    teardownReferenceFrames()
    const requestId = proposed.requestId
    referenceFrameUnsub = api().subscribeTask(requestTaskId, 0, (frame) => {
      if (requestTaskId !== taskId) return
      if (frame.kind !== 'approval-resolved') return
      if (frame.payload.requestId !== requestId) return
      if (frame.payload.approved) {
        void executeReferenceProposal(proposed.proposalId, requestTaskId)
      } else {
        teardownReferenceFrames()
        referenceAction = { phase: 'idle', proposalId: null, requestId: null, message: '已拒绝——参考图层保持现状', error: false }
      }
    })
  } catch (error) {
    if (requestTaskId !== taskId) return
    referenceAction = {
      phase: 'idle',
      proposalId: null,
      requestId: null,
      message: `发起失败：${error instanceof Error ? error.message : String(error)}`,
      error: true,
    }
  }
}

/** 请求禁用（确认面 open——破坏性语义：分件输入将回退原图，需重跑分件生效）。 */
export function requestDisableReferenceLayer(): void {
  pendingReferenceDisable = true
}

export function cancelDisableReferenceLayer(): void {
  pendingReferenceDisable = false
}

/** 确认禁用：标记生效+定向刷新+重跑分件提示（toast）。 */
export async function confirmDisableReferenceLayer(): Promise<void> {
  if (taskId === null || !pendingReferenceDisable) return
  const requestTaskId = taskId
  pendingReferenceDisable = false
  try {
    await api().taskReferenceDisable(requestTaskId)
    if (requestTaskId !== taskId) return
    await loadWorkbench(requestTaskId, { refresh: true })
    showToast('已禁用参考图层——分件输入回退原图；对既有图层重跑抠图（分件）后生效')
  } catch (error) {
    showToast(`禁用失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 启用（无破坏性——直呼）：重申生成帧+刷新+提示。 */
export async function enableReferenceLayer(): Promise<void> {
  if (taskId === null) return
  const requestTaskId = taskId
  try {
    await api().taskReferenceEnable(requestTaskId)
    if (requestTaskId !== taskId) return
    await loadWorkbench(requestTaskId, { refresh: true })
    showToast('已启用参考图层——后续抠图（分件）重新用参考图层')
  } catch (error) {
    showToast(`启用失败：${error instanceof Error ? error.message : String(error)}`)
  }
}


/** 原图 dataUrl（F5：树根行缩略图=原图缩略渲染——与主画布背景同源）。 */
export function getBaseImageUrl(): string | null {
  return baseImageUrl
}

export function getBaseImageOpacity(): number {
  return baseOpacity
}

export function setBaseImageOpacity(opacity: number): void {
  baseOpacity = Math.min(1, Math.max(0, opacity))
}

export function getShowMasks(): boolean {
  return showMasks
}

/** dev-only 注入面（presentation U2：产品 checkbox 退役——测试/诊断经此驱动蒙版叠加）。 */
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
      return bytesFromBase64(artifact.dataBase64)
    },
  })
}

/**
 * 抠图层渐进请求（v4 渲染语义层——组件 $effect 消费）：位面就绪且原图在场时按
 * (baseImageRef, maskRef, bbox) 内容寻址合成（cutout.svelte LRU 缓存）。
 * F4（Codex P1-4，design §2 资源约束「不可见层不合成」）：可见节点集合（含祖先
 * 显隐——hiddenDeepIdsOf 与渲染/命中同式）接入请求管线——隐藏子树不启动新合成、
 * 已隐藏层的在途/未消费结果经条目收缩释放（重显示时缓存键未变即热命中）。读取
 * hiddenNodes 建立显隐依赖（$effect 消费面——显隐切换即重投影）。
 */
export function requestCutoutsForTree(): void {
  if (taskId === null) return
  const hiddenDeep = hiddenDeepIdsOf(nodes, hiddenNodes)
  const visibleNodes = nodes.filter((node) => node.parent !== null && !hiddenDeep.has(node.id))
  requestCutouts(visibleNodes, {
    baseImageUrl,
    baseImageRef: detail?.baseImage?.blobRef ?? null,
  })
}

export { getMaskEntryOf } from './maskBits.svelte.js'

// ---------------------------------------------------------------- 画布投影（v4 图层渲染语义层——WorkbenchLayerStage 喂数）

/**
 * 图层渲染模型（组件 $derived 内调用即响应式——树/指派/gems/视图态/位面/抠图面
 * 变化自动重渲）。渲染序=树前序（父先子后=DOM 序=z 序）；显隐传递（自身+全部祖先
 * 可见才渲染——层隐藏→其钻+树后代一并跳过）；钻按 blockId 归层（层内坐标系由
 * 消费方换算）；numbered 分组=渲染序首现序。
 * 投影缓存（沿 2d 性能门同式）：输入恒等键 memo——键检查仍逐一读取响应式输入
 * （$derived 依赖追踪不被缓存短路）。
 */
let layerRenderCache: { inputs: unknown[]; model: LayerRenderModel } | null = null

function sameRenderInputs(cached: unknown[], next: unknown[]): boolean {
  if (cached.length !== next.length) return false
  for (let i = 0; i < cached.length; i += 1) {
    if (cached[i] !== next[i]) return false
  }
  return true
}

export function getWorkbenchLayerRender(): LayerRenderModel | null {
  if (phase !== 'ready' || detail === null) return null
  // 工作画布真源锚（Bug B 修复 2026-10-04——树优先）：bbox/掩码/钻布局全活在树坐标系，
  // imagePx/canvasCm 必须取树锚；树缺席（未拆层）才回落 gems→baseImage。旧序
  // baseImage→gems 会把 scene-analysis 锚（iter-5：500px/ppm2.5）与树锚（1280px/
  // ppm6.4）混拼——1280px bbox÷2.5=「512×512 mm」幻数+辅助图不铺满双症状。
  const imagePx =
    detail.tree?.imagePx ?? gemsDoc?.imagePx
    ?? (detail.baseImage !== null
      ? { width: detail.baseImage.widthPx, height: detail.baseImage.heightPx }
      : null)
  if (imagePx === null) return null
  const inputs: unknown[] = [
    detail.baseImage,
    detail.tree,
    nodes,
    assignments,
    gemsDoc,
    baseImageUrl,
    hiddenNodes,
    showMasks,
    getMaskEntriesIdentity(),
  ]
  if (layerRenderCache !== null && sameRenderInputs(layerRenderCache.inputs, inputs)) {
    return layerRenderCache.model
  }
  const canvasCm = detail.tree?.canvasCm ?? gemsDoc?.canvasCm ?? detail.baseImage?.canvasCm ?? null
  // 锚齐才可推导（树/gems/baseImage 任一双锚在场）；缺席=回退口径显式降级
  //（exact=false——StatusBar「回退口径」标注同源），不再伪造 canvasCm。
  const derived =
    canvasCm !== null ? derivePixelsPerMm({ canvasCm, imagePx }) : { ok: false as const }
  const ppm = derived.ok ? derived.pixelsPerMm : PIXELS_PER_MM
  // 显隐传递投影：自身或任一祖先隐藏 → 该行 visible=false（渲染跳过）——
  // layerTree.hiddenDeepIdsOf 单源（F4：与命中/抠图请求管线同式）。
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const hiddenDeep = hiddenDeepIdsOf(nodes, hiddenNodes)
  // 钻按 blockId 归层（不可见层的钻仍归入行——行级 visible 统一跳过渲染）；
  // v5 去重口径（Owner 裁定：组恒不产钻）：父层（组）旧指派的钻**不渲染不计数**
  // （旧数据 gems 工件可能携带 v4 父层钻——画布无叠钻/读数治理与 execute 收敛同语义；
  // 判定单源=contracts nodeProducesBlock——修复轮 R1e）。
  const leafIds = new Set(nodes.filter(nodeProducesBlock).map((node) => node.id))
  const gemsByNode = new Map<string, Array<{ id: string; x: number; y: number; radiusPx: number; colorHex: string; nodeId: string }>>()
  const colorByNode = new Map(
    assignments.map((assignment) => [assignment.nodeId, assignment.stones[0]?.colorHex ?? '#A3A3A3'] as const),
  )
  for (const gem of gemsDoc?.gems ?? []) {
    if (!leafIds.has(gem.blockId)) continue
    const bucket = gemsByNode.get(gem.blockId) ?? []
    bucket.push({
      id: gem.id,
      x: gem.x,
      y: gem.y,
      radiusPx: (gem.diameterMm * ppm) / 2,
      colorHex: colorByNode.get(gem.blockId) ?? '#A3A3A3',
      nodeId: gem.blockId,
    })
    gemsByNode.set(gem.blockId, bucket)
  }
  const excludedNodes = new Set(
    assignments.filter((assignment) => assignment.strategyKind === 'exclusion').map((assignment) => assignment.nodeId),
  )
  // 树前序行集（渲染序=z 序）
  const rows: LayerRenderRow[] = []
  let groupSeq = 0
  let gemsSeq = 0
  const walk = (id: string): void => {
    const node = byId.get(id)
    if (node === undefined) return
    const gems = gemsByNode.get(id) ?? []
    const visible = !hiddenDeep.has(id)
    const gemsStart = gemsSeq
    if (visible) gemsSeq += gems.length
    let groupNo: number | null = null
    let groupColor: string | null = null
    if (visible && gems.length > 0) {
      groupNo = groupSeq + 1
      groupColor = GEM_GROUP_PALETTE[groupSeq % GEM_GROUP_PALETTE.length]!
      groupSeq += 1
    }
    let maskRuns: Array<{ x: number; y: number; w: number; h: number }> | null = null
    if (showMasks) {
      const entry = getMaskEntryOf(id)
      if (entry.phase === 'ready' && entry.bits !== null) {
        try {
          maskRuns = maskRunsOf(node.bbox, entry.bits)
        } catch {
          maskRuns = null // 单层坏 mask 降级：叠加跳过（警示在图层行）
        }
      }
    }
    rows.push({
      node,
      visible,
      gems,
      groupNo,
      groupColor,
      gemsStart,
      excluded: excludedNodes.has(id) || !node.drillWorthy,
      maskRuns,
    })
    for (const child of node.children) walk(child)
  }
  const root = nodes.find((node) => node.parent === null)
  if (root !== undefined) walk(root.id)
  else for (const node of nodes) walk(node.id)
  const model: LayerRenderModel = {
    imagePx,
    rows,
    gemsVisible: countVisibleGems(rows),
    ppm: { ppm, exact: derived.ok },
    sourceUrl: baseImageUrl,
  }
  layerRenderCache = { inputs, model }
  return model
}

/** 兼容读数面（Inspector/StatusBar/BrushLayer——画幅/ppm/计数轻量读取）。 */
export function getWorkbenchRenderMetrics(): { imagePx: { width: number; height: number } | null; ppm: { ppm: number; exact: boolean } | null; gemsVisible: number; sourceUrl: string | null } {
  const model = getWorkbenchLayerRender()
  if (model === null) return { imagePx: null, ppm: null, gemsVisible: 0, sourceUrl: null }
  return { imagePx: model.imagePx, ppm: model.ppm, gemsVisible: model.gemsVisible, sourceUrl: model.sourceUrl }
}

/**
 * 去重口径总颗数（v5 读数治理——「847 颗」类计数改为去重口径）：gems 工件颗数中
 * 父层（组）旧指派的钻不计数（组不产钻——与画布渲染/getWorkbenchLayerRender 同
 * 语义）。gems 工件缺席时回落 task.detail.count（0）。
 */
export function getEffectiveGemTotal(): number {
  if (detail === null) return 0
  if (gemsDoc === null) return detail.gems?.count ?? 0
  const leafIds = new Set(nodes.filter(nodeProducesBlock).map((node) => node.id))
  let total = 0
  for (const gem of gemsDoc.gems) {
    if (leafIds.has(gem.blockId)) total += 1
  }
  return total
}

// ---------------------------------------------------------------- 写操作（D-1 直接生效）

/**
 * layer.split 出参就地应用（拆层/确认落地共用——**调用方必须先过 commandFenceValid**）：
 * 子层入树+父 children 推进+自动选中首个新子层+树/预览引用推进+警告/零检出 toast+
 * 结构域 undo 版本入史。
 */
function applySegmentOutput(nodeId: string, output: SegmentOneOutput): void {
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
}

/**
 * 人类拆层（2.3）：单步 SAM 细分（真桥 1-2 分钟/mock 桥秒回）。成功=子层入树+
 * 画布刷新+自动选中首个新子层；失败=splitError 驻留（重试=再次调用）。
 */
export async function splitLayer(nodeId: string, hint: string): Promise<boolean> {
  if (taskId === null || splitting) return false
  const requestTaskId = taskId
  const epoch = loadSeq
  splitting = true
  splitError = null
  try {
    const output = await api().layerSplit({ taskId: requestTaskId, nodeId, hint })
    // H2（Codex 三轮 P1-2）：A 的拆层响应迟到（已切 B）不得把 A 的子层写进 B 的
    // nodes——同任务代次漂移（中途装载过）也不得就地追加（服务端真源已含效果）
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    applySegmentOutput(nodeId, output)
    return true
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    splitError = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    splitting = false
  }
}

/** layer.split 试跑/落地原语出参（T5 Dialog——add-vision-pipeline-v2 D6）。 */
export interface SegmentSplitParams {
  nodeId: string
  /** 文本提示（add-sam-playbook T2 可选——纯框模式留空；与 box 至少一项） */
  hint?: string
  /** 正框（D3——imagePx 画布坐标；无 hint 时=纯框选抠图） */
  box?: NodeBBox
  /** 排除区（D2——框住区域从结果掩膜扣除；入服务端 reqHash） */
  excludeBox?: NodeBBox
  /** 实例枚举（D1——all=同款多实例逐个成层） */
  instances?: 'best' | 'all'
  /** 精度覆写（D3——未传字段=服务端图像处理配置缺省） */
  precision?: SegmentPrecision
  /** 落地自定义图层名（空=服务端提示语命名链） */
  layerName?: string
  /** 试跑基线树引用（Codex R1 P1——确认请求携带：≠服务端电流树时 typed 拒 trial-stale-tree） */
  trialTreeBlobRef?: string
}

/** 试跑结果（ok=false 时 error 驻留任务面——Dialog 呈现可重试）。 */
export type SegmentTrialOutcome = { ok: true; output: SegmentOneOutput } | { ok: false; error: string }

/** add-sam-playbook T2 载荷投影（box/excludeBox 纯数据展开——$state 深代理不穿 RPC 面）。 */
function splitParamsToRpcInput(params: SegmentSplitParams): {
  nodeId: string
  hint?: string
  box?: NodeBBox
  excludeBox?: NodeBBox
  instances?: 'best' | 'all'
  precision?: SegmentPrecision
  layerName?: string
  trialTreeBlobRef?: string
} {
  return {
    nodeId: params.nodeId,
    ...(params.hint !== undefined && params.hint.trim() !== '' ? { hint: params.hint.trim() } : {}),
    ...(params.box !== undefined ? { box: { ...params.box } } : {}),
    ...(params.excludeBox !== undefined ? { excludeBox: { ...params.excludeBox } } : {}),
    ...(params.instances !== undefined ? { instances: params.instances } : {}),
    // precision 展开为普通对象（$state 深代理不穿 RPC 面）
    ...(params.precision !== undefined ? { precision: { ...params.precision } } : {}),
    ...(params.layerName !== undefined && params.layerName.trim() !== '' ? { layerName: params.layerName.trim() } : {}),
    ...(params.trialTreeBlobRef !== undefined ? { trialTreeBlobRef: params.trialTreeBlobRef } : {}),
  }
}

/**
 * layer.split 试跑（T5 Dialog 消费——dryRun=true）：真跑分段（服务端 SAM 请求照发+
 * 断点账本照记）但**不落树**——本 store 零树变更；返回 trial 面载荷（掩膜叠加预览+
 * 试跑子层+警告+回放标记）。确认落地=同参再调 landSegmentLayer——账本命中掩膜直接
 * 回放，服务端零二次桥调。add-sam-playbook T2：box/excludeBox/instances 透传
 * （excludeBox/instances/box 均入服务端 reqHash——试跑与确认必须同参才命中回放）。
 */
export async function trialSegmentLayer(params: SegmentSplitParams): Promise<SegmentTrialOutcome> {
  if (taskId === null) return { ok: false, error: '工作台未装载' }
  const requestTaskId = taskId
  const epoch = loadSeq
  try {
    const output = await api().layerSplit({
      taskId: requestTaskId,
      ...splitParamsToRpcInput(params),
      dryRun: true,
    })
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return { ok: false, error: '任务视图已切换（试跑结果已丢弃）' }
    }
    return { ok: true, output }
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return { ok: false, error: '任务视图已切换' }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * layer.split 确认落地（T5 Dialog 消费——dryRun 缺省=false）：同参再调（含试跑时的
 * precision/指令），服务端断点账本命中掩膜直接回放（零二次桥调）；成功=子层入树+
 * 自动选中新子层（applySegmentOutput 共享面——与拆层同款 fence/toast/undo 语义）。
 */
export async function landSegmentLayer(params: SegmentSplitParams): Promise<boolean> {
  if (taskId === null) return false
  const requestTaskId = taskId
  const epoch = loadSeq
  try {
    const output = await api().layerSplit({
      taskId: requestTaskId,
      ...splitParamsToRpcInput(params),
    })
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    applySegmentOutput(params.nodeId, output)
    return true
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    showToast(`落地失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * 任务代次栅栏（v4 修复轮二 G2——Codex 二轮 P1-2；修复轮三 H2 泛化到全部异步写
 * 命令——Codex 三轮 P1-2）：模块级单例的异步写命令在 await 返回后不得盲写共享状态
 * ——A 任务命令在途期间切到 B（loadWorkbench(B) 推进 taskId+loadSeq），A 的迟到
 * 响应会把 A 的 nodes/detail/gems 工件写进 B 的单例。命令入口捕获
 * {requestTaskId, epoch=loadSeq}；每次 await 后写共享状态前校验：
 *   - 跨任务（requestTaskId ≠ 当前 taskId）→ 放弃写（A 的写已在服务端 A 数据面
 *     落库，B 无需任何动作——不重载）；
 *   - 同任务但代次漂移（中途发生过装载/定向刷新）→ 放弃就地写，触发一次定向
 *     重载收敛（服务端真源已含本命令效果）。
 * 覆盖面（H2）：split/rename/strategy/reorder/delete/tree revert/mask retry/
 * discard/brush patch/view-state 写队列（viewWriteChain 入队绑定 task/epoch——
 * 过期项不发出，响应与失败回滚均先验栅栏）。
 */
function commandFenceValid(requestTaskId: string, epoch: number): boolean {
  return requestTaskId === taskId && epoch === loadSeq
}

/** 栅栏失守处置：跨任务=静默放弃；同任务代次漂移=定向刷新收敛（不自动重试命令）。 */
function abandonStaleCommand(requestTaskId: string): void {
  if (requestTaskId === taskId && taskId !== null) void loadWorkbench(requestTaskId, { refresh: true })
}

/** 图层重命名（2.2——inline 编辑提交；直接生效+版本入史）。 */
export async function renameLayer(nodeId: string, objectName: string): Promise<boolean> {
  if (taskId === null) return false
  const requestTaskId = taskId
  const epoch = loadSeq
  renameError = null
  try {
    const output = await api().layerRename({ taskId: requestTaskId, nodeId, objectName })
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    // 数组级替换（非就地改写——画布模型 memo 以 nodes 身份为键；框线 objectName 随之失效）
    nodes = nodes.map((node) => (node.id === nodeId ? { ...node, objectName } : node))
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
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    renameError = error instanceof Error ? error.message : String(error)
    showToast(`重命名失败：${renameError}`)
    return false
  }
}

/**
 * 策略直改（2.4——D-1 直接生效）：单节点指派替换→服务端 execute 真身重算→
 * 新 gems 工件按 ref 重拉（点阵/预览即刻刷新）。不注入对话——人类主权面直改。
 * v3：options.stoneIdx=钻选择器指派（候选表 idx——服务端回填 StonePick 真源）。
 */
export async function applyLayerStrategy(
  nodeId: string,
  strategyKind: KernelStrategyKind,
  params: Record<string, unknown>,
  densityPerCm2?: number,
  options: { undoSilent?: boolean; stoneIdx?: number[] } = {},
): Promise<boolean> {
  if (taskId === null || applying) return false
  const requestTaskId = taskId
  const epoch = loadSeq
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
      taskId: requestTaskId,
      nodeId,
      strategyKind,
      params,
      ...(options.stoneIdx !== undefined && options.stoneIdx.length > 0 ? { stoneIdx: options.stoneIdx } : {}),
      ...(densityPerCm2 !== undefined ? { densityPerCm2 } : {}),
    })
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    // G2：后续工件请求一律用捕获的 task id——await 间隙切任务后不得读可变全局 taskId
    const artifact = await api().taskArtifact({ taskId: requestTaskId, blobRef: output.gems.blobRef })
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    gemsDoc = StrategyGemsViewSchema.parse(decodeArtifactJson(artifact.dataBase64))
    const existing = assignments.find((assignment) => assignment.nodeId === nodeId)
    // 钻指派面即时投影：选了候选钻=按候选真源更新 stones（服务端回填同源）；未选=沿用旧钻
    const stones =
      options.stoneIdx !== undefined && options.stoneIdx.length > 0
        ? options.stoneIdx
            .map((idx) => getStoneCandidates().find((candidate) => candidate.idx === idx))
            .filter((candidate): candidate is StoneCandidateRow => candidate !== undefined)
            .map((candidate) => ({
              resourceId: candidate.resourceId,
              sku: candidate.sku,
              supplier: candidate.supplier,
              sizeMm: candidate.sizeMm,
              colorHex: candidate.colorHex,
            }))
        : (existing?.stones ?? [])
    assignments = [
      ...assignments.filter((assignment) => assignment.nodeId !== nodeId),
      {
        nodeId,
        strategyKind,
        params,
        stones,
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
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
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
  brushCasRef = null
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
 * CAS 错误面读回电流树引用（P1-3）：rpc 通道经错误 data.currentTreeBlobRef（服务端
 * TaskWorkbenchError 结构化载荷）；mock 通道从消息文本提取（完整 ref 在消息内）。
 */
function currentTreeRefOfError(error: unknown): string | null {
  const data = (error as { data?: { currentTreeBlobRef?: unknown } } | null)?.data
  if (typeof data?.currentTreeBlobRef === 'string') return data.currentTreeBlobRef
  const message = error instanceof Error ? error.message : String(error)
  const parsed = /电流树\s([0-9a-zA-Z_-]{8,})/.exec(message)
  return parsed?.[1] ?? null
}

/**
 * 异步重算终态等待（Codex 复评建议五——spec 异步契约真身）：editState=accepted 的
 * patch 由服务端后置作业收敛（recomputing→ready/error；树推进竞态=stale）——前端
 * 不得只做一次定向刷新（只能读到过渡态）。轮询 task.detail.maskEdits 至终态或被
 * 新编辑覆盖（baseVersion 漂移=新 patch 已接管等待面）。轮询失败不阻塞（终态以下
 * 一次刷新/用户操作为准）；30s 上限防挂死。
 */
async function waitForMaskEditSettled(requestTaskId: string, nodeId: string, baseVersion: number): Promise<void> {
  const deadline = Date.now() + 30_000
  await new Promise((resolve) => setTimeout(resolve, 60)) // 服务端两级微任务+帧发布窗口
  while (Date.now() < deadline) {
    // H2：轮询固定用命令入口捕获的任务 id（await 间隙切任务后不得读可变全局）；
    // 当前任务已换=本等待面作废（新任务的装载/命令自会收敛其留痕）
    if (taskId !== requestTaskId) return
    try {
      const detail = await api().taskDetail(requestTaskId)
      if (taskId !== requestTaskId) return
      const edit = detail.maskEdits.find((candidate) => candidate.nodeId === nodeId)
      if (edit === undefined || edit.baseVersion !== baseVersion) return // 留痕消失/被新编辑覆盖
      if (edit.state === 'ready' || edit.state === 'error' || edit.state === 'stale') return
    } catch {
      return // 轮询通道失败不阻塞——终态以最终刷新/后续操作为准
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * 提交笔刷（layer.mask.patch——ops=本地笔画序列；CAS 基线=本地树工件引用）：
 * 服务端 mask 重写+bbox/effectiveMm 重算+版本入史+可选 recomputeStrategy 重算
 * →定向刷新（loadWorkbench refresh=true：树/位面缓存键换新/gems/maskEdits/
 * exportGate 一次读齐——选中与会话保留）。
 * CAS 失败（P1-3 重放闭环）：错误面读回电流树 ref→更新本地基线（detail.tree.blobRef）
 * +brushCasRef 挂起+定向刷新（refresh 保留笔画）——「基于新基线重放」按钮可用。
 */
export async function commitBrushStrokes(recomputeStrategy: boolean): Promise<boolean> {
  if (taskId === null || selectedNodeId === null || brushSubmitting) return false
  if (brush.strokes.length === 0) return false
  const currentTreeRef = detail?.tree?.blobRef ?? null
  if (currentTreeRef === null) {
    brushError = '尚无图层树——笔刷编辑需要 object-tree 工件'
    return false
  }
  const requestTaskId = taskId
  const requestNodeId = selectedNodeId
  const epoch = loadSeq
  brushSubmitting = true
  brushError = null
  const ops = brush.strokes.map((stroke) => ({ op: stroke.op, radiusPx: stroke.radiusPx, points: stroke.points }))
  try {
    const output = await api().layerMaskPatch({
      taskId: requestTaskId,
      nodeId: requestNodeId,
      ops,
      expectedTreeBlobRef: currentTreeRef,
      recomputeStrategy,
    })
    // H2（Codex 三轮 P1-2）：迟到响应不得把 A 的留痕行/树引用写进 B 的共享面
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    // maskEdits 即时 upsert（badge 即刻反映 ready/incomplete——完整三新面随定向刷新读齐）
    maskEdits = [
      ...maskEdits.filter((edit) => edit.nodeId !== requestNodeId),
      {
        nodeId: requestNodeId,
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
    brushCasRef = null
    // 异步契约（Codex 复评建议五）：accepted=服务端后置作业收敛——轮询终态再刷新
    // （单次定向刷新只能读到 recomputing 过渡态；mock 同步 ready 路径首轮即过）。
    if (output.editState === 'accepted') {
      await waitForMaskEditSettled(requestTaskId, requestNodeId, output.version)
    }
    await loadWorkbench(requestTaskId, { refresh: true })
    if (requestTaskId !== taskId) return true // 装载窗口任务又切走——undo 域/toast 只属当前任务面
    noteCommittedMaskVersion(output.version)
    noteUndoAction('mask-edit')
    showToast(
      `遮罩已更新（${output.editState === 'ready' ? '重算完成' : `状态 ${output.editState}`}${output.incomplete ? '·行程超限已告警' : ''}）` +
        (output.gems !== null ? `——重算 ${output.gems.count} 颗` : ''),
    )
    return true
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    const message = error instanceof Error ? error.message : String(error)
    brushError = message
    if (message.includes('cas-mismatch')) {
      // CAS 漂移：读回服务端电流树 ref→更新本地基线+挂起重放锚+定向刷新（保留笔画）
      const serverRef = currentTreeRefOfError(error)
      if (serverRef !== null && serverRef !== currentTreeRef) {
        brushCasRef = serverRef
        if (detail !== null && detail.tree !== null) {
          detail = { ...detail, tree: { ...detail.tree, blobRef: serverRef } }
        }
        brushError = `cas-mismatch：树已被其他操作推进——已读回新基线（${serverRef.slice(0, 12)}…），可「基于新基线重放」本笔画`
        await loadWorkbench(requestTaskId, { refresh: true })
      }
    }
    return false
  } finally {
    brushSubmitting = false
  }
}

/** CAS 重放锚读取（错误面挂起的电流树 ref——null=无 CAS 漂移挂起）。 */
export function getBrushCasRef(): string | null {
  return brushCasRef
}

/**
 * 「基于新基线重放」（P1-3 显式入口）：CAS 失败后以读回的服务端电流树为新
 * expectedTreeBlobRef 重提同一笔画集（笔画保留在本地栈——服务端在新基线 mask 上
 * 重放同一意图）。成功即清锚；再漂移则锚随新错误面更新（可连续重放）。
 */
export async function retryCommitBrushStrokes(): Promise<boolean> {
  if (brushCasRef === null) return false
  const ok = await commitBrushStrokes(true)
  if (ok) brushCasRef = null
  return ok
}

// ---------------------------------------------------------------- 2c：图层结构写（重排/删除——layer.reorder/layer.delete 消费）

/** 结构域写发生（版本链待重种+域路由推动；历史面开着则同步刷新；nodes 漂移置位——
 * revert 回拨 ref 的短路窗口由 loadWorkbench 的 !nodesDirtySinceLoad 判定封堵）。 */
function noteStructureWrite(): void {
  noteUndoAction('tree-structure')
  structureSeeded = false
  nodesDirtySinceLoad = true
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
  const requestTaskId = taskId
  const epoch = loadSeq
  try {
    const output = await api().layerReorder({
      taskId: requestTaskId,
      nodeId,
      newParentId: payload.newParentId,
      index: payload.index,
      expectedTreeBlobRef: baseline,
    })
    // H2（Codex 三轮 P1-2 点名）：A 的 reorder 响应迟到（已切 B 装载）不得把
    // output.treeBlobRef 写进模块级 detail——B 的定向刷新会因 response ref==lastLoaded
    // 走 treeUnchanged 分支复用被污染的 prev.tree，B 随后以 A 的树引用为 CAS 基线
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
      }
    }
    await loadWorkbench(requestTaskId, { refresh: true })
    if (requestTaskId !== taskId) return true // undo 域推动只属当前任务面
    noteStructureWrite()
    return true
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      abandonStaleCommand(requestTaskId)
      return false
    }
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
  const requestTaskId = taskId
  const epoch = loadSeq
  const name = getNodeOf(target.nodeId)?.objectName ?? target.nodeId
  try {
    const output = await api().layerDelete({ taskId: requestTaskId, nodeId: target.nodeId, expectedTreeBlobRef: baseline })
    // H2（Codex 三轮 P1-2）：同 reorder——迟到响应不得把 A 的树引用写进 B 的 detail
    //（确认面/选中/树引用均不得跨任务落地；命令已在服务端 A 落库）
    if (!commandFenceValid(requestTaskId, epoch)) {
      pendingDelete = null // 确认面使命结束（命令已发出且服务端完成）——清理本命令请求面
      abandonStaleCommand(requestTaskId)
      return false
    }
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
    await loadWorkbench(requestTaskId, { refresh: true })
    if (requestTaskId !== taskId) return true
    noteStructureWrite()
    showToast(
      `已删除「${name}」子树（${output.removedNodeIds.length} 节点${output.gems !== null ? `·重算 ${output.gems.count} 颗` : '·无剩余指派产物'}）`,
    )
    return true
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      pendingDelete = null
      abandonStaleCommand(requestTaskId)
      return false
    }
    showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export function getPendingDelete(): { nodeId: string; count: number } | null {
  return pendingDelete
}

// ---------------------------------------------------------------- 2c/4：层命中测试（mask 位面命中——鼠标 P0）

/**
 * 画布 px 坐标 → 命中层 id（逆 DFS：最深层/后序兄弟优先——最具体者胜）。
 * mask 就绪层=位面精确命中（非仅 bbox）；mask 未就绪/坏态层=bbox 兜底（渐进可用）。
 * 隐藏层不可命中——v4 显隐传递：自身或任一祖先隐藏即跳过（与渲染投影同式——
 * layerTree.hiddenDeepIdsOf 单源）。
 * v4 修复轮 F5（树根=背景层）：根节点（画布）不再承接命中——背景层无策略语义、
 * 选中限图层节点（右栏属性/命令面均以图层为对象）；点根区域=未命中=清空选中。
 */
export function hitTestNodeAt(x: number, y: number): string | null {
  if (nodes.length === 0) return null
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const hiddenDeep = hiddenDeepIdsOf(nodes, hiddenNodes)
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
    if (node === undefined || node.parent === null) continue // 根=背景层，不承接命中（F5）
    if (hiddenDeep.has(node.id)) continue
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

/**
 * [w19-critic P2] 外控开合同步（历史 Drawer 槽位）：open=可见性旗——既是 dock
 * 体的渲染门（panelOpen 并集），也是 noteStructureWrite「历史面开着→写后自动
 * 刷新」的门条件。Drawer 开合喂入（开=拉新版本链；关=复位）。自管宿主/测试直驱
 * toggleTreeHistoryPanel 语义不变。
 */
export function setTreeHistoryOpen(open: boolean): void {
  if (treeHistory.open === open) return
  treeHistory = { ...treeHistory, open }
  if (open) void fetchTreeHistory()
}

/**
 * 历史面请求隔离（Codex v3 复核 P1-1——token+pending）：
 *   - 请求携带发起时的 taskId+递增 historySeq 双锚——迟到响应（换任务/已被新请求
 *     接管后到达）不落地（旧形态：任务 A 的在途回来直接写 versions——污染任务 B
 *     的历史面+冲掉 loading 态）。
 *   - 在途期间的拉取意图（写后刷新/再次开面）置 pending——请求收尾时自动补拉一次
 *     最新（旧形态：loading 时直接 return——首个 history 在途时发生的 rename 完成后
 *     链不含新版本）。
 */
let historySeq = 0
let historyPending = false

export async function fetchTreeHistory(): Promise<void> {
  if (taskId === null) return
  if (treeHistory.loading) {
    // 在途请求兜住本次拉取意图——完成后补拉最新（写后刷新不被吞）
    historyPending = true
    return
  }
  const reqTaskId = taskId
  const seq = ++historySeq
  treeHistory = { ...treeHistory, loading: true, error: null }
  try {
    const output = await api().treeHistory({ taskId: reqTaskId })
    if (reqTaskId !== taskId || seq !== historySeq) return // 迟到响应作废（任务已换/已被接管）
    treeHistory = { open: treeHistory.open, loading: false, versions: output.versions, error: null }
    reseedStructureVersions(structureVersionsOf(output.versions))
    structureSeeded = true
  } catch (error) {
    if (reqTaskId !== taskId || seq !== historySeq) return
    treeHistory = { ...treeHistory, loading: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (historyPending) {
      historyPending = false
      if (taskId !== null) void fetchTreeHistory()
    }
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
  // 发起阶段栅栏（Codex 四轮 P1）：await 历史读取期间换任务时放弃——不得把 A 的
  // 确认面（目标版本来自 A 的调用）放进 B。
  const requestTaskId = taskId
  const requestSeq = loadSeq
  if (!structureSeeded) await fetchTreeHistory()
  if (taskId !== requestTaskId || loadSeq !== requestSeq) return
  pendingTreeRevert = {
    targetVersion,
    entries: treeHistory.versions.filter((version) => version.version > targetVersion),
  }
}

export function cancelPendingTreeRevert(): void {
  pendingTreeRevert = null
}

/** 确认执行整树回退（tree.revert——revert 自身入史，历史只增不删）。回退成功后
 * 经 loadWorkbench(refresh) 以服务端全量 detail 树真正重建 nodes/名称（内容寻址下
 * revert 把电流树 ref 回拨到历史值——nodesDirtySinceLoad 置位封堵 treeUnchanged
 * 短路，本地已被 rename/split 演进的旧 nodes 不得幸存；MainAgent 走查 B3 根因）。 */
export async function confirmTreeRevert(): Promise<boolean> {
  const target = pendingTreeRevert
  if (target === null || taskId === null) return false
  const requestTaskId = taskId
  const epoch = loadSeq
  try {
    const output = await api().treeRevert({ taskId: requestTaskId, version: target.targetVersion })
    // H2（Codex 三轮 P1-2）：迟到响应不得写 B 的 nodesDirtySinceLoad/detail/树引用
    if (!commandFenceValid(requestTaskId, epoch)) {
      pendingTreeRevert = null // 确认面使命结束——清理本命令请求面
      abandonStaleCommand(requestTaskId)
      return false
    }
    pendingTreeRevert = null
    nodesDirtySinceLoad = true // ref 可能回拨到 lastLoadedTreeRef 历史值——强制下次装载重建
    if (detail !== null) {
      detail = {
        ...detail,
        tree: detail.tree === null ? null : { ...detail.tree, blobRef: output.treeBlobRef },
        preview: { blobRef: output.previewBlobRef },
      }
    }
    await loadWorkbench(requestTaskId, { refresh: true })
    if (requestTaskId !== taskId) return true
    noteStructureWrite()
    showToast(`已回退到 v${target.targetVersion} 时刻的树（revert 以 v${output.version} 入史——历史只增不删）`)
    return true
  } catch (error) {
    if (!commandFenceValid(requestTaskId, epoch)) {
      pendingTreeRevert = null
      abandonStaleCommand(requestTaskId)
      return false
    }
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
  lastLoadedTreeRef = null
  lastLoadedBaseImageRef = null
  lastLoadedGemsRef = null
  nodesDirtySinceLoad = false
  historySeq = 0
  historyPending = false
  previewModeSeq = 0
  selectedNodeId = null
  hiddenNodes = new Set()
  collapsedNodes = new Set()
  lockedNodes = new Set()
  viewRevision = null
  viewSyncing = false
  viewWriteChain = Promise.resolve()
  maskEdits = []
  baseVisible = true
  baseOpacity = 0.6
  showMasks = false
  previewMode = 'rendered'
  thumbMode = 'trim'
  numberedGroupStrokes = false
  splitting = false
  splitError = null
  applying = false
  applyError = null
  renameError = null
  exporting = false
  exportError = null
  teardownReferenceFrames()
  referenceAction = { phase: 'idle', proposalId: null, requestId: null, message: null, error: false }
  pendingReferenceDisable = false
  referenceThumb = null
  brush = { active: false, op: 'add', radiusPx: 12, strokes: [], previewPoints: [], painting: false }
  brushSubmitting = false
  brushError = null
  brushCasRef = null
  loadSeq = 0
  helpOpen = false
  pendingDelete = null
  pendingTreeRevert = null
  treeHistory = { open: false, loading: false, versions: [], error: null }
  renameRequestId = 0
  layerRenderCache = null
  resetUndoDomainsInStore()
}
