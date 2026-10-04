/*
 * [split-admin-portal 1.4] hash 路由器单测：parseHash 回落矩阵 + routeHash 互逆 +
 * hashchange 监听同步 + 登录回跳 stash/consume。
 * [unify-studio-routing 2026-10-04] 扩全路由表：home 视图段（#/studio[/engine|
 * /task/{id}]、#/assets 等开发面段）+ 任务详情面板 tab 段（#/t/{id}/activity|
 * workbench|r/{pid}）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeReturnTo,
  navigate,
  parseHash,
  resetRouterForTests,
  routeHash,
  router,
  startRouter,
  stashReturnTo,
  stripSearchParams,
  type Route,
} from '../lib/router.svelte'

beforeEach(() => {
  sessionStorage.clear()
  resetRouterForTests('')
})

describe('parseHash 回落矩阵（1.4 + unify-studio-routing 全表）', () => {
  const cases: Array<[string, Route]> = [
    // 前台壳（home·agent 缺省）：空/裸井号/根/未知路径/查询串/显式 agent 段
    ['', { name: 'home', view: 'agent' }],
    ['#', { name: 'home', view: 'agent' }],
    ['#/', { name: 'home', view: 'agent' }],
    ['#/anything', { name: 'home', view: 'agent' }],
    ['#/a/b/c', { name: 'home', view: 'agent' }],
    ['#/agent', { name: 'home', view: 'agent' }],
    ['#/agent/t/abc', { name: 'home', view: 'agent' }], // agent 段后锚不解析（canonical 锚不带 agent 段）
    // 登录页
    ['#/login', { name: 'login' }],
    ['#/login/', { name: 'login' }],
    ['#/login?next=x', { name: 'login' }], // 查询串剥除（登录归 login 分支）
    ['#/login/extra', { name: 'login' }],
    // 后台四 tab
    ['#/admin', { name: 'admin', tab: 'accounts' }],
    ['#/admin/', { name: 'admin', tab: 'accounts' }],
    ['#/admin/accounts', { name: 'admin', tab: 'accounts' }],
    ['#/admin/resources', { name: 'admin', tab: 'resources' }],
    ['#/admin/kb', { name: 'admin', tab: 'kb' }],
    ['#/admin/settings', { name: 'admin', tab: 'settings' }],
    // 非法 tab/未知段 回落 accounts（spec：非法 tab 回落账号页）
    ['#/admin/bogus', { name: 'admin', tab: 'accounts' }],
    ['#/admin/ACCOUNTS', { name: 'admin', tab: 'accounts' }],
    ['#//admin/settings', { name: 'admin', tab: 'settings' }], // 空段过滤（zhumo 同款）
    // 多余段忽略
    ['#/admin/settings/extra', { name: 'admin', tab: 'settings' }],
    // 会话子锚（product-polish-w1 T1——zhumo §1.1 补抄）：#/t/{id} agent 下钻。
    ['#/t/abc123', { name: 'home', view: 'agent', session: 'abc123' }],
    ['#/t/s-long-id-42', { name: 'home', view: 'agent', session: 's-long-id-42' }],
    ['#/t/abc/extra', { name: 'home', view: 'agent', session: 'abc' }], // 未知尾段忽略（同 admin 先例）
    // 任务详情面板 tab 段（unify-studio-routing）：activity/workbench/result。
    ['#/t/abc/activity', { name: 'home', view: 'agent', session: 'abc', taskTab: 'activity' }],
    ['#/t/abc/workbench', { name: 'home', view: 'agent', session: 'abc', taskTab: 'workbench' }],
    ['#/t/abc/r/pub-1', { name: 'home', view: 'agent', session: 'abc', taskTab: 'result', taskResultId: 'pub-1' }],
    ['#/t/abc/r/', { name: 'home', view: 'agent', session: 'abc' }], // 缺 publicId 不构成 result 段
    ['#/t/abc/r', { name: 'home', view: 'agent', session: 'abc' }],
    // 缺 id 不构成锚：回裸 home
    ['#/t', { name: 'home', view: 'agent' }],
    ['#/t/', { name: 'home', view: 'agent' }],
    // [中栏迁移 2026-10-02] 新建态锚（zhumo 三态同款）：#/new=agent composer 态。
    ['#/new', { name: 'home', view: 'agent', composer: true }],
    ['#/new/extra', { name: 'home', view: 'agent', composer: true }], // 多余段忽略（同 t 锚先例）
    // t 锚优先于字面 new 会话 id（顶层分支序：t 先判——`#/t/new` 是 id 为 new 的会话）。
    ['#/t/new', { name: 'home', view: 'agent', session: 'new' }],
    // [unify-studio-routing] studio 视图段：模式选择/引擎实验/任务详情工作台。
    ['#/studio', { name: 'home', view: 'studio' }],
    ['#/studio/', { name: 'home', view: 'studio' }],
    ['#/studio/engine', { name: 'home', view: 'studio', studioEngine: true }],
    ['#/studio/task/tk-1', { name: 'home', view: 'studio', studioTask: 'tk-1' }],
    ['#/studio/task/tk-1/extra', { name: 'home', view: 'studio', studioTask: 'tk-1' }], // 多余段忽略
    ['#/studio/foo', { name: 'home', view: 'studio' }], // 未知子段回落模式选择
    ['#/studio/task/', { name: 'home', view: 'studio' }], // 缺 taskId 不构成任务段
    ['#/studio/task', { name: 'home', view: 'studio' }],
    // [unify-studio-routing] 开发面视图段（随 handicraft.dev.workbenches 旗标）。
    ['#/assets', { name: 'home', view: 'assets' }],
    ['#/stones', { name: 'home', view: 'stones' }],
    ['#/warehouse', { name: 'home', view: 'warehouse' }],
    ['#/lab', { name: 'home', view: 'lab' }],
    ['#/strategy', { name: 'home', view: 'strategy' }],
    ['#/edit', { name: 'home', view: 'edit' }],
    ['#/assets/extra', { name: 'home', view: 'assets' }], // 多余段忽略
  ]

  for (const [hash, expected] of cases) {
    it(`${JSON.stringify(hash)} → ${expected.name}${expected.name === 'admin' ? `/${expected.tab}` : ''}${expected.name === 'home' ? `/${expected.view}` : ''}${expected.name === 'home' && 'session' in expected ? ` (session=${expected.session})` : ''}`, () => {
      expect(parseHash(hash)).toEqual(expected)
    })
  }

  it('routeHash 与 parseHash 互逆（合法 Route → hash → Route 恒等；canonical 形）', () => {
    const routes: Route[] = [
      { name: 'home', view: 'agent' },
      { name: 'home', view: 'agent', session: 'abc123' },
      { name: 'home', view: 'agent', composer: true },
      { name: 'home', view: 'agent', session: 'abc123', taskTab: 'activity' },
      { name: 'home', view: 'agent', session: 'abc123', taskTab: 'workbench' },
      { name: 'home', view: 'agent', session: 'abc123', taskTab: 'result', taskResultId: 'pub-1' },
      { name: 'home', view: 'studio' },
      { name: 'home', view: 'studio', studioEngine: true },
      { name: 'home', view: 'studio', studioTask: 'tk-1' },
      { name: 'home', view: 'assets' },
      { name: 'home', view: 'stones' },
      { name: 'home', view: 'warehouse' },
      { name: 'home', view: 'lab' },
      { name: 'home', view: 'strategy' },
      { name: 'home', view: 'edit' },
      { name: 'login' },
      { name: 'admin', tab: 'accounts' },
      { name: 'admin', tab: 'resources' },
      { name: 'admin', tab: 'kb' },
      { name: 'admin', tab: 'settings' },
    ]
    for (const route of routes) {
      expect(parseHash(routeHash(route))).toEqual(route)
    }
  })

  it('canonical 形（#/ 与 #/agent 同义；agent 段不产出——8317 裸锚兼容）', () => {
    expect(routeHash({ name: 'home', view: 'agent' })).toBe('#/')
    expect(routeHash({ name: 'home', view: 'studio' })).toBe('#/studio')
  })
})

describe('hashchange 监听同步（路由变化不重载页面）', () => {
  it('startRouter 后 hash 变更驱动 router.route 更新', () => {
    startRouter()
    expect(router.route).toEqual({ name: 'home', view: 'agent' })

    location.hash = '#/admin/settings'
    window.dispatchEvent(new Event('hashchange'))
    expect(router.route).toEqual({ name: 'admin', tab: 'settings' })

    location.hash = '#/login'
    window.dispatchEvent(new Event('hashchange'))
    expect(router.route).toEqual({ name: 'login' })

    location.hash = '#/admin/nope'
    window.dispatchEvent(new Event('hashchange'))
    expect(router.route).toEqual({ name: 'admin', tab: 'accounts' })

    location.hash = '#/studio/task/tk-9'
    window.dispatchEvent(new Event('hashchange'))
    expect(router.route).toEqual({ name: 'home', view: 'studio', studioTask: 'tk-9' })
  })

  it('navigate() 编程导航与 hashchange 同链路', () => {
    startRouter()
    navigate('#/login')
    window.dispatchEvent(new Event('hashchange'))
    expect(location.hash).toBe('#/login')
    expect(router.route).toEqual({ name: 'login' })
  })

  it('writeHash 镜像即时同步 router.route（不等 hashchange——sessionRoute/view 镜像链）', async () => {
    const { writeHash } = await import('../lib/router.svelte')
    startRouter()
    expect(location.hash).toBe('')
    writeHash('#/studio/engine')
    expect(router.route).toEqual({ name: 'home', view: 'studio', studioEngine: true })
    // 同值 replace 幂等（不写 history）
    const spy = vi.spyOn(history, 'replaceState')
    writeHash('#/studio/engine')
    expect(spy).not.toHaveBeenCalled()
  })

  it('stripSearchParams 清参不重载（urlFlags/demoDelay 引导；hash 保真由 new URL(href) 构造保证）', async () => {
    const { writeHash } = await import('../lib/router.svelte')
    writeHash('#/t/abc/workbench')
    // jsdom 无导航实现——search 变更经 replaceState 摆位（urlFlags.test 同式）。
    history.replaceState(null, '', '/?api=rpc&demoDelay=50')
    stripSearchParams(['api', 'demoDelay'])
    expect(location.search).toBe('')
    // 无关参数不动
    history.replaceState(null, '', '/?other=1')
    stripSearchParams(['api'])
    expect(location.search).toBe('?other=1')
    history.replaceState(null, '', '/')
  })
})

describe('登录回跳（stashReturnTo / consumeReturnTo）', () => {
  it('守卫卡位置被记录且一次性消费；无记录回 #/', () => {
    location.hash = '#/admin/settings'
    stashReturnTo()
    expect(consumeReturnTo()).toBe('#/admin/settings')
    // 一次性：二次消费回默认
    expect(consumeReturnTo()).toBe('#/')
  })

  it('#/login 与空 hash 不记录（避免登录回登录死循环）', () => {
    location.hash = '#/login'
    stashReturnTo()
    expect(consumeReturnTo()).toBe('#/')
    location.hash = ''
    stashReturnTo()
    expect(consumeReturnTo()).toBe('#/')
  })
})
