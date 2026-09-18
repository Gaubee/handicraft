/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-19 Contract] 手动编辑文档唯一真源（design.md §1 冻结契约）：gems/EditGem[] + 只读
 *    blocks/palette/grid/width/height + 固定四层显隐透明度 + selection；ManualEditHandoff 显式交接。
 * 2. [2026-09-19 Bake] 烘焙隔离：loadFromHandoff 深拷贝快照（toEditGem 逐钻转换、掩码/像素缓冲复制），
 *    此后与工作台零耦合（参数变更不回流；再次送精修 = 覆盖式重载，由调用方确认）。
 * 3. [2026-09-19 Undo] patch 撤销栈（design.md §1 撤销规格）：三原子 add/remove/update（字段级）；
 *    beginStroke/endStroke 合组；预算 100 组裁最旧；新操作清空 redo；单 stroke >2000 钻拒绝。
 * 4. [2026-09-19 Id] 手工钻 id = 'm-' 前缀模块内自增（layout 输出 g##### 命名空间不重叠；防御性跳撞）。
 * 5. [2026-09-19 Pure] 状态模块零 DOM/引擎写入：只消费 engine 公共类型与 toEditGem。
 */

import { toEditGem, type Block, type EditGem, type EngineImage, type Gem, type GridSpec, type Palette } from '$lib/engine'
import { pinAsset, unpinAsset } from '$lib/persistence/assetStore'
import { SvelteSet } from 'svelte/reactivity'

// ---------------------------------------------------------------------------
// 契约类型（design.md §1）
// ---------------------------------------------------------------------------

/** 工作台 → 编辑器显式交接（单向烘焙快照；不复用仅传图片的 handoff）
 *  [add-asset-library C-1 修订 / 6.1] referenceAssetId 替代 referenceDataUrl（[Owner] 直接切换无兼容）：
 *  参考原图是不可变资产，引用不破坏快照语义；消费侧（EditCanvas）经 assetStore 解析 + 四态。 */
export interface ManualEditHandoff {
  gems: Gem[]
  blocks: Block[]
  palette: Palette
  grid: GridSpec
  /** 导出必需（exportSvg 需要） */
  width: number
  height: number
  /** 来源策略/密度/SS 摘要（只读展示） */
  sourceSummary: string
  /** 不可变快照（编辑器深拷贝收下） */
  paintingSnapshot: EngineImage
  /** 参考原图资产引用（若有） */
  referenceAssetId?: string
}

export interface LayerState {
  visible: boolean
  opacity: number
}

export type EditLayerKey = 'painting' | 'reference' | 'blocks' | 'gems'

export interface EditDocument {
  gems: EditGem[]
  /** 只读参考（重分块回工作台用；编辑器不改） */
  blocks: Block[]
  palette: Palette
  grid: GridSpec
  width: number
  height: number
  /** 固定四层（叠序：painting → reference → blocks → gems） */
  layers: Record<EditLayerKey, LayerState>
  selection: SvelteSet<string>
  paintingSnapshot: EngineImage
  /** 参考原图资产引用（[6.1] 异步解析于 EditCanvas；null = 无参考层） */
  referenceAssetId: string | null
  sourceSummary: string
}

// ---------------------------------------------------------------------------
// patch 三原子（design.md §1 撤销栈规格）
// ---------------------------------------------------------------------------

export type EditGemFields = Partial<Pick<EditGem, 'x' | 'y' | 'colorId'>>

/** update：字段级 before/after（只记变更字段，回退/重放对称） */
export interface UpdateChange {
  id: string
  before: EditGemFields
  after: EditGemFields
}

export type EditPatch =
  | { op: 'add'; gems: EditGem[] }
  | { op: 'remove'; items: Array<{ gem: EditGem; index: number }> }
  | { op: 'update'; changes: UpdateChange[] }

interface UndoGroup {
  patches: EditPatch[]
  /** 本组新增钻数（>2000 预算门用） */
  addedCount: number
}

export type PatchResult = { ok: true } | { ok: false; error: string }

/** undo 组预算（超限裁最旧） */
export const UNDO_GROUP_BUDGET = 100
/** 单 stroke/command 新增钻上限（超出拒绝执行，防巨型 patch） */
export const MAX_STROKE_GEMS = 2000
export const MANUAL_ID_PREFIX = 'm-'

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

let doc = $state<EditDocument | null>(null)

/** 撤销/重做栈（普通数组——历史不进渲染图；计数镜像供响应式读取） */
let undoStack: UndoGroup[] = []
let redoStack: UndoGroup[] = []
let undoCount = $state(0)
let redoCount = $state(0)

/** 进行中的 stroke 组（null = 无开启组；无组时 applyPatch 自动成单组） */
let strokeGroup: UndoGroup | null = null

