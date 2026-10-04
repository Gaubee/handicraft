/**
 * [2026-09-18 UX] 顶栏视图切换的唯一状态源（'lab' | 'studio' 起步，历批扩至八字段）。
 * [unify-studio-routing 2026-10-04] 视图态路由化：本 store 保持既有 API（getView/
 * setView/openStudioTask/closeStudioTask）并新增 studio 子态（studioMode）与任务详情
 * 面板 tab 态（taskTab/taskResultId），全部经 hash 路由镜像（design §3 双向同步）：
 *   - 程序向（UI 动作）：状态先行（同步写 $state——既有调用方/测试零迁移）→
 *     routeHash(当前态) 镜像（显式导航 push 进栈可回退；closeStudioTask 等收口
 *     动作 replace 防历史膨胀）。
 *   - URL 向（回退/前进/深链/手改）：startViewRouteSync 监听 hashchange/popstate
 *     反向派发写 $state（URL 为该向真源——不回写）。
 * 会话段（session/composer）归 agentApi/sessionRoute（分区监听各写各字段）；本
 * store 格式化 agent 路由时经 provider 注入回填会话态（bindViewRouteSessionSource
 * ——避免 view ↔ agentApi/store 静态环：store→view 单向，view 不 import store）。
 * 视图枚举沿革：'agent'（W3 产品默认）/'assets'/'stones'/'warehouse'/'lab'/
 * 'studio'（含任务上下文态 studioTaskId——add-task-detail-layer-workbench 2.1）/
 * 'strategy'/'edit'。
 */

import {
  parseHash,
  resetRouterForTests,
  routeHash,
  writeHash,
  type HomeRoute,
  type TaskTab,
  type ViewId,
} from '$lib/router.svelte'

export type { TaskTab, ViewId }

/** studio 视图模式（'select'=模式选择；'engine'=引擎实验——路由 `#/studio/engine`）。 */
export type StudioMode = 'select' | 'engine'

let current = $state<ViewId>('agent')
/** studio 视图的任务上下文（null=无任务——模式选择面；置位=任务详情工作台）。 */
let studioTaskId = $state<string | null>(null)
/** studio 视图模式（引擎实验入口——路由化前为 StudioView 组件实例态）。 */
let studioMode = $state<StudioMode>('select')
/** 任务详情面板活动 tab（detail 缺省无 URL 段；result 值域另携 taskResultId）。 */
let taskTabValue = $state<TaskTab>('detail')
let taskResultId = $state<string | null>(null)

/** 会话态 provider（agent 路由格式化回填 session/composer——store 初始化时绑定）。 */
interface ViewRouteSessionSource {
  session(): string | null
  composer(): boolean
}

let sessionSource: ViewRouteSessionSource = { session: () => null, composer: () => false }

/** 绑定会话态读取面（initAgentStore 调用——避免静态环的运行期注入）。 */
export function bindViewRouteSessionSource(source: ViewRouteSessionSource): void {
  sessionSource = source
}

/** 当前视图+子态 → HomeRoute（镜像格式化单源——store 态为程序向真源）。 */
function currentHomeRoute(): HomeRoute {
  if (current === 'agent') {
    const composer = sessionSource.composer()
    const session = sessionSource.session()
    const route: HomeRoute = { name: 'home', view: 'agent' }
    if (composer) route.composer = true
    else if (session !== null) route.session = session
    if (taskTabValue !== 'detail') {
      route.taskTab = taskTabValue
      if (taskTabValue === 'result' && taskResultId !== null) route.taskResultId = taskResultId
    }
    return route
  }
  if (current === 'studio') {
    if (studioTaskId !== null) return { name: 'home', view: 'studio', studioTask: studioTaskId }
    if (studioMode === 'engine') return { name: 'home', view: 'studio', studioEngine: true }
    return { name: 'home', view: 'studio' }
  }
  return { name: 'home', view: current }
}

