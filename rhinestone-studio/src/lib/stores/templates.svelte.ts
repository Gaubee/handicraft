/**
 * 实验室模板共享 store（openspec add-project-files design §7.1 / §9.3 E4 + 补充稿 B.1；
 * 切片 4.3——TemplateEditor 双宿主编辑的地基，本切片单宿主接线实验室手风琴）。
 *
 * 正交意图：
 * 1. [2026-09-19 Library] 列表 = sys-templates 直系子节点中未软删的 gemtpl 节点（B.1.1）；
 *    每节点一条响应式 record（解析后的编辑视图 name/promptBody/candidates/caseBinding +
 *    保存态 savedAt/lastError/saving）。移出目录 = 从列表收起（库仍真源，refresh 采纳）。
 * 2. [2026-09-19 WriteQueue] 保存 = 字段提交自动换绑（onchange/blur，B.1.2）：每模板 asset
 *    串行写队列 + 单调 revision（design §9.3 E4：旧 revision 完成不得覆盖新内容——写入内容
 *    在执行时刻从 record 现算，天然合并并发提交；失败 toast 三段式 + record 回显上次持久值，
 *    revision 守卫防止回滚覆盖更新提交）；CAS（expectedBlobKey）冲突 → 重读节点收敛真源。
 *    saveVariants 的 32 条模板上限防线归此处（补充稿 §F-5「旧防线新家」）。
 *    [4.3b] 增「放弃修改」面：revertTemplateFields（record 回退最后成功快照，磁盘不动）
 *    + getTemplatePersistedSnapshot（守卫「有无未提交修改」对比口）——供 RightSheet
 *    关闭状态机消费，见对应注释的时序裁决。
 * 3. [2026-09-19 Session] 启用集/选中态 = lab-session key（templateMigration.LAB_SESSION_KEY，
 *    0.8 引擎写入的键——读写同源）：损坏/缺失回默认（全部启用 + 首项选中，E8）；
 *    跨 tab `storage` 事件显式提示「已在其他窗口修改启用状态」（非静默 last-write-win）。
 * 4. [2026-09-20 C3.1] 高级选项正交键（add-lab-drill-params design §1.1/§6.1）：record 增
 *    drillParams/blueprint（undefined = 从未配置；enabled=false 数据保留）；提交白名单同规则
 *    扩展——写入门 = advancedOptions validate（非法 typed error 拒写 + toast，不入队）；
 *    blueprint.refs 暂不落盘（labFile.BlueprintToggle 键位归 4.1——record/快照层保留，
 *    刷新丢失是 4.1 前已知局限）。
 *
 * 边界：不 import lab store 运行时（物化管线归 lab.svelte.ts，避免循环依赖——
 * lab store 反向消费本 store 的列表/启用态）。
 */

