/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-20 studio-layers 2.2] 历史域 store：StudioOp 全集（图层稿 §D.2——layer.create/
 *    delete/merge/rename/moveBlocks/config[layerIds[],patch,prev[]——多选批量=单 op]/
 *    block.override/palette.edit/segment.opts + improve-paving-workbench 增 layer.reorder）
 *    + 纯 fold(baseSnapshot, ops) → {state, diagnostics}。
 *    结果永不入栈（Owner「不记录结果，每次重新计算」）——ops 只含参数/结构变更。
 * 2. [stale 容错（R1·议题 15/P0-6）] 诊断流 = 稳定 code/path 排序的只读记录；stale op 不删除、
 *    不重写为有效操作——「重放确定」= 参数确定 + 诊断可查。撤销 segment.opts 回旧 k/seed →
 *    引擎确定性重生成旧块 id → 后续 op 重新有效、对应诊断条目消失（属性测试面）。
 * 3. [2026-09-20 improve-paving-workbench 2.1] PS 游标模型（Owner 点 2）：ops 数组 + cursor ∈
 *    [0, ops.length]——undo/redo 仅移动游标（列表条目恒不变，游标后条目灰显只读）；仅游标非尾时
 *    新操作截断前向（「强行修改 → 前向记录被覆盖」）。压实 100 组上限（超限把最旧 ops fold 进
 *    baseSnapshot + 记边界与 state hash——跨压实边界等价可验证；游标同步回退）。历史栈永不序列化
 *    （gemproj 存 fold 终态；打开文件 = 新 base 清空）。
 * 4. [接线面] dispatch = 唯一写入入口（apply op → live setParamState → 通知监听者标脏/重算差分）；
 *    undo/redo 与 ⌘Z/⇧⌘Z 同源（同一 reducer 入口）；监听回调由 store 根注册（避免 history →
 *    computeQueue 硬依赖）。dirty 全集 = 一切 StudioOp（undo 不清——沿 edit 先例；2.8 读取器）。
 */

import {
  applyLayerConfig,
  applyLayerReorder,
  applyPaletteEdit,
  applySegmentOpts,
  cloneParamState,
  createLayer,
  deleteLayer,
  getParamState,
  mergeLayers,
  moveBlocks,
  paramStateHash,
  renameLayer,
  setBlockOverride,
  setParamState,
  type LayerConfigPatch,
  type LayerMutationDiagnostic,
  type StudioParamState,
} from '$lib/studio/layers.svelte'
import type { BlockType, PaletteColor, StrategyId } from '$lib/engine'

// ---------------------------------------------------------------------------
// StudioOp 全集（图层稿 §D.2 冻结）
// ---------------------------------------------------------------------------

export type StudioOp =
  | { t: 'layer.create'; name?: string; blockIds?: string[]; seedConfig?: LayerConfigPatch }
  | { t: 'layer.delete'; layerId: string }
  | { t: 'layer.merge'; intoLayerId: string; fromLayerIds: string[] }
  | { t: 'layer.rename'; layerId: string; name: string }
  | { t: 'layer.moveBlocks'; blockIds: string[]; toLayerId: string }
  | { t: 'layer.reorder'; order: string[] }
  | {
      t: 'layer.config'
      layerIds: string[]
      patch: LayerConfigPatch
      /** 各层写前配置快照（面板回显/undo 摘要；fold 不消费——truncate+refold 即真撤销） */
      prev: Array<LayerConfigPatch & { strategy: StrategyId; specKey: string; gapMm: number; density: number; relax: { boundary: boolean; repulsion: boolean } }>
      /** 滑杆 300ms 窗口链合组（同 groupId 连续提交合并为一个 op） */
      groupId?: string
    }
  | {
      t: 'block.override'
      blockId: string
      patch:
        | { kind: 'enabled'; value: boolean }
        | { kind: 'density'; value: number | null }
        | { kind: 'type'; value: BlockType | null }
        | { kind: 'color'; value: string | null }
      groupId?: string
    }
  | {
      t: 'palette.edit'
      edit: { kind: 'add'; name: string; hex: string } | { kind: 'upsert'; color: PaletteColor } | { kind: 'remove'; id: string }
      groupId?: string
    }
  | { t: 'segment.opts'; k: number; seed: number }

