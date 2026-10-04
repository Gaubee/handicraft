/**
 * hash 路由（split-admin-portal 1.4，2026-09-28；zhumo webui router.svelte.ts 同构；
 * unify-studio-routing 2026-10-04 扩全路由表——本仓唯一 history 调用点）。
 * 选型：纯 Vite SPA + hash——daemon 静态托管零配置、路由变化不重载页面
 * （hashchange 监听）。既有深链面（#/t/{id} 8317 书签、#/new、#/login、#/admin/*）
 * 形状与语义零改；本批把前台壳内部视图态（view.svelte.ts 枚举）与任务详情面板
 * tab 状态收进同一路由表（design §2）。
 * 正交意图：
 *   [1] 解析 location.hash → Route 判别联合 + 非法回落（design §2 路由表）。
 *   [2] navigate() + hashchange 订阅（Svelte 5 $state 单例）。
 *   [3] 登录回跳（守卫卡进登录前记下来处 hash，登录成功一次性消费）。
 *   [4] history 执行器单出口（writeHash/stripSearchParams——全仓 pushState/
 *       replaceState/location.hash 写收编于此，守卫测试把门，design §4）。
 */
export type AdminTab = 'accounts' | 'resources' | 'kb' | 'settings'

/** 前台壳视图枚举（源定义——view.svelte.ts 兼容 re-export）。 */
export type ViewId = 'agent' | 'assets' | 'stones' | 'warehouse' | 'lab' | 'studio' | 'strategy' | 'edit'

/** 任务详情面板 tab（TaskDetailPanel——result 值域另携 publicId）。 */
export type TaskTab = 'detail' | 'activity' | 'workbench' | 'result'

/**
 * home 路由（前台壳内部）：view 段 + 各视图专属子段。agent 三态（zhumo 路由同款，
 * 2026-10-02 中栏迁移）：`#/t/{id}`=指定会话（session 下钻）；`#/new`=新建态
 * （composer——中栏表单）；裸 `#/`=默认最新/列表态。composer 与 session 互斥。
 * taskTab/taskResultId：agent 视图任务详情面板的活动 tab（detail 缺省）。
 * studioTask：studio 视图任务上下文（任务详情工作台）；studioEngine：引擎实验。
 */
export interface HomeRoute {
  name: 'home'
  view: ViewId
  /** agent：`#/t/{sessionId}` 会话锚。 */
  session?: string
  /** agent：`#/new` 新建态（与 session 互斥）。 */
  composer?: boolean
  /** agent：任务详情面板 tab（缺省 detail）。 */
  taskTab?: Exclude<TaskTab, 'detail'>
  /** agent：taskTab=result 的导出 publicId。 */
  taskResultId?: string
  /** studio：任务详情工作台 taskId。 */
  studioTask?: string
  /** studio：引擎实验（旧排钻面板）。 */
  studioEngine?: boolean
}

export type Route = HomeRoute | { name: 'login' } | { name: 'admin'; tab: AdminTab }

const ADMIN_TABS = ['accounts', 'resources', 'kb', 'settings'] as const

/** 前台视图段（agent 缺省不占段——裸 `#/` 即 agent；`#/agent` 显式形也接受）。 */
const VIEW_SEGMENTS: readonly ViewId[] = ['agent', 'assets', 'stones', 'warehouse', 'lab', 'studio', 'strategy', 'edit']

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
  // [unify-studio-routing] studio 视图子段：task/{id}=任务详情工作台；engine=引擎实验；
  // 其余未知段忽略回落 `#/studio`。
  if (segments[0] === 'studio') {
    if (segments[1] === 'task' && segments[2] !== undefined && segments[2] !== '') {
      return { name: 'home', view: 'studio', studioTask: segments[2] }
    }
    if (segments[1] === 'engine') return { name: 'home', view: 'studio', studioEngine: true }
    return { name: 'home', view: 'studio' }
  }
  // 其余具名视图段（assets/stones/warehouse/lab/strategy/edit/agent——开发面随旗标）。
  if (segments[0] !== 't' && segments[0] !== 'new' && (VIEW_SEGMENTS as readonly string[]).includes(segments[0])) {
    return { name: 'home', view: segments[0] as ViewId }
  }
  // 会话子锚（T1）：`#/t/{sessionId}`——agent 视图下钻指定会话；尾段 taskTab：
  // /activity、/workbench、/r/{publicId}（结果 tab）；缺 id 回裸 home（`#/t` 不构成锚）。
  if (segments[0] === 't' && segments[1] !== undefined && segments[1] !== '') {
    const home: HomeRoute = { name: 'home', view: 'agent', session: segments[1] }
    if (segments[2] === 'activity') home.taskTab = 'activity'
    else if (segments[2] === 'workbench') home.taskTab = 'workbench'
    else if (segments[2] === 'r' && segments[3] !== undefined && segments[3] !== '') {
      home.taskTab = 'result'
      home.taskResultId = segments[3]
    }
    return home
  }
  // 新建态锚（zhumo 三态同款）：`#/new`=新建（中栏 composer 表单）；后续段忽略。
  if (segments[0] === 'new') return { name: 'home', view: 'agent', composer: true }
  // 其余一切（含空 hash / `#/agent`）= Agent 主面缺省（内部视图归 view.svelte.ts）。
  return { name: 'home', view: 'agent' }
}

