/*
 * [task-detail-activity 2026-10-02] 任务详情「活动」tab 测试（Owner 需求「任务详情=
 * 整个任务会话的投影——图像处理过程可视化」）。
 * 覆盖：
 * - 纯投影（agentApi/activity.svelte）：running+终态按 activityId 配对合并（首见
 *   位置=时间线序、终态覆写不移动行位）；未配对 running=进行中；终态无 running
 *   前帧（回放截断）按序自成一行；耗时人话化三档；在途计数与投影同源。
 * - 转录流不重复渲染：projectFrames 对 activity 帧显式跳过（模型视角归 transcript
 *   role:'tool' 帧——契约「并存不互替」）。
 * - UI（TaskDetailPanel 活动固定第二 tab——详情之后、工作台之前）：
 *   badge=未配对 running 数；行渲染（label/耗时/状态 data-status）；展开明细
 *   （输入/产出/失败简述）+产出图缩略→Lightbox 大图；空态「暂无活动记录」；
 *   实时性（subscribeTask 到达新帧即更新——同一游标流不另开通道）。
 * - mock 纪律：MockAgentApi clown fixture（活动帧演示时间线——组件走与 rpc 同一条
 *   帧→投影路径，无 mock 分支）。
 * 组件面走 stub AgentApi（taskDetailTabs.test 同式）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import type { Frame } from '@handicraft/contracts'
import TaskDetailPanel from '$lib/components/agent/TaskDetailPanel.svelte'
import {
  activityRunningCount,
  formatActivityDuration,
  projectActivity,
} from '$lib/agentApi/activity.svelte'
import { projectFrames } from '$lib/agentApi/transcript.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  bindAgentApi,
  getActiveTask,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetGemSummaryForTests } from '$lib/agentApi/gemSummary.svelte'
import { resetMyTasksForTests } from '$lib/myMaterials/tasks.svelte'

// jsdom 未实现 scrollIntoView——桩掉（既有 agent 测试同式）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const SESSION = 'sess-act-1'
const TASK = 'task-act-1'
const TS = Date.parse('2026-10-02T08:00:00.000Z')
/** BlobRef 形态（64 位十六进制——schema 把守；fixtures ref() 同式确定性生成）。 */
const REF_A = 'a'.repeat(64)

/** activity 帧速造（payload 字段与契约逐字面一致）。 */
function activityFrame(
  seq: number,
  over: Partial<Extract<Frame, { kind: 'activity' }>['payload']> & { activityId: string; label: string },
): Frame {
  return {
    seq,
    ts: TS + seq * 100,
    kind: 'activity',
    payload: {
      tool: 'studio.subject.segment',
      status: 'ok',
      startedAt: TS + seq * 100,
      ...over,
    },
  }
}

// ---------------------------------------------------------------- 纯投影

