/*
 * [task-detail-tabs 2026-10-02] 任务详情多 tabs 结构测试（Owner 验收反馈：参考
 * zhumo——详情预览任务+结果链接+工作台链接；结果 iframe 与工作台 page-component
 * 分 tab 打开）。
 * 覆盖：
 * - tab 结构：详情（缺省）/工作台/结果 tabs（session.exports——每 imageId 一 tab）；
 *   详情 tab=任务预览（状态徽标/元数据/导出结果列表卡/工作台入口卡）。
 * - 导出读面复用：MyMaterials tasks.svelte 注入客户端 → ensure/reload 取数；
 *   mock 且未注入 → 静默提示（不空转重连 WS）。
 * - 结果 tab 开关：导出行点击开 tab（地址栏工具行+iframe sandbox 同 zhumo）；
 *   地址栏关闭回详情；导出消失（重导/撤销）活动 tab 回退。
 * - iframe 保活：bits-ui Tabs.Content 常驻挂载（inactive=hidden 非卸载）——切走
 *   不重载（同一 DOM 节点+src 不变）。
 * - 工作台保活：入口卡/触发器首开挂载 TaskWorkbenchView（embedded）；切走再回
 *   同一 DOM 节点在场（画布状态/装载门零改——presence.svelte.ts 判 hidden 链）。
 * 组件面走 stub AgentApi（gemSummary.test 同式）+ MockAgentApi clown 会话（工作台
 * 真装载路径）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import type { Frame } from '@handicraft/contracts'
import TaskDetailPanel from '$lib/components/agent/TaskDetailPanel.svelte'
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
import {
  resetMyTasksForTests,
  type MyTasksClient,
} from '$lib/myMaterials/tasks.svelte'
import type { SessionExportRow } from '$lib/myMaterials/schemas.js'

// jsdom 未实现 scrollIntoView——桩掉（既有 agent 测试同式）。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const SESSION = 'sess-tabs-1'
const TASK = 'task-tabs-1'
const TS = Date.parse('2026-10-02T08:00:00.000Z')

interface StubOptions {
  frames: Frame[]
  status?: 'done' | 'running'
}

function stubApi(options: StubOptions): AgentApi {
  const unimplemented = (name: string): never => {
    throw new Error(`stub 未实现：${name}`)
  }
  const summary = {
    id: SESSION,
    title: '多 tabs 会话',
    status: 'active' as const,
    createdAt: '2026-10-02T07:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
  }
  const status = options.status ?? 'done'
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
      tasks: [{ taskId: TASK, status, lastSeq: options.frames.length, frameCount: options.frames.length }],
    }),
    followup: async () => unimplemented('followup'),
    stopTask: async () => unimplemented('stopTask'),
    answer: async () => ({ ok: true }),
    renameSession: async () => unimplemented('renameSession'),
    cancel: async () => ({ ok: true }),
    clear: async () => ({ ok: true, status: 'cleared' }),
    replay: async (_sessionId: string, taskId: string) => ({
      frames: taskId === TASK ? options.frames : [],
      nextSeq: options.frames.length + 1,
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

function exportsRow(imageId: string, publicId: string, createdAt: string): SessionExportRow {
  return {
    resultId: `res-${publicId}`,
    publicId,
    exportedByTaskId: TASK,
    imageId,
    sourceTaskId: TASK,
    createdAt,
    expiresAt: null,
    download: `/r/${publicId}/files/bom`,
  }
}

/** 可变导出清单的注入客户端（rows 数组直接推动——刷新即见新面）。 */
function makeExportsClient(): { client: MyTasksClient; rows: SessionExportRow[]; calls: () => number } {
  let calls = 0
  const rows: SessionExportRow[] = []
  const client: MyTasksClient = {
    listSessions: async () => ({ sessions: [] }),
    getSession: async () => ({ tasks: [] }),
    listSessionExports: async () => {
      calls += 1
      return { exports: [...rows] }
    },
  }
  return { client, rows, calls: () => calls }
}

const mountedDisposers: Array<() => void> = []

function mountTracked<P extends Record<string, unknown>>(component: Component<P>, props: P): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(component, { target, props })
  mountedDisposers.push(() => {
    unmount(view)
    target.remove()
  })
}

