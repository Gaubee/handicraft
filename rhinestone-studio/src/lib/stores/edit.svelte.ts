/*
 * Orthogonal intents (max 6):
 * 1. [2026-09-19 Contract] 专家工作台文档唯一真源（design.md §1 冻结契约）：gems/EditGem[] + 只读
 *    blocks/palette/grid/width/height + 固定四层显隐透明度 + selection；ManualEditHandoff 显式交接。
 * 2. [2026-09-19 Bake] 烘焙隔离：loadFromHandoff 深拷贝快照（toEditGem 逐钻转换、掩码/像素缓冲复制），
 *    此后与排钻工作台零耦合（参数变更不回流；再次送精修 = 覆盖式重载，由调用方确认）。
 * 3. [2026-09-19 Undo] patch 撤销栈（design.md §1 撤销规格）：三原子 add/remove/update（字段级）；
 *    beginStroke/endStroke 合组；预算 100 组裁最旧；新操作清空 redo；单 stroke >2000 钻拒绝。
 * 4. [2026-09-19 Id] 手工钻 id = 'm-' 前缀模块内自增（layout 输出 g##### 命名空间不重叠；防御性跳撞）；
 *    gemdoc 打开时计数器从 gems 派生 max(m-编号)（design §1.2，nextManualId 自增至 max+1）。
 * 5. [2026-09-19 Pure] 状态模块零 DOM/引擎写入：只消费 engine 公共类型与 toEditGem
 *    （[add-project-files 3.2] 例外：gemdoc 编解码经 projectFile 的 canvas 委托助手，序列化层职责）。
 * 6. [add-project-files 3.2] 项目身份 + dirty 连锁（design §1.2 A.2.3）：docState 增
 *    {docId, name, createdAt, savedAt, provenance}；dirty = 自上次保存以来有修改
 *    （loadFromHandoff/新建 → true；保存成功 → false；导出不清；undo 不影响）——
 *    守卫/徽标/覆盖确认消费点一律读 dirty（isEditDirty），undoCount 回归纯撤销可用性。
 *    saveGemdoc = serializeGemdoc → 首次 ingestProjectAsset(sys-projects) / 再次 CAS 换绑；
 *    loadFromGemdoc = lease（gemdoc 仅 pin reference）→ parseGemdoc → 干净态装载；
 *    撤销栈/selection 永不入文件（两格式一致）。
 * 7. [2026-09-20 A 轨 2.4/2.5 拆分（rename-and-expert-workbench design §2.2）] 文档状态位域
 *    （dirty/savedBlobKey/gemdocLease/EDIT_PROJECT_OWNER_ID + 身份读取器/重命名）已拆出 →
 *    src/lib/edit/documentStatus.svelte.ts；载入 + gemdoc 生命周期域（loadFromHandoff/pin 编排 +
 *    保存/打开/关闭/另存为/导出）已拆出 → src/lib/edit/gemdocLifecycle.svelte.ts（payload 红线薄
 *    wrapper——owner = studio-layers replay/handoff gate，本仓消费接线归 5.9）。公共面均经本根
 *    re-export 兼容；根保留核心 $state 宿主职责（doc/撤销栈/计数器）与 patch/undo/选择/图层域。
 */

import { type Block, type EditGem, type EngineImage, type Gem, type GridSpec, type Palette, type PhysicalCanvas } from '$lib/engine'
import type { GemdocOrigin } from '$lib/persistence/projectFile'
import { SvelteSet } from 'svelte/reactivity'
import {
  clearEditDirty,
  markEditDirty,
  releaseGemdocLease,
  setSavedBlobKey,
} from '$lib/edit/documentStatus.svelte'
import { clearPinnedReference } from '$lib/edit/gemdocLifecycle.svelte'

// ---------------------------------------------------------------------------
// 契约类型（design.md §1）
// ---------------------------------------------------------------------------

