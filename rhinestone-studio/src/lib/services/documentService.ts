/**
 * 文档 service：打开/保存/导出编排壳（rename-and-expert-workbench S-4.2；design §4.3）。
 *
 * 定位与纪律：
 * - service = 无 UI 依赖的用例编排层（可注入依赖 + 结果对象可测）；**状态真源恒在
 *   edit store**——本模块不复制状态、不新增第二真源（PRODUCT_MODEL 硬规则 2）。
 * - **payload 零复制声明（R3 非阻塞建议 2 落档）**：handoff/document payload
 *   （ManualEditHandoff / EditDocument 的构造与解析、gemdoc serialize-parse）的真源恒在
 *   edit store 与 replay gate owner——本模块只做编排调用（loadFromGemdoc / saveGemdoc /
 *   buildGemdocExport 等既有公共 API），不 import parseGemdoc/serializeGemdoc/
 *   buildManualEditHandoff，不形成隐性第二实现。
 * - 守卫确认（dirty 三按钮）归 UI：openFromLibrary 在 dirty 且未 force 时返回
 *   `guard-required` 信号，不弹窗；UI 守卫通过后以 force 直达。
 * - 失败注入可测：CAS conflict / parse 失败 / lease 过期等经 classifyError 映射为
 *   typed reason 的结果对象（不吞 store 抛出的 typed error 细节）。
 * - [D-5.2 pairwise 消费] exportSvg/exportBom/exportPng 前接 engine exportGate
 *   （专家稿 §I.3-2 放行条件原文义务）：违规 → `{ status:'blocked', violations }` typed
 *   阻断信号（UI 呈现违规明细，不弹窗）；**保存/另存为不设门**（文档可存——warning 降级
 *   呈现归状态条徽标/EditStatusBar 派生消费）。missing-asset 面经可选 resolveShapeAsset
 *   注入（运行时资产解析接线归 2.x vertical slice；缺席 = 该面跳过，engine gate 语义）。
 * - exportPng 需四层合成栅格化 renderer——注入缺席时返回 typed unavailable
 *   （接线归后续切片，不造假产物）；gate 阻断先于 renderer 判定（违规文档不进渲染）。
 */

import {
  exportBom,
  exportGate,
  exportSvg,
  fromEditGem,
  type ExportViolation,
  type LayoutResult,
  type ShapeAssetRefState,
} from '$lib/engine'
import { AssetStoreError } from '$lib/persistence/assetStore'
import { ProjectConflictError } from '$lib/persistence/projectTypes'
import { ProjectFileError } from '$lib/persistence/projectFile'
import {
  buildGemdocExport,
  getEditDoc,
  isEditDirty,
  loadFromGemdoc,
  saveGemdoc,
  saveGemdocAs,
  type EditDocument,
  type GemdocExport,
  type SaveGemdocResult,
} from '$lib/stores/edit.svelte'

// ---------------------------------------------------------------------------
// 结果类型（typed reason——失败注入测试与 UI 分流提示的共用面）
// ---------------------------------------------------------------------------

export type DocumentFailureReason =
  | 'no-document'
  | 'missing'
  | 'trashed'
  | 'blob-missing'
  | 'wrong-kind'
  | 'cas-conflict'
  | 'parse'
  | 'lease'
  | 'png-renderer-unavailable'
  | 'unknown'

interface FailureShape {
  reason: DocumentFailureReason
  message: string
}

export type DocumentOpenResult =
  | { status: 'opened' }
  /** 当前文档未保存——守卫信号（UI 决策：保存/丢弃/取消；通过后以 force 重入） */
  | { status: 'guard-required' }
  | ({ status: 'failed' } & FailureShape)

export type DocumentSaveResult =
  | { status: 'saved'; kind: SaveGemdocResult['status']; docId: string; name: string }
  | ({ status: 'failed' } & FailureShape)

export type DocumentExportResult =
  | { status: 'exported'; blob: Blob; filename: string }
  /** [D-5.2] exportGate 违规 → 硬阻断（违规明细交 UI 呈现；不产半成品 blob） */
  | { status: 'blocked'; violations: ExportViolation[] }
  | ({ status: 'failed' } & FailureShape)