function mountPanel(): void {
  mountTracked(TaskDetailPanel, { taskId: TASK })
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

function doneFrames(): Frame[] {
  return [
    { seq: 1, ts: TS, kind: 'transcript', payload: { role: 'user', text: '给小丑贴钻' } },
    { seq: 2, ts: TS + 4200, kind: 'done', payload: {} },
  ]
}

/** 活动面板页（bits-ui Tabs.Content：active 无 hidden/data-state=active）。 */
function tabState(testid: string): { hidden: boolean; state: string | null } {
  const el = q(`[data-testid="${testid}"]`)
  return { hidden: el?.hasAttribute('hidden') ?? true, state: el?.getAttribute('data-state') ?? null }
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

// ---------------------------------------------------------------- tab 结构

describe('tab 结构：详情（缺省）+工作台+结果 tabs', () => {
  it('exports 就绪：详情缺省激活，导出结果卡 2 行（图 1/图 2）各开结果 tab；详情=任务预览（状态徽标+元数据+工作台入口）', async () => {
    const exportsClient = makeExportsClient()
    exportsClient.rows.push(
      exportsRow('image-1', 'pub-alpha', '2026-10-02T08:30:00.000Z'),
      exportsRow('image-2', 'pub-beta', '2026-10-02T08:40:00.000Z'),
    )
    resetMyTasksForTests(exportsClient.client)
    bindAgentApi(stubApi({ frames: doneFrames() }))
    await initAgentStore()
    mountPanel()
    await waitUntil(() => qq('[data-testid="task-detail-export-row"]').length === 2)

    // 三类 tab 触发器在场：详情（缺省 active）/工作台/结果×2（imageLabel）。
    expect(q('[data-testid="task-detail-tab-detail"]')).not.toBeNull()
    expect(q('[data-testid="task-detail-tab-workbench"]')).not.toBeNull()
    const resultTriggers = qq('[data-testid="task-detail-tab-result"]')
    expect(resultTriggers).toHaveLength(2)
    expect(resultTriggers[0]?.textContent).toContain('图 1')
    expect(resultTriggers[1]?.textContent).toContain('图 2')
    expect(tabState('task-detail-content')).toEqual({ hidden: false, state: 'active' })
    expect(tabState('task-detail-workbench-content').state).toBe('inactive')

    // 详情=任务预览：状态徽标（已完成）+元数据（创建时间/模型/用时）+工作台入口卡。
    expect(q('[data-testid="task-detail-status-badge"]')?.textContent).toContain('已完成')
    const metadata = q('[data-testid="task-detail-metadata"]')?.textContent ?? ''
    expect(metadata).toContain('2026')
    expect(metadata).toContain('后台默认')
    expect(metadata).toContain('4s')
    expect(q('[data-testid="task-detail-workbench-entry"]')?.textContent).toContain('打开工作台')

    // 导出结果卡行：名称+时间+「打开」。
    const row = q('[data-testid="task-detail-export-row"]')
    expect(row?.textContent).toContain('图 1')
    expect(row?.textContent).toContain('打开')
    expect(row?.getAttribute('data-public-id')).toBe('pub-alpha')
  })

  it('运行中：状态徽标「排钻中 Ns」（首帧起算秒表）+钻数占位不硬编', async () => {
    bindAgentApi(
      stubApi({
        status: 'running',
        frames: [
          { seq: 1, ts: Date.now() - 5000, kind: 'transcript', payload: { role: 'user', text: '排钻中' } },
          { seq: 2, ts: Date.now() - 4000, kind: 'progress', payload: { text: '排钻计算中', ratio: 0.4 } },
        ],
      }),
    )
    await initAgentStore()
    mountPanel()
    await waitUntil(() => q('[data-testid="task-detail-status-badge"]') !== null)
    const badge = q('[data-testid="task-detail-status-badge"]')?.textContent ?? ''
    expect(badge).toContain('排钻中')
    expect(badge).toMatch(/\d+s/)
    expect(q('[data-testid="task-detail-gem-pending"]')?.textContent).toContain('排钻中…')
    expect(q('[data-testid="task-detail-gem-badge"]')).toBeNull()
  })

  it('mock 且未注入客户端：导出卡静默提示，不发起任何请求（不空转重连 WS）', async () => {
    bindAgentApi(stubApi({ frames: doneFrames() }))
    await initAgentStore()
    mountPanel()
    await waitUntil(() => q('[data-testid="task-detail-exports-card"]') !== null)
    expect(q('[data-testid="task-detail-exports-mock"]')?.textContent).toContain('本地演示通道无导出历史')
    expect(q('[data-testid="task-detail-exports-loading"]')).toBeNull()
    expect(q('[data-testid="task-detail-export-row"]')).toBeNull()
  })

  it('导出清单拉取失败：错误+重试（error 允许重拉）', async () => {
    const exportsClient = makeExportsClient()
    let fail = true
    exportsClient.client.listSessionExports = async () => {
      if (fail) throw new Error('daemon 不可达')
      return { exports: [exportsRow('image-1', 'pub-gamma', '2026-10-02T08:50:00.000Z')] }
    }
    resetMyTasksForTests(exportsClient.client)
    bindAgentApi(stubApi({ frames: doneFrames() }))
    await initAgentStore()
    mountPanel()
    await waitUntil(() => q('[data-testid="task-detail-exports-error"]') !== null)
    expect(q('[data-testid="task-detail-exports-error"]')?.textContent).toContain('daemon 不可达')

    fail = false
    click('[data-testid="task-detail-exports-retry"]')
    await waitUntil(() => q('[data-testid="task-detail-export-row"]') !== null)
    expect(q('[data-testid="task-detail-export-row"]')?.getAttribute('data-public-id')).toBe('pub-gamma')
  })
})

// ---------------------------------------------------------------- 结果 tab 开关

describe('结果 tab 开关（地址栏工具行+关闭+回退）', () => {
  let exportsClient: ReturnType<typeof makeExportsClient>

  beforeEach(async () => {
    exportsClient = makeExportsClient()
    exportsClient.rows.push(
      exportsRow('image-1', 'pub-alpha', '2026-10-02T08:30:00.000Z'),
      exportsRow('image-2', 'pub-beta', '2026-10-02T08:40:00.000Z'),
    )
    resetMyTasksForTests(exportsClient.client)
    bindAgentApi(stubApi({ frames: doneFrames() }))
    await initAgentStore()
    mountPanel()
    await waitUntil(() => qq('[data-testid="task-detail-export-row"]').length === 2)
  })

  it('导出行点击→结果 tab 激活：地址栏工具行在场+网址=/r/{publicId}+iframe sandbox 同 zhumo', async () => {
    click('[data-testid="task-detail-export-row"]')
    await waitUntil(() => q('[data-testid="task-detail-result-toolbar"]') !== null)
    expect(tabState('task-detail-content').state).toBe('inactive')

    const url = q('[data-testid="task-detail-result-url"]') as HTMLInputElement | null
    expect(url?.value).toBe(`${location.origin}/r/pub-alpha`)
    // 地址栏六件套：后退/前进/刷新/网址/外链/关闭。
    for (const part of ['back', 'forward', 'reload', 'external', 'close']) {
      expect(q(`[data-testid="task-detail-result-${part}"]`)).not.toBeNull()
    }

    const frame = q('[data-testid="task-detail-result-frame"]')
    expect(frame?.getAttribute('src')).toBe(`${location.origin}/r/pub-alpha`)
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-popups')
  })

  it('地址栏「关闭标签」→回详情（工具行退场，结果 tab 仍在）', async () => {
    click('[data-testid="task-detail-export-row"]')
    await waitUntil(() => q('[data-testid="task-detail-result-toolbar"]') !== null)
    click('[data-testid="task-detail-result-close"]')
    await waitUntil(() => q('[data-testid="task-detail-result-toolbar"]') === null)
    expect(tabState('task-detail-content')).toEqual({ hidden: false, state: 'active' })
    // 关闭=回详情，不删导出（结果 tab 触发器仍在——可再开）。
    expect(qq('[data-testid="task-detail-tab-result"]')).toHaveLength(2)
  })

  it('刷新后导出消失（重导/撤销）→活动结果 tab 回退详情+对应结果 tab 退场', async () => {
    // 进入 pub-alpha 结果 tab，再刷新清单模拟重导（image-1 换新 publicId）。
    qq('[data-testid="task-detail-export-row"]')[0]!.click()
    await waitUntil(() => q('[data-testid="task-detail-result-toolbar"]') !== null)

    exportsClient.rows[0] = exportsRow('image-1', 'pub-new', '2026-10-02T09:00:00.000Z')
    click('[data-testid="task-detail-exports-refresh"]')
    await waitUntil(() => q('[data-testid="task-detail-result-toolbar"]') === null)
    expect(tabState('task-detail-content').state).toBe('active')
    // 结果 tab 集随清单重渲：image-1 → pub-new（旧 pub-alpha 退场），image-2 保留。
    await waitUntil(() => q('[data-testid="task-detail-tab-result"]')?.getAttribute('data-public-id') === 'pub-new')
    expect(qq('[data-testid="task-detail-tab-result"]').map((el) => el.getAttribute('data-public-id'))).toEqual(['pub-new', 'pub-beta'])
  })
})

// ---------------------------------------------------------------- iframe 保活

describe('iframe 保活（bits-ui Tabs 常驻挂载——切走不重载）', () => {
  beforeEach(async () => {
    const exportsClient = makeExportsClient()
    exportsClient.rows.push(
      exportsRow('image-1', 'pub-alpha', '2026-10-02T08:30:00.000Z'),
      exportsRow('image-2', 'pub-beta', '2026-10-02T08:40:00.000Z'),
    )
    resetMyTasksForTests(exportsClient.client)
    bindAgentApi(stubApi({ frames: doneFrames() }))
    await initAgentStore()
    mountPanel()
    await waitUntil(() => qq('[data-testid="task-detail-export-row"]').length === 2)
  })

  it('两结果 tab 各一常驻 iframe；切回详情后 iframe 不卸载（同一 DOM 节点+src 不变+hidden 而非移除）', async () => {
    // bits-ui Tabs.Content 常驻挂载：清单就绪即两 iframe 全在场（未激活走 hidden）。
    await waitUntil(() => qq('[data-testid="task-detail-result-frame"]').length === 2)
    const first = q('[data-testid="task-detail-result-frame"]')!

    // 依次激活两个结果 tab（hidden 切换——节点不新增不重建）。
    qq('[data-testid="task-detail-export-row"]')[0]!.click()
    await waitUntil(
      () => qq('[data-testid="task-detail-result-frame"]')[0]!.closest('[role="tabpanel"]')?.hasAttribute('hidden') === false,
    )
    qq('[data-testid="task-detail-export-row"]')[1]!.click()
    await waitUntil(
      () => qq('[data-testid="task-detail-result-frame"]')[1]!.closest('[role="tabpanel"]')?.hasAttribute('hidden') === false,
    )

    // 切回详情：两 iframe 仍在 DOM、节点身份与 src 不变（保活不重载）。
    click('[data-testid="task-detail-tab-detail"]')
    await waitUntil(() => tabState('task-detail-content').state === 'active')
    const framesAfter = qq('[data-testid="task-detail-result-frame"]')
    expect(framesAfter).toHaveLength(2)
    expect(framesAfter[0]!.isSameNode(first)).toBe(true)
    expect(framesAfter[0]!.getAttribute('src')).toBe(`${location.origin}/r/pub-alpha`)
    expect(framesAfter[1]!.getAttribute('src')).toBe(`${location.origin}/r/pub-beta`)
    // 隐藏机制=hidden 属性（presence.svelte.jsdom 判定链同源），非 display/卸载。
    expect(framesAfter[0]!.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
  })
})

// ---------------------------------------------------------------- 工作台保活（真装载路径）

describe('工作台 tab 保活（MockAgentApi clown 会话——首开挂载/切走不卸载）', () => {
  beforeEach(async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
    await openSession('fixt-session-clown')
  })

  it('详情缺省不挂工作台；入口卡「打开工作台」→tab 激活+紧凑工作台装载（embedded）；切详情再回=同一 DOM 节点（不重载）', async () => {
    const task = getActiveTask()
    expect(task).not.toBeNull()
    mountTracked(TaskDetailPanel, { taskId: task!.taskId })
    await waitUntil(() => q('[data-testid="task-detail-tab-workbench"]') !== null)

    // 缺省详情：工作台未挂载（打开时挂载——懒挂载语义）。
    expect(q('[data-testid="task-workbench"]')).toBeNull()

    click('[data-testid="task-detail-open-workbench-tab"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    const workbench = q('[data-testid="task-workbench"]')!
    expect(workbench.getAttribute('data-embedded')).toBe('true')
    expect(tabState('task-detail-workbench-content')).toEqual({ hidden: false, state: 'active' })

    // 切回详情：工作台 hidden 保活（同节点在场——画布状态不丢）；再回不重载。
    click('[data-testid="task-detail-tab-detail"]')
    await waitUntil(() => tabState('task-detail-content').state === 'active')
    expect(q('[data-testid="task-workbench"]')!.isSameNode(workbench)).toBe(true)
    expect(q('[data-testid="task-workbench"]')!.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    expect(qq('[data-testid="workbench-layer-row"]')).toHaveLength(5)

    click('[data-testid="task-detail-tab-workbench"]')
    await waitUntil(() => tabState('task-detail-workbench-content').state === 'active')
    expect(q('[data-testid="task-workbench"]')!.isSameNode(workbench)).toBe(true)
    expect(qq('[data-testid="workbench-layer-row"]')).toHaveLength(5)
  })
})
