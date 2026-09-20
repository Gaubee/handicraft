/**
 * 任务元数据 / 变体 / 表单的 localStorage 持久化。
 *
 * 配额三级降级（对应 spec prompt-lab「持久化与配额降级」）：
 *   全量 → 去 payload（剥 debug）→ 仅最近 50 条
 * 设置存独立 key（见 api/settings.ts），任何降级都不触碰设置。
 */

import type { ImageTaskDebug } from '$lib/api/client'
import type { VariantEffectRef } from '$lib/stores/lab.svelte'
import type { AssetNodeId } from '$lib/persistence/assetStore'
import type { CaseRefLayout } from '$lib/lab/caseComposite'
import {
  normalizeLabTaskBlueprint,
  normalizeLabTaskDrillParams,
  normalizePersistedStages,
  type LabTaskBlueprint,
  type LabTaskDrillParams,
  type PersistedStageMeta,
} from '$lib/lab/stages'

export const TASKS_KEY = 'rhinestone-studio:tasks'
/** 变体信封 key（[add-project-files 0.8] 导出供迁移引擎删除/存在性检查；唯一真源仍在本模块）。 */
export const VARIANTS_KEY = 'rhinestone-studio:variants'
const FORM_KEY = 'rhinestone-studio:form'

const RECENT_TASKS_FALLBACK = 50
const MAX_TASKS = 500

/**
 * 旧持久化数据（无 runId 字段）迁移归入的合成批次 id。
 * 新批次 id 形如 `run-…`，永不与之碰撞。
 */
export const LEGACY_RUN_ID = 'legacy'

export type PersistedTaskStatus = 'success' | 'error' | 'cancelled'

/**
 * [add-asset-library 4.2] 旧 upload kind 的只读载体：写路径已删（[Owner] 无兼容分支），
 * 仅保留读取能力供 lab hydrate 做一次性迁移写回（uploadKeys 反查节点 → 物化合成图后改绑），
 * 迁移后永不再出现在新写入的数据里。
 */
export interface LegacyUploadEffectRef {
  kind: 'upload'
  uploadKeys: { src: string; res: string }
}

/**
 * [Owner 2026-09-19 参照对退役] 旧「url 直链对」的只读载体（url kind 已删，提交时即物化）：
 * hydrate 读到后物化为合成图资产并改绑，迁移后消失。
 */
export interface LegacyUrlEffectRef {
  kind: 'legacy-url'
  srcUrl?: string
  resUrl: string
}

/**
 * [Owner 2026-09-19 参照对退役] 旧「asset src+res 双图对」的只读载体：
 * hydrate 读到后物化为合成图资产并改绑，迁移后消失。
 * （旧持久化数据里 kind 写作 'asset' + assetIds；normalizeEffectRef 读取时重打标签，
 * 与新 asset 形态 {assetId, caseLayout} 在类型上彻底分离。）
 */
export interface LegacyAssetPairEffectRef {
  kind: 'legacy-asset-pair'
  assetIds: { src?: AssetNodeId; res: AssetNodeId }
}

/** 持久化层的效果参考形状（当前契约 + 迁移期旧载体）。 */
export type StoredEffectRef =
  | VariantEffectRef
  | LegacyUrlEffectRef
  | LegacyAssetPairEffectRef
  | LegacyUploadEffectRef
  | null

