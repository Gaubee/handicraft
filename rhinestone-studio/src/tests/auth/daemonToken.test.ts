/*
 * [Owner 验收 2026-09-30] daemonToken 匿名兜底单源修复。
 * 报障：首进后台切 settings 报「模型配置加载失败：需要管理员权限」。根因=
 * 「登录前的匿名 token 请求晚到」把匿名 token 写进登录键位（TOKEN_KEY），覆盖
 * 刚登录写入的 admin token——各 RPC 面的代际漂移检测全部失效（存储=连接 token）。
 * 修复语义：匿名 token 只写独立键位 ANONYMOUS_TOKEN_KEY；登录 token 恒优先；
 * 并发解析共享一次请求；晚到守卫=解析期间登录已完成则登录优先。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANONYMOUS_TOKEN_KEY,
  TOKEN_KEY,
  clearStoredToken,
  fetchAnonymousToken,
  getStoredToken,
  setStoredToken,
} from '$lib/daemonToken'

function stubAnonymousFetch(token: string | null, delayMs = 0): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return {
      ok: token !== null,
      json: async () => ({ token: token ?? undefined }),
    }
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('daemonToken 匿名兜底单源（Owner 2026-09-30 首进 settings 403 修复）', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('登录 token 在场 → 直接返回，不发匿名请求', async () => {
    setStoredToken('tok-admin')
    const fetchMock = stubAnonymousFetch('tok-anon')
    await expect(fetchAnonymousToken('http://127.0.0.1:8317')).resolves.toBe('tok-admin')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('匿名解析只写独立键位——TOKEN_KEY 不被匿名 token 占位', async () => {
    const fetchMock = stubAnonymousFetch('tok-anon')
    await expect(fetchAnonymousToken('http://127.0.0.1:8317')).resolves.toBe('tok-anon')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(sessionStorage.getItem(ANONYMOUS_TOKEN_KEY)).toBe('tok-anon')
    // 二次调用走匿名键位缓存（不再发请求）
    await expect(fetchAnonymousToken('http://127.0.0.1:8317')).resolves.toBe('tok-anon')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('晚到守卫：匿名请求期间登录完成 → 返回登录 token（不覆盖）', async () => {
    const fetchMock = stubAnonymousFetch('tok-anon', 50)
    const pending = fetchAnonymousToken('http://127.0.0.1:8317')
    setStoredToken('tok-admin') // 请求进行中登录完成
    await expect(pending).resolves.toBe('tok-admin')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getStoredToken()).toBe('tok-admin')
    expect(sessionStorage.getItem(ANONYMOUS_TOKEN_KEY)).toBe('tok-anon') // 匿名结果只进独立键位
  })

  it('并发解析共享一次请求', async () => {
    const fetchMock = stubAnonymousFetch('tok-anon', 30)
    const [a, b, c] = await Promise.all([
      fetchAnonymousToken('http://127.0.0.1:8317'),
      fetchAnonymousToken('http://127.0.0.1:8317'),
      fetchAnonymousToken('http://127.0.0.1:8317'),
    ])
    expect([a, b, c]).toEqual(['tok-anon', 'tok-anon', 'tok-anon'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('登出（clearStoredToken）后匿名兜底复用同匿名身份', async () => {
    stubAnonymousFetch('tok-anon')
    await expect(fetchAnonymousToken('http://127.0.0.1:8317')).resolves.toBe('tok-anon')
    setStoredToken('tok-admin')
    clearStoredToken() // 登出——只清登录键位
    await expect(fetchAnonymousToken('http://127.0.0.1:8317')).resolves.toBe('tok-anon')
  })
})
