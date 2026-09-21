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
 *   呈现归状态条徽标/EditStatusBar 派生消费）。missing-asset 面经注入解析（默认实例已接
 *   assetStore.gemshapeRefResolver 批量真源——[R5-P1]；custom 无 assetId 由 engine 门
 *   无条件 typed invalid，不依赖注入；解析运行时不可用 = typed blocked，不静默导出）。
 * - exportPng 走离屏渲染器（[走查3 P1-1] 默认实例接线 lib/designer/pngRender——画布侧渲染
 *   资产复用：gemSprites 帧/gemVisual 回退/underlay 三源同口径）；注入面 renderPng 缺席时
 *   返回 typed unavailable（测试注入面语义保留——不造假产物）；gate 阻断先于 renderer 判定
 *   （违规文档不进渲染）。
 * - [R1-P0-2 / redesign 4.3 开窗] 可见层投影 projectVisibleGems(doc)（design §4.4）：
 *   SVG/BOM/PNG 导出与 preflight gate 的**唯一钻集来源**（service 内部投影，非 UI 过滤
 *   ——直接调用 export API 不能绕过裁剪）；锁定≠隐藏不参与过滤（锁定只约束编辑面）。
 *   engine exportGate 零改动（契约本就是调用方 concat 后的钻集，分叉在调用方投影）。
 *   既有导出产物语义与守卫编排不动。
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
import { AssetStoreError, gemshapeRefResolver } from '$lib/persistence/assetStore'
import { ProjectConflictError } from '$lib/persistence/projectTypes'
import { ProjectFileError } from '$lib/persistence/projectFile'
import { renderEditDocumentPng } from '$lib/designer/pngRender'
import {
  buildGemdocExport,
  getEditDoc,
  isEditDirty,
  loadFromGemdoc,
  saveGemdoc,
  saveGemdocAs,
  type DesignerGem,
  type EditDocument,
  type GemdocExport,
  type SaveGemdocResult,
} from '$lib/stores/edit.svelte'

// ---------------------------------------------------------------------------
// 可见层投影（R1-P0-2 / redesign-designer-workbench 4.3 开窗——design §4.4）
// ---------------------------------------------------------------------------

/**
 * 可见层投影（design §4.4 隐藏层导出口径）：按 doc.layers 的 visible 过滤 gems 的纯函数
 * ——SVG/BOM/PNG 导出与 preflight gate 的**唯一钻集来源**（设计师工作台：隐藏层不导出，
 * 与排钻「隐藏仍导出」分叉在调用方实现，engine 无 visibility 维度）。
 * - **锁定 ≠ 隐藏**：锁定层不参与过滤（可见即导出——锁定只约束编辑面，§4.3）。
 * - layerId 未命中任何层记录的钻不导出（v3 序列化归属闭合校验保证内存面不出现；
 *   此处防御性收敛——无层可见性可依的归属不产出）。
 * - 纯函数（无 store/IO）——UI 确认文案与状态栏「含 N 隐藏」经 countHiddenGems 同源消费。
 */
export function projectVisibleGems(doc: EditDocument): DesignerGem[] {
  const visibleLayerIds = new Set(doc.layers.filter((layer) => layer.visible).map((layer) => layer.id))
  if (visibleLayerIds.size === 0) return []
  return doc.gems.filter((gem) => visibleLayerIds.has(gem.layerId))
}

/**
 * 隐藏层钻计数（design §4.4 口径数据源）：状态栏「含 N 隐藏」与导出确认
 * 「不含 N 颗隐藏钻」共此单源——仅层 visible 过滤（锁定不参与），与投影互补。
 */
