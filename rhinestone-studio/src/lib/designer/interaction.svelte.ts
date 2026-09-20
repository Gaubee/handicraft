/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 画布瞬时交互态（拖移预览/
 *    变换手柄读数/属性面板定位焦点）——独立于 workbench.svelte.ts 态模块（共享文件只加
 *    不改的并行纪律下，本切片新态自成模块；jsdom 无 2d 上下文，测试经本模块读取面断言，
 *    浏览器经画布 ghost/读数气泡消费）。
 * 2. [进行中手势取消注册表] Esc/系统打断取消进行中的拖移/旋转/改径会话（design §2 通用
 *    约束：进行中手势可 Esc 取消，不产生 undo 组）——会话注册 canceler，键盘 Esc 经
 *    cancelActiveInteraction() 单点裁决（消费返回 true 则不再清空选择）。
 * 3. [Test] resetInteractionForTests 复位（预览/焦点/取消注册全清）。
 */

/** P5 拖移预览读数（拖拽中画布 ghost 偏移；copy=true 为 Alt 副本拖移）。 */
export interface MovePreview {
  dx: number
  dy: number
  copy: boolean
}

/** P6/P7 变换手柄实时读数（旋转° / 直径 mm——气泡与状态消费）。 */
export type TransformPreview =
  | { kind: 'rotate'; gemId: string; valueDeg: number }
  | { kind: 'diameter'; gemId: string; valueMm: number }

/** P8 属性面板定位焦点（双击钻 → 视图滚动到字段并高亮；seq 消除同 gem 连击去重）。 */
export interface PropertiesFocus {
  gemId: string
  seq: number
}

let movePreview = $state<MovePreview | null>(null)
let transformPreview = $state<TransformPreview | null>(null)
let propertiesFocus = $state<PropertiesFocus | null>(null)
let focusSeq = 0

// 进行中手势取消注册表（会话起注册、收笔/取消注销）
let cancelers: Array<() => void> = []

export function getMovePreview(): MovePreview | null {
  return movePreview
}

export function setMovePreview(preview: MovePreview | null): void {
  movePreview = preview === null ? null : { ...preview }
}

export function getTransformPreview(): TransformPreview | null {
  return transformPreview
}

export function setTransformPreview(preview: TransformPreview | null): void {
  transformPreview = preview
}

export function getPropertiesFocus(): PropertiesFocus | null {
  return propertiesFocus
}

/** P8 焦点写入（同 gem 重复双击递增 seq——消费 effect 按次触发）。 */
export function setPropertiesFocus(gemId: string | null): void {
  propertiesFocus = gemId === null ? null : { gemId, seq: ++focusSeq }
}

/** 注册进行中手势的取消器；返回注销函数。 */
export function registerGestureCancel(cancel: () => void): () => void {
  cancelers.push(cancel)
  return () => {
    cancelers = cancelers.filter((c) => c !== cancel)
  }
}

/** 是否存在进行中手势（拖移/旋转/改径会话）。 */
export function hasActiveGesture(): boolean {
  return cancelers.length > 0
}

/**
 * 取消所有进行中手势（Esc 单点裁决）：存在被取消的会话返回 true（调用方不再执行
 * Esc 的清空选择语义——取消优先，选择保持）。
 */
export function cancelActiveInteraction(): boolean {
  if (cancelers.length === 0) return false
  const all = [...cancelers]
  cancelers = []
  for (const cancel of all) cancel()
  setMovePreview(null)
  setTransformPreview(null)
  return true
}

/** 测试专用：整体复位（预览/焦点/取消注册全清）。 */
export function resetInteractionForTests(): void {
  movePreview = null
  transformPreview = null
  propertiesFocus = null
  focusSeq = 0
  cancelers = []
}
