/*
 * [split-admin-portal 1.4/1.5] App 顶层 hash 分发集成测试（fake adminApi 注入）。
 * 覆盖：#/login→LoginPage（前台壳退场）；#/admin 直达（admin=壳+守卫=守卫卡）；
 * #/=前台壳；前台顶栏登录态（匿名=登录入口无后台/设置入口；admin=后台+设置+
 * username/角色/登出）；「后台」按钮 hash 导航。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { FakeAdminApi } from './fakeAdminApi'
import { makeFakeAdminApi } from './fakeAdminApi'

const holder: { current: FakeAdminApi | null } = vi.hoisted(() => ({ current: null }))
vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.current!.api }))

// modelsApi/imageProcessingApi 替身（admin settings 分区挂载确定性——不触发真实 WS/fetch）。
vi.mock('$lib/modelsApi', () => ({
  modelsApi: () => ({
    async getModels() {
      return { routes: [], default: null }
    },
    async saveModels() {
      return { routes: [], default: null }
    },
    async getModelsCatalog() {
      return { presets: [] }
    },
    async refreshModelsCatalog() {
      return { presets: [] }
    },
    async testModelRoute() {
      return { ok: true, latencyMs: 1 }
    },
    async getAvailableModels() {
      return { models: [], default: null }
    },
    async getModelRoute() {
      return null
    },
  }),
}))
vi.mock('$lib/imageProcessingApi', () => ({
  imageProcessingApi: () => ({
    async getImageProcessing() {
      return {
        settings: null,
        source: 'default',
        effective: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
      }
    },
    async saveImageProcessing() {
      return {
        settings: null,
        source: 'default',
        effective: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
      }
    },
  }),
}))

import App from '../../App.svelte'
import { resetRouterForTests, router } from '../../lib/router.svelte'
import {
  ANONYMOUS_DISPLAY_NAME,
  resetSessionForTests,
  type AdminSessionUser,
} from '../../lib/stores/session.svelte'
import { resetDevFlagForTests } from '../../lib/stores/devFlag.svelte'
import { resetViewForTests } from '../../lib/stores/view.svelte'
import { resetAgentStoreForTests, bindAgentApi } from '../../lib/agentApi/store.svelte'
import { MockAgentApi } from '../../lib/agentApi/mock'
import { getSettings, resetLabForTests } from '../../lib/stores/lab.svelte'
import { resetToastsForTests } from '../../lib/stores/toast.svelte'
import { resetModelsSettingsForTests } from '../../lib/stores/modelsSettingsDialog.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

async function flush(ms = 10): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function mountApp(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  mountedDisposers.push(() => {
    unmount(app)
    target.remove()
  })
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `选择器 ${selector} 应命中`).not.toBeNull()
  return el as HTMLElement
}

const ADMIN: AdminSessionUser = { username: 'boss', role: 'admin' }
const ANON: AdminSessionUser = { username: '__anonymous__', role: 'anonymous' }

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  sessionStorage.clear()
  localStorage.clear()
  holder.current = makeFakeAdminApi()
  resetRouterForTests('')
  resetSessionForTests()
  resetDevFlagForTests(false)
  resetViewForTests('agent')
  resetAgentStoreForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  getSettings()
  resetLabForTests()
  resetToastsForTests()
  resetModelsSettingsForTests()
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
})

describe('App 顶层 hash 分发（1.4）', () => {
  it('#/login → LoginPage 渲染；前台壳（顶栏标题/底部导航）退场', async () => {
    resetRouterForTests('#/login')
    resetSessionForTests(null, false)
    mountApp()
    await flush()

    expect(q('[data-testid="login-card"]').textContent).toContain('登录贴钻工作台')
    expect(document.body.textContent?.includes('贴钻工作台')).toBe(true) // 登录页自身标题含词
    expect(document.querySelector('[data-testid="agent-view"]')).toBeNull()
    expect(document.querySelector('nav[aria-label="模块切换"]')).toBeNull()
  })

  it('#/admin 直达 + 匿名会话 → AdminPage 守卫卡（不加载管理数据）', async () => {
    resetRouterForTests('#/admin')
    resetSessionForTests(ANON, true)
    mountApp()
    await flush()

    expect(q('[data-testid="admin-guard-card"]').textContent).toContain('需要管理员权限')
    expect(document.querySelector('[data-testid="agent-view"]')).toBeNull()
    expect(holder.current!.state.calls.userList).toBe(0)
  })

  it('#/admin/settings 直达 + admin 会话 → 后台设置分区（路由 tab 透传）', async () => {
    resetRouterForTests('#/admin/settings')
    resetSessionForTests(ADMIN, false)
    mountApp()
    await flush(40)

    expect(document.querySelector('[data-testid="admin-guard-card"]')).toBeNull()
    expect(q('[data-testid="admin-settings-nav"]').textContent).toContain('大模型服务')
    expect(q('[data-testid="admin-settings-nav"]').textContent).toContain('图像处理')
    expect(q('[data-testid="admin-settings-nav"]').textContent).toContain('站点与安全')
  })

  it('#/（空 hash）→ 前台壳（Agent 主面+顶栏）', async () => {
    resetRouterForTests('')
    resetSessionForTests(ANON, true)
    mountApp()
    await flush()

    expect(q('[data-testid="agent-view"]')).toBeDefined()
    expect(document.querySelector('[data-testid="admin-guard-card"]')).toBeNull()
  })
})

describe('前台顶栏登录态与入口（1.5）', () => {
  it('匿名/无会话：登录入口在场；后台/设置入口不可见', async () => {
    resetRouterForTests('')
    resetSessionForTests(ANON, true)
    mountApp()
    await flush()

    expect(q('[data-testid="session-login"]')).toBeDefined()
    expect(document.querySelector('[data-testid="session-username"]')?.textContent).toContain(ANONYMOUS_DISPLAY_NAME)
    expect(document.querySelector('[data-testid="admin-entry"]')).toBeNull()
    expect(document.querySelector('[data-testid="settings-button"]')).toBeNull()
    expect(document.querySelector('[data-testid="session-logout"]')).toBeNull()
  })

  it('普通用户：登录态 username+角色 badge+登出；后台/设置仍不可见', async () => {
    resetRouterForTests('')
    resetSessionForTests({ username: 'user1', role: 'user' }, false)
    mountApp()
    await flush()

    expect(q('[data-testid="session-username"]').textContent).toContain('user1')
    expect(q('[data-testid="session-role"]').textContent).toContain('user')
    expect(q('[data-testid="session-logout"]')).toBeDefined()
    expect(document.querySelector('[data-testid="admin-entry"]')).toBeNull()
    expect(document.querySelector('[data-testid="settings-button"]')).toBeNull()
  })

  it('admin：后台+设置入口可见；点「后台」hash 切 #/admin/accounts 且守卫放行', async () => {
    resetRouterForTests('')
    resetSessionForTests(ADMIN, false)
    mountApp()
    await flush()

    q('[data-testid="admin-entry"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)
    // hashchange 驱动 router（jsdom hash 变更自动派发；显式补一发保时序确定）
    window.dispatchEvent(new Event('hashchange'))
    await flush(30)

    expect(location.hash).toBe('#/admin/accounts')
    expect(router.route).toEqual({ name: 'admin', tab: 'accounts' })
    expect(document.querySelector('[data-testid="admin-guard-card"]')).toBeNull()
    expect(q('[data-testid="admin-users-table"]')).toBeDefined()
    // settings-button 是前台顶栏入口——后台壳上退场（设置走后台设置分区）。
    expect(document.querySelector('[data-testid="settings-button"]')).toBeNull()
  })

  it('admin 设置按钮打开设置抽屉（admin 快捷入口保留）', async () => {
    resetRouterForTests('')
    resetSessionForTests(ADMIN, false)
    mountApp()
    await flush()

    q('[data-testid="settings-button"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(q('[data-testid="settings-sheet"]')).toBeDefined()
  })
})
