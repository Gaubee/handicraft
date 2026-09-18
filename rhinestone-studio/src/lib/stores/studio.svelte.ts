/*
Orthogonal intents (max 5):
1. [2026-09-18 Ingest] 数字油画载入（handoff 优先 > 本地上传，>1024px 降采样）与分块参数（k/seed，防抖重分块）。
2. [2026-09-18 Overrides] 块级覆写：启用/密度（DensitySpec Record 合并，缺省块 1.0）/类型/颜色 + 全局密度、SS/gap → gridFromSs 重建。
3. [2026-09-19 Offload] 重算全部经 runCompute 卸载（浏览器=module worker，jsdom/SSR=主线程同构 fallback）：分块=单策略空轮、布局=逐策略子轮（渐进落地 + 单策略错误隔离），run 号作废迟到结果。
4. [2026-09-19 Progress] computeProgress 阶段态 {done,total,label}（分块 0/1 → 逐策略 n/6）与用户显式取消 cancelCompute（作废在途轮 + 复位状态）。
5. [2026-09-18 Export/Preview] activeStrategy 导出源、导出门（spacing 违规阻断）、BOM 摘要派生；预览三模式 + 透明度。
*/

import {
  STRATEGY_IDS,
  SS_KEYS,
  SS_TABLE,
  STARTER_PALETTE,
  exportBom,
  exportSvg,
  findPaletteColor,
  gridFromSs,
  isExportable,
  mapColors,
  pitchPx,
  removePaletteColor,
  upsertPaletteColor,
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
import { clearHandoff, getHandoff, type HandoffReference } from './handoff.svelte'
import type { ManualEditHandoff } from './edit.svelte'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** px↔mm 唯一换算系数（SS10 → pitch 8px / 钻径 7px，引擎标准网格） */
export const PIXELS_PER_MM = 2.5
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

export type PreviewMode = 'gems' | 'painting' | 'reference'

export interface StudioImage {
  dataUrl: string
  name: string
  width: number
  height: number
  origin: 'handoff' | 'upload'
  /** 降采样系数（1 = 原尺寸） */
  downscale: number
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
let referenceImage = $state<{ dataUrl: string; name: string } | null>(null)
let painting = $state<EngineImage | null>(null)
let loadError = $state<string | null>(null)

let segK = $state(8)
let segSeed = $state(1)
let segmenting = $state(false)

let blocks = $state<Block[]>([])
/** 存在的 key = 该块禁用（禁用 = 不参与排布） */
let disabledIds = $state<Record<string, true>>({})
/** 块级密度覆写（0<d≤1），缺省回落全局密度 */
let densityOverrides = $state<Record<string, number>>({})
let typeOverrides = $state<Record<string, BlockType>>({})
/** 块颜色覆写：色板条目 id，缺省走 mapColors 最近邻 */
let colorOverrides = $state<Record<string, string>>({})

let globalDensity = $state(1)
let ss = $state<SSKey>('SS10')
let gapMm = $state(0.4)
let relax = $state({ boundary: false, repulsion: false })

const palette = $state<Palette>(STARTER_PALETTE.map((c) => ({ ...c })))

let selectedBlockId = $state<string | null>(null)
let activeStrategy = $state<StrategyId>('hybrid')
let previewMode = $state<PreviewMode>('gems')
let overlayOpacity = $state(0.5)

let results = $state<Record<StrategyId, StrategyResult | null>>(emptyResults())
let computing = $state(false)
/** 当前轮计算进度（null=无在途轮）；done/total 与 computeCore 单元模型一致（segment 1 + 策略 N） */
let computeProgress = $state<ComputeProgressState | null>(null)

/** 进度快照：UI 进度条/徽章直出（label 已是人类可读阶段名） */
export interface ComputeProgressState {
  done: number
  total: number
  label: string
}

function emptyResults(): Record<StrategyId, StrategyResult | null> {
  return { 'hex-thin': null, 'hex-pitch': null, poisson: null, hybrid: null, cvt: null }
}

// ---------------------------------------------------------------------------
// 派生量
// ---------------------------------------------------------------------------

const grid = $derived(gridFromSs(ss, PIXELS_PER_MM, gapMm))
const enabledBlocks = $derived(blocks.filter((b) => !disabledIds[b.id]))
/** 送 layout 的最终块集：启用 + 类型覆写（mask/bbox 浅共享，不改动引擎产物） */
const effectiveBlocks = $derived(
  enabledBlocks.map((b) => {
    const t = typeOverrides[b.id]
    return t && t !== b.suggested ? { ...b, suggested: t } : b
  }),
)
/**
 * DensitySpec 的 Record 形态：每块生效密度 = 块覆写 ?? 全局；
 * 生效密度恰为 1 的块省略（引擎侧 Record 缺省块默认 1.0，types.ts 语义）。
 */
const densitySpec = $derived.by(() => {
  const spec: Record<string, number> = {}
  for (const b of enabledBlocks) {
    const d = densityOverrides[b.id] ?? globalDensity
    if (d !== 1) spec[b.id] = d
  }
  return spec
})

/** 快速钻数估算（六方密排足迹近似）：area·d / ((√3/2)·pitch²)，对 d 单调 */
function estimateCount(areaPx: number, density: number, pitch: number): number {
  const cell = (Math.sqrt(3) / 2) * pitch * pitch
  return Math.round((areaPx * density) / cell)
}

/** 每块生效密度（块覆写 ?? 全局） */
export function getBlockDensity(blockId: string): number {
  return densityOverrides[blockId] ?? globalDensity
}

export function getBlockEstimate(block: Block): number {
  return estimateCount(block.areaPx, getBlockDensity(block.id), pitchPx(grid))
}

export function getTotalEstimate(): number {
  return enabledBlocks.reduce((sum, b) => sum + getBlockEstimate(b), 0)
}

/** activeStrategy 结果中每块实际钻数（无结果/未参与为 0） */
const actualBlockCounts = $derived.by(() => {
  const res = results[activeStrategy]
  const counts: Record<string, number> = {}
  if (res) for (const g of res.gems) counts[g.blockId] = (counts[g.blockId] ?? 0) + 1
  return counts
})

export function getActualBlockCount(blockId: string): number {
  return actualBlockCounts[blockId] ?? 0
}

const activeResult = $derived(results[activeStrategy])

/** BOM 摘要（色名 × 数量，按数量降序） */
const bomSummary = $derived.by(() => {
  const res = activeResult
  if (!res) return [] as Array<{ id: string; name: string; hex: string; count: number }>
  const counts = new Map<string, number>()
  for (const g of res.gems) counts.set(g.colorId, (counts.get(g.colorId) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id, count]) => {
      const entry = findPaletteColor(palette, id)
      return { id, name: entry?.name ?? (id || '未映射'), hex: entry?.hex ?? '#9CA3AF', count }
    })
})

/** 导出前全量校验（任务 4.4：spacing 违规 → 禁用导出并列出清单） */
const exportCheck = $derived.by(() => {
  const res = activeResult
  if (!res || res.error) return { ready: false, exportable: false, warnings: [] as Warning[] }
  const warnings = validate(res.gems, grid, effectiveBlocks)
  return { ready: true, exportable: isExportable(warnings), warnings }
})

// ---------------------------------------------------------------------------
// 读取器
// ---------------------------------------------------------------------------

export function getSourceImage(): StudioImage | null {
  return sourceImage
}
export function getReferenceImage(): { dataUrl: string; name: string } | null {
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
  return segK
}
export function getSegSeed(): number {
  return segSeed
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
  return typeOverrides[blockId]
}
export function getColorOverride(blockId: string): string | undefined {
  return colorOverrides[blockId]
}
export function getGlobalDensity(): number {
  return globalDensity
}
export function getSs(): SSKey {
  return ss
}
export function getGapMm(): number {
  return gapMm
}
export function getGrid(): GridSpec {
  return grid
}
export function getRelax(): { boundary: boolean; repulsion: boolean } {
  return relax
}
export function getPalette(): Palette {
  return palette
}
export function getSelectedBlockId(): string | null {
  return selectedBlockId
}
export function getActiveStrategy(): StrategyId {
  return activeStrategy
}
export function getResults(): Record<StrategyId, StrategyResult | null> {
  return results
}
export function getComputing(): boolean {
  return computing
}
export function getComputeProgress(): ComputeProgressState | null {
  return computeProgress
}
export function getActiveResult(): StrategyResult | null {
  return activeResult
}
export function getBomSummary(): Array<{ id: string; name: string; hex: string; count: number }> {
  return bomSummary
}
export function getExportCheck(): { ready: boolean; exportable: boolean; warnings: Warning[] } {
  return exportCheck
}
export function getPreviewMode(): PreviewMode {
  return previewMode
}
export function getOverlayOpacity(): number {
  return overlayOpacity
}

// ---------------------------------------------------------------------------
// 图像载入（浏览器解码路径 + 测试直灌路径）
// ---------------------------------------------------------------------------

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败（不支持的格式或损坏的文件）'))
    img.src = src
  })
}

