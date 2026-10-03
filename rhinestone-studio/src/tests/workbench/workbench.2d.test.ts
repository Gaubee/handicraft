/*
 * [add-workbench-pro 2d] 波 2d 终验红段（Codex 2bfix+2c 合并复评 6.6/10 NO-GO 的
 * 前端阻塞项固化——红→绿两段式）：
 *   [1] blob LRU 补全（复评建议三）：entries 随当前树节点集清理（树刷新/删节点清
 *       孤儿 entries）+不强持有被逐出 bytes（96 项上界真实生效——entries 的 bits
 *       引用不得越过 LRU 上界）。
 *   [2] a11y roving focus（复评建议四·design §2 遮罩行 a11y）：图层树容器
 *       role=tree 可聚焦 tabindex=0+子项 treeitem tabindex=-1+方向键移动/展开收起
 *       +aria-activedescendant 同步+输入框/IME 保护。
 *   [3] 异步契约前端对齐（复评建议五）：mask.patch 提交 accepted 后不得只做一次
 *       定向刷新——轮询 editState 至终态（ready/error/stale）再刷新（spec.md
 *       异步契约真身）。
 *   [4] mock 通道插值资源上限（复评建议二 三侧之一）：坐标 0..imagePx 界外
 *       typed 拒（mask-invalid）。
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
import type { LayerMaskPatchInput, LayerMaskPatchOutput, MaskEditStatus, TaskDetailResponse } from '@handicraft/contracts'
import { encodeInlineMask, type ObjectNode } from '@handicraft/contracts'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  requestNodeMasks,
  getMaskEntryOf,
  resetMaskBitsForTests,
  MASK_CACHE_MAX,
} from '$lib/components/studio/taskWorkbench/maskBits.svelte'
import {
  beginStroke,
  commitBrushStrokes,
  endStroke,
  enterBrushMode,
  getMaskEditOf,
  getSelectedNodeId,
  loadWorkbench,
  requestRenameSelected,
  resetWorkbenchForTests,
  selectNode,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetUndoDomainsForTests } from '$lib/components/studio/taskWorkbench/undoDomains.svelte'
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
  resetViewForTests('studio')
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

// ---------------------------------------------------------------- [1] blob LRU 补全

/** 合成 inline mask 节点（无需树工件——requestNodeMasks 直驱）。 */
function inlineNode(id: string, w = 8, h = 8): ObjectNode {
  return {
    id,
    objectName: id,
    category: 'part',
    mask: encodeInlineMask(w, h, new Uint8Array(w * h).fill(1)),
    bbox: { x: 0, y: 0, w, h },
    parent: null,
    children: [],
    effectiveMm: 10,
    labVariance: 5,
    drillWorthy: true,
    origin: 'manual-lasso',
  }
}

const SYNC_CTX = { treeBlobRef: 't0', fetchMaskBlob: async () => new Uint8Array() }

describe('mask LRU 补全（Codex 复评建议三：entries 随树清理+逐出 bytes 不强持有）', () => {
  it('树节点集收缩（删节点/树刷新）：孤儿 entries 清理——不在树内的节点条目回落 idle', () => {
    requestNodeMasks([inlineNode('n-a'), inlineNode('n-b')], SYNC_CTX)
    expect(getMaskEntryOf('n-a').phase).toBe('ready')
    expect(getMaskEntryOf('n-b').phase).toBe('ready')

    // 树刷新为只剩 n-a（n-b 被删）：n-b 条目不得驻留 ready（孤儿=内存泄漏面）
    requestNodeMasks([inlineNode('n-a')], SYNC_CTX)
    expect(getMaskEntryOf('n-b').phase).toBe('idle')
    expect(getMaskEntryOf('n-b').bits).toBeNull()
  })

  it('超过 MASK_CACHE_MAX 项：entries 不强持有被逐出 bytes——bits 非空条目数 ≤ 上界', () => {
    const nodes = Array.from({ length: MASK_CACHE_MAX + 8 }, (_, i) => inlineNode(`n-${i}`))
    requestNodeMasks(nodes, SYNC_CTX)
    const loaded = nodes.filter((node) => getMaskEntryOf(node.id).bits !== null)
    // 当前实现：entries 逐节点持有解码位面（LRU 只限 cache Map）——逐出后 bytes 仍被
    // 强引用，上界形同虚设。绿段=逐出条目降级（bits 释放）。
    expect(loaded.length).toBeLessThanOrEqual(MASK_CACHE_MAX)
  })
})

