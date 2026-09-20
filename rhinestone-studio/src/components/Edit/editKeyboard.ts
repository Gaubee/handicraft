/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.2/3.5 rename-and-expert-workbench] 设计师工作台键盘分派（纯决策函数）：
 *    Esc 清空选择 / 方向键三档微移（默认 1px、Shift=网格 pitch、Alt=0.1mm 精调）/
 *    ⌘Z·⌘⇧Z（Ctrl 同）撤销重做。输入控件聚焦时一律放行（不劫持表单键）。
 * 2. [2026-09-20 Pure] 纯 TS——vitest 用合成 KeyboardEvent 语义直接驱动，EditView 只做接线。
 */

import type { GridSpec } from '$lib/engine'

export interface WorkbenchKeyboardContext {
  hasDocument(): boolean
  selectionCount(): number
  /** 三档步进（px）——实现方按当前文档 grid 换算（nudgeStepPx）。 */
  nudgeStep(modifiers: { shift: boolean; alt: boolean }): number
  /** 微移已选钻（dx/dy 已按步进换算的 px）；返回是否实际生效 */
  nudgeSelection(dxPx: number, dyPx: number): boolean
  clearSelection(): void
  undo(): boolean
  redo(): boolean
}

/** 方向键三档步进（design §3.6）：默认 1px；Shift = pitch（px）；Alt = 0.1mm×pixelsPerMm
 *  （Shift+Alt 并按时取精调档——细粒度优先）。 */
export function nudgeStepPx(
  modifiers: { shift: boolean; alt: boolean },
  grid: Pick<GridSpec, 'pitchMm' | 'pixelsPerMm'>,
): number {
  if (modifiers.alt) return 0.1 * grid.pixelsPerMm
  if (modifiers.shift) return grid.pitchMm * grid.pixelsPerMm
  return 1
}

/** 表单控件聚焦判定（input/textarea/select/contenteditable —— 键盘归表单）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 键分派：命中返回 true（并 preventDefault），未命中返回 false（放行浏览器默认）。
 * 输入控件聚焦 / 无文档（除 Esc 清空亦无面）时直接放行。
 */
export function handleWorkbenchKeydown(event: KeyboardEvent, ctx: WorkbenchKeyboardContext): boolean {
  if (event.defaultPrevented) return false
  if (isEditableTarget(event.target)) return false

  const key = event.key
  // 撤销/重做：⌘Z / ⌘⇧Z（Ctrl 同）
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || key === 'Z')) {
    const done = event.shiftKey ? ctx.redo() : ctx.undo()
    if (done) {
      event.preventDefault()
      return true
    }
    return false
  }
  if (event.metaKey || event.ctrlKey) return false

  // Esc：清空选择
  if (key === 'Escape') {
    if (!ctx.hasDocument()) return false
    ctx.clearSelection()
    event.preventDefault()
    return true
  }

  // 方向键微移（无选中不动）
  const arrow: Array<{ key: string; dx: number; dy: number }> = [
    { key: 'ArrowLeft', dx: -1, dy: 0 },
    { key: 'ArrowRight', dx: 1, dy: 0 },
    { key: 'ArrowUp', dx: 0, dy: -1 },
    { key: 'ArrowDown', dx: 0, dy: 1 },
  ]
  const hit = arrow.find((a) => a.key === key)
  if (hit === undefined) return false
  if (!ctx.hasDocument() || ctx.selectionCount() === 0) return false
  const step = ctx.nudgeStep({ shift: event.shiftKey, alt: event.altKey })
  if (ctx.nudgeSelection(step * hit.dx, step * hit.dy)) {
    event.preventDefault()
    return true
  }
  return false
}
