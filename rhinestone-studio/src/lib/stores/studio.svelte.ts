/*
Orthogonal intents (max 5):
1. [2026-09-18 Ingest / 2026-09-20 A 轨 2.1/2.3 拆分] 数字油画载入域已拆出 → src/lib/studio/imageSource.svelte.ts
     （解码/降采样/素材库选择/上传/测试直灌）；送精修构造域已拆出 → src/lib/studio/editHandoff.svelte.ts
     （payload 红线薄 wrapper——owner = studio-layers replay/handoff gate）；公共面均经本根 re-export 兼容；
     根保留载入落位桥 applyPainting（内部协作面——编排 cancelPending/scheduleSegment/选择复位/结果清零）与计算编排域。
2. [2026-09-20 studio-layers 2.1] 图层/参数域已拆出 → src/lib/studio/layers.svelte.ts（LayerState[] +
     覆写四表随层 + 层物理四件 + palette/segment 参数态 + 观察态宿主）；现状单层全局态经本根兼容面读写
     兜底层（globalDensity/ss/gap/relax/覆写四表 = rest 层投影——行为零变化，oracle 活路径锁定保持）；
     getBlockDensity 回落目标 globalDensity → 所属层 density。
3. [2026-09-19 Offload] 重算全部经 runCompute 卸载（浏览器=module worker，jsdom/SSR=主线程同构 fallback）：分块=单策略空轮、布局=逐策略子轮（渐进落地 + 单策略错误隔离），run 号作废迟到结果。
4. [2026-09-19 Progress] computeProgress 阶段态 {done,total,label}（分块 0/1 → 逐策略 n/6）与用户显式取消 cancelCompute（作废在途轮 + 复位状态）。
5. [2026-09-18 Export/Preview / 2026-09-20 A 轨 2.2 拆分] activeStrategy 导出源、导出门（spacing 违规阻断）、
     BOM 摘要派生（根派生量保留）；导出编排（SVG/BOM 装配 + PNG 入库）已拆出 → lib/studio/exportSink.svelte.ts；
     预览三模式 + 透明度。
*/

import {
  STRATEGY_IDS,
  SS_KEYS,
  SS_TABLE,
  exportBom,
  exportSvg,
  findPaletteColor,
  gridFromSs,
  isExportable,
  PIXELS_PER_MM,
  mapColors,
  pitchPx,
  roundSpecKeyOfSs,
  ssOfRoundSpecKey,
  validate,
  type Block,
  type BlockType,
  type EngineImage,
  type Gem,
  type GridSpec,
  type Palette,
  type PaletteColor,
  type SSKey,
  type StrategyId,
  type Warning,
} from '$lib/engine'
import { runCompute, type ComputeHandle } from '$lib/workers/computeClient'
import { ComputeAbortedError, STRATEGY_LABELS } from '$lib/workers/computeCore'
import { pinAsset, unpinAsset } from '$lib/persistence/assetStore'
import {
  blockDensityOf,
  getLayers,
  getPaletteState,
  getParamState,
  getRestLayer,
  getSegmentOpts,
  initDefaultLayers,
  landBlocks,
  owningLayerOf,
  restSsOf,
  resetLayersForTests,
  getSelectionOrder,
  selectLayer,
  getBackgroundObservation,
  setBackgroundObservation,
} from '$lib/studio/layers.svelte'
import {
  dispatchStudioOp,
  onStudioStateApplied,
  resetHistoryForTests,
  resetStudioHistory,
} from '$lib/studio/history.svelte'
import {
  cancelComputeQueue,
  getComputeProgress as getComputeProgressQueue,
  getComputing as getComputingQueue,
  getLayerResult,
  jointViewOf,
  markAllLayersDirty,
  markLayersDirty,
  recolorAllResults,
  refreshSignatureBaseline,
  resetComputeQueue,
  waitForComputeQueueIdle,
} from '$lib/studio/computeQueue.svelte'
import { jointExportGate, type LayeredViolationGroup } from '$lib/studio/jointGate'
import type { ExportViolation } from '$lib/engine'

// ---------------------------------------------------------------------------
// 常量
// [gem-catalog 2.4] PIXELS_PER_MM 已收编为 engine 单一出口 import（本文件原副本删除；
// SS10 → pitch 8px / 钻径 7px，引擎标准网格——值恒 2.5，行为零变化）。
// ---------------------------------------------------------------------------

/** 大图降采样上限：>1024px 先缩再 segment（细节损失可接受，换分块/排布流畅） */
export const MAX_IMAGE_DIM = 1024
export const SEGMENT_DEBOUNCE_MS = 300
export const LAYOUT_DEBOUNCE_MS = 300
/** 分块类型推断用的钻径：固定 SS10@2.5px/mm=7px（SS 切换只改 grid/pitch，不重分块） */
const SEGMENT_GEM_DIAMETER_PX = SS_TABLE.SS10 * PIXELS_PER_MM
const LAYOUT_SEED = 1

