/**
 * 智能排布（openspec add-project-files design §4 / tasks 3.1）：
 * 设计师工作台页四路 converge 入口之二——空态选图 → 默认参数一次 runCompute →
 * ManualEditHandoff 同构载荷。**不经 studio store**（直接消费 engine 公共面与
 * computeClient，零模块态耦合——studio 的分块/布局/取消/进度机器一概不触碰）。
 *
 * 正交意图：
 * 1. [2026-09-19 add-project-files 3.1] 默认参数单轮计算：segment k=8/seed=1 + hybrid 单策略，
 *    SS10/gap0.4/密度100%/relax 关——与 studio 初始态**同参**（design §4 条款；同图同参同出）。
 * 2. [参数固定禁令] API 形状不暴露任何计算参数（调参去排钻工作台页——编辑器永不长参数面板，
 *    概念混入禁令）；QUICK_LAYOUT_PARAMS 冻结只读，是文档不是入口。
 * 3. [同构载荷] 产物 = buildManualEditHandoff 的同构 ManualEditHandoff（字段一一对应：
 *    gems/blocks/palette/grid/width/height/sourceSummary/paintingSnapshot[/
 *    referenceAssetId——本路径无原图，缺席]）+ provenance.origin='quick-layout'
 *    （后续 3.2 序列化 .gemdoc 时的溯源录入）。
 * 4. [进度与取消] onProgress 直通 computeClient 阶段事件；AbortSignal 取消在途轮
 *    （handle.cancel → ComputeAbortedError，与 studio cancelCompute 同错误身份）。
 * 5. [2026-09-21 redesign-designer-workbench 7.1] 产物模式扩展：整文档 handoff（既有，
 *    冻结参数驱动——同参同出快照零改动）+ **钻数组（EditGem[] 规格物化，智能排布工具
 *    消费——design §5.3/§7.1-②）**。钻数组模式经 SmartLayoutSpecParams 接受策略×规格×
 *    gap×密度四参（PRODUCT_MODEL v6 硬规则 6 修订：显式工具允许自有参数小窗）；k/seed/
 *    layoutSeed/relax 仍为冻结缺省不暴露；计算内核（decode→segment→layout 编排）与
 *    进度/取消面两模式共用零改动。
 *
 * 解码链与 studio.svelte.ts 的 loadImageElement/imageToEngineImage 同构（blob → dataUrl →
 * Image → canvas ≤1024px 降采样）；因禁触 studio store，此处本地实现同一链。
 * 推导常量（MAX_IMAGE_DIM/SEGMENT_GEM_DIAMETER_PX/minAreaFor 算式）不冻结（design §1.1，
 * 归 engineVersion 语义）——与 studio 侧保持同值同式，改值必同步 bump ENGINE_VERSION。
 */

import {
  PIXELS_PER_MM,
  SS_TABLE,
  STARTER_PALETTE,
  gridFromSs,
  gridFromSpec,
  mapColors,
  type BaseSpec,
  type Block,
  type EditGem,
  type EngineImage,
  type Gem,
  type Palette,
  type StrategyId,
} from '$lib/engine'
import { blobToDataUrl } from '$lib/persistence/imageStore'
import type { ManualEditHandoff } from '$lib/stores/edit.svelte'
import { ComputeAbortedError, STRATEGY_LABELS, type ComputeOutput, type ComputeProgress } from '$lib/workers/computeCore'
import { runCompute } from '$lib/workers/computeClient'

// ---------------------------------------------------------------------------
// 冻结默认参数（与 studio 初始态同参——design §4；只读文档，非可调入口）
// ---------------------------------------------------------------------------

