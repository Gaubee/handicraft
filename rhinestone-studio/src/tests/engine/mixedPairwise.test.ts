/**
 * [gem-catalog engine gate 1.2] 混合径 pairwise + exportGate：
 * - 大小径混合：逐对判据（(da+db)/2+gap）——同距异径不同判决；
 * - 边界 gap：恰达所需判距 = 合规（≥ required），略低 = 违规（gap=0 相切含边界）；
 * - 旋转异形圆包络不变性：rotationDeg 不改判决；
 * - 20k 钻规模（性能烟测 + 确定性）；
 * - 违规清单确定性排序（exportGate：kind 秩 → gemIds 字典序）；
 * - exportGate 三违规面（spacing/mask/missing-asset）+ 保存 warning / 导出硬阻断语义分句证明。
 */

import { describe, expect, it } from 'vitest'
import {
  exportGate,
  gridFromSpec,
  isExportable,
  requiredCenterDistancePx,
  resolveConflicts,
  SS_TABLE,
  validate,
  validateEditable,
  type Block,
  type EditGem,
  type Gem,
  type GemSpecFields,
} from '$lib/engine'

const GAP = 0.4
const PPM = 2.5

function gridOf(diameterMm: number) {
  return gridFromSpec({ shapeId: 'round', sizeLabel: `${diameterMm}mm`, diameterMm }, GAP, PPM)
}

/** 规格物化 Gem（1.4 前的结构面：Gem & GemSpecFields）。 */
function gem(id: string, x: number, y: number, spec?: { shapeId: string; diameterMm: number }): Gem & GemSpecFields {
  return {
    id,
    x,
    y,
    colorId: '',
    blockId: 'blk',
    ...(spec !== undefined ? { shapeId: spec.shapeId, diameterMm: spec.diameterMm } : {}),
  }
}

function egem(id: string, x: number, y: number, spec?: { shapeId: string; diameterMm: number }): EditGem & GemSpecFields {
  return {
    id,
    x,
    y,
    colorId: '',
    blockId: 'blk',
    origin: 'layout' as const,
    moved: false,
    ...(spec !== undefined ? { shapeId: spec.shapeId, diameterMm: spec.diameterMm } : {}),
  }
}

const SMALL = { shapeId: 'round', diameterMm: SS_TABLE.SS6 } // 2.0mm
const BIG = { shapeId: 'round', diameterMm: SS_TABLE.SS34 } // 7.1mm

describe('1.2 大小径混合（逐对圆包络判据）', () => {
  it('validate：小-小同距合规、小-大同距违规（判据由两钻径共同决定）', () => {
    const grid = gridOf(SS_TABLE.SS6) // 基准 = 小径
    const smallPairRequired = requiredCenterDistancePx(
      { diameterMm: SMALL.diameterMm },
      { diameterMm: SMALL.diameterMm },
      grid,
    )
    // 两小钻恰好满足小-小判距：合规
    const clean = validate(
      [gem('a', 0, 0, SMALL), gem('b', smallPairRequired, 0, SMALL)],
      grid,
    )
    expect(clean.filter((w) => w.kind === 'spacing')).toEqual([])
    // 同距换成大钻：小-大判距更大 → 违规
    const dirty = validate([gem('a', 0, 0, SMALL), gem('b', smallPairRequired, 0, BIG)], grid)
    expect(dirty.filter((w) => w.kind === 'spacing')).toHaveLength(1)
    expect(dirty[0].detail).toContain('a 与 b')
  })

  it('validateEditable：同判据（等径 = v1 单一 pitch×0.999 等价；混合径逐对）', () => {
    const grid = gridOf(SS_TABLE.SS10)
    const pitchPx = grid.pitchMm * grid.pixelsPerMm
    // 等径：恰在 pitch×0.999 之上 = 合规；恰在其下 = 违规（v1 等价证据）
    const ok = validateEditable(
      [egem('g1', 0, 0), egem('g2', pitchPx * 0.9995, 0)],
      grid,
    )
    expect(ok.filter((w) => w.kind === 'spacing')).toEqual([])
    const bad = validateEditable([egem('g1', 0, 0), egem('g2', pitchPx * 0.99, 0)], grid)
    expect(bad.filter((w) => w.kind === 'spacing')).toHaveLength(1)
    // 混合径：大钻靠近 → 违规
    const mixed = validateEditable([egem('g1', 0, 0), egem('g2', pitchPx * 0.9995, 0, BIG)], grid)
    expect(mixed.filter((w) => w.kind === 'spacing')).toHaveLength(1)
  })

  it('resolveConflicts：混合径删除与保留按逐对判据（大钻卡死小钻位）', () => {
    const grid = gridOf(SS_TABLE.SS6)
    const d = requiredCenterDistancePx({ diameterMm: SMALL.diameterMm }, { diameterMm: SMALL.diameterMm }, grid)
    // 小钻间距合规；但一枚大钻落在小钻旁 < (ds+db)/2+gap → 先到者保留、后到者删
    const result = resolveConflicts(
      [egem('s1', 0, 0, SMALL), egem('s2', d, 0, SMALL), egem('b1', d * 0.5, 0, BIG)],
      grid,
    )
    expect(result.gems.map((x) => x.id)).toEqual(['s1', 's2'])
    expect(result.removed).toHaveLength(1)
    expect(result.removed[0].gem.id).toBe('b1')
    expect(result.removed[0].reason).toContain('所需')
  })
})

