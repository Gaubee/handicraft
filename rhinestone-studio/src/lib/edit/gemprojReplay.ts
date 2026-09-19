/**
 * gemproj → 专家工作台的引擎重放（openspec add-project-files design §4 / [Owner 本轮明示]
 * 「素材库/选图器选 .gemproj → 自动格式转化」）：编辑页第四入口的装配管线。
 *
 * 与 buildManualEditHandoff 同构（studio 管线的参数化复刻）但**不经 studio store**——
 * 直接消费 engine 公共面 + computeClient（沿 quickLayout.ts 同族纪律）：
 * parseGemproj → 来源图解码（asset 引用经 getHandoffImageBlob 单点 / embedded 直解）→
 * segment 重分块 → 覆写应用（disabled 过滤 / type 换 suggested / density Record 合成）→
 * activeStrategy 单轮布局 → mapColors + color 覆写 → ManualEditHandoff 同构载荷 +
 * provenance{origin:'studio-bake', gemprojAssetId} → 未保存新文档（调用方 loadFromHandoff）。
 *
 * 正交意图：
 * 1. [重放保真] 两段 compute 与 studio runSegment→runLayouts 同构（segment 空轮取块 →
 *    effectiveBlocks 复用路径单策略布局）；同图同参同出（与 quickLayout 默认参等价时逐字段相等）。
 * 2. [漂移诚实] engineVersion 不等不阻断（gemdoc 烘焙语义：结果即当前引擎产物）；悬空覆写键
 *    （块 id 已不存在）计数上浮 droppedOverrides 由调用方单次提示——不静默吞。
 * 3. [B2 单点] 来源 asset 形态的图片字节只经 getHandoffImageBlob（图片直取 / gemgen 解内嵌）；
 *    missing/损坏 typed error 上浮为转化失败。
 * 4. [进度与取消] onProgress 直通 computeClient 阶段事件（label 人类可读：正在分块…/X 排布中…）；
 *    AbortSignal 取消在途轮（ComputeAbortedError）。
 *
 * 解码链与 studio/quickLayout 同构（blob → dataUrl → Image → canvas ≤1024px 降采样），本地实现
 * 同一链（禁触 store）；推导常量（SEGMENT_GEM_DIAMETER_PX/minAreaFor/PIXELS_PER_MM）不冻结
 * （design §1.1 归 engineVersion 语义），与 studio 侧保持同值同式，改值必同步 bump ENGINE_VERSION。
 */

import { SS_TABLE, gridFromSs, mapColors, type Block, type EngineImage, type Gem, type Palette } from '$lib/engine'
import { getProject } from '$lib/persistence/assetStore'
import { blobToDataUrl, dataUrlToBlob, getImageBlob } from '$lib/persistence/imageStore'
import { getHandoffImageBlob } from '$lib/persistence/handoffImage'
import { parseGemproj, type GemprojFile, type GemprojSource } from '$lib/persistence/projectFile'
import type { ManualEditHandoff } from '$lib/stores/edit.svelte'
import { ComputeAbortedError, STRATEGY_LABELS, type ComputeProgress } from '$lib/workers/computeCore'
import { runCompute } from '$lib/workers/computeClient'

// ---------------------------------------------------------------------------
// 与 studio 同值同式的推导常量（studio.svelte.ts 冻结副本；禁触 store → 本地实现）
// ---------------------------------------------------------------------------

/** px↔mm 唯一换算系数（studio.PIXELS_PER_MM 同值）。 */
const PIXELS_PER_MM = 2.5
/** 大图降采样上限（studio.MAX_IMAGE_DIM 同值）。 */
const MAX_IMAGE_DIM = 1024
/** 布局种子（studio LAYOUT_SEED 同值——gemproj 不存布局种子，恒 1）。 */
const LAYOUT_SEED = 1
/** 分块类型推断钻径：SS10@2.5px/mm=7px（studio SEGMENT_GEM_DIAMETER_PX 同式；SS 不重分块）。 */
const SEGMENT_GEM_DIAMETER_PX = SS_TABLE.SS10 * PIXELS_PER_MM

