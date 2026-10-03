/*
 * [BUG 8317 修复] 图层树折叠/展开滚动锚定聚焦测试：
 * PS 逆序表中组行子行在其**上方**（bow/face/hat 在 clown 之上）——折叠移除上方行、
 * 展开在其上方插行，组行的滚动内容偏移随切换骤变；无锚定补偿时 scrollTop 数值不动
 * （收起=视口内容整体上跳「向上收起」；展开=锚行被推出视野）。
 * jsdom 无布局：以动态 getBoundingClientRect 补丁按「行序×28px」模拟几何，
 * 断言切换后 scrollTop 按锚行位移差回补（视口稳定在被操作行）。
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
  const row = tree.querySelector<HTMLElement>(`:scope [data-testid="workbench-layer-row"][data-node-id="${nodeId}"]`)
  if (row === null) throw new Error(`树内行不存在：${nodeId}`)
  return row
}

// ---------------------------------------------------------------- jsdom 布局模拟

const ROW_H = 28

/** 滚动容器与锚行的动态几何：rect.top = 行序×ROW_H − 当前 scrollTop（rect 差法可测）。 */
function patchLayout(tree: HTMLElement, anchor: HTMLElement): void {
  const rect = (top: number): DOMRect =>
    ({ top, bottom: top + ROW_H, left: 0, right: 400, width: 400, height: ROW_H, x: 0, y: top, toJSON: () => ({}) }) as unknown as DOMRect
  Object.defineProperty(tree, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect(0),
  })
  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const rows = [...tree.querySelectorAll<HTMLElement>(':scope > [data-testid="workbench-layer-row"]')]
      const absTop = Math.max(0, rows.indexOf(anchor)) * ROW_H
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

  it('折叠组：scrollTop 随锚行位移回补（84→0）——视口不向上跳，锚行元素 keyed 复用', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    expect(rowNodeIds()).toEqual(['n-bow', 'n-face', 'n-hat', 'n-clown', 'n-canvas'])

    const tree = q('[data-testid="workbench-layer-tree"]')!
    const clownBefore = treeRow(tree, 'n-clown')
    patchLayout(tree, clownBefore)
    // 滚到 clown 行贴视口顶（第 4 行×28=84）——折叠前锚行在视口顶
    tree.scrollTop = 84

    click('[data-testid="workbench-layer-collapse-n-clown"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 2)

    // 修复：clown 内容偏移 84→0，scrollTop 回补 -84 → 0（视口钉在 clown，不向上跳）
    // 旧代码：scrollTop 恒 84（内容仅剩 56px——真机被钳制跳位；jsdom 中锚行 rect.top=-84 出视野）
    expect(tree.scrollTop).toBe(0)
    expect(clownBefore.getBoundingClientRect().top).toBe(0)
    // keyed each：锚行 DOM 元素复用（非重建）
    expect(treeRow(tree, 'n-clown')).toBe(clownBefore)
  })

  it('展开组：scrollTop 随锚行位移回补（0→84）——锚行不被推出视野', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
    click('[data-testid="workbench-layer-collapse-n-clown"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 2)

    const tree = q('[data-testid="workbench-layer-tree"]')!
    const clown = treeRow(tree, 'n-clown')
    patchLayout(tree, clown)
    tree.scrollTop = 0 // 收起态 clown 在内容顶

    click('[data-testid="workbench-layer-collapse-n-clown"]') // 展开（toggle）
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    // 修复：clown 内容偏移 0→84（子行插到上方），scrollTop 回补 +84 → 锚行仍贴视口顶
    // 旧代码：scrollTop 恒 0，clown rect.top=84 被推出视野（展开锚点丢失）
    expect(tree.scrollTop).toBe(84)
    expect(clown.getBoundingClientRect().top).toBe(0)
    expect(rowNodeIds()).toEqual(['n-bow', 'n-face', 'n-hat', 'n-clown', 'n-canvas'])
  })

  it('收起全部：锚=活动行（选中 clown）——scrollTop 同步回补，不整体上跳', async () => {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)

    click('[data-testid="workbench-layer-select-n-clown"]') // 选中→活动行跟随
    await flush()

    const tree = q('[data-testid="workbench-layer-tree"]')!
    const clown = treeRow(tree, 'n-clown')
    patchLayout(tree, clown)
    tree.scrollTop = 84

    click('[data-testid="workbench-layer-collapse-all"]')
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 2)

    expect(tree.scrollTop).toBe(0)
    expect(clown.getBoundingClientRect().top).toBe(0)
    expect(rowNodeIds()).toEqual(['n-clown', 'n-canvas'])
  })
})
