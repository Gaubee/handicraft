/*
 * [add-task-stones-manifest-export 6.1 studio] 多图首条自动拆会话测试（Owner 裁决
 * 2026-09-30 收敛形态）。覆盖：
 *   [1] 新会话首条多图（无任务行+无队列）→ N 次 createSession+followup——每会话
 *       单图（图 i）+同文本+同 sourceSetId；toast 汇总+会话列表刷新+打开第 1 个
 *       新会话。
 *   [2] 单图不拆（原路径零变化——同会话 followup 单附件）。
 *   [3] 已开谈的会话多图不拆（讨论插图语义——同会话 followup 全量附件）。
 *   [4] 部分失败（第 k 个会话创建/投递失败）不强事务：已完成会话保留+toast 报告
 *       成败明细（第 k 张：原因）。
 * 全程 fake rpc AgentApi（store 编排面——daemon 零改动，无需真实服务端）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionRouteForTests } from '$lib/agentApi/sessionRoute.svelte'
import type { Frame } from '@handicraft/contracts'
import type { AgentApi, AgentConnectionState } from '$lib/agentApi/types'
import type { AttachmentMeta } from '$lib/agentApi/attachments'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  bindAgentApi,
  getActiveSessionId,
  getAgentSessions,
  initAgentStore,
  resetAgentStoreForTests,
  sendFollowup,
} from '$lib/agentApi/store.svelte'

// ---------------------------------------------------------------- 测试助手

function att(i: number): AttachmentMeta {
  return { blobRef: `blob-img-${i}.png`, name: `img-${i}.png`, mime: 'image/png', width: 640, height: 480 }
}

interface FollowupCall {
  sessionId: string
  text: string
  mode?: 'followup' | 'steer'
  attachments?: string[]
  sourceSetId?: string
}

interface CreateCall {
  title?: string
}

interface StubOptions {
  /** getSession 返回的任务行（缺省空=新会话首条输入态；给任务行=已开谈）。 */
  tasks?: Array<{ taskId: string; status: 'running' | 'done' }>
  /** 第 k 次 createSession 抛错（1 基；缺省全成功）。 */
  failCreateOn?: number
  /** createSession 恒抛（全败形态）。 */
  failAllCreates?: boolean
  /** 第 k 次 followup 抛错（1 基）。 */
  failFollowupOn?: number
}

/**
 * fake rpc AgentApi：listSessions 返回单一空会话（initAgentStore 自动打开——发送
 * 上下文）；createSession 逐次发放 s-split-1/2/3…；followup/create 载荷记账。
 */
