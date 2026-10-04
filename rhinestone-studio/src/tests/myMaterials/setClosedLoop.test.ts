/*
 * [product-polish-w1 材料线 γ] 组合四环闭环 studio 测试（T2 开工/T4 编辑面+市场模式）。
 * 覆盖：
 *   [T2] 我的组合卡「开工」：createSession（标题=组合名）+composerOutbox 组合预选
 *        注入（新会话 Composer 集合选择器预选）+切前台 Agent 视图（view+hash）。
 *   [T4] SetDetailSheet 编辑态：进入（成员草稿行）→行内改数量/移除→搜索添加成员
 *        （SetStoneSearchPicker 共用件）→保存=sets.update（SetPatch diff+CAS
 *        baseRevision）→保存后回读模式+清单刷新。
 *   [T4] 市场模式：材料市场组合分组（默认折叠+与我的组去重）→卡片开只读详情
 *        （「复制到我的材料后可编辑」提示+无编辑位）→复制=copyFromMarket→副本进
 *        我的组+详情切到副本（可编辑）。
 * 数据面：stonesAdmin sets.fixtures（makeMarketSetsClient——scope/update/
 * copyFromMarket 真形）+ stonesAdmin fixtures makeClient（搜索读面）+ agentApi
 * store 注入 rpc 形 stub（开工链）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import MySetsSection from '../../components/my-materials/MySetsSection.svelte'
import { resetMySetsForTests } from '$lib/myMaterials/sets.svelte'
import { resetSessionForTests } from '$lib/stores/session.svelte'
import { bindStonesClient, resetStonesAdminForTests } from '$lib/stonesAdmin/store.svelte'
import { makeClient } from '../stonesAdmin/fixtures'
import { makeMarketSetsClient, type MarketSetsFixtureCalls } from '../stonesAdmin/sets.fixtures'
import type { WarehouseSetsClient } from '$lib/warehouse/client'
import { bindAgentApi, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { peekComposerSetPreset, resetComposerOutboxForTests } from '$lib/agentApi/composerOutbox.svelte'
import { getView, resetViewForTests } from '$lib/stores/view.svelte'
import { resetRouterForTests } from '$lib/router.svelte'
import type { AgentApi, AgentConnectionState } from '$lib/agentApi/types'
import type { Frame } from '@handicraft/contracts'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

// jsdom 未实现 ResizeObserver；bits-ui Sheet 覆盖层组件内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const mountedDisposers: Array<() => void> = []

function mountSection(client: WarehouseSetsClient): void {
  resetMySetsForTests(client)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(MySetsSection, { target })
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

function click(selector: string): void {
  q(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function type(selector: string, value: string): void {
  const el = q(selector) as HTMLInputElement
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 开工链 rpc 形 stub（agentApi store 注入——createSession 调用记录）。 */
function makeAgentStub(): { api: AgentApi; createSessionCalls: Array<{ title?: string }> } {
  const iso = new Date().toISOString()
  const session = { id: 's-existing', title: '既有会话', status: 'active' as const, createdAt: iso, updatedAt: iso }
  const createSessionCalls: Array<{ title?: string }> = []
  const listeners = new Map<string, Set<(frame: Frame) => void>>()
  let connectionState: AgentConnectionState = 'open'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
  const unimplemented = (what: string) => (): never => {
    throw new Error(`${what}不可用（开工链桩）`)
  }
  const api: AgentApi = {
  setAutoApprove: async () => ({ ok: true, autoApprove: false }),
    mode: 'rpc',
    connection: () => connectionState,
    onConnectionChange: (listener) => {
      connectionListeners.add(listener)
      listener(connectionState)
      return () => connectionListeners.delete(listener)
    },
    listSessions: async () => ({ sessions: [session] }),
    createSession: async (input: { title?: string }) => {
      createSessionCalls.push({ ...(input.title !== undefined ? { title: input.title } : {}) })
      return { sessionId: 's-new', createdAt: iso }
    },
    getSession: async () => ({ session, tasks: [] }),
    followup: async () => ({ taskId: 't-x' }),
    uploadAssetImage: unimplemented('图片上传'),
    stopTask: async () => {},
    answer: async () => ({ ok: true }),
    renameSession: async () => {
      throw new Error('本测试不触达')
    },
    cancel: async () => ({ ok: true }),
    clear: async () => ({ ok: true, status: 'cleared' as const }),
    replay: async () => ({ frames: [], nextSeq: 0 }),
    sessionResult: async () => {
      throw new Error('会话暂无已完成结果')
    },
    taskResult: async () => ({ found: false }),
    taskArtifact: unimplemented('工件读面'),
    taskDetail: unimplemented('任务详情'),
    layerSplit: unimplemented('拆层'),
    layerRename: unimplemented('重命名'),
    layerStrategySet: unimplemented('策略直改'),
    treeHistory: unimplemented('版本史'),
    layerMaskPatch: unimplemented('遮罩编辑'),
    viewStateSet: unimplemented('视图态写入'),
    taskExport: unimplemented('任务导出'),
    layerReorder: unimplemented('图层重排'),
    layerDelete: unimplemented('图层删除'),
    treeRevert: unimplemented('整树回退'),
    maskEditRetry: unimplemented('编辑重算'),
    taskReferenceRegenerate: unimplemented('重新生成参考图层'),
    taskReferenceDisable: unimplemented('禁用参考图层'),
    taskReferenceEnable: unimplemented('启用参考图层'),
    maskEditDiscard: unimplemented('编辑放弃'),
    subscribeTask: (taskId, _afterSeq, onFrame) => {
      let set = listeners.get(taskId)
      if (!set) {
        set = new Set()
        listeners.set(taskId, set)
      }
      set.add(onFrame)
      return () => {
        set!.delete(onFrame)
      }
    },
  }
  return { api, createSessionCalls }
}

