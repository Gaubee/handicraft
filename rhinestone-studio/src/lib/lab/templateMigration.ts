/**
 * variants {v:2} 信封 → 库模板（gemtpl 资产）一次性迁移 journal 引擎
 * （openspec add-project-files design §9.3 E3/B6 + §7.1；切片 0.8）。
 *
 * 纯引擎模块：依赖注入（raw 读取 / preset 物化 / 节点读写 / 时间源 / 存储门面），
 * 不 import lab store 运行时——lab hydrate 接线是 4.3 切片的事。
 *
 * 冻结算法（Codex R1-R5 裁决，任何偏离打回）：
 * ① 备份：raw-v2 读 VARIANTS_KEY 原文 → 写一次性备份 key（journal.backupKey 记名，TTL 30 天）
 * ② 逐节点 create-only：id 形如 `tpl-${presetId}` → 目标 `ast-tpl-${presetId}`（provenance
 *    builtin-seed）；其余 → `ast-tpl-legacy-${legacyId}`（provenance user-created）。ingest 前
 *    先 get 存在性（含软删）即跳过——普通随机 UUID 在「ingest 成功、完成集写入前崩溃」时
 *    重试必重复建节点，确定性 id 是该崩溃窗口的幂等兜底 [Codex-R3-B6-2]
 * ③ 每节点成功 → completedNodeIds 追加（**先节点落库后记账**）
 * ④ 全节点完成 → 写 lab-session key → sessionWritten
 * ⑤ state='done' → 删 VARIANTS_KEY → oldKeyDeleted
 *
 * IDB 与 localStorage 非原子：任一步崩溃按完成集 + 确定性 id 重入（旧 key 未删则保留）；
 * 软删不复活；用户内容零变化（create-only，任何内容差异覆盖均被 R2/R3 推翻）。
 */

import type { CaseRefLayout } from '$lib/lab/caseComposite'
import { serializeGemtpl, type GemtplFileInput, type LabCaseBinding } from '$lib/persistence/labFile'
import {
  getProject,
  ingestProjectAsset,
  type IngestProjectAssetOptions,
  type ProjectIngestResult,
} from '$lib/persistence/assetStore'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { readRawVariantsV2, VARIANTS_KEY, type RawVariantsV2 } from '$lib/persistence/taskStore'

// ---------------------------------------------------------------------------
// key 与常量（journal 结构冻结：version 1）
// ---------------------------------------------------------------------------

export const TEMPLATE_MIGRATION_JOURNAL_KEY = 'rhinestone-studio:tpl-migration'
/**
 * 一次性备份 key（固定名）：journal.backupKey 记名；同 key 重试覆写不产生孤儿键，
 * TTL 过期后由 cleanupExpiredBackup 释放。pending 期备份意外缺失时从原文自愈补写。
 */
export const TEMPLATE_MIGRATION_BACKUP_KEY = 'rhinestone-studio:tpl-migration-backup'
/** lab-session key：enabled/选中态的会话意图落点（gemtpl 文件本身不含 enabled）。 */
export const LAB_SESSION_KEY = 'rhinestone-studio:lab-session'

export const TEMPLATE_MIGRATION_JOURNAL_VERSION = 1
/** 备份保留期（design §9.3：TTL 30 天；state='done' 且 startedAt 距今 >30d 才清）。 */
export const TEMPLATE_MIGRATION_BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface TemplateMigrationJournal {
  version: 1
  state: 'pending' | 'done'
  completedNodeIds: string[]
  sessionWritten: boolean
  oldKeyDeleted: boolean
  backupKey: string
  startedAt: number
}

/** 迁移写入 lab-session 的载荷形状（4.3 hydrate 消费；E8 失效/损坏回默认启用集）。 */
export interface LabSessionPayload {
  enabledTemplateAssetIds: string[]
  /** 遗留持久层无选中态字段——不伪造，恒 null（选中是会话意图，非用户内容）。 */
  selectedTemplateAssetId: string | null
}

