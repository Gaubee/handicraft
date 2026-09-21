/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-21 redesign-designer-workbench 5.1] 空态三入口的文档构造器（design §5.1）：
 *    ① 选图新建（主入口）——图片仅作参考底图：gems=0（**绝不动算法**——不 import quickLayout/
 *    computeClient，排稿只能经 7.x 智能排布工具显式触发）；underlay 只增 reference 源
 *    （visible/1.0，§4.2「painting/blocks 无源」）；画幅 default 锚（px ÷ 2.5 px/mm，§5.2）。
 *    ② 空白新建——无原图空文档，缺省画幅 200×200mm（占位缺省，状态栏可改）。
 * 2. [Upload 路径] 上传文件先入库（ingestAsset → sys-uploads——沿 studio loadFromFile 先例：
 *    原图是不可变资产，参考底图恒以资产引用承载；入库失败显式报错不静默降级），随后与库选
 *    同一构造链。
 * 3. [装配边界] 文档装配复用 loadFromHandoff（计数器/撤销栈/租约/pin/dirty 编排零重写），
 *    装载后一次修正新文档身份面（underlay 源集 / 名称 / 溯源摘要——design §4.2 空白起步形态
 *    与 loadFromHandoff 的送精修缺省装配的分叉点，全部直改 $state doc，与 saveGemdoc 写
 *    current.name 同式）。
 * 4. [解码] 只测像素尺寸（naturalWidth/Height），不解码像素（原图字节由画布经资产
 *    objectURL 异步解析——与 quickLayout 解码链同源式但无 canvas 2d 依赖；≤1024 降采样
 *    与 MAX_IMAGE_DIM 同值语义：画幅像素 = 降采样后尺寸）。
 */

import {
  PIXELS_PER_MM,
  STARTER_PALETTE,
  gridFromSs,
  type EngineImage,
} from '$lib/engine'
import { blobToDataUrl } from '$lib/persistence/imageStore'
import { ingestAsset } from '$lib/persistence/assetStore'
import {
  defaultPhysicalCanvasOf,
  getEditDoc,
  loadFromHandoff,
  type ManualEditHandoff,
} from '$lib/stores/edit.svelte'

/** 与 quickLayout/studio MAX_IMAGE_DIM 同值的降采样上限（推导常量——改值必同步 ENGINE_VERSION）。 */
const MAX_IMAGE_DIM = 1024

/** 空白新建缺省画幅（design §5.1 裁断：占位缺省 200×200mm，状态栏 popover 可改 declared）。 */
export const BLANK_CANVAS_MM = 200

/** 新文档缺省名（design §5.1：首次保存可改名）。 */
export const UNTITLED_DOC_NAME = '设计 · 未命名'

/** 空白起步的 painting 占位（1×1 透明——参考层无 painting 载荷；序列化/回读同式）。 */
function blankPaintingSnapshot(): EngineImage {
  return { width: 1, height: 1, data: new Uint8ClampedArray(4) }
}

// ---------------------------------------------------------------------------
// 尺寸解码（blob → dataUrl → Image natural 尺寸——无 canvas 2d 依赖）
// ---------------------------------------------------------------------------

interface DecodedImageSize {
  /** 降采样后的画幅像素（≤1024 长边）。 */
  width: number
  height: number
  /** 原图自然尺寸（入库 width/height 用）。 */
  naturalWidth: number
  naturalHeight: number
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败（不支持的格式或损坏的文件）'))
    img.src = src
  })
}

/** 图片像素尺寸（≤1024 长边降采样与 quickLayout 同式——画幅像素锚定降采样后尺寸）。 */
async function measureImage(blob: Blob): Promise<DecodedImageSize> {
  const dataUrl = await blobToDataUrl(blob)
  const img = await loadImageElement(dataUrl)
  const downscale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.naturalWidth, img.naturalHeight))
  return {
    width: Math.max(1, Math.round(img.naturalWidth * downscale)),
    height: Math.max(1, Math.round(img.naturalHeight * downscale)),
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  }
}

