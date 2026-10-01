/*
 * [add-task-stones-manifest-export 1.2 studio] Composer 集合选择器测试。
 * 覆盖（tasks 1.2 验收面）：
 * ①可见性门：新会话首条输入态显示选择入口（rpc+无任务行）；已有消息的会话隐藏
 *   （W0 冻结——sourceSetId 仅首个常规 followup 有效）；mock 演示模式隐藏（注入面在否）。
 * ②选择链：打开 Popover→候选行（集合名+成员数+更新时间）→选中落 chip（名称+
 *   成员数+「任务中可追加钻」提示+可清除）→发送载荷含 sourceSetId（与 attachments
 *   同级线字段）。
 * ③清除链：chip 移除→发送载荷无 sourceSetId 键。
 * ④跳过链：不选直接发送→载荷无 sourceSetId 键+选择器空态/脚注「本项目暂不引入
 *   集合成员」文案明示。
 * ⑤清单摘要（后续轮次）：task.detail.projectStones 投影（revision+条目数+溯源
 *   集合名）渲染在 Composer 上方；选择器同时隐藏。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  bindAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import {
  peekComposerSetPreset,
  queueComposerSetPreset,
  resetComposerOutboxForTests,
} from '$lib/agentApi/composerOutbox.svelte'
import type { AgentApi, AgentConnectionState, AgentSetSummary } from '$lib/agentApi/types'
import type { TaskDetailProjectStones, TaskDetailResponse, Frame } from '@handicraft/contracts'

// jsdom 缺口桩（同 composerAttachments.test.ts——本文件挂 SessionStream/TranscriptView）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

// ---------------------------------------------------------------- 测试助手

interface FollowupCall {
  sessionId: string
  text: string
  mode?: 'followup' | 'steer'
  attachments?: string[]
  sourceSetId?: string
}

interface StubOptions {
  /** getSession 返回的任务行（[] = 新会话首条输入态——选择器可见性锚）。 */
  tasks?: Array<{ taskId: string; status: 'running' | 'done' }>
  /** listSets 候选（缺省两行固定集合）。 */
  sets?: AgentSetSummary[]
  /** task.detail 的 projectStones 投影（缺省 null——摘要隐藏）。 */
  projectStones?: TaskDetailProjectStones | null
  /** [T3] copyMarketSet 强制失败（市场复制失败面）。 */
  copyMarketSetFailWith?: string
}

const STUB_SETS: AgentSetSummary[] = [
  { resourceId: 'res-a', setId: 'set-cartoon-a', name: '卡通人物套餐-A', memberCount: 12, updatedAt: '2026-09-20T08:30:00.000Z' },
  { resourceId: 'res-b', setId: 'set-red-basic', name: '红色系基础钻', memberCount: 8, updatedAt: '2026-09-25T12:00:00.000Z' },
]

/** [T3] 市场组候选（scope=market——材料市场组合折叠组）。 */
const MARKET_STUB_SET: AgentSetSummary = {
  resourceId: 'res-mkt', setId: 'set-xmas', name: '圣诞系列', memberCount: 20, updatedAt: '2026-09-28T09:00:00.000Z', scope: 'market',
}

