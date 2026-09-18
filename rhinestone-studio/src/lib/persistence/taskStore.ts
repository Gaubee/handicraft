/**
 * 任务元数据 / 变体 / 表单的 localStorage 持久化。
 *
 * 配额三级降级（对应 spec prompt-lab「持久化与配额降级」）：
 *   全量 → 去 payload（剥 debug）→ 仅最近 50 条
 * 设置存独立 key（见 api/settings.ts），任何降级都不触碰设置。
 */

import type { ImageTaskDebug } from '$lib/api/client'

const TASKS_KEY = 'rhinestone-studio:tasks'
const VARIANTS_KEY = 'rhinestone-studio:variants'
const FORM_KEY = 'rhinestone-studio:form'

const RECENT_TASKS_FALLBACK = 50
const MAX_TASKS = 500

export type PersistedTaskStatus = 'success' | 'error' | 'cancelled'

export interface PersistedTaskMeta {
  id: string
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
    size: typeof v.size === 'string' ? v.size : '',
    hasReference: v.hasReference === true,
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
