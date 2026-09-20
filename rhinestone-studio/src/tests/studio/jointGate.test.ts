/*
 * [2026-09-20 studio-layers 1.3] 联合 pairwise + exportGate 消费接线（lib/studio/jointGate.ts）：
 * 全层 concat → engine exportGate（判据/门 = engine 已证；本面 = 层序组织与分组聚合）。
 *
 * 八源碰撞清单（R1·议题 9 原文逐条用例）：
 * ① 相邻块边界两层钻各贴共同边界；② 各层独立 layout 层间无协调；③ 不同径 gap
 * （层 A 大钻层 B 小钻所需中心距不同——逐对判据）；④ boundary-repulsion 位移把钻推出
 * 掩码边界；⑤ 重分块归属变化（旧块引用悬空）；⑥ 设计师工作台改层/改径/改形后回流的 gemdoc；
 * ⑦ malformed import / 重复块（parser 分区拒绝面之外的第二道防线——引用/几何面）；
 * ⑧ 未来手工钻（blockId=null 的 mask 豁免 + spacing 照查 + custom missing-asset 硬阻断）。
 * 另证：隐藏层仍参与 concat、违规硬阻断（ok=false）、分组确定性、gap 保守取参与层最大。
 *
 * 判距基准（pixelsPerMm=2.5、gap=0.4）：2.8mm 对 = (2.8+0.4)×2.5 = 8px（×0.999 = 7.992）；
 * 4.8/2.8 混对 = (3.8+0.4)×2.5 = 10.5px；设计师 6.4/2.8 = (4.6+0.4)×2.5 = 12.5px。
 */

import { describe, expect, it } from 'vitest'
import type { Block, GateGem } from '$lib/engine'
import { jointExportGate, type JointGateLayer } from '$lib/studio/jointGate'

function fullBlock(id: string, x: number, w = 32, h = 16): Block {
  return {
    id,
    label: `测试块 ${id}`,
    mask: { w, h, bits: new Uint8Array(w * h).fill(1) },
    colorRgb: [200, 16, 46],
    areaPx: w * h,
    bbox: { x, y: 0, w, h },
    widthPx: { max: 16, mean: 16 },
    suggested: 'fill',
  }
}

function gem(id: string, x: number, y: number, blockId: string | null, diameterMm = 2.8, extra: Partial<GateGem> = {}): GateGem {
  return { id, x, y, blockId, shapeId: 'round', diameterMm, ...extra }
}

function layer(layerId: string, layerName: string, gems: GateGem[], gapMm = 0.4, visible = true): JointGateLayer {
  return { layerId, layerName, gapMm, gems, visible }
}

const PPM = 2.5
const B1 = fullBlock('b1', 0)
const B2 = fullBlock('b2', 32)

