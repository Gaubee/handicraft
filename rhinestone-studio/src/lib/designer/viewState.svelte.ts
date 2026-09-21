/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 工作台视图态：右面板列
 *    折叠（design §3.4 Tab——折叠/展开承载属性+图层两源的折中裁断）与键位速查面板开关
 *    （design §3.7「?」）。独立态模块（共享 workbench 态模块只加不改的并行纪律）。
 * 2. [6.2 右键空态树] 画幅设置 popover 开合（5.2 canvas popover 状态上收本模块——右键
 *    「画幅设置…」经命令总线 open-canvas-popover 打开同一 popover，状态栏读数点击同源
 *    toggle；design §2.2 空态树「画幅设置…」缺口接线）。
 * 3. [Test] resetViewStateForTests 复位。
 */

let rightRailCollapsed = $state(false)
let shortcutsHelpOpen = $state(false)
let canvasPopoverOpen = $state(false)

export function getRightRailCollapsed(): boolean {
  return rightRailCollapsed
}

export function setRightRailCollapsed(collapsed: boolean): void {
  rightRailCollapsed = collapsed
}

export function toggleRightRail(): void {
  rightRailCollapsed = !rightRailCollapsed
}

export function getShortcutsHelpOpen(): boolean {
  return shortcutsHelpOpen
}

export function setShortcutsHelpOpen(open: boolean): void {
  shortcutsHelpOpen = open
}

export function toggleShortcutsHelp(): void {
  shortcutsHelpOpen = !shortcutsHelpOpen
}

/** [6.2] 画幅设置 popover 开合（状态栏读数点击 toggle / 右键「画幅设置…」命令置开）。 */
export function getCanvasPopoverOpen(): boolean {
  return canvasPopoverOpen
}

export function setCanvasPopoverOpen(open: boolean): void {
  canvasPopoverOpen = open
}

export function toggleCanvasPopover(): void {
  canvasPopoverOpen = !canvasPopoverOpen
}

/** 测试专用：复位。 */
export function resetViewStateForTests(): void {
  rightRailCollapsed = false
  shortcutsHelpOpen = false
  canvasPopoverOpen = false
}
