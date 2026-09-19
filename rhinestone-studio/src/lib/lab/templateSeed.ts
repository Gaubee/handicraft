/**
 * 内置 preset → .gemtpl 模板条目 seed（openspec add-project-files design §7.1 前两条 +
 * 补充稿 A.4.1；切片 4.2——4.3 模板面板库化的数据面硬前置）。
 *
 * 职责边界（A.4.1：目录 seed 在 assetStore，条目 seed 在 lab hydrate——域管线归域 store）：
 * - 本模块只做**条目** seed：EFFECT_REF_PRESETS 逐个物化合成案例（复用 lab store 的
 *   materializePresetEffectRef 幂等管线，依赖注入——与 templateMigration.ts 同款边界：
 *   本模块不 import lab store 运行时，避免循环依赖）→ serializeGemtpl →
 *   ingestProjectAsset(确定性 id `ast-tpl-${presetId}`，落 sys-templates)。
 * - `sys-templates` **目录**节点由 assetStore 侧机制建（SYSTEM_FOLDER_IDS/seedSystemFolders
 *   + ingestProjectAsset 事务内 ensure，沿 sys-projects 先例）。
 *
 * 幂等口径（冻结）：
 * - **节点存在即跳过（含软删，删除不复活）**：ingest 前先 getProject（assetStore get 含软删）
 *   ——create-only，不覆盖不复活（用户编辑优先；ingest 的确定性 id 分支是「ingest 成功、
 *   下轮重入」窗口的兜底，同 journal 引擎 [Codex-R3-B6-2] 的确定性 id 论证）。
 * - **单模板原子性**：物化失败（离线/IDB 不可用）→ 该模板本轮不 seed（不建绑定缺失的
 *   半成品），下轮 hydrate 重试；已 seed 模板不受影响。
 * - 可重入：每轮全量检查（非一次性 flag），与 ast-preset-* 图像 seed 的幂等风格一致。
 *
 * 与 0.8 迁移引擎（templateMigration.ts）的关系：seed 先跑（官方默认就位）；引擎后续跑时
 * 按 `ast-tpl-${presetId}` 存在性 create-only 自然跳过已 seed 节点——接线归 4.3，本模块
 * 不消费引擎。
 */

import type { CaseRefLayout } from '$lib/lab/caseComposite'
import type { MaterializedPresetCase } from '$lib/lab/templateMigration'
import { serializeGemtpl } from '$lib/persistence/labFile'
import {
  getProject,
  ingestProjectAsset,
  SYS_TEMPLATES_FOLDER_ID,
  type IngestProjectAssetOptions,
  type ProjectIngestResult,
} from '$lib/persistence/assetStore'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 应用版本标识（gemtpl appVersion 字段真源）。仓内暂无全局 APP_VERSION 常量，
 * 先在本侧落 0.1.0（与 package.json version 对齐）——4.3 收口为全局真源。
 */
export const APP_VERSION = '0.1.0'

/**
 * seed 模板的候选数默认（= lab store DEFAULT_CANDIDATES=2，defaultVariants 现状；
 * 不 import 该常量以避免与 lab store 的运行时循环依赖）。
 */
const SEED_DEFAULT_CANDIDATES = 2

/** 内置模板的目标节点 id（design §7.1；与迁移引擎/4.3 共用的确定性 id 约定）。 */
export function builtinTemplateNodeId(presetId: string): string {
  return `ast-tpl-${presetId}`
}

// ---------------------------------------------------------------------------
// 依赖注入面（lab hydrate 接线：materializePreset 传 lab store 真实现）
// ---------------------------------------------------------------------------

export interface TemplateSeedDeps {
  /** preset 过渡态物化（返回 null 或抛错 = 该模板本轮失败，下轮 hydrate 重试）。 */
  materializePreset: (presetId: string) => Promise<MaterializedPresetCase | null>
  /** 覆盖 appVersion（缺省 APP_VERSION）。 */
  appVersion?: string
  /** 目标节点存在性检查（含软删）；缺省 assetStore.getProject。 */
  getProject?: (id: string) => Promise<AssetProject | null>
  /** 项目入库（确定性 id 语义）；缺省 assetStore.ingestProjectAsset。 */
  ingestProjectAsset?: (options: IngestProjectAssetOptions) => Promise<ProjectIngestResult>
  /** 时间源；缺省 Date.now。 */
  now?: () => number
}

