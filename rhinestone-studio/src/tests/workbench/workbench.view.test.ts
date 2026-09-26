/*
 * [add-task-detail-layer-workbench 2.2-2.6] 任务详情工作台 jsdom 交互测试。
 * 覆盖：装载四态（loading/错误+重试/无图层树引导/内容态——小丑 fixture）；
 * 画布三层喂数（原图+框线+点阵——task.detail→StrategyCanvas 投影）；蒙版可视化
 * 开关与逐节点显隐；拆层流（提示输入→layer.split→子层入树+自动选中新子层+
 * 失败重试态）；策略直改流（D-1 直接生效——密度/换族→点阵刷新）；重命名流
 * （inline 编辑→layer.rename→版本入史）；动线（SessionStream done 卡「打开任务详情」
 * →studio 路由→返回 Agent 会话）。挂载模式沿 view.mount.test.ts 先例。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import SessionStream from '$lib/components/agent/SessionStream.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import type { TaskDetailResponse } from '@handicraft/contracts'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import { bindAgentApi, initAgentStore, openSession, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { resetViewForTests, getStudioTaskId, getView } from '$lib/stores/view.svelte'
import { resetWorkbenchForTests } from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

// 三视图共用挂载器（props 形状由调用点保证——测试面不做组件 props 泛型收紧）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountView(component: Component<any>, props: Record<string, unknown> = {}): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(component, { target, props })
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

/** 门控 API（装载态测试）：taskDetail 挂起至 resolve。 */
function gatedApi(base: MockAgentApi): { api: AgentApi; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
  const original = base.taskDetail.bind(base)
  copy.taskDetail = async (taskId: string) => {
    await gate
    return original(taskId)
  }
  return { api: copy, release }
}

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetViewForTests('agent')
  resetToastsForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  await initAgentStore()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('装载四态', () => {
  it('装载态→内容态：taskDetail 在途显示 loading，释放后工作台就位（顶栏+三区）', async () => {
    const { api, release } = gatedApi(new MockAgentApi({ speed: 0 }))
    bindAgentApi(api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await flush()
    expect(q('[data-testid="workbench-loading"]')).not.toBeNull()
    expect(q('[data-testid="workbench-topbar"]')).toBeNull()

    release()
    await waitUntil(() => q('[data-testid="workbench-topbar"]') !== null)
    expect(q('[data-testid="workbench-layer-panel"]')).not.toBeNull()
    expect(q('[data-testid="strategy-canvas"]')).not.toBeNull()
    expect(q('[data-testid="workbench-params-panel"]')).not.toBeNull()
  })

  it('错误态：未知任务装载失败驻留错误卡+重试入口', async () => {
    mountView(TaskWorkbenchView, { taskId: 'fixt-task-unknown' })
    await waitUntil(() => q('[data-testid="workbench-error"]') !== null)
    expect(q('[data-testid="workbench-error"]')?.textContent).toContain('装载失败')
    expect(q('[data-testid="workbench-retry"]')).not.toBeNull()
  })

  it('无图层树引导：tree=null 的任务详情→识图引导卡（回 Agent 会话）', async () => {
    const base = new MockAgentApi({ speed: 0 })
    const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
    copy.taskDetail = async (taskId: string): Promise<TaskDetailResponse> => ({
      task: { id: taskId, title: '只有输入的任务', status: 'done', createdAt: '2026-09-25T00:00:00.000Z' },
      session: null,
      baseImage: null,
      tree: null,
      assignments: [],
      gems: null,
      preview: null,
      viewState: null,
      maskEdits: [],
      exportGate: { allowed: true, blockers: [] },
    })
    bindAgentApi(copy)
    mountView(TaskWorkbenchView, { taskId: 'fixt-task-bare' })
    await waitUntil(() => q('[data-testid="workbench-no-tree"]') !== null)
    expect(q('[data-testid="workbench-no-tree"]')?.textContent).toContain('尚无图层树')
    expect(q('[data-testid="workbench-no-tree-back"]')).not.toBeNull()
  })
})

describe('内容态：task.detail→StrategyCanvas 喂数（小丑 fixture）', () => {
  beforeEach(() => {
    mountedDisposers.splice(0).forEach((dispose) => dispose())
    document.body.innerHTML = ''
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('顶栏：标题/状态/钻数摘要（20 颗·0 留白）', async () => {
    await waitUntil(() => q('[data-testid="workbench-topbar"]') !== null)
    expect(q('[data-testid="workbench-title"]')?.textContent).toContain('小丑贴钻·工作台')
    expect(q('[data-testid="workbench-task-status"]')?.textContent).toContain('done')
    expect(q('[data-testid="workbench-gem-count"]')?.textContent).toContain('20 颗')
  })

  it('画布三层：原图 image+框线 5+点阵 20（颜色=指派 StonePick；ppm=2.00）', async () => {
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 20)
    expect(q('[data-testid="strategy-base-image"]')).not.toBeNull()
    expect(qq('[data-testid="strategy-node-box"]')).toHaveLength(5)
    expect(q('[data-testid="strategy-gem-count"]')?.textContent).toContain('ppm=2.00')
    const hatGem = qq('[data-testid="strategy-gem"]').find((gem) => gem.getAttribute('data-node-id') === 'n-hat')
    expect(hatGem?.getAttribute('fill')).toBe('#D63A2F')
  })

  it('图层树 5 行 + 逐节点显隐（隐藏帽子→点阵 13+框线 4）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-visible-n-hat"]')
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 13)
    expect(qq('[data-testid="strategy-node-box"]')).toHaveLength(4)
  })

  it('蒙版可视化开关：开→半透明行程组入画布（inline mask 投影）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(qq('[data-testid="strategy-mask-overlay"]')).toHaveLength(0)
    click('[data-testid="workbench-mask-toggle"]')
    await waitUntil(() => qq('[data-testid="strategy-mask-overlay"]').length > 0)
    expect(qq('[data-testid="strategy-mask-overlay"]').length).toBe(5)
    const hat = qq('[data-testid="strategy-mask-overlay"]').find((g) => g.getAttribute('data-node-id') === 'n-hat')
    expect(hat?.querySelectorAll('rect').length).toBeGreaterThan(0)
    click('[data-testid="workbench-mask-toggle"]')
    await waitUntil(() => qq('[data-testid="strategy-mask-overlay"]').length === 0)
  })
})

