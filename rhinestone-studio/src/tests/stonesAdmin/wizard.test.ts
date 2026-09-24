/*
 * 导入向导状态机单测（add-stone-library S3.3——design §8 UI 壳）：
 * 步进守卫（draft 未过校验不可前进/authorize 为终态）、源图页管理、草表校验
 * （好/坏 JSON、字段级 issue）、预览摘要（低置信/缺页/单页回退）、授权桥调用
 * JSON、报告注入校验与四清单派生。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CardCatalogDraftSchema, type CardCatalogDraft } from '@handicraft/contracts'
import {
  LOW_CONFIDENCE_THRESHOLD,
  getImportWizardDraftError,
  getImportWizardReport,
  getImportWizardStep,
  reportListsOf,
  resetImportWizardForTests,
  summarizeDraft,
  wizardCanAdvance,
  wizardGoBack,
  wizardGoNext,
  wizardMcpInvocationJson,
  wizardRemoveSourcePage,
  wizardSetDraftText,
  wizardSetReport,
  wizardSetSourceFiles,
  wizardSetTargetSupplier,
} from '$lib/stonesAdmin/wizard.svelte'

function png(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

const VALID_DRAFT = {
  schemaVersion: 1,
  supplier: 'yuhang',
  sourceImage: {
    blobRef: 'a'.repeat(64),
    pages: [
      { page: 1, widthPx: 1000, heightPx: 800 },
      { page: 2, widthPx: 1000, heightPx: 800 },
    ],
  },
  bands: [{ rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3 } }],
  styles: [
    {
      row: 51,
      suggestedName: '象牙白',
      suggestedFamily: '白色系',
      rgb: [255, 255, 240],
      confidence: 0.9,
      cells: [{ sku: 'J51', page: 1, bboxPx: { x: 0, y: 0, w: 10, h: 10 } }],
    },
    {
      row: 52,
      suggestedName: '',
      suggestedFamily: '蓝色系',
      rgb: [30, 60, 200],
      confidence: 0.5,
      cells: [{ sku: 'A52', page: 2, bboxPx: { x: 5, y: 5, w: 8, h: 8 } }],
    },
  ],
} satisfies CardCatalogDraft

const REPORT_FIXTURE = {
  kind: 'card-import-report',
  formatVersion: 1,
  generatedAt: '2026-09-24T00:00:00.000Z',
  supplier: 'yuhang',
  draftSupplier: 'yuhang',
  options: { targetSupplier: 'yuhang', qualityFlag: null, backgroundTolerance: 16, featherPx: 2 },
  summary: { created: 2, skipped: 1, failed: 1, pending: 1, lowConfidence: 1, rows: 2, needsReviewRows: 1 },
  lowConfidence: [{ sku: 'A52', row: 52, outcome: 'created' as const }],
  rows: [
    {
      row: 51,
      suggestedName: '象牙白',
      appliedName: '象牙白',
      family: '白色系',
      confidence: 0.9,
      lowConfidence: false,
      needsReview: false,
      cells: [
        { sku: 'J51', finalSku: 'J51', page: 1, status: 'created' as const, reason: null },
        { sku: 'A51', finalSku: 'A51', page: 1, status: 'skipped' as const, reason: 'supplier×sku 已存在' },
      ],
    },
    {
      row: 52,
      suggestedName: '',
      appliedName: '待命名-52',
      family: '蓝色系',
      confidence: 0.5,
      lowConfidence: true,
      needsReview: true,
      cells: [
        { sku: 'A52', finalSku: 'A52', page: 2, status: 'created' as const, reason: null },
        { sku: 'B52', finalSku: 'B52', page: 2, status: 'failed' as const, reason: '贴图 gate：alpha 内容为空' },
        { sku: 'C52', finalSku: 'C52', page: 2, status: 'pending' as const, reason: '跨格同字节——card-render-pending' },
      ],
    },
  ],
}

beforeEach(() => {
  resetImportWizardForTests()
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:wiz'), revokeObjectURL: vi.fn() })
})

describe('向导步进状态机', () => {
  it('sources→draft 自由前进；draft 未过校验不可前进；过验后到 preview；authorize 终态（无下一步）', () => {
    expect(getImportWizardStep()).toBe('sources')
    expect(wizardCanAdvance()).toBe(true)
    wizardGoNext()
    expect(getImportWizardStep()).toBe('draft')

    expect(wizardCanAdvance()).toBe(false) // 无草表
    wizardGoNext()
    expect(getImportWizardStep()).toBe('draft') // 原地

    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    expect(wizardCanAdvance()).toBe(true)
    wizardGoNext()
    expect(getImportWizardStep()).toBe('preview')
    wizardGoNext()
    expect(getImportWizardStep()).toBe('authorize')
    expect(wizardCanAdvance()).toBe(false) // 浏览器侧终态
    wizardGoNext()
    expect(getImportWizardStep()).toBe('authorize')
  })

  it('back 链路：authorize→preview→draft→sources', () => {
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    wizardGoNext()
    wizardGoNext()
    wizardGoNext()
    wizardGoBack()
    expect(getImportWizardStep()).toBe('preview')
    wizardGoBack()
    expect(getImportWizardStep()).toBe('draft')
    wizardGoBack()
    expect(getImportWizardStep()).toBe('sources')
  })

  it('报告注入（未来 RPC 缝）：合法报告切到 report 步；坏形状显式拒绝不切步', () => {
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    const ok = wizardSetReport(REPORT_FIXTURE)
    expect(ok.ok).toBe(true)
    expect(getImportWizardStep()).toBe('report')

    resetImportWizardForTests()
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    const bad = wizardSetReport({ ...REPORT_FIXTURE, summary: { ...REPORT_FIXTURE.summary, created: '2' } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('created')
    expect(getImportWizardStep()).not.toBe('report')
  })
})

describe('源图页管理', () => {
  /** 页号即键——经调用 JSON 反查（避免额外导出面）。 */
  function wizardPagesOfInvocation(): number[] {
    const invocation = wizardMcpInvocationJson()
    if (invocation === '') return []
    const parsed = JSON.parse(invocation) as { arguments: { sourcePages: Record<string, string> } }
    return Object.keys(parsed.arguments.sourcePages).map(Number).sort((a, b) => a - b)
  }

  it('多页顺序编号；移除后重排', () => {
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    wizardSetSourceFiles([png('p1.png'), png('p2.png'), png('p3.png')])
    expect(wizardPagesOfInvocation()).toEqual([1, 2, 3])
    wizardRemoveSourcePage(2)
    expect(wizardPagesOfInvocation()).toEqual([1, 2])
  })
})