function makeSplitStub(options: StubOptions = {}): {
  api: AgentApi
  followupCalls: FollowupCall[]
  createCalls: CreateCall[]
  listCalls: () => number
} {
  const iso = new Date().toISOString()
  const baseSession = { id: 's-base', title: '空会话', status: 'active' as const, createdAt: iso, updatedAt: iso }
  const followupCalls: FollowupCall[] = []
  const createCalls: CreateCall[] = []
  let listCount = 0
  let createSeq = 0
  let followupSeq = 0
  const api: AgentApi = {
    mode: 'rpc',
    connection: () => 'open' as AgentConnectionState,
    onConnectionChange: (listener) => {
      listener('open')
      return () => {}
    },
    listSessions: async () => {
      listCount += 1
      return { sessions: [baseSession] }
    },
    createSession: async (input) => {
      createSeq += 1
      if (options.failAllCreates || options.failCreateOn === createSeq) throw new Error('会话创建失败（模拟）')
      createCalls.push(input?.title !== undefined ? { title: input.title } : {})
      return { sessionId: `s-split-${createSeq}`, createdAt: iso }
    },
    getSession: async (sessionId) => ({
      session: { ...baseSession, id: sessionId },
      tasks: (options.tasks ?? []).map((task) => ({
        taskId: task.taskId,
        status: task.status,
        lastSeq: 0,
        frameCount: 0,
      })),
    }),
    followup: async (sessionId, text, mode, attachments, sourceSetId) => {
      followupSeq += 1
      if (options.failFollowupOn === followupSeq) throw new Error('投递失败（模拟）')
      followupCalls.push({
        sessionId,
        text,
        ...(mode !== undefined ? { mode } : {}),
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
        ...(sourceSetId !== undefined ? { sourceSetId } : {}),
      })
      return { taskId: `t-fu-${followupSeq}` }
    },
    stopTask: async () => {},
    answer: async () => ({ ok: true }),
    renameSession: async () => {
      throw new Error('本测试不触达')
    },
    cancel: async () => ({ ok: true }),
    clear: async () => ({ ok: true, status: 'cleared' as const }),
    replay: async () => ({ frames: [] as Frame[], nextSeq: 0 }),
    sessionResult: async () => {
      throw new Error('会话暂无已完成结果')
    },
    taskResult: async () => ({ found: false }),
    taskArtifact: async () => {
      throw new Error('工件不存在（拆会话桩）')
    },
    taskDetail: async () => {
      throw new Error('任务详情不可用（拆会话桩）')
    },
    layerSplit: async () => {
      throw new Error('拆层不可用（拆会话桩）')
    },
    layerRename: async () => {
      throw new Error('重命名不可用（拆会话桩）')
    },
    layerStrategySet: async () => {
      throw new Error('策略直改不可用（拆会话桩）')
    },
    treeHistory: async () => {
      throw new Error('版本史不可用（拆会话桩）')
    },
    layerMaskPatch: async () => {
      throw new Error('遮罩编辑不可用（拆会话桩）')
    },
    viewStateSet: async () => {
      throw new Error('视图态写入不可用（拆会话桩）')
    },
    taskExport: async () => {
      throw new Error('任务导出不可用（拆会话桩）')
    },
    layerReorder: async () => {
      throw new Error('图层重排不可用（拆会话桩）')
    },
    layerDelete: async () => {
      throw new Error('图层删除不可用（拆会话桩）')
    },
    treeRevert: async () => {
      throw new Error('整树回退不可用（拆会话桩）')
    },
    maskEditRetry: async () => {
      throw new Error('编辑重算不可用（拆会话桩）')
    },
    maskEditDiscard: async () => {
      throw new Error('编辑放弃不可用（拆会话桩）')
    },
    subscribeTask: () => () => {},
  }
  return { api, followupCalls, createCalls, listCalls: () => listCount }
}