// ---------------------------------------------------------------------------
// 依赖注入面（edit store 状态面 + 可选 PNG renderer / busy 回调）
// ---------------------------------------------------------------------------

/** edit store 公共面子集（真实现 = store 直连函数；测试注入 fake 做失败注入）。 */
export interface EditStoreSurface {
  getEditDoc(): EditDocument | null
  isEditDirty(): boolean
  loadFromGemdoc(assetId: string): Promise<void>
  saveGemdoc(options?: { name?: string }): Promise<SaveGemdocResult>
  saveGemdocAs(name: string): Promise<SaveGemdocResult>
  buildGemdocExport(): Promise<GemdocExport>
}

export interface DocumentServiceDeps {
  store: EditStoreSurface
  /** 四层合成 PNG 栅格化（接线归后续切片；缺席时 exportPng 返回 typed unavailable）。 */
  renderPng?(doc: EditDocument): Promise<Blob>
  /**
   * [D-5.2] custom 钻形资产解析面（exportGate missing-asset 判据注入；可选）。
   * 运行时真源接线（assetStore .gemshape 四态）归 2.x vertical slice；缺席 = 该面跳过
   * （engine gate 语义：不视为合规以外的任何断言）。
   */
  resolveShapeAsset?(assetId: string): ShapeAssetRefState
  /** busy 态回调（UI 挂 spinner/disabled；service 不持有 UI 状态）。 */
  onBusy?(busy: boolean): void
}

export interface EditDocumentService {
  /** 打开精修项目：dirty 且未 force → 守卫信号（不弹窗）。 */
  openFromLibrary(assetId: string, opts?: { force?: boolean }): Promise<DocumentOpenResult>
  /** 保存：serialize → 首次 ingest / CAS 换绑 → dirty 清零（失败 dirty 保持——store 语义）。 */
  save(opts?: { name?: string }): Promise<DocumentSaveResult>
  /** 另存为（fork）：恒 ingest 新节点并接管 docId。 */
  saveAs(name: string): Promise<DocumentSaveResult>
  /** 导出 .gemdoc 装配：只序列化不落库（不清 dirty、不建库节点——契约沿用）。 */
  exportGemdoc(): Promise<DocumentExportResult>
  /** SVG 导出编排（[D-5.2] exportGate 前接——违规 → blocked typed 信号）。 */
  exportSvg(): Promise<DocumentExportResult>
  /** BOM 导出编排（同上）。 */
  exportBom(): Promise<DocumentExportResult>
  /** PNG 导出编排（gate 先于 renderer；renderer 未接线 → typed unavailable，不造假产物）。 */
  exportPng(): Promise<DocumentExportResult>
}

// ---------------------------------------------------------------------------
// 失败分类（store/persistence typed error → service reason）
// ---------------------------------------------------------------------------