describe('1.2 边界 gap 与旋转不变性', () => {
  it('gap=0 相切：恰达 (da+db)/2 = 合规；略低 = 违规（边界含等号）', () => {
    const grid = gridFromSpec({ shapeId: 'round', sizeLabel: 'x', diameterMm: 2.0 }, 0, PPM)
    const required = requiredCenterDistancePx({ diameterMm: 2 }, { diameterMm: 2 }, grid) // = 2×PPM
    const clean = validate([gem('a', 0, 0), gem('b', required, 0)], grid)
    expect(clean.filter((w) => w.kind === 'spacing')).toEqual([])
    const dirty = validate([gem('a', 0, 0), gem('b', required * 0.995, 0)], grid)
    expect(dirty.filter((w) => w.kind === 'spacing')).toHaveLength(1)
  })

  it('旋转异形圆包络不变性：rotationDeg 不改判决（异形按最大径圆包络）', () => {
    const grid = gridOf(SS_TABLE.SS10)
    const at = (rotationDeg: number) => [
      gem('a', 0, 0, { shapeId: 'marquise', diameterMm: 4.0 }),
      { ...gem('b', 10, 0, { shapeId: 'marquise', diameterMm: 4.0 }), rotationDeg },
    ] as (Gem & GemSpecFields)[]
    const required = requiredCenterDistancePx(
      { diameterMm: 4.0 },
      { diameterMm: 4.0 },
      grid,
    )
    const withDist = (dist: number, rot: number) => [
      { ...gem('a', 0, 0, { shapeId: 'marquise', diameterMm: 4.0 }) },
      { ...gem('b', dist, 0, { shapeId: 'marquise', diameterMm: 4.0 }), rotationDeg: rot },
    ]
    for (const rot of [0, 37.5, 90, 359.9]) {
      expect(validate(withDist(required * 1.01, rot), grid).filter((w) => w.kind === 'spacing')).toEqual([])
      expect(validate(withDist(required * 0.95, rot), grid).filter((w) => w.kind === 'spacing')).toHaveLength(1)
    }
    void at
  })
})

describe('1.2 20k 钻规模（性能烟测 + 确定性）', () => {
  it('20k 混合径钻 validate/exportGate 双运行逐位一致且含预期违规', () => {
    const grid = gridOf(SS_TABLE.SS10)
    const pitchPx = grid.pitchMm * grid.pixelsPerMm
    const gems: Array<Gem & GemSpecFields> = []
    // 六方密排 20k+（无违规基底）
    const rowH = (pitchPx * Math.sqrt(3)) / 2
    let n = 0
    outer: for (let row = 0; row < 200; row += 1) {
      for (let col = 0; col < 110; col += 1) {
        if (n >= 20_000) break outer
        gems.push(
          gem(`g${n}`, col * pitchPx + (row % 2) * (pitchPx / 2), row * rowH, {
            shapeId: 'round',
            diameterMm: SS_TABLE.SS10,
          }),
        )
        n += 1
      }
    }
    // 撒入 8 枚大径侵扰钻（各自制造至少一处违规）
    for (let k = 0; k < 8; k += 1) {
      gems.push(gem(`big${k}`, 5 * pitchPx + k * 9 * pitchPx, 5 * rowH, BIG))
    }

    const t0 = performance.now()
    const warnings1 = validate(gems, grid)
    const verdict1 = exportGate(gems, { grid })
    const elapsed = performance.now() - t0
    const warnings2 = validate(gems, grid)
    const verdict2 = exportGate(gems, { grid })

    expect(warnings1.filter((w) => w.kind === 'spacing').length).toBeGreaterThanOrEqual(8)
    expect(warnings2).toEqual(warnings1) // 确定性
    expect(verdict1).toEqual(verdict2)
    expect(verdict1.ok).toBe(false)
    expect(isExportable(warnings1)).toBe(false)
    // 宽松上限（CI 抖动；本机典型 < 1s）
    expect(elapsed, `validate+exportGate @20k 应远快于 30s（实测 ${elapsed.toFixed(0)}ms）`).toBeLessThan(30_000)
  }, 60_000)
})

