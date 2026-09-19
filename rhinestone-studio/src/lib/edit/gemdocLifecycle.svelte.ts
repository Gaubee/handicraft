/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-20 rename-and-expert-workbench A 2.4] 载入域（原 stores/edit.svelte.ts :208-263
 *    loadFromHandoff/pin 编排）+ gemdoc 生命周期域（:479-716 保存/打开/关闭/另存为/导出）纯搬移；
 *    公共导出面经 store 根 re-export 兼容（design §2.3-1/2）。
 * 2. [payload v2（R3 P0 修复冻结 → studio-layers 1.4 修改权接管换真）] loadFromHandoff 的
 *    v2 消费、EditDocument/gemdoc serialize-parse/round-trip 的唯一修改 owner = studio-layers
 *    replay/handoff gate；本切片落地 physicalCanvas 贯通：payload.physicalCanvas → EditDocument
 *    （v1 形态载荷无键 = default 锚合成显式，向后兼容 quickLayout）；serializeGemdoc/parseGemdoc
 *    physicalCanvas 位（schema 已冻结）round-trip 字节等价。后续消费接线归 D 轨 5.9。
 * 3. [依赖纪律] 子模块单向依赖：根（核心 $state 读写协作面 + 契约类型 type-only）→
 *    documentStatus（状态位域，非互相 import）→ engine/persistence 公共面；不 import 其它子模块。
 * 4. [pin 编排] pinnedReferenceId（活动 EditDocument 参考资产 bool-pin）宿主在此——
 *    其写点全部位于本域（载入/覆盖/关闭）；根测试复位经内部 clearPinnedReference。
 */

import { toEditGem, type Block, type EngineImage } from '$lib/engine'
import {
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
  type GemprojReference,
} from '$lib/persistence/projectFile'
import { PROJECT_MIME, type ProjectSummary } from '$lib/persistence/projectTypes'
import { APP_VERSION } from '$lib/appVersion'
import { SvelteSet } from 'svelte/reactivity'
import {
  EDIT_PROJECT_OWNER_ID,
  clearEditDirty,
  getSavedBlobKey,
  markEditDirty,
  releaseGemdocLease,
  setGemdocLease,
  setSavedBlobKey,
} from '$lib/edit/documentStatus.svelte'
import {
  defaultPhysicalCanvasOf,
  getEditDoc,
  resetUndoHistory,
  setEditDocument,
  setManualCounter,
  type EditDocument,
  type EditLayerKey,
  type LayerState,
  type LoadDocumentMeta,
  type ManualEditHandoff,
} from '$lib/stores/edit.svelte'

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

