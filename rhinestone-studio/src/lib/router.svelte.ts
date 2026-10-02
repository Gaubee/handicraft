/**
 * hash 路由（split-admin-portal 1.4，2026-09-28；zhumo webui router.svelte.ts 同构）。
 * 选型：纯 Vite SPA + hash——daemon 静态托管零配置、路由变化不重载页面
 * （hashchange 监听）。前台内部仍由 view.svelte.ts 的视图枚举管理（home 路由
 * 不改变该机制——hash 路由只负责顶层分发：前台壳 / 登录页 / 后台壳）。
 * [product-polish-w1 T1] home 下钻会话子锚 `#/t/{sessionId}`（zhumo §1.1 补抄）：
 * 指定会话深链/回退/分享；选中写 hash（replaceState）与反向派发归
 * agentApi/sessionRoute.svelte.ts（双向同步编排层——本文件只管形状与顶层分发）。
 * 正交意图：
 *   [1] 解析 location.hash → Route 判别联合（home[+session]/login/admin）+ 非法回落。
 *   [2] navigate() + hashchange 订阅（Svelte 5 $state 单例）。
 *   [3] 登录回跳（守卫卡进登录前记下来处 hash，登录成功一次性消费）。
 */
export type AdminTab = 'accounts' | 'resources' | 'kb' | 'settings'

/**
 * home 三态（zhumo 路由同款，2026-10-02 中栏迁移）：
 * `#/t/{id}`=指定会话（session 下钻）；`#/new`=新建态（composer——中栏表单）；
 * 裸 `#/`=默认最新/列表态。composer 与 session 互斥（锚形状二选一）。
 */
export type Route =
  | { name: 'home'; session?: string; composer?: boolean }
  | { name: 'login' }
  | { name: 'admin'; tab: AdminTab }

const ADMIN_TABS = ['accounts', 'resources', 'kb', 'settings'] as const

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0] ?? '/'
  const segments = path.split('/').filter((s) => s.length > 0)
  if (segments[0] === 'login') return { name: 'login' }
  if (segments[0] === 'admin') {
    const tab = segments[1]
    if (tab !== undefined && (ADMIN_TABS as readonly string[]).includes(tab)) {
      return { name: 'admin', tab: tab as AdminTab }
    }
    // 非法/缺省 tab 回落账号页（spec：非法 tab 回落 accounts）。
    return { name: 'admin', tab: 'accounts' }
  }
  // 会话子锚（T1）：`#/t/{sessionId}`——home 下钻指定会话；缺 id 回裸 home
  // （`#/t` 不构成锚）。锚与 login/admin 互斥（顶层先判）。
  if (segments[0] === 't' && segments[1] !== undefined && segments[1] !== '') {
    return { name: 'home', session: segments[1] }
  }
  // 新建态锚（zhumo 三态同款）：`#/new`=新建（中栏 composer 表单）；后续段忽略。
  if (segments[0] === 'new') return { name: 'home', composer: true }
  // 其余一切（含空 hash）= 前台壳（内部视图归 view.svelte.ts）。
  return { name: 'home' }
}

function currentRoute(): Route {
  return parseHash(location.hash)
}

/** 当前路由（响应式单例）。 */
export const router = $state<{ route: Route }>({ route: currentRoute() })

/** 编程导航（hash 变更驱动重渲染；不重载页面）。 */
export function navigate(to: string): void {
  location.hash = to
}

let listening = false

export function startRouter(): void {
  if (listening) return
  listening = true
  const sync = (): void => {
    router.route = currentRoute()
  }
  window.addEventListener('hashchange', sync)
  window.addEventListener('popstate', sync)
  sync()
}

/** Route → hash（与 parseHash 互逆；测试与跳转辅助）。 */
export function routeHash(route: Route): string {
  switch (route.name) {
    case 'login':
      return '#/login'
    case 'admin':
      return `#/admin/${route.tab}`
    case 'home':
      if (route.composer === true) return '#/new'
      return route.session !== undefined ? `#/t/${route.session}` : '#/'
    default:
      return '#/'
  }
}

/** 登录回跳：守卫卡进登录前记下来处 hash（#/login 本身与空 hash 不记）。 */
export function stashReturnTo(): void {
  if (location.hash === '' || location.hash === '#/' || location.hash === '#/login') return
  try {
    sessionStorage.setItem('handicraft.return-to', location.hash)
  } catch {
    // 隐私模式等存储不可用：静默降级为登录后回 #/。
  }
}

/** 登录成功后取回来处（一次性消费；无记录/无效值回默认首页）。 */
export function consumeReturnTo(): string {
  let to: string | null = null
  try {
    to = sessionStorage.getItem('handicraft.return-to')
    sessionStorage.removeItem('handicraft.return-to')
  } catch {
    to = null
  }
  return to !== null && to !== '' && to !== '#/login' ? to : '#/'
}

/** 测试复位（jsdom hash/location 跨测试存留——挂载前显式归位）。 */
export function resetRouterForTests(hash = ''): void {
  try {
    location.hash = hash
  } catch {
    // location 只读环境：仅重置路由态。
  }
  router.route = parseHash(hash)
}