import { LAB_SESSION_KEY } from '$lib/lab/templateMigration'
import {
  validateGemtplBlueprint,
  validateGemtplDrillParams,
  type GemtplBlueprint,
  type GemtplDrillParams,
} from '$lib/lab/advancedOptions'
import {
  getProject,
  ingestProjectAsset,
  listChildNodes,
  renameAsset,
  trashAsset,
  updateProjectAsset,
  SYS_TEMPLATES_FOLDER_ID,
  type AssetNode,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import {
  GEMTPL_CANDIDATES_MAX,
  GEMTPL_CANDIDATES_MIN,
  GEMTPL_PROMPT_BODY_MAX,
  parseGemtpl,
  serializeGemtpl,
  type GemtplFile,
  type GemtplProvenanceSource,
  type LabCaseBinding,
} from '$lib/persistence/labFile'
import { PROJECT_MIME, ProjectConflictError, type AssetProject } from '$lib/persistence/projectTypes'
import { APP_VERSION } from '$lib/appVersion'
import { showToast } from './toast.svelte'

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 模板条数上限（saveVariants 旧防线的「旧防线新家」，补充稿 §F-5）。 */
export const MAX_TEMPLATES = 32

/** 新建模板的候选数默认（= lab DEFAULT_CANDIDATES=2；不 import lab store 避免循环依赖）。 */
const NEW_TEMPLATE_CANDIDATES = 2

/** 每模板的共享编辑视图 record（双宿主同开同一 $state，宿主不持副本——PRODUCT_MODEL 硬规则 7）。 */
export interface TemplateRecord {
  assetId: string
  name: string
  promptBody: string
  candidates: number
  caseBinding: LabCaseBinding | null
  /** [C3.1] 水钻参数配置高级选项（undefined = 从未配置；enabled=false = 关灯数据保留）。 */
  drillParams?: GemtplDrillParams
  /** [C3.1] 蓝图高级选项（beta；undefined = 从未配置）。refs 落盘归 4.1（labFile 键位）。 */
  blueprint?: GemtplBlueprint
  createdAt: number
  provenance: { source: GemtplProvenanceSource; presetId?: string; sourceNote?: string }
  /** 最后一次成功换绑时刻（保存态指示）。 */
  savedAt: number
  /** 最近一次写失败（三段式 toast 的同时挂 record，宿主可展示）。 */
  lastError: string | null
  saving: boolean
}

/** 字段提交补丁（提交即自动换绑，B.1.2）。 */
export interface TemplateFieldPatch {
  name?: string
  promptBody?: string
  candidates?: number
  caseBinding?: LabCaseBinding | null
  /** [C3.1] 高级选项整键提交（validate 门在 submitTemplateField 内——非法拒写）。 */
  drillParams?: GemtplDrillParams
  blueprint?: GemtplBlueprint
}

/** 最后一次成功换绑的持久内容快照（「放弃修改」的回退目标；C.5.4 / 4.3b 只读出口）。 */
export interface TemplatePersistedSnapshot {
  name: string
  promptBody: string
  candidates: number
  caseBinding: LabCaseBinding | null
  drillParams?: GemtplDrillParams
  blueprint?: GemtplBlueprint
}

/** lab-session 载荷（与 0.8 迁移引擎 LabSessionPayload 读写同源；disabledTemplateAssetIds
 *  是本 store 的补充字段——引擎只写 enabled 单列表，store 写 enabled+disabled 双列表：
 *  单列表（引擎形态）absent = 禁用（迁移期权威全集）；双列表 absent = 新入列模板 → 默认启用）。 */
interface LabSessionPayload {
  enabledTemplateAssetIds: string[]
  selectedTemplateAssetId: string | null
  /** 仅 store 写入；缺席 = 引擎迁移期形态（enabled 列表为全集，缺席即禁用）。 */
  disabledTemplateAssetIds?: string[]
}

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

const records = $state<Record<string, TemplateRecord>>({})
let order = $state<string[]>([])
let ready = $state(false)
/** 启用集（显式布尔；新入列模板默认 true 并落 session）。 */
let enabledMap = $state<Record<string, boolean>>({})
let selectedId = $state<string | null>(null)

/** CAS 期望键（节点当前 blobKey；refresh/换绑成功时更新）。 */
const blobKeys = new Map<string, string>()
/** 最后一次成功写入磁盘的内容（失败回显旧值的数据源；结构 = TemplatePersistedSnapshot）。 */
type PersistedSnapshot = TemplatePersistedSnapshot
const persistedSnapshots = new Map<string, PersistedSnapshot>()
/** 单调 revision：每次字段提交 +1；writtenRevisions 记最后成功写入所含的 revision。 */
const revisions = new Map<string, number>()
const writtenRevisions = new Map<string, number>()
/** 每模板串行写队列（E4）。 */
const writeChains = new Map<string, Promise<void>>()
let queuedWriteCount = 0
/** 已删除模板的在途写熔断（删除 = 清空队列并终止在途写，E4）。 */
const disposed = new Set<string>()

// ---------------------------------------------------------------------------
// session 读写（localStorage；损坏/缺失 → null → 调用方回默认）
// ---------------------------------------------------------------------------

function parseSessionRaw(raw: string | null): LabSessionPayload | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LabSessionPayload>
    if (!Array.isArray(parsed.enabledTemplateAssetIds) || parsed.enabledTemplateAssetIds.some((id) => typeof id !== 'string')) {
      return null
    }
    const selected = parsed.selectedTemplateAssetId
    if (selected !== null && typeof selected !== 'string') return null
    const disabled = parsed.disabledTemplateAssetIds
    if (disabled !== undefined && (!Array.isArray(disabled) || disabled.some((id) => typeof id !== 'string'))) {
      return null
    }
    return {
      enabledTemplateAssetIds: [...parsed.enabledTemplateAssetIds],
      selectedTemplateAssetId: selected ?? null,
      ...(disabled !== undefined ? { disabledTemplateAssetIds: [...disabled] } : {}),
    }
  } catch {
    return null
  }
}

function readSession(): LabSessionPayload | null {
  try {
    return parseSessionRaw(localStorage.getItem(LAB_SESSION_KEY))
  } catch {
    return null
  }
}