/** 合组预算（edit UNDO_GROUP_BUDGET=100 先例纪律平移——机制同族不共用实现）。 */
export const STUDIO_UNDO_GROUP_BUDGET = 100

// ---------------------------------------------------------------------------
// fold：纯函数（属性测试面——同 base + 同 ops ⇒ 同 state 且同 diagnostics）
// ---------------------------------------------------------------------------

export type StudioDiagnosticCode =
  | 'layer-not-found'
  | 'layer-delete-rest'
  | 'block-not-in-set'
  | 'no-op'

export interface StudioFoldDiagnostic {
  code: StudioDiagnosticCode
  /** 诊断定位：层 id / 块 id / op 下标（稳定排序键）。 */
  layerId?: string
  blockId?: string
  opIndex: number
}

export interface StudioFoldResult {
  state: StudioParamState
  /** 稳定排序（code 秩 → path 字典序 → opIndex）；只读记录——stale op 不删除不重写。 */
  diagnostics: StudioFoldDiagnostic[]
}

const CODE_RANK: Record<StudioDiagnosticCode, number> = {
  'layer-not-found': 0,
  'layer-delete-rest': 1,
  'block-not-in-set': 2,
  'no-op': 3,
}

function compareDiagnostics(a: StudioFoldDiagnostic, b: StudioFoldDiagnostic): number {
  const byCode = CODE_RANK[a.code] - CODE_RANK[b.code]
  if (byCode !== 0) return byCode
  const pa = a.layerId ?? a.blockId ?? ''
  const pb = b.layerId ?? b.blockId ?? ''
  if (pa !== pb) return pa < pb ? -1 : 1
  return a.opIndex - b.opIndex
}

/**
 * 命令重放（Owner「撤销重放，不记录结果」）：base 快照 + op 流 → 参数终态 + 诊断流。
 * 纯函数：每次调用从 base 的深拷贝起步（调用方持有的 base 不被污染）。
 */
export function foldStudioOps(base: StudioParamState, ops: readonly StudioOp[]): StudioFoldResult {
  const state = cloneParamState(base)
  const diagnostics: StudioFoldDiagnostic[] = []
  const push = (opIndex: number, list: LayerMutationDiagnostic[]): void => {
    for (const d of list) diagnostics.push({ ...d, opIndex })
  }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    switch (op.t) {
      case 'layer.create':
        createLayer(state, { name: op.name, blockIds: op.blockIds, seedConfig: op.seedConfig })
        break
      case 'layer.delete':
        push(i, deleteLayer(state, op.layerId))
        break
      case 'layer.merge':
        push(i, mergeLayers(state, op.intoLayerId, op.fromLayerIds))
        break
      case 'layer.rename':
        push(i, renameLayer(state, op.layerId, op.name))
        break
      case 'layer.moveBlocks':
        // fold 态不含块集——块存在性不在此面校验（store live 路径带块集调用 layers.moveBlocks）
        push(i, moveBlocks(state, op.blockIds, op.toLayerId))
        break
      case 'layer.reorder':
        push(i, applyLayerReorder(state, op.order))
        break
      case 'layer.config':
        push(i, applyLayerConfig(state, op.layerIds, op.patch))
        break
      case 'block.override':
        push(i, setBlockOverride(state, op.blockId, op.patch))
        break
      case 'palette.edit':
        push(i, applyPaletteEdit(state, op.edit))
        break
      case 'segment.opts':
        applySegmentOpts(state, op.k, op.seed)
        break
    }
  }
  diagnostics.sort(compareDiagnostics)
  return { state, diagnostics }
}

