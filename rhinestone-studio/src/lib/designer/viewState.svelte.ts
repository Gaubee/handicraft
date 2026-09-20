/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 工作台视图态：右面板列
 *    折叠（design §3.4 Tab——折叠/展开承载属性+图层两源的折中裁断）与键位速查面板开关
 *    （design §3.7「?」）。独立态模块（共享 workbench 态模块只加不改的并行纪律）。
 * 2. [Test] resetViewStateForTests 复位。
 */

let rightRailCollapsed = $state(false)
let shortcutsHelpOpen = $state(false)

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

/** 测试专用：复位。 */
export function resetViewStateForTests(): void {
  rightRailCollapsed = false
  shortcutsHelpOpen = false
}