function imageToEngineImage(
  img: HTMLImageElement,
  maxDim: number,
): { image: EngineImage; downscale: number } {
  const downscale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * downscale))
  const h = Math.max(1, Math.round(img.naturalHeight * downscale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 不可用，无法解码图片')
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  return { image: { width: w, height: h, data: data.data }, downscale }
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 浏览器路径：dataURL → 解码 → ≤1024px 降采样 → 分块管线 */
export async function loadFromDataUrl(
  dataUrl: string,
  name: string,
  origin: 'handoff' | 'upload',
): Promise<boolean> {
  loadError = null
  try {
    const img = await loadImageElement(dataUrl)
    const { image, downscale } = imageToEngineImage(img, MAX_IMAGE_DIM)
    applyPainting(image, { dataUrl, name, origin, downscale })
    return true
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    return false
  }
}

export async function loadFromFile(file: File): Promise<boolean> {
  const dataUrl = await fileToDataUrl(file)
  return loadFromDataUrl(dataUrl, file.name, 'upload')
}

/** handoff 参考原图落位：不覆盖已手动上传的参考图（纯增量，loadFromHandoff 与测试共用） */
export function applyHandoffReference(ref: HandoffReference | undefined): void {
  if (ref && !referenceImage) referenceImage = { dataUrl: ref.dataUrl, name: ref.name }
}

/** 消费 handoff store（实验室「送转化」产物），成功后清空交接。
 *  [2026-09-18 R3] payload.reference：实验室参考原图 → 自动填充「叠原图」底图（不覆盖已手动上传的）。 */
export async function loadFromHandoff(): Promise<boolean> {
  const payload = getHandoff()
  if (!payload) return false
  const ok = await loadFromDataUrl(payload.image, payload.name, 'handoff')
  if (ok) {
    applyHandoffReference(payload.reference)
    clearHandoff()
  }
  return ok
}

/** 测试/程序化路径：直接灌入 EngineImage（jsdom 无 canvas 解码时同构可用） */
export function loadFromEngineImage(
  image: EngineImage,
  name: string,
  origin: 'handoff' | 'upload' = 'upload',
): void {
  loadError = null
  const w = image.width
  const h = image.height
  // 合成一个可渲染的等价 dataUrl 不可行（无编码器）；渲染层直接消费 painting 像素
  applyPainting({ width: w, height: h, data: image.data }, {
    dataUrl: '',
    name,
    origin,
    downscale: 1,
  })
}

function applyPainting(image: EngineImage, meta: Omit<StudioImage, 'width' | 'height'>): void {
  cancelPending()
  painting = image
  sourceImage = { ...meta, width: image.width, height: image.height }
  selectedBlockId = null
  results = emptyResults()
  scheduleSegment()
}

export async function setReferenceFile(file: File): Promise<void> {
  referenceImage = { dataUrl: await fileToDataUrl(file), name: file.name }
}

export function clearReferenceImage(): void {
  referenceImage = null
  if (previewMode === 'reference') previewMode = 'painting'
}

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
  const next = Math.min(10, Math.max(6, Math.round(k)))
  if (next === segK) return
  segK = next
  scheduleSegment()
}

export function setSegSeed(seed: number): void {
  const next = Math.max(0, Math.round(seed) || 0)
  if (next === segSeed) return
  segSeed = next
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
  segmenting = true
  computeProgress = { done: 0, total: 1, label: '正在分块…' }
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
        layoutOpts: { density: {}, seed: LAYOUT_SEED, relax: { ...relax } },
        grid: gridFromSs(ss, PIXELS_PER_MM, gapMm),
      })
      segmentHandle = handle
      const { blocks: next } = await handle.promise
      if (run !== segmentRun) return
      blocks = next
      pruneStaleOverrides()
      if (selectedBlockId && !next.some((b) => b.id === selectedBlockId)) selectedBlockId = null
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
      computeProgress = null
    }
  }
}

