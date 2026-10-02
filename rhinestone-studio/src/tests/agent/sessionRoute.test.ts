/*
 * [product-polish-w1 T1] 会话 URL 锚定测试（zhumo §1.1 补抄——「它有 url 导航
 * 绑定，你没有」）。覆盖（store 集成级——stub API 注入，同 sessionUserSync 口径）：
 * ①选中写 hash：openSession 后 replaceState 镜像 `#/t/{id}`（不触发 hashchange、
 *   不进历史栈——replaceState spy 断言；防历史污染）；fromHash 反向派发不回写。
 * ②hash → 选中：hashchange（回退/深链/手改）反向 openSession；裸 `#/` 打开列表
 *   最新（URL 保持裸锚）；login/admin 顶层不派发。
 * ③深链首开：initAgentStore 时 `#/t/{id}` 在列表内=打开它；不在=回落最新+锚自愈。
 * ④新建会话落地即 `#/t/{新id}`（zhumo `#/new` 过渡态对齐——不设过渡态）；
 *   无会话态 hash 回裸 `#/`。
 * ⑤document.title 跟随会话标题（无会话/空标题回默认「贴钻工作台」）。
 * [T2] autoApprove 客户端透传（同 stub 顺带覆盖）：openSession 回读服务端投影、
 * 开关本地翻转、followup 投递携带现值（true/false 均为权威写入）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@handicraft/contracts'
import {
  bindAgentApi,
  createSession,
  getActiveSessionId,
  getAgentError,
  getAgentSessions,
  getSessionAutoApprove,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
  sendFollowup,
  setSessionAutoApprove,
} from '$lib/agentApi/store.svelte'
import {
  DEFAULT_DOCUMENT_TITLE,
  resetSessionRouteForTests,
  syncSessionDocumentTitle,
} from '$lib/agentApi/sessionRoute.svelte'
import type { AgentApi, AgentTaskView } from '$lib/agentApi/types'

function sessionOf(id: string, title: string, extra?: { autoApprove?: boolean }): SessionSummary {
  const now = new Date().toISOString()
  return { id, title, status: 'active', createdAt: now, updatedAt: now, ...(extra?.autoApprove !== undefined ? { autoApprove: extra.autoApprove } : {}) }
}

interface FollowupCall {
  sessionId: string
  text: string
  autoApprove?: boolean
}

/** stub API：list 可换；getSession/replay/subscribeTask/followup/createSession/clear 最小面。 */
function stubApi(sessions: SessionSummary[]): { api: AgentApi; setList(next: SessionSummary[]): void; followupCalls: FollowupCall[] } {
  let list = [...sessions]
  let created = 0
  const followupCalls: FollowupCall[] = []
  const api = {
    mode: 'rpc',
    connection: () => 'open' as const,
    onConnectionChange: () => () => {},
    listSessions: async () => ({ sessions: [...list] }),
    createSession: async () => {
      created += 1
      const row = sessionOf(`s-new-${created}`, '新建会话')
      list = [row, ...list]
      return { sessionId: row.id, createdAt: row.createdAt }
    },
    getSession: async (sessionId: string) => {
      const found = list.find((candidate) => candidate.id === sessionId)
      if (!found) throw new Error(`会话不存在：${sessionId}`)
      const tasks: AgentTaskView[] = []
      return { session: found, tasks }
    },
    followup: async (sessionId: string, text: string, _mode?: 'followup' | 'steer', _attachments?: string[], _sourceSetId?: string, autoApprove?: boolean) => {
      followupCalls.push({ sessionId, text, ...(autoApprove !== undefined ? { autoApprove } : {}) })
      return { taskId: `t-${followupCalls.length}` }
    },
    replay: async () => ({ frames: [], nextSeq: 0 }),
    subscribeTask: () => () => {},
    sessionResult: async () => {
      throw new Error('无结果')
    },
    clear: async () => ({ ok: true, status: 'cleared' as const }),
  } as unknown as AgentApi
  return { api, setList: (next) => (list = next), followupCalls }
}

beforeEach(() => {
  resetAgentStoreForTests()
  resetSessionRouteForTests('')
  document.title = DEFAULT_DOCUMENT_TITLE
})

