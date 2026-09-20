/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-20 D-5.5 rename-and-expert-workbench；2026-09-21 迁移至 lib/designer] 笔刷算法
 *    落地：消费笔刷意图流（onBrushStroke）——draw = 落点生成手工钻（makeBrushGem 源头戳规格：
 *    shapeId/diameterMm/colorId 物化 + origin='manual'，同 layout makeGem 源头物化纪律）；
 *    erase = 命中删除（1.5×钻半径命中圈，与画布点选同口径）；一笔 = 单 undo 组
 *    （beginStroke/endStroke，空笔组丢弃——store 既有语义）。
 *    [redesign 2.x] 落钻归属当前层（design §4.1「新增」行——currentLayerIdOf 真源）。
 *    [redesign 3.1] 橡皮跳过锁定层与隐藏层钻（design §6.1——锁定层保护擦除、隐藏层不参与）。
 * 2. [redesign 3.1 custom 判据替换（design §6.2）] custom 形入笔刷面：「内置五形白名单」→
 *    「custom 必带 assetId」（engine customAssetIdMissing 单一语义源）——物化携带 assetId；
 *    条件项三件套之 asset resolver（assetId → sys-shapes .gemshape 资产解析，gemCatalogService
 *    零改动消费）+ missing-asset 拒画（整笔拒绝 + brushError 报错读数——不得只放宽 UI 判据）。
 * 3. [2026-09-20 D-5.5] 冲突拒画：逐点 pairwise 判据（requiredCenterDistancePx×0.999
 *    ——与 validateEditable/exportGate 同判据同容差；落钻永不自产 spacing 违规）；
 *    拒画点经 setBrushRejections 闪红读数（画布绘红 X）。「画钻笔刷 snap 六方格位」
 *    语义 = 手势层（画布 brushPointFor）已按格位吸附，本算法消费吸附点；
 *    snap=free 时落点原样（同样过 pairwise 门）。
 * 4. [2026-09-20 Perf/Pure] 空间索引邻域判定（spatialIndex——cell=maxCellPx 契约，
 *    含笔刷径并入取 max）：起笔一次建索引 O(n)，逐点 3×3 桶查询；本笔内新增钻单独
 *    线性查（笔内钻数远小于全集）；擦除幽灵项（本笔已删）按 id 过滤。
 * 5. [redesign 3.2] 吸附 pitch 随当前规格重算（design §6.1「格位 = 当前规格 pitch 六方格位」）：
 *    brushSnapPitchPx 单源（规格径 + grid gap × px/mm；基准派生态与 pitchPx(grid) 逐位相等
 *    ——语义回归不破坏）——画布落点吸附/拖移吸附共用。
 */

import {
  baseSpecDiameterMm,
  customAssetIdMissing,
  customSpecKey,
  effectiveSpecOf,
  isBuiltinShapeId,
  maxCellPx,
  requiredCenterDistancePx,
  type EditGem,
  type PairwiseSpec,
} from '$lib/engine'
import { SpatialIndex } from '$lib/edit/spatialIndex'
import { applyPatch, beginStroke, endStroke, getEditDoc, nextManualId, type DesignerGem, type GemLayerRecord } from '$lib/stores/edit.svelte'
import { gemCatalog, type CatalogSpec, type GemCatalogService } from '$lib/services/gemCatalogService'
import type { BrushPoint } from './brushGesture'
import { BrushSpecShapeError, currentLayerIdOf, getBrushError, getBrushRejections, getBrushSpec, onBrushStroke, setBrushError, setBrushRejections } from './workbench.svelte'
import type { BrushSpecState } from './workbench.svelte'
import type { GridSpec } from '$lib/engine'

/** 与 validateEditable/exportGate 同口径浮点容差（判距 ×0.999；等径退化 = v1 判据）。 */
const PAIRWISE_TOLERANCE = 0.999

/** 擦除命中圈 = 1.5×钻半径（与画布点选 hitGem 同口径）。 */
export const ERASE_HIT_FACTOR = 1.5

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
 * [redesign 3.1 判据替换（design §6.2）] 源头守卫：custom 必带 assetId（缺 = typed 拒绝
 * BrushSpecShapeError）；assetId 仅 custom 携带（builtin 带 assetId 同拒绝——engine GemSchema
 * 同口径镜像）。custom 物化携带 assetId（身份 custom-<assetId> 的派生依据）。
 */
export function makeBrushGem(spec: BrushSpecState, id: string, x: number, y: number): EditGem {
  if (customAssetIdMissing(spec)) throw new BrushSpecShapeError(spec.shapeId)
  if (isBuiltinShapeId(spec.shapeId) && spec.assetId !== undefined) throw new BrushSpecShapeError(spec.shapeId)
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
    ...(spec.shapeId === 'custom' && spec.assetId !== undefined ? { assetId: spec.assetId } : {}),
  }
}

// ---------------------------------------------------------------------------
// [redesign 3.1] asset resolver：assetId → sys-shapes .gemshape 资产解析
// （gemCatalogService 零改动消费——resolveSpec('custom-<assetId>')；missing 四态
//  [wrong-kind/软删/blob 缺失/parse 失败] 统一 undefined）。解析异步、落钻同步——
// 起笔时按缓存状态同步裁决（pending/missing 均拒画）；写入侧（apply-spec 命令）
// 先行 prefetch，常规链路用户落笔前已就绪。
// ---------------------------------------------------------------------------

/** 解析缓存：assetId → 目录条目（'missing' = 解析完成且缺席）。 */
const brushAssetCache = new Map<string, CatalogSpec | 'missing'>()