// ---------------------------------------------------------------------------
// 依赖注入面（4.3 接线：materializePreset 传 lab store 真实现）
// ---------------------------------------------------------------------------

/** preset 过渡态物化结果（lab store MaterializedCaseRef 的引擎侧最小投影）。 */
export interface MaterializedPresetCase {
  assetId: string
  caseLayout: CaseRefLayout
}

export interface TemplateMigrationDeps {
  /** preset 过渡态物化（4.3 接线传真实现；返回 null 或抛错 = 该节点本轮失败，下轮重试）。 */
  materializePreset: (presetId: string) => Promise<MaterializedPresetCase | null>
  /** 写入 gemtpl appVersion 的应用版本标识（labFile 序列化要求非空）。 */
  appVersion: string
  /** raw-v2 原文读取；缺省 taskStore.readRawVariantsV2。 */
  readRawVariants?: () => RawVariantsV2 | null
  /** 目标节点存在性检查（含软删）；缺省 assetStore.getProject。 */
  getProject?: (id: string) => Promise<AssetProject | null>
  /** 项目入库（确定性 id 语义）；缺省 assetStore.ingestProjectAsset。 */
  ingestProjectAsset?: (options: IngestProjectAssetOptions) => Promise<ProjectIngestResult>
  /** localStorage 门面；缺省全局 localStorage（无存储环境降级为 no-op → not-needed）。 */
  storage?: Storage
  /** 时间源；缺省 Date.now。 */
  now?: () => number
}

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

export type MigrationNodeStatus =
  /** 本轮新建节点。 */
  | 'created'
  /** get/ingest 命中既有节点（含软删）——create-only 跳过。 */
  | 'skipped-existing'
  /** 完成集已记录（崩溃重入时对已完节点的零动作确认）。 */
  | 'already-completed'
  /** 本轮失败未记完成（materialize 失败 / 序列化或入库失败 / 非法条目），下轮重试。 */
  | 'pending-retry'

export interface MigrationNodeOutcome {
  legacyId: string
  targetId: string
  status: MigrationNodeStatus
  /** pending-retry 的原因（不含字段值，只描述类型/阶段）。 */
  reason?: string
}

export interface MigrationResult {
  /** not-needed = 无 journal 且无 {v:2} 原文（key 缺失/v≠2/损坏），未写任何状态。 */
  state: 'pending' | 'done' | 'not-needed'
  /** 本轮逐节点结果（items 序；done 短路重入时为空——零变化）。 */
  nodes: MigrationNodeOutcome[]
  sessionWritten: boolean
  oldKeyDeleted: boolean
  backupKey: string
}

// ---------------------------------------------------------------------------
// 存储门面（全部访问不抛：隐私模式/配额异常按「写失败」语义走崩溃重入）
// ---------------------------------------------------------------------------

const NOOP_STORAGE: Storage = {
  get length() {
    return 0
  },
  clear() {},
  getItem: () => null,
  key: () => null,
  setItem() {},
  removeItem() {},
}

function defaultStorage(): Storage {
  // SSR/极端环境无 localStorage：与 readRawVariantsV2 的静默 null 口径一致 → not-needed。
  return typeof localStorage === 'undefined' ? NOOP_STORAGE : localStorage
}

function storageGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function storageRemove(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// journal 读写（损坏 → null：视同不存在，从①重来——节点面由确定性 id 幂等兜底）
// ---------------------------------------------------------------------------

function parseJournal(value: unknown): TemplateMigrationJournal | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Partial<TemplateMigrationJournal>
  if (
    v.version !== TEMPLATE_MIGRATION_JOURNAL_VERSION ||
    (v.state !== 'pending' && v.state !== 'done') ||
    !Array.isArray(v.completedNodeIds) ||
    v.completedNodeIds.some((id) => typeof id !== 'string') ||
    typeof v.sessionWritten !== 'boolean' ||
    typeof v.oldKeyDeleted !== 'boolean' ||
    typeof v.backupKey !== 'string' ||
    v.backupKey === '' ||
    typeof v.startedAt !== 'number' ||
    !Number.isFinite(v.startedAt)
  ) {
    return null
  }
  return {
    version: TEMPLATE_MIGRATION_JOURNAL_VERSION,
    state: v.state,
    completedNodeIds: [...v.completedNodeIds],
    sessionWritten: v.sessionWritten,
    oldKeyDeleted: v.oldKeyDeleted,
    backupKey: v.backupKey,
    startedAt: v.startedAt,
  }
}

