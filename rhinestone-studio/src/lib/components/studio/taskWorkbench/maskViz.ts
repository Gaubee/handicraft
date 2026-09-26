/*
 * 蒙版可视化投影（add-task-detail-layer-workbench 2.2——mask 蒙版可视化开关；
 * add-workbench-pro 2.2 升级为 bits 源——inline|blob 两态统一消费）。
 * 位面 → 画布坐标横向行程矩形（连续行纵向合并）；bits 由 maskBits.svelte.ts
 * 解码缓存供（inline=树工件内嵌同步解码 / blob=taskArtifact 附件通道异步拉取——
 * 两态全链见该模块）。纯函数 + 行程上限（真 mask 可达 1024²——上限内保持 SVG
 * 节点数有界）。
 */

import type { ObjectNode } from '@handicraft/contracts'
import type { CanvasMaskOverlay } from '$lib/components/strategy/canvasModel.js'
import type { MaskBits } from './maskBits.svelte.js'

/** 单节点行程矩形上限（超出截断——可视化面，非精确渲染承诺）。 */
export const MASK_RUN_LIMIT = 4096

/** 位面 → 画布坐标行程矩形（mask 局部坐标→bbox 原点+尺度换算；纵向合并降节点数）。 */
export function maskRunsOf(bbox: ObjectNode['bbox'], mask: MaskBits): Array<{ x: number; y: number; w: number; h: number }> {
  const scaleX = bbox.w / mask.w
  const scaleY = bbox.h / mask.h
  const runs: Array<{ x: number; y: number; w: number; h: number }> = []
  const pushRun = (xStart: number, xEnd: number, y: number): void => {
    const x = bbox.x + xStart * scaleX
    const width = (xEnd - xStart) * scaleX
    const top = bbox.y + y * scaleY
    const height = scaleY
    // 纵向合并：与上一行程同列同宽且首尾相接 → 高度延伸（条带 mask 矩形数约降一个量级）。
    const last = runs[runs.length - 1]
    if (last !== undefined && last.x === x && last.w === width && last.y + last.h === top) {
      last.h += height
      return
    }
    runs.push({ x, y: top, w: width, h: height })
  }
  for (let y = 0; y < mask.h && runs.length < MASK_RUN_LIMIT; y++) {
    let xStart = -1
    for (let x = 0; x <= mask.w; x++) {
      const on = x < mask.w && mask.bits[y * mask.w + x] === 1
      if (on && xStart < 0) xStart = x
      else if (!on && xStart >= 0) {
        pushRun(xStart, x, y)
        xStart = -1
        if (runs.length >= MASK_RUN_LIMIT) break
      }
    }
  }
  return runs
}

/** 已解码位面 → 画布叠加行（空掩码=null——调用方跳过渲染）。 */
export function maskOverlayOf(node: ObjectNode, bits: MaskBits, selected = false): CanvasMaskOverlay | null {
  const runs = maskRunsOf(node.bbox, bits)
  return runs.length > 0 ? { nodeId: node.id, runs, selected } : null
}
