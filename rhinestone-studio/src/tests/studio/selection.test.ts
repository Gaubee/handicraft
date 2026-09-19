/*
 * [2026-09-20 studio-layers 2.4] 多选与「配置不同」验收面（tasks 2.4，工作默认二）：
 * - 选择序语义：单击重置 / Cmd 尾部追加 / Shift 范围替换 / Cmd+A 全选普通层；
 *   锚点 = selectionOrder[0] = 最早选中（Owner：「不是排列在前面，是最早选中的」）+ 徽标 ①②③；
 * - 字段级混合检测器冻结矩阵（不同策略/spec/gap/relax/overrides 组合 + 空层选中态）；
 * - 混合态字段预填锚点值（不显示混合值）+ 横幅「N 层配置不同 · 以 ①层名 为基准」；
 * - 批量写入 = 单 layer.config op（一次撤销恢复全部原值）+ 每层标脏重算；
 * - 画布点选块 = 隐式单选所属层；命中失败（null）不改层选择；背景层选中独占且批量只读。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearLayerSelection,
  getAnchorLayer,
  getLayers,
  getSelectionOrder,
  initDefaultLayers,
  isBackgroundSelected,
  isLayerSelected,
  resetStudioForTests,
  selectAllLayers,
  selectBackground,
  selectBlock,
  selectLayer,
  selectedConfigView,
  selectionBadgeOf,
  undoStudioOp,
  waitForStudioIdle,
  writeSelectedLayerConfig,
  loadFromEngineImage,
  getLayerResult,
  getBlocks,
} from '$lib/stores/studio.svelte'
import { dispatchStudioOp, getOps } from '$lib/studio/history.svelte'

beforeEach(() => {
  resetStudioForTests()
  initDefaultLayers()
})

function makeLayer(name: string): string {
  dispatchStudioOp({ t: 'layer.create', name })
  return getLayers()[getLayers().length - 1]!.id
}

describe('2.4 选择序语义', () => {
  it('单击重置 / Cmd 尾部追加（选择序=加选序，非列表序）', () => {
    const l2 = makeLayer('L2')
    const l3 = makeLayer('L3')
    expect(getSelectionOrder()).toEqual(['L1']) // 进页默认全选（单层）
    selectLayer(l3)
    expect(getSelectionOrder()).toEqual([l3]) // 单击重置
    selectLayer('L1', 'toggle')
    selectLayer(l2, 'toggle')
    expect(getSelectionOrder()).toEqual([l3, 'L1', l2]) // 追加序 = 选择序
    expect(getAnchorLayer()?.id).toBe(l3) // 锚点 = 最早选中（非列表首）
    selectLayer('L1', 'toggle') // 再点移出
    expect(getSelectionOrder()).toEqual([l3, l2])
  })

  it('Shift 范围替换（锚点 → 点击层的列表序区间）', () => {
    const l2 = makeLayer('L2')
    const l3 = makeLayer('L3')
    const l4 = makeLayer('L4')
    selectLayer('L1') // 锚点 = L1（最早选中）
    selectLayer(l4, 'range')
    expect(getSelectionOrder()).toEqual(['L1', l2, l3, l4]) // 列表序区间（锚点 L1 → L4）
    selectLayer(l2, 'range') // 锚点仍 L1 → 区间收窄
    expect(getSelectionOrder()).toEqual(['L1', l2])
  })

  it('Cmd+A 全选普通层；选择序徽标 ①②③ 仅多选 >1 时显示', () => {
    const l2 = makeLayer('L2')
    selectAllLayers()
    expect(getSelectionOrder()).toEqual(['L1', l2])
    expect(selectionBadgeOf('L1')).toBe(1)
    expect(selectionBadgeOf(l2)).toBe(2)
    selectLayer('L1') // 回单选 → 徽标消失
    expect(selectionBadgeOf('L1')).toBeNull()
    expect(selectionBadgeOf(l2)).toBeNull()
  })

  it('背景层选中独占（层选择清空；再选普通层复位）', () => {
    makeLayer('L2')
    selectAllLayers()
    selectBackground()
    expect(isBackgroundSelected()).toBe(true)
    expect(getSelectionOrder()).toEqual([])
    selectLayer('L1')
    expect(isBackgroundSelected()).toBe(false)
  })

  it('结构变更后选择集过滤死层（undo 跨删除稳健面）', () => {
    const l2 = makeLayer('L2')
    selectLayer(l2, 'toggle')
    expect(getSelectionOrder()).toEqual(['L1', l2])
    dispatchStudioOp({ t: 'layer.delete', layerId: l2 })
    expect(getSelectionOrder()).toEqual(['L1'])
    expect(isLayerSelected(l2)).toBe(false)
  })
})

describe('2.4 混合配置检测器（字段级冻结矩阵）', () => {
  it('全部字段相等 → 「配置相同」横幅 + 共同值', () => {
    makeLayer('L2')
    selectAllLayers()
    const view = selectedConfigView()
    expect(view).not.toBeNull()
    expect(view!.count).toBe(2)
    expect(view!.banner).toBe('same')
    expect(view!.strategy).toEqual({ mixed: false, value: 'hybrid' })
    expect(view!.specKey).toEqual({ mixed: false, value: 'round-ss10' })
    expect(view!.gapMm).toEqual({ mixed: false, value: 0.4 })
    expect(view!.density).toEqual({ mixed: false, value: 1 })
    expect(view!.relax).toEqual({ mixed: false, value: { boundary: false, repulsion: false } })
    expect(view!.overridesMixed).toBe(false)
  })

  it.each([
    ['策略不同', (id: string) => dispatchStudioOp({ t: 'layer.config', layerIds: [id], patch: { strategy: 'poisson' }, prev: [] }), 'strategy'],
    ['规格不同', (id: string) => dispatchStudioOp({ t: 'layer.config', layerIds: [id], patch: { specKey: 'round-ss16' }, prev: [] }), 'specKey'],
    ['gap 不同', (id: string) => dispatchStudioOp({ t: 'layer.config', layerIds: [id], patch: { gapMm: 0.6 }, prev: [] }), 'gapMm'],
    ['密度不同', (id: string) => dispatchStudioOp({ t: 'layer.config', layerIds: [id], patch: { density: 0.5 }, prev: [] }), 'density'],
    ['松弛不同', (id: string) => dispatchStudioOp({ t: 'layer.config', layerIds: [id], patch: { relax: { boundary: true, repulsion: false } }, prev: [] }), 'relax'],
  ] as const)('%s → 混合横幅 + 全字段预填锚点值（不显示混合值）', (_name, mutate, field) => {
    const l2 = makeLayer('L2')
    mutate(l2)
    // 锚点 = L1（最早选中）→ 预填 L1 值
    selectAllLayers()
    const view = selectedConfigView()!
    expect(view.banner).toBe('mixed')
    expect(view.anchorName).toBe('图层 1')
    expect((view as unknown as Record<string, { mixed: boolean }>)[field].mixed).toBe(true)
    // 预填锚点值：L1 默认配置（混合值不出现在字段位）
    expect(view.strategy.value).toBe('hybrid')
    expect(view.specKey.value).toBe('round-ss10')
    expect(view.gapMm.value).toBe(0.4)
    expect(view.density.value).toBe(1)
    expect(view.relax.value).toEqual({ boundary: false, repulsion: false })
    // 锚点换 L2 → 预填 L2 值（最早选中语义贯穿）
    clearLayerSelection()
    selectLayer(l2, 'toggle')
    selectLayer('L1', 'toggle')
    const view2 = selectedConfigView()!
    expect(view2.anchorName).toBe('L2')
    if (field === 'strategy') expect(view2.strategy.value).toBe('poisson')
    if (field === 'gapMm') expect(view2.gapMm.value).toBe(0.6)
  })

  it('覆写存在性参与混合判定（同配置不同覆写 → mixed）', () => {
    const l2 = makeLayer('L2')
    dispatchStudioOp({ t: 'block.override', blockId: 'any-block', patch: { kind: 'density', value: 0.5 } })
    selectAllLayers()
    const view = selectedConfigView()!
    expect(view.overridesMixed).toBe(true)
    expect(view.banner).toBe('mixed')
    expect(view.strategy.mixed).toBe(false) // 其余字段仍 same（字段级，非整层 blob）
  })

  it('空选择 → null 视图（检查器空态）', () => {
    clearLayerSelection()
    expect(selectedConfigView()).toBeNull()
  })
})

describe('2.4 批量写入 = 单 layer.config op', () => {
  it('触碰任一控件写入全部选中层：一次撤销恢复全部原值', () => {
    const l2 = makeLayer('L2')
    const l3 = makeLayer('L3')
    selectAllLayers()
    expect(getSelectionOrder()).toEqual(['L1', l2, l3])
    const opsBefore = getOps().length
    writeSelectedLayerConfig({ gapMm: 0.7 })
    expect(getOps().length).toBe(opsBefore + 1) // 单 op（多选批量）
    for (const layer of getLayers()) expect(layer.physics.gapMm).toBe(0.7)
    expect(undoStudioOp()).toBe(true)
    for (const layer of getLayers()) expect(layer.physics.gapMm).toBe(0.4) // 一次恢复全部
  })

  it('批量写随层标脏：全部选中层重算落地', async () => {
    loadFromEngineImage(
      { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(200) },
      'batch.png',
      'upload',
    )
    await waitForStudioIdle()
    expect(getBlocks().length).toBeGreaterThanOrEqual(1)
    const l2 = makeLayer('前景')
    dispatchStudioOp({ t: 'layer.moveBlocks', blockIds: [getBlocks()[0]!.id], toLayerId: l2 })
    await waitForStudioIdle()
    selectAllLayers()
    writeSelectedLayerConfig({ strategy: 'poisson' })
    await waitForStudioIdle()
    for (const layer of getLayers()) {
      expect(getLayerResult(layer.id)?.strategy).toBe('poisson')
    }
  })
})

describe('2.4 画布 ↔ 层选择联动', () => {
  it('块选择命中 = 隐式单选所属层；null（取消选中）不动层选择', async () => {
    loadFromEngineImage(
      { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(200) },
      'link.png',
      'upload',
    )
    await waitForStudioIdle()
    const blocks = getBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    const l2 = makeLayer('前景')
    dispatchStudioOp({ t: 'layer.moveBlocks', blockIds: [blocks[0]!.id], toLayerId: l2 })
    selectAllLayers()
    selectBlock(blocks[0]!.id)
    expect(getSelectionOrder()).toEqual([l2]) // 块属 L2 → 隐式单选
    selectBlock(null)
    expect(getSelectionOrder()).toEqual([l2]) // 命中失败/取消块选择不改层选择
  })
})
