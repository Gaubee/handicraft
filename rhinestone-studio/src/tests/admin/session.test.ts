/*
 * [split-admin-portal 1.5] 会话态 store 逻辑测试（fake adminApi 注入 + fetch 桩）。
 * 覆盖：initSession 恢复矩阵（bootstrap/token→me/refresh 自愈/失效清 token）；
 * login 成败与 token 写入（sessionStorage 既有键位）；loginAnonymous（匿名端点）；
 * logout（allowAnonymous 开时回落匿名）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeAdminApi } from './fakeAdminApi'
import { makeFakeAdminApi } from './fakeAdminApi'

const holder: { current: FakeAdminApi | null } = vi.hoisted(() => ({ current: null }))
vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.current!.api }))

import {
  getAllowAnonymous,
  getSessionError,
  getSessionUser,
  getSiteBrandName,
  initSession,
  isAdmin,
  login,
  loginAnonymous,
  logout,
  resetSessionForTests,
  setSessionSiteName,
} from '../../lib/stores/session.svelte'
import { currentStoredToken, getStoredToken, TOKEN_KEY } from '../../lib/daemonToken'

/** fetch 桩：/api/bootstrap 与 /api/auth/anonymous 两端点。 */
function stubFetch(allowAnonymous: boolean, anonymousToken: string | null): void {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/bootstrap')) {
      return new Response(
        JSON.stringify({
          version: '0.0.0-test',
          allowAnonymous,
          adminConfigured: true,
          imgConfigured: true,
          llmConfigured: true,
          imgDryRun: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/api/auth/anonymous') && (init?.method ?? 'GET') === 'POST') {
      if (anonymousToken === null) return new Response('forbidden', { status: 403 })
      return new Response(JSON.stringify({ token: anonymousToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`测试未预期的 fetch：${url}`)
  }
  vi.stubGlobal('fetch', vi.fn(impl))
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  holder.current = makeFakeAdminApi()
  vi.unstubAllGlobals() // 上一用例的 fetch 桩清理（各用例显式重装）
})

describe('initSession（启动恢复）', () => {
  it('bootstrap 投影 allowAnonymous；无 token=未登录态', async () => {
    stubFetch(true, 'tok-anon-0')
    resetSessionForTests(null, null)
    // initialized 复位后重跑（resetSessionForTests 置 true——直接改由 initSession 覆盖）
    await initSession()

    expect(getAllowAnonymous()).toBe(true)
    expect(getSessionUser()).toBeNull()
  })

  it('有 token → auth.me 恢复会话（admin）', async () => {
    stubFetch(false, null)
    resetSessionForTests(null, null)
    sessionStorage.setItem(TOKEN_KEY, 'tok-boss-1')
    await initSession()

    expect(getSessionUser()).toEqual({ username: 'boss', role: 'admin' })
    expect(isAdmin()).toBe(true)
    expect(holder.current!.state.calls.me).toBe(1)
  })

  it('me 401 → auth.refresh 一次自愈（新 token 写回）', async () => {
    stubFetch(false, null)
    resetSessionForTests(null, null)
    sessionStorage.setItem(TOKEN_KEY, 'tok-boss-stale')
    const fake = holder.current!
    fake.state.meUser = null // me 抛 401 语义
    await initSession()

    expect(fake.state.calls.refresh).toEqual(['tok-boss-stale'])
    expect(getStoredToken()).toBe('tok-boss-0')
    expect(getSessionUser()).toEqual({ username: 'boss', role: 'admin' })
  })

  it('me+refresh 均失败 → 清 token 归未登录', async () => {
    stubFetch(false, null)
    resetSessionForTests(null, null)
    sessionStorage.setItem(TOKEN_KEY, 'tok-boss-stale')
    const fake = holder.current!
    fake.state.meUser = null
    fake.state.refreshShouldFail = true
    await initSession()

    expect(getStoredToken()).toBeNull()
    expect(getSessionUser()).toBeNull()
  })

  it('bootstrap 不可达 → 不抛错（前台壳照常可用）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    resetSessionForTests(null, null)
    await expect(initSession()).resolves.toBeUndefined()
    expect(getAllowAnonymous()).toBeNull()
  })
})

describe('login / loginAnonymous / logout', () => {
  it('login 成功：token 写入既有键位+会话投影', async () => {
    stubFetch(false, null)
    resetSessionForTests(null, false)
    const ok = await login('boss', 'secret-password')

    expect(ok).toBe(true)
    expect(getStoredToken()).toBe('tok-boss-0')
    expect(getSessionUser()).toEqual({ username: 'boss', role: 'admin' })
    expect(getSessionError()).toBeNull()
  })

  it('login 失败：中文错误进 session.error，token 不写', async () => {
    stubFetch(false, null)
    const fake = holder.current!
    fake.state.loginShouldFail = true
    resetSessionForTests(null, false)
    const ok = await login('boss', 'wrong')

    expect(ok).toBe(false)
    expect(getSessionError()).toBe('用户名或密码错误')
    expect(getStoredToken()).toBeNull()
  })

  it('loginAnonymous：匿名端点取 token+me 投影匿名会话', async () => {
    stubFetch(true, 'tok-anon-1')
    const fake = holder.current!
    fake.state.meUser = { username: '__anonymous__', role: 'anonymous' }
    resetSessionForTests(null, true)
    const ok = await loginAnonymous()

    expect(ok).toBe(true)
    // [Owner 验收 2026-09-30 token 修复] 匿名 token 落独立键位（不进 TOKEN_KEY——
    // 防晚到覆盖登录 token）；生效面语义断言=currentStoredToken。
    expect(getStoredToken()).toBeNull()
    expect(currentStoredToken()).toBe('tok-anon-1')
    expect(getSessionUser()).toEqual({ username: '__anonymous__', role: 'anonymous' })
  })

  it('loginAnonymous：匿名关闭（403）→ 错误提示+false', async () => {
    stubFetch(false, null)
    resetSessionForTests(null, false)
    const ok = await loginAnonymous()

    expect(ok).toBe(false)
    expect(getSessionError()).toContain('匿名')
  })

  it('logout：allowAnonymous 开 → 清 token 回落匿名会话', async () => {
    stubFetch(true, 'tok-anon-2')
    const fake = holder.current!
    fake.state.meUser = { username: '__anonymous__', role: 'anonymous' }
    resetSessionForTests({ username: 'boss', role: 'admin' }, true)
    sessionStorage.setItem(TOKEN_KEY, 'tok-boss-9')

    await logout()

    expect(getSessionUser()).toEqual({ username: '__anonymous__', role: 'anonymous' })
    // 匿名回落 token 落独立键位（语义断言见 token 修复注释）。
    expect(currentStoredToken()).toBe('tok-anon-2')
  })

  it('logout：匿名关 → 清 token 归未登录（不再匿名）', async () => {
    stubFetch(false, null)
    resetSessionForTests({ username: 'user1', role: 'user' }, false)
    sessionStorage.setItem(TOKEN_KEY, 'tok-user1-9')

    await logout()

    expect(getSessionUser()).toBeNull()
    expect(getStoredToken()).toBeNull()
  })
})

describe('bootstrap 双形读取与站点品牌（波 5 P2-2）', () => {
  /** fetch 桩：/api/bootstrap 以指定 body 应答（真 daemon 形状注入点）。 */
  function stubBootstrapBody(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.endsWith('/api/bootstrap')) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`测试未预期的 fetch：${url}`)
      }),
    )
  }

  it('真 daemon snake_case 体：allow_anonymous/site_name 均投影（此前严格 camelCase 守门恒拒）', async () => {
    stubBootstrapBody({
      version: '0.1.0',
      needs_setup: false,
      allow_anonymous: true,
      admin_configured: true,
      img_configured: true,
      llm_configured: true,
      site_name: '我的贴钻站',
    })
    resetSessionForTests(null, null, null)
    await initSession()

    expect(getAllowAnonymous()).toBe(true)
    expect(getSiteBrandName()).toBe('我的贴钻站')
  })

  it('camelCase 体（测试桩形态）同读；site_name 空/缺席回落「贴钻工作台」', async () => {
    stubBootstrapBody({
      version: '0.0.0-test',
      allowAnonymous: false,
      adminConfigured: true,
      imgConfigured: true,
      llmConfigured: true,
      imgDryRun: false,
      siteName: '',
    })
    resetSessionForTests(null, null, '旧值不应存活')
    await initSession()

    expect(getAllowAnonymous()).toBe(false)
    expect(getSiteBrandName()).toBe('贴钻工作台')
  })

  it('setSessionSiteName 写面：后台保存后即时跟随；null/空串回落缺省', () => {
    resetSessionForTests(null, null, null)
    setSessionSiteName('新站名')
    expect(getSiteBrandName()).toBe('新站名')
    setSessionSiteName(null)
    expect(getSiteBrandName()).toBe('贴钻工作台')
    setSessionSiteName('')
    expect(getSiteBrandName()).toBe('贴钻工作台')
  })
})
