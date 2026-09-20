/*
 * [2026-09-20 studio-layers 2.3] 计算队列域 store 验收面（tasks 2.3）：
 * - 逐层调度序列（单 worker 串行：层 B 在层 A 结算后才起算；进度聚合 segment 1 + N 层带层名）；
 * - 取消/作废（cancelComputeQueue 作废在途层轮 + 清脏队列；新批作废旧批迟到结果不落地）；
 * - 未触碰层缓存保留（①结果缓存/⑥重算期间旧结果保留的 store 面复验）；
 * - 脏层差分（markLayersDirty 只重算标脏层；block.override 标所属层）；
 * - 多层 joint 视图（concat + 跨层 g##### 全局重编号 + 逐层规格物化）；
 * - undo/redo 差分重算（refold 后只有配置变化的层进入重算）。
 * harness 复验（活路径锁定 oracle 逐位相等）在 computeLayer.test.ts——本文件不重复。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  cancelCompute,
  dispatchLayerConfigOp,
  getLayerById,
  getLayerResult,
  getLayerResults,
  getLayers,
  jointViewOf,
  loadFromEngineImage,
  recompute,
  resetStudioForTests,
  setBlockDensity,
  setBlockInherit,
  setBlockLayerConfig,
  undoStudioOp,
  waitForStudioIdle,
  getBlocks,
  getComputeProgress,
  getComputing,
} from '$lib/stores/studio.svelte'
import { dispatchStudioOp } from '$lib/studio/history.svelte'
import { getDirtyLayerIds } from '$lib/studio/computeQueue.svelte'
import { fixtureShapes } from '../engine/helpers'

beforeEach(() => {
  resetStudioForTests()
})

/** 载入并建两层（块集二分）：显式层 L2 持最大块（保证独立排布有产出），其余落兜底层 L1。 */
async function loadTwoLayers(): Promise<void> {
  loadFromEngineImage(fixtureShapes(), 'two-layers.png', 'handoff')
  await waitForStudioIdle()
  const blocks = [...getBlocks()].sort((a, b) => b.areaPx - a.areaPx)
  expect(blocks.length).toBeGreaterThanOrEqual(2)
  dispatchStudioOp({ t: 'layer.create', name: '前景', blockIds: [blocks[0]!.id] })
  // 新层成员就位 → 全量重算（moveBlocks 的 dirty 由 computeQueue 事件接线覆盖此处显式 recompute）
  recompute()
  await waitForStudioIdle()
  expect(getLayerResult('L1')?.gems.length).toBeGreaterThan(0)
  expect(getLayerResult('L2')?.gems.length).toBeGreaterThan(0)
}