describe('projectActivity：配对合并与时间正序', () => {
  it('running+终态同 activityId 配对合并为一行（终态覆写、行位=首见序）', () => {
    const frames = [
      activityFrame(1, { activityId: 'a1', label: '区域分割 · 左手', status: 'running', inputSummary: '左手区域' }),
      activityFrame(2, { activityId: 'a2', label: '区域分割 · 右手', status: 'running' }),
      activityFrame(3, { activityId: 'a1', label: '区域分割 · 左手', status: 'ok', durationMs: 1350, outputSummary: '掩码 1 层 · 覆盖 62%', outputBlobRef: REF_A }),
    ]
    const entries = projectActivity(frames)
    expect(entries.map((entry) => entry.activityId)).toEqual(['a1', 'a2'])
    // a1 终态覆写（status/durationMs/产出摘要/产出图——running 帧的 inputSummary 由终态帧整体覆写携带）。
    expect(entries[0]).toMatchObject({ status: 'ok', durationMs: 1350, outputSummary: '掩码 1 层 · 覆盖 62%', outputBlobRef: REF_A })
    // a2 未配对=进行中。
    expect(entries[1]).toMatchObject({ status: 'running' })
  })

  it('error/cancelled 终态+迟到 running 帧不回退（终态后的重复 running no-op）', () => {
    const frames = [
      activityFrame(1, { activityId: 'e1', label: '策略设计', status: 'running' }),
      activityFrame(2, { activityId: 'e1', label: '策略设计', status: 'error', durationMs: 2100, errorBrief: '引擎校验未过：最小间距 0.8mm' }),
      activityFrame(3, { activityId: 'c1', label: '导出工件', status: 'cancelled' }),
      // daemon 不发（turn 终止在途回收=终态帧直接补）；容忍重复 running 不回退。
      activityFrame(4, { activityId: 'e1', label: '策略设计', status: 'running' }),
    ]
    const entries = projectActivity(frames)
    expect(entries[0]).toMatchObject({ status: 'error', errorBrief: '引擎校验未过：最小间距 0.8mm' })
    expect(entries[1]).toMatchObject({ status: 'cancelled' })
  })

  it('终态帧无 running 前帧（回放窗口截断）＝按序自成一行（宽容不炸）', () => {
    const frames = [activityFrame(1, { activityId: 'orphan', label: '全图语义分析', status: 'ok', durationMs: 400 })]
    expect(projectActivity(frames)).toMatchObject([{ activityId: 'orphan', status: 'ok', durationMs: 400 }])
  })

  it('非 activity 帧零干扰；在途计数=未配对 running（与投影同源）', () => {
    const frames: Frame[] = [
      { seq: 1, ts: TS, kind: 'transcript', payload: { role: 'user', text: '给小丑贴钻' } },
      activityFrame(2, { activityId: 'r1', label: '全图语义分析', status: 'running' }),
      activityFrame(3, { activityId: 'r2', label: '区域分割 · 帽子', status: 'running' }),
      activityFrame(4, { activityId: 'r1', label: '全图语义分析', status: 'ok', durationMs: 1350 }),
    ]
    expect(activityRunningCount(frames)).toBe(1)
    // 全配对=0；无 activity 帧=0（空态口径）。
    expect(activityRunningCount([frames[0]!, frames[2]!, activityFrame(5, { activityId: 'r2', label: '区域分割 · 帽子', status: 'ok' })])).toBe(0)
    expect(activityRunningCount([frames[0]!])).toBe(0)
  })

  it('耗时人话化三档：<1s→ms、<60s→s、else→m+s', () => {
    expect(formatActivityDuration(400)).toBe('400ms')
    expect(formatActivityDuration(999)).toBe('999ms')
    expect(formatActivityDuration(12_000)).toBe('12s')
    expect(formatActivityDuration(59_400)).toBe('59s')
    expect(formatActivityDuration(126_000)).toBe('2m6s')
    expect(formatActivityDuration(120_000)).toBe('2m')
  })

  it('转录流对 activity 帧显式跳过（对话流不重复渲染工具行——并存不互替）', () => {
    const frames: Frame[] = [
      activityFrame(1, { activityId: 'a1', label: '区域分割 · 左手', status: 'ok', durationMs: 1350 }),
      { seq: 2, ts: TS + 200, kind: 'progress', payload: { text: '排钻计算中', ratio: 0.4 } },
    ]
    const items = projectFrames([{ taskId: 't', frames }])
    // 只剩 progress status 行——activity 帧不进转录条目。
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'status', text: '排钻计算中' })
  })
})

// ---------------------------------------------------------------- UI（stub 帧流）

interface StubOptions {
  frames: Frame[]
  status?: 'done' | 'running'
}

