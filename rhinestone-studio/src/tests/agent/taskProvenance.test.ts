/*
 * [v6 复核 P1-5] chat 帧流任务归属回归：多任务会话（一个 followup=一个 task）的
 * 压平转录流不得丢 taskId——历史任务的 done 卡「打开任务详情」、审批应答目标
 * 必须路由来源任务，不得被最新任务顶替。
 * 覆盖三层：
 *   [1] 投影面：projectFrames 按任务分组入参——frame 条目逐条携带来源 taskId。
 *   [2] store 面：getPendingApproval 的 taskId=审批帧来源任务（旧 bug：恒最新任务）。
 *   [3] 组件面：SessionStream 渲染两任务交错 done 帧——两张 done 卡的
 *       「打开任务详情」分别打开各自来源任务。
 * 测试注入本地 stub AgentApi（两任务交错 fixture——mock 固定 fixture 无多任务会话）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Frame } from '@handicraft/contracts'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import { projectFrames } from '$lib/agentApi/transcript.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import {
  bindAgentApi,
  getActiveSessionTaskFrames,
  getPendingApproval,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { getStudioTaskId, resetViewForTests } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

// jsdom 未实现 scrollIntoView（转录流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const TASK_1 = 'prov-task-1'
const TASK_2 = 'prov-task-2'
const SESSION = 'prov-session'

const ts = Date.parse('2026-09-28T10:00:00.000Z')
const userFrame = (seq: number, text: string): Frame => ({
  seq,
  ts: ts + seq * 1000,
  kind: 'transcript',
  payload: { role: 'user', text },
})
const doneFrame = (seq: number): Frame => ({ seq, ts: ts + seq * 1000, kind: 'done', payload: {} })
const approvalRequestFrame = (seq: number, requestId: string): Frame => ({
  seq,
  ts: ts + seq * 1000,
  kind: 'approval-request',
  payload: {
    requestId,
    tool: 'studio.patch-apply',
    proposalId: 'prov-proposal-1',
    summary: '历史任务的审批请求',
    expiresAt: new Date(ts + 10 * 60_000).toISOString(),
    preview: { before: 'b'.repeat(64), after: 'a'.repeat(64) },
  },
})

/** 任务 1（历史）：user → 未应答审批 → done；任务 2（最新）：user → done。 */
const TASK_1_FRAMES: Frame[] = [
  userFrame(1, '第一轮：帮我把爱心排满红钻'),
  approvalRequestFrame(2, 'prov-request-1'),
  doneFrame(3),
]
const TASK_2_FRAMES: Frame[] = [userFrame(1, '第二轮：换成蓝色'), doneFrame(2)]

function stubApi(): AgentApi {
  const unimplemented = (name: string): never => {
    throw new Error(`stub 未实现：${name}（本测试只消费会话读面）`)
  }
  const summary = {
    id: SESSION,
    title: '两轮连续会话',
    status: 'active' as const,
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T10:05:00.000Z',
  }
  const tasks = [
    { id: TASK_1, status: 'done' as const, frames: TASK_1_FRAMES },
    { id: TASK_2, status: 'done' as const, frames: TASK_2_FRAMES },
  ]
  const framesOf = (taskId: string): Frame[] => tasks.find((t) => t.id === taskId)?.frames ?? []
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
      tasks: tasks.map((t) => ({
        taskId: t.id,
        status: t.status,
        lastSeq: t.frames.length,
        frameCount: t.frames.length,
      })),
    }),
    followup: async () => unimplemented('followup'),
    stopTask: async () => unimplemented('stopTask'),
    answer: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    clear: async () => ({ ok: true, status: 'cleared' }),
    replay: async (_sessionId, taskId) => ({
      frames: framesOf(taskId),
      nextSeq: framesOf(taskId).length + 1,
    }),
    sessionResult: async () => unimplemented('sessionResult'),
    taskResult: async () => unimplemented('taskResult'),
    taskArtifact: async () => unimplemented('taskArtifact'),
    subscribeTask: () => () => {},
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
  }
}

const disposers: Array<() => void> = []

async function openProvenanceSession(): Promise<void> {
  bindAgentApi(stubApi())
  await initAgentStore()
}

beforeEach(() => {
  resetAgentStoreForTests()
  resetViewForTests()
  resetToastsForTests()
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  resetAgentStoreForTests()
  resetViewForTests()
  resetToastsForTests()
})

describe('帧流任务归属（v6 复核 P1-5）', () => {
  it('投影面：frame 条目逐条携带来源 taskId（压平不丢归属）', async () => {
    await openProvenanceSession()
    const groups = getActiveSessionTaskFrames()
    expect(groups.map((g) => g.taskId)).toEqual([TASK_1, TASK_2])
    const items = projectFrames(groups)
    const frameItems = items.filter((item) => item.kind === 'frame')
    // 任务 1 的审批帧+done 帧归属任务 1；任务 2 的 done 帧归属任务 2
    expect(frameItems.map((item) => (item.kind === 'frame' ? item.taskId : null))).toEqual([
      TASK_1,
      TASK_1,
      TASK_2,
    ])
    // 全局 seq 单调（任务域 seq 跨任务重复——投影序不冲突）
    const seqs = items.map((item) => item.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('store 面：未应答审批的 taskId=审批帧来源任务（非最新任务）', async () => {
    await openProvenanceSession()
    const approval = getPendingApproval()
    expect(approval).not.toBeNull()
    expect(approval!.requestId).toBe('prov-request-1')
    expect(approval!.taskId).toBe(TASK_1) // 旧 bug：恒返回最新任务 TASK_2
  })

  it('组件面：两张 done 卡「打开任务详情」分别打开来源任务', async () => {
    await openProvenanceSession()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const view = mount(SessionStream, { target })
    disposers.push(() => {
      unmount(view)
      target.remove()
    })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 30))

    const buttons = document.querySelectorAll('[data-testid="open-task-detail"]')
    expect(buttons.length).toBe(2) // 两任务的 done 卡各一张
    ;(buttons[0] as HTMLElement).click()
    expect(getStudioTaskId()).toBe(TASK_1) // 历史任务 done 卡 → 来源任务
    ;(buttons[1] as HTMLElement).click()
    expect(getStudioTaskId()).toBe(TASK_2) // 最新任务 done 卡 → 自身
  })
})
