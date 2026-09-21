/*
 * [2026-09-20 D-5.5 Test] 笔刷算法落地（rename-and-expert-workbench tasks 5.5）：
 * 消费意图流（emitBrushEvent 直驱 + DesignerView jsdom pointer 全链）——
 * draw 物化断言（shapeId/diameterMm/colorId 源头戳 + origin='manual' + 格位落位）、
 * 冲突拒画（pairwise 判据 + 闪红读数 + 空笔不产 undo 组）、
 * erase 命中删除（1.5×半径口径 + 原位回插）、
 * 一笔 = 单 undo 组（多点/多删合并；两笔两组）、snap grid/free 两模式、
 * 笔刷规格覆盖态（setBrushSpec——5.3 选择器写入口预埋）与基准派生、退订停摆。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import { getEditDoc, getGemCount, getUndoDepths, loadFromHandoff, resetEditForTests, undo } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  BrushSpecShapeError,
  emitBrushEvent,
  getBrushRejections,
  getBrushSpec,
  resetWorkbenchForTests,
  setBrushSpec,
  type BrushSpecState,
} from '$lib/designer/workbench.svelte'
import { attachBrushEngine, makeBrushGem, resolveBrushSpec } from '$lib/designer/brushEngine'
import type { BrushPoint } from '$lib/designer/brushGesture'
import { computeFit } from '../../components/Studio/fit'
import { makeHandoff } from '../edit/helpers'

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

/** [R3.1 显式更新] 面积落子后落钻坐标 = 引擎派生格位（offset+col×pitchPx、row×rowH——
 *  与 hexSnapPoint 同式；brushSnapPitchPx=(2.8+0.4)×2.5=7.999999999999999 有 1 ulp 尾差），
 *  逐位断言改 closeness（语义等值——格位身份不变）。 */
function expectXsCloseTo(xs: number[], expected: number[]): void {
  expect(xs).toHaveLength(expected.length)
  for (let i = 0; i < expected.length; i++) expect(xs[i]).toBeCloseTo(expected[i], 9)
}

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
    expectXsCloseTo(added.map((g) => g.x), [CLEAN_A.x, CLEAN_B.x]) // 格位落位（格心）
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

  // —— [R5-P1 统一契约] 笔刷面收窄拒绝：custom 不进笔刷规格（与 engine schema/gate 同契约）——
  it('setBrushSpec 拒绝 custom：typed throw BrushSpecShapeError + 覆盖态不被污染', () => {
    expect(() =>
      setBrushSpec({ shapeId: 'custom' as unknown as BrushSpecState['shapeId'], diameterMm: 3, colorId: 'red' }),
    ).toThrow(BrushSpecShapeError)
    expect(getBrushSpec()).toBeNull() // 拒绝写入，覆盖态保持空（回基准派生）
    // 后续合法写入不受影响
    setBrushSpec({ shapeId: 'square', diameterMm: 3.5, colorId: 'black' })
    expect(getBrushSpec()?.shapeId).toBe('square')
    setBrushSpec(null)
  })

  it('makeBrushGem 源头拒绝 custom：永不物化无 assetId 引用的 custom 手工钻', () => {
    expect(() =>
      makeBrushGem({ shapeId: 'custom' as unknown as BrushSpecState['shapeId'], diameterMm: 3, colorId: 'red' }, 'm-1', 0, 0),
    ).toThrow(BrushSpecShapeError)
    // 内置五形全放行（收窄面 = custom 排除，不误伤）
    for (const shapeId of ['round', 'square', 'drop', 'heart', 'marquise'] as const) {
      expect(makeBrushGem({ shapeId, diameterMm: 3, colorId: 'red' }, 'm-x', 0, 0).shapeId).toBe(shapeId)
    }
  })
})

describe('冲突拒画（pairwise 判据 + 闪红）', () => {
  // [R3.1 显式更新] 面积语义：圆盘覆盖的是六方格位（fixture 行 y=4 在格阵行间——(12,4)
  // 非 格位）。改用两个真实 row1 格位 (4, 6.928…)/(12, 6.928…)（距行钻 2.93px < 7.99），
  // 各自仅覆自身格位（默认盘半径 3.5 < pitch 8）→ 双格位拒画闪红。
  const ROW1_Y = 8 * Math.sqrt(3) / 2 // = 6.928…
  it('占用格位/近格位落子拒画：不落钻、闪红读数记录、空笔不产 undo 组', () => {
    const detach = attachBrushEngine()
    stroke('draw', 'grid', [
      { x: 4, y: ROW1_Y }, // row1 格位距行钻 (4,4) 2.93px < 7.99
      { x: 12, y: ROW1_Y }, // row1 格位距行钻 (12,4) 2.93px < 7.99
    ])

    expect(getGemCount()).toBe(12) // 全拒
    expect(manualGems()).toHaveLength(0)
    expect(getUndoDepths().undo).toBe(0) // 空笔组丢弃
    const rejections = getBrushRejections()
    expect(rejections).toHaveLength(2)
    expect(rejections[0].x).toBeCloseTo(4, 9)
    expect(rejections[0].y).toBeCloseTo(ROW1_Y, 9)
    expect(rejections[1].x).toBeCloseTo(12, 9)
    expect(rejections[1].y).toBeCloseTo(ROW1_Y, 9)

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

describe('erase：命中删除（[R3.1] footprint 圆盘口径——钻心入盘即删，默认直径=规格径）', () => {
  it('命中删除（盘心落钻位）+ 原位回插 undo', () => {
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
    stroke('erase', 'free', [{ x: 10.25, y: 10.5 }]) // 距最近钻 6.73px > 默认盘半径 3.5px
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
    expectXsCloseTo(manualGems().map((g) => g.x), [CLEAN_A.x, CLEAN_B.x])
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

describe('DesignerView jsdom 全链（手势层 → 意图流 → 算法）', () => {
  it('画钻工具 + 格位吸附：pointer 笔划落钻一颗（吸附格心 + manual 物化）；undo 单组', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(DesignerView, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[data-testid="designer-tool-draw"]')!.click()
    await tick()
    const canvas = target.querySelector<HTMLCanvasElement>('[data-testid="designer-canvas-canvas"]')!
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
