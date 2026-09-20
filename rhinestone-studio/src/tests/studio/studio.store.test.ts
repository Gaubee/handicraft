/*
[2026-09-18 Test] tasks 4.x 状态语义：块选择/启用、DensitySpec Record 合并（缺省块 1.0）、
类型与颜色覆写、SS/gap → grid 重建、密度单调估算。管线级断言见 pipeline.test.ts。
*/

import { beforeEach, describe, expect, it } from 'vitest'
import { SS_TABLE } from '$lib/engine'
import {
  getActiveResult,
  getActualBlockCount,
  getBlockDensity,
  getBlockEstimate,
  getBlocks,
  getDensitySpec,
  getEffectiveBlocks,
  getGlobalDensity,
  getGrid,
  getPalette,
  getSegK,
  getSegSeed,
  getSelectedBlockId,
  getTypeOverride,
  isEnabled,
  loadFromEngineImage,
  resetBlockDensity,
  resetStudioForTests,
  selectBlock,
  setBlockColor,
  setBlockDensity,
  setBlockType,
  setEnabled,
  setGapMm,
  setGlobalDensity,
  setSegK,
  setSegSeed,
  setSs,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'

beforeEach(() => {
  resetStudioForTests()
})

describe('studio store · 载入与分块参数', () => {
  it('载入合成数字油画后防抖完成分块（≥3 块）', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png', 'handoff')
    await waitForStudioIdle()
    expect(getBlocks().length).toBeGreaterThanOrEqual(3)
  })

  it('k 与 seed 可调并夹紧到合法域', () => {
    setSegK(3)
    expect(getSegK()).toBe(6)
    setSegK(99)
    expect(getSegK()).toBe(10)
    setSegSeed(-5)
    expect(getSegSeed()).toBe(0)
  })
})

describe('studio store · 块选择与启用', () => {
  it('selectBlock/setEnabled 语义', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()
    const first = getBlocks()[0]

    selectBlock(first.id)
    expect(getSelectedBlockId()).toBe(first.id)
    selectBlock(null)
    expect(getSelectedBlockId()).toBeNull()

    expect(isEnabled(first.id)).toBe(true)
    setEnabled(first.id, false)
    expect(isEnabled(first.id)).toBe(false)
    expect(getEffectiveBlocks().some((b) => b.id === first.id)).toBe(false)
    setEnabled(first.id, true)
    expect(isEnabled(first.id)).toBe(true)
  })

  it('禁用块在重算后不产生任何钻位', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()
    const victim = getBlocks()[0]
    setEnabled(victim.id, false)
    await waitForStudioIdle()
    const gems = getActiveResult()?.gems ?? []
    expect(gems.length).toBeGreaterThan(0)
    expect(gems.every((g) => g.blockId !== victim.id)).toBe(true)
  })
})

describe('studio store · DensitySpec Record 合并语义', () => {
  it('无覆写 + 全局 1 → 空 Record（缺省块引擎侧默认 1.0）', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()
    expect(getGlobalDensity()).toBe(1)
    expect(getDensitySpec()).toEqual({})
  })

  it('全局密度写入全部块；块覆写优先；显式 1 省略键但保持覆写', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()
    const [a, b] = getBlocks()

    setGlobalDensity(0.5)
    const spec = getDensitySpec()
    expect(spec[a.id]).toBe(0.5)
    expect(spec[b.id]).toBe(0.5)
    expect(getBlockDensity(a.id)).toBe(0.5)

    setBlockDensity(a.id, 0.8)
    expect(getDensitySpec()[a.id]).toBe(0.8)
    expect(getDensitySpec()[b.id]).toBe(0.5)
    expect(getBlockDensity(a.id)).toBe(0.8)

    // 显式 1.0：Record 省略键（引擎缺省块 1.0），但该块不再跟随全局
    setBlockDensity(a.id, 1)
    expect(getDensitySpec()[a.id]).toBeUndefined()
    expect(getBlockDensity(a.id)).toBe(1)

    // 清除覆写 → 重新跟随全局
    resetBlockDensity(a.id)
    expect(getBlockDensity(a.id)).toBe(0.5)

    setGlobalDensity(1)
    expect(getDensitySpec()).toEqual({})
  })

  it('块钻数估算随密度单调不减', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()
    const block = getBlocks()[0]
    const at1 = getBlockEstimate(block)
    setBlockDensity(block.id, 0.5)
    const at05 = getBlockEstimate(block)
    setBlockDensity(block.id, 0.25)
    const at025 = getBlockEstimate(block)
    expect(at05).toBeLessThanOrEqual(at1)
    expect(at025).toBeLessThanOrEqual(at05)
  })
})

