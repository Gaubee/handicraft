/*
 * daemon token 生命周期（split-admin-portal 1.5，2026-09-28）。
 * sessionStorage 既有键位 `handicraft.daemon.token` 的唯一读写面：登录页/会话
 * store 写入登录 token；匿名兜底（allowAnonymous 开时）POST /api/auth/anonymous
 * 自动获取并缓存。rpc.ts / modelsApi / imageProcessingApi / adminApi 全部经本
 * 模块取 token——「有登录态用登录 token，无则匿名兜底」在存储层单点成立。
 * 背景：W3.1 时代各客户端各自内联同款逻辑（rpc.ts/modelsApi/imageProcessingApi
 * 三处复制）——波 1 登录态引入后收敛为共享模块（rpc.ts 已切换；modelsApi/
 * imageProcessingApi 保持各自内联（resolveToken 语义等价，合流后统一替换）。
 */

export const TOKEN_KEY = 'handicraft.daemon.token'

/** 当前存储 token（无存储/未登录且未匿名过 → null）。 */
export function getStoredToken(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null
  } catch {
    return null
  }
}

/** 登录/匿名成功后写入（同键覆盖——登录 token 优先，最新写入者生效）。 */
export function setStoredToken(token: string): void {
  try {
    globalThis.sessionStorage?.setItem(TOKEN_KEY, token)
  } catch {
    // 隐私模式等存储不可用：跳过（后续调用回落无 token 连接）。
  }
}

/** 登出/失效清除。 */
export function clearStoredToken(): void {
  try {
    globalThis.sessionStorage?.removeItem(TOKEN_KEY)
  } catch {
    // 同上：静默降级。
  }
}

/**
 * 匿名 token 兜底（allowAnonymous 开时可用）：POST /api/auth/anonymous（既有
 * HTTP 端点，daemon 侧匿名关闭时返回非 2xx → undefined）。成功即缓存——后续
 * 调用直接复用。失败静默（调用方以无 token 连接，由服务端按 401/403 收口）。
 */
export async function fetchAnonymousToken(baseUrl: string): Promise<string | undefined> {
  const cached = getStoredToken()
  if (cached) return cached
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/anonymous`, { method: 'POST' })
    if (!response.ok) return undefined
    const body = (await response.json()) as { token?: string }
    if (body.token) {
      setStoredToken(body.token)
      return body.token
    }
    return undefined
  } catch {
    return undefined
  }
}
