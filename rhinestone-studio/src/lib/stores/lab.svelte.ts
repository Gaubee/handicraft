import {
  editImage,
  generateImage,
  ImageApiError,
  maskAdvancedJsonForPersist,
  parseAdvancedJson,
  type ImageTaskDebug,
} from '$lib/api/client'
import { loadSettings, saveSettings, type LabSettings } from '$lib/api/settings'
import { prepareReferenceImage, ACCEPTED_IMAGE_MIME_TYPES, type PreparedReferenceImage } from '$lib/api/imageInput'
import { getImageBlob, imageUrlToBlob, blobToDataUrl } from '$lib/persistence/imageStore'
import { getHandoffImageBlob } from '$lib/persistence/handoffImage'
import {
  createFolder,
  getAsset,
  getAssetBlob,
  getProject,
  ingestAsset,
  ingestProjectAsset,
  listAllNodes,
  listChildNodes,
  moveAsset,
  objectUrlForAsset,
  renameAsset,
  runAssetMigration,
  SYS_TEMPLATES_FOLDER_ID,
  trashAsset,
  type AssetMeta,
  type AssetNode,
  type AssetNodeId,
} from '$lib/persistence/assetStore'
import {
  canvasToPngBlob,
  composeCaseComposite,
  loadImageElement,
  pickCaseLayout,
  type CaseRefLayout,
} from '$lib/lab/caseComposite'
import { seedBuiltinTemplates } from '$lib/lab/templateSeed'
import type { LabStage, LabTaskBlueprint } from '$lib/lab/stages'
import { refresh as refreshLibrary } from '$lib/assets/library.svelte'
import { composeDrillPrompt, EFFECT_REF_PRESETS, PRESET_SOURCE_VERSION } from '$lib/presets/effectRefs'
import {
  clearTaskMetas,
  LEGACY_RUN_ID,
  loadLabForm,
  loadTaskMetas,
  saveLabForm,
  saveTaskMetas,
  type LegacyUploadEffectRef,
  type PersistedTaskMeta,
  type PersistedTaskStatus,
  type StoredEffectRef,
} from '$lib/persistence/taskStore'
import { setHandoff } from './handoff.svelte'
import { showToast } from './toast.svelte'
import {
  getTemplateList,
  getTemplateRecord,
  isEnabledTemplate,
  refreshTemplates,
  resetTemplatesForTests,
  submitTemplateField,
} from './templates.svelte'
import { APP_VERSION } from '$lib/appVersion'
import { cleanupExpiredBackup, executeTemplateMigration } from '$lib/lab/templateMigration'
import { serializeGemgen, type LabCaseBinding } from '$lib/persistence/labFile'
import { PROJECT_MIME, type ProjectThumbMeta } from '$lib/persistence/projectTypes'

/**
 * 提示词实验室核心状态（Svelte 5 runes 模块）。
 *
 * 任务模型：每「模板 × 候选序号」一个任务；
 * 状态机 pending → running → success | error | cancelled（AbortController 可取消）；
 * 并发上限 4；失败/取消任务保留全部输入引用，重试免重传。
 *
 * [add-project-files 4.3] 模板真源 = 素材库 .gemtpl（templates store）——variants {v:2}
 * localStorage 信封退役（design §7.1/§9.3）：本模块不再持有模板编辑态，hydrate 只做
 * seed → 迁移引擎接线 → 模板 store 刷新；enabled/选中态 = lab-session 会话 key。
 */

export const MAX_CONCURRENCY = 4
export const DEFAULT_CANDIDATES = 2
export const DEFAULT_SIZE = '1024x1024'

/**
 * 变体级「案例参照图」（[Owner 2026-09-19 参照对退役]）：
 * 案例侧只产出/附送**一张**合成参照图（canvas 拼接原图+效果图，布局模板标注角标），
 * 请求附图 = [案例合成图(若有), 参考图(目标)]。
 * - asset：素材库中的合成图资产（= gemtpl.caseBinding 的任务快照形态）
 * - preset：「未物化」过渡态——仅遗留持久化任务快照在重试时现场物化（B.1.3 收窄：
 *   新模板恒为 asset 绑定，seed 物化失败重试期之外 UI 不再呈现该 kind）
 */
export type VariantEffectRef =
  | { kind: 'asset'; assetId: string; caseLayout: CaseRefLayout }
  | { kind: 'preset'; presetId: string }

export type TaskStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'
export type RunMode = 'generate' | 'edit'
/** 蓝图策略（run 级；design §4.1/§4.2——serial=串行依赖 B 默认 / parallel=并行同生 A 实验关）。 */
export type BlueprintStrategy = 'serial' | 'parallel'

