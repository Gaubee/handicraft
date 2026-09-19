/*
 * [2026-09-20 D-5.5 Test] 笔刷算法落地（rename-and-expert-workbench tasks 5.5）：
 * 消费意图流（emitBrushEvent 直驱 + EditView jsdom pointer 全链）——
 * draw 物化断言（shapeId/diameterMm/colorId 源头戳 + origin='manual' + 格位落位）、
 * 冲突拒画（pairwise 判据 + 闪红读数 + 空笔不产 undo 组）、
 * erase 命中删除（1.5×半径口径 + 原位回插）、
 * 一笔 = 单 undo 组（多点/多删合并；两笔两组）、snap grid/free 两模式、
 * 笔刷规格覆盖态（setBrushSpec——5.3 选择器写入口预埋）与基准派生、退订停摆。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EditView from '$lib/components/views/EditView.svelte'
import { getEditDoc, getGemCount, getUndoDepths, loadFromHandoff, resetEditForTests, undo } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  emitBrushEvent,
  getBrushRejections,
  resetWorkbenchForTests,
  setBrushSpec,
} from '../../components/Edit/workbench.svelte'
import { attachBrushEngine, makeBrushGem, resolveBrushSpec } from '../../components/Edit/brushEngine'
import type { BrushPoint } from '../../components/Edit/brushGesture'
import { computeFit } from '../../components/Studio/fit'
import { makeHandoff } from './helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

const FIT = computeFit(600, 420, 64, 64)

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

function pointer(el: Element, type: string, at: { x: number; y: number }): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: c.clientX,
      clientY: c.clientY,
    }),
  )
}

/** 直驱意图流（绕过手势层——手势/吸附语义已由 workbench.brush 覆盖）。 */
function stroke(tool: 'draw' | 'erase', snap: 'grid' | 'free', points: BrushPoint[]): void {
  emitBrushEvent({ phase: 'begin', intent: { tool, snap, points: [points[0]] } })
  for (const p of points.slice(1)) {
    emitBrushEvent({ phase: 'move', intent: { tool, snap, points }, appended: [p] })
  }
  emitBrushEvent({ phase: 'end', intent: { tool, snap, points } })
}

function manualGems() {
  return getEditDoc()!.gems.filter((g) => g.origin === 'manual')
}

/** 干净落区：snap 格阵 row2（y≈13.856）——与 fixture 行（y=4, pitch 8）最近距 ≈10.6px ≥ 判距 7.99。 */
const ROW2_Y = 8 * Math.sqrt(3) / 2 * 2 // = 13.856…
const CLEAN_A: BrushPoint = { x: 0, y: ROW2_Y }
const CLEAN_B: BrushPoint = { x: 8, y: ROW2_Y }

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12)) // 行钻 (4,4)..(92,4)；SS10 基准径 2.8 / 色板首色 red
})