// ---------------------------------------------------------------- [2] a11y roving focus

async function openWorkbench(): Promise<void> {
  await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
  await flush()
}

function treeEl(): HTMLElement {
  const el = q('[role="tree"]')
  if (el === null) throw new Error('role=tree 容器缺席')
  return el
}

function treeitems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
}

describe('图层树 a11y roving focus（Codex 复评建议四：tree 容器焦点+方向键+activedescendant）', () => {
  it('容器 role=tree 可聚焦（tabindex=0）+子项 treeitem tabindex=-1（roving 模式）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await openWorkbench()
    const tree = treeEl()
    expect(tree.getAttribute('tabindex')).toBe('0')
    expect(tree.getAttribute('aria-label')).not.toBeNull()
    const items = treeitems()
    expect(items.length).toBeGreaterThanOrEqual(5)
    for (const item of items) expect(item.getAttribute('tabindex')).toBe('-1')
  })

  it('ArrowDown/ArrowUp 移动活动项（aria-activedescendant 同步）+Enter 选中', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await openWorkbench()
    const tree = treeEl()
    const items = treeitems()
    const idOf = (el: HTMLElement): string => el.getAttribute('id') ?? ''
    // 自然树序（Owner 定调 2026-10-04）：首行=画布根，末行=最深后序叶
    expect(idOf(items[0]!)).toContain('n-canvas')
    expect(idOf(items[items.length - 1]!)).toContain('n-bow')
    expect(tree.getAttribute('aria-activedescendant')).toBe(idOf(items[0]!))

    tree.dispatchEvent(key({ key: 'ArrowDown' }))
    await flush()
    expect(tree.getAttribute('aria-activedescendant')).toBe(idOf(items[1]!))
    tree.dispatchEvent(key({ key: 'ArrowDown' }))
    await flush()
    expect(tree.getAttribute('aria-activedescendant')).toBe(idOf(items[2]!))
    tree.dispatchEvent(key({ key: 'ArrowUp' }))
    await flush()
    expect(tree.getAttribute('aria-activedescendant')).toBe(idOf(items[1]!))

    // 活动项已在 n-clown（自然树序第 2 行——上一步 ArrowUp 后）→ Enter=选中
    expect(tree.getAttribute('aria-activedescendant')).toBe(idOf(treeitems()[1]!))
    tree.dispatchEvent(key({ key: 'Enter' }))
    await flush()
    expect(getSelectedNodeId()).toBe('n-clown')
  })

  it('ArrowLeft 折叠展开节点（aria-expanded 翻转）/ArrowRight 展开', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await openWorkbench()
    const tree = treeEl()
    const clown = treeitems()[1]! // n-clown（自然树序第 2 行——子层默认展开）
    expect(clown.getAttribute('aria-expanded')).toBe('true')

    // 活动项移到 n-clown 后折叠（首行画布根起一次 ArrowDown）
    for (let i = 0; i < 1; i += 1) {
      tree.dispatchEvent(key({ key: 'ArrowDown' }))
      await flush()
    }
    tree.dispatchEvent(key({ key: 'ArrowLeft' }))
    await flush()
    expect(clown.getAttribute('aria-expanded')).toBe('false')
    // 折叠后子行不再渲染（行数收缩）
    expect(treeitems().length).toBe(2)

    tree.dispatchEvent(key({ key: 'ArrowRight' }))
    await flush()
    expect(clown.getAttribute('aria-expanded')).toBe('true')
    expect(treeitems().length).toBe(5)
  })

  it('输入框聚焦时方向键不劫持（重命名/拆分提示输入不受树键盘影响）', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await openWorkbench()
    selectNode('n-clown')
    await flush()
    const tree = treeEl()
    tree.dispatchEvent(key({ key: 'ArrowDown' }))
    await flush()
    const before = tree.getAttribute('aria-activedescendant')
    expect(before).not.toBeNull()

    // 重命名输入框（treeitem 行内——isEditableTarget 保护：不移动活动项）
    requestRenameSelected()
    await flush()
    const renameInput = q('[data-testid="workbench-rename-input"]') as HTMLInputElement | null
    if (renameInput === null) throw new Error('F2 后重命名输入框缺席')
    renameInput.dispatchEvent(key({ key: 'ArrowDown' }))
    await flush()
    expect(tree.getAttribute('aria-activedescendant')).toBe(before)

    // 拆分提示输入框（v5 PS 底部操作条「拆分」展开——树容器外：不触及树键盘面）
    ;(q('[data-testid="workbench-layer-split-toggle"]') as HTMLButtonElement | null)?.click()
    await flush()
    const hint = q('[data-testid="workbench-split-hint"]') as HTMLInputElement | null
    if (hint === null) throw new Error('拆分提示输入框缺席')
    hint.dispatchEvent(key({ key: 'ArrowDown' }))
    await flush()
    expect(tree.getAttribute('aria-activedescendant')).toBe(before)
  })
})

