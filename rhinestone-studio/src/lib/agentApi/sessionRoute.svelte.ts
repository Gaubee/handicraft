/*
 * 会话 URL 锚定（product-polish-w1 T1——补抄 zhumo §1.1「它有 url 导航绑定，你没有」）。
 * hash 三态（zhumo 同款，2026-10-02 中栏迁移）：`#/t/{sessionId}`=打开指定会话；
 * `#/new`=新建态（中栏 composer 表单——不打开任何会话）；裸 `#/`=默认最新会话
 * （8317 既有书签/分享兼容——行为不变，落地后被选中会话的锚镜像替换）。双向同步：
 *   - 选中 → hash：openSession 后镜像 `#/t/{id}`（缺省 replace 不进栈——防 init/
 *     切回/清理兜底等自动选中把浏览器历史刷成会话序列）。
 *     例外：composer 创建成功（pushHistory）叠新会话锚进栈——浏览器后退可回新建态
 *     （zhumo navigate 同为进栈）。
 *   - hash → 选中：hashchange/popstate（回退/前进/深链/手改 URL）反向派发
 *     openSession（fromHash——不再回写 hash，URL 是该向的真源）；`#/new` 派发
 *     openComposer（清选中视图、不回写）；裸 `#/` 派发 openLatest。
 * [unify-studio-routing 2026-10-04] ①镜像/派发均加 **agent 视图门**（home 路由的
 * view 段=agent 才作用——studio 等视图路由下会话段不可表示，切回 agent 时由 view
 * store 镜像从本 store 回填）；②镜像保留 taskTab 段（同会话镜像不剥深链 tab——
 * `#/t/s1/workbench` init 对齐；换会话剥段——任务切换回详情面板既有语义）；③
 * history 调用收编 router.writeHash（jsdom 降级路径上移——本文件零直接 history 写）。
 * document.title 跟随会话标题（无会话回默认「贴钻工作台」）。
 * 依赖方向：store → 本模块 → router/view（单向；view→router 单向；反向派发经
 * startSessionRouteSync 注入回调，避免环）。
 */

import { parseHash, resetRouterForTests, routeHash, writeHash } from '$lib/router.svelte'
import { getTaskResultId, getTaskTab } from '$lib/stores/view.svelte'

/** 新建态锚 hash（`#/new`——中栏 composer；zhumo 同形）。 */
export const NEW_TASK_ANCHOR_HASH = '#/new'

/** 默认文档标题（无会话/空标题/非 home 路由）。 */
export const DEFAULT_DOCUMENT_TITLE = '贴钻工作台'

/** 当前 hash 的会话锚（home 路由下钻；裸 `#/`/`#/new`/其他顶层=null）。 */
export function sessionAnchorOfHash(hash: string): string | null {
  const route = parseHash(hash)
  return route.name === 'home' && route.view === 'agent' && route.session !== undefined
    ? route.session
    : null
}

/** hash 是否为新建态锚（`#/new`——home 域；首开深链与派发共用）。 */
export function isNewTaskAnchorOfHash(hash: string): boolean {
  const route = parseHash(hash)
  return route.name === 'home' && route.view === 'agent' && route.composer === true
}

/** home·agent 路由判定（视图门——会话段只在 agent 视图下可表示）。 */
function isAgentViewRoute(hash: string): boolean {
  const route = parseHash(hash)
  return route.name === 'home' && route.view === 'agent'
}

/**
 * 选中 → hash 镜像（缺省 replace——不触发 hashchange、不进历史栈）。
 * opts.push=true（composer 创建成功）：叠新条目进栈——后退回新建态。守卫：当前
 * 非 home·agent 路由时不改写（studio 等视图下会话段不可表示；login/admin 顶层
 * URL 语义独立）；sessionId=null（会话清空/无会话）回裸 `#/`。
 * taskTab 段：同会话镜像保留（view store 读——深链 tab 不被 init 对齐剥段）；
 * 换会话剥段（任务切换回详情——面板侧 effect 随后复位 store 态）。
 * 同值 no-op（幂等——push 路径除外：创建锚落定前目标必异于现值）。
 */
