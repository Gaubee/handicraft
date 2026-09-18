/*
 * [2026-09-19 Test] tasks 1.4：撤销栈规格——三原子 patch 任意序列完整回退/前进、
 * stroke 合组、100 组预算裁最旧、新操作清空 redo、单 stroke >2000 钻拒绝（零部分执行）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { EditGem } from '$lib/engine'
import {
  MAX_STROKE_GEMS,
  UNDO_GROUP_BUDGET,
  applyPatch,
  beginStroke,
  canRedo,
  canUndo,
  endStroke,
  getEditDoc,
  getUndoDepths,
  hasEdits,
  loadFromHandoff,
  nextManualId,
  redo,
  resetEditForTests,
  undo,
  type EditPatch,
} from '$lib/stores/edit.svelte'
import { makeHandoff, plainGems } from './helpers'

beforeEach(() => {
  resetEditForTests()
  loadFromHandoff(makeHandoff(4))
})

/** 手工钻构造（origin='manual'、blockId=null——契约语义） */
function manualGem(x: number, y: number, colorId = 'red'): EditGem {
  return { id: nextManualId(), x, y, colorId, blockId: null, origin: 'manual', moved: false }
}

function removePatch(...ids: string[]): EditPatch {
  const items = ids
    .map((id) => {
      const index = getEditDoc()!.gems.findIndex((g) => g.id === id)
      const gem = getEditDoc()!.gems[index]
      return gem ? { gem: { ...gem }, index } : null
    })
    .filter((v): v is { gem: EditGem; index: number } => v !== null)
  return { op: 'remove', items }
}

describe('撤销栈 · 三原子任意序列完整回退/前进', () => {
  it('add → update → remove 交错序列：undo 到底=初始，redo 到底=终态', () => {
    const doc = getEditDoc()!
    const initial = plainGems(doc.gems)

    // op1：加两颗手工钻（stroke 组）
    beginStroke()
    const a = manualGem(40.5, 40.5)
    const b = manualGem(48.5, 40.5)
    expect(applyPatch({ op: 'add', gems: [a, b] }).ok).toBe(true)
    endStroke()

    // op2：改 layout 钻颜色（命令单组）
    expect(applyPatch({ op: 'update', changes: [{ id: 'g00001', before: { colorId: 'red' }, after: { colorId: 'gold' } }] }).ok).toBe(true)

    // op3：移动两颗（字段级：只动 x，y/colorId 不变）
    expect(
      applyPatch({
        op: 'update',
        changes: [
          { id: 'g00002', before: { x: 12 }, after: { x: 12.5 } },
          { id: a.id, before: { x: a.x }, after: { x: a.x + 1 } },
        ],
      }).ok,
    ).toBe(true)

    // op4：删一颗来源钻（带索引回插）
    expect(applyPatch(removePatch('g00003')).ok).toBe(true)

    const final = plainGems(getEditDoc()!.gems)
    expect(getEditDoc()!.gems).toHaveLength(5) // 4 - 1 + 2
    expect(getUndoDepths()).toEqual({ undo: 4, redo: 0 })

    // 全量回退
    expect(undo()).toBe(true)
    expect(undo()).toBe(true)
    expect(undo()).toBe(true)
    expect(undo()).toBe(true)
    expect(undo()).toBe(false)
    expect(plainGems(getEditDoc()!.gems)).toEqual(initial)
    expect(canUndo()).toBe(false)
    expect(canRedo()).toBe(true)

    // 全量前进
    while (redo()) { /* 重放全部 4 组 */ }
    expect(plainGems(getEditDoc()!.gems)).toEqual(final)
    expect(canRedo()).toBe(false)
  })

  it('update 字段级：before/after 只含变更字段，未涉及字段保持', () => {
    const g = getEditDoc()!.gems[1]
    const before = { ...g }
    applyPatch({ op: 'update', changes: [{ id: g.id, before: { colorId: g.colorId }, after: { colorId: 'black' } }] })
    const after = getEditDoc()!.gems.find((x) => x.id === g.id)!
    expect(after.colorId).toBe('black')
    expect(after.x).toBe(before.x)
    expect(after.y).toBe(before.y)
    undo()
    const restored = getEditDoc()!.gems.find((x) => x.id === g.id)!
    expect({ ...restored }).toEqual(before)
  })

  it('remove 撤销按原索引回插：数组顺序精确复原', () => {
    const initial = plainGems(getEditDoc()!.gems)
    applyPatch(removePatch('g00002', 'g00004'))
    expect(getEditDoc()!.gems.map((g) => g.id)).toEqual(['g00001', 'g00003'])
    undo()
    expect(plainGems(getEditDoc()!.gems)).toEqual(initial)
  })

  it('未载入文档时 applyPatch/undo 报错或拒绝', () => {
    resetEditForTests()
    expect(applyPatch({ op: 'update', changes: [] }).ok).toBe(false)
    expect(undo()).toBe(false)
    expect(redo()).toBe(false)
  })
})

