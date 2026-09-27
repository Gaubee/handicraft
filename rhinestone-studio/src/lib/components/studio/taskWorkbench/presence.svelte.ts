/*
 * presence.svelte.ts——工作台实例在场门（rework-layer-model v4 修复轮 F2/F3；
 * 原始需求：openspec/changes/rework-layer-model/design.md §4「同组件同 store」+
 * Codex v4 复核 P1-2/P1-3（/tmp/codex-layer-model-v4-review.md）；2026-09-28）。
 *
 * 背景：bits-ui Tabs.Content=常驻挂载+hidden 属性（非卸载）。App Tabs 恒挂载下
 * Studio 完整工作台与 Agent 详情面板嵌入工作台（TaskDetailPanel）可同时在场：
 *   - 快捷键门（P1-3）：window keydown 监听按实例注册——不可见实例必须放行
 *     （否则隐藏工作台截获 ⌘Z/Delete/F2/Alt+方向/空格平移）。
 *   - 装载门（P1-2，消费方 TaskWorkbenchView $effect）：同上双实例共享模块级
 *     store 单例——不可见实例不得装载（防后台覆盖前台），变可见时校验重载。
 *
 * 判定（双态宿主）：checkVisibility 优先（真浏览器——display:none/visibility 全覆盖，
 * bits-ui Tabs 隐藏=hidden 属性→UA display:none）；无 checkVisibility 时降级 hidden
 * 属性链遍历（jsdom 无布局/无 checkVisibility——Tabs 的隐藏机制恰是 hidden 属性，
 * 集成测试可真实切换）。纯函数零 runes——键位门同步调用（keydown 热路径）。
 */

/**
 * 工作台根元素当前是否实际可见（display:none/hidden 链任一命中=false）。
 * null/未连接（挂载前/卸载后）=false。
 */
export function isWorkbenchVisible(el: HTMLElement | null): boolean {
  if (el === null || el.isConnected === false) return false
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
  }
  // jsdom 降级：祖先链（含自身）任一 hidden 属性=Tabs 隐藏中
  for (let node: HTMLElement | null = el; node !== null && node !== document.documentElement; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return false
  }
  return true
}