/** 连通域最小面积：随图尺寸缩放（studio minAreaFor 同式）。 */
function minAreaFor(image: EngineImage): number {
  return Math.min(4000, Math.max(12, Math.round(image.width * image.height * 0.0005)))
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface GemprojReplayOptions {
  /** 计算阶段事件直通（segment 空轮 + 单策略布局轮，各自带 label）。 */
  onProgress?: (progress: ComputeProgress) => void
  /** 取消信号：abort 时取消在途计算轮（ComputeAbortedError 上浮）。 */
  signal?: AbortSignal
}

export interface GemprojReplayResult {
  /** 直接喂 edit store 的 loadFromHandoff（meta 由调用方按 provenance 装配）。 */
  handoff: ManualEditHandoff
  provenance: {
    origin: 'studio-bake'
    sourceSummary: string
    gemprojAssetId: string
  }
  /** 重放文档名建议（gemproj 节点名去扩展名）。 */
  name: string
  /** 悬空覆写键计数（块 id 已不存在——引擎重分块漂移的显式清单，调用方单次提示）。 */
  droppedOverrides: number
  /** 重放工作像与文件记录尺寸不一致（引擎演进/文件漂移诊断位）。 */
  dimsMismatch: boolean
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ComputeAbortedError()
}

// 解码链（studio loadImageElement/imageToEngineImage 同构；禁触 store → 本地实现）
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('来源图解码失败（不支持的格式或损坏的文件）'))
    img.src = src
  })
}

