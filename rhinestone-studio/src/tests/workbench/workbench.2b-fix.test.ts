/*
Orthogonal intents:
1. [2026-09-26 add-workbench-pro 2b 复核修复] Codex 2b 复核（5.2/10）红→绿测试
   （原始需求：P0 笔刷坐标/blob 回写/状态机三 P0 + 迟到响应/断笔/CAS 重放/视图态并发 P1——
   P0-2 状态机 daemon 运行路径与 daemon 侧折线插值在 daemon/tests/workbench-pro-2b.test.ts）。
2. [P0-1 回归] 2c 画布舞台重构后笔刷接收面=画布 viewport 盒（同盒对齐）：非零偏移
   坐标系下落笔像素精确+接收面不含 toolbar——防回退到「父容器 inset-3+错 bbox」旧疾。
3. [2.6 走查遗留] 标签避让（同区域标签纵向堆叠）+有指派父节点策略面板守卫放宽——
   401 自愈在 agentApi.rpc.test.ts（传输层桩）。
*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import StrategyCanvas from '$lib/components/strategy/StrategyCanvas.svelte'
import type { AgentApi } from '$lib/agentApi/types'
import { MockAgentApi } from '$lib/agentApi/mock'
import {
  WORKBENCH_FIXTURE_TASK_ID,
  WORKBENCH_FIXTURE_BLOB_REFS,
} from '$lib/agentApi/workbenchFixtures'
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
  getBrushSession,
  loadWorkbench,
  resetWorkbenchForTests,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  resetCanvasStageForTests,
  setCanvasViewForTests,
} from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import {
  getMaskEntryOf,
  resetMaskBitsForTests,
  requestNodeMasks,
  type RequestMasksContext,
} from '$lib/components/studio/taskWorkbench/maskBits.svelte'
import { decodeInlineMask, encodeInlineMask, type ObjectNode, type ViewStateSetInput } from '@handicraft/contracts'

// jsdom 未实现 scrollIntoView——桩掉。
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

async function waitUntil(condition: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await condition()) && Date.now() < deadline) await flush(20)
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

function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** pointer 事件（jsdom 无 PointerEvent 时回退 MouseEvent——坐标字段同名）。 */
function firePointer(el: Element, type: string, clientX: number, clientY: number): void {
  const Ctor = globalThis.PointerEvent ?? MouseEvent
  el.dispatchEvent(new Ctor(type, { clientX, clientY, bubbles: true, cancelable: true }))
}

/** 元素布局桩（真实浏览器布局语义——getBoundingClientRect 非零偏移坐标系）。 */
function stubRect(selector: string, rect: { left: number; top: number; width: number; height: number }): void {
  const el = q(selector)
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.getBoundingClientRect = () =>
    ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect
}

let api: MockAgentApi

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetCanvasStageForTests()
  resetMaskBitsForTests()
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

// ---------------------------------------------------------------- P0-1 笔刷接收面布局回归

describe('P0-1 笔刷接收面布局回归（2c 舞台架构——防回退）', () => {
  it('非零偏移坐标系：落笔像素=client→viewport 盒局部→画布 px 逆映射；接收面与画布 viewport 盒同盒（不含 toolbar）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    pressKey('b')
    await waitUntil(() => q('[data-testid="workbench-brush-layer"]') !== null)

    // 真实布局语义：画布 viewport 盒在 (20,64)（工具簇在其上方），尺寸 800×600；
    // 图层舞台与笔刷 svg 同盒（inset-0 注入位）。v4：workbench-layer-stage 即取景盒。
    const box = { left: 20, top: 64, width: 800, height: 600 }
    stubRect('[data-testid="workbench-layer-stage"]', box)
    stubRect('[data-testid="workbench-brush-layer"]', box)

    setCanvasViewForTests({ scale: 0.5, x: 40, y: 80 })
    await flush()

    // 接收面=画布 viewport 盒（同盒对齐——工具簇在盒外，z 序不接收笔刷坐标）
    const brushRect = q('[data-testid="workbench-brush-layer"]')!.getBoundingClientRect()
    const canvasRect = q('[data-testid="workbench-layer-stage"]')!.getBoundingClientRect()
    expect(brushRect.left).toBe(canvasRect.left)
    expect(brushRect.top).toBe(canvasRect.top)
    expect(brushRect.width).toBe(canvasRect.width)
    expect(brushRect.top).toBeGreaterThanOrEqual(64) // 44px strategy 工具条+p-3 内容偏移之下

    // 落笔：client (70,184) → 盒局部 (50,120) → 画布 ((50-40)/0.5, (120-80)/0.5)=(20,80)
    const svg = q('[data-testid="workbench-brush-layer"]')!
    firePointer(svg, 'pointerdown', 70, 184)
    firePointer(svg, 'pointerup', 70, 184)
    await flush()
    expect(getBrushSession().strokes).toHaveLength(1)
    expect(getBrushSession().strokes[0]?.points[0]).toEqual({ x: 20, y: 80 })
  })
})

