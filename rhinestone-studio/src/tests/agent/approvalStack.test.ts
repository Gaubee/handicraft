/*
 * [product-polish-w2 T3] 审批卡入 InputGroup（zStack）jsdom 测试（Owner Wave 1
 * 验收指令「收到审批任务的时候，InputGroup 内的 textarea 会被替换成审批卡」）。
 * 覆盖：①栈替换（textarea 退场+计数+切卡箭头态+发送禁用）；②批准链（answer→
 * resolved 帧→自动切下一张→全部处理完恢复 textarea 且草稿保留）；③多卡层叠
 * （帧序逐个处理+后卡露出条+键盘 ←/→ 切卡）；④过期卡（操作区变「跳过」=本地
 * 清卡不入审批账——answer 不被调）；⑤转录抑制（栈在场时转录流审批卡无操作面，
 * 栈清空即恢复）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import {
  bindAgentApi,
  getPendingApprovals,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
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
    replay: async () => ({ frames: [], nextSeq: 0 }),
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
})
