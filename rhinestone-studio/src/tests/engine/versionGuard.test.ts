/**
 * [gem-catalog engine gate 1.6] ENGINE_VERSION 1→2 护栏（design §2.5）：
 * - 单规格圆钻文档 v1/v2 引擎**钻位逐位不变**：v1 引擎黄金快照（engineGolden.test——动工前采集）
 *   与 v2 引擎（逐对圆包络判据）同参输出逐位相等；本文件补「v1 判据参考实现」的等价性直证——
 *   v1 单一 pitch×0.999 阈值 + cell=pitch 索引的暴力参考 vs v2 validate/resolveConflicts 输出全等；
 * - serialize 自动携带新值（gemproj/gemdoc engineVersion === ENGINE_VERSION）；
 * - v1 引擎旧档（engineVersion:1）仍可 parse（非负整数门）——重放漂移横幅语义 =
 *   「保存时记录值 ≠ 当前值 → 横幅」，比对基准面不变（横幅接线归 replay/studio，非本 gate）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  gridFromSs,
  layout,
  resolveConflicts,
  segment,
  SS_TABLE,
  validate,
  validateEditable,
  type EditGem,
  type Gem,
} from '$lib/engine'
import { SpatialIndex } from '$lib/engine/ops'
import { ENGINE_VERSION } from '$lib/engine/version'
import { parseGemdoc, parseGemproj, serializeGemdoc, serializeGemproj } from '$lib/persistence/projectFile'
import { fixtureShapes, SEG_OPTS, standardGrid } from './helpers'

// ---------------------------------------------------------------------------
// v1 判据参考实现（镜像 v1 validate/resolveGreedy：单一 pitch×0.999 + cell=pitch）
// ---------------------------------------------------------------------------

function v1SpacingViolations(gems: Array<{ id: string; x: number; y: number }>, pitch: number): string[] {
  const threshold = pitch * 0.999
  const index = new SpatialIndex<number>(pitch)
  gems.forEach((gem, i) => index.insert(gem.x, gem.y, i))
  const out: string[] = []
  const seen = new Set<number>()
  for (let i = 0; i < gems.length; i++) {
    for (const j of index.query(gems[i].x, gems[i].y)) {
      if (j <= i) continue
      const dx = gems[j].x - gems[i].x
      const dy = gems[j].y - gems[i].y
      if (dx * dx + dy * dy >= threshold * threshold) continue
      const key = i * gems.length + j
      if (seen.has(key)) continue
      seen.add(key)
      out.push([gems[i].id, gems[j].id].sort().join('|'))
    }
  }
  return out.sort()
}

function v1KeepOrder(gems: Array<{ id: string; x: number; y: number }>, pitch: number): string[] {
  const threshold = pitch * 0.999
  const keep: string[] = []
  const kept: Array<{ x: number; y: number }> = []
  for (const gem of gems) {
    let conflict = false
    for (const other of kept) {
      const dx = other.x - gem.x
      const dy = other.y - gem.y
      if (dx * dx + dy * dy < threshold * threshold) {
        conflict = true
        break
      }
    }
    if (!conflict) {
      keep.push(gem.id)
      kept.push(gem)
    }
  }
  return keep
}

describe('单规格圆钻 v1/v2 逐位不变护栏（ENGINE_VERSION 2 bump 前提）', () => {
  const grid = standardGrid() // SS10 + 2.5 → pitch 8px
  const pitch = grid.pitchMm * grid.pixelsPerMm

  it('validate：v2 逐对圆包络判据 ≡ v1 单一 pitch×0.999（违规对集合全等，单规格参数空间）', () => {
    const blocks = segment(fixtureShapes(), SEG_OPTS)
    const { gems } = layout(blocks, 'hex-pitch', { density: 1, seed: 7 }, grid)
    // v1 参考 vs v2 引擎：钻位无位移（间距违规集合逐对全等）
    expect(v1SpacingViolations(gems, pitch)).toEqual([])
    expect(validate(gems, grid).filter((w) => w.kind === 'spacing')).toEqual([])
    // 注入确定性违规簇（覆盖恰阈值/半距/重合三档）
    const injected: Gem[] = [
      ...gems,
      { ...gems[0], id: 'dup-exact', x: gems[0].x + pitch, y: gems[0].y }, // 恰 pitch = 合规
      { ...gems[0], id: 'dup-half', x: gems[0].x + pitch * 0.5, y: gems[0].y },
      { ...gems[1], id: 'dup-coincident', x: gems[1].x, y: gems[1].y },
    ]
    const v1Pairs = v1SpacingViolations(injected, pitch)
    const v2Pairs = validate(injected, grid)
      .filter((w) => w.kind === 'spacing')
      .map((w) => {
        const ids = /钻 (\S+) 与 (\S+) /.exec(w.detail)
        return [ids?.[1] ?? '', ids?.[2] ?? ''].sort().join('|')
      })
      .sort()
    expect(v2Pairs).toEqual(v1Pairs)
    expect(v1Pairs.length).toBeGreaterThanOrEqual(2)
  })

  it('resolveConflicts：v2 消解保留集 ≡ v1 keep-earlier 贪心（同输入序）', () => {
    const blocks = segment(fixtureShapes(), SEG_OPTS)
    const { gems } = layout(blocks, 'poisson', { density: 1, seed: 7 }, grid)
    const mixed = gems.flatMap((g, i) =>
      i % 7 === 3 ? [{ ...g, id: `dup-${g.id}`, x: g.x + 0.5, y: g.y + 0.5 }, g] : [g],
    )
    const v2 = resolveConflicts(
      mixed.map((g) => ({ ...g, blockId: g.blockId, origin: 'layout' as const, moved: false })),
      grid,
    )
    expect(v2.gems.map((g) => g.id)).toEqual(v1KeepOrder(mixed, pitch))
  })

  it('validateEditable：同判据（v1 等径阈值逐位等价）', () => {
    const egems: EditGem[] = [
      { id: 'a', x: 0, y: 0, colorId: 'red', blockId: null, origin: 'layout', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS10 },
      { id: 'b', x: pitch * 0.9995, y: 0, colorId: 'red', blockId: null, origin: 'layout', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS10 },
      { id: 'c', x: pitch * 0.99, y: 50, colorId: 'red', blockId: null, origin: 'layout', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS10 },
      { id: 'd', x: 0, y: 50, colorId: 'red', blockId: null, origin: 'layout', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS10 },
    ]
    const warnings = validateEditable(egems, grid).filter((w) => w.kind === 'spacing')
    expect(warnings.map((w) => w.gemIds.join('|')).sort()).toEqual(['c|d'])
  })

  it('layout 黄金：v2 引擎钻位与 v1 黄金逐位相等（engineGolden fixtures 现场抽查）', () => {
    const golden = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'goldens', 'hex-pitch-shapes.json'), 'utf8'),
    ) as { gems: Array<{ id: string; x: number; y: number; blockId: string }> }
    const blocks = segment(fixtureShapes(), SEG_OPTS)
    const { gems } = layout(blocks, 'hex-pitch', { density: 1, seed: 7 }, grid)
    expect(gems.map((g) => ({ id: g.id, x: g.x, y: g.y, blockId: g.blockId }))).toEqual(golden.gems)
  })
})

describe('ENGINE_VERSION 1→2 携带与旧档兼容', () => {
  it('ENGINE_VERSION === 2；serializeGemproj/serializeGemdoc 自动携带（serialize 侧直读常量）', () => {
    expect(ENGINE_VERSION).toBe(2)
    const proj = serializeGemproj({
      appVersion: 't',
      createdAt: 1,
      savedAt: 2,
      name: 'n',
      source: { kind: 'asset', assetId: 'a', name: 's', width: 8, height: 8, downscale: 1 },
      segment: { k: 6, seed: 0 },
      layers: [
        {
          id: 'L1',
          name: '图层 1',
          blockIds: 'rest',
          strategy: 'hex-pitch',
          physics: { specKey: 'round-ss10', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } },
          overrides: { disabled: {}, density: {}, type: {}, color: {} },
        },
      ],
      palette: [],
    })
    expect(JSON.parse(proj).engineVersion).toBe(2)
    const doc = serializeGemdoc({
      appVersion: 't',
      createdAt: 1,
      savedAt: 2,
      name: 'n',
      width: 8,
      height: 8,
      grid: gridFromSs('SS10', 2.5),
      palette: [],
      gems: [],
      blocks: [],
      layers: {
        painting: { visible: true, opacity: 1 },
        reference: { visible: true, opacity: 0.6 },
        blocks: { visible: true, opacity: 0.9 },
        gems: { visible: true, opacity: 1 },
      },
      painting: { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      provenance: { origin: 'studio-bake', sourceSummary: 'x' },
    })
    expect(JSON.parse(doc).engineVersion).toBe(2)
  })

  it('v1 引擎旧档（engineVersion:1）可 parse——漂移横幅语义 = 记录值≠当前值（比对基准面不变）', () => {
    const projV1Engine = serializeGemproj({
      appVersion: 't',
      createdAt: 1,
      savedAt: 2,
      name: 'n',
      source: { kind: 'asset', assetId: 'a', name: 's', width: 8, height: 8, downscale: 1 },
      segment: { k: 6, seed: 0 },
      layers: [
        {
          id: 'L1',
          name: '图层 1',
          blockIds: 'rest',
          strategy: 'hex-pitch',
          physics: { specKey: 'round-ss10', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } },
          overrides: { disabled: {}, density: {}, type: {}, color: {} },
        },
      ],
      palette: [],
    }).replace('"engineVersion":2', '"engineVersion":1')
    const parsed = parseGemproj(projV1Engine)
    expect(parsed.engineVersion).toBe(1)
    expect(parsed.engineVersion !== ENGINE_VERSION).toBe(true) // 横幅触发条件（记录值 ≠ 当前值）
  })
})