function imageToEngineImage(img: HTMLImageElement, maxDim: number): EngineImage {
  const downscale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * downscale))
  const h = Math.max(1, Math.round(img.naturalHeight * downscale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D 不可用，无法解码来源图')
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  return { width: w, height: h, data: data.data }
}

/** 深拷贝块（烘焙隔离；与 studio copyBlockForHandoff 同式）。 */
function copyBlockForHandoff(b: Block): Block {
  return {
    ...b,
    colorRgb: [...b.colorRgb] as [number, number, number],
    bbox: { ...b.bbox },
    widthPx: { ...b.widthPx },
    mask: { w: b.mask.w, h: b.mask.h, bits: new Uint8Array(b.mask.bits) },
  }
}

/** 挂取消监听的 compute 等待（quickLayoutFromImage 同式）。 */
async function awaitCompute<T>(
  promise: Promise<T>,
  handle: { cancel(): void },
  signal: AbortSignal | undefined,
): Promise<T> {
  const onAbort = (): void => handle.cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal?.aborted) onAbort()
    return await promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 来源双形态 → 图片字节（asset 经 B2 单点 getHandoffImageBlob；embedded dataUrl 直解零重编码）。 */
async function resolveSourceBlob(source: GemprojSource): Promise<Blob> {
  if (source.kind === 'embedded') return dataUrlToBlob(source.dataUrl)
  return getHandoffImageBlob(source.assetId)
}

/**
 * 重放核心：GemprojFile + 来源图字节 → ManualEditHandoff 同构载荷。
 * 失败形态：坏图（解码失败 Error）/ ComputeAbortedError（signal）/ 引擎错误透传。
 */
export async function replayGemproj(
  file: GemprojFile,
  sourceBlob: Blob,
  context: { gemprojAssetId: string; gemprojName: string },
  options: GemprojReplayOptions = {},
): Promise<GemprojReplayResult> {
  const signal = options.signal
  throwIfAborted(signal)
  const dataUrl = await blobToDataUrl(sourceBlob)
  throwIfAborted(signal)
  const image = imageToEngineImage(await loadImageElement(dataUrl), MAX_IMAGE_DIM)
  throwIfAborted(signal)
  const dimsMismatch = image.width !== file.source.width || image.height !== file.source.height

  const segmentOpts = {
    k: file.segment.k,
    seed: file.segment.seed,
    gemDiameterPx: SEGMENT_GEM_DIAMETER_PX,
    minAreaPx: minAreaFor(image),
  }
  const grid = gridFromSs(file.physics.ss, PIXELS_PER_MM, file.physics.gapMm)
  const relax = { boundary: file.physics.relax.boundary, repulsion: file.physics.relax.repulsion }

  // 段一：segment 空轮取块（studio runSegment 同构）
  const segmentRun = runCompute(
    { image, segmentOpts, strategies: [], layoutOpts: { density: {}, seed: LAYOUT_SEED, relax }, grid },
    options.onProgress,
  )
  const blocks = (await awaitCompute(segmentRun.promise, segmentRun, signal)).blocks

  // 覆写应用（studio effectiveBlocks/densitySpec 同构）+ 悬空键清点（漂移显式清单）
  const blockIds = new Set(blocks.map((b) => b.id))
  let droppedOverrides = 0
  for (const key of [
    ...Object.keys(file.overrides.disabled),
    ...Object.keys(file.overrides.density),
    ...Object.keys(file.overrides.type),
    ...Object.keys(file.overrides.color),
  ]) {
    if (!blockIds.has(key)) droppedOverrides += 1
  }
  const effectiveBlocks: Block[] = blocks
    .filter((b) => file.overrides.disabled[b.id] !== true)
    .map((b) => {
      const typeOverride = file.overrides.type[b.id]
      return typeOverride !== undefined && typeOverride !== b.suggested ? { ...b, suggested: typeOverride } : b
    })
  const density: Record<string, number> = {}
  for (const b of effectiveBlocks) {
    // 显式覆写全量（含恰为 1.0）；Record 缺省块默认 1.0 → 恰为 1 的键省略（引擎侧语义）
    const d = file.overrides.density[b.id] ?? file.physics.globalDensity
    if (d !== 1) density[b.id] = d
  }

  throwIfAborted(signal)
  // 段二：单策略布局（blocks 复用路径——studio runLayouts 单轮同构）
  const layoutRun = runCompute(
    {
      image,
      segmentOpts,
      strategies: [file.activeStrategy],
      layoutOpts: { density, seed: LAYOUT_SEED, relax },
      grid,
      blocks: effectiveBlocks.map((b) => ({ ...b })),
    },
    options.onProgress,
  )
  const result = (await awaitCompute(layoutRun.promise, layoutRun, signal)).results[file.activeStrategy]

  // mapColors 最近邻 + 块颜色覆写（studio applyColors 同式，不动几何）
  const palette: Palette = file.palette.map((c) => ({ ...c }))
  const gems: Gem[] = result.gems.map((g) => ({ ...g }))
  if (gems.length > 0 && palette.length > 0) mapColors(gems, effectiveBlocks, palette)
  for (const gem of gems) {
    const override = file.overrides.color[gem.blockId]
    if (override !== undefined) gem.colorId = override
  }

  const sourceSummary = `${STRATEGY_LABELS[file.activeStrategy]} · 密度 ${Math.round(
    file.physics.globalDensity * 100,
  )}% · ${file.physics.ss} · ${gems.length} 钻`
  return {
    handoff: {
      gems,
      blocks: effectiveBlocks.map(copyBlockForHandoff),
      palette,
      grid,
      width: image.width,
      height: image.height,
      sourceSummary,
      paintingSnapshot: { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) },
      referenceAssetId: file.reference?.assetId,
    },
    provenance: { origin: 'studio-bake', sourceSummary, gemprojAssetId: context.gemprojAssetId },
    name: context.gemprojName.replace(/\.gemproj$/, ''),
    droppedOverrides,
    dimsMismatch,
  }
}

/**
 * 库内 gemproj 节点 → 重放（节点校验 + blob 读取 + parseGemdoc 交叉校验 + replayGemproj）。
 * 失败形态：非 gemproj 节点 / 已软删 / 物理记录缺失 / 文件层 typed error / 来源图 missing。
 */
export async function replayGemprojAsset(assetId: string, options: GemprojReplayOptions = {}): Promise<GemprojReplayResult> {
  const node = await getProject(assetId)
  if (node === null || node.projectKind !== 'gemproj') {
    throw new Error(node === null ? '排钻项目不存在（可能已被删除）。' : `目标不是排钻项目（.gemproj），而是 ${node.projectKind}。`)
  }
  if (node.trashedAt !== undefined) throw new Error('排钻项目已在回收站，可还原后再转化。')
  const blob = await getImageBlob(node.blobKey).catch(() => null)
  if (blob === null) throw new Error('排钻项目的文件内容已缺失（物理记录丢失）。')
  const text = new TextDecoder().decode(await blob.arrayBuffer())
  const file = parseGemproj(text, { mime: node.mime })
  return replayGemproj(file, await resolveSourceBlob(file.source), { gemprojAssetId: assetId, gemprojName: node.name }, options)
}
