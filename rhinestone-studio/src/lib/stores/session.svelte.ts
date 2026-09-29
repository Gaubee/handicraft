/**
 * 会话状态 store（split-admin-portal 1.5，2026-09-28；zhumo webui stores/auth.svelte.ts 同构适配）。
 * 唯一会话真源：currentUser{username,role}|null + allowAnonymous（bootstrap 现状投影）。
 * token 生命周期走 daemonToken 存储层（sessionStorage 既有键位——rpc/modelsApi 等
 * 客户端经同一键位取登录 token；登录态优先、匿名兜底在存储层单点成立）。
 * 正交意图：
 *   [1] initSession：bootstrap（/api/bootstrap 现有投影）+ 有 token 时 auth.me 恢复
 *       （401 → auth.refresh 一次 → 仍失败清 token 归匿名/未登录）。
 *   [2] login/logout/anonymous：写 token+会话投影；错误中文进 session.error（登录页直显）。
 *   [3] admin 判定（顶栏后台入口/AdminPage 守卫卡共用）。
 */
import { BootstrapOutputSchema } from '@handicraft/contracts'
import { adminApi, type AdminSessionUser } from '$lib/adminApi'
import {
  clearStoredToken,
  fetchAnonymousToken,
  getStoredToken,
  setStoredToken,
} from '$lib/daemonToken'

export type { AdminSessionUser }

/** 匿名会话的用户投影（daemon 内置 __anonymous__ 账号；username 展示为「匿名用户」）。 */
export const ANONYMOUS_SESSION_USER: AdminSessionUser = { username: '__anonymous__', role: 'anonymous' }
export const ANONYMOUS_DISPLAY_NAME = '匿名用户'

function resolveBaseUrl(): string {
  return (globalThis.location?.origin ?? 'http://127.0.0.1:8317').replace(/\/$/, '')
}

const session = $state({
  user: null as AdminSessionUser | null,
  /** bootstrap 投影（null=未取到/加载失败——登录页匿名入口不显示）。 */
  allowAnonymous: null as boolean | null,
  /** initSession 至少完成一轮（前台壳可据此区分加载中）。 */
  initialized: false,
  /** 最近一次 login/anonymous 失败的中文错误（登录页直显；新尝试即清）。 */
  error: null as string | null,
})

export function getSessionUser(): AdminSessionUser | null {
  return session.user
}

export function getAllowAnonymous(): boolean | null {
  return session.allowAnonymous
}

export function isSessionInitialized(): boolean {
  return session.initialized
}

export function getSessionError(): string | null {
  return session.error
}

export function isAdmin(): boolean {
  return session.user?.role === 'admin'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 启动恢复：bootstrap（allowAnonymous 现状投影）+ 会话还原（有 token → auth.me；
 * 失败 → auth.refresh 一次 → 仍失败清 token 归未登录）。不抛错——启动不因
 * daemon 不可达而死（前台壳照常渲染，登录入口可用）。
 */
export async function initSession(): Promise<void> {
  session.error = null
  try {
    const response = await fetch(`${resolveBaseUrl()}/api/bootstrap`)
    if (response.ok) {
      const out = BootstrapOutputSchema.parse(await response.json())
      session.allowAnonymous = out.allowAnonymous
    }
  } catch {
    // bootstrap 不可达：allowAnonymous 保持 null（登录页匿名入口不显示）。
  }
  const token = getStoredToken()
  if (token === null) {
    session.initialized = true
    return
  }
  try {
    session.user = await adminApi().me()
  } catch {
    try {
      const refreshed = await adminApi().refresh(token)
      setStoredToken(refreshed.token)
      session.user = refreshed.user
    } catch {
      clearStoredToken()
      session.user = null
    }
  }
  session.initialized = true
}

/** 用户名+口令登录（成功写 token+会话投影；失败置 session.error 返回 false）。 */
export async function login(username: string, password: string): Promise<boolean> {
  session.error = null
  try {
    const out = await adminApi().login(username, password)
    setStoredToken(out.token)
    session.user = out.user
    return true
  } catch (error) {
    session.error = errorMessage(error)
    return false
  }
}

/**
 * 匿名进入（allowAnonymous 开时的登录页次入口）：POST /api/auth/anonymous 取
 * token（daemon 侧匿名关闭时非 2xx → 失败）→ auth.me 还原会话投影。
 */
export async function loginAnonymous(): Promise<boolean> {
  session.error = null
  try {
    clearStoredToken() // 旧 token（可能已失效）先清——匿名端点取全新 token
    const token = await fetchAnonymousToken(resolveBaseUrl())
    if (token === undefined) {
      session.error = '匿名访问未开启或不可用，请使用账号登录'
      return false
    }
    session.user = await adminApi().me()
    return true
  } catch (error) {
    session.error = errorMessage(error)
    return false
  }
}

/** 登出：清 token+会话投影；allowAnonymous 开时自动回落匿名（zhumo 同款动线）。 */
export async function logout(): Promise<void> {
  clearStoredToken()
  session.user = null
  session.error = null
  if (session.allowAnonymous === true) {
    if (await loginAnonymous()) return
  }
}

/** 测试复位（模块级 $state 跨测试存留——挂载前显式归位；默认=已初始化的未登录态）。 */
export function resetSessionForTests(
  user: AdminSessionUser | null = null,
  allowAnonymous: boolean | null = null,
): void {
  session.user = user
  session.allowAnonymous = allowAnonymous
  session.initialized = true
  session.error = null
  clearStoredToken()
}