// ---------------------------------------------------------------- P0-3 mock blob 态回写

describe('P0-3 mock 通道 blob 掩码回写（n-canvas patch 不再断路）', () => {
  it('blob 态节点 patch 成功：产新 blob 态掩码+可经附件通道拉回+版本入史', async () => {
    const detail0 = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    const canvas0 = detail0.tree!.nodes.find((n) => n.id === 'n-canvas')!
    expect(canvas0.mask.kind).toBe('blob') // fixture 前提：画布层=120×160 blob 态

    const out = await api.layerMaskPatch({
      taskId: WORKBENCH_FIXTURE_TASK_ID,
      nodeId: 'n-canvas',
      ops: [{ op: 'add', radiusPx: 8, points: [{ x: 60, y: 80 }] }],
      expectedTreeBlobRef: detail0.tree!.blobRef,
      recomputeStrategy: false,
    })
    expect(out.editState).toBe('ready')

    // patch 后节点掩码仍可寻址：blob 新 ref（19200>4096 持久化阈值）且附件通道能拉回
    const detail1 = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    const canvas1 = detail1.tree!.nodes.find((n) => n.id === 'n-canvas')!
    expect(canvas1.mask.kind).toBe('blob')
    if (canvas1.mask.kind === 'blob') {
      expect(canvas1.mask.blobRef).not.toBe(WORKBENCH_FIXTURE_BLOB_REFS.canvasMaskBlob)
      const artifact = await api.taskArtifact({ taskId: WORKBENCH_FIXTURE_TASK_ID, blobRef: canvas1.mask.blobRef })
      const bytes = Uint8Array.from(atob(artifact.dataBase64), (ch) => ch.charCodeAt(0))
      expect(bytes.byteLength).toBe(120 * 160)
    }

    const history = await api.treeHistory({ taskId: WORKBENCH_FIXTURE_TASK_ID })
    expect(history.versions.some((version) => version.cause === 'mask-patch')).toBe(true)
  })
})

// ---------------------------------------------------------------- P1-2 mock 折线插值

describe('P1-2 mock 折线笔刷扫掠（相邻点线段插值——步长≤半径/2）', () => {
  it('大间距两点（30px >> 2r=8px）：中点必须被涂上（旧实现逐点盖圆留缝）', async () => {
    const detail0 = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    // n-hat bbox (36,28,48,30)；两点画布 (39,43)/(69,43)，中点 (54,43)——
    // 条纹基底 (18+15)%3===0 ⇒ 中点原值=0（add 涂 1 才能区分插值效果）
    const out = await api.layerMaskPatch({
      taskId: WORKBENCH_FIXTURE_TASK_ID,
      nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 4, points: [{ x: 39, y: 43 }, { x: 69, y: 43 }] }],
      expectedTreeBlobRef: detail0.tree!.blobRef,
      recomputeStrategy: false,
    })
    expect(out.editState).toBe('ready')
    const detail1 = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    const hat = detail1.tree!.nodes.find((n) => n.id === 'n-hat')!
    expect(hat.mask.kind).toBe('inline')
    if (hat.mask.kind !== 'inline') throw new Error('P1-2 测试预期 inline 态掩码')
    const bits = decodeInlineMask(hat.mask)
    const cx = 54 - hat.bbox.x
    const cy = 43 - hat.bbox.y
    expect(bits.bits[cy * bits.w + cx]).toBe(1)
  })
})

// ---------------------------------------------------------------- P1-1 maskBits 迟到响应竞态

