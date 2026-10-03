/*
 * [P0 批准唤醒可见性 θ 前端接线，2026-10-01] 系统续跑通知回归：
 * daemon wakeForApproval 在原任务帧流上补 transcript user 帧（text=
 * `系统续跑已开启（新任务 <wakeTaskId>）——…`）——此前前端只订阅客户端自开任务，
 * 服务端发起的续跑轮对 UI 不可见（「点批准后无续跑」感知病灶）。
 * 覆盖三层：
 *   [1] 解析面：parseResumeRunNotice（宽容锚定+非通知帧 null）。
 *   [2] store 面：ingestFrame 收到通知帧 → 登记 wake 任务+replay+订阅（幂等/切会话守卫）。
 *   [3] 投影面：通知帧渲染为 status 行（不进用户气泡——系统通知非用户原话）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '@handicraft/contracts'
import { parseResumeRunNotice } from '$lib/agentApi/resumeRun'
import { projectFrames } from '$lib/agentApi/transcript.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import {
  bindAgentApi,
  getActiveSessionTaskFrames,
  getActiveTasks,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const SESSION = 'theta-session'
const ORIGIN_TASK = 'theta-task-origin'
const WAKE_TASK = 'theta-task-wake'
const PROPOSAL = 'theta-proposal-1'

const ts = Date.parse('2026-10-01T08:00:00.000Z')

/** daemon kernel/index.ts wakeForApproval 字面帧。 */
const wakeNoticeFrame: Frame = {
  seq: 3,
  ts: ts + 3000,
  kind: 'transcript',
  payload: {
    role: 'user',
    text: `系统续跑已开启（新任务 ${WAKE_TASK}）——已批准审批 ${PROPOSAL} 的后续执行在该任务中进行`,
  },
}

describe('[1] parseResumeRunNotice 解析面', () => {
  it('通知帧 → 新任务 id；前缀不符/括号残缺 → null', () => {
    expect(parseResumeRunNotice(wakeNoticeFrame.payload.text)).toBe(WAKE_TASK)
    expect(parseResumeRunNotice('系统续跑开启失败（网络）——请手动发送消息继续')).toBeNull()
    expect(parseResumeRunNotice('系统续跑已开启（新任务 ）——空 id')).toBeNull()
    expect(parseResumeRunNotice('用户普通消息')).toBeNull()
  })
})

describe('[2] store 接线：通知帧 → 登记+replay+订阅', () => {
  let replayCalls: Array<{ sessionId: string; taskId: string }>
  let deliver: ((frame: Frame) => void) | null

  function stubApi(): AgentApi {
    const unimplemented = (name: string): never => {
      throw new Error(`stub 未实现：${name}`)
    }
    const summary = {
      id: SESSION,
      title: '批准唤醒会话',
      status: 'active' as const,
      createdAt: '2026-10-01T07:00:00.000Z',
      updatedAt: '2026-10-01T08:05:00.000Z',
    }
    const originFrames: Frame[] = [
      { seq: 1, ts, kind: 'transcript', payload: { role: 'user', text: '帮我排满红钻' } },
      { seq: 2, ts: ts + 1000, kind: 'done', payload: {} },
    ]
    const wakeFrames: Frame[] = [
      { seq: 1, ts: ts + 4000, kind: 'transcript', payload: { role: 'assistant', text: '续跑轮开始执行' } },
    ]
    const framesOf = (taskId: string): Frame[] =>
      taskId === ORIGIN_TASK ? originFrames : taskId === WAKE_TASK ? wakeFrames : []
    return {
      mode: 'mock',
      setAutoApprove: async () => ({ ok: true, autoApprove: false }),
      connection: () => 'mock',
      onConnectionChange: (listener) => {
        listener('mock')
        return () => {}
      },
      listSessions: async () => ({ sessions: [summary] }),
      createSession: async () => unimplemented('createSession'),
      getSession: async () => ({
        session: summary,
        // 服务端发起的续跑任务不在会话详情任务行（openSession 时序早于批准）——
        // 正是 θ 的病灶：只能靠通知帧接线登记。
        tasks: [{ taskId: ORIGIN_TASK, status: 'done', lastSeq: 2, frameCount: 2 }],
      }),
      followup: async () => unimplemented('followup'),
      stopTask: async () => unimplemented('stopTask'),
      answer: async () => ({ ok: true }),
      renameSession: async () => unimplemented('renameSession'),
      cancel: async () => ({ ok: true }),
      clear: async () => ({ ok: true, status: 'cleared' }),
      replay: async (sessionId, taskId) => {
        replayCalls.push({ sessionId, taskId })
        const frames = framesOf(taskId)
        return { frames, nextSeq: frames.length + 1 }
      },
      sessionResult: async () => {
        throw new Error('本测试无结果面')
      },
      taskResult: async () => unimplemented('taskResult'),
      taskArtifact: async () => unimplemented('taskArtifact'),
      subscribeTask: (_taskId, _afterSeq, onFrame) => {
        deliver = (frame) => onFrame(frame)
        return () => {}
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
    }
  }

  beforeEach(() => {
    resetAgentStoreForTests()
    resetViewForTests()
    resetToastsForTests()
    replayCalls = []
    deliver = null
  })

  afterEach(() => {
    resetAgentStoreForTests()
    resetViewForTests()
    resetToastsForTests()
  })

  it('原任务流收到通知帧 → wake 任务登记+回放并入会话视图（服务端续跑可见）', async () => {
    bindAgentApi(stubApi())
    await initAgentStore()
    expect(getActiveTasks().map((task) => task.taskId)).toEqual([ORIGIN_TASK])

    // daemon 在原任务流上补发通知帧（writer-fence 放行）。
    deliver?.({ ...wakeNoticeFrame, seq: 3 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(getActiveTasks().map((task) => task.taskId)).toEqual([ORIGIN_TASK, WAKE_TASK])
    expect(replayCalls).toContainEqual({ sessionId: SESSION, taskId: WAKE_TASK })
    const wakeGroup = getActiveSessionTaskFrames().find((group) => group.taskId === WAKE_TASK)
    expect(wakeGroup?.frames.map((frame) => frame.kind)).toEqual(['transcript'])
  })

  it('重复通知帧幂等（不重复登记）；普通用户消息不触发登记', async () => {
    bindAgentApi(stubApi())
    await initAgentStore()

    deliver?.({ ...wakeNoticeFrame, seq: 3 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    deliver?.({ ...wakeNoticeFrame, seq: 4, ts: ts + 3500 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getActiveTasks().filter((task) => task.taskId === WAKE_TASK)).toHaveLength(1)
    expect(replayCalls.filter((call) => call.taskId === WAKE_TASK)).toHaveLength(1)

    deliver?.({
      seq: 5,
      ts: ts + 5000,
      kind: 'transcript',
      payload: { role: 'user', text: '用户追问：进度如何' },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getActiveTasks().map((task) => task.taskId)).toEqual([ORIGIN_TASK, WAKE_TASK])
  })
})

describe('[3] 投影面：通知帧渲染为 status 行', () => {
  it('projectFrames：通知帧 → status（不产生用户气泡条目）', () => {
    const items = projectFrames([{ taskId: ORIGIN_TASK, frames: [wakeNoticeFrame] }])
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('status')
    if (items[0]!.kind === 'status') {
      expect(items[0]!.text).toContain('续跑任务已开启')
      expect(items[0]!.text).not.toContain(WAKE_TASK) // 裸 taskId 不入行
    }
  })
})
