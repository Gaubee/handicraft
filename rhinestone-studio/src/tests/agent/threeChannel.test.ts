/*
 * [add-agent-three-channel 2.5] 三通道前端 jsdom 测试（mock 通道驱动）。
 * 覆盖：①停止按钮态机（running 空输入=停止位→点击 done 收口→发送位回归+可续聊）；
 * ②排队通道（running Enter=入队不投递+反馈条+队列面板读/逐条删除/清空）；
 * ③自动开跑（当前轮 done——自然收口与打断收口两路——队头自动以新 followup 开跑）；
 * ④引导通道（Zap=steer 同任务投递不新开行+反馈条）；⑤暂离编辑（回填/确认原序放回/
 * Esc 取消/有草稿拒绝进入）；⑥demoDelay 走查开关（query 解析+sessionStorage 节奏注入）；
 * ⑦会话代数守卫（Codex W10 P1-1——延迟 API 中途切会话：迟到响应不污染新会话）。
 * 语义对齐 shufa b6cec8a（W10a/b）+ eb125a1（W10c）+ a3ac820（W10e demoDelay）；
 * 贴钻差异：队列=前端持有外环（无 inbox RPC），打断收口=done 帧（无 status 帧）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import App from '../../App.svelte'
import { resetDevFlagForTests } from '$lib/stores/devFlag.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetOpenIntentForTests } from '$lib/stores/openIntent.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  DEMO_DELAY_KEY,
  parseDemoDelayQuery,
} from '$lib/agentApi/demoDelay.svelte'
import {
  answerApproval,
  bindAgentApi,
  getActiveSessionFrames,
  getActiveSessionId,
  getActiveTask,
  getActiveTasks,
  getAgentQueue,
  getAgentSessions,
  getPendingApproval,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
  sendFollowup,
} from '$lib/agentApi/store.svelte'

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
// jsdom 未实现 Web Animations API（QueuePanel 手风琴 slide 过渡）——最小桩：
// 返回立即完成的动画（onfinish 回调/cancel/finished），产品侧动画不受影响。
if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function (this: Element): Animation {
    const animation = {
      onfinish: null as null | (() => void),
      cancel: () => {},
      finished: Promise.resolve(),
    }
    queueMicrotask(() => animation.onfinish?.())
    return animation as unknown as Animation
  }
}

const mountedDisposers: Array<() => void> = []

function mountApp(): () => void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(App, { target })
  const dispose = () => {
    unmount(app)
    target.remove()
  }
  mountedDisposers.push(dispose)
  return dispose
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

/** 可见 composer（默认无旗标=Agent 主面单实例）。 */
function composer(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="agent-composer"]') as HTMLTextAreaElement
}

async function typeAndSubmit(text: string, key = 'agent-send'): Promise<void> {
  const input = composer()
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  const button = document.querySelector(`[data-testid="${key}"]`) as HTMLButtonElement
  button.click()
  await flush()
}

/** Enter 键发送（排队通道的走查路径）。 */
async function typeAndEnter(text: string): Promise<void> {
  const input = composer()
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await flush()
}

/** 发送并推进到审批门挂起（mock 脚本在 approval-request 处等待——running 可驻留）。 */
async function startRunningTask(prompt: string): Promise<void> {
  await typeAndSubmit(prompt)
  await waitUntil(() => document.querySelector('[data-testid="approval-card"]') !== null)
}