/** fake rpc AgentApi（集合选择链注入面——mode 'rpc' 触发 SessionStream 选择器/附件面）。 */
function makeRpcStub(options: StubOptions = {}): { api: AgentApi; followupCalls: FollowupCall[]; taskDetailCalls: string[]; copyMarketCalls: string[] } {
  const iso = new Date().toISOString()
  const session = { id: 's-set', title: '集合选择会话', status: 'active' as const, createdAt: iso, updatedAt: iso }
  const followupCalls: FollowupCall[] = []
  const taskDetailCalls: string[] = []
  const copyMarketCalls: string[] = []
  let followupSeq = 0
  const listeners = new Map<string, Set<(frame: Frame) => void>>()
  let connectionState: AgentConnectionState = 'open'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
  const unimplemented = (what: string) => (): never => {
    throw new Error(`${what}不可用（集合选择桩）`)
  }
  const api: AgentApi = {
    mode: 'rpc',
    connection: () => connectionState,
    onConnectionChange: (listener) => {
      connectionListeners.add(listener)
      listener(connectionState)
      return () => connectionListeners.delete(listener)
    },
    listSessions: async () => ({ sessions: [session] }),
    createSession: async () => ({ sessionId: 's-new', createdAt: iso }),
    getSession: async () => ({
      session,
      tasks: (options.tasks ?? []).map((task) => ({
        taskId: task.taskId,
        status: task.status,
        lastSeq: 0,
        frameCount: 0,
      })),
    }),
    followup: async (sessionId, text, mode, attachments, sourceSetId) => {
      followupSeq += 1
      // 线形状归一记录（undefined 键不落——与 daemon 实际线上形状一致）。
      followupCalls.push({
        sessionId,
        text,
        ...(mode !== undefined ? { mode } : {}),
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
        ...(sourceSetId !== undefined ? { sourceSetId } : {}),
      })
      return { taskId: `t-fu-${followupSeq}` }
    },
    listSets: async () => structuredClone(options.sets ?? STUB_SETS),
    copyMarketSet: options.copyMarketSetFailWith === undefined
      ? async (resourceId: string) => {
          copyMarketCalls.push(resourceId)
          return { resourceId: `copy-of-${resourceId}`, memberCount: 20 }
        }
      : async (resourceId: string) => {
          copyMarketCalls.push(resourceId)
          throw new Error(options.copyMarketSetFailWith)
        },
    uploadAssetImage: async (file) => ({
      blobRef: `blob-${file.name}`,
      name: file.name,
      mime: file.type || 'image/png',
      width: 640,
      height: 480,
    }),
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
    taskDetail: async (taskId: string) => {
      taskDetailCalls.push(taskId)
      return {
        task: { taskId, status: 'done' },
        session: null,
        baseImage: null,
        tree: null,
        assignments: [],
        gems: null,
        preview: null,
        viewState: null,
        maskEdits: [],
        exportGate: { allowed: true, blockers: [] },
        stoneCandidates: [],
        projectStones: options.projectStones ?? null,
      } as unknown as TaskDetailResponse
    },
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
  return { api, followupCalls, taskDetailCalls, copyMarketCalls }
}

const mountedDisposers: Array<() => void> = []

function mountStream(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SessionStream, { target })
  mountedDisposers.push(() => {
    unmount(component)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

function setTrigger(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="composer-set-trigger"]') as HTMLButtonElement | null
}

function composerInput(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
}

/** 输入文本并触发 input（bind:value 同步——tick 后派生态跟手，同附件链测试形态）。 */
async function typeText(value: string): Promise<void> {
  const input = composerInput()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}

/** 打开选择器（点触发位→候选渲染完成）。 */
async function openSetPicker(): Promise<void> {
  setTrigger()!.click()
  await waitUntil(() => document.querySelector('[data-testid="composer-set-option"]') !== null)
}

/** 选中候选行（按集合名匹配）。 */
async function pickSetByName(name: string): Promise<void> {
  const option = [...document.querySelectorAll('[data-testid="composer-set-option"]')].find((el) =>
    el.textContent?.includes(name),
  ) as HTMLElement | undefined
  if (option === undefined) throw new Error(`候选行不存在：${name}`)
  option.click()
  await waitUntil(() => document.querySelector('[data-testid="composer-set-chip"]') !== null)
}

async function send(): Promise<void> {
  ;(document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).click()
  await waitUntil(() => true === true)
  await flush()
}

beforeEach(() => {
  resetAgentStoreForTests()
  resetComposerOutboxForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  resetAgentStoreForTests()
  resetComposerOutboxForTests()
})

// ---------------------------------------------------------------------------
// ① 可见性门（新会话显示/已有消息隐藏/mock 隐藏）
// ---------------------------------------------------------------------------

describe('集合选择器：可见性门', () => {
  it('新会话首条输入态（rpc+无任务行）显示选择入口；候选行含集合名+成员数+更新时间', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()
    expect(setTrigger()).not.toBeNull()

    await openSetPicker()
    const options = [...document.querySelectorAll('[data-testid="composer-set-option"]')]
    expect(options.map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('卡通人物套餐-A')]),
    )
    expect(options[0]!.textContent).toContain('12 成员')
    expect(options[0]!.textContent).toContain('2026-09-20')
  })

  it('已有消息的会话（任务行在场）隐藏选择入口（W0 冻结：仅首个常规 followup 有效）', async () => {
    const stub = makeRpcStub({ tasks: [{ taskId: 't-hist', status: 'done' }] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()
    expect(setTrigger()).toBeNull()
  })

  it('mock 演示模式隐藏选择入口（注入面在否——同附件位语义）', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    mountStream()
    await flush()
    // mock fixtures 的星夜会话 tasks=[]（新会话形态）——即便如此 rpc 门也拦下。
    expect(setTrigger()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ② 选择链（chip 呈现 + 发送载荷 sourceSetId）
// ---------------------------------------------------------------------------

describe('集合选择器：选择链', () => {
  it('选中→chip（名称+成员数+任务中可追加钻提示+可清除）→发送载荷含 sourceSetId（与 attachments 同级）', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    // 跳过=不选的脚注文案明示（选择器内常驻）。
    expect(document.querySelector('[data-testid="composer-set-skip-hint"]')?.textContent).toContain(
      '本项目暂不引入集合成员',
    )
    await pickSetByName('卡通人物套餐-A')

    const chip = document.querySelector('[data-testid="composer-set-chip"]') as HTMLElement
    expect(chip.textContent).toContain('卡通人物套餐-A')
    expect(chip.textContent).toContain('12 成员')
    expect(chip.textContent).toContain('任务中可追加钻')
    expect(chip.querySelector('[data-testid="composer-set-chip-remove"]')).not.toBeNull()

    await typeText('照这张图排')
    await send()
    expect(stub.followupCalls).toHaveLength(1)
    expect(stub.followupCalls[0]).toMatchObject({
      sessionId: 's-set',
      text: '照这张图排',
      sourceSetId: 'res-a',
    })
    // 未选附件=不带 attachments 键（线上形状零漂移）。
    expect('attachments' in stub.followupCalls[0]!).toBe(false)
  })

  it('搜索过滤：查询串命中子串（大小写不敏感），候选收敛', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    const search = document.querySelector('[data-testid="composer-set-search"]') as HTMLInputElement
    search.value = '红色系'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    const options = [...document.querySelectorAll('[data-testid="composer-set-option"]')]
    expect(options).toHaveLength(1)
    expect(options[0]!.textContent).toContain('红色系基础钻')
  })
})

// ---------------------------------------------------------------------------
// ③ 清除链 / ④ 跳过链
// ---------------------------------------------------------------------------

describe('集合选择器：清除与跳过', () => {
  it('清除 chip→发送载荷无 sourceSetId 键', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    await pickSetByName('红色系基础钻')
    ;(document.querySelector('[data-testid="composer-set-chip-remove"]') as HTMLElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-chip"]') === null)

    await typeText('不选集合直接开始')
    await send()
    expect(stub.followupCalls).toHaveLength(1)
    expect('sourceSetId' in stub.followupCalls[0]!).toBe(false)
  })

  it('跳过=不选直接发送→载荷无 sourceSetId 键；空态文案明示「本项目暂不引入集合成员」', async () => {
    const stub = makeRpcStub({ tasks: [], sets: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    setTrigger()!.click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-popover"]') !== null)
    await flush()
    // 空集合态：列表区空态文案（跳过不强制）。
    expect(document.querySelector('[data-testid="composer-set-list"]')?.textContent).toContain(
      '无匹配集合——本项目暂不引入集合成员',
    )
    expect(document.querySelector('[data-testid="composer-set-skip-hint"]')?.textContent).toContain(
      '本项目暂不引入集合成员',
    )

    await typeText('跳过集合，直接排')
    await send()
    expect(stub.followupCalls).toHaveLength(1)
    expect('sourceSetId' in stub.followupCalls[0]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ⑤ 清单摘要（后续轮次——projectStones 投影）
// ---------------------------------------------------------------------------

describe('项目钻清单摘要：后续轮次渲染', () => {
  it('task.detail.projectStones 投影渲染在顶部栏（[product-polish-w2 T1] 迁 header——紧凑款数+rev；title 显全量含溯源集合名）', async () => {
    const stub = makeRpcStub({
      tasks: [{ taskId: 't-det', status: 'done' }],
      projectStones: { revision: 3, entryCount: 5, sourceSetName: '夏季主色', lint: null },
    })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await waitUntil(() => document.querySelector('[data-testid="composer-project-stones"]') !== null)

    expect(stub.taskDetailCalls).toContain('t-det')
    const chip = document.querySelector('[data-testid="composer-project-stones"]') as HTMLElement
    // [T1] header 同排位（「进行中」pill 邻域——header 内），紧凑文本+title 全量信息。
    expect(chip.closest('header')).not.toBeNull()
    expect(chip.textContent).toContain('5 款钻')
    expect(chip.textContent).toContain('rev 3')
    expect(chip.getAttribute('title')).toContain('项目钻清单：夏季主色 · 5 款钻 · revision 3')
    // 已有消息的会话：选择器隐藏（W0 冻结），摘要承接。
    expect(setTrigger()).toBeNull()
  })

  it('projectStones=null（未装配/无项目行）摘要隐藏，不占错误面', async () => {
    const stub = makeRpcStub({ tasks: [{ taskId: 't-det', status: 'done' }], projectStones: null })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush(60)
    expect(document.querySelector('[data-testid="composer-project-stones"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// [product-polish-w1 T2] 组合预选注入（我的材料「开工」→ 新会话 Composer 预选）
// ---------------------------------------------------------------------------

describe('组合预选注入（T2 开工链路终点）', () => {
  it('queueComposerSetPreset→SessionStream 消费→chip 在场（不开选择器）+单槽清空', async () => {
    const stub = makeRpcStub({ tasks: [] })
    bindAgentApi(stub.api)
    await initAgentStore()
    queueComposerSetPreset({ resourceId: 'res-a', setId: 'set-cartoon-a', name: '卡通人物套餐-A', memberCount: 12, updatedAt: '2026-09-20T08:30:00.000Z', scope: 'mine' })
    mountStream()
    await flush()

    const chip = document.querySelector('[data-testid="composer-set-chip"]') as HTMLElement
    expect(chip.textContent).toContain('卡通人物套餐-A')
    expect(chip.textContent).toContain('12 成员')
    // 消费即清空（单槽——不滞留污染下个会话）。
    expect(peekComposerSetPreset()).toBeNull()

    // 预选随首条消息投递（sourceSetId=预选组合）。
    await typeText('照这个组合开工')
    await send()
    expect(stub.followupCalls[0]).toMatchObject({ sourceSetId: 'res-a' })
  })

  it('已有任务的会话不消费（选择器隐藏——注入滞留不丢「开工」意图）', async () => {
    const stub = makeRpcStub({ tasks: [{ taskId: 't-hist', status: 'done' }] })
    bindAgentApi(stub.api)
    await initAgentStore()
    queueComposerSetPreset({ resourceId: 'res-a', setId: 'set-cartoon-a', name: '卡通人物套餐-A', memberCount: 12, updatedAt: '2026-09-20T08:30:00.000Z', scope: 'mine' })
    mountStream()
    await flush()

    expect(document.querySelector('[data-testid="composer-set-chip"]')).toBeNull()
    expect(peekComposerSetPreset()?.resourceId).toBe('res-a')
  })
})

// ---------------------------------------------------------------------------
// [product-polish-w1 T3] 分组置顶+市场组合复制语义（N1「挑组合」）
// ---------------------------------------------------------------------------

describe('集合选择器：分组+市场组合（T3）', () => {
  it('我的组合置顶+材料市场组合折叠组：默认只渲染我的组；展开后市场行可选', async () => {
    const stub = makeRpcStub({ tasks: [], sets: [...STUB_SETS, MARKET_STUB_SET] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    // 分组头：我的组合（置顶）+材料市场组合（计数）。
    expect(document.querySelector('[data-testid="composer-set-group-mine"]')?.textContent).toContain('我的组合')
    const marketToggle = document.querySelector('[data-testid="composer-set-group-market"]') as HTMLElement
    expect(marketToggle.textContent).toContain('材料市场组合')
    expect(marketToggle.textContent).toContain('1')
    // 默认折叠：市场行不渲染，我的组两行在场。
    let options = [...document.querySelectorAll('[data-testid="composer-set-option"]')]
    expect(options).toHaveLength(2)
    expect(options.every((el) => el.getAttribute('data-scope') === 'mine')).toBe(true)

    // 展开后市场行在场（data-scope=market+「市场」徽标）。
    marketToggle.click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-option"][data-scope="market"]') !== null)
    options = [...document.querySelectorAll('[data-testid="composer-set-option"]')]
    expect(options).toHaveLength(3)
    const marketRow = options.find((el) => el.getAttribute('data-scope') === 'market')!
    expect(marketRow.textContent).toContain('圣诞系列')
    expect(marketRow.textContent).toContain('市场')
  })

  it('选中市场组合→chip「市场」徽标+只读快照提示行', async () => {
    const stub = makeRpcStub({ tasks: [], sets: [...STUB_SETS, MARKET_STUB_SET] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    ;(document.querySelector('[data-testid="composer-set-group-market"]') as HTMLElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-option"][data-scope="market"]') !== null)
    ;([...document.querySelectorAll('[data-testid="composer-set-option"]')]
      .find((el) => el.getAttribute('data-scope') === 'market') as HTMLElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-chip"]') !== null)

    const chip = document.querySelector('[data-testid="composer-set-chip"]') as HTMLElement
    expect(chip.textContent).toContain('圣诞系列')
    expect(chip.textContent).toContain('市场')
    expect(document.querySelector('[data-testid="composer-set-market-hint"]')?.textContent).toContain(
      '市场组合为只读快照——开工自动复制到我的材料',
    )
  })

  it('发送市场组合：先 copyMarketSet 再绑定副本 resourceId 为 sourceSetId（复制链路一次）', async () => {
    const stub = makeRpcStub({ tasks: [], sets: [...STUB_SETS, MARKET_STUB_SET] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    ;(document.querySelector('[data-testid="composer-set-group-market"]') as HTMLElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-option"][data-scope="market"]') !== null)
    ;([...document.querySelectorAll('[data-testid="composer-set-option"]')]
      .find((el) => el.getAttribute('data-scope') === 'market') as HTMLElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-chip"]') !== null)

    await typeText('按圣诞系列排这张图')
    await send()
    // 复制先于发送，sourceSetId=副本（非市场源——服务端 owner 隔离下市场源必拒）。
    expect(stub.copyMarketCalls).toEqual(['res-mkt'])
    expect(stub.followupCalls).toHaveLength(1)
    expect(stub.followupCalls[0]).toMatchObject({ sourceSetId: 'copy-of-res-mkt' })
  })

  it('复制失败：中止发送（不裸发市场源）+chip 保留可重试', async () => {
    const stub = makeRpcStub({ tasks: [], sets: [...STUB_SETS, MARKET_STUB_SET], copyMarketSetFailWith: '源组合不属于管理员' })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    ;(document.querySelector('[data-testid="composer-set-group-market"]') as HTMLElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-option"][data-scope="market"]') !== null)
    ;([...document.querySelectorAll('[data-testid="composer-set-option"]')]
      .find((el) => el.getAttribute('data-scope') === 'market') as HTMLElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-set-chip"]') !== null)

    await typeText('按圣诞系列排这张图')
    await send()
    expect(stub.copyMarketCalls).toEqual(['res-mkt'])
    expect(stub.followupCalls).toHaveLength(0) // 不裸发市场源
    expect(document.querySelector('[data-testid="composer-set-chip"]')).not.toBeNull() // 选中态保留
  })

  it('搜索命中市场组：折叠态自动展开（查询命中不藏行）', async () => {
    const stub = makeRpcStub({ tasks: [], sets: [...STUB_SETS, MARKET_STUB_SET] })
    bindAgentApi(stub.api)
    await initAgentStore()
    mountStream()
    await flush()

    await openSetPicker()
    const search = document.querySelector('[data-testid="composer-set-search"]') as HTMLInputElement
    search.value = '圣诞'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await waitUntil(() => document.querySelector('[data-testid="composer-set-option"][data-scope="market"]') !== null)
    const options = [...document.querySelectorAll('[data-testid="composer-set-option"]')]
    expect(options).toHaveLength(1)
    expect(options[0]!.textContent).toContain('圣诞系列')
  })
})
