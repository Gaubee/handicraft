/*
 * 装饰钻库管理视图测试夹具（add-stone-library S3.3）。
 * fixture client 实现 StonesAdminClient 接口（内存数据+调用记录）——组件/store
 * 测试注入用，不 ship 到 lib（生产走 RpcStonesClient）。
 */

import type { StoneGridCell, StoneFile } from '@handicraft/contracts'
import type { StonesAdminClient } from '$lib/stonesAdmin/client'
import type {
  StoneDetail,
  StonesImportRunInput,
  StonesImportRunOutput,
  StonesListInput,
  StonesListOutput,
  StonesTreeOutput,
} from '$lib/stonesAdmin/schemas'

export function makeCell(overrides: Partial<StoneGridCell> = {}): StoneGridCell {
  return {
    resourceId: 'res-j51',
    sku: 'J51',
    supplier: 'yuhang',
    name: '象牙白 · 2mm',
    styleName: '象牙白',
    family: '白色系',
    sizeMm: 2,
    colorHex: '#FFFFF0',
    finish: 'glossy',
    textureUrl: '/api/stones/res-j51/texture.png',
    trashed: false,
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  }
}

export function makeStoneFile(overrides: Partial<StoneFile> = {}): StoneFile {
  return {
    kind: 'stone',
    formatVersion: 1,
    id: 'stn-j51',
    name: '象牙白 · 2mm',
    supplier: 'yuhang',
    sku: 'J51',
    skuParsed: { row: 51, prefix: 'J', sizeMm: 2 },
    sizeMm: 2,
    color: { name: '象牙白', rgb: [255, 255, 240], family: '白色系', finish: 'glossy' },
    texture: {
      file: '贴图.png',
      mime: 'image/png',
      width: 96,
      height: 96,
      alphaBounds: { x: 8, y: 8, w: 80, h: 80 },
    },
    metadata: { sizeNote: '样卡标注 2mm' },
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  }
}

/** 完整 detail（resolved / soft-deleted 全文态）。 */
export function makeFullDetail(overrides: { resourceId?: string; state?: 'resolved' | 'soft-deleted' } = {}): Extract<StoneDetail, { stone: StoneFile }> {
  const resourceId = overrides.resourceId ?? 'res-j51'
  return {
    resourceId,
    state: overrides.state ?? 'resolved',
    revision: 1,
    path: `/stones/standards/yuhang/白色系/51-象牙白/J51`,
    trashed: (overrides.state ?? 'resolved') === 'soft-deleted',
    stone: makeStoneFile(),
    texture: { blobRef: 'a'.repeat(64), width: 96, height: 96, textureUrl: `/api/stones/${resourceId}/texture.png` },
    readScope: 'shared-library',
  }
}

export function makeBareDetail(state: 'blob-missing' | 'wrong-kind' | 'not-found', resourceId = 'res-x'): StoneDetail {
  return { resourceId, state, readScope: 'shared-library' }
}

/**
 * 树：yuhang（白色系 2 款式行 3 叶 + 蓝色系 1 软删叶——includeTrashed=false 时蓝色系整枝剪除）。
 */
export function makeTree(options: { includeTrashed?: boolean } = {}): StonesTreeOutput {
  const trashedCell = makeCell({ resourceId: 'res-a55', sku: 'A55', name: '湖蓝 · 3mm', family: '蓝色系', styleName: '湖蓝', sizeMm: 3, colorHex: '#1E3CC8', trashed: true, textureUrl: '/api/stones/res-a55/texture.png' })
  return {
    rootId: 'dir-standards',
    readScope: 'shared-library',
    node: {
      kind: 'dir',
      id: 'dir-standards',
      name: 'standards',
      role: 'standards-root',
      childCount: options.includeTrashed === true ? 4 : 3,
      children: [
        {
          kind: 'dir',
          id: 'dir-yuhang',
          name: 'yuhang',
          role: 'supplier',
          childCount: options.includeTrashed === true ? 4 : 3,
          children: [
            {
              kind: 'dir',
              id: 'dir-white',
              name: '白色系',
              childCount: 3,
              children: [
                {
                  kind: 'dir',
                  id: 'dir-row51',
                  name: '51-象牙白',
                  childCount: 2,
                  children: [
                    { kind: 'stone', cell: makeCell({ resourceId: 'res-j51' }) },
                    { kind: 'stone', cell: makeCell({ resourceId: 'res-a51', sku: 'A51', name: '象牙白 · 3mm', sizeMm: 3, textureUrl: '/api/stones/res-a51/texture.png' }) },
                  ],
                },
                {
                  kind: 'dir',
                  id: 'dir-row52',
                  name: '52-米白',
                  childCount: 1,
                  children: [{ kind: 'stone', cell: makeCell({ resourceId: 'res-j52', sku: 'J52', name: '米白 · 2mm', styleName: '米白', textureUrl: '/api/stones/res-j52/texture.png' }) }],
                },
              ],
            },
            ...(options.includeTrashed === true
              ? [
                  {
                    kind: 'dir' as const,
                    id: 'dir-blue',
                    name: '蓝色系',
                    childCount: 1,
                    children: [{ kind: 'stone' as const, cell: trashedCell }],
                  },
                ]
              : []),
          ],
        },
      ],
    },
  }
}

export interface FixtureCalls {
  list: StonesListInput[]
  tree: Array<{ rootId?: string; includeTrashed?: boolean }>
  get: string[]
  trash: string[]
  restore: string[]
  importRun: StonesImportRunInput[]
  uploads: Array<{ filename: string }>
}

export interface FixtureClientOptions {
  cells?: StoneGridCell[]
  pageSizeCap?: number
  details?: Record<string, StoneDetail>
  /** importRun 替身响应（缺省最小合法报告——六字段+report 全文）。 */
  importRunResponse?: StonesImportRunOutput
}

