/*
 * [product-polish-w2 T3] 审批卡入 InputGroup（zStack）jsdom 测试（Owner Wave 1
 * 验收指令「收到审批任务的时候，InputGroup 内的 textarea 会被替换成审批卡」）。
 * 覆盖：①栈替换（textarea 退场+计数+切卡箭头态+发送禁用）；②批准链（answer→
 * resolved 帧→自动切下一张→全部处理完恢复 textarea 且草稿保留）；③多卡层叠
 * （帧序逐个处理+后卡露出条+键盘 ←/→ 切卡）；④过期卡（操作区变「跳过」=本地
 * 清卡不入审批账——answer 不被调）；⑤转录抑制（栈在场时转录流审批卡无操作面，
 * 栈清空即恢复）。
 * [w19-critic 终门三修] ⑥P1 卡高约束+转录保底（composer max-h 内滚+140px 底线）；
 * ⑦P2 strategy.design 决策点卡人话形态（zStack 走 StrategyProposalCard——方案
 * 摘要+查看详情折叠）；⑧P2 过期卡跳过跨 openSession 重开不复活（会话键持久化）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import {
  bindAgentApi,
  getPendingApprovals,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { bindStrategyArtifactsProvider, resetStrategyDesignerForTests } from '$lib/strategyDesigner/store.svelte'
import { MockStrategyArtifacts, STRATEGY_FIXTURE_BLOB_REFS } from '$lib/strategyDesigner/fixtures'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import type { AgentApi, AgentConnectionState, AgentTaskView } from '$lib/agentApi/types'
import type { Frame, SessionSummary } from '@handicraft/contracts'

// jsdom 缺口桩（同 autoApproveToggle/quickStart——挂 SessionStream/TranscriptView）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

interface Harness {
  api: AgentApi
  /** 直推帧（subscribeTask 注册的监听面——模拟 WS 实时帧到达）。 */
  pushFrames(...frames: Frame[]): void
  answerCalls: Array<{ requestId: string; approved: boolean }>
}

function approvalFrame(seq: number, requestId: string, opts?: { expiresAt?: string; tool?: string }): Frame {
  return {
    seq,
    ts: Date.now(),
    kind: 'approval-request',
    payload: {
      requestId,
      tool: opts?.tool ?? 'studio.patch-apply',
      proposalId: `proposal-${requestId}`,
      preview: { before: 'blob-before-0001', after: 'blob-after-0001' },
      summary: `排钻修改提案 ${requestId}：把主体区域密度提升到 0.9。`,
      expiresAt: opts?.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
      projectLabel: '审批测试项目',
    },
  } as Frame
}

/** 策略工件帧（[w19-critic P2]⑦——喂 getStrategyRefs → MockStrategyArtifacts 装配指派行）。 */
function strategyArtifactFrame(name: string, blobRef: string): Frame {
  return {
    ts: Date.now(),
    kind: 'artifact',
    payload: { name, blobRef },
  } as Frame
}

function resolvedFrame(seq: number, requestId: string, approved: boolean): Frame {
  return {
    seq,
    ts: Date.now(),
    kind: 'approval-resolved',
    payload: { requestId, approved, resolvedAt: new Date().toISOString() },
  } as Frame
}