function pruneStaleOverrides(): void {
  const ids = new Set(blocks.map((b) => b.id))
  for (const key of Object.keys(disabledIds)) if (!ids.has(key)) delete disabledIds[key]
  for (const key of Object.keys(densityOverrides)) if (!ids.has(key)) delete densityOverrides[key]
  for (const key of Object.keys(typeOverrides)) if (!ids.has(key)) delete typeOverrides[key]
  for (const key of Object.keys(colorOverrides)) if (!ids.has(key)) delete colorOverrides[key]
}

// ---------------------------------------------------------------------------
// 块级覆写 / 全局参数（全部触发布局防抖重算）
// ---------------------------------------------------------------------------

export function selectBlock(blockId: string | null): void {
  selectedBlockId = blockId
}

export function setEnabled(blockId: string, enabled: boolean): void {
  if (enabled) delete disabledIds[blockId]
  else disabledIds[blockId] = true
  scheduleLayout()
}

export function setBlockDensity(blockId: string, density: number): void {
  // 显式覆写（含 1.0）：滑杆一经触碰即脱离全局；densitySpec 出口再省略恰为 1 的键
  densityOverrides[blockId] = Math.min(1, Math.max(0.01, density))
  scheduleLayout()
}

/** 清除块密度覆写：恢复跟随全局密度 */
export function resetBlockDensity(blockId: string): void {
  delete densityOverrides[blockId]
  scheduleLayout()
}