describe('撤销栈 · stroke 合组与命令单组', () => {
  it('beginStroke/endStroke 内多个 patch 合为一个 undo 单元', () => {
    const initial = plainGems(getEditDoc()!.gems)
    beginStroke()
    applyPatch({ op: 'add', gems: [manualGem(20, 20)] })
    applyPatch({ op: 'add', gems: [manualGem(28, 20)] })
    applyPatch({
      op: 'update',
      changes: [{ id: 'g00001', before: { colorId: 'red' }, after: { colorId: 'gold' } }],
    })
    endStroke()
    expect(getUndoDepths().undo).toBe(1)
    expect(getEditDoc()!.gems).toHaveLength(6)

    undo()
    expect(plainGems(getEditDoc()!.gems)).toEqual(initial)

    redo()
    expect(getEditDoc()!.gems).toHaveLength(6)
    expect(getEditDoc()!.gems.find((g) => g.id === 'g00001')?.colorId).toBe('gold')
  })

  it('空 stroke 组丢弃（不计预算不入栈）', () => {
    beginStroke()
    endStroke()
    expect(getUndoDepths()).toEqual({ undo: 0, redo: 0 })
    expect(hasEdits()).toBe(false)
  })

  it('stroke 外 applyPatch 自动成单组（命令操作形态）', () => {
    applyPatch({ op: 'add', gems: [manualGem(30, 30)] })
    applyPatch({ op: 'add', gems: [manualGem(38, 30)] })
    expect(getUndoDepths().undo).toBe(2)
  })

  it('hasEdits：撤销栈非空即 true（「再次送精修」覆盖确认口径）', () => {
    expect(hasEdits()).toBe(false)
    applyPatch({ op: 'add', gems: [manualGem(30, 30)] })
    expect(hasEdits()).toBe(true)
    undo()
    expect(hasEdits()).toBe(false)
  })
})

describe('撤销栈 · 预算与 redo 语义', () => {
  it(`100 组预算：超限裁最旧（前 ${UNDO_GROUP_BUDGET} 条历史不可回退）`, () => {
    const gemId = 'g00001'
    for (let i = 1; i <= UNDO_GROUP_BUDGET + 5; i++) {
      const cur = getEditDoc()!.gems.find((g) => g.id === gemId)!.x
      applyPatch({ op: 'update', changes: [{ id: gemId, before: { x: cur }, after: { x: i } }] })
    }
    expect(getUndoDepths().undo).toBe(UNDO_GROUP_BUDGET)

    while (undo()) { /* 裁到底 */ }
    expect(canUndo()).toBe(false)
    // 最旧 5 组被裁：x 只能回到第 5 次操作后的值
    expect(getEditDoc()!.gems.find((g) => g.id === gemId)!.x).toBe(5)

    while (redo()) { /* 重放可重放部分 */ }
    expect(getEditDoc()!.gems.find((g) => g.id === gemId)!.x).toBe(UNDO_GROUP_BUDGET + 5)
    expect(getUndoDepths().redo).toBe(0)
  })

  it('新操作清空 redo（含 stroke 内首 patch 即刻失效）', () => {
    applyPatch({ op: 'add', gems: [manualGem(30, 30)] })
    undo()
    expect(canRedo()).toBe(true)

    applyPatch({ op: 'add', gems: [manualGem(31, 31)] })
    expect(canRedo()).toBe(false)
    expect(redo()).toBe(false)

    // stroke 版：begin 后首个 patch 即清 redo
    applyPatch({ op: 'add', gems: [manualGem(32, 32)] })
    undo()
    expect(canRedo()).toBe(true)
    beginStroke()
    applyPatch({ op: 'add', gems: [manualGem(33, 33)] })
    expect(canRedo()).toBe(false)
    endStroke()
  })
})

describe('撤销栈 · 巨型 patch 拒绝（>2000 钻，零部分执行）', () => {
  it(`单 add patch ${MAX_STROKE_GEMS + 1} 钻：拒绝且文档不变`, () => {
    const before = plainGems(getEditDoc()!.gems)
    const huge = Array.from({ length: MAX_STROKE_GEMS + 1 }, (_, i) => ({
      ...manualGem(100 + (i % 90) * 8, 100 + Math.floor(i / 90) * 8),
    }))
    const result = applyPatch({ op: 'add', gems: huge })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('2000')
    expect(plainGems(getEditDoc()!.gems)).toEqual(before)
    expect(getUndoDepths().undo).toBe(0)
  })

  it('stroke 累计超限：第二批整批拒绝（已落地的第一批保持，可整体撤销）', () => {
    const initial = plainGems(getEditDoc()!.gems)
    beginStroke()
    const first = applyPatch({
      op: 'add',
      gems: Array.from({ length: 1500 }, (_, i) => manualGem(100 + (i % 90) * 8, 100 + Math.floor(i / 90) * 8)),
    })
    expect(first.ok).toBe(true)
    const beforeSecond = plainGems(getEditDoc()!.gems)

    const second = applyPatch({
      op: 'add',
      gems: Array.from({ length: 600 }, (_, i) => manualGem(200 + (i % 90) * 8, 200 + Math.floor(i / 90) * 8)),
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toContain('2000')
    expect(plainGems(getEditDoc()!.gems)).toEqual(beforeSecond) // 无部分执行
    endStroke()

    undo() // 一个组整体回退
    expect(plainGems(getEditDoc()!.gems)).toEqual(initial)
  })

  it(`恰好 ${MAX_STROKE_GEMS} 钻放行（边界含）`, () => {
    const r = applyPatch({
      op: 'add',
      gems: Array.from({ length: MAX_STROKE_GEMS }, (_, i) => manualGem(100 + (i % 90) * 8, 100 + Math.floor(i / 90) * 8)),
    })
    expect(r.ok).toBe(true)
    expect(getEditDoc()!.gems).toHaveLength(4 + MAX_STROKE_GEMS)
  })

  it('remove/update 不占新增预算（只限 add）', () => {
    beginStroke()
    expect(applyPatch(removePatch('g00001')).ok).toBe(true)
    expect(applyPatch({ op: 'update', changes: [{ id: 'g00002', before: { x: 12 }, after: { x: 13 } }] }).ok).toBe(true)
    endStroke()
    expect(getUndoDepths().undo).toBe(1)
  })
})