function classifyError(error: unknown): FailureShape {
  const message = error instanceof Error ? error.message : String(error)
  // edit store 的 EditGemdocError 自带 reason（no-document/missing/trashed/blob-missing/wrong-kind）
  if (error instanceof Error && 'reason' in error && typeof (error as { reason: unknown }).reason === 'string') {
    return { reason: (error as { reason: DocumentFailureReason }).reason, message }
  }
  if (error instanceof ProjectConflictError) return { reason: 'cas-conflict', message }
  if (error instanceof ProjectFileError) return { reason: 'parse', message }
  if (error instanceof AssetStoreError && /lease|租约|pin/i.test(message)) {
    return { reason: 'lease', message }
  }
  return { reason: 'unknown', message }
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export function createDocumentService(deps: DocumentServiceDeps): EditDocumentService {
  const { store } = deps
  const withBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
    deps.onBusy?.(true)
    try {
      return await fn()
    } finally {
      deps.onBusy?.(false)
    }
  }

  return {
    async openFromLibrary(assetId, opts) {
      if (store.isEditDirty() && opts?.force !== true) return { status: 'guard-required' }
      try {
        return await withBusy(async () => {
          await store.loadFromGemdoc(assetId)
          return { status: 'opened' } as const
        })
      } catch (error) {
        return { status: 'failed', ...classifyError(error) }
      }
    },

    async save(opts) {
      if (store.getEditDoc() === null) {
        return { status: 'failed', reason: 'no-document', message: '编辑文档未载入，无法保存。' }
      }
      try {
        return await withBusy(async () => {
          const result = await store.saveGemdoc(opts)
          return { status: 'saved' as const, kind: result.status, docId: result.docId, name: result.name }
        })
      } catch (error) {
        return { status: 'failed', ...classifyError(error) }
      }
    },

    async saveAs(name) {
      if (store.getEditDoc() === null) {
        return { status: 'failed', reason: 'no-document', message: '编辑文档未载入，无法另存为。' }
      }
      try {
        return await withBusy(async () => {
          const result = await store.saveGemdocAs(name)
          return { status: 'saved' as const, kind: result.status, docId: result.docId, name: result.name }
        })
      } catch (error) {
        return { status: 'failed', ...classifyError(error) }
      }
    },

    async exportGemdoc() {
      try {
        const { blob, filename } = await store.buildGemdocExport()
        return { status: 'exported' as const, blob, filename }
      } catch (error) {
        return { status: 'failed', ...classifyError(error) }
      }
    },

    async exportSvg() {
      const gate = preflightGate(deps)
      if (gate !== null) return gate
      const doc = store.getEditDoc()!
      const result: LayoutResult = { gems: doc.gems.map(fromEditGem), warnings: [] }
      const blob = exportSvg(result, doc.grid, {
        width: doc.width,
        height: doc.height,
        palette: doc.palette,
      })
      return { status: 'exported', blob, filename: `${doc.name}.svg` }
    },

    async exportBom() {
      const gate = preflightGate(deps)
      if (gate !== null) return gate
      const doc = store.getEditDoc()!
      const result: LayoutResult = { gems: doc.gems.map(fromEditGem), warnings: [] }
      const blob = exportBom(result, doc.palette, doc.grid)
      return { status: 'exported', blob, filename: `${doc.name}.csv` }
    },

    async exportPng() {
      const gate = preflightGate(deps)
      if (gate !== null) return gate // gate 阻断先于 renderer 判定（违规文档不进渲染）
      const doc = store.getEditDoc()!
      if (deps.renderPng === undefined) {
        return {
          status: 'failed',
          reason: 'png-renderer-unavailable',
          message: 'PNG 渲染器未接线（四层合成栅格化归后续切片）。',
        }
      }
      const blob = await deps.renderPng(doc)
      return { status: 'exported', blob, filename: `${doc.name}.png` }
    },
  }
}

/**
 * [D-5.2] 导出前置门（engine exportGate 编排）：全量钻集（当前单层 concat 面）× grid ×
 * blocks 送门；违规 → typed blocked 信号。无文档 → no-document failed。
 */
function preflightGate(
  deps: DocumentServiceDeps,
): { status: 'blocked'; violations: ExportViolation[] } | ({ status: 'failed' } & FailureShape) | null {
  const doc = deps.store.getEditDoc()
  if (doc === null) {
    return {
      status: 'failed',
      reason: 'no-document',
      message: '编辑文档未载入，无法导出。',
    }
  }
  const verdict = exportGate(doc.gems, {
    grid: doc.grid,
    blocks: doc.blocks,
    ...(deps.resolveShapeAsset !== undefined ? { resolveShapeAsset: deps.resolveShapeAsset } : {}),
  })
  if (!verdict.ok) return { status: 'blocked', violations: verdict.violations }
  return null
}

/** 默认实例：真源直连（edit store 公共面；无 PNG renderer——exportPng typed unavailable）。 */
export const editDocumentService: EditDocumentService = createDocumentService({
  store: {
    getEditDoc,
    isEditDirty,
    loadFromGemdoc,
    saveGemdoc,
    saveGemdocAs,
    buildGemdocExport,
  },
})