/** 智能排布默认参数快照（展示/断言用；Object.freeze 运行时只读）。 */
export const QUICK_LAYOUT_PARAMS = Object.freeze({
  /** 量化色数（studio 初始 segK=8） */
  k: 8,
  /** 分块种子（studio 初始 segSeed=1） */
  seed: 1,
  /** 布局种子（studio LAYOUT_SEED=1） */
  layoutSeed: 1,
  /** 钻尺寸（studio 初始 ss='SS10'） */
  ss: 'SS10' as const,
  /** 钻间距 mm（studio 初始 gapMm=0.4） */
  gapMm: 0.4,
  /** 全局密度（studio 初始 globalDensity=1 → 密度 100%；Record 缺省全块 1.0 → density: {}） */
  globalDensity: 1,
  /** 单轮策略（studio 初始 activeStrategy='hybrid'） */
  strategy: 'hybrid' as const,
  /** relax 双开关（studio 初始全关） */
  relax: Object.freeze({ boundary: false, repulsion: false }),
})

/** [gem-catalog 2.4] PIXELS_PER_MM 本地副本删除——import engine 单一出口；grid 以缺省 2.5 锚定
 *  （anchorSource:'default' 显式——画幅锚声明归 replay/handoff gate 接线，design §1.5）。 */
/** 大图降采样上限（与 studio.MAX_IMAGE_DIM 同值同式）。 */
const MAX_IMAGE_DIM = 1024
/** 分块类型推断钻径：SS10@2.5px/mm=7px（studio SEGMENT_GEM_DIAMETER_PX 同式；SS 切换不重分块）。 */
const SEGMENT_GEM_DIAMETER_PX = SS_TABLE[QUICK_LAYOUT_PARAMS.ss] * PIXELS_PER_MM

