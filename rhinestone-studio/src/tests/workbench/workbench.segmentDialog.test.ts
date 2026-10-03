/*
 * 工作台抠图 Dialog 测试（add-vision-pipeline-v2 T5/D6——jsdom 全流程）。
 * 覆盖：
 *   [1] 全流程：拆分按钮→Dialog→指令+参数→试跑（mock RPC 断言 dryRun=true+precision
 *       载荷+树未变+预览 dataUrl）→命名落地（同参 dryRun=false+layerName）→树新增
 *       子层挂 targetNodeId 下+自定义名+segmentPrompt 指令原文+自动选中。
 *   [2] 参数面：maskMaxSide/confThreshold 空=「跟随配置」（RPC 不带 precision）；
 *       填值=显式覆写透传；同参重跑试跑=replayed 标记（mock 账本回放投影）。
 *   [3] 取消：试跑后取消=树未变；重开=新任务 draft（指令空）——旧任务驻留数组
 *       （队列预埋：任务数组+activeId 切换）。
 *   [4] T4.3：fixture 旧树节点（无 segmentPrompt）零占位渲染；落地新子层带指令次行。
 * 挂载模式沿 workbench.view.test.ts 先例（MockAgentApi+bindAgentApi）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import type { LayerSplitInput } from '@handicraft/contracts'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import { bindAgentApi, initAgentStore, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  getSelectedNodeId,
  getWorkbenchNodes,
  resetWorkbenchForTests,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import {
  closeSegmentTask,
  getActiveSegmentTask,
  getSegmentTasks,
  resetSegmentTasksForTests,
} from '$lib/components/studio/taskWorkbench/segmentTasks.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountView<P extends Record<string, unknown>>(component: Component<P>, props: Partial<P> = {}): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(component, { target, props: props as P })
  mountedDisposers.push(() => {
    unmount(view)
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

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function qq(selector: string): Element[] {
  return [...document.querySelectorAll(selector)]
}

function setText(selector: string, value: string): void {
  const input = q(selector) as HTMLInputElement | null
  if (input === null) throw new Error(`输入不存在：${selector}`)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(selector: string): void {
  const el = q(selector) as HTMLButtonElement | null
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

/** RPC spy 面：记录 layerSplit 全部入参（dryRun/precision/layerName 断言源）。 */
function spyLayerSplit(): { api: AgentApi; calls: LayerSplitInput[] } {
  const base = new MockAgentApi({ speed: 0 })
  const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
  const original = base.layerSplit.bind(base)
  const calls: LayerSplitInput[] = []
  copy.layerSplit = async (input: LayerSplitInput) => {
    calls.push(JSON.parse(JSON.stringify(input)) as LayerSplitInput)
    return original(input)
  }
  return { api: copy, calls }
}

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetSegmentTasksForTests()
  resetViewForTests('studio')
  resetToastsForTests()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('T5 抠图 Dialog 全流程', () => {
  it('试跑（dryRun=true+precision 透传，树未变）→预览→命名落地（同参 dryRun=false+layerName）→子层挂目标下+segmentPrompt 原文', async () => {
    const { api, calls } = spyLayerSplit()
    bindAgentApi(api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    // T4.3 前置：fixture 旧树节点无 segmentPrompt——零占位渲染
    expect(qq('[data-testid^="workbench-layer-prompt-"]')).toHaveLength(0)

    setText('[data-testid="workbench-segment-instruction"]', '把帽尖拆出来')
    setText('[data-testid="workbench-segment-mask-max-side"]', '1536')
    setText('[data-testid="workbench-segment-conf-threshold"]', '0.35')
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => q('[data-testid="workbench-segment-trial-preview"]') !== null)

    // 试跑 RPC 载荷：dryRun=true+precision 显式覆写；树未变
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      taskId: WORKBENCH_FIXTURE_TASK_ID,
      nodeId: 'n-hat',
      hint: '把帽尖拆出来',
      dryRun: true,
      precision: { maskMaxSide: 1536, confThreshold: 0.35 },
    })
    expect(getWorkbenchNodes()).toHaveLength(5)
    expect((q('[data-testid="workbench-segment-trial-preview"]') as HTMLImageElement).src.startsWith('data:image/png;base64,')).toBe(true)
    expect(q('[data-testid="workbench-segment-trial-result"]')?.textContent).toContain('帽子')
    expect(q('[data-testid="workbench-segment-trial-replayed"]')?.textContent).toContain('SAM 实跑')

    // 命名落地：layerName 透传+同参（hint/precision）
    setText('[data-testid="workbench-segment-layer-name"]', '帽尖高光')
    await flush()
    click('[data-testid="workbench-segment-apply"]')
    await waitUntil(() => q('[data-testid="workbench-segment-dialog"]') === null)
    await waitUntil(() => getWorkbenchNodes().length === 6)

    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      nodeId: 'n-hat',
      hint: '把帽尖拆出来',
      precision: { maskMaxSide: 1536, confThreshold: 0.35 },
      layerName: '帽尖高光',
    })
    expect(calls[1]!.dryRun).toBeUndefined() // 确认落地=dryRun 缺省 false
    // 树断言：新子层挂 n-hat 下+自定义名+segmentPrompt 指令原文+自动选中
    const landed = getWorkbenchNodes().find((node) => node.objectName === '帽尖高光')
    expect(landed).toBeDefined()
    expect(landed!.parent).toBe('n-hat')
    expect(landed!.segmentPrompt).toBe('把帽尖拆出来')
    expect(getSelectedNodeId()).toBe(landed!.id)
    // T4.3：新子层行渲染指令次行（弱化文案）
    expect(q(`[data-testid="workbench-layer-prompt-${landed!.id}"]`)?.textContent).toContain('把帽尖拆出来')
  })

  it('参数面：空=跟随配置（RPC 不带 precision）；非法值按空处理', async () => {
    const { api, calls } = spyLayerSplit()
    bindAgentApi(api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()

    setText('[data-testid="workbench-segment-instruction"]', 'hat')
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 1)
    expect(calls[0]!.precision).toBeUndefined() // 空=跟随配置语义

    // 非法 maskMaxSide（<32）→按空处理（跟随配置）
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    setText('[data-testid="workbench-segment-mask-max-side"]', '16')
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 2)
    expect(calls[1]!.precision).toBeUndefined()
    // 合法值回填→透传（等回 preview-ready——trialing 中草稿禁改）
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    setText('[data-testid="workbench-segment-mask-max-side"]', '1024')
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 3)
    expect(calls[2]!.precision).toEqual({ maskMaxSide: 1024 })
    // 同参（同 precision 键）重跑=mock 账本回放标记（等试跑收束回 preview-ready）
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 4)
    expect(calls[3]!.precision).toEqual({ maskMaxSide: 1024 })
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    expect(q('[data-testid="workbench-segment-trial-replayed"]')?.textContent).toContain('账本回放')
  })

  it('取消：试跑后取消=树未变；重开=新任务 draft；任务数组驻留（队列预埋）', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    setText('[data-testid="workbench-segment-instruction"]', '把帽尖拆出来')
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => q('[data-testid="workbench-segment-trial-preview"]') !== null)

    click('[data-testid="workbench-segment-cancel"]')
    await flush()
    expect(q('[data-testid="workbench-segment-dialog"]')).toBeNull()
    expect(getWorkbenchNodes()).toHaveLength(5) // 取消=零树变更

    // 队列预埋：任务数组驻留（放弃的任务不入 active 但可追溯）；重开=新 draft
    expect(getSegmentTasks()).toHaveLength(1)
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    expect(q('[data-testid="workbench-segment-dialog"]')).not.toBeNull()
    expect(getSegmentTasks()).toHaveLength(2)
    const instruction = q('[data-testid="workbench-segment-instruction"]') as HTMLInputElement
    expect(instruction.value).toBe('') // 新任务 draft——不携带旧指令
    closeSegmentTask()
  })
})
