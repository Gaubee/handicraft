/*
 * [2026-09-20 studio-layers 2.9 · ④段验收] 消费端到端 jsdom 走查（design §2.10 验收清单）：
 * 载入（默认全选 + 自动排布 = 现状效果——工作默认一）→ 建层/移块（图层域结构语义）→
 * 多选混合配置批量写（锚点 = 最早选中；单 layer.config op 写全部选中层 = 一次撤销还原全部）→
 * 撤销跨重分块（undo segment.opts → refold 旧 k → 块 id 确定性复原）→ 隐藏层导出口径
 * （隐藏 ≠ 排除：联合统计/导出包含隐藏层）→ 送精修 v2（buildManualEditHandoff 全层 +
 * 逐钻 GemSpecSnapshot + PhysicalCanvas）。
 *
 * store 级走查（无组件挂载——jsdom 端到端的真源断言面；组件面走查归 panels/interactions/
 * studio-view.mount 三件）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildManualEditHandoff,
  dispatchLayerConfigOp,
  dispatchStudioOp,
  getBlocks,
  getHiddenLayerCount,
  getLayerMemberIds,
  getLayerResult,
  getLayers,
  getSegK,
  getSelectionOrder,
  getUndoDepth,
  jointViewOf,
  loadFromEngineImage,
  resetStudioForTests,
  selectedConfigView,
  setLayerVisible,
  setSegK,
  undoStudioOp,
  waitForStudioIdle,
  writeSelectedLayerConfig,
} from '$lib/stores/studio.svelte'
import { selectLayer } from '$lib/studio/layers.svelte'
import { fixtureShapes } from '../engine/helpers'

beforeEach(() => {
  resetStudioForTests()
})

describe('④段验收 · 消费端到端 jsdom 走查', () => {
  it('载入→默认全选自动排布→建层/移块→多选混合批量写→撤销跨重分块→隐藏层导出口径→送精修 v2', async () => {
    // ① 载入：页面一进来默认全选图层 + 自动排布（1.1 compatibility 等价面）
    loadFromEngineImage(fixtureShapes(), '走查.png', 'upload')
    await waitForStudioIdle()
    expect(getSelectionOrder()).toEqual(['L1']) // 单层即全选
    expect(getLayerResult('L1')?.gems.length ?? 0).toBeGreaterThan(0) // 自动排布已落地
    const idsAtK8 = getBlocks().map((b) => b.id)

    // ② 建层 + 移块：L2 持两块（create 带块 + moveBlocks 追加）、L1 兜底收缩
    const [b0, b1] = [getBlocks()[0]!.id, getBlocks()[1]!.id]
    dispatchStudioOp({ t: 'layer.create', name: '前景', blockIds: [b0] })
    dispatchStudioOp({ t: 'layer.moveBlocks', blockIds: [b1], toLayerId: 'L2' })
    await waitForStudioIdle()
    const l2Members = getLayerMemberIds('L2')
    expect(l2Members.has(b0) && l2Members.has(b1)).toBe(true)
    expect(getLayerMemberIds('L1').has(b0)).toBe(false) // 兜底 = 全块 − 显式并集

    // ③ 多选混合批量写：L2 先行差异化（gap 0.8）→ 选 L1+L2 → 混合横幅数据面 + 锚点预填
    dispatchLayerConfigOp(['L2'], { gapMm: 0.8 })
    selectLayer('L1', 'replace')
    selectLayer('L2', 'toggle') // 选择序 [L1, L2]——锚点 = 最早选中 L1
    const view = selectedConfigView()
    expect(view?.banner).toBe('mixed')
    expect(view?.count).toBe(2)
    expect(view?.anchorName).toBe('图层 1')
    expect(view?.gapMm.mixed).toBe(true)
    expect(view?.gapMm.value).toBe(0.4) // 预填锚点值（非混合值）

    const depthBefore = getUndoDepth()
    writeSelectedLayerConfig({ density: 0.6 }) // 批量写 = 单 layer.config op
    expect(getUndoDepth()).toBe(depthBefore + 1)
    expect(getLayers().every((l) => l.physics.density === 0.6)).toBe(true) // 全部选中层写入

    // ④ 撤销跨重分块：setSegK(6) → 重分块真实发生（runSegment 重跑 + landBlocks 落位；fixture
    // 分离色区对 k 不敏感——ids 恒定，k 敏感面归 layers/history 域测）；undo（refold 回 k=8）
    // → 根重跑分块 + 块 id 确定性复原
    setSegK(6)
    await waitForStudioIdle()
    expect(getSegK()).toBe(6)
    const densityDepth = getUndoDepth()
    undoStudioOp() // 撤销 segment.opts → refold → 根重跑分块（k=8）
    await waitForStudioIdle()
    expect(getSegK()).toBe(8)
    expect(getBlocks().map((b) => b.id)).toEqual(idsAtK8) // 确定性复原（同 k/seed 同块 id）
    expect(getUndoDepth()).toBe(densityDepth - 1)
    expect(getLayers().every((l) => l.physics.density === 0.6)).toBe(true) // 撤的是分块参数，不回卷密度

    // ⑤ 隐藏层导出口径：隐藏 ≠ 排除——联合统计/导出含隐藏层
    const jointTotal = jointViewOf(getLayers()).gems.length
    expect(jointTotal).toBeGreaterThan(0)
    setLayerVisible('L2', false)
    expect(getHiddenLayerCount()).toBe(1)
    expect(jointViewOf(getLayers()).gems.length).toBe(jointTotal) // 观察态不入统计口径

    // ⑥ 送精修 v2：全层 concat + 逐钻规格快照 + PhysicalCanvas（③段 handoffV2 契约消费）
    const handoff = buildManualEditHandoff()
    expect(handoff).not.toBeNull()
    expect(handoff!.gems).toHaveLength(jointTotal)
    for (const gem of handoff!.gems) {
      expect(gem.shapeId).toBeTruthy() // 逐钻 GemSpecSnapshot 物化
      expect(gem.diameterMm).toBeGreaterThan(0)
    }
    expect(handoff!.physicalCanvas).toBeDefined() // 物理锚贯通（pixelsPerMm 派生真源）
    expect(handoff!.sourceSummary).toContain('2 层') // 层语法 sourceSummary（E.5）
  })
})
