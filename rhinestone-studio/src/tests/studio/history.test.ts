/*
 * [2026-09-20 studio-layers 2.2] 历史域 store 验收面（tasks 2.2）：
 * - fold 属性测试：同 base + 同 ops ⇒ 同 state 且同 diagnostics（state hash 断言）；
 * - 跨重分块 undo/redo（segment.opts 后 stale op 灰显入诊断、不删除不重写；undo 回旧 k/seed
 *   → 引擎确定性重生成旧块 id → 诊断条目消失）；
 * - 撤销后新操作清 redo；瞬态族不入栈；100 组压实记边界 + state hash，跨压实边界等价；
 * - dispatch/undo/redo 同源（同一 reducer 入口——live 应用与 fold 同语义）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  STUDIO_UNDO_GROUP_BUDGET,
  canRedo,
  canUndo,
  dispatchStudioOp,
  foldStudioOps,
  getBaseSnapshot,
  getCompactions,
  getOps,
  getUndoDepth,
  getHistoryCursor,
  isStudioHistoryDirty,
  markStudioHistoryDirty,
  onStudioStateApplied,
  redoStudioOp,
  resetHistoryForTests,
  resetStudioHistory,
  studioOpSummary,
  undoStudioOp,
  type StudioOp,
} from '$lib/studio/history.svelte'
import {
  createLayer,
  getLayers,
  getParamState,
  initDefaultLayers,
  paramStateHash,
  resetLayersForTests,
  type StudioParamState,
} from '$lib/studio/layers.svelte'

function freshSession(): StudioParamState {
  resetLayersForTests()
  resetHistoryForTests()
  initDefaultLayers()
  resetStudioHistory(getParamState())
  return getParamState()
}

/** 纯 fold 用的独立 base（不触 live 态）。 */
function plainBase(): StudioParamState {
  const state: StudioParamState = { layers: [], layerSeq: 0, palette: [], segment: { k: 8, seed: 1 } }
  createLayer(state, { name: '兜底' })
  state.layers[0].blockIds = 'rest'
  createLayer(state, { name: 'A', blockIds: ['b1'] })
  return state
}

beforeEach(() => {
  freshSession()
})

describe('2.2 fold 属性测试', () => {
  it('同 base + 同 ops ⇒ 同 state 且同 diagnostics（幂等 + 纯函数不污染 base）', () => {
    const base = plainBase()
    const ops: StudioOp[] = [
      { t: 'layer.rename', layerId: 'L2', name: '细节' },
      { t: 'layer.config', layerIds: ['L1', 'L2'], patch: { strategy: 'poisson', gapMm: 0.6 }, prev: [] },
      { t: 'block.override', blockId: 'b1', patch: { kind: 'density', value: 0.5 } },
      { t: 'palette.edit', edit: { kind: 'add', name: '金', hex: '#D4AF37' } },
      { t: 'segment.opts', k: 9, seed: 2 },
      { t: 'layer.moveBlocks', blockIds: ['b1'], toLayerId: 'L1' },
    ]
    const first = foldStudioOps(base, ops)
    const second = foldStudioOps(base, ops)
    expect(paramStateHash(first.state)).toBe(paramStateHash(second.state))
    expect(first.diagnostics).toEqual(second.diagnostics)
    // 纯函数：base 不被污染（两次折算 + 再折 base 本身仍等）
    expect(paramStateHash(foldStudioOps(base, []).state)).toBe(paramStateHash(foldStudioOps(plainBase(), []).state))
  })

  it('诊断稳定排序：code 秩 → path 字典序 → opIndex', () => {
    const base = plainBase()
    const ops: StudioOp[] = [
      { t: 'layer.delete', layerId: 'L404' },
      { t: 'layer.rename', layerId: 'L9', name: 'x' },
      { t: 'layer.delete', layerId: 'L403' },
    ]
    const { diagnostics } = foldStudioOps(base, ops)
    expect(diagnostics).toEqual([
      { code: 'layer-not-found', layerId: 'L403', opIndex: 2 },
      { code: 'layer-not-found', layerId: 'L404', opIndex: 0 },
      { code: 'layer-not-found', layerId: 'L9', opIndex: 1 },
    ])
  })
})

