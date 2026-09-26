/*
 * 蒙版可视化投影（add-task-detail-layer-workbench 2.2——mask 蒙版可视化开关）。
 * inline mask 位面 → 画布坐标横向行程矩形（连续行纵向合并）；blob 态蒙版降级
 * 跳过（字节面归 tasks.artifact 附件通道后续接线——不阻塞开关其余层）。
 * 纯函数 + 行程上限（真 mask 可达 1024²——上限内保持 SVG 节点数有界）。
 */

import { decodeInlineMask, type ObjectNode } from '@handicraft/contracts'
import type { CanvasMaskOverlay } from '$lib/components/strategy/canvasModel.js'

/** 单节点行程矩形上限（超出截断——可视化面，非精确渲染承诺）。 */
const MASK_RUN_LIMIT = 4096

export function maskOverlayOf(node: ObjectNode): CanvasMaskOverlay | null {
  if (node.mask.kind !== 'inline') return null
  const { w, h, bits } = decodeInlineMask(node.mask)
  // mask 局部坐标 → 画布坐标（bbox 原点 + 尺度换算——mask w/h 与 bbox 同尺时比例恒 1）。
  const scaleX = node.bbox.w / w
  const scaleY = node.bbox.h / h
  const runs: Array<{ x: number; y: number; w: number; h: number }> = []
  const pushRun = (xStart: number, xEnd: number, y: number): void => {
    const x = node.bbox.x + xStart * scaleX
    const width = (xEnd - xStart) * scaleX
    const top = node.bbox.y + y * scaleY
    const height = scaleY
    // 纵向合并：与上一行程同列同宽且首尾相接 → 高度延伸（条带 mask 矩形数约降一个量级）。
    const last = runs[runs.length - 1]
    if (last !== undefined && last.x === x && last.w === width && last.y + last.h === top) {
      last.h += height
      return
    }
    runs.push({ x, y: top, w: width, h: height })
  }
  for (let y = 0; y < h && runs.length < MASK_RUN_LIMIT; y++) {
    let xStart = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && bits[y * w + x] === 1
      if (on && xStart < 0) xStart = x
      else if (!on && xStart >= 0) {
        pushRun(xStart, x, y)
        xStart = -1
        if (runs.length >= MASK_RUN_LIMIT) break
      }
    }
  }
  return runs.length > 0 ? { nodeId: node.id, runs } : null
}
