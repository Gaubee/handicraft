/*
 * [rework-layer-model v4] 图层模型 PS 化聚焦测试（波 1-3 验收面）：
 *   [A] 图层即遮罩渲染语义：背景层眼睛开关；hover/选中交互态（虚线/实线描边+
 *       名称标签——常驻零条框已在 view 测试断言）；钻单颗 hover 规格预览（空间索引）；
 *       hitTestNodeAt 显隐传递（隐藏父层=子树不可命中）。
 *   [B] treeView：钻布局虚拟子行（规格+颗数——assignments 派生）；抠图缩略组件在场
 *       （jsdom 无 2d canvas=phase idle 结构面）。
 *   [C] 容器查询工作台：embedded 紧凑形态标记+选中层摘要+完整形态 inspector 共存
 *       （形态切换=纯 CSS 容器查询——真实三形态走真浏览器走查）；⋯ 菜单历史 dock 入口。
 *   [D] 纹理优先缺省决策树（波 3 后半）：未指派叶层推荐首项=texture-fill；
 *       「硬朗+纯色」提示下才展开规整族；指派层策略族选项序纹理优先。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import TaskDetailPanel from '$lib/components/agent/TaskDetailPanel.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import type { TaskDetailResponse } from '@handicraft/contracts'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  hitTestNodeAt,
  resetWorkbenchForTests,
  selectNode,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetCanvasStageForTests, setCanvasViewForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

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

/** pointer 事件（jsdom 无 PointerEvent 时回退 MouseEvent）。 */
function firePointer(el: Element, type: string, clientX: number, clientY: number): void {
  const Ctor = globalThis.PointerEvent ?? MouseEvent
  el.dispatchEvent(new Ctor(type, { clientX, clientY, bubbles: true, cancelable: true }))
}

/** 无指派叶层 fixture（决策树测试面——clown 树去掉全部 assignments）。 */
function unassignedApi(base: MockAgentApi): AgentApi {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
  const original = base.taskDetail.bind(base)
  copy.taskDetail = async (taskId: string): Promise<TaskDetailResponse> => {
    const detail = await original(taskId)
    detail.assignments = []
    return detail
  }
  return copy
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

// ---------------------------------------------------------------- [A] 渲染语义

describe('v4 图层即遮罩渲染语义', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('背景层眼睛开关：隐藏→原图缺席（仅图层/钻）；层显隐不牵连背景', async () => {
    await waitUntil(() => qq('[data-testid^="workbench-layer-item-"]').length === 5)
    expect(q('[data-testid="workbench-base-image"]')).not.toBeNull()
    click('[data-testid="workbench-base-toggle"]')
    await waitUntil(() => q('[data-testid="workbench-base-image"]') === null)
    // 图层与钻仍在（隐藏背景=仅见图层）
    expect(qq('[data-testid^="workbench-layer-item-"]').length).toBe(5)
    expect(q('[data-testid="workbench-layer-gems-n-hat"]')).not.toBeNull()
    click('[data-testid="workbench-base-toggle"]')
    await waitUntil(() => q('[data-testid="workbench-base-image"]') !== null)
  })

  it('选中态：2px 实线描边+名称标签（bbox 顶）——右栏联动同源', async () => {
    await waitUntil(() => qq('[data-testid^="workbench-layer-item-"]').length === 5)
    selectNode('n-hat')
    await waitUntil(() => q('[data-testid="workbench-selection-outline"]') !== null)
    expect(q('[data-testid="workbench-selection-outline"]')?.getAttribute('data-node-id')).toBe('n-hat')
    expect(q('[data-testid="workbench-selection-label"]')?.textContent).toContain('帽子')
    expect(q('[data-testid="workbench-selection-label"]')?.textContent).toContain('7 颗')
    // 层项选中标记（画布命中联动面）
    expect(q('[data-testid="workbench-layer-item-n-hat"]')?.getAttribute('data-selected')).toBe('true')
    selectNode(null)
    await waitUntil(() => q('[data-testid="workbench-selection-outline"]') === null)
  })

  it('hover 态：指针命中帽层→虚线描边（无文字）；钻单颗命中→规格预览 tip', async () => {
    await waitUntil(() => qq('[data-testid^="workbench-layer-item-"]').length === 5)
    // 视口=恒等（scale 1 原点）+overlay 盒 (0,0,800,600)——client=画布坐标
    setCanvasViewForTests({ scale: 1, x: 0, y: 0 })
    const overlay = q('[data-testid="workbench-pointer-overlay"]')!
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    await flush()

    // 帽层钻位（fixture hat 首钻 (40,54) 直径 3mm×ppm2=半径 3px）——钻单颗命中
    firePointer(overlay, 'pointermove', 40, 54)
    await waitUntil(() => q('[data-testid="workbench-gem-hover-tip"]') !== null)
    const tip = q('[data-testid="workbench-gem-hover-tip"]')!
    expect(tip.getAttribute('data-node-id')).toBe('n-hat')
    expect(tip.textContent).toContain('3.0mm')
    expect(tip.textContent).toContain('J-201')
    // hover 层描边（虚线——无文字标签）
    await waitUntil(() => q('[data-testid="workbench-hover-outline"]') !== null)
    expect(q('[data-testid="workbench-hover-outline"]')?.getAttribute('data-node-id')).toBe('n-hat')
    expect(q('[data-testid="workbench-hover-outline"]')?.className).toContain('border-dashed')
    expect(qq('[data-testid="workbench-hover-outline"] text, [data-testid="workbench-hover-outline"] [data-testid*="label"]')).toHaveLength(0)

    // 离场清空（少即是多——无 hover=零条框）
    firePointer(overlay, 'pointerleave', 0, 0)
    await waitUntil(() => q('[data-testid="workbench-hover-outline"]') === null)
    expect(q('[data-testid="workbench-gem-hover-tip"]')).toBeNull()
  })

  it('hitTestNodeAt 显隐传递：隐藏小丑→帽子点位落到根画布层；隐藏根→全树不可命中', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 帽子 mask 条纹命中位（帽内局部 (5,2)：(5+2)%3=1≠0→位 1——精确位面命中）
    expect(hitTestNodeAt(41, 30)).toBe('n-hat')
    // 隐藏小丑=子树整枝跳过（帽/脸/结不再命中）；根画布层仍可命中（底层承接）
    click('[data-testid="workbench-layer-visible-n-clown"]')
    await flush()
    expect(hitTestNodeAt(41, 30)).toBe('n-canvas')
    expect(hitTestNodeAt(60, 40)).toBe('n-canvas')
    click('[data-testid="workbench-layer-visible-n-clown"]')
    await flush()
    expect(hitTestNodeAt(41, 30)).toBe('n-hat')
    // 隐藏根=全树（含全部后代）不可命中
    click('[data-testid="workbench-layer-visible-n-canvas"]')
    await flush()
    expect(hitTestNodeAt(41, 30)).toBeNull()
    expect(hitTestNodeAt(60, 40)).toBeNull()
  })
})

