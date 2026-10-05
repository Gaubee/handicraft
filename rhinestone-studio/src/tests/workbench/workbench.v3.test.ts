/*
 * [add-workbench-pro v3] Owner 走查整改聚焦测试：
 *   [A] PS 式三栏布局——图层行精简（缩略图/名/眼睛/锁定；无参数串/策略徽标堆叠）+
 *       右栏 WorkbenchInspector 在场+底部历史事务 dock 在场；
 *   [B] 钻选择器（2026-10-05 Owner 整改：平铺色板网格→选钻 Dialog）——入口+已选缩略
 *       横排/Dialog 装载（分组折叠懒渲染）/搜索过滤/仅看已选/多选应用随
 *       layer.strategy.set stoneIdx 提交（mock 通道回填 StonePick 真源）/真实贴图 src；
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
  getNumberedGroupStrokes,
  getPendingTreeRevert,
  getPreviewMode,
  getStoneCandidates,
  getTreeHistoryState,
  getWorkbenchAssignments,
  getWorkbenchNodes,
  loadWorkbench,
  renameLayer,
  requestTreeRevert,
  resetWorkbenchForTests,
  selectNode,
  setPreviewMode,
  toggleTreeHistoryPanel,
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
  resetViewForTests('studio')
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

/** Dialog 候选格（data-testid=workbench-stone-{数字 idx}——排除组头/托盘等同前缀控件）。 */
function stoneCells(): HTMLElement[] {
  return qq('button[data-testid^="workbench-stone-"]').filter((el) => /^workbench-stone-\d+$/.test(el.dataset.testid ?? ''))
}

function openStoneDialog(): void {
  click('[data-testid="workbench-stone-picker"]')
}

