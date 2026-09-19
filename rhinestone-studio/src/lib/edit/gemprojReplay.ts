/**
 * gemproj → 专家工作台的引擎重放（openspec add-project-files design §4 / [Owner 本轮明示]
 * 「素材库/选图器选 .gemproj → 自动格式转化」）：编辑页第四入口的装配管线。
 *
 * [studio-layers 1.5] v2 六步链（图层稿 §E.5 / P0-4 冻结）：
 *   1. segment 一次（全局单轮 k/seed，空轮取块）；
 *   2. 解析唯一 rest + 显式层 → 各层成员（rest = 分块结果 − 显式层并集）；
 *   3. 每层派生 effectiveBlocks / density（两级回落）/ grid（gridFromSpec 按层 specKey）
 *      ——2/3 步 = lib/edit/replayLayers.ts 纯函数内核；
 *   4. 逐层 computeLayer（lib/studio/computeLayer.ts 单一入口——runCompute 单请求形状，
 *      LAYOUT_SEED=1 同 seed 纪律；onProgress 带层名；AbortSignal 作废在途层轮）；
 *   5. 全层 concat → 统一 pairwise / exportGate（lib/studio/jointGate.ts——层序组织；
 *      判据/门 = engine 已证；replay 非导出路径不阻断，违规摘要上浮）；
 *   6. handoff 携带逐钻规格快照 + PhysicalCanvas（pixelsPerMm = 实际降采样 canvas 宽 ÷
 *      widthMm 锚定——物理锚缺席 = default 显式合成）。
 * v1 消费点（gridFromSs(file.physics.ss)/overrides/单策略布局）全退役——layers[] 直消费，
 * 非圆钻 specKey 解除 v1 读面 typed 拒绝（resolveSpecForKey builtin 反解/custom 注入目录）。
 *
 * 正交意图：
 * 1. [重放保真] 六步链与 studio 管线同构（computeLayer 兼容性由 1.1 oracle harness 证明）；
 *    v1 工程迁移后单 rest 层 ⇔ 旧整图单策略（v1 fixture 逐位相等守卫，tests/edit/gemprojReplay.test.ts）。
 * 2. [漂移诚实] engineVersion 不等不阻断；悬空覆写键逐层清点合计上浮 droppedOverrides；
 *    custom specKey 资产 missing 四态 = SpecKeyResolveError typed 上浮（禁静默降级圆钻）。
 * 3. [B2 单点] 来源 asset 形态的图片字节只经 getHandoffImageBlob；missing/损坏 typed error。
 * 4. [进度与取消] onProgress：segment「正在分块…」+ 逐层「层「N」排布中…」；
 *    AbortSignal 取消在途层轮（ComputeAbortedError）。
 */

import {
  PIXELS_PER_MM,
  SS_TABLE,
  mapColors,
  type Block,
  type EngineImage,
  type Gem,
  type GridSpec,
  type Palette,
} from '$lib/engine'
import { getProject } from '$lib/persistence/assetStore'
import { resolveGemshapeRefState } from '$lib/persistence/assetStore'
import { blobToDataUrl, dataUrlToBlob, getImageBlob } from '$lib/persistence/imageStore'
import { getHandoffImageBlob } from '$lib/persistence/handoffImage'
import { parseGemproj, type GemprojFile, type GemprojSource } from '$lib/persistence/projectFile'
import { parseGemshape } from '$lib/persistence/gemshapeFile'
import { defaultPhysicalCanvasOf, type ManualEditHandoff } from '$lib/stores/edit.svelte'
import { layerSourceSummaryFor } from '$lib/studio/editHandoff.svelte'
import { computeLayer } from '$lib/studio/computeLayer'
import { jointExportGate } from '$lib/studio/jointGate'
import { resolveLayerPlans, SpecKeyResolveError, type CustomSpecResolution, type CustomSpecResolver } from '$lib/edit/replayLayers'
import { ComputeAbortedError, type ComputeProgress } from '$lib/workers/computeCore'
import { runCompute } from '$lib/workers/computeClient'

// ---------------------------------------------------------------------------
// 与 studio 同值同式的推导常量（studio.svelte.ts 冻结副本；禁触 store → 本地实现）。
// [gem-catalog 2.4] PIXELS_PER_MM 本地副本删除——import engine 单一出口（同值 2.5，行为零变化）。
// ---------------------------------------------------------------------------

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
  /** 计算阶段事件（segment「正在分块…」+ 逐层「层「N」排布中…」）。 */
  onProgress?: (progress: ComputeProgress) => void
  /** 取消信号：abort 时取消在途层轮（ComputeAbortedError 上浮）。 */
  signal?: AbortSignal
  /** custom specKey 目录解析注入（测试 stub；生产缺省 = 素材库 .gemshape 真源 adapter）。 */
  resolveCustom?: CustomSpecResolver
}

