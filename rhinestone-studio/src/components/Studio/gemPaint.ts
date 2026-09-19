/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-18 Render / 2026-09-20 studio-layers 2.6 逐钻签名] 钻位 canvas 绘制共享助手：
 *    预览浮卡（drawPreview）与主画布/导出 PNG 光栅化共用。半径逐钻物化——gemRadiusPx(gem, grid)
 *    逐钻签名（engine gate 1.3 偏离登记的既定收口：唯一物理依据 gem.diameterMm；层结果随结算
 *    按层规格 stamp，多层混径渲染正确；旧单 grid 基准半径由 engine @deprecated 重载保留给
 *    edit 域未迁移消费者）。
 * 2. [变换] t 默认图像素坐标系（scale:1/ox:0/oy:0）；pixelsPerMm = px↔mm 锚（缺省 2.5）。
 */

import { PIXELS_PER_MM, gemRadiusPx, type Block, type EngineImage, type Gem, type GridSpec, type Palette } from '$lib/engine'

export interface PaintTransform {
  scale: number
  ox: number
  oy: number
  /** px↔mm 锚（逐钻半径换算；缺省 PIXELS_PER_MM） */
  pixelsPerMm?: number
}

/** EngineImage → ImageData（复制一次以获得 ArrayBuffer 支配类型的像素缓冲） */
export function paintingImageData(image: EngineImage): ImageData {
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
}

/** 钻位圆点批量绘制：色板 hex → 块代表色 → 灰阶占位；t 默认图像素坐标系 */
export function paintGems(
  ctx: CanvasRenderingContext2D,
  gems: Gem[],
  palette: Palette,
  blocks: Block[],
  gridOrTransform: GridSpec | PaintTransform = { scale: 1, ox: 0, oy: 0 },
  maybeTransform?: PaintTransform,
): void {
  // 双形态收口：paintGems(ctx, gems, palette, blocks, grid[, t])（旧调用——图像素坐标由 t 缺省 1:1，
  // 锚取 grid.pixelsPerMm）与 paintGems(ctx, gems, palette, blocks, t)（v2——缩放/偏移 + px↔mm 锚）
  const isGrid = 'pitchMm' in gridOrTransform
  const grid: GridSpec = isGrid ? gridOrTransform : { pitchMm: 0, gapMm: 0, rowAngleDeg: 0, pixelsPerMm: PIXELS_PER_MM }
  const t: PaintTransform = isGrid ? (maybeTransform ?? { scale: 1, ox: 0, oy: 0 }) : gridOrTransform
  const pixelsPerMm = t.pixelsPerMm ?? grid.pixelsPerMm
  const colorHex = new Map(palette.map((c) => [c.id, c.hex]))
  const blockColor = new Map(
    blocks.map((b) => [b.id, `rgb(${b.colorRgb.map((v) => Math.round(v)).join(' ')})`] as const),
  )
  for (const g of gems) {
    const r = Math.max(0.4, gemRadiusPx(g, grid) * t.scale)
    ctx.fillStyle = colorHex.get(g.colorId) ?? blockColor.get(g.blockId) ?? '#9CA3AF'
    ctx.beginPath()
    ctx.arc(t.ox + (g.x + 0.5) * t.scale, t.oy + (g.y + 0.5) * t.scale, r, 0, Math.PI * 2)
    ctx.fill()
  }
}
