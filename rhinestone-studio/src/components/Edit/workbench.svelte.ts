/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 专家工作台 UI 互操作态：当前工具
 *    （select/draw/erase）与 snap（grid/free）——工具栏写、画布读，跨组件唯一真源。
 * 2. [2026-09-20 C-3.2/3.3] 画布瞬时交互读数：marquee 矩形 / 笔刷光标位 / 吸附格位高亮
 *    （图像坐标系）。jsdom 无 2d 上下文——测试经本模块读取面断言，浏览器经画布重绘消费。
 * 3. [2026-09-20 C-3.3] 笔刷意图流出口：onBrushStroke 订阅（begin/move/end × 落点序列 +
 *    工具 + snap 态）——落钻算法（依赖轨 5.5）与测试的消费接口。
 * 4. [2026-09-20 Test] resetWorkbenchForTests 复位（工具/snap/读数/订阅全清）。
 */

import type { BrushIntentEvent, BrushIntentListener, BrushPoint, SnapMode } from './brushGesture'
import type { MarqueeRect } from './selection'

/** 专家工作台工具：选择 / 画钻 / 擦除。 */
export type WorkbenchTool = 'select' | 'draw' | 'erase'

let tool = $state<WorkbenchTool>('select')
let snap = $state<SnapMode>('grid')
let marquee = $state<MarqueeRect | null>(null)
let brushCursor = $state<BrushPoint | null>(null)
let snapIndicator = $state<BrushPoint | null>(null)

export function getTool(): WorkbenchTool {
  return tool
}

export function setTool(next: WorkbenchTool): void {
  tool = next
  // 切工具丢弃进行中的框选与笔刷读数（光标/吸附高亮由画布随 move 重建）
  marquee = null
  brushCursor = null
  snapIndicator = null
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

/** 测试专用：整体复位（工具/snap/读数/订阅全清）。 */
export function resetWorkbenchForTests(): void {
  tool = 'select'
  snap = 'grid'
  marquee = null
  brushCursor = null
  snapIndicator = null
  brushListeners = []
}