/** 策略中文名唯一真源在 computeCore（worker 可导入的纯模块）；store 转发以兼容既有 UI 导入 */
export { STRATEGY_LABELS } from '$lib/workers/computeCore'

export const SS_LABELS: Record<SSKey, string> = SS_KEYS.reduce(
  (acc, k) => {
    acc[k] = `${k}（${SS_TABLE[k].toFixed(1)}mm）`
    return acc
  },
  {} as Record<SSKey, string>,
)


export interface StudioImage {
  dataUrl: string
  name: string
  width: number
  height: number
  origin: 'handoff' | 'upload' | 'library'
  /** 来源素材节点 id（[add-asset-library 5.1]：会话引用 pin / 送精修 reference 链）。 */
  assetId?: string
  /** 降采样系数（1 = 原尺寸） */
  downscale: number
}

/** 参考原图（[add-asset-library 5.2]）：assetId + dataUrl 渲染缓存（asset 本体归素材库）。 */
export interface StudioReferenceImage {
  assetId?: string
  dataUrl: string
  name: string
}

export interface StrategyResult {
  strategy: StrategyId
  gems: Gem[]
  warnings: Warning[]
  durationMs: number
  spacingCount: number
  /** 被确定性冲突消解剔除的钻数（引擎 LayoutResult.dropped） */
  dropped: number
  error?: string
}

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

let sourceImage = $state<StudioImage | null>(null)
let referenceImage = $state<StudioReferenceImage | null>(null)
let painting = $state<EngineImage | null>(null)
let loadError = $state<string | null>(null)

let segmenting = $state(false)
/** [2.3] 分块阶段进度（分块单轮归根；布局阶段进度归 computeQueue 域——读取面合并） */
let segmentProgress = $state<ComputeProgressState | null>(null)

let blocks = $state<Block[]>([])

// [2.1] 图层/参数域 $state 已迁 lib/studio/layers.svelte.ts（layers[]+覆写四表+层物理+
// palette+segment+k/seed+观察态）；下方派生量经其读取器投影——单兜底层下与拆分前逐值相等。

let selectedBlockId = $state<string | null>(null)

// [2.3] 五策略域（results/activeStrategy/runLayouts）退役——计算队列域已拆出 →
// src/lib/studio/computeQueue.svelte.ts（脏层追踪 + 单 worker 逐层串行 + perLayerResults）；
// oracle fixture 已由 1.1 固化（src/tests/studio/fixtures/compute-layer-oracle.json）。

/** 进度快照：UI 进度条/徽章直出（label 已是人类可读阶段名） */
export interface ComputeProgressState {
  done: number
  total: number
  label: string
}

// ---------------------------------------------------------------------------
// 派生量（[2.1] 覆写四表/物理四件 = 图层域 rest 层投影——单兜底层下与拆分前逐值相等）
// ---------------------------------------------------------------------------

const layersNow = $derived(getLayers())
const restLayer = $derived.by(() => layersNow.find((l) => l.blockIds === 'rest') ?? null)

const grid = $derived.by(() => {
  if (restLayer === null) return gridFromSs('SS10', PIXELS_PER_MM, 0.4)
  const ssKey = ssOfRoundSpecKey(restLayer.physics.specKey) ?? 'SS10'
  return gridFromSs(ssKey, PIXELS_PER_MM, restLayer.physics.gapMm)
})
const palette = $derived(getPaletteState())

/** 全设计禁用视图（分区不变量下每块至多一层持有键；层集变化/键增删均触发重算） */
const disabledIds = $derived.by(() => {
  const merged: Record<string, true> = {}
  for (const layer of layersNow) Object.assign(merged, layer.overrides.disabled)
  return merged
})
const enabledBlocks = $derived(blocks.filter((b) => !disabledIds[b.id]))
/** 送 layout 的最终块集：启用 + 类型覆写（mask/bbox 浅共享，不改动引擎产物） */
const effectiveBlocks = $derived(
  enabledBlocks.map((b) => {
    const owner = owningLayerOf(layersNow, b.id)
    const t = owner?.overrides.type[b.id]
    return t && t !== b.suggested ? { ...b, suggested: t } : b
  }),
)
/**
 * DensitySpec 的 Record 形态：每块生效密度 = 块覆写 ?? 所属层 density；
 * 生效密度恰为 1 的块省略（引擎侧 Record 缺省块默认 1.0，types.ts 语义）。
 */
const densitySpec = $derived.by(() => {
  const spec: Record<string, number> = {}
  for (const b of enabledBlocks) {
    const d = blockDensityOf(layersNow, b.id)
    if (d !== 1) spec[b.id] = d
  }
  return spec
})

/** 快速钻数估算（六方密排足迹近似）：area·d / ((√3/2)·pitch²)，对 d 单调 */
function estimateCount(areaPx: number, density: number, pitch: number): number {
  const cell = (Math.sqrt(3) / 2) * pitch * pitch
  return Math.round((areaPx * density) / cell)
}

/** 每块生效密度（块覆写 ?? 所属层 density——2.1 回落目标层级化） */
export function getBlockDensity(blockId: string): number {
  return blockDensityOf(getLayers(), blockId)
}