beforeEach(() => {
  document.body.innerHTML = ''
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  sessionStorage.clear()
  localStorage.clear()
  resetSessionForTests({ username: 'worker', role: 'user' })
  resetStonesAdminForTests()
  bindStonesClient(makeClient().client)
  resetAgentStoreForTests()
  resetComposerOutboxForTests()
  resetViewForTests()
  resetRouterForTests()
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  resetMySetsForTests()
  resetAgentStoreForTests()
  resetComposerOutboxForTests()
  resetViewForTests()
  resetRouterForTests()
})

// ---------------------------------------------------------------------------
// [T2] 开工 CTA
// ---------------------------------------------------------------------------

describe('我的组合卡「开工」（T2——挑组合→开工一步进首条消息）', () => {
  it('点击开工：createSession（标题=组合名）+组合预选注入+切前台 Agent 视图', async () => {
    const agentStub = makeAgentStub()
    bindAgentApi(agentStub.api)
    const fixture = makeMarketSetsClient({
      sets: [
        {
          resourceId: 'set-snow',
          name: '圣诞雪人款',
          members: [
            { stoneRef: 'res-j51', quantity: 2 },
            { stoneRef: 'res-a51' },
          ],
        },
      ],
    })
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-start-set-snow"]')
    await flush(40)

    // createSession 标题=组合名（N1：会话即订单）。
    expect(agentStub.createSessionCalls).toEqual([{ title: '圣诞雪人款' }])
    // 组合预选注入在场（SessionStream 未挂载——单槽滞留，前台挂载即消费）。
    expect(peekComposerSetPreset()).toMatchObject({ resourceId: 'set-snow', name: '圣诞雪人款', scope: 'mine' })
    // 切前台：view=agent + hash 归位。
    expect(getView()).toBe('agent')
    expect(location.hash).toBe('#/')
    // 开工按钮 stopPropagation——详情 Sheet 不开（不误触详情面）。
    expect(document.querySelector('[data-testid="my-set-detail-sheet"]')).toBeNull()
  })

  it('开工失败（createSession 抛错）：停留当前视图+toast 错误面不崩', async () => {
    const agentStub = makeAgentStub()
    agentStub.api.createSession = async () => {
      throw new Error('会话服务不可用')
    }
    bindAgentApi(agentStub.api)
    const fixture = makeMarketSetsClient({ sets: [{ resourceId: 'set-a', name: '组合A', members: [{ stoneRef: 'res-j51' }] }] })
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-start-set-a"]')
    await flush(40)
    // 预选不注入（开工链原子性——失败不残留半链）。
    expect(peekComposerSetPreset()).toBeNull()
    expect(document.querySelector('[data-testid="my-sets-card-set-a"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// [T4] 编辑面（SetPatch UI）
// ---------------------------------------------------------------------------

describe('SetDetailSheet 编辑态（T4——成员行内改数量/移除/搜索添加→sets.update）', () => {
  it('改数量+移除+搜索添加→保存=SetPatch diff（CAS baseRevision）→回读模式+清单刷新', async () => {
    let setsCalls: MarketSetsFixtureCalls
    const fixture = makeMarketSetsClient({
      sets: [
        {
          resourceId: 'set-a',
          name: '组合A',
          members: [
            { stoneRef: 'res-j51', quantity: 2 },
            { stoneRef: 'res-a51', quantity: 5 },
          ],
        },
      ],
    })
    setsCalls = fixture.calls
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-a"]')
    await flush()
    click('[data-testid="my-set-detail-edit"]')
    await flush()
    expect(q('[data-testid="my-set-detail-edit-panel"]')).toBeDefined()

    // 行内改数量：res-j51 2→5。
    type('[data-testid="my-set-detail-edit-qty-res-j51"]', '5')
    // 行内移除：res-a51。
    click('[data-testid="my-set-detail-edit-remove-res-a51"]')
    await flush()
    // 搜索添加成员（共用件——300ms 防抖后服务端查询；米白 → res-j52）。
    type('[data-testid="set-edit-search"]', '米白')
    await flush(360)
    click('[data-testid="set-edit-result-res-j52"]')
    await flush()
    expect(q('[data-testid="my-set-detail-edit-new-res-j52"]').textContent).toContain('新')

    click('[data-testid="my-set-detail-save"]')
    await flush(60)

    // 保存=SetPatch diff：数量更新+移除+追加（CAS baseRevision=3 fixture 锚）。
    expect(setsCalls.update).toHaveLength(1)
    expect(setsCalls.update[0]).toEqual({
      resourceId: 'set-a',
      baseRevision: 3,
      patch: {
        removeMembers: ['res-a51'],
        addMembers: [{ stoneRef: 'res-j52' }],
        updateMembers: [{ stoneRef: 'res-j51', quantity: 5 }],
      },
    })
    // 保存后回读模式（编辑面板退场）+清单刷新（memberCount 跟随）。
    expect(document.querySelector('[data-testid="my-set-detail-edit-panel"]')).toBeNull()
    expect(q('[data-testid="my-set-detail-sheet"]')).toBeDefined()
    expect(q('[data-testid="my-sets-count"]').textContent).toContain('1 个组合')
  })

  it('清空守卫：移除全部成员→保存拦下（empty-members 前置）+取消编辑回读模式', async () => {
    const fixture = makeMarketSetsClient({
      sets: [{ resourceId: 'set-a', name: '组合A', members: [{ stoneRef: 'res-j51' }] }],
    })
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-a"]')
    await flush()
    click('[data-testid="my-set-detail-edit"]')
    await flush()
    click('[data-testid="my-set-detail-edit-remove-res-j51"]')
    await flush()
    expect(q('[data-testid="my-set-detail-edit-empty"]')).toBeDefined()

    click('[data-testid="my-set-detail-save"]')
    await flush()
    expect(fixture.calls.update).toHaveLength(0) // 清空不落库（empty-members）
    // 保存按钮禁用+取消编辑回读模式。
    expect((q('[data-testid="my-set-detail-save"]') as HTMLButtonElement).disabled).toBe(true)
    click('[data-testid="my-set-detail-edit-cancel"]')
    await flush()
    expect(document.querySelector('[data-testid="my-set-detail-edit-panel"]')).toBeNull()
    expect(q('[data-testid="my-set-detail-grid"]')).toBeDefined()
  })

  it('CAS 漂移：revision-conflict typed 错误条呈现（他处已更新）', async () => {
    const fixture = makeMarketSetsClient({
      sets: [{ resourceId: 'set-a', name: '组合A', members: [{ stoneRef: 'res-j51', quantity: 1 }] }],
    })
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-card-set-a"]')
    await flush()
    click('[data-testid="my-set-detail-edit"]')
    await flush()
    // 他处先行更新（fixture 真形 CAS——revision 3→4）。
    await fixture.client.update({ resourceId: 'set-a', baseRevision: 3, patch: { updateMembers: [{ stoneRef: 'res-j51', quantity: 9 }] } })
    type('[data-testid="my-set-detail-edit-qty-res-j51"]', '2')
    click('[data-testid="my-set-detail-save"]')
    await flush(40)

    expect(q('[data-testid="my-set-detail-edit-error"]').textContent).toContain('revision')
    expect(document.querySelector('[data-testid="my-set-detail-edit-panel"]')).not.toBeNull() // 编辑态保留
  })
})

// ---------------------------------------------------------------------------
// [T4] 市场模式（只读快照+复制到我的材料）
// ---------------------------------------------------------------------------

describe('材料市场组合分组+市场模式详情（T4/T1——A1 活分组）', () => {
  it('市场分组默认折叠+与我的组去重；展开开详情：只读快照提示+复制 CTA+无编辑位', async () => {
    const fixture = makeMarketSetsClient({
      sets: [
        { resourceId: 'set-mine', name: '我的组合', members: [{ stoneRef: 'res-j51' }] },
        { resourceId: 'set-mkt', name: '圣诞系列', members: [{ stoneRef: 'res-j51', quantity: 6 }], market: true, mine: false },
        { resourceId: 'set-mine-mkt', name: '我的也是市场', members: [{ stoneRef: 'res-a51' }], market: true },
      ],
    })
    mountSection(fixture.client)
    await flush()

    // 我的组网格：两套（含 set-mine-mkt——admin 场景自有组合进我的组）。
    expect(q('[data-testid="my-sets-card-set-mine"]')).toBeDefined()
    expect(q('[data-testid="my-sets-card-set-mine-mkt"]')).toBeDefined()
    // 市场分组在场（默认折叠——卡片不渲染；与我的组 resourceId 去重：只剩 set-mkt）。
    expect(q('[data-testid="my-sets-market-toggle"]').textContent).toContain('材料市场组合')
    expect(q('[data-testid="my-sets-market-toggle"]').textContent).toContain('1')
    expect(document.querySelector('[data-testid="my-sets-market-card-set-mkt"]')).toBeNull()

    click('[data-testid="my-sets-market-toggle"]')
    await flush()
    click('[data-testid="my-sets-market-card-set-mkt"]')
    await flush()

    // 市场模式详情：市场徽标+只读快照提示+复制 CTA；编辑位退场。
    expect(q('[data-testid="my-set-detail-market-badge"]').textContent).toContain('市场')
    expect(q('[data-testid="my-set-detail-market-hint"]').textContent).toContain('市场组合为只读快照——复制到我的材料后可编辑')
    expect(q('[data-testid="my-set-detail-copy"]').textContent).toContain('复制到我的材料')
    expect(document.querySelector('[data-testid="my-set-detail-edit"]')).toBeNull()
  })

  it('复制链：copyFromMarket 调用→副本进我的组→详情切到副本（可编辑）', async () => {
    const fixture = makeMarketSetsClient({
      sets: [
        { resourceId: 'set-mine', name: '我的组合', members: [{ stoneRef: 'res-j51' }] },
        { resourceId: 'set-mkt', name: '圣诞系列', members: [{ stoneRef: 'res-j51', quantity: 6 }, { stoneRef: 'res-a51' }], market: true, mine: false },
      ],
    })
    mountSection(fixture.client)
    await flush()

    click('[data-testid="my-sets-market-toggle"]')
    await flush()
    click('[data-testid="my-sets-market-card-set-mkt"]')
    await flush()
    click('[data-testid="my-set-detail-copy"]')
    await flush(60)

    // T1 白名单复制调用（源 resourceId）。
    expect(fixture.calls.copyFromMarket).toEqual([{ resourceId: 'set-mkt' }])
    // 副本进我的组（计数 1→2）。
    expect(q('[data-testid="my-sets-count"]').textContent).toContain('2 个组合')
    // 详情切到副本——可编辑（编辑位在场+标题=副本）。
    expect(q('[data-testid="my-set-detail-edit"]')).toBeDefined()
    expect(fixture.calls.get).toContain('set-copy-1')
  })
})