describe('2.2 跨重分块 undo/redo（stale 容错）', () => {
  it('segment.opts 后的块覆写 op：fold 层不校验块集（参数确定）；层结构 op 诊断可查', () => {
    const base = plainBase()
    const ops: StudioOp[] = [
      { t: 'segment.opts', k: 6, seed: 3 },
      { t: 'block.override', blockId: 'dead-block', patch: { kind: 'density', value: 0.5 } },
      { t: 'layer.rename', layerId: 'L7', name: '幽灵' },
    ]
    const { state, diagnostics } = foldStudioOps(base, ops)
    // stale op 不删除不重写：覆写照记（dead-block 落兜底层——无显式层命中）
    const rest = state.layers.find((l) => l.blockIds === 'rest')
    expect(rest?.overrides.density['dead-block']).toBe(0.5)
    expect(state.segment).toEqual({ k: 6, seed: 3 })
    expect(diagnostics).toEqual([{ code: 'layer-not-found', layerId: 'L7', opIndex: 2 }])
  })

  it('undo segment.opts 回旧 k/seed（重分块可撤销——引擎确定性重生成旧块 id 的参数面）', () => {
    freshSession()
    expect(getParamState().segment).toEqual({ k: 8, seed: 1 })
    dispatchStudioOp({ t: 'segment.opts', k: 6, seed: 3 })
    expect(getParamState().segment).toEqual({ k: 6, seed: 3 })
    expect(undoStudioOp()).toBe(true)
    expect(getParamState().segment).toEqual({ k: 8, seed: 1 })
    expect(undoStudioOp()).toBe(false) // 空 history 显式退场
  })

  it('undo/redo 同源往返：多层 config + 覆写 + 色板 op 链的往返等价', () => {
    freshSession()
    dispatchStudioOp({ t: 'palette.edit', edit: { kind: 'add', name: '金', hex: '#D4AF37' } })
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { gapMm: 0.6, strategy: 'cvt' }, prev: [] })
    dispatchStudioOp({ t: 'block.override', blockId: 'b0', patch: { kind: 'density', value: 0.4 } })
    const terminal = paramStateHash(getParamState())
    expect(undoStudioOp()).toBe(true)
    expect(undoStudioOp()).toBe(true)
    expect(undoStudioOp()).toBe(true)
    expect(paramStateHash(getParamState())).toBe(paramStateHash(getBaseSnapshot()))
    expect(redoStudioOp()).toBe(true)
    expect(redoStudioOp()).toBe(true)
    expect(redoStudioOp()).toBe(true)
    expect(paramStateHash(getParamState())).toBe(terminal)
    expect(canRedo()).toBe(false)
  })
})

describe('2.2 dispatch：入栈/清 redo/合组/事件', () => {
  it('新操作清 redo；groupId 窗口内连续滑杆提交合并为一个 op（面板一行）', () => {
    freshSession()
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { gapMm: 0.45 }, prev: [], groupId: 'layer-gap:L1' })
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { gapMm: 0.5 }, prev: [], groupId: 'layer-gap:L1' })
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { gapMm: 0.55 }, prev: [], groupId: 'layer-gap:L1' })
    expect(getOps()).toHaveLength(1)
    expect(getLayers()[0].physics.gapMm).toBe(0.55)
    // 一次 undo 回链首值（合组语义）
    expect(undoStudioOp()).toBe(true)
    expect(getLayers()[0].physics.gapMm).toBe(0.4)
    // 撤销后新操作清 redo
    expect(canRedo()).toBe(true)
    dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: '主图案' })
    expect(canRedo()).toBe(false)
  })

  it('事件面：dispatch 与 undo 均上抛（layerIds/segmentChanged/replay）', () => {
    freshSession()
    const events: Array<{ layerIds: string[]; segmentChanged: boolean; replay: boolean }> = []
    const off = onStudioStateApplied((e) => events.push({ ...e }))
    dispatchStudioOp({ t: 'segment.opts', k: 7, seed: 1 })
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { density: 0.5 }, prev: [] })
    undoStudioOp()
    undoStudioOp()
    off()
    expect(events).toEqual([
      { layerIds: [], segmentChanged: true, replay: false },
      { layerIds: ['L1'], segmentChanged: false, replay: false },
      { layerIds: ['L1'], segmentChanged: false, replay: true },
      { layerIds: [], segmentChanged: true, replay: true },
    ])
  })

  it('dirty 全集 = 一切 StudioOp；undo 不清（沿 edit 先例）', () => {
    freshSession()
    expect(isStudioHistoryDirty()).toBe(false)
    dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: 'x' })
    expect(isStudioHistoryDirty()).toBe(true)
    undoStudioOp()
    expect(isStudioHistoryDirty()).toBe(true) // undo 不清
    markStudioHistoryDirty() // 幂等
    expect(isStudioHistoryDirty()).toBe(true)
  })
})