export function getBlockEstimate(block: Block, densityOverride?: number): number {
  const density = densityOverride ?? getBlockDensity(block.id)
  return estimateCount(block.areaPx, density, pitchPx(grid))
}

export function getTotalEstimate(): number {
  return enabledBlocks.reduce((sum, b) => sum + getBlockEstimate(b), 0)
}

/**
 * 滑杆防抖提交选项：immediate = 跳过布局防抖直起计算轮。
 * [2026-09-19 Busy 切片] input-range 在组件层已做 300ms trailing 合并（乐观 UI 期间 store 不动），
 * 提交时若再走 scheduleLayout 会叠加一层防抖（300+300ms）——immediate 保持「停止拖动 300ms 后触发」单一时序。
 * 既有调用（Select/Switch 等离散入口与测试）不传该参，行为不变。
 */
export interface CommitOpts {
  immediate?: boolean
}

/** activeStrategy 结果中每块实际钻数（无结果/未参与为 0）——[2.3] 联合口径（Σ 各层） */
const actualBlockCounts = $derived.by(() => {
  const view = jointView
  const counts: Record<string, number> = {}
  for (const g of view.gems) counts[g.blockId] = (counts[g.blockId] ?? 0) + 1
  return counts
})

export function getActualBlockCount(blockId: string): number {
  return actualBlockCounts[blockId] ?? 0
}

/** [2.3] 联合视图（各层 concat + 跨层全局重编号——旧 activeStrategy 单值结果的层化继任） */
const jointView = $derived.by(() => jointViewOf(layersNow))

const anchorStrategy = $derived.by(() =>
  layersNow.find((l) => l.blockIds === 'rest')?.strategy ?? layersNow[0]?.strategy ?? 'hybrid',
)

/** 兼容面（2.7 StrategyFilmStrip 废除时随组件退役）：联合视图 → 旧 StrategyResult 形状 */
const activeResultCompat = $derived.by<StrategyResult | null>(() => {
  const view = jointView
  const anySettled = layersNow.some((l) => getLayerResult(l.id) !== undefined)
  if (!anySettled) return null
  return {
    strategy: anchorStrategy,
    gems: view.gems,
    warnings: view.warnings,
    durationMs: 0,
    spacingCount: view.warnings.filter((w) => w.kind === 'spacing').length,
    dropped: view.dropped,
    ...(view.hasError ? { error: '部分层计算失败' } : {}),
  }
})

/** BOM 摘要（色名 × 数量，按数量降序——联合口径含隐藏层） */
const bomSummary = $derived.by(() => {
  const view = jointView
  const counts = new Map<string, number>()
  for (const g of view.gems) counts.set(g.colorId, (counts.get(g.colorId) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id, count]) => {
      const entry = findPaletteColor(palette, id)
      return { id, name: entry?.name ?? (id || '未映射'), hex: entry?.hex ?? '#9CA3AF', count }
    })
})

/**
 * [2.3] 导出门 = 联合 exportGate（全层 concat 统一 pairwise——1.3 jointGate；隐藏层照常参与，
 * §2.5「隐藏 ≠ 排除」）：SVG/BOM/PNG/送精修共同前置硬阻断；保存允许 warning。
 */
const jointCheck = $derived.by(() => {
  const view = jointView
  const anySettled = layersNow.some((l) => getLayerResult(l.id) !== undefined)
  if (!anySettled || painting === null || view.hasError) {
    return {
      ready: false,
      exportable: false,
      warnings: [] as ExportViolation[],
      groups: [] as LayeredViolationGroup[],
      involvedLayerIds: [] as string[],
    }
  }
  const gate = jointExportGate(
    view.layers.map((l) => ({ layerId: l.layerId, layerName: l.layerName, gapMm: l.gapMm, gems: l.gems })),
    { pixelsPerMm: PIXELS_PER_MM, blocks: effectiveBlocks },
  )
  return {
    ready: true,
    exportable: gate.verdict.ok,
    warnings: gate.verdict.violations,
    groups: gate.groups,
    involvedLayerIds: [...new Set(gate.groups.flatMap((g) => g.layerIds))],
  }
})

// ---------------------------------------------------------------------------
// 读取器
// ---------------------------------------------------------------------------