/** 状态先行已毕 → hash 镜像（不派发事件——本向 store 是真源）。 */
function mirrorRoute(push: boolean): void {
  writeHash(routeHash(currentHomeRoute()), { push })
}

export function getView(): ViewId {
  return current
}

export function setView(view: ViewId): void {
  if (current === view) return
  current = view
  mirrorRoute(true)
}

export function getStudioTaskId(): string | null {
  return studioTaskId
}

/** 打开任务详情（SessionStream/FrameView/TaskDetailPanel 入口唯一写面）：置任务
 * 上下文+切 studio 视图（push——回退可回来处）。 */
export function openStudioTask(taskId: string): void {
  studioTaskId = taskId
  current = 'studio'
  mirrorRoute(true)
}

/** 离开任务详情（工作台「返回」）：清任务上下文——studio 回模式选择面（replace——
 * 收口动作不叠历史，back 直回来处）。 */
export function closeStudioTask(): void {
  if (studioTaskId === null) return
  studioTaskId = null
  if (current === 'studio') mirrorRoute(false)
}

export function getStudioMode(): StudioMode {
  return studioMode
}

/** 引擎实验进/出（StudioView 模式选择——push：显式导航可回退）。 */
export function setStudioMode(mode: StudioMode): void {
  if (studioMode === mode) return
  studioMode = mode
  if (current === 'studio' && studioTaskId === null) mirrorRoute(true)
}

export function getTaskTab(): TaskTab {
  return taskTabValue
}

export function getTaskResultId(): string | null {
  return taskResultId
}

/**
 * 任务详情面板 tab 切换（TaskDetailPanel 触发器/导出行/关闭钮/自动回退共用）。
 * push 缺省（用户显式切换）；自动回退类（导出消失回详情）传 replace。
 */
export function openTaskTab(tab: TaskTab, opts?: { resultId?: string; replace?: boolean }): void {
  const next = tab
  if (next === taskTabValue && (next !== 'result' || opts?.resultId === taskResultId)) return
  taskTabValue = next
  taskResultId = next === 'result' ? (opts?.resultId ?? null) : null
  if (current === 'agent') mirrorRoute(opts?.replace !== true)
}

let started = false

/**
 * URL → 视图态 反向同步（回退/前进/深链/手改 URL；幂等监听+每次调用即同步——
 * App 每次挂载调用，重挂载（刷新还原）即时对齐）。login/admin 顶层不动（守卫卡/
 * 后台页 URL 语义独立）；session 段归 sessionRoute 分区监听（本层只写视图字段）。
 */
export function startViewRouteSync(): void {
  const sync = (): void => {
    const route = parseHash(location.hash)
    if (route.name !== 'home') return
    current = route.view
    studioTaskId = route.studioTask ?? null
    studioMode = route.studioEngine === true ? 'engine' : 'select'
    taskTabValue = route.taskTab ?? 'detail'
    taskResultId = route.taskTab === 'result' ? (route.taskResultId ?? null) : null
  }
  if (!started) {
    started = true
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
  }
  sync()
}

/**
 * 测试复位视图态（模块级 $state 跨测试存留——App 级测试前置复位到默认 Agent 落地）。
 * [unify-studio-routing] 复位=状态与 hash **一致**归位：hash 落该视图规范锚（而非裸
 * 清）——仅清 hash 会把复位成的视图在下次挂载初始同步（startViewRouteSync 调用即
 * 同步）里被 '' →agent 覆写（实证 app.globalImport 失败分支：复位 assets 被打回
 * agent）；反之仅复位 $state 会把上一测试的 hash 泄漏给下一次挂载（实证 app.smoke
 * handoff 轮）。测试自设深链须在本复位**之后**赋 hash（appRouting 同式）。
 */
export function resetViewForTests(view: ViewId = 'agent'): void {
  current = view
  studioTaskId = null
  studioMode = 'select'
  taskTabValue = 'detail'
  taskResultId = null
  resetRouterForTests(routeHash({ name: 'home', view }))
}