function persistSession(): void {
  const payload: LabSessionPayload = {
    enabledTemplateAssetIds: Object.entries(enabledMap)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id),
    selectedTemplateAssetId: selectedId,
    // 双列表自描述「已知全集」：后续读取可区分「显式禁用」与「新入列默认启用」
    disabledTemplateAssetIds: Object.entries(enabledMap)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id),
  }
  try {
    localStorage.setItem(LAB_SESSION_KEY, JSON.stringify(payload))
  } catch {
    // 隐私模式/配额：会话态丢失不阻断（下次回默认全启用），不抛
  }
}

// ---------------------------------------------------------------------------
// 读取面（组件/宿主消费；$state 读取天然响应式）
// ---------------------------------------------------------------------------

export function isTemplatesReady(): boolean {
  return ready
}

export function getTemplateAssetIds(): string[] {
  return order
}

export function getTemplateRecord(assetId: string): TemplateRecord | undefined {
  return records[assetId]
}

export function getTemplateList(): TemplateRecord[] {
  return order.map((id) => records[id]).filter((r): r is TemplateRecord => r !== undefined)
}

export function isEnabledTemplate(assetId: string): boolean {
  return enabledMap[assetId] === true
}

export function getSelectedTemplateAssetId(): string | null {
  return selectedId
}

/** startRun / RunBar / 摘要徽标共用的「可用模板」口径（启用 × 非空提示词 × 候选 ≥1）。 */
export function getUsableTemplates(): TemplateRecord[] {
  return getTemplateList().filter(
    (t) => isEnabledTemplate(t.assetId) && t.promptBody.trim() !== '' && t.candidates >= 1,
  )
}

// ---------------------------------------------------------------------------
// session 变更面
// ---------------------------------------------------------------------------

export function setEnabledTemplate(assetId: string, enabled: boolean): void {
  if (!(assetId in records) && !(assetId in enabledMap)) return
  if (enabledMap[assetId] === enabled) return
  enabledMap[assetId] = enabled
  persistSession()
}

export function selectTemplate(assetId: string | null): void {
  if (assetId !== null && !(assetId in records)) return
  if (selectedId === assetId) return
  selectedId = assetId
  persistSession()
}

// ---------------------------------------------------------------------------
// 写队列（E4：串行 + 单调 revision；写入内容执行时刻现算——旧写不覆盖新写）
// ---------------------------------------------------------------------------

function enqueueWrite(assetId: string): void {
  queuedWriteCount += 1
  const prev = writeChains.get(assetId) ?? Promise.resolve()
  const next = prev.then(() => runWrite(assetId)).finally(() => {
    queuedWriteCount -= 1
  })
  writeChains.set(assetId, next)
}

// ---------------------------------------------------------------------------
// 高级选项辅助（C3.1：深拷贝应用防外泄可变引用；等值判定沿 caseBindingEquals 先例）
// ---------------------------------------------------------------------------

function cloneDrillParams(value: GemtplDrillParams): GemtplDrillParams {
  return {
    enabled: value.enabled,
    specs: [...value.specs],
    ...(value.physical !== undefined ? { physical: { ...value.physical } } : {}),
  }
}

function cloneBlueprint(value: GemtplBlueprint): GemtplBlueprint {
  return { enabled: value.enabled, ...(value.refs !== undefined ? { refs: [...value.refs] } : {}) }
}

function drillParamsEquals(a: GemtplDrillParams | undefined, b: GemtplDrillParams | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.enabled !== b.enabled) return false
  if (a.specs.length !== b.specs.length || a.specs.some((s, i) => s !== b.specs[i])) return false
  if ((a.physical === undefined) !== (b.physical === undefined)) return false
  if (a.physical === undefined || b.physical === undefined) return true
  return (
    a.physical.widthMm === b.physical.widthMm &&
    a.physical.heightMm === b.physical.heightMm &&
    a.physical.anchorSource === b.physical.anchorSource
  )
}

function blueprintEquals(a: GemtplBlueprint | undefined, b: GemtplBlueprint | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.enabled !== b.enabled) return false
  const ar = a.refs ?? []
  const br = b.refs ?? []
  return ar.length === br.length && ar.every((r, i) => r === br[i])
}

