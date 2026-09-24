/**
 * 钻表选择器测试底座（add-stone-library S5.3）：Mock 数据源（复刻 daemon
 * stones/query.ts 的 list 过滤/groupBy 键格式/分页语义——键格式 'row-51'/'未编行'/
 * '未声明' 与真源同构）+ fixture 单元格族（钰航样卡形态：色系→款式行→尺寸变体）。
 * 查询全记录（calls）供协议断言（q/nearColor/activeSetId 透传）。
 * fixture 约定：styleName==='' 即视为 style_row NULL（未编行项——模拟魔方钻色卡）。
 */
import type { StoneGridCell } from '@handicraft/contracts'
import { sortCellsByNearColor, type StoneGetOutcome, type StoneListQuery, type StoneListResult, type StonePickerSource } from '$lib/stonePicker/source.js'

export interface CellSpec {
  resourceId: string
  sku: string
  supplier?: string
  styleName?: string
  family: string
  sizeMm?: number | null
  colorHex: string
  trashed?: boolean
}

export function makeCell(spec: CellSpec): StoneGridCell {
  const supplier = spec.supplier ?? 'yuhang'
  const styleName = spec.styleName ?? ''
  const sizeMm = spec.sizeMm === undefined ? 2 : spec.sizeMm
  return {
    resourceId: spec.resourceId,
    sku: spec.sku,
    supplier,
    name: sizeMm !== null ? `${styleName || spec.sku} · ${sizeMm}mm` : (styleName || spec.sku),
    styleName,
    family: spec.family,
    sizeMm,
    colorHex: spec.colorHex,
    finish: 'glossy',
    textureUrl: `/api/stones/${spec.resourceId}/texture.png`,
    trashed: spec.trashed ?? false,
    updatedAt: '2026-09-24T00:00:00.000Z',
  }
}

/** 钰航样卡形态 fixture：白色系两款式行（51/52）+ 红色系一款式行（60）+ 未声明/未编行项。 */
export function fixtureCells(): StoneGridCell[] {
  return [
    makeCell({ resourceId: 'stn-j51', sku: 'J51', styleName: '象牙白', family: '白色系', sizeMm: 2, colorHex: '#FFFFF0' }),
    makeCell({ resourceId: 'stn-a51', sku: 'A51', styleName: '象牙白', family: '白色系', sizeMm: 3, colorHex: '#FFFFF0' }),
    makeCell({ resourceId: 'stn-b51', sku: 'B51', styleName: '象牙白', family: '白色系', sizeMm: 4, colorHex: '#FFFFF0' }),
    makeCell({ resourceId: 'stn-j52', sku: 'J52', styleName: '珍珠白', family: '白色系', sizeMm: 2, colorHex: '#FDEFF5' }),
    makeCell({ resourceId: 'stn-j60', sku: 'J60', styleName: '正红', family: '红色系', sizeMm: 2, colorHex: '#E02020' }),
    makeCell({ resourceId: 'stn-a60', sku: 'A60', styleName: '正红', family: '红色系', sizeMm: 3, colorHex: '#E02020' }),
    // 未声明尺寸 + 未编行（§8.1 规则 7 显式态——魔方钻色卡形态）
    makeCell({ resourceId: 'stn-m01', sku: 'M01', styleName: '', family: '白色系', sizeMm: null, colorHex: '#FAFAFA' }),
  ]
}

/** fixture 行号口径：sku 数字段=行号（钰航 styleKey='row' 同式）；未编行项=null。 */
function rowOfCell(cell: StoneGridCell): number | null {
  if (cell.styleName === '') return null
  const match = /^([A-Za-z]+)([0-9]+)$/.exec(cell.sku)
  return match === null ? null : Number.parseInt(match[2] as string, 10)
}

export class MockStonePickerSource implements StonePickerSource {
  readonly calls: StoneListQuery[] = []
  private cells: StoneGridCell[]
  private readonly gets: Record<string, StoneGetOutcome | Error>
  private failMessage: string | null = null

  constructor(options: { cells?: StoneGridCell[]; gets?: Record<string, StoneGetOutcome | Error> } = {}) {
    this.cells = options.cells ?? fixtureCells()
    this.gets = options.gets ?? {}
  }

  setCells(cells: StoneGridCell[]): void {
    this.cells = cells
  }

  /** 下一次 list 抛错（错误态/重试用例——一次性）。 */
  failNextList(message = '模拟查询失败'): void {
    this.failMessage = message
  }

  async list(query: StoneListQuery): Promise<StoneListResult> {
    this.calls.push({ ...query })
    if (this.failMessage !== null) {
      const message = this.failMessage
      this.failMessage = null
      throw new Error(message)
    }
    let cells = this.cells.filter((cell) => !cell.trashed)
    if (query.supplier !== undefined) cells = cells.filter((c) => c.supplier === query.supplier)
    if (query.family !== undefined) cells = cells.filter((c) => c.family === query.family)
    if (query.sizeMm !== undefined) cells = cells.filter((c) => c.sizeMm === query.sizeMm)
    if (query.styleRow !== undefined) cells = cells.filter((c) => rowOfCell(c) === query.styleRow)
    if (query.sku !== undefined) cells = cells.filter((c) => c.sku === query.sku)
    if (query.q !== undefined) {
      const needle = query.q.toLowerCase()
      cells = cells.filter((c) =>
        [c.sku, c.supplier, c.family, c.styleName, c.colorHex].some((field) => field.toLowerCase().includes(needle)),
      )
    }
    cells = [...cells].sort((a, b) =>
      a.supplier === b.supplier ? a.sku.localeCompare(b.sku) : a.supplier.localeCompare(b.supplier),
    )
    if (query.nearColor !== undefined) {
      // 协议语义：全过滤集 ΔE 升序（模拟服务端 nearColor 排序到位——store/组件不感知实现侧）。
      cells = sortCellsByNearColor(cells, query.nearColor)
    }
    const total = cells.length
    const start = (query.page - 1) * query.pageSize
    const result: StoneListResult = {
      cells: cells.slice(start, start + query.pageSize),
      total,
      page: query.page,
      pageSize: query.pageSize,
    }
    if (query.groupBy !== undefined) result.groupKeys = groupKeysOf(cells, query.groupBy)
    return result
  }

  async get(resourceId: string): Promise<StoneGetOutcome> {
    const entry = this.gets[resourceId]
    if (entry === undefined) return { resourceId, state: 'resolved' }
    if (entry instanceof Error) throw entry
    return entry
  }

  resolveTextureUrl(textureUrl: string): string {
    return `/mock-daemon${textureUrl}`
  }
}

function groupKeysOf(cells: StoneGridCell[], groupBy: 'family' | 'sizeMm' | 'style'): string[] {
  if (groupBy === 'family') return [...new Set(cells.map((c) => c.family))].sort()
  if (groupBy === 'sizeMm') {
    return [...new Set(cells.map((c) => (c.sizeMm !== null ? String(c.sizeMm) : '未声明')))].sort((a, b) => {
      if (a === '未声明') return 1
      if (b === '未声明') return -1
      return Number(a) - Number(b)
    })
  }
  return [...new Set(cells.map((c) => {
    const row = rowOfCell(c)
    return row === null ? '未编行' : `row-${row}`
  }))].sort((a, b) => {
    if (a === '未编行') return 1
    if (b === '未编行') return -1
    return Number(a.slice(4)) - Number(b.slice(4))
  })
}