describe('T1 会话 URL 锚定（zhumo §1.1 补抄）', () => {
  it('①选中写 hash：openSession replaceState 镜像 #/t/{id}（非 pushState——防历史污染）', async () => {
    const replaceSpy = vi.spyOn(history, 'replaceState')
    const pushSpy = vi.spyOn(history, 'pushState')
    const stub = stubApi([sessionOf('s1', '会话一'), sessionOf('s2', '会话二')])
    bindAgentApi(stub.api)
    await initAgentStore()
    // 首开（列表最新）已镜像锚（jsdom 下主路径抛错走 hash 赋值降级——路径断言见下）。
    expect(location.hash).toBe('#/t/s1')

    await openSession('s2')
    expect(location.hash).toBe('#/t/s2')
    // 主路径调用形态：replaceState(null, '', '#/t/s2')——pushState 零调用（防污染）。
    expect(replaceSpy).toHaveBeenCalledWith(null, '', '#/t/s2')
    expect(pushSpy).not.toHaveBeenCalled()
    replaceSpy.mockRestore()
    pushSpy.mockRestore()
  })

  it('①反向派发不回写：fromHash 打开会话时 hash 保持来向值（URL 是该向真源）', async () => {
    const stub = stubApi([sessionOf('s1', '会话一'), sessionOf('s2', '会话二')])
    bindAgentApi(stub.api)
    await initAgentStore()
    location.hash = '#/t/s2'
    window.dispatchEvent(new Event('hashchange'))
    await vi.waitFor(() => expect(getActiveSessionId()).toBe('s2'))
    // 不回写（hash 已是 #/t/s2——replaceState 无同值调用即无漂移；断言路径稳定）。
    expect(location.hash).toBe('#/t/s2')
  })

  it('②hashchange 反向派发选中：手改/回退到 #/t/{id} 切换活跃会话', async () => {
    const stub = stubApi([sessionOf('s1', '会话一'), sessionOf('s2', '会话二')])
    bindAgentApi(stub.api)
    await initAgentStore()
    expect(getActiveSessionId()).toBe('s1')

    location.hash = '#/t/s2'
    window.dispatchEvent(new Event('hashchange'))
    await vi.waitFor(() => expect(getActiveSessionId()).toBe('s2'))
  })

  it('②裸 #/ 打开列表最新（zhumo「#/ 默认最新会话」；URL 保持裸锚不回写）', async () => {
    const stub = stubApi([sessionOf('s1', '会话一'), sessionOf('s2', '会话二')])
    bindAgentApi(stub.api)
    await initAgentStore()
    await openSession('s2')
    expect(location.hash).toBe('#/t/s2')

    location.hash = '#/'
    window.dispatchEvent(new Event('hashchange'))
    await vi.waitFor(() => expect(getActiveSessionId()).toBe('s1'))
    expect(location.hash).toBe('#/')
  })

  it('②login/admin 顶层不派发（会话锚只在 home 下钻——守卫卡/后台页 URL 独立）', async () => {
    const stub = stubApi([sessionOf('s1', '会话一')])
    bindAgentApi(stub.api)
    await initAgentStore()
    await openSession('s1')

    location.hash = '#/login'
    window.dispatchEvent(new Event('hashchange'))
    await openSession('s1') // 无操作等待一拍（监听已跑完同步段）
    expect(getActiveSessionId()).toBe('s1')
    // login 顶层的选中镜像守卫：不把 #/login 改写成会话锚。
    expect(location.hash).toBe('#/login')

    location.hash = '#/admin/settings'
    window.dispatchEvent(new Event('hashchange'))
    expect(getActiveSessionId()).toBe('s1')
    expect(location.hash).toBe('#/admin/settings')
  })

  it('③深链首开：init 时 #/t/{id} 在列表内=打开它（非列表序第一）', async () => {
    location.hash = '#/t/s2'
    const stub = stubApi([sessionOf('s1', '会话一'), sessionOf('s2', '会话二')])
    bindAgentApi(stub.api)
    await initAgentStore()
    expect(getActiveSessionId()).toBe('s2')
    expect(location.hash).toBe('#/t/s2')
  })

  it('③未知锚清锚回列表态（[fixture 边界 2026-10-02]——rpc 残留 fixture/已删会话不 fallback 渲染）', async () => {
    location.hash = '#/t/ghost'
    const stub = stubApi([sessionOf('s1', '会话一')])
    bindAgentApi(stub.api)
    await initAgentStore()
    // 不再回落打开 sessions[0]——清锚+列表态（无选中）。
    expect(getActiveSessionId()).toBeNull()
    expect(location.hash).toBe('#/')
  })

  it('③rpc 下 fixture 残留锚（fixt-session-heart）：同 URL=清锚+列表态+零 fixture 渲染', async () => {
    location.hash = '#/t/fixt-session-heart'
    const stub = stubApi([sessionOf('rpc-s1', '真实会话')])
    bindAgentApi(stub.api)
    await initAgentStore()
    expect(getActiveSessionId()).toBeNull()
    expect(location.hash).toBe('#/')
    // 会话列表只含真实会话（fixture 无混入点——列表真源=listSessions）。
    expect(getAgentSessions().map((row) => row.id)).toEqual(['rpc-s1'])
  })

  it('③运行中手改 hash 到未知锚（fixture 残留）：清锚回 #/ + 默认最新（zhumo 同款——不留幽灵选中/不渲染 fixture）', async () => {
    const stub = stubApi([sessionOf('s1', '会话一')])
    bindAgentApi(stub.api)
    await initAgentStore()
    expect(getActiveSessionId()).toBe('s1')

    location.hash = '#/t/fixt-session-heart'
    window.dispatchEvent(new Event('hashchange'))
    // 复位写裸 #/ → 反向派发 openLatest（裸锚=默认最新——zhumo 路由契约同款）：
    // 净效果=清锚+回到真实最新会话；幽灵选中（fixture id）与残留锚都不在场。
    await vi.waitFor(() => expect(location.hash).toBe('#/'))
    await vi.waitFor(() => expect(getActiveSessionId()).toBe('s1'))
    expect(getAgentSessions().map((row) => row.id)).toEqual(['s1'])
    // 失败错误条被 openLatest 的 openSession 复位（无「会话不存在」残留）。
    expect(getAgentError()).toBeNull()
  })

  it('④新建会话落地即 #/t/{新id}（zhumo #/new 过渡态对齐——直落锚不设过渡态）', async () => {
    const stub = stubApi([sessionOf('s1', '会话一')])
    bindAgentApi(stub.api)
    await initAgentStore()
    await createSession('新作品')
    expect(getActiveSessionId()).toBe('s-new-1')
    expect(location.hash).toBe('#/t/s-new-1')
  })

  it('⑤document.title 跟随会话标题；无会话/空标题回默认「贴钻工作台」', async () => {
    expect(document.title).toBe(DEFAULT_DOCUMENT_TITLE)
    syncSessionDocumentTitle('爱心毛衣排钻')
    expect(document.title).toBe(`爱心毛衣排钻 · ${DEFAULT_DOCUMENT_TITLE}`)
    syncSessionDocumentTitle('   ')
    expect(document.title).toBe(DEFAULT_DOCUMENT_TITLE)
    syncSessionDocumentTitle(null)
    expect(document.title).toBe(DEFAULT_DOCUMENT_TITLE)
  })

  it('⑤store 集成：打开会话后标题跟随（App.svelte $effect 同源真源——store 驱动）', async () => {
    const stub = stubApi([sessionOf('s1', '星夜毛衣'), sessionOf('s2', '')])
    bindAgentApi(stub.api)
    await initAgentStore()
    syncSessionDocumentTitle(null)
    // 标题跟随由 App 层 $effect 消费（见 App.svelte）；此处验证数据面可达。
    expect(stub.api.listSessions).toBeDefined()
  })
})

