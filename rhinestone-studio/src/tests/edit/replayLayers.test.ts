/*
 * [2026-09-20 studio-layers 1.2] replay 层模型内核（lib/edit/replayLayers.ts）纯函数矩阵：
 * specKey 解析（builtin bootstrap 反解 / custom 注入目录四态 / typed 拒绝禁静默降级）、
 * rest 展开（分块结果 − 显式层并集）/ 显式 ∩ 当前块集 / 悬空覆写键逐层清点 /
 * 两级密度回落（恰 1 省略）/ per-layer grid（按层 specKey）/ pixelsPerMm 画幅锚。
 */

import { describe, expect, it } from 'vitest'
import { PIXELS_PER_MM, gridFromSs, type BaseSpec, type Block } from '$lib/engine'
import type { LayerRecord } from '$lib/persistence/projectFile'
import {
  resolveLayerPlans,
  resolveSpecForKey,
  SpecKeyResolveError,
  type CustomSpecResolver,
} from '$lib/edit/replayLayers'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function block(id: string, suggested: Block['suggested'] = 'fill'): Block {
  const w = 32
  const h = 16
  return {
    id,
    label: `测试块 ${id}`,
    mask: { w, h, bits: new Uint8Array(w * h).fill(1) },
    colorRgb: [200, 16, 46],
    areaPx: w * h,
    bbox: { x: 0, y: 0, w, h },
    widthPx: { max: 16, mean: 16 },
    suggested,
  }
}

const BLOCKS = [block('b1'), block('b2', 'linear'), block('b3'), block('b4')]

function layer(partial: Partial<LayerRecord> & Pick<LayerRecord, 'id'>): LayerRecord {
  return {
    name: `图层 ${partial.id}`,
    blockIds: 'rest',
    strategy: 'hybrid',
    physics: { specKey: 'round-ss10', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } },
    overrides: { disabled: {}, density: {}, type: {}, color: {} },
    ...partial,
  }
}

const CUSTOM_SPEC: BaseSpec = {
  shapeId: 'custom',
  sizeLabel: '自定义星形',
  diameterMm: 4.2,
  widthMm: 3.1,
  heightMm: 4.2,
  assetId: 'ast-x1',
}

// ---------------------------------------------------------------------------
// specKey 解析
// ---------------------------------------------------------------------------

describe('1.2 resolveSpecForKey', () => {
  it('builtin round-ssXX：bootstrap 查表直径（含 SS24 补档）', async () => {
    expect(await resolveSpecForKey('round-ss10')).toEqual({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 })
    expect(await resolveSpecForKey('round-ss24')).toEqual({ shapeId: 'round', sizeLabel: 'SS24', diameterMm: 5.3 })
  })

  it('builtin 非圆四形：builtinSpecKey 规则逆推（sizeLabel 还原 <token>mm）', async () => {
    expect(await resolveSpecForKey('square-3.5')).toEqual({ shapeId: 'square', sizeLabel: '3.5mm', diameterMm: 3.5 })
    expect(await resolveSpecForKey('marquise-5')).toEqual({ shapeId: 'marquise', sizeLabel: '5mm', diameterMm: 5 })
    expect(await resolveSpecForKey('heart-4.5')).toEqual({ shapeId: 'heart', sizeLabel: '4.5mm', diameterMm: 4.5 })
  })

  it('builtin 非法形态：typed 拒绝（非档位 SS / 非数值 token / 未知前缀）', async () => {
    for (const key of ['round-ss99', 'round-ss', 'square-abc', 'weird-key', 'round-SS10x']) {
      await expect(resolveSpecForKey(key), key).rejects.toThrowError(SpecKeyResolveError)
    }
    await expect(resolveSpecForKey('round-ss99')).rejects.toMatchObject({
      reason: 'invalid-builtin',
      specKey: 'round-ss99',
    })
  })

  it('custom：注入 resolver resolved → BaseSpec（含 assetId/宽高透传）', async () => {
    const resolver: CustomSpecResolver = async () => ({ state: 'resolved', spec: CUSTOM_SPEC })
    expect(await resolveSpecForKey('custom-ast-x1', resolver)).toEqual(CUSTOM_SPEC)
  })

  it('custom missing 四态：typed 拒绝携带 state（soft-deleted/blob-missing/wrong-kind/not-found）——禁静默降级圆钻', async () => {
    for (const state of ['soft-deleted', 'blob-missing', 'wrong-kind', null] as const) {
      const resolver: CustomSpecResolver = async () => ({ state })
      const error = await resolveSpecForKey('custom-ast-x1', resolver).catch((e) => e)
      expect(error).toBeInstanceOf(SpecKeyResolveError)
      expect(error.reason).toBe('custom-missing')
      expect(error.state).toBe(state)
      expect(error.message).toContain('不回退圆钻')
    }
  })

  it('custom resolver 缺席 / 空 assetId：typed 拒绝（显式 missing，不猜）', async () => {
    await expect(resolveSpecForKey('custom-ast-x1')).rejects.toThrowError(SpecKeyResolveError)
    await expect(resolveSpecForKey('custom-', async () => ({ state: 'resolved', spec: CUSTOM_SPEC }))).rejects.toThrowError(
      SpecKeyResolveError,
    )
  })
})

// ---------------------------------------------------------------------------
// 层成员解析 + 每层派生
// ---------------------------------------------------------------------------

