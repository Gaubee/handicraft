/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-19 Render / 2026-09-20 studio-layers 2.6 签名层化] 预览绘制纯函数：PreviewRenderInput
 *    v2（图层稿 §B.7 冻结签名——background{source,opacity,painting?,referenceBitmap?} + layers[]
 *    [{id,visible,selected,result}] + palette/blocks/size/dpr；mode/overlayOpacity/grid/result 单值
 *    入口废除）。无组件状态、无 Image 加载、无 objectURL/ResizeObserver/重绘调度生命周期
 *    （留在组件；纯函数边界纪律沿用——redesign-studio-layout §2 冻结面被本变更覆盖，design §2.6）。
 *    [实现补全登记] 冻结签名未携带 px↔mm 锚——逐钻半径（gemRadiusPx(gem,grid) 逐钻签名）需要
 *    pixelsPerMm；本实现补可选 pixelsPerMm（缺省 PIXELS_PER_MM=2.5）。
 * 2. [主画布分派] pickCanvasLayers 层化（BlockCanvas 分派面）：背景源三态 + 可见层有钻 →
 *    各层开关 + alpha；无钻回落现状渲染（overlay 0.9）；渲染三分常量（选中 1.0/非选中 0.8
 *    固定——SELECTED_LAYER_OPACITY/DESELECTED_LAYER_OPACITY）由组件逐层施加。
 * 3. [Golden 等价迁移] 旧三模式语义经等价映射逐字节保持（gems⇔source='none'；
 *    painting⇔source='painting'+旧 overlayOpacity；单 rest 层⇔layers=[单层 selected]——
 *    旧管线复刻 golden 对照归 tests/studio/previewRender.test.ts，缺迁移不得切实现切片的
 *    纪律以该测试逐字节相等为验收）。
 */

import { PIXELS_PER_MM, type Block, type EngineImage, type Gem, type Palette } from '$lib/engine'
import {
  DESELECTED_LAYER_OPACITY,
  SELECTED_LAYER_OPACITY,
  type BackgroundSource,
} from '$lib/studio/layers.svelte'
// TODO(拓扑迁移): gemPaint 仍在 components/Studio 下，previewRender 先相对路径跨层引用；
// redesign-studio-layout 后续组件拆分任务将 gemPaint 迁入 lib/studio 时改回同层导入。
import { paintGems, paintingImageData } from '../../components/Studio/gemPaint'

/** 层结果（渲染只消费 gems——StrategyResult/LayerResultEntry 的结构子集）。 */
export interface PreviewLayerResult {
  gems: Gem[]
}

/** 普通层（列表序 = 合成序自下而上；selected → alpha 1.0 / 非选中 0.8 固定常量）。 */
export interface PreviewRenderLayer {
  id: string
  visible: boolean
  selected: boolean
  result: PreviewLayerResult | null
}

/** PreviewRenderInput v2（图层稿 §B.7 冻结签名 + pixelsPerMm 实现补全）。 */
export interface PreviewRenderInput {
  background: {
    source: BackgroundSource
    /** 0–1（默认 0.5——BACKGROUND_OPACITY_DEFAULT） */
    opacity: number
    painting?: EngineImage | null
    referenceBitmap?: ImageBitmap | HTMLImageElement | null
  }
  layers: PreviewRenderLayer[]
  palette: Palette
  blocks: Block[]
  /** px↔mm 锚（逐钻半径换算；缺省 2.5） */
  pixelsPerMm?: number
  /** CSS 像素尺寸（组件从 clientWidth/Height 解析）与设备像素比 */
  size: { width: number; height: number }
  dpr: number
}

export { SELECTED_LAYER_OPACITY, DESELECTED_LAYER_OPACITY }

/** EngineImage → 离屏 canvas（jsdom 无 2D 上下文时为 null → 跳过该层，旧组件 paintLayer=null 同构） */
const layerCache = new WeakMap<EngineImage, HTMLCanvasElement | null>()

function paintingLayer(painting: EngineImage): HTMLCanvasElement | null {
  const cached = layerCache.get(painting)
  if (cached !== undefined) return cached
  const canvas = document.createElement('canvas')
  canvas.width = painting.width
  canvas.height = painting.height
  const ctx = canvas.getContext('2d')
  let layer: HTMLCanvasElement | null = null
  if (ctx) {
    ctx.putImageData(paintingImageData(painting), 0, 0)
    layer = canvas
  }
  layerCache.set(painting, layer)
  return layer
}

