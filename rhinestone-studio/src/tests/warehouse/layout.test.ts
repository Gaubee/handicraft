/*
 * 多标准纵向分组流布局（add-stone-library S7.4——design §7.6 性能护栏）。
 * 段堆叠数学（段头偏移/总高/折叠段 0 高）+离屏段空窗口（不放大渲染）+
 * 可见段虚拟窗口平移+viewportH=0 退化（jsdom/首帧）。纯函数直测。
 */

import { describe, expect, it } from 'vitest'
import { flatFlowLayout, flowWindowIndices, FLOW_SECTION_MARGIN, FLOW_SECTION_HEADER_H, WAREHOUSE_CELL_H } from '$lib/warehouse/layout'
import { STONE_GRID_GAP, STONE_GRID_OVERSCAN_ROWS } from '$lib/stonesAdmin/virtual'

const STRIDE = WAREHOUSE_CELL_H + STONE_GRID_GAP // 128（S7.7：行槽=瓦片实际高 116+gap 12）

function params(overrides: Partial<Parameters<typeof flatFlowLayout>[0]> = {}) {
  return {
    sections: [
      { key: 'yuhang', itemCount: 6 },
      { key: 'factoryB', itemCount: 3 },
    ],
    viewportW: 1000,
    viewportH: 500,
    scrollTop: 0,
    cellMinW: 136,
    cellH: WAREHOUSE_CELL_H,
    gap: STONE_GRID_GAP,
    padding: 16,
    overscanRows: STONE_GRID_OVERSCAN_ROWS,
    ...overrides,
  }
}

describe('flatFlowLayout 段堆叠数学', () => {
  it('两段堆叠：首段顶 0；第二段顶=首段高+margin；总高去尾 margin', () => {
    const layout = flatFlowLayout(params())
    expect(layout.sections).toHaveLength(2)
    const [a, b] = layout.sections
    // 1000px 视口 → 6 列：6 项=1 行；3 项=1 行。
    expect(a!.geometry.columns).toBe(6)
    expect(a!.sectionTop).toBe(0)
    expect(a!.gridTop).toBe(FLOW_SECTION_HEADER_H)
    expect(a!.gridHeight).toBe(STRIDE)
    expect(a!.height).toBe(FLOW_SECTION_HEADER_H + STRIDE)
    expect(b!.sectionTop).toBe(a!.height + FLOW_SECTION_MARGIN)
    expect(b!.gridTop).toBe(b!.sectionTop + FLOW_SECTION_HEADER_H)
    expect(layout.totalHeight).toBe(a!.height + FLOW_SECTION_MARGIN + b!.height)
  })

  it('折叠段（itemCount=0）：网格高 0、仅段头占位', () => {
    const layout = flatFlowLayout(params({ sections: [{ key: 'yuhang', itemCount: 0 }, { key: 'factoryB', itemCount: 3 }] }))
    const [a] = layout.sections
    expect(a!.gridHeight).toBe(0)
    expect(a!.height).toBe(FLOW_SECTION_HEADER_H)
    expect(a!.geometry.startRow).toBe(0)
    expect(a!.geometry.endRowExclusive).toBe(0)
  })

  it('空段清单：总高 0 不抛', () => {
    const layout = flatFlowLayout(params({ sections: [] }))
    expect(layout.totalHeight).toBe(0)
    expect(layout.sections).toEqual([])
  })
})

describe('flatFlowLayout 可见性窗口', () => {
  it('离屏段（网格区间与视口不相交）→ 空窗口（渲染零格，只留撑高）', () => {
    // yuhang 600 项（6 列×100 行 gridHeight=12800+段头 44）；滚动越过 factoryB 底 → 两段皆离屏。
    const layout = flatFlowLayout(params({ sections: [{ key: 'yuhang', itemCount: 600 }, { key: 'factoryB', itemCount: 3 }], scrollTop: 21500 }))
    const [a, b] = layout.sections
    expect(b!.geometry.endRowExclusive).toBe(0)
    expect(b!.gridHeight).toBe(STRIDE) // 撑高保留（spacer 语义）
    expect(a!.geometry.endRowExclusive).toBe(0)
  })

  it('视口内段：窗口=可见行+overscan（virtual.ts 数学直通）', () => {
    const layout = flatFlowLayout(params({ sections: [{ key: 'yuhang', itemCount: 600 }] }))
    const [a] = layout.sections
    // scrollTop=0：首行 0，可见 ceil(500/128)=4 行 +overscan 3 → endRow=7。
    expect(a!.geometry.startRow).toBe(0)
    expect(a!.geometry.endRowExclusive).toBe(7)
    expect(flowWindowIndices(a!)).toHaveLength(42)
  })

  it('滚动后窗口平移（段内局部 scrollTop=全局−gridTop）', () => {
    const layout = flatFlowLayout(params({ sections: [{ key: 'yuhang', itemCount: 600 }], scrollTop: FLOW_SECTION_HEADER_H + STRIDE * 30 }))
    const [a] = layout.sections
    expect(a!.geometry.startRow).toBe(27) // 段内局部行 30 − overscan 3
    expect(flowWindowIndices(a!)[0]).toBe(27 * 6)
  })

  it('第二段窗口基于自身 gridTop（全局滚动位换算段内）', () => {
    // 两段各 6 项（1 行）：a gridTop=44/gridBottom=172；b gridTop=184/gridBottom=312。
    // 滚到 320：a 离屏（gridBottom<scrollTop）、b 在视口内（段内局部=320−184=136 → 行 1−overscan 夹回 0）。
    const layout = flatFlowLayout(params({ scrollTop: 320 }))
    const [a, b] = layout.sections
    expect(b!.geometry.startRow).toBe(0)
    expect(a!.geometry.endRowExclusive).toBe(0) // 首段已离屏
  })

  it('viewportH=0（jsdom/首帧）退化：全部段按可见处理（overscan 窗口非空屏）', () => {
    const layout = flatFlowLayout(params({ viewportH: 0, sections: [{ key: 'yuhang', itemCount: 600 }, { key: 'factoryB', itemCount: 3 }] }))
    for (const section of layout.sections) {
      expect(section.geometry.endRowExclusive).toBeGreaterThan(0)
    }
  })
})