/** 连通域最小面积：随图尺寸缩放（studio minAreaFor 同式——推导常量，归 engineVersion 语义）。 */
function minAreaFor(image: EngineImage): number {
  return Math.min(4000, Math.max(12, Math.round(image.width * image.height * 0.0005)))
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface QuickLayoutOptions {
  /** 计算阶段事件直通（computeClient ComputeProgress：segment → layout:hybrid → done）。 */
  onProgress?: (progress: ComputeProgress) => void
  /** 取消信号：abort 时取消在途计算轮（ComputeAbortedError 上浮）。 */
  signal?: AbortSignal
}

/**
 * 智能排布产物：handoff 直接喂 edit store 的 loadFromHandoff（烘焙快照契约同送精修）；
 * provenance 供 3.2 序列化 .gemdoc 时录入溯源（origin='quick-layout'）。
 */
export interface QuickLayoutResult {
  handoff: ManualEditHandoff
  provenance: {
    origin: 'quick-layout'
    sourceSummary: string
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ComputeAbortedError()
}

// 解码链（与 studio loadImageElement/imageToEngineImage 同构；禁触 store → 本地实现）
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败（不支持的格式或损坏的文件）'))
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
  if (!ctx) throw new Error('Canvas 2D 不可用，无法解码图片')
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  return { width: w, height: h, data: data.data }
}

/** 深拷贝块（烘焙隔离；与 studio copyBlockForHandoff 同式）。 */
function copyBlock(b: Block): Block {
  return {
    ...b,
    colorRgb: [...b.colorRgb] as [number, number, number],
    bbox: { ...b.bbox },
    widthPx: { ...b.widthPx },
    mask: { w: b.mask.w, h: b.mask.h, bits: new Uint8Array(b.mask.bits) },
  }
}

/**
 * 空态选图 → 默认参数单轮排稿 → ManualEditHandoff 同构载荷（provenance=quick-layout）。
 * 失败形态：坏图（解码失败 Error）/ 计算 ComputeAbortedError（signal 取消）/ 引擎错误透传。
 */
export async function quickLayoutFromImage(
  blob: Blob,
  options: QuickLayoutOptions = {},
): Promise<QuickLayoutResult> {
  const signal = options.signal
  throwIfAborted(signal)
  const dataUrl = await blobToDataUrl(blob)
  throwIfAborted(signal)
  const image = imageToEngineImage(await loadImageElement(dataUrl), MAX_IMAGE_DIM)
  throwIfAborted(signal)

  const handle = runCompute(
    {
      image,
      segmentOpts: {
        k: QUICK_LAYOUT_PARAMS.k,
        seed: QUICK_LAYOUT_PARAMS.seed,
        gemDiameterPx: SEGMENT_GEM_DIAMETER_PX,
        minAreaPx: minAreaFor(image),
      },
      strategies: [QUICK_LAYOUT_PARAMS.strategy],
      layoutOpts: {
        density: {},
        seed: QUICK_LAYOUT_PARAMS.layoutSeed,
        relax: { ...QUICK_LAYOUT_PARAMS.relax },
      },
      grid: gridFromSs(QUICK_LAYOUT_PARAMS.ss, PIXELS_PER_MM, QUICK_LAYOUT_PARAMS.gapMm),
    },
    options.onProgress,
  )
  const onAbort = (): void => handle.cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  let output: ComputeOutput
  try {
    if (signal?.aborted) onAbort()
    output = await handle.promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return buildResult(output, image)
}

/** 计算产物 → 同构载荷（与 buildManualEditHandoff 字段一一对应；无原图 → referenceAssetId 缺席）。 */
function buildResult(output: ComputeOutput, image: EngineImage): QuickLayoutResult {
  const result = output.results[QUICK_LAYOUT_PARAMS.strategy]
  const palette: Palette = STARTER_PALETTE.map((c) => ({ ...c }))
  const gems: Gem[] = result.gems.map((g) => ({ ...g }))
  // 最近邻映射（studio applyColors 同式；本路径无颜色覆写）
  if (gems.length > 0 && palette.length > 0) mapColors(gems, output.blocks, palette)
  const sourceSummary = `${STRATEGY_LABELS[QUICK_LAYOUT_PARAMS.strategy]} · 密度 ${Math.round(
    QUICK_LAYOUT_PARAMS.globalDensity * 100,
  )}% · ${QUICK_LAYOUT_PARAMS.ss} · ${gems.length} 钻`
  return {
    handoff: {
      gems,
      blocks: output.blocks.map(copyBlock),
      palette,
      grid: gridFromSs(QUICK_LAYOUT_PARAMS.ss, PIXELS_PER_MM, QUICK_LAYOUT_PARAMS.gapMm),
      width: image.width,
      height: image.height,
      sourceSummary,
      paintingSnapshot: {
        width: image.width,
        height: image.height,
        data: new Uint8ClampedArray(image.data),
      },
    },
    provenance: { origin: 'quick-layout', sourceSummary },
  }
}

// ---------------------------------------------------------------------------
// [7.1] 钻数组产物模式（智能排布工具消费——design §5.3/§7.1-②；计算内核/冻结参数共用）
// ---------------------------------------------------------------------------

/**
 * 智能排布参数小窗四参（design §5.3「策略（五策略 Select）· 基础规格（目录档）· 间距 gapMm ·
 * 密度 %」——PRODUCT_MODEL v6 硬规则 6 修订：显式工具允许自有参数小窗；排钻工作台不迁移此面）。
 * k/seed/layoutSeed/relax 维持 QUICK_LAYOUT_PARAMS 冻结缺省，不经本类型暴露。
 */
export interface SmartLayoutSpecParams {
  /** 单轮策略（五策略之一）。 */
  strategy: StrategyId
  /** 基础规格（目录档 BaseSpec——形×径；custom 必带 assetId，gridFromSpec 标准构造入口消费）。 */
  spec: BaseSpec
  /** 间距 gapMm（0.4–0.8 同 studio 值域）。 */
  gapMm: number
  /** 密度（(0,1]——1 = 100%）。 */
  density: number
  /** 目标文档 px/mm（compute grid 锚——结果钻几何与目标文档物理一致；缺省 2.5 与冻结参数同锚）。 */
  pixelsPerMm?: number
}

/**
 * 钻数组产物：EditGem[] 规格物化（design §5.3「API 改造：产物从整文档 ManualEditHandoff
 * 改为钻数组」）——落点语义按 §4.1「新增（智能排布）」行：origin='manual'、blockId=null、
 * moved=false、规格字段按基础规格整组物化（engine makeGem 源头恒 round+grid 基准径——
 * 非圆规格身份在产物边界按层规格同式改写，gemprojReplay 物化同口径）。
 * id 为 engine layout 出口重编号（'g#####'，与既有来源钻同命名空间）——落点边界
 * （SmartLayoutPanel）必须以 nextManualId 重写防与既有钻碰撞（编辑器手工钻 'm-' 自增语义）。
 */
export interface SmartLayoutGemsResult {
  gems: EditGem[]
  /** 参与最近邻映射的色板（调用方传入目标文档色板——colorId 已映射到该色板条目）。 */
  palette: Palette
  sourceSummary: string
}

/**
 * 钻数组产物模式：底图 blob + 目标文档色板 + 参数小窗四参 → EditGem[]（规格物化）。
 * 计算链与整文档模式共用（decode → segment → layout；进度/取消语义一致——AbortSignal
 * 取消在途轮 ComputeAbortedError 上浮）。失败形态：坏图（解码失败 Error）/ ComputeAbortedError /
 * 引擎错误透传。
 */
export async function smartLayoutGemsFromImage(
  blob: Blob,
  palette: Palette,
  params: SmartLayoutSpecParams,
  options: QuickLayoutOptions = {},
): Promise<SmartLayoutGemsResult> {
  const signal = options.signal
  const pixelsPerMm = params.pixelsPerMm ?? PIXELS_PER_MM
  throwIfAborted(signal)
  const dataUrl = await blobToDataUrl(blob)
  throwIfAborted(signal)
  const image = imageToEngineImage(await loadImageElement(dataUrl), MAX_IMAGE_DIM)
  throwIfAborted(signal)

  const handle = runCompute(
    {
      image,
      segmentOpts: {
        k: QUICK_LAYOUT_PARAMS.k,
        seed: QUICK_LAYOUT_PARAMS.seed,
        gemDiameterPx: params.spec.diameterMm * pixelsPerMm,
        minAreaPx: minAreaFor(image),
      },
      strategies: [params.strategy],
      layoutOpts: {
        density: params.density,
        seed: QUICK_LAYOUT_PARAMS.layoutSeed,
        relax: { ...QUICK_LAYOUT_PARAMS.relax },
      },
      grid: gridFromSpec(params.spec, params.gapMm, pixelsPerMm),
    },
    options.onProgress,
  )
  const onAbort = (): void => handle.cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  let output: ComputeOutput
  try {
    if (signal?.aborted) onAbort()
    output = await handle.promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return buildGemsResult(output, palette, params)
}

/** 计算产物 → EditGem[] 规格物化（mapColors 最近邻 → 层规格整组改写 → manual 钻语义）。 */
function buildGemsResult(
  output: ComputeOutput,
  palette: Palette,
  params: SmartLayoutSpecParams,
): SmartLayoutGemsResult {
  const layoutGems: Gem[] = output.results[params.strategy].gems.map((g) => ({ ...g }))
  // 最近邻映射（目标文档色板——结果钻 colorId 即取该色板条目）
  if (layoutGems.length > 0 && palette.length > 0) mapColors(layoutGems, output.blocks, palette)
  const spec = params.spec
  const gems: EditGem[] = layoutGems.map((g) => ({
    id: g.id,
    x: g.x,
    y: g.y,
    colorId: g.colorId,
    blockId: null, // 智能排布产物 = 新增 manual 钻（design §4.1「新增」行——不携带来源块引用）
    origin: 'manual',
    moved: false,
    shapeId: spec.shapeId,
    diameterMm: spec.diameterMm,
    ...(spec.shapeId === 'custom' && spec.assetId !== undefined ? { assetId: spec.assetId } : {}),
  }))
  const sourceSummary = `${STRATEGY_LABELS[params.strategy]} · 密度 ${Math.round(params.density * 100)}% · ${spec.sizeLabel} · ${gems.length} 钻`
  return { gems, palette, sourceSummary }
}
