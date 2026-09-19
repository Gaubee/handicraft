/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 专家工作台 UI 互操作态：当前工具
 *    （select/draw/erase）与 snap（grid/free）——工具栏写、画布读，跨组件唯一真源。
 * 2. [2026-09-20 C-3.2/3.3] 画布瞬时交互读数：marquee 矩形 / 笔刷光标位 / 吸附格位高亮
 *    （图像坐标系）。jsdom 无 2d 上下文——测试经本模块读取面断言，浏览器经画布重绘消费。
 * 3. [2026-09-20 C-3.3] 笔刷意图流出口：onBrushStroke 订阅（begin/move/end × 落点序列 +
 *    工具 + snap 态）——[D-5.5] brushEngine 消费（落钻/擦除算法）与测试共用接口。
 * 4. [2026-09-20 D-5.5] 笔刷当前规格态（brushSpec——显式覆盖；null = 文档基准派生，
 *    见 brushEngine.resolveBrushSpec）+ 冲突拒画闪红读数（brushRejections——起笔清零、
 *    拒画点追加；画布绘红 X）。规格选择器写入口（setBrushSpec）预埋归 5.3（数据源
 *    gemCatalogService 真源切换归 5.6——本模块只持 UI 态不引 service 依赖）。
 * 5. [2026-09-20 Test] resetWorkbenchForTests 复位（工具/snap/读数/订阅/规格/闪红全清）。
 */

import type { ShapeId } from '$lib/engine'
import type { BrushIntentEvent, BrushIntentListener, BrushPoint, SnapMode } from './brushGesture'
import type { MarqueeRect } from './selection'

/** 专家工作台工具：选择 / 画钻 / 擦除。 */
export type WorkbenchTool = 'select' | 'draw' | 'erase'

/** [D-5.5] 笔刷当前规格（画钻物化戳的形状×尺寸×色；5.3 规格选择器的写入口真源）。 */
export interface BrushSpecState {
  shapeId: ShapeId
  diameterMm: number
  colorId: string
}

let tool = $state<WorkbenchTool>('select')
let snap = $state<SnapMode>('grid')
let marquee = $state<MarqueeRect | null>(null)
let brushCursor = $state<BrushPoint | null>(null)
let snapIndicator = $state<BrushPoint | null>(null)
/** [D-5.5] 笔刷规格显式覆盖态（null = brushEngine 按文档基准派生）。 */
let brushSpec = $state<BrushSpecState | null>(null)
/** [D-5.5] 冲突拒画闪红读数（被拒落点；起笔清零，画布绘红 X 提示）。 */
let brushRejections = $state<BrushPoint[]>([])

export function getTool(): WorkbenchTool {
  return tool
}

export function setTool(next: WorkbenchTool): void {
  tool = next
  // 切工具丢弃进行中的框选与笔刷读数（光标/吸附高亮由画布随 move 重建；闪红随笔废弃）
  marquee = null
  brushCursor = null
  snapIndicator = null
  brushRejections = []
}

export function getSnap(): SnapMode {
  return snap
}

export function setSnap(next: SnapMode): void {
  snap = next
}

export function getMarquee(): MarqueeRect | null {
  return marquee
}

export function setMarquee(rect: MarqueeRect | null): void {
  marquee = rect
}

export function getBrushCursor(): BrushPoint | null {
  return brushCursor
}

export function setBrushCursor(point: BrushPoint | null): void {
  brushCursor = point
}

export function getSnapIndicator(): BrushPoint | null {
  return snapIndicator
}

export function setSnapIndicator(point: BrushPoint | null): void {
  snapIndicator = point
}

export function getBrushSpec(): BrushSpecState | null {
  return brushSpec
}

/** [5.3 接口预埋] 规格选择器写当前笔刷规格；null 清除覆盖（回文档基准派生）。 */
export function setBrushSpec(spec: BrushSpecState | null): void {
  brushSpec = spec === null ? null : { ...spec }
}

export function getBrushRejections(): BrushPoint[] {
  return brushRejections
}

/** [D-5.5] 拒画闪红写入口（brushEngine 起笔清零/拒画追加；快照拷贝防外部渗入）。 */
export function setBrushRejections(points: BrushPoint[]): void {
  brushRejections = points.map((p) => ({ ...p }))
}

let brushListeners: BrushIntentListener[] = []

/** 订阅笔刷意图流；返回退订函数。 */
export function onBrushStroke(listener: BrushIntentListener): () => void {
  brushListeners.push(listener)
  return () => {
    brushListeners = brushListeners.filter((l) => l !== listener)
  }
}

/** 画布手势层唯一发事件入口（订阅方异常不中断手势）。 */
export function emitBrushEvent(event: BrushIntentEvent): void {
  for (const listener of [...brushListeners]) {
    try {
      listener(event)
    } catch {
      // 监听方异常隔离：手势层不因消费方失败而中断
    }
  }
}

/** 测试专用：整体复位（工具/snap/读数/订阅/规格/闪红全清）。 */
export function resetWorkbenchForTests(): void {
  tool = 'select'
  snap = 'grid'
  marquee = null
  brushCursor = null
  snapIndicator = null
  brushSpec = null
  brushRejections = []
  brushListeners = []
}
