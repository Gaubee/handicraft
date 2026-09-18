/*
 * [2026-09-19 Test] 手动编辑测试共用手具：程序化 ManualEditHandoff（满幅单块 + 六方格位钻）。
 * 脱离 studio 管线构造交接快照——edit store 单测不需要跑 segment/layout。
 */

import { STARTER_PALETTE, gridFromSs, type Block, type EngineImage, type Gem, type GridSpec } from '$lib/engine'
import type { ManualEditHandoff } from '$lib/stores/edit.svelte'

export const TEST_PITCH = 8 // SS10 + 2.5px/mm + gap 0.4 → pitch 8px（引擎标准网格）

export function testGrid(): GridSpec {
  return gridFromSs('SS10', 2.5)
}

/** 满幅单块（0,0,w,h 全 1 掩码；编辑器只读参考用，几何细节不影响 store 语义测试） */
export function fullBlock(w: number, h: number, id = 'blk-1'): Block {
  return {
    id,
    label: `测试块 ${id}`,
    mask: { w, h, bits: new Uint8Array(w * h).fill(1) },
    colorRgb: [200, 16, 46],
    areaPx: w * h,
    bbox: { x: 0, y: 0, w, h },
    widthPx: { max: Math.min(w, h), mean: Math.min(w, h) },
    suggested: 'fill',
  }
}

/** 纯色像素快照（红色），尺寸 w×h */
export function solidImage(w: number, h: number): EngineImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200
    data[i + 1] = 16
    data[i + 2] = 46
    data[i + 3] = 255
  }
  return { width: w, height: h, data }
}

/** 六方格位钻（pitch 8，jitter=0 确定性）；gemCount 颗，id 沿用 layout 的 g##### 形态 */
export function hexGems(gemCount: number, blockId = 'blk-1'): Gem[] {
  const gems: Gem[] = []
  const pitch = TEST_PITCH
  const cols = Math.ceil(gemCount / Math.max(1, Math.ceil(gemCount / 64)))
  let row = 0
  while (gems.length < gemCount) {
    const offset = row % 2 === 0 ? 0 : pitch / 2
    for (let col = 0; col < cols && gems.length < gemCount; col++) {
      gems.push({
        id: `g${String(gems.length + 1).padStart(5, '0')}`,
        x: 4 + col * pitch + offset,
        y: 4 + row * pitch * 0.866,
        colorId: STARTER_PALETTE[gems.length % STARTER_PALETTE.length].id,
        blockId,
      })
    }
    row++
  }
  return gems
}

/** 标准测试交接：64×64 单块 + hexGems(count) + 起步色板 */
export function makeHandoff(gemCount = 12, overrides: Partial<ManualEditHandoff> = {}): ManualEditHandoff {
  return {
    gems: hexGems(gemCount),
    blocks: [fullBlock(64, 64)],
    palette: STARTER_PALETTE.map((c) => ({ ...c })),
    grid: testGrid(),
    width: 64,
    height: 64,
    sourceSummary: '六方抽稀 · 密度 100% · SS10 · 12 钻',
    paintingSnapshot: solidImage(64, 64),
    ...overrides,
  }
}

/** 深快照（plain 对象数组，供 JSON 对账） */
export function plainGems(gems: ReadonlyArray<unknown>): unknown[] {
  return JSON.parse(JSON.stringify(gems))
}
