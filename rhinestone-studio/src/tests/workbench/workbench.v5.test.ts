/*
 * [rework-layer-ps-panel v5] PS 图层面板复刻+父层产钻语义聚焦测试：
 *   [A] PS 排序：面板首行=最上层（树前序逆序）；根「画布」行固定面板最底=背景层
 *       （data-root 标记+锁形图标位在场；无折叠 caret）。
 *   [B] 单行节奏：fx 徽标（有钻叶子 ◆+颗数——点击右栏定位）；组 caret/竖向轨道线；
 *       双击行名重命名；v4 钻布局虚拟子行缺席。
 *   [C] 底部操作条：拆分（选中叶子展开提示输入）/删除（确认面）/展开全部/收起全部
 *       （收起全部后仅组行+根行；展开全部还原）。
 *   [D] v5 语义：组直改被拒（mock node-not-leaf 同构 daemon）；组旧指派读面降级
 *       （图层行「组不产钻——已失效」+Inspector 组门+紧凑态组门）；去重口径计数
 *       （父层旧指派的钻不计数不渲染——getEffectiveGemTotal+画布行钻数）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  getBoundAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  applyLayerStrategy,
  getApplyError,
  getEffectiveGemTotal,
  getSelectedNodeId,
  getWorkbenchLayerRender,
  loadWorkbench,
  resetWorkbenchForTests,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetCanvasStageForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})

const mountedDisposers: Array<() => void> = []

function mountView<P extends Record<string, unknown>>(component: Component<P>, props: Partial<P> = {}): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const instance = mount(component, { target, props: props as P })
  mountedDisposers.push(() => {
    unmount(instance)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

function q(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector)
}

function qq(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
}

function click(selector: string): void {
  const el = q(selector)
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

function rowNodeIds(): string[] {
  return qq('[data-testid="workbench-layer-row"]').map((row) => row.getAttribute('data-node-id') ?? '')
}

/** mock 工作台内部状态（旧指派种入——v4 语义产物读面降级测试）。 */
interface MockStateLens {
  detail: {
    assignments: Array<Record<string, unknown>>
    stoneCandidates: Array<{ resourceId: string; sku: string; supplier: string; sizeMm: number | null; colorHex: string }>
    gems: { blobRef: string; count: number; excludedRegions: number } | null
  }
  gemsByRef: Map<string, { gems: Array<Record<string, unknown>> }>
}

function workbenchStateLens(): MockStateLens {
  const api = getBoundAgentApi() as MockAgentApi
  const states = (api as unknown as { workbenchStates: Map<string, MockStateLens> }).workbenchStates
  const state = states.get(WORKBENCH_FIXTURE_TASK_ID)
  if (state === undefined) throw new Error('mock 工作台状态缺席（需先装载一次）')
  return state
}

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetCanvasStageForTests()
  resetViewForTests('studio')
  resetToastsForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  await initAgentStore()
})

afterEach(() => {
  mountedDisposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ''
  localStorage.clear()
})

  // v5 PS 序断言见下方各用例
