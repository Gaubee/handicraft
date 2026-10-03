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
import type { LayerSplitInput, SegmentOneOutput } from '@handicraft/contracts'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import { bindAgentApi, initAgentStore, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  getSelectedNodeId,
  getWorkbenchDetail,
  getWorkbenchNodes,
  renameLayer,
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

/** 失焦（P2-5 草稿校验触发面——onblur 直挂元素，非冒泡）。 */
function blur(selector: string): void {
  const input = q(selector) as HTMLInputElement | null
  if (input === null) throw new Error(`输入不存在：${selector}`)
  input.dispatchEvent(new Event('blur'))
}

/** Escape 键（bits-ui EscapeLayer 挂 document keydown——P2-3 关窗闸测试面）。 */
function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

function click(selector: string): void {
  const el = q(selector) as HTMLButtonElement | null
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

/** RPC spy 面：记录 layerSplit 全部入参（dryRun/precision/layerName 断言源）。 */
function spyLayerSplit(): { api: AgentApi; calls: LayerSplitInput[] } {
  const base = new MockAgentApi({ speed: 0 })
  // 原型链代理（不污染 MockAgentApi.prototype——旧写法 Object.assign(getPrototypeOf(base), base)
  // 会把 spy 直接挂上类原型，跨测试串状态：后测试的 layerSplit 经原型命中前测试的 spy 链，
  // 服务于前测试 base 的已突变 state——Codex R1 修复批实证（trial 回传树引用与 detail 漂移））
  const copy = Object.create(base) as AgentApi
  const original = base.layerSplit.bind(base)
  const calls: LayerSplitInput[] = []
  copy.layerSplit = async (input: LayerSplitInput) => {
    calls.push(JSON.parse(JSON.stringify(input)) as LayerSplitInput)
    return original(input)
  }
  return { api: copy, calls }
}

/** 可闸 mock：指定面（trial/land）的 layerSplit 挂起至 release()（忙碌态时序构造——P2-3）。 */
function gatedLayerSplit(mode: 'trial' | 'land'): { api: AgentApi; calls: LayerSplitInput[]; release(): void } {
  const base = new MockAgentApi({ speed: 0 })
  const copy = Object.create(base) as AgentApi // 同 spyLayerSplit——不污染类原型
  const original = base.layerSplit.bind(base)
  const calls: LayerSplitInput[] = []
  const pending: Array<() => void> = []
  copy.layerSplit = (input: LayerSplitInput): Promise<SegmentOneOutput> => {
    calls.push(JSON.parse(JSON.stringify(input)) as LayerSplitInput)
    if ((mode === 'trial') === (input.dryRun === true)) {
      return new Promise<SegmentOneOutput>((resolve) => {
        pending.push(() => resolve(original(input)))
      })
    }
    return original(input)
  }
  return { api: copy, calls, release: () => pending.shift()?.() }
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
    // P1：试跑快照在场（树引用=试跑响应原样回传的当前树）
    const trialTreeRef = getActiveSegmentTask()?.trialSnapshot?.treeBlobRef
    expect(trialTreeRef).toBe(getWorkbenchDetail()?.tree?.blobRef ?? null)

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
    // P1：确认请求携带试跑基线树引用（=试跑响应 treeBlobRef=当时电流树）
    expect(calls[1]!.trialTreeBlobRef).toBe(trialTreeRef)
    // 树断言：新子层挂 n-hat 下+自定义名+segmentPrompt 指令原文+自动选中
    const landed = getWorkbenchNodes().find((node) => node.objectName === '帽尖高光')
    expect(landed).toBeDefined()
    expect(landed!.parent).toBe('n-hat')
    expect(landed!.segmentPrompt).toBe('把帽尖拆出来')
    expect(getSelectedNodeId()).toBe(landed!.id)
    // T4.3：新子层行渲染指令次行（弱化文案）
    expect(q(`[data-testid="workbench-layer-prompt-${landed!.id}"]`)?.textContent).toContain('把帽尖拆出来')
  })

  it('参数面（P2-5 草稿语义）：空=跟随配置；非法=失焦错误呈现且不参与试跑；草稿独立不清空；同参重跑=replayed', async () => {
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
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')

    // P2-5 核心：全选替换逐字输入中间态不清空——「6」保持草稿（旧缺陷：值从 precision
    // 衍生，<32 解析为 null → 控件被清空无法继续输入「64」）
    setText('[data-testid="workbench-segment-mask-max-side"]', '6')
    expect((q('[data-testid="workbench-segment-mask-max-side"]') as HTMLInputElement).value).toBe('6')
    // 失焦校验：非法（6<32）=错误呈现，不参与试跑（试跑按钮禁用、零 RPC）
    blur('[data-testid="workbench-segment-mask-max-side"]')
    await flush()
    expect(q('[data-testid="workbench-segment-mask-max-side-error"]')?.textContent).toContain('≥32')
    click('[data-testid="workbench-segment-trial"]')
    await flush()
    expect(calls).toHaveLength(1) // 非法值不参与试跑——不发起 RPC
    // 修好（64）→ 失焦提交（precision 变化触发 P1 作废→回 draft）→ 试跑携带 64
    setText('[data-testid="workbench-segment-mask-max-side"]', '64')
    expect((q('[data-testid="workbench-segment-mask-max-side"]') as HTMLInputElement).value).toBe('64')
    blur('[data-testid="workbench-segment-mask-max-side"]')
    await flush()
    expect(q('[data-testid="workbench-segment-mask-max-side-error"]')).toBeNull()
    expect(getActiveSegmentTask()?.status).toBe('draft') // P1：参数漂移=旧预览作废
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 2)
    expect(calls[1]!.precision).toEqual({ maskMaxSide: 64 })
    // 同参（同 precision 键）重跑=mock 账本回放标记（等试跑收束回 preview-ready）
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 3)
    expect(calls[2]!.precision).toEqual({ maskMaxSide: 64 })
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

describe('Codex R1 修复批（P1 绑定确认/P2-3 忙碌关窗）', () => {
  /** 开任务+跑一次试跑到 preview-ready（共用前置）。 */
  async function trialToPreview(calls: LayerSplitInput[]): Promise<void> {
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    setText('[data-testid="workbench-segment-instruction"]', '把帽尖拆出来')
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 1)
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
  }

  it('P1 参数变更：改指令=回 draft+预览作废+确认禁用+提示重试跑；layerName 改名不作废；重试跑恢复', async () => {
    const { api, calls } = spyLayerSplit()
    bindAgentApi(api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    await trialToPreview(calls)
    expect((q('[data-testid="workbench-segment-apply"]') as HTMLButtonElement).disabled).toBe(false)

    // layerName 不参与对比（T5 账本语义：不入指纹——改名不需要重试跑）
    setText('[data-testid="workbench-segment-layer-name"]', '自定义名')
    await flush()
    expect(getActiveSegmentTask()?.status).toBe('preview-ready')
    expect((q('[data-testid="workbench-segment-apply"]') as HTMLButtonElement).disabled).toBe(false)

    // 改指令=与快照漂移：回 draft+旧预览作废+确认禁用+提示
    setText('[data-testid="workbench-segment-instruction"]', '把帽带拆出来')
    await flush()
    const task = getActiveSegmentTask()
    expect(task?.status).toBe('draft')
    expect(task?.trialResult).toBeNull()
    expect(q('[data-testid="workbench-segment-trial-result"]')).toBeNull() // 旧预览作废
    expect((q('[data-testid="workbench-segment-apply"]') as HTMLButtonElement).disabled).toBe(true)
    expect(q('[data-testid="workbench-segment-stale-note"]')?.textContent).toContain('参数已变更，请重新试跑')

    // 重试跑（新参数）→ preview-ready 恢复+提示消失+确认可点
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 2)
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    expect(q('[data-testid="workbench-segment-stale-note"]')).toBeNull()
    expect((q('[data-testid="workbench-segment-apply"]') as HTMLButtonElement).disabled).toBe(false)
    expect(calls[1]!.hint).toBe('把帽带拆出来')
  })

  it('P1 树漂移：试跑后树被别处改（rename 推进树引用）=确认禁用+提示+不发落地 RPC；重试跑携带新基线落地', async () => {
    const { api, calls } = spyLayerSplit()
    bindAgentApi(api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    await trialToPreview(calls)

    // 试跑后树被别处改过（agent/用户 rename → detail.tree.blobRef 推进）
    const ok = await renameLayer('n-hat', '帽子（他处改名）')
    expect(ok).toBe(true)
    await flush()
    expect(q('[data-testid="workbench-segment-tree-drifted"]')?.textContent).toContain('重新试跑')
    expect((q('[data-testid="workbench-segment-apply"]') as HTMLButtonElement).disabled).toBe(true)
    expect(calls).toHaveLength(1) // 确认禁用=落地 RPC 不发

    // 重试跑：快照更新到新树基态 → 提示消失+确认恢复 → 落地携带新基线（服务端守卫通过）
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => calls.length === 2)
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    expect(q('[data-testid="workbench-segment-tree-drifted"]')).toBeNull()
    const refBeforeApply = getWorkbenchDetail()?.tree?.blobRef ?? null
    click('[data-testid="workbench-segment-apply"]')
    await waitUntil(() => getWorkbenchNodes().length === 6)
    expect(calls[2]!.trialTreeBlobRef).toBe(refBeforeApply) // 落地携带=试跑时基线
  })

  it('P2-3 忙碌态：试跑中 Escape 不关+X 关闭钮隐藏；preview-ready 后 Escape 可关', async () => {
    const gated = gatedLayerSplit('trial')
    bindAgentApi(gated.api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    setText('[data-testid="workbench-segment-instruction"]', '把帽尖拆出来')
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => getActiveSegmentTask()?.status === 'trialing')
    // 试跑中：Escape 不关、X 隐藏、取消禁用
    pressEscape()
    await flush()
    expect(q('[data-testid="workbench-segment-dialog"]')).not.toBeNull()
    expect(q('[data-slot="dialog-close"]')).toBeNull()
    expect((q('[data-testid="workbench-segment-cancel"]') as HTMLButtonElement).disabled).toBe(true)
    // 收束到 preview-ready 后：Escape 可关（关窗仅清非忙碌态）
    gated.release()
    await waitUntil(() => getActiveSegmentTask()?.status === 'preview-ready')
    pressEscape()
    await flush()
    expect(q('[data-testid="workbench-segment-dialog"]')).toBeNull()
  })

  it('P2-3 落地中：Escape/取消不关窗——在途 RPC 收束后自动关', async () => {
    const gated = gatedLayerSplit('land')
    bindAgentApi(gated.api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    await trialToPreview(gated.calls)
    click('[data-testid="workbench-segment-apply"]')
    await waitUntil(() => getActiveSegmentTask()?.status === 'landing')
    pressEscape()
    await flush()
    expect(q('[data-testid="workbench-segment-dialog"]')).not.toBeNull() // 落地中不关
    expect((q('[data-testid="workbench-segment-cancel"]') as HTMLButtonElement).disabled).toBe(true)
    gated.release()
    await waitUntil(() => getWorkbenchNodes().length === 6) // 落地完成=子层入树
    await waitUntil(() => q('[data-testid="workbench-segment-dialog"]') === null) // 自动关
  })
})
