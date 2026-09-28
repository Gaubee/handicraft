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
 *   [E] v4 修复轮（Codex P1/P2+MainAgent 定案——/tmp/codex-layer-model-v4-review.md）：
 *       F1 紧凑态策略直改+掩码重算/放弃；F2 双任务视图不串 store（视图归属装载门）；
 *       F3 快捷键可见性门（隐藏工作台不截获）；F5 树根=背景层（眼睛↔工具栏同源）；
 *       F8a 钻空间索引桶边界；F8b 钻子行继承祖先显隐（画布/命中/面板三面）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import TaskDetailPanel from '$lib/components/agent/TaskDetailPanel.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import type { LayerRenameInput, LayerStrategySetInput, TaskDetailResponse } from '@handicraft/contracts'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID, WORKBENCH_FIXTURE_TREE } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  initAgentStore,
  openSession,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests, setView } from '$lib/stores/view.svelte'
import {
  applyLayerStrategy,
  beginStroke,
  commitBrushStrokes,
  confirmDeleteLayer,
  confirmTreeRevert,
  endStroke,
  enterBrushMode,
  getMaskEditOf,
  getPendingDelete,
  getPendingTreeRevert,
  getRenameRequestId,
  getSelectedNodeId,
  getWorkbenchAssignments,
  getWorkbenchDetail,
  getWorkbenchNodes,
  getWorkbenchPhase,
  getWorkbenchTaskId,
  hitTestNodeAt,
  isNodeVisible,
  renameLayer,
  requestDeleteLayer,
  requestTreeRevert,
  retryMaskEditNode,
  resetWorkbenchForTests,
  reorderLayerNode,
  selectNode,
  splitLayer,
  toggleNodeVisible,
  exportTask,
  getExportError,
  loadWorkbench,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { GemSpatialIndex } from '$lib/components/studio/taskWorkbench/layerRender.svelte.js'
import type { LayerRenderRow } from '$lib/components/studio/taskWorkbench/layerRender.svelte.js'
import { resetCanvasStageForTests, setCanvasViewForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { resetToastsForTests, getToasts } from '$lib/stores/toast.svelte'

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

  it('hitTestNodeAt 显隐传递：隐藏小丑→帽子点位无承接（F5：根=背景层不承接命中）；隐藏根（store 面）→全树不可命中', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 帽子 mask 条纹命中位（帽内局部 (5,2)：(5+2)%3=1≠0→位 1——精确位面命中）
    expect(hitTestNodeAt(41, 30)).toBe('n-hat')
    // 隐藏小丑=子树整枝跳过（帽/脸/结不再命中）；根画布=背景层无策略语义不承接
    // （v4 修复轮 F5：选中限图层节点——点根区域=未命中=清空选中）
    click('[data-testid="workbench-layer-visible-n-clown"]')
    await flush()
    expect(hitTestNodeAt(41, 30)).toBeNull()
    expect(hitTestNodeAt(60, 40)).toBeNull()
    click('[data-testid="workbench-layer-visible-n-clown"]')
    await flush()
    expect(hitTestNodeAt(41, 30)).toBe('n-hat')
    // 隐藏根=全树（含全部后代）不可命中（store API 面——根行眼睛自 F5 起驱动背景层）
    toggleNodeVisible('n-canvas')
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

  it('图层行缩略=抠图组件（LayerCutoutThumb——jsdom 无 2d canvas=结构在场 phase idle/loading/error 面；根行=原图缩略 base 面）', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 5 行缩略组件在场（选择器排除 loading 内层占位块——只取缩略容器本身；G3 起
    // 合并在途请求的层会登记 loading entry，内层占位块随行在场属预期）
    const thumbs = qq('[data-testid^="workbench-layer-thumb-"]:not([data-testid^="workbench-layer-thumb-loading-"])')
    expect(thumbs.length).toBeGreaterThanOrEqual(5)
    expect(q('[data-testid="workbench-layer-thumb-n-hat"]')).not.toBeNull()
    expect(thumbs.every((thumb) =>
      ['idle', 'loading', 'ready', 'error', 'base', 'group'].includes((thumb.getAttribute('data-phase') ?? '').split(':')[0]),
    )).toBe(true)
    // v5：组行缩略=子层并集合成面（n-clown=组——group-composite 标记）
    expect(q('[data-testid="workbench-layer-thumb-n-clown"]')?.getAttribute('data-role')).toBe('group-composite')
    // 根行缩略=原图（base 模式——非 cutout 条目面）
    expect(q('[data-testid="workbench-layer-thumb-n-canvas"]')?.getAttribute('data-phase')).toBe('base')
    expect(q('[data-testid="workbench-layer-thumb-n-canvas"]')?.getAttribute('data-role')).toBe('base-image')
  })

  it('v5 fx 徽标：三产钻叶层 ◆+颗数（7/9/4）；非产钻层/组无徽标；点击=右栏定位钻区', async () => {
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 有钻叶子行 fx 徽标（钻=图层特效——颗数微标）
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')?.getAttribute('data-gem-count')).toBe('7')
    expect(q('[data-testid="workbench-layer-fx-n-face"]')?.getAttribute('data-gem-count')).toBe('9')
    expect(q('[data-testid="workbench-layer-fx-n-bow"]')?.getAttribute('data-gem-count')).toBe('4')
    // 组/根行无 fx（组不产钻；根=背景层）
    expect(q('[data-testid="workbench-layer-fx-n-clown"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-canvas"]')).toBeNull()
    // v4 钻布局虚拟子行已移除（单行节奏——元数据收进 fx/tooltip）
    expect(q('[data-testid="workbench-layer-gemlayout-n-hat"]')).toBeNull()
    // 点击 fx=选中层+右栏定位（workbench:fx-focus 事件）
    let focused: string | null = null
    const onFocus = (event: Event): void => {
      focused = (event as CustomEvent<{ nodeId: string }>).detail.nodeId
    }
    window.addEventListener('workbench:fx-focus', onFocus)
    click('[data-testid="workbench-layer-fx-n-hat"]')
    await flush()
    window.removeEventListener('workbench:fx-focus', onFocus)
    expect(focused).toBe('n-hat')
    expect(getSelectedNodeId()).toBe('n-hat')
    // 折叠小丑→子层行（含 fx 徽标）一并隐藏（树行折叠语义）
    click('[data-testid="workbench-layer-collapse-n-clown"]')
    await waitUntil(() => q('[data-testid="workbench-layer-fx-n-hat"]') === null)
  })
})