describe('草表校验', () => {
  it('空文本/坏 JSON/字段级漂移逐条报错；合法草表通过并预填 targetSupplier', () => {
    wizardSetDraftText('')
    expect(getImportWizardDraftError()).toContain('为空')
    wizardSetDraftText('{not json')
    expect(getImportWizardDraftError()).toContain('JSON 解析失败')
    wizardSetDraftText(JSON.stringify({ ...VALID_DRAFT, supplier: '' }))
    expect(getImportWizardDraftError()).toContain('supplier')
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    expect(getImportWizardDraftError()).toBeNull()
  })

  it('targetSupplier 可改写（落库供应商显式覆盖）', () => {
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    wizardSetTargetSupplier('factoryB')
    const invocation = JSON.parse(wizardMcpInvocationJson()) as { arguments: { targetSupplier: string } }
    expect(invocation.arguments.targetSupplier).toBe('factoryB')
  })

  it('授权桥调用 JSON：stone.import 双模说明+draftJson 全文', () => {
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    const parsed = JSON.parse(wizardMcpInvocationJson()) as { tool: string; arguments: { sourcePages: Record<string, string> } }
    expect(parsed.tool).toBe('stone.import')
    expect(Object.keys(parsed.arguments.sourcePages)).toEqual([])
  })
})

describe('预览摘要（summarizeDraft 纯函数）', () => {
  const draft = CardCatalogDraftSchema.parse(VALID_DRAFT)

  it('统计款式/格数/色系；低置信=置信<0.7 或空名（reason 区分）', () => {
    const summary = summarizeDraft(draft, [1, 2])
    expect(summary.styleCount).toBe(2)
    expect(summary.cellCount).toBe(2)
    expect(summary.families).toEqual(['白色系', '蓝色系'])
    expect(summary.lowConfidence).toHaveLength(1)
    expect(summary.lowConfidence[0]?.row).toBe(52)
    expect(summary.lowConfidence[0]?.reason).toBe('unnamed') // 空名优先于低置信标注
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.7)
  })

  it('多页缺页检出；单页草表 blobRef 回退可用', () => {
    const missing = summarizeDraft(draft, [1])
    expect(missing.missingPages).toEqual([2])
    expect(missing.singlePageFallbackAvailable).toBe(false)

    const single = CardCatalogDraftSchema.parse({
      ...VALID_DRAFT,
      sourceImage: { blobRef: 'a'.repeat(64), pages: [{ page: 1, widthPx: 1000, heightPx: 800 }] },
      styles: [VALID_DRAFT.styles[0]],
    })
    const fallback = summarizeDraft(single, [])
    expect(fallback.missingPages).toEqual([])
    expect(fallback.singlePageFallbackAvailable).toBe(true)
  })
})

describe('报告四清单派生（S2.5）', () => {
  it('created/skipped/failed/pendingDowngrades 按格分组；低置信清单全量保留', () => {
    const parsed = wizardSetReport(REPORT_FIXTURE)
    expect(parsed.ok).toBe(true)
    const report = getImportWizardReport()
    expect(report).not.toBeNull()
    const lists = reportListsOf(report!)
    expect(lists.created.map((item) => item.sku)).toEqual(['J51', 'A52'])
    expect(lists.skipped[0]?.sku).toBe('A51')
    expect(lists.failed[0]?.reason).toContain('gate')
    expect(lists.pendingDowngrades[0]?.sku).toBe('C52')
    expect(lists.pendingDowngrades[0]?.reason).toContain('同字节')
  })
})
