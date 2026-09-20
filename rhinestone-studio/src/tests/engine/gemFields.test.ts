/**
 * [gem-catalog engine gate 1.4] Gem/EditGem 规格物化字段落地：
 * - zod 公共契约面（GemSchema/EditGemSchema：必填 shapeId/diameterMm、rotationDeg 值域、
 *   assetId 仅 custom）；
 * - toEditGem/fromEditGem 字段随迁 round-trip（含 rotationDeg/assetId 可选键缺席不落键）；
 * - layout 产物规格戳（shapeId='round' + baseSpecDiameterMm——gridFromSs 构造链逐位同值）；
 * - gemdoc v2 钻位字段转必填（缺席 = typed error；v1 迁移补 round 见 formatV2.test）。
 */

import { describe, expect, it } from 'vitest'
import {
  baseSpecDiameterMm,
  EditGemSchema,
  fromEditGem,
  GemSchema,
  gridFromSs,
  layout,
  segment,
  SS_TABLE,
  toEditGem,
  type EditGem,
  type Gem,
} from '$lib/engine'
import type { EditGemFields } from '$lib/stores/edit.svelte'
import { ProjectFileFieldError, serializeGemdoc, parseGemdoc, type GemdocGem, type GemdocUnderlaySourceInput } from '$lib/persistence/projectFile'
import { fixtureShapes, SEG_OPTS, standardGrid } from './helpers'

const ROUND = { shapeId: 'round' as const, diameterMm: SS_TABLE.SS10 }

describe('zod 公共契约面（GemSchema / EditGemSchema）', () => {
  const gem = { id: 'g1', x: 0, y: 0, colorId: 'red', blockId: 'blk', ...ROUND }

  it('合法形态 parse 通过（Gem / EditGem）', () => {
    expect(GemSchema.parse(gem)).toEqual(gem)
    expect(EditGemSchema.parse({ ...gem, blockId: null, origin: 'manual', moved: false })).toMatchObject({
      id: 'g1',
      origin: 'manual',
      shapeId: 'round',
      diameterMm: SS_TABLE.SS10,
    })
  })

  it('shapeId/diameterMm 必填：缺席拒收；rotationDeg 值域 [0,360)；assetId 仅 custom', () => {
    const { shapeId: _s, diameterMm: _d, ...bare } = gem
    void _s
    void _d
    expect(GemSchema.safeParse(bare).success).toBe(false)
    expect(GemSchema.safeParse({ ...gem, shapeId: 'hexagon' }).success).toBe(false)
    expect(GemSchema.safeParse({ ...gem, diameterMm: 0 }).success).toBe(false)
    expect(GemSchema.safeParse({ ...gem, rotationDeg: 360 }).success).toBe(false)
    expect(GemSchema.safeParse({ ...gem, rotationDeg: 359.9, assetId: 'ast-1' }).success).toBe(false) // assetId 仅 custom
    expect(
      GemSchema.safeParse({ ...gem, shapeId: 'custom', assetId: 'ast-1' }).success,
    ).toBe(true)
  })
})

describe('toEditGem / fromEditGem 字段随迁（1.4）', () => {
  it('必填字段直传；可选键缺席不落键；round-trip 逐字段保真', () => {
    const plain: Gem = { id: 'g-1', x: 1, y: 2, colorId: 'red', blockId: 'blk', ...ROUND }
    const e = toEditGem(plain)
    expect(e).toEqual({ ...plain, origin: 'layout', moved: false })
    expect(fromEditGem(e)).toEqual(plain)
    const rotated: Gem = { ...plain, rotationDeg: 45, assetId: 'ast-9', shapeId: 'custom' }
    const e2 = toEditGem(rotated)
    expect(e2.rotationDeg).toBe(45)
    expect(e2.assetId).toBe('ast-9')
    expect(fromEditGem(e2)).toEqual(rotated)
  })

  it('EditGemFields 白名单扩展（类型级）：shapeId/diameterMm/rotationDeg 可作 update patch 字段', () => {
    const patch: EditGemFields = { x: 1, y: 2, colorId: 'red', shapeId: 'square', diameterMm: 3.5, rotationDeg: 30 }
    expect(patch).toMatchObject({ shapeId: 'square', diameterMm: 3.5, rotationDeg: 30 })
  })
})

describe('layout 产物规格戳（1.4：makeGem 源头统一）', () => {
  it('全部钻 shapeId=round + diameterMm=baseSpecDiameterMm(grid)（gridFromSs 链 = SS_TABLE 查表值）', () => {
    const grid = standardGrid()
    const blocks = segment(fixtureShapes(), SEG_OPTS)
    const { gems } = layout(blocks, 'hex-pitch', { density: 1, seed: 7 }, grid)
    expect(gems.length).toBeGreaterThan(0)
    for (const gem of gems) {
      expect(gem.shapeId).toBe('round')
      expect(gem.diameterMm).toBe(baseSpecDiameterMm(grid))
      expect(gem.diameterMm).toBe(SS_TABLE.SS10)
    }
    // gridFromSs 构造链：量化回推与 SS_TABLE 逐位相等（bootstrap 查表投影命中前提）
    expect(baseSpecDiameterMm(gridFromSs('SS34', 2.5))).toBe(SS_TABLE.SS34)
  })
})

describe('gemdoc v2 钻位字段转必填（1.4）', () => {
  // [1.2 v3 演进] 序列化输入面随 gemdoc v3：layers 钻石层 + underlay 源（断言语义不变）
  const baseInput = {
    appVersion: '0.1.0-test',
    createdAt: 1,
    savedAt: 2,
    name: '字段必填',
    width: 10,
    height: 10,
    grid: standardGrid(),
    palette: [{ id: 'red', name: '红', hex: '#C8102E' }],
    gems: [] as GemdocGem[],
    layers: [{ id: 'L1', name: '图层 1', visible: true, locked: false }],
    underlay: {
      sources: [
        { key: 'painting', visible: true, opacity: 1, painting: { mime: 'image/png' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
      ] as GemdocUnderlaySourceInput[],
    },
    provenance: { origin: 'studio-bake' as const, sourceSummary: 'x' },
  }
  const goodGem: GemdocGem = {
    id: 'g1', x: 1, y: 1, colorId: 'red', blockId: null, origin: 'layout', moved: false, layerId: 'L1', ...ROUND,
  }

  it('携带字段的 v2 round-trip 通过；字段缺席的过渡窗口文件 = typed error 拒收（转必填）', () => {
    const text = serializeGemdoc({ ...baseInput, gems: [goodGem] })
    const parsed = parseGemdoc(text)
    expect(parsed.gems[0]).toMatchObject({ shapeId: 'round', diameterMm: SS_TABLE.SS10 })
    expect(parseGemdoc(serializeGemdoc({ ...baseInput, gems: parseGemdoc(text).gems }))).toEqual(parsed)

    const transitional = JSON.parse(text) as { gems: Array<Record<string, unknown>> }
    delete transitional.gems[0].shapeId
    delete transitional.gems[0].diameterMm
    const error = parseGemdocSafeError(JSON.stringify(transitional))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('gems.0.shapeId')
  })
})

function parseGemdocSafeError(text: string): unknown {
  try {
    parseGemdoc(text)
    return null
  } catch (error) {
    return error
  }
}