describe('拆层流（2.3 人类抠图）', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('选中帽子→提示「把帽尖拆出来」→子层入树+画布刷新+自动选中新子层', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    expect(q('[data-testid="workbench-split-box"]')?.textContent).toContain('帽子')

    setText('[data-testid="workbench-split-hint"]', '把帽尖拆出来')
    await flush() // 按钮 disabled 由 splitHint 派生——先让渲染追上再点击
    click('[data-testid="workbench-split-apply"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 7)
    expect(qq('[data-testid="strategy-node-box"]')).toHaveLength(7)
    // 提示语派生子层名（mock 语义同真实 SAM text 提示透传）
    expect(q('[data-testid="workbench-layer-select-n-hat-s1a"]')?.textContent).toContain('帽尖')
    expect(q('[data-testid="workbench-layer-select-n-hat-s1b"]')?.textContent).toContain('帽尖·余部')
    // 自动选中首个新子层（参数卡联动目标）
    expect(q('[data-testid="workbench-layer-select-n-hat-s1a"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="strategy-masks-toggle"]')).not.toBeNull()
  })

  it('失败态可重试：首次 split 拒绝→错误驻留→重试成功', async () => {
    const base = new MockAgentApi({ speed: 0 })
    const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
    const original = base.layerSplit.bind(base)
    let calls = 0
    copy.layerSplit = async (input: Parameters<typeof original>[0]) => {
      calls += 1
      if (calls === 1) throw new Error('SAM 桥超时（mock 注入）')
      return original(input)
    }
    bindAgentApi(copy)

    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    setText('[data-testid="workbench-split-hint"]', '把帽尖拆出来')
    await flush()
    click('[data-testid="workbench-split-apply"]')
    await waitUntil(() => q('[data-testid="workbench-split-error"]') !== null)
    expect(q('[data-testid="workbench-split-error"]')?.textContent).toContain('SAM 桥超时')

    click('[data-testid="workbench-split-retry"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 7)
    expect(q('[data-testid="workbench-split-error"]')).toBeNull()
  })
})

