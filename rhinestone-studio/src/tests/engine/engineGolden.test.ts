/**
 * [2026-09-20 gem-catalog engine gate] v1 引擎黄金快照（goldens）守卫：
 * - 黄金 fixtures 于 engine gate 动工**前**从 v1 引擎（ENGINE_VERSION=1）采集
 *   （GOLDEN_REGEN=1 再生；再生只允许在语义变更有意发生时执行并随 commit 说明）。
 * - 守卫断言：同参 layout 输出（钻位 id/x/y/blockId + dropped）与黄金逐位相等——
 *   1.5 CVT 优化（逐位不变承诺）与 1.6 ENGINE_VERSION bump（单规格圆钻 v1/v2 钻位
 *   逐位不变护栏，design §2.5）的共同证据面。
 * - 比较投影只取位相关字段（colorId 恒空串、1.4 起的规格物化字段不进黄金——
 *   v1 黄金不含新字段，v2 引擎产物经同一投影后必须逐位相等）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { layout, segment, type Block, type StrategyId } from '$lib/engine'
import { fixtureShapes, fixtureSolid, fixtureTwoRects, loadBostonPhotoPainting, SEG_OPTS } from './helpers'

/** 位相关投影（黄金比较面）：id/x/y/blockId + 数量与 dropped。 */
interface GoldenGem {
  id: string
  x: number
  y: number
  blockId: string
}

interface GoldenDoc {
  strategy: StrategyId
  source: string
  density: number
  relax: { boundary: boolean; repulsion: boolean }
  gemCount: number
  dropped: number
  gems: GoldenGem[]
}

const GOLDEN_DIR = join(__dirname, 'fixtures', 'goldens')

function makeImage256Solid(): ReturnType<typeof fixtureSolid> {
  return fixtureSolid()
}

/** 黄金用例表（固定参数：SS10 网格 2.5px/mm、k=6 seed=3 gemDiameterPx=7、seed=7）。 */
const CASES: Array<{
  name: string
  strategy: StrategyId
  source: () => ReturnType<typeof fixtureShapes>
  sourceLabel: string
  density?: number
  relax?: { boundary: boolean; repulsion: boolean }
}> = [
  { name: 'hex-thin-shapes', strategy: 'hex-thin', source: fixtureShapes, sourceLabel: 'fixtureShapes 120²' },
  { name: 'hex-pitch-shapes', strategy: 'hex-pitch', source: fixtureShapes, sourceLabel: 'fixtureShapes 120²' },
  { name: 'poisson-shapes', strategy: 'poisson', source: fixtureShapes, sourceLabel: 'fixtureShapes 120²' },
  { name: 'hybrid-shapes', strategy: 'hybrid', source: fixtureShapes, sourceLabel: 'fixtureShapes 120²' },
  { name: 'cvt-shapes', strategy: 'cvt', source: fixtureShapes, sourceLabel: 'fixtureShapes 120²' },
  {
    name: 'cvt-shapes-density',
    strategy: 'cvt',
    source: fixtureShapes,
    sourceLabel: 'fixtureShapes 120²',
    density: 0.55,
  },
  { name: 'cvt-two-rects', strategy: 'cvt', source: fixtureTwoRects, sourceLabel: 'fixtureTwoRects 96×64' },
  { name: 'cvt-solid-256', strategy: 'cvt', source: makeImage256Solid, sourceLabel: 'fixtureSolid 48×48' },
  {
    name: 'cvt-boston',
    strategy: 'cvt',
    source: () => loadBostonPhotoPainting(),
    sourceLabel: 'boston 400×400 数字油画',
  },
  {
    name: 'cvt-boston-relax',
    strategy: 'cvt',
    source: () => loadBostonPhotoPainting(),
    sourceLabel: 'boston 400×400 数字油画',
    relax: { boundary: true, repulsion: true },
  },
]

function runCase(c: (typeof CASES)[number]): GoldenDoc {
  const blocks: Block[] = segment(c.source(), SEG_OPTS)
  const { gems, dropped } = layout(
    blocks,
    c.strategy,
    {
      density: c.density ?? 1,
      seed: 7,
      relax: c.relax ?? { boundary: false, repulsion: false },
    },
    // SS10 + 2.5px/mm（helpers.standardGrid 同参；黄金与 v1 单一 pitch 判据同参数空间）
    { ss: 'SS10', pitchMm: 2.8 + 0.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 },
  )
  return {
    strategy: c.strategy,
    source: c.sourceLabel,
    density: c.density ?? 1,
    relax: c.relax ?? { boundary: false, repulsion: false },
    gemCount: gems.length,
    dropped: dropped ?? 0,
    gems: gems.map((g) => ({ id: g.id, x: g.x, y: g.y, blockId: g.blockId })),
  }
}

const REGEN = process.env.GOLDEN_REGEN === '1'

describe('engine 黄金快照守卫（v1 引擎采集；1.5/1.6 逐位不变证据面）', () => {
  if (REGEN) {
    it.only(
      'GOLDEN_REGEN=1：再生黄金 fixtures（v1 引擎语义基准）',
      () => {
        mkdirSync(GOLDEN_DIR, { recursive: true })
        for (const c of CASES) {
          const doc = runCase(c)
          writeFileSync(join(GOLDEN_DIR, `${c.name}.json`), JSON.stringify(doc))
        }
        expect(existsSync(join(GOLDEN_DIR, 'cvt-boston.json'))).toBe(true)
      },
      120_000,
    )
  } else {
    for (const c of CASES) {
      it(`${c.name}：同参输出与黄金逐位相等（两次运行互等 + 与 v1 黄金相等）`, { timeout: c.sourceLabel.includes('boston') ? 60_000 : 20_000 }, () => {
        const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${c.name}.json`), 'utf8')) as GoldenDoc
        const first = runCase(c)
        const second = runCase(c)
        // CPU 确定性 oracle：同进程两次运行逐位相等
        expect(second).toEqual(first)
        // 与 v1 引擎黄金逐位相等
        expect(first).toEqual(golden)
        expect(first.gemCount).toBeGreaterThan(0)
      })
    }
  }
})
