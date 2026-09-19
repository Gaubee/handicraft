import {
  editImage,
  generateImage,
  ImageApiError,
  maskAdvancedJsonForPersist,
  parseAdvancedJson,
  type ImageTaskDebug,
} from '$lib/api/client'
import { loadSettings, saveSettings, type LabSettings } from '$lib/api/settings'
import { prepareReferenceImage, type PreparedReferenceImage } from '$lib/api/imageInput'
import { getImageBlob, imageUrlToBlob } from '$lib/persistence/imageStore'
import {
  createFolder,
  getAsset,
  getAssetBlob,
  ingestAsset,
  moveAsset,
  listAllNodes,
  listChildNodes,
  objectUrlForAsset,
  renameAsset,
  runAssetMigration,
  trashAsset,
  type AssetNode,
  type AssetNodeId,
} from '$lib/persistence/assetStore'
import { refresh as refreshLibrary } from '$lib/assets/library.svelte'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import {
  clearTaskMetas,
  LEGACY_RUN_ID,
  loadLabForm,
  loadTaskMetas,
  loadVariants,
  saveLabForm,
  saveTaskMetas,
  saveVariants,
  type LegacyUploadEffectRef,
  type PersistedTaskMeta,
  type PersistedTaskStatus,
  type PersistedVariant,
  type StoredEffectRef,
} from '$lib/persistence/taskStore'
import { setHandoff } from './handoff.svelte'
import { showToast } from './toast.svelte'

/**
 * 提示词实验室核心状态（Svelte 5 runes 模块）。
 *
 * 任务模型：每「变体 × 候选序号」一个任务；
 * 状态机 pending → running → success | error | cancelled（AbortController 可取消）；
 * 并发上限 4；失败/取消任务保留全部输入引用，重试免重传。
 */

export const MAX_CONCURRENCY = 4
export const DEFAULT_CANDIDATES = 2
export const DEFAULT_SIZE = '1024x1024'

/**
 * 变体级「效果参考」：一对「原图 + 贴钻效果图」，跟随变体参与生成请求。
 * 来源三种（[add-asset-library 4.2] 双图契约）：
 * - preset：内置案例（见 lib/presets/effectRefs.ts，静态路径直引）
 * - url：用户粘贴的图片直链（逃生舱）
 * - asset：素材库资产引用（上传即入库 sys-uploads；[Owner] 已删旧 upload kind，无兼容分支）
 */
export type VariantEffectRef =
  | { kind: 'preset'; presetId: string }
  | { kind: 'url'; srcUrl?: string; resUrl: string }
  | { kind: 'asset'; assetIds: { src?: AssetNodeId; res: AssetNodeId } }

export interface PromptVariant {
  id: string
  /** 中文名。 */
  name: string
  /** 英文生成指令正文。 */
  prompt: string
  /** 该变体的候选数，默认 2。 */
  candidates: number
  /** 禁用的变体不参与批量生成（默认 true，旧持久化数据缺省视为启用）。 */
  enabled: boolean
  /** 效果参考（旧持久化数据缺省视为 null）。 */
  effectRef?: VariantEffectRef | null
}

export type TaskStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'
export type RunMode = 'generate' | 'edit'