describe('策略直改流（2.4 D-1 直接生效）', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('选中帽子→密度 4→应用→点阵即刻刷新+指派摘要更新（不经对话注入）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-params-kind"]') !== null)
    expect(q('[data-testid="workbench-params-kind"]')?.textContent).toContain('纹理贴图')

    setText('[data-testid="workbench-params-field-density"]', '4')
    click('[data-testid="workbench-apply-strategy"]')
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length !== 20)
    // 密度上调→帽层点阵加密（mock 网格重演——颗数上涨）
    expect(qq('[data-testid="strategy-gem"]').length).toBeGreaterThan(20)
    expect(q('[data-testid="workbench-gem-count"]')?.textContent).toContain('颗')
    expect(q('[data-testid="workbench-layer-params-n-hat"]')?.textContent).toContain('4/cm²')
  })

  it('换族直改：帽子→排除→该层点阵移除（20→13）+徽标变排除色语义', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-kind-select"]') !== null)

    const kind = q('[data-testid="workbench-kind-select"]') as HTMLSelectElement
    kind.value = 'exclusion'
    kind.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(q('[data-testid="workbench-params-field-density"]')).toBeNull() // 排除族无密度面

    click('[data-testid="workbench-apply-strategy"]')
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 13)
    expect(q('[data-testid="workbench-layer-kind-n-hat"]')?.textContent).toContain('exclusion')
  })
})

describe('重命名流（2.2 inline 编辑→layer.rename）', () => {
  it('编辑蝴蝶结→回车提交→树行更新+mock 状态持久（再装载仍在）+版本入史', async () => {
    const api = new MockAgentApi({ speed: 0 })
    bindAgentApi(api)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="workbench-layer-rename-n-bow"]')
    await flush()
    setText('[data-testid="workbench-rename-input"]', '胸花结')
    click('[data-testid="workbench-rename-commit"]')
    await waitUntil(() => q('[data-testid="workbench-layer-select-n-bow"]')?.textContent?.includes('胸花结') ?? false)

    // mock 服务态持久：新 API 实例不共享内存，但同一实例再读 detail 反映改名
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.tree?.nodes.find((node) => node.id === 'n-bow')?.objectName).toBe('胸花结')
    // 版本史：rename 入史（cause=rename）
    const history = await api.treeHistory({ taskId: WORKBENCH_FIXTURE_TASK_ID })
    expect(history.currentVersion).toBe(1)
    expect(history.versions[0]?.cause).toBe('rename')
  })
})

describe('任务详情动线（2.1 SessionStream 入口→studio 路由→返回）', () => {
  it('done 卡「打开任务详情」→studio 视图+任务上下文→StudioView 路由进工作台→返回清上下文', async () => {
    await openSession('fixt-session-clown')
    mountView(SessionStream)
    await waitUntil(() => q('[data-testid="open-task-detail"]') !== null)
    click('[data-testid="open-task-detail"]')
    await flush()
    expect(getView()).toBe('studio')
    expect(getStudioTaskId()).toBe(WORKBENCH_FIXTURE_TASK_ID)

    // StudioView 路由：任务上下文→TaskWorkbenchView（非模式选择/引擎实验）
    mountView(StudioView)
    await waitUntil(() => q('[data-testid="workbench-topbar"]') !== null)
    expect(q('[data-testid="studio-mode-select"]')).toBeNull()

    click('[data-testid="workbench-back"]')
    await waitUntil(() => getView() === 'agent')
    expect(getStudioTaskId()).toBeNull()
  })

  it('无任务上下文：StudioView 默认模式选择（任务工作台引导+引擎实验入口）', async () => {
    mountView(StudioView)
    await flush()
    expect(q('[data-testid="studio-mode-select"]')).not.toBeNull()
    expect(q('[data-testid="studio-mode-workbench"]')).not.toBeNull()
    expect(q('[data-testid="studio-mode-engine-enter"]')).not.toBeNull()
  })
})