export function countHiddenGems(doc: EditDocument): number {
  return doc.gems.length - projectVisibleGems(doc).length
}

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
  /** [D-5.2] exportGate 违规 → 硬阻断（message = 人读摘要，违规明细 violations 交 UI 呈现；不产半成品 blob） */
  | { status: 'blocked'; message: string; violations: ExportViolation[] }
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
  /**
   * PNG 离屏渲染（[走查3 P1-1] 默认实例接线 lib/designer/pngRender——canvas 侧渲染资产
   * 复用；注入面缺席时 exportPng 返回 typed unavailable，测试注入替身用）。
   */
  renderPng?(doc: EditDocument): Promise<Blob>
  /**
   * [D-5.2] custom 钻形资产解析面（exportGate missing-asset 判据注入；可选，已预收集的
   * 同步面——测试注入用）。默认实例经 collectShapeAssets 批量解析后折入本面。
   */
  resolveShapeAsset?(assetId: string): ShapeAssetRefState
  /**
   * [R5-P1 统一契约] custom 资产**批量**解析面（默认实例注入 assetStore.gemshapeRefResolver
   * ——沿 lab 4.2 真源先例；engine 门是同步纯函数，IDB 异步解析在此预收集为快照 resolver）。
   * 导出路径对文档内 custom 资产逐个解析：missing 四态 → gate 阻断；解析运行时不可用 →
   * typed blocked（不静默导出）。custom 无 assetId 的 typed invalid 由 engine 门无条件阻断
   * （不依赖本面）。
   */
  collectShapeAssets?(assetIds: Iterable<string>): Promise<(assetId: string) => ShapeAssetRefState | null>
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
  /** PNG 导出编排（gate 先于 renderer；默认实例走离屏渲染器——注入缺席才 typed unavailable）。 */
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
      const gate = await preflightGate(deps)
      if (gate !== null) return gate
      const doc = store.getEditDoc()!
      // [R1-P0-2] 可见层投影：隐藏层钻不进产物（service 内部投影——直接调 API 不可绕过）
      const result: LayoutResult = { gems: projectVisibleGems(doc).map(fromEditGem), warnings: [] }
      const blob = exportSvg(result, doc.grid, {
        width: doc.width,
        height: doc.height,
        palette: doc.palette,
      })
      return { status: 'exported' as const, blob, filename: `${doc.name}.svg` }
    },

    async exportBom() {
      const gate = await preflightGate(deps)
      if (gate !== null) return gate
      const doc = store.getEditDoc()!
      // [R1-P0-2] 可见层投影：BOM 行序不随层序（按规格×颜色聚合），钻集随可见层裁剪
      const result: LayoutResult = { gems: projectVisibleGems(doc).map(fromEditGem), warnings: [] }
      const blob = exportBom(result, doc.palette, doc.grid)
      return { status: 'exported' as const, blob, filename: `${doc.name}.csv` }
    },

    async exportPng() {
      const gate = await preflightGate(deps)
      if (gate !== null) return gate // gate 阻断先于 renderer 判定（违规文档不进渲染）
      const doc = store.getEditDoc()!
      if (deps.renderPng === undefined) {
        return {
          status: 'failed',
          reason: 'png-renderer-unavailable',
          message: 'PNG 渲染器不可用，导出未完成。',
        }
      }
      // [R1-P0-2] 投影在 service 面：renderer 收到的 doc.gems 即可见集（浅拷贝投影态，
      // 原文档真源不动）——renderer 自行再过滤 = 第二投影面，禁止
      const blob = await deps.renderPng({ ...doc, gems: projectVisibleGems(doc) })
      return { status: 'exported' as const, blob, filename: `${doc.name}.png` }
    },
  }
}

/**
 * [D-5.2] 导出前置门（engine exportGate 编排）：**可见钻集**（projectVisibleGems 投影后
 * ——R1-P0-2：投影不豁免校验，隐藏层钻不进 gate）× grid × blocks 送门；违规 → typed
 * blocked 信号。无文档 → no-document failed。
 * [R5-P1] custom 资产解析：同步注入面优先；否则默认批量面（collectShapeAssets）对**可见**
 * custom 资产预收集——解析运行时不可用 → typed blocked（不静默导出）；可见集无 custom 资产
 * 时不触批量面（零 IDB 往返）。custom 无 assetId 的 typed invalid 由 engine 门无条件阻断。
 */
async function preflightGate(
  deps: DocumentServiceDeps,
): Promise<
  | { status: 'blocked'; message: string; violations: ExportViolation[] }
  | ({ status: 'failed' } & FailureShape)
  | null
> {
  const doc = deps.store.getEditDoc()
  if (doc === null) {
    return {
      status: 'failed',
      reason: 'no-document',
      message: '编辑文档未载入，无法导出。',
    }
  }
  const visibleGems = projectVisibleGems(doc) // 唯一钻集来源（design §4.4——锁定不过滤）
  let resolveShapeAsset = deps.resolveShapeAsset
  if (resolveShapeAsset === undefined && deps.collectShapeAssets !== undefined) {
    const customAssetIds = [...new Set(visibleGems.flatMap((g) => (g.assetId !== undefined ? [g.assetId] : [])))]
    if (customAssetIds.length > 0) {
      try {
        resolveShapeAsset = await deps.collectShapeAssets(customAssetIds)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          status: 'blocked',
          message: `导出已阻断：钻形资产解析运行时不可用（${message}）——不静默导出，请稍后重试或检查素材库。`,
          violations: [],
        }
      }
    }
  }
  const verdict = exportGate(visibleGems, {
    grid: doc.grid,
    blocks: doc.blocks,
    ...(resolveShapeAsset !== undefined ? { resolveShapeAsset } : {}),
  })
  if (!verdict.ok) {
    const kinds = verdict.violations.map((v) => v.kind)
    const uniqueKinds = [...new Set(kinds)].join('、')
    return {
      status: 'blocked',
      message: `导出已阻断：${verdict.violations.length} 项违规（${uniqueKinds}）——${verdict.violations[0].detail}`,
      violations: verdict.violations,
    }
  }
  return null
}

/**
 * 默认实例：真源直连（edit store 公共面；[走查3 P1-1] exportPng 接线 lib/designer/pngRender
 * 离屏渲染器——画布侧渲染资产复用，投影仍在 service 面：renderer 收到的 doc.gems 即可见集）。
 * [R5-P1] custom 资产批量解析注入 assetStore.gemshapeRefResolver（素材库 .gemshape 真源，
 * 沿 lab 4.2 先例）：custom 缺资产/missing 四态 → gate 阻断；运行时不可用 → typed blocked。
 */
export const editDocumentService: EditDocumentService = createDocumentService({
  store: {
    getEditDoc,
    isEditDirty,
    loadFromGemdoc,
    saveGemdoc,
    saveGemdocAs,
    buildGemdocExport,
  },
  collectShapeAssets: gemshapeRefResolver,
  renderPng: renderEditDocumentPng,
})