export function setBlockType(blockId: string, type: BlockType | null): void {
  if (type === null) delete typeOverrides[blockId]
  else typeOverrides[blockId] = type
  scheduleLayout()
}

export function setBlockColor(blockId: string, paletteColorId: string | null): void {
  if (paletteColorId === null) delete colorOverrides[blockId]
  else colorOverrides[blockId] = paletteColorId
  recolorResults()
}

export function setGlobalDensity(density: number): void {
  globalDensity = Math.min(1, Math.max(0.01, density))
  scheduleLayout()
}

export function setSs(next: SSKey): void {
  if (next === ss) return
  ss = next
  scheduleLayout()
}

export function setGapMm(gap: number): void {
  const next = Math.min(0.8, Math.max(0.4, Math.round(gap * 100) / 100))
  if (next === gapMm) return
  gapMm = next
  scheduleLayout()
}

export function setRelax(patch: Partial<{ boundary: boolean; repulsion: boolean }>): void {
  relax = { ...relax, ...patch }
  scheduleLayout()
}

export function setActiveStrategy(strategy: StrategyId): void {
  activeStrategy = strategy
}

export function setPreviewMode(mode: PreviewMode): void {
  previewMode = mode
}

export function setOverlayOpacity(opacity: number): void {
  overlayOpacity = Math.min(1, Math.max(0, opacity))
}

// ---------------------------------------------------------------------------
// 色板编辑器（引擎助手原地增删改）
// ---------------------------------------------------------------------------

export function upsertColor(color: PaletteColor): void {
  upsertPaletteColor(palette, color)
  recolorResults()
}

export function removeColor(id: string): void {
  removePaletteColor(palette, id)
  // 引用该色的覆写与其它块的映射一并失效重算
  for (const key of Object.keys(colorOverrides)) {
    if (colorOverrides[key] === id) delete colorOverrides[key]
  }
  recolorResults()
}

function nextPaletteId(): string {
  let n = palette.length + 1
  while (palette.some((c) => c.id === `c${n}`)) n++
  return `c${n}`
}

export function addColor(name: string, hex: string): void {
  upsertColor({ id: nextPaletteId(), name: name.trim() || '新颜色', hex })
}

// ---------------------------------------------------------------------------
// 五策略布局（300ms 防抖合并；单策略 try 隔离）
// ---------------------------------------------------------------------------

let layoutTimer: ReturnType<typeof setTimeout> | null = null
let layoutRun = 0
let layoutInflight: Promise<void> | null = null

export function scheduleLayout(): void {
  if (layoutTimer) clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    layoutTimer = null
    void runLayouts()
  }, LAYOUT_DEBOUNCE_MS)
}

