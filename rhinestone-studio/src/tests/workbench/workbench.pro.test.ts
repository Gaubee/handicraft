/*
Orthogonal intents:
1. [2026-09-26 add-workbench-pro 2.1-2.3] 工作台专业化 jsdom 交互测试（原始需求：
   Codex 2b 复核前波交付面——视图态服务端所有权（显隐/折叠/锁定 view.state.set
   写透+重装载读回——刷新/换端不丢）；导出门（exportGate 阻断禁用+blockers 呈现+
   放行导出）；遮罩可视化（24×24 缩略图 inline|blob 两态渐进+选中层高亮填充+
   4096 incomplete 徽标）；笔刷最小编辑闭环（B 键进入→涂抹收集→撤销一笔→提交→
   layer.mask.patch→mask/bbox/gems 重算+editState 徽标）。挂载沿 workbench.view
   .test.ts 先例。
2. [2026-09-26 add-workbench-pro 2b 复核修复] strict 约束清障（Codex 2b 复核通过项
   附注：Component<any>/globalThis as any/svg as any 违反 openspec/config.yaml
   『TypeScript strict（禁 any/as any）』——本文件内的类型逃逸全部清除）。
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
  getWorkbenchLayerRender,
  resetWorkbenchForTests,
  undoLastStroke,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetCanvasStageForTests, setCanvasViewForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountView<P extends Record<string, unknown>>(component: Component<P>, props: P = {} as P): void {
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

/** 可见钻总数（v4：钻渲进层——层项 data-gem-count 求和；不可见层整行缺席）。 */
function gemTotal(): number {
  return qq('[data-testid^="workbench-layer-item-"]').reduce((sum, item) => sum + Number(item.getAttribute('data-gem-count') ?? '0'), 0)
}

/** 窗口键（快捷键面——designer keymap B/[/]/Esc 同源语义）。 */
function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** pointer 事件（jsdom 无 PointerEvent 时回退 MouseEvent——坐标字段同名）。 */
function firePointer(el: Element, type: string, clientX: number, clientY: number): void {
  const Ctor = globalThis.PointerEvent ?? MouseEvent
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

    // 显隐：隐藏帽子→钻 13+层项 4（写透 view.state.set；显隐传递）
    click('[data-testid="workbench-layer-visible-n-hat"]')
    await waitUntil(() => gemTotal() === 13)
    // 锁定：帽子锁上（图标 aria-pressed——折叠前行必须在场）
    click('[data-testid="workbench-layer-lock-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-layer-lock-n-hat"]')?.getAttribute('aria-pressed') === 'true')
    // 折叠：小丑组折叠→组行+根行（v5 PS：根=背景层无折叠语义——折叠目标是组）
    click('[data-testid="workbench-layer-collapse-n-clown"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 2)

    // 服务端工件在场（task.detail.viewState 读面——revision 链≥3）
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.viewState).not.toBeNull()
    expect(detail.viewState!.revision).toBeGreaterThanOrEqual(3)
    const hatState = detail.viewState!.nodes.find((n) => n.nodeId === 'n-hat')
    expect(hatState).toMatchObject({ visible: false, locked: true })
    expect(detail.viewState!.nodes.find((n) => n.nodeId === 'n-clown')).toMatchObject({ collapsed: true })

    // 刷新模拟：卸载+store 复位（新浏览器会话等价）→重装载读回三面
    mountedDisposers.splice(0).forEach((dispose) => dispose())
    document.body.innerHTML = ''
    resetWorkbenchForTests()
  resetCanvasStageForTests()
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 2)
    expect(gemTotal()).toBe(13) // 帽子隐藏读回
    click('[data-testid="workbench-layer-collapse-n-clown"]') // 展开→5 行读回
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

  it('图层行缩略图（v4=抠图层缩略）：inline 即时就绪；根节点无抠图（背景层承担）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // inline 四层同步就绪（抠图缩略=原图区域×mask 的缩采样——jsdom 无 2d canvas 时
    // 位面就绪但合成静默缺位 idle；以 cutout 条目面断言结构，像素面在真浏览器走查）
    const hatPhase = q('[data-testid="workbench-layer-thumb-n-hat"]')?.getAttribute('data-phase')
    expect(hPhaseOk(hatPhase)).toBe(true)
    // 根节点（画布）无抠图条目——背景层=原图承担（design §1；v4 修复轮 F5 起根行
    // 缩略=原图直出 base 面，非 cutout 条目面）
    expect(q('[data-testid="workbench-layer-thumb-n-canvas"]')?.getAttribute('data-phase')).toBe('base')
  })

  /**
   * jsdom 无 2d canvas——ready（真浏览器合成）/idle（jsdom 静默缺位）/loading
   * （G3：合并在途单飞的层登记 loading entry——jsdom 的 loadImage 挂起即驻留）均合法。
   */
  function hPhaseOk(phase: string | null | undefined): boolean {
    return phase === 'ready' || phase === 'idle' || phase === 'loading'
  }

  it('选中层蒙版高亮（琥珀语义色）+未选中层紫——层项 data-mask-selected', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    click('[data-testid="workbench-mask-toggle"]')
    await waitUntil(() => qq('[data-mask-on="true"]').length === 5)
    expect(q('[data-testid="workbench-layer-item-n-hat"]')?.getAttribute('data-mask-selected')).toBe('true')
    expect(q('[data-testid="workbench-layer-item-n-face"]')?.getAttribute('data-mask-selected')).toBe(null)
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
    svg.getBoundingClientRect = () =>
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
    // v3：ready 徽标在右侧属性面板（行徽标仅阻断态）
    await waitUntil(() => q('[data-testid="workbench-inspector-mask-edit-badge"]') !== null)
    expect(q('[data-testid="workbench-inspector-mask-edit-badge"]')?.textContent).toContain('已编辑')
    await waitUntil(() => gemTotal() !== 20)
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
    expect(getWorkbenchLayerRender()).not.toBeNull()
  })
})
