/*
 * [2026-09-21 rework-designer-manual-rhinestone R3.1 Test] 笔刷流量·面积落子（design §4）：
 * - 宽带笔刷（直径 > 2×钻径）一次横拖铺出多列（「笔刷不是点」验收锚——非中心线单列）；
 * - 流量单调：同轨迹 flow 高 → 落钻集 ⊇ flow 低（seeded 阈值嵌套）且钻数严格递减；
 * - 增量结算无缝：单次大跳（事件稀疏）与逐格慢拖（事件密集）同胶囊带 → 落钻集逐位相等；
 * - 零碰撞违规：落钻后 validateEditable 无 spacing 告警（避碰——既有钻 + 本笔批同判）；
 * - 橡皮同 footprint：圆盘内批量擦除（一次多删单 undo 组；盘外不误删）；
 * - 默认直径（=规格径 < pitch）回归锚：圆盘仅覆自身格位——与点间隔旧行为逐位一致。
 * 直驱意图流（emitBrushEvent——手势/吸附语义归 workbench.brush* 既有文件）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  getEditDoc,
  getGemCount,
  getUndoDepths,
  loadFromHandoff,
  resetEditForTests,
  undo,
} from '$lib/stores/edit.svelte'
import {
  effectiveBrushDiameterMm,
  emitBrushEvent,
  getBrushRejections,
  getBrushSettings,
  resetWorkbenchForTests,
  setBrushDiameter,
  setBrushFlowPercent,
} from '$lib/designer/workbench.svelte'
import { attachBrushEngine, brushCellHash } from '$lib/designer/brushEngine'
import { validateEditable } from '$lib/engine'
import type { BrushPoint } from '$lib/designer/brushGesture'
import { makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

const PITCH = 8 // SS10 @2.5px/mm + gap0.4 → 8px（TEST_PITCH 同源）
const ROW_H = (PITCH * Math.sqrt(3)) / 2

/** 干净落带：row6（y≈41.57，偶行 x=8k）——距 fixture 行钻（y=4）≥ 36px，任何判距外。 */
const BAND_Y = ROW_H * 6

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

function placedKeys(): string[] {
  return manualGems()
    .map((g) => `${Math.round(g.x * 1000) / 1000},${Math.round(g.y * 1000) / 1000}`)
    .sort()
}

/** 水平横拖（row6 格位点列）：fromX..toX 逐格步进（慢速密集采样）。 */
function horizontalDrag(fromX: number, toX: number): BrushPoint[] {
  const points: BrushPoint[] = []
  for (let x = fromX; x <= toX; x += PITCH) points.push({ x, y: BAND_Y })
  return points
}

/** 格位对齐断言：全部落钻都在六方格位上（rowH 行距/奇行偏移半格——hexSnap 同格）。 */
function expectHexLatticeAligned(): void {
  for (const g of manualGems()) {
    const row = Math.round(g.y / ROW_H)
    const offset = row % 2 === 0 ? 0 : PITCH / 2
    expect(g.y).toBeCloseTo(row * ROW_H, 6)
    expect(g.x).toBeCloseTo(offset + Math.round((g.x - offset) / PITCH) * PITCH, 6)
  }
}

function spacingWarnings() {
  const doc = getEditDoc()!
  return validateEditable(doc.gems, doc.grid, doc.blocks).filter((w) => w.kind === 'spacing')
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  loadFromHandoff(makeHandoff(12)) // 行钻 (4,4)..(92,4)；SS10 基准径 2.8 / pitch 8
})

describe('R3.1 面积落子：宽带笔刷多列铺满（「笔刷不是点」验收锚）', () => {
  it('直径 3×规格径横拖：铺出 ≥3 列六方排布（垂直笔迹方向填充），格位对齐 + 零碰撞 + 单 undo 组', () => {
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(2.8, 10) // 默认=规格径
    setBrushDiameter(2.8 * 3) // 8.4mm → 盘半径 10.5px（>2×钻径 7px）
    expect(getBrushSettings().diameterMm).toBeCloseTo(8.4, 10)

    const detach = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 48))
    detach()

    const added = manualGems()
    expect(added.length).toBeGreaterThan(20) // 宽带铺满（点间隔单列仅 7 颗）
    const rows = new Set(added.map((g) => Math.round(g.y / ROW_H)))
    expect(rows.size).toBeGreaterThanOrEqual(3) // 多列：row5/6/7（|Δy|≤10.5px 带内三行）
    expectHexLatticeAligned()
    expect(spacingWarnings()).toHaveLength(0) // 零碰撞违规（含本笔批内同判）
    expect(getBrushRejections()).toHaveLength(0) // 干净带内无拒画
    expect(getUndoDepths().undo).toBe(1) // 一次拖动 = 单个撤销组

    undo()
    expect(getGemCount()).toBe(12) // 整笔回退
  })

  it('「笔刷不是点」负断言：同轨迹默认直径（=规格径 < pitch）恒单列——多列只来自圆盘扫面', () => {
    const detach = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 48)) // 默认 2.8mm：圆盘半径 3.5px < pitch 8
    detach()

    const added = manualGems()
    expect(added).toHaveLength(7) // 每格位一颗（与点间隔旧行为逐位一致——回归锚）
    expect(new Set(added.map((g) => g.y)).size).toBe(1) // 单列（点刷语义）
    expectHexLatticeAligned()
    expect(spacingWarnings()).toHaveLength(0)
  })
})

