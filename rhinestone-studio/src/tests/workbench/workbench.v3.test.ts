/*
 * [add-workbench-pro v3] Owner 走查整改聚焦测试：
 *   [A] PS 式三栏布局——图层行精简（缩略图/名/眼睛/锁定；无参数串/策略徽标堆叠）+
 *       右栏 WorkbenchInspector 在场+底部历史事务 dock 在场；
 *   [B] 钻选择器——task.detail.stoneCandidates 色板渲染/选中态反查（既有指派 idx 高亮）/
 *       多选应用随 layer.strategy.set stoneIdx 提交（mock 通道回填 StonePick 真源）；
 *   [C] 预览三模式——工具条切换（holes/numbered/rendered）+画布 data-gem-mode 渲染变体
 *       （numbered=分组色+图例+组徽标；holes=冲孔视觉+底图淡化）+previewMode 服务端化
 *       （view.state.set 写透——刷新/换端保持）；
 *   [D] 历史事务——mock journey 基线版预置（历史面即时非空）+dock 展开装载版本链+
 *       操作后续链增长+回退确认→tree.revert 全刷回滚。
 * 挂载模式沿 workbench.2c.test.ts 先例（MockAgentApi speed=0）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  confirmTreeRevert,
  fetchTreeHistory,
  getPreviewMode,
  getStoneCandidates,
  getTreeHistoryState,
  getWorkbenchAssignments,
  loadWorkbench,
  renameLayer,
  resetWorkbenchForTests,
  selectNode,
  setPreviewMode,
} from '$lib/components/studio/taskWorkbench/store.svelte'
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

let api: MockAgentApi

beforeEach(() => {
  resetAgentStoreForTests()
  initAgentStore()
  api = new MockAgentApi({ speed: 0 })
  bindAgentApi(api)
  resetViewForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  document.body.innerHTML = ''
})

afterEach(() => {
  mountedDisposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------- [A] 三栏布局

describe('v3 三栏布局（PS 式）', () => {
  it('三区在场：左图层/中画布/右属性+底部历史 dock；图层行无参数串与策略徽标', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(q('[data-testid="workbench-layer-slot"]')).not.toBeNull()
    expect(q('[data-testid="workbench-inspector-slot"]')).not.toBeNull()
    expect(q('[data-testid="workbench-inspector"]')).not.toBeNull()
    expect(q('[data-testid="workbench-canvas-stage"]')).not.toBeNull()
    expect(q('[data-testid="workbench-tree-history"]')).not.toBeNull()

    // 图层行精简：无行内参数串/策略族徽标（信息过杂根因整改）——细节全在右侧
    expect(qq('[data-testid^="workbench-layer-params-"]').length).toBe(0)
    expect(qq('[data-testid^="workbench-layer-kind-"]').length).toBe(0)
    // 眼睛/锁定图标在场（PS 图层行惯例）
    expect(qq('[data-testid^="workbench-layer-visible-"]').length).toBe(5)
    expect(qq('[data-testid^="workbench-layer-lock-"]').length).toBe(5)
  })

  it('行 hover 摘要 tooltip（策略/用钻/密度收进 title——右侧属性面板承载细节）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    const hatRow = qq('[data-testid="workbench-layer-row"]').find((row) => row.getAttribute('data-node-id') === 'n-hat')!
    expect(hatRow.getAttribute('title')).toContain('texture-fill')
    expect(hatRow.getAttribute('title')).toContain('J-201')
  })

  it('属性面板基本信息：选中帽子→类别/尺寸/覆盖率可见；未选层=引导态', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(q('[data-testid="workbench-params-empty"]')).not.toBeNull()

    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    const info = q('[data-testid="workbench-inspector-info"]')
    expect(info?.textContent).toContain('clothing')
    expect(info?.textContent).toContain('mm')
    expect(info?.textContent).toContain('掩码覆盖')
  })
})

// ---------------------------------------------------------------- [B] 钻选择器

describe('v3 钻选择器（候选表色板——stoneIdx 指派流）', () => {
  it('候选表装载（12 款多彩色板）+选中态反查（帽子既有指派 J-201 → idx1 高亮）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(getStoneCandidates().length).toBe(12)
    expect(getStoneCandidates()[0]).toMatchObject({ idx: 1, sku: 'J-201 朱红', sizeMm: 3 })

    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)

    expect(q('[data-testid="workbench-stone-picker"]')?.querySelectorAll('button[data-testid^="workbench-stone-"]').length).toBe(12)
    // 反查高亮：帽子指派 J-201（idx=1）选中态
    expect(q('[data-testid="workbench-stone-1"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="workbench-stone-2"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('多选应用：选 idx4（鎏金）+idx1 → stoneIdx 随 strategy.set 提交→指派钻真源替换', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)

    click('[data-testid="workbench-stone-4"]') // 鎏金（多选追加——idx1 已在选中集）
    await flush()
    click('[data-testid="workbench-apply-strategy"]')
    await waitUntil(() => {
      const assignment = getWorkbenchAssignments().find((a) => a.nodeId === 'n-hat')
      return assignment !== undefined && assignment.stones.length === 2
    })
    const stones = getWorkbenchAssignments().find((a) => a.nodeId === 'n-hat')!.stones
    expect(stones.map((stone) => stone.sku).sort()).toEqual(['A-801 鎏金', 'J-201 朱红'])
    // mock 服务态持久：detail 面反映 stoneIdx 回填的 StonePick 真源
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.assignments.find((a) => a.nodeId === 'n-hat')?.stones.map((s) => s.sku).sort()).toEqual(['A-801 鎏金', 'J-201 朱红'])
  })

  it('候选表为空=引导文案（不阻塞）；未选钻沿用既有指派（stoneIdx 缺省继承）', async () => {
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
    const before = getWorkbenchAssignments().find((a) => a.nodeId === 'n-hat')!.stones.map((s) => s.sku)
    // 不触碰钻选择器，仅改密度应用——指派钻不变（服务端继承语义）
    selectNode('n-hat')
    const { applyLayerStrategy } = await import('$lib/components/studio/taskWorkbench/store.svelte')
    const ok = await applyLayerStrategy('n-hat', 'texture-fill', { mode: 'flow', polarity: 'dark-dense', fallbackEngineStrategy: 'hex-pitch' }, 3.5)
    expect(ok).toBe(true)
    const after = getWorkbenchAssignments().find((a) => a.nodeId === 'n-hat')!.stones.map((s) => s.sku)
    expect(after).toEqual(before)
  })
})

// ---------------------------------------------------------------- [C] 预览三模式

describe('v3 预览三模式（holes/numbered/rendered——渲染变体+服务端化）', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('缺省=rendered（成钻渲染：渐变光泽）+工具条三档切换', async () => {
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 20)
    expect(getPreviewMode()).toBe('rendered')
    expect(q('[data-testid="workbench-preview-rendered"]')?.getAttribute('aria-pressed')).toBe('true')
    const gem = q('[data-testid="strategy-gem"]')!
    expect(gem.getAttribute('data-gem-mode')).toBe('rendered')
    expect(gem.getAttribute('fill')).toMatch(/^url\(#wb-gem-grad/)

    expect(q('[data-testid="workbench-preview-holes"]')).not.toBeNull()
    expect(q('[data-testid="workbench-preview-numbered"]')).not.toBeNull()
  })

  it('holes 模式：孔洞视觉（深孔+浅内缘）+底图淡化（opacity≤0.1）', async () => {
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 20)
    click('[data-testid="workbench-preview-holes"]')
    await flush()
    expect(getPreviewMode()).toBe('holes')
    const gem = q('[data-testid="strategy-gem"]')!
    expect(gem.getAttribute('data-gem-mode')).toBe('holes')
    expect(gem.getAttribute('fill')).toBe('#20242C')
    expect(gem.getAttribute('stroke')).toBe('#C7CEDB')
    const base = q('[data-testid="strategy-base-image"]')!
    expect(Number(base.getAttribute('opacity'))).toBeLessThanOrEqual(0.1)
  })

  it('numbered 模式：分组色孔+组徽标+图例（色块=图层名+编号区间）', async () => {
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 20)
    click('[data-testid="workbench-preview-numbered"]')
    await flush()
    expect(getPreviewMode()).toBe('numbered')
    expect(qq('[data-testid="strategy-gem"]').every((gem) => gem.getAttribute('data-gem-mode') === 'numbered')).toBe(true)

    const legend = q('[data-testid="strategy-gem-legend"]')
    expect(legend).not.toBeNull()
    // 图例行=三个产钻层（帽子/脸蛋/蝴蝶结——画布层无钻不在列）
    const rows = qq('[data-testid="strategy-gem-legend-row"]')
    expect(rows.length).toBe(3)
    expect(legend?.textContent).toContain('帽子')
    expect(legend?.textContent).toContain('#1-')
    // 组徽标（层 bbox 中心编号 1..3）
    expect(qq('[data-testid="strategy-gem-group-badge"]').length).toBe(3)
  })

  it('previewMode 服务端化：切换→view.state.set 写透→重装载保持（刷新不丢）', async () => {
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 20)
    click('[data-testid="workbench-preview-numbered"]')
    await flush()
    // 写透经 viewWriteChain 串行排队——等服务态工件可见
    await new Promise((resolve) => setTimeout(resolve, 60))
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.viewState?.previewMode).toBe('numbered')

    // 重装载（刷新路径）：模式从服务端工件读回
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID, { refresh: true })
    expect(getPreviewMode()).toBe('numbered')
  })
})

// ---------------------------------------------------------------- [D] 历史事务

describe('v3 历史事务（底部 dock——journey 基线+版本链+回退全刷）', () => {
  it('mock journey 基线预置：dock 收起条显版本计数；展开=时间线装载（v1 journey）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => q('[data-testid="workbench-tree-history-count"]') !== null)
    // 收起态：计数常显（可见性提升——不展开也可见规模）
    expect(q('[data-testid="workbench-tree-history-body"]')).toBeNull()
    expect(q('[data-testid="workbench-tree-history-count"]')?.textContent).toContain('1 版')

    click('[data-testid="workbench-tree-history-toggle"]')
    await waitUntil(() => q('[data-testid="workbench-tree-history-timeline"]') !== null)
    const rows = qq('[data-testid="workbench-tree-history-row"]')
    expect(rows.length).toBe(1)
    expect(rows[0]?.getAttribute('data-version')).toBe('1')
    expect(rows[0]?.textContent).toContain('会话产树')
    // 单版本=当前版本：无回退按钮
    expect(qq('[data-testid^="workbench-tree-revert-"]').length).toBe(0)
  })

  it('操作后续链增长（dock 开着自动刷新）+回退确认→tree.revert 全刷回滚', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 装载预取已在链（v1 journey）——展开 dock
    click('[data-testid="workbench-tree-history-toggle"]')
    await waitUntil(() => qq('[data-testid="workbench-tree-history-row"]').length === 1)
    expect(getTreeHistoryState().versions.map((v) => v.cause)).toEqual(['journey'])

    // dock 开着时结构写→自动续链（noteStructureWrite→fetchTreeHistory）
    expect(await renameLayer('n-hat', '魔术帽')).toBe(true)
    await waitUntil(() => qq('[data-testid="workbench-tree-history-row"]').length === 2)

    // 回退到 v1（journey 基线=改名前）：确认面列出将一并回退的 v2
    click('[data-testid="workbench-tree-revert-1"]')
    await waitUntil(() => q('[data-testid="workbench-revert-confirm"]') !== null)
    expect(q('[data-testid="workbench-revert-confirm"]')?.textContent).toContain('1 个后续版本')
    click('[data-testid="workbench-revert-confirm-ok"]')
    await waitUntil(() => {
      const state = getTreeHistoryState()
      return state.versions.length === 3 && state.versions.at(-1)?.cause === 'revert'
    })
    // 回退后全刷：树回到「帽子」（journey 基线快照）
    const { getWorkbenchNodes } = await import('$lib/components/studio/taskWorkbench/store.svelte')
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')?.objectName).toBe('帽子')
    expect(getTreeHistoryState().versions.map((v) => v.cause)).toEqual(['journey', 'rename', 'revert'])
  })

  it('柳树任务同构：journey 基线预置（两 fixture 通道一致）', async () => {
    await loadWorkbench('fixt-task-willow-1')
    await fetchTreeHistory()
    expect(getTreeHistoryState().versions.length).toBeGreaterThan(0)
    expect(getTreeHistoryState().versions[0]?.cause).toBe('journey')
  })
})
