/*
 * [2026-09-21 rework-designer-manual-rhinestone Codex 终审 P1-1+P2] blocks 边界描线
 * 共享纯 helper——此前 pngRender.drawBlockLines 与 DesignerCanvas layers effect 完整
 * 复制同一 labelMap 四邻算法，且四邻读取无网格边界守卫：gx=0 的 `-1` 读到上一行末列、
 * gx=W-1 的 `+1` 读到下一行首列（跨行索引）——满宽块中间行左/右竖边被误判为内部而漏画
 * （PNG 导出与实时画布同错，且边界结果随相邻行内容漂移）。本模块收敛为单源实现：
 * 越界邻居恒为「非本块」（网格外不存在块像素）+ 显式 gx>0 / gx+1<W / gy>0 / gy+1<H
 * 守卫；两消费面（PNG 离屏渲染器 / 画布 blocks 缓存层）禁再复制算法。
 *
 * 纯函数、零依赖（engine Block 类型除外）、无 runes/UI；labelMap 语义与两消费面原实现
 * 逐位一致（Int16Array、后块覆写前块的掩码重叠顺序、边界像素 = 块代表色 + alpha 210）。
 */

import type { Block } from '$lib/engine'

/** labelMap 越界哨兵（Int16Array 填充基值——不与任何块索引相等）。 */
export const BLOCK_LABEL_NONE = -1

/** blocks 边界描线像素 alpha（块代表色淡填充口径——画布/PNG 原值冻结）。 */
export const BLOCK_OUTLINE_ALPHA = 210

/**
 * blocks → 文档像素网格 labelMap（Int16Array W×H，值 = 块在数组中的索引，哨兵 -1）。
 * 掩码重叠时后块覆写前块（两消费面原实现同序——渲染分组口径，非归属真源）。
 */
export function buildBlockLabelMap(blocks: readonly Block[], W: number, H: number): Int16Array {
  const label = new Int16Array(W * H).fill(BLOCK_LABEL_NONE)
  blocks.forEach((b, bi) => {
    const bits = b.mask.bits
    const { x, y, w, h } = b.bbox
    for (let dy = 0; dy < h; dy++) {
      const row = (y + dy) * W + x
      for (let dx = 0; dx < w; dx++) {
        if (bits[dy * w + dx] === 1) label[row + dx] = bi
      }
    }
  })
  return label
}

/**
 * 四邻边界判定（网格边界守卫单源）：像素 (gx,gy) 属块 bi 时，任一邻居非本块即为边界。
 * 越界邻居恒判「非本块」——显式 gx>0 / gx+1<W / gy>0 / gy+1<H 守卫取代裸索引 ±1
 * （旧实现 gx=0 读上行末列 / gx=W-1 读下行首列的跨行缺陷在此收口）。
 */
export function isBlockBoundaryAt(
  label: Int16Array,
  W: number,
  H: number,
  gx: number,
  gy: number,
  blockIndex: number,
): boolean {
  if (gx <= 0 || label[gy * W + gx - 1] !== blockIndex) return true
  if (gx + 1 >= W || label[gy * W + gx + 1] !== blockIndex) return true
  if (gy <= 0 || label[(gy - 1) * W + gx] !== blockIndex) return true
  if (gy + 1 >= H || label[(gy + 1) * W + gx] !== blockIndex) return true
  return false
}

/**
 * blocks 边界描线 → RGBA 像素缓冲（px 长度须为 W×H×4，其余通道不动——消费方只写本层）。
 * 边界像素 = 块代表色 RGB + alpha 210；非边界块像素与块外像素恒透明（0）。
 */
export function paintBlockOutlinePixels(
  px: Uint8ClampedArray,
  blocks: readonly Block[],
  W: number,
  H: number,
): void {
  const label = buildBlockLabelMap(blocks, W, H)
  blocks.forEach((b, bi) => {
    const [r, g, bl] = b.colorRgb
    const { x, y, w, h } = b.bbox
    const bits = b.mask.bits
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (bits[dy * w + dx] !== 1) continue
        const gx = x + dx
        const gy = y + dy
        if (!isBlockBoundaryAt(label, W, H, gx, gy, bi)) continue
        const i = (gy * W + gx) * 4
        px[i] = r
        px[i + 1] = g
        px[i + 2] = bl
        px[i + 3] = BLOCK_OUTLINE_ALPHA
      }
    }
  })
}