/** 字段提交（onchange/blur → 本函数 → 串行换绑）。同步应用 record + 入队写。 */
export function submitTemplateField(assetId: string, patch: TemplateFieldPatch): void {
  const record = records[assetId]
  if (!record || disposed.has(assetId)) return
  // 高级选项写入门（design §1.1「裁决与禁令」）：validate 拒写 = toast + 零应用零入队。
  // UI 层（TemplateAdvancedOptions）保证常规操作合法；此门拦截程序化/异常路径的脏输入。
  if (patch.drillParams !== undefined) {
    try {
      validateGemtplDrillParams(patch.drillParams)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '水钻参数配置不合法，已拒绝保存。')
      return
    }
  }
  if (patch.blueprint !== undefined) {
    try {
      validateGemtplBlueprint(patch.blueprint)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '蓝图选项不合法，已拒绝保存。')
      return
    }
  }
  let touched = false
  if (patch.name !== undefined && patch.name !== record.name) {
    record.name = patch.name
    touched = true
  }
  if (patch.promptBody !== undefined && patch.promptBody !== record.promptBody) {
    // 入口截断（labFile 序列化层是双侧第二道防线，保持 record 与磁盘零漂移）
    record.promptBody = patch.promptBody.slice(0, GEMTPL_PROMPT_BODY_MAX)
    touched = true
  }
  if (patch.candidates !== undefined) {
    const clamped = Math.min(GEMTPL_CANDIDATES_MAX, Math.max(GEMTPL_CANDIDATES_MIN, Math.floor(patch.candidates) || 1))
    if (clamped !== record.candidates) {
      record.candidates = clamped
      touched = true
    }
  }
  if (patch.caseBinding !== undefined && !caseBindingEquals(patch.caseBinding, record.caseBinding)) {
    // [B-2] 换绑不删旧合成图资产（资产生命周期归素材库）
    record.caseBinding = patch.caseBinding === null ? null : { ...patch.caseBinding }
    touched = true
  }
  if (patch.drillParams !== undefined && !drillParamsEquals(patch.drillParams, record.drillParams)) {
    record.drillParams = cloneDrillParams(patch.drillParams)
    touched = true
  }
  if (patch.blueprint !== undefined && !blueprintEquals(patch.blueprint, record.blueprint)) {
    record.blueprint = cloneBlueprint(patch.blueprint)
    touched = true
  }
  if (!touched) return
  record.lastError = null
  revisions.set(assetId, (revisions.get(assetId) ?? 0) + 1)
  enqueueWrite(assetId)
}

function caseBindingEquals(a: LabCaseBinding | null, b: LabCaseBinding | null): boolean {
  if (a === null || b === null) return a === b
  return a.assetId === b.assetId && a.caseLayout === b.caseLayout
}

function fieldLabelOf(patchWritten: {
  name: boolean
  promptBody: boolean
  candidates: boolean
  caseBinding: boolean
  drillParams: boolean
  blueprint: boolean
}): string {
  if (patchWritten.name) return '名称'
  if (patchWritten.candidates) return '候选数'
  if (patchWritten.caseBinding) return '案例绑定'
  if (patchWritten.drillParams) return '水钻参数配置'
  if (patchWritten.blueprint) return '蓝图选项'
  return '提示词体'
}

