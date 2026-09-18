/**
 * 任务元数据 / 变体 / 表单的 localStorage 持久化。
 *
 * 配额三级降级（对应 spec prompt-lab「持久化与配额降级」）：
 *   全量 → 去 payload（剥 debug）→ 仅最近 50 条
 * 设置存独立 key（见 api/settings.ts），任何降级都不触碰设置。
 */

import type { ImageTaskDebug } from '$lib/api/client'
import type { VariantEffectRef } from '$lib/stores/lab.svelte'

const TASKS_KEY = 'rhinestone-studio:tasks'
const VARIANTS_KEY = 'rhinestone-studio:variants'
const FORM_KEY = 'rhinestone-studio:form'

const RECENT_TASKS_FALLBACK = 50
const MAX_TASKS = 500

/**
 * 旧持久化数据（无 runId 字段）迁移归入的合成批次 id。
 * 新批次 id 形如 `run-…`，永不与之碰撞。
 */
export const LEGACY_RUN_ID = 'legacy'

export type PersistedTaskStatus = 'success' | 'error' | 'cancelled'

export interface PersistedTaskMeta {
  id: string
  /** 所属批次（一次「开始生成」）；旧数据缺省归 LEGACY_RUN_ID。 */
  runId?: string
  variantId: string
  variantName: string
  candidateIndex: number
  prompt: string
  mode: 'generate' | 'edit'
  model: string
  size: string
  advancedJson: string
  status: PersistedTaskStatus
  hasReference: boolean
  /** 效果参考快照（画廊卡片来源徽章用；upload kind 仅存 IndexedDB key）。 */
  effectRef?: VariantEffectRef | null
  /** 生成图 blob 是否已写入 IndexedDB。 */
  imageStored: boolean
  error?: string
  createdAt: number
  finishedAt?: number
  durationMs?: number
  debug?: ImageTaskDebug
}

export type DegradationLevel = 'full' | 'no-payload' | 'recent-50' | 'failed'

export interface SaveTasksOutcome {
  level: DegradationLevel
  error?: unknown
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (error) {
    // 配额/隐私模式异常：调用方决定降级策略。
    return false
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function stripDebug(task: PersistedTaskMeta): PersistedTaskMeta {
  const { debug: _debug, ...rest } = task
  return rest
}

/**
 * 三级降级写入。返回实际达到的层级。
 * 无论降到哪一级，都不会抛出——配额异常不应打断生成流程。
 */
export function saveTaskMetas(tasks: PersistedTaskMeta[]): SaveTasksOutcome {
  const trimmed = tasks.slice(-MAX_TASKS)

  // L1 全量
  if (writeJson(TASKS_KEY, trimmed)) return { level: 'full' }

  // L2 去 payload（剥 debug，保留任务史）
  const stripped = trimmed.map(stripDebug)
  if (writeJson(TASKS_KEY, stripped)) return { level: 'no-payload' }

  // L3 仅最近 50 条
  const recent = stripped.slice(-RECENT_TASKS_FALLBACK)
  if (writeJson(TASKS_KEY, recent)) return { level: 'recent-50' }

  return { level: 'failed' }
}

function isPersistedTaskStatus(value: unknown): value is PersistedTaskStatus {
  return value === 'success' || value === 'error' || value === 'cancelled'
}

/**
 * 效果参考快照的宽松校验/归一：非法结构落 null（旧持久化数据无该字段 → null）。
 * upload kind 只含 IndexedDB key，不含图片数据本体。
 */
function normalizeEffectRef(value: unknown): VariantEffectRef | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const v = value as Partial<VariantEffectRef>
  if (v.kind === 'preset' && typeof v.presetId === 'string' && v.presetId.trim()) {
    return { kind: 'preset', presetId: v.presetId }
  }
  if (v.kind === 'url' && typeof v.resUrl === 'string' && v.resUrl.trim()) {
    const src = typeof v.srcUrl === 'string' && v.srcUrl.trim() ? v.srcUrl : undefined
    return { kind: 'url', srcUrl: src, resUrl: v.resUrl }
  }
  if (
    v.kind === 'upload' &&
    v.uploadKeys !== null &&
    typeof v.uploadKeys === 'object' &&
    typeof v.uploadKeys.res === 'string' &&
    v.uploadKeys.res.trim()
  ) {
    return {
      kind: 'upload',
      uploadKeys: { src: typeof v.uploadKeys.src === 'string' ? v.uploadKeys.src : '', res: v.uploadKeys.res },
    }
  }
  return null
}

function restoreTask(value: unknown): PersistedTaskMeta | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Partial<PersistedTaskMeta>
  if (
    typeof v.id !== 'string' ||
    typeof v.variantId !== 'string' ||
    typeof v.variantName !== 'string' ||
    typeof v.candidateIndex !== 'number' ||
    typeof v.prompt !== 'string' ||
    (v.mode !== 'generate' && v.mode !== 'edit') ||
    typeof v.model !== 'string' ||
    typeof v.advancedJson !== 'string' ||
    !isPersistedTaskStatus(v.status) ||
    typeof v.createdAt !== 'number'
  ) {
    return null
  }
  return {
    ...v,
    // 旧数据无 runId：归入合成批次 'legacy'（组头显示「更早」），避免缺失字段导致分组崩溃
    runId: typeof v.runId === 'string' && v.runId.trim() ? v.runId : LEGACY_RUN_ID,
    size: typeof v.size === 'string' ? v.size : '',
    hasReference: v.hasReference === true,
    effectRef: normalizeEffectRef(v.effectRef),
    imageStored: v.imageStored === true,
    error: typeof v.error === 'string' ? v.error : undefined,
    finishedAt: typeof v.finishedAt === 'number' ? v.finishedAt : undefined,
    durationMs: typeof v.durationMs === 'number' ? v.durationMs : undefined,
    debug: v.debug,
  } as PersistedTaskMeta
}

