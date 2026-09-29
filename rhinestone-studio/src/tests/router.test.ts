/*
 * [split-admin-portal 1.4] hash 路由器单测：parseHash 回落矩阵 + routeHash 互逆 +
 * hashchange 监听同步 + 登录回跳 stash/consume。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  consumeReturnTo,
  navigate,
  parseHash,
  resetRouterForTests,
  routeHash,
  router,
  startRouter,
  stashReturnTo,
  type Route,
} from '../lib/router.svelte'

beforeEach(() => {
  sessionStorage.clear()
  resetRouterForTests('')
})

describe('parseHash 回落矩阵（1.4）', () => {
  const cases: Array<[string, Route]> = [
    // 前台壳（home）：空/裸井号/根/未知路径/查询串
    ['', { name: 'home' }],
    ['#', { name: 'home' }],
    ['#/', { name: 'home' }],
    ['#/anything', { name: 'home' }],
    ['#/a/b/c', { name: 'home' }],
    ['#/login?next=x', { name: 'login' }], // 查询串剥除（登录归 login 分支）
    // 登录页
    ['#/login', { name: 'login' }],
    ['#/login/', { name: 'login' }],
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
    ['#/login/extra', { name: 'login' }],
  ]

  for (const [hash, expected] of cases) {
    it(`${JSON.stringify(hash)} → ${expected.name}${expected.name === 'admin' ? `/${expected.tab}` : ''}`, () => {
      expect(parseHash(hash)).toEqual(expected)
    })
  }

  it('routeHash 与 parseHash 互逆（合法 Route → hash → Route 恒等）', () => {
    const routes: Route[] = [
      { name: 'home' },
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
})

describe('hashchange 监听同步（路由变化不重载页面）', () => {
  it('startRouter 后 hash 变更驱动 router.route 更新', () => {
    startRouter()
    expect(router.route).toEqual({ name: 'home' })

    location.hash = '#/admin/settings'
    window.dispatchEvent(new Event('hashchange'))
    expect(router.route).toEqual({ name: 'admin', tab: 'settings' })

    location.hash = '#/login'
    window.dispatchEvent(new Event('hashchange'))
    expect(router.route).toEqual({ name: 'login' })

    location.hash = '#/admin/nope'
    window.dispatchEvent(new Event('hashchange'))
    expect(router.route).toEqual({ name: 'admin', tab: 'accounts' })
  })

  it('navigate() 编程导航与 hashchange 同链路', () => {
    startRouter()
    navigate('#/login')
    window.dispatchEvent(new Event('hashchange'))
    expect(location.hash).toBe('#/login')
    expect(router.route).toEqual({ name: 'login' })
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
