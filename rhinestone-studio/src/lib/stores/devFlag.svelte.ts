/**
 * [add-backend-platform W3.2] 传统三工作台开发者旗标（spec「Agent 优先界面形态」）。
 * localStorage `handicraft.dev.workbenches` = '1' 显式开启；默认关——默认导航只见
 * Agent 主面；开旗标后可见旧工作台入口（不删除不维护）。BYOK 面随之退场。
 */

const FLAG_KEY = 'handicraft.dev.workbenches'

let enabled = $state<boolean>(typeof localStorage !== 'undefined' ? localStorage.getItem(FLAG_KEY) === '1' : false)

export function isDevWorkbenches(): boolean {
  return enabled
}

export function setDevWorkbenches(value: boolean): void {
  enabled = value
  if (value) localStorage.setItem(FLAG_KEY, '1')
  else localStorage.removeItem(FLAG_KEY)
}

/** 测试复位（挂载前显式设定目标模式；模块级 $state 需重置防跨测试泄漏）。 */
export function resetDevFlagForTests(value = false): void {
  localStorage.removeItem(FLAG_KEY)
  if (value) localStorage.setItem(FLAG_KEY, '1')
  enabled = value
}
