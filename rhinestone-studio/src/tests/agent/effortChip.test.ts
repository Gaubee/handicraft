/*
 * [product-polish-w2 T2 补抄 zhumo 强度 chip] 任务级模型/强度覆盖测试（Owner
 * Wave 1 验收「Effect=思考强度配置 chip——zhumo 有这个我们抄漏了」）。
 * 覆盖：①chip 渲染（默认档标注「（默认）」——zhumo 语义 null=跟随默认）；
 * ②选档覆盖（effort-only：模型身份跟随后台默认+effort 覆盖随 followup 透传）；
 * ③「跟随默认」回位（effort=null → followup 不带 model 键——线上形状零漂移）；
 * ④模型 chip 覆盖（provider/model+effort 成对透传；切模型清悬空档）。
 * 数据面（models.available 的 efforts/default.effort）经 vi.mock('$lib/modelsApi')
 * 注入；followup 透传断言走 stub api 调用记录（rpc.ts 载荷形状与契约对齐——
 * 契约测试见 contracts session.test.ts「session.followup model」）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import {
  bindAgentApi,
  getAgentEffortOverride,
  getAgentModelOverride,
  initAgentStore,
  resetAgentStoreForTests,
  setAgentDefaultModel,
} from '$lib/agentApi/store.svelte'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import type { AgentApi, AgentConnectionState, AgentTaskView } from '$lib/agentApi/types'
import type { SessionSummary } from '@handicraft/contracts'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// 可用模型目录（zcode 转录形态：efforts=[low,medium,high]——默认档算法取 ceil(3/2)=2
// 即 medium；default.effort 未配置走算法档）。
const MODELS = [
  { provider: 'zai', model: 'glm-5.3', name: 'GLM 5.3', contextWindow: 131072, efforts: ['low', 'medium', 'high'] },
  { provider: 'zai', model: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 131072, efforts: ['low', 'medium', 'high'] },
]
const DEFAULT_MODEL = { provider: 'zai', model: 'glm-5.3-flash' }

vi.mock('$lib/modelsApi', () => ({
  modelsApi: () => ({
    getAvailableModels: async () => ({ models: MODELS, default: DEFAULT_MODEL }),
  }),
}))

interface FollowupCall {
  sessionId: string
  text: string
  model?: { provider: string; model: string; effort?: string }
}

function stubApi(): { api: AgentApi; followupCalls: FollowupCall[] } {
  const iso = new Date().toISOString()
  const session: SessionSummary = { id: 's-effort', title: '强度 chip 会话', status: 'active', createdAt: iso, updatedAt: iso }
  const tasks: AgentTaskView[] = []
  const followupCalls: FollowupCall[] = []
  let connectionState: AgentConnectionState = 'open'
  const connectionListeners = new Set<(state: AgentConnectionState) => void>()
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
    followup: async (
      sessionId: string,
      text: string,
      _mode?: 'followup' | 'steer',
      _attachments?: string[],
      _sourceSetId?: string,
      _autoApprove?: boolean,
      model?: { provider: string; model: string; effort?: string },
    ) => {
      followupCalls.push({ sessionId, text, ...(model !== undefined ? { model } : {}) })
      return { taskId: `t-${followupCalls.length}` }
    },
    replay: async () => ({ frames: [], nextSeq: 0 }),
    subscribeTask: () => () => {},
    sessionResult: async () => {
      throw new Error('无结果')
    },
    clear: async () => ({ ok: true, status: 'cleared' as const }),
    cancel: async () => ({ ok: true }),
    answer: async () => ({ ok: true }),
    stopTask: async () => {},
    taskResult: async () => ({ found: false }),
    taskArtifact: async () => {
      throw new Error('本测试不触达')
    },
  } as unknown as AgentApi
  return { api, followupCalls }
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

/** 打字+点发送（idle 首条——常规 followup 路径）。 */
async function typeAndSend(text: string): Promise<void> {
  const input = document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  ;(document.querySelector('[data-testid="agent-send"]') as HTMLButtonElement).click()
  await flush()
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

describe('T2 强度 chip（补抄 zhumo）：任务级覆盖+followup 透传', () => {
  it('①chip 渲染：默认档算法值标注「（默认）」（null=跟随默认——zhumo 语义）', async () => {
    const { api } = stubApi()
    await mountStream(api)
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-chip"]') !== null)

    const chip = document.querySelector('[data-testid="composer-effort-chip"]') as HTMLElement
    // 默认模型 glm-5.3-flash 的算法档=high（ceil(3/2)=下标 2 即第三档）；未覆盖=无前缀圆点。
    expect(chip.textContent).toContain('high（默认）')
    expect(chip.querySelector('span.rounded-full')).toBeNull()
    expect(getAgentEffortOverride()).toBeNull()
  })

  it('②选档覆盖：effort-only 覆盖随 followup 透传（模型身份跟随后台默认）', async () => {
    const { api, followupCalls } = stubApi()
    await mountStream(api)
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-chip"]') !== null)

    ;(document.querySelector('[data-testid="composer-effort-chip"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-option"]') !== null)
    const high = [...document.querySelectorAll('[data-testid="composer-effort-option"]')].find(
      (el) => el.textContent?.trim() === 'high',
    ) as HTMLButtonElement
    high.click()
    await flush()

    // chip 呈现覆盖态（前缀圆点+裸档名）；store 覆盖就位。
    const chip = document.querySelector('[data-testid="composer-effort-chip"]') as HTMLElement
    await waitUntil(() => chip.textContent?.trim() === 'high')
    expect(chip.querySelector('span.rounded-full')).not.toBeNull()
    expect(getAgentEffortOverride()).toBe('high')

    // 发送：followup 载荷 model={后台默认身份, effort:'high'}（effort-only 覆盖
    // 的模型身份源=sessionDefaultModel 回填）。
    await typeAndSend('开始排钻')
    expect(followupCalls.length).toBe(1)
    expect(followupCalls[0]!.model).toEqual({ provider: 'zai', model: 'glm-5.3-flash', effort: 'high' })
  })

  it('③跟随默认回位：effort=null → followup 不带 model 键（线上形状零漂移）', async () => {
    const { api, followupCalls } = stubApi()
    await mountStream(api)
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-chip"]') !== null)

    // 先覆盖再回位。
    ;(document.querySelector('[data-testid="composer-effort-chip"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-option"]') !== null)
    ;([...document.querySelectorAll('[data-testid="composer-effort-option"]')].find(
      (el) => el.textContent?.trim() === 'low',
    ) as HTMLButtonElement).click()
    await flush()
    expect(getAgentEffortOverride()).toBe('low')

    ;(document.querySelector('[data-testid="composer-effort-chip"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-default"]') !== null)
    ;(document.querySelector('[data-testid="composer-effort-default"]') as HTMLButtonElement).click()
    await flush()
    expect(getAgentEffortOverride()).toBeNull()

    await typeAndSend('开始排钻')
    expect(followupCalls[0]!.model).toBeUndefined()
  })

  it('④模型 chip 覆盖：provider/model+effort 成对透传；切模型清悬空档', async () => {
    const { api, followupCalls } = stubApi()
    await mountStream(api)
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-chip"]') !== null)

    // 先选强度 high（骑在默认模型上），再切模型 glm-5.3——悬空档清（回「跟随默认」）。
    ;(document.querySelector('[data-testid="composer-effort-chip"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-option"]') !== null)
    ;([...document.querySelectorAll('[data-testid="composer-effort-option"]')].find(
      (el) => el.textContent?.trim() === 'high',
    ) as HTMLButtonElement).click()
    await flush()
    expect(getAgentEffortOverride()).toBe('high')

    ;(document.querySelector('[data-testid="composer-model-chip"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-model-option"]') !== null)
    const glm = [...document.querySelectorAll('[data-testid="composer-model-option"]')].find((el) =>
      el.textContent?.includes('GLM 5.3'),
    ) as HTMLButtonElement
    // 目录序：GLM 5.3 在前（glm-5.3）、Flash 在后——取非 flash 的第一个。
    const target = glm ?? ([...document.querySelectorAll('[data-testid="composer-model-option"]')][0] as HTMLButtonElement)
    target.click()
    await flush()
    expect(getAgentModelOverride()).toEqual({ provider: 'zai', model: 'glm-5.3' })
    expect(getAgentEffortOverride()).toBeNull()

    // 再补 effort: high（此时骑在覆盖模型上）→ 成对透传。
    ;(document.querySelector('[data-testid="composer-effort-chip"]') as HTMLButtonElement).click()
    await waitUntil(() => document.querySelector('[data-testid="composer-effort-option"]') !== null)
    ;([...document.querySelectorAll('[data-testid="composer-effort-option"]')].find(
      (el) => el.textContent?.trim() === 'high',
    ) as HTMLButtonElement).click()
    await flush()

    await typeAndSend('开始排钻')
    expect(followupCalls[0]!.model).toEqual({ provider: 'zai', model: 'glm-5.3', effort: 'high' })
    // 模型 chip 标签=覆盖模型名（无「（默认）」后缀）。
    const modelChip = document.querySelector('[data-testid="composer-model-chip"]') as HTMLElement
    expect(modelChip.textContent).toContain('glm-5.3')
    expect(modelChip.textContent).not.toContain('（默认）')
  })
})
