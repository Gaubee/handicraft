/**
 * [gem-catalog engine gate 1.5] CPU CVT 优化（路线 a：同序定容网格 + 扁平 pair 缓冲）：
 * - **输出逐位不变**：黄金守卫（engineGolden.test，v1 引擎动工前采集）覆盖 6 组 cvt 形态
 *   （120² 五策略基线含 cvt×3、96×64 双矩、400² boston 高细节、boston+relax 最坏组合）——
 *   本文件不再重复快照断言；
 * - 同参快照确定性断言（CPU deterministic oracle）：512² 合成高细节图两次运行 JSON 全等；
 * - 计时基准：512² 默认档（宽松上限，CI 抖动余量）；1024² 慢速档由 CVT_PERF_1024=1 显式开启
 *   （阈值 <10s——gpu-research §7 P0-1 目标；43.1s 基线疑含负载，本机安静基线 15-25s，
 *   研发复现命令见 .agents/documents/2026-09-19-gem-catalog/cvt-optimization-research.md §5）。
 *
 * 合成图为研究稿 gen.ts 的 high 类逐语句副本（数字油画式高细节：8 色放射楔 + 同心环带 +
 * 2px 细弧 + 径向细线 + 点阵 + 棋盘噪声——确定性，无 Math.random）。
 */

import { describe, expect, it } from 'vitest'
import { gridFromSs, layout, segment } from '$lib/engine'
import type { EngineImage } from '$lib/engine'

const PALETTE: Array<[number, number, number]> = [
  [220, 60, 60],
  [60, 80, 220],
  [60, 180, 90],
  [230, 200, 60],
  [200, 70, 180],
  [70, 190, 200],
  [235, 140, 50],
  [120, 70, 200],
  [245, 245, 245],
  [40, 40, 45],
]

/** 研究稿 gen.ts 的 high 类（确定性高细节合成——逐语句副本，标注对照）。 */
function genHigh(S: number): EngineImage {
  const data = new Uint8ClampedArray(S * S * 4)
  const cx = (S - 1) / 2
  const cy = (S - 1) / 2
  const put = (i: number, c: [number, number, number]) => {
    data[i * 4] = c[0]
    data[i * 4 + 1] = c[1]
    data[i * 4 + 2] = c[2]
    data[i * 4 + 3] = 255
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx
      const dy = y - cy
      const r = Math.sqrt(dx * dx + dy * dy)
      const ang = Math.atan2(dy, dx) + Math.PI
      const wob = Math.sin(ang * 3 + r * 0.02) * 0.18
      let aw = ang + wob
      if (aw < 0) aw += 2 * Math.PI
      if (aw >= 2 * Math.PI) aw -= 2 * Math.PI
      const wedge = Math.floor((aw / (2 * Math.PI)) * 8) % 8
      let c = PALETTE[wedge]
      const band = Math.floor(r / 80) % 4
      if (r > S * 0.18 && r < S * 0.48) c = PALETTE[4 + band]
      for (const rr of [S * 0.16, S * 0.34, S * 0.46]) {
        if (Math.abs(r - rr) < 1) c = PALETTE[9]
      }
      const angDeg = (ang * 180) / Math.PI
      if (Math.abs(((angDeg % 30) + 30) % 30) < 0.35 && r > S * 0.5) c = PALETTE[9]
      if (x < S / 4 && y < S / 4) {
        c = PALETTE[8]
        const gx = x % 22
        const gy = y % 22
        if ((gx - 11) ** 2 + (gy - 11) ** 2 <= 9) c = PALETTE[9]
      }
      if (x >= S * 0.8 && y >= S * 0.8) {
        c = ((x >> 3) + (y >> 3)) % 2 === 0 ? PALETTE[5] : PALETTE[6]
      }
      put(y * S + x, c)
    }
  }
  return { width: S, height: S, data }
}

function runCvt(S: number, relax: boolean): { ms: number; gemCount: number; snapshot: string } {
  const blocks = segment(genHigh(S), { k: 8, seed: 1, gemDiameterPx: 7 })
  const grid = gridFromSs('SS10', 2.5) // pitch 8px（研究稿同参）
  const opts = relax
    ? { density: 1, seed: 1, relax: { boundary: true, repulsion: true } }
    : { density: 1, seed: 1, relax: { boundary: false, repulsion: false } }
  const t0 = performance.now()
  const { gems } = layout(blocks, 'cvt', opts, grid)
  const ms = performance.now() - t0
  return {
    ms,
    gemCount: gems.length,
    snapshot: JSON.stringify(gems.map((g) => [g.id, g.x, g.y, g.blockId])),
  }
}

describe('CPU CVT 优化（路线 a：输出逐位不变 + 计时）', () => {
  it('512² 高细节：同参快照确定性（两次运行 JSON 全等——CPU oracle）+ 计时宽松上限', () => {
    const first = runCvt(512, false)
    const second = runCvt(512, false)
    expect(second.snapshot).toBe(first.snapshot) // 同参确定性 oracle
    expect(first.gemCount).toBeGreaterThan(1000)
    // 宽松上限（CI 抖动；研究基线 512² 优化前 ~2-4s，优化后 ~1s 量级）
    expect(first.ms, `512² cvt 应 < 15s（实测 ${first.ms.toFixed(0)}ms）`).toBeLessThan(15_000)
  }, 120_000)

  it('512² + relax 最坏组合：确定性 + 宽松计时', () => {
    const first = runCvt(512, true)
    const second = runCvt(512, true)
    expect(second.snapshot).toBe(first.snapshot)
    expect(first.ms, `512² cvt+relax 应 < 20s（实测 ${first.ms.toFixed(0)}ms）`).toBeLessThan(20_000)
  }, 180_000)

  // 1024² 慢速档：CVT_PERF_1024=1 显式开启（研发复现口径：43.1s 基线 → 目标 <10s）
  const run1024 = process.env.CVT_PERF_1024 === '1'
  ;(run1024 ? it : it.skip)(
    '1024² 高细节 + relax：P0 目标 <10s（gpu-research §7 P0-1；显式开启档）',
    () => {
      const plain = runCvt(1024, false)
      console.log(`[cvt-perf] 1024² high cvt: ${plain.ms.toFixed(0)}ms (${plain.gemCount} gems)`)
      expect(plain.ms, `1024² cvt 应 <10s（实测 ${plain.ms.toFixed(0)}ms）`).toBeLessThan(10_000)
      const worst = runCvt(1024, true)
      console.log(`[cvt-perf] 1024² high cvt+relax: ${worst.ms.toFixed(0)}ms (${worst.gemCount} gems)`)
      expect(worst.ms, `1024² cvt+relax 应 <10s（实测 ${worst.ms.toFixed(0)}ms）`).toBeLessThan(10_000)
    },
    300_000,
  )
})