describe('1.3 jointExportGate：八源碰撞清单逐条', () => {
  it('① 相邻块边界：两层钻各贴共同边界（几何上各自掩码内合法，联合 < 7.992px → inter 违规）', () => {
    const alone = (gems: GateGem[]) => jointExportGate([layer('A', '图层 A', gems)], { pixelsPerMm: PPM, blocks: [B1, B2] })
    const aGems = [gem('a1', 31, 8, 'b1')] // 贴 b1 右缘
    const bGems = [gem('b1', 33, 8, 'b2')] // 贴 b2 左缘（相距 2px）
    expect(alone(aGems).verdict.ok).toBe(true)
    expect(alone(bGems).verdict.ok).toBe(true)
    const joint = jointExportGate([layer('A', '图层 A', aGems), layer('B', '图层 B', bGems)], { pixelsPerMm: PPM, blocks: [B1, B2] })
    expect(joint.verdict.ok).toBe(false)
    expect(joint.verdict.violations).toHaveLength(1)
    expect(joint.verdict.violations[0]?.kind).toBe('spacing')
    expect(joint.groups).toHaveLength(1)
    expect(joint.groups[0]?.scope).toBe('inter')
    expect(joint.groups[0]?.layerIds).toEqual(['A', 'B'])
    expect(joint.groups[0]?.layerNames).toEqual(['图层 A', '图层 B'])
  })

  it('② 各层独立 layout 层间无协调：同块双布局交错 4px → inter 违规（层内各自合法）', () => {
    const joint = jointExportGate(
      [
        layer('A', '图层 A', [gem('a1', 4, 8, 'b1')]),
        layer('B', '图层 B', [gem('b1', 8, 8, 'b1')]), // 与 a1 相距 4px
      ],
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(joint.verdict.ok).toBe(false)
    expect(joint.groups[0]).toMatchObject({ scope: 'inter', layerIds: ['A', 'B'] })
  })

  it('③ 不同径 gap：大/小径混对判据由两钻径共同决定（9px 小对合法、混对 10.49px 违规）', () => {
    const joint = jointExportGate(
      [
        layer('A', '图层 A', [gem('a1', 4, 8, 'b1', 4.8)]), // 大钻
        layer('B', '图层 B', [gem('b1', 13, 8, 'b1', 2.8), gem('b2', 22, 8, 'b1', 2.8)]), // 9px 小对合法
      ],
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(joint.verdict.ok).toBe(false)
    const spacing = joint.verdict.violations.find((v) => v.kind === 'spacing')
    expect(spacing?.gemIds).toEqual(['a1', 'b1'])
    expect(spacing?.detail).toContain('10.49') // (3.8+0.4)×2.5×0.999
  })

  it('④ boundary-repulsion 位移：钻被推出所属块掩码 → mask 违规（层内 intra）', () => {
    const joint = jointExportGate(
      [layer('A', '图层 A', [gem('a1', 40, 8, 'b1')])], // b1 掩码只覆盖 x 0..31——位移越界
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(joint.verdict.ok).toBe(false)
    expect(joint.verdict.violations[0]?.kind).toBe('mask')
    expect(joint.groups[0]).toMatchObject({ scope: 'intra', layerIds: ['A'] })
  })

  it('⑤ 重分块归属变化：钻引用新块集外的旧块 id → mask 违规「引用不存在的块」（第二道防线）', () => {
    const joint = jointExportGate(
      [layer('A', '图层 A', [gem('a1', 4, 8, 'old-b9')])],
      { pixelsPerMm: PPM, blocks: [B1, B2] }, // 重分块后块集不含 old-b9
    )
    expect(joint.verdict.ok).toBe(false)
    expect(joint.verdict.violations[0]?.kind).toBe('mask')
    expect(joint.verdict.violations[0]?.detail).toContain('old-b9')
  })

  it('⑥ 设计师回流：改径后（2.8 → 6.4mm）原合法间距变违规；blockId=null 手工豁免 mask 面', () => {
    const joint = jointExportGate(
      [layer('E', '设计师层', [gem('e1', 4, 8, null, 6.4), gem('g1', 13, 8, 'b1', 2.8)])], // 9px：2.8 对合法、6.4 混对需 12.49px
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(joint.verdict.ok).toBe(false)
    const spacing = joint.verdict.violations.find((v) => v.kind === 'spacing')
    expect(spacing?.gemIds).toEqual(['e1', 'g1'])
    expect(joint.verdict.violations.some((v) => v.kind === 'mask')).toBe(false) // e1 blockId=null → mask 面跳过
  })

  it('⑦ malformed import：重复钻 id 双层重复入列 → 零距 spacing 违规（多归属显式可判、分组确定）', () => {
    const duplicated = gem('x1', 4, 8, 'b1')
    const joint = jointExportGate(
      [layer('A', '图层 A', [duplicated]), layer('B', '图层 B', [gem('x1', 4, 8, 'b1')])],
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(joint.verdict.ok).toBe(false)
    expect(joint.verdict.violations[0]?.kind).toBe('spacing')
    expect(joint.gemLayer.get('x1')).toEqual(['A', 'B']) // 重复 id 跨层 = 多归属（显式可判态）
  })

  it('⑧ 未来手工钻：blockId=null 参与 spacing 判据；custom missing-asset → 硬阻断', () => {
    const manual = jointExportGate(
      [layer('A', '图层 A', [gem('m-1', 4, 8, null), gem('g1', 9, 8, 'b1')])], // 5px → 违规（手工钻照查）
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(manual.verdict.ok).toBe(false)
    expect(manual.verdict.violations[0]?.gemIds).toEqual(['m-1', 'g1'])

    const customMissing = jointExportGate(
      [layer('A', '图层 A', [gem('c1', 4, 8, 'b1', 3.5, { shapeId: 'custom', assetId: 'ast-gone' })])],
      { pixelsPerMm: PPM, resolveShapeAsset: () => null },
    )
    expect(customMissing.verdict.ok).toBe(false)
    expect(customMissing.verdict.violations[0]?.kind).toBe('missing-asset')
  })
})

describe('1.3 jointExportGate：层序组织语义', () => {
  it('隐藏层仍参与 concat（隐藏 ≠ 排除——观察态不影响门）', () => {
    const joint = jointExportGate(
      [layer('A', '图层 A', [gem('a1', 4, 8, 'b1')]), layer('B', '隐藏层', [gem('b1', 8, 8, 'b1')], 0.4, false)],
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(joint.verdict.ok).toBe(false)
    expect(joint.groups[0]?.layerIds).toEqual(['A', 'B'])
  })

  it('违规硬阻断信号：任一违规 → verdict.ok=false（导出四路共同前置；保存不消费本门）', () => {
    const clean = jointExportGate(
      [layer('A', '图层 A', [gem('a1', 4, 8, 'b1'), gem('a2', 13, 8, 'b1')])],
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(clean.verdict.ok).toBe(true)
    expect(clean.groups).toEqual([])
    const dirty = jointExportGate(
      [layer('A', '图层 A', [gem('a1', 4, 8, 'b1'), gem('a2', 9, 8, 'b1')])],
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(dirty.verdict.ok).toBe(false)
  })

  it('gap 保守取参与层最大：层 A gap0.4 / 层 B gap0.8 → 联合判距 9px（8.5px 在 0.4 下会漏报）', () => {
    const joint = jointExportGate(
      [layer('A', '图层 A', [gem('a1', 4, 8, 'b1')], 0.4), layer('B', '图层 B', [gem('b1', 12.5, 8, 'b1')], 0.8)],
      { pixelsPerMm: PPM, blocks: [B1] },
    )
    expect(joint.verdict.ok).toBe(false) // 8.5px < (2.8+0.8)×2.5×0.999 = 8.991
    expect(joint.verdict.violations[0]?.detail).toContain('8.99')
  })

  it('层内对按本层 gap 判距：小 gap 层自身合法布局不因他层大 gap 被误报（逐对 gap = max(所属层)）', () => {
    // ppm=1（mm 即 px）：层 A gap 0.4 两钻 4px ≥ (2.8+0.4)=3.2 对本层契约合法；
    // 层 B gap 0.8 单钻远置（60,8）——joint 0.8 判距不回灌层内对
    const small = layer('A', '小间距层', [gem('a1', 4, 8, 'b1', 2.8), gem('a2', 8, 8, 'b1', 2.8)], 0.4)
    const bigGap = layer('B', '大间距层', [gem('b1', 60, 8, 'b2', 2.8)], 0.8)
    const joint = jointExportGate([small, bigGap], { pixelsPerMm: 1, blocks: [B1, B2] })
    expect(joint.verdict.ok).toBe(true)
    // 反证：同样 3.4px 的**层间**对在 joint 0.8 判距下违规（(2.8+2.8)/2+0.8 = 3.6px）
    const inter = jointExportGate(
      [layer('A', '小间距层', [gem('a1', 4, 8, 'b1', 2.8)], 0.4), layer('B', '大间距层', [gem('b1', 7.4, 8, 'b2', 2.8)], 0.8)],
      { pixelsPerMm: 1, blocks: [B1, B2] },
    )
    expect(inter.verdict.ok).toBe(false) // 3.4px < 3.6px（joint max-gap 判距）
    expect(inter.groups[0]?.scope).toBe('inter')
  })

  it('分组确定性：同输入两次运行 verdict/groups 逐位相等（组序 = 层 id 对字典序）', () => {
    const layers = [
      layer('C', '图层 C', [gem('c1', 4, 8, 'b1'), gem('c2', 9, 8, 'b1')]), // 层内违规
      layer('A', '图层 A', [gem('a1', 40, 8, 'b1')]), // mask 越界
      layer('B', '图层 B', [gem('b1', 30, 8, 'b1')]), // 与 c2 相距 21px、与 a1 相距 10px——合法
    ]
    const first = jointExportGate(layers, { pixelsPerMm: PPM, blocks: [B1] })
    const second = jointExportGate(layers, { pixelsPerMm: PPM, blocks: [B1] })
    expect(first).toEqual(second)
    expect(first.groups.map((g) => g.layerIds)).toEqual([['A'], ['C']]) // 字典序：A < C
    expect(first.groups.map((g) => g.scope)).toEqual(['intra', 'intra'])
  })
})
