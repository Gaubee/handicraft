/*
 * [2026-09-20 R5-P1 Test] custom 必带 assetId 统一契约（codex-review-r4 题② P1-1/P1-2 修复）：
 * 同一 typed error 面横贯五处消费——
 * ① zod 公共 schema（GemSchema/EditGemSchema superRefine 反向强制，镜像 GemSpecSnapshotSchema）；
 * ② geometry.effectiveSpecOf（typed throw CustomAssetIdMissingError——validate/validateEditable/
 *    resolveConflicts 全消费面统一 fail-fast）；
 * ③ engine exportGate（custom 无 assetId 不跳过——无条件 missing-asset 阻断，与 resolver 接线无关）；
 * ④ 笔刷面收窄（BrushSpecState.shapeId: BuiltinShapeId + setBrushSpec/makeBrushGem 运行时拒绝
 *    ——详测 workbench.brushEngine.test.ts）；
 * ⑤ lab 账本 normalize 镜像（脏账本拒读——详测 stages.persist.test.ts）。
 * 本文件只测 engine 侧 ①②③ + 共享判据；BaseSpecSchema 保持 custom 弱引用可选（既有裁决，
 * spec.contract.test 在档）不在收窄面。
 */

import { describe, expect, it } from 'vitest'
import {
  CustomAssetIdMissingError,
  EditGemSchema,
  GemSchema,
  customAssetIdMissing,
  effectiveSpecOf,
  exportGate,
  gridFromSs,
  isBuiltinShapeId,
} from '$lib/engine'
import type { Gem, EditGem, GridSpec } from '$lib/engine'

const GRID: GridSpec = gridFromSs('SS10', 2.5)

function gem(overrides: Partial<Gem> = {}): Gem {
  return {
    id: 'g00001',
    x: 4,
    y: 4,
    colorId: 'red',
    blockId: 'blk-1',
    shapeId: 'round',
    diameterMm: 2.8,
    ...overrides,
  }
}

function editGem(overrides: Partial<EditGem> = {}): EditGem {
  return {
    id: 'g00001',
    x: 4,
    y: 4,
    colorId: 'red',
    blockId: null,
    origin: 'manual',
    moved: false,
    shapeId: 'round',
    diameterMm: 2.8,
    ...overrides,
  }
}

describe('共享判据（单一语义源）', () => {
  it('customAssetIdMissing：custom × (assetId 缺席/空串) = true；其余形态 false', () => {
    expect(customAssetIdMissing({ shapeId: 'custom' })).toBe(true)
    expect(customAssetIdMissing({ shapeId: 'custom', assetId: '' })).toBe(true)
    expect(customAssetIdMissing({ shapeId: 'custom', assetId: 'ast-x' })).toBe(false)
    expect(customAssetIdMissing({ shapeId: 'round' })).toBe(false)
    expect(customAssetIdMissing({ shapeId: 'round', assetId: 'ast-x' })).toBe(false)
    expect(customAssetIdMissing({})).toBe(false) // 规格字段缺席（v1 形态）不在判据面
  })

  it('isBuiltinShapeId：内置五形 true；custom 与未知值 false', () => {
    for (const id of ['round', 'square', 'drop', 'heart', 'marquise']) {
      expect(isBuiltinShapeId(id)).toBe(true)
    }
    expect(isBuiltinShapeId('custom')).toBe(false)
    expect(isBuiltinShapeId('hexagon')).toBe(false)
  })

  it('CustomAssetIdMissingError：typed error 形态（name/where/消息含契约句）', () => {
    const error = new CustomAssetIdMissingError('test-where')
    expect(error).toBeInstanceOf(CustomAssetIdMissingError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('CustomAssetIdMissingError')
    expect(error.where).toBe('test-where')
    expect(error.message).toContain("shapeId='custom' 必须携带 assetId")
  })
})

describe('① zod 公共 schema 反向强制', () => {
  it('GemSchema：custom 无 assetId → invalid；custom 带 assetId → valid（负向矩阵）', () => {
    expect(GemSchema.safeParse(gem({ shapeId: 'custom', diameterMm: 3 })).success).toBe(false)
    expect(GemSchema.safeParse(gem({ shapeId: 'custom', diameterMm: 3, assetId: 'ast-x' })).success).toBe(true)
    // 既有正向约束不回归：非 custom 带 assetId → invalid
    expect(GemSchema.safeParse(gem({ assetId: 'ast-x' })).success).toBe(false)
  })

  it('EditGemSchema：custom 无 assetId → invalid（镜像 GemSpecSnapshotSchema 约束）', () => {
    expect(EditGemSchema.safeParse(editGem({ shapeId: 'custom', diameterMm: 3 })).success).toBe(false)
    expect(EditGemSchema.safeParse(editGem({ shapeId: 'custom', diameterMm: 3, assetId: 'ast-x' })).success).toBe(true)
  })

  it('issue 落点 assetId + 消息含 canonical 派生依据', () => {
    const result = GemSchema.safeParse(gem({ shapeId: 'custom' }))
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('assetId')
      expect(result.error.issues.some((i) => i.message.includes('canonical specKey 派生依据'))).toBe(true)
    }
  })
})

