/*
 * 样卡导入向导状态机（add-stone-library S3.3——design §8 导入链的 UI 壳）。
 * 原始需求 2026-09-24（Owner 定调三「AI 帮人录入」）：上传样卡源图 → 粘贴/引用
 * AI 草表（CardCatalogDraft JSON）→ proposal 预览 → 执行 → 导入报告。
 * 执行通道（S3.3 占位升级）：stones.importRun 人工直发——操作者即批准人（与
 * agent/MCP 面 proposal 流并存，daemon 侧收敛同一 runCardImport）；执行器经
 * bindWizardImportExecutor 注入（store 的 runStoneImport——源图页 blob 映射 +
 * importRun + 报告回填），测试可注替身。
 * 正交意图：
 *   [1] 步进状态机（sources→draft→preview→execute；report=执行产物态）。
 *   [2] 源图页管理（多页上传映射 sourcePages——File+objectURL；页号即键）。
 *   [3] 草表校验（CardCatalogDraftSchema 全量 parse——错误逐条呈现）。
 *   [4] 预览摘要（纯函数 summarizeDraft：款式/格数/色系/低置信/引用页 vs 上传页）。
 *   [5] 执行面（executor 注入+执行锁+错误呈现）与报告投影（daemon
 *       CardImportReport 子集 schema——四清单分组派生）。
 */

import { CardCatalogDraftSchema, type CardCatalogDraft } from '@handicraft/contracts'
import { z } from 'zod'

export const WIZARD_STEPS = ['sources', 'draft', 'preview', 'execute'] as const
export type ImportWizardStep = (typeof WIZARD_STEPS)[number] | 'report'

/** 低置信阈值（design §8 / S2.4 冻结 0.7——与 daemon importer 常量同值镜像）。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7

export interface WizardSourcePage {
  page: number
  file: File
  url: string
}

/** 执行请求（wizard 状态 → 注入执行器；页 File 直供由执行器负责 blob 入库）。 */
export interface WizardImportRequest {
  draft: CardCatalogDraft
  targetSupplier: string
  pages: WizardSourcePage[]
}

/** 执行器（生产=store.runStoneImport：源图页 uploadAsset→importRun；测试注替身）。 */
export type WizardImportExecutor = (request: WizardImportRequest) => Promise<unknown>

export interface WizardLowConfidenceItem {
  row: number
  suggestedName: string
  confidence: number
  reason: 'low-confidence' | 'unnamed'
}

export interface WizardPreviewSummary {
  supplier: string
  styleCount: number
  cellCount: number
  families: string[]
  bands: Array<{ rows: [number, number]; prefixes: string[] }>
  lowConfidence: WizardLowConfidenceItem[]
  referencedPages: number[]
  uploadedPages: number[]
  /** 引用页未上传（多页草表无单页回退——执行前须补页或换草表）。 */
  missingPages: number[]
  singlePageFallbackAvailable: boolean
}

// ---------------------------------------------------------------- 状态

let open = $state(false)
let step = $state<ImportWizardStep>('sources')
let pages = $state<WizardSourcePage[]>([])
let draftText = $state('')
let draft = $state<CardCatalogDraft | null>(null)
let draftError = $state<string | null>(null)
let targetSupplier = $state('')
let report = $state<WizardImportReport | null>(null)
let executor: WizardImportExecutor | null = null
let executing = $state(false)
let executeError = $state<string | null>(null)

export function isImportWizardOpen(): boolean {
  return open
}

export function getImportWizardStep(): ImportWizardStep {
  return step
}

export function getImportWizardPages(): WizardSourcePage[] {
  return pages
}

export function getImportWizardDraftText(): string {
  return draftText
}

export function getImportWizardDraft(): CardCatalogDraft | null {
  return draft
}

export function getImportWizardDraftError(): string | null {
  return draftError
}

export function getImportWizardTargetSupplier(): string {
  return targetSupplier
}

export function getImportWizardReport(): WizardImportReport | null {
  return report
}

export function isImportWizardExecuting(): boolean {
  return executing
}

export function getImportWizardExecuteError(): string | null {
  return executeError
}

// ---------------------------------------------------------------- 开合与步进

export function openImportWizard(): void {
  open = true
  step = 'sources'
  executeError = null
}

export function closeImportWizard(): void {
  open = false
}