/** 排钻工作台 → 编辑器显式交接（单向烘焙快照；不复用仅传图片的 handoff）
 *  [add-asset-library C-1 修订 / 6.1] referenceAssetId 替代 referenceDataUrl（[Owner] 直接切换无兼容）：
 *  参考原图是不可变资产，引用不破坏快照语义；消费侧（EditCanvas）经 assetStore 解析 + 四态。
 *  [studio-layers 1.4 payload v2] + physicalCanvas?: PhysicalCanvas（画幅物理锚——缺席 = v1 形态
 *  载荷，loadFromHandoff 以 grid.pixelsPerMm 合成 default 锚向后兼容 quickLayout 直到其同步补锚）；
 *  gems = 各层 concat 逐钻物化规格（Gem 必含 shapeId/diameterMm）；grid 保留为参考网格（画幅级，
 *  单 grid 不再是唯一径源——逐钻规格字段即物理真源）。 */
export interface ManualEditHandoff {
  gems: Gem[]
  blocks: Block[]
  palette: Palette
  grid: GridSpec
  /** 导出必需（exportSvg 需要） */
  width: number
  height: number
  /** 来源层语法摘要（`N 层 · 共 X 钻 · 主规格 …`——只读展示） */
  sourceSummary: string
  /** 不可变快照（编辑器深拷贝收下） */
  paintingSnapshot: EngineImage
  /** 参考原图资产引用（若有） */
  referenceAssetId?: string
  /** 画幅物理锚（v2 构造方写入；v1 形态载荷无键 = default 锚合成，不静默） */
  physicalCanvas?: PhysicalCanvas
}

/**
 * 缺省锚合成（payload v2 单源）：画幅无 declared mm 时按参考网格 pixelsPerMm 反推 mm——
 * `anchorSource:'default'` 显式（回退可见）；grid.pixelsPerMm 反推保证与参考网格语义一致。
 */
export function defaultPhysicalCanvasOf(widthPx: number, heightPx: number, pixelsPerMm: number): PhysicalCanvas {
  return { widthMm: widthPx / pixelsPerMm, heightMm: heightPx / pixelsPerMm, anchorSource: 'default' }
}

export interface LayerState {
  visible: boolean
  opacity: number
}

export type EditLayerKey = 'painting' | 'reference' | 'blocks' | 'gems'

/**
 * 文档溯源（add-project-files design §1.2 provenance，仅展示）：
 * 序列化时与文档 sourceSummary 合成 gemdoc 的 provenance 字段；sourceSummary 单源在文档上。
 */
export interface EditProvenance {
  origin: GemdocOrigin
  sourceAssetId?: string
  gemprojAssetId?: string
}

export interface EditDocument {
  gems: EditGem[]
  /** 只读参考（重分块回排钻工作台用；编辑器不改） */
  blocks: Block[]
  palette: Palette
  grid: GridSpec
  width: number
  height: number
  /** 固定四层（叠序：painting → reference → blocks → gems） */
  layers: Record<EditLayerKey, LayerState>
  selection: SvelteSet<string>
  paintingSnapshot: EngineImage
  /** [studio-layers 1.4] 画幅物理锚（装载后恒有：payload/gemdoc 缺席时 default 锚合成显式）。 */
  physicalCanvas: PhysicalCanvas
  /** 参考原图资产引用（[6.1] 异步解析于 EditCanvas；null = 无参考层） */
  referenceAssetId: string | null
  sourceSummary: string
  /** [add-project-files 3.2] 项目身份：素材库 AssetProject 节点 id（null = 未保存新文档）。 */
  docId: string | null
  /** 文档名（保存节点名 = `${name}.gemdoc`；首次保存可改名）。 */
  name: string
  /** 文档创建时间戳（gemdoc 打开后沿用文件值；跨保存稳定）。 */
  createdAt: number
  /** 最近一次保存成功时间戳（null = 从未保存）。 */
  savedAt: number | null
  provenance: EditProvenance
}

/** loadFromHandoff 的溯源/命名元数据（缺省 origin='studio-bake'——送精修主链不传即旧行为）。 */
export interface LoadDocumentMeta {
  origin?: GemdocOrigin
  sourceAssetId?: string
  gemprojAssetId?: string
  /** 新文档名（缺省 `精修 · <来源摘要>`，首次保存弹命名预填）。 */
  name?: string
}

// ---------------------------------------------------------------------------
// patch 三原子（design.md §1 撤销栈规格）
// ---------------------------------------------------------------------------

/** update patch 白名单（gem-catalog engine gate 1.4：x/y/colorId + 规格物化字段——
 *  rotationDeg 随附（非身份）；assetId 不入白名单——custom 引用只经 ingest/另存副本路径变更）。 */
