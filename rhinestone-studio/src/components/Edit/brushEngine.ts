/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 D-5.5 rename-and-expert-workbench] 笔刷算法落地：消费 C-3.3 意图流
 *    （onBrushStroke）——draw = 落点生成手工钻（makeBrushGem 源头戳规格：shapeId/
 *    diameterMm/colorId 物化 + origin='manual'，同 layout makeGem 源头物化纪律）；
 *    erase = 命中删除（1.5×钻半径命中圈，与画布点选同口径）；一笔 = 单 undo 组
 *    （beginStroke/endStroke，空笔组丢弃——store 既有语义）。
 * 2. [2026-09-20 D-5.5] 冲突拒画：逐点 pairwise 判据（requiredCenterDistancePx×0.999
 *    ——与 validateEditable/exportGate 同判据同容差；落钻永不自产 spacing 违规）；
 *    拒画点经 workbench.setBrushRejections 闪红读数（画布绘红 X）。「画钻笔刷 snap
 *    六方格位」语义 = 手势层（EditCanvas brushPointFor）已按格位吸附，本算法消费吸附点；
 *    snap=free 时落点原样（同样过 pairwise 门）。
 * 3. [2026-09-20 Perf/Pure] 空间索引邻域判定（spatialIndex——cell=maxCellPx 契约，
 *    含笔刷径并入取 max）：起笔一次建索引 O(n)，逐点 3×3 桶查询；本笔内新增钻单独
 *    线性查（笔内钻数远小于全集）；擦除幽灵项（本笔已删）按 id 过滤。
 */

import {
  baseSpecDiameterMm,
  effectiveSpecOf,
  isBuiltinShapeId,
  maxCellPx,
  requiredCenterDistancePx,
  type EditGem,
  type PairwiseSpec,
} from '$lib/engine'
import { SpatialIndex } from '$lib/edit/spatialIndex'
import { applyPatch, beginStroke, endStroke, getEditDoc, nextManualId, type DesignerGem } from '$lib/stores/edit.svelte'
import type { BrushPoint } from './brushGesture'
import { BrushSpecShapeError, getBrushRejections, getBrushSpec, onBrushStroke, setBrushRejections } from './workbench.svelte'
import type { BrushSpecState } from './workbench.svelte'
import type { GridSpec } from '$lib/engine'

/** 与 validateEditable/exportGate 同口径浮点容差（判距 ×0.999；等径退化 = v1 判据）。 */
const PAIRWISE_TOLERANCE = 0.999

/** 擦除命中圈 = 1.5×钻半径（与画布点选 hitGem 同口径）。 */
const ERASE_HIT_FACTOR = 1.5

/** 文档基准派生笔刷规格：round × grid 基准径（baseSpecDiameterMm 量化回推=SS 查表值）× 色板首色。 */
export function resolveBrushSpec(doc: {
  grid: GridSpec
  palette: ReadonlyArray<{ id: string }>
}): BrushSpecState {
  const override = getBrushSpec()
  if (override !== null) return override
  return {
    shapeId: 'round',
    diameterMm: baseSpecDiameterMm(doc.grid),
    colorId: doc.palette[0]?.id ?? '',
  }
}

/**
 * 画钻物化（源头戳规格——同 layout makeGem 纪律；blockId null = 手工钻；朝向缺省）。
 * [R5-P1 统一契约] 源头守卫：非内置形 typed 拒绝（BrushSpecShapeError）——custom 钻形
 * 经资产路径产生，笔刷永不物化无 assetId 引用的 custom 手工钻。
 */
export function makeBrushGem(spec: BrushSpecState, id: string, x: number, y: number): EditGem {
  if (!isBuiltinShapeId(spec.shapeId)) throw new BrushSpecShapeError(spec.shapeId)
  return {
    id,
    x,
    y,
    colorId: spec.colorId,
    blockId: null,
    origin: 'manual',
    moved: false,
    shapeId: spec.shapeId,
    diameterMm: spec.diameterMm,
  }
}

interface StrokeState {
  readonly grid: GridSpec
  readonly brush: BrushSpecState
  readonly brushSpec: PairwiseSpec
  /** 起笔时既有钻的邻域索引（draw 判距/erase 命中共用；draw 不改既有钻——快照即活照）。 */
  readonly index: SpatialIndex<DesignerGem> // [1.1 v3] 钻集含 layerId（remove patch items 契约）
  /** 邻域查询半径上界（(笔刷径+全集最大径)/2+gap）×px/mm——cell 契约下 3×3 桶不漏。 */
  readonly queryRadius: number
  /** 本笔已落钻（笔内 pairwise 线性判——笔内钻数远小于全集）。 */
  readonly added: EditGem[]
  /** 本笔已删钻 id（erase 幽灵过滤：索引快照仍含已删项）。 */
  readonly removed: Set<string>
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) * (ax - bx) + (ay - by) * (ay - by)
}

function requiredPx(stroke: StrokeState, other: PairwiseSpec): number {
  return requiredCenterDistancePx(stroke.brushSpec, other, stroke.grid) * PAIRWISE_TOLERANCE
}

