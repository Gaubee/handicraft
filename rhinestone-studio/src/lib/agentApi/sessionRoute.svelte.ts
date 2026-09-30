/*
 * 会话 URL 锚定（product-polish-w1 T1——补抄 zhumo §1.1「它有 url 导航绑定，你没有」）。
 * hash 语义：`#/t/{sessionId}`=打开指定会话（home 路由下钻——login/admin 不受影响）；
 * 裸 `#/`=默认最新会话（8317 既有书签/分享兼容——行为不变，落地后被选中会话的锚
 * 镜像替换）。双向同步：
 *   - 选中 → hash：openSession 后 replaceState 写 `#/t/{id}`（不触发 hashchange、
 *     不进历史栈——防 init/切回/清理兜底等自动选中把浏览器历史刷成会话序列）。
 *   - hash → 选中：hashchange/popstate（回退/前进/深链/手改 URL）反向派发
 *     openSession（fromHash——不再回写 hash，URL 是该向的真源）。
 * zhumo `#/new` 为过渡态、落地即 `#/t/{id}`——本仓 createSession 直落 `#/t/{id}`
 * 对齐，不设过渡态。document.title 跟随会话标题（无会话回默认「贴钻工作台」）。
 * 依赖方向：store → 本模块 → router（单向；反向派发经 startSessionRouteSync 注入
 * 回调，避免环）。
 */

import { parseHash } from '$lib/router.svelte'

/** 会话子锚前缀（`#/t/`——t=thread，zhumo 同形）。 */
const SESSION_ANCHOR_PREFIX = 't'

/** 默认文档标题（无会话/空标题/非 home 路由）。 */
export const DEFAULT_DOCUMENT_TITLE = '贴钻工作台'

/** 当前 hash 的会话锚（home 路由下钻；裸 `#/`/其他顶层=null）。 */
export function sessionAnchorOfHash(hash: string): string | null {
  const route = parseHash(hash)
  return route.name === 'home' && route.session !== undefined ? route.session : null
}

/**
 * 选中 → hash 镜像（replaceState——不触发 hashchange、不进历史栈）。
 * 守卫：当前处于 login/admin 顶层路由时不改写（Agent 面只在 home 下挂载，此为
 * 防御位）；sessionId=null（会话清空/无会话）回裸 `#/`。同值 no-op（幂等）。
 */
export function writeSessionHash(sessionId: string | null): void {
  const target = sessionId !== null ? `#/${SESSION_ANCHOR_PREFIX}/${sessionId}` : '#/'
  const route = parseHash(location.hash)
  // login/admin 顶层不动（会话锚只在 home 下钻——守卫卡/后台页的 URL 语义独立）。
  if (route.name !== 'home') return
  if (location.hash === target || (location.hash === '' && target === '#/')) return
  try {
    history.replaceState(null, '', target)
  } catch {
    // 受限环境降级（实证：jsdom 30 History-impl 对 hash URL 抛
    // targetURL.path.join is not a function）：回落 location.hash 赋值——会触发
    // hashchange，但反向监听按「锚=活跃会话」判定 no-op（不自激）。真实浏览器
    // 走主路径（不进历史栈）；降级路径仅在测试壳生效。
    location.hash = target
  }
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
}

let started = false

/**
 * 启动 hash → 选中 反向同步（幂等；initAgentStore 首拉完成后调用）。
 * 深链启动消费见 initAgentStore（首拉时直接对齐）；此后 hashchange/popstate
 * （回退/前进/手改）驱动：`#/t/x` → openSession(x, fromHash)；裸 `#/` → 打开
 * 列表最新（zhumo「`#/` 默认最新会话」同语义，URL 保持裸锚不回写）。
 */
export function startSessionRouteSync(deps: SessionRouteDeps): void {
  if (started) return
  started = true
  const dispatch = (): void => {
    if (!deps.initialized()) return
    // 顶层先判：login/admin 路由不派发（会话锚只在 home 下钻——守卫卡/后台页的
    // URL 语义独立，切去登录/后台不应动会话选中）。
    const route = parseHash(location.hash)
    if (route.name !== 'home') return
    if (route.session !== undefined) {
      if (route.session !== deps.activeSessionId()) void deps.openSession(route.session, { fromHash: true })
      return
    }
    // 裸 `#/`（home 无下钻）：默认最新会话（列表序第一）。
    deps.openLatest()
  }
  window.addEventListener('hashchange', dispatch)
  window.addEventListener('popstate', dispatch)
}

/** 测试复位（跨测试 hash/listener 存留）。 */
export function resetSessionRouteForTests(hash = ''): void {
  started = false
  try {
    location.hash = hash
  } catch {
    // location 只读环境：跳过。
  }
}

/**
 * document.title 跟随会话标题（zhumo §1.1 同款）：有会话且标题非空 =
 * `{标题} · 贴钻工作台`；无会话/空标题 = 默认「贴钻工作台」。
 */
export function syncSessionDocumentTitle(sessionTitle: string | null): void {
  const trimmed = sessionTitle?.trim() ?? ''
  document.title = trimmed.length > 0 ? `${trimmed} · ${DEFAULT_DOCUMENT_TITLE}` : DEFAULT_DOCUMENT_TITLE
}