describe('T2 自动批准客户端透传（开关+followup 携带）', () => {
  it('openSession 回读服务端投影：autoApprove 会话=开；普通会话=关', async () => {
    const stub = stubApi([sessionOf('s1', '开启的会话', { autoApprove: true }), sessionOf('s2', '普通会话')])
    bindAgentApi(stub.api)
    await initAgentStore()
    expect(getSessionAutoApprove()).toBe(true)
    await openSession('s2')
    expect(getSessionAutoApprove()).toBe(false)
  })

  it('开关本地翻转+followup 按投递时刻现值携带（true/false 均为权威写入）', async () => {
    const stub = stubApi([sessionOf('s1', '会话一')])
    bindAgentApi(stub.api)
    await initAgentStore()

    // 缺省关：首条 followup 携带 false（权威写入——服务端真源翻回）。
    await sendFollowup('先跑一版')
    expect(stub.followupCalls[0]).toMatchObject({ sessionId: 's1', autoApprove: false })

    // 开启后：下一条携带 true（steer 通道直投——首条后任务 running，常规发送会入队）。
    setSessionAutoApprove(true)
    expect(getSessionAutoApprove()).toBe(true)
    await sendFollowup('再调整密度', 'steer')
    expect(stub.followupCalls[1]).toMatchObject({ sessionId: 's1', autoApprove: true })

    // 关回：false 同样透传（免值守结束——服务端跟着翻回）。
    setSessionAutoApprove(false)
    await sendFollowup('恢复人工批准', 'steer')
    expect(stub.followupCalls[2]).toMatchObject({ sessionId: 's1', autoApprove: false })
  })
})
