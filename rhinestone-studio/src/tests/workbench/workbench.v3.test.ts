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
    expect(legend?.textContent).toContain('#1-')
    expect(legend?.textContent).toContain('（7）')
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

describe('F5 钻选择器空选语义（真源一致性——空选禁用应用）', () => {
  it('清空全部选择→应用禁用+提示；恢复选择→门解除', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await waitUntil(() => q('[data-testid="workbench-stone-picker"]') !== null)
    // 帽子既有指派 J-201（idx1）高亮——点击取消=清空全部选择
    expect(q('[data-testid="workbench-stone-1"]')?.getAttribute('aria-pressed')).toBe('true')
    click('[data-testid="workbench-stone-1"]')
    await flush()

    const apply = q('[data-testid="workbench-apply-strategy"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(q('[data-testid="workbench-stone-empty-intent"]')?.textContent).toContain('至少选一款')

    // 恢复选择（选 idx2）→ 门解除
    click('[data-testid="workbench-stone-2"]')
    await flush()
    expect((q('[data-testid="workbench-apply-strategy"]') as HTMLButtonElement).disabled).toBe(false)
    expect(q('[data-testid="workbench-stone-empty-intent"]')).toBeNull()
  })
})