export function getSourceImage(): StudioImage | null {
  return sourceImage
}
export function getReferenceImage(): StudioReferenceImage | null {
  return referenceImage
}
/** 解码后的数字油画像素（渲染/导出用） */
export function getPainting(): EngineImage | null {
  return painting
}
export function getLoadError(): string | null {
  return loadError
}
export function getSegK(): number {
  return getSegmentOpts().k
}
export function getSegSeed(): number {
  return getSegmentOpts().seed
}
export function getSegmenting(): boolean {
  return segmenting
}
export function getBlocks(): Block[] {
  return blocks
}
/** 送 layout 的最终块集（启用过滤 + 类型覆写），测试与导出共用口径 */
export function getEffectiveBlocks(): Block[] {
  return effectiveBlocks
}
/** DensitySpec 的 Record 形态（生效密度恰为 1 的块省略 → 引擎默认 1.0） */
export function getDensitySpec(): Record<string, number> {
  return densitySpec
}
export function isEnabled(blockId: string): boolean {
  return !disabledIds[blockId]
}
/** 禁用块 id 集（响应式快照，画布层用 Object.keys 追踪增删） */
export function getDisabledIds(): Record<string, true> {
  return disabledIds
}
export function getTypeOverride(blockId: string): BlockType | undefined {
  return owningLayerOf(getLayers(), blockId)?.overrides.type[blockId]
}
export function getColorOverride(blockId: string): string | undefined {
  return owningLayerOf(getLayers(), blockId)?.overrides.color[blockId]
}
/** [2.1] 全局密度语义退役——读面 = 兜底层密度投影（写入面同） */
export function getGlobalDensity(): number {
  return getRestLayer()?.physics.density ?? 1
}
export function getSs(): SSKey {
  return restSsOf(getLayers()) as SSKey
}
export function getGapMm(): number {
  return getRestLayer()?.physics.gapMm ?? 0.4
}
export function getGrid(): GridSpec {
  return grid
}
export function getRelax(): { boundary: boolean; repulsion: boolean } {
  return getRestLayer()?.physics.relax ?? { boundary: false, repulsion: false }
}
export function getPalette(): Palette {
  return palette
}
export function getSelectedBlockId(): string | null {
  return selectedBlockId
}
export function getComputing(): boolean {
  return segmenting || getComputingQueue()
}
export function getComputeProgress(): ComputeProgressState | null {
  return segmenting ? segmentProgress : getComputeProgressQueue()
}
export function getActiveResult(): StrategyResult | null {
  return activeResultCompat
}
export function getBomSummary(): Array<{ id: string; name: string; hex: string; count: number }> {
  return bomSummary
}
export interface JointCheckView {
  ready: boolean
  exportable: boolean
  warnings: ExportViolation[]
  /** 违规按层对分组（§2.7 状态条违规清单 ▾ 数据面——intra/inter 层名） */
  groups: LayeredViolationGroup[]
  /** 违规涉及层全集（[边界松弛][斥力修复] 写入目标——多选批量语义） */
  involvedLayerIds: string[]
}

export function getExportCheck(): JointCheckView {
  return jointCheck
}

/** 层成员面（行钻数/键盘兜底；rest = 分块结果 − 显式层并集）。 */
export function getLayerMemberCount(layerId: string): number {
  return getLayerMemberIds(layerId).size
}

export function getLayerMemberIds(layerId: string): Set<string> {
  const layers = getLayers()
  const layer = layers.find((l) => l.id === layerId)
  if (layer === undefined) return new Set()
  if (layer.blockIds !== 'rest') return new Set(layer.blockIds)
  const explicit = new Set<string>()
  for (const l of layers) {
    if (l.blockIds !== 'rest') for (const id of l.blockIds) explicit.add(id)
  }
  return new Set(blocks.filter((b) => !explicit.has(b.id)).map((b) => b.id))
}
/** [2.5] 隐藏层计数（「隐藏 ≠ 排除」口径附注——状态条「M 层 · 含 k 隐藏层」数据面）。 */
export function getHiddenLayerCount(): number {
  return getLayers().filter((l) => !l.visible).length
}

// ---------------------------------------------------------------------------
// 图像载入域（A 轨 2.1 已拆出 → src/lib/studio/imageSource.svelte.ts；公共面经根 re-export 兼容）
// ---------------------------------------------------------------------------

// —— 内部协作面（仅拆分子模块消费；非公共 API，签名不冻结） ——

/** 图像载入域写 loadError（载入/解码/读取失败的显式错误态唯一出口；分块失败仍由根直写）。 */
export function setLoadError(message: string | null): void {
  loadError = message
}

/** 图像载入域写 referenceImage（参考原图落位/替换/清除；pin 编排在子模块完成）。 */
export function setReferenceImageRecord(next: StudioReferenceImage | null): void {
  referenceImage = next
}

/**
 * 载入落位桥（内部）：painting/sourceImage 就位 + 会话引用换绑（旧 unpin/新 pin）+
 * 复位选中块与结果并起分块防抖。留在根：编排 cancelPending/scheduleSegment/selectedBlockId/
 * results 等 store 核心计算域（design §2.3-4 单向依赖——子模块不反向持有计算编排）。
 */
export function applyPainting(image: EngineImage, meta: Omit<StudioImage, 'width' | 'height'>): void {
  cancelPending()
  painting = image
  // studio 会话引用（§4 引用集②）：换图解除旧 pin，新资产挂 pin
  if (sourceImage?.assetId) unpinAsset(sourceImage.assetId)
  sourceImage = { ...meta, width: image.width, height: image.height }
  if (sourceImage.assetId) pinAsset(sourceImage.assetId)
  selectedBlockId = null
  // [2.1] 换图 = 图层域重置为单一兜底层「图层 1」（palette/segment 保持现场——与拆分前一致）
  initDefaultLayers()
  // [2.2] 换图 = 新 base 会话级重置（不入历史——守卫走 add-project-files §3 三按钮）
  resetStudioHistory(getParamState())
  // [2.3] 计算队列复位（在途批作废 + 逐层结果清零）+ 差分签名基线重立
  resetComputeQueue()
  refreshSignatureBaseline()
  scheduleSegment()
}

