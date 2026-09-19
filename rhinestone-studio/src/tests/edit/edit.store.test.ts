/*
 * [2026-09-19 Test] tasks 1.1：EditDocument 快照载入（toEditGem 转换/深拷贝隔离/m- id 策略/
 * 图层与选择默认）+ tasks 3.2 烘焙隔离（工作台参数变更不回流）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  MANUAL_ID_PREFIX,
  clearSelection,
  getEditDoc,
  getGemCount,
  getSourceSummary,
  loadFromHandoff,
  nextManualId,
  resetEditForTests,
  setLayerOpacity,
  setLayerVisible,
  setSelection,
  toggleSelection,
  type ManualEditHandoff,
} from '$lib/stores/edit.svelte'
import { STARTER_PALETTE } from '$lib/engine'
import { makeHandoff, plainGems, testGrid } from './helpers'
import {
  buildManualEditHandoff,
  getActiveResult,
  getGlobalDensity,
  loadFromEngineImage,
  resetStudioForTests,
  recompute,
  setGlobalDensity,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'

beforeEach(() => {
  resetEditForTests()
  resetStudioForTests()
})

describe('edit store · loadFromHandoff 快照载入（tasks 1.1）', () => {
  it('gems 经 toEditGem 转换：origin=layout、moved=false、blockId 直传', () => {
    loadFromHandoff(makeHandoff(6))
    const doc = getEditDoc()
    expect(doc).not.toBeNull()
    expect(doc!.gems).toHaveLength(6)
    for (const g of doc!.gems) {
      expect(g.origin).toBe('layout')
      expect(g.moved).toBe(false)
      expect(g.blockId).toBe('blk-1')
      expect(g.id).toMatch(/^g\d{5}$/)
    }
    expect(getGemCount()).toBe(6)
  })

  it('只读元数据落位：blocks/palette/grid/width/height/sourceSummary/referenceAssetId', () => {
    loadFromHandoff(
      makeHandoff(3, { sourceSummary: '泊松盘 · 密度 80% · SS16', referenceAssetId: 'ast-ref-test' }),
    )
    const doc = getEditDoc()!
    expect(doc.blocks).toHaveLength(1)
    expect(doc.palette.map((c) => c.id)).toEqual(STARTER_PALETTE.map((c) => c.id))
    expect(doc.grid).toEqual(testGrid())
    expect(doc.width).toBe(64)
    expect(doc.height).toBe(64)
    expect(getSourceSummary()).toBe('泊松盘 · 密度 80% · SS16')
    expect(doc.referenceAssetId).toBe('ast-ref-test')
  })

  it('固定四层默认全可见（透明度 clamp 后可调），selection 初始为空', () => {
    loadFromHandoff(makeHandoff())
    const doc = getEditDoc()!
    for (const key of ['painting', 'reference', 'blocks', 'gems'] as const) {
      expect(doc.layers[key].visible).toBe(true)
      expect(doc.layers[key].opacity).toBeGreaterThan(0)
    }
    expect(doc.selection.size).toBe(0)
  })

  it('深拷贝隔离（payload 级）：交接后改 payload 任何字段不渗入文档', () => {
    const payload: ManualEditHandoff = makeHandoff(4)
    loadFromHandoff(payload)
    const doc = getEditDoc()!
    const gemsSnap = plainGems(doc.gems)
    const maskSnap = new Uint8Array(doc.blocks[0].mask.bits)
    const pixelSnap = new Uint8ClampedArray(doc.paintingSnapshot.data)

    payload.gems[0].x = 9999
    payload.gems[0].colorId = 'hacked'
    payload.blocks[0].mask.bits[0] = 0
    payload.blocks[0].label = 'hacked'
    payload.palette.pop()
    payload.grid.pitchMm = 0.001
    payload.paintingSnapshot.data[0] = 255
    payload.sourceSummary = 'hacked'

    expect(plainGems(doc.gems)).toEqual(gemsSnap)
    expect(doc.blocks[0].label).toBe('测试块 blk-1')
    expect(new Uint8Array(doc.blocks[0].mask.bits)).toEqual(maskSnap)
    expect(new Uint8ClampedArray(doc.paintingSnapshot.data)).toEqual(pixelSnap)
    expect(doc.grid.pitchMm).toBeCloseTo(testGrid().pitchMm, 10)
    expect(doc.sourceSummary).not.toBe('hacked')
    expect(doc.palette).toHaveLength(5)
  })

  it('重载 handoff = 全新文档：历史/选择/摘要一并重置', () => {
    loadFromHandoff(makeHandoff(4))
    setSelection(['g00001'])
    loadFromHandoff(makeHandoff(9, { sourceSummary: '第二次' }))
    const doc = getEditDoc()!
    expect(doc.gems).toHaveLength(9)
    expect(doc.selection.size).toBe(0)
    expect(doc.sourceSummary).toBe('第二次')
    expect(nextManualId()).toBe(`${MANUAL_ID_PREFIX}1`) // 手工钻计数器随载入重置
  })
})

describe('edit store · 手工钻 m- id 策略（tasks 1.1）', () => {
  it('自增分配且不回收：撤销/重载语义靠计数器单调', () => {
    loadFromHandoff(makeHandoff())
    expect(nextManualId()).toBe('m-1')
    expect(nextManualId()).toBe('m-2')
    expect(nextManualId()).toBe('m-3')
  })

  it('防御性跳撞：来源 id 恰占 m-N 时自动让位（契约上命名空间不重叠，兜底）', () => {
    // 构造 id 与 m- 前缀冲突的来源钻（异常输入，验证防御路径）
    const payload = makeHandoff(3)
    payload.gems = payload.gems.map((g, i) => ({ ...g, id: `m-${i + 1}` }))
    loadFromHandoff(payload)
    const id = nextManualId()
    expect(id.startsWith('m-')).toBe(true)
    expect(getEditDoc()!.gems.some((g) => g.id === id)).toBe(false)
  })
})

describe('edit store · 图层与选择 setter', () => {
  it('setLayerVisible/setLayerOpacity（透明度 clamp 0.01..1——gemdoc 格式值域 (0,1] 同口径）', () => {
    loadFromHandoff(makeHandoff())
    setLayerVisible('painting', false)
    setLayerOpacity('gems', 1.7)
    setLayerOpacity('blocks', -0.2)
    const layers = getEditDoc()!.layers
    expect(layers.painting.visible).toBe(false)
    expect(layers.gems.opacity).toBe(1)
    expect(layers.blocks.opacity).toBeCloseTo(0.01, 10)
  })

  it('setSelection/toggleSelection/clearSelection', () => {
    loadFromHandoff(makeHandoff(4))
    const doc = getEditDoc()!
    setSelection(['g00001', 'g00002'])
    expect([...doc.selection].sort()).toEqual(['g00001', 'g00002'])
    setSelection(['g00003']) // 覆盖语义
    expect([...doc.selection]).toEqual(['g00003'])
    toggleSelection('g00003')
    expect(doc.selection.size).toBe(0)
    toggleSelection('g00004')
    expect([...doc.selection]).toEqual(['g00004'])
    clearSelection()
    expect(doc.selection.size).toBe(0)
  })
})

describe('烘焙隔离（tasks 3.2）：送精修后工作台参数变更不回流', () => {
  it('送精修 → 改全局密度并重算 → EditDocument 逐字段不变', async () => {
    loadFromEngineImage(fixtureShapes(), 'isolation.png', 'handoff')
    await waitForStudioIdle()
    expect(getActiveResult()?.gems.length ?? 0).toBeGreaterThan(0)

    const handoff = buildManualEditHandoff()
    expect(handoff).not.toBeNull()
    loadFromHandoff(handoff!)

    const doc = getEditDoc()!
    const gemsSnap = plainGems(doc.gems)
    const gridSnap = { ...doc.grid }
    const blocksSnap = plainGems(doc.blocks.map((b) => ({ ...b })))
    const pixelsSnap = new Uint8ClampedArray(doc.paintingSnapshot.data)
    const count = getGemCount()

    setGlobalDensity(0.25)
    recompute()
    await waitForStudioIdle()
    expect(getGlobalDensity()).toBe(0.25)
    expect(getActiveResult()?.gems.length ?? 0).not.toBe(count) // 工作台确实重算了

    expect(getGemCount()).toBe(count)
    expect(plainGems(getEditDoc()!.gems)).toEqual(gemsSnap)
    expect(getEditDoc()!.grid).toEqual(gridSnap)
    expect(plainGems(getEditDoc()!.blocks.map((b) => ({ ...b })))).toEqual(blocksSnap)
    expect(new Uint8ClampedArray(getEditDoc()!.paintingSnapshot.data)).toEqual(pixelsSnap)
  })
})
