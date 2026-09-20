/**
 * [2026-09-18 UX] 顶栏视图切换的唯一状态源（'lab' | 'studio'）。
 * App.svelte 的 Tabs 受控绑定本 store；handoff 置位 → App 层 $effect 自动切 studio，
 * 取代模块 A 时代「送排钻后靠 DOM 点击切视图」的过渡方案。
 * [2026-09-19 Edit] 增第三视图 'edit'（专家工作台；add-manual-edit-mode tasks 3.1）：
 * 进入编辑器必须经「送精修」显式交接，直接进入显示空态引导回排钻工作台。
 * [2026-09-19 Assets] 增第四视图 'assets'（素材库；[Owner] Tab 首位，默认落地仍为实验室）。
 */

export type ViewId = 'assets' | 'lab' | 'studio' | 'edit'

let current = $state<ViewId>('lab')

export function getView(): ViewId {
  return current
}

export function setView(view: ViewId): void {
  current = view
}