export interface LabTask {
  id: string
  /** 所属批次：一次「开始生成」= 一个 runId，同批任务共享；旧数据迁移为 'legacy'。 */
  runId: string
  variantId: string
  variantName: string
  /** 0 起的候选序号。 */
  candidateIndex: number
  prompt: string
  mode: RunMode
  model: string
  size: string
  advancedJson: string
  /** 发起时的效果参考快照（画廊卡片来源徽章；重试时据此重取参考图）。 */
  effectRef?: VariantEffectRef | null
  /** 发起时的参考原图素材 id（B-3 上传即入库；hydrate 后重试按 id 解析，B-4）。 */
  referenceAssetId?: string
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

/** 画廊分组 = 批次（runId）：一次「开始生成」一组；组间最新在前，组内保持发起顺序。 */
export interface TaskGroup {
  /** 批次 id；旧持久化数据合成 'legacy'。 */
  runId: string
  /** 旧数据合成组：组头显示「更早」，不参与「第 N 次运行」编号。 */
  legacy: boolean
  /** 批次总序号（1 起，按创建先后）；legacy 组为 undefined。 */
  runIndex?: number
  /** 组内最早任务 createdAt（组头 HH:mm 显示用）。 */
  startedAt: number
  /** 组内最新任务 createdAt（组间逆序排序键）。 */
  latestCreatedAt: number
  /** 组内任务，createdAt 升序 = 变体顺序 × 候选序的稳定原始顺序。 */
  tasks: LabTask[]
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
// 默认变体 = 内置案例一一对应（融合：变体天生绑定自己的案例图）。
// id/name/prompt 取自 EFFECT_REF_PRESETS（真实案例数据源），effectRef 固定为
// preset 绑定（图片走 public/presets 静态路径）。已持久化的用户变体列表
// 不受影响——仅代码默认值变化（迁移保持原样）。
// ---------------------------------------------------------------------------

export function defaultVariants(): PromptVariant[] {
  return EFFECT_REF_PRESETS.map((preset) => ({
    id: newId('var'),
    name: preset.name,
    prompt: preset.prompt,
    candidates: DEFAULT_CANDIDATES,
    enabled: true,
    effectRef: { kind: 'preset', presetId: preset.id },
  }))
}

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

const settings = $state<LabSettings>(loadSettings())
const variants = $state<PromptVariant[]>(defaultVariants())
let reference = $state<PreparedReferenceImage | null>(null)
/** 参考原图对应的素材节点 id（上传即入库；任务快照持久化它，刷新后按 id 解析）。 */
let referenceAssetId: string | null = null
const tasks = $state<LabTask[]>([])
const form = $state({ advancedJson: '', size: DEFAULT_SIZE })

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
// 变体
// ---------------------------------------------------------------------------

export function getVariants(): PromptVariant[] {
  return variants
}

function persistVariants(): void {
  saveVariants(variants)
}

export function addVariant(): void {
  variants.push({
    id: newId('var'),
    name: `变体 ${variants.length + 1}`,
    prompt: '',
    candidates: DEFAULT_CANDIDATES,
    enabled: true,
    // 新增变体不自动绑定案例图：案例图区显示空态引导（上传/粘贴链接），
    // 不绑定也允许纯 prompt 生成（mode 走 generate，行为不变）。
    effectRef: null,
  })
  persistVariants()
}

export function updateVariant(id: string, patch: Partial<Omit<PromptVariant, 'id'>>): void {
  const variant = variants.find((v) => v.id === id)
  if (!variant) return
  if (patch.name !== undefined) variant.name = patch.name
  if (patch.prompt !== undefined) variant.prompt = patch.prompt
  if (patch.enabled !== undefined) variant.enabled = patch.enabled
  if (patch.candidates !== undefined) {
    variant.candidates = Math.min(8, Math.max(1, Math.floor(patch.candidates) || 1))
  }
  if (patch.effectRef !== undefined) {
    // [B-2] 替换/清除变体参考不删资产：旧图保留在素材库，回收/清理由素材库统一负责
    variant.effectRef = patch.effectRef
  }
  persistVariants()
}

export function removeVariant(id: string): void {
  const index = variants.findIndex((v) => v.id === id)
  if (index >= 0) {
    // [B-2] 移除变体不删参考资产（资产生命周期归素材库）
    variants.splice(index, 1)
  }
  persistVariants()
}

// ---------------------------------------------------------------------------
// 表单（Advanced JSON / 尺寸）
// ---------------------------------------------------------------------------

export function getForm(): { advancedJson: string; size: string } {
  return form
}

function persistForm(): void {
  saveLabForm({ advancedJson: form.advancedJson, size: form.size })
}

export function updateForm(patch: Partial<{ advancedJson: string; size: string }>): void {
  if (patch.advancedJson !== undefined) form.advancedJson = patch.advancedJson
  if (patch.size !== undefined) form.size = patch.size.trim()
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
// 变体案例图（内置案例 / 直链 / 素材库资产）
// ---------------------------------------------------------------------------

/** asset kind 的展示解析走 assetStore 冻结出口 objectUrlForAsset（按 blobKey 共享 LRU 缓存，
 *  模块内不再自建 objectURL 缓存；满 200 条由 assetStore 统一回收最旧）。 */

/** 两图（原图 + 效果图）时的参考图指代说明（英文，追加在变体 prompt 之后）。 */
export function buildEffectRefPromptClause(hasSourceImage: boolean): string {
  if (hasSourceImage) {
    return (
      ' Reference images attached after the source artwork (if any): the first reference shows the original printed artwork' +
      ' of a real rhinestone kit example, and the second shows its finished rhinestone effect. Reproduce that exact conversion' +
      ' style (element selection, color simplification and level of detail) for the input artwork.'
    )
  }
  return (
    ' A reference image is attached after the source artwork (if any): it shows the finished rhinestone effect of a real' +
    ' rhinestone kit example. Reproduce that exact conversion style (element selection, color simplification and level of' +
    ' detail) for the input artwork.'
  )
}

/** UI 展示用：把三种来源统一解析成 { srcUrl, resUrl }（srcUrl 空串 = 无原图对）。 */
export async function getEffectRefUrls(
  effectRef: VariantEffectRef | null | undefined,
): Promise<{ srcUrl: string; resUrl: string } | null> {
  if (!effectRef) return null
  if (effectRef.kind === 'preset') {
    const preset = EFFECT_REF_PRESETS.find((p) => p.id === effectRef.presetId)
    if (!preset || !preset.resImage) return null
    return { srcUrl: preset.srcImage || '', resUrl: preset.resImage }
  }
  if (effectRef.kind === 'url') {
    const resUrl = effectRef.resUrl?.trim() ?? ''
    if (!resUrl) return null
    return { srcUrl: effectRef.srcUrl?.trim() || '', resUrl }
  }
  // asset kind：经 assetStore 冻结出口解析（软删/缺失 → null，UI 显示空态）
  const resUrl = await objectUrlForAsset(effectRef.assetIds.res).catch(() => null)
  if (!resUrl) return null
  const srcUrl = effectRef.assetIds.src
    ? ((await objectUrlForAsset(effectRef.assetIds.src).catch(() => null)) ?? '')
    : ''
  return { srcUrl, resUrl }
}

/**
 * 上传效果参考：预处理后经 ingestAsset 入库 sys-uploads（B-3 上传即入库），
 * 变体挂 asset 引用。预处理/入库失败直接抛给调用方 toast；此时不动旧值
 * （已入库的半份留在素材库中，由素材库负责回收）。
 */
export async function setVariantEffectRefUpload(variantId: string, src: File | undefined, res: File): Promise<void> {
  const variant = variants.find((v) => v.id === variantId)
  if (!variant) return
  const [srcPrepared, resPrepared] = await Promise.all([
    src ? prepareReferenceImage(src) : Promise.resolve(null),
    prepareReferenceImage(res),
  ])
  await ensureLibrarySeeded()
  const [srcNode, resNode] = await Promise.all([
    srcPrepared
      ? ingestAsset({
          blob: srcPrepared.file,
          name: `${variant.name}·参考原图`,
          width: srcPrepared.width,
          height: srcPrepared.height,
          parentId: 'sys-uploads',
          source: 'upload',
        })
      : Promise.resolve(null),
    ingestAsset({
      blob: resPrepared.file,
      name: `${variant.name}·参考效果`,
      width: resPrepared.width,
      height: resPrepared.height,
      parentId: 'sys-uploads',
      source: 'upload',
      meta: { variantName: variant.name },
    }),
  ])
  // [B-2] 替换不删旧资产：旧参考保留在素材库
  variant.effectRef = { kind: 'asset', assetIds: { src: srcNode?.node.id, res: resNode.node.id } }
  persistVariants()
}

// ---------------------------------------------------------------------------
// 生成请求链路里的效果参考解析（preset 静态路径 / url 直链 → fetch 转 blob）
// ---------------------------------------------------------------------------

function extForMime(type: string): string {
  if (type === 'image/png') return 'png'
  if (type === 'image/webp') return 'webp'
  return 'jpg'
}

function blobToEffectFile(blob: Blob, role: 'src' | 'res'): File {
  const type = blob.type || 'image/jpeg'
  return new File([blob], `effect-${role}.${extForMime(type)}`, { type })
}

async function fetchEffectImage(url: string, role: 'src' | 'res', failureMessage: string, signal?: AbortSignal): Promise<File> {
  try {
    return blobToEffectFile(await imageUrlToBlob(url, signal), role)
  } catch (error) {
    if (isAbortError(error)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${failureMessage}（${reason}）`)
  }
}

/** 解析效果参考为请求用 File 对（src 缺席 = 仅一张参考图）。 */
async function resolveEffectRefFiles(
  ref: VariantEffectRef,
  signal?: AbortSignal,
): Promise<{ src?: File; res: File }> {
  if (ref.kind === 'preset') {
    const preset = EFFECT_REF_PRESETS.find((p) => p.id === ref.presetId)
    if (!preset) throw new Error('效果参考案例已不存在，请重新选择。')
    const src = preset.srcImage
      ? await fetchEffectImage(preset.srcImage, 'src', '效果参考案例原图加载失败，请重试', signal)
      : undefined
    const res = await fetchEffectImage(preset.resImage, 'res', '效果参考案例图加载失败，请重试', signal)
    return { src, res }
  }
  if (ref.kind === 'url') {
    const resUrl = ref.resUrl?.trim()
    if (!resUrl) throw new Error('效果参考已失效，请重新设置。')
    const srcUrl = ref.srcUrl?.trim()
    const src = srcUrl
      ? await fetchEffectImage(srcUrl, 'src', '参考图链接跨域不可取，请下载后上传', signal)
      : undefined
    const res = await fetchEffectImage(resUrl, 'res', '参考图链接跨域不可取，请下载后上传', signal)
    return { src, res }
  }
  if (ref.kind === 'asset') {
    const srcBlob = ref.assetIds.src ? await getAssetBlob(ref.assetIds.src).catch(() => null) : null
    const resBlob = await getAssetBlob(ref.assetIds.res).catch(() => null)
    if (!resBlob) throw new Error('效果参考图已丢失（素材库中已无该图片，可能已被清理），请重新上传。')
    return {
      src: srcBlob ? blobToEffectFile(srcBlob, 'src') : undefined,
      res: blobToEffectFile(resBlob, 'res'),
    }
  }
  // 三种 kind 全覆盖（联合穷尽；控制流到此为 never）
  throw assertNeverEffectRef(ref)
}

function assertNeverEffectRef(ref: never): never {
  throw new Error(`未知效果参考 kind：${String((ref as { kind?: string }).kind)}`)
}

/** 发起 run 前的效果参考有效性检查：res 不可得 → 视为无参考（不阻断其他变体）。 */
function sanitizeEffectRefForRun(ref: VariantEffectRef | null | undefined): VariantEffectRef | null {
  if (!ref) return null
  if (ref.kind === 'preset') {
    const preset = EFFECT_REF_PRESETS.find((p) => p.id === ref.presetId)
    return preset?.resImage ? { kind: 'preset', presetId: preset.id } : null
  }
  if (ref.kind === 'url') {
    const resUrl = ref.resUrl?.trim()
    if (!resUrl) return null
    const srcUrl = ref.srcUrl?.trim()
    return { kind: 'url', srcUrl: srcUrl || undefined, resUrl }
  }
  // asset kind：res 节点 id 在即放行（字节可得性由 runTask 的解析步骤给出任务级错误）
  if (ref.assetIds.res) {
    return { kind: 'asset', assetIds: { src: ref.assetIds.src, res: ref.assetIds.res } }
  }
  return null
}

// ---------------------------------------------------------------------------
// 生成结果归档（4.3：首个成功懒建批次夹 + 三步补偿；[Codex-R1-议题3 修正]）
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

/**
 * 批次夹解析（runId 幂等）：会话缓存 → 同批任一任务的资产节点 parentId →
 * 迁移期确定性 id `ast-batch-<runId>`（assetStore §3 建夹约定）→ 懒建。
 * 有效性口径 = sys-generated 下「未软删」的文件夹（缓存/兄弟引用可能指向已被
 * 空批次清理软删的夹，不复用）。
 * name `MM-DD HH:mm · N 张`：时间戳取批次最早任务 createdAt，N 随成功张数刷新。
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
      const node = await getAsset(t.assetId).catch(() => null)
      if (node?.parentId && validFolders.has(node.parentId)) {
        batchFolderByRun.set(runId, node.parentId)
        return { folderId: node.parentId, created: false }
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

/**
 * 单任务成功结果归档：ingestAsset（blob+节点同事务）→ task.assetId → 批次夹计数命名刷新。
 * 失败时：本调用新建的夹若无图 → 清理不留空夹（软删入回收站）；错误上抛由调用方决定降级。
 */
async function archiveGeneratedResult(task: LabTask, blob: Blob): Promise<void> {
  await ensureLibrarySeeded()
  const earliest = tasks
    .filter((t) => t.runId === task.runId)
    .reduce((min, t) => Math.min(min, t.createdAt), task.createdAt)
  const { folderId, created } = await findOrCreateBatchFolder(task.runId, earliest)
  try {
    const ingested = await ingestAsset({
      blob,
      name: `${task.variantName}·候选${task.candidateIndex + 1}`,
      width: 0,
      height: 0,
      parentId: folderId,
      source: 'lab-generate',
      meta: {
        runId: task.runId,
        variantName: task.variantName,
        candidateIndex: task.candidateIndex,
        prompt: task.prompt,
        // [Owner] 效果图↔参考图配对入资产（跨刷新保持；素材库预览可跳转）
        referenceAssetId: task.referenceAssetId,
      },
    })
    task.assetId = ingested.node.id
  } catch (error) {
    if (created) {
      const children = await listChildNodes(folderId).catch(() => [] as AssetNode[])
      if (!children.some((n) => n.type === 'image')) {
        // 空批次清理（软删入回收站）+ 缓存失效（后续成功重建夹，不复用已删夹）
        await trashAsset(folderId).catch(() => undefined)
        batchFolderByRun.delete(task.runId)
      }
    }
    throw error
  }
  const children = await listChildNodes(folderId).catch(() => [] as AssetNode[])
  const count = children.filter((n) => n.type === 'image' && n.trashedAt === undefined).length
  if (count > 0) await renameAsset(folderId, `${stampOf(earliest)} · ${count} 张`).catch(() => undefined)
}

/** 归档串行链：并发的多任务成功共享同一批次夹解析，避免懒建竞态产生重复夹。 */
let archiveChain: Promise<void> = Promise.resolve()

function enqueueArchive(run: () => Promise<void>): Promise<void> {
  const next = archiveChain.then(run, run)
  archiveChain = next
    .catch(() => undefined)
    // 归档是素材库投影的外部写入者（无通知通道）——落定后触发一次全量重查，
    // 让已打开的素材库视图/选图器看到新资产（Tabs 惰性挂载的重查兜底之外的会话内实时性）；
    // 重查失败静默（下次挂载/操作重试），不阻断归档链
    .then(() => {
      refreshLibrary().catch(() => undefined)
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
  // 一次性快照 Promise.all 会漏掉后续波次。
  while (inflight.size > 0) {
    await Promise.all([...inflight])
  }
}

/**
 * 画廊分组：组 = runId（一次「开始生成」一批）。
 * 组间按组内最新任务 createdAt 逆序（最新批次在前）；组内按 createdAt 升序
 * （= 变体顺序 × 候选序的稳定原始顺序）。runId 缺失（旧内存态兜底）归 legacy。
 */
export function getTaskGroups(): TaskGroup[] {
  const byRun = new Map<string, TaskGroup>()
  for (const task of tasks) {
    const runId = task.runId || LEGACY_RUN_ID
    let group = byRun.get(runId)
    if (!group) {
      group = { runId, legacy: runId === LEGACY_RUN_ID, startedAt: task.createdAt, latestCreatedAt: task.createdAt, tasks: [] }
      byRun.set(runId, group)
    }
    group.tasks.push(task)
    if (task.createdAt < group.startedAt) group.startedAt = task.createdAt
    if (task.createdAt > group.latestCreatedAt) group.latestCreatedAt = task.createdAt
  }
  // 批次序号按创建先后编号（最早 = 第 1 次；legacy 不占号，组头显示「更早」），
  // 再整体逆序返回——用户视角「最新一次点击」永远在最上面。
  const chronological = [...byRun.values()].sort((a, b) => a.latestCreatedAt - b.latestCreatedAt)
  let runNumber = 0
  for (const group of chronological) {
    group.tasks.sort((a, b) => a.createdAt - b.createdAt)
    if (!group.legacy) {
      runNumber += 1
      group.runIndex = runNumber
    }
  }
  chronological.reverse()
  return chronological
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
      candidateIndex: t.candidateIndex,
      prompt: t.prompt,
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
      // 效果参考解析（preset 静态路径 / url 直链 fetch 转 blob / upload 走 IndexedDB）。
      // 失败（跨域、缓存清理、案例下架）以任务级中文错误落地，不阻断其他任务。
      let effectSrc: File | undefined
      let effectRes: File | undefined
      if (task.effectRef) {
        const files = await resolveEffectRefFiles(task.effectRef, controller.signal)
        effectSrc = files.src
        effectRes = files.res
      }

      // 参考图数组顺序即语义：[用户参考原图(若已上传), 效果原图, 效果图]。
      const images: File[] = []
      if (taskReferenceFile) images.push(taskReferenceFile)
      if (effectSrc) images.push(effectSrc)
      if (effectRes) images.push(effectRes)

      const prompt = task.effectRef
        ? task.prompt + buildEffectRefPromptClause(effectSrc !== undefined)
        : task.prompt

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

  const usable = variants.filter((v) => v.enabled && v.prompt.trim() !== '' && v.candidates >= 1)
  if (usable.length === 0) {
    const anyPrompt = variants.some((v) => v.prompt.trim() !== '')
    return {
      ok: false,
      error: anyPrompt ? '没有启用的变体——请在变体组打开开关。' : '至少需要一个启用且填写了提示词的变体。',
      enqueued: 0,
    }
  }

  let enqueued = 0
  // 本次「开始生成」= 一个批次：同批所有任务共享 runId（画廊分组键）。
  const runId = `run-${Date.now()}-${(runSeq += 1)}`
  for (const variant of usable) {
    // 效果参考按变体携带：mode 也随之逐变体判定（有参考图必走 edits）。
    const effectRef = sanitizeEffectRefForRun(variant.effectRef)
    const mode: RunMode = hasReference() || effectRef !== null ? 'edit' : 'generate'
    for (let candidateIndex = 0; candidateIndex < variant.candidates; candidateIndex += 1) {
      tasks.push({
        id: newId('task'),
        runId,
        variantId: variant.id,
        variantName: variant.name,
        candidateIndex,
        prompt: variant.prompt,
        mode,
        model: settings.model.trim(),
        size: form.size,
        advancedJson: form.advancedJson,
        effectRef: effectRef ? { ...effectRef } : null,
        // 参考原图快照（B-3/B-4）：任务携带 assetId，刷新后重试按 id 解析。
        referenceAssetId: referenceAssetId ?? undefined,
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

/** 「复用参数」：把任务用过的提示词/模型/尺寸/Advanced JSON 写回编辑区。 */
export function applyTaskParams(taskId: string): void {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return
  form.advancedJson = task.advancedJson
  form.size = task.size
  settings.model = task.model
  saveSettings(settings)

  const existing = variants.find((v) => v.id === task.variantId)
  if (existing) {
    existing.prompt = task.prompt
  } else {
    variants.push({
      id: newId('var'),
      name: task.variantName,
      prompt: task.prompt,
      candidates: DEFAULT_CANDIDATES,
      enabled: true,
      // 变体与其案例图绑定：重建时带回任务发起时的效果参考快照
      effectRef: task.effectRef ?? null,
    })
  }
  persistVariants()
  persistForm()
}

// ---------------------------------------------------------------------------
// 送转化（4.5 handoff v2：{assetId, name, referenceAssetId?}，[Owner] 直接切换）
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
      task.error = '送转化失败：生成图未能入库（存储不可用或会话已过期），请重试。'
      return false
    }
    setHandoff({
      assetId: task.assetId,
      name: `${task.variantName}-候选${task.candidateIndex + 1}.png`,
      // 参考原图随交接带资产 id：会话引用优先，回退任务快照（刷新后的历史任务也能带上）
      referenceAssetId: referenceAssetId ?? task.referenceAssetId ?? undefined,
    })
    showToast('已送入转化工作台')
    return true
  } catch (error) {
    task.error = `送转化失败：${error instanceof Error ? error.message : String(error)}`
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

/** 迁移期旧 upload 载体先置 null（当前契约不认）；迁移写回后再恢复为 asset 引用。 */
function currentEffectRef(ref: StoredEffectRef | undefined): VariantEffectRef | null {
  return ref && ref.kind !== 'upload' ? ref : null
}

/**
 * [4.2 一次性迁移写回 + 4.3 存量归档] hydrate 尾部执行：
 * - 旧 upload kind（effectref-* blobKey）→ 等迁移建完节点后按 blobKey 反查，写回变体/任务为 asset 引用；
 * - 旧链路成功任务（taskId 键 blob、无 assetId）→ 入库批次夹（内容寻址与迁移节点天然去重）。
 * 仅存在存量待迁移数据时才 await 迁移；全部成功后写回 localStorage（旧载体从此消失）。
 */
async function migrateLegacyData(rawVariants: PersistedVariant[], rawMetas: PersistedTaskMeta[]): Promise<void> {
  const legacyVariantRefs = rawVariants.filter(
    (v): v is PersistedVariant & { effectRef: LegacyUploadEffectRef } => v.effectRef?.kind === 'upload',
  )
  const legacyTaskRefs = rawMetas.filter(
    (m): m is PersistedTaskMeta & { effectRef: LegacyUploadEffectRef } => m.effectRef?.kind === 'upload',
  )
  const unarchived = rawMetas.filter((m) => m.status === 'success' && m.imageStored && !m.assetId)
  if (legacyVariantRefs.length === 0 && legacyTaskRefs.length === 0 && unarchived.length === 0) return

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
    return // 反查失败：保留可重跑态（下次 hydrate 重跑）
  }

  let dirtyVariants = false
  for (const raw of legacyVariantRefs) {
    const keys = raw.effectRef.uploadKeys
    const res = nodeByBlobKey.get(keys.res)
    if (!res) continue // res 节点缺失（blob 已被清理）→ 维持 null（显式失效，不静默挂错）
    const src = keys.src ? nodeByBlobKey.get(keys.src) : undefined
    const variant = variants.find((v) => v.id === raw.id)
    if (variant) {
      variant.effectRef = { kind: 'asset', assetIds: { src, res } }
      dirtyVariants = true
    }
  }
  if (dirtyVariants) persistVariants()

  let dirtyTasks = false
  for (const raw of legacyTaskRefs) {
    const keys = raw.effectRef.uploadKeys
    const res = nodeByBlobKey.get(keys.res)
    if (!res) continue
    const src = keys.src ? nodeByBlobKey.get(keys.src) : undefined
    const task = tasks.find((t) => t.id === raw.id)
    if (task) {
      task.effectRef = { kind: 'asset', assetIds: { src, res } }
      dirtyTasks = true
    }
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

  const persistedVariants = loadVariants()
  if (persistedVariants && persistedVariants.length > 0) {
    variants.splice(
      0,
      variants.length,
      ...persistedVariants.map((v) => ({ ...v, effectRef: currentEffectRef(v.effectRef) })),
    )
  }
  const persistedForm = loadLabForm()
  if (persistedForm) {
    form.advancedJson = persistedForm.advancedJson
    form.size = persistedForm.size
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
      candidateIndex: meta.candidateIndex,
      prompt: meta.prompt,
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
        // 优先走素材解析出口；旧链路任务（无 assetId）回退 taskId 键 blob（迁移写回会补齐）
        const blob = meta.assetId
          ? await getAssetBlob(meta.assetId).catch(() => null)
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

  await migrateLegacyData(persistedVariants ?? [], metas)
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
  variants.splice(0, variants.length, ...defaultVariants())
  form.advancedJson = ''
  form.size = DEFAULT_SIZE
  hydrated = false
}
