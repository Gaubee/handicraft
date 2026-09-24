/*
 * marquee 框选命中数学（add-stone-library S7.4——design §7.6 框选）。
 * 边界（接触即命中）/负向拖拽（左上方向）/缩放视口（CSS transform scale 指针
 * 位移换算）/行跨度扫描（部分重叠）/退化矩形。纯函数直测（无 DOM）。
 */

import { describe, expect, it } from 'vitest'
import { cellBoxInGrid, marqueeHitIndices, marqueeRectFromPointer, normalizeRect, rectsIntersect } from '$lib/warehouse/marquee'
import { WAREHOUSE_CELL_H } from '$lib/warehouse/layout'

const GEO = { columns: 4, rows: 3, columnWidth: 136, startRow: 0, endRowExclusive: 3 }
// S7.7：生产行槽高=WAREHOUSE_CELL_H（瓦片实际高）——命中数学跟常量走，改槽高不脱钩。
const METRICS = { cellH: WAREHOUSE_CELL_H, gap: 12, padding: 16 }
const STRIDE = METRICS.cellH + METRICS.gap // 128

describe('normalizeRect（任意方向拖拽归一化）', () => {
  it('右下拖（正向）', () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({ x: 10, y: 20, w: 100, h: 200 })
  })

  it('左上拖（负向 delta——起点右下、终点左上）', () => {
    expect(normalizeRect({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 100, h: 200 })
  })

  it('左下/右上拖同样归一', () => {
    expect(normalizeRect({ x: 100, y: 10 }, { x: 0, y: 200 })).toEqual({ x: 0, y: 10, w: 100, h: 190 })
    expect(normalizeRect({ x: 0, y: 200 }, { x: 100, y: 10 })).toEqual({ x: 0, y: 10, w: 100, h: 190 })
  })

  it('零位移（点击未拖动）→ 退化矩形 w/h=0', () => {
    expect(normalizeRect({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, w: 0, h: 0 })
  })
})

describe('marqueeRectFromPointer（缩放视口换算）', () => {
  it('scale=1 缺省=指针位移直通', () => {
    expect(marqueeRectFromPointer({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 0, y: 0, w: 100, h: 50 })
  })

  it('scale=2：指针位移÷2=内容位移（放大容器内拖 200px 内容跨 100px）', () => {
    expect(marqueeRectFromPointer({ x: 40, y: 20 }, { x: 240, y: 120 }, 2)).toEqual({ x: 20, y: 10, w: 100, h: 50 })
  })

  it('scale=0.5（缩小容器）：内容位移=指针位移×2', () => {
    expect(marqueeRectFromPointer({ x: 0, y: 0 }, { x: 50, y: 25 }, 0.5)).toEqual({ x: 0, y: 0, w: 100, h: 50 })
  })

  it('非法 scale（0/负）按 1 处理不抛', () => {
    expect(marqueeRectFromPointer({ x: 0, y: 0 }, { x: 30, y: 30 }, 0)).toEqual({ x: 0, y: 0, w: 30, h: 30 })
    expect(marqueeRectFromPointer({ x: 0, y: 0 }, { x: 30, y: 30 }, -2)).toEqual({ x: 0, y: 0, w: 30, h: 30 })
  })
})

describe('rectsIntersect（闭区间——边界接触算命中）', () => {
  it('重叠', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
  })

  it('右边界恰好接触（x=10 == b.x）→ 命中', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(true)
  })

  it('右边界外一点（x=10.01 > b.x）→ 不命中', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10.01, y: 0, w: 10, h: 10 })).toBe(false)
  })

  it('上下边界接触命中、越界不命中', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 10, w: 10, h: 10 })).toBe(true)
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 10.5, w: 10, h: 10 })).toBe(false)
  })

  it('零面积矩形与包含点的 bbox 接触命中', () => {
    expect(rectsIntersect({ x: 5, y: 5, w: 0, h: 0 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(true)
  })
})

describe('cellBoxInGrid（网格局部 bbox——窗口无关稳定式）', () => {
  it('首格（0,0）=pad 原点', () => {
    expect(cellBoxInGrid(0, GEO, METRICS)).toEqual({ x: 16, y: 0, w: 136, h: METRICS.cellH })
  })

  it('行末换行（index=4 → row1 col0）y=步进', () => {
    expect(cellBoxInGrid(4, GEO, METRICS)).toEqual({ x: 16, y: STRIDE, w: 136, h: METRICS.cellH })
  })

  it('同行第二列 x=pad+列步进', () => {
    expect(cellBoxInGrid(1, GEO, METRICS)).toEqual({ x: 16 + 148, y: 0, w: 136, h: METRICS.cellH })
  })
})

describe('marqueeHitIndices（矩形∩cell bbox 命中）', () => {
  it('整行框选：第一行 4 列全中', () => {
    const rect = { x: 0, y: 0, w: 1000, h: METRICS.cellH }
    expect(marqueeHitIndices(rect, GEO, 12, METRICS)).toEqual([0, 1, 2, 3])
  })

  it('部分行覆盖（半行高）：仍全行命中（bbox 与矩形相交即中）', () => {
    // [60,110] 只交首行（首行 bbox [0,116)，次行顶 128）——部分覆盖仍算整行命中。
    const rect = { x: 0, y: 60, w: 1000, h: 50 }
    expect(marqueeHitIndices(rect, GEO, 12, METRICS)).toEqual([0, 1, 2, 3])
  })

  it('列跨度裁剪：只覆盖前两列', () => {
    const rect = { x: 0, y: 0, w: 16 + 148 + 136, h: METRICS.cellH }
    expect(marqueeHitIndices(rect, GEO, 12, METRICS)).toEqual([0, 1])
  })

  it('跨两行框选：8 格全中', () => {
    const rect = { x: 0, y: 0, w: 1000, h: STRIDE + METRICS.cellH }
    expect(marqueeHitIndices(rect, GEO, 12, METRICS)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('负向拖拽（终点左上）等价命中——归一化后同一矩形', () => {
    const rect = marqueeRectFromPointer({ x: 1000, y: STRIDE + METRICS.cellH }, { x: 0, y: 0 })
    expect(marqueeHitIndices(rect, GEO, 12, METRICS)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('行间隙（gap 带）：矩形落在带内不命中任何行；边界恰好接触=单行命中', () => {
    // y=[cellH,STRIDE) 是第一行底与第二行顶的 gap 带；带内正高矩形与两行 bbox 皆不相交。
    expect(marqueeHitIndices({ x: 16, y: METRICS.cellH + 6, w: 136, h: 4 }, GEO, 12, METRICS)).toEqual([])
    // 零高矩形贴第一行底边（y=cellH）→ 只命中行 0。
    expect(marqueeHitIndices({ x: 16, y: METRICS.cellH, w: 136, h: 0 }, GEO, 12, METRICS)).toEqual([0])
    // 贴第二行顶边（y=STRIDE）→ 只命中行 1。
    expect(marqueeHitIndices({ x: 16, y: STRIDE, w: 136, h: 0 }, GEO, 12, METRICS)).toEqual([4])
  })

  it('itemCount 尾行截断（12 格 4 列 3 行，itemCount=6 → 尾部只 2 格在第 1 行）', () => {
    const rect = { x: 0, y: STRIDE, w: 1000, h: METRICS.cellH }
    expect(marqueeHitIndices(rect, GEO, 6, METRICS)).toEqual([4, 5])
  })

  it('空集（itemCount=0 / 列数 0）→ 空', () => {
    expect(marqueeHitIndices({ x: 0, y: 0, w: 100, h: 100 }, GEO, 0, METRICS)).toEqual([])
    expect(marqueeHitIndices({ x: 0, y: 0, w: 100, h: 100 }, { ...GEO, columns: 0 }, 12, METRICS)).toEqual([])
  })

  it('网格外矩形（y 超尾行）→ 空', () => {
    expect(marqueeHitIndices({ x: 0, y: STRIDE * 3 + 10, w: 1000, h: 50 }, GEO, 12, METRICS)).toEqual([])
  })
})