describe('P1-1 mask 位面迟到响应竞态（完成时核对 entry.ref）', () => {
  function blobNode(id: string, blobRef: string, w = 2, h = 2): ObjectNode {
    return {
      id,
      objectName: id,
      category: 'test',
      mask: { kind: 'blob', blobRef, w, h },
      bbox: { x: 0, y: 0, w, h },
      parent: null,
      children: [],
      effectiveMm: 1,
      labVariance: 1,
      drillWorthy: true,
      origin: 'vlm+sam3',
    }
  }

  it('旧 blob 响应迟到不得覆盖已换 ref 的新条目（refresh 后 mask 变 inline）', async () => {
    let releaseOld!: (bytes: Uint8Array) => void
    const oldFetch = new Promise<Uint8Array>((resolve) => {
      releaseOld = resolve
    })
    const ctxOf = (fetcher: RequestMasksContext['fetchMaskBlob']): RequestMasksContext => ({
      treeBlobRef: 't1',
      fetchMaskBlob: fetcher,
    })

    // ① 旧树：n-x 为 blob 态（ref A）——异步拉取挂起
    requestNodeMasks([blobNode('n-x', 'blob-a')], ctxOf(() => oldFetch))
    expect(getMaskEntryOf('n-x').phase).toBe('loading')

    // ② 树推进（笔刷编辑落新树）：n-x mask 变 inline → 同步就绪（ref=inline:t2:n-x）
    const inlineNode: ObjectNode = {
      ...blobNode('n-x', 'unused'),
      mask: encodeInlineMask(2, 2, new Uint8Array([1, 1, 1, 1])),
    }
    requestNodeMasks([inlineNode], { ...ctxOf(() => oldFetch), treeBlobRef: 't2' })
    expect(getMaskEntryOf('n-x').phase).toBe('ready')
    expect(getMaskEntryOf('n-x').ref).toBe('inline:t2:n-x')

    // ③ 旧 blob-a 响应迟到到达——不得覆盖新条目（旧实现无条件 setEntry → 覆盖）
    releaseOld(new Uint8Array([1, 0, 0, 1]))
    await flush()
    const entry = getMaskEntryOf('n-x')
    expect(entry.ref).toBe('inline:t2:n-x')
    expect(entry.phase).toBe('ready')
  })
})

// ---------------------------------------------------------------- P1-3 CAS 失败重放闭环

describe('P1-3 CAS 失败「基于新基线重放」闭环', () => {
  it('漂移注入→提交失败驻留错误+重放按钮在场→点击后基于新基线成功提交（笔画不丢）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    pressKey('b')
    await waitUntil(() => q('[data-testid="workbench-brush-toolbar"]') !== null)

    // 服务端先推进（另一端写）——本地 CAS 基线过期
    await api.layerRename({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-bow', objectName: '胸花结' })
    const detailNow = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)

    // 本地涂抹一笔并提交：cas-mismatch 驻留+笔画保留
    const svg = q('[data-testid="workbench-brush-layer"]')!
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 120, height: 160, right: 120, bottom: 160, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    firePointer(svg, 'pointerdown', 60, 40)
    firePointer(svg, 'pointerup', 60, 40)
    await flush()
    expect(getBrushSession().strokes).toHaveLength(1)
    click('[data-testid="workbench-brush-commit"]')
    await waitUntil(() => q('[data-testid="workbench-brush-error"]') !== null)
    expect(q('[data-testid="workbench-brush-error"]')?.textContent).toContain('cas-mismatch')
    expect(getBrushSession().strokes).toHaveLength(1)

    // 错误面读回新基线：重放按钮在场+提示携带电流树 ref 语义
    const retry = q('[data-testid="workbench-brush-retry"]')
    expect(retry).not.toBeNull()
    expect(q('[data-testid="workbench-brush-error"]')?.textContent).toContain('新基线')

    // 点击重放：以服务端电流树为新 expectedTreeBlobRef 重提同一笔画——成功
    ;(retry as HTMLElement).click()
    await waitUntil(() => getBrushSession().strokes.length === 0)
    // 新基线=服务端当前树（漂移注入后的 ref）——重放以此提交
    const history = await api.treeHistory({ taskId: WORKBENCH_FIXTURE_TASK_ID })
    const maskPatch = history.versions.find((version) => version.cause === 'mask-patch')
    expect(maskPatch).toBeDefined()
    const detailAfter = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detailAfter.tree!.blobRef).not.toBe(detailNow.tree!.blobRef)
  })
})

// ---------------------------------------------------------------- P1-4 视图态写队列串行化

describe('P1-4 视图态写队列串行化（连续快速操作不丢意图）', () => {
  it('第一写在途时第二写排队：带新 revision 串行提交——两意图都在服务端终态', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // mock 通道 spy：两写都先挂起（可控放行——构造「后发写完成在先」的并发交错），记录参数
    const real = api.viewStateSet.bind(api)
    const calls: ViewStateSetInput[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    api.viewStateSet = async (input: ViewStateSetInput) => {
      calls.push(input)
      await gate
      return real(input)
    }

    // 连续快速两操作（不等第一个写完成——并发窗口）
    click('[data-testid="workbench-layer-visible-n-hat"]')
    await flush(5)
    click('[data-testid="workbench-layer-visible-n-face"]')
    await flush(5)

    // 放行：串行化后第二写排队至第一写完成才发出——必带第一写的新 revision
    // （旧实现并发发出同基线→CAS 拒→回滚+「保存失败」toast——两断言皆红）
    releaseFirst()
    await waitUntil(() => calls.length >= 2 && calls[1]?.expectedRevision === 1)
    expect(calls[1]?.expectedRevision).toBe(1)
    expect(q('[data-testid="toast-stack"]')?.textContent ?? '').not.toContain('保存失败')

    await waitUntil(async () => {
      const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
      const hidden = (detail.viewState?.nodes ?? []).filter((n) => n.visible === false).map((n) => n.nodeId)
      return hidden.includes('n-hat') && hidden.includes('n-face')
    })
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    const hidden = (detail.viewState?.nodes ?? []).filter((n) => n.visible === false).map((n) => n.nodeId)
    expect(hidden).toEqual(expect.arrayContaining(['n-hat', 'n-face']))
  })
})