export interface PersistedTaskMeta {
  id: string
  /** 所属批次（一次「开始生成」）；旧数据缺省归 LEGACY_RUN_ID。 */
  runId?: string
  variantId: string
  variantName: string
  /** [add-project-files 4.3] 模板资产 id 快照（画廊过滤键；legacy 会话任务缺省）。 */
  templateAssetId?: string
  candidateIndex: number
  prompt: string
  /**
   * [add-project-files 4.4] 请求时实际发出的提示词全文快照（composeDrillPrompt 输出，
   * 含动态角色声明/DRILL_RULES 骨架）。归档 .gemgen provenance.composedPrompt 的消费
   * 真源（审计链：模板存可编辑体、任务快照可重试、档案存当时全文）；刷新后补偿归档
   * 仍能落全文。legacy 数据（快照引入前）缺省——归档侧按附件形态推断重建。
   */
  composedPrompt?: string
  mode: 'generate' | 'edit'
  model: string
  size: string
  advancedJson: string
  status: PersistedTaskStatus
  hasReference: boolean
  /** 原图素材 id（[add-asset-library B-3/B-4]：上传即入库，hydrate 后按 id 解析重试输入）。 */
  referenceAssetId?: string
  /** 生成结果素材节点 id（[add-asset-library 4.3]：首个成功时入库批次夹）。 */
  assetId?: AssetNodeId
  /** 效果参考快照（画廊卡片来源徽章用；asset kind 存素材节点 id）。 */
  effectRef?: StoredEffectRef
  /** 生成图 blob 是否已持久化（新链路 = 已入库素材；旧数据 = taskId 键 blob）。 */
  imageStored: boolean
  error?: string
  createdAt: number
  finishedAt?: number
  durationMs?: number
  debug?: ImageTaskDebug
  /**
   * [add-lab-drill-params 2.3] 终态 stage 快照（terminal-only——pending/running 不落账本，
   * 刷新即丢；imageUrl/debug 瞬态不落）。缺席 = legacy 账本（读时经 stagesFromPersisted
   * 合成单 main stage 只读兼容）。写侧状态 = persistedTaskStatusOf(stages)。
   */
  stages?: PersistedStageMeta[]
  /** [add-lab-drill-params 2.3] 任务侧水钻参数快照（specs/physical/materialAssetIds——刷新后重试/补偿归档免重解析目录）。 */
  drillParams?: LabTaskDrillParams
  /** [add-lab-drill-params 2.3] 任务侧蓝图快照（strategy/refs）。 */
  blueprint?: LabTaskBlueprint
  /** [placeholders] 案例参照图效果提示词覆盖快照（刷新后重试保持同片段；缺席 = auto）。 */
  casePromptFragment?: string
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
 * 当前契约：asset kind 存合成图素材节点 id + caseLayout；preset kind 为「未物化」过渡态。
 * 旧载体（url / asset src+res 对 / upload）读取时重打 legacy-* 标签，仅供 lab hydrate
 * 一次性物化改绑（[Owner] 无兼容分支，新写入永不出现）。
 */
const CASE_LAYOUTS: readonly string[] = ['horizontal', 'vertical', 'single']

function normalizeEffectRef(value: unknown): StoredEffectRef {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const v = value as {
    kind?: unknown
    presetId?: unknown
    assetId?: unknown
    caseLayout?: unknown
    srcUrl?: unknown
    resUrl?: unknown
    assetIds?: { src?: unknown; res?: unknown } | null
    uploadKeys?: { src?: unknown; res?: unknown } | null
  }
  if (v.kind === 'preset' && typeof v.presetId === 'string' && v.presetId.trim()) {
    return { kind: 'preset', presetId: v.presetId }
  }
  if (
    v.kind === 'asset' &&
    typeof v.assetId === 'string' &&
    v.assetId.trim() &&
    typeof v.caseLayout === 'string' &&
    CASE_LAYOUTS.includes(v.caseLayout)
  ) {
    return { kind: 'asset', assetId: v.assetId, caseLayout: v.caseLayout as CaseRefLayout }
  }
  if (v.kind === 'asset' && v.assetIds !== null && typeof v.assetIds === 'object' && typeof v.assetIds.res === 'string' && v.assetIds.res.trim()) {
    return {
      kind: 'legacy-asset-pair',
      assetIds: {
        src: typeof v.assetIds.src === 'string' && v.assetIds.src.trim() ? v.assetIds.src : undefined,
        res: v.assetIds.res,
      },
    }
  }
  if (v.kind === 'url' && typeof v.resUrl === 'string' && v.resUrl.trim()) {
    const src = typeof v.srcUrl === 'string' && v.srcUrl.trim() ? v.srcUrl : undefined
    return { kind: 'legacy-url', srcUrl: src, resUrl: v.resUrl }
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
    referenceAssetId: typeof v.referenceAssetId === 'string' && v.referenceAssetId ? v.referenceAssetId : undefined,
    templateAssetId: typeof v.templateAssetId === 'string' && v.templateAssetId ? v.templateAssetId : undefined,
    composedPrompt: typeof v.composedPrompt === 'string' && v.composedPrompt ? v.composedPrompt : undefined,
    assetId: typeof v.assetId === 'string' && v.assetId ? v.assetId : undefined,
    effectRef: normalizeEffectRef(v.effectRef),
    imageStored: v.imageStored === true,
    error: typeof v.error === 'string' ? v.error : undefined,
    finishedAt: typeof v.finishedAt === 'number' ? v.finishedAt : undefined,
    durationMs: typeof v.durationMs === 'number' ? v.durationMs : undefined,
    debug: v.debug,
    // [add-lab-drill-params 2.3] stage 终态快照与高级选项快照：坏结构丢字段不丢任务
    stages: normalizePersistedStages(v.stages),
    drillParams: normalizeLabTaskDrillParams(v.drillParams),
    blueprint: normalizeLabTaskBlueprint(v.blueprint),
    // [placeholders] 案例片段覆盖快照（非字符串 = 丢弃回 auto）
    casePromptFragment: typeof v.casePromptFragment === 'string' ? v.casePromptFragment : undefined,
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
  /** 变体级效果参考（旧持久化数据无该字段 → 归一为 null；迁移期 upload 载体由 lab hydrate 写回）。 */
  effectRef?: StoredEffectRef
}

/** 模板持久化版本门（[Owner] 无兼容）：载荷形态 {v, items}；v 缺失或不等于当前默认代数
 *  → 返回 null（hydrate 回落新默认模板），旧「全钻中间稿」模板整体退役不迁移。 */
const VARIANTS_PAYLOAD_VERSION = 2

interface StoredVariantsPayload {
  v: number
  items: PersistedVariant[]
}

export function saveVariants(variants: PersistedVariant[]): boolean {
  const items = variants.slice(0, 32).map((v) => ({ ...v, prompt: v.prompt.slice(0, 8000) }))
  return writeJson(VARIANTS_KEY, { v: VARIANTS_PAYLOAD_VERSION, items } satisfies StoredVariantsPayload)
}

export function loadVariants(): PersistedVariant[] | null {
  const raw = readJson<unknown>(VARIANTS_KEY)
  // 旧数组载荷（无版本）或版本不匹配 → null：重置为当前默认模板
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const payload = raw as Partial<StoredVariantsPayload>
  if (payload.v !== VARIANTS_PAYLOAD_VERSION || !Array.isArray(payload.items)) return null
  return normalizeVariants(payload.items)
}

/**
 * [add-project-files 0.8] 迁移专用 raw-v2 reader（design §9.3 E3/B6）：
 * 绕过 loadVariants 版本门读取 {v:2} **原文**——备份需要逐字节原文、节点枚举需要原始 items
 * （normalizeVariants 的 clamp/归一不得介入，「用户内容零变化」）。
 * key 缺失 / JSON 损坏 / v 缺失或 ≠2 / items 非数组 → null（不抛）。
 * 仅供模板迁移 journal 引擎消费；不改变 loadVariants 行为。
 */
export interface RawVariantsV2 {
  /** localStorage 原文（保真备份）。 */
  raw: string
  /** 原始 items（未 normalize，逐节点由迁移侧自行校验）。 */
  items: unknown[]
}

export function readRawVariantsV2(): RawVariantsV2 | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(VARIANTS_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const payload = parsed as Partial<StoredVariantsPayload>
    if (payload.v !== VARIANTS_PAYLOAD_VERSION || !Array.isArray(payload.items)) return null
    return { raw, items: payload.items }
  } catch {
    return null
  }
}

function normalizeVariants(raw: unknown[]): PersistedVariant[] | null {
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
        // 旧数据无 effectRef 字段：归一为 null（asset kind 存素材节点 id）
        effectRef: normalizeEffectRef(v.effectRef),
      }
    })
    .filter((v): v is PersistedVariant => v !== null)
  return restored
}

export interface PersistedLabForm {
  advancedJson: string
  size: string
  /** [add-lab C3.2] run 级蓝图策略（design §4.3）；旧载荷缺席 = serial（lab store hydrate 归一）。 */
  blueprintStrategy?: 'serial' | 'parallel'
}

export function saveLabForm(form: PersistedLabForm): boolean {
  return writeJson(FORM_KEY, {
    advancedJson: form.advancedJson.slice(0, 20000),
    size: form.size.slice(0, 32),
    ...(form.blueprintStrategy !== undefined ? { blueprintStrategy: form.blueprintStrategy } : {}),
  })
}

export function loadLabForm(): PersistedLabForm | null {
  const raw = readJson<Partial<PersistedLabForm>>(FORM_KEY)
  if (raw === null || typeof raw.advancedJson !== 'string' || typeof raw.size !== 'string') return null
  // 值域防御：非 serial/parallel 视为缺席（回默认串行）
  const strategy = raw.blueprintStrategy === 'serial' || raw.blueprintStrategy === 'parallel' ? raw.blueprintStrategy : undefined
  return { advancedJson: raw.advancedJson, size: raw.size, ...(strategy !== undefined ? { blueprintStrategy: strategy } : {}) }
}