export function resetImportWizardForTests(): void {
  open = false
  step = 'sources'
  pages = []
  draftText = ''
  draft = null
  draftError = null
  targetSupplier = ''
  report = null
  executor = null
  executing = false
  executeError = null
}

/** 步进守卫：draft→preview 需草表 parse 通过；execute 由执行按钮推进到 report。 */
export function wizardCanAdvance(): boolean {
  if (step === 'sources') return true
  if (step === 'draft') return draft !== null
  if (step === 'preview') return true
  return false
}

export function wizardGoNext(): void {
  if (!wizardCanAdvance()) return
  if (step === 'sources') step = 'draft'
  else if (step === 'draft') step = 'preview'
  else if (step === 'preview') step = 'execute'
}

export function wizardGoBack(): void {
  if (step === 'draft') step = 'sources'
  else if (step === 'preview') step = 'draft'
  else if (step === 'execute') step = 'preview'
}

// ---------------------------------------------------------------- 源图页

/** 多页上传（sourcePages 映射）：页号顺序 1..n；重复设置整体替换。 */
export function wizardSetSourceFiles(files: File[]): void {
  for (const page of pages) URL.revokeObjectURL(page.url)
  pages = files.map((file, index) => ({ page: index + 1, file, url: URL.createObjectURL(file) }))
}

export function wizardRemoveSourcePage(page: number): void {
  const target = pages.find((candidate) => candidate.page === page)
  if (target === undefined) return
  URL.revokeObjectURL(target.url)
  pages = pages.filter((candidate) => candidate.page !== page).map((candidate, index) => ({ ...candidate, page: index + 1 }))
}

// ---------------------------------------------------------------- 草表