/** [内部] 释放参考资产 bool-pin 并复位（根测试复位消费；本域载入/关闭路径直用局部状态）。 */
export function clearPinnedReference(): void {
  if (pinnedReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = null
}

/** 交接快照 → 编辑文档：深拷贝一切（钻/块/掩码/色板/网格/像素），重置历史与选择。
 *  [6.2] 挂载 pin 参考资产；再次送精修覆盖时先解除旧引用再挂新引用。
 *  [add-project-files 3.2] meta 录入溯源/命名（缺省 origin='studio-bake'——送精修主链零改动）；
 *  覆盖 = 未保存新文档（dirty=true，docId 置空）；旧 gemdoc 租约随覆盖释放。 */
export function loadFromHandoff(payload: ManualEditHandoff, meta: LoadDocumentMeta = {}): void {
  setManualCounter(0)
  resetUndoHistory()
  const nextReferenceId = payload.referenceAssetId ?? null
  if (pinnedReferenceId && pinnedReferenceId !== nextReferenceId) unpinAsset(pinnedReferenceId)
  pinnedReferenceId = nextReferenceId
  if (nextReferenceId) pinAsset(nextReferenceId)
  releaseGemdocLease()
  setSavedBlobKey(null)
  markEditDirty()
  setEditDocument({
    gems: payload.gems.map(toEditGem),
    blocks: payload.blocks.map(copyBlock),
    palette: payload.palette.map((c) => ({ ...c })),
    grid: { ...payload.grid },
    width: payload.width,
    height: payload.height,
    layers: defaultLayers(),
    selection: new SvelteSet<string>(),
    paintingSnapshot: copyImage(payload.paintingSnapshot),
    // [1.4] v2 物理锚贯通：payload 缺席（v1 形态——quickLayout 既有装配）= 按参考网格
    // pixelsPerMm 合成 default 锚（显式回退，不静默；同参同出不破坏）
    physicalCanvas: payload.physicalCanvas ?? defaultPhysicalCanvasOf(payload.width, payload.height, payload.grid.pixelsPerMm),
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
  })
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
    // [1.4] 物理锚随文档恒写（schema 位 W0 已冻结；缺席旧档经装载侧合成 default 后补齐）
    physicalCanvas: current.physicalCanvas,
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
  const current = getEditDoc()
  if (current === null) throw new EditGemdocError('编辑文档未载入，无法保存。', 'no-document')
  if (options.name !== undefined) {
    const trimmed = options.name.trim()
    if (trimmed !== '') current.name = trimmed
  }
  const text = await serializeCurrentGemdoc(current)
  const blob = new Blob([text], { type: PROJECT_MIME.gemdoc })
  const summary = gemdocSummaryOf(current)
  const expectedBlobKey = getSavedBlobKey()
  if (current.docId === null || expectedBlobKey === null) {
    const ingested = await ingestProjectAsset({
      blob,
      name: `${current.name}.gemdoc`,
      projectKind: 'gemdoc',
      summary,
    })
    current.docId = ingested.node.id
    current.name = ingested.node.name.replace(/\.gemdoc$/, '')
    current.savedAt = Date.now()
    setSavedBlobKey(ingested.node.blobKey)
    clearEditDirty()
    return { status: 'created', docId: ingested.node.id, name: current.name }
  }
  const updated = await updateProjectAsset(current.docId, { expectedBlobKey, bytes: blob, summary })
  current.savedAt = Date.now()
  setSavedBlobKey(updated.blobKey)
  clearEditDirty()
  return { status: 'updated', docId: updated.id, name: current.name }
}

/** 另存为（fork，design §2：不绑既有节点——恒 ingest 新节点并接管 docId）。 */
export async function saveGemdocAs(name: string): Promise<SaveGemdocResult> {
  const current = getEditDoc()
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
  setSavedBlobKey(ingested.node.blobKey)
  clearEditDirty()
  return { status: 'created', docId: ingested.node.id, name: current.name }
}

export interface GemdocExport {
  blob: Blob
  filename: string
}

/** 导出精修文件（.gemdoc）装配：只序列化不落库——导出不清 dirty、不建库节点。 */
export async function buildGemdocExport(): Promise<GemdocExport> {
  const current = getEditDoc()
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
  setGemdocLease(lease)
  setSavedBlobKey(node.blobKey)
  setManualCounter(deriveManualCounter(file.gems))
  resetUndoHistory()
  clearEditDirty()
  setEditDocument({
    gems: file.gems.map((g) => ({ ...g })),
    blocks: file.blocks.map(fromSerializedBlock),
    palette: file.palette.map((c) => ({ ...c })),
    grid: { ...file.grid },
    width: file.width,
    height: file.height,
    layers: copyLayers(file.layers),
    selection: new SvelteSet<string>(),
    paintingSnapshot: painting,
    // [1.4] 旧档无 physicalCanvas → default 锚合成（grid.pixelsPerMm 反推；anchorSource 显式）
    physicalCanvas: file.physicalCanvas ?? defaultPhysicalCanvasOf(file.width, file.height, file.grid.pixelsPerMm),
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
  })
}

/** 关闭文档：释放租约（幂等）与 bool-pin、清空文档/历史/dirty。守卫（dirty 三按钮）归调用方。 */
export async function closeEditDocument(): Promise<void> {
  releaseGemdocLease()
  clearPinnedReference()
  setSavedBlobKey(null)
  setEditDocument(null)
  clearEditDirty()
  resetUndoHistory()
  setManualCounter(0)
}
