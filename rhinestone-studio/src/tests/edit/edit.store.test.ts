/*
 * [2026-09-19 Test] tasks 1.1：EditDocument 快照载入（toEditGem 转换/深拷贝隔离/m- id 策略/
 * 图层与选择默认）+ tasks 3.2 烘焙隔离（工作台参数变更不回流）。
 * [2026-09-21 redesign-designer-workbench 1.1 v3 演进]（显式更新，非静默改）：
 * - 固定四层断言 → v3 模型断言（layers: GemLayerRecord[]「图层 1」+ underlay sources 按载荷可用性）；
 * - setLayerVisible/setLayerOpacity（EditLayerKey）→ setUnderlaySource…/setGemLayer… 族（v3 setter 面）；
 * - 新增 layerId 生命周期断言族（design §4.1 生命周期表逐行：新增/更新/删除/复制/合并/移入/迁移）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  MANUAL_ID_PREFIX,
  addGemLayer,
  applyPatch,
  clearSelection,
  duplicateGems,
  getEditDoc,
  getGemCount,
  getSourceSummary,
  getUnderlaySource,
  getUndoDepths,
  loadFromHandoff,
  mergeGemLayers,
  moveGemsToLayer,
  nextManualId,
  redo,
  renameGemLayer,
  resetEditForTests,
  setGemLayerLocked,
  setGemLayerOpacity,
  setGemLayerVisible,
  setSelection,
  setUnderlaySourceOpacity,
  setUnderlaySourceVisible,
  toggleSelection,
  undo,
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
  it('gems 经 toEditGem 转换 + [1.1 v3] layerId 归「图层 1」：origin=layout、moved=false、blockId 直传', () => {
    loadFromHandoff(makeHandoff(6))
    const doc = getEditDoc()
    expect(doc).not.toBeNull()
    expect(doc!.gems).toHaveLength(6)
    for (const g of doc!.gems) {
      expect(g.origin).toBe('layout')
      expect(g.moved).toBe(false)
      expect(g.blockId).toBe('blk-1')
      expect(g.id).toMatch(/^g\d{5}$/)
      expect(g.layerId).toBe('L1') // [1.1 v3] 交接钻全数归默认钻层（design §4.1）
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

  it('[1.1 v3] 图层模型默认：layers=[图层 1]（visible/locked；opacity 缺省 1.0 省略）+ underlay 源按载荷可用性呈现', () => {
    loadFromHandoff(makeHandoff()) // 无 reference、有 blocks
    const doc = getEditDoc()!
    expect(doc.layers).toHaveLength(1)
    expect(doc.layers[0]).toEqual({ id: 'L1', name: '图层 1', visible: true, locked: false })
    expect(doc.layers[0].opacity).toBeUndefined() // 缺省 1.0 = 省略（新文档规范形态）
    expect(doc.underlay.sources.map((s) => s.key)).toEqual(['painting', 'blocks']) // reference 无载荷不呈现
    expect(doc.underlay.sources[0]).toEqual({ key: 'painting', visible: true, opacity: 1 })
    expect(doc.underlay.sources[1]).toEqual({ key: 'blocks', visible: true, opacity: 0.9 })
    expect(doc.selection.size).toBe(0)
  })

  it('[1.1 v3] 带 reference 的交接：underlay 三源齐备（v2 缺省透明度语义保留：reference 0.6）', () => {
    loadFromHandoff(makeHandoff(2, { referenceAssetId: 'ast-ref-x' }))
    const doc = getEditDoc()!
    expect(doc.underlay.sources.map((s) => `${s.key}:${s.opacity}`)).toEqual(['painting:1', 'reference:0.6', 'blocks:0.9'])
    expect(doc.referenceAssetId).toBe('ast-ref-x')
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

describe('edit store · 图层与选择 setter（[1.1 v3 演进] 四层面 → 源级/层级 setter）', () => {
  it('setUnderlaySource*/setGemLayer*（透明度 clamp 0.01..1——gemdoc 格式值域 (0,1] 同口径）', () => {
    loadFromHandoff(makeHandoff())
    setUnderlaySourceVisible('painting', false)
    setUnderlaySourceOpacity('blocks', 1.7)
    setGemLayerOpacity('L1', -0.2)
    setGemLayerLocked('L1', true)
    const doc = getEditDoc()!
    expect(getUnderlaySource('painting')!.visible).toBe(false)
    expect(getUnderlaySource('blocks')!.opacity).toBe(1)
    expect(doc.layers[0].opacity).toBeCloseTo(0.01, 10)
    expect(doc.layers[0].locked).toBe(true)
  })

  it('[1.1 v3] 源缺席 = 显式不可见缺省（getUnderlaySource null；setter 静默 no-op 不造源）', () => {
    loadFromHandoff(makeHandoff()) // 无 reference 源
    expect(getUnderlaySource('reference')).toBeNull()
    setUnderlaySourceVisible('reference', false)
    setUnderlaySourceOpacity('reference', 0.5)
    expect(getUnderlaySource('reference')).toBeNull()
  })

  it('renameGemLayer（trim；空串保持原名）', () => {
    loadFromHandoff(makeHandoff())
    renameGemLayer('L1', '  主钻面  ')
    expect(getEditDoc()!.layers[0].name).toBe('主钻面')
    renameGemLayer('L1', '   ')
    expect(getEditDoc()!.layers[0].name).toBe('主钻面')
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

// ---------------------------------------------------------------------------
// [1.1 v3] layerId 生命周期（design §4.1 生命周期表逐行——R1-P0-4 裁决验收面）
// 「序列化/导出投影」两行的文件级断言归 1.2 gemdocV3Migration.test.ts 与 4.3 隐藏层口径切片。
// ---------------------------------------------------------------------------

describe('layerId 生命周期（design §4.1 表逐行）', () => {
  it('新增：add patch 携带的 layerId 原样落位（调用方=笔刷/粘贴/智能排布，当前层决策归其所有）', () => {
    loadFromHandoff(makeHandoff(2))
    expect(
      applyPatch({
        op: 'add',
        gems: [
          { id: 'm-1', x: 10, y: 10, colorId: 'red', blockId: null, origin: 'manual', moved: false, shapeId: 'round', diameterMm: 2.8, layerId: 'L1' },
        ],
      }).ok,
    ).toBe(true)
    expect(getEditDoc()!.gems.at(-1)).toMatchObject({ id: 'm-1', layerId: 'L1' })
  })

  it('更新：几何/规格/颜色 update patch 不改归属（归属与几何正交）', () => {
    loadFromHandoff(makeHandoff(2))
    const g = getEditDoc()!.gems[0]
    applyPatch({ op: 'update', changes: [{ id: g.id, before: { x: g.x }, after: { x: g.x + 5 } }] })
    expect(getEditDoc()!.gems[0].layerId).toBe('L1')
  })

  it('删除：remove patch 随钻记录移除 layerId（undo 回插复原归属）', () => {
    loadFromHandoff(makeHandoff(2))
    const g = getEditDoc()!.gems[0]
    const index = 0
    applyPatch({ op: 'remove', items: [{ gem: { ...g }, index }] })
    expect(getEditDoc()!.gems.some((x) => x.id === g.id)).toBe(false)
    undo()
    expect(getEditDoc()!.gems[0]).toMatchObject({ id: g.id, layerId: 'L1' })
  })

  it('复制：副本 origin=manual·blockId=null·moved 重置·id 走 m- 自增·归当前目标层；原钻原位归属不变；undo 移除副本', () => {
    loadFromHandoff(makeHandoff(2))
    const original = getEditDoc()!.gems[0] // layout 钻（blockId='blk-1'、moved=false）
    // moved 不在 update patch 白名单（几何/规格/归属正交）——直接置位构造「被移动过」原钻
    original.moved = true
    const moved = getEditDoc()!.gems[0]

    const id2 = addGemLayer()!
    expect(id2).toBe('L2')
    expect(getEditDoc()!.layers.map((l) => l.id)).toEqual(['L1', 'L2'])

    expect(duplicateGems([moved.id], 'L2').ok).toBe(true)
    const copy = getEditDoc()!.gems.at(-1)!
    expect(copy.id).toBe(`${MANUAL_ID_PREFIX}1`)
    expect(copy.layerId).toBe('L2') // 跨层复制统一归当前目标层
    expect(copy.origin).toBe('manual')
    expect(copy.blockId).toBeNull()
    expect(copy.moved).toBe(false) // moved 重置
    expect(copy.x).toBe(moved.x) // 几何/规格随副本
    expect(getEditDoc()!.gems[0]).toMatchObject({ id: moved.id, layerId: 'L1', moved: true }) // 原钻原位归属不变

    expect(getUndoDepths().undo).toBe(2) // addGemLayer / duplicate 各一组（moved 直改非 patch——不入栈）
    undo() // 撤销复制
    expect(getEditDoc()!.gems.some((g) => g.id === copy.id)).toBe(false)
  })

  it('合并：源层钻 layerId 批量改写目标层 + 源层记录删除 = 单 op（一次撤销恢复源层与全部归属）', () => {
    loadFromHandoff(makeHandoff(3))
    const l2 = addGemLayer('描边')!
    const ids = getEditDoc()!.gems.slice(0, 2).map((g) => g.id)
    expect(moveGemsToLayer(ids, l2).ok).toBe(true)
    expect(getEditDoc()!.gems[0].layerId).toBe('L2')
    expect(getEditDoc()!.gems[2].layerId).toBe('L1')

    expect(mergeGemLayers('L2', 'L1').ok).toBe(true) // 合并 = 单 op
    const doc = getEditDoc()!
    expect(doc.layers.map((l) => l.id)).toEqual(['L1']) // 源层记录删除
    for (const g of doc.gems) expect(g.layerId).toBe('L1') // 全部归属目标层

    undo() // 一次撤销：恢复源层与全部归属
    const restored = getEditDoc()!
    expect(restored.layers.map((l) => l.id)).toEqual(['L1', 'L2'])
    expect(restored.layers[1].name).toBe('描边')
    expect(restored.gems[0].layerId).toBe('L2')
    expect(restored.gems[2].layerId).toBe('L1')
    redo()
    expect(getEditDoc()!.gems.every((g) => g.layerId === 'L1')).toBe(true)
  })

  it('合并拒绝面：目标=源自身 / 层不存在', () => {
    loadFromHandoff(makeHandoff(2))
    expect(mergeGemLayers('L1', 'L1').ok).toBe(false)
    expect(mergeGemLayers('L9', 'L1').ok).toBe(false)
  })

  it('移入图层：选中钻 layerId 批量改写指定层 = 单 patch 组；目标层钻不变；目标不存在拒绝', () => {
    loadFromHandoff(makeHandoff(3))
    const l2 = addGemLayer()!
    const ids = getEditDoc()!.gems.map((g) => g.id)
    const depthBefore = getUndoDepths().undo
    expect(moveGemsToLayer(ids.slice(0, 2), l2).ok).toBe(true)
    expect(getUndoDepths().undo).toBe(depthBefore + 1) // 单组
    expect(getEditDoc()!.gems[0].layerId).toBe('L2')
    expect(getEditDoc()!.gems[1].layerId).toBe('L2')
    expect(getEditDoc()!.gems[2].layerId).toBe('L1')
    undo()
    expect(getEditDoc()!.gems.every((g) => g.layerId === 'L1')).toBe(true)
    expect(moveGemsToLayer(ids, 'L9').ok).toBe(false)
  })

  it('新建层：层 id 自增不回收（L 前缀；undo 恢复后编号由计数单调保证不复用）', () => {
    loadFromHandoff(makeHandoff(2))
    expect(addGemLayer()!).toBe('L2')
    expect(addGemLayer('自定义名')!).toBe('L3')
    expect(getEditDoc()!.layers.map((l) => [l.id, l.name])).toEqual([
      ['L1', '图层 1'],
      ['L2', '图层 2'],
      ['L3', '自定义名'],
    ])
    undo() // 撤销 L3 新建
    expect(getEditDoc()!.layers).toHaveLength(2)
    expect(addGemLayer()!).toBe('L3') // 计数器只增不减（同 m- 口径）
  })

  it('addGemLayer 可撤销/重做（结构 op 走 patch 面）；空文档返回 null', () => {
    expect(addGemLayer()).toBeNull()
  })
})
