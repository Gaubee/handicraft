/*
 * [split-admin-portal 1.5] LoginPage jsdom 测试（fake adminApi 注入）。
 * 覆盖：表单形态；登录载荷（username trim）；失败错误提示；匿名入口开关
 * （allowAnonymous 时显示）；登录成功回跳（consumeReturnTo）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { FakeAdminApi } from './fakeAdminApi'
import { makeFakeAdminApi } from './fakeAdminApi'

const holder: { current: FakeAdminApi | null } = vi.hoisted(() => ({ current: null }))
vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.current!.api }))

import LoginPage from '../../lib/components/pages/LoginPage.svelte'
import { resetSessionForTests } from '../../lib/stores/session.svelte'
import { resetRouterForTests } from '../../lib/router.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

async function flush(ms = 10): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function mountPage(): { unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(LoginPage, { target })
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `选择器 ${selector} 应命中`).not.toBeNull()
  return el as HTMLElement
}

function setInputValue(selector: string, value: string): void {
  const input = q(selector) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
  localStorage.clear()
  holder.current = makeFakeAdminApi()
  resetRouterForTests('')
  resetSessionForTests(null, null)
  vi.unstubAllGlobals()
})

/** fetch 桩：匿名端点（bootstrap 面不触达本页——统一 200 兜底）。 */
function stubAnonymousEndpoint(token: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/api/auth/anonymous') && (init?.method ?? 'GET') === 'POST') {
        if (token === null) return new Response('forbidden', { status: 403 })
        return new Response(JSON.stringify({ token }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`测试未预期的 fetch：${url}`)
    }),
  )
}

describe('LoginPage（1.5）', () => {
  it('渲染品牌标题+用户名/口令表单；未开匿名时无「匿名进入」', async () => {
    resetSessionForTests(null, false)
    const page = mountPage()
    await flush()

    expect(document.body.textContent).toContain('登录贴钻工作台')
    expect(q('[data-testid="login-username"]')).toBeDefined()
    expect(q('[data-testid="login-password"]')).toBeDefined()
    expect(document.querySelector('[data-testid="login-anonymous"]')).toBeNull()

    page.unmount()
  })

  it('allowAnonymous 开时显示「匿名进入」且点击走匿名动线回首页', async () => {
    stubAnonymousEndpoint('tok-anon-1')
    holder.current!.state.meUser = { username: '__anonymous__', role: 'anonymous' }
    resetSessionForTests(null, true)
    const page = mountPage()
    await flush()

    const anonymousButton = document.querySelector('[data-testid="login-anonymous"]')
    expect(anonymousButton, 'allowAnonymous 开时匿名入口应渲染').not.toBeNull()
    anonymousButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(location.hash).toBe('#/')

    page.unmount()
  })

  it('提交登录：username 去空格后作为载荷；成功回跳来处（stash 的 #/admin/settings）', async () => {
    sessionStorage.setItem('handicraft.return-to', '#/admin/settings')
    resetSessionForTests(null, false)
    const page = mountPage()
    await flush()

    setInputValue('[data-testid="login-username"]', '  boss ')
    setInputValue('[data-testid="login-password"]', 'secret-password')
    q('[data-testid="login-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(holder.current!.state.calls.login).toEqual([{ username: 'boss', password: 'secret-password' }])
    expect(location.hash).toBe('#/admin/settings')
    // 回跳一次性：记录已消费
    expect(sessionStorage.getItem('handicraft.return-to')).toBeNull()

    page.unmount()
  })

  it('登录失败：中文错误提示在场，不跳转', async () => {
    holder.current!.state.loginShouldFail = true
    resetSessionForTests(null, false)
    const page = mountPage()
    await flush()

    setInputValue('[data-testid="login-username"]', 'boss')
    setInputValue('[data-testid="login-password"]', 'wrong')
    q('[data-testid="login-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(q('[data-testid="login-error"]').textContent).toContain('用户名或密码错误')
    expect(location.hash).toBe('')

    page.unmount()
  })

  it('P2-2 站点品牌：siteName 已设置时标题跟随；未设置回落「贴钻工作台」', async () => {
    // 已设置（后台 site_name 键在场——bootstrap 投影进 session store）。
    resetSessionForTests(null, false, '我的贴钻站')
    let page = mountPage()
    await flush()
    expect(document.body.textContent).toContain('登录我的贴钻站')
    page.unmount()

    // 未设置：回落缺省品牌。
    resetSessionForTests(null, false, null)
    page = mountPage()
    await flush()
    expect(document.body.textContent).toContain('登录贴钻工作台')
    page.unmount()
  })
})