describe('v5 PS 图层面板（rework-layer-ps-panel）', () => {
  // jsdom 多轮装载/写透 flush 累计可超 vitest 缺省 5s——统一放大到 20s（与 perf.gate 同档裁量）
  vi.setConfig({ testTimeout: 20_000 })

  it('首行=最上层（树前序逆序：bow/face/hat/clown）+根「画布」行固定最底（data-root+锁形图标位+无 caret）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(rowNodeIds()).toEqual(['n-bow', 'n-face', 'n-hat', 'n-clown', 'n-canvas'])
    const rootRow = qq('[data-testid="workbench-layer-row"]').find((row) => row.getAttribute('data-node-id') === 'n-canvas')
    expect(rootRow?.getAttribute('data-root')).toBe('true')
    // 根=背景层：锁形图标位在场（静态——非按钮）；无折叠 caret
    expect(rootRow?.querySelector('[data-testid="workbench-layer-lock-n-canvas"]')).not.toBeNull()
    expect(rootRow?.querySelector('[data-testid="workbench-layer-collapse-n-canvas"]')).toBeNull()
    // 组行（n-clown）有 caret；叶子行无
    expect(q('[data-testid="workbench-layer-collapse-n-clown"]')).not.toBeNull()
    expect(q('[data-testid="workbench-layer-collapse-n-hat"]')).toBeNull()
    // 组行缩略=子层并集合成面标记
    expect(q('[data-testid="workbench-layer-thumb-n-clown"]')?.getAttribute('data-role')).toBe('group-composite')
  })

  // ---------------------------------------------------------------- [B] 单行节奏

  it('单行节奏：无钻布局虚拟子行；fx 徽标颗数（7/9/4）；双击行名进入重命名', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(q('[data-testid="workbench-layer-gemlayout-n-hat"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')?.getAttribute('data-gem-count')).toBe('7')
    expect(q('[data-testid="workbench-layer-fx-n-face"]')?.getAttribute('data-gem-count')).toBe('9')
    expect(q('[data-testid="workbench-layer-fx-n-bow"]')?.getAttribute('data-gem-count')).toBe('4')
    expect(q('[data-testid="workbench-layer-fx-n-clown"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-canvas"]')).toBeNull()

    q('[data-testid="workbench-layer-select-n-hat"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flush()
    expect(q('[data-testid="workbench-rename-input"]')).not.toBeNull()
  })

  // ---------------------------------------------------------------- [C] 底部操作条

  it('底部操作条：收起全部→组行+根行；展开全部→五行还原；拆分按钮展开提示输入', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(q('[data-testid="workbench-layer-bottombar"]')).not.toBeNull()

    click('[data-testid="workbench-layer-collapse-all"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 2)
    expect(rowNodeIds()).toEqual(['n-clown', 'n-canvas'])

    click('[data-testid="workbench-layer-expand-all"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // 拆分按钮：选中叶子后展开提示输入（split-box 在场且含目标层名）
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    expect(q('[data-testid="workbench-split-box"]')?.textContent).toContain('帽子')

    // 删除按钮：走确认面（破坏性=确认）
    click('[data-testid="workbench-layer-delete-selected"]')
    await flush()
    expect(q('[data-testid="workbench-delete-confirm"]')).not.toBeNull()
    click('[data-testid="workbench-delete-confirm-cancel"]')
    await flush()
    expect(q('[data-testid="workbench-delete-confirm"]')).toBeNull()
  })

  // ---------------------------------------------------------------- [D] v5 语义

  it('组直改被拒（node-not-leaf——mock 与 daemon 同构）；叶层直改照常', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    const rejected = await applyLayerStrategy('n-clown', 'texture-fill', { mode: 'scatter' }, 2)
    expect(rejected).toBe(false)
    expect(getApplyError()).toContain('node-not-leaf')

    const ok = await applyLayerStrategy('n-hat', 'texture-fill', { mode: 'scatter' }, 2.3)
    expect(ok).toBe(true)
    expect(getApplyError()).toBeNull()
  })

  it('组旧指派读面降级：图层行/Inspector/紧凑态三面标注「组不产钻——已失效」；去重口径计数', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // 种入 v4 语义父层旧指派（mock 内部状态——daemon 侧 execute 已跳过产块，读面降级）
    const state = workbenchStateLens()
    const stone = state.detail.stoneCandidates[0]!
    state.detail.assignments.push({
      nodeId: 'n-clown',
      strategyKind: 'texture-fill',
      params: { mode: 'scatter' },
      stones: [{
        resourceId: stone.resourceId, sku: stone.sku, supplier: stone.supplier,
        sizeMm: stone.sizeMm, colorHex: stone.colorHex,
      }],
      densityPerCm2: 2.3,
      rationale: 'v4 旧父层指派（测试种入）',
    })
    // 同步种入父层旧钻（v4 gems 工件形态——父层 blockId 的钻在读面必须被去重）
    const gemsRef = state.detail.gems?.blobRef
    if (gemsRef !== undefined && gemsRef !== null) {
      const doc = state.gemsByRef.get(gemsRef)
      if (doc !== undefined) {
        doc.gems.push({ id: 'n-clown#legacy1', x: 40, y: 60, blockId: 'n-clown', diameterMm: 3 } as Record<string, unknown>)
        doc.gems.push({ id: 'n-clown#legacy2', x: 42, y: 62, blockId: 'n-clown', diameterMm: 3 } as Record<string, unknown>)
      }
    }
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID, { refresh: true })

    // 图层行降级标注
    expect(q('[data-testid="workbench-layer-select-n-clown"]')?.textContent).toContain('组不产钻——已失效')

    // Inspector 组门+旧指派失效标注
    click('[data-testid="workbench-layer-select-n-clown"]')
    await flush()
    expect(q('[data-testid="workbench-params-hierarchy"]')?.textContent).toContain('组不产钻——拆分后在子图层指派')
    expect(q('[data-testid="workbench-params-hierarchy-stale"]')?.textContent).toContain('已失效')
    expect(q('[data-testid="workbench-kind-select"]')).toBeNull()
    expect(q('[data-testid="workbench-apply-strategy"]')).toBeNull()

    // 紧凑态组门（agent 详情形态——紧凑摘要承载同语义）
    // （完整形态下紧凑区块 display:none 但 DOM 在场——文本面可断言）
    expect(q('[data-testid="workbench-compact-strategy"]')?.textContent).toContain('组不产钻——拆分后在子图层指派')

    // 去重口径：父层旧钻（2 颗）不计数；渲染模型不归层（画布无叠钻）
    const model = getWorkbenchLayerRender()
    const clownRow = model?.rows.find((row) => row.node.id === 'n-clown')
    expect(clownRow?.gems.length).toBe(0)
    const totalLeafGems = model?.rows.reduce((sum, row) => sum + row.gems.length, 0) ?? 0
    expect(getEffectiveGemTotal()).toBe(totalLeafGems)
    expect(getEffectiveGemTotal()).toBe(20) // 7+9+4——不含父层旧钻 2 颗

    // fx 定位：组无徽标（组不产钻）——叶子徽标在场
    expect(q('[data-testid="workbench-layer-fx-n-clown"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')).not.toBeNull()
    expect(getSelectedNodeId()).toBe('n-clown')
  })
})