// ---------------------------------------------------------------------------
// 结果形状（调用方观测口；不进任何持久化）
// ---------------------------------------------------------------------------

export interface TemplateSeedReport {
  /** 本轮新建的节点 id（EFFECT_REF_PRESETS 序）。 */
  created: string[]
  /** 已存在（含软删）而跳过的节点 id——create-only 命中。 */
  skippedExisting: string[]
  /** 本轮失败未建（物化/序列化/入库失败，下轮 hydrate 重试）的节点 id。 */
  failed: string[]
}

// ---------------------------------------------------------------------------
// 执行入口（永不 reject：逐模板容错，失败 console.warn 记账）
// ---------------------------------------------------------------------------

/**
 * 内置模板条目 seed。时序（每 preset）：
 * getProject(`ast-tpl-${presetId}`)（含软删）命中即跳过 → materializePreset（lab store
 * 幂等管线：sys-cases meta.presetId+PRESET_SOURCE_VERSION 反查复用，未命中才 fetch 合成）
 * → serializeGemtpl（provenance builtin-seed + presetId + sourceNote）→
 * ingestProjectAsset(确定性 id, parentId=sys-templates, 事务内 ensure 目录)。
 */
export async function seedBuiltinTemplates(deps: TemplateSeedDeps): Promise<TemplateSeedReport> {
  const now = deps.now ?? Date.now
  const getExistingProject = deps.getProject ?? getProject
  const ingest = deps.ingestProjectAsset ?? ingestProjectAsset
  const report: TemplateSeedReport = { created: [], skippedExisting: [], failed: [] }

  for (const preset of EFFECT_REF_PRESETS) {
    const targetId = builtinTemplateNodeId(preset.id)

    // create-only：节点存在（含软删）即跳过——不覆盖用户编辑、不复活已删模板。
    let existing: AssetProject | null = null
    try {
      existing = await getExistingProject(targetId)
    } catch {
      existing = null // IDB 暂不可用按未命中处理：ingest 的确定性 id 分支仍兜得住
    }
    if (existing !== null) {
      report.skippedExisting.push(targetId)
      continue
    }

    // 单模板原子性：物化失败 → 本轮不建半成品，下轮 hydrate 重试。
    let materialized: MaterializedPresetCase | null = null
    try {
      materialized = await deps.materializePreset(preset.id)
    } catch (error) {
      console.warn(`内置模板 seed：案例物化失败（${preset.name}），本轮跳过，下次启动重试`, error)
      report.failed.push(targetId)
      continue
    }
    if (materialized === null) {
      console.warn(`内置模板 seed：案例物化不可用（${preset.name}），本轮跳过，下次启动重试`)
      report.failed.push(targetId)
      continue
    }

    const stamp = now()
    try {
      const file = serializeGemtpl({
        appVersion: deps.appVersion ?? APP_VERSION,
        createdAt: stamp,
        savedAt: stamp,
        name: preset.name,
        promptBody: preset.prompt,
        caseBinding: { assetId: materialized.assetId, caseLayout: materialized.caseLayout },
        candidates: SEED_DEFAULT_CANDIDATES,
        provenance: { source: 'builtin-seed', presetId: preset.id, sourceNote: preset.sourceNote },
      })
      const blob = new Blob([file], { type: PROJECT_MIME.gemtpl })
      const result = await ingest({
        blob,
        name: preset.name,
        projectKind: 'gemtpl',
        id: targetId,
        parentId: SYS_TEMPLATES_FOLDER_ID,
      })
      if (result.status === 'created') report.created.push(targetId)
      else report.skippedExisting.push(targetId)
    } catch (error) {
      console.warn(`内置模板 seed：入库失败（${preset.name}），本轮跳过，下次启动重试`, error)
      report.failed.push(targetId)
    }
  }

  return report
}