/** 粘贴/导入草表 JSON：全量 schema 校验——失败逐条列 issue，不部分接受。 */
export function wizardSetDraftText(text: string): void {
  draftText = text
  draft = null
  draftError = null
  const trimmed = text.trim()
  if (trimmed === '') {
    draftError = '草表 JSON 为空——粘贴 AI 产出的 CardCatalogDraft（vision 样卡识别结果）'
    return
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(trimmed)
  } catch (error) {
    draftError = `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
    return
  }
  const result = CardCatalogDraftSchema.safeParse(parsedJson)
  if (!result.success) {
    draftError = result.error.issues.map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')
    return
  }
  draft = result.data
  if (targetSupplier === '') targetSupplier = result.data.supplier
}

export function wizardSetTargetSupplier(supplier: string): void {
  targetSupplier = supplier
}

// ---------------------------------------------------------------- 预览摘要（纯函数）

/** 草表结构摘要：客户端可证事实（新原子数/切格结果以服务端 preview 与执行报告为准——不猜测）。 */
export function summarizeDraft(draft: CardCatalogDraft, uploadedPages: number[]): WizardPreviewSummary {
  const referencedPages = [...new Set(draft.styles.flatMap((style) => style.cells.map((cell) => cell.page)))].sort((a, b) => a - b)
  const singlePageFallbackAvailable = draft.sourceImage.pages.length === 1 && referencedPages.length === 1 && referencedPages[0] === draft.sourceImage.pages[0]!.page
  const missingPages = singlePageFallbackAvailable ? [] : referencedPages.filter((page) => !uploadedPages.includes(page))
  const lowConfidence: WizardLowConfidenceItem[] = []
  for (const style of draft.styles) {
    const reason: WizardLowConfidenceItem['reason'] | null = style.suggestedName.trim() === '' ? 'unnamed' : style.confidence < LOW_CONFIDENCE_THRESHOLD ? 'low-confidence' : null
    if (reason !== null) {
      lowConfidence.push({ row: style.row, suggestedName: style.suggestedName, confidence: style.confidence, reason })
    }
  }
  return {
    supplier: draft.supplier,
    styleCount: draft.styles.length,
    cellCount: draft.styles.reduce((sum, style) => sum + style.cells.length, 0),
    families: [...new Set(draft.styles.map((style) => style.suggestedFamily).filter((family) => family !== ''))],
    bands: draft.bands.map((band) => ({ rows: [band.rows[0], band.rows[1]], prefixes: Object.keys(band.sizeMmByPrefix) })),
    lowConfidence,
    referencedPages,
    uploadedPages: [...uploadedPages].sort((a, b) => a - b),
    missingPages,
    singlePageFallbackAvailable,
  }
}

// ---------------------------------------------------------------- 执行面（importRun 直发）

/** 注入执行器（生产=store.runStoneImport；测试注替身——报告注入缝的执行侧对偶）。 */
export function bindWizardImportExecutor(exec: WizardImportExecutor): void {
  executor = exec
}

/**
 * 执行导入（execute 步按钮）：调注入执行器（源图页 blob 映射+stones.importRun
 * ——操作者即批准人），成功响应经 wizardSetReport 校验后切 report 步；执行锁
 * 防重复提交（幽灵操作防线）。
 */
export async function wizardExecuteImport(): Promise<void> {
  if (executing || draft === null) return
  if (executor === null) {
    executeError = '执行器未绑定（导入执行通道缺席——管理视图未初始化）'
    return
  }
  executing = true
  executeError = null
  try {
    const response = await executor({
      draft,
      targetSupplier: targetSupplier.trim() !== '' ? targetSupplier.trim() : draft.supplier,
      pages: [...pages],
    })
    const applied = wizardSetReport(response)
    if (!applied.ok) {
      executeError = `导入响应不符报告契约：${applied.error}`
    }
  } catch (error) {
    executeError = error instanceof Error ? error.message : String(error)
  } finally {
    executing = false
  }
}

// ---------------------------------------------------------------- 报告（外部注入缝）

export const ImportCellOutcomeSchema = z.enum(['created', 'skipped', 'failed', 'pending'])
export type ImportCellOutcome = z.infer<typeof ImportCellOutcomeSchema>

/** daemon CardImportReport 的 UI 消费子集（多余字段剥除——不发明字段）。 */
export const WizardImportReportSchema = z.object({
  kind: z.literal('card-import-report'),
  formatVersion: z.literal(1),
  generatedAt: z.string(),
  supplier: z.string(),
  summary: z.object({
    created: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
    lowConfidence: z.number().int(),
    rows: z.number().int(),
    needsReviewRows: z.number().int(),
  }),
  lowConfidence: z.array(z.object({ sku: z.string(), row: z.number().int(), outcome: ImportCellOutcomeSchema })),
  rows: z.array(
    z.object({
      row: z.number().int(),
      suggestedName: z.string(),
      appliedName: z.string(),
      family: z.string(),
      confidence: z.number(),
      lowConfidence: z.boolean(),
      needsReview: z.boolean(),
      cells: z.array(
        z.object({
          sku: z.string(),
          finalSku: z.string(),
          page: z.number().int(),
          status: ImportCellOutcomeSchema,
          reason: z.string().nullable(),
        }),
      ),
    }),
  ),
})
export type WizardImportReport = z.infer<typeof WizardImportReportSchema>

export interface ImportReportLists {
  created: Array<{ sku: string; finalSku: string; row: number }>
  skipped: Array<{ sku: string; reason: string | null }>
  failed: Array<{ sku: string; reason: string | null }>
  /** pendingDowngrades（§8.1 规则 3 跨格同字节降级——card-render-pending）。 */
  pendingDowngrades: Array<{ sku: string; reason: string | null }>
}

/** 报告 → 四清单（成功/跳过/失败/pendingDowngrades——S2.5 冻结视图）。 */
export function reportListsOf(report: WizardImportReport): ImportReportLists {
  const lists: ImportReportLists = { created: [], skipped: [], failed: [], pendingDowngrades: [] }
  for (const row of report.rows) {
    for (const cell of row.cells) {
      if (cell.status === 'created') lists.created.push({ sku: cell.sku, finalSku: cell.finalSku, row: row.row })
      else if (cell.status === 'skipped') lists.skipped.push({ sku: cell.sku, reason: cell.reason })
      else if (cell.status === 'failed') lists.failed.push({ sku: cell.sku, reason: cell.reason })
      else lists.pendingDowngrades.push({ sku: cell.sku, reason: cell.reason })
    }
  }
  return lists
}

/** 注入执行报告（wizardExecuteImport 产物/测试注入缝——校验失败显式拒绝）。 */
export function wizardSetReport(input: unknown): { ok: true } | { ok: false; error: string } {
  const parsed = WizardImportReportSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；') }
  }
  report = parsed.data
  step = 'report'
  return { ok: true }
}