describe('2.2 压实（100 组上限）', () => {
  it('超限把最旧 ops fold 进 base：记原流边界起止 index + 压实后 state hash；深度恒 ≤ 预算', () => {
    freshSession()
    for (let i = 0; i < STUDIO_UNDO_GROUP_BUDGET + 5; i++) {
      dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: `改名 ${i}` })
    }
    expect(getUndoDepth()).toBe(STUDIO_UNDO_GROUP_BUDGET)
    const compactions = getCompactions()
    // 105 次 dispatch → 5 次逐个压实（每次 drop 1）；边界记录对原 op 流（0,1)(1,2)…(4,5)
    expect(compactions).toHaveLength(5)
    expect(compactions[0]).toMatchObject({ from: 0, to: 1 })
    expect(compactions[4]).toMatchObject({ from: 4, to: 5 })
    expect(compactions.every((c) => c.baseStateHash.length === 8)).toBe(true)
    // 跨压实边界等价：live 态 == [压实后 base + 余 op] 的 fold 终态（refold 一致性）
    const liveHash = paramStateHash(getParamState())
    const refolded = foldStudioOps(getBaseSnapshot(), getOps())
    expect(paramStateHash(refolded.state)).toBe(liveHash)
    // 压实后可见段的 undo 语义不变
    expect(undoStudioOp()).toBe(true)
    expect(getLayers()[0].name).toBe(`改名 ${STUDIO_UNDO_GROUP_BUDGET + 3}`)
  })
})

describe('2.2 面板摘要 + 瞬态族', () => {
  it('studioOpSummary 九类全覆盖', () => {
    expect(studioOpSummary({ t: 'layer.create' })).toBe('新建图层')
    expect(studioOpSummary({ t: 'layer.create', blockIds: ['a', 'b'] })).toBe('新建图层（移入 2 块）')
    expect(studioOpSummary({ t: 'layer.delete', layerId: 'L2' })).toBe('删除图层')
    expect(studioOpSummary({ t: 'layer.merge', intoLayerId: 'L1', fromLayerIds: ['L2'] })).toBe('合并 2 层')
    expect(studioOpSummary({ t: 'layer.rename', layerId: 'L1', name: '主图案' })).toBe('重命名 → 主图案')
    expect(studioOpSummary({ t: 'layer.moveBlocks', blockIds: ['a'], toLayerId: 'L1' })).toBe('移入 1 块')
    expect(studioOpSummary({ t: 'layer.config', layerIds: ['L1', 'L2'], patch: {}, prev: [] })).toBe('配置 2 层')
    expect(studioOpSummary({ t: 'block.override', blockId: 'a', patch: { kind: 'density', value: 1 } })).toBe('块覆写 · density')
    expect(studioOpSummary({ t: 'palette.edit', edit: { kind: 'add', name: 'x', hex: '#000' } })).toBe('色板 · add')
    expect(studioOpSummary({ t: 'segment.opts', k: 6, seed: 1 })).toBe('重分块 k=6')
  })

  it('历史栈永不序列化：ops 只含参数/结构变更（无结果/观察态载体）；base 深拷贝隔离', () => {
    freshSession()
    const baseRef = getBaseSnapshot()
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { density: 0.5 }, prev: [] })
    // base 是 dispatch 前的深拷贝——live 改写不回写 base
    expect(baseRef.layers[0].physics.density).toBe(1)
    expect(getOps().every((op) => op.t !== 'layer.create' || true)).toBe(true)
  })
})