/** 联合导出门摘要（判据/门 = engine 已证；replay 非导出路径不阻断——硬阻断消费归 ④段导出四路）。 */
export interface JointGateSummary {
  ok: boolean
  /** engine 平面违规总数（spacing/mask/missing-asset）。 */
  violations: number
  /** 层对分组数（intra/inter——§2.7 状态条违规清单 ▾ 数据面）。 */
  groups: number
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
  /** 悬空覆写键计数（逐层清点合计——引擎重分块漂移的显式清单，调用方单次提示）。 */
  droppedOverrides: number
  /** 重放工作像与文件记录尺寸不一致（引擎演进/文件漂移诊断位——以实测 canvas 为准）。 */
  dimsMismatch: boolean
  /** 全层 concat 联合 exportGate 摘要（六步链第 5 步产物）。 */
  jointGate: JointGateSummary
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
 * custom specKey 的生产目录 adapter（素材库 .gemshape 真源；lib 纯度——replay 内核经注入消费）：
 * 四态镜像 resolveGemshapeRefState（resolved/soft-deleted/blob-missing/wrong-kind/null）；
 * resolved 态再读资产文件物化 BaseSpec（diameterMm = max(物理宽高)；sizeLabel = 资产名——
 * gemCatalog 自定义条目同式）。resolved 与目录读不一致（坏档）→ wrong-kind 归档。
 */
const libraryCustomSpecResolver: CustomSpecResolver = async (assetId: string): Promise<CustomSpecResolution> => {
  const state = await resolveGemshapeRefState(assetId)
  if (state !== 'resolved') return { state }
  const node = await getProject(assetId)
  if (node === null || node.projectKind !== 'gemshape') return { state: 'wrong-kind' }
  const blob = await getImageBlob(node.blobKey).catch(() => null)
  if (blob === null) return { state: 'blob-missing' }
  try {
    const file = parseGemshape(new TextDecoder().decode(await blob.arrayBuffer()), { mime: node.mime })
    return {
      state: 'resolved',
      spec: {
        shapeId: 'custom',
        sizeLabel: node.name.replace(/\.gemshape$/, ''),
        diameterMm: Math.max(file.physical.widthMm, file.physical.heightMm),
        widthMm: file.physical.widthMm,
        heightMm: file.physical.heightMm,
        assetId,
      },
    }
  } catch {
    return { state: 'wrong-kind' } // 四态定义：wrong-kind 涵盖 parse 失败档（resolveGemshapeRefState 同式）
  }
}

/**
 * 重放核心（六步链）：GemprojFile + 来源图字节 → ManualEditHandoff v2 载荷。
 * 失败形态：坏图（解码失败 Error）/ ComputeAbortedError（signal）/ SpecKeyResolveError
 * （specKey 不可解析——custom missing 四态/builtin 非法）/ 引擎错误透传。
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

  // ---- 段一（六步链第 1 步）：segment 空轮取块（studio runSegment 同构——runCompute 单请求形状） ----
  const segmentRun = runCompute(
    { image, segmentOpts, strategies: [], layoutOpts: { density: {}, seed: LAYOUT_SEED, relax: { boundary: false, repulsion: false } }, grid: { pitchMm: SEGMENT_GEM_DIAMETER_PX, gapMm: 0, rowAngleDeg: 0, pixelsPerMm: PIXELS_PER_MM } },
    options.onProgress,
  )
  const blocks = (await awaitCompute(segmentRun.promise, segmentRun, signal)).blocks

  // ---- 六步链第 2/3 步：层成员解析 + 每层派生（replayLayers 纯函数内核） ----
  const plan = await resolveLayerPlans(
    file.layers,
    blocks,
    image.width,
    file.physicalCanvas,
    options.resolveCustom ?? libraryCustomSpecResolver,
  )
  const droppedOverrides = Object.values(plan.droppedOverridesByLayer).reduce((a, b) => a + b, 0)
  const palette: Palette = file.palette.map((c) => ({ ...c }))

  // ---- 六步链第 4 步：逐层 computeLayer + 层内色映射（v1 applyColors 同式） ----
  // 跨层 id 命名空间归并：每层产物沿用引擎 g##### 自增序列（层间重复）——concat 前按层序
  // 全局重编号（单层 = 恒等映射：引擎出口序即全局序，v1 逐位相等不受影响）。
  const layerGems: Gem[][] = []
  const layerBlocks: Block[][] = []
  let gemSeq = 0
  for (const layerPlan of plan.layers) {
    throwIfAborted(signal)
    const run = computeLayer(
      {
        image,
        segmentOpts,
        strategy: layerPlan.record.strategy,
        layoutOpts: { density: layerPlan.density, seed: LAYOUT_SEED, relax: { ...layerPlan.record.physics.relax } },
        grid: layerPlan.grid,
        blocks: layerPlan.effectiveBlocks.map((b) => ({ ...b })),
        progressLayerName: layerPlan.record.name,
      },
      options.onProgress,
    )
    const output = await awaitCompute(run.promise, run, signal)
    // 逐钻规格快照物化：engine makeGem 源头戳恒 'round'+grid 基准径（布局输入恒单 spec 的
    // 圆钻产物口径）；非圆钻层的层规格身份（shapeId/assetId）在此按层物化——round 层为恒等
    // 变换（v1 逐位相等不受影响），square/custom 层的 BOM specKey×colorId 投影因此正确。
    const spec = layerPlan.spec
    const gems: Gem[] = output.gems.map((g) => ({
      ...g,
      id: `g${String(++gemSeq).padStart(5, '0')}`,
      shapeId: spec.shapeId,
      diameterMm: spec.diameterMm,
      ...(spec.shapeId === 'custom' && spec.assetId !== undefined ? { assetId: spec.assetId } : {}),
    }))
    // mapColors 最近邻（块级映射——按层调用与整图调用同结果）+ 层颜色覆写（不动几何）
    if (gems.length > 0 && palette.length > 0) mapColors(gems, layerPlan.effectiveBlocks, palette)
    for (const gem of gems) {
      const override = layerPlan.record.overrides.color[gem.blockId]
      if (override !== undefined) gem.colorId = override
    }
    layerGems.push(gems)
    layerBlocks.push(layerPlan.effectiveBlocks)
  }

  // ---- 六步链第 5 步：全层 concat → 联合 pairwise/exportGate（jointGate 层序组织） ----
  const allGems = layerGems.flat()
  const jointBlocks = layerBlocks.flat()
  const gate = jointExportGate(
    plan.layers.map((lp, i) => ({
      layerId: lp.record.id,
      layerName: lp.record.name,
      gapMm: lp.record.physics.gapMm,
      gems: layerGems[i],
    })),
    { pixelsPerMm: plan.pixelsPerMm, blocks: jointBlocks },
  )

  // ---- 六步链第 6 步：handoff（逐钻规格快照 + PhysicalCanvas） ----
  // 参考网格 = 兜底层 grid（v1 等价：rest 层即旧整图策略；逐钻规格字段即物理真源）
  const grid: GridSpec = plan.layers[plan.restLayerIndex].grid
  const sourceSummary = layerSourceSummaryFor(file.layers.length, allGems, grid)
  return {
    handoff: {
      gems: allGems,
      blocks: jointBlocks.map(copyBlockForHandoff),
      palette,
      grid,
      width: image.width,
      height: image.height,
      sourceSummary,
      paintingSnapshot: { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) },
      referenceAssetId: file.reference?.assetId,
      physicalCanvas: file.physicalCanvas ?? defaultPhysicalCanvasOf(image.width, image.height, plan.pixelsPerMm),
    },
    provenance: { origin: 'studio-bake', sourceSummary, gemprojAssetId: context.gemprojAssetId },
    name: context.gemprojName.replace(/\.gemproj$/, ''),
    droppedOverrides,
    dimsMismatch,
    jointGate: { ok: gate.verdict.ok, violations: gate.verdict.violations.length, groups: gate.groups.length },
  }
}

/**
 * 库内 gemproj 节点 → 重放（节点校验 + blob 读取 + parseGemproj 交叉校验 + replayGemproj）。
 * 失败形态：非 gemproj 节点 / 已软删 / 物理记录缺失 / 文件层 typed error（含 SpecKeyResolveError）/ 来源图 missing。
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

// 让 SpecKeyResolveError 可被调用方 instanceof 消费（typed error 家族公共面）
export { SpecKeyResolveError }