export interface LabTask {
  id: string
  /** 所属批次：一次「开始生成」= 一个 runId，同批任务共享；旧数据迁移为 'legacy'。 */
  runId: string
  variantId: string
  variantName: string
  /** [4.3] 模板资产 id 快照（画廊过滤键；legacy 会话任务无此字段）。 */
  templateAssetId?: string
  /** 0 起的候选序号。 */
  candidateIndex: number
  prompt: string
  /**
   * [4.4] 请求时实际发出的提示词全文快照（runTask 组装后立即落任务；归档 .gemgen
   * provenance.composedPrompt 消费——审计真源，含动态角色声明/DRILL_RULES 骨架）。
   * legacy 任务（快照引入前的持久化数据）缺省，归档侧按附件形态推断重建。
   */
  composedPrompt?: string
  mode: RunMode
  model: string
  size: string
  advancedJson: string
  /** 发起时的效果参考快照（画廊卡片来源徽章；重试时据此重取参考图）。 */
  effectRef?: VariantEffectRef | null
  /** 发起时的参考原图素材 id（B-3 上传即入库；hydrate 后重试按 id 解析，B-4）。 */
  referenceAssetId?: string
  /**
   * [C3.2] 蓝图任务级快照（design §1.2/§4.3）：仅 blueprint.enabled=true 的模板在
   * startRun 时物化（strategy=发起面板单选 + refs=模板参考图快照）；stage 派发/归档
   * 消费归 4.3/4.4，C 轨只承快照数据面。
   */
  blueprint?: LabTaskBlueprint
  /**
   * [C3.3→4.3] stage 树键位登记（design §3.1）：C 轨仅承展示消费——任务卡蓝图子态经
   * deriveBlueprintBadge(stages) 派生（tests fixture 喂入）；startRun 物化 / pump 调度 /
   * PersistedTaskMeta 接线归 4.3。缺席 = 无蓝图/旧档（蓝图区不渲染）。
   */
  stages?: LabStage[]
  status: TaskStatus
  /** 会话内展示 URL（objectURL / dataURL）。 */
  imageUrl?: string
  /** 生成图 blob 是否已持久化（新链路 = 已入库为素材）。 */
  imageStored: boolean
  /** 生成结果素材节点 id（4.3 归档；入库失败暂缺，由补偿链路补建）。 */
  assetId?: AssetNodeId
  /** 恢复时 IndexedDB 中已无对应 blob。 */
  imageMissing?: boolean
  error?: string
  debug?: ImageTaskDebug
  createdAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface StartRunResult {
  ok: boolean
  error?: string
  enqueued: number
}

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ---------------------------------------------------------------------------
// 模块状态（模板编辑态归 templates store——本模块只持任务/表单/参考图/设置）
// ---------------------------------------------------------------------------

const settings = $state<LabSettings>(loadSettings())
let reference = $state<PreparedReferenceImage | null>(null)
/** 参考原图对应的素材节点 id（上传即入库；任务快照持久化它，刷新后按 id 解析）。 */
let referenceAssetId: string | null = null
const tasks = $state<LabTask[]>([])
/**
 * [C3.2] lab-session form：blueprintStrategy = run 级蓝图策略（design §4.3——模板只存开关
 * 不锁策略，策略在发起面板按次选择；默认串行 B，随 saveLabForm 持久化）。
 */
const form = $state<{ advancedJson: string; size: string; blueprintStrategy: BlueprintStrategy }>({
  advancedJson: '',
  size: DEFAULT_SIZE,
  blueprintStrategy: 'serial',
})

const controllers = new Map<string, AbortController>()
const inflight = new Set<Promise<void>>()
let hydrated = false

// 供 UI / 测试读取的派生量
let runningCount = $derived(tasks.filter((t) => t.status === 'running').length)
let pendingCount = $derived(tasks.filter((t) => t.status === 'pending').length)

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export function getSettings(): LabSettings {
  return settings
}

export function updateSettings(patch: Partial<LabSettings>): void {
  if (patch.baseUrl !== undefined) settings.baseUrl = patch.baseUrl
  if (patch.apiKey !== undefined) settings.apiKey = patch.apiKey
  if (patch.model !== undefined) settings.model = patch.model
  saveSettings(settings)
}

// ---------------------------------------------------------------------------
// 表单（Advanced JSON / 尺寸）
// ---------------------------------------------------------------------------

export function getForm(): { advancedJson: string; size: string; blueprintStrategy: BlueprintStrategy } {
  return form
}

function persistForm(): void {
  saveLabForm({ advancedJson: form.advancedJson, size: form.size, blueprintStrategy: form.blueprintStrategy })
}

export function updateForm(
  patch: Partial<{ advancedJson: string; size: string; blueprintStrategy: BlueprintStrategy }>,
): void {
  if (patch.advancedJson !== undefined) form.advancedJson = patch.advancedJson
  if (patch.size !== undefined) form.size = patch.size.trim()
  if (patch.blueprintStrategy === 'serial' || patch.blueprintStrategy === 'parallel') {
    form.blueprintStrategy = patch.blueprintStrategy
  }
  persistForm()
}

// ---------------------------------------------------------------------------
// 参考原图
// ---------------------------------------------------------------------------

export function getReference(): PreparedReferenceImage | null {
  return reference
}

/** 参考原图对应的素材节点 id（未入库/入库失败为 null）。 */
export function getReferenceAssetId(): string | null {
  return referenceAssetId
}

export async function setReference(file: File): Promise<void> {
  const prepared = await prepareReferenceImage(file)
  // [B-3 上传即入库] 参考原图素材化（sys-uploads），任务快照持久化 assetId；
  // 入库失败（IDB 不可用等）降级为会话内引用，不阻断上传。
  let assetId: string | null = null
  try {
    await ensureLibrarySeeded()
    const ingested = await ingestAsset({
      blob: prepared.file,
      name: prepared.file.name,
      width: prepared.width,
      height: prepared.height,
      parentId: 'sys-uploads',
      source: 'upload',
    })
    assetId = ingested.node.id
  } catch (error) {
    console.warn('参考原图入库失败，降级为会话内引用', error)
  }
  if (reference) URL.revokeObjectURL(reference.previewUrl)
  reference = prepared
  referenceAssetId = assetId
}

export function clearReference(): void {
  if (reference) URL.revokeObjectURL(reference.previewUrl)
  reference = null
  // 素材本体保留在库中（上传即入库；回收/清理由素材库负责）。
  referenceAssetId = null
}

export function hasReference(): boolean {
  return reference !== null
}

// ---------------------------------------------------------------------------
// 案例参照图：物化管线 + 绑定 API（[Owner 2026-09-19 参照对退役]）
// ---------------------------------------------------------------------------

/** 合成图资产的 meta 扩展（AssetMeta 之外的私有字段，随节点 meta 原样持久化）。 */
interface CaseCompositeMeta extends AssetMeta {
  /** preset 物化的幂等键（sys-cases 下按 presetId+版本 复用既有合成资产，确定性可重复）。 */
  presetId?: string
  /** 内置案例素材源版本（effectRefs PRESET_SOURCE_VERSION）——素材内容变更后旧合成资产不复用。 */
  presetSrcVersion?: number
  caseLayout?: CaseRefLayout
}

export interface MaterializedCaseRef {
  assetId: string
  caseLayout: CaseRefLayout
  /** true = 合成降级为效果图单张（无 2D 上下文等）；调用方据此 toast 说明。 */
  degraded: boolean
}

interface MaterializeCaseOptions {
  name: string
  parentId: 'sys-cases' | 'sys-uploads'
  source: 'preset' | 'upload'
  meta?: CaseCompositeMeta
}

function assertCaseImageMime(blob: Blob, role: string): void {
  if (!(ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(blob.type)) {
    throw new Error(`案例${role}格式不受支持（${blob.type || '未知'}），请使用 PNG / JPEG / WebP。`)
  }
}

interface DrawableSource {
  image: HTMLImageElement
  width: number
  height: number
  revoke: () => void
}

/** blob → 可绘制源（objectURL 过桥，取 natural 尺寸；jsdom 桩由测试提供）。 */
async function loadDrawable(blob: Blob): Promise<DrawableSource> {
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImageElement(url)
    return {
      image,
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0,
      revoke: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

interface CompositeBuild {
  blob: Blob
  caseLayout: CaseRefLayout
  degraded: boolean
  width: number
  height: number
}

/**
 * 合成管线：loadImageElement×2 → pickCaseLayout → composeCaseComposite → canvasToPngBlob。
 * - 单张输入（无原图）直接透传效果图（layout=single）；
 * - compose 返 null（jsdom 无 2D 上下文等）→ 降级取效果图单张（layout=single + degraded）；
 *   真机合成质量（角标/中缝/contain 适配）由走查验证。
 */
async function buildCaseCompositeBlob(src: Blob | undefined, res: Blob): Promise<CompositeBuild> {
  const resDrawable = await loadDrawable(res)
  try {
    if (!src) {
      return { blob: res, caseLayout: 'single', degraded: false, width: resDrawable.width, height: resDrawable.height }
    }
    const srcDrawable = await loadDrawable(src)
    try {
      const layout = pickCaseLayout(srcDrawable, resDrawable)
      const canvas = composeCaseComposite(
        { bitmap: srcDrawable.image, width: srcDrawable.width, height: srcDrawable.height },
        { bitmap: resDrawable.image, width: resDrawable.width, height: resDrawable.height },
        layout,
      )
      if (!canvas) {
        return { blob: res, caseLayout: 'single', degraded: true, width: resDrawable.width, height: resDrawable.height }
      }
      const blob = await canvasToPngBlob(canvas)
      return { blob, caseLayout: layout, degraded: false, width: canvas.width, height: canvas.height }
    } finally {
      srcDrawable.revoke()
    }
  } finally {
    resDrawable.revoke()
  }
}

/**
 * 物化管线（[Owner]）：两图源（文件/URL/IDB blob/preset 静态路径已先转为 blob）→ 合成 →
 * ingestAsset → 合成图资产绑定。preset 入 sys-cases（meta.presetId+caseLayout，幂等复用）；
 * 用户来源（上传/链接/迁移）入 sys-uploads。
 */
async function materializeCaseAsset(
  src: Blob | undefined,
  res: Blob,
  options: MaterializeCaseOptions,
): Promise<MaterializedCaseRef> {
  assertCaseImageMime(res, '效果图')
  if (src) assertCaseImageMime(src, '原图')
  const build = await buildCaseCompositeBlob(src, res)
  await ensureLibrarySeeded()
  const meta: CaseCompositeMeta = { ...options.meta, caseLayout: build.caseLayout }
  const ingested = await ingestAsset({
    blob: build.blob,
    name: options.name,
    width: build.width,
    height: build.height,
    parentId: options.parentId,
    source: options.source,
    meta,
  })
  return { assetId: ingested.node.id, caseLayout: build.caseLayout, degraded: build.degraded }
}

/** preset 物化的在途去重（同 presetId 并发只跑一次；落定后清除，跨调用幂等靠 meta 反查）。 */
const presetMaterializations = new Map<string, Promise<MaterializedCaseRef>>()

/** preset 合成资产的幂等反查（sys-cases 下按 meta.presetId+源版本；软删视为不存在）。 */
async function findPresetCompositeAsset(presetId: string): Promise<MaterializedCaseRef | null> {
  try {
    for (const node of await listAllNodes()) {
      if (node.type !== 'image' || node.trashedAt !== undefined) continue
      const meta = node.meta as CaseCompositeMeta | undefined
      if (meta?.presetId === presetId && meta.presetSrcVersion === PRESET_SOURCE_VERSION && meta.caseLayout) {
        return { assetId: node.id, caseLayout: meta.caseLayout, degraded: false }
      }
    }
  } catch {
    // IDB 不可用：视为未物化（现场物化会失败并上抛，由调用方决定保留原状）
  }
  return null
}

async function fetchCaseBlob(url: string, failureMessage: string, signal?: AbortSignal): Promise<Blob> {
  try {
    return await imageUrlToBlob(url, signal)
  } catch (error) {
    if (isAbortError(error)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${failureMessage}（${reason}）`)
  }
}

async function materializePresetEffectRefUncached(presetId: string, signal?: AbortSignal): Promise<MaterializedCaseRef> {
  const preset = EFFECT_REF_PRESETS.find((p) => p.id === presetId)
  if (!preset) throw new Error('效果参考案例已不存在，请重新选择。')
  const reused = await findPresetCompositeAsset(presetId)
  if (reused) return reused
  const res = await fetchCaseBlob(preset.resImage, '效果参考案例图加载失败，请重试', signal)
  const src = preset.srcImage
    ? await fetchCaseBlob(preset.srcImage, '效果参考案例原图加载失败，请重试', signal)
    : undefined
  return materializeCaseAsset(src, res, {
    name: `${preset.name}·案例参照图`,
    parentId: 'sys-cases',
    source: 'preset',
    meta: { presetId, presetSrcVersion: PRESET_SOURCE_VERSION },
  })
}

/** preset 物化（在途去重 + meta 幂等）：hydrate 迁移 / 首次使用 / 展示解析共用同一入口。 */
export function materializePresetEffectRef(presetId: string, signal?: AbortSignal): Promise<MaterializedCaseRef> {
  const inFlight = presetMaterializations.get(presetId)
  if (inFlight) return inFlight
  const promise = materializePresetEffectRefUncached(presetId, signal).finally(() => {
    presetMaterializations.delete(presetId)
  })
  presetMaterializations.set(presetId, promise)
  return promise
}

export interface EffectRefCaseView {
  url: string
  caseLayout: CaseRefLayout
  /** 来源资产名（Dialog 绑定信息展示；解析失败缺省）。 */
  name?: string
}

/**
 * UI 展示解析：asset → assetStore 冻结出口 objectUrlForAsset（按 blobKey 共享 LRU 缓存），
 * 软删/缺失 → null（UI 显示失效空态）；preset（未物化过渡态）→ 先物化（幂等）再取。
 */
export async function getEffectRefCaseView(
  effectRef: VariantEffectRef | null | undefined,
): Promise<EffectRefCaseView | null> {
  if (!effectRef) return null
  if (effectRef.kind === 'preset') {
    try {
      const materialized = await materializePresetEffectRef(effectRef.presetId)
      const [url, node] = await Promise.all([
        objectUrlForAsset(materialized.assetId).catch(() => null),
        getAsset(materialized.assetId).catch(() => null),
      ])
      return url ? { url, caseLayout: materialized.caseLayout, name: node?.name } : null
    } catch {
      return null // 物化失败（离线/IDB 不可用）：UI 显示失效态，不抛
    }
  }
  const [url, node] = await Promise.all([
    objectUrlForAsset(effectRef.assetId).catch(() => null),
    getAsset(effectRef.assetId).catch(() => null),
  ])
  return url ? { url, caseLayout: effectRef.caseLayout, name: node?.name } : null
}

/**
 * 上传方案①（[Owner 2026-09-19] 拼接原图必选）：原图 + 效果图（两图缺一不可）→
 * 预处理 → 自动合成 → 入库 sys-uploads → 绑定 gemtpl.caseBinding（4.3：写回 templates
 * store 写队列，换绑保存）。只有效果图的场景请走 setTemplateEffectRefSingle（原「src 缺失
 * = single」分支已删除，职责完全归 single 入口）；内部 degraded 仅保留给 canvas 不可用
 * 环境的合成降级。失败抛给调用方 toast，不动旧绑定（B-2：旧合成资产保留在库）。
 */
export async function setTemplateEffectRefPair(templateAssetId: string, src: File, res: File): Promise<MaterializedCaseRef> {
  const record = getTemplateRecord(templateAssetId)
  if (!record) throw new Error('模板不存在，请刷新后重试。')
  const [srcPrepared, resPrepared] = await Promise.all([
    prepareReferenceImage(src),
    prepareReferenceImage(res),
  ])
  const materialized = await materializeCaseAsset(srcPrepared.file, resPrepared.file, {
    name: `${record.name || '未命名模板'}·案例参照图`,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  submitTemplateField(templateAssetId, {
    caseBinding: { assetId: materialized.assetId, caseLayout: materialized.caseLayout },
  })
  return materialized
}

/** 上传方案②：单张案例图直传（caseLayout='single'）。 */
export async function setTemplateEffectRefSingle(templateAssetId: string, file: File): Promise<MaterializedCaseRef> {
  const record = getTemplateRecord(templateAssetId)
  if (!record) throw new Error('模板不存在，请刷新后重试。')
  const prepared = await prepareReferenceImage(file)
  const materialized = await materializeCaseAsset(undefined, prepared.file, {
    name: `${record.name || '未命名模板'}·案例参照图`,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  submitTemplateField(templateAssetId, {
    caseBinding: { assetId: materialized.assetId, caseLayout: materialized.caseLayout },
  })
  return materialized
}

/** 粘贴链接（[Owner] 提交时即物化）：两 URL → fetch → 合成 → 入库 sys-uploads → 绑定；仅 res URL → single。 */
export async function setTemplateEffectRefUrls(templateAssetId: string, srcUrl: string | undefined, resUrl: string): Promise<MaterializedCaseRef> {
  const record = getTemplateRecord(templateAssetId)
  if (!record) throw new Error('模板不存在，请刷新后重试。')
  const res = await fetchCaseBlob(resUrl, '参考图链接跨域不可取，请下载后上传')
  const src = srcUrl ? await fetchCaseBlob(srcUrl, '参考图链接跨域不可取，请下载后上传') : undefined
  const materialized = await materializeCaseAsset(src, res, {
    name: `${record.name || '未命名模板'}·案例参照图`,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  submitTemplateField(templateAssetId, {
    caseBinding: { assetId: materialized.assetId, caseLayout: materialized.caseLayout },
  })
  return materialized
}

// ---------------------------------------------------------------------------
// 生成请求链路里的案例参照图解析（asset 经 getAssetBlob；preset 未物化时现场物化再取）
// ---------------------------------------------------------------------------

function extForMime(type: string): string {
  if (type === 'image/png') return 'png'
  if (type === 'image/webp') return 'webp'
  return 'jpg'
}

function blobToCaseFile(blob: Blob): File {
  const type = blob.type || 'image/jpeg'
  return new File([blob], `case-ref.${extForMime(type)}`, { type })
}

/** preset 物化完成后的改绑（守卫：任务在物化期间仍指向同一 preset 引用才改写）。
 *  [4.3] 模板侧已恒为 asset 绑定——只有遗留持久化任务的 preset 快照走到这里。 */
function rebindPresetMaterialization(
  task: LabTask,
  presetId: string,
  assetRef: { kind: 'asset'; assetId: string; caseLayout: CaseRefLayout },
): void {
  if (task.effectRef?.kind === 'preset' && task.effectRef.presetId === presetId) {
    task.effectRef = { ...assetRef }
  }
}

/** 案例参照图 → 请求用 File（合成图字节 + 布局）；preset 过渡态现场物化（幂等）。 */
async function resolveCaseFile(
  ref: VariantEffectRef,
  task: LabTask,
  signal?: AbortSignal,
): Promise<{ file: File; caseLayout: CaseRefLayout }> {
  let assetRef: { kind: 'asset'; assetId: string; caseLayout: CaseRefLayout }
  if (ref.kind === 'preset') {
    const materialized = await materializePresetEffectRef(ref.presetId, signal)
    assetRef = { kind: 'asset', assetId: materialized.assetId, caseLayout: materialized.caseLayout }
    rebindPresetMaterialization(task, ref.presetId, assetRef)
  } else {
    assetRef = ref
  }
  const blob = await getAssetBlob(assetRef.assetId).catch(() => null)
  if (!blob) throw new Error('案例参照图已丢失（素材库中已无该图片，可能已被清理），请重新上传。')
  return { file: blobToCaseFile(blob), caseLayout: assetRef.caseLayout }
}

/**
 * 发起 run 前的 caseBinding 有效性口径：模板恒为 asset 绑定（assetId 非空即放行）；
 * 字节可得性由 runTask 的解析步骤给出任务级中文错误，不阻断其他模板。
 */
function caseBindingForRun(binding: LabCaseBinding | null): VariantEffectRef | null {
  return binding && binding.assetId ? { kind: 'asset', assetId: binding.assetId, caseLayout: binding.caseLayout } : null
}

// ---------------------------------------------------------------------------
// 生成结果归档（4.4：serializeGemgen → ingestProjectAsset；首个成功懒建批次夹 +
// 三步补偿机制沿 4.3 不动，仅产物从裸图换 .gemgen 档案）
// ---------------------------------------------------------------------------

/** 与 assetStore 迁移同格式的批次时间戳（MM-DD HH:mm）。 */
function stampOf(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 系统目录种子检查（一次性）：hydrate 的异步迁移尚未落完时用户已发起生成的兜底。 */
let librarySeedChecked = false

async function ensureLibrarySeeded(): Promise<void> {
  if (librarySeedChecked) return
  try {
    const root = await listChildNodes(null)
    const hasUploads = root.some((n) => n.id === 'sys-uploads')
    const hasGenerated = root.some((n) => n.id === 'sys-generated')
    if (!hasUploads || !hasGenerated) await runAssetMigration()
    librarySeedChecked = true
  } catch {
    // IDB 不可用：入库链路整体降级（任务仍成功，素材缺位由补偿链路重试）
    librarySeedChecked = true
  }
}

/** runId → 批次夹 id 会话缓存（刷新后经兄弟任务 assetId / 迁移确定性 id 重建）。 */
const batchFolderByRun = new Map<string, string>()

/** gemgen 缩略边长（256px PNG，P0——视觉资产目录无缩略不可用，补充稿 C.2）。 */
const GEMGEN_THUMB_SIZE = 256

/**
 * 批次夹解析（runId 幂等）：会话缓存 → 同批任一任务的资产节点 parentId →
 * 迁移期确定性 id `ast-batch-<runId>`（assetStore §3 建夹约定）→ 懒建。
 * [4.4] 兄弟反查扩到项目节点（归档产物 = AssetProject(gemgen)；旧批次内仍是图片节点）。
 * 有效性口径 = sys-generated 下「未软删」的文件夹（缓存/兄弟引用可能指向已被
 * 空批次清理软删的夹，不复用）。
 * name `MM-DD HH:mm · N 张`：时间戳取批次最早任务 createdAt，N 随成功张数刷新
 * （计数口径 = image + project/gemgen——4.4 前旧档图 + 新档 gemgen 同计，文案不变）。
 */
async function findOrCreateBatchFolder(runId: string, earliestCreatedAt: number): Promise<{ folderId: string; created: boolean }> {
  const generated = await listChildNodes('sys-generated').catch(() => [] as AssetNode[])
  const validFolders = new Set(
    generated
      .filter((n) => n.type === 'folder' && (n as { trashedAt?: number }).trashedAt === undefined)
      .map((n) => n.id),
  )
  const cached = batchFolderByRun.get(runId)
  if (cached && validFolders.has(cached)) return { folderId: cached, created: false }
  for (const t of tasks) {
    if (t.runId === runId && t.assetId) {
      const [image, project] = await Promise.all([
        getAsset(t.assetId).catch(() => null),
        getProject(t.assetId).catch(() => null),
      ])
      const siblingParent = image?.parentId ?? project?.parentId
      if (siblingParent && validFolders.has(siblingParent)) {
        batchFolderByRun.set(runId, siblingParent)
        return { folderId: siblingParent, created: false }
      }
    }
  }
  const migrated = `ast-batch-${runId}`
  if (validFolders.has(migrated)) {
    batchFolderByRun.set(runId, migrated)
    return { folderId: migrated, created: false }
  }
  // 懒建：createFolder 冻结出口禁止在系统目录内直接新建（§4 用户语义）——
  // 经「根层新建 → moveAsset 归位 sys-generated」两步组合达成（均为公共操作，仅改 parentId）。
  const folder = await createFolder(null, `${stampOf(earliestCreatedAt)} · 1 张`)
  try {
    const placed = await moveAsset(folder.id, 'sys-generated')
    batchFolderByRun.set(runId, placed.id)
    return { folderId: placed.id, created: true }
  } catch (error) {
    // 归位失败：回收根层残留夹（不留孤儿）
    await trashAsset(folder.id).catch(() => undefined)
    throw error
  }
}

/** 批次夹内的归档产物计数口径（image + project/gemgen；软删不计）。 */
function isBatchArtifact(node: AssetNode): boolean {
  return (
    (node as { trashedAt?: number }).trashedAt === undefined &&
    (node.type === 'image' || (node.type === 'project' && node.projectKind === 'gemgen'))
  )
}

interface DecodedGeneratedImage {
  source: CanvasImageSource
  width: number
  height: number
}

/**
 * 生成图字节 → 可绘制源（createImageBitmap 优先，Image 元素过桥兜底）；过桥 objectURL
 * 在 finally 即弃（序列化辅助 URL 不驻留——与任务会话展示 URL 是两回事）。
 * 两者皆不可用（无解码能力的极端环境）→ null（尺寸走请求快照兜底、缩略缺省）。
 */
async function decodeGeneratedImage(blob: Blob): Promise<DecodedGeneratedImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      return { source: bitmap, width: bitmap.width, height: bitmap.height }
    } catch {
      // 损坏字节/解码失败 → 落到 Image 过桥再试（一并失败由调用方兜底）
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImageElement(url)
    const width = image.naturalWidth || image.width || 0
    const height = image.naturalHeight || image.height || 0
    return width > 0 && height > 0 ? { source: image, width, height } : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 请求尺寸快照兜底（'1024x1024' → 1024×1024）：无可解码环境给 schema 正数尺寸。 */
function sizeFallbackOf(size: string): { width: number; height: number } | null {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(size.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * gemgen 缩略（256px contain PNG）：无 2D 上下文（jsdom）或 toBlob 不可用 → undefined
 * （缩略缺省——显式降级路径，归档不因此失败；真机 canvas 一次，补充稿 C.2）。
 */
async function renderGemgenThumb(
  decoded: DecodedGeneratedImage,
): Promise<{ bytes: Blob; meta: Omit<ProjectThumbMeta, 'key' | 'bytes'> } | undefined> {
  const canvas = document.createElement('canvas')
  canvas.width = GEMGEN_THUMB_SIZE
  canvas.height = GEMGEN_THUMB_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const scale = Math.min(GEMGEN_THUMB_SIZE / decoded.width, GEMGEN_THUMB_SIZE / decoded.height)
  const width = Math.max(1, Math.round(decoded.width * scale))
  const height = Math.max(1, Math.round(decoded.height * scale))
  ctx.drawImage(decoded.source, (GEMGEN_THUMB_SIZE - width) / 2, (GEMGEN_THUMB_SIZE - height) / 2, width, height)
  try {
    const bytes = await canvasToPngBlob(canvas)
    return { bytes, meta: { mime: 'image/png', width: GEMGEN_THUMB_SIZE, height: GEMGEN_THUMB_SIZE } }
  } catch {
    return undefined
  }
}

/** 溯源用案例绑定快照：asset 绑定原样入档；preset 过渡态/无绑定 → null（显式未绑定）。 */
function caseBindingOfTask(task: LabTask): LabCaseBinding | null {
  return task.effectRef?.kind === 'asset'
    ? { assetId: task.effectRef.assetId, caseLayout: task.effectRef.caseLayout }
    : null
}

/**
 * composedPrompt 审计快照消费：请求时快照为真源（runTask 组装后落任务）；legacy 任务
 * （快照引入前的持久化数据）按当前附件形态推断重建——hasCase/hasReference 只能取
 * 任务快照可表达的部分（asset 绑定 / referenceAssetId），与请求时组合可能不符，
 * 作为旧数据（本就无全文可考）的最优近似。
 */
function composedPromptOf(task: LabTask): string {
  if (task.composedPrompt !== undefined) return task.composedPrompt
  const caseBinding = caseBindingOfTask(task)
  return composeDrillPrompt(task.prompt, {
    hasCase: caseBinding !== null,
    caseLayout: caseBinding?.caseLayout ?? 'single',
    hasReference: task.mode === 'edit' && task.referenceAssetId !== undefined,
  })
}

/**
 * 单任务成功结果归档 [4.4]：serializeGemgen → ingestProjectAsset（blob+节点+thumb 同事务）
 * → task.assetId → 批次夹计数命名刷新。溯源收编：runId/templateAssetId/templateName/
 * promptBody/composedPrompt/caseBinding/referenceAssetId/candidateIndex/mode/model/size/
 * advancedJson（序列化边界 N3 打码）全部上移文件 provenance；节点只留 summary 展示缓存。
 * image 内嵌：任务 blob → dataUrl（原始字节不降采样；dataUrl 仅存在于文件字节，不驻留任务）。
 * 失败时：本调用新建的夹若无归档产物 → 清理不留空夹（软删入回收站）；错误上抛由调用方决定降级。
 */
async function archiveGeneratedResult(task: LabTask, blob: Blob): Promise<void> {
  await ensureLibrarySeeded()
  const earliest = tasks
    .filter((t) => t.runId === task.runId)
    .reduce((min, t) => Math.min(min, t.createdAt), task.createdAt)
  const { folderId, created } = await findOrCreateBatchFolder(task.runId, earliest)
  try {
    const decoded = await decodeGeneratedImage(blob)
    const dims = decoded ? { width: decoded.width, height: decoded.height } : sizeFallbackOf(task.size)
    if (!dims) throw new Error('生成图尺寸不可得，无法写入生成档案（.gemgen）。')
    // mime 归一：结果 blob 无类型时按 PNG（沿 dataUrlToBlob 缺省口径），保证 dataUrl 头部合法。
    const mime = blob.type || 'image/png'
    const imageBlob = mime === blob.type ? blob : new Blob([blob], { type: mime })
    const dataUrl = await blobToDataUrl(imageBlob)
    const thumb = decoded ? await renderGemgenThumb(decoded) : undefined
    const name = `${task.variantName}·候选${task.candidateIndex + 1}`
    const text = serializeGemgen({
      appVersion: APP_VERSION,
      createdAt: task.createdAt,
      savedAt: Date.now(),
      name,
      image: { mime, dataUrl, width: dims.width, height: dims.height },
      provenance: {
        runId: task.runId,
        ...(task.templateAssetId ? { templateAssetId: task.templateAssetId } : {}),
        templateName: task.variantName,
        promptBody: task.prompt,
        composedPrompt: composedPromptOf(task),
        caseBinding: caseBindingOfTask(task),
        ...(task.referenceAssetId ? { referenceAssetId: task.referenceAssetId } : {}),
        candidateIndex: task.candidateIndex,
        // [4.1] canonical 写键 requestMode（v1 过渡 mode 输入面移除——serialize 恒写 requestMode）
        requestMode: task.mode,
        model: task.model,
        size: task.size,
        ...(task.advancedJson.trim() ? { advancedJson: task.advancedJson } : {}),
      },
    })
    const ingested = await ingestProjectAsset({
      blob: new Blob([text], { type: PROJECT_MIME.gemgen }),
      name,
      projectKind: 'gemgen',
      parentId: folderId,
      summary: {
        templateName: task.variantName,
        candidateIndex: task.candidateIndex,
        size: task.size,
        mode: task.mode,
      },
      ...(thumb ? { thumb } : {}),
    })
    task.assetId = ingested.node.id
  } catch (error) {
    if (created) {
      const children = await listChildNodes(folderId).catch(() => [] as AssetNode[])
      if (!children.some(isBatchArtifact)) {
        // 空批次清理（软删入回收站）+ 缓存失效（后续成功重建夹，不复用已删夹）
        await trashAsset(folderId).catch(() => undefined)
        batchFolderByRun.delete(task.runId)
      }
    }
    throw error
  }
  const children = await listChildNodes(folderId).catch(() => [] as AssetNode[])
  const count = children.filter(isBatchArtifact).length
  if (count > 0) await renameAsset(folderId, `${stampOf(earliest)} · ${count} 张`).catch(() => undefined)
}

/** 归档串行链：并发的多任务成功共享同一批次夹解析，避免懒建竞态产生重复夹。 */
let archiveChain: Promise<void> = Promise.resolve()
// 在途归档数（含尾部 refreshLibrary）：whenIdle 需排干归档链——补偿重试走
// fire-and-forget enqueue，不在 inflight 里；assetId 写内存与 persistTasks
// 之间隔着 IDB 操作，不排干会读到未持久化的旧账本（终态持久化竞态）
let archiveDepth = 0

function enqueueArchive(run: () => Promise<void>): Promise<void> {
  const next = archiveChain.then(run, run)
  archiveDepth += 1
  archiveChain = next
    .catch(() => undefined)
    // 归档是素材库投影的外部写入者（无通知通道）——落定后触发一次全量重查，
    // 让已打开的素材库视图/选图器看到新资产（Tabs 惰性挂载的重查兜底之外的会话内实时性）；
    // 重查失败静默（下次挂载/操作重试），不阻断归档链
    .then(() => {
      refreshLibrary().catch(() => undefined)
    })
    .finally(() => {
      archiveDepth -= 1
    })
  return next
}

/**
 * 三步失败补偿（任务终态持久化时幂等补建）：成功但未入库的任务，从会话 objectURL
 * 重取字节归档。刷新后字节已不可得的任务自然跳过（imageMissing 语义）。
 */
async function reconcileUnarchivedResults(): Promise<void> {
  const pending = tasks.filter(
    (t) => t.status === 'success' && t.imageStored && !t.assetId && t.imageUrl?.startsWith('blob:'),
  )
  if (pending.length === 0) return
  for (const task of pending) {
    try {
      const blob = await imageUrlToBlob(task.imageUrl as string)
      await archiveGeneratedResult(task, blob)
    } catch {
      // 下次终态持久化时再试（幂等）
    }
  }
  persistTasks()
}

function scheduleArchiveReconcile(): void {
  if (tasks.some((t) => t.status === 'success' && t.imageStored && !t.assetId && t.imageUrl?.startsWith('blob:'))) {
    void enqueueArchive(reconcileUnarchivedResults)
  }
}

// ---------------------------------------------------------------------------
// 任务与调度
// ---------------------------------------------------------------------------

export function getTasks(): LabTask[] {
  return tasks
}

export function getTask(id: string): LabTask | undefined {
  return tasks.find((t) => t.id === id)
}

export function getRunningCount(): number {
  return runningCount
}

export function getPendingCount(): number {
  return pendingCount
}

export function isBusy(): boolean {
  return runningCount + pendingCount > 0
}

export async function whenIdle(): Promise<void> {
  // 循环等待：pump 会在已跟踪 promise 的 finally 里启动新任务，
  // 一次性快照 Promise.all 会漏掉后续波次；归档链（含 fire-and-forget 补偿）
  // 同理——排干后重查，链上续入的新工作不漏。
  while (inflight.size > 0 || archiveDepth > 0) {
    await Promise.all([...inflight, archiveChain])
  }
}

function isTerminalTask(t: LabTask): t is LabTask & { status: PersistedTaskStatus } {
  return t.status === 'success' || t.status === 'error' || t.status === 'cancelled'
}

function persistTasks(): void {
  const metas: PersistedTaskMeta[] = tasks
    .filter(isTerminalTask)
    .map((t) => ({
      id: t.id,
      runId: t.runId,
      variantId: t.variantId,
      variantName: t.variantName,
      templateAssetId: t.templateAssetId,
      candidateIndex: t.candidateIndex,
      prompt: t.prompt,
      // [4.4] 请求时全文快照随任务账本持久化（归档审计真源，不随降级剥离）
      composedPrompt: t.composedPrompt,
      mode: t.mode,
      model: t.model,
      size: t.size,
      // localStorage 明文可读：Advanced JSON 中敏感键打码后再持久化（N3）
      advancedJson: maskAdvancedJsonForPersist(t.advancedJson),
      status: t.status,
      hasReference: t.mode === 'edit',
      referenceAssetId: t.referenceAssetId,
      assetId: t.assetId,
      effectRef: t.effectRef ?? null,
      imageStored: t.imageStored,
      error: t.error,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt,
      durationMs: t.durationMs,
      debug: t.debug,
    }))
  saveTaskMetas(metas)
}

function pump(): void {
  let slots = MAX_CONCURRENCY - runningCount
  if (slots <= 0) return
  for (const task of tasks) {
    if (slots <= 0) break
    if (task.status === 'pending') {
      slots -= 1
      void runTask(task.id)
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * [B-4] hydrate 后 edit 重试：按任务快照的 referenceAssetId 经 assetStore 冻结出口
 * 解析回 File（getAsset 取名 / getAssetBlob 取字节）；缺失/软删/入库缺失 → null（显式失效态）。
 */
async function restoreReferenceFileFromAsset(assetId: string): Promise<File | null> {
  try {
    const [node, blob] = await Promise.all([getAsset(assetId), getAssetBlob(assetId)])
    if (!blob) return null
    const name = node?.name || 'reference.png'
    return new File([blob], name, { type: blob.type || node?.mime || 'image/png' })
  } catch {
    return null
  }
}

async function runTask(taskId: string): Promise<void> {
  const task = tasks.find((t) => t.id === taskId)
  if (!task || task.status !== 'pending') return

  const promise = (async () => {
    task.status = 'running'
    task.startedAt = Date.now()
    task.error = undefined
    task.debug = undefined
    task.imageMissing = false
    // 生成结果字节（成功路径留存，供归档；失败/取消为 undefined）
    let successBlob: Blob | undefined

    // edit 任务参考原图三来源：会话引用 → 任务快照 assetId（刷新后按 id 解析，B-4）→ 均无则失败。
    let taskReferenceFile: File | undefined
    if (task.mode === 'edit') {
      if (reference) {
        taskReferenceFile = reference.file
      } else if (task.referenceAssetId) {
        const restored = await restoreReferenceFileFromAsset(task.referenceAssetId)
        if (!restored) {
          task.status = 'error'
          task.error = '参考原图已失效（素材库中已无该图片，可能已被清理），请重新上传后再重试。'
          task.finishedAt = Date.now()
          task.durationMs = task.finishedAt - task.startedAt
          return
        }
        taskReferenceFile = restored
      } else if (!task.effectRef) {
        task.status = 'error'
        task.error = '参考原图已丢失（页面刷新过），请重新上传后再重试。'
        task.finishedAt = Date.now()
        task.durationMs = task.finishedAt - task.startedAt
        return
      }
    }

    const advancedParse = parseAdvancedJson(task.advancedJson)
    if (!advancedParse.ok) {
      task.status = 'error'
      task.error = advancedParse.error
      task.finishedAt = Date.now()
      task.durationMs = task.finishedAt - task.startedAt
      return
    }

    const controller = new AbortController()
    controllers.set(taskId, controller)
    try {
      // 案例参照图解析（asset 经 IDB 取字节 / preset 过渡态现场物化）。
      // 失败（离线、缓存清理、案例下架）以任务级中文错误落地，不阻断其他任务。
      let caseFile: File | undefined
      let caseLayout: CaseRefLayout | undefined
      if (task.effectRef) {
        const resolved = await resolveCaseFile(task.effectRef, task, controller.signal)
        caseFile = resolved.file
        caseLayout = resolved.caseLayout
      }

      // [Owner 2026-09-19] 附图顺序即提示词角色声明顺序：[案例参照图(合成), 参考图]——
      // 模型按附图序号理解【图一/图二】，顺序与声明不一致会导致案例图与参考图被混合。
      const images: File[] = []
      if (caseFile) images.push(caseFile)
      if (taskReferenceFile) images.push(taskReferenceFile)

      // 完整指令 = 角色声明（动态编号，按布局描述两半含义）+ 任务要求 + 通用贴钻规则
      // + 模板特化体 + 输出行（组装器拼装）
      const prompt = composeDrillPrompt(task.prompt, {
        hasCase: caseFile !== undefined,
        caseLayout: caseLayout ?? 'single',
        hasReference: taskReferenceFile !== undefined,
      })
      // [4.4] 请求时全文快照落任务（归档 .gemgen composedPrompt 的审计真源）
      task.composedPrompt = prompt

      const params = {
        settings: { ...settings, model: task.model },
        prompt,
        size: task.size,
        advanced: advancedParse.value,
        signal: controller.signal,
      }
      const result =
        images.length > 0
          ? await editImage({ ...params, image: images[0], extraImages: images.slice(1) })
          : await generateImage(params)

      const blob = await imageUrlToBlob(result.imageUrl, controller.signal)

      // 重试成功会再次走到这里：旧 objectURL（若有）先回收再覆盖，防泄漏
      if (task.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(task.imageUrl)
      task.imageUrl = URL.createObjectURL(blob)
      task.imageStored = true
      task.debug = result.debug
      task.status = 'success'
      task.finishedAt = Date.now()
      task.durationMs = task.finishedAt - task.startedAt
      successBlob = blob
    } catch (error) {
      if (isAbortError(error)) {
        task.status = 'cancelled'
        task.error = '已取消'
        task.finishedAt = Date.now()
        task.durationMs = task.finishedAt - task.startedAt
      } else {
        task.status = 'error'
        task.error = error instanceof Error ? error.message : String(error)
        if (error instanceof ImageApiError) task.debug = error.debug
        task.finishedAt = Date.now()
        task.durationMs = task.finishedAt - task.startedAt
      }
    } finally {
      controllers.delete(taskId)
    }

    // [4.3] 成功结果归档（blob+节点同事务入库 + meta.assetId）：失败不改变任务成功态，
    // 由任务终态持久化时的补偿链路幂等补建。
    if (successBlob && task.status === 'success' && !task.assetId) {
      try {
        await enqueueArchive(() => archiveGeneratedResult(task, successBlob as Blob))
      } catch (error) {
        console.warn('生成结果入库失败（将在任务终态持久化时重试）', error)
      }
    }
  })()

  inflight.add(promise)
  try {
    await promise
  } finally {
    inflight.delete(promise)
    persistTasks()
    scheduleArchiveReconcile()
    pump()
  }
}

// ---------------------------------------------------------------------------
// 批量发起
// ---------------------------------------------------------------------------

/** 批次序号：保证同毫秒内两次 startRun 也能生成不同 runId。 */
let runSeq = 0

export function startRun(): StartRunResult {
  if (!settings.baseUrl.trim()) return { ok: false, error: '请先在设置中填写 Base URL。', enqueued: 0 }
  if (!settings.apiKey.trim()) return { ok: false, error: '请先在设置中填写 API Key。', enqueued: 0 }
  if (!settings.model.trim()) return { ok: false, error: '请先在设置中填写模型名。', enqueued: 0 }

  // Advanced JSON 前端拦截：非法则整个 run 不发。
  const advancedParse = parseAdvancedJson(form.advancedJson)
  if (!advancedParse.ok) return { ok: false, error: advancedParse.error, enqueued: 0 }

  const usable = getTemplateList().filter(
    (t) => isEnabledTemplate(t.assetId) && t.promptBody.trim() !== '' && t.candidates >= 1,
  )
  if (usable.length === 0) {
    const anyPrompt = getTemplateList().some((t) => t.promptBody.trim() !== '')
    return {
      ok: false,
      error: anyPrompt ? '没有启用的模板——请在模板列表打开开关。' : '至少需要一个启用且填写了提示词的模板。',
      enqueued: 0,
    }
  }

  let enqueued = 0
  // 本次「开始生成」= 一个批次：同批所有任务共享 runId（画廊分组键）。
  const runId = `run-${Date.now()}-${(runSeq += 1)}`
  for (const template of usable) {
    // 案例绑定按模板携带：mode 也随之逐模板判定（有参考图必走 edits）。
    // [B.1.4] 任务快照 = templateAssetId + promptBody + caseBinding（配置 → 快照降熵链）。
    // [C3.2] blueprint.enabled=true 的模板追加蓝图任务级快照（strategy=发起面板单选 +
    // refs=模板参考图；请求派发/归档消费归 4.3/4.4）。
    const effectRef = caseBindingForRun(template.caseBinding)
    const mode: RunMode = hasReference() || effectRef !== null ? 'edit' : 'generate'
    const blueprint: LabTaskBlueprint | undefined =
      template.blueprint?.enabled === true
        ? { strategy: form.blueprintStrategy, refs: [...(template.blueprint.refs ?? [])] }
        : undefined
    for (let candidateIndex = 0; candidateIndex < template.candidates; candidateIndex += 1) {
      tasks.push({
        id: newId('task'),
        runId,
        variantId: template.assetId,
        variantName: template.name,
        templateAssetId: template.assetId,
        candidateIndex,
        prompt: template.promptBody,
        mode,
        model: settings.model.trim(),
        size: form.size,
        advancedJson: form.advancedJson,
        effectRef: effectRef ? { ...effectRef } : null,
        // 参考原图快照（B-3/B-4）：任务携带 assetId，刷新后重试按 id 解析。
        referenceAssetId: referenceAssetId ?? undefined,
        ...(blueprint !== undefined ? { blueprint: { ...blueprint, refs: [...blueprint.refs] } } : {}),
        status: 'pending',
        imageStored: false,
        createdAt: Date.now() + enqueued, // 保证同批任务顺序稳定
      })
      enqueued += 1
    }
  }
  pump()
  return { ok: true, enqueued }
}

// ---------------------------------------------------------------------------
// 取消 / 重试 / 复用参数
// ---------------------------------------------------------------------------

export function cancelTask(taskId: string): void {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return
  if (task.status === 'running') {
    controllers.get(taskId)?.abort()
    return // 状态由 runTask 的 catch 分支落为 cancelled
  }
  if (task.status === 'pending') {
    task.status = 'cancelled'
    task.error = '已取消'
    persistTasks()
    scheduleArchiveReconcile()
  }
}

export function cancelAll(): void {
  for (const task of tasks) {
    if (task.status === 'running') {
      controllers.get(task.id)?.abort()
    } else if (task.status === 'pending') {
      task.status = 'cancelled'
      task.error = '已取消'
    }
  }
  persistTasks()
  scheduleArchiveReconcile()
}

/** 失败/取消任务重试：输入引用（提示词/模型/Advanced/参考图/效果参考）全部保留，免重传。 */
export function retryTask(taskId: string): void {
  const task = tasks.find((t) => t.id === taskId)
  if (!task || (task.status !== 'error' && task.status !== 'cancelled')) return
  // 有 referenceAssetId 快照时放行进入 runTask（由其按 id 解析并给出失效态）。
  if (task.mode === 'edit' && !hasReference() && !task.effectRef && !task.referenceAssetId) {
    task.status = 'error'
    task.error = '参考原图已丢失（页面刷新过），请重新上传后再重试。'
    persistTasks()
    return
  }
  task.status = 'pending'
  task.error = undefined
  task.debug = undefined
  task.startedAt = undefined
  task.finishedAt = undefined
  task.durationMs = undefined
  persistTasks()
  pump()
}

/**
 * 「复用参数」[4.3 非破坏化，B.1.4]：只回填表单层（model/size/advancedJson——本就是会话态）；
 * 提示词体**不写任何模板**（用旧快照隐式覆写用户可能已编辑的库模板 = 数据损失路径）。
 * 「想用这段提示词」→ 任务卡 [复制提示词]（copyTaskPrompt）或新建模板粘贴。
 */
export function applyTaskParams(taskId: string): void {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return
  form.advancedJson = task.advancedJson
  form.size = task.size
  settings.model = task.model
  saveSettings(settings)
  persistForm()
}

/** [4.3] 任务卡 [复制提示词]：模板特化体快照进剪贴板（不触碰任何模板）。 */
export async function copyTaskPrompt(taskId: string): Promise<boolean> {
  const task = tasks.find((t) => t.id === taskId)
  if (!task || task.prompt === '') return false
  try {
    await navigator.clipboard.writeText(task.prompt)
    showToast('提示词已复制到剪贴板')
    return true
  } catch {
    showToast('复制失败：浏览器剪贴板不可用')
    return false
  }
}

// ---------------------------------------------------------------------------
// 送排钻（4.5 handoff v2：{assetId, name, referenceAssetId?}，[Owner] 直接切换）
// ---------------------------------------------------------------------------

export async function sendToStudio(taskId: string): Promise<boolean> {
  const task = tasks.find((t) => t.id === taskId)
  if (!task || task.status !== 'success') return false
  try {
    // 存库校验/补建：4.3 已入库；会话内入库失败的此处补一次（幂等）
    if (!task.assetId) {
      const blob = task.imageUrl?.startsWith('blob:') ? await imageUrlToBlob(task.imageUrl).catch(() => null) : null
      if (blob) await enqueueArchive(() => archiveGeneratedResult(task, blob))
    }
    if (!task.assetId) {
      task.error = '送排钻失败：生成图未能入库（存储不可用或会话已过期），请重试。'
      return false
    }
    setHandoff({
      assetId: task.assetId,
      name: `${task.variantName}-候选${task.candidateIndex + 1}.png`,
      // 参考原图随交接带资产 id：会话引用优先，回退任务快照（刷新后的历史任务也能带上）
      referenceAssetId: referenceAssetId ?? task.referenceAssetId ?? undefined,
    })
    showToast('已送入排钻设计')
    return true
  } catch (error) {
    task.error = `送排钻失败：${error instanceof Error ? error.message : String(error)}`
    return false
  }
}

// ---------------------------------------------------------------------------
// 清空历史 / 恢复
// ---------------------------------------------------------------------------

/**
 * [B-1] 清空历史只清任务 meta/画廊，不动资产：生成图已入库（4.3），删除/清理由素材库统一负责。
 */
export async function clearHistory(): Promise<void> {
  cancelAll()
  await whenIdle()
  await archiveChain.catch(() => undefined) // 在途归档落地后再清，避免补偿链路复活已清任务
  for (const task of tasks) {
    if (task.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(task.imageUrl)
  }
  tasks.splice(0, tasks.length)
  batchFolderByRun.clear()
  clearTaskMetas()
}

/**
 * 迁移期旧载体（upload / 旧 url 对 / 旧 asset 对）不进入运行态：先置 null，
 * 由 migrateLegacyData 从原始持久化数据物化改绑（失败保留原持久化数据，下次 hydrate 重试）。
 * preset 过渡态直接放行（hydrate 物化改绑；失败同样保留待重试）。
 */
function currentEffectRef(ref: StoredEffectRef | undefined): VariantEffectRef | null {
  if (!ref) return null
  if (ref.kind === 'asset' || ref.kind === 'preset') return ref
  return null
}

/** 案例参照物化的输入源（从持久化原始数据提取）。 */
type CaseMaterializationSource =
  | { kind: 'preset'; presetId: string }
  | { kind: 'legacy-url'; srcUrl?: string; resUrl: string }
  | { kind: 'legacy-asset-pair'; assetIds: { src?: AssetNodeId; res: AssetNodeId } }

/** 物化改绑守卫：当前绑定仍是物化发起时的那个源（未被用户替换）才允许改写。 */
function ownsEffectRef(current: VariantEffectRef | null | undefined, source: CaseMaterializationSource): boolean {
  if (source.kind === 'preset') {
    return current?.kind === 'preset' && current.presetId === source.presetId
  }
  return current === null // 旧载体在 hydrate 时被置 null：null = 仍待迁移改绑
}

/** hydrate 迁移用的物化分派：preset → 幂等物化；旧 url 对 / asset 对 → 取字节合成（入 sys-uploads）。 */
async function materializeEffectRefSource(source: CaseMaterializationSource): Promise<MaterializedCaseRef> {
  if (source.kind === 'preset') return materializePresetEffectRef(source.presetId)
  if (source.kind === 'legacy-url') {
    const res = await fetchCaseBlob(source.resUrl, '案例参照图链接加载失败')
    const src = source.srcUrl ? await fetchCaseBlob(source.srcUrl, '案例参照图链接加载失败') : undefined
    return materializeCaseAsset(src, res, { name: '案例参照图·链接迁移', parentId: 'sys-uploads', source: 'upload' })
  }
  const res = await getAssetBlob(source.assetIds.res).catch(() => null)
  if (!res) throw new Error('案例参照图资产字节缺失（素材库中已无该图片）')
  // 原图字节缺失 → 降级仅效果图（single），仍可作参照
  const src = source.assetIds.src ? await getAssetBlob(source.assetIds.src).catch(() => null) : null
  const resNode = await getAsset(source.assetIds.res).catch(() => null)
  return materializeCaseAsset(src ?? undefined, res, {
    name: `${resNode?.name ?? '案例参照图'}·合成`,
    parentId: 'sys-uploads',
    source: 'upload',
  })
}

/**
 * [4.2 一次性迁移写回 + 案例参照物化 + 4.3 存量归档] hydrate 尾部执行（[4.3] 变体侧
 * 随 variants 信封退役——只迁移**任务快照**的遗留案例载体）：
 * - 案例参照物化（[Owner 2026-09-19 参照对退役]）：任务快照里的 preset 过渡态 / 旧 url 对 /
 *   旧 asset(src+res) 对 → 合成图资产 → 改绑任务快照（物化期间被用户替换 → 放弃改绑，资产留在库中）；
 * - 旧 upload kind（effectref-* blobKey）→ 迁移建节点后按 blobKey 反查为 asset 对，再走同一物化；
 * - 旧链路成功任务（taskId 键 blob、无 assetId）→ 入库批次夹（内容寻址与迁移节点天然去重）。
 * 物化失败 console.warn 保留原持久化数据（下次 hydrate 重试）；成功后写回 localStorage（旧载体从此消失）。
 */
async function migrateLegacyData(rawMetas: PersistedTaskMeta[]): Promise<void> {
  interface PendingBind {
    id: string
    source: CaseMaterializationSource
  }
  const pending: PendingBind[] = []
  const collect = (ref: StoredEffectRef | undefined, id: string): void => {
    // 新 asset 形态无需迁移；upload 载体走下方 blobKey 反查支线
    if (ref && ref.kind !== 'upload' && ref.kind !== 'asset') pending.push({ id, source: ref })
  }
  for (const meta of rawMetas) collect(meta.effectRef, meta.id)

  const legacyUploadTasks = rawMetas.filter((m) => m.effectRef?.kind === 'upload')
  const unarchived = rawMetas.filter((m) => m.status === 'success' && m.imageStored && !m.assetId)
  if (pending.length === 0 && legacyUploadTasks.length === 0 && unarchived.length === 0) return

  if (legacyUploadTasks.length > 0) {
    await runAssetMigration().catch(() => undefined)
    // 按 blobKey 反查节点（迁移已按 blobKey 保留 effectref-* 配对信息）
    const nodeByBlobKey = new Map<string, AssetNodeId>()
    try {
      for (const node of await listAllNodes()) {
        if (node.type === 'image' && node.refKind === 'blob' && node.blobKey && node.trashedAt === undefined) {
          nodeByBlobKey.set(node.blobKey, node.id)
        }
      }
    } catch {
      return // 反查失败：保留可重跑态（下次 hydrate 重跑；pending 一并重试，幂等）
    }
    const pushUploadPair = (id: string, keys: { src: string; res: string }): void => {
      const res = nodeByBlobKey.get(keys.res)
      if (!res) return // res 节点缺失（blob 已被清理）→ 无物化源，维持 null（显式失效，不静默挂错）
      const src = keys.src ? nodeByBlobKey.get(keys.src) : undefined
      pending.push({ id, source: { kind: 'legacy-asset-pair', assetIds: { src, res } } })
    }
    for (const raw of legacyUploadTasks) {
      pushUploadPair(raw.id, (raw.effectRef as LegacyUploadEffectRef).uploadKeys)
    }
  }

  let dirtyTasks = false
  for (const item of pending) {
    let materialized: MaterializedCaseRef
    try {
      materialized = await materializeEffectRefSource(item.source)
    } catch (error) {
      console.warn('案例参照图物化失败（保留原持久化绑定，下次启动重试）', item, error)
      continue
    }
    const next: VariantEffectRef = { kind: 'asset', assetId: materialized.assetId, caseLayout: materialized.caseLayout }
    const task = tasks.find((t) => t.id === item.id)
    if (!task || !ownsEffectRef(task.effectRef, item.source)) continue
    task.effectRef = next
    dirtyTasks = true
  }

  for (const meta of unarchived) {
    const task = tasks.find((t) => t.id === meta.id)
    if (!task) continue
    const blob = await getImageBlob(meta.id).catch(() => null)
    if (!blob) continue
    try {
      await enqueueArchive(() => archiveGeneratedResult(task, blob))
      dirtyTasks = true
    } catch {
      // 下次 hydrate 重试（幂等）
    }
  }
  if (dirtyTasks) persistTasks()
}

export async function hydrate(): Promise<void> {
  if (hydrated) return
  hydrated = true

  // [add-asset-library §3] 启动迁移：异步幂等、不阻塞首屏、不抛。
  void runAssetMigration()

  const persistedForm = loadLabForm()
  if (persistedForm) {
    form.advancedJson = persistedForm.advancedJson
    form.size = persistedForm.size
    // [C3.2] 旧载荷无 blueprintStrategy（saveLabForm 键扩展前）→ 回默认串行
    form.blueprintStrategy = persistedForm.blueprintStrategy ?? 'serial'
  }

  const metas = loadTaskMetas()
  const restored: LabTask[] = []
  for (const meta of metas) {
    const task: LabTask = {
      id: meta.id,
      // 旧持久化数据无 runId：loadTaskMetas 已归一为 'legacy'，此处再兜底一次
      runId: meta.runId || LEGACY_RUN_ID,
      variantId: meta.variantId,
      variantName: meta.variantName,
      templateAssetId: meta.templateAssetId,
      candidateIndex: meta.candidateIndex,
      prompt: meta.prompt,
      composedPrompt: meta.composedPrompt,
      mode: meta.mode,
      model: meta.model,
      size: meta.size,
      advancedJson: meta.advancedJson,
      effectRef: currentEffectRef(meta.effectRef),
      referenceAssetId: meta.referenceAssetId,
      assetId: meta.assetId,
      status: meta.status,
      imageStored: meta.imageStored,
      error: meta.error,
      debug: meta.debug,
      createdAt: meta.createdAt,
      finishedAt: meta.finishedAt,
      durationMs: meta.durationMs,
    }
    if (meta.status === 'success' && meta.imageStored) {
      try {
        // 优先走素材解析出口；[4.4] assetId 可能指向 gemgen 档案节点（getAssetBlob 对
        // 项目节点返回 null）——经 B2 单点出口 getHandoffImageBlob 取内嵌原始字节；
        // 旧链路任务（无 assetId）回退 taskId 键 blob（迁移写回会补齐）。
        const blob = meta.assetId
          ? await getHandoffImageBlob(meta.assetId).catch(() => null)
          : await getImageBlob(meta.id).catch(() => null)
        if (blob) task.imageUrl = URL.createObjectURL(blob)
        else task.imageMissing = true
      } catch {
        task.imageMissing = true
      }
    }
    restored.push(task)
  }
  restored.sort((a, b) => a.createdAt - b.createdAt)
  tasks.splice(0, tasks.length, ...restored)

  await migrateLegacyData(metas)

  // [4.2] 内置模板条目 seed（域管线归域 store，补充稿 A.4.1）：每轮 hydrate 全量检查
  // （create-only：节点存在含软删即跳过，删除不复活；物化失败单模板本轮跳过下轮重试）。
  // await 收口保证时序确定——下方 4.3 迁移引擎在本 seed 之后接线，create-only
  // 自然跳过已 seed 节点（seed 先跑，官方默认就位）。seed 自身永不 reject（逐模板容错）。
  const seedReport = await seedBuiltinTemplates({ materializePreset: materializePresetEffectRef })
  // 素材库投影的外部写入者：写库后触发一次重查（沿 enqueueArchive 先例；失败静默）。
  if (seedReport.created.length > 0) refreshLibrary().catch(() => undefined)

  // [4.3] variants {v:2} → 库模板迁移引擎接线（design §9.3 E3/B6 冻结时序：seed 之后）。
  // 引擎幂等可重入（完成集 + 确定性 id）；pending = 有节点未落定，下轮 hydrate 续跑。
  // 注入面落位：引擎缺省 ingest 不指定 parentId（→ sys-projects）——迁移产物是 gemtpl 模板，
  // 经 deps.ingestProjectAsset 注入 parentId=sys-templates 落到模板目录（列表口径 B.1.1）。
  const migration = await executeTemplateMigration({
    materializePreset: materializePresetEffectRef,
    appVersion: APP_VERSION,
    ingestProjectAsset: (options) => ingestProjectAsset({ ...options, parentId: options.parentId ?? SYS_TEMPLATES_FOLDER_ID }),
  })
  if (migration.state === 'pending') {
    console.warn('variants → 库模板迁移未完成（将在下次启动重试）')
  }
  if (migration.nodes.some((n) => n.status === 'created')) refreshLibrary().catch(() => undefined)
  cleanupExpiredBackup() // 备份 TTL 清理（幂等：done 且 >30 天才动）

  // 模板 store 刷新：列表 + record 解析 + session enabled/选中恢复（引擎已写 lab-session）。
  await refreshTemplates()
}

/** 测试专用：把模块状态整体复位（不动 localStorage/IndexedDB，由测试自行 mock/清理）。 */
export function resetLabForTests(): void {
  cancelAll()
  tasks.splice(0, tasks.length)
  controllers.clear()
  if (reference) URL.revokeObjectURL(reference.previewUrl)
  reference = null
  referenceAssetId = null
  // 只复位会话内模块态（批次夹缓存/种子检查/归档链）；不动 IndexedDB / localStorage
  // （由测试自行 mock/清理，且 hydrate-after-refresh 场景需要 IDB 里的素材数据存活）。
  batchFolderByRun.clear()
  librarySeedChecked = false
  presetMaterializations.clear()
  resetTemplatesForTests()
  form.advancedJson = ''
  form.size = DEFAULT_SIZE
  form.blueprintStrategy = 'serial'
  hydrated = false
}
