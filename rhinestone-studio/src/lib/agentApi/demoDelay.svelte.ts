/*
 * 走查演示开关（add-agent-three-channel 2.4，对齐 shufa a3ac820 ?demoDelay=<ms>）：
 * URL query 一次性激活 → sessionStorage 持有 → MockAgentApi 构造时读取为帧流节奏
 * （统一每帧间隔，替代脚本内建 delayMs——三通道时序可用人眼走查）。
 * shufa 把开关做在 daemon（DemoAgent）；贴钻 mock 通道本就是零 LLM 的演示真源，
 * 故延迟注入在 mock 适配器内生效（rpc 通道不受影响）。
 * [unify-studio-routing] 清参走 router.stripSearchParams（history 收编单出口；
 * 顺修旧实现 replaceState pathname-only 丢 hash 的 bug——深链 ?demoDelay=#/t/x 保锚）。
 */

import { stripSearchParams } from '$lib/router.svelte'

export const DEMO_DELAY_KEY = 'handicraft.demo-delay'

/** 解析 URL query（纯函数——测试注入 search 串）。非法/非正数返回 null。 */
export function parseDemoDelayQuery(search: string): number | null {
  const raw = new URLSearchParams(search).get('demoDelay')
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

/** 当前激活的演示节奏（ms；未激活=0）。 */
export function getDemoDelay(): number {
  try {
    const raw = globalThis.sessionStorage?.getItem(DEMO_DELAY_KEY)
    const value = Number(raw ?? '0')
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

/** 退出演示模式（清标记；MockAgentApi.setDemoDelay(0) 同步复位运行中节奏）。 */
export function clearDemoDelay(): void {
  try {
    globalThis.sessionStorage?.removeItem(DEMO_DELAY_KEY)
  } catch {
    // sessionStorage 不可用（隐私模式等）——开关本就无效，静默即可。
  }
}

function activateFromLocation(): void {
  if (typeof globalThis.location === 'undefined') return
  const parsed = parseDemoDelayQuery(globalThis.location.search)
  if (parsed === null) return
  try {
    globalThis.sessionStorage?.setItem(DEMO_DELAY_KEY, String(parsed))
  } catch {
    return
  }
  // 清 query 保持地址干净（不重载——SPA 状态与 sessionStorage 均保留；保 hash）。
  stripSearchParams(['demoDelay'])
}

// 模块加载即激活（早于任何 MockAgentApi 构造——mock.ts 本模块导入；jsdom 测试的
// location.search 恒空 → 无副作用）。
activateFromLocation()