function loadJournal(storage: Storage): TemplateMigrationJournal | null {
  const raw = storageGet(storage, TEMPLATE_MIGRATION_JOURNAL_KEY)
  if (raw === null) return null
  try {
    return parseJournal(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

function persistJournal(storage: Storage, journal: TemplateMigrationJournal): boolean {
  return storageSet(storage, TEMPLATE_MIGRATION_JOURNAL_KEY, JSON.stringify(journal))
}

// ---------------------------------------------------------------------------
// legacy 变体 → 目标节点规划（形态规则冻结：`tpl-${presetId}` 前缀判别）
// ---------------------------------------------------------------------------

const TPL_ID_PREFIX = 'tpl-'
const CASE_LAYOUTS: readonly string[] = ['horizontal', 'vertical', 'single']

/** effectRef 只认当前契约两形态：asset（直接映射 caseBinding）/ preset（待物化）；
 * 其余（null / legacy-* 载体）→ null（legacy 载体的物化改绑归 lab hydrate 职责，不属本迁移）。 */
function parseEffectRefForBinding(
  value: unknown,
): { kind: 'asset'; assetId: string; caseLayout: CaseRefLayout } | { kind: 'preset'; presetId: string } | null {
  if (value === null || typeof value !== 'object') return null
  const ref = value as { kind?: unknown; assetId?: unknown; caseLayout?: unknown; presetId?: unknown }
  if (
    ref.kind === 'asset' &&
    typeof ref.assetId === 'string' &&
    ref.assetId.trim() &&
    typeof ref.caseLayout === 'string' &&
    CASE_LAYOUTS.includes(ref.caseLayout)
  ) {
    return { kind: 'asset', assetId: ref.assetId, caseLayout: ref.caseLayout as CaseRefLayout }
  }
  if (ref.kind === 'preset' && typeof ref.presetId === 'string' && ref.presetId.trim()) {
    return { kind: 'preset', presetId: ref.presetId }
  }
  return null
}

interface PlannedNode {
  legacyId: string
  targetId: string
  enabled: boolean
  /** preset 过渡态：物化成功前 caseBinding 未知（交给注入的 materializePreset）。 */
  pendingPresetId: string | null
  /** GemtplFileInput 中与时间/版本无关的部分（clamp 交给 serializeGemtpl 双侧防线）。 */
  base: {
    name: string
    promptBody: string
    candidates: number
    caseBinding: LabCaseBinding | null
    provenance: GemtplFileInput['provenance']
  }
}

function legacyIdOf(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
  }
  return '?'
}

/** 单条 legacy 变体规划：非法结构 → error（该节点永久 pending-retry，旧 key 保留）。 */
function planLegacyNode(value: unknown): { node: PlannedNode } | { error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '非对象条目' }
  }
  const v = value as {
    id?: unknown
    name?: unknown
    prompt?: unknown
    candidates?: unknown
    enabled?: unknown
    effectRef?: unknown
  }
  if (typeof v.id !== 'string' || !v.id.trim()) return { error: 'id 缺失或非 string' }
  if (typeof v.name !== 'string') return { error: 'name 非 string' }
  if (typeof v.prompt !== 'string') return { error: 'prompt 非 string' }
  if (typeof v.candidates !== 'number' || !Number.isFinite(v.candidates)) {
    return { error: 'candidates 非有限数字' }
  }
  // 形态规则（冻结）：`tpl-${presetId}` → `ast-tpl-${presetId}` + builtin-seed；
  // 其余 → `ast-tpl-legacy-${legacyId}` + user-created。
  const presetId = v.id.startsWith(TPL_ID_PREFIX) ? v.id.slice(TPL_ID_PREFIX.length) : ''
  const isBuiltinSeed = presetId !== ''
  const ref = parseEffectRefForBinding(v.effectRef)
  return {
    node: {
      legacyId: v.id,
      targetId: isBuiltinSeed ? `ast-tpl-${presetId}` : `ast-tpl-legacy-${v.id}`,
      // 旧数据无 enabled 字段：仅显式 false 视为禁用（normalizeVariants 同口径）
      enabled: v.enabled !== false,
      pendingPresetId: ref !== null && ref.kind === 'preset' ? ref.presetId : null,
      base: {
        name: v.name,
        promptBody: v.prompt,
        candidates: v.candidates,
        caseBinding:
          ref !== null && ref.kind === 'asset'
            ? { assetId: ref.assetId, caseLayout: ref.caseLayout }
            : null,
        provenance: isBuiltinSeed ? { source: 'builtin-seed', presetId } : { source: 'user-created' },
      },
    },
  }
}

