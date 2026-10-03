/*
 * [BUG 8317 修复] 图层树折叠/展开滚动锚定聚焦测试：
 * 自然树序（Owner 定调 2026-10-04）：组行子行在其**下方**（clown 在上，hat/face/bow 依序在下）——
 * 锚行取被切换子树**下方**的行（其上方行数随折叠/展开骤变才是回补的场景面）；
 * 无锚定补偿时 scrollTop 数值不动
 * （收起=视口内容整体上跳「向上收起」；展开=锚行被推出视野）。
 * jsdom 无布局：以动态 getBoundingClientRect 补丁按「行序×28px」模拟几何，
 * 断言切换后 scrollTop 按锚行位移差回补（视口稳定在被操作行）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import type { ObjectNode } from '@handicraft/contracts'
import {
  bindAgentApi,
  getBoundAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { resetWorkbenchForTests } from '$lib/components/studio/taskWorkbench/store.svelte'
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

/** 树内行查询（data-node-id 被画布 stage overlay 复用——必须限定树容器内查询）。 */
function treeRow(tree: HTMLElement, nodeId: string): HTMLElement {
  const row = [...tree.querySelectorAll<HTMLElement>(':scope > [data-testid="workbench-layer-row"]')]
    .find((candidate) => candidate.getAttribute('data-node-id') === nodeId)
  if (row === undefined) throw new Error(`树内行不存在：${nodeId}`)
  return row
}

interface MockStateLens {
  nodes: ObjectNode[]
}

async function addCanvasSiblings(count: number): Promise<void> {
  const api = getBoundAgentApi() as MockAgentApi
  await api.taskDetail(WORKBENCH_FIXTURE_TASK_ID)
  const states = (api as unknown as { workbenchStates: Map<string, MockStateLens> }).workbenchStates
  const state = states.get(WORKBENCH_FIXTURE_TASK_ID)
  if (state === undefined) throw new Error('mock 工作台状态缺席')
  const canvas = state.nodes.find((node) => node.parent === null)
  if (canvas === undefined) throw new Error('画布根节点缺席')
  const siblings = Array.from({ length: count }, (_, index) => ({
    ...canvas,
    id: `n-canvas-sibling-${index}`,
    objectName: `旁支 ${index}`,
    bbox: { ...canvas.bbox },
    parent: canvas.id,
    children: [],
  }))
  state.nodes.push(...siblings)
  canvas.children.push(...siblings.map((node) => node.id))
}

// ---------------------------------------------------------------- jsdom 布局模拟

const ROW_H = 28

/** 浏览器滚动范围与行几何：内容缩短后 scrollTop 会先被钳制。 */
function patchLayout(tree: HTMLElement, anchor: HTMLElement): void {
  let requestedScrollTop = 0
  const rect = (top: number): DOMRect =>
    ({ top, bottom: top + ROW_H, left: 0, right: 400, width: 400, height: ROW_H, x: 0, y: top, toJSON: () => ({}) }) as unknown as DOMRect
  const rows = (): HTMLElement[] => [...tree.querySelectorAll<HTMLElement>(':scope > [data-testid="workbench-layer-row"]')]
  Object.defineProperty(tree, 'clientHeight', { configurable: true, value: ROW_H * 2 })
  Object.defineProperty(tree, 'scrollHeight', {
    configurable: true,
    get: () => rows().length * ROW_H,
  })
  Object.defineProperty(tree, 'scrollTop', {
    configurable: true,
    get: () => Math.min(requestedScrollTop, Math.max(0, tree.scrollHeight - tree.clientHeight)),
    set: (value: number) => {
      requestedScrollTop = Math.max(0, Math.min(value, tree.scrollHeight - tree.clientHeight))
    },
  })
  Object.defineProperty(tree, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect(0),
  })
  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const absTop = Math.max(0, rows().indexOf(anchor)) * ROW_H
      return rect(absTop - tree.scrollTop)
    },
  })
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

describe('图层树折叠/展开滚动锚定（BUG 8317「向上收起」）', () => {
  vi.setConfig({ testTimeout: 20_000 })

  it('折叠组：锚行在被折叠子树下方——内容缩短后 scrollTop 回补保持锚行屏幕位置，锚行 DOM keyed 复用', async () => {
    await addCanvasSiblings(7)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 12)
    // 自然树序：canvas(0) clown(1) hat(2) face(3) bow(4) s0(5)…s6(11)。锚=s3(索引 8)——
    // 折叠 clown 移除 hat/face/bow（锚上方 3 行）→ 锚上移 3 行，scrollTop 需 -3 行回补。
    const tree = q('[data-testid="workbench-layer-tree"]')!
    const anchorBefore = treeRow(tree, 'n-canvas-sibling-3')
    patchLayout(tree, anchorBefore)
    tree.scrollTop = rowNodeIds().indexOf('n-canvas-sibling-3') * ROW_H
    expect(anchorBefore.getBoundingClientRect().top).toBe(0)

    click('[data-testid="workbench-layer-collapse-n-clown"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 9)

    expect(tree.scrollTop).toBe((8 - 3) * ROW_H)
    expect(anchorBefore.getBoundingClientRect().top).toBe(0)
    expect(treeRow(tree, 'n-canvas-sibling-3')).toBe(anchorBefore)
  })

  it('展开组：锚行在展开子树下方——插入行推锚下移，scrollTop 随位移回补（+84）', async () => {
    await addCanvasSiblings(2)
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 7)
    click('[data-testid="workbench-layer-collapse-n-clown"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 4)

    // 收起序：canvas(0) clown(1) s0(2) s1(3)。锚=s0（索引 2）贴视口顶。
    const tree = q('[data-testid="workbench-layer-tree"]')!
    const s0 = treeRow(tree, 'n-canvas-sibling-0')
    patchLayout(tree, s0)
    tree.scrollTop = 2 * ROW_H
    expect(s0.getBoundingClientRect().top).toBe(0)

    click('[data-testid="workbench-layer-collapse-n-clown"]') // 展开（toggle）
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 7)

    // 修复：展开在锚上方插入 hat/face/bow（+3 行）→ scrollTop 回补 +84 → 锚仍贴顶
    // 旧代码（无补偿）：scrollTop 恒 56，锚被推到 rect.top=84 视野外（展开锚点丢失）。
    expect(tree.scrollTop).toBe(2 * ROW_H + 84)
    expect(s0.getBoundingClientRect().top).toBe(0)
    expect(rowNodeIds()).toEqual(['n-canvas', 'n-clown', 'n-hat', 'n-face', 'n-bow', 'n-canvas-sibling-0', 'n-canvas-sibling-1'])
  })

  it('收起全部折叠画布根：只保留根行，展开全部恢复自然树序', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="workbench-layer-select-n-canvas"]')
    await flush()

    const tree = q('[data-testid="workbench-layer-tree"]')!
    const canvas = treeRow(tree, 'n-canvas')
    patchLayout(tree, canvas)
    tree.scrollTop = ROW_H * 3

    click('[data-testid="workbench-layer-collapse-all"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 1)

    expect(tree.scrollTop).toBe(0)
    expect(rowNodeIds()).toEqual(['n-canvas'])
    expect(treeRow(tree, 'n-canvas')).toBe(canvas)

    click('[data-testid="workbench-layer-expand-all"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(rowNodeIds()).toEqual(['n-canvas', 'n-clown', 'n-hat', 'n-face', 'n-bow'])
  })
})
