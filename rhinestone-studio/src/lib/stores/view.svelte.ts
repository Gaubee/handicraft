/**
 * [2026-09-18 UX] 顶栏视图切换的唯一状态源（'lab' | 'studio'）。
 * App.svelte 的 Tabs 受控绑定本 store；handoff 置位 → App 层 $effect 自动切 studio，
 * 取代模块 A 时代「送排钻后靠 DOM 点击切视图」的过渡方案。
 * [2026-09-19 Edit] 增第三视图 'edit'（设计师工作台；add-manual-edit-mode tasks 3.1）：
 * 进入编辑器必须经「送精修」显式交接，直接进入显示空态引导回排钻工作台。
 * [2026-09-19 Assets] 增第四视图 'assets'（素材库；[Owner] Tab 首位，默认落地仍为实验室）。
 * [add-backend-platform W3.1/W3.2] 增第五视图 'agent'（Agent 主面——产品默认落地；
 * spec「Agent 优先界面形态」：默认路由=Agent，旧三工作台收进开发者旗标）。
 * [add-stone-library S3.3] 增第六视图 'stones'（装饰钻库管理视图——开发者旗标，
 * 与素材库并列；数据源=daemon resources 共享读，非本地 IDB）。
 * [add-stone-library S7.4] 增第七视图 'warehouse'（仓储管理工作台——组合层载体 UI，
 * design §7.6：标准平铺+框选/点选+集合侧栏；开发者旗标，与装饰钻库并列）。
 */

export type ViewId = 'agent' | 'assets' | 'stones' | 'warehouse' | 'lab' | 'studio' | 'edit'

let current = $state<ViewId>('agent')

export function getView(): ViewId {
  return current
}

export function setView(view: ViewId): void {
  current = view
}

/** 测试复位视图态（模块级 $state 跨测试存留——App 级测试前置复位到默认 Agent 落地）。 */
export function resetViewForTests(view: ViewId = 'agent'): void {
  current = view
}