/**
 * 纯绘制（v2 层化）：清屏 → contain 适配缩放 → 背景层（源非无：数字油画/原图按透明度）→
 * 各普通层钻点（可见者按列表序；选中 1.0 / 非选中 0.8 固定常量）。会按 size×dpr 调整背板尺寸。
 * background.painting 缺席/null = 清屏即止（旧 `if (!p) return` 语义——预览锚定数字油画画幅）。
 */
export function drawPreview(ctx: CanvasRenderingContext2D, input: PreviewRenderInput): void {
  const { background, layers, palette, blocks, size, dpr } = input
  const pixelsPerMm = input.pixelsPerMm ?? PIXELS_PER_MM
  const cssW = size.width
  const cssH = size.height
  const bw = Math.round(cssW * dpr)
  const bh = Math.round(cssH * dpr)
  const canvas = ctx.canvas
  if (canvas.width !== bw) canvas.width = bw
  if (canvas.height !== bh) canvas.height = bh
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  const painting = background.painting ?? null
  if (!painting) return

  const W = painting.width
  const H = painting.height
  const s = Math.min(cssW / W, cssH / H)
  const ox = (cssW - W * s) / 2
  const oy = (cssH - H * s) / 2

  if (background.source !== 'none') {
    ctx.globalAlpha = Math.min(1, Math.max(0, background.opacity))
    if (background.source === 'painting') {
      const layer = paintingLayer(painting)
      if (layer) ctx.drawImage(layer, ox, oy, W * s, H * s)
    }
    if (background.source === 'reference' && background.referenceBitmap) {
      ctx.drawImage(background.referenceBitmap, ox, oy, W * s, H * s)
    }
    ctx.globalAlpha = 1
  }

  for (const layer of layers) {
    if (!layer.visible) continue
    ctx.globalAlpha = layer.selected ? SELECTED_LAYER_OPACITY : DESELECTED_LAYER_OPACITY
    paintGems(ctx, layer.result?.gems ?? [], palette, blocks, { scale: s, ox, oy, pixelsPerMm })
    ctx.globalAlpha = 1
  }
}

// ---------------------------------------------------------------------------
// 主画布（BlockCanvas）层分派（2.6 层化：背景源三态 + 可见层有钻）
// ---------------------------------------------------------------------------

/** 主画布层分派计划（纯映射；位图就绪性/层内容/视口由组件收口）。 */
export interface CanvasLayerPlan {
  /** 数字油画背景层（source='painting' 且背景可见 → 按透明度叠稿） */
  paint: boolean
  paintAlpha: number
  /** 分块着色层（仅无钻回落时保留 = 修复前现状渲染 0.9） */
  overlay: boolean
  overlayAlpha: number
  /** 原图背景层（source='reference' 且背景可见；组件在位图未就绪时跳过该层） */
  reference: boolean
  referenceAlpha: number
  /** 钻点层（任一可见层有钻 → 组件按层序逐层绘制，alpha 三分常量） */
  gems: boolean
}

export interface CanvasLayerPlanInput {
  background: { source: BackgroundSource; opacity: number; visible: boolean }
  /** 任一可见层有钻（无钻 = 结果未落地/被清 → 回落现状渲染，避免空画布闪烁） */
  hasGems: boolean
}

/**
 * 背景源 + 层可见性 → 层分派（2.6 收编语义，与 drawPreview v2 同构；差异在分块着色层去留）：
 * 背景 none/隐藏 = 纯钻；painting 可见 = 底图按透明度；reference 可见 = 原图按透明度；
 * hasGems=false（任意背景态）= 修复前渲染不变（overlay 回落）。
 */
export function pickCanvasLayers({ background, hasGems }: CanvasLayerPlanInput): CanvasLayerPlan {
  const alpha = Math.min(1, Math.max(0, background.opacity))
  if (!hasGems) {
    return { paint: true, paintAlpha: 1, overlay: true, overlayAlpha: 0.9, reference: false, referenceAlpha: 1, gems: false }
  }
  const base: CanvasLayerPlan = {
    paint: false,
    paintAlpha: 1,
    overlay: false,
    overlayAlpha: 0.9,
    reference: false,
    referenceAlpha: 1,
    gems: true,
  }
  if (!background.visible || background.source === 'none') return base
  if (background.source === 'painting') return { ...base, paint: true, paintAlpha: alpha }
  return { ...base, reference: true, referenceAlpha: alpha }
}
