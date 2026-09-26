/*
 * [add-workbench-pro 2.1-2.3] 工作台专业化 jsdom 交互测试（波 2b）。
 * 覆盖：视图态服务端所有权（显隐/折叠/锁定 view.state.set 写透+重装载读回——刷新
 * /换端不丢）；导出门（exportGate 阻断禁用+blockers 呈现+放行导出）；遮罩可视化
 * （24×24 缩略图 inline|blob 两态渐进+选中层高亮填充+4096 incomplete 徽标）；
 * 笔刷最小编辑闭环（B 键进入→涂抹收集→撤销一笔→提交→layer.mask.patch→
 * mask/bbox/ gems 重算+editState 徽标）。挂载模式沿 workbench.view.test.ts 先例。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  beginStroke,
  endStroke,
  extendStroke,
  exportTask,
  getBrushSession,
  getExportGate,
  getWorkbenchCanvasModel,
  resetWorkbenchForTests,
  undoLastStroke,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetCanvasStageForTests, setCanvasViewForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

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

function click(selector: string): void {
  const el = q(selector) as HTMLButtonElement | null
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

/** 窗口键（快捷键面——designer keymap B/[/]/Esc 同源语义）。 */
function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** pointer 事件（jsdom 无 PointerEvent 时回退 MouseEvent——坐标字段同名）。 */
function firePointer(el: Element, type: string, clientX: number, clientY: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (globalThis as any).PointerEvent ?? MouseEvent
  el.dispatchEvent(new Ctor(type, { clientX, clientY, bubbles: true, cancelable: true }))
}

let api: MockAgentApi

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetCanvasStageForTests()
  resetViewForTests('studio')
  resetToastsForTests()
  api = new MockAgentApi({ speed: 0 })
  bindAgentApi(api as AgentApi)
  await initAgentStore()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

// ---------------------------------------------------------------- 视图态（2.1）

describe('视图态服务端所有权（view.state.set 写透+装载读回）', () => {
  it('显隐/折叠/锁定写透服务端——重装载（新 store 会话）后不丢', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // 显隐：隐藏帽子→点阵 13+框线 4（写透 view.state.set）
    click('[data-testid="workbench-layer-visible-n-hat"]')
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 13)
    // 锁定：帽子锁上（图标 aria-pressed——折叠前行必须在场）
    click('[data-testid="workbench-layer-lock-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-layer-lock-n-hat"]')?.getAttribute('aria-pressed') === 'true')
    // 折叠：画布折叠→仅根行
    click('[data-testid="workbench-layer-collapse-n-canvas"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 1)

    // 服务端工件在场（task.detail.viewState 读面——revision 链≥3）
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.viewState).not.toBeNull()
    expect(detail.viewState!.revision).toBeGreaterThanOrEqual(3)
    const hatState = detail.viewState!.nodes.find((n) => n.nodeId === 'n-hat')
    expect(hatState).toMatchObject({ visible: false, locked: true })
    expect(detail.viewState!.nodes.find((n) => n.nodeId === 'n-canvas')).toMatchObject({ collapsed: true })

    // 刷新模拟：卸载+store 复位（新浏览器会话等价）→重装载读回三面
    mountedDisposers.splice(0).forEach((dispose) => dispose())
    document.body.innerHTML = ''
    resetWorkbenchForTests()
  resetCanvasStageForTests()
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 1)
    expect(qq('[data-testid="strategy-gem"]').length).toBe(13) // 帽子隐藏读回
    click('[data-testid="workbench-layer-collapse-n-canvas"]') // 展开→5 行读回
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(q('[data-testid="workbench-layer-lock-n-hat"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

// ---------------------------------------------------------------- 导出门（2.1）

describe('导出门（exportGate 呈现+task.export 接线）', () => {
  it('阻断态（stale+incomplete 演示造数）：按钮禁用+blockers 就近呈现+本地预拒', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => q('[data-testid="workbench-topbar"]') !== null)
    expect(getExportGate().allowed).toBe(false)
    expect(getExportGate().blockers).toEqual(['mask-incomplete', 'mask-stale'])
    const button = q('[data-testid="workbench-export-button"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(q('[data-testid="workbench-export-blockers"]')?.textContent).toContain('mask-incomplete')
    // 本地预拒（门只增不减——无客户端豁免口）
    expect(await exportTask()).toBe(false)
  })

  it('放行态（willow）：导出成功（strategy-gems.json 字节——jsdom 无下载通道跳过 anchor）', async () => {
    mountView(TaskWorkbenchView, { taskId: 'fixt-task-willow-1' })
    await waitUntil(() => q('[data-testid="workbench-topbar"]') !== null)
    await waitUntil(() => (q('[data-testid="workbench-export-button"]') as HTMLButtonElement | null)?.disabled === false)
    expect(await exportTask()).toBe(true)
    expect(q('[data-testid="workbench-export-error"]')).toBeNull()
  })
})

// ---------------------------------------------------------------- 遮罩可视化（2.2）

describe('遮罩可视化（缩略图+选中层高亮+incomplete 徽标）', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('图层行缩略图：inline 即时就绪+blob 渐进（loading→ready）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // inline 四层同步就绪
    expect(q('[data-testid="workbench-mask-thumb-n-hat"]')?.getAttribute('data-phase')).toBe('ready')
    // blob 画布层（120×160 位面经附件通道）异步渐进就绪
    await waitUntil(() => q('[data-testid="workbench-mask-thumb-n-canvas"]')?.getAttribute('data-phase') === 'ready')
  })

  it('选中层蒙版高亮填充（琥珀语义色）+未选中层紫色', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    click('[data-testid="workbench-mask-toggle"]')
    await waitUntil(() => qq('[data-testid="strategy-mask-overlay"]').length === 5)
    const hat = qq('[data-testid="strategy-mask-overlay"]').find((g) => g.getAttribute('data-node-id') === 'n-hat')
    const face = qq('[data-testid="strategy-mask-overlay"]').find((g) => g.getAttribute('data-node-id') === 'n-face')
    expect(hat?.getAttribute('fill')).toBe('#F59E0B')
    expect(face?.getAttribute('fill')).toBe('#7C3AED')
  })

  it('4096 incomplete 显式徽标（demo 造数——n-bow 行程超限禁导出）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    const badge = q('[data-testid="workbench-mask-edit-n-bow"]')
    expect(badge?.textContent).toContain('4096')
    expect(badge?.getAttribute('title')).toContain('禁止导出')
  })
})