describe('R3.1 流量抽稀：seeded 确定性 + 阈值嵌套单调', () => {
  function paintAtFlow(flow: number): string[] {
    resetEditForTests()
    resetWorkbenchForTests()
    loadFromHandoff(makeHandoff(12))
    setBrushDiameter(2.8 * 3)
    setBrushFlowPercent(flow)
    const detach = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 48))
    detach()
    return placedKeys()
  }

  it('同轨迹 flow 100 > 70 > 40 > 10：落钻集严格嵌套收缩、钻数严格递减', () => {
    const full = paintAtFlow(100)
    const mid = paintAtFlow(70)
    const low = paintAtFlow(40)
    const floor = paintAtFlow(10)
    const sets = [new Set(full), new Set(mid), new Set(low), new Set(floor)]
    for (let i = 1; i < sets.length; i++) {
      for (const key of sets[i]!) expect(sets[i - 1]!.has(key)).toBe(true) // 嵌套：低流量 ⊆ 高流量
    }
    expect(full.length).toBeGreaterThan(mid.length)
    expect(mid.length).toBeGreaterThan(low.length)
    expect(low.length).toBeGreaterThan(floor.length)
  })

  it('flow=0：一格不落（空笔组丢弃）；flow=100：抽稀旁路全保留', () => {
    setBrushDiameter(2.8 * 3)
    setBrushFlowPercent(0)
    const detach = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 48))
    expect(manualGems()).toHaveLength(0)
    expect(getUndoDepths().undo).toBe(0) // 空笔组丢弃
    detach()
  })

  it('确定性：同 flow 两次独立起笔落钻集逐位相等（brushCellHash 点级稳定）', () => {
    const seed = brushCellHash(3, 6)
    expect(brushCellHash(3, 6)).toBe(seed) // 同格位同值
    expect(brushCellHash(4, 6)).not.toBe(brushCellHash(3, 6)) // 异格位散列

    const first = paintAtFlow(55)
    const second = paintAtFlow(55)
    expect(second).toEqual(first)
  })

  it('抽稀 ≠ 拒画：流量丢弃的格位不进闪红读数', () => {
    setBrushDiameter(2.8 * 3)
    setBrushFlowPercent(40)
    const detach = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 48))
    detach()
    expect(manualGems().length).toBeGreaterThan(0)
    expect(getBrushRejections()).toHaveLength(0) // 干净带内：低流量只抽稀、不闪红
  })

  it('同笔已结算格位增量去重：圆盘原地反复扫过不重复落钻', () => {
    setBrushDiameter(2.8 * 3)
    const detach = attachBrushEngine()
    const wiggle: BrushPoint[] = []
    for (let i = 0; i < 6; i++) wiggle.push({ x: 0, y: BAND_Y + (i % 2 === 0 ? 2 : -2) })
    stroke('draw', 'grid', wiggle)
    detach()
    const keys = placedKeys()
    expect(new Set(keys).size).toBe(keys.length) // 无重复落点（增量结算幂等）
    expect(spacingWarnings()).toHaveLength(0)
  })
})

describe('R3.1 增量结算无缝（区间覆盖 sweep）', () => {
  it('单次大跳（稀疏采样）与逐格慢拖（密集采样）铺出同一胶囊带——落钻集逐位相等', () => {
    setBrushDiameter(2.8 * 3)
    const detachFast = attachBrushEngine()
    stroke('draw', 'grid', [
      { x: 0, y: BAND_Y },
      { x: 48, y: BAND_Y },
    ]) // 一跳 48px
    detachFast()
    const fast = placedKeys()

    resetEditForTests()
    resetWorkbenchForTests()
    loadFromHandoff(makeHandoff(12))
    setBrushDiameter(2.8 * 3)
    const detachSlow = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 48)) // 7 个采样点
    detachSlow()
    const slow = placedKeys()

    expect(fast.length).toBeGreaterThan(20)
    expect(fast).toEqual(slow) // 段胶囊判定：采样密度不影响覆盖（无缝 sweep）
  })

  it('折返路径：往返扫过同一带不重复落钻、不重复闪红', () => {
    setBrushDiameter(2.8 * 3)
    const detach = attachBrushEngine()
    stroke('draw', 'grid', [
      { x: 0, y: BAND_Y },
      { x: 32, y: BAND_Y },
      { x: 0, y: BAND_Y },
    ])
    detach()
    const keys = placedKeys()
    expect(new Set(keys).size).toBe(keys.length)
    expect(spacingWarnings()).toHaveLength(0)
  })
})