describe('draw：物化断言 + 格位落位', () => {
  it('吸附落点物化手工钻：shapeId/diameterMm/colorId 源头戳 + origin=manual + blockId null', () => {
    const detach = attachBrushEngine()
    stroke('draw', 'grid', [CLEAN_A, CLEAN_B])

    const added = manualGems()
    expect(added).toHaveLength(2)
    expect(getGemCount()).toBe(14)
    for (const gem of added) {
      expect(gem.origin).toBe('manual')
      expect(gem.blockId).toBeNull()
      expect(gem.moved).toBe(false)
      expect(gem.shapeId).toBe('round') // 基准派生规格
      expect(gem.diameterMm).toBe(2.8) // SS10 基准径（grid 派生）
      expect(gem.colorId).toBe('red') // 色板首色
      expect(gem.id).toMatch(/^m-\d+$/)
      expect(gem.rotationDeg).toBeUndefined() // 朝向缺省（圆钻恒缺省）
    }
    expect(added.map((g) => g.x)).toEqual([CLEAN_A.x, CLEAN_B.x]) // 格位落位（格心）
    expect(added[0].y).toBeCloseTo(ROW2_Y, 10)

    detach()
  })

  it('snap=free：原始坐标原样落钻（不过格位）', () => {
    const detach = attachBrushEngine()
    const raw = { x: 2.37, y: 20.11 }
    stroke('draw', 'free', [raw])
    const added = manualGems()
    expect(added).toHaveLength(1)
    expect(added[0].x).toBe(2.37)
    expect(added[0].y).toBe(20.11)

    detach()
  })

  it('makeBrushGem 纯构造：规格字段逐位物化（源头戳纪律）', () => {
    const gem = makeBrushGem({ shapeId: 'square', diameterMm: 4.8, colorId: 'black' }, 'm-9', 10, 20)
    expect(gem).toEqual({
      id: 'm-9',
      x: 10,
      y: 20,
      colorId: 'black',
      blockId: null,
      origin: 'manual',
      moved: false,
      shapeId: 'square',
      diameterMm: 4.8,
    })
  })

  it('resolveBrushSpec：覆盖态优先；null = 文档基准派生（round×基准径×首色）', () => {
    const doc = getEditDoc()!
    expect(resolveBrushSpec(doc)).toEqual({ shapeId: 'round', diameterMm: 2.8, colorId: 'red' })
    setBrushSpec({ shapeId: 'heart', diameterMm: 4.3, colorId: 'gold' })
    expect(resolveBrushSpec(doc)).toEqual({ shapeId: 'heart', diameterMm: 4.3, colorId: 'gold' })
    setBrushSpec(null)
    expect(resolveBrushSpec(doc).shapeId).toBe('round')
  })
})

describe('冲突拒画（pairwise 判据 + 闪红）', () => {
  it('占用格位/近距落点拒画：不落钻、闪红读数记录、空笔不产 undo 组', () => {
    const detach = attachBrushEngine()
    stroke('draw', 'grid', [
      { x: 12, y: 4 }, // 既有钻格位（距离 0）
      { x: 12, y: 6 }, // 距既有钻 2px < 7.99
    ])

    expect(getGemCount()).toBe(12) // 全拒
    expect(manualGems()).toHaveLength(0)
    expect(getUndoDepths().undo).toBe(0) // 空笔组丢弃
    expect(getBrushRejections()).toEqual([{ x: 12, y: 4 }, { x: 12, y: 6 }])

    detach()
  })

  it('笔内 pairwise：同笔第二点撞第一点 → 拒（含本笔已落钻判距）', () => {
    const detach = attachBrushEngine()
    stroke('draw', 'free', [CLEAN_A, { x: CLEAN_A.x + 1, y: CLEAN_A.y }]) // 距 1px < 7.99
    expect(manualGems()).toHaveLength(1) // 第二点拒
    expect(getBrushRejections()).toHaveLength(1)

    detach()
  })

  it('下一笔起笔清零闪红读数', () => {
    const detach = attachBrushEngine()
    stroke('draw', 'grid', [{ x: 12, y: 4 }])
    expect(getBrushRejections()).toHaveLength(1)
    stroke('draw', 'grid', [CLEAN_A])
    expect(getBrushRejections()).toHaveLength(0)
    expect(manualGems()).toHaveLength(1)

    detach()
  })

  it('笔刷规格覆盖态参与判距：4.8mm 径在 2.8mm 可落位处拒画', () => {
    const detach = attachBrushEngine()
    // 距 (4,4) 9px：基准径判距 7.99 可落；4.8mm 判距 (4.8+2.8)/2+0.4=4mm×2.5=10px → 拒
    const at9px = { x: 4 + 9 * Math.cos(Math.PI / 2), y: 4 + 9 }
    setBrushSpec({ shapeId: 'round', diameterMm: 4.8, colorId: 'black' })
    stroke('draw', 'free', [at9px])
    expect(manualGems()).toHaveLength(0)
    expect(getBrushRejections()).toEqual([at9px])

    // 同点基准径（清除覆盖）可落
    setBrushSpec(null)
    stroke('draw', 'free', [at9px])
    expect(manualGems()).toHaveLength(1)
    expect(manualGems()[0].diameterMm).toBe(2.8) // 覆盖清除后回基准物化

    detach()
  })
})