describe('多图首条自动拆会话（6.1——store 编排，daemon 零改动）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    resetSessionRouteForTests('')
    resetToastsForTests()
  })

  afterEach(() => {
    resetAgentStoreForTests()
    resetToastsForTests()
  })

  it('新会话首条 3 图 → 3 个新会话：每会话单图（图 i）+同文本+同 sourceSetId；toast 汇总+列表刷新+打开第 1 个', async () => {
    const stub = makeSplitStub()
    bindAgentApi(stub.api)
    await initAgentStore()
    expect(getActiveSessionId()).toBe('s-base')

    await sendFollowup('帮我把这几张图排满红钻', 'followup', [att(1), att(2), att(3)], 'set-42')

    // N 次 createSession+followup：每会话恰一张图（图 i）+同文本+同 sourceSetId。
    expect(stub.createCalls).toHaveLength(3)
    expect(stub.followupCalls).toHaveLength(3)
    expect(stub.followupCalls.map((call) => call.sessionId)).toEqual(['s-split-1', 's-split-2', 's-split-3'])
    for (let i = 0; i < 3; i += 1) {
      expect(stub.followupCalls[i]).toMatchObject({
        text: '帮我把这几张图排满红钻',
        mode: 'followup',
        sourceSetId: 'set-42',
      })
      expect(stub.followupCalls[i]!.attachments).toEqual([`blob-img-${i + 1}.png`])
    }
    // 会话标题取自文本（拆分会话在列表可辨识）。
    expect(stub.createCalls.map((call) => call.title)).toEqual([
      '帮我把这几张图排满红钻',
      '帮我把这几张图排满红钻',
      '帮我把这几张图排满红钻',
    ])
    // toast 汇总 + 会话列表刷新 + 打开第 1 个新会话。
    expect(getToasts().map((toast) => toast.message).join('\n')).toContain('已按图拆分为 3 个会话')
    expect(stub.listCalls()).toBeGreaterThanOrEqual(2) // init 一次 + 拆分后刷新
    expect(getActiveSessionId()).toBe('s-split-1')
    // 原空会话未被投递（载荷只落在新建会话）。
    expect(stub.followupCalls.some((call) => call.sessionId === 's-base')).toBe(false)
  })

  it('纯图多图（空文本）：每会话空文本+单图（契约「text 或 attachments 至少其一」成立）', async () => {
    const stub = makeSplitStub()
    bindAgentApi(stub.api)
    await initAgentStore()

    await sendFollowup('', 'followup', [att(1), att(2)])

    expect(stub.followupCalls).toHaveLength(2)
    expect(stub.followupCalls[0]).toMatchObject({ text: '', attachments: ['blob-img-1.png'] })
    expect(stub.followupCalls[1]).toMatchObject({ text: '', attachments: ['blob-img-2.png'] })
    // 标题回退附件名（空文本无标题可取）。
    expect(stub.createCalls.map((call) => call.title)).toEqual(['img-1.png', 'img-2.png'])
  })

  it('单图不拆：同会话 followup 单附件（原路径零变化）', async () => {
    const stub = makeSplitStub()
    bindAgentApi(stub.api)
    await initAgentStore()

    await sendFollowup('排这张', 'followup', [att(1)], 'set-42')

    expect(stub.createCalls).toHaveLength(0)
    expect(stub.followupCalls).toEqual([
      { sessionId: 's-base', text: '排这张', mode: 'followup', attachments: ['blob-img-1.png'], sourceSetId: 'set-42' },
    ])
    expect(getToasts()).toHaveLength(0)
    expect(getActiveSessionId()).toBe('s-base')
  })

  it('已开谈的会话多图不拆：讨论插图语义——同会话 followup 全量附件', async () => {
    const stub = makeSplitStub({ tasks: [{ taskId: 't-hist', status: 'done' }] })
    bindAgentApi(stub.api)
    await initAgentStore()
    expect(getActiveSessionId()).toBe('s-base')

    await sendFollowup('这两张是参考图', 'followup', [att(1), att(2)])

    expect(stub.createCalls).toHaveLength(0)
    expect(stub.followupCalls).toEqual([
      {
        sessionId: 's-base',
        text: '这两张是参考图',
        mode: 'followup',
        attachments: ['blob-img-1.png', 'blob-img-2.png'],
      },
    ])
    expect(getToasts()).toHaveLength(0)
    expect(getActiveSessionId()).toBe('s-base')
    expect(getAgentSessions()).toHaveLength(1)
  })

  it('部分失败（第 2 个会话创建失败）不强事务：已完成保留+toast 成败明细+打开第 1 个成功会话', async () => {
    const stub = makeSplitStub({ failCreateOn: 2 })
    bindAgentApi(stub.api)
    await initAgentStore()

    await sendFollowup('排满', 'followup', [att(1), att(2), att(3)], 'set-42')

    // 第 2 张失败不影响第 3 张继续（不强事务）；成功 2 个会话各自单图。
    expect(stub.followupCalls.map((call) => call.sessionId)).toEqual(['s-split-1', 's-split-3'])
    expect(stub.followupCalls[1]!.attachments).toEqual(['blob-img-3.png'])
    // toast 报告成败明细（第 2 张+原因）。
    const messages = getToasts().map((toast) => toast.message).join('\n')
    expect(messages).toContain('成功 2 个、失败 1 个')
    expect(messages).toContain('第 2 张：会话创建失败（模拟）')
    // 列表刷新 + 打开第 1 个成功会话（失败的 s-split-2 从未创建成功）。
    expect(stub.listCalls()).toBeGreaterThanOrEqual(2)
    expect(getActiveSessionId()).toBe('s-split-1')
  })

  it('投递失败同样计入失败明细（创建成功但 followup 拒）', async () => {
    const stub = makeSplitStub({ failFollowupOn: 1 })
    bindAgentApi(stub.api)
    await initAgentStore()

    await sendFollowup('排满', 'followup', [att(1), att(2)])

    expect(stub.followupCalls).toHaveLength(1)
    expect(stub.followupCalls[0]!.sessionId).toBe('s-split-2')
    const messages = getToasts().map((toast) => toast.message).join('\n')
    expect(messages).toContain('成功 1 个、失败 1 个')
    expect(messages).toContain('第 1 张：投递失败（模拟）')
    expect(getActiveSessionId()).toBe('s-split-2')
  })

  it('全部失败：不打开新会话（停留原会话），toast 如实报告', async () => {
    const stubAll = makeSplitStub({ failAllCreates: true })
    bindAgentApi(stubAll.api)
    await initAgentStore()

    await sendFollowup('排满', 'followup', [att(1), att(2)])

    expect(stubAll.followupCalls).toHaveLength(0)
    const messages = getToasts().map((toast) => toast.message).join('\n')
    expect(messages).toContain('全部失败')
    expect(messages).toContain('第 1 张：会话创建失败（模拟）')
    expect(getActiveSessionId()).toBe('s-base')
  })
})