describe('2.3 计算队列域：逐层调度与缓存', () => {
  it('两层各自结果落地且策略随层（joint 视图 = concat + 跨层 id 全局重编号 + 层规格物化）', async () => {
    await loadTwoLayers()
    dispatchLayerConfigOp(['L2'], { strategy: 'hex-thin' })
    await waitForStudioIdle()
    expect(getLayerResult('L1')?.strategy).toBe('hybrid')
    expect(getLayerResult('L2')?.strategy).toBe('hex-thin')

    const view = jointViewOf(getLayers())
    expect(view.gems.length).toBe((getLayerResult('L1')?.gems.length ?? 0) + (getLayerResult('L2')?.gems.length ?? 0))
    // 跨层全局重编号：id 唯一且连续（g00001…）
    const ids = view.gems.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('g00001')
    // 逐层规格物化（round SS10 层序 stamp——engine makeGem 源头恒 round，此处同值补全）
    for (const g of view.gems) {
      expect(g.shapeId).toBe('round')
      expect(g.diameterMm).toBeGreaterThan(0)
    }
    // 联合视图 = 各层 concat（单层断言已在 view.gems）
  })

  it('未触碰层缓存保留：仅标脏 L2 时 L1 entry 身份跨批不变（① 结果缓存 store 面）', async () => {
    await loadTwoLayers()
    const l1Before = getLayerResult('L1')
    dispatchLayerConfigOp(['L2'], { gapMm: 0.6 })
    await waitForStudioIdle()
    expect(getLayerResult('L1')).toBe(l1Before) // 未触碰层 entry 身份保留（不重算）
    expect(getLayerResult('L2')?.gems.length).toBeGreaterThanOrEqual(0)
    expect(getDirtyLayerIds()).toEqual([])
  })

  it('block.override 标脏所属层（覆写随层住——块密度只触发所属层重算）', async () => {
    await loadTwoLayers()
    const blocks = getBlocks()
    const moved = blocks.slice(0, 1)[0]!
    const restBlock = blocks.find((b) => b.id !== moved.id)!
    const l1Before = getLayerResult('L1')
    setBlockDensity(moved.id, 0.3, { immediate: true })
    await waitForStudioIdle()
    // moved 块属显式层 L2 → L1 缓存保留
    expect(getLayerResult('L1')).toBe(l1Before)

    const l2Before = getLayerResult('L2')
    setBlockDensity(restBlock.id, 0.3, { immediate: true })
    await waitForStudioIdle()
    expect(getLayerResult('L2')).toBe(l2Before) // rest 块属 L1 → L2 不动
    expect(getLayerResult('L1')?.gems.length).toBeLessThanOrEqual(l1Before!.gems.length)
  })

  it('cancelComputeQueue 作废在途批：迟到结果不落地、脏队列清空、既有结果保留', async () => {
    await loadTwoLayers()
    const l1Before = getLayerResult('L1')?.gems.length ?? 0
    const l2Before = getLayerResult('L2')?.gems.length ?? 0
    dispatchLayerConfigOp(['L1', 'L2'], { gapMm: 0.7 })
    cancelCompute()
    expect(getComputing()).toBe(false)
    expect(getComputeProgress()).toBeNull()
    expect(getDirtyLayerIds()).toEqual([])
    await waitForStudioIdle()
    // 取消只作废新轮——既有结果保留
    expect(getLayerResult('L1')?.gems.length).toBe(l1Before)
    expect(getLayerResult('L2')?.gems.length).toBe(l2Before)
  })

  it('undo（refold）差分重算：撤销 layer.config 只重算涉事层', async () => {
    await loadTwoLayers()
    const l1Before = getLayerResult('L1')
    dispatchLayerConfigOp(['L2'], { density: 0.5 }, 'layer-density:L2')
    await waitForStudioIdle()
    expect(getLayerById('L2')?.physics.density).toBe(0.5)
    const l2After = getLayerResult('L2')

    expect(undoStudioOp()).toBe(true)
    expect(getLayerById('L2')?.physics.density).toBe(1)
    await waitForStudioIdle()
    // L1 全程未被触碰：entry 身份跨 undo 保持
    expect(getLayerResult('L1')).toBe(l1Before)
    expect(getLayerResult('L2')).not.toBe(l2After) // 配置回退 → 重算落地新 entry
  })

  it('空层即时清零（无 worker 轮）：移出全部块后 entry 变空且不挂计算态', async () => {
    await loadTwoLayers()
    const blocks = getBlocks()
    const moved = blocks.slice(0, 1)[0]!
    // L2 唯一块移回兜底层 → L2 成空层
    dispatchStudioOp({ t: 'layer.moveBlocks', blockIds: [moved.id], toLayerId: 'L1' })
    recompute()
    await waitForStudioIdle()
    expect(getLayerById('L2')?.blockIds).toEqual([])
    expect(getLayerResult('L2')?.gems).toEqual([])
    expect(getComputing()).toBe(false)
  })
})

describe('improve 1.1 联合口径稳定序（拖动排序不改几何与 BOM 顺序）', () => {
  it('layer.reorder 后 joint 层序/编号恒按层 id 稳定序；面板序（getLayers）已变', async () => {
    await loadTwoLayers()
    const before = jointViewOf(getLayers())
    const gemsBefore = before.gems.map((g) => g.id)
    dispatchStudioOp({ t: 'layer.reorder', order: ['L2', 'L1'] })
    expect(getLayers().map((l) => l.id)).toEqual(['L2', 'L1']) // 视觉序已重排
    const after = jointViewOf(getLayers())
    expect(after.layers.map((l) => l.layerId)).toEqual(['L1', 'L2']) // 联合层序 = id 稳定序
    expect(after.gems.map((g) => g.id)).toEqual(gemsBefore) // 跨层编号不随重排漂移
    expect(after.gems.map((g) => g.blockId)).toEqual(before.gems.map((g) => g.blockId))
  })
})