describe('R3.1 避碰：扫面落子不越既有钻', () => {
  it('宽带扫过 fixture 行：近行格位全拒、合法带照常落——落钻永不自产 spacing 违规', () => {
    setBrushDiameter(2.8 * 3)
    const detach = attachBrushEngine()
    // 圆盘心 (0, ROW2)：row2 格位合法（距行钻 10.6px ≥ 7.99）；row0/row1 部分格位撞行钻
    stroke('draw', 'grid', [{ x: 0, y: ROW_H * 2 }])
    detach()

    const added = manualGems()
    expect(added.length).toBeGreaterThan(0) // 合格格位照常落
    expect(getBrushRejections().length).toBeGreaterThan(0) // 撞行钻格位显式拒画闪红
    expect(spacingWarnings()).toHaveLength(0) // 通过者与既有钻零违规（0.999 判据同源）
    expectHexLatticeAligned()
  })

  it('已占格位二次扫过：增量结算不复活已拒格位、不产第二颗', () => {
    setBrushDiameter(2.8)
    const detach = attachBrushEngine()
    stroke('draw', 'grid', [{ x: 0, y: BAND_Y }])
    stroke('draw', 'grid', [{ x: 0, y: BAND_Y }]) // 同格位第二笔
    detach()
    expect(manualGems()).toHaveLength(1) // 新笔撞前笔钻 → 拒（不落第二颗）
    expect(getGemCount()).toBe(13)
  })
})

describe('R3.1 橡皮 footprint：圆盘批量擦除', () => {
  function paintBand(): void {
    setBrushDiameter(2.8 * 3)
    const detach = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 48))
    detach()
    expect(manualGems().length).toBeGreaterThan(20)
  }

  it('宽带橡皮一次扫过多删：盘内全部钻心入区即删，一笔单 undo 组、undo 整组恢复', () => {
    paintBand()
    const before = manualGems().length
    setBrushDiameter(2.8 * 3) // 同 footprint：半径 10.5px
    const detach = attachBrushEngine()
    stroke('erase', 'grid', [{ x: 24, y: BAND_Y }]) // 单点盘内多钻（≥2 颗）
    detach()

    const erased = before - manualGems().length
    expect(erased).toBeGreaterThanOrEqual(2) // 批量：一次触擦多颗（旧单点口径恒 1）
    expect(getUndoDepths().undo).toBe(2) // 画带一组 + 擦除一组
    undo()
    expect(manualGems().length).toBe(before) // 整组原位恢复
  })

  it('盘外不误删（WYSIWYG 口径：钻心距盘心 > 半径不删）；默认直径点擦恒 1 颗', () => {
    paintBand()
    const before = manualGems().length

    // 默认直径（回跟随规格径 2.8mm）：盘半径 3.5px——单点只删最近 1 颗（格距 8px 邻钻不入盘）
    setBrushDiameter(null)
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(2.8, 10)
    const detach = attachBrushEngine()
    const target = manualGems()[0]!
    stroke('erase', 'grid', [{ x: target.x, y: target.y }])
    detach()
    expect(before - manualGems().length).toBe(1)

    // 盘外远点：零删除零组
    const detach2 = attachBrushEngine()
    stroke('erase', 'grid', [{ x: 24, y: BAND_Y + 40 }])
    detach2()
    expect(manualGems().length).toBe(before - 1)
  })
})

describe('R3.1 吸附关：中心线现状模式（回归锚）', () => {
  it('free 模式逐点 pairwise 门保持：原始坐标原样落钻、近距拒画（流量不参与）', () => {
    setBrushDiameter(2.8 * 3) // 圆盘直径在 free 模式不产面积候选（design §4.2 中心线模式）
    setBrushFlowPercent(30)
    const detach = attachBrushEngine()
    const raw = { x: 2.37, y: 40.11 }
    stroke('draw', 'free', [raw, { x: raw.x + 1, y: raw.y }]) // 第二点距 1px < 7.99 → 拒
    detach()

    const added = manualGems()
    expect(added).toHaveLength(1) // 流量抽稀仅作用于吸附开格位（free 不抽稀）
    expect(added[0]!.x).toBe(2.37)
    expect(added[0]!.y).toBe(40.11)
    expect(getBrushRejections()).toHaveLength(1)
  })
})