async function runWrite(assetId: string): Promise<void> {
  const record = records[assetId]
  if (!record || disposed.has(assetId)) return
  const revision = revisions.get(assetId) ?? 0
  if (revision === (writtenRevisions.get(assetId) ?? 0)) return // 合并：无新提交

  // 执行时刻现算写入内容（并发提交合并为最新态——旧 revision 永不覆盖新内容）
  const snapshotPrev = persistedSnapshots.get(assetId)
  const content: PersistedSnapshot & { createdAt: number; provenance: TemplateRecord['provenance'] } = {
    name: record.name,
    promptBody: record.promptBody,
    candidates: record.candidates,
    caseBinding: record.caseBinding === null ? null : { ...record.caseBinding },
    drillParams: record.drillParams === undefined ? undefined : cloneDrillParams(record.drillParams),
    blueprint: record.blueprint === undefined ? undefined : cloneBlueprint(record.blueprint),
    createdAt: record.createdAt,
    provenance: record.provenance,
  }
  const written = { name: false, promptBody: false, candidates: false, caseBinding: false, drillParams: false, blueprint: false }
  if (snapshotPrev === undefined || snapshotPrev.name !== content.name) written.name = true
  if (snapshotPrev === undefined || snapshotPrev.promptBody !== content.promptBody) written.promptBody = true
  if (snapshotPrev === undefined || snapshotPrev.candidates !== content.candidates) written.candidates = true
  if (snapshotPrev === undefined || !caseBindingEquals(snapshotPrev.caseBinding, content.caseBinding)) written.caseBinding = true
  if (snapshotPrev === undefined || !drillParamsEquals(snapshotPrev.drillParams, content.drillParams)) written.drillParams = true
  if (snapshotPrev === undefined || !blueprintEquals(snapshotPrev.blueprint, content.blueprint)) written.blueprint = true

  record.saving = true
  try {
    // 重命名 = 节点名 + 文件名同步（B.1.1）：先 renameAsset 取同父去重后的真实名，再入文件
    if (snapshotPrev === undefined || snapshotPrev.name !== content.name) {
      const renamed = await renameAsset(assetId, content.name)
      content.name = renamed.name // 去重后缀（' (2)'）采纳为真实名，节点/文件/record 三方一致
    }
    const stamp = Date.now()
    const text = serializeGemtpl({
      appVersion: APP_VERSION,
      createdAt: content.createdAt,
      savedAt: stamp,
      name: content.name,
      promptBody: content.promptBody,
      caseBinding: content.caseBinding,
      candidates: content.candidates,
      drillParams: content.drillParams,
      // refs 剥离落盘（labFile.BlueprintToggle 只有 enabled 键；refs 键位接线归 4.1）
      blueprint: content.blueprint === undefined ? undefined : { enabled: content.blueprint.enabled },
      provenance: content.provenance,
    })
    const updated = await updateProjectAsset(assetId, {
      expectedBlobKey: blobKeys.get(assetId) ?? '',
      bytes: new Blob([text], { type: PROJECT_MIME.gemtpl }),
      summary: {},
    })
    blobKeys.set(assetId, updated.blobKey)
    writtenRevisions.set(assetId, revision)
    // 快照存「提交态」（含 refs）：refs 是 validate 门通过并成功换绑的 record 值——
    // 「放弃修改」回退与脏检查以提交面为口径（磁盘 refs 缺席是 4.1 前的持久化局限，不算未提交）
    persistedSnapshots.set(assetId, {
      name: content.name,
      promptBody: content.promptBody,
      candidates: content.candidates,
      caseBinding: content.caseBinding,
      drillParams: content.drillParams === undefined ? undefined : cloneDrillParams(content.drillParams),
      blueprint: content.blueprint === undefined ? undefined : cloneBlueprint(content.blueprint),
    })
    record.name = content.name
    record.savedAt = stamp
    record.lastError = null
  } catch (error) {
    const conflict = error instanceof ProjectConflictError
    // revision 守卫：写入期间有更新提交时不回滚（用户最新编辑在途，由追加写轮次承接）
    const superseded = (revisions.get(assetId) ?? 0) > revision
    if (conflict) {
      // 跨 tab 冲突（C.5.4 裁决：单用户本地应用，最后写赢）：刷新 CAS 期望键，
      // 本轮内容保留，追加轮次以新键重写胜出；不静默（显式提示覆盖发生）
      const node = await getProject(assetId).catch(() => null)
      if (node) blobKeys.set(assetId, node.blobKey)
      showToast(`「${content.name || '未命名模板'}」已在其他窗口被修改；本次保存将以当前编辑内容覆盖。`)
      record.lastError = '已在其他窗口被修改，保存将覆盖'
    } else {
      if (!superseded) {
        // 失败回显旧值（B.1.2）：record 回退到最后一次成功持久内容
        const snap = persistedSnapshots.get(assetId)
        if (snap) {
          record.name = snap.name
          record.promptBody = snap.promptBody
          record.candidates = snap.candidates
          record.caseBinding = snap.caseBinding
          record.drillParams = snap.drillParams === undefined ? undefined : cloneDrillParams(snap.drillParams)
          record.blueprint = snap.blueprint === undefined ? undefined : cloneBlueprint(snap.blueprint)
        }
      }
      const reason = error instanceof Error ? error.message : String(error)
      // 三段式：失败事实（哪个模板哪个字段）+ 原因 + 恢复动作
      showToast(
        `保存失败：「${content.name || '未命名模板'}」的${fieldLabelOf(written)}未能写入素材库（${reason}）。已恢复为上次保存的值，可修改后重试。`,
      )
      record.lastError = reason
    }
  } finally {
    record.saving = false
  }

  // 写入期间有**更新提交**（revision 前进超过本轮）→ 追加一轮写最新内容；
  // 失败但无更新提交不重试（防止持久故障下的无限重试循环），用户下次提交自然再试
  if (!disposed.has(assetId) && (revisions.get(assetId) ?? 0) > revision) {
    enqueueWrite(assetId)
  }
}

