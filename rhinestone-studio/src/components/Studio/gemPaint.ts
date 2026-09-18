/*
Orthogonal intents (max 1):
1. [2026-09-18 Render] 钻位 canvas 绘制共享助手：CompareGrid（contain 适配缩放）与 ExportBar PNG 光栅化（图像素坐标）共用。
*/

import { gemRadiusPx, type Block, type EngineImage, type Gem, type GridSpec, type Palette } from '$lib/engine'

export interface PaintTransform {
  scale: number
  ox: number
  oy: number
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
  grid: GridSpec,
  t: PaintTransform = { scale: 1, ox: 0, oy: 0 },
): void {
  const colorHex = new Map(palette.map((c) => [c.id, c.hex]))
  const blockColor = new Map(
    blocks.map((b) => [b.id, `rgb(${b.colorRgb.map((v) => Math.round(v)).join(' ')})`] as const),
  )
  const r = Math.max(0.4, gemRadiusPx(grid) * t.scale)
  for (const g of gems) {
    ctx.fillStyle = colorHex.get(g.colorId) ?? blockColor.get(g.blockId) ?? '#9CA3AF'
    ctx.beginPath()
    ctx.arc(t.ox + (g.x + 0.5) * t.scale, t.oy + (g.y + 0.5) * t.scale, r, 0, Math.PI * 2)
    ctx.fill()
  }
}