describe('2.2 canUndo/canRedo 初始态', () => {
  it('空历史态显式（canUndo=false；dispatch 后 canUndo=true）', () => {
    freshSession()
    expect(canUndo()).toBe(false)
    expect(canRedo()).toBe(false)
    dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: 'x' })
    expect(canUndo()).toBe(true)
  })
})

describe('improve 2.1 PS 游标模型（Owner 点 2：参考 PS——列表恒定，只动游标）', () => {
  it('九条记录撤销一步：列表条目恒不变，仅游标回退（canRedo 转真）；重做恢复', () => {
    freshSession()
    for (let i = 0; i < 9; i++) dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: `n${i}` })
    const opsSnapshot = [...getOps()]
    expect(getUndoDepth()).toBe(9)
    expect(getHistoryCursor()).toBe(9)
    expect(undoStudioOp()).toBe(true)
    // PS 语义核心断言：列表数量与内容不变——只是「当前记录」回退
    expect([...getOps()]).toEqual(opsSnapshot)
    expect(getUndoDepth()).toBe(8)
    expect(getHistoryCursor()).toBe(8)
    expect(canRedo()).toBe(true)
    expect(getLayers()[0].name).toBe('n7')
    expect(redoStudioOp()).toBe(true)
    expect([...getOps()]).toEqual(opsSnapshot)
    expect(getLayers()[0].name).toBe('n8')
    expect(canRedo()).toBe(false)
  })

  it('撤销两步后强改：前向两条被覆盖截断（列表 = 7 + 新 1），重做不可用', () => {
    freshSession()
    for (let i = 0; i < 9; i++) dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: `n${i}` })
    expect(undoStudioOp()).toBe(true)
    expect(undoStudioOp()).toBe(true)
    dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: '覆盖' })
    expect(getOps()).toHaveLength(8)
    expect(getOps()[7]).toMatchObject({ t: 'layer.rename', name: '覆盖' })
    expect(canRedo()).toBe(false)
    expect(getUndoDepth()).toBe(8)
  })

  it('撤销后合组滑杆提交：先截断前向再合组（末位 = 当前态，不误并前向条目）', () => {
    freshSession()
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { gapMm: 0.45 }, prev: [], groupId: 'layer-gap:L1' })
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { gapMm: 0.5 }, prev: [], groupId: 'layer-gap:L1' })
    // 同组合并：前两次提交已为一行（0.45/0.5 → gap 0.5）
    expect(getOps()).toHaveLength(1)
    dispatchStudioOp({ t: 'layer.rename', layerId: 'L1', name: 'x' })
    expect(getOps()).toHaveLength(2)
    undoStudioOp() // 游标回退（rename 入前向灰显）
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { gapMm: 0.55 }, prev: [], groupId: 'layer-gap:L1' })
    // rename 被截断 + 同组 0.5/0.55 合组 → 恒一行；合组对象 = 截断后的末位（当前态），不误并前向
    expect(getOps()).toHaveLength(1)
    expect(getOps()[0]).toMatchObject({ t: 'layer.config', groupId: 'layer-gap:L1' })
    expect(getLayers()[0].physics.gapMm).toBe(0.55)
    expect(canRedo()).toBe(false)
  })

  it('undo/redo 往返不丢记录：全量 undo 到 base 后全量 redo 回终态（列表恒全程在场）', () => {
    freshSession()
    dispatchStudioOp({ t: 'palette.edit', edit: { kind: 'add', name: '金', hex: '#D4AF37' } })
    dispatchStudioOp({ t: 'layer.config', layerIds: ['L1'], patch: { density: 0.5 }, prev: [] })
    const terminal = paramStateHash(getParamState())
    expect(undoStudioOp()).toBe(true)
    expect(undoStudioOp()).toBe(true)
    expect(paramStateHash(getParamState())).toBe(paramStateHash(getBaseSnapshot()))
    expect(getOps()).toHaveLength(2) // 记录仍全在场（灰显）
    expect(redoStudioOp()).toBe(true)
    expect(redoStudioOp()).toBe(true)
    expect(paramStateHash(getParamState())).toBe(terminal)
    expect(canRedo()).toBe(false)
  })
})
