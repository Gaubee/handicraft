/*
 * [rework-layer-ps-panel v5] PS 图层面板复刻+父层产钻语义聚焦测试：
 *   [A] 自然树序（Owner 定调 2026-10-04）：面板首行=根「画布」，子随父后缩进（旧 PS 逆序类比废弃）
 *       （data-root 标记+锁形图标位在场；无折叠 caret）。
 *   [B] 单行节奏：fx 徽标（有钻叶子 ◆+颗数——点击右栏定位）；组 caret/竖向轨道线；
 *       双击行名重命名；v4 钻布局虚拟子行缺席。
 *   [C] 底部操作条：拆分（选中叶子展开提示输入）/删除（确认面）/展开全部/收起全部
 *       （收起全部后仅组行+根行；展开全部还原）。
 *   [D] v5 语义：组直改被拒（mock node-not-leaf 同构 daemon）；组旧指派读面降级
 *       （图层行「组不产钻——已失效」+Inspector 组门+紧凑态组门）；去重口径计数
 *       （父层旧指派的钻不计数不渲染——getEffectiveGemTotal+画布行钻数）。
 *   [E] 修复轮 R1c：mock taskExport/taskDetail 叶子口径（与 daemon effectiveGems 同构）
 *       ——父层旧钻不进导出字节/详情计数，三面一致。
 *   [F] 修复轮 R3：编号图例每行颗数==该层 gems 计数（vision 终审「红鼻子 71」负样本
 *       ——真机同形数据 21/71/71 冻结名-数配对，防顺序错位/缓存漂移）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
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
  getEffectiveGemTotal,
  getNodeOf,
  getSelectedNodeId,
  getWorkbenchLayerRender,
  getWorkbenchNodes,
  loadWorkbench,
  resetWorkbenchForTests,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetCanvasStageForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})

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

function rowNodeIds(): string[] {
  return qq('[data-testid="workbench-layer-row"]').map((row) => row.getAttribute('data-node-id') ?? '')
}

/** mock 工作台内部状态（旧指派种入——v4 语义产物读面降级测试）。 */
interface MockStateLens {
  detail: {
    assignments: Array<Record<string, unknown>>
    stoneCandidates: Array<{ resourceId: string; sku: string; supplier: string; sizeMm: number | null; colorHex: string }>
    gems: { blobRef: string; count: number; excludedRegions: number } | null
  }
  gemsByRef: Map<string, { gems: Array<Record<string, unknown>> }>
  /** 导出门真源（clown fixture 造数门阻——导出行为测试前清零）。 */
  maskEdits: unknown[]
}