// 公共导出面 re-export（消费方 import 路径与签名零变化；A 轨 2.1 零行为验收面）
export {
  fileToDataUrl,
  loadFromDataUrl,
  loadFromFile,
  loadFromLibrary,
  applyHandoffReference,
  loadFromHandoff,
  loadFromEngineImage,
  setReferenceFile,
  clearReferenceImage,
} from '$lib/studio/imageSource.svelte'

// ---------------------------------------------------------------------------
// 分块（防抖）
// ---------------------------------------------------------------------------

let segmentTimer: ReturnType<typeof setTimeout> | null = null
let segmentRun = 0
let segmentInflight: Promise<void> | null = null

/** 连通域最小面积：随图尺寸缩放（1024² ≈ 524px），抑制 AI 平涂图的碎块 */
function minAreaFor(image: EngineImage): number {
  return Math.min(4000, Math.max(12, Math.round(image.width * image.height * 0.0005)))
}

export function setSegK(k: number): void {
  const segment = getSegmentOpts()
  const next = Math.min(10, Math.max(6, Math.round(k)))
  if (next === segment.k) return
  dispatchStudioOp({ t: 'segment.opts', k: next, seed: segment.seed })
  scheduleSegment()
}

export function setSegSeed(seed: number): void {
  const segment = getSegmentOpts()
  const next = Math.max(0, Math.round(seed) || 0)
  if (next === segment.seed) return
  dispatchStudioOp({ t: 'segment.opts', k: segment.k, seed: next })
  scheduleSegment()
}

function scheduleSegment(): void {
  if (segmentTimer) clearTimeout(segmentTimer)
  segmentTimer = setTimeout(() => {
    segmentTimer = null
    void runSegment()
  }, SEGMENT_DEBOUNCE_MS)
}

let segmentHandle: ComputeHandle | null = null

async function runSegment(): Promise<void> {
  const image = painting
  if (!image) {
    blocks = []
    return
  }
  const run = ++segmentRun
  const { k: segK, seed: segSeed } = getSegmentOpts()
  segmenting = true
  segmentProgress = { done: 0, total: 1, label: '正在分块…' }
  const promise = (async () => {
    // 先让出主线程：segmenting/进度状态有机会先渲染
    await new Promise<void>((r) => setTimeout(r, 0))
    if (run !== segmentRun) return
    try {
      const handle = runCompute({
        image,
        segmentOpts: {
          k: segK,
          seed: segSeed,
          gemDiameterPx: SEGMENT_GEM_DIAMETER_PX,
          minAreaPx: minAreaFor(image),
        },
        strategies: [],
        layoutOpts: { density: {}, seed: LAYOUT_SEED, relax: { ...getRelax() } },
        grid: { ...grid },
      })
      segmentHandle = handle
      const { blocks: next } = await handle.promise
      if (run !== segmentRun) return
      blocks = next
      landBlocks(next)
      if (selectedBlockId && !next.some((b) => b.id === selectedBlockId)) selectedBlockId = null
      // [2.3] 块集落位 → 有成员的层全量标脏（分块是全局单轮——层几何输入整体换新）
      scheduleLayout()
    } catch (error) {
      if (run !== segmentRun) return
      if (error instanceof ComputeAbortedError) return
      loadError = `分块失败：${error instanceof Error ? error.message : String(error)}`
    }
  })()
  segmentInflight = promise
  try {
    await promise
  } finally {
    if (run === segmentRun) {
      segmenting = false
      segmentInflight = null
      segmentProgress = null
    }
  }
}

// ---------------------------------------------------------------------------
// 块级覆写 / 层参数（[2.3] 触发面 = 计算队列域标脏——所属层差分重算，未触碰层缓存保留）
// ---------------------------------------------------------------------------

export function selectBlock(blockId: string | null): void {
  selectedBlockId = blockId
  // [2.4] 两级选择联动：块选择（画布点选/块列表行）命中成功 = 隐式单选所属层；
  // null（列表再点取消/详情取消选中）只清块选择，不动层选择——「命中失败不改层选择」
  if (blockId !== null) {
    const owner = owningLayerOf(getLayers(), blockId)
    if (owner !== null) selectLayer(owner.id, 'replace')
  }
}

/**
 * [2.4] 多选批量写：触碰任一配置控件 = 该字段写入**全部选中普通层** = 单个 layer.config op
 * （一次撤销恢复全部原值——工作默认二）；每层随写入标脏重算。背景层不在选择集（批量只读）。
 */
