/*
 * [2026-09-20 studio-layers 2.7] UI 拓扑 + 面板族验收面（tasks 2.7）：
 * - 面板交互：层名双击重命名（行内输入）/ 合并到本层（多选）/ 删除确认 Dialog（兜底层禁用）/
 *   选择序徽标 ①②③ / 眼睛切换 / [+ 新建图层] / 背景层行选中 → 背景面板；
 * - 历史面板：⤺⤻ 按钮 + 倒序摘要 + 空历史态 + ⌘Z 同源；
 * - 布局冒烟：四区按序 + 左列双 tab 可见性（jsdom 恒桌面分支——matchMedia 无布局；三档真浏览器
 *   viewport 归 Owner 走查硬承诺，见 tasks 2.7）；
 * - 状态矩阵抽检（图层稿 §B.9 12 态的新增四态：多选·配置不同 / 隐藏层观察 / 背景层选中 / 历史重放中）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import {
  clearLayerSelection,
  dispatchLayerConfigOp,
  getBackgroundObservation,
  getBlocks,
  getLayerById,
  getLayers,
  getLayerResult,
  getOps,
  getSegK,
  getSegSeed,
  getSelectionOrder,
  getUndoDepth,
  isBackgroundSelected,
  loadFromEngineImage,
  resetStudioForTests,
  selectAllLayers,
  selectLayer,
  setLayerVisible,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { dispatchStudioOp, undoStudioOp } from '$lib/studio/history.svelte'
import { fixtureShapes } from '../engine/helpers'

// jsdom 未实现 ResizeObserver；bits-ui 组件依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

async function mountStudio(): Promise<{ unmount: () => void }> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StudioView, { target })
  await tick()
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function loaded(): Promise<void> {
  loadFromEngineImage(fixtureShapes(), 'panels.png', 'upload')
  await waitForStudioIdle()
}

function click(selector: string): void {
  document.querySelector<HTMLElement>(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function dblclick(selector: string): void {
  document.querySelector<HTMLElement>(selector)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

beforeEach(() => {
  resetStudioForTests()
})

describe('2.7 图层面板交互', () => {
  it('双击层名 → 行内重命名输入 → Enter 提交（op 入史）', async () => {
    await loaded()
    const { unmount } = await mountStudio()
    const depthBefore = getUndoDepth()
    dblclick('[data-testid="layer-row-L1"] span[role="button"]')
    await tick()
    const input = document.querySelector<HTMLInputElement>('[data-testid="layer-rename-input"]')
    expect(input).not.toBeNull()
    input!.value = '主图案'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick()
    expect(getLayerById('L1')?.name).toBe('主图案')
    expect(getUndoDepth()).toBe(depthBefore + 1)
    unmount()
  })

  it('多选徽标 ①②③ = 选择序；行点击单选重置', async () => {
    await loaded()
    dispatchStudioOp({ t: 'layer.create', name: '细节' })
    dispatchStudioOp({ t: 'layer.create', name: '轮廓' })
    const { unmount } = await mountStudio()
    selectLayer('L3')
    selectLayer('L1', 'toggle')
    selectLayer('L2', 'toggle')
    await tick()
    expect(document.querySelector('[data-testid="layer-badge-L3"]')?.textContent?.trim()).toBe('①')
    expect(document.querySelector('[data-testid="layer-badge-L1"]')?.textContent?.trim()).toBe('②')
    expect(document.querySelector('[data-testid="layer-badge-L2"]')?.textContent?.trim()).toBe('③')
    click('[data-testid="layer-row-L2"]')
    await tick()
    expect(getSelectionOrder()).toEqual(['L2'])
    expect(document.querySelector('[data-testid="layer-badge-L2"]')).toBeNull()
    unmount()
  })

  it('删除 = 确认 Dialog（取消/确认两路）；兜底层删除项禁用', async () => {
    await loaded()
    dispatchStudioOp({ t: 'layer.create', name: '临层' })
    const { unmount } = await mountStudio()

    // 兜底层删除按钮禁用（不可删）
    click('[data-testid="layer-menu-L1"]')
    await tick()
    const restDelete = document.querySelector<HTMLButtonElement>('[data-testid="layer-delete-L1"]')
    expect(restDelete?.disabled).toBe(true)

    // 普通层：菜单 → 删除 → 确认 Dialog 出现 → 取消不动 → 再删 → 确认移除
    click('[data-testid="layer-menu-L2"]')
    await tick()
    click('[data-testid="layer-delete-L2"]')
    await tick()
    expect(document.querySelector('[data-testid="layer-delete-confirm"]')).not.toBeNull()
    click('[data-testid="layer-delete-cancel"]')
    await tick()
    expect(getLayerById('L2')).not.toBeNull()
    click('[data-testid="layer-menu-L2"]')
    await tick()
    click('[data-testid="layer-delete-L2"]')
    await tick()
    click('[data-testid="layer-delete-confirm"]')
    await tick()
    expect(getLayerById('L2')).toBeNull()
    unmount()
  })

  it('合并到本层：多选 ≥2 时行菜单合并项可用并执行（并集入锚点层）', async () => {
    await loaded()
    const blockIds = getBlocks().slice(0, 1).map((b) => b.id)
    dispatchStudioOp({ t: 'layer.create', name: '前景', blockIds })
    dispatchStudioOp({ t: 'layer.create', name: '细节' })
    const { unmount } = await mountStudio()
    selectAllLayers()
    await tick()
    click('[data-testid="layer-menu-L2"]')
    await tick()
    const merge = document.querySelector<HTMLButtonElement>('[data-testid="layer-merge-L2"]')
    expect(merge?.disabled).toBe(false)
    merge!.click()
    await tick()
    // L3/L1 的块并集入 L2；仅剩 L2（rest 哨兵随锚点保持——L1 为兜底层被并入后哨兵唯一）
    const layers = getLayers()
    expect(layers.some((l) => l.id === 'L3')).toBe(false)
    expect(getSelectionOrder()).toEqual(['L2'])
    unmount()
  })

  it('眼睛切换 = 观察态（行状态与统计附注即时反映，不触发重算）', async () => {
    await loaded()
    const { unmount } = await mountStudio()
    const entry = getLayerResult('L1')
    click('[data-testid="layer-eye-L1"]')
    await tick()
    expect(getLayerById('L1')?.visible).toBe(false)
    expect(getLayerResult('L1')).toBe(entry) // 未重算
    expect(document.querySelector('[data-testid="status-layer-count"]')?.textContent).toContain('含 1 隐藏层')
    click('[data-testid="layer-eye-L1"]')
    await tick()
    expect(getLayerById('L1')?.visible).toBe(true)
    unmount()
  })

  it('背景层行选中 → 检查器背景面板（源+透明度+只读说明）；层选择清空', async () => {
    await loaded()
    const { unmount } = await mountStudio()
    click('[data-testid="layer-row-background"]')
    await tick()
    expect(isBackgroundSelected()).toBe(true)
    expect(document.querySelector('[data-testid="background-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="layer-config-card"]')).toBeNull()
    expect(document.querySelector('[data-testid="background-source-select"]')).not.toBeNull()
    expect(getBackgroundObservation().opacity).toBe(0.5)
    unmount()
  })

  it('[+ 新建图层]：空层继承锚点配置 + 选中新层', async () => {
    await loaded()
    const { unmount } = await mountStudio()
    click('[data-testid="layer-create"]')
    await tick()
    const created = getLayers()[1]
    expect(created?.name).toBe('图层 2')
    expect(created?.strategy).toBe('hybrid')
    expect(getSelectionOrder()).toEqual([created?.id])
    unmount()
  })

  it('键盘：↑↓ 单选移动 / Space 切眼睛 / Cmd+A 全选（面板容器承接）', async () => {
    await loaded()
    dispatchStudioOp({ t: 'layer.create', name: '细节' })
    const { unmount } = await mountStudio()
    const panel = document.querySelector<HTMLElement>('[data-testid="layer-panel"]')!
    panel.focus()
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await tick()
    expect(getSelectionOrder()).toEqual(['L2'])
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await tick()
    expect(getLayerById('L2')?.visible).toBe(false)
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()
    expect(getSelectionOrder()).toEqual(['L1', 'L2'])
    unmount()
  })
})

describe('2.7 历史面板', () => {
  it('空历史态显式；操作后倒序摘要 + 撤销/重做按钮态 + ⌘Z 同源', async () => {
    await loaded()
    const { unmount } = await mountStudio()
    click('[data-testid="left-tab-history"]')
    await tick()
    expect(document.querySelector('[data-testid="history-empty"]')).not.toBeNull()

    dispatchLayerConfigOp(['L1'], { gapMm: 0.6 })
    dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: '主图案' })
    click('[data-testid="left-tab-history"]')
    await tick()
    const items = [...document.querySelectorAll('[data-testid="history-item"]')]
    expect(items.length).toBe(2)
    expect(items[0]?.textContent).toContain('重命名 → 主图案') // 最新在上
    expect(items[1]?.textContent).toContain('层配置')

    // ⤺ 按钮与 ⌘Z 同源（同一 undoStudioOp）
    click('[data-testid="history-undo"]')
    await tick()
    expect(getLayerById('L1')?.name).toBe('图层 1')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    await tick()
    expect(getLayerById('L1')?.physics.gapMm).toBe(0.4) // ⌘Z 撤销下一步
    expect(document.querySelector('[data-testid="history-empty"]')).not.toBeNull()
    expect(getOps()).toHaveLength(0)
    unmount()
  })
})

describe('2.7 状态矩阵抽检（§B.9 新增四态）', () => {
  it('多选·配置不同：横幅「N 层配置不同 · 以 ①层名 为基准」在场（检查器层配置卡）', async () => {
    await loaded()
    const blockIds = getBlocks().slice(0, 1).map((b) => b.id)
    dispatchStudioOp({ t: 'layer.create', name: '前景', blockIds })
    dispatchLayerConfigOp(['L2'], { strategy: 'poisson' })
    const { unmount } = await mountStudio()
    selectLayer('L1')
    selectLayer('L2', 'toggle')
    await tick()
    const banner = document.querySelector('[data-testid="layer-config-mixed"]')
    expect(banner?.textContent).toContain('2 层配置不同')
    expect(banner?.textContent).toContain('①图层 1')
    expect(banner?.textContent).toContain('为基准')
    unmount()
  })

  it('隐藏层观察：统计/导出口径不变（状态条「含 k 隐藏层」附注在场）', async () => {
    await loaded()
    const { unmount } = await mountStudio()
    const before = document.querySelector('[data-testid="export-gem-count"]')?.textContent ?? ''
    setLayerVisible('L1', false)
    await tick()
    const after = document.querySelector('[data-testid="export-gem-count"]')?.textContent ?? ''
    expect(after).toBe(before) // 隐藏 ≠ 排除
    unmount()
  })

  it('历史重放中：撤销跨重分块（segment.opts 回旧 k/seed → 引擎确定性重生成旧块 id）', async () => {
    await loaded()
    const idsBefore = getBlocks().map((b) => b.id)
    const { unmount } = await mountStudio()
    dispatchStudioOp({ t: 'segment.opts', k: 8, seed: 5 })
    await waitForStudioIdle()
    expect(getBlocks().length).toBeGreaterThan(0)
    expect(undoStudioOp()).toBe(true)
    await waitForStudioIdle()
    // 回旧 k/seed → 引擎确定性重放：块 id 与重分块前逐位一致（fixtureShapes 的 kmeans
    // 对分离色区不随 seed 漂移——参数面差异由 k/seed 读数断言承载）
    expect(getBlocks().map((b) => b.id)).toEqual(idsBefore)
    expect(getSegK()).toBe(8)
    expect(getSegSeed()).toBe(1)
    unmount()
  })
})

describe('2.7 布局冒烟', () => {
  it('四区按序：上下文条 → [左列|画布|检查器] → 状态条；左列双 tab 与图层面板在场', async () => {
    await loaded()
    const { unmount } = await mountStudio()
    const zones = ['[data-testid="context-bar"]', '[data-testid="studio-mid"]', '[data-testid="status-bar"]']
    const els = zones.map((sel) => document.querySelector(sel))
    for (const el of els) expect(el).not.toBeNull()
    for (let i = 0; i < els.length - 1; i++) {
      expect(els[i]!.compareDocumentPosition(els[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const mid = document.querySelector('[data-testid="studio-mid"]')!
    expect(mid.querySelector('[data-testid="studio-left-column"]')).not.toBeNull()
    expect(mid.querySelector('[data-testid="studio-stage"]')).not.toBeNull()
    expect(mid.querySelector('[data-testid="studio-inspector-slot"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="strategy-film-strip"]')).toBeNull() // 胶片带整区废除
    unmount()
  })

  it('检查器折叠组：块列表只列选中层块（layerOnly）', async () => {
    await loaded()
    const blockIds = getBlocks().slice(0, 1).map((b) => b.id)
    dispatchStudioOp({ t: 'layer.create', name: '前景', blockIds })
    await waitForStudioIdle()
    const { unmount } = await mountStudio()
    selectLayer('L2')
    await tick()
    // 展开块列表折叠组（Accordion trigger 点击）
    const triggers = [...document.querySelectorAll('[data-testid="inspector"] button')]
    const blockTrigger = triggers.find((b) => b.textContent?.includes('块列表'))
    blockTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    const summary = document.querySelector('[data-testid="inspector"]')?.textContent ?? ''
    expect(summary).toContain('选中层 1 块 / 全部')
    unmount()
  })
})
