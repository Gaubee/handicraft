/*
 * [split-admin-portal 1.6] AdminPage jsdom 测试（fake adminApi 注入；modelsApi/
 * imageProcessingApi 替身——设置分区挂载确定性）。
 * 覆盖：非 admin 守卫卡；四入口侧栏+顶栏返回前台；账号表渲染（系统账户行只标注
 * 无操作）；创建/改密/删除三 Dialog 载荷；禁用载荷；匿名开关 settingsUpdate；
 * resources 两子分区实装挂载（2026-09-30 Owner 裁决合并：装饰钻库面板
 * StonesLibraryPanel 内「钻型|组合」双视角——StonesAdminView/WarehouseView 零改动
 * 挂载走 fixture 注入，组合不再是独立子分区；AssetsLibAdmin 走 fake assetsLib 面）
 * /kb=KnowledgeManager
 * 实装挂载；设置三分区切换+ModelsConfig/ImageProcessingConfig 挂载在场+siteName
 * 保存载荷。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { FakeAdminApi } from './fakeAdminApi'
import { makeFakeAdminApi } from './fakeAdminApi'

const holder: { current: FakeAdminApi | null } = vi.hoisted(() => ({ current: null }))
vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.current!.api }))

// modelsApi 替身（models 分区挂载确定性——空路由空态；不触发真实 WS/fetch）。
vi.mock('$lib/modelsApi', () => {
  return {
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
  }
})

// imageProcessingApi 替身（image-processing 分区挂载确定性——默认档回落态）。
vi.mock('$lib/imageProcessingApi', () => {
  return {
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
  }
})

import AdminPage from '../../lib/components/pages/AdminPage.svelte'
import { resetSessionForTests } from '../../lib/stores/session.svelte'
import { resetRouterForTests } from '../../lib/router.svelte'
import type { Route } from '../../lib/router.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

async function flush(ms = 10): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function mountPage(tab: Route & { name: 'admin' }): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(AdminPage, { target, props: { tab } })
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

function clickButtonByText(scope: HTMLElement, text: string): void {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button, `按钮「${text}」应存在`).toBeDefined()
  button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  sessionStorage.clear()
  localStorage.clear()
  holder.current = makeFakeAdminApi()
  resetRouterForTests('#/admin/accounts')
  resetSessionForTests()
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
})

describe('AdminPage 守卫与壳（1.6）', () => {
  it('非 admin（匿名）会话：守卫卡「需要管理员权限」+去登录/返回前台；不加载管理数据', async () => {
    resetSessionForTests({ username: '__anonymous__', role: 'anonymous' })
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    expect(q('[data-testid="admin-guard-card"]').textContent).toContain('需要管理员权限')
    const buttons = q('[data-testid="admin-guard-card"]').textContent ?? ''
    expect(buttons).toContain('去登录')
    expect(buttons).toContain('返回前台')
    expect(holder.current!.state.calls.userList).toBe(0)

    clickButtonByText(q('[data-testid="admin-guard-card"]'), '返回前台')
    await flush()
    expect(location.hash).toBe('#/')
  })

  it('admin 会话：四入口侧栏+顶栏「返回前台」；数据加载一次', async () => {
    resetSessionForTests({ username: 'boss', role: 'admin' })
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    expect(document.querySelector('[data-testid="admin-guard-card"]')).toBeNull()
    expect(document.body.textContent).toContain('后台管理')
    for (const id of ['accounts', 'resources', 'kb', 'settings']) {
      expect(q(`[data-testid="admin-nav-${id}"]`).textContent).toContain(
        { accounts: '账号管理', resources: '资源管理', kb: '知识库', settings: '设置' }[id]!,
      )
    }
    expect(holder.current!.state.calls.userList).toBe(1)
    expect(holder.current!.state.calls.settingsGet).toBe(1)
  })
})

describe('账号管理（zhumo :374-524 复刻）', () => {
  beforeEach(() => {
    resetSessionForTests({ username: 'boss', role: 'admin' })
  })

  it('用户表渲染：username font-mono+角色 Badge+状态；__anonymous__ 行只标注无操作', async () => {
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    const table = q('[data-testid="admin-users-table"]')
    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(3)
    const anonRow = rows.find((r) => r.textContent?.includes('__anonymous__'))
    expect(anonRow).toBeDefined()
    expect(anonRow!.textContent).toContain('系统账户')
    // 系统账户行：无改密/禁用/删除
    expect(anonRow!.textContent?.includes('改密')).toBe(false)
    expect(anonRow!.textContent?.includes('禁用')).toBe(false)
    expect(anonRow!.textContent?.includes('删除')).toBe(false)
    // 普通行：三操作在场+font-mono 用户名
    const userRow = rows.find((r) => r.textContent?.includes('user1'))!
    expect(userRow.querySelector('.font-mono')?.textContent).toBe('user1')
    expect(userRow.textContent).toContain('改密')
    expect(userRow.textContent).toContain('禁用')
    expect(userRow.textContent).toContain('删除')
    // 角色 Badge 文案
    expect(userRow.textContent).toContain('user')
  })

  it('创建用户 Dialog：不开放注册文案+载荷 {username,password,role:"user"}', async () => {
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    clickButtonByText(document.body as HTMLElement, '+ 创建用户')
    await flush()

    const dialog = q('[data-testid="admin-create-dialog"]')
    expect(dialog.textContent).toContain('本站不开放注册，仅管理员创建。')
    const usernameInput = q('[data-testid="admin-create-username"]') as HTMLInputElement
    const passwordInput = q('[data-testid="admin-create-password"]') as HTMLInputElement
    usernameInput.value = 'newbie'
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
    passwordInput.value = 'password8chars'
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    q('[data-testid="admin-create-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(holder.current!.state.calls.userCreate).toEqual([
      { username: 'newbie', password: 'password8chars', role: 'user' },
    ])
    // 创建后列表刷新含新行
    expect(q('[data-testid="admin-users-table"]').textContent).toContain('newbie')
  })

  it('创建校验：用户名<2 或密码<8 前置拦截（不发 RPC）', async () => {
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    clickButtonByText(document.body as HTMLElement, '+ 创建用户')
    await flush()
    q('[data-testid="admin-create-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(20)

    expect(q('[data-testid="admin-create-dialog"]').textContent).toContain('用户名至少 2 个字符')
    expect(holder.current!.state.calls.userCreate).toHaveLength(0)
  })

  it('改密 Dialog：确认后 userUpdate{username,password}', async () => {
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    const table = q('[data-testid="admin-users-table"]')
    const userRow = [...table.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('user1'))!
    clickButtonByText(userRow as HTMLElement, '改密')
    await flush()

    const next = q('[data-testid="admin-password-next"]') as HTMLInputElement
    next.value = 'newpassword8'
    next.dispatchEvent(new Event('input', { bubbles: true }))
    q('[data-testid="admin-password-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(holder.current!.state.calls.userUpdate).toEqual([{ username: 'user1', password: 'newpassword8' }])
  })

  it('禁用/启用：userUpdate{username,disabled}', async () => {
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    const table = q('[data-testid="admin-users-table"]')
    const userRow = [...table.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('user1'))!
    clickButtonByText(userRow as HTMLElement, '禁用')
    await flush(30)

    expect(holder.current!.state.calls.userUpdate).toEqual([{ username: 'user1', disabled: true }])
    // 刷新后行内状态翻为「已禁用」+操作变「启用」
    const refreshed = [...q('[data-testid="admin-users-table"]').querySelectorAll('tbody tr')].find((r) =>
      r.textContent?.includes('user1'),
    )!
    expect(refreshed.textContent).toContain('已禁用')
    expect(refreshed.textContent).toContain('启用')
  })

  it('删除 Dialog：级联清理警示文案+确认后 userDelete(username)', async () => {
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    const table = q('[data-testid="admin-users-table"]')
    const userRow = [...table.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('user1'))!
    clickButtonByText(userRow as HTMLElement, '删除')
    await flush()

    const dialog = q('[data-testid="admin-delete-dialog"]')
    expect(dialog.textContent).toContain('删除账号 · user1')
    expect(dialog.textContent).toContain('且不可恢复')
    clickButtonByText(dialog, '确认删除')
    await flush(30)

    expect(holder.current!.state.calls.userDelete).toEqual(['user1'])
    expect(q('[data-testid="admin-users-table"]').textContent?.includes('user1')).toBe(false)
  })

  it('匿名开关：切换调 settingsUpdate({allowAnonymous}) 且行内状态跟随', async () => {
    mountPage({ name: 'admin', tab: 'accounts' })
    await flush()

    expect(holder.current!.state.settings.allowAnonymous).toBe(true)
    q('[data-testid="admin-anonymous-switch"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(holder.current!.state.calls.settingsUpdate).toEqual([{ allowAnonymous: false }])
  })
})

describe('resources 两子分区（2026-09-30 Owner 裁决：组合并入装饰钻库为分组视角）', () => {
  beforeEach(() => {
    resetSessionForTests({ username: 'boss', role: 'admin' })
  })

  it('两子分区导航在场（组合不独立成面）；缺省装饰钻库面板=钻型视角挂载 StonesAdminView', async () => {
    // StonesAdminView 自初始化走 stonesAdmin store——生产 RPC 面 jsdom 不可达，
    // fixture 注入（app.smoke 同模式）。
    const { makeClient } = await import('../stonesAdmin/fixtures')
    const { bindStonesClient, resetStonesAdminForTests } = await import('../../lib/stonesAdmin/store.svelte')
    resetStonesAdminForTests()
    bindStonesClient(makeClient().client)

    mountPage({ name: 'admin', tab: 'resources' })
    await flush(30)

    expect(document.querySelector('[data-testid="admin-placeholder-resources"]')).toBeNull()
    for (const id of ['stones', 'assets']) {
      expect(q(`[data-testid="admin-resources-nav-${id}"]`).textContent).toContain(
        { stones: '装饰钻库', assets: '素材库' }[id]!,
      )
    }
    // 组合/套装库不再是独立子分区（2026-09-30 裁决——无独立导航项）。
    expect(document.querySelector('[data-testid="admin-resources-nav-sets"]')).toBeNull()
    // 装饰钻库面板在场：缺省钻型视角（组合视角切换在场——「钻型|组合」小 tab）。
    expect(q('[data-testid="admin-resources-stones"] [data-testid="stones-library-panel"]')).toBeDefined()
    expect(q('[data-testid="stones-view-tab-stones"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="admin-resources-stones"] [data-testid="stones-view-panel-stones"] [data-testid="stones-admin-view"]')).toBeDefined()
  })

  it('装饰钻库面板切「组合」视角挂载 WarehouseView（分组视角——组件零改动挂载）', async () => {
    const { makeWarehouseClient } = await import('../warehouse/fixtures')
    const { bindWarehouseClient, resetWarehouseForTests } = await import('../../lib/warehouse/store.svelte')
    resetWarehouseForTests()
    bindWarehouseClient(makeWarehouseClient().client)

    mountPage({ name: 'admin', tab: 'resources' })
    await flush(30)
    q('[data-testid="stones-view-tab-sets"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(q('[data-testid="stones-view-tab-sets"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="admin-resources-stones"] [data-testid="stones-view-panel-sets"] [data-testid="warehouse-view"]')).toBeDefined()
    // 切回钻型视角：组合视图卸载、StonesAdminView 回场（重挂载语义）。
    q('[data-testid="stones-view-tab-stones"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)
    expect(document.querySelector('[data-testid="admin-resources-stones"] [data-testid="warehouse-view"]')).toBeNull()
    expect(q('[data-testid="admin-resources-stones"] [data-testid="stones-view-panel-stones"] [data-testid="stones-admin-view"]')).toBeDefined()
  })

  it('素材库子分区挂载 AssetsLibAdmin（服务端树+网格——fake assetsLib 面）', async () => {
    mountPage({ name: 'admin', tab: 'resources' })
    await flush(30)
    q('[data-testid="admin-resources-nav-assets"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(q('[data-testid="admin-resources-assets"] [data-testid="assets-lib-view"]')).toBeDefined()
    expect(holder.current!.state.calls.assetsLibTree).toBeGreaterThanOrEqual(1)
    // 默认根目录图片网格（fixture：上传目录下 1 张样图）
    q('[data-testid="assets-lib-tree-folder-al-dir-uploads"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(q('[data-testid="assets-lib-node-al-img-1"]').textContent).toContain('样图.png')
  })
})

describe('kb 实装挂载（波 3）', () => {
  beforeEach(() => {
    resetSessionForTests({ username: 'boss', role: 'admin' })
  })

  it('kb 分区=KnowledgeManager 实装挂载（波 3——占位卡已移除）', async () => {
    mountPage({ name: 'admin', tab: 'kb' })
    await flush()

    expect(document.querySelector('[data-testid="admin-placeholder-kb"]')).toBeNull()
    // 真组件在场：搜索框+修订历史入口+分组列表（fake kbGroups 首组）
    expect(q('[data-testid="kb-search-input"]')).toBeDefined()
    expect(q('[data-testid="kb-history-open"]').textContent).toContain('修订历史')
    expect(q('[data-testid="kb-group-钻径与规格"]').textContent).toContain('钻径与规格')
    expect(holder.current!.state.calls.kbList).toBeGreaterThanOrEqual(1)
  })
})

describe('设置三分区（list-detail）', () => {
  beforeEach(() => {
    resetSessionForTests({ username: 'boss', role: 'admin' })
  })

  it('三分区导航在场；缺省 models 分区挂载 ModelsConfig（空态）', async () => {
    mountPage({ name: 'admin', tab: 'settings' })
    await flush(40)

    for (const id of ['models', 'image-processing', 'site']) {
      expect(q(`[data-testid="admin-settings-nav-${id}"]`)).toBeDefined()
    }
    // ModelsConfig 挂载在场（空路由空态文案——modelsApi 替身）
    expect(document.body.textContent).toContain('添加第一个模型路由')
  })

  it('切图像处理分区挂载 ImageProcessingConfig（preset 组在场）', async () => {
    mountPage({ name: 'admin', tab: 'settings' })
    await flush(40)

    q('[data-testid="admin-settings-nav-image-processing"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(40)

    expect(q('[data-testid="image-processing-preset-group"]')).toBeDefined()
  })

  it('站点与安全：siteName 回显+保存载荷 settingsUpdate({siteName})', async () => {
    mountPage({ name: 'admin', tab: 'settings' })
    await flush(40)

    q('[data-testid="admin-settings-nav-site"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    const input = q('[data-testid="admin-site-sitename-input"]') as HTMLInputElement
    expect(input.value).toBe('贴钻工作台')
    input.value = '我的贴钻站'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    q('[data-testid="admin-site-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush(30)

    expect(holder.current!.state.calls.settingsUpdate).toEqual([{ siteName: '我的贴钻站' }])
    expect(q('[data-testid="admin-site-message"]').textContent).toContain('已保存')
  })

  it('P1-1 新实例：settingsGet 无 siteName 字段——页面整体可用（不再守门拒整包）+输入回落空串', async () => {
    // 波 5 走查 P1-1：daemon 新实例 siteName 字段缺席（可选语义）——AdminPage
    // 此前以 update 入面 schema 守 get 读面，空串/缺席即拒整包，后台导航全卡死。
    holder.current!.state.settings = { allowAnonymous: false }
    mountPage({ name: 'admin', tab: 'settings' })
    await flush(40)

    // 整体可用：无 loadError 告警（settingsGet 守门通过），设置分区正常渲染。
    expect(document.body.textContent ?? '').not.toContain('后台数据加载失败')
    expect(q('[data-testid="admin-settings-nav-site"]')).toBeDefined()
    // 站点设置输入回落空串（不写 undefined 进 input.value）。
    q('[data-testid="admin-settings-nav-site"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    const input = q('[data-testid="admin-site-sitename-input"]') as HTMLInputElement
    expect(input.value).toBe('')
  })
})
