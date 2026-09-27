/**
 * URL 参数一次性引导（Owner 验收入口——免控制台手敲 localStorage）。
 * `?api=rpc` → handicraft.agentApi='rpc'（agentApi 工厂运行时读取——同源 daemon WS）；
 * `?workbenches=1` → handicraft.dev.workbenches='1'（须先于 devFlag 模块求值——
 * 本模块以副作用形式在 main.ts 首位 import，深度优先保证时序）。
 * 写入即 replaceState 清参（刷新/分享不带参数；localStorage 持久——后续直接走裸入口）。
 */

if (typeof window !== 'undefined' && typeof URLSearchParams !== 'undefined') {
  const url = new URL(window.location.href)
  const api = url.searchParams.get('api')
  const workbenches = url.searchParams.get('workbenches')
  if (api === 'rpc') localStorage.setItem('handicraft.agentApi', 'rpc')
  if (workbenches === '1') localStorage.setItem('handicraft.dev.workbenches', '1')
  if (api !== null || workbenches !== null) {
    url.searchParams.delete('api')
    url.searchParams.delete('workbenches')
    window.history.replaceState(null, '', url)
  }
}

export {}