function stubApi(options: StubOptions): AgentApi & { __pushFrameForTest: (frame: Frame) => void } {
  const unimplemented = (name: string): never => {
    throw new Error(`stub 未实现：${name}`)
  }
  const summary = {
    id: SESSION,
    title: '活动会话',
    status: 'active' as const,
    createdAt: '2026-10-02T07:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
  }
  const status = options.status ?? 'done'
  /** 实时帧推手（subscribeTask 回调捕获——模拟 WS 新帧到达）。 */
  let pushFrame: ((frame: Frame) => void) | null = null
  const frames = [...options.frames]
  return {
    mode: 'mock',
    connection: () => 'mock',
    onConnectionChange: (listener) => {
      listener('mock')
      return () => {}
    },
    listSessions: async () => ({ sessions: [summary] }),
    createSession: async () => unimplemented('createSession'),
    getSession: async () => ({
      session: summary,
      tasks: [{ taskId: TASK, status, lastSeq: frames.length, frameCount: frames.length }],
    }),
    followup: async () => unimplemented('followup'),
    stopTask: async () => unimplemented('stopTask'),
    answer: async () => ({ ok: true }),
    renameSession: async () => unimplemented('renameSession'),
    cancel: async () => ({ ok: true }),
    clear: async () => ({ ok: true, status: 'cleared' }),
    replay: async (_sessionId: string, taskId: string) => ({
      frames: taskId === TASK ? [...frames] : [],
      nextSeq: frames.length + 1,
    }),
    sessionResult: async () => unimplemented('sessionResult'),
    taskResult: async () => unimplemented('taskResult'),
    taskArtifact: async () => unimplemented('taskArtifact'),
    subscribeTask: (_taskId, _afterSeq, onFrame) => {
      pushFrame = onFrame
      return () => {
        pushFrame = null
      }
    },
    taskDetail: async () => unimplemented('taskDetail'),
    layerSplit: async () => unimplemented('layerSplit'),
    layerRename: async () => unimplemented('layerRename'),
    layerStrategySet: async () => unimplemented('layerStrategySet'),
    treeHistory: async () => unimplemented('treeHistory'),
    layerMaskPatch: async () => unimplemented('layerMaskPatch'),
    viewStateSet: async () => unimplemented('viewStateSet'),
    taskExport: async () => unimplemented('taskExport'),
    layerReorder: async () => unimplemented('layerReorder'),
    layerDelete: async () => unimplemented('layerDelete'),
    treeRevert: async () => unimplemented('treeRevert'),
    maskEditRetry: async () => unimplemented('maskEditRetry'),
    maskEditDiscard: async () => unimplemented('maskEditDiscard'),
    __pushFrameForTest: (frame: Frame) => {
      frames.push(frame)
      pushFrame?.(frame)
    },
  } as AgentApi & { __pushFrameForTest: (frame: Frame) => void }
}

const mountedDisposers: Array<() => void> = []

function mountPanel(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(TaskDetailPanel, { target, props: { taskId: TASK, onBackToChat: () => {} } })
  mountedDisposers.push(() => {
    unmount(view)
    target.remove()
  })
}

const flush = async (ms = 20): Promise<void> => {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
  if (!condition()) throw new Error(`waitUntil 超时（${ms}ms）：条件未满足`)
}

function q(selector: string): HTMLElement | null {
  return document.querySelector(selector)
}

function qq(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
}

function click(selector: string): void {
  const el = q(selector) as HTMLButtonElement | null
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

/** 活动面板页（bits-ui Tabs.Content：active 无 hidden/data-state=active）。 */
function tabState(testid: string): { hidden: boolean; state: string | null } {
  const el = q(`[data-testid="${testid}"]`)
  return { hidden: el?.hasAttribute('hidden') ?? true, state: el?.getAttribute('data-state') ?? null }
}

/** 三条样例帧：配对 ok（带产出图）+未配对 running+error。 */
function demoActivityFrames(): Frame[] {
  return [
    activityFrame(1, { activityId: 'a1', label: '区域分割 · 帽子', status: 'running', inputSummary: '帽子区域 · SAM 单步细分' }),
    activityFrame(2, { activityId: 'a1', label: '区域分割 · 帽子', status: 'ok', durationMs: 1350, inputSummary: '帽子区域 · SAM 单步细分', outputSummary: '掩码 1 层 · 覆盖 62%', outputBlobRef: REF_A }),
    activityFrame(3, { activityId: 'a2', label: '策略设计', status: 'running' }),
    activityFrame(4, { activityId: 'a3', label: '策略设计', status: 'running' }),
    activityFrame(5, { activityId: 'a3', label: '策略设计', status: 'error', durationMs: 2100, errorBrief: '引擎校验未过：最小间距 0.8mm' }),
  ]
}

beforeEach(() => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetViewForTests('agent')
  resetToastsForTests()
  resetGemSummaryForTests()
  resetMyTasksForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetViewForTests('agent')
  resetToastsForTests()
  resetGemSummaryForTests()
  resetMyTasksForTests()
})