/** 手工钻自增计数（loadFromHandoff 重置；只增不减——撤销不回收 id，防新旧混淆） */
let manualCounter = 0

function defaultLayers(): Record<EditLayerKey, LayerState> {
  return {
    painting: { visible: true, opacity: 1 },
    reference: { visible: true, opacity: 0.6 },
    blocks: { visible: true, opacity: 0.9 },
    gems: { visible: true, opacity: 1 },
  }
}

// 深拷贝助手（烘焙隔离：交接方后续改动不得渗入编辑文档）
function copyBlock(b: Block): Block {
  return {
    ...b,
    colorRgb: [...b.colorRgb] as [number, number, number],
    bbox: { ...b.bbox },
    widthPx: { ...b.widthPx },
    mask: { w: b.mask.w, h: b.mask.h, bits: new Uint8Array(b.mask.bits) },
  }
}

function copyImage(image: EngineImage): EngineImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
}

// ---------------------------------------------------------------------------
// 载入（tasks 1.1 / 3.1）
// ---------------------------------------------------------------------------

/** 当前受保护（pin）的参考资产 id（[6.2] 活动 EditDocument 引用入硬清空保护）。 */
let pinnedReferenceId: string | null = null

/** 交接快照 → 编辑文档：深拷贝一切（钻/块/掩码/色板/网格/像素），重置历史与选择。
 *  [6.2] 挂载 pin 参考资产；再次送精修覆盖时先解除旧引用再挂新引用。 */
