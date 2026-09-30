/*
 * daemon token 生命周期（split-admin-portal 1.5，2026-09-28）。
 * sessionStorage 既有键位 `handicraft.daemon.token` 的唯一读写面：登录页/会话
 * store 写入登录 token；匿名兜底（allowAnonymous 开时）POST /api/auth/anonymous
 * 自动获取并缓存。rpc.ts / modelsApi / imageProcessingApi / adminApi 全部经本
 * 模块取 token——「有登录态用登录 token，无则匿名兜底」在存储层单点成立。
 * 背景：W3.1 时代各客户端各自内联同款逻辑（rpc.ts/modelsApi/imageProcessingApi
 * 三处复制）——波 1 登录态引入后收敛为共享模块（rpc.ts 已切换；modelsApi/
 * imageProcessingApi 保持各自内联（resolveToken 语义等价，合流后统一替换）。
 *
 * 匿名 token 独立键位（Owner 验收 2026-09-30 走查修复）：原实现把匿名 token 写
 * TOKEN_KEY——「登录前的匿名请求晚到」会在登录写 token 之后覆盖之（首进后台
 * settings 报「需要管理员权限」根因：存储与连接 token 一致，各 RPC 面的代际
 * 漂移检测全部失效）。现匿名 token 只写 ANONYMOUS_TOKEN_KEY（登录/登出的
 * setStoredToken/clearStoredToken 不触碰它），登录 token 恒优先；匿名身份经
 * 独立键位跨刷新/登出再进入保持稳定。
 */

export const TOKEN_KEY = 'handicraft.daemon.token'

/** 匿名 token 独立键位（不与登录 token 同键——防晚到覆盖竞态，见头注）。 */
export const ANONYMOUS_TOKEN_KEY = 'handicraft.daemon.anonymous-token'

/** 进行中匿名请求去重（并发调用共享一次网络请求）。 */
let anonymousPending: Promise<string | undefined> | null = null

/** 当前存储 token（无存储/未登录且未匿名过 → null）。 */
export function getStoredToken(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null
  } catch {
    return null
  }
}

/** 登录成功写入登录 token（匿名键位不受影响——登出再匿名进入仍是同一匿名身份）。 */
export function setStoredToken(token: string): void {
  try {
    globalThis.sessionStorage?.setItem(TOKEN_KEY, token)
  } catch {
    // 隐私模式等存储不可用：跳过（后续调用回落无 token 连接）。
  }
}

/** 登出/失效清除（仅登录 token；匿名键位保留供下次匿名兜底复用）。 */
export function clearStoredToken(): void {
  try {
    globalThis.sessionStorage?.removeItem(TOKEN_KEY)
  } catch {
    // 同上：静默降级。
  }
}

/**
 * 匿名 token 兜底（allowAnonymous 开时可用）：POST /api/auth/anonymous（既有
 * HTTP 端点，daemon 侧匿名关闭时返回非 2xx → undefined）。取用顺序=登录 token
 * （TOKEN_KEY）→ 匿名缓存（ANONYMOUS_TOKEN_KEY）→ 网络解析（写匿名键位+内存
 * 去重）。失败静默（调用方以无 token 连接，由服务端按 401/403 收口）。
 */
export async function fetchAnonymousToken(baseUrl: string): Promise<string | undefined> {
  const stored = getStoredToken()
  if (stored) return stored
  const cachedAnonymous = readAnonymousToken()
  if (cachedAnonymous !== null) return cachedAnonymous
  if (anonymousPending === null) {
    anonymousPending = (async (): Promise<string | undefined> => {
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/anonymous`, { method: 'POST' })
        if (!response.ok) return undefined
        const body = (await response.json()) as { token?: string }
        if (body.token) {
          // 晚到守卫：请求期间登录已完成（TOKEN_KEY 有登录 token）——匿名结果
          // 只进匿名键位，绝不覆盖登录 token；登录 token 已在场则登录优先。
          writeAnonymousToken(body.token)
          return getStoredToken() ?? body.token
        }
        return undefined
      } catch {
        return undefined
      } finally {
        anonymousPending = null
      }
    })()
  }
  return anonymousPending
}

function readAnonymousToken(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(ANONYMOUS_TOKEN_KEY) ?? null
  } catch {
    return null
  }
}

function writeAnonymousToken(token: string): void {
  try {
    globalThis.sessionStorage?.setItem(ANONYMOUS_TOKEN_KEY, token)
  } catch {
    // 静默降级（下次再解析）。
  }
}
