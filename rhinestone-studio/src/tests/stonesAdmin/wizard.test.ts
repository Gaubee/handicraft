/*
 * 导入向导状态机单测（add-stone-library S3.3——design §8；S3.3 占位升级后）：
 * 步进守卫（draft 未过校验不可前进/execute 为执行步）、源图页管理、草表校验
 * （好/坏 JSON、字段级 issue）、预览摘要（低置信/缺页/单页回退）、执行面
 * （executor 注入+执行锁+错误呈现+报告校验回填）与报告四清单派生。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CardCatalogDraftSchema, type CardCatalogDraft } from '@handicraft/contracts'
import {
  LOW_CONFIDENCE_THRESHOLD,
  bindWizardImportExecutor,
  getImportWizardDraftError,
  getImportWizardExecuteError,
  getImportWizardReport,
  getImportWizardStep,
  isImportWizardExecuting,
  reportListsOf,
  resetImportWizardForTests,
  summarizeDraft,
  wizardCanAdvance,
  wizardExecuteImport,
  wizardGoBack,
  wizardGoNext,
  wizardRemoveSourcePage,
  wizardSetDraftText,
  wizardSetReport,
  wizardSetSourceFiles,
  wizardSetTargetSupplier,
  type WizardImportRequest,
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
  it('sources→draft 自由前进；draft 未过校验不可前进；过验后到 preview；execute 由执行按钮推进（无下一步）', () => {
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
    expect(getImportWizardStep()).toBe('execute')
    expect(wizardCanAdvance()).toBe(false) // 执行步无「下一步」——报告由执行产物切换
    wizardGoNext()
    expect(getImportWizardStep()).toBe('execute')
  })

  it('back 链路：execute→preview→draft→sources', () => {
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

  it('报告注入（执行产物缝）：合法报告切到 report 步；坏形状显式拒绝不切步', () => {
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

describe('执行面（executor 注入——S3.3 占位升级）', () => {
  function gotoExecute(): void {
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    wizardGoNext()
    wizardGoNext()
    wizardGoNext()
    expect(getImportWizardStep()).toBe('execute')
  }

  it('执行成功：请求携带 draft/targetSupplier/页映射 → 报告校验回填切 report 步', async () => {
    const requests: WizardImportRequest[] = []
    bindWizardImportExecutor(async (request) => {
      requests.push(request)
      return REPORT_FIXTURE
    })
    wizardSetSourceFiles([png('p1.png'), png('p2.png')])
    gotoExecute()
    await wizardExecuteImport()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.targetSupplier).toBe('yuhang') // 缺省取草表
    expect(requests[0]!.pages.map((page) => page.page)).toEqual([1, 2])
    expect(requests[0]!.draft.styles).toHaveLength(2)
    expect(getImportWizardStep()).toBe('report')
    expect(getImportWizardExecuteError()).toBeNull()
    expect(getImportWizardReport()?.summary.created).toBe(2)
  })

  it('targetSupplier 覆写透传执行请求', async () => {
    const requests: WizardImportRequest[] = []
    bindWizardImportExecutor(async (request) => {
      requests.push(request)
      return REPORT_FIXTURE
    })
    gotoExecute()
    wizardSetTargetSupplier('factoryB')
    await wizardExecuteImport()
    expect(requests[0]!.targetSupplier).toBe('factoryB')
  })

  it('执行失败：错误显式呈现、步不切；响应不符报告契约同样拒绝', async () => {
    bindWizardImportExecutor(async () => {
      throw new Error('daemon 不可达')
    })
    gotoExecute()
    await wizardExecuteImport()
    expect(getImportWizardStep()).toBe('execute')
    expect(getImportWizardExecuteError()).toContain('daemon 不可达')

    bindWizardImportExecutor(async () => ({ created: [] })) // 非报告形状
    await wizardExecuteImport()
    expect(getImportWizardStep()).toBe('execute')
    expect(getImportWizardExecuteError()).toContain('不符报告契约')
  })

  it('未绑定执行器：显式错误（不静默）', async () => {
    gotoExecute()
    await wizardExecuteImport()
    expect(getImportWizardStep()).toBe('execute')
    expect(getImportWizardExecuteError()).toContain('执行器')
  })

  it('执行锁：executing 期间重复调用不重入', async () => {
    let release: (() => void) | null = null
    let calls = 0
    bindWizardImportExecutor(async () => {
      calls += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return REPORT_FIXTURE
    })
    gotoExecute()
    const first = wizardExecuteImport()
    expect(isImportWizardExecuting()).toBe(true)
    await wizardExecuteImport() // 执行中重入：直接返回
    release!()
    await first
    expect(calls).toBe(1)
    expect(getImportWizardStep()).toBe('report')
  })
})

describe('源图页管理', () => {
  /** 页号即键——经执行请求反查（避免额外导出面）。 */
  async function wizardPagesOfRequest(): Promise<number[]> {
    let seen: WizardImportRequest | null = null
    bindWizardImportExecutor(async (request) => {
      seen = request
      return REPORT_FIXTURE
    })
    wizardSetDraftText(JSON.stringify(VALID_DRAFT))
    wizardGoNext()
    wizardGoNext()
    wizardGoNext()
    await wizardExecuteImport()
    return (seen as WizardImportRequest | null)?.pages.map((page) => page.page).sort((a, b) => a - b) ?? []
  }

  it('多页顺序编号；移除后重排', async () => {
    wizardSetSourceFiles([png('p1.png'), png('p2.png'), png('p3.png')])
    expect(await wizardPagesOfRequest()).toEqual([1, 2, 3])
    resetImportWizardForTests()
    wizardSetSourceFiles([png('p1.png'), png('p2.png'), png('p3.png')])
    wizardRemoveSourcePage(2)
    expect(await wizardPagesOfRequest()).toEqual([1, 2])
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
