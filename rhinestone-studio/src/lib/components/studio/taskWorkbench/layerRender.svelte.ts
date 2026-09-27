/*
 * 图层渲染语义层（rework-layer-model design §1/§3——v4 PS 化渲染模型）。
 *
 * 来源与时间戳：openspec/changes/rework-layer-model/design.md §1/§3（v4 波 1 初始
 * 实现 2026-09-27）；v4 修复轮 F8a（2026-09-28，Codex P2-5——/tmp/codex-layer-model-
 * v4-review.md）修 GemSpatialIndex 桶边界漏报（钻心单桶登记→半径覆盖所有桶）。
 *
 * 模型：渲染序=树前序（父先子后=DOM 序=z 序，父层=底层）；图层=抠图位图
 * （cutout.svelte）+钻子层（gems 画在所属层坐标系——blockId=该节点）；显隐传递
 * （层隐藏→其钻+树后代渲染一并跳过——PS 语义）。背景层=原图（独立可隐藏）。
 *
 * 本模块承载纯派生件：渲染行类型/numbered 组色板/钻空间索引（hover 单颗命中）。
 * 行集派生在 store.svelte.ts（直接读其 $state——避免循环依赖）。
 */

import type { ObjectNode } from '@handicraft/contracts'
import type { CanvasGem } from '$lib/components/strategy/canvasModel.js'

/** numbered 模式分组色板（v3 StrategyCanvas 同款——组色=图层分组可读性锚）。 */
export const GEM_GROUP_PALETTE = [
  '#DC2626', '#D97706', '#059669', '#2563EB', '#7C3AED', '#DB2777',
  '#0891B2', '#65A30D', '#EA580C', '#4F46E5', '#0D9488', '#B45309',
] as const

/** 图层渲染行（树前序——DOM 序=z 序）。 */
export interface LayerRenderRow {
  node: ObjectNode
  /** 显隐传递投影（自身与全部祖先均可见才 true——隐藏层连其钻与后代整树跳过）。 */
  visible: boolean
  /** 该层钻（blockId=该节点；画布 px 坐标——绘制时换算层内坐标）。 */
  gems: CanvasGem[]
  /** numbered 模式分组（有钻才有组；组号=渲染序首现序）。 */
  groupNo: number | null
  groupColor: string | null
  /** 该层钻的全局编号基（树前序可见钻累计——numbered 逐孔标号/图例区间共用）。 */
  gemsStart: number
  /** 排除语义（exclusion 指派或 drillWorthy=false——钻渲染面为空，命中/警示用）。 */
  excluded: boolean
  /** 蒙版叠加行程（showMasks 开启且位面就绪时——画布 px 坐标；缺省 null）。 */
  maskRuns: Array<{ x: number; y: number; w: number; h: number }> | null
}

/** 图层渲染模型（工作台主画布喂数——null=空态）。 */
export interface LayerRenderModel {
  imagePx: { width: number; height: number }
  /** 树前序渲染行（含不可见行——visible 由消费方跳过渲染；保持序稳定）。 */
  rows: LayerRenderRow[]
  /** 可见钻总数（状态栏/计数面）。 */
  gemsVisible: number
  ppm: { ppm: number; exact: boolean }
  sourceUrl: string | null
}

/** 空间索引桶边（px——桶≈最大钻直径量级；粗桶+桶内精测半径）。 */
const GEM_BUCKET_PX = 64

export interface GemHit {
  gem: CanvasGem
  nodeId: string
  /** 命中钻的层内坐标（px）。 */
  lx: number
  ly: number
}

/**
 * 钻空间索引（hover 单颗命中——design §3）：桶网格（64px 桶）+桶内欧氏精测。
 * 按渲染行逆序建桶（后建者=DOM 上层——命中取桶序末位=最上层钻）。
 * F8a（Codex P2-5 桶边界漏报）：钻登记到**半径覆盖的所有桶**（外接方块
 * [x−r,x+r]×[y−r,y+r] 相交的桶全集，每桶一次）——查询点所在桶必含覆盖该点的
 * 钻（单桶查询即可命中；旧实现只登记钻心所在桶，跨桶钻漏报）。同一钻跨多桶
 * 不影响 z 序（桶内相对序=行序，各桶独立一致）。
 */
export class GemSpatialIndex {
  private readonly buckets = new Map<string, GemHit[]>()
  private readonly rowsVisible: ReadonlyArray<{ nodeId: string; bbox: ObjectNode['bbox']; hits: GemHit[] }>

  constructor(rows: ReadonlyArray<LayerRenderRow>) {
    const visible: Array<{ nodeId: string; bbox: ObjectNode['bbox']; hits: GemHit[] }> = []
    for (const row of rows) {
      if (!row.visible || row.gems.length === 0) continue
      const hits: GemHit[] = row.gems.map((gem) => ({
        gem,
        nodeId: row.node.id,
        lx: gem.x - row.node.bbox.x,
        ly: gem.y - row.node.bbox.y,
      }))
      for (const hit of hits) {
        // 半径覆盖的所有桶（外接方块相交桶全集——F8a）
        const bx0 = Math.floor((hit.gem.x - hit.gem.radiusPx) / GEM_BUCKET_PX)
        const bx1 = Math.floor((hit.gem.x + hit.gem.radiusPx) / GEM_BUCKET_PX)
        const by0 = Math.floor((hit.gem.y - hit.gem.radiusPx) / GEM_BUCKET_PX)
        const by1 = Math.floor((hit.gem.y + hit.gem.radiusPx) / GEM_BUCKET_PX)
        for (let bx = bx0; bx <= bx1; bx += 1) {
          for (let by = by0; by <= by1; by += 1) {
            const key = `${bx}:${by}`
            const bucket = this.buckets.get(key) ?? []
            // 逆行序入桶（首行先入——后行 push 末位；命中取末位=上层）
            bucket.push(hit)
            this.buckets.set(key, bucket)
          }
        }
      }
      visible.push({ nodeId: row.node.id, bbox: row.node.bbox, hits })
    }
    this.rowsVisible = visible
  }

  private keyOf(x: number, y: number): string {
    return `${Math.floor(x / GEM_BUCKET_PX)}:${Math.floor(y / GEM_BUCKET_PX)}`
  }

  /** 画布 px 坐标 → 最上层命中钻（半径内；否则 null）。 */
  hitTest(x: number, y: number): GemHit | null {
    const bucket = this.buckets.get(this.keyOf(x, y))
    if (bucket === undefined) return null
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const hit = bucket[i]!
      // 同一钻可入多桶（F8a 半径覆盖登记）——桶内可能重复？每桶登记一次，无重复；
      // 半径精测按最近命中即返回（桶序末位=上层）。
      const dx = hit.gem.x - x
      const dy = hit.gem.y - y
      if (dx * dx + dy * dy <= hit.gem.radiusPx * hit.gem.radiusPx) return hit
    }
    return null
  }
}

/** 行集可见钻计数（状态栏读数）。 */
export function countVisibleGems(rows: ReadonlyArray<LayerRenderRow>): number {
  let total = 0
  for (const row of rows) if (row.visible) total += row.gems.length
  return total
}
