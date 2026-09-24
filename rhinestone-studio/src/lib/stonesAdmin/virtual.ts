/*
 * 样卡网格虚拟滚动几何（add-stone-library S3.3——design §7.6 性能护栏）。
 * 原始需求 2026-09-24：大样卡平铺（钰航 259 + tuzuan 623 量级）必须虚拟滚动——
 * 只渲染可视窗口 + overscan 行。纯函数（无 DOM 依赖），jsdom 直测数学；
 * 组件层把测得的容器尺寸/scrollTop 喂进来。
 */

/** 网格单元格几何常量（固定单元格虚拟化的前提——样卡卡位统一尺寸）。 */
export const STONE_CELL_MIN_W = 136
export const STONE_CELL_H = 196
export const STONE_GRID_GAP = 12
export const STONE_GRID_PAD = 16
/** 可视窗口外预渲染行数（滚动方向急转时的空白缓冲）。 */
export const STONE_GRID_OVERSCAN_ROWS = 3

export interface VirtualGridParams {
  itemCount: number
  viewportW: number
  viewportH: number
  scrollTop: number
  /** 单元格最小宽（列数=floor 可容纳数，实际列宽拉伸填满）。 */
  cellMinW: number
  cellH: number
  gap: number
  padding: number
  overscanRows: number
}

export interface VirtualGridGeometry {
  /** 列数（≥1——viewportW 非法/为零时退化单列，窗口数学仍闭合）。 */
  columns: number
  /** 总行数。 */
  rows: number
  /** 撑高容器用总高（px）。 */
  totalHeight: number
  /** 窗口起始行（含 overscan，夹紧 [0, rows)）。 */
  startRow: number
  /** 窗口结束行（不含；夹紧 ≤ rows）。 */
  endRowExclusive: number
  /** 窗口首行距顶偏移（px）——绝对定位单元的 translate 基准。 */
  padTop: number
  /** 实际列宽（拉伸填满：均分剩余宽度，≥ cellMinW）。 */
  columnWidth: number
}

/**
 * 平铺网格虚拟窗口几何。 scrollTop 负值按 0；viewportH 为 0（首帧未测得/jsdom）
 * 仍产出 overscan 窗口（可见 0 行 + overscan），不产生 NaN。
 */
export function virtualGridGeometry(params: VirtualGridParams): VirtualGridGeometry {
  const { itemCount, cellH, overscanRows } = params
  const viewportW = Math.max(0, params.viewportW)
  const viewportH = Math.max(0, params.viewportH)
  const scrollTop = Math.max(0, params.scrollTop)
  const track = viewportW - params.padding * 2
  const columns = Math.max(1, Math.floor((track + params.gap) / (params.cellMinW + params.gap)))
  const columnWidth = Math.max(params.cellMinW, (track - params.gap * (columns - 1)) / columns)
  const rows = Math.ceil(itemCount / columns)
  const totalHeight = rows * (cellH + params.gap)
  const firstVisible = Math.floor(scrollTop / (cellH + params.gap))
  const visibleRows = Math.ceil(viewportH / (cellH + params.gap))
  // 双端夹紧：超尾滚动时 startRow 封顶 rows-1（窗口退化为末行邻域，不悬空）。
  const startRow = Math.max(0, Math.min(firstVisible - overscanRows, Math.max(0, rows - 1)))
  const endRowExclusive = Math.min(rows, firstVisible + Math.max(1, visibleRows) + overscanRows)
  return {
    columns,
    rows,
    totalHeight,
    startRow,
    endRowExclusive,
    padTop: startRow * (cellH + params.gap),
    columnWidth,
  }
}

/** 窗口内条目索引展开（行主序：startRow..endRowExclusive × columns）。 */
export function virtualWindowIndices(geometry: VirtualGridParams): number[] {
  const geo = virtualGridGeometry(geometry)
  const indices: number[] = []
  for (let row = geo.startRow; row < geo.endRowExclusive; row += 1) {
    for (let col = 0; col < geo.columns; col += 1) {
      const index = row * geo.columns + col
      if (index >= geometry.itemCount) break
      indices.push(index)
    }
  }
  return indices
}