/** 立即重算（跳过防抖；测试与「重新计算」入口共用） */
export function recompute(): void {
  if (layoutTimer) {
    clearTimeout(layoutTimer)
    layoutTimer = null
  }
  void runLayouts()
}

function cancelPending(): void {
  if (segmentTimer) {
    clearTimeout(segmentTimer)
    segmentTimer = null
  }
  if (layoutTimer) {
    clearTimeout(layoutTimer)
    layoutTimer = null
  }
  segmentRun++
  layoutRun++
  // 尽力而为取消在途 worker 任务（立即 reject；迟到结果靠 run 号丢弃）
  segmentHandle?.cancel()
  layoutHandle?.cancel()
  segmentHandle = null
  layoutHandle = null
}

/** 用户显式中断当前计算（进度徽章「取消」）：作废在途轮次并复位状态；之后的参数改动照常触发新轮 */
export function cancelCompute(): void {
  cancelPending()
  segmenting = false
  computing = false
  computeProgress = null
  segmentInflight = null
  layoutInflight = null
}

let layoutHandle: ComputeHandle | null = null

async function runLayouts(): Promise<void> {
  const run = ++layoutRun
  // 快照当前参数（异步期间用户可能继续改动；取消靠 run 号失效）
  const image = painting
  const blocksNow = effectiveBlocks.map((b) => ({ ...b }))
  const densityNow: Record<string, number> = { ...densitySpec }
  const gridNow: GridSpec = { ...grid }
  const relaxNow = { ...relax }

  if (!image || blocksNow.length === 0) {
    results = emptyResults()
    computing = false
    layoutInflight = null
    return
  }

  computing = true
  const promise = (async () => {
    for (let i = 0; i < STRATEGY_IDS.length; i++) {
      const sid = STRATEGY_IDS[i]
      if (run !== layoutRun) return
      // 进度与 computeCore 单元模型一致：segment 预完成 1 单元 + 已完成策略数
      computeProgress = {
        done: 1 + i,
        total: STRATEGY_IDS.length + 1,
        label: `${STRATEGY_LABELS[sid]} 排布中…`,
      }
      const t0 = performance.now()
      try {
        // 逐策略子轮（blocks 复用路径跳过分块）：结果渐进落地，单策略失败不拖垮其它策略
        const handle = runCompute({
          image,
          segmentOpts: {
            k: segK,
            seed: segSeed,
            gemDiameterPx: SEGMENT_GEM_DIAMETER_PX,
            minAreaPx: minAreaFor(image),
          },
          strategies: [sid],
          layoutOpts: { density: densityNow, seed: LAYOUT_SEED, relax: relaxNow },
          grid: gridNow,
          blocks: blocksNow,
        })
        layoutHandle = handle
        const { gems, warnings, dropped } = (await handle.promise).results[sid]
        if (run !== layoutRun) return
        applyColors(gems, blocksNow)
        results[sid] = {
          strategy: sid,
          gems,
          warnings,
          durationMs: performance.now() - t0,
          spacingCount: warnings.filter((w) => w.kind === 'spacing').length,
          dropped: dropped ?? 0,
        }
      } catch (error) {
        if (run !== layoutRun) return
        if (error instanceof ComputeAbortedError) return
        results[sid] = {
          strategy: sid,
          gems: [],
          warnings: [],
          durationMs: performance.now() - t0,
          spacingCount: 0,
          dropped: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  })()
  layoutInflight = promise
  try {
    await promise
  } finally {
    if (run === layoutRun) {
      computing = false
      layoutInflight = null
      computeProgress = null
    }
  }
}

/** mapColors 最近邻 + 块颜色覆写（不动几何，纯 colorId 后处理） */
function applyColors(gems: Gem[], blocksNow: Block[]): void {
  if (gems.length === 0) return
  if (palette.length === 0) return
  mapColors(gems, blocksNow, palette.map((c) => ({ ...c })))
  for (const gem of gems) {
    const override = colorOverrides[gem.blockId]
    if (override !== undefined) gem.colorId = override
  }
}

/** 色板/颜色覆写变更：在既有结果上原地重映射（不重跑几何） */
function recolorResults(): void {
  const blocksNow = effectiveBlocks.map((b) => ({ ...b }))
  const ids = new Set(blocksNow.map((b) => b.id))
  for (const sid of STRATEGY_IDS) {
    const res = results[sid]
    if (!res || res.gems.length === 0) continue
    if (!res.gems.every((g) => ids.has(g.blockId))) continue // 旧块集，等重算覆盖
    applyColors(res.gems, blocksNow)
  }
}

// ---------------------------------------------------------------------------
// 导出（SVG / BOM CSV；PNG 光栅化在 ExportBar 组件层用 canvas 完成）
// ---------------------------------------------------------------------------

function baseName(): string {
  const name = sourceImage?.name ?? 'rhinestone'
  return name.replace(/\.[^.]+$/, '') || 'rhinestone'
}

export function buildActiveSvg(): Blob | null {
  const res = activeResult
  const image = painting
  if (!res || !image || !exportCheck.exportable) return null
  return exportSvg({ gems: res.gems, warnings: res.warnings }, grid, {
    width: image.width,
    height: image.height,
    palette: palette.map((c) => ({ ...c })),
    blocks: effectiveBlocks,
    showBoundaries: true,
  })
}

export function buildActiveBom(): Blob | null {
  const res = activeResult
  if (!res || !exportCheck.exportable) return null
  return exportBom({ gems: res.gems, warnings: res.warnings }, palette.map((c) => ({ ...c })), grid)
}

export function exportFileName(ext: string): string {
  return `${baseName()}-${activeStrategy}.${ext}`
}

// ---------------------------------------------------------------------------
// 送精修（add-manual-edit-mode tasks 3.1）：工作台 → 手动编辑的显式交接构造
// ---------------------------------------------------------------------------

/**
 * 从当前工作台状态构造 ManualEditHandoff（深拷贝快照；edit store 侧还会再深拷贝一次收下）。
 * 无可送内容（无 activeResult / 计算失败 / 无像素）返回 null。
 */
export function buildManualEditHandoff(): ManualEditHandoff | null {
  const res = activeResult
  const image = painting
  if (!res || res.error || !image) return null
  return {
    gems: res.gems.map((g) => ({ ...g })),
    blocks: effectiveBlocks.map(copyBlockForHandoff),
    palette: palette.map((c) => ({ ...c })),
    grid: { ...grid },
    width: image.width,
    height: image.height,
    sourceSummary: `${STRATEGY_LABELS[activeStrategy]} · 密度 ${Math.round(globalDensity * 100)}% · ${ss} · ${res.gems.length} 钻`,
    paintingSnapshot: {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
    },
    referenceDataUrl: referenceImage?.dataUrl,
  }
}

function copyBlockForHandoff(b: Block): Block {
  return {
    ...b,
    colorRgb: [...b.colorRgb] as [number, number, number],
    bbox: { ...b.bbox },
    widthPx: { ...b.widthPx },
    mask: { w: b.mask.w, h: b.mask.h, bits: new Uint8Array(b.mask.bits) },
  }
}

// ---------------------------------------------------------------------------
// 测试支持
// ---------------------------------------------------------------------------

/** 等待防抖与计算全部落地（管线集成测试用） */
export async function waitForStudioIdle(): Promise<void> {
  for (let guard = 0; guard < 2000; guard++) {
    if (!segmentTimer && !layoutTimer && !segmentInflight && !layoutInflight) return
    if (segmentInflight) await segmentInflight.catch(() => undefined)
    else if (layoutInflight) await layoutInflight.catch(() => undefined)
    else await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitForStudioIdle 超时（2s×5ms 轮询上限）')
}

/** 测试专用：整体复位（清定时器/覆写/结果，色板还原起步色板） */
export function resetStudioForTests(): void {
  cancelPending()
  segmentInflight = null
  layoutInflight = null
  segmenting = false
  computing = false
  computeProgress = null
  sourceImage = null
  referenceImage = null
  painting = null
  loadError = null
  segK = 8
  segSeed = 1
  blocks = []
  disabledIds = {}
  densityOverrides = {}
  typeOverrides = {}
  colorOverrides = {}
  globalDensity = 1
  ss = 'SS10'
  gapMm = 0.4
  relax = { boundary: false, repulsion: false }
  palette.splice(0, palette.length, ...STARTER_PALETTE.map((c) => ({ ...c })))
  selectedBlockId = null
  activeStrategy = 'hybrid'
  previewMode = 'gems'
  overlayOpacity = 0.5
  results = emptyResults()
}