function harness(): Harness {
  const iso = new Date().toISOString()
  const session: SessionSummary = { id: 's-stack', title: '审批栈会话', status: 'active', createdAt: iso, updatedAt: iso }
  const tasks: AgentTaskView[] = [{ taskId: 't-stack', status: 'running', lastSeq: 0, frameCount: 0 }]
  const listeners = new Set<(frame: Frame) => void>()
  const answerCalls: Array<{ requestId: string; approved: boolean }> = []
  /** 已推帧（[w19-critic P2]⑧——openSession 重开时 replay 回放同集：跳过持久化断言用）。 */
  const pushed: Frame[] = []
  let connectionState: AgentConnectionState = 'open'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
  let seq = 0
  const api = {
    mode: 'rpc',
    connection: () => connectionState,
    onConnectionChange: (listener: (state: AgentConnectionState) => void) => {
      connectionListeners.add(listener)
      listener(connectionState)
      return () => connectionListeners.delete(listener)
    },
    listSessions: async () => ({ sessions: [session] }),
    createSession: async () => ({ sessionId: 's-new', createdAt: iso }),
    getSession: async () => ({ session, tasks }),
    followup: async () => ({ taskId: 't-stack' }),
    replay: async () => ({ frames: structuredClone(pushed), nextSeq: pushed.length }),
    subscribeTask: (_taskId: string, _afterSeq: number, onFrame: (frame: Frame) => void) => {
      listeners.add(onFrame)
      return () => listeners.delete(onFrame)
    },
    sessionResult: async () => {
      throw new Error('无结果')
    },
    clear: async () => ({ ok: true, status: 'cleared' as const }),
    cancel: async () => ({ ok: true }),
    answer: async (_sessionId: string, requestId: string, approved: boolean) => {
      answerCalls.push({ requestId, approved })
      return { ok: true }
    },
    stopTask: async () => {},
    taskResult: async () => ({ found: false }),
    taskArtifact: async () => {
      throw new Error('本测试不触达')
    },
  } as unknown as AgentApi
  return {
    api,
    answerCalls,
    pushFrames: (...frames: Frame[]) => {
      for (const frame of frames) {
        seq += 1
        const stamped = { ...frame, seq } as Frame
        pushed.push(stamped)
        for (const listener of listeners) listener(stamped)
      }
    },
  }
}

const mounted: Array<() => void> = []