describe('1.2 exportGate（导出前置门）', () => {
  const grid = gridOf(SS_TABLE.SS10)
  const pitchPx = grid.pitchMm * grid.pixelsPerMm

  function blockOf(w: number, h: number): Block {
    const bits = new Uint8Array(w * h).fill(1)
    return {
      id: 'blk',
      label: 'blk',
      mask: { w, h, bits },
      colorRgb: [255, 0, 0],
      areaPx: w * h,
      bbox: { x: 0, y: 0, w, h },
      widthPx: { max: w, mean: w / 2 },
      suggested: 'fill',
    }
  }

  it('零违规 = ok（保存与导出双放行）', () => {
    const gems = [gem('a', 0, 0), gem('b', pitchPx * 1.05, 0)]
    const verdict = exportGate(gems, { grid, blocks: [blockOf(64, 64)] })
    expect(verdict).toEqual({ ok: true, violations: [] })
  })

  it('spacing/mask/missing-asset 三面各产违规；违规清单确定性排序（kind 秩 → gemId 字典序）', () => {
    const gems = [
      gem('a', 0, 0),
      gem('b', pitchPx * 0.5, 0), // spacing 违规（a-b）
      gem('z', 100, 100), // mask 违规（越出 64×64 块）
      { ...gem('c1', 10, 10, { shapeId: 'custom', diameterMm: 3 }), assetId: 'ast-x' },
      { ...gem('c2', 20, 20, { shapeId: 'custom', diameterMm: 3 }), assetId: 'ast-y' },
    ]
    const verdict = exportGate(gems, {
      grid,
      blocks: [blockOf(64, 64)],
      resolveShapeAsset: (assetId) => (assetId === 'ast-x' ? 'soft-deleted' : 'resolved'),
    })
    expect(verdict.ok).toBe(false)
    const kinds = verdict.violations.map((v) => v.kind)
    // kind 秩：spacing < mask < missing-asset
    expect(kinds).toEqual(['spacing', 'mask', 'missing-asset'])
    expect(verdict.violations[0].gemIds).toEqual(['a', 'b'])
    expect(verdict.violations[2].gemIds).toEqual(['c1']) // 同资产聚合；ast-y resolved 不报
    expect(verdict.violations[2].detail).toContain('soft-deleted')
    // 同输入再跑逐位一致
    expect(exportGate(gems, {
      grid,
      blocks: [blockOf(64, 64)],
      resolveShapeAsset: (assetId) => (assetId === 'ast-x' ? 'soft-deleted' : 'resolved'),
    })).toEqual(verdict)
  })

  it('同 kind 违规按 gemIds 字典序稳定排序（多 spacing 对）', () => {
    const gems = [
      gem('m', 0, 0),
      gem('n', pitchPx * 0.4, 0),
      gem('a', 0, 50),
      gem('b', pitchPx * 0.4, 50),
    ]
    const verdict = exportGate(gems, { grid })
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.map((v) => v.gemIds.join(','))).toEqual(['a,b', 'm,n'])
  })

  it('missing-asset：未提供 resolveShapeAsset 接线时跳过该面（不虚报合规以外断言）', () => {
    const gems = [{ ...gem('c1', 10, 10, { shapeId: 'custom', diameterMm: 3 }), assetId: 'ast-x' }]
    expect(exportGate(gems, { grid }).ok).toBe(true)
    expect(exportGate(gems, { grid, resolveShapeAsset: () => null }).ok).toBe(false)
  })

  it('多层 concat 语义：层序组织归调用方——concat 输入的跨层 spacing 违规同样硬阻断', () => {
    // 两层各自内部合规，concat 后层间重叠 → 违规（隐藏层包含与硬阻断判据证明，R2 §四 P0-3）
    const layerA = [gem('a1', 0, 0), gem('a2', pitchPx * 1.05, 0)]
    const layerB = [gem('b1', pitchPx * 0.5, 0)] // 与 a1 半距重叠
    const verdict = exportGate([...layerA, ...layerB], { grid })
    expect(verdict.ok).toBe(false)
    expect(verdict.violations.every((v) => v.kind === 'spacing')).toBe(true)
  })
})