export function writeSelectedLayerConfig(
  patch: Parameters<typeof dispatchLayerConfigOp>[1],
  opts: CommitOpts = {},
): void {
  const ids = getSelectionOrder()
  if (ids.length === 0) return
  dispatchLayerConfigOp(ids, patch, undefined, opts)
}

/** 块所属层标脏（覆写随层住——两级选择里块覆写只影响所属层的重算）。 */
function markBlockLayerDirty(blockId: string, opts: CommitOpts = {}): void {
  const owner = owningLayerOf(getLayers(), blockId)
  if (owner !== null) markLayersDirty([owner.id], opts)
}

/**
 * [improve 1.2] 移块入层（BlockDetail「移入图层」唯一入口）：moveBlocks op + **新旧所属层双标脏**。
 * 现状 BUG 修复：裸 dispatch layer.moveBlocks 无人标脏（computeQueue 只监听 replay 事件）→
 * 画布/统计停留旧归属，表现为「移入图层没生效」。同层自移 = no-op 不标脏。
 */
export function moveBlockToLayer(blockId: string, toLayerId: string, opts: CommitOpts = {}): void {
  const layers = getLayers()
  const prevOwner = owningLayerOf(layers, blockId)
  const target = layers.find((l) => l.id === toLayerId)
  if (target === undefined || target.id === prevOwner?.id) return
  dispatchStudioOp({ t: 'layer.moveBlocks', blockIds: [blockId], toLayerId })
  const dirty = new Set<string>()
  if (prevOwner !== null) dirty.add(prevOwner.id)
  dirty.add(toLayerId)
  markLayersDirty([...dirty], opts)
}

export function setEnabled(blockId: string, enabled: boolean): void {
  dispatchStudioOp({ t: 'block.override', blockId, patch: { kind: 'enabled', value: enabled } })
  markBlockLayerDirty(blockId)
}

export function setBlockDensity(
  blockId: string,
  density: number,
  opts: CommitOpts = {},
): void {
  // 显式覆写（含 1.0）：滑杆一经触碰即脱离层密度；densitySpec 出口再省略恰为 1 的键
  dispatchStudioOp({
    t: 'block.override',
    blockId,
    patch: { kind: 'density', value: density },
    groupId: `block-density:${blockId}`,
  })
  markBlockLayerDirty(blockId, opts)
}

/** 清除块密度覆写：恢复跟随所属层密度 */
export function resetBlockDensity(blockId: string): void {
  dispatchStudioOp({ t: 'block.override', blockId, patch: { kind: 'density', value: null } })
  markBlockLayerDirty(blockId)
}

export function setBlockType(blockId: string, type: BlockType | null): void {
  dispatchStudioOp({ t: 'block.override', blockId, patch: { kind: 'type', value: type } })
  markBlockLayerDirty(blockId)
}

export function setBlockColor(blockId: string, paletteColorId: string | null): void {
  dispatchStudioOp({ t: 'block.override', blockId, patch: { kind: 'color', value: paletteColorId } })
  recolorAllResults()
}

// ---------------------------------------------------------------------------
// [improve 3.1] 块级「继承」开关（Owner 2026-09-20 修订：显式开关随时切换是否继承）
// ---------------------------------------------------------------------------

/** 开关写入：开 = 跟随父层（休眠值保留）；关 = 独立微调（无档摄父层快照/有档恢复休眠值）。 */
export function setBlockInherit(blockId: string, inherit: boolean, opts: CommitOpts = {}): void {
  dispatchStudioOp({ t: 'block.override', blockId, patch: { kind: 'inherit', value: inherit } })
  markBlockLayerDirty(blockId, opts)
}

/** 独立配置写入（策略 + 基础规格；继承态 UI 只读——BlockDetail 开关卡位）。 */
export function setBlockLayerConfig(
  blockId: string,
  config: { strategy: StrategyId; specKey: string },
  opts: CommitOpts = {},
): void {
  dispatchStudioOp({ t: 'block.override', blockId, patch: { kind: 'config', value: config } })
  markBlockLayerDirty(blockId, opts)
}

/** 块配置面板视图（继承态回显父层值；ownerName 承载「继承自图层N」标记）。 */
export interface BlockConfigView {
  inherit: boolean
  strategy: StrategyId
  specKey: string
  ownerName: string
}

export function getBlockConfigView(blockId: string): BlockConfigView | null {
  const layers = getLayers()
  const owner = owningLayerOf(layers, blockId)
  if (owner === null) return null
  const entry = owner.overrides.config[blockId]
  if (entry === undefined || entry.inherit) {
    return { inherit: true, strategy: owner.strategy, specKey: owner.physics.specKey, ownerName: owner.name }
  }
  return { inherit: false, strategy: entry.strategy, specKey: entry.specKey, ownerName: owner.name }
}

/** [2.1] 全局密度语义退役——写入面 = 兜底层密度（锚点层写入；2.2 起经 layer.config op 入史） */
export function setGlobalDensity(density: number, opts: CommitOpts = {}): void {
  const rest = getRestLayer()
  if (rest === null) return
  dispatchLayerConfigOp([rest.id], { density }, undefined, opts)
}