/** 内存 fixture client：list 做真过滤（supplier/family/q/includeTrashed）+分页。 */
export function makeClient(options: FixtureClientOptions = {}): { client: StonesAdminClient; calls: FixtureCalls } {
  const cells = options.cells ?? [
    makeCell({ resourceId: 'res-j51' }),
    makeCell({ resourceId: 'res-a51', sku: 'A51', name: '象牙白 · 3mm', sizeMm: 3, textureUrl: '/api/stones/res-a51/texture.png' }),
    makeCell({ resourceId: 'res-j52', sku: 'J52', name: '米白 · 2mm', styleName: '米白', textureUrl: '/api/stones/res-j52/texture.png' }),
    makeCell({ resourceId: 'res-a55', sku: 'A55', name: '湖蓝 · 3mm', family: '蓝色系', styleName: '湖蓝', sizeMm: 3, colorHex: '#1E3CC8', trashed: true, textureUrl: '/api/stones/res-a55/texture.png' }),
  ]
  const details: Record<string, StoneDetail> = options.details ?? {
    'res-j51': makeFullDetail({ resourceId: 'res-j51' }),
  }
  const calls: FixtureCalls = { list: [], tree: [], get: [], trash: [], restore: [], importRun: [], uploads: [] }
  /** 内存态：软删盖戳集（trash/restore 写动作真变更——恢复/软删交互可断言）。 */
  const trashed = new Set<string>(cells.filter((cell) => cell.trashed).map((cell) => cell.resourceId))
  const importRunResponse: StonesImportRunOutput =
    options.importRunResponse ??
    ({
      created: ['res-j51'],
      skipped: [],
      failed: [],
      pendingDowngrades: [],
      lowConfidence: [],
      reportRef: 'a'.repeat(64),
      report: {
        kind: 'card-import-report',
        formatVersion: 1,
        generatedAt: '2026-09-24T00:00:00.000Z',
        supplier: 'yuhang',
        draftSupplier: 'yuhang',
        options: { targetSupplier: 'yuhang', qualityFlag: null, backgroundTolerance: 16, featherPx: 2 },
        summary: { created: 1, skipped: 0, failed: 0, pending: 0, lowConfidence: 0, rows: 1, needsReviewRows: 0 },
        lowConfidence: [],
        rows: [
          {
            row: 51,
            suggestedName: '象牙白',
            appliedName: '象牙白',
            family: '白色系',
            confidence: 0.9,
            lowConfidence: false,
            needsReview: false,
            cells: [{ sku: 'J51', finalSku: 'J51', page: 1, status: 'created', reason: null }],
          },
        ],
      },
    } as StonesImportRunOutput)
  const client: StonesAdminClient = {
    async tree(input: { rootId?: string; includeTrashed?: boolean } = {}) {
      calls.tree.push(input)
      return makeTree({ includeTrashed: input.includeTrashed ?? false })
    },
    async list(input: StonesListInput): Promise<StonesListOutput> {
      calls.list.push(input)
      let rows = cells
      if (!input.includeTrashed) rows = rows.filter((cell) => !trashed.has(cell.resourceId))
      if (input.supplier !== undefined) rows = rows.filter((cell) => cell.supplier === input.supplier)
      if (input.family !== undefined) rows = rows.filter((cell) => cell.family === input.family)
      if (input.sizeMm !== undefined) rows = rows.filter((cell) => cell.sizeMm === input.sizeMm)
      if (input.sku !== undefined) rows = rows.filter((cell) => cell.sku === input.sku)
      if (input.q !== undefined) {
        const needle = input.q.toLowerCase()
        rows = rows.filter((cell) => `${cell.sku} ${cell.supplier} ${cell.family} ${cell.styleName} ${cell.colorHex}`.toLowerCase().includes(needle))
      }
      const total = rows.length
      const page = rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize)
      const out: StonesListOutput = { cells: page, total, page: input.page, pageSize: input.pageSize, readScope: 'shared-library' }
      if (input.groupBy !== undefined) {
        out.groupKeys = [...new Set(rows.map((cell) => (input.groupBy === 'family' ? cell.family : input.groupBy === 'sizeMm' ? (cell.sizeMm !== null ? `${cell.sizeMm}mm` : '未声明') : cell.styleName || '未命名款式')))]
      }
      return out
    },
    async get(resourceId: string) {
      calls.get.push(resourceId)
      const detail = details[resourceId]
      if (detail === undefined) return makeBareDetail('not-found', resourceId)
      return detail
    },
    async trash(resourceId: string) {
      calls.trash.push(resourceId)
      trashed.add(resourceId)
      return { resourceId, trashedRows: 3, trashedStones: 1, note: '软删=回收站语义' }
    },
    async restore(resourceId: string) {
      calls.restore.push(resourceId)
      trashed.delete(resourceId)
      return { resourceId, restoredRows: 3, restoredStones: 1, note: '恢复=清子树戳+祖先链重算' }
    },
    async importRun(input: StonesImportRunInput): Promise<StonesImportRunOutput> {
      calls.importRun.push(input)
      return importRunResponse
    },
    async uploadAsset(filename: string) {
      calls.uploads.push({ filename })
      return { blobRef: 'b'.repeat(64), filename, size: 3 }
    },
  }
  return { client, calls }
}

/** N 个合成 cell（虚拟滚动大样卡量级测试）。 */
export function makeManyCells(count: number): StoneGridCell[] {
  return Array.from({ length: count }, (_, index) =>
    makeCell({
      resourceId: `res-bulk-${index}`,
      sku: `S${index}`,
      name: `合成 · ${index}`,
      textureUrl: `/api/stones/res-bulk-${index}/texture.png`,
    }),
  )
}
