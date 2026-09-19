/*
 * Orthogonal intents (max 6):
 * 1. [2026-09-19 Contract] 专家工作台文档唯一真源（design.md §1 冻结契约）：gems/EditGem[] + 只读
 *    blocks/palette/grid/width/height + 固定四层显隐透明度 + selection；ManualEditHandoff 显式交接。
 * 2. [2026-09-19 Bake] 烘焙隔离：loadFromHandoff 深拷贝快照（toEditGem 逐钻转换、掩码/像素缓冲复制），
 *    此后与排钻设计零耦合（参数变更不回流；再次送精修 = 覆盖式重载，由调用方确认）。
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
 */

import { toEditGem, type Block, type EditGem, type EngineImage, type Gem, type GridSpec, type Palette } from '$lib/engine'
import {
  closeProject,
  getAsset,
  getProject,
  ingestProjectAsset,
  openProject,
  pinAsset,
  unpinAsset,
  updateProjectAsset,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import {
  dataUrlToPainting,
  fromSerializedBlock,
  paintingToDataUrl,
  parseGemdoc,
  serializeGemdoc,
  type GemdocOrigin,
  type GemprojReference,
} from '$lib/persistence/projectFile'
import { PROJECT_MIME, type ProjectLease, type ProjectSummary } from '$lib/persistence/projectTypes'
import { APP_VERSION } from '$lib/appVersion'
import { SvelteSet } from 'svelte/reactivity'

// ---------------------------------------------------------------------------
// 契约类型（design.md §1）
// ---------------------------------------------------------------------------

/** 排钻设计 → 编辑器显式交接（单向烘焙快照；不复用仅传图片的 handoff）
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
  /** 只读参考（重分块回排钻设计用；编辑器不改） */
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

/** [3.2 dirty] 自上次保存以来有修改（A.2.3 口径；详见文件头意图 6）。 */
let dirty = $state(false)

/** 撤销/重做栈（普通数组——历史不进渲染图；计数镜像供响应式读取） */
let undoStack: UndoGroup[] = []
let redoStack: UndoGroup[] = []
let undoCount = $state(0)
let redoCount = $state(0)

/** 进行中的 stroke 组（null = 无开启组；无组时 applyPatch 自动成单组） */
let strokeGroup: UndoGroup | null = null

/** 手工钻自增计数（loadFromHandoff 重置 / loadFromGemdoc 从 gems 派生；只增不减）。 */
let manualCounter = 0

/** [3.2] 当前文档对应的库节点 blobKey（CAS 换绑的 expectedBlobKey 真源）。 */
let savedBlobKey: string | null = null

/** [3.2] gemdoc 打开租约（design §9.1 B5：gemdoc 仅 pin reference；ownerId 宿主稳定）。 */
let gemdocLease: ProjectLease | null = null

/** lease ownerId（design §9.1 B5 R3：宿主提供且宿主生命周期内稳定）。 */
export const EDIT_PROJECT_OWNER_ID = 'edit-page'

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
// 载入（tasks 1.1 / 3.1 / add-project-files 3.2）
// ---------------------------------------------------------------------------

/** 当前受保护（pin）的参考资产 id（[6.2] 活动 EditDocument 引用入硬清空保护）。 */
let pinnedReferenceId: string | null = null

/** 释放 gemdoc 租约（幂等；closeProject 同步体——置空先行防重入）。 */
function releaseGemdocLease(): void {
  const lease = gemdocLease
  gemdocLease = null
  if (lease) void closeProject(lease)
}

/** 交接快照 → 编辑文档：深拷贝一切（钻/块/掩码/色板/网格/像素），重置历史与选择。
 *  [6.2] 挂载 pin 参考资产；再次送精修覆盖时先解除旧引用再挂新引用。
 *  [add-project-files 3.2] meta 录入溯源/命名（缺省 origin='studio-bake'——送精修主链零改动）；
 *  覆盖 = 未保存新文档（dirty=true，docId 置空）；旧 gemdoc 租约随覆盖释放。 */
export function loadFromHandoff(payload: ManualEditHandoff, meta: LoadDocumentMeta = {}): void {
  manualCounter = 0
  undoStack = []
  redoStack = []
  redoCount = 0
  undoCount = 0
  strokeGroup = null
  const nextReferenceId = payload.referenceAssetId ?? null
  if (pinnedReferenceId && pinnedReferenceId !== nextReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = nextReferenceId
  if (nextReferenceId) pinAsset(nextReferenceId)
  releaseGemdocLease()
  savedBlobKey = null
  dirty = true
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
    docId: null,
    name: meta.name ?? `精修 · ${payload.sourceSummary}`,
    createdAt: Date.now(),
    savedAt: null,
    provenance: {
      origin: meta.origin ?? 'studio-bake',
      ...(meta.sourceAssetId !== undefined ? { sourceAssetId: meta.sourceAssetId } : {}),
      ...(meta.gemprojAssetId !== undefined ? { gemprojAssetId: meta.gemprojAssetId } : {}),
    },
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

/** [3.2 dirty 口径（A.2.3）] 未保存 = 自上次保存以来有修改（patch/图层/重命名）。
 *  守卫、●未保存徽标、「再次送精修」覆盖确认的共用出口；undo 不影响（撤销≠保存）；
 *  导出不清除。canUndo/canRedo 回归纯撤销可用性。 */
export function isEditDirty(): boolean {
  return dirty
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
  dirty = true
}

export function setLayerOpacity(layer: EditLayerKey, opacity: number): void {
  if (!doc) return
  doc.layers[layer].opacity = Math.min(1, Math.max(0.01, opacity))
  dirty = true
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
  dirty = true

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
// gemdoc 保存 / 打开 / 关闭（add-project-files tasks 3.2/3.4；design §1.2/§4/§9.1 B5）
// ---------------------------------------------------------------------------

/** gemdoc 打开/保存失败的可辨错误（reason 供调用方分流提示；文件层 typed error 原样上浮）。 */
export class EditGemdocError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'no-document'
      | 'missing'
      | 'trashed'
      | 'blob-missing'
      | 'wrong-kind',
  ) {
    super(message)
    this.name = 'EditGemdocError'
  }
}

export type SaveGemdocStatus = 'created' | 'updated'

export interface SaveGemdocResult {
  status: SaveGemdocStatus
  docId: string
  /** 实际落库名（重名自动后缀后的节点名去扩展名）。 */
  name: string
}

export interface SaveGemdocOptions {
  /** 保存时重命名（trim；空串回退当前名）。 */
  name?: string
}

function gemdocSummaryOf(current: EditDocument): ProjectSummary {
  // [gem-catalog 1.4] ss 键随 GridSpec.ss 过渡读面清零而删除（规格身份归 canonical specKey 面）
  return { gemCount: current.gems.length }
}

/** 当前文档 → gemdoc 文本（保存与导出共用装配；reference 名经库解析，missing 容忍回退）。 */
async function serializeCurrentGemdoc(current: EditDocument): Promise<string> {
  let reference: GemprojReference | undefined
  if (current.referenceAssetId !== null) {
    const node = await getAsset(current.referenceAssetId).catch(() => null)
    reference = { assetId: current.referenceAssetId, name: node?.name ?? '参考原图' }
  }
  const provenance = current.provenance
  return serializeGemdoc({
    appVersion: APP_VERSION,
    createdAt: current.createdAt,
    savedAt: Date.now(),
    name: current.name,
    width: current.width,
    height: current.height,
    grid: current.grid,
    palette: current.palette,
    gems: current.gems,
    blocks: current.blocks,
    layers: current.layers,
    painting: { mime: 'image/png' as const, dataUrl: paintingToDataUrl(current.paintingSnapshot) },
    ...(reference !== undefined ? { reference } : {}),
    provenance: {
      origin: provenance.origin,
      sourceSummary: current.sourceSummary,
      ...(provenance.sourceAssetId !== undefined ? { sourceAssetId: provenance.sourceAssetId } : {}),
      ...(provenance.gemprojAssetId !== undefined ? { gemprojAssetId: provenance.gemprojAssetId } : {}),
    },
  })
}

/**
 * 保存（design §1.2 C.1.4 写路径）：serializeGemdoc → 首次 ingestProjectAsset（sys-projects，
 * 记 docId）/ 再次 updateProjectAsset CAS 换绑（savedBlobKey 为 expected）→ dirty=false。
 * CAS 冲突（ProjectConflictError）与文件校验错误（ProjectFile*）原样上浮，dirty 保持。
 */
export async function saveGemdoc(options: SaveGemdocOptions = {}): Promise<SaveGemdocResult> {
  const current = doc
  if (current === null) throw new EditGemdocError('编辑文档未载入，无法保存。', 'no-document')
  if (options.name !== undefined) {
    const trimmed = options.name.trim()
    if (trimmed !== '') current.name = trimmed
  }
  const text = await serializeCurrentGemdoc(current)
  const blob = new Blob([text], { type: PROJECT_MIME.gemdoc })
  const summary = gemdocSummaryOf(current)
  if (current.docId === null || savedBlobKey === null) {
    const ingested = await ingestProjectAsset({
      blob,
      name: `${current.name}.gemdoc`,
      projectKind: 'gemdoc',
      summary,
    })
    current.docId = ingested.node.id
    current.name = ingested.node.name.replace(/\.gemdoc$/, '')
    current.savedAt = Date.now()
    savedBlobKey = ingested.node.blobKey
    dirty = false
    return { status: 'created', docId: ingested.node.id, name: current.name }
  }
  const updated = await updateProjectAsset(current.docId, { expectedBlobKey: savedBlobKey, bytes: blob, summary })
  current.savedAt = Date.now()
  savedBlobKey = updated.blobKey
  dirty = false
  return { status: 'updated', docId: updated.id, name: current.name }
}

/** 另存为（fork，design §2：不绑既有节点——恒 ingest 新节点并接管 docId）。 */
export async function saveGemdocAs(name: string): Promise<SaveGemdocResult> {
  const current = doc
  if (current === null) throw new EditGemdocError('编辑文档未载入，无法另存为。', 'no-document')
  const trimmed = name.trim()
  if (trimmed !== '') current.name = trimmed
  const text = await serializeCurrentGemdoc(current)
  const ingested = await ingestProjectAsset({
    blob: new Blob([text], { type: PROJECT_MIME.gemdoc }),
    name: `${current.name}.gemdoc`,
    projectKind: 'gemdoc',
    summary: gemdocSummaryOf(current),
  })
  current.docId = ingested.node.id
  current.name = ingested.node.name.replace(/\.gemdoc$/, '')
  current.savedAt = Date.now()
  savedBlobKey = ingested.node.blobKey
  dirty = false
  return { status: 'created', docId: ingested.node.id, name: current.name }
}

export interface GemdocExport {
  blob: Blob
  filename: string
}

/** 导出精修文件（.gemdoc）装配：只序列化不落库——导出不清 dirty、不建库节点。 */
export async function buildGemdocExport(): Promise<GemdocExport> {
  const current = doc
  if (current === null) throw new EditGemdocError('编辑文档未载入，无法导出。', 'no-document')
  const text = await serializeCurrentGemdoc(current)
  return { blob: new Blob([text], { type: PROJECT_MIME.gemdoc }), filename: `${current.name}.gemdoc` }
}

/** 'm-' 手工钻计数器从 gems 派生（design §1.2：取 max(m-编号)；nextManualId 自增得 max+1，跳撞兜底仍在）。 */
function deriveManualCounter(gems: ReadonlyArray<{ id: string }>): number {
  let max = 0
  for (const gem of gems) {
    const match = /^m-(\d+)$/.exec(gem.id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return max
}

function copyLayers(layers: Record<EditLayerKey, LayerState>): Record<EditLayerKey, LayerState> {
  const out = {} as Record<EditLayerKey, LayerState>
  for (const key of ['painting', 'reference', 'blocks', 'gems'] as const) {
    out[key] = { visible: layers[key].visible, opacity: layers[key].opacity }
  }
  return out
}

/**
 * 打开精修项目（tasks 3.4 / design §7.4）：节点校验 → 读 blob → parseGemdoc（mime 交叉）→
 * painting PNG 解码 → 开租约（gemdoc 仅 pin reference，§9.1 B5）→ 装载干净态（dirty=false）。
 * 覆盖当前文档：旧 bool-pin/旧租约在 parse 成功后才释放（失败路径旧文档保持原样）。
 * manualCounter 从 gems 派生；撤销栈/选择重置（不入文件语义）。
 */
export async function loadFromGemdoc(assetId: string): Promise<void> {
  const node = await getProject(assetId)
  if (node === null || node.projectKind !== 'gemdoc') {
    throw new EditGemdocError(
      node === null ? '精修项目不存在（可能已被删除）。' : `目标不是精修项目（.gemdoc），而是 ${node.projectKind}。`,
      node === null ? 'missing' : 'wrong-kind',
    )
  }
  if (node.trashedAt !== undefined) {
    throw new EditGemdocError('精修项目已在回收站，可还原后再打开。', 'trashed')
  }
  const blob = await getImageBlob(node.blobKey).catch(() => null)
  if (blob === null) throw new EditGemdocError('精修项目的文件内容已缺失（物理记录丢失）。', 'blob-missing')
  const text = new TextDecoder().decode(await blob.arrayBuffer())
  const file = parseGemdoc(text, { mime: node.mime })
  const painting = await dataUrlToPainting(file.painting.dataUrl)
  // 先开新租约再释放旧文档引用：openProject 失败时旧文档与其保护完全保持
  const lease = await openProject(
    assetId,
    'gemdoc',
    EDIT_PROJECT_OWNER_ID,
    file.reference ? [file.reference.assetId] : [],
  )
  if (pinnedReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = null
  releaseGemdocLease()
  gemdocLease = lease
  savedBlobKey = node.blobKey
  manualCounter = deriveManualCounter(file.gems)
  undoStack = []
  redoStack = []
  undoCount = 0
  redoCount = 0
  strokeGroup = null
  dirty = false
  doc = {
    gems: file.gems.map((g) => ({ ...g })),
    blocks: file.blocks.map(fromSerializedBlock),
    palette: file.palette.map((c) => ({ ...c })),
    grid: { ...file.grid },
    width: file.width,
    height: file.height,
    layers: copyLayers(file.layers),
    selection: new SvelteSet<string>(),
    paintingSnapshot: painting,
    referenceAssetId: file.reference?.assetId ?? null,
    sourceSummary: file.provenance.sourceSummary,
    docId: assetId,
    name: file.name,
    createdAt: file.createdAt,
    savedAt: file.savedAt,
    provenance: {
      origin: file.provenance.origin,
      ...(file.provenance.sourceAssetId !== undefined ? { sourceAssetId: file.provenance.sourceAssetId } : {}),
      ...(file.provenance.gemprojAssetId !== undefined ? { gemprojAssetId: file.provenance.gemprojAssetId } : {}),
    },
  }
}

/** 关闭文档：释放租约（幂等）与 bool-pin、清空文档/历史/dirty。守卫（dirty 三按钮）归调用方。 */
export async function closeEditDocument(): Promise<void> {
  releaseGemdocLease()
  if (pinnedReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = null
  savedBlobKey = null
  doc = null
  dirty = false
  undoStack = []
  redoStack = []
  undoCount = 0
  redoCount = 0
  strokeGroup = null
  manualCounter = 0
}

// ---------------------------------------------------------------------------
// 项目身份读取器（摘要条 [▦]名● 消费）
// ---------------------------------------------------------------------------

export function getEditProjectIdentity(): { docId: string | null; name: string; savedAt: number | null } | null {
  return doc === null ? null : { docId: doc.docId, name: doc.name, savedAt: doc.savedAt }
}

/** 重命名文档（入 gemdoc name 字段 → 变更即 dirty）。 */
export function setEditDocName(name: string): void {
  if (!doc) return
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === doc.name) return
  doc.name = trimmed
  dirty = true
}

// ---------------------------------------------------------------------------
// 测试支持
// ---------------------------------------------------------------------------

/** 测试专用：整体复位（文档/历史/计数器；[6.2] 卸载 = 解除参考资产 pin；[3.2] 释放租约/CAS 键/dirty）。 */
export function resetEditForTests(): void {
  releaseGemdocLease()
  if (pinnedReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = null
  savedBlobKey = null
  doc = null
  dirty = false
  undoStack = []
  redoStack = []
  undoCount = 0
  redoCount = 0
  strokeGroup = null
  manualCounter = 0
}
