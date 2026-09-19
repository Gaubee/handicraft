/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-19 Perf] 编辑器私有空间索引（grid-hash，cell=pitch）：画布点选命中 / 笔刷邻域 /
 *    视口裁剪共用（design.md §2 性能基线的数据结构落点）。insert/remove 均摊 O(1)，
 *    半径/矩形查询只枚举覆盖桶。
 * 2. [2026-09-19 Pure] 纯 TS 零 runes/DOM——vitest 与暴力法对账（随机点集）证明与 O(n²) 等价。
 */

export interface IndexedItem {
  id: string
  x: number
  y: number
}

/**
 * 网格哈希空间索引。cellSize 契约（gem-catalog tasks 1.1）：调用方传 **maxCellPx**
 * （engine/geometry.ts——(max(diameterMm)+gapMm)×pixelsPerMm）：cell ≥ 文档内任意大小径对
 * 所需距离 → 半径 ≤ maxCellPx 的查询至多扫 3×3 桶（恰跨 cell 边界的邻域对不漏）。
 * 等径文档 maxCellPx = pitch（与 v1 等价）。消费面（EditCanvas 现传 pitchPx 为 v1 过渡——
 * components 域迁移归 studio gate；本类的 cellSize 语义自 1.1 起以上述契约为准）。
 */
export class SpatialIndex<T extends IndexedItem> {
  private readonly cell: number
  private readonly buckets = new Map<string, T[]>()
  /** id → 桶键（remove O(1) 定位；同 id 重复 insert = 先移后放的替换语义） */
  private readonly itemCell = new Map<string, string>()
  private _size = 0

  constructor(cellSize: number) {
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
      throw new Error(`SpatialIndex cellSize 必须为正有限数，收到 ${cellSize}`)
    }
    this.cell = cellSize
  }

  get size(): number {
    return this._size
  }

  private keyOf(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`
  }

  /** 落位（重复 id = 替换旧位置）。item 坐标随后被外部改动时需 remove 后重插。 */
  insert(item: T): void {
    const existing = this.itemCell.get(item.id)
    if (existing !== undefined) this.removeFromBucket(existing, item.id)
    const key = this.keyOf(item.x, item.y)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = []
      this.buckets.set(key, bucket)
    }
    bucket.push(item)
    this.itemCell.set(item.id, key)
    this._size++
  }

  /** 按 id 摘除，返回被摘除项（未命中返回 undefined）。 */
  remove(id: string): T | undefined {
    const key = this.itemCell.get(id)
    if (key === undefined) return undefined
    const bucket = this.buckets.get(key)
    if (!bucket) {
      this.itemCell.delete(id)
      return undefined
    }
    const item = this.removeFromBucket(key, id)
    return item
  }

  has(id: string): boolean {
    return this.itemCell.has(id)
  }

  get(id: string): T | undefined {
    const key = this.itemCell.get(id)
    const bucket = key !== undefined ? this.buckets.get(key) : undefined
    return bucket?.find((it) => it.id === id)
  }

  private removeFromBucket(key: string, id: string): T | undefined {
    const bucket = this.buckets.get(key)
    if (!bucket) return undefined
    const i = bucket.findIndex((it) => it.id === id)
    if (i < 0) return undefined
    const [item] = bucket.splice(i, 1)
    if (bucket.length === 0) this.buckets.delete(key)
    this.itemCell.delete(id)
    this._size--
    return item
  }

  /** 圆域查询（中心距 ≤ r，含边界）。返回顺序不定，调用方按需排序/按 set 对账。 */
  queryCircle(x: number, y: number, r: number): T[] {
    const out: T[] = []
    if (!(r >= 0)) return out
    const r2 = r * r
    this.forEachCell(x - r, y - r, x + r, y + r, (item) => {
      const dx = item.x - x
      const dy = item.y - y
      if (dx * dx + dy * dy <= r2) out.push(item)
    })
    return out
  }

  /** 矩形查询（x0..x1 / y0..y1 闭区间，自动归一颠倒输入）。 */
  queryRect(x0: number, y0: number, x1: number, y1: number): T[] {
    const out: T[] = []
    const loX = Math.min(x0, x1)
    const hiX = Math.max(x0, x1)
    const loY = Math.min(y0, y1)
    const hiY = Math.max(y0, y1)
    this.forEachCell(loX, loY, hiX, hiY, (item) => {
      if (item.x >= loX && item.x <= hiX && item.y >= loY && item.y <= hiY) out.push(item)
    })
    return out
  }

  private forEachCell(
    loX: number,
    loY: number,
    hiX: number,
    hiY: number,
    visit: (item: T) => void,
  ): void {
    const cx0 = Math.floor(loX / this.cell)
    const cx1 = Math.floor(hiX / this.cell)
    const cy0 = Math.floor(loY / this.cell)
    const cy1 = Math.floor(hiY / this.cell)
    const spanX = cx1 - cx0 + 1
    const spanY = cy1 - cy0 + 1
    // 巨型包围盒（如清空后全域查询 / 极端 zoom-out）只枚举已占桶，防 62 亿空桶遍历
    if (spanX * spanY > this.buckets.size) {
      for (const [key, bucket] of this.buckets) {
        const comma = key.indexOf(',')
        const cx = Number(key.slice(0, comma))
        const cy = Number(key.slice(comma + 1))
        if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue
        for (let i = bucket.length - 1; i >= 0; i--) visit(bucket[i])
      }
      return
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.buckets.get(`${cx},${cy}`)
        if (!bucket) continue
        // 桶内倒序拷贝遍历：visit 回调内 insert/remove 同索引不破坏枚举
        for (let i = bucket.length - 1; i >= 0; i--) visit(bucket[i])
      }
    }
  }

  clear(): void {
    this.buckets.clear()
    this.itemCell.clear()
    this._size = 0
  }
}

/** 便利构造：批量插入（画布/基准共用的重建路径）。 */
export function buildSpatialIndex<T extends IndexedItem>(items: readonly T[], cellSize: number): SpatialIndex<T> {
  const index = new SpatialIndex<T>(cellSize)
  for (const it of items) index.insert(it)
  return index
}