function workbenchStateLens(): MockStateLens {
  const api = getBoundAgentApi() as MockAgentApi
  const states = (api as unknown as { workbenchStates: Map<string, MockStateLens> }).workbenchStates
  const state = states.get(WORKBENCH_FIXTURE_TASK_ID)
  if (state === undefined) throw new Error('mock 工作台状态缺席（需先装载一次）')
  return state
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

  // v5 PS 序断言见下方各用例
describe('v5 PS 图层面板（rework-layer-ps-panel）', () => {
  // jsdom 多轮装载/写透 flush 累计可超 vitest 缺省 5s——统一放大到 20s（与 perf.gate 同档裁量）
  vi.setConfig({ testTimeout: 20_000 })

  it('首行=画布根（自然树序）；根按真实父节点呈现折叠入口', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(rowNodeIds()).toEqual(['n-canvas', 'n-clown', 'n-hat', 'n-face', 'n-bow'])
    const rootRow = qq('[data-testid="workbench-layer-row"]').find((row) => row.getAttribute('data-node-id') === 'n-canvas')
    expect(rootRow?.getAttribute('data-root')).toBe('true')
    // 根仍受结构保护，但其子树通过普通组行折叠。
    expect(rootRow?.querySelector('[data-testid="workbench-layer-lock-n-canvas"]')).not.toBeNull()
    expect(rootRow?.querySelector('[data-testid="workbench-layer-collapse-n-canvas"]')).not.toBeNull()
    // 组行（n-clown）有 caret；叶子行无
    expect(q('[data-testid="workbench-layer-collapse-n-clown"]')).not.toBeNull()
    expect(q('[data-testid="workbench-layer-collapse-n-hat"]')).toBeNull()
    // 组行缩略=子层并集合成面标记
    expect(q('[data-testid="workbench-layer-thumb-n-clown"]')?.getAttribute('data-role')).toBe('group-composite')
  })

  it('画布根可选中并在自身下拆分，原根节点和原有子树保留', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="workbench-layer-select-n-canvas"]')
    await flush()
    expect(getSelectedNodeId()).toBe('n-canvas')
    expect(q('[data-testid="workbench-layer-select-n-canvas"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="workbench-layer-split-toggle"]')?.hasAttribute('disabled')).toBe(false)

    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    const dialog = q('[data-testid="workbench-segment-dialog"]')
    if (dialog === null) throw new Error('画布抠图 Dialog 缺席')
    expect(q('[data-testid="workbench-segment-target"]')?.textContent).toContain('画布')
    const instruction = q('[data-testid="workbench-segment-instruction"]') as HTMLInputElement | null
    if (instruction === null) throw new Error('抠图指令输入缺席')
    instruction.value = '把背景纹样拆出来'
    instruction.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    click('[data-testid="workbench-segment-trial"]')
    await waitUntil(() => q('[data-testid="workbench-segment-trial-preview"]') !== null)
    click('[data-testid="workbench-segment-apply"]')
    await waitUntil(() => getWorkbenchNodes().length === 6)
    expect(getWorkbenchNodes()).toHaveLength(6)
    await flush()
    expect(rowNodeIds()).toHaveLength(6)

    const canvas = getNodeOf('n-canvas')
    expect(canvas?.parent).toBeNull()
    expect(canvas?.children).toHaveLength(2)
    expect(canvas?.children).toContain('n-clown')
    const addedIds = canvas?.children.filter((id) => id !== 'n-clown') ?? []
    expect(addedIds).toHaveLength(1)
    expect(addedIds.every((id) => getNodeOf(id)?.parent === 'n-canvas')).toBe(true)
    expect(addedIds.every((id) => rowNodeIds().includes(id))).toBe(true)
  })

  // ---------------------------------------------------------------- [B] 单行节奏

  it('单行节奏：无钻布局虚拟子行；fx 徽标颗数（7/9/4）；双击行名进入重命名', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    expect(q('[data-testid="workbench-layer-gemlayout-n-hat"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')?.getAttribute('data-gem-count')).toBe('7')
    expect(q('[data-testid="workbench-layer-fx-n-face"]')?.getAttribute('data-gem-count')).toBe('9')
    expect(q('[data-testid="workbench-layer-fx-n-bow"]')?.getAttribute('data-gem-count')).toBe('4')
    expect(q('[data-testid="workbench-layer-fx-n-clown"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-canvas"]')).toBeNull()

    q('[data-testid="workbench-layer-select-n-hat"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flush()
    expect(q('[data-testid="workbench-rename-input"]')).not.toBeNull()
  })

  // ---------------------------------------------------------------- [C] 底部操作条

  it('底部操作条：收起全部→仅画布根；展开全部→五行还原；拆分按钮展开提示输入', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(q('[data-testid="workbench-layer-bottombar"]')).not.toBeNull()

    click('[data-testid="workbench-layer-collapse-all"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 1)
    expect(rowNodeIds()).toEqual(['n-canvas'])

    click('[data-testid="workbench-layer-expand-all"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // 拆分按钮：选中叶子后打开抠图 Dialog（T5——任务详情形态；目标面含目标层名）
    click('[data-testid="workbench-layer-select-n-hat"]')
    await flush()
    click('[data-testid="workbench-layer-split-toggle"]')
    await flush()
    expect(q('[data-testid="workbench-segment-dialog"]')).not.toBeNull()
    expect(q('[data-testid="workbench-segment-target"]')?.textContent).toContain('帽子')
    click('[data-testid="workbench-segment-cancel"]')
    await flush()
    expect(q('[data-testid="workbench-segment-dialog"]')).toBeNull()

    // 删除按钮：走确认面（破坏性=确认）
    click('[data-testid="workbench-layer-delete-selected"]')
    await flush()
    expect(q('[data-testid="workbench-delete-confirm"]')).not.toBeNull()
    click('[data-testid="workbench-delete-confirm-cancel"]')
    await flush()
    expect(q('[data-testid="workbench-delete-confirm"]')).toBeNull()
  })

  // ---------------------------------------------------------------- [D] v5 语义

  it('组直改被拒（node-not-leaf——mock 与 daemon 同构）；叶层直改照常', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    const rejected = await applyLayerStrategy('n-clown', 'texture-fill', { mode: 'scatter' }, 2)
    expect(rejected).toBe(false)
    expect(getApplyError()).toContain('node-not-leaf')

    const ok = await applyLayerStrategy('n-hat', 'texture-fill', { mode: 'scatter' }, 2.3)
    expect(ok).toBe(true)
    expect(getApplyError()).toBeNull()
  })

  it('组旧指派读面降级：图层行/Inspector/紧凑态三面标注「组不产钻——已失效」；去重口径计数', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // 种入 v4 语义父层旧指派（mock 内部状态——daemon 侧 execute 已跳过产块，读面降级）
    const state = workbenchStateLens()
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
      rationale: 'v4 旧父层指派（测试种入）',
    })
    // 同步种入父层旧钻（v4 gems 工件形态——父层 blockId 的钻在读面必须被去重）
    const gemsRef = state.detail.gems?.blobRef
    if (gemsRef !== undefined && gemsRef !== null) {
      const doc = state.gemsByRef.get(gemsRef)
      if (doc !== undefined) {
        doc.gems.push({ id: 'n-clown#legacy1', x: 40, y: 60, blockId: 'n-clown', diameterMm: 3 } as Record<string, unknown>)
        doc.gems.push({ id: 'n-clown#legacy2', x: 42, y: 62, blockId: 'n-clown', diameterMm: 3 } as Record<string, unknown>)
      }
    }
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID, { refresh: true })

    // 图层行降级标注
    expect(q('[data-testid="workbench-layer-select-n-clown"]')?.textContent).toContain('组不产钻——已失效')

    // Inspector 组门+旧指派失效标注
    click('[data-testid="workbench-layer-select-n-clown"]')
    await flush()
    expect(q('[data-testid="workbench-params-hierarchy"]')?.textContent).toContain('组不产钻——拆分后在子图层指派')
    expect(q('[data-testid="workbench-params-hierarchy-stale"]')?.textContent).toContain('已失效')
    expect(q('[data-testid="workbench-kind-select"]')).toBeNull()
    expect(q('[data-testid="workbench-apply-strategy"]')).toBeNull()

    // 紧凑态组门（agent 详情形态——紧凑摘要承载同语义）
    // （完整形态下紧凑区块 display:none 但 DOM 在场——文本面可断言）
    expect(q('[data-testid="workbench-compact-strategy"]')?.textContent).toContain('组不产钻——拆分后在子图层指派')

    // 去重口径：父层旧钻（2 颗）不计数；渲染模型不归层（画布无叠钻）
    const model = getWorkbenchLayerRender()
    const clownRow = model?.rows.find((row) => row.node.id === 'n-clown')
    expect(clownRow?.gems.length).toBe(0)
    const totalLeafGems = model?.rows.reduce((sum, row) => sum + row.gems.length, 0) ?? 0
    expect(getEffectiveGemTotal()).toBe(totalLeafGems)
    expect(getEffectiveGemTotal()).toBe(20) // 7+9+4——不含父层旧钻 2 颗

    // fx 定位：组无徽标（组不产钻）——叶子徽标在场
    expect(q('[data-testid="workbench-layer-fx-n-clown"]')).toBeNull()
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')).not.toBeNull()
    expect(getSelectedNodeId()).toBe('n-clown')
  })

  // ---------------------------------------------------------------- [E] 修复轮 R1c：mock 导出叶子口径

  it('导出叶子口径（mock 与 daemon effectiveGems 同构）：父层旧钻不进导出字节/详情计数——三面一致', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    const state = workbenchStateLens()
    // 种入 v4 父层旧钻 2 颗（落**新 ref** 强制 store 重解析——同 ref 原位追加会被
    // 装载缓存的身份复用短路，见 loadWorkbench refUnchanged 分支）
    const gemsRef = state.detail.gems!.blobRef
    const doc = state.gemsByRef.get(gemsRef)!
    doc.gems.push(
      { id: 'n-clown#legacy1', x: 40, y: 60, colorId: '', blockId: 'n-clown', shapeId: 'round', diameterMm: 3 },
      { id: 'n-clown#legacy2', x: 42, y: 62, colorId: '', blockId: 'n-clown', shapeId: 'round', diameterMm: 3 },
    )
    const seededRef = 'wb-fixt-clown-gems-seeded-v5'
    state.gemsByRef.set(seededRef, doc)
    state.detail.gems = { ...state.detail.gems!, blobRef: seededRef }
    // 门净（clown fixture 造数门阻——聚焦叶子口径行为本身；门接线已有 v4 用例覆盖）
    state.maskEdits.length = 0
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID, { refresh: true })

    const api = getBoundAgentApi()! // beforeEach 已 bind——非空断言（与既有用例同裁量）
    // UI 口径：详情计数不含父层旧钻（22-2）
    const detail = await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    expect(detail.gems?.count).toBe(20)
    // 导出面：过滤后字节+新 ref+过滤颗数+degraded warning 明示剔除
    const out = await api.taskExport({ taskId: WORKBENCH_FIXTURE_TASK_ID })
    expect(out.gemCount).toBe(20)
    expect(out.blobRef).not.toBe(seededRef)
    // mock btoa 通道按字节编码——TextDecoder 还原 UTF-8（直接 atob 会得 Latin-1 乱码）
    const decodeJson = (b64: string): unknown =>
      JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
    const decoded = decodeJson(out.dataBase64) as {
      gems: Array<{ blockId: string; id: string }>
      warnings: Array<{ kind: string; detail: string }>
    }
    expect(decoded.gems).toHaveLength(20)
    expect(decoded.gems.every((gem) => gem.blockId !== 'n-clown')).toBe(true)
    expect(decoded.gems.some((gem) => gem.id.startsWith('n-clown#legacy'))).toBe(false)
    expect(decoded.warnings.some((w) => w.kind === 'degraded' && w.detail.includes('2 颗'))).toBe(true)
    // 三面一致（Codex 负向样本验收面：界面=下载=数据）
    expect(detail.gems?.count).toBe(out.gemCount)
    expect(out.gemCount).toBe(decoded.gems.length)
    // 附件通道按新 ref 读回同文档（ref-字节匹配）
    const artifact = await api.taskArtifact({ taskId: WORKBENCH_FIXTURE_TASK_ID, blobRef: out.blobRef })
    const readBack = decodeJson(artifact.dataBase64) as { gems: unknown[] }
    expect(readBack.gems).toHaveLength(20)
  })

  // ---------------------------------------------------------------- [F] 修复轮 R3：图例行颗数==该层计数

  it('编号图例每行颗数==该层 gems 计数（「红鼻子 71」负样本——真机同形 21/71/71 配对冻结）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    // 种入真机走查同形数据（中位行低计数+两侧行等高计数——vision NCC 判读 21→71 的
    // 错位陷阱）：帽子 21/脸蛋 71/蝴蝶结 71（新 ref 强制重解析，同 [E]）
    const state = workbenchStateLens()
    const gemsRef = state.detail.gems!.blobRef
    const doc = state.gemsByRef.get(gemsRef)!
    doc.gems = [
      ...Array.from({ length: 21 }, (_, i) => ({
        id: `n-hat#L${i}`, x: 40 + (i % 10), y: 30 + Math.floor(i / 10), colorId: '',
        blockId: 'n-hat', shapeId: 'round', diameterMm: 3,
      })),
      ...Array.from({ length: 71 }, (_, i) => ({
        id: `n-face#L${i}`, x: 40 + (i % 12), y: 64 + Math.floor(i / 12), colorId: '',
        blockId: 'n-face', shapeId: 'round', diameterMm: 2.5,
      })),
      ...Array.from({ length: 71 }, (_, i) => ({
        id: `n-bow#L${i}`, x: 51 + (i % 8), y: 106 + Math.floor(i / 8), colorId: '',
        blockId: 'n-bow', shapeId: 'round', diameterMm: 2,
      })),
    ]
    const seededRef = 'wb-fixt-clown-gems-legend-v5'
    state.gemsByRef.set(seededRef, doc)
    state.detail.gems = { ...state.detail.gems!, blobRef: seededRef }
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID, { refresh: true })

    click('[data-testid="workbench-preview-numbered"]')
    await flush()

    // 图例行=三产钻叶（树前序：帽子/脸蛋/蝴蝶结——组与画布不在列）
    const rows = qq('[data-testid="workbench-numbered-legend-row"]')
    expect(rows.length).toBe(3)
    const expected: Record<string, number> = { 'n-hat': 21, 'n-face': 71, 'n-bow': 71 }
    for (const row of rows) {
      const nodeId = row.getAttribute('data-node-id') ?? ''
      const count = Number(row.querySelector(':scope > span:last-child')?.textContent ?? 'NaN')
      expect(count, `图例行 ${nodeId} 颗数==该层 gems 计数`).toBe(expected[nodeId])
    }
    // 名-数配对（顺序错位防护）：中位行「帽子」必须带 21 不是 71
    const hatRow = q('[data-testid="workbench-numbered-legend-row"][data-node-id="n-hat"]')
    expect(hatRow?.textContent).toContain('帽子')
    expect(hatRow?.querySelector(':scope > span:last-child')?.textContent?.trim()).toBe('21')
    // 与 fx 徽标/顶栏读数同源（图例≠孤证）
    expect(q('[data-testid="workbench-layer-fx-n-hat"]')?.getAttribute('data-gem-count')).toBe('21')
    expect(q('[data-testid="workbench-layer-fx-n-face"]')?.getAttribute('data-gem-count')).toBe('71')
    expect(q('[data-testid="workbench-layer-fx-n-bow"]')?.getAttribute('data-gem-count')).toBe('71')
    expect(getEffectiveGemTotal()).toBe(163)
  })
})
