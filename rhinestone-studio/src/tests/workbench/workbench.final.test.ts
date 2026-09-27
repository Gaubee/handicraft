/*
 * [2026-09-27 add-workbench-pro 终评收尾轮] Codex 终评 7.0/10 NO-GO 关闭项的 jsdom 面：
 * 1. [P0-1 恢复链] stale/error 重放（maskEditRetry）与确认放弃（maskEditDiscard）的
 *    mock 通道语义（CAS 漂移拒/态门/幂等）+ UI 动作面（图层行「重算」「放弃」按钮
 *    ——成功后终态刷新+导出门重估）。
 * 2. [P1-2 热路径] 定向刷新身份保持回归：内容寻址引用未变时画布模型缓存命中
 *    （同对象身份返回——100k 颗投影不因身份置换重跑）。
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
import type { AgentApi } from '$lib/agentApi/types'
import type { TaskDetailResponse, ObjectNode } from '@handicraft/contracts'
import { encodeInlineMask } from '@handicraft/contracts'
import { StrategyGemsViewSchema, type StrategyGemsView } from '$lib/strategyDesigner/artifacts.js'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  discardMaskEditNode,
  exportTask,
  getExportGate,
  getMaskEditOf,
  getWorkbenchCanvasModel,
  loadWorkbench,
  resetWorkbenchForTests,
  retryMaskEditNode,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetMaskBitsForTests } from '$lib/components/studio/taskWorkbench/maskBits.svelte'
import { resetUndoDomainsForTests } from '$lib/components/studio/taskWorkbench/undoDomains.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountView<P extends Record<string, unknown>>(component: Component<P>, props: P = {} as P): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const instance = mount(component, { target, props })
  mountedDisposers.push(() => {
    unmount(instance)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function click(selector: string): void {
  const el = q(selector)
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

function q(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector)
}

beforeEach(() => {
  resetAgentStoreForTests()
  initAgentStore()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  resetViewForTests()
  resetWorkbenchForTests()
  resetUndoDomainsForTests()
  resetMaskBitsForTests()
  resetToastsForTests()
  document.body.innerHTML = ''
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------- [1] mock 通道恢复链语义

describe('maskEditRetry/maskEditDiscard mock 通道（终评 P0-1）', () => {
  beforeEach(async () => {
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
  })

  it('fixture 阻断面在场：n-face stale+n-bow incomplete → 门阻双因子', () => {
    expect(getMaskEditOf('n-face')?.state).toBe('stale')
    expect(getMaskEditOf('n-bow')?.incomplete).toBe(true)
    expect(getExportGate()).toEqual({ allowed: false, blockers: ['mask-incomplete', 'mask-stale'] })
  })

  it('stale 重放（n-face）：CAS 基线正确 → ready 留痕+mask-stale 因子解除', async () => {
    const ok = await retryMaskEditNode('n-face')
    expect(ok).toBe(true)
    expect(getMaskEditOf('n-face')?.state).toBe('ready')
    expect(getExportGate()).toEqual({ allowed: false, blockers: ['mask-incomplete'] }) // n-bow incomplete 仍在
  })

  it('stale 重放 CAS 漂移（expectedBaseVersion≠行现值）：mock typed 拒 cas-mismatch', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const channel = api as unknown as AgentApi
    const current = getMaskEditOf('n-face')!
    await expect(
      channel.maskEditRetry({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-face', expectedBaseVersion: current.baseVersion + 1 }),
    ).rejects.toThrow('cas-mismatch')
    // 态门：限内 ready 留痕重放拒 invalid-input（重放仅面向 stale/error）
    await channel.maskEditRetry({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-face', expectedBaseVersion: current.baseVersion })
    await expect(
      channel.maskEditRetry({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-face', expectedBaseVersion: getMaskEditOf('n-face')!.baseVersion }),
    ).rejects.toThrow('invalid-input')
  })

  it('放弃 incomplete 留痕（n-bow）：行清+门全开+导出走通', async () => {
    // 先重放 n-face（清 stale）→ 再弃 n-bow（清 incomplete）→ 门全开 → 导出成功
    await retryMaskEditNode('n-face')
    const ok = await discardMaskEditNode('n-bow')
    expect(ok).toBe(true)
    expect(getMaskEditOf('n-bow')).toBeNull()
    expect(getExportGate()).toEqual({ allowed: true, blockers: [] })
    const exported = await exportTask()
    expect(exported).toBe(true)
  })

  it('幂等放弃：行已不在 → mock 返 discarded:false', async () => {
    const api = new MockAgentApi({ speed: 0 })
    const channel = api as unknown as AgentApi
    const out = await channel.maskEditDiscard({ taskId: WORKBENCH_FIXTURE_TASK_ID, nodeId: 'n-ghost', expectedBaseVersion: 1 })
    expect(out.discarded).toBe(false)
  })
})

// ---------------------------------------------------------------- [2] UI 动作面（图层行按钮）

describe('图层行恢复链按钮（终评 P0-1——重算/放弃）', () => {
  beforeEach(async () => {
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await flush()
  })

  it('stale 行呈现「重算」+「放弃」；incomplete 行仅「放弃」；限内 ready 行无动作', async () => {
    // v3：恢复链动作面在右侧属性面板——先选中目标层（行上仅阻断告警徽标）
    expect(q('[data-testid="workbench-mask-edit-n-face"]')?.textContent).toContain('已漂移')
    expect(q('[data-testid="workbench-mask-edit-n-bow"]')?.textContent).toContain('4096')
    click('[data-testid="workbench-layer-select-n-face"]')
    await flush()
    expect(q('[data-testid="workbench-mask-retry-n-face"]')).not.toBeNull()
    expect(q('[data-testid="workbench-mask-discard-n-face"]')).not.toBeNull()
    expect(q('[data-testid="workbench-mask-retry-n-bow"]')).toBeNull()
    expect(q('[data-testid="workbench-mask-discard-n-bow"]')).toBeNull()
    click('[data-testid="workbench-layer-select-n-bow"]')
    await flush()
    expect(q('[data-testid="workbench-mask-retry-n-bow"]')).toBeNull()
    expect(q('[data-testid="workbench-mask-discard-n-bow"]')).not.toBeNull()
  })

  it('点击「重算」：徽标 stale→已编辑（ready）+mask-stale 阻断解除', async () => {
    click('[data-testid="workbench-layer-select-n-face"]')
    await flush()
    q('[data-testid="workbench-mask-retry-n-face"]')!.click()
    await flush(120)
    expect(getMaskEditOf('n-face')?.state).toBe('ready')
    expect(q('[data-testid="workbench-mask-retry-n-face"]')).toBeNull() // 终态后按钮退场
    expect(getExportGate().blockers).toEqual(['mask-incomplete'])
  })

  it('点击「放弃」（incomplete 行）：行徽标退场+导出门全开+导出按钮可用', async () => {
    // n-face stale 与 n-bow incomplete 各自可弃——先弃 n-face 再弃 n-bow → 门全开
    click('[data-testid="workbench-layer-select-n-face"]')
    await flush()
    q('[data-testid="workbench-mask-discard-n-face"]')!.click()
    await flush(120)
    click('[data-testid="workbench-layer-select-n-bow"]')
    await flush()
    q('[data-testid="workbench-mask-discard-n-bow"]')!.click()
    await flush(120)
    expect(getMaskEditOf('n-face')).toBeNull()
    expect(getMaskEditOf('n-bow')).toBeNull()
    expect(q('[data-testid="workbench-mask-discard-n-bow"]')).toBeNull()
    expect(getExportGate()).toEqual({ allowed: true, blockers: [] })
  })
})

// ---------------------------------------------------------------- [3] P1-2 热路径身份保持

describe('定向刷新身份保持（终评 P1-2——热载入投影缓存命中）', () => {
  it('同 ref 刷新：画布模型缓存命中（同对象身份）+树推进后缓存失效重建', async () => {
    const IMAGE_PX = { width: 512, height: 512 }
    const CANVAS_CM = { w: 25, h: 25 }
    const nodes: ObjectNode[] = [
      {
        id: 'n-a', objectName: '层 A', category: 'part',
        mask: encodeInlineMask(8, 8, new Uint8Array(64).fill(1)),
        bbox: { x: 0, y: 0, w: 512, h: 512 }, parent: null, children: [],
        effectiveMm: 250, labVariance: 5, drillWorthy: true, origin: 'vlm+sam3',
      },
    ]
    const gemsDoc: StrategyGemsView = StrategyGemsViewSchema.parse({
      kind: 'strategy-gems', formatVersion: 1, planRef: 'a'.repeat(64), canvasCm: CANVAS_CM, imagePx: IMAGE_PX,
      gems: Array.from({ length: 2000 }, (_, i) => ({
        id: `g${i}`, x: (i * 3.7) % IMAGE_PX.width, y: (i * 7.1) % IMAGE_PX.height,
        colorId: 'c1', blockId: 'n-a', shapeId: 'round', diameterMm: 3,
      })),
      excludedRegions: [], warnings: [], createdAt: '2026-09-27T00:00:00.000Z',
    })
    const detail: TaskDetailResponse = {
      task: { id: 'perf-id-1', title: 't', status: 'done', createdAt: '2026-09-27T00:00:00.000Z' },
      session: null,
      baseImage: { blobRef: 'base-ref-1', widthPx: IMAGE_PX.width, heightPx: IMAGE_PX.height, canvasCm: CANVAS_CM },
      tree: { blobRef: 'tree-ref-1', nodes },
      assignments: [],
      gems: { blobRef: 'gems-ref-1', count: gemsDoc.gems.length, excludedRegions: 0 },
      preview: null,
      viewState: null,
      maskEdits: [],
      exportGate: { allowed: true, blockers: [] },
      stoneCandidates: [],
    }
    const artifact = (ref: string): { blobRef: string; mime: string; dataBase64: string } =>
      ref === 'gems-ref-1'
        ? { blobRef: ref, mime: 'application/json', dataBase64: Buffer.from(JSON.stringify(gemsDoc), 'utf8').toString('base64') }
        : { blobRef: ref, mime: 'application/octet-stream', dataBase64: '' }
    let treeRef = 'tree-ref-1'
    const api = {
      mode: 'mock' as const,
      connection: () => 'mock' as const,
      onConnectionChange: () => () => {},
      taskDetail: async () => structuredClone({ ...detail, tree: { blobRef: treeRef, nodes } }),
      taskArtifact: async (input: { blobRef: string }) => artifact(input.blobRef),
    } as unknown as AgentApi
    bindAgentApi(api)
    await loadWorkbench('perf-id-1')
    const modelCold = getWorkbenchCanvasModel()
    expect(modelCold).not.toBeNull()

    // 同 ref 定向刷新（身份保持面）：模型缓存命中——同对象身份返回
    await loadWorkbench('perf-id-1', { refresh: true })
    expect(getWorkbenchCanvasModel()).toBe(modelCold)

    // 树推进（ref 变化）：缓存必失效重建（语义不回退）
    treeRef = 'tree-ref-2'
    await loadWorkbench('perf-id-1', { refresh: true })
    expect(getWorkbenchCanvasModel()).not.toBe(modelCold)
  })
})