// ---------------------------------------------------------------------------
// 「放弃修改」回退 + 持久快照只读口（4.3b RightSheet 关闭守卫；C.5.4 / design §9.3 E4）
// ---------------------------------------------------------------------------

/**
 * 最后一次成功换绑快照的只读副本（无持久历史 = undefined：从未写成功/文件损坏态）。
 * 宿主守卫用其与 record 对比判断「有无未提交修改」；返回拷贝防外泄内部可变引用。
 */
export function getTemplatePersistedSnapshot(assetId: string): TemplatePersistedSnapshot | undefined {
  const snap = persistedSnapshots.get(assetId)
  if (snap === undefined) return undefined
  return {
    name: snap.name,
    promptBody: snap.promptBody,
    candidates: snap.candidates,
    caseBinding: snap.caseBinding === null ? null : { ...snap.caseBinding },
    drillParams: snap.drillParams === undefined ? undefined : cloneDrillParams(snap.drillParams),
    blueprint: snap.blueprint === undefined ? undefined : cloneBlueprint(snap.blueprint),
  }
}

/**
 * 「放弃修改」（C.5.4）：record 四字段回退到最后成功换绑快照——丢弃未提交缓冲回到
 * 已持久内容，**磁盘不动**（快照本就是磁盘现状，失败写从未落盘）。
 *
 * 时序裁决（design §9.3 E4「放弃=回退最后成功快照并关闭」的实现语义）：
 * - 同时把 revision 对齐 writtenRevision——此后队列中**尚未开始**的写轮次因
 *   `revision === writtenRevision` 空转返回（不写盘、不清 lastError 语义），达成
 *   「排队中的放弃 = 连带放弃排队写」。
 * - **已在飞行中**（runWrite 已读取 revision/已现算内容）的写不受影响：其成功落盘后
 *   record/快照/磁盘三方一致（该内容成为新的持久真值），放弃对它语义不存在——因此
 *   调用方（TemplateEditSheet 关闭守卫）必须先 `whenTemplatesIdle()` 排空队列再回退；
 *   若 flush 已把新值写入磁盘，「放弃」自然无事可做。
 * - lastError 一并清除：record 已与持久态一致，失败指示失去对象。
 *
 * @returns false = record 不存在或无持久快照（无可回退）。
 */
export function revertTemplateFields(assetId: string): boolean {
  const record = records[assetId]
  const snap = persistedSnapshots.get(assetId)
  if (record === undefined || snap === undefined) return false
  record.name = snap.name
  record.promptBody = snap.promptBody
  record.candidates = snap.candidates
  record.caseBinding = snap.caseBinding === null ? null : { ...snap.caseBinding }
  record.drillParams = snap.drillParams === undefined ? undefined : cloneDrillParams(snap.drillParams)
  record.blueprint = snap.blueprint === undefined ? undefined : cloneBlueprint(snap.blueprint)
  record.lastError = null
  revisions.set(assetId, writtenRevisions.get(assetId) ?? 0)
  return true
}

// ---------------------------------------------------------------------------
// CRUD（B.1.1：新建即 ingest「模板 N」/ 复制 fork「原名 副本」/ 软删 / 移出目录=收起）
// ---------------------------------------------------------------------------

function assertCapacity(): boolean {
  if (getTemplateList().length < MAX_TEMPLATES) return true
  showToast(`模板已达上限（${MAX_TEMPLATES} 条），请先整理或删除后再操作。`)
  return false
}