// ---------------------------------------------------------------- [B] treeView

describe('v4 treeView（抠图缩略+钻布局虚拟子行）', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('图层行缩略=抠图组件（LayerCutoutThumb——jsdom 无 2d canvas=结构在场 phase idle/error 面）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 5 行缩略组件在场；根行（画布）无抠图条目=idle；jsdom 下其余层合成缺位也 idle
    const thumbs = qq('[data-testid^="workbench-layer-thumb-"]')
    expect(thumbs.length).toBeGreaterThanOrEqual(5)
    expect(q('[data-testid="workbench-layer-thumb-n-hat"]')).not.toBeNull()
    expect(thumbs.every((thumb) => ['idle', 'loading', 'ready', 'error'].includes(thumb.getAttribute('data-phase') ?? ''))).toBe(true)
  })

  it('钻布局虚拟子行：三产钻层规格+颗数（7/9/4）；折叠层隐藏；非产钻层无子行', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    const hat = q('[data-testid="workbench-layer-gemlayout-n-hat"]')
    expect(hat?.textContent).toContain('J-201')
    expect(hat?.textContent).toContain('3mm')
    expect(hat?.getAttribute('data-gem-count')).toBe('7')
    expect(q('[data-testid="workbench-layer-gemlayout-n-face"]')?.getAttribute('data-gem-count')).toBe('9')
    expect(q('[data-testid="workbench-layer-gemlayout-n-bow"]')?.getAttribute('data-gem-count')).toBe('4')
    // 无钻层（画布/小丑）无虚拟子行
    expect(q('[data-testid="workbench-layer-gemlayout-n-canvas"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-gemlayout-n-clown"]')).toBeNull()
    // 折叠小丑→子层与其钻布局行一并隐藏（树行折叠语义）
    click('[data-testid="workbench-layer-collapse-n-clown"]')
    await waitUntil(() => q('[data-testid="workbench-layer-gemlayout-n-hat"]') === null)
  })
})