export function loadTaskMetas(): PersistedTaskMeta[] {
  const raw = readJson<unknown[]>(TASKS_KEY)
  if (!Array.isArray(raw)) return []
  return raw.map(restoreTask).filter((t): t is PersistedTaskMeta => t !== null)
}

export function clearTaskMetas(): void {
  try {
    localStorage.removeItem(TASKS_KEY)
  } catch {
    // 忽略：隐私模式下 removeItem 也可能抛。
  }
}

// ---------------------------------------------------------------------------
// 变体与表单（小体量，独立 key，配额异常静默丢弃但不影响设置/任务）
// ---------------------------------------------------------------------------

export interface PersistedVariant {
  id: string
  name: string
  prompt: string
  candidates: number
  enabled: boolean
  /** 变体级效果参考（旧持久化数据无该字段 → 归一为 null）。 */
  effectRef?: VariantEffectRef | null
}

export function saveVariants(variants: PersistedVariant[]): boolean {
  return writeJson(VARIANTS_KEY, variants.slice(0, 32).map((v) => ({ ...v, prompt: v.prompt.slice(0, 8000) })))
}

export function loadVariants(): PersistedVariant[] | null {
  const raw = readJson<unknown[]>(VARIANTS_KEY)
  if (!Array.isArray(raw)) return null
  const restored = raw
    .map((value): PersistedVariant | null => {
      if (value === null || typeof value !== 'object') return null
      const v = value as Partial<PersistedVariant>
      if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.prompt !== 'string' || typeof v.candidates !== 'number') {
        return null
      }
      return {
        id: v.id,
        name: v.name,
        prompt: v.prompt,
        candidates: Math.min(8, Math.max(1, Math.floor(v.candidates))),
        // 旧数据无 enabled 字段：仅显式 false 视为禁用，缺省视为启用
        enabled: v.enabled !== false,
        // 旧数据无 effectRef 字段：归一为 null（upload kind 只存 IndexedDB key）
        effectRef: normalizeEffectRef(v.effectRef),
      }
    })
    .filter((v): v is PersistedVariant => v !== null)
  return restored
}

export interface PersistedLabForm {
  advancedJson: string
  size: string
}

export function saveLabForm(form: PersistedLabForm): boolean {
  return writeJson(FORM_KEY, { advancedJson: form.advancedJson.slice(0, 20000), size: form.size.slice(0, 32) })
}

export function loadLabForm(): PersistedLabForm | null {
  const raw = readJson<Partial<PersistedLabForm>>(FORM_KEY)
  if (raw === null || typeof raw.advancedJson !== 'string' || typeof raw.size !== 'string') return null
  return { advancedJson: raw.advancedJson, size: raw.size }
}
