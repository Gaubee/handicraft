import { z } from 'zod'

/** BYOK 连接设置：仅存 localStorage，凭据永不离开浏览器。 */
export interface LabSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export const DEFAULT_MODEL = 'gpt-image-2.5'

export const DEFAULT_SETTINGS: LabSettings = {
  baseUrl: '',
  apiKey: '',
  model: DEFAULT_MODEL,
}

const STORAGE_KEY = 'rhinestone-studio:settings'

const settingsSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
})

/** 尾斜杠归一：'https://x/v1/' → 'https://x/v1'（拼接路径前统一）。 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function joinBaseUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

export function loadSettings(): LabSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = settingsSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return { ...DEFAULT_SETTINGS }
    return parsed.data
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 设置独立成 key，永不因任务历史写满配额而丢失
 * （任务持久化的三级降级只作用于任务 key，见 persistence/taskStore.ts）。
 */
export function saveSettings(settings: LabSettings): boolean {
  const normalized: LabSettings = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim(),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    return true
  } catch {
    return false
  }
}