describe('② effectiveSpecOf typed throw', () => {
  it('custom 无 assetId → CustomAssetIdMissingError（不静默按判距放行）', () => {
    expect(() => effectiveSpecOf({ shapeId: 'custom', diameterMm: 3 }, GRID)).toThrow(CustomAssetIdMissingError)
    expect(() => effectiveSpecOf({ shapeId: 'custom' }, GRID)).toThrow(/assetId/)
  })

  it('合法形态不受影响：custom 带 assetId / round / 规格字段缺席（v1 派生）', () => {
    expect(effectiveSpecOf({ shapeId: 'custom', diameterMm: 3, assetId: 'ast-x' }, GRID)).toEqual({ diameterMm: 3 })
    expect(effectiveSpecOf({ shapeId: 'round', diameterMm: 2.8 }, GRID)).toEqual({ diameterMm: 2.8 })
    expect(effectiveSpecOf({}, GRID)).toEqual({ diameterMm: 2.8 }) // grid 基准派生
  })
})

describe('③ exportGate 无条件阻断（不跳过）', () => {
  it('custom 无 assetId → missing-asset 违规（resolver 缺席也阻断——不跳过）', () => {
    const invalid = gem({ id: 'c1', shapeId: 'custom', diameterMm: 3 })
    const verdict = exportGate([invalid], { grid: GRID })
    expect(verdict.ok).toBe(false)
    expect(verdict.violations).toHaveLength(1)
    expect(verdict.violations[0].kind).toBe('missing-asset')
    expect(verdict.violations[0].gemIds).toEqual(['c1'])
    expect(verdict.violations[0].detail).toContain('typed invalid')
  })

  it('resolver 接线时同判（不因 resolver 面重复/吞并 typed invalid 违规）', () => {
    const invalid = gem({ id: 'c1', shapeId: 'custom', diameterMm: 3 })
    const valid = gem({ id: 'c2', x: 40, shapeId: 'custom', diameterMm: 3, assetId: 'ast-ok' })
    const verdict = exportGate([invalid, valid], {
      grid: GRID,
      resolveShapeAsset: () => 'resolved',
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.violations).toHaveLength(1)
    expect(verdict.violations[0].gemIds).toEqual(['c1'])
  })

  it('spacing 面仍可运行：invalid custom 钻参与判距（违规文档的完整违规清单）', () => {
    // invalid custom (4,4) 与 round (6,4)：中心距 2px < 判距——spacing + missing-asset 两违规并存
    const verdict = exportGate(
      [gem({ id: 'c1', shapeId: 'custom', diameterMm: 2.8 }), gem({ id: 'g2', x: 6, blockId: 'blk-1' })],
      { grid: GRID },
    )
    expect(verdict.ok).toBe(false)
    const kinds = verdict.violations.map((v) => v.kind)
    expect(kinds).toContain('spacing')
    expect(kinds).toContain('missing-asset')
    // 确定性排序：spacing 秩 < missing-asset 秩
    expect(kinds.indexOf('spacing')).toBeLessThan(kinds.indexOf('missing-asset'))
  })
})