// ---------------------------------------------------------------- 2.6-2 画布标签避让

describe('2.6-2 画布同区域标签避让（纵向堆叠）', () => {
  it('两框线完全同区域：标签 y 错开（第二级下移）——不再叠压', () => {
    const model = {
      imagePx: { width: 120, height: 160 },
      gems: [],
      boxes: [
        { nodeId: 'a', objectName: '标签甲', bbox: { x: 20, y: 28, w: 48, h: 30 }, excluded: false },
        { nodeId: 'b', objectName: '标签乙', bbox: { x: 20, y: 28, w: 48, h: 30 }, excluded: false },
      ],
      ppm: { ppm: 2, exact: true },
      sourceUrl: null,
      excludedCount: 0,
    }
    const target = document.createElement('div')
    document.body.appendChild(target)
    const view = mount(StrategyCanvas, { target, props: { model, showBoxes: true } })
    try {
      const labels = qq('[data-testid="strategy-node-label"]')
      expect(labels).toHaveLength(2)
      const y1 = Number(labels[0]!.getAttribute('y'))
      const y2 = Number(labels[1]!.getAttribute('y'))
      expect(y1).not.toBeNaN()
      expect(y2).not.toBeNaN()
      expect(Math.abs(y2 - y1)).toBeGreaterThan(0)
    } finally {
      unmount(view)
      target.remove()
    }
  })
})

// ---------------------------------------------------------------- 2.6-3 父节点策略面板（v5 语义重定）

describe('2.6-3 父节点策略面板（v5：组恒不产钻——有无指派均走组门）', () => {
  it('父节点（n-clown）有旧指派：组门在（无指派控件）+旧指派降级标注失效', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // v5：直改组节点被拒（mock node-not-leaf 与 daemon 同构——applyError 驻留）
    const applied = await applyLayerStrategy('n-clown', 'texture-fill', { mode: 'scatter' }, 2)
    expect(applied).toBe(false)
    expect(getApplyError()).toContain('node-not-leaf')
    // 旧指派（v4 语义产物）经 mock 内部状态面种入——测读面降级标注（不炸不静默）
    const api = getBoundAgentApi() as MockAgentApi
    interface LensState {
      detail: {
        assignments: Array<Record<string, unknown>>
        stoneCandidates: Array<{ resourceId: string; sku: string; supplier: string; sizeMm: number | null; colorHex: string }>
      }
    }
    const states = (api as unknown as { workbenchStates: Map<string, LensState> }).workbenchStates
    const state = states.get(WORKBENCH_FIXTURE_TASK_ID)!
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
      rationale: 'v4 旧父层指派（降级读面测试种入）',
    })
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID, { refresh: true })

    click('[data-testid="workbench-layer-select-n-clown"]')
    await flush()
    // 组门：无任何指派控件（kind select/应用按钮缺席）
    expect(q('[data-testid="workbench-params-hierarchy"]')).not.toBeNull()
    expect(q('[data-testid="workbench-params-hierarchy"]')?.textContent).toContain('组不产钻——拆分后在子图层指派')
    expect(q('[data-testid="workbench-params-hierarchy-stale"]')).not.toBeNull()
    expect(q('[data-testid="workbench-kind-select"]')).toBeNull()
    expect(q('[data-testid="workbench-apply-strategy"]')).toBeNull()
    // 图层行：组旧指派降级标注
    expect(q('[data-testid="workbench-layer-select-n-clown"]')?.textContent).toContain('组不产钻——已失效')
  })

  it('父节点（n-clown）无指派：组门同样在（无旧指派标注）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="workbench-layer-select-n-clown"]')
    await flush()
    expect(q('[data-testid="workbench-params-hierarchy"]')?.textContent).toContain('组不产钻——拆分后在子图层指派')
    expect(q('[data-testid="workbench-params-hierarchy-stale"]')).toBeNull()
    expect(q('[data-testid="workbench-kind-select"]')).toBeNull()
  })
})