// ---------------------------------------------------------------- [C] 容器查询工作台

describe('v4 容器查询工作台（详情=工作台紧凑形态）', () => {
  it('embedded：无顶栏+紧凑摘要（选中层）与完整 inspector 同树共存（形态=纯 CSS 容器查询）', async () => {
    // TaskDetailPanel 挂载于 AgentView——装载门（F2）按视图归属：agent 激活才装载
    setView('agent')
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

// ---------------------------------------------------------------- [E] v4 修复轮（F1/F2/F3/F5/F8a/F8b）

/** window keydown 派发（F3——返回事件供 defaultPrevented 断言）。 */
function fireWindowKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

/**
 * Tabs 语义挂载（F3/F2）：bits-ui Tabs.Content=常驻+hidden 属性（非卸载）——测试用
 * 同机制挂载（hidden 容器=该 Tab 非激活的 workbench 实例在场形态）。setView 对应
 * 手动切换容器 hidden 属性（isWorkbenchVisible 的 hidden 链判定同源）。
 */
function mountInTab<P extends Record<string, unknown>>(component: Component<P>, props: Partial<P> = {}): { target: HTMLDivElement; setTabActive(active: boolean): void } {
  const target = document.createElement('div')
  target.setAttribute('hidden', '') // 初始=非激活 Tab（调用方按需激活）
  document.body.appendChild(target)
  const instance = mount(component, { target, props: props as P })
  mountedDisposers.push(() => {
    unmount(instance)
    target.remove()
  })
  return {
    target,
    setTabActive(active: boolean): void {
      if (active) target.removeAttribute('hidden')
      else target.setAttribute('hidden', '')
    },
  }
}

describe('v4 修复轮 F1：紧凑工作台关键操作（策略直改+掩码重算/放弃）', () => {
  it('紧凑摘要就地完成策略更改（族+密度→应用直接生效）——与完整态同一 task 状态面；params 含族判别值（G1/Codex 二轮 P1-1）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-compact-strategy"]') !== null)

    // 紧凑策略区：族选择（决策树序首项 texture-fill）+密度草稿回指派真值
    const select = q('[data-testid="workbench-compact-strategy-select"]') as HTMLSelectElement
    expect(select.value).toBe('texture-fill')
    expect((q('[data-testid="workbench-compact-strategy-density"]') as HTMLInputElement).value).not.toBe('')

    // 完成一次策略更改：换 geometry 族+密度 3.3 → 应用（applyLayerStrategy 同一写路径）
    select.value = 'geometry'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    const density = q('[data-testid="workbench-compact-strategy-density"]') as HTMLInputElement
    density.value = '3.3'
    density.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    click('[data-testid="workbench-compact-strategy-apply"]')
    await waitUntil(() => {
      const assignment = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-hat')
      return assignment?.strategyKind === 'geometry'
    })
    // 与完整态同一 task 状态：assignments 同源读得同一指派（模块真源面——detail 快照
    // 不随直改回填 assignments，写路径以 assignments/gemsDoc 为准）
    const assignment = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-hat')
    expect(assignment?.densityPerCm2).toBe(3.3)
    expect(getWorkbenchDetail()?.gems).not.toBeNull()
    // G1（Codex 二轮 P1-1）：daemon 族 schema 对判别联合族要求必需判别值——紧凑请求
    // 的 params 必含判别键（此前传 {} 在真实 daemon 必被 params-invalid 拒、mock 假绿）
    expect(assignment?.params).toEqual({ shape: 'star' })

    // 判别联合第二族（texture-fill=mode）+ 无判别族（soft-curve={} 即合法）
    select.value = 'texture-fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    click('[data-testid="workbench-compact-strategy-apply"]')
    await waitUntil(() => {
      const found = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-hat')
      return found?.strategyKind === 'texture-fill'
    })
    expect(getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-hat')?.params).toEqual({ mode: 'scatter' })
    select.value = 'soft-curve'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    click('[data-testid="workbench-compact-strategy-apply"]')
    await waitUntil(() => {
      const found = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-hat')
      return found?.strategyKind === 'soft-curve'
    })
    expect(getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-hat')?.params).toEqual({})
  })

  it('stale 留痕层：紧凑态重算——真点击+终态断言（ready 收敛+恢复链命令消失）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // fixture 造数：n-face=stale（编辑基线漂移）
    click('[data-testid="workbench-layer-select-n-face"]')
    await waitUntil(() => q('[data-testid="workbench-compact-mask-edit"]') !== null)
    expect(getMaskEditOf('n-face')?.state).toBe('stale')
    // 真点击重算（修复轮一只断言在场——G1 补真点击+终态）
    click('[data-testid="workbench-compact-mask-retry"]')
    await waitUntil(() => getMaskEditOf('n-face')?.state === 'ready')
    // 终态：stale 阻断面消失（该节点的恢复链区块退场；n-bow incomplete 仍属其自身行）
    await waitUntil(() => q('[data-testid="workbench-compact-mask-edit"]') === null)
    expect(getWorkbenchDetail()?.maskEdits.find((edit) => edit.nodeId === 'n-face')?.state).toBe('ready')
  })

  it('incomplete 留痕层：紧凑态放弃告警——真点击+终态断言（行移除+门阻减一）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // fixture 造数：n-bow=incomplete（行程 4096 超限——放弃面向阻断留痕）
    click('[data-testid="workbench-layer-select-n-bow"]')
    await waitUntil(() => q('[data-testid="workbench-compact-mask-edit"]') !== null)
    expect(getMaskEditOf('n-bow')?.incomplete).toBe(true)
    const blockersBefore = getWorkbenchDetail()?.exportGate.blockers ?? []
    // 真点击放弃（mask 保持现状——仅清告警/门阻断面）
    click('[data-testid="workbench-compact-mask-discard"]')
    await waitUntil(() => getMaskEditOf('n-bow') === null)
    await waitUntil(() => q('[data-testid="workbench-compact-mask-edit"]') === null)
    // 终态：门阻收敛（mask-incomplete 消失；n-face 的 mask-stale 仍在——两行独立）
    const blockersAfter = getWorkbenchDetail()?.exportGate.blockers ?? []
    expect(blockersAfter).toEqual(blockersBefore.filter((blocker) => blocker !== 'mask-incomplete'))
  })
})

describe('v4 修复轮 F2：双任务视图不串 store（视图归属装载门）', () => {
  const TASK_A = WORKBENCH_FIXTURE_TASK_ID
  const TASK_B = 'fixt-task-willow-1'

  it('后台实例不装载；视图切换时 store.taskId 校验重载——A/B 来回各自显示自己的任务与各自修改', async () => {
    // Studio（view=studio）开任务 A；Agent 面板挂任务 B（agent 视图未激活）
    mountView(TaskWorkbenchView, { taskId: TASK_A })
    mountView(TaskDetailPanel, { taskId: TASK_B, onBackToChat: () => {} })
    await waitUntil(() => getWorkbenchTaskId() === TASK_A && getWorkbenchDetail()?.task.id === TASK_A)

    // 后台实例（B）不得装载覆盖前台（Codex P1-2 场景：嵌入工作台加载 B 覆盖共享态）
    await flush(60)
    expect(getWorkbenchTaskId()).toBe(TASK_A)

    // 在 A 上完成一次修改（rename 帽子——mock 状态持久；nodes 模块面即时演进）
    await renameLayer('n-hat', '帽子·A改')
    await flush()
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')?.objectName).toBe('帽子·A改')

    // 切 agent → B 的嵌入工作台接管装载（store.taskId 校验不符即重载）
    setView('agent')
    await waitUntil(() => getWorkbenchDetail()?.task.id === TASK_B)
    expect(getWorkbenchTaskId()).toBe(TASK_B)

    // 切回 studio → A 重载（选中被清=装载语义；修改持久——mock 状态演进不丢）
    setView('studio')
    await waitUntil(() => getWorkbenchDetail()?.task.id === TASK_A)
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')?.objectName).toBe('帽子·A改')

    // 再切 agent → B 仍在（来回切换不串任务）
    setView('agent')
    await waitUntil(() => getWorkbenchDetail()?.task.id === TASK_B)
    setView('studio')
    await waitUntil(() => getWorkbenchDetail()?.task.id === TASK_A)
  })

  it('同任务双实例（纯放大）：视图切换不重载——选中会话保留（「详情=工作台」同会话语义）', async () => {
    mountView(TaskWorkbenchView, { taskId: TASK_A })
    mountView(TaskDetailPanel, { taskId: TASK_A, onBackToChat: () => {} })
    await waitUntil(() => getWorkbenchDetail()?.task.id === TASK_A)
    selectNode('n-hat')
    await flush()
    setView('agent')
    await flush(80)
    // 同 taskId：装载门跳过（无重装载）——选中保留
    expect(getWorkbenchTaskId()).toBe(TASK_A)
    expect(getSelectedNodeId()).toBe('n-hat')
  })
})

describe('v4 修复轮二 G2：异步写命令任务代次栅栏（Codex 二轮 P1-2 延迟响应交错）', () => {
  const TASK_A = WORKBENCH_FIXTURE_TASK_ID
  const TASK_B = 'fixt-task-willow-1'

  /**
   * 延迟响应宿主：指定写 RPC 的响应挂起至手动放行（mock 状态即时演进=服务端已
   * 落库、前端响应迟到——Codex 点名的「A 在途时切 B」交错窗口）。
   */
  function deferredApi(base: MockAgentApi): { api: AgentApi; releaseRename(): void; releaseStrategy(): void } {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
    let releaseRename: () => void = () => {}
    let releaseStrategy: () => void = () => {}
    const gateRename = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    const gateStrategy = new Promise<void>((resolve) => {
      releaseStrategy = resolve
    })
    const originalRename = base.layerRename.bind(base)
    const originalStrategy = base.layerStrategySet.bind(base)
    copy.layerRename = async (input: LayerRenameInput) => {
      const output = await originalRename(input)
      await gateRename
      return output
    }
    copy.layerStrategySet = async (input: LayerStrategySetInput) => {
      const output = await originalStrategy(input)
      await gateStrategy
      return output
    }
    return { api: copy, releaseRename, releaseStrategy }
  }

  it('rename 延迟响应跨任务切换：A 在途→切 B 装载→放回 A 响应——B 的 nodes/detail/undo 不被污染；A 数据在切回时读回', async () => {
    const deferred = deferredApi(new MockAgentApi({ speed: 0 }))
    bindAgentApi(deferred.api)
    mountView(TaskWorkbenchView, { taskId: TASK_A })
    await waitUntil(() => getWorkbenchTaskId() === TASK_A && getWorkbenchPhase() === 'ready')

    // A 的 rename 在途（不 await——响应被 gate 挂住）
    const renamePromise = renameLayer('n-hat', '帽子·A改')
    // 切 B：agent 视图激活 → 嵌入实例装载 B（taskId+loadSeq 推进）
    mountView(TaskDetailPanel, { taskId: TASK_B, onBackToChat: () => {} })
    setView('agent')
    await waitUntil(() => getWorkbenchTaskId() === TASK_B && getWorkbenchPhase() === 'ready')

    // 放回 A 的迟到响应——栅栏失守（跨任务）：放弃写（返回 false），B 单例不被污染
    deferred.releaseRename()
    await expect(renamePromise).resolves.toBe(false)
    expect(getWorkbenchTaskId()).toBe(TASK_B)
    expect(getWorkbenchDetail()?.task.id).toBe(TASK_B)
    expect(getWorkbenchNodes().some((node) => node.objectName === '帽子·A改')).toBe(false)
    expect(getWorkbenchDetail()?.tree?.blobRef ?? 'no-tree').not.toContain('rename')

    // 切回 studio → A 重载：rename 已在服务端（mock 状态）落库——真源读回
    setView('studio')
    await waitUntil(() => getWorkbenchDetail()?.task.id === TASK_A)
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')?.objectName).toBe('帽子·A改')
  })

  it('策略重算延迟响应跨任务切换：A 在途→切 B 装载→放回响应——B 的 assignments/gems 工件不被污染', async () => {
    const deferred = deferredApi(new MockAgentApi({ speed: 0 }))
    bindAgentApi(deferred.api)
    mountView(TaskWorkbenchView, { taskId: TASK_A })
    await waitUntil(() => getWorkbenchTaskId() === TASK_A && getWorkbenchPhase() === 'ready')

    const applyPromise = applyLayerStrategy('n-hat', 'geometry', { shape: 'star' }, 3.3)
    mountView(TaskDetailPanel, { taskId: TASK_B, onBackToChat: () => {} })
    setView('agent')
    await waitUntil(() => getWorkbenchTaskId() === TASK_B && getWorkbenchPhase() === 'ready')
    const bAssignments = JSON.parse(JSON.stringify(getWorkbenchAssignments())) as unknown[]
    const bGemsRef = getWorkbenchDetail()?.gems?.blobRef ?? null

    // 放回 A 的迟到响应——栅栏失守：不写 gemsDoc/assignments/detail（taskArtifact
    // 后续请求亦不发出——用捕获 task id 的写面在栅栏处即被拦）
    deferred.releaseStrategy()
    await expect(applyPromise).resolves.toBe(false)
    expect(getWorkbenchTaskId()).toBe(TASK_B)
    expect(getWorkbenchDetail()?.task.id).toBe(TASK_B)
    expect(getWorkbenchAssignments()).toEqual(bAssignments)
    expect(getWorkbenchDetail()?.gems?.blobRef ?? null).toBe(bGemsRef)
    // B 的 undo 域不受 A 的 noteUndoAction('strategy-param') 推进：当前无 A 残留指派前值
    expect(getWorkbenchAssignments().some((assignment) => assignment.nodeId === 'n-hat' && assignment.strategyKind === 'geometry')).toBe(false)
  })
})

describe('v4 修复轮 F3：快捷键可见性门（隐藏工作台不截获）', () => {
  it('工作台就绪但 Tab 隐藏（lab/agent 场景）→ ⌘Z/Delete/F2/Alt+↓/?/空格 不截获不触发命令', async () => {
    // view=studio：studio Tab 激活装载（mountInTab 初始 hidden——先激活再等装载）
    const tab = mountInTab(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    setView('studio')
    tab.setTabActive(true)
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    selectNode('n-hat')
    const renameBefore = getRenameRequestId()

    // 切 lab：studio Tabs.Content hidden（bits-ui 同机制——容器 hidden 属性）
    setView('lab')
    tab.setTabActive(false)
    await flush()
    expect(fireWindowKey('z', { metaKey: true }).defaultPrevented).toBe(false)
    expect(fireWindowKey('Delete').defaultPrevented).toBe(false)
    expect(fireWindowKey('F2').defaultPrevented).toBe(false)
    expect(fireWindowKey('ArrowDown', { altKey: true }).defaultPrevented).toBe(false)
    expect(fireWindowKey('?').defaultPrevented).toBe(false)
    expect(fireWindowKey(' ', { code: 'Space' }).defaultPrevented).toBe(false)
    // 无命令副作用（删除确认面未开/重命名未触发）
    expect(q('[data-testid="workbench-delete-confirm"]')).toBeNull()
    expect(getRenameRequestId()).toBe(renameBefore)

    // 切 agent（studio Tab 同式 hidden）
    setView('agent')
    await flush()
    expect(fireWindowKey('z', { metaKey: true }).defaultPrevented).toBe(false)
    expect(fireWindowKey('Delete').defaultPrevented).toBe(false)

    // 切回 studio（Tab 重新激活）→ 命令恢复接管
    setView('studio')
    tab.setTabActive(true)
    await flush()
    expect(fireWindowKey('F2').defaultPrevented).toBe(true)
    expect(getRenameRequestId()).toBe(renameBefore + 1)
  })

  it('双实例在场：仅可见实例响应（隐藏 studio 实例不截获 Delete）', async () => {
    const studioTab = mountInTab(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    const agentTab = mountInTab(TaskDetailPanel, { taskId: WORKBENCH_FIXTURE_TASK_ID, onBackToChat: () => {} })
    setView('studio')
    studioTab.setTabActive(true)
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length >= 5)
    selectNode('n-hat')
    // view=agent：studio Tab hidden（放行）——agent Tab（embedded）激活接管 Delete
    setView('agent')
    studioTab.setTabActive(false)
    agentTab.setTabActive(true)
    await flush()
    expect(fireWindowKey('Delete').defaultPrevented).toBe(true)
    await waitUntil(() => qq('[data-testid="workbench-delete-confirm"]').length >= 1)
  })
})

describe('v4 修复轮 F5：树根=背景层（眼睛↔工具栏同源双向）', () => {
  it('根行眼睛驱动背景显隐：与工具栏背景簇同真源双向同步；根行点击不选中', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 初始：背景在场；根行无选择按钮（选中限图层节点）
    expect(q('[data-testid="workbench-base-image"]')).not.toBeNull()
    expect(q('[data-testid="workbench-layer-select-n-canvas"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-select-n-hat"]')).not.toBeNull()

    // 根行眼睛 → 背景隐藏（工具栏按钮同状态）
    click('[data-testid="workbench-layer-visible-n-canvas"]')
    await waitUntil(() => q('[data-testid="workbench-base-image"]') === null)
    expect(q('[data-testid="workbench-base-toggle"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(q('[data-testid="workbench-layer-visible-n-canvas"]')?.getAttribute('aria-pressed')).toBe('false')
    // 图层与钻不受背景显隐牵连
    expect(qq('[data-testid^="workbench-layer-item-"]').length).toBe(5)

    // 工具栏背景开关（反向）→ 根行眼睛同步恢复
    click('[data-testid="workbench-base-toggle"]')
    await waitUntil(() => q('[data-testid="workbench-base-image"]') !== null)
    expect(q('[data-testid="workbench-layer-visible-n-canvas"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('v4 修复轮 F8a：GemSpatialIndex 桶边界（Codex P2-5）', () => {
  /** 最小渲染行（绝对坐标 gems——空间索引只消费 x/y/radiusPx）。 */
  function rowOf(gems: Array<{ id: string; x: number; y: number; r: number }>, visible = true): LayerRenderRow {
    const node = WORKBENCH_FIXTURE_TREE.nodes[2]! // n-hat（bbox 任意——lx/ly 派生不参与命中）
    return {
      node,
      visible,
      gems: gems.map((gem) => ({ id: gem.id, x: gem.x, y: gem.y, radiusPx: gem.r, colorHex: '#DC2626', nodeId: node.id })),
      groupNo: null,
      groupColor: null,
      gemsStart: 0,
      excluded: false,
      maskRuns: null,
    }
  }

  it('钻心单桶登记缺陷已修：跨 X/Y/角点桶边界的半径命中不漏报', () => {
    // 跨 X：钻心 (64.1,50) r=40——桶 (1,0)；查询 (32,50) 桶 (0,0)：距离 32.1<40 必命中
    const crossX = new GemSpatialIndex([rowOf([{ id: 'g1', x: 64.1, y: 50, r: 40 }])])
    expect(crossX.hitTest(32, 50)?.gem.id).toBe('g1')
    // 跨 Y：钻心 (50,64.1) r=40——查询 (50,32)（距离 32.1<40）
    const crossY = new GemSpatialIndex([rowOf([{ id: 'g1', x: 50, y: 64.1, r: 40 }])])
    expect(crossY.hitTest(50, 32)?.gem.id).toBe('g1')
    // 角点：钻心 (64.1,64.1) r=40——查询 (40,40)（距离 ≈34<40；查询桶 (0,0)，钻心桶 (1,1)）
    const corner = new GemSpatialIndex([rowOf([{ id: 'g1', x: 64.1, y: 64.1, r: 40 }])])
    expect(corner.hitTest(40, 40)?.gem.id).toBe('g1')
    // 半径外仍不命中（精测）
    expect(corner.hitTest(24, 24)).toBeNull()
  })

  it('重叠钻 z 序：后行=上层——命中取桶序末位（行序跨桶一致）', () => {
    const rows = [
      rowOf([{ id: 'bottom', x: 32, y: 32, r: 30 }]),
      rowOf([{ id: 'top', x: 34, y: 34, r: 30 }]),
    ]
    const index = new GemSpatialIndex(rows)
    // 两钻半径内（上层 top 胜）；仅 bottom 半径内的点命中 bottom（(12,12) 到 bottom
    // 28.3<30、到 top 31.1>30——跨桶下 z 序仍=行序）
    expect(index.hitTest(33, 33)?.gem.id).toBe('top')
    expect(index.hitTest(12, 12)?.gem.id).toBe('bottom')
  })

  it('大钻多桶登记：半径 200 的钻覆盖 7×7 桶——各桶均可命中', () => {
    const index = new GemSpatialIndex([rowOf([{ id: 'huge', x: 320, y: 320, r: 200 }])])
    expect(index.hitTest(320, 320)?.gem.id).toBe('huge') // 中心桶
    expect(index.hitTest(140, 320)?.gem.id).toBe('huge') // 左缘（距离 180<200，跨 3 桶）
    expect(index.hitTest(320, 490)?.gem.id).toBe('huge') // 下缘（距离 170<200）
    expect(index.hitTest(530, 320)).toBeNull() // 右外（距离 210>200）
  })
})

describe('v4 修复轮三 H1：free-code 需载荷族直改门（Codex 三轮 P1-1）', () => {
  const WILLOW_TASK = 'fixt-task-willow-1'

  /**
   * n-ribbon 指派 params 改 inline source 形态（daemon 本波可行通道——codeArtifactRef
   * 通道 P3 未接线，persistFreeCodeArtifact 要求 params.source；真源合法性由 daemon 侧
   * workbench.v4-strategy-defaults.test.ts 七族断言把守）。
   */
  function freeCodeSourceApi(base: MockAgentApi): AgentApi {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
    const original = base.taskDetail.bind(base)
    copy.taskDetail = async (taskId: string): Promise<TaskDetailResponse> => {
      const detail = await original(taskId)
      const ribbon = detail.assignments.find((assignment) => assignment.nodeId === 'n-ribbon')
      if (ribbon !== undefined && ribbon.strategyKind === 'free-code') {
        ribbon.params = { source: 'function layout(sandbox){ return []; }', entryPoint: 'layout', seed: 7 }
      }
      return detail
    }
    return copy
  }

  it('紧凑态别族切入 free-code：应用按钮禁用+阻止提示在场——无载荷直改不发出（assignments 不变）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-compact-strategy"]') !== null)
    const before = JSON.parse(JSON.stringify(getWorkbenchAssignments())) as unknown[]

    const select = q('[data-testid="workbench-compact-strategy-select"]') as HTMLSelectElement
    select.value = 'free-code'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    // 阻止面：按钮禁用+就近提示（free-code 需经提案流程提供源码——同 Inspector 语义）
    const apply = q('[data-testid="workbench-compact-strategy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(q('[data-testid="workbench-compact-freecode-blocked"]')?.textContent).toContain('提案流程')
    apply.click() // jsdom disabled 按钮不触发 handler——兜底断言无副作用
    await flush(60)
    expect(getWorkbenchAssignments()).toEqual(before)
  })

  it('紧凑态同族重应用：free-code 原载荷 params 保留（source 不丢）+密度生效', async () => {
    bindAgentApi(freeCodeSourceApi(new MockAgentApi({ speed: 0 })))
    mountView(TaskWorkbenchView, { taskId: WILLOW_TASK })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 6)
    click('[data-testid="workbench-layer-select-n-ribbon"]')
    await waitUntil(() => q('[data-testid="workbench-compact-strategy"]') !== null)
    const select = q('[data-testid="workbench-compact-strategy-select"]') as HTMLSelectElement
    expect(select.value).toBe('free-code') // 草稿回指派真值（同族）
    expect(q('[data-testid="workbench-compact-freecode-blocked"]')).toBeNull() // 同族不被阻止
    const density = q('[data-testid="workbench-compact-strategy-density"]') as HTMLInputElement
    density.value = '2.0'
    density.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    click('[data-testid="workbench-compact-strategy-apply"]')
    await waitUntil(() => {
      const found = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-ribbon')
      return found?.densityPerCm2 === 2
    })
    const assignment = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-ribbon')
    expect(assignment?.strategyKind).toBe('free-code')
    // 原载荷整组保留（H1 核心：不得以 strategyDefaultsOf 的 {} 假装缺省——丢 source 必被真 daemon 拒）
    expect(assignment?.params).toEqual({ source: 'function layout(sandbox){ return []; }', entryPoint: 'layout', seed: 7 })
  })

  it('Inspector：同族 free-code=重应用面（载荷保留）；别族切入=阻止提示无直改按钮', async () => {
    bindAgentApi(freeCodeSourceApi(new MockAgentApi({ speed: 0 })))
    mountView(TaskWorkbenchView, { taskId: WILLOW_TASK })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 6)
    // 同族：n-ribbon 指派 free-code → 重应用面在场（密度+按钮）
    click('[data-testid="workbench-layer-select-n-ribbon"]')
    await waitUntil(() => q('[data-testid="workbench-freecode-direct"]') !== null)
    expect(q('[data-testid="workbench-freecode-reapply"]')).not.toBeNull()
    expect(q('[data-testid="workbench-freecode-blocked"]')).toBeNull()
    click('[data-testid="workbench-freecode-reapply"]')
    await waitUntil(() => {
      const found = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-ribbon')
      return found !== undefined && (found.params as Record<string, unknown>).source !== undefined
    })
    const reapply = getWorkbenchAssignments().find((candidate) => candidate.nodeId === 'n-ribbon')
    expect(reapply?.params).toEqual({ source: 'function layout(sandbox){ return []; }', entryPoint: 'layout', seed: 7 })

    // 别族切入：n-branch（texture-fill 指派）→ 族选择切 free-code → 阻止提示+无重应用按钮
    click('[data-testid="workbench-layer-select-n-branch"]')
    await waitUntil(() => q('[data-testid="workbench-kind-select"]') !== null)
    const kindSelect = q('[data-testid="workbench-kind-select"]') as HTMLSelectElement
    kindSelect.value = 'free-code'
    kindSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await waitUntil(() => q('[data-testid="workbench-freecode-blocked"]') !== null)
    expect(q('[data-testid="workbench-freecode-reapply"]')).toBeNull()
    expect(q('[data-testid="workbench-freecode-blocked"]')?.textContent).toContain('提案流程')
  })
})

describe('v4 修复轮三 H2：异步写命令任务代次栅栏泛化（Codex 三轮 P1-2 延迟响应交错）', () => {
  const TASK_A = WORKBENCH_FIXTURE_TASK_ID
  const TASK_B = 'fixt-task-willow-1'

  type GatedMethod = 'layerSplit' | 'layerReorder' | 'layerDelete' | 'maskEditRetry' | 'layerMaskPatch' | 'treeRevert' | 'viewStateSet' | 'taskExport' | 'treeHistory'

  /**
   * 按方法名 gate 的延迟响应宿主（G2 deferredApi 泛化）：指定写 RPC 的响应挂起至
   * 手动放行（成功放行/失败放行两态）——mock 状态即时演进=服务端已落库、前端响应
   * 迟到（A 在途→切 B 装载→放行 A 响应——Codex 三轮 P1-2 交错窗口逐命令复现）。
   */
  function gatedApi(base: MockAgentApi, method: GatedMethod): { api: AgentApi; release(fail?: boolean): void } {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
    let release!: (fail?: boolean) => void
    const gate = new Promise<void>((resolve, reject) => {
      release = (fail = false) => (fail ? reject(new Error(`${method}（测试注入失败）`)) : resolve())
    })
    const original = (base[method] as (input: never) => Promise<unknown>).bind(base)
    Object.defineProperty(copy, method, {
      value: async (input: never): Promise<unknown> => {
        const output = await original(input)
        await gate
        return output
      },
    })
    return { api: copy, release }
  }

  function mountA(): Promise<void> {
    mountView(TaskWorkbenchView, { taskId: TASK_A })
    return waitUntil(() => getWorkbenchTaskId() === TASK_A && getWorkbenchPhase() === 'ready')
  }

  /** A 在途→切 B 装载（交错窗口）——返回后 store=B 就绪态。 */
  async function switchToB(): Promise<void> {
    mountView(TaskDetailPanel, { taskId: TASK_B, onBackToChat: () => {} })
    setView('agent')
    await waitUntil(() => getWorkbenchTaskId() === TASK_B && getWorkbenchPhase() === 'ready')
  }

  it('split 延迟响应：B 的 nodes 不被 A 子层污染', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'layerSplit')
    bindAgentApi(gated.api)
    await mountA()
    const splitPromise = splitLayer('n-hat', '把帽檐拆出来')
    await switchToB()
    gated.release()
    await expect(splitPromise).resolves.toBe(false)
    expect(getWorkbenchDetail()?.task.id).toBe(TASK_B)
    expect(getWorkbenchNodes().length).toBe(6) // willow 原生 6 节点——A 的 -s1a/-s1b 不入树
    expect(getWorkbenchNodes().some((node) => node.id.includes('-s1'))).toBe(false)
  })

  it('reorder 延迟响应：B 的树引用不被 A 推进——B 下一次结构写的 CAS 基线正确（Codex 点名树引用链）', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'layerReorder')
    bindAgentApi(gated.api)
    await mountA()
    const reorderPromise = reorderLayerNode('n-hat', { newParentId: 'n-canvas', index: 0 })
    await switchToB()
    const bTreeRef = getWorkbenchDetail()?.tree?.blobRef ?? null
    gated.release()
    await expect(reorderPromise).resolves.toBe(false)
    // A 的 output.treeBlobRef 不写进 B 的 detail（否则 B 的 refresh 走 treeUnchanged
    // 分支复用被污染的 prev.tree——B 以 A 的树引用为 CAS 基线）
    expect(getWorkbenchDetail()?.tree?.blobRef ?? null).toBe(bTreeRef)
    // B 下一次结构写（正常完成）：以 B 电流树为基线——mock CAS 门通过即证明基线未污染
    const ok = await reorderLayerNode('n-branch', { newParentId: 'n-canvas', index: 0 })
    expect(ok).toBe(true)
    expect(getWorkbenchNodes().find((node) => node.id === 'n-branch')?.parent).toBe('n-canvas')
  })

  it('delete 延迟响应：B 的 nodes 不被 A 收缩；确认面不泄漏到 B', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'layerDelete')
    bindAgentApi(gated.api)
    await mountA()
    expect(requestDeleteLayer('n-hat')).toBe(true)
    const deletePromise = confirmDeleteLayer()
    await switchToB()
    gated.release()
    await expect(deletePromise).resolves.toBe(false)
    expect(getWorkbenchNodes().length).toBe(6)
    expect(getPendingDelete()).toBeNull()
  })

  it('mask retry 延迟响应：B 的 maskEdits 不被 A 留痕行污染', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'maskEditRetry')
    bindAgentApi(gated.api)
    await mountA()
    const retryPromise = retryMaskEditNode('n-face') // fixture 造数：n-face=stale
    await switchToB()
    gated.release()
    await expect(retryPromise).resolves.toBe(false)
    expect(getWorkbenchDetail()?.maskEdits).toEqual([]) // willow fixture 无留痕——A 的 ready 行不 upsert
    expect(getMaskEditOf('n-face')).toBeNull()
  })

  it('brush patch 延迟响应：B 的 maskEdits/树引用不被 A 污染', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'layerMaskPatch')
    bindAgentApi(gated.api)
    await mountA()
    selectNode('n-hat')
    await flush()
    expect(enterBrushMode()).toBe(true)
    beginStroke({ x: 40, y: 30 })
    endStroke()
    const commitPromise = commitBrushStrokes(true)
    await switchToB()
    const bTreeRef = getWorkbenchDetail()?.tree?.blobRef ?? null
    gated.release()
    await expect(commitPromise).resolves.toBe(false)
    expect(getWorkbenchDetail()?.maskEdits).toEqual([])
    expect(getWorkbenchDetail()?.tree?.blobRef ?? null).toBe(bTreeRef)
  })

  it('view-state 成功延迟响应：B 的 viewRevision 不被 A 写（B 下一次视图写 CAS 不被错基线拒）', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'viewStateSet')
    bindAgentApi(gated.api)
    await mountA()
    toggleNodeVisible('n-hat')
    await flush()
    await switchToB()
    gated.release()
    await flush(80)
    expect(getWorkbenchDetail()?.task.id).toBe(TASK_B)
    // B 下一次视图写（首写语义——viewRevision 应为 null 基线）：成功即证明 A 的
    // revision 未写进 B（否则 expectedRevision 携带 A 代值被 mock CAS 拒并回滚）
    toggleNodeVisible('n-branch')
    await flush(80)
    expect(isNodeVisible('n-branch')).toBe(false) // 本地投影保持=写成功未回滚
  })

  it('view-state 失败延迟响应：A 的旧快照不回滚进 B（失败回滚先验栅栏）', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'viewStateSet')
    bindAgentApi(gated.api)
    await mountA()
    toggleNodeVisible('n-hat') // A 本地投影 hidden={n-hat}（previous 随命令捕获）
    await flush()
    await switchToB() // B 装载重置三面（willow 全可见）
    gated.release(true) // A 的写迟到失败
    await flush(80)
    // A 的 previous={n-hat hidden} 回滚未发生——B 全可见
    expect(isNodeVisible('n-branch')).toBe(true)
    expect(isNodeVisible('n-hat')).toBe(true)
  })

  it('tree revert 延迟响应：B 的 nodes 不被 A 回退结果污染；确认面不泄漏', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'treeRevert')
    bindAgentApi(gated.api)
    await mountA()
    await requestTreeRevert(1)
    const revertPromise = confirmTreeRevert()
    await switchToB()
    gated.release()
    await expect(revertPromise).resolves.toBe(false)
    expect(getWorkbenchNodes().length).toBe(6)
    expect(getPendingTreeRevert()).toBeNull()
  })

  it('requestTreeRevert 发起阶段交错（Codex 四轮 P1）：历史在途切 B——A 的确认面不进 B', async () => {
    // 五轮收紧：gate 需区分两次 treeHistory 调用——第 1 次=loadWorkbench 初始预取
    // （放行使 structureSeeded=true），rename 置回 false 且 dock 关不触发拉取，第 2 次
    // =requestTreeRevert 自己的历史读取（挂住至切 B 后放行——真正锁定发起窗口）。
    const base = new MockAgentApi({ speed: 0 })
    const copy = Object.assign(Object.create(Object.getPrototypeOf(base)), base) as AgentApi
    let calls = 0
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const originalTreeHistory = base.treeHistory.bind(base)
    Object.defineProperty(copy, 'treeHistory', {
      value: async (input: never): Promise<unknown> => {
        calls += 1
        const output = await originalTreeHistory(input)
        if (calls === 2) await secondGate
        return output
      },
    })
    bindAgentApi(copy)
    await mountA()
    expect(calls).toBeGreaterThanOrEqual(1) // 初始预取放行完成
    await renameLayer('n-hat', '临时') // noteStructureWrite → structureSeeded=false（dock 关不拉取）
    const requestPromise = requestTreeRevert(1)
    await switchToB() // 发起窗口：A 的历史读取仍挂在 secondGate
    releaseSecond()
    await requestPromise
    // 栅栏拦截（非换任务清理兜底）：若栅栏缺席，第二次响应作废返回后仍会以 A 的
    // 目标版本建立确认面——此刻 store 已是 B。
    expect(getPendingTreeRevert()).toBeNull()
    expect(getWorkbenchTaskId()).toBe(TASK_B)
  })

  it('exportTask 失败迟到（Codex 四轮 P1）：A 的 exportError 不写进 B', async () => {
    // clown fixture 被造数故意门阻（mask-incomplete/stale）——导出任务用门净的
    // willow 为 A、clown 为 B。
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'taskExport')
    bindAgentApi(gated.api)
    mountView(TaskWorkbenchView, { taskId: TASK_B })
    await waitUntil(() => getWorkbenchTaskId() === TASK_B && getWorkbenchPhase() === 'ready')
    const exportPromise = exportTask()
    mountView(TaskDetailPanel, { taskId: TASK_A, onBackToChat: () => {} })
    setView('agent')
    await waitUntil(() => getWorkbenchTaskId() === TASK_A && getWorkbenchPhase() === 'ready')
    gated.release(true)
    await expect(exportPromise).resolves.toBe(false)
    expect(getExportError()).toBeNull()
  })

  it('exportTask 同任务代次漂移（重装载）：迟到产物不 toast 不落 UI 面', async () => {
    const gated = gatedApi(new MockAgentApi({ speed: 0 }), 'taskExport')
    bindAgentApi(gated.api)
    mountView(TaskWorkbenchView, { taskId: TASK_B })
    await waitUntil(() => getWorkbenchTaskId() === TASK_B && getWorkbenchPhase() === 'ready')
    const exportPromise = exportTask()
    // 同任务 refresh 装载（loadSeq 推进——代次漂移窗口）
    await loadWorkbench(TASK_B, { refresh: true })
    resetToastsForTests()
    gated.release()
    await expect(exportPromise).resolves.toBe(true)
    expect(getExportError()).toBeNull()
    // 五轮收紧：成功 toast 不得越代次串场（迟到产物不提示）。
    expect(getToasts().some((toast) => toast.message.includes('已导出'))).toBe(false)
  })

  it('换任务清确认面（Codex 四轮 P1）：A 的 pendingDelete/pendingTreeRevert 不残留到 B', async () => {
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await mountA()
    // 五轮收紧：两侧确认面都实际建立后再切任务（避免空值旁路）。
    await requestTreeRevert(1)
    requestDeleteLayer('n-hat')
    expect(getPendingTreeRevert()).not.toBeNull()
    expect(getPendingDelete()).not.toBeNull()
    await switchToB()
    expect(getPendingTreeRevert()).toBeNull()
    expect(getPendingDelete()).toBeNull()
  })
})

describe('v4 修复轮 F8b→v5 重定：祖先显隐传递（画布/命中/面板行三面）', () => {
  it('隐藏小丑父层：子层行仍列（面板如实）+画布子树整枝缺席+命中整枝跳过', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')).not.toBeNull()
    click('[data-testid="workbench-layer-visible-n-clown"]')
    await flush()
    // 面板：单行节奏下行仍在场（显隐状态经眼睛图标如实——PS 语义：隐藏层行仍列）
    expect(q('[data-testid="workbench-layer-select-n-hat"]')).not.toBeNull()
    // PS 语义：隐藏祖先不改子层自身眼睛态（继承隐藏仅作用于画布/命中/合成面）
    // 画布：隐藏子树整枝缺席（n-hat/n-face/n-bow；根 n-canvas 在场+小丑 n-clown 行自身）
    expect(q('[data-testid="workbench-layer-item-n-hat"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-item-n-face"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-item-n-bow"]')).toBeNull()
    // 命中：整枝跳过
    expect(hitTestNodeAt(41, 30)).toBeNull()
    click('[data-testid="workbench-layer-visible-n-clown"]')
    await flush()
    expect(q('[data-testid="workbench-layer-item-n-hat"]')).not.toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')).not.toBeNull()
  })
})