/** op 摘要（历史面板行文案——图层稿 §D.5「图标+摘要」）。 */
export function studioOpSummary(op: StudioOp): string {
  switch (op.t) {
    case 'layer.create':
      return op.blockIds !== undefined && op.blockIds.length > 0 ? `新建图层（移入 ${op.blockIds.length} 块）` : '新建图层'
    case 'layer.delete':
      return '删除图层'
    case 'layer.merge':
      return `合并 ${op.fromLayerIds.length + 1} 层`
    case 'layer.rename':
      return `重命名 → ${op.name}`
    case 'layer.moveBlocks':
      return `移入 ${op.blockIds.length} 块`
    case 'layer.reorder':
      return '图层排序'
    case 'layer.config':
      return op.layerIds.length > 1 ? `配置 ${op.layerIds.length} 层` : '层配置'
    case 'block.override':
      return `块覆写 · ${op.patch.kind}`
    case 'palette.edit':
      return `色板 · ${op.edit.kind}`
    case 'segment.opts':
      return `重分块 k=${op.k}`
  }
}

// ---------------------------------------------------------------------------
// $state 宿主：live 历史（base + op 流 + 游标——improve 2.1 PS 模型：undo/redo 只动游标，
// 列表条目恒不变；游标后条目灰显只读；仅游标非尾时新操作截断前向）
// ---------------------------------------------------------------------------

interface CompactionRecord {
  /** 被压实 op 区间 [from, to)（对原 op 流的下标——面板「已压实」标注/等价性验证）。 */
  from: number
  to: number
  /** 压实后 baseSnapshot 的 state hash（跨压实边界 undo/redo 等价性锚点）。 */
  baseStateHash: string
}

let baseSnapshot = $state<StudioParamState>({ layers: [], layerSeq: 0, palette: [], segment: { k: 8, seed: 1 } })
let ops = $state<StudioOp[]>([])
/** 当前游标 ∈ [0, ops.length]：state = fold(base, ops.slice(0, cursor))。 */
let cursor = $state(0)
let compactions = $state<CompactionRecord[]>([])

/** dispatch/undo/redo 后的状态应用通知（store 根注册：标脏层 + 差分重算 + dirty 置位）。 */
export interface StudioApplyEvent {
  /** 本次状态变化涉及的层（config/结构面——computeQueue 标脏用）。 */
  layerIds: string[]
  /** segment k/seed 是否变化（变化 → 根重跑分块 → 块集再生 → 全量重算差分）。 */
  segmentChanged: boolean
  /** 是否由 undo/redo/refold 触发（观察态保持现场）。 */
  replay: boolean
}

type ApplyListener = (event: StudioApplyEvent) => void
const listeners = new Set<ApplyListener>()

export function onStudioStateApplied(listener: ApplyListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: StudioApplyEvent): void {
  for (const listener of listeners) listener(event)
}

/** dirty 全集 = 一切 StudioOp（undo 不清——沿 edit 先例；保存清/导出不清归 2.8 读取器）。 */
let dirty = $state(false)

/** 观察派生：当前参数态（= live setParamState 后的 getParamState 同步镜像；面板直读）。 */
export function canUndo(): boolean {
  return cursor > 0
}

export function canRedo(): boolean {
  return cursor < ops.length
}

export function getUndoDepth(): number {
  return cursor
}

/** [improve 2.1] 历史游标（PS 模型数据面：下标 ≥ cursor 的条目 = 已撤销的前向，面板灰显只读）。 */
export function getHistoryCursor(): number {
  return cursor
}

export function getOps(): readonly StudioOp[] {
  return ops
}

export function getCompactions(): readonly CompactionRecord[] {
  return compactions
}

export function isStudioHistoryDirty(): boolean {
  return dirty
}

export function clearStudioHistoryDirty(): void {
  dirty = false
}

export function markStudioHistoryDirty(): void {
  dirty = true
}

// ---------------------------------------------------------------------------
// dispatch（唯一写入入口）
// ---------------------------------------------------------------------------

function affectedLayerIds(op: StudioOp): string[] {
  switch (op.t) {
    case 'layer.create':
      return [] // 新层尚无结果可脏（排布由块集落地触发）
    case 'layer.delete':
      return [op.layerId]
    case 'layer.merge':
      return [op.intoLayerId, ...op.fromLayerIds]
    case 'layer.rename':
      return []
    case 'layer.moveBlocks':
      return [op.toLayerId]
    case 'layer.reorder':
      return [] // 纯视觉序（联合口径恒按层 id 稳定序）——无层需要重算
    case 'layer.config':
      return [...op.layerIds]
    case 'block.override':
      return [] // 块级覆写经根标脏所属层（blockId → 层归属在 live 态解析）
    case 'palette.edit':
      return []
    case 'segment.opts':
      return []
  }
}