describe('v3 钻选择器（2026-10-05 Owner 整改：平铺网格→选钻 Dialog——搜索/分组/真实贴图）', () => {
  it('入口在场（当前 1 款+已选缩略横排真实贴图 src）→ 开 Dialog：分组视图组默认折叠（懒渲染）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(getStoneCandidates().length).toBe(12)
    expect(getStoneCandidates()[0]).toMatchObject({ idx: 1, sku: 'J-201 朱红', sizeMm: 3 })

    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)
    // 入口标签=指派反查款数；缩略横排=真实贴图（withAuthToken 无 token 原样直出）
    expect(q('[data-testid="workbench-stone-picker-label"]')?.textContent).toContain('当前 1 款')
    expect(q('[data-testid="workbench-stone-strip-img-1"]')?.getAttribute('src')).toBe('/api/stones/stone-j201/texture.png')

    openStoneDialog()
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') !== null)
    // 分组视图缺省：12 族组头在场（每款一族）、格子未渲染（折叠懒渲染——992 款防一次性铺开）
    expect(qq('[data-testid="workbench-stone-group"]').length).toBe(12)
    expect(stoneCells().length).toBe(0)
  })

  it('组折叠展开→选中态反查（J-201 idx1 高亮）+贴图 img src；无贴图款=色块+「无贴图」占位', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)
    openStoneDialog()
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') !== null)

    click('[data-testid="workbench-stone-group"][data-family="红色系"] [data-testid="workbench-stone-group-header"]')
    await flush()
    // 反查高亮：帽子指派 J-201（idx=1）选中态（同组仅此一款）
    expect(q('[data-testid="workbench-stone-1"]')?.getAttribute('aria-pressed')).toBe('true')
    // 真实贴图：img src=textureUrl（jsdom 不解码像素——断 src 形态）
    expect(q('[data-testid="workbench-stone-img-1"]')?.getAttribute('src')).toBe('/api/stones/stone-j201/texture.png')

    // 无贴图款（idx12 N-940 pending）：灰色系组展开=色块占位（无 img）+「无贴图」角标
    expect(q('[data-testid="workbench-stone-img-12"]')).toBeNull()
    click('[data-testid="workbench-stone-group"][data-family="灰色系"] [data-testid="workbench-stone-group-header"]')
    await flush()
    expect(q('[data-testid="workbench-stone-12"]')).not.toBeNull()
    expect(q('[data-testid="workbench-stone-12"]')?.textContent).toContain('无贴图')
  })

  it('搜索过滤：命中「鎏金」→自动展开+仅命中格；「仅看已选」toggle 收窄到已选', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)
    openStoneDialog()
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') !== null)

    const search = q('[data-testid="workbench-stone-search"]') as HTMLInputElement
    search.value = '鎏金'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    // 搜索无视折叠（命中即见）+只渲染命中格（sku/styleName 双命中面——此处 1 款）
    expect(stoneCells().length).toBe(1)
    expect(q('[data-testid="workbench-stone-4"]')).not.toBeNull()
    expect(q('[data-testid="workbench-stone-count"]')?.textContent).toContain('匹配 1/12')

    // 清搜索 → 回折叠全景；开「仅看已选」→ 仅 idx1（帽子既有指派）
    click('[data-testid="workbench-stone-search-clear"]')
    await flush()
    expect(stoneCells().length).toBe(0)
    const only = q('[data-testid="workbench-stone-selected-only"]') as HTMLInputElement
    only.checked = true
    only.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(stoneCells().length).toBe(1)
    expect(q('[data-testid="workbench-stone-1"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('多选应用：全部平铺视图选 idx4（鎏金）→Dialog 应用（已选 2 款文案）→ stoneIdx 随 strategy.set 提交→真源替换+Dialog 关窗', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)
    openStoneDialog()
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') !== null)
    click('[data-testid="workbench-stone-view-all"]')
    await flush()
    expect(stoneCells().length).toBe(12)

    click('[data-testid="workbench-stone-4"]') // 鎏金（多选追加——idx1 已在选中集）
    await flush()
    expect(q('[data-testid="workbench-stone-apply"]')?.textContent).toContain('应用（已选 2 款）')
    // 已选托盘：idx1+idx4 两枚缩略在场
    expect(q('[data-testid="workbench-stone-tray-1"]')).not.toBeNull()
    expect(q('[data-testid="workbench-stone-tray-4"]')).not.toBeNull()

    // 应用走 layerStrategySet 通道——断言请求体 stoneIdx=[1,4]（mock 通道回填 StonePick 真源）
    const strategyCalls: Array<{ stoneIdx?: number[] }> = []
    const original = api.layerStrategySet.bind(api)
    vi.spyOn(api, 'layerStrategySet').mockImplementation(async (input: { stoneIdx?: number[] }) => {
      strategyCalls.push(input)
      return original(input as Parameters<typeof original>[0])
    })
    click('[data-testid="workbench-stone-apply"]')
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') === null) // 成功关窗
    expect(strategyCalls[0]?.stoneIdx).toEqual([1, 4])

    const stones = getWorkbenchAssignments().find((a) => a.nodeId === 'n-hat')!.stones
    expect(stones.map((stone) => stone.sku).sort()).toEqual(['A-801 鎏金', 'J-201 朱红'])
    // mock 服务态持久：detail 面反映 stoneIdx 回填的 StonePick 真源
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.assignments.find((a) => a.nodeId === 'n-hat')?.stones.map((s) => s.sku).sort()).toEqual(['A-801 鎏金', 'J-201 朱红'])
    // 入口横排随真源刷新（idx1+idx4 两枚贴图缩略）
    expect(qq('[data-testid^="workbench-stone-strip-img-"]').length).toBe(2)
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

describe('v3 预览三模式（v4 语义重定：rendered=钻渲进层/holes=只孔洞/numbered=组色+侧栏图例）', () => {
  beforeEach(() => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
  })

  it('缺省=rendered（钻渲进层）+工具条三档切换', async () => {
    await waitUntil(() => qq('[data-testid^="workbench-layer-item-"]').length === 5)
    expect(getPreviewMode()).toBe('rendered')
    expect(q('[data-testid="workbench-preview-rendered"]')?.getAttribute('aria-pressed')).toBe('true')
    // 各层钻子层=rendered 变体（canvas 绘制——结构面 data-gem-mode）
    expect(q('[data-testid="workbench-layer-gems-n-hat"]')?.getAttribute('data-gem-mode')).toBe('rendered')

    expect(q('[data-testid="workbench-preview-holes"]')).not.toBeNull()
    expect(q('[data-testid="workbench-preview-numbered"]')).not.toBeNull()
  })

  it('holes 模式：只孔洞（层内坐标）+底图淡化（opacity≤0.1）+抠图层缺席', async () => {
    await waitUntil(() => qq('[data-testid^="workbench-layer-item-"]').length === 5)
    click('[data-testid="workbench-preview-holes"]')
    await flush()
    expect(getPreviewMode()).toBe('holes')
    expect(q('[data-testid="workbench-layer-gems-n-hat"]')?.getAttribute('data-gem-mode')).toBe('holes')
    // 底图淡化（effective opacity=min(用户值,0.1)）
    const base = q('[data-testid="workbench-base-image"]') as HTMLImageElement | null
    expect(base).not.toBeNull()
    expect((base?.getAttribute('style') ?? '')).toMatch(/opacity:\s*0\.1/)
    // 只孔洞——抠图层缺席（cutout 不渲染）
    expect(q('[data-testid="workbench-layer-cutout-n-hat"]')).toBeNull()
  })

  it('numbered 模式：组色+图例移侧栏（图层面板）+组徽标移除（组色描边可选缺省关）', async () => {
    await waitUntil(() => qq('[data-testid^="workbench-layer-item-"]').length === 5)
    click('[data-testid="workbench-preview-numbered"]')
    await flush()
    expect(getPreviewMode()).toBe('numbered')
    expect(q('[data-testid="workbench-layer-gems-n-hat"]')?.getAttribute('data-gem-mode')).toBe('numbered')

    // 图例在侧栏（图层面板顶部——不压画布）
    const legend = q('[data-testid="workbench-numbered-legend"]')
    expect(legend).not.toBeNull()
    // 图例行=三个产钻层（帽子/脸蛋/蝴蝶结——画布层无钻不在列）
    const rows = qq('[data-testid="workbench-numbered-legend-row"]')
    expect(rows.length).toBe(3)
    expect(legend?.textContent).toContain('帽子')
    // v5：图例行=组号+层名+颗数（逐孔编号稀疏化后区间语义移除——颗数保留）
    expect(legend?.textContent).toContain('帽子 7')
    // v4：组徽标移除（常驻画布零标注——组色描边可选缺省关）
    expect(qq('[data-testid="strategy-gem-group-badge"]').length).toBe(0)
    expect(getNumberedGroupStrokes()).toBe(false)
    // 开关打开=组色描边入画（本地视图偏好——不写服务端）
    click('[data-testid="workbench-numbered-strokes-toggle"]')
    await flush()
    expect(getNumberedGroupStrokes()).toBe(true)
    click('[data-testid="workbench-numbered-strokes-toggle"]')
    await flush()
    expect(getNumberedGroupStrokes()).toBe(false)
  })

  it('previewMode 服务端化：切换→view.state.set 写透→重装载保持（刷新不丢）', async () => {
    await waitUntil(() => qq('[data-testid^="workbench-layer-item-"]').length === 5)
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

// ---------------------------------------------------------------- [E] Codex v3 复核修复回归（F2/F3/F4/F5）

describe('F2 历史面请求隔离（taskId+seq 双锚+pending 补拉）', () => {
  it('首个 history 在途时发生 rename → 完成后自动补拉，链含新版本（写后刷新不被吞）', async () => {
    // 首个请求挂起交付（响应体=发出时刻快照——模拟慢网络在途）
    const original = api.treeHistory.bind(api)
    let gate: (() => void) | null = null
    const gated = new Promise<void>((resolve) => {
      gate = resolve
    })
    let first = true
    vi.spyOn(api, 'treeHistory').mockImplementation(async (input: { taskId: string }) => {
      if (first) {
        first = false
        const snapshot = await original(input) // rename 前的链快照
        await gated // 在途挂起
        return snapshot
      }
      return original(input)
    })

    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 装载预取 fetch1 在途（loading）——开 dock 触发的 fetch2 与 rename 触发的刷新均被 pending 兜住
    toggleTreeHistoryPanel()
    await flush()
    expect(await renameLayer('n-hat', '魔术帽')).toBe(true)
    await flush()
    // 链仍空（fetch1 在途未交付——补拉尚未发生；mock 链仅在 fetch 响应里落地）
    expect(getTreeHistoryState().versions.length).toBe(0)

    gate!() // fetch1 交付（旧快照：不含 rename）
    await waitUntil(() => getTreeHistoryState().versions.length === 2)
    expect(getTreeHistoryState().versions.map((v) => v.cause)).toEqual(['journey', 'rename'])
    expect(getTreeHistoryState().loading).toBe(false)
  })

  it('任务 A 的迟到 history 响应不污染任务 B（换任务后旧响应作废）', async () => {
    const original = api.treeHistory.bind(api)
    let gate: (() => void) | null = null
    const gated = new Promise<void>((resolve) => {
      gate = resolve
    })
    let first = true
    vi.spyOn(api, 'treeHistory').mockImplementation(async (input: { taskId: string }) => {
      if (first && input.taskId === WORKBENCH_FIXTURE_TASK_ID) {
        first = false
        const snapshot = await original(input)
        await gated
        return snapshot
      }
      return original(input)
    })

    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID) // fetchA 发出（gate 挂起）
    await loadWorkbench('fixt-task-willow-1') // 换任务：treeHistory 重置+fetchB 正常落地
    await flush(60) // fetchB（装载预取的 void 调用）落地
    const willowRefs = getTreeHistoryState().versions.map((v) => v.treeBlobRef)
    expect(willowRefs.length).toBeGreaterThan(0)
    expect(getTreeHistoryState().loading).toBe(false)
    // willow 链 ref 均为 willow 工作台产出（不含 clown fixture 引用——可判污染）
    expect(willowRefs.every((ref) => !ref.includes('clown'))).toBe(true)

    gate!() // A 的迟到响应到达——不得落地
    await flush(60)
    expect(getTreeHistoryState().versions.map((v) => v.treeBlobRef)).toEqual(willowRefs)
    expect(getTreeHistoryState().loading).toBe(false)
  })
})

describe('F3 回退后树内容刷新（内容寻址 ref 回拨短路——真浏览器走查 B3 根因）', () => {
  it('revert 回拨 ref==装载 ref 时强制重建：回退后图层名==目标版本快照名', async () => {
    // 模拟真 daemon 内容寻址（mock 每次 pushVersion 生成递增 ref——jsdom 下从未踩到
    // 回拨短路）：taskDetail 响应的 tree.blobRef 恒为树内容的确定函数（同内容同 ref）
    const originalDetail = api.taskDetail.bind(api)
    vi.spyOn(api, 'taskDetail').mockImplementation(async (taskId: string) => {
      const response = await originalDetail(taskId)
      if (response.tree !== null) {
        const names = response.tree.nodes.map((n) => `${n.id}:${n.objectName}`).join('|')
        response.tree = { ...response.tree, blobRef: `content-addr:${names}` }
      }
      return response
    })

    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 开 dock 等链装载（行内回退按钮的渲染前置）
    toggleTreeHistoryPanel()
    await waitUntil(() => qq('[data-testid="workbench-tree-history-row"]').length === 1)
    // rename 就地演进（本地 nodes=魔术帽；装载锚 ref=内容寻址 v1 值）
    expect(await renameLayer('n-hat', '魔术帽')).toBe(true)
    await waitUntil(() => qq('[data-testid="workbench-tree-history-row"]').length === 2)
    expect(getWorkbenchNodes().find((n) => n.id === 'n-hat')?.objectName).toBe('魔术帽')

    // 回退到 v1：mock 把树换回快照（帽子）——但 ref 经 spy 回拨到与装载时相同的内容寻址值
    click('[data-testid="workbench-tree-revert-1"]')
    await waitUntil(() => q('[data-testid="workbench-revert-confirm"]') !== null)
    click('[data-testid="workbench-revert-confirm-ok"]')
    await waitUntil(() => getPendingTreeRevert() === null)
    await flush()

    // 真源+图层行都回到目标版本快照名（修复前：treeUnchanged 误判保住本地「魔术帽」）
    expect(getWorkbenchNodes().find((n) => n.id === 'n-hat')?.objectName).toBe('帽子')
    const hatRow = qq('[data-testid="workbench-layer-row"]').find((row) => row.getAttribute('data-node-id') === 'n-hat')!
    expect(hatRow.textContent).toContain('帽子')
    expect(hatRow.textContent).not.toContain('魔术帽')
  })
})

describe('F4 previewMode 写队列 generation（连续切换+首笔失败）', () => {
  it('rendered→holes→numbered 连点且首笔失败——最终意图保留（不回滚到旧值）', async () => {
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
    const originalSet = api.viewStateSet.bind(api)
    const calls: Array<{ previewMode?: string }> = []
    let first = true
    vi.spyOn(api, 'viewStateSet').mockImplementation(async (input: { previewMode?: string }) => {
      calls.push(input)
      if (first) {
        first = false
        throw new Error('模拟首笔写失败（网络抖动）')
      }
      return originalSet(input as Parameters<typeof originalSet>[0])
    })

    setPreviewMode('holes')
    setPreviewMode('numbered') // 同步连点（第一笔尚在队列）
    await new Promise((resolve) => setTimeout(resolve, 100)) // 链清空

    // 首笔请求体携带捕获值 holes（执行体不读可变全局——修复前读到队列尾的 numbered）
    expect(calls[0]?.previewMode).toBe('holes')
    expect(calls[1]?.previewMode).toBe('numbered')
    // 失败回滚不覆盖队列尾部最终意图（修复前：无条件回滚到首笔调用时的 rendered）
    expect(getPreviewMode()).toBe('numbered')
    // 服务端态收敛到最终意图
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.viewState?.previewMode).toBe('numbered')
  })
})

describe('F5 钻选择器空选语义（真源一致性——Dialog 空选=沿用旧指派，不误清空真源）', () => {
  it('托盘清空选集→Dialog 应用（空选）→ 真源指派沿用不变（所见=真源）+Dialog 关窗', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)
    openStoneDialog()
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') !== null)

    // 帽子既有指派 J-201（idx1）——托盘单击移除=清空全部选择
    expect(q('[data-testid="workbench-stone-apply"]')?.textContent).toContain('应用（已选 1 款）')
    click('[data-testid="workbench-stone-tray-1"]')
    await flush()
    expect(q('[data-testid="workbench-stone-apply"]')?.textContent).toContain('应用（空选=沿用当前指派）')

    // 空选显式应用=沿用旧指派（stoneIdx 不发——服务端继承语义；按钮文案已明示）
    const strategyCalls: Array<{ stoneIdx?: number[] }> = []
    const original = api.layerStrategySet.bind(api)
    vi.spyOn(api, 'layerStrategySet').mockImplementation(async (input: { stoneIdx?: number[] }) => {
      strategyCalls.push(input)
      return original(input as Parameters<typeof original>[0])
    })
    click('[data-testid="workbench-stone-apply"]')
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') === null)
    expect('stoneIdx' in (strategyCalls[0] ?? {})).toBe(false) // 不发 stoneIdx（空=缺省继承）
    // 真源沿用：指派钻仍是 J-201（空选不落空集——所见=真源）
    const stones = getWorkbenchAssignments().find((a) => a.nodeId === 'n-hat')!.stones
    expect(stones.map((stone) => stone.sku)).toEqual(['J-201 朱红'])
    // 入口横排随真源保持（当前 1 款）
    expect(q('[data-testid="workbench-stone-picker-label"]')?.textContent).toContain('当前 1 款')
  })

  it('Dialog 空选应用文案在场（「空选=沿用当前指派」明示——防误操作）+「清空」钮', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)
    openStoneDialog()
    await waitUntil(() => q('[data-testid="workbench-stone-dialog"]') !== null)

    click('[data-testid="workbench-stone-tray-clear"]')
    await flush()
    expect(q('[data-testid="workbench-stone-apply"]')?.textContent).toContain('应用（空选=沿用当前指派）')
    expect(q('[data-testid="workbench-stone-tray-empty"]')?.textContent).toContain('未选')
  })
})