async function mountStream(api: AgentApi): Promise<void> {
  bindAgentApi(api)
  await initAgentStore()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SessionStream, { target })
  mounted.push(() => {
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

beforeEach(() => {
  resetAgentStoreForTests()
  resetSessionRouteForTests('')
  resetStrategyDesignerForTests()
})

afterEach(() => {
  while (mounted.length > 0) {
    const dispose = mounted.pop()!
    dispose()
  }
})

describe('T3 审批 zStack：textarea 整块替换', () => {
  it('①审批到达→栈出现+textarea 退场+计数+切卡箭头禁用态+转录抑制', async () => {
    const h = harness()
    await mountStream(h.api)

    expect(document.querySelector('[data-testid="agent-composer"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="composer-approval-stack"]')).toBeNull()

    h.pushFrames(approvalFrame(1, 'req-1'))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') !== null)

    // textarea 整块替换。
    expect(document.querySelector('[data-testid="agent-composer"]')).toBeNull()
    // 计数徽标 1/1 + 单卡无前后卡（箭头禁用）。
    expect(document.querySelector('[data-testid="composer-approval-count"]')?.textContent?.trim()).toBe('1/1')
    expect((document.querySelector('[data-testid="composer-approval-prev"]') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('[data-testid="composer-approval-next"]') as HTMLButtonElement).disabled).toBe(true)
    // 当前卡（帧序第 1 张）。
    expect(document.querySelector('[data-testid="composer-approval-card-1"]')).not.toBeNull()
    // 转录抑制：转录流的审批卡信息态（无操作面——栈是唯一动作面）。
    expect(document.querySelector('[data-testid="frame-approval-resolved"]')).toBeNull()
    expect(document.querySelector('[data-testid="approval-card"] [data-testid="approval-approve"]')).not.toBeNull()
    // 栈内卡（inline）持批准/拒绝；转录卡（非 inline）无。
    const cards = [...document.querySelectorAll('[data-testid="approval-card"]')]
    expect(cards.length).toBe(2)
    const approveButtons = [...document.querySelectorAll('[data-testid="approval-approve"]')]
    expect(approveButtons.length).toBe(1)
    expect(approveButtons[0]!.closest('[data-testid="composer-approval-stack"]')).not.toBeNull()
  })

  it('②批准链：answer→resolved 帧→栈清空恢复 textarea（草稿保留）', async () => {
    const h = harness()
    await mountStream(h.api)

    // 用户先有草稿（审批帧后到——draftLength 语义）。
    const input = document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
    input.value = '等审批过后我想继续调整密度'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    h.pushFrames(approvalFrame(1, 'req-1'))
    await waitUntil(() => document.querySelector('[data-testid="agent-composer"]') === null)

    ;(document.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement).click()
    await waitUntil(() => h.answerCalls.length === 1)
    expect(h.answerCalls[0]).toEqual({ requestId: 'req-1', approved: true })

    // approval-resolved 帧到达 → 栈清空 → textarea 恢复且草稿保留。
    h.pushFrames(resolvedFrame(2, 'req-1', true))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') === null)
    const restored = document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
    expect(restored).not.toBeNull()
    expect(restored.value).toBe('等审批过后我想继续调整密度')
    expect(getPendingApprovals()).toEqual([])
  })

  it('③多卡层叠：帧序逐个处理+露出条 cap+箭头/键盘切卡+处理完自动落位下一张', async () => {
    const h = harness()
    await mountStream(h.api)

    h.pushFrames(
      approvalFrame(1, 'req-1'),
      approvalFrame(2, 'req-2'),
      approvalFrame(3, 'req-3'),
      approvalFrame(4, 'req-4'),
    )
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-count"]') !== null)

    // 计数 1/4；露出条 cap=3（4 卡→3 条视觉暗示）。
    expect(document.querySelector('[data-testid="composer-approval-count"]')?.textContent?.trim()).toBe('1/4')
    const stack = document.querySelector('[data-testid="composer-approval-stack"]') as HTMLElement
    const peeks = stack.querySelectorAll('div[aria-hidden="true"]')
    expect(peeks.length).toBe(3)

    // 箭头切卡：1→2；键盘 ←/→ 同门。
    ;(document.querySelector('[data-testid="composer-approval-next"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-count"]')?.textContent?.trim() === '2/4')
    stack.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-count"]')?.textContent?.trim() === '3/4')
    stack.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-count"]')?.textContent?.trim() === '2/4')

    // 批准当前卡（第 2 张 req-2）→ 处理完自动落位下一张（3 张剩→2/3）。
    ;(document.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement).click()
    await waitUntil(() => h.answerCalls.length === 1)
    expect(h.answerCalls[0]).toEqual({ requestId: 'req-2', approved: true })
    h.pushFrames(resolvedFrame(5, 'req-2', true))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-count"]')?.textContent?.trim() === '2/3')
    expect(getPendingApprovals().map((item) => item.requestId)).toEqual(['req-1', 'req-3', 'req-4'])
  })

  it('④过期卡：操作区变「跳过」（本地清卡不入审批账——answer 零调用）', async () => {
    const h = harness()
    await mountStream(h.api)

    h.pushFrames(approvalFrame(1, 'req-old', { expiresAt: new Date(Date.now() - 60_000).toISOString() }))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') !== null)

    // 过期卡：无批准/拒绝（TTL 已过服务端必拒），有跳过。
    expect(document.querySelector('[data-testid="approval-approve"]')).toBeNull()
    expect(document.querySelector('[data-testid="approval-reject"]')).toBeNull()
    const skip = document.querySelector('[data-testid="composer-approval-skip"]') as HTMLButtonElement
    expect(skip).not.toBeNull()

    skip.click()
    // 跳过=本地清卡（不入审批账）：无 answer 调用、栈清空、帧真源保留（转录仍显请求卡）。
    expect(h.answerCalls).toEqual([])
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') === null)
    expect(getPendingApprovals()).toEqual([])
    expect(document.querySelector('[data-testid="agent-composer"]')).not.toBeNull()
    // 帧真源未动：转录流仍有该 approval-request 帧（pending 恢复可见的操作面）。
    expect(document.querySelectorAll('[data-testid="approval-card"]').length).toBe(1)
    await waitUntil(() => document.querySelector('[data-testid="approval-approve"]') !== null)
  })

  it('⑤running 未过期卡无跳过位（跳过只属过期卡）', async () => {
    const h = harness()
    await mountStream(h.api)

    h.pushFrames(approvalFrame(1, 'req-live'))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') !== null)
    expect(document.querySelector('[data-testid="composer-approval-skip"]')).toBeNull()
    expect(document.querySelector('[data-testid="approval-approve"]')).not.toBeNull()
  })

  it('⑥[w19-critic P1] 审批态卡高约束+转录保底：卡 max-h+栈内滚+转录区 140px 底线', async () => {
    const h = harness()
    await mountStream(h.api)

    h.pushFrames(approvalFrame(1, 'req-1'))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') !== null)

    // 卡高上限在场（60dvh 与 100dvh-预留 较小者——390px 移动端不再整卡 405px 压扁转录）。
    const card = document.querySelector('[data-testid="composer-dropzone"]') as HTMLElement
    expect(card.className).toContain('max-h-[min(60dvh,calc(100dvh-260px))]')
    expect(card.classList.contains('flex-col')).toBe(true)
    // 栈体=可收缩滚动区（超高内滚，工具行不被压缩）。
    const stack = document.querySelector('[data-testid="composer-approval-stack"]') as HTMLElement
    expect(stack.classList.contains('overflow-y-auto')).toBe(true)
    const toolRow = card.querySelector('.mt-1.flex') as HTMLElement | null
    expect(toolRow?.classList.contains('shrink-0')).toBe(true)
    // 转录区 140px 可读底线（此前 min-h-0——flex 收缩下被压成 24px 缝）。
    const transcript = document.querySelector('[aria-label^="对话转录区"]') as HTMLElement
    expect(transcript.className).toContain('min-h-[140px]')
    // footer 不被 flex 压缩（卡高约束归卡自身承担）。
    const footer = card.closest('footer') as HTMLElement | null
    expect(footer?.classList.contains('shrink-0')).toBe(true)
  })

  it('⑦[w19-critic P2] strategy.design 决策点卡人话形态：zStack 走 StrategyProposalCard（方案摘要+详情折叠）', async () => {
    const h = harness()
    bindStrategyArtifactsProvider(new MockStrategyArtifacts())
    await mountStream(h.api)

    h.pushFrames(
      strategyArtifactFrame('object-tree.json', STRATEGY_FIXTURE_BLOB_REFS.treeJson),
      strategyArtifactFrame('strategy-plan.json', STRATEGY_FIXTURE_BLOB_REFS.planJson),
      strategyArtifactFrame('strategy-gems.json', STRATEGY_FIXTURE_BLOB_REFS.gemsJson),
      approvalFrame(4, 'req-plan', { tool: 'studio.strategy.design' }),
    )
    const stackCard = '[data-testid="composer-approval-stack"] [data-testid="strategy-proposal-card"]'
    await waitUntil(() => document.querySelector(stackCard) !== null)
    // 工件装配异步（card 自举 $effect→provider.load）——等人话计数摘要落定。
    await waitUntil(() =>
      document
        .querySelector('[data-testid="composer-approval-stack"] [data-testid="strategy-proposal-summary"]')
        ?.textContent?.includes('处指派') === true,
    )

    // 栈内=StrategyProposalCard（非 ApprovalCard 术语文本直出）。
    expect(document.querySelector('[data-testid="composer-approval-stack"] [data-testid="approval-card"]')).toBeNull()
    // 人话摘要头（计数派生自指派行——Mock 工件装配后）。
    const summary = document.querySelector('[data-testid="composer-approval-stack"] [data-testid="strategy-proposal-summary"]')
    expect(summary?.textContent).toContain('处指派')
    expect(summary?.textContent).toContain('候选钻')
    // 管线细节（LLM 术语文本/指派表）默认折叠——正文不见术语。
    expect(document.querySelector('[data-testid="composer-approval-stack"] [data-testid="strategy-proposal-details"]')).toBeNull()
    const toggle = document.querySelector('[data-testid="composer-approval-stack"] [data-testid="strategy-proposal-details-toggle"]') as HTMLButtonElement
    toggle.click()
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"] [data-testid="strategy-proposal-row"]') !== null)
    // inline 全宽形态 + 批准/拒绝在场（zStack 当前卡动作面）。
    const cardEl = document.querySelector(stackCard) as HTMLElement
    expect(cardEl.classList.contains('w-full')).toBe(true)
    expect(document.querySelector('[data-testid="strategy-proposal-approve"]')).not.toBeNull()
  })

  it('⑧[w19-critic P2] 过期卡跳过跨 openSession 重开不复活（会话键持久化）', async () => {
    const h = harness()
    await mountStream(h.api)

    h.pushFrames(approvalFrame(1, 'req-old', { expiresAt: new Date(Date.now() - 60_000).toISOString() }))
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') !== null)
    ;(document.querySelector('[data-testid="composer-approval-skip"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-approval-stack"]') === null)
    expect(getPendingApprovals()).toEqual([])
    // 跳过集落 sessionStorage（页面层持久化——组件重挂/重订阅不丢）。
    expect(sessionStorage.getItem('rhinestone-studio.skipped-approvals.v1')).toContain('req-old')

    // 重开同会话（重挂/路由往返等价——replay 回放含该过期审批帧）：栈不得复活。
    await openSession('s-stack')
    await flush()
    expect(getPendingApprovals()).toEqual([])
    expect(document.querySelector('[data-testid="composer-approval-stack"]')).toBeNull()
  })
})