export type EditGemFields = Partial<Pick<EditGem, 'x' | 'y' | 'colorId' | 'shapeId' | 'diameterMm' | 'rotationDeg'>>

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

/** 手工钻自增计数（loadFromHandoff 重置 / loadFromGemdoc 从 gems 派生；只增不减）。 */
let manualCounter = 0

// —— 内部协作面（仅拆分子模块 gemdocLifecycle 消费；非公共 API，签名不冻结） ——

/** 装载域写 doc（loadFromHandoff/loadFromGemdoc 装配 / closeEditDocument 复位）。 */
export function setEditDocument(next: EditDocument | null): void {
  doc = next
}

/** 装载域整体复位撤销/重做栈（载入/覆盖/关闭路径；五项赋值互不依赖，与原内联序列等价）。 */
export function resetUndoHistory(): void {
  undoStack = []
  redoStack = []
  undoCount = 0
  redoCount = 0
  strokeGroup = null
}

/** 装载域写手工钻计数器（loadFromHandoff 归零 / loadFromGemdoc 从 gems 派生 / 关闭复位）。 */
export function setManualCounter(value: number): void {
  manualCounter = value
}

// ---------------------------------------------------------------------------
// 载入 + gemdoc 生命周期域（A 轨 2.4 已拆出 → src/lib/edit/gemdocLifecycle.svelte.ts；
// payload 红线薄 wrapper——loadFromHandoff v2 消费/EditDocument·gemdoc schema 与 round-trip
// 的唯一修改 owner = studio-layers replay/handoff gate；公共面经根 re-export 兼容）
// ---------------------------------------------------------------------------

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
// [3.2] 图层显隐/透明度 = gemdoc 序列化字段（design §1.2 文档态）→ 变更即 dirty；
// 不透明度下界 0.01（格式值域 (0,1]，与序列化层同口径——0 与 0.01 视觉同为全透明）。
// ---------------------------------------------------------------------------

export function setLayerVisible(layer: EditLayerKey, visible: boolean): void {
  if (!doc) return
  doc.layers[layer].visible = visible
  markEditDirty()
}

export function setLayerOpacity(layer: EditLayerKey, opacity: number): void {
  if (!doc) return
  doc.layers[layer].opacity = Math.min(1, Math.max(0.01, opacity))
  markEditDirty()
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

  // patch 已生效 = 自上次保存以来有修改（A.2.3 dirty 口径；stroke 中途也算——内容已变）
  markEditDirty()

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
// gemdoc 生命周期域（A 轨 2.4 已拆出 → src/lib/edit/gemdocLifecycle.svelte.ts）
// 公共面经根 re-export 兼容；payload 红线见「载入 + gemdoc 生命周期域」节注
// ---------------------------------------------------------------------------

// 公共导出面 re-export（消费方 import 路径与签名零变化；A 轨 2.4 零行为验收面）
export {
  loadFromHandoff,
  EditGemdocError,
  type SaveGemdocStatus,
  type SaveGemdocResult,
  type SaveGemdocOptions,
  saveGemdoc,
  saveGemdocAs,
  type GemdocExport,
  buildGemdocExport,
  loadFromGemdoc,
  closeEditDocument,
} from '$lib/edit/gemdocLifecycle.svelte'

// ---------------------------------------------------------------------------
// 文档状态位域（A 轨 2.5 已拆出 → src/lib/edit/documentStatus.svelte.ts；公共面经根 re-export 兼容）
// ---------------------------------------------------------------------------

// 公共导出面 re-export（消费方 import 路径与签名零变化；A 轨 2.5 零行为验收面）
export {
  EDIT_PROJECT_OWNER_ID,
  isEditDirty,
  getEditProjectIdentity,
  setEditDocName,
} from '$lib/edit/documentStatus.svelte'

// ---------------------------------------------------------------------------
// 测试支持
// ---------------------------------------------------------------------------

/** 测试专用：整体复位（文档/历史/计数器；[6.2] 卸载 = 解除参考资产 pin；[3.2] 释放租约/CAS 键/dirty）。 */
export function resetEditForTests(): void {
  releaseGemdocLease()
  clearPinnedReference()
  setSavedBlobKey(null)
  doc = null
  clearEditDirty()
  undoStack = []
  redoStack = []
  undoCount = 0
  redoCount = 0
  strokeGroup = null
  manualCounter = 0
}