function currentRoute(): Route {
  return parseHash(location.hash)
}

/** 当前路由（响应式单例）。 */
export const router = $state<{ route: Route }>({ route: currentRoute() })

/**
 * history 执行器（全仓唯一 pushState/replaceState 出口——unify-studio-routing 收编）。
 * 调用方须已同步写完自身状态（状态先行——design §3）：本执行器不派发事件（镜像
 * 无需回派）；router.route 即时同步（修既有镜像后 route stale 的微瑕）。
 * jsdom 降级：History-impl 对 hash URL 抛 targetURL.path.join is not a function
 * （sessionRoute 既有实证）——回落 location.hash 赋值（会触发 hashchange，反向
 * 监听按等值幂等消化）；真实浏览器走主路径。
 */
export function writeHash(hash: string, opts?: { push?: boolean }): void {
  if (opts?.push !== true && (location.hash === hash || (location.hash === '' && hash === '#/'))) return
  try {
    if (opts?.push === true) history.pushState(null, '', hash)
    else history.replaceState(null, '', hash)
  } catch {
    try {
      location.hash = hash
    } catch {
      // 受限环境双降级：路由态仍即时同步（重挂载读 location 兜底）。
    }
  }
  router.route = currentRoute()
}

/** 编程导航（hash 变更驱动重渲染；不重载页面）。缺省 push（location.hash 赋值
 *  自然进栈+触发 hashchange）；replace 变体走 writeHash（不触发事件——调用方
 *  状态先行）。 */
export function navigate(to: string, opts?: { replace?: boolean }): void {
  if (opts?.replace === true) {
    writeHash(to)
    return
  }
  location.hash = to
}

/**
 * boot 期一次性 query 清参（urlFlags `?api=rpc`/`?workbenches=1`、demoDelay
 * `?demoDelay=`——写入即清保持地址干净；**保 hash**）。demoDelay 旧实现清参丢
 * hash（replaceState pathname-only）——本出口顺修。
 */
export function stripSearchParams(names: string[]): void {
  if (typeof location === 'undefined' || typeof URLSearchParams === 'undefined') return
  const url = new URL(location.href)
  let changed = false
  for (const name of names) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name)
      changed = true
    }
  }
  if (!changed) return
  try {
    history.replaceState(null, '', url)
  } catch {
    // history 不可用（极端 jsdom 桩）——地址带 query 不影响功能。
    return
  }
  router.route = currentRoute()
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

/** Route → hash（与 parseHash 互逆——规范形；测试与跳转辅助）。 */
export function routeHash(route: Route): string {
  switch (route.name) {
    case 'login':
      return '#/login'
    case 'admin':
      return `#/admin/${route.tab}`
    case 'home':
      if (route.view === 'agent') {
        if (route.composer === true) return '#/new'
        if (route.session !== undefined) {
          const tab =
            route.taskTab === 'activity'
              ? '/activity'
              : route.taskTab === 'workbench'
                ? '/workbench'
                : route.taskTab === 'result' && route.taskResultId !== undefined
                  ? `/r/${route.taskResultId}`
                  : ''
          return `#/t/${route.session}${tab}`
        }
        return '#/'
      }
      if (route.view === 'studio') {
        if (route.studioTask !== undefined) return `#/studio/task/${route.studioTask}`
        if (route.studioEngine === true) return '#/studio/engine'
        return '#/studio'
      }
      return `#/${route.view}`
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
