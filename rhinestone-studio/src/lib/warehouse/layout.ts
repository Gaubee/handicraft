/*
 * 多标准纵向分组流布局（add-stone-library S7.4——design §7.6）。
 * 原始需求 2026-09-24：标准平铺区=多标准**纵向分组流**（每标准一段=段头+完整
 * 样卡网格；跨标准对比挑选是核心场景——优于标准页签）。大样卡量级（tuzuan 623
 * +yuhang 259）虚拟滚动：复用 S3.3 virtual.ts 的单段网格窗口数学，本文件把
 * 多段堆叠成单一滚动内容（段高=段头+网格内容高；总高=Σ段高）。
 * 可见性防线：完全离开视口的段渲染**空窗口**（只留撑高 spacer），避免 N 标准
 * × 视口行的隐性放大渲染。
 */

import {
  virtualGridGeometry,
  type VirtualGridGeometry,
  type VirtualGridParams,
} from '$lib/stonesAdmin/virtual'

/** 段头高度（含段内筛选条——固定高，布局常量）。 */
export const FLOW_SECTION_HEADER_H = 44
/** 段间额外分隔（视觉呼吸；不含在段高内，计入下一段 top）。 */
export const FLOW_SECTION_MARGIN = 12
/**
 * 仓储瓦片行槽高=StoneCellTile 实际渲染高（S7.7 走查修复 2026-09-24：此前沿用
 * 管理视图 STONE_CELL_H=196 → 瓦片实际 ~116，行间 ~90px 垂直死空间）。
 * 槽高组成（StoneCellTile 类算术）：border×2=2 + p-1.5×2=12 + 贴图 h-16=64 +
 * gap-1=4 + 文案块（text-xs 行 16 + gap-0.5 2 + 徽标行 h-4 16）=34 → 116。
 * 改 StoneCellTile 结构（贴图高/文案行数/padding）必须同步本常量。
 */
export const WAREHOUSE_CELL_H = 116

export interface FlowSectionInput {
  /** 段键（=supplier——多标准同 SKU 靠限定名区分，段本身按标准分组）。 */
  key: string
  /** 段内条目数（折叠段/空段=0——网格高 0，仅段头）。 */
  itemCount: number
}

export interface FlowSectionLayout {
  key: string
  itemCount: number
  /** 内容坐标：段头绝对顶。 */
  sectionTop: number
  /** 内容坐标：网格画布绝对顶（=sectionTop+headerH）。 */
  gridTop: number
  /** 网格内容高（rows×步进；0 项段=0）。 */
  gridHeight: number
  /** 段总高（headerH+gridHeight）。 */
  height: number
  /** 段内窗口几何（不可见段=空窗口 startRow0/endRowExclusive0）。 */
  geometry: VirtualGridGeometry
}

export interface FlowLayoutParams {
  sections: FlowSectionInput[]
  viewportW: number
  viewportH: number
  scrollTop: number
  cellMinW: number
  cellH: number
  gap: number
  padding: number
  overscanRows: number
  /** 段头高（缺省 FLOW_SECTION_HEADER_H）。 */
  headerH?: number
}

export interface FlowLayout {
  totalHeight: number
  sections: FlowSectionLayout[]
}

/**
 * 纵向分组流布局。viewportH=0（jsdom 首帧未测得）时全部段按可见处理——
 * 与 virtual.ts 的退化窗口语义对齐（overscan 窗口而非空屏），不产生 NaN。
 */
export function flatFlowLayout(params: FlowLayoutParams): FlowLayout {
  const headerH = params.headerH ?? FLOW_SECTION_HEADER_H
  const shared: Omit<VirtualGridParams, 'itemCount' | 'scrollTop'> = {
    viewportW: params.viewportW,
    viewportH: params.viewportH,
    cellMinW: params.cellMinW,
    cellH: params.cellH,
    gap: params.gap,
    padding: params.padding,
    overscanRows: params.overscanRows,
  }
  const sections: FlowSectionLayout[] = []
  let cursor = 0
  for (const section of params.sections) {
    // scrollTop=0 只取列/行几何（columns/columnWidth/rows/totalHeight——与滚动位无关）。
    const base = virtualGridGeometry({ ...shared, itemCount: section.itemCount, scrollTop: 0 })
    const gridHeight = base.totalHeight
    const height = headerH + gridHeight
    sections.push({
      key: section.key,
      itemCount: section.itemCount,
      sectionTop: cursor,
      gridTop: cursor + headerH,
      gridHeight,
      height,
      geometry: base,
    })
    cursor += height + FLOW_SECTION_MARGIN
  }
  // 总高去尾段 margin（尾段下不留缝）。
  const totalHeight = Math.max(0, cursor - (sections.length > 0 ? FLOW_SECTION_MARGIN : 0))

  const viewportH = Math.max(0, params.viewportH)
  const scrollTop = Math.max(0, params.scrollTop)
  for (const section of sections) {
    // 可见判定：网格区间与视口区间相交（viewportH=0 退化=全可见——jsdom/首帧）。
    const visible =
      section.gridHeight > 0 &&
      (viewportH === 0 ||
        (section.gridTop < scrollTop + viewportH && section.gridTop + section.gridHeight > scrollTop))
    if (!visible) {
      section.geometry = { ...section.geometry, startRow: 0, endRowExclusive: 0, padTop: 0 }
      continue
    }
    // 可见段：段内局部 scrollTop（=全局−段顶；段在视口上方时为正且被
    // virtualGridGeometry 夹紧到末行邻域——窗口不悬空）。
    section.geometry = virtualGridGeometry({
      ...shared,
      itemCount: section.itemCount,
      scrollTop: scrollTop - section.gridTop,
    })
  }
  return { totalHeight, sections }
}

/** 段内窗口条目索引展开（行主序；调用方按 itemCount 截断——virtual.ts 同式语义）。 */
export function flowWindowIndices(section: FlowSectionLayout): number[] {
  const indices: number[] = []
  for (let row = section.geometry.startRow; row < section.geometry.endRowExclusive; row += 1) {
    for (let col = 0; col < section.geometry.columns; col += 1) {
      const index = row * section.geometry.columns + col
      if (index >= section.itemCount) break
      indices.push(index)
    }
  }
  return indices
}
