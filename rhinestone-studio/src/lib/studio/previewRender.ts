/*
Orthogonal intents (max 2):
1. [2026-09-19 Render / redesign-studio-layout 任务 0.1] 预览绘制纯函数：DPR 背板尺寸/清屏/三模式底图
   叠加（透明度）/钻位圆点全部收口 drawPreview——无组件状态、无 Image 加载、无 objectURL/
   ResizeObserver/重绘调度生命周期（留在组件，design §2 [Codex-R1-B9] 冻结签名）。
   [2026-09-19 Preview-fix] 主画布（BlockCanvas）三模式层分派 pickCanvasLayers 同族纯函数：
   模式/透明度/有钻 → 各层开关+alpha（jsdom 可单测）；位图就绪性/视口/重绘调度仍在组件收口。
2. [2026-09-19 Golden] 与旧 CompareGrid.renderPreview 逐 canvas 调用序列等价（基准测试以旧算法
   本地复刻为 golden 逐字节对照）；painting 底图离屏层按 EngineImage 对象身份 WeakMap 记忆 =
   旧组件「painting 不变时复用 paintLayer」的纯函数侧等价物（painting 为整体替换式更新，
   store 侧从不原地改写像素 → 记忆层内容恒等于 putImageData(painting)）。
*/

import type { Block, EngineImage, GridSpec, Palette } from '$lib/engine'
// TODO(拓扑迁移): gemPaint 仍在 components/Studio 下（本任务文件边界禁动），previewRender 先相对路径跨层引用；
// redesign-studio-layout 后续组件拆分任务将 gemPaint 迁入 lib/studio 时改回同层导入。
import { paintGems, paintingImageData } from '../../components/Studio/gemPaint'
// type-only 导入：无运行时耦合（esbuild/Svelte 编译期擦除），PreviewMode/StrategyResult 真源在 store。
import type { PreviewMode, StrategyResult } from '$lib/stores/studio.svelte'

export interface PreviewRenderInput {
  /**
   * 叠稿底图（缺省/null = 清屏即止，旧 `if (!p) return` 语义）；内部按对象身份记忆离屏层。
   * null 宽容 = 组件可空状态直传（undefined 同义）。
   */
  painting?: EngineImage | null
  /** 叠原图（组件解析完成的位图；缺省/null = 该层不画，旧 `mode==='reference' && refImg` 语义） */
  referenceBitmap?: ImageBitmap | HTMLImageElement | null
  /** 计算中/失败可为 null/undefined（旧 `res?.gems ?? []` 语义：无钻可画） */
  result?: StrategyResult | null
  palette: Palette
  blocks: Block[]
  grid: GridSpec
  mode: PreviewMode
  overlayOpacity: number
  /** CSS 像素尺寸（组件从 clientWidth/Height 解析）与设备像素比 */
  size: { width: number; height: number }
  dpr: number
}

/** EngineImage → 离屏 canvas（jsdom 无 2D 上下文时为 null → 跳过该层，与旧组件 paintLayer=null 同构） */
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
 * 纯绘制：清屏 → contain 适配缩放 →（painting/reference 模式）底图按 overlayOpacity 叠加 →
 * 钻位圆点。会按 size×dpr 调整 ctx.canvas 背板尺寸（等价旧 renderPreview 的 width/height 赋值）。
 */
export function drawPreview(ctx: CanvasRenderingContext2D, input: PreviewRenderInput): void {
  const { painting, referenceBitmap, result, palette, blocks, grid, mode, overlayOpacity, size, dpr } = input
  const cssW = size.width
  const cssH = size.height
  const bw = Math.round(cssW * dpr)
  const bh = Math.round(cssH * dpr)
  const canvas = ctx.canvas
  if (canvas.width !== bw) canvas.width = bw
  if (canvas.height !== bh) canvas.height = bh
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  if (!painting) return

  const W = painting.width
  const H = painting.height
  const s = Math.min(cssW / W, cssH / H)
  const ox = (cssW - W * s) / 2
  const oy = (cssH - H * s) / 2

  if (mode !== 'gems') {
    ctx.globalAlpha = overlayOpacity
    if (mode === 'painting') {
      const layer = paintingLayer(painting)
      if (layer) ctx.drawImage(layer, ox, oy, W * s, H * s)
    }
    if (mode === 'reference' && referenceBitmap) {
      ctx.drawImage(referenceBitmap, ox, oy, W * s, H * s)
    }
    ctx.globalAlpha = 1
  }

  paintGems(ctx, result?.gems ?? [], palette, blocks, grid, { scale: s, ox, oy })
}

// ---------------------------------------------------------------------------
// 主画布（BlockCanvas）三模式层分派（redesign-studio-layout spec「预览控制就近 …即时作用于画布呈现」）
// ---------------------------------------------------------------------------

/** 主画布层分派计划：模式 → 各层开关 + alpha（纯映射；位图就绪性/层内容/视口由组件收口） */
export interface CanvasLayerPlan {
  /** 数字油画底图层（painting 模式 = 按 overlayOpacity 半透明叠稿） */
  paint: boolean
  paintAlpha: number
  /** 分块着色层（仅无钻回落时保留 = 修复前现状渲染 0.9） */
  overlay: boolean
  overlayAlpha: number
  /** 参考原图层（reference 模式 = 叠原；组件在位图未就绪时跳过该层） */
  reference: boolean
  referenceAlpha: number
  /** 钻点层（三模式均画；无结果回落时不画） */
  gems: boolean
}

export interface CanvasLayerPlanInput {
  mode: PreviewMode
  overlayOpacity: number
  /** activeResult 有钻（无钻 = 结果未落地/被清 → 回落现状渲染，避免空画布闪烁） */
  hasGems: boolean
}

/**
 * 模式 → 层分派（与 drawPreview 的浮卡三模式语义同构，差异仅在分块着色层的去留）：
 * gems 纯钻 = 透明底 + 钻点；painting 叠稿 = 底图按透明度 + 钻点（分块着色让位）；
 * reference 叠原 = 参考原图按透明度 + 钻点；hasGems=false（任意模式）= 修复前渲染不变。
 */
export function pickCanvasLayers({ mode, overlayOpacity, hasGems }: CanvasLayerPlanInput): CanvasLayerPlan {
  const alpha = Math.min(1, Math.max(0, overlayOpacity))
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
  if (mode === 'painting') return { ...base, paint: true, paintAlpha: alpha }
  if (mode === 'reference') return { ...base, reference: true, referenceAlpha: alpha }
  return base
}