export function writeSessionHash(sessionId: string | null, opts?: { push?: boolean }): void {
  if (!isAgentViewRoute(location.hash)) return
  let target: string
  if (sessionId === null) {
    target = '#/'
  } else {
    const parsed = parseHash(location.hash)
    const sameSession = parsed.name === 'home' && parsed.session === sessionId
    const tab = sameSession ? getTaskTab() : 'detail'
    const resultId = sameSession ? getTaskResultId() : null
    target =
      routeHash({
        name: 'home',
        view: 'agent',
        session: sessionId,
        ...(tab !== 'detail' ? { taskTab: tab, ...(tab === 'result' && resultId !== null ? { taskResultId: resultId } : {}) } : {}),
      })
  }
  if (opts?.push !== true && (location.hash === target || (location.hash === '' && target === '#/'))) return
  writeHash(target, { push: opts?.push === true })
}

/** 反向派发依赖（store 注入——避免模块环）。 */
export interface SessionRouteDeps {
  /** hash 指定的会话 ≠ 活跃时反向打开（fromHash——不回写 hash）。 */
  openSession(sessionId: string, opts?: { fromHash?: boolean }): Promise<void>
  /** 活跃会话 id（null=无）。 */
  activeSessionId(): string | null
  /** store 已完成首拉（未初始化时深链由 init 消费，监听先静默）。 */
  initialized(): boolean
  /** 打开列表序第一会话（裸 `#/` 的「默认最新」语义）。 */
  openLatest(): void
  /** 进入新建态（`#/new`——清选中视图，不创建会话；不回写 hash）。 */
  openComposer(): void
}

let started = false

/**
 * 启动 hash → 选中 反向同步（幂等；initAgentStore 首拉完成后调用）。
 * 深链启动消费见 initAgentStore（首拉时直接对齐）；此后 hashchange/popstate
 * （回退/前进/手改）驱动：`#/t/x` → openSession(x, fromHash)；`#/new` →
 * openComposer（清选中——中栏表单）；裸 `#/` → 打开列表最新（zhumo「`#/`
 * 默认最新会话」同语义，URL 保持裸锚不回写）。
 * [unify-studio-routing] 视图门：非 agent 视图路由（#/studio 等）不派发——
 * 切视图不动会话选中（切回 agent 由 view 镜像回填锚）。
 */
export function startSessionRouteSync(deps: SessionRouteDeps): void {
  if (started) return
  started = true
  const dispatch = (): void => {
    if (!deps.initialized()) return
    // 顶层先判：login/admin 路由不派发（会话锚只在 home 下钻——守卫卡/后台页的
    // URL 语义独立，切去登录/后台不应动会话选中）。
    const route = parseHash(location.hash)
    if (route.name !== 'home' || route.view !== 'agent') return
    if (route.composer === true) {
      deps.openComposer()
      return
    }
    if (route.session !== undefined) {
      if (route.session !== deps.activeSessionId()) void deps.openSession(route.session, { fromHash: true })
      return
    }
    // 裸 `#/`（agent 无下钻）：默认最新会话（列表序第一）。
    deps.openLatest()
  }
  window.addEventListener('hashchange', dispatch)
  window.addEventListener('popstate', dispatch)
}

/** 测试复位（跨测试 hash/listener 存留——hash 归位委托 router）。 */
export function resetSessionRouteForTests(hash = ''): void {
  started = false
  resetRouterForTests(hash)
}

/**
 * document.title 跟随会话标题（zhumo §1.1 同款）：有会话且标题非空 =
 * `{标题} · 贴钻工作台`；无会话/空标题 = 默认「贴钻工作台」。
 */
export function syncSessionDocumentTitle(sessionTitle: string | null): void {
  const trimmed = sessionTitle?.trim() ?? ''
  document.title = trimmed.length > 0 ? `${trimmed} · ${DEFAULT_DOCUMENT_TITLE}` : DEFAULT_DOCUMENT_TITLE
}