describe('1.2 resolveLayerPlans', () => {
  it('rest 展开：分块结果 − 显式层并集；显式层 = blockIds ∩ 当前块集（未知键不拒收、空层保留）', async () => {
    const layers = [
      layer({ id: 'L1', blockIds: ['b1', 'b2'] }),
      layer({ id: 'L2', blockIds: ['b3', 'ghost-9'] }), // ghost-9 不在块集 → 空补不炸
      layer({ id: 'L-rest' }),
    ]
    const out = await resolveLayerPlans(layers, BLOCKS, 96, undefined)
    expect(out.layers[0]?.memberBlocks.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(out.layers[1]?.memberBlocks.map((b) => b.id)).toEqual(['b3']) // 未知键静默零块（成员面）
    expect(out.layers[2]?.memberBlocks.map((b) => b.id)).toEqual(['b4']) // rest = 剩余
    expect(out.restLayerIndex).toBe(2)
  })

  it('悬空覆写键逐层清点：四表键不在当前块集 → 该层计数（v1 全局清点的层级化）', async () => {
    const layers = [
      layer({
        id: 'L1',
        blockIds: ['b1'],
        overrides: { disabled: { 'ghost-a': true }, density: {}, type: {}, color: { b2: 'c1' } }, // ghost-a 悬空；b2 非本层块但在块集 → 不计
      }),
      layer({
        id: 'L-rest',
        overrides: { disabled: {}, density: { 'ghost-b': 0.5, 'ghost-c': 0.5 }, type: {}, color: {} },
      }),
    ]
    const out = await resolveLayerPlans(layers, BLOCKS, 96, undefined)
    expect(out.droppedOverridesByLayer).toEqual({ L1: 1, 'L-rest': 2 })
  })

  it('effectiveBlocks：disabled 过滤 + type 覆写（覆写 === suggested 时零拷贝透传）', async () => {
    const layers = [
      layer({
        id: 'L-rest',
        overrides: {
          disabled: { b2: true },
          density: {},
          type: { b1: 'linear', b3: 'fill' }, // b1 改写生效；b3 === suggested 零变化
          color: {},
        },
      }),
    ]
    const out = await resolveLayerPlans(layers, BLOCKS, 96, undefined)
    const effective = out.layers[0]?.effectiveBlocks
    expect(effective?.map((b) => b.id)).toEqual(['b1', 'b3', 'b4'])
    expect(effective?.[0]?.suggested).toBe('linear')
    expect(effective?.[1]).toBe(BLOCKS[2]) // 零拷贝透传（同引用）
  })

  it('两级密度回落：块覆写 ?? 层 density；恰为 1 的键省略（含显式覆写 1.0）', async () => {
    const layers = [
      layer({
        id: 'L-rest',
        physics: { specKey: 'round-ss10', gapMm: 0.4, density: 0.5, relax: { boundary: false, repulsion: false } },
        overrides: { disabled: {}, density: { b1: 0.8, b2: 1 }, type: {}, color: {} },
      }),
    ]
    const out = await resolveLayerPlans(layers, BLOCKS, 96, undefined)
    expect(out.layers[0]?.density).toEqual({ b1: 0.8, b3: 0.5, b4: 0.5 }) // b2 覆写 1 省略（引擎缺省 1.0）
  })

  it('per-layer grid：按层 specKey 派生（异 spec/异 gap → 异 pitch；gridFromSs 特例退役）', async () => {
    const layers = [
      layer({ id: 'L1', blockIds: ['b1'], physics: { specKey: 'round-ss10', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } } }),
      layer({
        id: 'L2',
        blockIds: ['b2'],
        physics: { specKey: 'round-ss20', gapMm: 0.6, density: 1, relax: { boundary: false, repulsion: false } },
      }),
      layer({ id: 'L-rest', physics: { specKey: 'square-3.5', gapMm: 0.5, density: 1, relax: { boundary: false, repulsion: false } } }),
    ]
    const out = await resolveLayerPlans(layers, BLOCKS, 96, undefined)
    // 与 gridFromSs 构造式逐字段相等（浮点加法同式：SS_TABLE.SS10 + 0.4——降位特例退役的等价证明）
    expect(out.layers[0]?.grid).toEqual(gridFromSs('SS10', 2.5, 0.4))
    expect(out.layers[1]?.grid).toEqual(gridFromSs('SS20', 2.5, 0.6))
    expect(out.layers[2]?.grid).toEqual({ pitchMm: 3.5 + 0.5, gapMm: 0.5, rowAngleDeg: 0, pixelsPerMm: 2.5 }) // square 3.5+0.5
    expect(out.layers[0]?.grid.pitchMm).not.toBe(out.layers[1]?.grid.pitchMm)
  })

  it('pixelsPerMm 画幅锚：declared → canvas 宽 ÷ widthMm；缺席 → default 2.5 显式', async () => {
    const declared = { widthMm: 192, heightMm: 128, anchorSource: 'declared' as const }
    const anchored = await resolveLayerPlans([layer({ id: 'L-rest' })], BLOCKS, 960, declared)
    expect(anchored.pixelsPerMm).toBe(5)
    expect(anchored.layers[0]?.grid.pixelsPerMm).toBe(5)
    const fallback = await resolveLayerPlans([layer({ id: 'L-rest' })], BLOCKS, 960, undefined)
    expect(fallback.pixelsPerMm).toBe(PIXELS_PER_MM)
  })

  it('specKey 不可解析上浮：任一层 custom missing → 整次解析 typed 失败', async () => {
    const layers = [layer({ id: 'L1', blockIds: ['b1'], physics: { specKey: 'custom-ast-gone', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } } }), layer({ id: 'L-rest' })]
    const resolver: CustomSpecResolver = async () => ({ state: 'blob-missing' })
    const error = await resolveLayerPlans(layers, BLOCKS, 96, undefined, resolver).catch((e) => e)
    expect(error).toBeInstanceOf(SpecKeyResolveError)
    expect(error.state).toBe('blob-missing')
  })
})
