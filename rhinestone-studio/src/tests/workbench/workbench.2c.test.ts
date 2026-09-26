/*
 * [add-workbench-pro 2c] 波 2c 聚焦测试：canvaskit 抽取核（锚定缩放/适配/正逆映射/
 * IME 保护）+命令总线键分派+undo 四域路由（D-3 交错示例）+图层重排/删除（mock 通道
 * 契约语义）+层命中测试（mask 位面）+并发 CAS 回归（双面板同基线双写只成功一个）。
 * 挂载模式沿 workbench.pro.test.ts 先例；纯函数面直测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, flushSync, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID, WORKBENCH_FIXTURE_TREE } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  clampZoomScale,
  fitContainView,
  imageToScreen,
  isEditableTarget,
  screenToImage,
  zoomAtAnchor,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
} from '$lib/canvaskit.js'
import {
  fitCanvasView,
  getCanvasView,
  getWorkbenchTool,
  panCanvasBy,
  resetCanvasStageForTests,
  zoomCanvasAtPoint,
} from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { handleWorkbenchKeydown } from '$lib/components/studio/taskWorkbench/commands'
import {
  buildReorderPayload,
  isInSubtreeOf,
  siblingMovePayload,
  subtreeIdsOf,
} from '$lib/components/studio/taskWorkbench/layerTree'
import {
  applyLayerStrategy,
  cancelPendingDelete,
  enterBrushMode,
  cancelPendingTreeRevert,
  confirmDeleteLayer,
  confirmTreeRevert,
  fetchTreeHistory,
  getPendingDelete,
  getPendingTreeRevert,
  getRenameRequestId,
  getSelectedNodeId,
  getTreeHistoryState,
  getWorkbenchNodes,
  hitTestNodeAt,
  loadWorkbench,
  moveSelectedLayer,
  redoCurrentDomain,
  requestDeleteLayer,
  requestRenameSelected,
  requestTreeRevert,
  resetWorkbenchForTests,
  selectNode,
  toggleNodeVisible,
  undoCurrentDomain,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import {
  getUndoFocusDomain,
  resetUndoDomainsForTests,
  setUndoFocusDomain,
} from '$lib/components/studio/taskWorkbench/undoDomains.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { beginStroke, endStroke, exitBrushMode, getBrushSession, undoLastStroke } from '$lib/components/studio/taskWorkbench/store.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountView(component: Component<Props>, props: Record<string, unknown> = {}): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const instance = mount(component, { target, props })
  mountedDisposers.push(() => {
    unmount(instance)
    target.remove()
  })
}

// eslint-disable-next-line @typescript/no-explicit-any
type Props = any

function flush(): Promise<void> {
  return tick().then(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

function q(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector)
}

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  const { key: keyPressed, ...rest } = init
  return new KeyboardEvent('keydown', {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    bubbles: true,
    cancelable: true,
    ...rest,
    key: keyPressed,
  })
}

beforeEach(() => {
  resetAgentStoreForTests()
  initAgentStore()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  resetViewForTests()
  resetWorkbenchForTests()
  resetCanvasStageForTests()
  resetUndoDomainsForTests()
  resetToastsForTests()
  document.body.innerHTML = ''
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------- canvaskit 抽取核

describe('canvaskit 抽取核（§0 复用真源——designer/workbench 双消费）', () => {
  it('锚定缩放：光标下图像点钉在原屏幕位（designer zoomAt 公式同源）', () => {
    const view = { scale: 1, x: 10, y: 20 }
    const next = zoomAtAnchor(view, 100, 50, 2)
    expect(next.scale).toBe(2)
    // 锚点 (100,50) 下的图像点 screenToImage=(90,30) 缩放后仍映射回 (100,50)
    expect(screenToImage(view, 100, 50)).toEqual({ x: 90, y: 30 })
    expect(imageToScreen(next, 90, 30)).toEqual({ x: 100, y: 50 })
  })

  it('档位夹取 [10%,1600%]；fit 独立不受限', () => {
    expect(clampZoomScale(0.01)).toBe(ZOOM_MIN_SCALE)
    expect(clampZoomScale(99)).toBe(ZOOM_MAX_SCALE)
    expect(fitContainView(50, 100, 1000, 1000).scale).toBeLessThan(ZOOM_MIN_SCALE)
  })

  it('contain 适配居中；正逆映射往返', () => {
    const view = fitContainView(200, 100, 100, 100)
    expect(view).toEqual({ scale: 1, x: 50, y: 0 })
    const image = screenToImage(view, 75, 40)
    expect(imageToScreen(view, image.x, image.y)).toEqual({ x: 75, y: 40 })
  })

  it('表单聚焦判定（input/textarea/contenteditable——键盘归表单）', () => {
    const input = document.createElement('input')
    expect(isEditableTarget(input)).toBe(true)
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(isEditableTarget(div)).toBe(false)
    div.setAttribute('contenteditable', 'true')
    expect(isEditableTarget(div)).toBe(true)
    div.remove()
    expect(isEditableTarget(null)).toBe(false)
  })
})

// ---------------------------------------------------------------- 画布舞台（视口+工具）

describe('画布舞台视口态（滚轮锚定缩放/平移/fit）', () => {
  it('滚轮锚定缩放+平移（userAdjusted 后 fit 不自动覆盖）', () => {
    zoomCanvasAtPoint(50, 40, 2)
    expect(getCanvasView()).toEqual({ scale: 2, x: -50, y: -40 })
    panCanvasBy(10, -5)
    expect(getCanvasView()).toEqual({ scale: 2, x: -40, y: -45 })
    expect(fitCanvasView()).toBe(false) // 无几何（jsdom）——fit 命令放行回 false
  })
})

// ---------------------------------------------------------------- 命令总线（键分派+帮助面）

describe('快捷键命令总线（V/H/Z/Delete/F2/Esc/⌘Z/?——IME+表单保护）', () => {
  beforeEach(async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await flush()
    await vi.waitFor(() => expect(q('[data-testid="workbench-layer-row"]')).not.toBeNull())
  })

  it('V/H/Z 工具切换（designer keymap 真源对齐）', async () => {
    expect(handleWorkbenchKeydown(key({ key: 'h' }))).toBe(true)
    expect(getWorkbenchTool()).toBe('hand')
    expect(handleWorkbenchKeydown(key({ key: 'z' }))).toBe(true)
    expect(getWorkbenchTool()).toBe('zoom')
    expect(handleWorkbenchKeydown(key({ key: 'v' }))).toBe(true)
    expect(getWorkbenchTool()).toBe('select')
  })

  it('输入框聚焦/IME 组字不拦截（W10 P1 同款谨慎）', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const inInput = key({ key: 'v' })
    Object.defineProperty(inInput, 'target', { value: input })
    expect(handleWorkbenchKeydown(inInput)).toBe(false)
    const composing = key({ key: 'v' })
    Object.defineProperty(composing, 'isComposing', { value: true })
    expect(handleWorkbenchKeydown(composing)).toBe(false)
  })

  it('Delete 预判根保护；F2 触发 inline 重命名；? 开帮助面（命令总线单源）', async () => {
    selectNode('n-canvas')
    await flush()
    const before = getRenameRequestId()
    // 根选中——Delete 被预判消费（toast 提示 root-protected），确认面不出现
    expect(handleWorkbenchKeydown(key({ key: 'Delete' }))).toBe(true)
    expect(getPendingDelete()).toBeNull()
    // F2：非根选中触发重命名请求计数
    selectNode('n-hat')
    await flush()
    expect(handleWorkbenchKeydown(key({ key: 'F2' }))).toBe(true)
    expect(getRenameRequestId()).toBeGreaterThan(before)
    // ?：帮助面板（命令清单驱动）
    expect(handleWorkbenchKeydown(key({ key: '?', shiftKey: true }))).toBe(true)
    await flush()
    expect(q('[data-testid="workbench-shortcuts-help"]')).not.toBeNull()
    expect(q('[data-testid="workbench-shortcut-title-tool.select"]')?.textContent).toContain('选择工具')
    // Esc 取消链：帮助面板最先关
    expect(handleWorkbenchKeydown(key({ key: 'Escape' }))).toBe(true)
    await flush()
    expect(q('[data-testid="workbench-shortcuts-help"]')).toBeNull()
  })

  it('笔刷半径 [ ] 仅笔刷激活时接管（其余放行浏览器默认）', async () => {
    expect(handleWorkbenchKeydown(key({ key: ']' }))).toBe(false)
    selectNode('n-hat')
    enterBrushMode()
    expect(handleWorkbenchKeydown(key({ key: ']' }))).toBe(true)
    expect(getBrushSession().radiusPx).toBe(14)
    expect(handleWorkbenchKeydown(key({ key: '[' }))).toBe(true)
    expect(getBrushSession().radiusPx).toBe(12)
  })
})

// ---------------------------------------------------------------- 图层结构写（reorder/delete）

describe('图层重排/删除（layer.reorder/layer.delete 消费——mock 契约语义）', () => {
  beforeEach(async () => {
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
    await flush()
  })

  it('重排：帽子移到画布根下（跨父）+同父序移（Alt+↑↓ 等价）', async () => {
    // n-hat（小丑的第 1 子）移到根 n-canvas 下
    const ok = await import('$lib/components/studio/taskWorkbench/store.svelte').then((m) =>
      m.reorderLayerNode('n-hat', { newParentId: 'n-canvas', index: 1 }),
    )
    expect(ok).toBe(true)
    const canvas = getWorkbenchNodes().find((node) => node.id === 'n-canvas')!
    const clown = getWorkbenchNodes().find((node) => node.id === 'n-clown')!
    expect(canvas.children).toEqual(['n-clown', 'n-hat'])
    expect(clown.children).toEqual(['n-face', 'n-bow'])
    const hat = getWorkbenchNodes().find((node) => node.id === 'n-hat')!
    expect(hat.parent).toBe('n-canvas')
    // 同父序移：帽子（根下 index 1）上移一位
    selectNode('n-hat')
    expect(moveSelectedLayer(-1)).toBe(true)
    await flush()
    const canvasAfter = getWorkbenchNodes().find((node) => node.id === 'n-canvas')!
    expect(canvasAfter.children).toEqual(['n-hat', 'n-clown'])
    // 已在顶端——moveSelectedLayer 返回 false（键位层放行）
    expect(moveSelectedLayer(-1)).toBe(false)
  })

  it('重排预判：根拒/环路拒/锁定拒（UI 就近提示——不发 RPC）', async () => {
    const m = await import('$lib/components/studio/taskWorkbench/store.svelte')
    expect(await m.reorderLayerNode('n-canvas', { newParentId: 'n-clown', index: 0 })).toBe(false)
    // 环路：把小丑移到自己的子孙（帽子）下
    expect(await m.reorderLayerNode('n-clown', { newParentId: 'n-hat', index: 0 })).toBe(false)
    expect(getWorkbenchNodes().find((node) => node.id === 'n-clown')!.parent).toBe('n-canvas')
  })

  it('删除：确认面→子树出树+指派收敛+版本入史；根/锁定预判拒', async () => {
    // 根预判
    expect(requestDeleteLayer('n-canvas')).toBe(true)
    expect(getPendingDelete()).toBeNull()
    // 帽子（带指派）删除——确认面（count=子树节点数）
    expect(requestDeleteLayer('n-hat')).toBe(true)
    expect(getPendingDelete()).toEqual({ nodeId: 'n-hat', count: 1 })
    expect(await confirmDeleteLayer()).toBe(true)
    await flush()
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')).toBeUndefined()
    const clown = getWorkbenchNodes().find((node) => node.id === 'n-clown')!
    expect(clown.children).toEqual(['n-face', 'n-bow'])
    // 指派收敛（mock detail 面已移除 n-hat 指派）
    const detail = await import('$lib/components/studio/taskWorkbench/store.svelte').then((m2) => m2.getWorkbenchAssignments())
    expect(detail.find((assignment) => assignment.nodeId === 'n-hat')).toBeUndefined()
    // 取消路径：请求后取消不落任何写
    requestDeleteLayer('n-bow')
    cancelPendingDelete()
    expect(getPendingDelete()).toBeNull()
    expect(getWorkbenchNodes().find((node) => node.id === 'n-bow')).toBeDefined()
  })

  it('事务历史面：tree.history 版本链+tree.revert 回退（W10 复核补齐的前端 API）', async () => {
    const m = await import('$lib/components/studio/taskWorkbench/store.svelte')
    await m.renameLayer('n-hat', '礼帽')
    await m.renameLayer('n-hat', '魔术帽')
    await fetchTreeHistory()
    const history = getTreeHistoryState()
    expect(history.versions.length).toBe(2)
    expect(history.versions.at(-1)?.cause).toBe('rename')
    // 回退到 v1（=首笔重命名后状态「礼帽」）——确认面携带「将一并回退」清单（D-3 透明化）
    const earliest = history.versions[0]!.version
    await requestTreeRevert(earliest)
    const pending = getPendingTreeRevert()
    expect(pending?.targetVersion).toBe(earliest)
    expect(pending?.entries.map((entry) => entry.version)).toEqual([earliest + 1])
    expect(await confirmTreeRevert()).toBe(true)
    await flush()
    expect(getPendingTreeRevert()).toBeNull()
    // 回退后树回到 v1 快照（魔术帽→礼帽）
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')?.objectName).toBe('礼帽')
    await fetchTreeHistory()
    expect(getTreeHistoryState().versions.at(-1)?.cause).toBe('revert')
  })
})

// ---------------------------------------------------------------- 重排载荷纯函数

describe('layerTree 纯函数（拖拽三落区→载荷构造）', () => {
  it('before/after/inside 三落区（index=移出后下标语义）', () => {
    const nodes = getFixtureNodes()
    // 帽子 before 脸蛋（同父小丑下：[hat,face,bow]→hat 已在 face 前=0）
    expect(buildReorderPayload(nodes, { nodeId: 'n-hat', targetId: 'n-face', zone: 'before' })).toEqual({
      newParentId: 'n-clown',
      index: 0,
    })
    // 蝴蝶结 before 帽子（[hat,face,bow] 移出 bow → [hat,face]，插到 hat 前=0）
    expect(buildReorderPayload(nodes, { nodeId: 'n-bow', targetId: 'n-hat', zone: 'before' })).toEqual({
      newParentId: 'n-clown',
      index: 0,
    })
    // 蝴蝶结 after 帽子 → [hat,face] 中 hat 后=1
    expect(buildReorderPayload(nodes, { nodeId: 'n-bow', targetId: 'n-hat', zone: 'after' })).toEqual({
      newParentId: 'n-clown',
      index: 1,
    })
    // 蝴蝶结 inside 画布 → 根 children 尾追加
    expect(buildReorderPayload(nodes, { nodeId: 'n-bow', targetId: 'n-canvas', zone: 'inside' })).toEqual({
      newParentId: 'n-canvas',
      index: 1,
    })
  })

  it('不可落：根不可移/环路（含自身）/根 before-after 非法', () => {
    const nodes = getFixtureNodes()
    expect(buildReorderPayload(nodes, { nodeId: 'n-canvas', targetId: 'n-clown', zone: 'inside' })).toBeNull()
    expect(buildReorderPayload(nodes, { nodeId: 'n-clown', targetId: 'n-hat', zone: 'inside' })).toBeNull()
    expect(buildReorderPayload(nodes, { nodeId: 'n-hat', targetId: 'n-hat', zone: 'before' })).toBeNull()
    expect(buildReorderPayload(nodes, { nodeId: 'n-hat', targetId: 'n-canvas', zone: 'before' })).toBeNull()
  })

  it('同父序移（[a,b,c] 移 b 上=0 下=2；越界 null）', () => {
    const nodes = getFixtureNodes()
    expect(siblingMovePayload(nodes, 'n-hat', -1)).toBeNull() // 已在首位
    expect(siblingMovePayload(nodes, 'n-hat', 1)).toEqual({ newParentId: 'n-clown', index: 1 }) // [face,hat,bow]
    expect(siblingMovePayload(nodes, 'n-bow', 1)).toBeNull() // 已在末位
    expect(siblingMovePayload(nodes, 'n-bow', -1)).toEqual({ newParentId: 'n-clown', index: 1 })
  })

  it('subtreeIdsOf/isInSubtreeOf（删除计数/环路预判共用）', () => {
    const nodes = getFixtureNodes()
    expect(subtreeIdsOf(nodes, 'n-clown')).toEqual(['n-clown', 'n-hat', 'n-face', 'n-bow'])
    expect(isInSubtreeOf(nodes, 'n-hat', 'n-clown')).toBe(true)
    expect(isInSubtreeOf(nodes, 'n-clown', 'n-hat')).toBe(false)
    expect(isInSubtreeOf(nodes, 'n-clown', 'n-clown')).toBe(true)
  })

  function getFixtureNodes() {
    // 小丑 fixture 真树（纯函数直喂——不跨 store 态）
    return structuredClone(WORKBENCH_FIXTURE_TREE.nodes)
  }
})

// ---------------------------------------------------------------- 层命中测试（mask 位面）

describe('层命中测试（点击画布元素→选中层——mask 位面命中而非仅 bbox）', () => {
  beforeEach(async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await flush()
    await vi.waitFor(() => expect(q('[data-testid="workbench-layer-row"]')).not.toBeNull())
    // 位面渐进就绪（inline 同步解码——requestNodeMasks 经组件 $effect）
    await flush()
  })

  it('mask 位就绪层=精确命中；条纹 mask 的洞不命中（回落到外层）', async () => {
    // 脸蛋 bbox (38,64,44,36) stripes (x+y)%3!==0——(39,65)：局部 (1,1) 和 2 → 位=1 精确命中
    expect(hitTestNodeAt(39, 65)).toBe('n-face')
    // 脸蛋洞位 (39,66)：局部 (1,2) 和 3 → face 位=0；小丑局部 (15,38) 和 53%3=2 → 小丑位=1
    // → 位面命中回落到外层小丑（mask 命中而非仅 bbox——洞不挡穿透）
    expect(hitTestNodeAt(39, 66)).toBe('n-clown')
    // 画布外=null
    expect(hitTestNodeAt(500, 500)).toBeNull()
  })

  it('隐藏层不可命中（与画布投影过滤同式）', async () => {
    toggleNodeVisible('n-face')
    await flush()
    expect(hitTestNodeAt(39, 65)).toBe('n-clown')
    toggleNodeVisible('n-face')
    await flush()
    expect(hitTestNodeAt(39, 65)).toBe('n-face')
  })
})

// ---------------------------------------------------------------- undo 四域路由（D-3 交错示例）

describe('undo 四域路由（D-3——交错操作域独立回退）', () => {
  beforeEach(async () => {
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
    await flush()
  })

  it('交错序列：视图态开关→笔刷笔画→策略直改→重命名——mask 上下文 Ctrl+Z 只撤笔画；视图域回退视图；参数域回退前值；结构域走确认回退', async () => {
    // t_view：隐藏帽子（tree-view 域入栈）
    toggleNodeVisible('n-hat')
    await flush()
    // t_mask：本地笔画两笔（未提交）
    selectNode('n-hat')
    enterBrushMode()
    beginStroke({ x: 40, y: 30 })
    endStroke()
    beginStroke({ x: 42, y: 32 })
    endStroke()
    expect(getBrushSession().strokes).toHaveLength(2)
    // t_param：帽子密度直改 2.3→4.0（strategy-param 域入栈——前值快照）。
    // 笔刷保持激活（本地笔画不跨 exit 清空——mask 上下文在后续操作后仍可回退）
    const applied = await applyLayerStrategy('n-hat', 'texture-fill', { mode: 'flow', polarity: 'dark-dense', fallbackEngineStrategy: 'hex-pitch' }, 4.0)
    expect(applied).toBe(true)
    // t_structure：两笔重命名（tree-structure 域版本入史——v1 礼帽/v2 魔术帽）
    const m = await import('$lib/components/studio/taskWorkbench/store.svelte')
    expect(await m.renameLayer('n-hat', '礼帽')).toBe(true)
    expect(await m.renameLayer('n-hat', '魔术帽')).toBe(true)

    // --- mask 上下文 Ctrl+Z：仅撤最近一笔（参数/结构/视图不动——D-3 交错示例；
    // brush 全程激活——enterBrushMode 会清笔画故不重入）
    expect(await undoCurrentDomain()).toBe(true)
    expect(getBrushSession().strokes).toHaveLength(1)
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')?.objectName).toBe('魔术帽')
    expect(m.getAssignmentOf('n-hat')!.densityPerCm2).toBe(4)
    // redo（mask 域先行——笔画重入栈）
    expect(await redoCurrentDomain()).toBe(true)
    expect(getBrushSession().strokes).toHaveLength(2)
    exitBrushMode() // 收笔会话退出（未提交笔画随之清空——2b 既有语义）

    // --- 视图域：最近操作域=structure（重命名）……但焦点在图层树（structure）。
    // 显隐操作后再 Ctrl+Z → 回退视图（D-3「显隐/折叠/锁定操作后→tree-view」）
    toggleNodeVisible('n-face')
    await flush()
    expect(await undoCurrentDomain()).toBe(true)
    await flush()
    // 视图回退=上一步快照整体回放：n-face 恢复可见、n-hat 仍隐藏（只撤 n-face 那一步）
    expect(m.isNodeVisible('n-face')).toBe(true)
    expect(m.isNodeVisible('n-hat')).toBe(false)

    // --- 参数域：焦点切策略卡 → Ctrl+Z 回退密度前值（2.3——undoSilent 不二次入栈）
    setUndoFocusDomain('strategy-param')
    expect(await undoCurrentDomain()).toBe(true)
    await flush()
    expect(m.getAssignmentOf('n-hat')!.densityPerCm2).toBe(2.3)

    // --- 结构域：焦点图层树 → Ctrl+Z 弹整树回退确认面（列出一并回退的后续版本）
    setUndoFocusDomain('tree-structure')
    expect(await undoCurrentDomain()).toBe(true)
    const pending = getPendingTreeRevert()
    expect(pending).not.toBeNull()
    expect(pending!.targetVersion).toBe(pending!.entries[0]!.version - 1)
    expect(pending!.entries.map((entry) => entry.cause)).toContain('rename')
    expect(await confirmTreeRevert()).toBe(true)
    await flush()
    expect(getWorkbenchNodes().find((node) => node.id === 'n-hat')?.objectName).toBe('礼帽')
    // 撤销后链尾追加 revert 版本（历史只增不删）——再撤=回退到链上前一版本（v2）。
    // 跨 revert 的线性游标保持/redo 属 2d 精化（版本链非线性后游标语义需 Owner 裁定）
    expect(await undoCurrentDomain()).toBe(true)
    expect(getPendingTreeRevert()?.targetVersion).toBe(pending!.entries[0]!.version)
    cancelPendingTreeRevert()
  })

  it('结构域栈空：无任何结构版本时 Ctrl+Z 提示「本域已无可回退」（不自动跨域——D-3 共同不变量）', async () => {
    setUndoFocusDomain('tree-structure')
    expect(await undoCurrentDomain()).toBe(true) // 消费为 toast 提示
    expect(getPendingTreeRevert()).toBeNull()
  })

  it('焦点域接线：图层树/策略卡 focusin 推动 undo 焦点域', () => {
    setUndoFocusDomain('strategy-param')
    expect(getUndoFocusDomain()).toBe('strategy-param')
    setUndoFocusDomain('tree-structure')
    expect(getUndoFocusDomain()).toBe('tree-structure')
  })

  it('本地笔画栈空时 mask 域提示（不自动跨域）+重命名 F2 请求面', async () => {
    selectNode('n-hat')
    enterBrushMode()
    beginStroke({ x: 40, y: 30 })
    endStroke()
    undoLastStroke()
    expect(await undoCurrentDomain()).toBe(true) // 栈空——toast 提示（本域已无可回退）
    expect(getBrushSession().strokes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- 并发 CAS 回归（Codex 2a 复核遗留）

describe('并发 CAS 回归（双面板同任务——同基线双写只成功一个）', () => {
  it('layer.reorder 同基线双写：恰好一个成功，另一个 cas-mismatch 拒（无重复副作用）', async () => {
    const mock = new MockAgentApi({ speed: 0 })
    const first = await mock.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    const baseline = first.tree!.blobRef
    // 双面板并发：同一基线各发一笔重排（Promise.all 模拟同时到达）
    const results = await Promise.allSettled([
      mock.layerReorder({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-hat', newParentId: 'n-canvas', index: 1, expectedTreeBlobRef: baseline }),
      mock.layerReorder({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-bow', newParentId: 'n-canvas', index: 1, expectedTreeBlobRef: baseline }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('cas-mismatch')
    // 成功后同基线重试（幂等面）：必被 CAS 拒——错误面携带的电流引用=自己上次响应的 treeBlobRef ⇒ 客户端判「已生效」放弃重试
    const own = (fulfilled[0] as PromiseFulfilledResult<{ treeBlobRef: string }>).value
    const retry = await mock.layerReorder({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-hat', newParentId: 'n-canvas', index: 1, expectedTreeBlobRef: baseline }).catch((error: Error) => error)
    expect(retry).toBeInstanceOf(Error)
    expect((retry as Error).message).toContain(own.treeBlobRef)
  })

  it('view.state.set 同 revision 双写：一成一拒（不静默覆盖）', async () => {
    const mock = new MockAgentApi({ speed: 0 })
    const first = await mock.viewStateSet({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodes: [{ nodeId: 'n-hat', visible: false }] })
    const results = await Promise.allSettled([
      mock.viewStateSet({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodes: [{ nodeId: 'n-face', visible: false }], expectedRevision: first.revision }),
      mock.viewStateSet({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodes: [{ nodeId: 'n-bow', collapsed: true }], expectedRevision: first.revision }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const readback = await mock.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(readback.viewState!.revision).toBe(first.revision + 1)
  })

  it('store 视图写透 CAS 漂移：他写后本地回滚+重装载读回（不静默覆盖）', async () => {
    const mock = new MockAgentApi({ speed: 0 })
    bindAgentApi(mock)
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
    await flush()
    // 他写：绕过本地 store 直接推进服务端视图态（另一面板）
    await mock.viewStateSet({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodes: [{ nodeId: 'n-hat', visible: false }] })
    // 本地面板按旧基线写 → CAS 拒 → 回滚+重装载读回他写结果
    toggleNodeVisible('n-face')
    await flush()
    await vi.waitFor(() => {
      void getSelectedNodeId() // store 读活性
    })
    const m = await import('$lib/components/studio/taskWorkbench/store.svelte')
    // 重装载后：他写的 n-hat 隐藏生效；本地 n-face 被回滚（可见）
    await vi.waitFor(() => expect(m.isNodeVisible('n-hat')).toBe(false))
    expect(m.isNodeVisible('n-face')).toBe(true)
  })
})

// ---------------------------------------------------------------- 状态栏（mount 面）

describe('状态栏 P0（zoom/坐标/ppm 三态/选中层/dirty/告警）', () => {
  it('渲染读数：ppm 真实态+选中层尺寸+遮罩告警聚合（demo 造数 stale+incomplete）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await flush()
    await vi.waitFor(() => expect(q('[data-testid="workbench-status-bar"]')).not.toBeNull())
    expect(q('[data-testid="workbench-status-ppm"]')?.textContent).toContain('ppm 2.00')
    // demo 造数：n-bow incomplete+n-face stale → 告警聚合
    expect(q('[data-testid="workbench-status-warnings"]')?.textContent).toContain('超限 1')
    expect(q('[data-testid="workbench-status-warnings"]')?.textContent).toContain('漂移 1')
    // 选中层（小丑 fixture ppm=2——mm=px/2）
    selectNode('n-hat')
    await flush()
    expect(q('[data-testid="workbench-status-selected"]')?.textContent).toContain('帽子')
    expect(q('[data-testid="workbench-status-selected"]')?.textContent).toContain('48×30 px')
    // dirty：笔刷两笔未提交
    enterBrushMode()
    beginStroke({ x: 40, y: 30 })
    endStroke()
    await flush()
    expect(q('[data-testid="workbench-status-dirty"]')?.textContent).toContain('未提交编辑')
  })
})
