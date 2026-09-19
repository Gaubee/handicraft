/**
 * [gem-catalog engine gate 1.7] 验收行为分句收口（R2 §四 P0-1 第三项——R1 P0-1 移入）：
 * 「跨层 mixed-size/旋转/边界测试全部通过」——本切片以**组合行为测试**证明判据在
 * 全层 concat 输入上成立（层序组织/隐藏层枚举归 studio-layers；replay 联合验收归
 * replay/handoff gate——design §2.6 出处标注）：
 * - 多层 concat × mixed-size × 旋转异形 × 恰跨 cell 边界：exportGate 逐对判据全量命中、
 *   确定性排序、导出硬阻断；
 * - 隐藏层包含语义：concat 由调用方组织（门不豁免任何层——判据面证明）。
 */

import { describe, expect, it } from 'vitest'
import {
  exportGate,
  gridFromSpec,
  requiredCenterDistancePx,
  SS_TABLE,
  type Gem,
} from '$lib/engine'

const GAP = 0.4
const PPM = 2.5

describe('1.7 跨层 mixed-size/旋转/边界组合（判据在全层 concat 上成立）', () => {
  const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, GAP, PPM)
  const cell = ((SS_TABLE.SS10 + GAP) * PPM) // maxCellPx（全 SS10 时）——跨 cell 边界构造用
  const pitch = grid.pitchMm * grid.pixelsPerMm

  function gem(id: string, x: number, y: number, spec: { shapeId: Gem['shapeId']; diameterMm: number; rotationDeg?: number; assetId?: string }): Gem {
    return {
      id,
      x,
      y,
      colorId: 'red',
      blockId: `layer-${id.slice(0, 1)}`,
      shapeId: spec.shapeId,
      diameterMm: spec.diameterMm,
      ...(spec.rotationDeg !== undefined ? { rotationDeg: spec.rotationDeg } : {}),
      ...(spec.assetId !== undefined ? { assetId: spec.assetId } : {}),
    }
  }

  it('三层 concat（小径层/大径旋转异形层/跨 cell 边界层）：违规逐对命中 + 确定性 + 硬阻断', () => {
    const small = { shapeId: 'round' as const, diameterMm: SS_TABLE.SS6 }
    const big = { shapeId: 'marquise' as const, diameterMm: SS_TABLE.SS34, rotationDeg: 37.5 }
    // L1 小径层：内距恰合规（= 小径判距）
    const dSmall = requiredCenterDistancePx({ diameterMm: small.diameterMm }, { diameterMm: small.diameterMm }, grid)
    const layer1: Gem[] = [gem('a1', 0, 0, small), gem('a2', dSmall, 0, small)]
    // L2 大径旋转异形层：与 L1 的 a2 跨层混合径违规（旋转不改包络——判据只看 diameterMm；
    // x 取 dSmall + 0.7×dMix：距 a2 违规、距 a1 合规——只命中跨层对）
    const dMix = requiredCenterDistancePx({ diameterMm: small.diameterMm }, { diameterMm: big.diameterMm }, grid)
    const layer2: Gem[] = [gem('b1', dSmall + dMix * 0.7, 0, big)]
    // L3 跨 cell 边界层：两点横跨 cell 边界、恰达大径等径判距 = 合规（边界含等号）
    const boundary = Math.ceil(pitch * 3 / cell) * cell // cell 整数倍桶边界
    const dBig = requiredCenterDistancePx({ diameterMm: big.diameterMm }, { diameterMm: big.diameterMm }, grid)
    const layer3: Gem[] = [
      gem('c1', boundary - 0.01, 100, big),
      gem('c2', boundary - 0.01 + dBig, 100, big), // 跨桶 + 恰达判距 = 合规
    ]

    // 组装（隐藏层包含 = 调用方 concat 全层；门不豁免任何层）
    const concat = [...layer1, ...layer2, ...layer3]
    const verdict = exportGate(concat, { grid })
    expect(verdict.ok).toBe(false) // a2-b1 混合径跨层违规 → 导出硬阻断
    const spacing = verdict.violations.filter((v) => v.kind === 'spacing')
    expect(spacing).toHaveLength(1)
    expect(spacing[0].gemIds).toEqual(['a2', 'b1'])
    // 边界对（c1-c2 恰达判距）与层内合规对不误报
    expect(JSON.stringify(verdict.violations)).not.toContain('c1')
    // 确定性：再跑逐位一致
    expect(exportGate(concat, { grid })).toEqual(verdict)

    // 修复 a2-b1 至判距后：全层 concat 通过（保存 warning → 消解后导出）
    layer2[0] = gem('b1', dSmall + dMix * 1.01, 0, big)
    const repaired = exportGate([...layer1, ...layer2, ...layer3], { grid })
    expect(repaired).toEqual({ ok: true, violations: [] })
  })

  it('旋转异形圆包络不变性（跨层组合再证）：rotationDeg 变化不改违规集合', () => {
    const small = { shapeId: 'round' as const, diameterMm: SS_TABLE.SS6 }
    const at = (rotationDeg?: number) => [
      gem('a1', 0, 0, small),
      gem('b1', pitch * 0.6, 0, { shapeId: 'drop' as const, diameterMm: SS_TABLE.SS16, ...(rotationDeg !== undefined ? { rotationDeg } : {}) }),
    ]
    for (const rot of [undefined, 0, 37.5, 359.9]) {
      const verdict = exportGate(at(rot), { grid })
      expect(verdict.ok, `rotationDeg=${rot}`).toBe(false)
      expect(verdict.violations, `rotationDeg=${rot}`).toHaveLength(1)
      expect(verdict.violations[0].gemIds).toEqual(['a1', 'b1'])
    }
  })
})