/** 逐点 pairwise 门：对既有全集（邻域索引）+ 本笔已落钻均须 dist ≥ 判距。 */
function canPlace(stroke: StrokeState, p: BrushPoint): boolean {
  for (const cand of stroke.index.queryCircle(p.x, p.y, stroke.queryRadius)) {
    const need = requiredPx(stroke, effectiveSpecOf(cand, stroke.grid))
    if (dist2(cand.x, cand.y, p.x, p.y) < need * need) return false
  }
  for (const gem of stroke.added) {
    const need = requiredPx(stroke, { diameterMm: gem.diameterMm })
    if (dist2(gem.x, gem.y, p.x, p.y) < need * need) return false
  }
  return true
}

function placePoints(stroke: StrokeState, points: readonly BrushPoint[]): void {
  const batch: EditGem[] = []
  const rejected: BrushPoint[] = []
  for (const p of points) {
    if (!canPlace(stroke, p)) {
      rejected.push({ ...p })
      continue
    }
    const gem = makeBrushGem(stroke.brush, nextManualId(), p.x, p.y)
    batch.push(gem)
    stroke.added.push(gem)
  }
  if (batch.length > 0) {
    // [1.1 v3 seam] 笔刷落钻归当前层（design §4.1「新增」行）——「当前层」真源归 1.3 workbench
    // store；过渡期取首层（1.x 全部动效下单钻层，语义无分叉）
    const layerId = getEditDoc()?.layers[0]?.id ?? 'L1'
    applyPatch({ op: 'add', gems: batch.map((gem) => ({ ...gem, layerId })) }) // stroke 组内并入（MAX_STROKE_GEMS 累计门在 store）
  }
  if (rejected.length > 0) {
    setBrushRejections([...getBrushRejections(), ...rejected])
  }
}

function erasePoints(stroke: StrokeState, points: readonly BrushPoint[]): void {
  const hits = new Map<string, DesignerGem>()
  const r = stroke.queryRadius * ERASE_HIT_FACTOR
  for (const p of points) {
    for (const cand of stroke.index.queryCircle(p.x, p.y, r)) {
      if (stroke.removed.has(cand.id)) continue
      const hitRadius =
        ERASE_HIT_FACTOR * (cand.diameterMm / 2) * stroke.grid.pixelsPerMm
      if (dist2(cand.x, cand.y, p.x, p.y) <= hitRadius * hitRadius) hits.set(cand.id, cand)
    }
  }
  if (hits.size === 0) return
  const doc = getEditDoc()
  if (doc === null) return
  // 记录原文档索引（undo 按原位回插——store applyInverse 契约）
  const items = [...hits.values()].map((gem) => ({
    gem,
    index: doc.gems.indexOf(gem),
  }))
  for (const it of items) stroke.removed.add(it.gem.id)
  applyPatch({ op: 'remove', items })
}

/**
 * 接线笔刷算法（订阅 C-3.3 意图流；返回退订）。起笔：清闪红 + 建快照索引 + 开 stroke 组；
 * 逐事件消费落点（draw 物化/erase 删除）；收笔：提交单 undo 组。文档缺席 = 忽略整笔。
 */
export function attachBrushEngine(): () => void {
  let stroke: StrokeState | null = null
  return onBrushStroke((event) => {
    const doc = getEditDoc()
    if (doc === null) {
      // 文档卸载（关闭/覆盖）中断进行中的笔——丢弃局部组不留悬空 stroke
      if (stroke !== null) {
        stroke = null
        endStroke() // 空组丢弃（已应用 patch 的极端竞态由 store 组语义兜底）
      }
      return
    }
    if (event.phase === 'begin') {
      setBrushRejections([]) // 新笔清闪红
      const brush = resolveBrushSpec(doc)
      const brushSpec: PairwiseSpec = { diameterMm: brush.diameterMm }
      const specs: PairwiseSpec[] = doc.gems.map((g) => effectiveSpecOf(g, doc.grid))
      let maxDiameter = brush.diameterMm
      for (const s of specs) if (s.diameterMm > maxDiameter) maxDiameter = s.diameterMm
      const index = new SpatialIndex<DesignerGem>(maxCellPx([{ diameterMm: maxDiameter }], doc.grid))
      for (const g of doc.gems) index.insert(g)
      stroke = {
        grid: doc.grid,
        brush,
        brushSpec,
        index,
        queryRadius:
          ((brush.diameterMm + maxDiameter) / 2 + doc.grid.gapMm) * doc.grid.pixelsPerMm,
        added: [],
        removed: new Set<string>(),
      }
      beginStroke()
      const consume = event.intent.tool === 'draw' ? placePoints : erasePoints
      consume(stroke, event.intent.points)
      return
    }
    if (stroke === null) return // 未起笔的 move/end（防御——手势层不产此序）
    if (event.phase === 'move') {
      const consume = event.intent.tool === 'draw' ? placePoints : erasePoints
      consume(stroke, event.appended)
      return
    }
    endStroke() // 一笔 = 单 undo 组（空组丢弃）
    stroke = null
  })
}
