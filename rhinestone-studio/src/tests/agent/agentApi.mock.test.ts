/*
 * [add-backend-platform W3.1] Agent API mock 适配器与 façade store 测试。
 * 覆盖：固定 fixture 帧序列（transcript/progress/approval-request/artifact/done）；
 * afterSeq task 域回放（无重帧无漏帧）；审批应答双分支（批准→产物+完成；拒绝→真值
 * 零变化话术）；取消停流；clear 列表过滤+幂等；store 帧摄入 seq 去重（重连重订阅
 * 无重复）；结果确定性选择；连接态=mock。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  answerApproval,
  bindAgentApi,
  getActiveSessionFrames,
  getActiveSessionId,
  getActiveSession,
  getAgentConnection,
  getAgentError,
  getAgentMode,
  getAgentSessions,
  getPendingApproval,
  getSessionResult,
  initAgentStore,
  resetAgentStoreForTests,
  sendFollowup,
  clearActiveSession,
} from '$lib/agentApi/store.svelte'

const flush = async (ms = 20): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('MockAgentApi：fixture 帧序列与回放', () => {
  it('预置会话与已完成任务：replay 全量与 afterSeq 窗口（task 域游标）', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const { sessions } = await api.listSessions()
    expect(sessions.map((s) => s.title)).toContain('爱心图案贴钻')
    expect(sessions.some((s) => s.status === 'cleared')).toBe(false)

    const heart = sessions.find((s) => s.title === '爱心图案贴钻')!
    const detail = await api.getSession(heart.id)
    expect(detail.tasks).toHaveLength(1)
    expect(detail.tasks[0]).toMatchObject({ status: 'done', lastSeq: 6, frameCount: 6 })

    const taskId = detail.tasks[0]!.taskId
    const full = await api.replay(heart.id, taskId, 0)
    expect(full.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(full.nextSeq).toBe(6)
    const window = await api.replay(heart.id, taskId, 4)
    expect(window.frames.map((f) => f.seq)).toEqual([5, 6])
    expect(window.nextSeq).toBe(6)
    const empty = await api.replay(heart.id, taskId, 6)
    expect(empty.frames).toEqual([])
    expect(empty.nextSeq).toBe(6)
  })

  it('subscribeTask：先回放 afterSeq 之后持久帧再续收实时帧（无缺失无重复）', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const { sessions } = await api.listSessions()
    const heart = sessions[0]!
    const detail = await api.getSession(heart.id)
    const taskId = detail.tasks[0]!.taskId
    const seen: number[] = []
    const unsubscribe = api.subscribeTask(taskId, 3, (frame) => seen.push(frame.seq))
    expect(seen).toEqual([4, 5, 6])
    unsubscribe()
  })

  it('followup 脚本：审批批准分支 → resolved(approved)+artifact+done+结果', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const created = await api.createSession({ title: '审批旅程' })
    const { taskId } = await api.followup(created.sessionId, '把爱心排密一点')
    const frames: { seq: number; kind: string }[] = []
    api.subscribeTask(taskId, 0, (frame) => frames.push({ seq: frame.seq, kind: frame.kind }))

    // 脚本推进到审批门挂起（user+assistant+progress×2+approval-request）。
    await flush(10)
    expect(frames.map((f) => f.kind)).toEqual([
      'transcript',
      'transcript',
      'progress',
      'progress',
      'approval-request',
    ])
    const replay = await api.replay(created.sessionId, taskId, 0)
    const request = replay.frames.find((f) => f.kind === 'approval-request')
    expect(request?.payload).toMatchObject({ tool: 'studio.patch-apply' })

    const answered = await api.answer(created.sessionId, (request!.payload as { requestId: string }).requestId, true)
    expect(answered.ok).toBe(true)
    await flush(10)
    expect(frames.map((f) => f.kind).slice(5)).toEqual(['approval-resolved', 'transcript', 'artifact', 'done'])

    const detail = await api.getSession(created.sessionId)
    expect(detail.tasks[0]!.status).toBe('done')
    const result = await api.sessionResult(created.sessionId)
    expect(result.taskId).toBe(taskId)
    expect(result.publicId).toBe('FixtNew01')
    expect(result.bundle.svg).toMatch(/^[0-9a-f]{64}$/)
  })

  it('followup 脚本：拒绝分支 → resolved(rejected)+说明+done（无 artifact）', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const created = await api.createSession({ title: '拒绝旅程' })
    const { taskId } = await api.followup(created.sessionId, '换个方案')
    await flush(10)
    const replay = await api.replay(created.sessionId, taskId, 0)
    const request = replay.frames.find((f) => f.kind === 'approval-request')!
    const answered = await api.answer(created.sessionId, (request.payload as { requestId: string }).requestId, false)
    expect(answered.ok).toBe(true)
    await flush(10)
    const after = await api.replay(created.sessionId, taskId, 0)
    const kinds = after.frames.map((f) => f.kind)
    expect(kinds).toContain('approval-resolved')
    expect(kinds).not.toContain('artifact')
    expect(kinds[kinds.length - 1]).toBe('done')
    // 未知 requestId：ok=false（幂等不误应答）。
    expect((await api.answer(created.sessionId, 'no-such-request', true)).ok).toBe(false)
  })

  it('取消：脚本中止、任务置 cancelled；清空：列表过滤+幂等', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const created = await api.createSession({ title: '取消与清空' })
    const { taskId } = await api.followup(created.sessionId, '先跑起来')
    await flush(10)
    expect((await api.cancel({ taskId })).ok).toBe(true)
    const detail = await api.getSession(created.sessionId)
    expect(detail.tasks[0]!.status).toBe('cancelled')
    // 审批门已被取消静默释放：answer 返回 ok=false。
    const replay = await api.replay(created.sessionId, taskId, 0)
    const request = replay.frames.find((f) => f.kind === 'approval-request')
    if (request) {
      expect((await api.answer(created.sessionId, (request.payload as { requestId: string }).requestId, true)).ok).toBe(false)
    }

    expect((await api.clear(created.sessionId)).ok).toBe(true)
    expect((await api.clear(created.sessionId)).ok).toBe(true) // tombstone 幂等
    const after = await api.listSessions()
    expect(after.sessions.map((s) => s.id)).not.toContain(created.sessionId)
    // cleared 会话拒新输入。
    await expect(api.followup(created.sessionId, '迟到')).rejects.toThrow('已清理')
  })

  it('taskResult：完成任务 found / 进行中任务 not_found；连接态恒 mock', async () => {
    const api = new MockAgentApi({ speed: 0 })
    expect(api.connection()).toBe('mock')
    const { sessions } = await api.listSessions()
    const heart = sessions[0]!
    const detail = await api.getSession(heart.id)
    const done = await api.taskResult(detail.tasks[0]!.taskId)
    expect(done.found).toBe(true)
    const created = await api.createSession({ title: '无结果' })
    const running = await api.followup(created.sessionId, '进行中')
    expect((await api.taskResult(running.taskId)).found).toBe(false)
  })

  // ---------------------------------------------------------------- P1-4：确定性选择

  it('两 task 逆序完成（先创建后完成者胜）：sessionResult 按 completedAt 选择（非 taskId）', async () => {
    let tick = 0
    const api = new MockAgentApi({ speed: 0, now: () => new Date(1_700_000_000_000 + tick).toISOString() })
    const created = await api.createSession({ title: '逆序完成' })
    // A 先创建、B 后创建——两脚本都停在审批门。
    const a = await api.followup(created.sessionId, '先创建的任务')
    const b = await api.followup(created.sessionId, '后创建的任务')
    await flush(10)

    // B 先完成（较早 completedAt），A 后完成（较晚 completedAt）——契约应选 A。
    const requestOf = async (taskId: string): Promise<string> => {
      const replay = await api.replay(created.sessionId, taskId, 0)
      return (replay.frames.find((f) => f.kind === 'approval-request')!.payload as { requestId: string }).requestId
    }
    await api.answer(created.sessionId, await requestOf(b.taskId), true)
    await flush(10)
    tick += 5_000
    await api.answer(created.sessionId, await requestOf(a.taskId), true)
    await flush(10)

    const detail = await api.getSession(created.sessionId)
    expect(detail.tasks.map((t) => t.status)).toEqual(['done', 'done'])
    const result = await api.sessionResult(created.sessionId)
    expect(result.taskId).toBe(a.taskId) // 完成时间晚者胜——字典序 taskId 更大的 B 落败
  })

  it('同时间完成的 taskId tie：字典序大者胜（contracts selectSessionResult 同源）', async () => {
    const fixed = new Date(1_700_000_000_000).toISOString()
    const api = new MockAgentApi({ speed: 0, now: () => fixed })
    const created = await api.createSession({ title: '同时完成' })
    const a = await api.followup(created.sessionId, '任务甲')
    const b = await api.followup(created.sessionId, '任务乙')
    await flush(10)
    const requestOf = async (taskId: string): Promise<string> => {
      const replay = await api.replay(created.sessionId, taskId, 0)
      return (replay.frames.find((f) => f.kind === 'approval-request')!.payload as { requestId: string }).requestId
    }
    await api.answer(created.sessionId, await requestOf(a.taskId), true)
    await api.answer(created.sessionId, await requestOf(b.taskId), true)
    await flush(10)

    // completedAt 相同 → taskId 大者（后创建的 B）胜。
    const result = await api.sessionResult(created.sessionId)
    expect(result.taskId).toBe(b.taskId)
  })
})

describe('façade store（mock 注入）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    bindAgentApi(new MockAgentApi({ speed: 0 }))
  })

  afterEach(() => {
    resetAgentStoreForTests()
    vi.restoreAllMocks()
  })

  it('init：fixture 会话列表+自动打开最近会话（帧回放+结果+连接态）', async () => {
    await initAgentStore()
    expect(getAgentMode()).toBe('mock')
    expect(getAgentConnection()).toBe('mock')
    expect(getAgentSessions().length).toBeGreaterThanOrEqual(2)
    expect(getActiveSession()?.title).toBe('爱心图案贴钻')
    expect(getActiveSessionFrames().map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(getSessionResult(getActiveSessionId())?.publicId).toBe('FixtHeart01')
    expect(getAgentError()).toBeNull()
  })

  it('followup→审批批准→结果：store 全链（帧摄入 seq 单调）', async () => {
    await initAgentStore()
    const created = await (getAgentSessions(), Promise.resolve(null))
    void created
    await sendFollowup('把红色区域改密一点')
    await flush(10)
    // 新任务帧接续在预置任务之后（会话流=任务序拼接）。
    const frames = getActiveSessionFrames()
    expect(frames.length).toBeGreaterThan(6)
    const approval = getPendingApproval()
    expect(approval).not.toBeNull()
    expect(approval!.tool).toBe('studio.patch-apply')

    await answerApproval(approval!.requestId, true)
    await flush(10)
    expect(getPendingApproval()).toBeNull()
    const kinds = getActiveSessionFrames().map((f) => f.kind)
    expect(kinds).toContain('approval-resolved')
    expect(kinds[kinds.length - 1]).toBe('done')
    expect(getSessionResult(getActiveSessionId())?.taskId).toBeTruthy()
  })

  it('断线重连模拟：重复订阅同 task（afterSeq=lastSeq）不产生重复帧', async () => {
    await initAgentStore()
    const before = getActiveSessionFrames().length
    // 重新打开会话=回放+重订阅（等价重连路径）；seq 去重保证无重帧。
    await (await import('$lib/agentApi/store.svelte')).openSession(getActiveSessionId()!)
    expect(getActiveSessionFrames().length).toBe(before)
    const seqs = getActiveSessionFrames().map((f) => f.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('clearActiveSession：活跃会话清空后切换到下一会话', async () => {
    await initAgentStore()
    const first = getActiveSessionId()
    await clearActiveSession()
    expect(getActiveSessionId()).not.toBe(first)
    expect(getAgentSessions().map((s) => s.id)).not.toContain(first)
  })
})