export function setSs(next: SSKey): void {
  const rest = getRestLayer()
  if (rest === null) return
  const specKey = roundSpecKeyOfSs(next)
  if (specKey === rest.physics.specKey) return
  dispatchLayerConfigOp([rest.id], { specKey })
}

export function setGapMm(gap: number, opts: CommitOpts = {}): void {
  const rest = getRestLayer()
  if (rest === null) return
  const next = Math.min(0.8, Math.max(0.4, Math.round(gap * 100) / 100))
  if (next === rest.physics.gapMm) return
  dispatchLayerConfigOp([rest.id], { gapMm: next }, `layer-gap:${rest.id}`, opts)
}

export function setRelax(patch: Partial<{ boundary: boolean; repulsion: boolean }>): void {
  const rest = getRestLayer()
  if (rest === null) return
  const merged = { ...rest.physics.relax, ...patch }
  dispatchLayerConfigOp([rest.id], { relax: merged })
}

// ---------------------------------------------------------------------------
// 色板编辑器（引擎助手原地增删改；[2.3] 色映射原地重算 = 计算队列域 recolorAllResults）
// ---------------------------------------------------------------------------

export function upsertColor(color: PaletteColor): void {
  dispatchStudioOp({ t: 'palette.edit', edit: { kind: 'upsert', color } })
  recolorAllResults()
}

export function removeColor(id: string): void {
  // 引用该色的覆写级联清理入 palette.edit op 语义（applyPaletteEdit）；其余块映射重算
  dispatchStudioOp({ t: 'palette.edit', edit: { kind: 'remove', id } })
  recolorAllResults()
}

export function addColor(name: string, hex: string): void {
  dispatchStudioOp({ t: 'palette.edit', edit: { kind: 'add', name, hex } })
  recolorAllResults()
}

// ---------------------------------------------------------------------------
// 层配置 op 构造（2.2 历史域接线；2.4 多选批量写复用——单 layer.config op 整体撤销）
// ---------------------------------------------------------------------------

/** 目标层写前配置快照（layer.config op 的 prev——面板回显/撤销摘要）。 */
function layerConfigPrevOf(layer: {
  strategy: StrategyId
  physics: { specKey: string; gapMm: number; density: number; relax: { boundary: boolean; repulsion: boolean } }
}) {
  return {
    strategy: layer.strategy,
    specKey: layer.physics.specKey,
    gapMm: layer.physics.gapMm,
    density: layer.physics.density,
    relax: { ...layer.physics.relax },
  }
}

/**
 * 派发 layer.config op（单层/多层共用；patch 值域 = 检查器层配置卡五字段）。
 * 配置写入即标脏重算（CommitOpts.immediate 双轨——检查器滑杆/Select 的统一触发面）。
 */