describe('活动 tab：固定第二位+badge+行渲染', () => {
  it('触发器在详情与工作台之间；badge=未配对 running 数（1）', async () => {
    bindAgentApi(stubApi({ frames: demoActivityFrames() }))
    await initAgentStore()
    mountPanel()
    await waitUntil(() => q('[data-testid="task-detail-tab-activity"]') !== null)

    // 固定第二位：详情之后、工作台之前（DOM 文档序——badge span 不进比对）。
    const detail = q('[data-testid="task-detail-tab-detail"]')!
    const activityTab = q('[data-testid="task-detail-tab-activity"]')!
    const workbench = q('[data-testid="task-detail-tab-workbench"]')!
    expect(detail.compareDocumentPosition(activityTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(activityTab.compareDocumentPosition(workbench) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(q('[data-testid="task-detail-tab-activity"]')?.textContent).toContain('活动')
    expect(q('[data-testid="task-detail-tab-activity-badge"]')?.textContent).toBe('1')
  })

  it('badge 零在途不显；行渲染：配对合并 3 行（ok/error/running），耗时人话化', async () => {
    bindAgentApi(
      stubApi({
        frames: [
          activityFrame(1, { activityId: 'a1', label: '区域分割 · 帽子', status: 'ok', durationMs: 1350 }),
          activityFrame(2, { activityId: 'a2', label: '导出工件', status: 'ok', durationMs: 400 }),
          activityFrame(3, { activityId: 'a3', label: '全图分析', status: 'ok', durationMs: 126_000 }),
        ],
      }),
    )
    await initAgentStore()
    mountPanel()
    await waitUntil(() => q('[data-testid="task-detail-tab-activity-badge"]') === null)
    expect(q('[data-testid="task-detail-tab-activity"]')).not.toBeNull()

    click('[data-testid="task-detail-tab-activity"]')
    await waitUntil(() => tabState('task-detail-activity-content').state === 'active')
    const rows = qq('[data-testid="task-activity-row"]')
    expect(rows).toHaveLength(3)
    // 时间正序：a1（首见序）在上。
    expect(rows.map((row) => row.getAttribute('data-activity-id'))).toEqual(['a1', 'a2', 'a3'])
    expect(rows[0]?.getAttribute('data-status')).toBe('ok')
    // 耗时三档：1.4s 档/400ms 档/2m6s 档。
    const durations = qq('[data-testid="task-activity-duration"]').map((el) => el.textContent)
    expect(durations).toEqual(['1s', '400ms', '2m6s'])
  })

  it('展开行：输入/产出/失败简述+产出图缩略（assetRawUrl w 参数）→点击开 Lightbox', async () => {
    bindAgentApi(stubApi({ frames: demoActivityFrames() }))
    await initAgentStore()
    mountPanel()
    click('[data-testid="task-detail-tab-activity"]')
    await waitUntil(() => qq('[data-testid="task-activity-row"]').length === 3)

    // ok 行展开：输入+产出摘要+缩略图。
    click('[data-activity-id="a1"] [data-testid="task-activity-row-toggle"]')
    await waitUntil(() => q('[data-testid="task-activity-detail"]') !== null)
    expect(q('[data-testid="task-activity-input"]')?.textContent).toContain('帽子区域 · SAM 单步细分')
    expect(q('[data-testid="task-activity-output"]')?.textContent).toContain('掩码 1 层 · 覆盖 62%')
    const thumb = q('[data-testid="task-activity-thumb"] img')
    expect(thumb?.getAttribute('src')).toContain(`/api/assets/${REF_A}/raw`)
    expect(thumb?.getAttribute('src')).toContain('w=320')

    // error 行展开：失败简述（destructive）。
    click('[data-activity-id="a3"] [data-testid="task-activity-row-toggle"]')
    await waitUntil(() => q('[data-testid="task-activity-error"]') !== null)
    expect(q('[data-testid="task-activity-error"]')?.textContent).toContain('引擎校验未过：最小间距 0.8mm')

    // 缩略点击 → 应用内 Lightbox（复用既有组件）。
    click('[data-testid="task-activity-thumb"]')
    await waitUntil(() => q('[data-testid="lightbox"]') !== null)
    expect(q('[data-testid="lightbox-image"]')?.getAttribute('src')).toContain(`/api/assets/${REF_A}/raw`)
  })

  it('running 行：状态点+「已进行 Ns」实时秒表（1s tick 推进）', async () => {
    bindAgentApi(
      stubApi({
        status: 'running',
        frames: [activityFrame(1, { activityId: 'live', label: '区域分割 · 脸蛋', status: 'running', startedAt: Date.now() - 1200 })],
      }),
    )
    await initAgentStore()
    mountPanel()
    click('[data-testid="task-detail-tab-activity"]')
    await waitUntil(() => q('[data-testid="task-activity-row"]') !== null)
    expect(q('[data-testid="task-activity-row"]')?.getAttribute('data-status')).toBe('running')
    const first = q('[data-testid="task-activity-duration"]')?.textContent ?? ''
    expect(first).toMatch(/已进行 \d+s/)
    // 秒表推进（≥2s 窗口内数字单调不减——interval 1s tick）。
    await waitUntil(() => (q('[data-testid="task-activity-duration"]')?.textContent ?? '') !== first, 3000)
    expect(q('[data-testid="task-activity-duration"]')?.textContent).toMatch(/已进行 \d+s/)
  })

  it('空态：任务无 activity 帧（旧任务）＝「暂无活动记录」', async () => {
    bindAgentApi(
      stubApi({
        frames: [
          { seq: 1, ts: TS, kind: 'transcript', payload: { role: 'user', text: '给小丑贴钻' } },
          { seq: 2, ts: TS + 4200, kind: 'done', payload: {} },
        ],
      }),
    )
    await initAgentStore()
    mountPanel()
    click('[data-testid="task-detail-tab-activity"]')
    await waitUntil(() => tabState('task-detail-activity-content').state === 'active')
    expect(q('[data-testid="task-activity-empty"]')?.textContent).toContain('暂无活动记录')
    expect(qq('[data-testid="task-activity-row"]')).toHaveLength(0)
  })

  it('实时性：WS 新帧到达（既有 subscribeTask 通道）→行即时更新（running→ok 配对+badge 归零）', async () => {
    const api = stubApi({ status: 'running', frames: demoActivityFrames() })
    bindAgentApi(api)
    await initAgentStore()
    mountPanel()
    click('[data-testid="task-detail-tab-activity"]')
    await waitUntil(() => qq('[data-testid="task-activity-row"]').length === 3)
    expect(q('[data-testid="task-detail-tab-activity-badge"]')?.textContent).toBe('1')

    // 在途 a2 收到终态帧（同一游标流推送——不另开通道）。
    api.__pushFrameForTest(
      activityFrame(6, { activityId: 'a2', label: '策略设计', status: 'ok', durationMs: 3200, outputSummary: '5 节点指派' }),
    )
    await waitUntil(() => q('[data-activity-id="a2"]')?.getAttribute('data-status') === 'ok')
    expect(qq('[data-testid="task-activity-row"]')).toHaveLength(3)
    expect(q('[data-activity-id="a2"] [data-testid="task-activity-duration"]')?.textContent).toBe('3s')
    // 全配对：badge 退场。
    await waitUntil(() => q('[data-testid="task-detail-tab-activity-badge"]') === null)
  })
})

// ---------------------------------------------------------------- mock 演示（fixture 驱动）

describe('mock 纪律：clown fixture 演示时间线（与 rpc 同一投影路径）', () => {
  it('活动 tab 渲染 fixture 五条（语义分析/分割×2/策略/导出——含产出图缩略）', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    await openSession('fixt-session-clown')
    const task = getActiveTask()
    expect(task).not.toBeNull()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const view = mount(TaskDetailPanel, { target, props: { taskId: task!.taskId, onBackToChat: () => {} } })
    mountedDisposers.push(() => {
      unmount(view)
      target.remove()
    })
    click('[data-testid="task-detail-tab-activity"]')
    await waitUntil(() => qq('[data-testid="task-activity-row"]').length === 5)
    const labels = qq('[data-testid="task-activity-label"]').map((el) => el.textContent)
    expect(labels).toEqual(['全图语义分析', '区域分割 · 帽子', '区域分割 · 脸蛋', '策略设计', '导出工件'])
    // 全部终态 ok（演示=已完成任务）；done 任务无在途 badge。
    expect(qq('[data-testid="task-activity-row"]').every((row) => row.getAttribute('data-status') === 'ok')).toBe(true)
    expect(q('[data-testid="task-detail-tab-activity-badge"]')).toBeNull()
    // 展开帽子分割行：产出图缩略在场（treePreview——点击可开 Lightbox）。
    click('[data-activity-id="dsh-clown-2"] [data-testid="task-activity-row-toggle"]')
    await waitUntil(() => q('[data-testid="task-activity-thumb"]') !== null)
    const thumb = q('[data-testid="task-activity-thumb"] img')
    expect(thumb?.getAttribute('src')).toContain('/api/assets/')
  })
})