function segmentOptsOf(state: StudioParamState): { k: number; seed: number } {
  return { k: state.segment.k, seed: state.segment.seed }
}

function applyOpLive(op: StudioOp, blockIdsInSet?: ReadonlySet<string>): void {
  const state = getParamState()
  switch (op.t) {
    case 'layer.create':
      createLayer(state, { name: op.name, blockIds: op.blockIds, seedConfig: op.seedConfig })
      break
    case 'layer.delete':
      deleteLayer(state, op.layerId)
      break
    case 'layer.merge':
      mergeLayers(state, op.intoLayerId, op.fromLayerIds)
      break
    case 'layer.rename':
      renameLayer(state, op.layerId, op.name)
      break
    case 'layer.moveBlocks':
      moveBlocks(state, op.blockIds, op.toLayerId, blockIdsInSet)
      break
    case 'layer.reorder':
      applyLayerReorder(state, op.order)
      break
    case 'layer.config':
      applyLayerConfig(state, op.layerIds, op.patch)
      break
    case 'block.override':
      setBlockOverride(state, op.blockId, op.patch)
      break
    case 'palette.edit':
      applyPaletteEdit(state, op.edit)
      break
    case 'segment.opts':
      applySegmentOpts(state, op.k, op.seed)
      break
  }
}

/** 合组窗口（滑杆 300ms trailing 链的 2 倍——同目标同字段连拖合并为一个 op 的判定窗）。 */
export const STUDIO_OP_COALESCE_MS = 600

/**
 * 同 groupId 连续滑杆提交合组：末位 op 同组且在窗口内 → 原位改写（layer.config 保留首 op 的
 * prev——撤销回链首值）。lastCoalesceAt 由 dispatch 在每次带 groupId 的入栈后刷新。
 * [improve 2.1] 合组仅发生在 dispatch（此刻游标 ≡ 尾）——原位改写末位 = 改写当前态，语义保持。
 */
function coalesceGroup(op: StudioOp & { groupId?: string }): boolean {
  if (op.groupId === undefined) return false
  const last = ops[ops.length - 1]
  if (last === undefined) return false
  if (last.t !== op.t || (last as StudioOp & { groupId?: string }).groupId !== op.groupId) return false
  if (Date.now() - lastCoalesceAt > STUDIO_OP_COALESCE_MS) return false
  if (op.t === 'layer.config' && last.t === 'layer.config') {
    ops[ops.length - 1] = { ...op, prev: last.prev }
  } else {
    ops[ops.length - 1] = op
  }
  return true
}

let lastCoalesceAt = 0

/**
 * 派发一个 StudioOp：live 应用 → 截断前向（游标非尾 = 覆盖已撤销记录——Owner PS 语义）→
 * 入栈（同组合并）→ 游标置尾 → 压实检查 → 通知。
 * dispatch 前先以 fold 语义应用（live reducer 与 fold reducer 同源）。
 */
export function dispatchStudioOp(
  op: StudioOp,
  opts: { blockIdsInSet?: ReadonlySet<string> } = {},
): void {
  const segmentBefore = segmentOptsOf(getParamState())
  applyOpLive(op, opts.blockIdsInSet)
  dirty = true
  // 游标非尾：前向条目被覆盖（截断）——「强行修改 → 之前的记录被覆盖掉」（Owner 点 2）
  ops.length = cursor
  if (!coalesceGroup(op)) {
    ops.push(op)
    if ((op as StudioOp & { groupId?: string }).groupId !== undefined) lastCoalesceAt = Date.now()
    if (ops.length > STUDIO_UNDO_GROUP_BUDGET) compactOldest()
  }
  cursor = ops.length
  const segmentAfter = segmentOptsOf(getParamState())
  emit({
    layerIds: affectedLayerIds(op),
    segmentChanged: segmentAfter.k !== segmentBefore.k || segmentAfter.seed !== segmentBefore.seed,
    replay: false,
  })
}