/** 目录 service（生产单例；测试注入替身——零改动消费接口签名）。 */
let brushCatalog: GemCatalogService = gemCatalog

/** 测试注入（null 复位生产单例；缓存一并清空）。 */
export function setBrushCatalogForTests(service: GemCatalogService | null): void {
  brushCatalog = service ?? gemCatalog
  brushAssetCache.clear()
}

/**
 * 解析自定义形资产（async；结果入缓存）。specKey = customSpecKey(assetId) 单源派生；
 * 解析结果身份校验（entry.assetId 必须回等 assetId——防错挂条目）。返回是否解析就绪。
 */
export async function resolveBrushAsset(assetId: string): Promise<boolean> {
  const entry = await brushCatalog.resolveSpec(customSpecKey(assetId)).catch(() => undefined)
  const ok = entry !== undefined && entry.shapeId === 'custom' && entry.assetId === assetId
  brushAssetCache.set(assetId, ok ? entry! : 'missing')
  return ok
}

/** 同步查缓存：'ready'（解析就绪）/ 'pending'（未解析或解析中）/ 'missing'（解析缺席）。 */
export function brushAssetStatusOf(assetId: string): 'ready' | 'pending' | 'missing' {
  const cached = brushAssetCache.get(assetId)
  if (cached === undefined) return 'pending'
  return cached === 'missing' ? 'missing' : 'ready'
}

/** 缓存目录条目读取（ready 态的条目；其余 null）。 */
export function brushAssetSpecOf(assetId: string): CatalogSpec | null {
  const cached = brushAssetCache.get(assetId)
  return cached !== undefined && cached !== 'missing' ? cached : null
}

/**
 * [redesign 3.2] 吸附 pitch（px）随当前规格重算（design §6.1：格位 = 当前规格 pitch
 * 六方格位——pitchMm = 规格径 + gap，gridFromSpec 同式）：覆盖态用规格径；null = 文档
 * 基准派生（baseSpecDiameterMm——与 pitchPx(grid) 逐位相等的基线语义）。pitch 只消费
 * 规格径（色不参与），基准径直取 grid 派生（与 resolveBrushSpec 基线分支同单源）。
 */
export function brushSnapPitchPx(doc: { grid: GridSpec }): number {
  const override = getBrushSpec()
  const diameterMm = override !== null ? override.diameterMm : baseSpecDiameterMm(doc.grid)
  return (diameterMm + doc.grid.gapMm) * doc.grid.pixelsPerMm
}

interface StrokeState {
  readonly grid: GridSpec
  readonly brush: BrushSpecState
  readonly brushSpec: PairwiseSpec
  /** 起笔时既有钻的邻域索引（draw 判距/erase 命中共用；draw 不改既有钻——快照即活照）。 */
  readonly index: SpatialIndex<DesignerGem> // 钻集含 layerId（remove patch items 契约）
  /** 邻域查询半径上界（(笔刷径+全集最大径)/2+gap）×px/mm——cell 契约下 3×3 桶不漏。 */
  readonly queryRadius: number
  /** [3.1] 可擦层 id 集（橡皮跳过锁定层与隐藏层钻——design §6.1；起笔快照）。 */
  readonly erasableLayers: ReadonlySet<string>
  /** 本笔已落钻（笔内 pairwise 线性判——笔内钻数远小于全集）。 */
  readonly added: EditGem[]
  /** 本笔已删钻 id（erase 幽灵过滤：索引快照仍含已删项）。 */
  readonly removed: Set<string>
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) * (ax - bx) + (ay - by) * (ay - by)
}

/** [3.1] 可擦层 id 集：未锁定且可见（橡皮跳过锁定/隐藏层钻——design §6.1）。 */
function erasableLayerIdsOf(layers: readonly GemLayerRecord[]): ReadonlySet<string> {
  return new Set(layers.filter((l) => !l.locked && l.visible).map((l) => l.id))
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
    // 落钻归当前层（design §4.1「新增」行——currentLayerIdOf：显式当前层，失效兜底首层）
    const doc = getEditDoc()
    const layerId = currentLayerIdOf(doc) ?? 'L1'
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
      // [3.1] 橡皮跳过锁定层与隐藏层钻（design §6.1——锁定层保护擦除，隐藏层不参与）
      if (!stroke.erasableLayers.has(cand.layerId)) continue
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
 * 接线笔刷算法（订阅意图流；返回退订）。起笔：清闪红 + 建快照索引 + 开 stroke 组；
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
      setBrushError(null) // 新笔清报错
      const brush = resolveBrushSpec(doc)
      // [3.1] missing-asset 拒画（design §6.2 条件项③）：custom 形起笔须资产解析就绪
      // （pending/missing 均拒——不物化身份悬空的 custom 钻）；整笔拒绝 + brushError
      // 报错读数 + 起笔点闪红（后续 move/end 因无 stroke 态忽略——整笔不落钻）。
      if (event.intent.tool === 'draw' && brush.shapeId === 'custom') {
        const assetId = brush.assetId ?? ''
        const status = brushAssetStatusOf(assetId)
        if (status !== 'ready') {
          setBrushError(
            `自定义钻形资产${status === 'missing' ? '已缺失' : '尚未解析完成'}（assetId ${assetId}）——已拒绝落钻，请在规格选择器重选或重新校准`,
          )
          setBrushRejections(event.intent.points.map((p) => ({ ...p })))
          stroke = null
          return
        }
      }
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
        erasableLayers: erasableLayerIdsOf(doc.layers),
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