describe('erase：命中删除', () => {
  it('命中删除（1.5×半径口径）+ 原位回插 undo', () => {
    const detach = attachBrushEngine()
    stroke('erase', 'free', [{ x: 4, y: 4 }])

    expect(getGemCount()).toBe(11)
    expect(getEditDoc()!.gems.some((g) => g.id === 'g00001')).toBe(false)
    expect(getUndoDepths().undo).toBe(1)

    undo()
    expect(getGemCount()).toBe(12)
    expect(getEditDoc()!.gems[0].id).toBe('g00001') // 原索引回插

    detach()
  })

  it('一笔多删 = 单 undo 组；undo 全部原位恢复', () => {
    const detach = attachBrushEngine()
    stroke('erase', 'free', [
      { x: 4, y: 4 },
      { x: 12, y: 4 },
      { x: 20, y: 4 },
    ])
    expect(getGemCount()).toBe(9)
    expect(getUndoDepths().undo).toBe(1)

    undo()
    expect(getGemCount()).toBe(12)
    expect(getEditDoc()!.gems.slice(0, 3).map((g) => g.id)).toEqual(['g00001', 'g00002', 'g00003'])

    detach()
  })

  it('未命中不删除不产组；同笔重复扫过同一钻只删一次', () => {
    const detach = attachBrushEngine()
    stroke('erase', 'free', [{ x: 10.25, y: 10.5 }]) // 距最近钻 6.73px > 5.25 命中圈
    expect(getGemCount()).toBe(12)
    expect(getUndoDepths().undo).toBe(0)

    stroke('erase', 'free', [
      { x: 4, y: 4 },
      { x: 4.5, y: 4.5 }, // 同钻二次扫过（幽灵过滤）
    ])
    expect(getGemCount()).toBe(11)

    detach()
  })
})

describe('一笔 = 单 undo 组（笔划生命周期）', () => {
  it('多点一笔单组、两笔两组；undo 逆序整笔回退', () => {
    const detach = attachBrushEngine()
    stroke('draw', 'grid', [CLEAN_A, CLEAN_B]) // 一笔两点
    expect(getUndoDepths().undo).toBe(1)
    stroke('draw', 'grid', [{ x: 16, y: ROW2_Y }]) // 第二笔
    expect(getUndoDepths().undo).toBe(2)

    undo() // 回退第二笔整笔
    expect(manualGems().map((g) => g.x)).toEqual([CLEAN_A.x, CLEAN_B.x])
    undo() // 回退第一笔整笔
    expect(manualGems()).toHaveLength(0)
    expect(getGemCount()).toBe(12)

    detach()
  })

  it('退订（detach）后意图流不再落钻', () => {
    const detach = attachBrushEngine()
    detach()
    stroke('draw', 'grid', [CLEAN_A])
    expect(getGemCount()).toBe(12)
  })
})

describe('EditView jsdom 全链（手势层 → 意图流 → 算法）', () => {
  it('画钻工具 + 格位吸附：pointer 笔划落钻一颗（吸附格心 + manual 物化）；undo 单组', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(EditView, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[data-testid="edit-tool-draw"]')!.click()
    await tick()
    const canvas = target.querySelector<HTMLCanvasElement>('[data-testid="edit-canvas-canvas"]')!
    pointer(canvas, 'pointerdown', { x: 2, y: 14 }) // 吸附格心 (0, 13.856…)——干净落区
    pointer(canvas, 'pointerup', { x: 2, y: 14 })
    await tick()

    const added = manualGems()
    expect(added).toHaveLength(1)
    expect(added[0].x).toBe(0)
    expect(added[0].y).toBeCloseTo(ROW2_Y, 10)
    expect(getUndoDepths().undo).toBe(1)

    // 冲突落点（吸附到已占用格位邻近）闪红：吸附格心 (12, 6.928…) 距行钻 2.93px < 7.99
    pointer(canvas, 'pointerdown', { x: 10, y: 10 })
    pointer(canvas, 'pointerup', { x: 10, y: 10 })
    await tick()
    expect(manualGems()).toHaveLength(1)
    expect(getBrushRejections()).toHaveLength(1)

    unmount(app)
    target.remove()
  })
})