// ---------------------------------------------------------------------------
// undo / redo（游标移动 + 重折——列表条目恒不变，improve 2.1）
// ---------------------------------------------------------------------------

/** 折算并整体落位（观察态保持现场——refold 只替换参数态）。 */
function refoldAndLand(opsAfter: readonly StudioOp[]): void {
  const { state } = foldStudioOps(baseSnapshot, opsAfter)
  // 观察态保持现场：逐层保留 visible（fold 态 visible 恒 true——clone 不丢）
  const liveVisible = new Map(getParamState().layers.map((l) => [l.id, l.visible]))
  for (const layer of state.layers) {
    const keep = liveVisible.get(layer.id)
    if (keep !== undefined) layer.visible = keep
  }
  setParamState(state)
}

/** undo：游标回退一步 → refold（op 流不动——前向条目留在列表灰显）。 */
export function undoStudioOp(): boolean {
  if (cursor === 0) return false
  const before = segmentOptsOf(getParamState())
  cursor -= 1
  const popped = ops[cursor] as StudioOp
  refoldAndLand(ops.slice(0, cursor))
  const after = segmentOptsOf(getParamState())
  emit({ layerIds: affectedLayerIds(popped), segmentChanged: before.k !== after.k || before.seed !== after.seed, replay: true })
  return true
}

/** redo：游标前进一步 → refold（op 流不动）。 */
export function redoStudioOp(): boolean {
  if (cursor === ops.length) return false
  const before = segmentOptsOf(getParamState())
  const op = ops[cursor] as StudioOp
  cursor += 1
  refoldAndLand(ops.slice(0, cursor))
  const after = segmentOptsOf(getParamState())
  emit({ layerIds: affectedLayerIds(op), segmentChanged: before.k !== after.k || before.seed !== after.seed, replay: true })
  return true
}

// ---------------------------------------------------------------------------
// 压实（100 组上限：最旧 ops fold 进 baseSnapshot，记边界与 state hash）
// ---------------------------------------------------------------------------

/** 已压实 op 总数（对原 op 流的累计下标——边界记录的原流锚点）。 */
let compactedCount = 0

function compactOldest(): void {
  if (ops.length <= STUDIO_UNDO_GROUP_BUDGET) return
  const drop = ops.length - STUDIO_UNDO_GROUP_BUDGET
  const from = compactedCount
  const to = compactedCount + drop
  const compactedOps = ops.slice(0, drop)
  const folded = foldStudioOps(baseSnapshot, compactedOps)
  baseSnapshot = folded.state
  ops = ops.slice(drop)
  cursor -= drop // [improve 2.1] 游标同步前移（压实仅在 dispatch 游标≡尾时触发——恒为满额回退）
  compactedCount = to
  compactions.push({ from, to, baseStateHash: paramStateHash(folded.state) })
}

export function getBaseSnapshot(): StudioParamState {
  return baseSnapshot
}

/** 压实后 base 的等价性锚点（跨压实边界 undo/redo 等价性验证用）。 */
export function baseStateHash(): string {
  return paramStateHash(baseSnapshot)
}

// ---------------------------------------------------------------------------
// 生命周期挂接（根编排调用）
// ---------------------------------------------------------------------------

/**
 * 新会话 base（进页/换图/打开工程）：历史清空、base = 当前参数态深拷贝。
 * 换图 = 会话级重置（不入历史——守卫走 add-project-files §3 三按钮，沿 2.8 移交面）。
 */
export function resetStudioHistory(base: StudioParamState): void {
  baseSnapshot = cloneParamState(base)
  ops = []
  cursor = 0
  compactions = []
  compactedCount = 0
  dirty = false
}

/** 历史栈永不序列化（gemproj 存 fold 终态；测试复位用）。 */
export function resetHistoryForTests(): void {
  resetStudioHistory({ layers: [], layerSeq: 0, palette: [], segment: { k: 8, seed: 1 } })
}
