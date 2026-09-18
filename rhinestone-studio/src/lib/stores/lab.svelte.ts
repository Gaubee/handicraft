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
import {
  blobToDataUrl,
  deleteImage,
  getImageBlob,
  imageUrlToBlob,
  putImage,
} from '$lib/persistence/imageStore'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import {
  clearTaskMetas,
  loadLabForm,
  loadTaskMetas,
  loadVariants,
  saveLabForm,
  saveTaskMetas,
  saveVariants,
  type PersistedTaskMeta,
  type PersistedTaskStatus,
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
 * 来源三种：
 * - preset：内置案例库（见 lib/presets/effectRefs.ts）
 * - url：用户粘贴的图片直链
 * - upload：本地上传（blob 存 IndexedDB imageStore，uploadKeys 只存 key）
 */
export interface VariantEffectRef {
  kind: 'preset' | 'url' | 'upload'
  /** kind=preset：案例 id。 */
  presetId?: string
  /** kind=url：用户粘贴直链（srcUrl 可空 = 只有效果图）。 */
  srcUrl?: string
  resUrl?: string
  /** kind=upload：IndexedDB imageStore 的 key（src 可为空串 = 只有效果图）。 */
  uploadKeys?: { src: string; res: string }
}

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
  status: TaskStatus
  /** 会话内展示 URL（objectURL / dataURL）。 */
  imageUrl?: string
  /** 生成图 blob 是否已写入 IndexedDB。 */
  imageStored: boolean
  /** 恢复时 IndexedDB 中已无对应 blob。 */
  imageMissing?: boolean
  error?: string
  debug?: ImageTaskDebug
  createdAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface TaskGroup {
  variantId: string
  variantName: string
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
// 默认 5 组提示词变体（提示词要点：仅重画值得贴钻的元素为纯色闭合形状、
// 天空/雪地/远景/人物剔除、5-6 色、透明或纯白背景；正文英文、名称中文）
// ---------------------------------------------------------------------------

const COMMON_TAIL = 'Remove the sky, snow, ground, distant scenery and background figures entirely. Use exactly 5-6 bold colors. Transparent or plain white background.'

export function defaultVariants(): PromptVariant[] {
  return [
    {
      id: newId('var'),
      name: '严格扁平·硬删氛围',
      prompt:
        'Convert this artwork into a flat rhinestone painting template. Redraw ONLY the elements worth decorating with rhinestones, each as one simple solid-color closed shape. Absolutely flat colors: no gradients, no shadows, no texture, no glow. ' +
        COMMON_TAIL,
      candidates: DEFAULT_CANDIDATES,
      enabled: true,
    },
    {
      id: newId('var'),
      name: '保留部分渐变',
      prompt:
        'Convert this artwork into a rhinestone painting template. Keep the main subject as clean closed shapes and preserve soft gradients ONLY inside large areas to retain volume; small details must stay flat solid color. ' +
        COMMON_TAIL,
      candidates: DEFAULT_CANDIDATES,
      enabled: true,
    },
    {
      id: newId('var'),
      name: '描边强调',
      prompt:
        'Convert this artwork into a rhinestone painting template. Give every shape a bold dark outline around a flat solid-color fill, like stained glass or sticker art, so each region reads as a distinct cell. ' +
        COMMON_TAIL,
      candidates: DEFAULT_CANDIDATES,
      enabled: true,
    },
    {
      id: newId('var'),
      name: '浆果逐颗圆点',
      prompt:
        'Convert this artwork into a rhinestone painting template. Render every berry, ornament ball and round fruit as an individual solid circle with its own closed outline, sized like a large gemstone; simplify leaves, ribbons and branches into flat closed shapes. ' +
        COMMON_TAIL,
      candidates: DEFAULT_CANDIDATES,
      enabled: true,
    },
    {
      id: newId('var'),
      name: '极简高光',
      prompt:
        'Convert this artwork into a minimal rhinestone painting template. Flat solid-color closed shapes only, plus at most ONE small white circular highlight per element to suggest sparkle; no other gradients or shadows. ' +
        COMMON_TAIL,
      candidates: DEFAULT_CANDIDATES,
      enabled: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

const settings = $state<LabSettings>(loadSettings())
const variants = $state<PromptVariant[]>(defaultVariants())
let reference = $state<PreparedReferenceImage | null>(null)
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
    // 替换/清除前回收旧 upload kind 的 objectURL 与 IndexedDB blob（防泄漏/防孤儿）
    cleanupUploadEffectRef(variant.effectRef)
    variant.effectRef = patch.effectRef
  }
  persistVariants()
}

export function removeVariant(id: string): void {
  const index = variants.findIndex((v) => v.id === id)
  if (index >= 0) {
    cleanupUploadEffectRef(variants[index].effectRef)
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

export async function setReference(file: File): Promise<void> {
  const prepared = await prepareReferenceImage(file)
  if (reference) URL.revokeObjectURL(reference.previewUrl)
  reference = prepared
}

export function clearReference(): void {
  if (reference) URL.revokeObjectURL(reference.previewUrl)
  reference = null
}

export function hasReference(): boolean {
  return reference !== null
}

// ---------------------------------------------------------------------------
// 变体效果参考（案例库 / 直链 / 本地上传）
// ---------------------------------------------------------------------------

/** upload kind 的展示 objectURL 缓存（key = imageStore key，替换/清除时 revoke）。 */
const effectRefObjectUrls = new Map<string, string>()

async function objectUrlForKey(key: string): Promise<string | null> {
  const cached = effectRefObjectUrls.get(key)
  if (cached) return cached
  const blob = await getImageBlob(key).catch(() => null)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  effectRefObjectUrls.set(key, url)
  return url
}

/** 回收 upload kind 的 objectURL 缓存并删除 IndexedDB blob（孤儿清理，失败静默）。 */
function cleanupUploadEffectRef(ref: VariantEffectRef | null | undefined): void {
  if (!ref || ref.kind !== 'upload' || !ref.uploadKeys) return
  for (const key of [ref.uploadKeys.src, ref.uploadKeys.res]) {
    if (!key) continue
    const url = effectRefObjectUrls.get(key)
    if (url) {
      URL.revokeObjectURL(url)
      effectRefObjectUrls.delete(key)
    }
    void deleteImage(key).catch(() => undefined)
  }
}

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
  const resUrl = effectRef.uploadKeys?.res ? await objectUrlForKey(effectRef.uploadKeys.res) : null
  if (!resUrl) return null
  const srcUrl = effectRef.uploadKeys?.src ? ((await objectUrlForKey(effectRef.uploadKeys.src)) ?? '') : ''
  return { srcUrl, resUrl }
}

/** 上传效果参考：blob 经 prepareReferenceImage 预处理后存 IndexedDB，变体只挂 key。 */
export async function setVariantEffectRefUpload(variantId: string, src: File | undefined, res: File): Promise<void> {
  const variant = variants.find((v) => v.id === variantId)
  if (!variant) return
  // 预处理失败（MIME 非法等）直接抛给调用方 toast；此时不动旧值。
  const [srcPrepared, resPrepared] = await Promise.all([
    src ? prepareReferenceImage(src) : Promise.resolve(null),
    prepareReferenceImage(res),
  ])
  const timestamp = Date.now()
  const srcKey = srcPrepared ? `effectref-${variantId}-src-${timestamp}` : ''
  const resKey = `effectref-${variantId}-res-${timestamp}`
  if (srcPrepared) {
    URL.revokeObjectURL(srcPrepared.previewUrl) // 展示走 getEffectRefUrls 的缓存，此预览即弃
    await putImage(srcKey, srcPrepared.file)
  }
  URL.revokeObjectURL(resPrepared.previewUrl)
  await putImage(resKey, resPrepared.file)
  cleanupUploadEffectRef(variant.effectRef)
  variant.effectRef = { kind: 'upload', uploadKeys: { src: srcKey, res: resKey } }
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
  const keys = ref.uploadKeys
  if (!keys?.res) throw new Error('效果参考已失效，请重新设置。')
  const srcBlob = keys.src ? await getImageBlob(keys.src).catch(() => null) : null
  const resBlob = await getImageBlob(keys.res).catch(() => null)
  if (!resBlob) throw new Error('效果参考图已丢失（浏览器存储被清理或变体已移除该参考），请重新上传。')
  return {
    src: srcBlob ? blobToEffectFile(srcBlob, 'src') : undefined,
    res: blobToEffectFile(resBlob, 'res'),
  }
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
  if (ref.uploadKeys?.res) {
    return { kind: 'upload', uploadKeys: { src: ref.uploadKeys.src || '', res: ref.uploadKeys.res } }
  }
  return null
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

export function getTaskGroups(): TaskGroup[] {
  const groups: TaskGroup[] = []
  for (const task of tasks) {
    let group = groups.find((g) => g.variantId === task.variantId)
    if (!group) {
      group = { variantId: task.variantId, variantName: task.variantName, tasks: [] }
      groups.push(group)
    }
    group.tasks.push(task)
  }
  return groups
}

function isTerminalTask(t: LabTask): t is LabTask & { status: PersistedTaskStatus } {
  return t.status === 'success' || t.status === 'error' || t.status === 'cancelled'
}

function persistTasks(): void {
  const metas: PersistedTaskMeta[] = tasks
    .filter(isTerminalTask)
    .map((t) => ({
      id: t.id,
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

async function runTask(taskId: string): Promise<void> {
  const task = tasks.find((t) => t.id === taskId)
  if (!task || task.status !== 'pending') return

  const promise = (async () => {
    task.status = 'running'
    task.startedAt = Date.now()
    task.error = undefined
    task.debug = undefined
    task.imageMissing = false

    // edit 任务但参考图与效果参考均已丢失（刷新后重试）：直接失败，不发请求。
    if (task.mode === 'edit' && !hasReference() && !task.effectRef) {
      task.status = 'error'
      task.error = '参考原图已丢失（页面刷新过），请重新上传后再重试。'
      task.finishedAt = Date.now()
      task.durationMs = task.finishedAt - task.startedAt
      return
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
      if (task.mode === 'edit' && reference) images.push(reference.file)
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
      await putImage(taskId, blob)

      // 重试成功会再次走到这里：旧 objectURL（若有）先回收再覆盖，防泄漏
      if (task.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(task.imageUrl)
      task.imageUrl = URL.createObjectURL(blob)
      task.imageStored = true
      task.debug = result.debug
      task.status = 'success'
      task.finishedAt = Date.now()
      task.durationMs = task.finishedAt - task.startedAt
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
  })()

  inflight.add(promise)
  try {
    await promise
  } finally {
    inflight.delete(promise)
    persistTasks()
    pump()
  }
}

// ---------------------------------------------------------------------------
// 批量发起
// ---------------------------------------------------------------------------

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
  for (const variant of usable) {
    // 效果参考按变体携带：mode 也随之逐变体判定（有参考图必走 edits）。
    const effectRef = sanitizeEffectRefForRun(variant.effectRef)
    const mode: RunMode = hasReference() || effectRef !== null ? 'edit' : 'generate'
    for (let candidateIndex = 0; candidateIndex < variant.candidates; candidateIndex += 1) {
      tasks.push({
        id: newId('task'),
        variantId: variant.id,
        variantName: variant.name,
        candidateIndex,
        prompt: variant.prompt,
        mode,
        model: settings.model.trim(),
        size: form.size,
        advancedJson: form.advancedJson,
        effectRef: effectRef ? { ...effectRef } : null,
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
}

/** 失败/取消任务重试：输入引用（提示词/模型/Advanced/参考图/效果参考）全部保留，免重传。 */
export function retryTask(taskId: string): void {
  const task = tasks.find((t) => t.id === taskId)
  if (!task || (task.status !== 'error' && task.status !== 'cancelled')) return
  if (task.mode === 'edit' && !hasReference() && !task.effectRef) {
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
    })
  }
  persistVariants()
  persistForm()
}

// ---------------------------------------------------------------------------
// 送转化
// ---------------------------------------------------------------------------

export async function sendToStudio(taskId: string): Promise<boolean> {
  const task = tasks.find((t) => t.id === taskId)
  if (!task || task.status !== 'success') return false
  try {
    // 优先取 IndexedDB 的持久副本；不可用时回退到会话内 URL。
    let blob: Blob | null = null
    if (task.imageStored) blob = await getImageBlob(taskId).catch(() => null)
    if (!blob && task.imageUrl) blob = await imageUrlToBlob(task.imageUrl)
    if (!blob) {
      task.error = '送转化失败：图片缓存已失效，请重试恢复。'
      return false
    }
    const dataUrl = await blobToDataUrl(blob)
    setHandoff({
      image: dataUrl,
      name: `${task.variantName}-候选${task.candidateIndex + 1}.png`,
      // 参考原图随交接带过去：工作台「叠原图」预览零二次上传（R3）。
      // 用 dataUrl 而非 objectURL，避免 clearReference 撤销后工作台侧失效。
      reference: reference ? { dataUrl: await blobToDataUrl(reference.file), name: reference.file.name } : undefined,
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

export async function clearHistory(): Promise<void> {
  cancelAll()
  await whenIdle()
  for (const task of tasks) {
    if (task.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(task.imageUrl)
    if (task.imageStored) await deleteImage(task.id).catch(() => undefined)
  }
  tasks.splice(0, tasks.length)
  clearTaskMetas()
}

export async function hydrate(): Promise<void> {
  if (hydrated) return
  hydrated = true

  const persistedVariants = loadVariants()
  if (persistedVariants && persistedVariants.length > 0) {
    variants.splice(0, variants.length, ...persistedVariants)
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
      variantId: meta.variantId,
      variantName: meta.variantName,
      candidateIndex: meta.candidateIndex,
      prompt: meta.prompt,
      mode: meta.mode,
      model: meta.model,
      size: meta.size,
      advancedJson: meta.advancedJson,
      effectRef: meta.effectRef ?? null,
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
        const blob = await getImageBlob(meta.id)
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
}

/** 测试专用：把模块状态整体复位（不动 localStorage/IndexedDB，由测试自行 mock/清理）。 */
export function resetLabForTests(): void {
  cancelAll()
  tasks.splice(0, tasks.length)
  controllers.clear()
  if (reference) URL.revokeObjectURL(reference.previewUrl)
  reference = null
  // 只回收会话内 objectURL；不动 IndexedDB / localStorage（由测试自行 mock/清理，
  // 且 hydrate-after-refresh 场景需要 IDB 里的效果参考 blob 存活）。
  for (const url of effectRefObjectUrls.values()) URL.revokeObjectURL(url)
  effectRefObjectUrls.clear()
  variants.splice(0, variants.length, ...defaultVariants())
  form.advancedJson = ''
  form.size = DEFAULT_SIZE
  hydrated = false
}