function queueItems(): HTMLElement[] {
  return [...document.querySelectorAll('[data-testid="agent-queue-item"]')] as HTMLElement[]
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetDevFlagForTests(false)
  resetViewForTests()
  resetAgentStoreForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  resetToastsForTests()
  resetOpenIntentForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// ① 打断通道：停止按钮态机
// ---------------------------------------------------------------------------

describe('三通道·打断：running 空输入=停止位，点击→done 收口可续聊', () => {
  it('发送位退场/停止位出现；停止后任务 done、发送位回归，同会话可续聊开新任务', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)

    await startRunningTask('把红色区域改密一点')
    // running + 空输入 → 停止位（发送/引导退场）。
    expect(document.querySelector('[data-testid="agent-stop"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-send"]')).toBeNull()
    expect(document.querySelector('[data-testid="agent-steer"]')).toBeNull()

    ;(document.querySelector('[data-testid="agent-stop"]') as HTMLButtonElement).click()
    await waitUntil(() => getActiveTask()?.status === 'done')
    await flush()
    // done（打断收口——无 status 帧，done 帧收口）→ 发送位回归、停止位退场。
    expect(document.querySelector('[data-testid="agent-send"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-stop"]')).toBeNull()

    // 可续聊（贴钻语义）：同会话再发 → 新任务开跑（审批卡再现）。
    const afterFirst = getActiveTasks().length
    await startRunningTask('续聊：再排一次')
    expect(getActiveTask()?.status).toBe('running')
    expect(getActiveTasks().length).toBe(afterFirst + 1)
    dispose()
  })

  it('停止不产生 error；新任务帧流正常（打断≠终态取消）', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮长任务')
    ;(document.querySelector('[data-testid="agent-stop"]') as HTMLButtonElement).click()
    await waitUntil(() => getActiveTask()?.status === 'done')
    // 停止收口帧=done（无 error 帧）。
    const kinds = getActiveSessionFrames().map((frame) => frame.kind)
    expect(kinds[kinds.length - 1]).toBe('done')
    expect(kinds).not.toContain('error')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// ② 排队通道：反馈条 + 队列面板（读/删/清空）
// ---------------------------------------------------------------------------

describe('三通道·排队：running Enter=入队（不投递）+即时反馈条', () => {
  it('Enter 入队→反馈条+面板预览出现；消息未投递（任务数不变）', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    const before = getActiveTasks().length

    await typeAndEnter('第二问：换个颜色')
    expect(document.querySelector('[data-testid="agent-channel-notice"]')?.textContent).toContain('已排队')
    expect(document.querySelector('[data-testid="agent-queue-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-queue-preview"]')?.textContent).toContain('第二问：换个颜色')
    // 入队不投递：不新开任务、composer 清空。
    expect(getActiveTasks().length).toBe(before)
    expect(composer().value).toBe('')
    // 队列 store 真源同步。
    expect(getAgentQueue().map((item) => item.text)).toEqual(['第二问：换个颜色'])
    dispose()
  })

  it('面板展开读列表+逐条删除+清空（面板随空队列隐藏）', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    await typeAndEnter('排队甲')
    await typeAndEnter('排队乙')

    ;(document.querySelector('[data-testid="agent-queue-toggle"]') as HTMLButtonElement).click()
    await flush()
    expect(queueItems()).toHaveLength(2)
    expect(queueItems()[0]?.textContent).toContain('排队甲')

    // 逐条删除队尾「排队乙」。
    queueItems()[1]!.querySelector<HTMLButtonElement>('[data-testid="agent-queue-remove"]')!.click()
    await flush()
    expect(queueItems()).toHaveLength(1)
    expect(queueItems()[0]?.textContent).toContain('排队甲')

    // 清空 → 面板隐藏。
    ;(document.querySelector('[data-testid="agent-queue-clear"]') as HTMLButtonElement).click()
    await flush()
    expect(document.querySelector('[data-testid="agent-queue-panel"]')).toBeNull()
    expect(getAgentQueue()).toHaveLength(0)
    dispose()
  })

  it('「立刻发送」为后端待补占位：呈现且禁用（不做旁路）', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    await typeAndEnter('排队甲')
    ;(document.querySelector('[data-testid="agent-queue-toggle"]') as HTMLButtonElement).click()
    await flush()
    const sendNow = document.querySelector<HTMLButtonElement>('[data-testid="agent-queue-sendnow"]')
    expect(sendNow).not.toBeNull()
    expect(sendNow!.disabled).toBe(true)
    expect(sendNow!.title).toContain('后端待补')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// ③ 自动开跑：当前轮结束（自然 done / 打断 done）→ 队头自动开跑
// ---------------------------------------------------------------------------

describe('三通道·自动开跑：当前轮结束后队头自动开跑', () => {
  it('审批通过（自然 done）→ 队头以新 followup 开跑（新任务 user 帧含排队文本）', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    await typeAndEnter('第二轮：排蓝色钻')

    ;(document.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement).click()
    await waitUntil(() => getActiveTasks().length === 2)
    // 新任务开跑：排队文本成为新任务首帧（user transcript）。
    await waitUntil(() =>
      getActiveSessionFrames().some(
        (frame) => frame.kind === 'transcript' && frame.payload.role === 'user' && frame.payload.text === '第二轮：排蓝色钻',
      ),
    )
    expect(getActiveTask()?.status).toBe('running')
    expect(getAgentQueue()).toHaveLength(0)
    dispose()
  })

  it('停止打断（done 收口）→ 队头同样自动开跑（keepInbox 等价形态）', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    await typeAndEnter('被打断后该跑')

    ;(document.querySelector('[data-testid="agent-stop"]') as HTMLButtonElement).click()
    await waitUntil(() => getActiveTasks().length === 2)
    await waitUntil(() =>
      getActiveSessionFrames().some((frame) => frame.kind === 'transcript' && frame.payload.text === '被打断后该跑'),
    )
    expect(getActiveTask()?.status).toBe('running')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// ④ 引导通道：Zap=steer 同任务投递
// ---------------------------------------------------------------------------

describe('三通道·引导：Zap 按钮=steer 立即投递当前任务', () => {
  it('running 有输入=引导位出现；点击→同任务投递（不新开行）+反馈条+草稿清空', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('开始排钻')
    const before = getActiveTasks().length

    const input = composer()
    input.value = '往红色偏一点'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    // running+有输入 → 引导位与排队发送位并存、停止位退场。
    expect(document.querySelector('[data-testid="agent-steer"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-send"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-stop"]')).toBeNull()

    ;(document.querySelector('[data-testid="agent-steer"]') as HTMLButtonElement).click()
    await waitUntil(() =>
      getActiveSessionFrames().some((frame) => frame.kind === 'transcript' && frame.payload.text.includes('收到引导：往红色偏一点')),
    )
    await waitUntil(() => document.querySelector('[data-testid="agent-channel-notice"]') !== null)
    expect(document.querySelector('[data-testid="agent-channel-notice"]')?.textContent).toContain('已引导')
    // steer 同任务投递（同 taskId 返回）——不新开任务行。
    expect(getActiveTasks().length).toBe(before)
    expect(composer().value).toBe('')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// ⑤ 暂离编辑：回填 / 确认原序放回 / Esc 取消 / 有草稿拒绝
// ---------------------------------------------------------------------------

describe('队列面板·暂离编辑（W10b 前端形态）', () => {
  it('编辑回填 composer；确认后该条原位更新（原序不变）', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    await typeAndEnter('排队甲')
    await typeAndEnter('排队乙')
    ;(document.querySelector('[data-testid="agent-queue-toggle"]') as HTMLButtonElement).click()
    await flush()

    // 编辑第二条：文本回填、发送位变确认修改。
    queueItems()[1]!.querySelector<HTMLButtonElement>('[data-testid="agent-queue-edit"]')!.click()
    await flush()
    expect(composer().value).toBe('排队乙')
    expect(document.querySelector('[data-testid="agent-edit-confirm"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="agent-send"]')).toBeNull()

    // 改文确认：原位更新（序不变）。
    const input = composer()
    input.value = '排队乙·改'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(getAgentQueue().map((item) => item.text)).toEqual(['排队甲', '排队乙·改'])
    expect(queueItems()[1]?.textContent).toContain('排队乙·改')
    // 编辑态退出：当前任务仍运行（审批门挂起）→ 回到停止位（发送位继续退场）。
    expect(document.querySelector('[data-testid="agent-edit-confirm"]')).toBeNull()
    expect(document.querySelector('[data-testid="agent-stop"]')).not.toBeNull()
    dispose()
  })

  it('Esc 取消：队列按原样保留、composer 清空；输入框有草稿时拒绝进入编辑', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    await typeAndEnter('排队甲')
    ;(document.querySelector('[data-testid="agent-queue-toggle"]') as HTMLButtonElement).click()
    await flush()

    // 有草稿 → 拒绝进入（Owner 设计）。
    const input = composer()
    input.value = '未发送草稿'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    queueItems()[0]!.querySelector<HTMLButtonElement>('[data-testid="agent-queue-edit"]')!.click()
    await flush()
    expect(document.querySelector('[data-testid="agent-edit-confirm"]')).toBeNull()
    expect(document.body.textContent).toContain('输入框有未发送内容')

    // 清草稿后进入编辑 → Esc 取消：原样保留。
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    queueItems()[0]!.querySelector<HTMLButtonElement>('[data-testid="agent-queue-edit"]')!.click()
    await flush()
    expect(composer().value).toBe('排队甲')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(getAgentQueue().map((item) => item.text)).toEqual(['排队甲'])
    expect(composer().value).toBe('')
    // 取消后仍运行中 → 编辑位退场、停止位保持。
    expect(document.querySelector('[data-testid="agent-edit-confirm"]')).toBeNull()
    expect(document.querySelector('[data-testid="agent-stop"]')).not.toBeNull()
    dispose()
  })

  it('编辑期间当前轮结束：自动开跑暂停，确认后恢复', async () => {
    const dispose = mountApp()
    await waitUntil(() => getAgentSessions().length > 0)
    await startRunningTask('第一轮')
    await typeAndEnter('编辑中不许跑')
    ;(document.querySelector('[data-testid="agent-queue-toggle"]') as HTMLButtonElement).click()
    await flush()
    queueItems()[0]!.querySelector<HTMLButtonElement>('[data-testid="agent-queue-edit"]')!.click()
    await flush()
    expect(document.querySelector('[data-testid="agent-queue-panel"]')?.textContent).toContain('编辑中')

    // 当前轮自然结束（批准）：编辑冻结 → 不自动开跑（任务数不增）。
    const beforeApprove = getActiveTasks().length
    ;(document.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement).click()
    await waitUntil(() => getActiveTask()?.status === 'done')
    await flush(80)
    expect(getActiveTasks().length).toBe(beforeApprove)
    expect(getAgentQueue().map((item) => item.text)).toEqual(['编辑中不许跑'])

    // 确认编辑 → 冻结解除 → 队头自动开跑。
    const input = composer()
    input.value = '确认后放行'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await waitUntil(() => getActiveTasks().length === beforeApprove + 1)
    await waitUntil(() =>
      getActiveSessionFrames().some((frame) => frame.kind === 'transcript' && frame.payload.text === '确认后放行'),
    )
    dispose()
  })
})

// ---------------------------------------------------------------------------
// ⑥ demoDelay 走查开关（2.4）
// ---------------------------------------------------------------------------

describe('demoDelay 走查开关', () => {
  it('parseDemoDelayQuery：正数合法/非正数与非数字拒绝/缺省 null', () => {
    expect(parseDemoDelayQuery('?demoDelay=800')).toBe(800)
    expect(parseDemoDelayQuery('?demoDelay=2500&x=1')).toBe(2500)
    expect(parseDemoDelayQuery('?demoDelay=0')).toBeNull()
    expect(parseDemoDelayQuery('?demoDelay=-5')).toBeNull()
    expect(parseDemoDelayQuery('?demoDelay=abc')).toBeNull()
    expect(parseDemoDelayQuery('')).toBeNull()
    expect(parseDemoDelayQuery('?other=1')).toBeNull()
  })

  it('sessionStorage 激活 → MockAgentApi 帧流按注入节奏发射（可运行中退出）', async () => {
    sessionStorage.setItem(DEMO_DELAY_KEY, '120')
    const api = new MockAgentApi()
    expect((await api.listSessions()).sessions.length).toBeGreaterThan(0)

    const created = await api.createSession({ title: '演示节奏' })
    const { taskId } = await api.followup(created.sessionId, '慢慢出帧')
    const startedAt = Date.now()
    let firstFrameAt = 0
    api.subscribeTask(taskId, 0, () => {
      if (firstFrameAt === 0) firstFrameAt = Date.now()
    })
    // 节奏 120ms：首帧不早于 ~110ms（容差——setTimeout 不早于设定值）。
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(firstFrameAt).toBeGreaterThanOrEqual(startedAt + 110)

    // 退出演示：setDemoDelay(0) 后续帧即时（speed 默认 1，脚本首帧 delayMs=0）。
    api.setDemoDelay(0)
    const second = await api.followup(created.sessionId, '退出后即时')
    let secondFirst = 0
    const t0 = Date.now()
    api.subscribeTask(second.taskId, 0, () => {
      if (secondFirst === 0) secondFirst = Date.now()
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(secondFirst).toBeGreaterThan(0)
    expect(secondFirst - t0).toBeLessThan(40)
  })
})

// ---------------------------------------------------------------------------
// ⑦ 会话代数守卫（[Codex W10 P1-1]）：延迟 API + 中途切会话——旧会话的迟到响应
//    不得污染新会话视图（任务/帧/队列）。
// ---------------------------------------------------------------------------

/** followup 门闩桩：followup 挂起至显式放行（成功或失败）——模拟慢 RPC。 */
class GatedFollowupApi extends MockAgentApi {
  private pending: Array<{ run: () => void; fail: () => void }> = []

  pendingCount(): number {
    return this.pending.length
  }

  override followup(
    sessionId: string,
    text: string,
    mode?: 'followup' | 'steer',
  ): Promise<{ taskId: string }> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        run: () => {
          void super.followup(sessionId, text, mode).then(resolve, reject)
        },
        fail: () => reject(new Error('投递失败（门闩注入）')),
      })
    })
  }

  releaseAll(): void {
    for (const gate of this.pending.splice(0)) gate.run()
  }

  failAll(): void {
    for (const gate of this.pending.splice(0)) gate.fail()
  }
}

describe('会话代数守卫：中途切会话的迟到响应不污染新会话（P1-1）', () => {
  it('followup 迟到响应：任务/帧不写入切换后的会话（切回原会话可见）', async () => {
    const api = new GatedFollowupApi({ speed: 0 })
    const a = await api.createSession({ title: '会话 A' })
    const b = await api.createSession({ title: '会话 B' })
    await initAgentStore(api) // 最新会话（B）自动打开
    await openSession(a.sessionId) // A 成为活跃（idle、无任务）
    expect(getActiveTasks()).toHaveLength(0)

    // 慢 followup 在途 → 中途切到 B → 放行：A 的任务不得出现在 B 的视图。
    const inFlight = sendFollowup('A 的消息')
    await waitUntil(() => api.pendingCount() === 1)
    await openSession(b.sessionId)
    api.releaseAll()
    await inFlight
    await flush()
    expect(getActiveSessionId()).toBe(b.sessionId)
    expect(getActiveTasks()).toHaveLength(0)
    expect(getActiveSessionFrames()).toHaveLength(0)

    // 迟到响应只是不写入新视图，不丢任务：切回 A → followup 任务在册。
    await openSession(a.sessionId)
    expect(getActiveTasks().some((task) => task.status === 'running')).toBe(true)
    expect(getActiveSessionFrames().some((frame) => frame.kind === 'transcript')).toBe(true)
  })

  it('队列开跑失败回填：中途切会话后失败条目不进新会话的队列', async () => {
    const api = new GatedFollowupApi({ speed: 0 })
    const a = await api.createSession({ title: '会话 A' })
    const b = await api.createSession({ title: '会话 B' })
    await initAgentStore(api)
    await openSession(a.sessionId)

    // 第一轮（放行 → running 挂在审批门）→ 排队一条 → 批准收口 → 队头开跑在途。
    const first = sendFollowup('第一轮')
    await waitUntil(() => api.pendingCount() === 1)
    api.releaseAll()
    await first
    await waitUntil(() => getPendingApproval() !== null)
    await sendFollowup('排队甲') // running → 入队不投递
    expect(getAgentQueue().map((item) => item.text)).toEqual(['排队甲'])
    const approval = getPendingApproval()
    expect(approval).not.toBeNull()
    await answerApproval(approval!.requestId, true) // 自然 done → 队头自动开跑（门闩在途）
    await waitUntil(() => api.pendingCount() === 1 && getAgentQueue().length === 0)

    // 中途切到 B → 开跑失败：失败条目不回填进 B 的队列（代数守卫）。
    await openSession(b.sessionId)
    api.failAll()
    await flush()
    expect(getActiveSessionId()).toBe(b.sessionId)
    expect(getAgentQueue()).toHaveLength(0)
  })
})