describe('improve 3.2 继承开关计算语义（测试义务：继承块随父层变 / 独立块不随）', () => {
  it('独立块 = 合成计算单元：首次脱离摄父层快照，父层改配置不随（单元仍按快照计算）', async () => {
    await loadTwoLayers()
    const blockId = getLayerById('L2')?.blockIds?.[0] as string
    setBlockInherit(blockId, false, { immediate: true }) // 首次关闭 = 父层当前快照（hybrid / round-ss10）
    await waitForStudioIdle()
    const unitId = `L2#${blockId}`
    expect(getLayerResult(unitId)?.strategy).toBe('hybrid')
    expect(getLayerResult(unitId)?.gems.length ?? 0).toBeGreaterThan(0)
    // L2 唯一块已独立 → 父层批空（即时清零 entry）
    expect(getLayerResult('L2')?.gems).toEqual([])

    // 父层改策略/规格 → 独立块不随：单元仍按自身（快照）配置重算
    dispatchLayerConfigOp(['L2'], { strategy: 'hex-thin' })
    await waitForStudioIdle()
    expect(getLayerResult(unitId)?.strategy).toBe('hybrid') // 不随父层
    expect(getLayerResult(unitId)?.gems.length ?? 0).toBeGreaterThan(0)

    // 独立微调写配置 → 单元按新配置计算
    setBlockLayerConfig(blockId, { strategy: 'poisson', specKey: 'round-ss10' }, { immediate: true })
    await waitForStudioIdle()
    expect(getLayerResult(unitId)?.strategy).toBe('poisson')

    // 联合视图：单元钻并入所属层（joint 层序稳定 + 总钻数 = L1 + L2 独立单元）
    const view = jointViewOf(getLayers())
    expect(view.gems.length).toBe(
      (getLayerResult('L1')?.gems.length ?? 0) + (getLayerResult(unitId)?.gems.length ?? 0),
    )
    expect(view.layers.map((l) => l.layerId)).toEqual(['L1', 'L2'])
  })

  it('开关回继承：块随父层计算（休眠单元条目不再并入联合视图）；再脱离恢复休眠配置', async () => {
    await loadTwoLayers()
    const blockId = getLayerById('L2')?.blockIds?.[0] as string
    setBlockInherit(blockId, false, { immediate: true })
    setBlockLayerConfig(blockId, { strategy: 'poisson', specKey: 'round-ss10' }, { immediate: true })
    await waitForStudioIdle()
    expect(getLayerResult(`L2#${blockId}`)?.strategy).toBe('poisson')

    // 回继承 → 块按父层（hex-thin 前的默认 hybrid？——父层此刻仍默认 hybrid）计算并入父层批
    setBlockInherit(blockId, true, { immediate: true })
    dispatchLayerConfigOp(['L2'], { strategy: 'hex-thin' })
    await waitForStudioIdle()
    expect(getLayerResult('L2')?.strategy).toBe('hex-thin') // 继承块随父层变
    expect(getLayerResult('L2')?.gems.length ?? 0).toBeGreaterThan(0)
    const view = jointViewOf(getLayers())
    // 休眠单元条目在场但不读：联合总钻 = L1 + L2 父批（无单元重复计入）
    expect(view.gems.length).toBe(
      (getLayerResult('L1')?.gems.length ?? 0) + (getLayerResult('L2')?.gems.length ?? 0),
    )

    // 再脱离 → 恢复休眠 poisson（不重摄父层 hex-thin 快照）
    setBlockInherit(blockId, false, { immediate: true })
    await waitForStudioIdle()
    expect(getLayerResult(`L2#${blockId}`)?.strategy).toBe('poisson')
  })
})