export function dispatchLayerConfigOp(
  layerIds: string[],
  patch: { strategy?: StrategyId; specKey?: string; gapMm?: number; density?: number; relax?: { boundary: boolean; repulsion: boolean } },
  groupId?: string,
  opts: CommitOpts = {},
): void {
  const layers = getLayers()
  const prev = layerIds
    .map((id) => layers.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .map(layerConfigPrevOf)
  dispatchStudioOp({ t: 'layer.config', layerIds, patch, prev, ...(groupId !== undefined ? { groupId } : {}) })
  markLayersDirty(layerIds, opts)
}

// ---------------------------------------------------------------------------
// 计算调度域（[2.3] 五策略循环退役——computeQueue 域接管；见下方兼容面）
// ---------------------------------------------------------------------------

/**
 * [2.3] 布局调度面 = 计算队列域（lib/studio/computeQueue.svelte.ts——脏层追踪 + 单 worker
 * 逐层串行 + 渐进落地/错误隔离/run 作废/取消；旧 runLayouts 五策略循环退役，oracle fixture
 * 已由 1.1 固化）。兼容签名保持（消费方零改动）。
 */
export function scheduleLayout(): void {
  markAllLayersDirty()
}

/** 立即重算（跳过防抖；测试与「重新计算」入口共用） */
export function recompute(): void {
  markAllLayersDirty({ immediate: true })
}

function cancelPending(): void {
  if (segmentTimer) {
    clearTimeout(segmentTimer)
    segmentTimer = null
  }
  segmentRun++
  // 尽力而为取消在途 worker 任务（立即 reject；迟到结果靠 run 号丢弃）
  segmentHandle?.cancel()
  segmentHandle = null
  // [2.3] 计算队列域作废（在途层轮 + 脏队列 + 进度复位）
  cancelComputeQueue()
}

/** 用户显式中断当前计算（进度徽章「取消」）：作废在途轮次并复位状态；之后的参数改动照常触发新轮 */
export function cancelCompute(): void {
  cancelPending()
  segmenting = false
  segmentProgress = null
  segmentInflight = null
}

// ---------------------------------------------------------------------------
// [2.2/2.3] 历史域接线：undo/redo（refold）后的差分重算。
// dispatch 路径的重算由各 mutator 标脏（所属层差分）；replay 路径 = computeQueue 内注册的
// 层配置签名差分（未触碰层缓存有效），segment 变化经根重跑分块（块集再生 → 全量标脏）。
// ---------------------------------------------------------------------------

onStudioStateApplied((event) => {
  if (!event.replay) return
  if (event.segmentChanged) scheduleSegment()
})

// ---------------------------------------------------------------------------
// 导出编排域（A 轨 2.2 已拆出 → src/lib/studio/exportSink.svelte.ts；公共面经根 re-export 兼容）
// ---------------------------------------------------------------------------

// 公共导出面 re-export（消费方 import 路径与签名零变化；A 轨 2.2 零行为验收面）
export {
  buildActiveSvg,
  buildActiveBom,
  exportFileName,
  archiveExportedPng,
} from '$lib/studio/exportSink.svelte'

// ---------------------------------------------------------------------------
// 送精修构造域（A 轨 2.3 已拆出 → src/lib/studio/editHandoff.svelte.ts；公共面经根 re-export 兼容）
// payload 红线（R3 P0 冻结，design §2.2 裁决二）：buildManualEditHandoff/ManualEditHandoff 唯一
// 修改 owner = studio-layers replay/handoff gate（本 change 消费接线归 5.9）；拆出面只做薄 wrapper。
// ---------------------------------------------------------------------------

// 公共导出面 re-export（消费方 import 路径与签名零变化；A 轨 2.3 零行为验收面）
export { currentSourceSummary, buildManualEditHandoff } from '$lib/studio/editHandoff.svelte'

// ---------------------------------------------------------------------------
// [2.1-2.3] 图层/历史/计算队列三子模块公共面聚合 re-export（design §2.3 根聚合纪律；
// 组件/测试统一从本根导入——子模块路径不进公共消费面）
// ---------------------------------------------------------------------------

export {
  getLayers,
  getLayerById,
  getRestLayer,
  getParamState,
  getPaletteState,
  getBackgroundObservation,
  setBackgroundObservation,
  setLayerVisible,
  getStaleOverrideNotice,
  clearStaleOverrideNotice,
  owningLayerOf,
  independentBlockConfigOf,
  toLayerRecord,
  fromLayerRecord,
  initDefaultLayers,
  selectLayer,
  selectAllLayers,
  selectBackground,
  clearLayerSelection,
  getSelectionOrder,
  getAnchorLayer,
  isLayerSelected,
  selectionBadgeOf,
  isBackgroundSelected,
  selectedConfigView,
  type LayerState,
  type LayerConfigPatch,
  type BackgroundSource,
  type SelectedConfigView,
} from '$lib/studio/layers.svelte'

export {
  dispatchStudioOp,
  undoStudioOp,
  redoStudioOp,
  canUndo,
  canRedo,
  getUndoDepth,
  getHistoryCursor,
  getOps,
  getCompactions,
  isStudioHistoryDirty,
  studioOpSummary,
  onStudioStateApplied,
  foldStudioOps,
  type StudioOp,
} from '$lib/studio/history.svelte'

export {
  getLayerResult,
  getLayerResults,
  getDirtyLayerIds,
  jointViewOf,
  layerComputeStatus,
  markLayersDirty,
  markAllLayersDirty,
  type JointView,
} from '$lib/studio/computeQueue.svelte'

// ---------------------------------------------------------------------------
// 测试支持
// ---------------------------------------------------------------------------

/** 等待防抖与计算全部落地（分块轮 + 计算队列批；管线集成测试用）。 */
export async function waitForStudioIdle(): Promise<void> {
  for (let guard = 0; guard < 2000; guard++) {
    const segmentBusy = segmentTimer !== null || segmentInflight !== null
    if (!segmentBusy) {
      await waitForComputeQueueIdle()
      // idle 返回后复查：idle 窗口内可能新起分块轮/新脏批（级联调度）
      if (segmentTimer === null && segmentInflight === null) return
      continue
    }
    if (segmentInflight) await segmentInflight.catch(() => undefined)
    else await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitForStudioIdle 超时（2s×5ms 轮询上限）')
}

/** 测试专用：整体复位（清定时器/覆写/结果，图层/历史/计算队列三域还原默认态并还原起步色板；解除会话引用 pin）。 */
export function resetStudioForTests(): void {
  cancelPending()
  segmentInflight = null
  segmenting = false
  segmentProgress = null
  if (sourceImage?.assetId) unpinAsset(sourceImage.assetId)
  if (referenceImage?.assetId) unpinAsset(referenceImage.assetId)
  sourceImage = null
  referenceImage = null
  painting = null
  loadError = null
  blocks = []
  // [2.1] 图层/参数域（layers[]/覆写四表/物理/palette/segment/观察态）整体复位
  resetLayersForTests()
  // [2.2] 历史域（base/ops/redo/压实记录/dirty）复位
  resetHistoryForTests()
  // [2.3] 计算队列域（在途批/脏集/逐层结果/差分签名基线）复位
  resetComputeQueue()
  refreshSignatureBaseline()
  selectedBlockId = null
}