// ---------------------------------------------------------------- [C] 容器查询工作台

describe('v4 容器查询工作台（详情=工作台紧凑形态）', () => {
  it('embedded：无顶栏+紧凑摘要（选中层）与完整 inspector 同树共存（形态=纯 CSS 容器查询）', async () => {
    mountView(TaskDetailPanel, { taskId: WORKBENCH_FIXTURE_TASK_ID, onBackToChat: () => {} })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(q('[data-testid="task-workbench"]')?.getAttribute('data-embedded')).toBe('true')
    expect(q('[data-testid="workbench-topbar"]')).toBeNull()
    // 紧凑摘要（选中后）+完整形态 inspector 元素共存——宽度形态由 @container CSS 决定
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-compact-summary"]') !== null)
    expect(q('[data-testid="workbench-compact-summary"]')?.textContent).toContain('帽子')
    expect(q('[data-testid="workbench-inspector"]')).not.toBeNull()
    // 完整工作台入口（纯放大）与继续对话在面板头
    expect(q('[data-testid="task-detail-open-workbench"]')).not.toBeNull()
    expect(q('[data-testid="task-detail-back-chat"]')).not.toBeNull()
  })

  it('⋯ 菜单：历史事务入口展开 dock（紧凑形态收进菜单）+导出/快捷键项', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => q('[data-testid="workbench-topbar"]') !== null)
    expect(q('[data-testid="workbench-more-menu"]')).not.toBeNull()
    click('[data-testid="workbench-more-menu"]')
    await flush()
    expect(q('[data-testid="workbench-more-history"]')).not.toBeNull()
    expect(q('[data-testid="workbench-more-help"]')).not.toBeNull()
    expect(q('[data-testid="workbench-more-export"]')).not.toBeNull()
    // 打开历史→dock 在场（版本计数可见）
    click('[data-testid="workbench-more-history"]')
    await waitUntil(() => q('[data-testid="workbench-tree-history"]') !== null)
    expect(q('[data-testid="workbench-tree-history-count"]')?.textContent).toContain('1 版')
  })
})

// ---------------------------------------------------------------- [D] 纹理优先缺省决策树

describe('v4 纹理优先缺省（Inspector 推荐决策树）', () => {
  beforeEach(() => {
    bindAgentApi(unassignedApi(new MockAgentApi({ speed: 0 })))
  })

  it('未指派叶层：推荐首项=纹理贴图（texture-fill）；规整族仅在「硬朗+纯色」提示下展开', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-recommend"]') !== null)

    // 通用缺省：texture-fill 推荐卡首项（决策树根）
    const primary = q('[data-testid="workbench-recommend-primary"]')
    expect(primary?.textContent).toContain('纹理贴图')
    expect(primary?.textContent).toContain('推荐')
    // 规整族缺省收起（无硬朗/纯色信号不推荐）
    expect(q('[data-testid="workbench-recommend-regular"]')).toBeNull()

    // 「硬朗+纯色」提示展开 → 直线族/参数化几何 低成本解在场
    click('[data-testid="workbench-recommend-regular-toggle"]')
    await waitUntil(() => q('[data-testid="workbench-recommend-regular"]') !== null)
    expect(q('[data-testid="workbench-recommend-regular-straight-line"]')?.textContent).toContain('直线族')
    expect(q('[data-testid="workbench-recommend-regular-geometry"]')?.textContent).toContain('几何')

    // 点推荐首项→进入 texture-fill 参数面（决策树直通）
    click('[data-testid="workbench-recommend-primary"]')
    await waitUntil(() => q('[data-testid="workbench-params-kind"]') !== null)
    expect(q('[data-testid="workbench-params-kind"]')?.textContent).toContain('纹理贴图')
  })

  it('指派层策略族选项序：texture-fill 首位+决策树引导 title（纹理优先缺省表达）', async () => {
    // 用原生 fixture（帽子已指派 texture-fill）
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-kind-select"]') !== null)
    const select = q('[data-testid="workbench-kind-select"]') as HTMLSelectElement
    const first = select.querySelector<HTMLOptionElement>('option:not([disabled])')
    expect(first?.value).toBe('texture-fill')
    expect(select.getAttribute('title')).toContain('纹理贴图=通用缺省')
  })
})