export function loadFromHandoff(payload: ManualEditHandoff): void {
  manualCounter = 0
  undoStack = []
  redoStack = []
  undoCount = 0
  redoCount = 0
  strokeGroup = null
  const nextReferenceId = payload.referenceAssetId ?? null
  if (pinnedReferenceId && pinnedReferenceId !== nextReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = nextReferenceId
  if (nextReferenceId) pinAsset(nextReferenceId)
  doc = {
    gems: payload.gems.map(toEditGem),
    blocks: payload.blocks.map(copyBlock),
    palette: payload.palette.map((c) => ({ ...c })),
    grid: { ...payload.grid },
    width: payload.width,
    height: payload.height,
    layers: defaultLayers(),
    selection: new SvelteSet<string>(),
    paintingSnapshot: copyImage(payload.paintingSnapshot),
    referenceAssetId: payload.referenceAssetId ?? null,
    sourceSummary: payload.sourceSummary,
  }
}

// ---------------------------------------------------------------------------
// 读取器
// ---------------------------------------------------------------------------

export function getEditDoc(): EditDocument | null {
  return doc
}

export function getSourceSummary(): string {
  return doc?.sourceSummary ?? ''
}

export function getGemCount(): number {
  return doc?.gems.length ?? 0
}

/** 有未导出修改（≈撤销栈非空；「再次送精修」覆盖确认与摘要徽标共用口径） */
export function hasEdits(): boolean {
  return undoCount > 0
}

export function canUndo(): boolean {
  return undoCount > 0
}

export function canRedo(): boolean {
  return redoCount > 0
}

export function getUndoDepths(): { undo: number; redo: number } {
  return { undo: undoCount, redo: redoCount }
}

/** 手工钻 id 分配：'m-' 前缀自增；防御性跳过与既有 id 撞名（契约上命名空间不重叠）。 */
export function nextManualId(): string {
  let id = `${MANUAL_ID_PREFIX}${++manualCounter}`
  while (doc?.gems.some((g) => g.id === id)) id = `${MANUAL_ID_PREFIX}${++manualCounter}`
  return id
}

// ---------------------------------------------------------------------------
// 图层 / 选择（固定四层；选择为渲染/编辑过滤，不改归属语义）
// ---------------------------------------------------------------------------

export function setLayerVisible(layer: EditLayerKey, visible: boolean): void {
  if (!doc) return
  doc.layers[layer].visible = visible
}

export function setLayerOpacity(layer: EditLayerKey, opacity: number): void {
  if (!doc) return
  doc.layers[layer].opacity = Math.min(1, Math.max(0, opacity))
}

export function setSelection(ids: Iterable<string>): void {
  if (!doc) return
  doc.selection.clear()
  for (const id of ids) doc.selection.add(id)
}

export function toggleSelection(id: string): void {
  if (!doc) return
  if (doc.selection.has(id)) doc.selection.delete(id)
  else doc.selection.add(id)
}

export function clearSelection(): void {
  doc?.selection.clear()
}

// ---------------------------------------------------------------------------
// patch 应用（正放）与撤销/重做（逆放）
// ---------------------------------------------------------------------------

function applyForward(patch: EditPatch): void {
  if (!doc) return
  switch (patch.op) {
    case 'add':
      doc.gems.push(...patch.gems)
      break
    case 'remove': {
      const ids = new Set(patch.items.map((it) => it.gem.id))
      doc.gems = doc.gems.filter((g) => !ids.has(g.id))
      break
    }
    case 'update': {
      const byId = new Map(doc.gems.map((g) => [g.id, g] as const))
      for (const change of patch.changes) {
        const gem = byId.get(change.id)
        if (!gem) continue
        Object.assign(gem, change.after)
      }
      break
    }
  }
}

function applyInverse(patch: EditPatch): void {
  if (!doc) return
  switch (patch.op) {
    case 'add': {
      const ids = new Set(patch.gems.map((g) => g.id))
      doc.gems = doc.gems.filter((g) => !ids.has(g.id))
      break
    }
    case 'remove':
      // 按原索引升序回插：整组回退（逆序 undo）时精确复原原数组顺序
      for (const it of [...patch.items].sort((a, b) => a.index - b.index)) {
        const i = Math.min(it.index, doc.gems.length)
        doc.gems.splice(i, 0, it.gem)
      }
      break
    case 'update': {
      const byId = new Map(doc.gems.map((g) => [g.id, g] as const))
      for (const change of patch.changes) {
        const gem = byId.get(change.id)
        if (!gem) continue
        Object.assign(gem, change.before)
      }
      break
    }
  }
}

/** 提交一个 undo 组入栈：预算裁最旧 + 清空 redo（新操作使重放历史失效）。 */
function commitGroup(group: UndoGroup): void {
  if (group.patches.length === 0) return
  undoStack.push(group)
  while (undoStack.length > UNDO_GROUP_BUDGET) undoStack.shift()
  undoCount = undoStack.length
  redoStack = []
  redoCount = 0
}

/**
 * 应用一个 patch（立即生效并记账）。
 * - stroke 内（beginStroke 后）：并入当前组，endStroke 时一次提交；
 * - stroke 外：自动成单组即刻提交（命令操作的默认形态）。
 * - 超 2000 钻拒绝：返回错误且不产生部分执行（doc 不变）。
 */
export function applyPatch(patch: EditPatch): PatchResult {
  if (!doc) return { ok: false, error: '编辑文档未载入' }
  if (patch.op === 'add') {
    if (patch.gems.length > MAX_STROKE_GEMS) {
      return { ok: false, error: `单次操作新增 ${patch.gems.length} 钻超过上限 ${MAX_STROKE_GEMS}，已拒绝执行` }
    }
    const current = strokeGroup
    if (current && current.addedCount + patch.gems.length > MAX_STROKE_GEMS) {
      return {
        ok: false,
        error: `本次笔划累计将新增 ${current.addedCount + patch.gems.length} 钻，超过上限 ${MAX_STROKE_GEMS}，已拒绝该批`,
      }
    }
  }

  applyForward(patch)

  // 新操作即刻清空 redo（文档已变，重放历史失效）——不等 stroke 提交，
  // 避免 stroke 中途对陈旧 redo 栈重放造成状态分叉
  redoStack = []
  redoCount = 0

  if (strokeGroup) {
    strokeGroup.patches.push(patch)
    strokeGroup.addedCount += patch.op === 'add' ? patch.gems.length : 0
  } else {
    commitGroup({ patches: [patch], addedCount: patch.op === 'add' ? patch.gems.length : 0 })
  }
  return { ok: true }
}

/** 开启 stroke 组（pointerdown→up 的连续编辑合并为一个 undo 单元）。 */
export function beginStroke(): void {
  if (!doc) return
  if (!strokeGroup) strokeGroup = { patches: [], addedCount: 0 }
}

/** 结束并提交 stroke 组（空组丢弃；redo 已在每个 patch 应用时清空）。 */
export function endStroke(): void {
  const group = strokeGroup
  strokeGroup = null
  if (group) commitGroup(group)
}

/** 撤销最近一组；成功返回 true。 */
export function undo(): boolean {
  if (!doc || undoStack.length === 0) return false
  const group = undoStack.pop()!
  for (let i = group.patches.length - 1; i >= 0; i--) applyInverse(group.patches[i])
  redoStack.push(group)
  undoCount = undoStack.length
  redoCount = redoStack.length
  return true
}

/** 重放最近被撤销的组；成功返回 true。 */
export function redo(): boolean {
  if (!doc || redoStack.length === 0) return false
  const group = redoStack.pop()!
  for (const patch of group.patches) applyForward(patch)
  undoStack.push(group)
  undoCount = undoStack.length
  redoCount = redoStack.length
  return true
}

// ---------------------------------------------------------------------------
// 测试支持
// ---------------------------------------------------------------------------

/** 测试专用：整体复位（文档/历史/计数器；[6.2] 卸载 = 解除参考资产 pin）。 */
export function resetEditForTests(): void {
  if (pinnedReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = null
  doc = null
  undoStack = []
  redoStack = []
  undoCount = 0
  redoCount = 0
  strokeGroup = null
  manualCounter = 0
}
