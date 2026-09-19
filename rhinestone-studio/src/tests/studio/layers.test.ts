/*
 * [2026-09-20 studio-layers 2.1] 图层域 store：LayerState reducer + 不变量全矩阵 +
 * 生命周期 op + LayerState↔LayerRecord 投影 round-trip（tasks 2.1 验收面）。
 * 兼容性锚点：单兜底层投影下 getBlockDensity 回落 = 所属层密度（原全局密度语义的层级化）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Block, BlockType } from '$lib/engine'
import {
  DEFAULT_LAYER_STRATEGY,
  DEFAULT_SPEC_KEY,
  applyLayerConfig,
  applySegmentOpts,
  applyPaletteEdit,
  assertLayerInvariants,
  blockDensityOf,
  checkLayerInvariants,
  cloneParamState,
  createLayer,
  deleteLayer,
  fromLayerRecord,
  getLayers,
  initDefaultLayers,
  landBlocks,
  mergeLayers,
  moveBlocks,
  owningLayerOf,
  paramStateHash,
  renameLayer,
  resetLayersForTests,
  restoreDefaultObservationState,
  setBlockOverride,
  setLayerVisible,
  syncBlocksLanded,
  toLayerRecord,
  type StudioParamState,
} from '$lib/studio/layers.svelte'

function emptyParamState(): StudioParamState {
  return { layers: [], layerSeq: 0, palette: [], segment: { k: 8, seed: 1 } }
}

function block(id: string): Block {
  return {
    id,
    label: `块 ${id}`,
    mask: { w: 2, h: 2, bits: new Uint8Array([1, 1, 1, 1]) },
    colorRgb: [120, 120, 120],
    areaPx: 4,
    bbox: { x: 0, y: 0, w: 2, h: 2 },
    widthPx: { max: 2, mean: 2 },
    suggested: 'fill' as BlockType,
  }
}

function baseWithRest(): StudioParamState {
  const state = emptyParamState()
  createLayer(state, { name: '图层 1' })
  // 首层默认持 'rest' 哨兵？——否：createLayer 建显式空层；rest 由 initDefaultLayers/装载建立。
  return state
}

beforeEach(() => {
  resetLayersForTests()
})

describe('2.1 不变量守卫（全矩阵）', () => {
  it('零层 = 无违反（空态合法）；有层无 rest = rest-missing', () => {
    expect(checkLayerInvariants([])).toEqual([])
    const state = baseWithRest()
    expect(checkLayerInvariants(state.layers)).toEqual([
      { code: 'rest-missing' },
    ])
  })

  it('多 rest = rest-multiple', () => {
    const state = emptyParamState()
    const a = createLayer(state, { name: 'A' })
    const b = createLayer(state, { name: 'B' })
    a.blockIds = 'rest'
    b.blockIds = 'rest'
    expect(checkLayerInvariants(state.layers)).toEqual([{ code: 'rest-multiple', layerId: b.id }])
  })

  it('跨层重复块 / 层内重复块 = duplicate-block；并集 ⊄ 块集 = block-out-of-set', () => {
    const state = emptyParamState()
    const a = createLayer(state, { name: 'A', blockIds: ['b1', 'b2'] })
    const b = createLayer(state, { name: 'B', blockIds: ['b2', 'b2', 'b3'] })
    a.blockIds = 'rest'
    const violations = checkLayerInvariants(state.layers, new Set(['b1', 'b2']))
    expect(violations).toContainEqual({ code: 'duplicate-block', layerId: b.id, blockId: 'b2' })
    expect(violations).toContainEqual({ code: 'block-out-of-set', layerId: b.id, blockId: 'b3' })
    // 块集缺席时跳过 block-out-of-set 面（fold 态不含块集）
    expect(checkLayerInvariants(state.layers).some((v) => v.code === 'block-out-of-set')).toBe(false)
  })

  it('assertLayerInvariants 违反即抛（运行时守卫 fail-fast）', () => {
    expect(() => assertLayerInvariants(baseWithRest().layers)).toThrow(/图层不变量违反/)
    expect(() => assertLayerInvariants([], new Set<string>())).not.toThrow()
  })
})

describe('2.1 生命周期 op', () => {
  function restful(): StudioParamState {
    const state = emptyParamState()
    const rest = createLayer(state, { name: '兜底' })
    rest.blockIds = 'rest'
    return state
  }

  it('createLayer：空层继承锚点层配置 + id 自增 L1/L2…（fold 确定性）', () => {
    const state = restful()
    state.layers[0].strategy = 'poisson'
    const l2 = createLayer(state, { name: '细节' })
    expect(l2.id).toBe('L2')
    expect(l2.strategy).toBe('poisson')
    expect(l2.blockIds).toEqual([])
    const l3 = createLayer(state, {})
    expect(l3.name).toBe('图层 3')
    expect(state.layerSeq).toBe(3)
  })

  it('createLayer 随层携带块（移入新图层）：块从原显式层摘出', () => {
    const state = restful()
    const a = createLayer(state, { name: 'A', blockIds: ['b1', 'b2'] })
    const b = createLayer(state, { name: 'B', blockIds: ['b1'] })
    expect(a.blockIds).toEqual(['b2'])
    expect(b.blockIds).toEqual(['b1'])
    expect(checkLayerInvariants(state.layers, new Set(['b1', 'b2']))).toEqual([])
  })

  it('deleteLayer：兜底层不可删（诊断 layer-delete-rest，层保持）；普通层删除 = 块随层移出', () => {
    const state = restful()
    const a = createLayer(state, { name: 'A', blockIds: ['b1'] })
    expect(deleteLayer(state, state.layers[0].id)).toEqual([
      { code: 'layer-delete-rest', layerId: 'L1' },
    ])
    expect(state.layers).toHaveLength(2)
    expect(deleteLayer(state, a.id)).toEqual([])
    expect(state.layers).toHaveLength(1)
    expect(deleteLayer(state, 'L404')).toEqual([{ code: 'layer-not-found', layerId: 'L404' }])
  })

  it('mergeLayers：块集并集入锚点层 + 覆写四表随块并入 + 其余层删除', () => {
    const state = restful()
    const a = createLayer(state, { name: 'A', blockIds: ['b1'] })
    const b = createLayer(state, { name: 'B', blockIds: ['b2'] })
    b.overrides.density.b2 = 0.6
    a.overrides.disabled.b1 = true
    const diagnostics = mergeLayers(state, a.id, [b.id])
    expect(diagnostics).toEqual([])
    expect(a.blockIds).toEqual(['b1', 'b2'])
    expect(a.overrides.density.b2).toBe(0.6)
    expect(state.layers.some((l) => l.id === b.id)).toBe(false)
  })

  it('mergeLayers 目标为兜底层：并入块自然落入 rest（显式成员表保持空）', () => {
    const state = restful()
    const a = createLayer(state, { name: 'A', blockIds: ['b1'] })
    const rest = state.layers[0]
    expect(mergeLayers(state, rest.id, [a.id])).toEqual([])
    expect(rest.blockIds).toBe('rest')
    expect(state.layers).toHaveLength(1)
  })

  it('renameLayer：写名 + 空名 no-op + 未知层诊断', () => {
    const state = restful()
    expect(renameLayer(state, 'L1', '  主图案 ')).toEqual([])
    expect(state.layers[0].name).toBe('主图案')
    expect(renameLayer(state, 'L1', '  ')).toEqual([{ code: 'no-op', layerId: 'L1' }])
    expect(renameLayer(state, 'L9', 'x')).toEqual([{ code: 'layer-not-found', layerId: 'L9' }])
  })

  it('moveBlocks：显式层间移动互斥（摘出原层再入列）；目标 = 兜底层即落回 rest', () => {
    const state = restful()
    const a = createLayer(state, { name: 'A', blockIds: ['b1', 'b2'] })
    const b = createLayer(state, { name: 'B' })
    const ids = new Set(['b1', 'b2'])
    expect(moveBlocks(state, ['b1', 'ghost'], b.id, ids)).toEqual([
      { code: 'block-not-in-set', blockId: 'ghost' },
    ])
    expect(a.blockIds).toEqual(['b2'])
    expect(b.blockIds).toEqual(['b1'])
    moveBlocks(state, ['b1'], state.layers[0].id, ids)
    expect(b.blockIds).toEqual([])
    // b1 未显式分配 → 属兜底层
    expect(owningLayerOf(state.layers, 'b1')?.id).toBe('L1')
  })

  it('applyLayerConfig：patch 写入全部目标层（clamp gap/density）；未知层诊断', () => {
    const state = restful()
    const a = createLayer(state, { name: 'A' })
    expect(
      applyLayerConfig(state, ['L1', a.id, 'L404'], {
        strategy: 'cvt',
        gapMm: 99,
        density: 0.5,
        relax: { boundary: true, repulsion: false },
      }),
    ).toEqual([{ code: 'layer-not-found', layerId: 'L404' }])
    for (const layer of [state.layers[0], a]) {
      expect(layer.strategy).toBe('cvt')
      expect(layer.physics.gapMm).toBe(0.8)
      expect(layer.physics.density).toBe(0.5)
      expect(layer.physics.relax).toEqual({ boundary: true, repulsion: false })
    }
  })
})

describe('2.1 块级覆写归属 + 两级密度回落', () => {
  it('setBlockOverride 四表写入所属层（显式层命中优先；未分配 = 兜底层）', () => {
    const state = emptyParamState()
    const rest = createLayer(state, { name: '兜底' })
    rest.blockIds = 'rest'
    const a = createLayer(state, { name: 'A', blockIds: ['b1'] })
    setBlockOverride(state, 'b1', { kind: 'density', value: 0.6 })
    setBlockOverride(state, 'b2', { kind: 'enabled', value: false })
    setBlockOverride(state, 'b1', { kind: 'type', value: 'linear' })
    setBlockOverride(state, 'b1', { kind: 'color', value: 'c2' })
    expect(a.overrides.density.b1).toBe(0.6)
    expect(a.overrides.type.b1).toBe('linear')
    expect(a.overrides.color.b1).toBe('c2')
    expect(rest.overrides.disabled.b2).toBe(true)
    // null/true 写入 = 清键（回落层缺省）
    setBlockOverride(state, 'b1', { kind: 'type', value: null })
    setBlockOverride(state, 'b2', { kind: 'enabled', value: true })
    expect(a.overrides.type.b1).toBeUndefined()
    expect(rest.overrides.disabled.b2).toBeUndefined()
  })

  it('密度两级回落：块覆写 ?? 所属层 density（原 globalDensity 语义层级化）', () => {
    const state = emptyParamState()
    const rest = createLayer(state, { name: '兜底' })
    rest.blockIds = 'rest'
    rest.physics.density = 0.7
    const a = createLayer(state, { name: 'A', blockIds: ['b1'] })
    a.physics.density = 0.4
    a.overrides.density.b1 = 0.6
    expect(blockDensityOf(state.layers, 'b1')).toBe(0.6) // 块覆写优先
    expect(blockDensityOf(state.layers, 'b2')).toBe(0.7) // 未覆写 → 兜底层密度
    a.overrides.density.b1 = 1
    expect(blockDensityOf(state.layers, 'b1')).toBe(1)
    delete a.overrides.density.b1
    expect(blockDensityOf(state.layers, 'b1')).toBe(0.4) // 回落所属显式层密度
  })
})

describe('2.1 重分块落位（syncBlocksLanded）', () => {
  it('新块全落兜底层（显式层死键摘除）+ 空层保留 + 逐层悬空覆写清点', () => {
    const state = emptyParamState()
    const rest = createLayer(state, { name: '兜底' })
    rest.blockIds = 'rest'
    const a = createLayer(state, { name: 'A', blockIds: ['old1', 'old2'] })
    a.overrides.density.old1 = 0.6
    a.overrides.color.old2 = 'c1'
    rest.overrides.disabled.old3 = true
    rest.overrides.density.new1 = 0.5 // 兜底层悬空键同样清点

    const report = syncBlocksLanded(state, [block('new1'), block('new2')])
    expect(report).toEqual({ droppedOverrideKeys: 3, emptiedLayers: 1 })
    expect(a.blockIds).toEqual([]) // 空层保留（配置在、块没了）
    expect(a.physics.density).toBe(1)
    expect(a.overrides.density.old1).toBeUndefined()
    expect(rest.overrides.disabled.old3).toBeUndefined()
    expect(rest.overrides.density.new1).toBe(0.5) // 新块键存活
    // rest 展开：new1/new2 自动落入兜底层
    expect(owningLayerOf(state.layers, 'new1')?.id).toBe(rest.id)
  })
})

describe('2.1 投影 round-trip + 观察态边界', () => {
  it('LayerState ↔ LayerRecord round-trip：visible 观察态剥离 + 恢复默认 true', () => {
    const state = emptyParamState()
    const rest = createLayer(state, { name: '兜底' })
    rest.blockIds = 'rest'
    const a = createLayer(state, { name: 'A', blockIds: ['b1'] })
    a.overrides.density.b1 = 0.6
    a.visible = false
    const record = toLayerRecord(a)
    expect('visible' in record).toBe(false)
    const back = fromLayerRecord(record)
    expect(back.visible).toBe(true)
    expect(back).toEqual({ ...a, visible: true })
  })

  it('观察态不入 paramStateHash：visible 翻转不改 state hash', () => {
    const state = emptyParamState()
    const rest = createLayer(state, { name: '兜底' })
    rest.blockIds = 'rest'
    const before = paramStateHash(state)
    rest.visible = false
    expect(paramStateHash(state)).toBe(before)
  })

  it('restoreDefaultObservationState：全层可见复位 + 背景默认源/50%', () => {
    const state = emptyParamState()
    const a = createLayer(state, { name: 'A' })
    a.visible = false
    const background = restoreDefaultObservationState(state.layers)
    expect(a.visible).toBe(true)
    expect(background).toEqual({ source: 'painting', opacity: 0.5, visible: true })
  })
})

describe('2.1 $state 宿主（live 写入面）', () => {
  it('initDefaultLayers：单一兜底层「图层 1」+ 默认配置', () => {
    initDefaultLayers()
    const layers = getLayers()
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({
      id: 'L1',
      name: '图层 1',
      blockIds: 'rest',
      strategy: DEFAULT_LAYER_STRATEGY,
    })
    expect(layers[0].physics.specKey).toBe(DEFAULT_SPEC_KEY)
    expect(layers[0].physics.gapMm).toBe(0.4)
    expect(layers[0].physics.density).toBe(1)
    expect(layers[0].physics.relax).toEqual({ boundary: false, repulsion: false })
    expect(layers[0].visible).toBe(true)
  })

  it('landBlocks：清点上浮（横幅数据面）+ setLayerVisible 观察态写入', () => {
    initDefaultLayers()
    const rest = getLayers()[0]
    rest.overrides.disabled.ghost = true
    const report = landBlocks([block('n1')])
    expect(report.droppedOverrideKeys).toBe(1)
    expect(rest.overrides.disabled.ghost).toBeUndefined()
    setLayerVisible(rest.id, false)
    expect(rest.visible).toBe(false)
  })

  it('cloneParamState：深拷贝隔离（副本改写不动原件——undo/redo refold 快照面）', () => {
    initDefaultLayers()
    const snapshot = cloneParamState({ layers: getLayers(), layerSeq: 1, palette: [], segment: { k: 8, seed: 1 } })
    snapshot.layers[0].name = '改名'
    snapshot.layers[0].overrides.disabled.x = true
    expect(getLayers()[0].name).toBe('图层 1')
    expect(getLayers()[0].overrides.disabled.x).toBeUndefined()
  })
})
