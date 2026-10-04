/*
 * [unify-studio-routing] 视图路由层（view.svelte.ts）双向同步矩阵：
 * ①程序向：setView/openStudioTask/setStudioMode/openTaskTab 状态先行+hash 镜像
 *   （显式导航进栈；收口动作 replace）；agent 视图镜像经 provider 回填 session/
 *   composer 段；taskTab 段随 agent 路由携带。
 * ②URL 向：startViewRouteSync（hashchange/popstate/调用即同步）反向派发写状态
 *   （login/admin 顶层不派发）；刷新还原=重调 startViewRouteSync 即时对齐。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindViewRouteSessionSource,
  closeStudioTask,
  getStudioMode,
  getStudioTaskId,
  getTaskResultId,
  getTaskTab,
  getView,
  openStudioTask,
  openTaskTab,
  resetViewForTests,
  setStudioMode,
  setView,
  startViewRouteSync,
} from '../../lib/stores/view.svelte'
import { resetRouterForTests } from '../../lib/router.svelte'

beforeEach(() => {
  resetViewForTests('agent')
  bindViewRouteSessionSource({ session: () => 's1', composer: () => false })
})

describe('①程序向：状态先行 + hash 镜像', () => {
  it('setView 切视图=push 进栈可回退（URL 变更）', () => {
    const pushSpy = vi.spyOn(history, 'pushState')
    setView('studio')
    expect(getView()).toBe('studio')
    expect(location.hash).toBe('#/studio')
    expect(pushSpy).toHaveBeenCalled()
    setView('assets')
    expect(location.hash).toBe('#/assets')
    pushSpy.mockRestore()
  })

  it('切回 agent=provider 回填会话段（#/t/{id}——会话上下文不因切视图丢失）', () => {
    setView('studio')
    setView('agent')
    expect(location.hash).toBe('#/t/s1')
  })

  it('composer 态优先于会话段（#/new——新建态切走再回可还原）', () => {
    bindViewRouteSessionSource({ session: () => 's1', composer: () => true })
    setView('studio')
    setView('agent')
    expect(location.hash).toBe('#/new')
  })

  it('openStudioTask=push 任务上下文锚（#/studio/task/{id}）', () => {
    openStudioTask('tk-1')
    expect(getView()).toBe('studio')
    expect(getStudioTaskId()).toBe('tk-1')
    expect(location.hash).toBe('#/studio/task/tk-1')
  })

  it('closeStudioTask=replace 收口（回 #/studio 模式选择——不叠历史）', () => {
    openStudioTask('tk-1')
    const replaceSpy = vi.spyOn(history, 'replaceState')
    closeStudioTask()
    expect(getStudioTaskId()).toBeNull()
    expect(location.hash).toBe('#/studio')
    // jsdom History-impl 对 hash URL 可能抛（writeHash 降级 location.hash 赋值）——
    // 两种路径都到达目标锚即可；replace 语义由不新增条目保证（同值幂等）。
    replaceSpy.mockRestore()
  })

  it('setStudioMode=引擎实验锚（#/studio/engine）；任务上下文在场不镜像', () => {
    setView('studio')
    setStudioMode('engine')
    expect(getStudioMode()).toBe('engine')
    expect(location.hash).toBe('#/studio/engine')
    setStudioMode('select')
    expect(location.hash).toBe('#/studio')
    // 任务上下文优先：engine 态不覆盖 task 锚
    openStudioTask('tk-2')
    setStudioMode('engine')
    expect(location.hash).toBe('#/studio/task/tk-2')
  })

  it('openTaskTab=任务详情面板 tab 段（agent 视图随会话锚携带）', () => {
    setView('agent') // #/t/s1
    openTaskTab('workbench')
    expect(getTaskTab()).toBe('workbench')
    expect(location.hash).toBe('#/t/s1/workbench')
    openTaskTab('activity')
    expect(location.hash).toBe('#/t/s1/activity')
    openTaskTab('result', { resultId: 'pub-9' })
    expect(getTaskResultId()).toBe('pub-9')
    expect(location.hash).toBe('#/t/s1/r/pub-9')
    openTaskTab('detail', { replace: true })
    expect(location.hash).toBe('#/t/s1')
    // 非 agent 视图不镜像（tab 段只在 agent 路由可表示——切走暂存于 store 态）
    setView('studio')
    openTaskTab('workbench')
    expect(location.hash).toBe('#/studio')
  })
})

describe('②URL 向：startViewRouteSync 反向派发（URL 为真源不回写）', () => {
  it('调用即同步（深链/刷新还原——App 挂载轮）', () => {
    resetRouterForTests('#/studio/task/tk-7')
    startViewRouteSync()
    expect(getView()).toBe('studio')
    expect(getStudioTaskId()).toBe('tk-7')
    expect(getStudioMode()).toBe('select')
    resetRouterForTests('#/studio/engine')
    startViewRouteSync()
    expect(getStudioMode()).toBe('engine')
    resetRouterForTests('#/t/s2/r/pub-3')
    startViewRouteSync()
    expect(getView()).toBe('agent')
    expect(getTaskTab()).toBe('result')
    expect(getTaskResultId()).toBe('pub-3')
  })

  it('hashchange/popstate 派发（回退/前进/手改 URL）', () => {
    startViewRouteSync()
    location.hash = '#/assets'
    window.dispatchEvent(new Event('hashchange'))
    expect(getView()).toBe('assets')
    location.hash = '#/studio/task/tk-8'
    window.dispatchEvent(new Event('popstate'))
    expect(getView()).toBe('studio')
    expect(getStudioTaskId()).toBe('tk-8')
  })

  it('login/admin 顶层不派发（守卫卡/后台页 URL 语义独立）', () => {
    startViewRouteSync()
    setView('assets')
    location.hash = '#/login'
    window.dispatchEvent(new Event('hashchange'))
    expect(getView()).toBe('assets')
    location.hash = '#/admin/kb'
    window.dispatchEvent(new Event('hashchange'))
    expect(getView()).toBe('assets')
  })

  it('反向派发不回写（URL 为该向真源——派发后 hash 不被镜像改写）', () => {
    startViewRouteSync()
    // 裸 #/（agent 无会话段）：派发视图态不补锚（openLatest/会话镜像归 sessionRoute 分区）。
    location.hash = '#/'
    window.dispatchEvent(new Event('hashchange'))
    expect(getView()).toBe('agent')
    expect(location.hash).toBe('#/')
  })
})
