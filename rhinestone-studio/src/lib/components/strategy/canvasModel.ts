/*
 * 策略画布视图模型（add-task-detail-layer-workbench 2.5——StrategyCanvas 受控化）。
 * 策略设计器 store 与任务工作台 store 各自把数据投影为本模型喂同一画布：
 * 「喂数方式=策略设计器 store 同式投影」（design 前端结构节——组件零数据源耦合，
 * 两个消费面共用一份渲染真身）。类型只做结构描述，两个 store 的投影结构化即可。
 */

import type { ObjectNode } from '@handicraft/contracts'

/** 点阵渲染行（颜色=指派 StonePick colorHex；尺寸=diameterMm×ppm）。 */
export interface CanvasGem {
  id: string
  x: number
  y: number
  radiusPx: number
  colorHex: string
  nodeId: string
}

/** 框线渲染行（排除/不值得贴=红虚线语义由画布消费）。 */
export interface CanvasNodeBox {
  nodeId: string
  objectName: string
  bbox: ObjectNode['bbox']
  excluded: boolean
}

/** 蒙版可视化叠加（mask 位面 → 画布坐标横向行程矩形；store 侧解码换算）。 */
export interface CanvasMaskOverlay {
  nodeId: string
  /** 行程矩形（画布像素坐标——已含 bbox 偏移与缩放）。 */
  runs: Array<{ x: number; y: number; w: number; h: number }>
}

/** 画布模型（null=空态——装载中/错误/无工件由独立态位承载）。 */
export interface StrategyCanvasModel {
  imagePx: { width: number; height: number }
  gems: CanvasGem[]
  boxes: CanvasNodeBox[]
  /** 蒙版叠加（缺省空数组——策略设计器不传即不渲染，行为零变化）。 */
  masks?: CanvasMaskOverlay[]
  ppm: { ppm: number; exact: boolean }
  sourceUrl: string | null
  excludedCount: number
}