// ---------------------------------------------------------------------------
// 新文档装配（loadFromHandoff 编排复用 + 空白起步身份修正）
// ---------------------------------------------------------------------------

/** 画幅级参考网格缺省（SS10@2.5px/mm + gap 0.4——与 quickLayout 冻结参数同基准）。 */
function blankStartGrid() {
  return gridFromSs('SS10', PIXELS_PER_MM)
}

/**
 * 装载后的空白起步身份修正（design §4.2/§5.1 分叉点）：
 * underlay 源集（选图 = 仅 reference 1.0 / 空白 = 无源）+ 文档名 + 溯源摘要。
 */
function applyBlankStartIdentity(options: {
  reference: boolean
  sourceSummary: string
}): void {
  const doc = getEditDoc()
  if (doc === null) return
  doc.underlay.sources = options.reference
    ? [{ key: 'reference', visible: true, opacity: 1 }]
    : []
  doc.name = UNTITLED_DOC_NAME
  doc.sourceSummary = options.sourceSummary
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * 选图新建（主入口，design §5.1）：画布 = 参考底图 + **0 颗钻**（绝不自动排稿）。
 * 参考底图以资产引用承载（assetId 必填——上传路径先 ingestAsset 再进此函数）。
 * 画幅 = default 锚（降采样后 px ÷ 2.5 px/mm，anchorSource 显式）。
 */
export async function createDocumentFromImage(input: {
  assetId: string
  blob: Blob
  /** 资产显示名（溯源摘要人读）。 */
  name: string
}): Promise<void> {
  const size = await measureImage(input.blob)
  const handoff: ManualEditHandoff = {
    gems: [], // 绝不动算法：选图 ≠ 排稿（纠偏 add-project-files 3.3 硬规则）
    blocks: [],
    palette: STARTER_PALETTE.map((c) => ({ ...c })),
    grid: blankStartGrid(),
    width: size.width,
    height: size.height,
    sourceSummary: `原图起步 · ${input.name}`,
    paintingSnapshot: blankPaintingSnapshot(),
    referenceAssetId: input.assetId,
    physicalCanvas: defaultPhysicalCanvasOf(size.width, size.height, PIXELS_PER_MM),
  }
  loadFromHandoff(handoff, { origin: 'blank', sourceAssetId: input.assetId, name: UNTITLED_DOC_NAME })
  applyBlankStartIdentity({ reference: true, sourceSummary: `原图起步 · ${input.name}` })
}

/**
 * 上传文件 → 选图新建：先入库 sys-uploads（原图是不可变资产；沿 studio loadFromFile 先例）
 * 再走同一构造链。入库失败 = 显式失败（参考底图无资产引用可承载，不静默降级为无参考文档）。
 */
export async function createDocumentFromUpload(file: File): Promise<void> {
  const size = await measureImage(file)
  const ingested = await ingestAsset({
    blob: file,
    name: file.name,
    width: size.naturalWidth,
    height: size.naturalHeight,
    parentId: 'sys-uploads',
    source: 'upload',
  })
  await createDocumentFromImage({ assetId: ingested.node.id, blob: file, name: ingested.node.name })
}

/**
 * 空白新建（次入口，design §5.1）：无原图空文档，缺省画幅 200×200mm（占位缺省——
 * 状态栏 popover 可改 declared；anchorSource='default' 显式）。0 颗钻、无任何 underlay 源。
 */
export function createBlankDocument(): void {
  const px = BLANK_CANVAS_MM * PIXELS_PER_MM
  const handoff: ManualEditHandoff = {
    gems: [],
    blocks: [],
    palette: STARTER_PALETTE.map((c) => ({ ...c })),
    grid: blankStartGrid(),
    width: px,
    height: px,
    sourceSummary: '空白起步',
    paintingSnapshot: blankPaintingSnapshot(),
    physicalCanvas: { widthMm: BLANK_CANVAS_MM, heightMm: BLANK_CANVAS_MM, anchorSource: 'default' },
  }
  loadFromHandoff(handoff, { origin: 'blank', name: UNTITLED_DOC_NAME })
  applyBlankStartIdentity({ reference: false, sourceSummary: '空白起步' })
}
