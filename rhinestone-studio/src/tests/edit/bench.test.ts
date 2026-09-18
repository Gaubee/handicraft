/*
 * [2026-09-19 Test] tasks 4.2：只读画布性能基线（vitest 计时，非真渲染）。
 * 量化三件事：① 空间索引构建 ② 命中/视口查询 ③ 四层合成 draw 调用数与绘制计划成本。
 * 真实帧率留浏览器走查；此处用宽松上限断言抓病态回归，数字进任务报告。
 */

import { describe, expect, it } from 'vitest'
import { STARTER_PALETTE, gemRadiusPx, gridFromSs, pitchPx } from '$lib/engine'
import { buildSpatialIndex, type IndexedItem } from '$lib/edit/spatialIndex'
import {
  countCompositeDrawCalls,
  isDetailedLod,
  planGemDraws,
  viewportFromView,
} from '$lib/edit/renderPlan'
import type { EditGem } from '$lib/engine'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 六方密排钻集（pitch 8 + ±0.5px 抖动，逼近 layout 真实分布） */
function hexGems(count: number): EditGem[] {
  const rnd = mulberry32(7)
  const pitch = 8
  const cols = Math.ceil(Math.sqrt(count * (Math.sqrt(3) / 2)))
  const gems: EditGem[] = []
  let row = 0
  while (gems.length < count) {
    const offset = row % 2 === 0 ? 0 : pitch / 2
    for (let col = 0; col < cols && gems.length < count; col++) {
      gems.push({
        id: `g${gems.length + 1}`,
        x: col * pitch + offset + (rnd() - 0.5),
        y: row * pitch * 0.866 + (rnd() - 0.5),
        colorId: STARTER_PALETTE[gems.length % STARTER_PALETTE.length].id,
        blockId: 'blk-1',
        origin: 'layout',
        moved: false,
      })
    }
    row++
  }
  return gems
}

/** 稳健计时：runs 次取最小值（最小值对噪声最不敏感） */
function timeMin(fn: () => void, runs = 5): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

const SIZES = [1_000, 10_000, 20_000] as const
const CANVAS_W = 600
const CANVAS_H = 420

/** 两档典型视口：fit（全图可见）与 zoom 4×（局部放大） */
function viewportsFor(gemCount: number): Array<{ label: string; view: { scale: number; x: number; y: number } }> {
  const span = Math.ceil(Math.sqrt(gemCount * 55.4)) // 六方足迹面积近似
  const fit = Math.min(CANVAS_W / span, CANVAS_H / span) * 0.9
  return [
    { label: 'fit(全图)', view: { scale: fit, x: (CANVAS_W - span * fit) / 2, y: (CANVAS_H - span * fit) / 2 } },
    { label: 'zoom4(局部)', view: { scale: 4, x: -CANVAS_W / 2, y: -CANVAS_H / 2 } },
  ]
}

describe('只读画布性能基线（tasks 4.2）', () => {
  const grid = gridFromSs('SS10', 2.5)
  const pitch = pitchPx(grid)
  const radius = gemRadiusPx(grid)
  const palette = STARTER_PALETTE.map((c) => ({ ...c }))
  const rnd = mulberry32(11)

  const rows: string[] = ['钻数 | 索引构建(ms) | 圆命中×1k均值(ms) | 视口fit:可见/查询(ms)/draw调用 | 视口zoom4:可见/查询(ms)/draw调用']

  for (const n of SIZES) {
    it(`${n.toLocaleString()} 钻：构建/命中/裁剪/绘制计划基准`, () => {
      const gems = hexGems(n)
      expect(gems).toHaveLength(n)

      // ① 索引构建
      const buildMs = timeMin(() => buildSpatialIndex(gems as IndexedItem[], pitch))
      const index = buildSpatialIndex(gems as IndexedItem[], pitch)

      // ② 圆命中查询（笔刷点选路径：r = 1.5×钻半径）
      const hitR = radius * 1.5
      const hitMs = timeMin(() => {
        for (let q = 0; q < 1000; q++) {
          const x = rnd() * (n === 1000 ? 240 : 740)
          const y = rnd() * (n === 1000 ? 240 : 740)
          index.queryCircle(x, y, hitR)
        }
      })
      const hitAvg = hitMs / 1000

      // ③ 视口裁剪 + LOD 绘制计划 + draw 调用数（painting/reference/blocks 3 张缓存层 + 钻面 + 选中环）
      const cells: number[] = []
      const queries: number[] = []
      const draws: number[] = []
      const plans: number[] = []
      for (const vp of viewportsFor(n)) {
        const viewport = viewportFromView(vp.view, CANVAS_W, CANVAS_H)
        const queryMs = timeMin(() => {
          index.queryRect(viewport.x0 - radius, viewport.y0 - radius, viewport.x1 + radius, viewport.y1 + radius)
        })
        const visible = index.queryRect(viewport.x0 - radius, viewport.y0 - radius, viewport.x1 + radius, viewport.y1 + radius)
        const detailed = isDetailedLod(radius * 2, vp.view.scale)
        const planMs = timeMin(() => planGemDraws(visible as EditGem[], palette, { gemRadius: radius, detailed }))
        const ops = planGemDraws(visible as EditGem[], palette, { gemRadius: radius, detailed })
        const total = countCompositeDrawCalls(3, ops.length, 1)
        cells.push(visible.length)
        queries.push(queryMs)
        draws.push(total)
        plans.push(planMs)
        // 裁剪正确性对账（暴力法）
        const brute = gems.filter((g) => g.x >= viewport.x0 - radius && g.x <= viewport.x1 + radius && g.y >= viewport.y0 - radius && g.y <= viewport.y1 + radius)
        expect(visible.length, `${n} 钻 ${vp.label} 视口裁剪与暴力法一致`).toBe(brute.length)
      }

      rows.push(
        `${n.toLocaleString()} | ${buildMs.toFixed(2)} | ${hitAvg.toFixed(5)} | ` +
          `${cells[0].toLocaleString()}/${queries[0].toFixed(2)}ms/${draws[0].toLocaleString()}(LOD点档=${!isDetailedLod(radius * 2, viewportsFor(n)[0].view.scale)}) | ` +
          `${cells[1].toLocaleString()}/${queries[1].toFixed(2)}ms/${draws[1].toLocaleString()}(LOD圆档=${isDetailedLod(radius * 2, 4)}) 计划${plans[1].toFixed(2)}ms`,
      )

      // 宽松上限断言（抓病态回归；真机数字远低于此）
      expect(buildMs, `${n} 钻索引构建应 < 2000ms`).toBeLessThan(2000)
      expect(hitAvg, `${n} 钻单次圆命中应 < 0.5ms`).toBeLessThan(0.5)
      expect(queries[0] + queries[1], `${n} 钻视口查询应 < 50ms`).toBeLessThan(50)
    })
  }

  it('基准数字汇总（入报告）', () => {
    // eslint-disable-next-line no-console
    console.log(`\n[性能基线] 画布 ${CANVAS_W}×${CANVAS_H} · SS10 pitch=${pitch}px 钻径=${radius * 2}px\n${rows.join('\n')}`)
    expect(rows.length).toBe(SIZES.length + 1)
  })
})