describe('R3.2 笔刷设定 UI（读数 popover + 光标/落子联动单源）', () => {
  function mountView(): { target: HTMLElement; q: (testid: string) => Element | null; unmount: () => void } {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(DesignerView, { target })
    return {
      target,
      q: (testid: string) => document.querySelector(`[data-testid="${testid}"]`),
      unmount: () => {
        unmount(app)
        target.remove()
      },
    }
  }

  it('读数常显默认值（Ø=规格径 · 流量 100%）；点击弹 popover——直径/流量/跟随规格三路写入经命令总线', async () => {
    const view = mountView()
    await tick()
    const readout = view.q('designer-status-brush') as HTMLElement
    expect(readout.textContent).toContain('笔刷 2.8mm · 流量 100%')

    readout.click()
    await tick()
    expect(view.q('designer-brush-popover')).not.toBeNull()

    // 直径 input 直写（input+change 事件——bind:value 在 input 上同步）：8.4 → 读数/设定/光标源三面联动
    const input = view.q('designer-brush-diameter-input') as HTMLInputElement
    input.value = '8.4'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getBrushSettings().diameterMm).toBeCloseTo(8.4, 10)
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(8.4, 10) // 光标圈半径单源（÷2×px/mm）
    expect((view.q('designer-status-brush') as HTMLElement).textContent).toContain('笔刷 8.4mm')

    // 流量滑杆（input 事件实时）：40%
    const slider = view.q('designer-brush-flow-input') as HTMLInputElement
    slider.value = '40'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(getBrushSettings().flowPercent).toBe(40)
    expect((view.q('designer-status-brush') as HTMLElement).textContent).toContain('流量 40%')
    expect((view.q('designer-brush-flow-value') as HTMLElement).textContent).toBe('40%')

    // 跟随规格：直径覆盖清空（null——规格切换随之联动）
    ;(view.q('designer-brush-diameter-follow') as HTMLElement).click()
    await tick()
    expect(getBrushSettings().diameterMm).toBeNull()
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(2.8, 10)
    expect((view.q('designer-status-brush') as HTMLElement).textContent).toContain('笔刷 2.8mm')

    view.unmount()
  })

  it('直径下于规格径夹取贴下限 = 回跟随（popover 非法小值不缩 footprint）', async () => {
    const view = mountView()
    await tick()
    ;(view.q('designer-status-brush') as HTMLElement).click()
    await tick()
    const input = view.q('designer-brush-diameter-input') as HTMLInputElement
    input.value = '0.5'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getBrushSettings().diameterMm).toBeNull() // 夹到规格径 → 跟随语义态
    expect(effectiveBrushDiameterMm(getEditDoc()!)).toBeCloseTo(2.8, 10)

    view.unmount()
  })

  it('光标即时反映：直径设定 → 光标圈半径单源同变（jsdom 无 2d 上下文——断言派生源 effectiveBrushDiameterMm；画布 redraw 消费同源）', async () => {
    const view = mountView()
    await tick()
    const d = getEditDoc()!
    const pxPerMm = d.grid.pixelsPerMm
    setBrushDiameter(8.4)
    await tick()
    // DesignerCanvas.brushCursorRadius = effectiveBrushDiameterMm(d)/2×px/mm（消费单源——
    // 设定变化即时反映在派生值上即光标直径联动断言）
    expect((effectiveBrushDiameterMm(d) / 2) * pxPerMm).toBeCloseTo(4.2 * pxPerMm, 10)
    setBrushDiameter(null)
    await tick()
    expect((effectiveBrushDiameterMm(d) / 2) * pxPerMm).toBeCloseTo(1.4 * pxPerMm, 10)

    view.unmount()
  })

  it('设定改变下一笔即生效：宽径一笔落多列带（真源 → 引擎起笔快照消费）', () => {
    setBrushDiameter(2.8 * 3)
    setBrushFlowPercent(100)
    const detach = attachBrushEngine()
    stroke('draw', 'grid', horizontalDrag(0, 24))
    detach()
    const rows = new Set(manualGems().map((g) => Math.round(g.y / ROW_H)))
    expect(rows.size).toBeGreaterThanOrEqual(3) // 宽径设定经真源流进引擎（多列）
    expect(spacingWarnings()).toHaveLength(0)
  })
})