// ---------------------------------------------------------------- 笔刷闭环（2.3）

describe('笔刷最小编辑闭环（layer.mask.patch）', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('选中帽子→B 键进入→涂抹（pointer 映射）→[/] 半径→撤销一笔→提交→mask 版本入史+badge 已编辑+点阵重算', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()

    // B 键进入笔刷（designer keymap B=draw 同源）
    pressKey('b')
    await waitUntil(() => q('[data-testid="workbench-brush-toolbar"]') !== null)
    expect(q('[data-testid="workbench-brush-target-bbox"]')).not.toBeNull()

    // 半径：] 步进 +2（12→14）——键面即数值框真源
    pressKey(']')
    await flush()
    expect((q('[data-testid="workbench-brush-radius"]') as HTMLInputElement).value).toBe('14')
    pressKey('[')
    await flush()

    // pointer 涂抹：svg rect 桩 240×320+视口 scale=2（client 120,80 → 画布 60,40——
    // 2c 视口化后映射经 CanvasView：screen = image×scale + (x,y) 的逆）
    setCanvasViewForTests({ scale: 2, x: 0, y: 0 })
    const svg = q('[data-testid="workbench-brush-layer"]') as SVGSVGElement
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(svg as any).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 240, height: 320, right: 240, bottom: 320, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    firePointer(svg, 'pointerdown', 120, 80)
    firePointer(svg, 'pointermove', 132, 88)
    firePointer(svg, 'pointerup', 132, 88)
    await flush()
    expect(getBrushSession().strokes).toHaveLength(1)
    expect(getBrushSession().strokes[0]?.points[0]).toEqual({ x: 60, y: 40 })
    expect(getBrushSession().strokes[0]?.points[1]).toEqual({ x: 66, y: 44 })

    // 第二笔（store 面——快速路径）+撤销最近一笔
    beginStroke({ x: 50, y: 45 })
    extendStroke({ x: 54, y: 47 })
    endStroke()
    expect(getBrushSession().strokes).toHaveLength(2)
    undoLastStroke()
    expect(getBrushSession().strokes).toHaveLength(1)

    // 提交（recomputeStrategy=true——受影响指派重算；先 flush 让按钮脱离禁用态）
    await flush()
    click('[data-testid="workbench-brush-commit"]')
    await waitUntil(() => getBrushSession().strokes.length === 0 && !getBrushSession().active)
    // 版本入史 cause=mask-patch + editState 徽标（ready=已编辑）+ 点阵重算（颗数变化）
    const history = await api.treeHistory({ taskId: WORKBENCH_FIXTURE_TASK_ID })
    expect(history.versions.some((version) => version.cause === 'mask-patch')).toBe(true)
    await waitUntil(() => q('[data-testid="workbench-mask-edit-n-hat"]') !== null)
    expect(q('[data-testid="workbench-mask-edit-n-hat"]')?.textContent).toContain('已编辑')
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length !== 20)
    // 服务端读面同步：exportGate 仍阻（n-face stale/n-bow incomplete 演示留痕未动）
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.exportGate.allowed).toBe(false)
    expect(detail.maskEdits.find((edit) => edit.nodeId === 'n-hat')?.state).toBe('ready')
  })

  it('锁定层拒入笔刷（node-locked 就近提示）+ Esc 退出清笔画', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-lock-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    pressKey('b')
    await flush()
    expect(q('[data-testid="workbench-brush-toolbar"]')).toBeNull()

    // 解锁后可进；Esc 退出并清未提交笔画
    click('[data-testid="workbench-layer-lock-n-hat"]')
    await flush()
    pressKey('b')
    await waitUntil(() => q('[data-testid="workbench-brush-toolbar"]') !== null)
    beginStroke({ x: 60, y: 40 })
    endStroke()
    expect(getBrushSession().strokes).toHaveLength(1)
    pressKey('Escape')
    await flush()
    expect(getBrushSession().active).toBe(false)
    expect(getBrushSession().strokes).toHaveLength(0)
  })

  it('提交失败（CAS 漂移注入）驻留错误——笔画不丢可改后重提', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    pressKey('b')
    await waitUntil(() => q('[data-testid="workbench-brush-toolbar"]') !== null)
    // 服务端先推进（另一端写）——本地 CAS 基线过期
    await api.layerRename({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-bow', objectName: '胸花结' })
    beginStroke({ x: 60, y: 40 })
    endStroke()
    await flush()
    click('[data-testid="workbench-brush-commit"]')
    await waitUntil(() => q('[data-testid="workbench-brush-error"]') !== null)
    expect(q('[data-testid="workbench-brush-error"]')?.textContent).toContain('cas-mismatch')
    expect(getBrushSession().strokes).toHaveLength(1)
    // 画布模型仍可用（错误不炸画布）
    expect(getWorkbenchCanvasModel()).not.toBeNull()
  })
})