describe('studio store · 类型与颜色覆写', () => {
  it('类型覆写改写 effectiveBlocks.suggested，清除后还原', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()
    const target = getBlocks().find((b) => b.suggested === 'fill')
    expect(target).toBeDefined()
    if (!target) return

    setBlockType(target.id, 'linear')
    expect(getTypeOverride(target.id)).toBe('linear')
    const patched = getEffectiveBlocks().find((b) => b.id === target.id)
    expect(patched?.suggested).toBe('linear')

    setBlockType(target.id, null)
    const restored = getEffectiveBlocks().find((b) => b.id === target.id)
    expect(restored?.suggested).toBe(target.suggested)
    expect(getTypeOverride(target.id)).toBeUndefined()
  })

  it('颜色覆写同步改写既有结果的 colorId（免重排）', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()
    const victim = getBlocks()[0]
    const paletteId = getPalette()[0].id
    const before = getActiveResult()?.gems.filter((g) => g.blockId === victim.id) ?? []
    expect(before.length).toBeGreaterThan(0)

    setBlockColor(victim.id, paletteId)
    const after = getActiveResult()?.gems.filter((g) => g.blockId === victim.id) ?? []
    expect(after.every((g) => g.colorId === paletteId)).toBe(true)

    setBlockColor(victim.id, null)
    const cleared = getActiveResult()?.gems.filter((g) => g.blockId === victim.id) ?? []
    expect(cleared.every((g) => g.colorId !== paletteId)).toBe(true)
  })
})

describe('studio store · SS 与 gap → grid 重建', () => {
  it('切换 SS 改 ss 与 pitchMm；gap 在 [0.4,0.8] 内连续可调', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture.png')
    await waitForStudioIdle()

    setSs('SS16')
    const g16 = getGrid()
    expect('ss' in g16).toBe(false) // 1.4 过渡键删除；SS 档语义经 pitch 断言
    expect(g16.pitchMm).toBeCloseTo(SS_TABLE.SS16 + 0.4, 10)
    expect(g16.pixelsPerMm).toBe(2.5)
    expect(g16.rowAngleDeg).toBe(0)

    setGapMm(0.8)
    expect(getGrid().pitchMm).toBeCloseTo(SS_TABLE.SS16 + 0.8, 10)

    setGapMm(2) // 夹紧到上限
    expect(getGrid().pitchMm).toBeCloseTo(SS_TABLE.SS16 + 0.8, 10)

    setSs('SS6')
    // SS6 档语义经 pitch 断言（ss 过渡键 1.4 删除）
    expect(getGrid().pitchMm).toBeCloseTo(SS_TABLE.SS6 + 0.8, 10)
  })
})

describe('studio store · [improve 4.2] 密度 0 = 无钻合法状态（排除口径同禁用块）', () => {
  it('块密度 0：DensitySpec 无键（engine 值域 (0,1] 不触破）+ effectiveBlocks 排除 + 预估/实排 0 钻', async () => {
    loadFromEngineImage(fixtureShapes(), 'fixture-zero.png')
    await waitForStudioIdle()
    const a = getBlocks()[0]!
    setBlockDensity(a.id, 0)
    expect(getBlockDensity(a.id)).toBe(0) // clamp 下界 0（滑杆可拉到 0%）
    expect(getDensitySpec()[a.id]).toBeUndefined() // 0 键不入场
    expect(getEffectiveBlocks().some((b) => b.id === a.id)).toBe(false) // 排除（同禁用口径）
    expect(getBlockEstimate(a)).toBe(0) // 预估 0 钻
    await waitForStudioIdle()
    expect(getActualBlockCount(a.id)).toBe(0) // 实排 0 钻
  })
})
