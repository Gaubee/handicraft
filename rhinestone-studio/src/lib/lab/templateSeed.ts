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
import { APP_VERSION } from '$lib/appVersion'
import { parseGemtpl, serializeGemtpl, type GemtplFile } from '$lib/persistence/labFile'
import {
  getProject,
  ingestProjectAsset,
  listChildNodes,
  trashAsset,
  SYS_TEMPLATES_FOLDER_ID,
  type AssetNode,
  type IngestProjectAssetOptions,
  type ProjectIngestResult,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { PROJECT_MIME, type AssetProject } from '$lib/persistence/projectTypes'
import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
import { EFFECT_REF_PRESETS_V2 } from '$lib/presets/effectRefTemplatesV2'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 应用版本标识真源已收口到全局模块（[4.3]）；此处 re-export 维持既有消费面。 */
export { APP_VERSION } from '$lib/appVersion'

/**
 * seed 模板的候选数默认（= lab store DEFAULT_CANDIDATES=2，templates store
 * NEW_TEMPLATE_CANDIDATES 同值；不 import 运行时常量以避免循环依赖）。
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
 * 内置模板条目 seed。〔placeholders 切片 4 v2 换代〕seed 全集 = v2 预设
 * （`ast-tpl-<baseId>-v2` 节点，占位符新版文案 + caseRef 默认开）；素材物化沿用**基
 * presetId**（复用 v1 时代已物化的同一合成图资产，不重复建图）。旧版 v1 节点不再 seed
 * （新建库只出 v2）；存量 v1 节点由 retireUnmodifiedBuiltinTemplates 软删（见下）。
 * 时序（每 preset）：getProject(确定性 id)（含软删）命中即跳过 → materializePreset（lab
 * store 幂等管线：sys-cases meta.presetId+PRESET_SOURCE_VERSION 反查复用，未命中才 fetch
 * 合成）→ serializeGemtpl（provenance builtin-seed + v2 presetId + sourceNote）→
 * ingestProjectAsset(确定性 id, parentId=sys-templates, 事务内 ensure 目录)。
 */
export async function seedBuiltinTemplates(deps: TemplateSeedDeps): Promise<TemplateSeedReport> {
  const now = deps.now ?? Date.now
  const getExistingProject = deps.getProject ?? getProject
  const ingest = deps.ingestProjectAsset ?? ingestProjectAsset
  const report: TemplateSeedReport = { created: [], skippedExisting: [], failed: [] }

  for (const preset of EFFECT_REF_PRESETS_V2) {
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

    // 单模板原子性：物化失败 → 本轮不建半成品，下轮 hydrate 重试（基 presetId 幂等复用）。
    let materialized: MaterializedPresetCase | null = null
    try {
      materialized = await deps.materializePreset(preset.baseId)
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
        promptBody: preset.promptBody,
        caseBinding: { assetId: materialized.assetId, caseLayout: materialized.caseLayout },
        candidates: SEED_DEFAULT_CANDIDATES,
        // [placeholders] 案例开关默认开（v2 预设即案例模板；片段缺席 = auto 角色声明文案）
        caseRef: { enabled: true },
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

// ---------------------------------------------------------------------------
// [placeholders 切片 4] 旧内置软删（v2 换代——未被用户修改的 v1 节点退役入回收站）
// ---------------------------------------------------------------------------

/** 旧内置软删依赖注入面（缺省 = assetStore/imageStore 真实现）。 */
export interface TemplateRetireDeps {
  /** 目录枚举；缺省 listChildNodes(SYS_TEMPLATES_FOLDER_ID)。 */
  listChildNodes?: (folderId: string) => Promise<AssetNode[]>
  /** 节点存在性检查（v2 存在安全门）；缺省 getProject。 */
  getProject?: (id: string) => Promise<AssetProject | null>
  /** 档案字节读取；缺省 imageStore.getImageBlob。 */
  getBlob?: (blobKey: string) => Promise<Blob | null>
  /** 软删（回收站可找回）；缺省 trashAsset。 */
  trashAsset?: (id: string) => Promise<AssetNode>
}

/** 软删结果（调用方观测口；不进任何持久化）。 */
export interface TemplateRetireReport {
  /** 本轮软删的旧内置节点 id（v1 presetId 的确定性节点 id）。 */
  retired: string[]
  /** 命中旧内置但因「有用户编辑痕迹」保留的节点 id。 */
  keptModified: string[]
}

/** 旧 v1 预设 id → preset（软删判定与文案比对真源）。 */
const OLD_PRESET_BY_ID = new Map(EFFECT_REF_PRESETS.map((preset) => [preset.id, preset] as const))

/**
 * 未修改判定的最小口径（store/文件可判定，design §5——全部满足才软删）：
 * provenance.source='builtin-seed' + presetId ∈ 旧 v1 预设 id（非 -v2）+ promptBody 与原
 * preset 逐字节相等 + candidates=seed 默认 + caseBinding 在（seed 恒绑定；解绑 = 编辑痕迹）
 * + v2 新键全缺席（caseRef/drillParams/blueprint/gemSpecIds——任一配置过 = 编辑痕迹）。
 */
function isUnmodifiedBuiltinV1(file: GemtplFile): boolean {
  if (file.provenance.source !== 'builtin-seed') return false
  const preset = OLD_PRESET_BY_ID.get(file.provenance.presetId ?? '')
  if (preset === undefined) return false
  return (
    file.promptBody === preset.prompt &&
    file.candidates === SEED_DEFAULT_CANDIDATES &&
    file.caseBinding !== null &&
    file.caseRef === undefined &&
    file.drillParams === undefined &&
    file.blueprint === undefined &&
    file.gemSpecIds === undefined
  )
}

/**
 * 旧内置软删（hydrate 在 v2 seed 之后执行）。安全门 = 对应 v2 节点已存在才删（防 v2
 * seed 失败掏空模板库）；已软删节点跳过；档案损坏保守保留；用户模板（user-created/
 * forked）与非 v1 内置节点零触碰。永不 reject（逐节点容错，失败 console.warn 记账）。
 */
export async function retireUnmodifiedBuiltinTemplates(deps: TemplateRetireDeps = {}): Promise<TemplateRetireReport> {
  const listChildren = deps.listChildNodes ?? listChildNodes
  const getExistingProject = deps.getProject ?? getProject
  const getBlob = deps.getBlob ?? ((blobKey: string) => getImageBlob(blobKey))
  const trash = deps.trashAsset ?? trashAsset
  const report: TemplateRetireReport = { retired: [], keptModified: [] }

  let children: AssetNode[]
  try {
    children = await listChildren(SYS_TEMPLATES_FOLDER_ID)
  } catch {
    return report // IDB 不可用：本轮不软删（下轮 hydrate 重试）
  }

  for (const node of children) {
    if (node.type !== 'project' || node.projectKind !== 'gemtpl') continue
    if ((node as { trashedAt?: number }).trashedAt !== undefined) continue // 已软删不重复处理
    let file: GemtplFile | null = null
    try {
      const blob = await getBlob(node.blobKey)
      file = blob === null ? null : parseGemtpl(await blob.text(), { mime: node.mime })
    } catch {
      file = null // 档案损坏：无法判定「未修改」→ 保留（保守）
    }
    if (file === null) continue
    const presetId = file.provenance.presetId
    if (presetId === undefined || !OLD_PRESET_BY_ID.has(presetId)) continue // v2/用户/fork 不触碰
    if (!isUnmodifiedBuiltinV1(file)) {
      report.keptModified.push(node.id)
      continue
    }
    // 安全门：对应 v2 节点已存在（本轮 created 或 create-only 命中）才软删旧节点
    const v2Exists = await getExistingProject(builtinTemplateNodeId(`${presetId}-v2`))
      .then((found) => found !== null)
      .catch(() => false)
    if (!v2Exists) continue
    try {
      await trash(node.id)
      report.retired.push(node.id)
    } catch (error) {
      console.warn(`旧内置模板软删失败（${node.id}），下次启动重试`, error)
    }
  }
  return report
}