/** 规划条目：合法变体节点，或保留 items 序的非法条目占位（进入 pending-retry 清单）。 */
type PlannedEntry = { node: PlannedNode } | { invalid: { legacyId: string; reason: string } }

// ---------------------------------------------------------------------------
// 执行入口（幂等：可从任意步崩溃重入）
// ---------------------------------------------------------------------------

function pendingResult(journal: TemplateMigrationJournal, nodes: MigrationNodeOutcome[]): MigrationResult {
  return {
    state: 'pending',
    nodes,
    sessionWritten: journal.sessionWritten,
    oldKeyDeleted: journal.oldKeyDeleted,
    backupKey: journal.backupKey,
  }
}

/**
 * 执行/续跑迁移。入口幂等：
 * - journal 不存在 → 从①开始（无 {v:2} 原文 → not-needed，零写入）；
 * - state='pending' → 按完成集 + 确定性 id 存在性跳过已完部分续跑；
 * - state='done' → 直接返回（VARIANTS_KEY 未删成则补删，其余零变化）。
 * 任何写失败（storage/IDB）不抛：按未完成语义返回 pending，等下次重入。
 */
export async function executeTemplateMigration(deps: TemplateMigrationDeps): Promise<MigrationResult> {
  const storage = deps.storage ?? defaultStorage()
  const now = deps.now ?? Date.now
  const readRawVariants = deps.readRawVariants ?? readRawVariantsV2
  const getExistingProject = deps.getProject ?? getProject
  const ingest = deps.ingestProjectAsset ?? ingestProjectAsset

  let journal = loadJournal(storage)

  // done 短路：唯一残留动作是⑤的补删（done 落盘与删 key 分属两个非原子写）。
  if (journal !== null && journal.state === 'done') {
    if (!journal.oldKeyDeleted) {
      storageRemove(storage, VARIANTS_KEY)
      if (storageGet(storage, VARIANTS_KEY) === null) {
        journal.oldKeyDeleted = true
        persistJournal(storage, journal) // 失败无碍：下次重入再校
      }
    }
    return {
      state: 'done',
      nodes: [],
      sessionWritten: journal.sessionWritten,
      oldKeyDeleted: journal.oldKeyDeleted,
      backupKey: journal.backupKey,
    }
  }

  const raw = readRawVariants()

  if (journal === null) {
    // 无 journal 且无 {v:2} 原文：key 缺失 / v≠2（版本门已 retire）/ 损坏 —— 无事可做。
    if (raw === null) {
      return { state: 'not-needed', nodes: [], sessionWritten: false, oldKeyDeleted: false, backupKey: '' }
    }
    // ① 备份：原文 → 一次性备份 key。写失败即中止（journal 未落盘，下轮整重来；
    // 固定 key 使重试覆写同一备份槽，不产生孤儿键）。
    if (!storageSet(storage, TEMPLATE_MIGRATION_BACKUP_KEY, raw.raw)) {
      return {
        state: 'pending',
        nodes: [],
        sessionWritten: false,
        oldKeyDeleted: false,
        backupKey: TEMPLATE_MIGRATION_BACKUP_KEY,
      }
    }
    journal = {
      version: TEMPLATE_MIGRATION_JOURNAL_VERSION,
      state: 'pending',
      completedNodeIds: [],
      sessionWritten: false,
      oldKeyDeleted: false,
      backupKey: TEMPLATE_MIGRATION_BACKUP_KEY,
      startedAt: now(),
    }
    if (!persistJournal(storage, journal)) {
      // 备份已写、journal 未落盘 → 下轮从①重来（原文未动，可安全重备份）。
      return pendingResult(journal, [])
    }
  }

  if (raw === null) {
    // pending 期旧 key 被外部清除：无法枚举/映射 enabled 集，保持 pending（数据面事故
    // 超出迁移职责；完成集与已建节点不受影响）。
    return pendingResult(journal, [])
  }

  // ① 自愈：pending 期备份 key 意外缺失 → 从原文补写（VARIANTS_KEY 未删，仍是真源）。
  if (storageGet(storage, journal.backupKey) === null && !storageSet(storage, journal.backupKey, raw.raw)) {
    return pendingResult(journal, [])
  }

  // ②③ 逐节点 create-only + 先落库后记账。
  const entries: PlannedEntry[] = raw.items.map((item) => {
    const planned = planLegacyNode(item)
    return 'error' in planned
      ? { invalid: { legacyId: legacyIdOf(item), reason: `非法变体条目：${planned.error}` } }
      : { node: planned.node }
  })
  const validNodes = entries.flatMap((entry): PlannedNode[] => ('node' in entry ? [entry.node] : []))
  const hasInvalid = entries.some((entry) => 'invalid' in entry)

  const outcomes: MigrationNodeOutcome[] = []
  const completed = new Set(journal.completedNodeIds)

  const recordCompleted = (targetId: string): boolean => {
    // 先节点落库后记账（调用点约定）：崩溃在「ingest 成功、完成集写入」之间时，磁盘完成集
    // 缺该 id，重试以同一确定性 id 再 ingest → assetStore 按 existing-id 跳过返回既有节点
    // ——不重复建节点、不覆盖内容。这正是确定性 id 存在的理由 [Codex-R3-B6-2]。
    journal.completedNodeIds.push(targetId)
    completed.add(targetId)
    return persistJournal(storage, journal)
  }

  for (const entry of entries) {
    if ('invalid' in entry) {
      outcomes.push({
        legacyId: entry.invalid.legacyId,
        targetId: '',
        status: 'pending-retry',
        reason: entry.invalid.reason,
      })
      continue
    }
    const node = entry.node

    if (completed.has(node.targetId)) {
      outcomes.push({ legacyId: node.legacyId, targetId: node.targetId, status: 'already-completed' })
      continue
    }

    // 先 get 存在性（含软删）即跳过：软删不复活、既有内容不被覆盖（create-only）。
    let existing: AssetProject | null = null
    try {
      existing = await getExistingProject(node.targetId)
    } catch {
      existing = null
    }
    if (existing !== null) {
      if (!recordCompleted(node.targetId)) return pendingResult(journal, outcomes)
      outcomes.push({ legacyId: node.legacyId, targetId: node.targetId, status: 'skipped-existing' })
      continue
    }

    const stamp = now()
    const input: GemtplFileInput = {
      appVersion: deps.appVersion,
      createdAt: stamp,
      savedAt: stamp,
      name: node.base.name,
      promptBody: node.base.promptBody,
      caseBinding: node.base.caseBinding,
      candidates: node.base.candidates,
      provenance: node.base.provenance,
    }

    // preset 过渡态：物化失败（null/抛错）→ 该节点本轮跳过不记完成，下轮重试。
    if (node.pendingPresetId !== null) {
      let materialized: MaterializedPresetCase | null = null
      try {
        materialized = await deps.materializePreset(node.pendingPresetId)
      } catch {
        materialized = null
      }
      if (materialized === null) {
        outcomes.push({
          legacyId: node.legacyId,
          targetId: node.targetId,
          status: 'pending-retry',
          reason: `preset 物化失败：${node.pendingPresetId}`,
        })
        continue
      }
      input.caseBinding = { assetId: materialized.assetId, caseLayout: materialized.caseLayout }
    }

    try {
      const blob = new Blob([serializeGemtpl(input)], { type: PROJECT_MIME.gemtpl })
      const result = await ingest({ blob, name: input.name, projectKind: 'gemtpl', id: node.targetId })
      outcomes.push({
        legacyId: node.legacyId,
        targetId: node.targetId,
        status: result.status === 'created' ? 'created' : 'skipped-existing',
      })
    } catch (error) {
      outcomes.push({
        legacyId: node.legacyId,
        targetId: node.targetId,
        status: 'pending-retry',
        reason: `序列化/入库失败：${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    // 完成集写失败（含注入的 journal 写入抛错）→ 本轮中止：节点已建但磁盘完成集缺该 id，
    // 重启重入走 get/ingest existing-id 分支 —— Codex 指定必测路径。
    if (!recordCompleted(node.targetId)) return pendingResult(journal, outcomes)
  }

  // 全节点完成判定：每个可规划目标都在完成集内（重复 legacy id → 同一目标，完成一次即全完；
  // 非法条目永不计完成——脏数据保留旧 key，宁可 stuck 不丢数据）。
  const allDone = !hasInvalid && validNodes.every((node) => completed.has(node.targetId))
  if (!allDone) return pendingResult(journal, outcomes)

  // ④ lab-session：enabled 集合 = legacy enabled 变体的目标节点 id 映射（items 序）。
  if (!journal.sessionWritten) {
    const session: LabSessionPayload = {
      enabledTemplateAssetIds: validNodes.filter((node) => node.enabled).map((node) => node.targetId),
      selectedTemplateAssetId: null,
    }
    if (!storageSet(storage, LAB_SESSION_KEY, JSON.stringify(session))) {
      return pendingResult(journal, outcomes)
    }
    journal.sessionWritten = true
    if (!persistJournal(storage, journal)) return pendingResult(journal, outcomes)
  }

  // ⑤ state='done' → 删 VARIANTS_KEY → oldKeyDeleted。
  journal.state = 'done'
  if (!persistJournal(storage, journal)) {
    journal.state = 'pending' // 磁盘仍是 pending：下轮续（完成集已记，直接补 session/done）
    return pendingResult(journal, outcomes)
  }
  storageRemove(storage, VARIANTS_KEY)
  if (storageGet(storage, VARIANTS_KEY) === null) {
    journal.oldKeyDeleted = true
    persistJournal(storage, journal) // 失败无碍：done 已落盘，重入 done 分支补删校
  }
  return {
    state: 'done',
    nodes: outcomes,
    sessionWritten: journal.sessionWritten,
    oldKeyDeleted: journal.oldKeyDeleted,
    backupKey: journal.backupKey,
  }
}

// ---------------------------------------------------------------------------
// 备份 TTL 清理（幂等：state='done' 且 startedAt 距今 >30 天才清备份）
// ---------------------------------------------------------------------------

/**
 * 清理过期备份。返回是否满足清理条件并执行了移除（备份已不存在时亦返回 true——
 * 幂等：重复调用无额外效果）。pending 永不清（迁移未收口，备份仍是无损重试的真源）。
 */
export function cleanupExpiredBackup(now: number = Date.now(), storage: Storage = defaultStorage()): boolean {
  const journal = loadJournal(storage)
  if (journal === null || journal.state !== 'done') return false
  if (now - journal.startedAt <= TEMPLATE_MIGRATION_BACKUP_TTL_MS) return false
  storageRemove(storage, journal.backupKey)
  return true
}