export async function createTemplate(): Promise<string | null> {
  if (!assertCapacity()) return null
  const stamp = Date.now()
  const name = `模板 ${getTemplateList().length + 1}`
  const text = serializeGemtpl({
    appVersion: APP_VERSION,
    createdAt: stamp,
    savedAt: stamp,
    name,
    promptBody: '',
    caseBinding: null,
    candidates: NEW_TEMPLATE_CANDIDATES,
    provenance: { source: 'user-created' },
  })
  try {
    const result = await ingestProjectAsset({
      blob: new Blob([text], { type: PROJECT_MIME.gemtpl }),
      name,
      projectKind: 'gemtpl',
      parentId: SYS_TEMPLATES_FOLDER_ID,
    })
    await refreshTemplates()
    selectTemplate(result.node.id)
    return result.node.id
  } catch (error) {
    showToast(`新建模板失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function forkTemplate(assetId: string): Promise<string | null> {
  const source = records[assetId]
  if (!source) return null
  if (!assertCapacity()) return null
  const stamp = Date.now()
  const text = serializeGemtpl({
    appVersion: APP_VERSION,
    createdAt: stamp,
    savedAt: stamp,
    name: `${source.name || '未命名模板'} 副本`,
    promptBody: source.promptBody,
    caseBinding: source.caseBinding === null ? null : { ...source.caseBinding },
    candidates: source.candidates,
    drillParams: source.drillParams === undefined ? undefined : cloneDrillParams(source.drillParams),
    blueprint:
      source.blueprint === undefined ? undefined : { enabled: source.blueprint.enabled },
    // fork 不记 templateAssetId 链（快照语义，同 gemproj 另存为不记 projectId）
    provenance: {
      source: 'forked',
      ...(source.provenance.sourceNote !== undefined ? { sourceNote: source.provenance.sourceNote } : {}),
    },
  })
  try {
    const result = await ingestProjectAsset({
      blob: new Blob([text], { type: PROJECT_MIME.gemtpl }),
      name: `${source.name || '未命名模板'} 副本`,
      projectKind: 'gemtpl',
      parentId: SYS_TEMPLATES_FOLDER_ID,
    })
    await refreshTemplates()
    selectTemplate(result.node.id)
    return result.node.id
  } catch (error) {
    showToast(`复制模板失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function removeTemplate(assetId: string): Promise<void> {
  if (!(assetId in records)) return
  try {
    await trashAsset(assetId)
  } catch (error) {
    showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  // E4：删除 = 清空队列并终止在途写（已 await trashAsset，在途写在 disposed 熔断下自然空转）
  disposed.add(assetId)
  pruneTemplateState(assetId)
}

function pruneTemplateState(assetId: string): void {
  delete records[assetId]
  order = order.filter((id) => id !== assetId)
  delete enabledMap[assetId]
  blobKeys.delete(assetId)
  persistedSnapshots.delete(assetId)
  revisions.delete(assetId)
  writtenRevisions.delete(assetId)
  if (selectedId === assetId) selectedId = order[0] ?? null
  persistSession()
}

// ---------------------------------------------------------------------------
// 刷新（hydrate / CRUD 后；含 session enabled 恢复——0.8 引擎写入的 lab-session 同源读取）
// ---------------------------------------------------------------------------

async function parseTemplateNode(node: AssetProject): Promise<GemtplFile | null> {
  try {
    const blob = await getImageBlob(node.blobKey)
    if (!blob) return null
    return parseGemtpl(await blob.text(), { mime: node.mime })
  } catch {
    return null
  }
}

export async function refreshTemplates(): Promise<void> {
  let children: AssetNode[] = []
  try {
    children = await listChildNodes(SYS_TEMPLATES_FOLDER_ID)
  } catch {
    children = [] // IDB 不可用：空列表 + ready（空态即 4.2 seed 失败恢复入口）
  }
  const nodes = children.filter(
    (n): n is AssetProject => n.type === 'project' && n.projectKind === 'gemtpl' && n.trashedAt === undefined,
  )

  const session = readSession()
  const sessionEnabled = new Set(session?.enabledTemplateAssetIds ?? [])
  // 引擎形态（无 disabled 列表）= 迁移期权威全集：absent 即禁用；
  // store 形态（双列表）= absent 未提及 → 新入列模板（新 preset 增量 seed / 外部导入）→ 默认启用
  const sessionDisabled = session?.disabledTemplateAssetIds
  const sessionDisabledSet = new Set(sessionDisabled ?? [])

  const nextOrder: string[] = []
  for (const node of nodes) {
    disposed.delete(node.id)
    nextOrder.push(node.id)
    blobKeys.set(node.id, node.blobKey)

    const existing = records[node.id]
    const pendingWrite = (revisions.get(node.id) ?? 0) !== (writtenRevisions.get(node.id) ?? 0)
    if (existing && (pendingWrite || existing.saving)) {
      // 在途/待写：保留内存编辑视图（刷新不覆盖未落盘内容）；仅顺延展示字段
      existing.name = node.name !== existing.name && !pendingWrite ? node.name : existing.name
      continue
    }

    const file = await parseTemplateNode(node)
    if (file === null) {
      // 文件损坏/版本超前：保留列表位（编辑器可打开，保存即换绑自愈），lastError 标注
      records[node.id] = {
        assetId: node.id,
        name: node.name,
        promptBody: '',
        candidates: NEW_TEMPLATE_CANDIDATES,
        caseBinding: null,
        createdAt: node.createdAt,
        provenance: { source: 'user-created' },
        savedAt: node.updatedAt,
        lastError: '模板文件无法读取（可能来自更新版本或已损坏）',
        saving: false,
      }
      persistedSnapshots.delete(node.id)
      continue
    }
    records[node.id] = {
      assetId: node.id,
      name: file.name,
      promptBody: file.promptBody,
      candidates: file.candidates,
      caseBinding: file.caseBinding,
      drillParams: file.drillParams === undefined ? undefined : cloneDrillParams(file.drillParams),
      // 读面 file 侧无 refs（labFile.BlueprintToggle 只承 enabled；refs 落盘归 4.1）
      blueprint: file.blueprint === undefined ? undefined : { enabled: file.blueprint.enabled },
      createdAt: file.createdAt,
      provenance: file.provenance,
      savedAt: file.savedAt,
      lastError: null,
      saving: false,
    }
    persistedSnapshots.set(node.id, {
      name: file.name,
      promptBody: file.promptBody,
      candidates: file.candidates,
      caseBinding: file.caseBinding,
      drillParams: file.drillParams === undefined ? undefined : cloneDrillParams(file.drillParams),
      blueprint: file.blueprint === undefined ? undefined : { enabled: file.blueprint.enabled },
    })
    writtenRevisions.set(node.id, revisions.get(node.id) ?? 0)
  }

  // 收起已消失的模板（软删/移出目录/硬清——库仍真源，移回/还原后 refresh 恢复）
  for (const id of [...order]) {
    if (!nextOrder.includes(id)) pruneTemplateState(id)
  }
  order = nextOrder

  // session enabled 恢复（E8 + 引擎/双列表两种载荷形态的合并规则见上方注释）
  let sessionDirty = false
  for (const id of order) {
    if (session === null) {
      enabledMap[id] = true // 无/损坏 session：回默认全启用
    } else if (sessionEnabled.has(id)) {
      if (enabledMap[id] !== true) sessionDirty = true
      enabledMap[id] = true
    } else if (sessionDisabled === undefined) {
      if (enabledMap[id] !== false) sessionDirty = true
      enabledMap[id] = false // 引擎载荷：absent = 禁用
    } else if (sessionDisabledSet.has(id)) {
      if (enabledMap[id] !== false) sessionDirty = true
      enabledMap[id] = false // 双列表载荷：显式禁用
    } else {
      enabledMap[id] = true // 双列表载荷未提及 = 新入列 → 默认启用
      sessionDirty = true
    }
  }
  if (selectedId === null || !order.includes(selectedId)) {
    const stored = session?.selectedTemplateAssetId ?? null
    selectedId = stored !== null && order.includes(stored) ? stored : (order[0] ?? null)
    sessionDirty = true
  }
  if (sessionDirty) persistSession()

  ready = true
}

// ---------------------------------------------------------------------------
// 跨 tab storage 事件（E8：非静默提示）
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LAB_SESSION_KEY) return
    // 载荷以事件 newValue 为准（本 tab 的 localStorage 仍是旧值——storage 事件只在跨 tab 触发）
    const session = parseSessionRaw(event.newValue)
    if (session === null) return
    const incoming = new Set(session.enabledTemplateAssetIds)
    const knownIds = [...Object.keys(enabledMap), ...order]
    const changed = knownIds.some((id) => (enabledMap[id] === true) !== incoming.has(id))
    for (const id of knownIds) {
      if (id in enabledMap) enabledMap[id] = incoming.has(id)
    }
    const stored = session.selectedTemplateAssetId
    if (stored !== null && order.includes(stored)) selectedId = stored
    if (changed) showToast('模板启用状态已在其他窗口修改，已同步显示。')
  })
}

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 等待全部在途/排队写落地（串行链 + 追加轮次全消）。 */
export async function whenTemplatesIdle(): Promise<void> {
  while (queuedWriteCount > 0) {
    await Promise.allSettled([...writeChains.values()])
  }
}

/** 测试专用：整体复位内存态（不动 IndexedDB / localStorage，由测试自行清理）。 */
export function resetTemplatesForTests(): void {
  for (const id of [...Object.keys(records)]) delete records[id]
  order = []
  enabledMap = {}
  selectedId = null
  ready = false
  blobKeys.clear()
  persistedSnapshots.clear()
  revisions.clear()
  writtenRevisions.clear()
  writeChains.clear()
  queuedWriteCount = 0
  disposed.clear()
}