// ---------------------------------------------------------------- [3] 异步契约：提交后等待终态

/** 代理 MockAgentApi：mask.patch 恒返 accepted（异步重算形态）；taskDetail 首次 recomputing→其后 ready。 */
function asyncRecomputeApi(): AgentApi {
  const base = new MockAgentApi({ speed: 0 })
  let editState: MaskEditStatus['state'] = 'ready'
  const target = base as unknown as Record<string, unknown>
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'layerMaskPatch') {
        return async (input: LayerMaskPatchInput): Promise<LayerMaskPatchOutput> => {
          const out = await base.layerMaskPatch(input)
          editState = 'recomputing'
          return { ...out, editState: 'accepted', gems: null }
        }
      }
      if (prop === 'taskDetail') {
        return async (taskId: string): Promise<TaskDetailResponse> => {
          const detail = await base.taskDetail(taskId)
          const state = editState
          if (editState === 'recomputing') editState = 'ready' // 下一轮 taskDetail 报终态
          const nodeId = detail.tree?.nodes.find((n) => n.parent !== null && n.children.length === 0)?.id ?? 'n-hat'
          const edit: MaskEditStatus = {
            nodeId,
            state,
            runCount: 32,
            incomplete: false,
            baseVersion: 2,
            error: null,
            updatedAt: '2026-09-27T00:00:00.000Z',
          }
          return { ...detail, maskEdits: [edit] }
        }
      }
      const value = Reflect.get(obj, prop, receiver)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(obj) : value
    },
  }) as unknown as AgentApi
}

describe('mask.patch 异步契约：accepted 后轮询终态再刷新（Codex 复评建议五）', () => {
  it('提交返回 accepted（gems=null）→轮询 editState 至 ready→最终态 ready（非停留在 recomputing）', async () => {
    bindAgentApi(asyncRecomputeApi())
    await loadWorkbench(WORKBENCH_FIXTURE_TASK_ID)
    selectNode('n-hat')
    expect(enterBrushMode()).toBe(true)
    beginStroke({ x: 40, y: 30 })
    endStroke()
    const ok = await commitBrushStrokes(true)
    expect(ok).toBe(true)
    await flush()
    // 单次定向刷新只能读到 recomputing（旧实现）；绿段=轮询至终态后刷新
    expect(getMaskEditOf('n-hat')?.state).toBe('ready')
  })
})

// ---------------------------------------------------------------- [4] mock 通道插值资源上限

describe('mock 通道坐标界（Codex 复评建议二 三侧之一：0..imagePx 界外 typed 拒）', () => {
  it('x=500 超出 fixture 画布 120px → mask-invalid 拒', async () => {
    const base = new MockAgentApi({ speed: 0 })
    const detail = await base.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
    const treeRef = detail.tree?.blobRef
    if (treeRef === undefined) throw new Error('fixture 任务缺图层树')
    await expect(base.layerMaskPatch({
      taskId: WORKBENCH_FIXTURE_TASK_ID,
      nodeId: 'n-hat',
      ops: [{ op: 'add', radiusPx: 4, points: [{ x: 500, y: 40 }] }],
      expectedTreeBlobRef: treeRef,
      recomputeStrategy: false,
    })).rejects.toThrow('mask-invalid')
  })
})
