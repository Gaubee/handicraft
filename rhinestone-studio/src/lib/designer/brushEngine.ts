/*
 * Orthogonal intents (max 6):
 * 1. [2026-09-20 D-5.5 rename-and-expert-workbench；2026-09-21 迁移至 lib/designer] 笔刷算法
 *    落地：消费笔刷意图流（onBrushStroke）——draw = 落点生成手工钻（makeBrushGem 源头戳规格：
 *    shapeId/diameterMm/colorId 物化 + origin='manual'，同 layout makeGem 源头物化纪律）；
 *    erase = 命中删除（[R3.1] 单点 1.5× 命中圈已让位 footprint 批量擦除，见 6.）；一笔 =
 *    单 undo 组（beginStroke/endStroke，空笔组丢弃——store 既有语义）。
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
 * 6. [2026-09-21 rework-designer-manual-rhinestone R3.1] 笔刷流量·面积落子（design §4）：
 *    笔刷 = 圆盘 footprint（直径 brushSettings.effectiveBrushDiameterMm，默认=规格钻径），
 *    非「点间隔」。吸附开 = 圆盘胶囊扫过区 ∩ 六方格位的**增量结算**（settledCells 去重；
 *    段 AB 胶囊判定——快速拖动无缝，非仅当前圆）→ 流量抽稀（格位保留概率，seeded 点级
 *    哈希阈值——嵌套语义，单调且确定性）→ 碰撞检查（既有钻 + 本笔批同判 0.999）→ 落子；
 *    吸附关 = 沿笔迹中心线逐点 pairwise 门（现状模式）。橡皮同 footprint：胶囊扫过区内
 *    **批量**擦除（中心入区即删——WYSIWYG；锁定/隐藏层跳过既有）。落点契约：grid 模式
 *    落点 = 手势层吸附格位 = 圆盘心（默认直径下圆盘仅覆自身格位——与点间隔旧行为逐位一致）。
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
import { BrushSpecShapeError, currentLayerIdOf, effectiveBrushDiameterMm, getBrushError, getBrushRejections, getBrushSettings, getBrushSpec, onBrushStroke, setBrushError, setBrushRejections } from './workbench.svelte'
import type { BrushSpecState } from './workbench.svelte'
import type { GridSpec } from '$lib/engine'

/** 与 validateEditable/exportGate 同口径浮点容差（判距 ×0.999；等径退化 = v1 判据）。 */
const PAIRWISE_TOLERANCE = 0.999

// ---------------------------------------------------------------------------
// [R3.1 面积落子] 圆盘胶囊 sweep 内核（纯几何——vitest 直驱）
// ---------------------------------------------------------------------------

/** 流量抽稀种子（固定值——同格位同流量恒同判：重描幂等、跨笔可复现、阈值嵌套成立）。 */
const BRUSH_FLOW_SEED = 0x62727573 // 'brus'

/**
 * 格位点级稳定哈希 [0,1)（流量抽稀确定性单源）。与 engine rng hash01 同族实现（整数坐标
 * 哈希、与遍历顺序无关）——designer 域本地实现，不触 engine 冻结面；阈值语义
 * keep ⟺ hash(col,row) < flow/100 使保留集随流量嵌套（低流量结果 = 高流量子集）。
 */
export function brushCellHash(col: number, row: number): number {
  let h = BRUSH_FLOW_SEED >>> 0
  h = Math.imul(h ^ (col + 0x9e3779b9), 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h ^ (row + 0xc2b2ae3d), 0x27d4eb2f)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** 点到线段 AB 距离（胶囊 sweep 判定内核——退化段（A=B）即点到点距离）。 */
function distToSegmentPx(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax
  const aby = by - ay
  const len2 = abx * abx + aby * aby
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / len2))
  const dx = px - (ax + t * abx)
  const dy = py - (ay + t * aby)
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * 六方格位胶囊枚举（[R3.1]）：线段 AB × 半径 r 的圆盘扫过区（胶囊）内全部格位，
 * 逐位回访（行升/列升——确定性枚举序）。格定义与 hexSnapPoint 同格单源语义：
 * rowH = pitch×√3/2、奇行偏移 pitch/2、行水平（GridSpec rowAngleDeg 恒 0 临时格）。
 */
function hexCellsInCapsule(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radiusPx: number,
  pitchPx: number,
  visit: (col: number, row: number, x: number, y: number) => void,
): void {
  if (!(pitchPx > 0) || !(radiusPx >= 0)) return
  const rowH = (pitchPx * Math.sqrt(3)) / 2
  const half = pitchPx / 2
  const loX = Math.min(ax, bx) - radiusPx
  const hiX = Math.max(ax, bx) + radiusPx
  const loY = Math.min(ay, by) - radiusPx
  const hiY = Math.max(ay, by) + radiusPx
  const rowMin = Math.floor(loY / rowH)
  const rowMax = Math.floor(hiY / rowH)
  for (let row = rowMin; row <= rowMax; row++) {
    const rowY = row * rowH
    if (rowY < loY || rowY > hiY) continue // 行带裁剪（浮点行界行不进列枚举）
    const offset = row % 2 === 0 ? 0 : half // 负行取余：-1 % 2 === -1 → 奇行偏移（与 hexSnapPoint 对称格同式）
    const colMin = Math.ceil((loX - offset) / pitchPx)
    const colMax = Math.floor((hiX - offset) / pitchPx)
    for (let col = colMin; col <= colMax; col++) {
      const px = offset + col * pitchPx
      if (px < loX || px > hiX) continue
      // 胶囊判定：格心到线段距离 ≤ 半径（含端帽——快速拖动段间不留未结算带）
      if (distToSegmentPx(px, rowY, ax, ay, bx, by) <= radiusPx) visit(col, row, px, rowY)
    }
  }
}

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
  /** [R3.1] 格位吸附 pitch px（brushSnapPitchPx 起笔快照——胶囊格位枚举与手势吸附同源）。 */
  readonly snapPitchPx: number
  /** [R3.1] 笔刷圆盘半径 px（effectiveBrushDiameterMm÷2×px/mm——起笔快照，笔中调节不扰进行中笔）。 */
  readonly diskRadiusPx: number
  /** [R3.1] 面积落子模式（draw×grid）：圆盘胶囊扫面；false = 中心线逐点（吸附关现状）。 */
  readonly areaMode: boolean
  /** [R3.1] 流量 %（格位保留概率——起笔快照，笔中调节不改变进行中笔的抽稀判定）。 */
  readonly flowPercent: number
  /** [R3.1] 已结算格位（"col|row" 键——落子/抽稀/拒画均算已结算；增量去重幂等）。 */
  readonly settledCells: Set<string>
  /** [R3.1] 上次圆盘心（胶囊段起点；null = 起笔位即退化段——erase 胶囊同源）。 */
  lastCenter: BrushPoint | null
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

/**
 * 落子批（碰撞门共用内核）：逐点 pairwise（既有全集邻域索引 + 本笔已落钻）→ 通过者物化
 * 落钻（单 stroke 组内并入），被拒点闪红。吸附关中心线模式与面积模式的碰撞段同源。
 */
function placeBatch(stroke: StrokeState, points: readonly BrushPoint[]): void {
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

/**
 * [R3.1] 面积落子（吸附开，design §4.2）：圆盘胶囊扫过区 ∩ 六方格位的**增量结算** →
 * 流量抽稀 → 碰撞 → 落子。无缝 sweep 判定式：新圆盘心 B 相对上次圆盘心 A 的扫过新增
 * 格位集 = {格心到线段 AB 距离 ≤ diskRadius} \ 已结算集——段判定（含端帽）保证快速
 * 拖动（事件稀疏）与慢速拖动（事件密集）覆盖同一胶囊带，不留未结算缝。落点契约：
 * grid 模式落点 = 手势层吸附格位 = 圆盘心；默认直径（=规格径 < pitch）下圆盘仅覆自身
 * 格位——与点间隔旧行为逐位一致（回归零破坏）；直径 > pitch 后垂直笔迹方向多列铺开。
 */
function placeDiskSweep(stroke: StrokeState, center: BrushPoint): void {
  const ax = stroke.lastCenter?.x ?? center.x
  const ay = stroke.lastCenter?.y ?? center.y
  const kept: BrushPoint[] = []
  const flowThreshold = stroke.flowPercent / 100
  hexCellsInCapsule(ax, ay, center.x, center.y, stroke.diskRadiusPx, stroke.snapPitchPx, (col, row, x, y) => {
    const key = `${col}|${row}`
    if (stroke.settledCells.has(key)) return // 增量结算：已结算格位（落/抽/拒）不再进批
    stroke.settledCells.add(key)
    // 流量抽稀（确定性阈值：hash(col,row) < flow/100 保留——嵌套语义，抽稀 ≠ 拒画不闪红）
    if (stroke.flowPercent < 100 && brushCellHash(col, row) >= flowThreshold) return
    kept.push({ x, y })
  })
  placeBatch(stroke, kept)
  stroke.lastCenter = { x: center.x, y: center.y }
}

/** draw 消费分派（逐事件点）：面积模式（吸附开）胶囊扫面结算；中心线模式（吸附关）逐点现状。 */
function consumeDraw(stroke: StrokeState, p: BrushPoint): void {
  if (stroke.areaMode) {
    placeDiskSweep(stroke, p)
    return
  }
  placeBatch(stroke, [p])
}

/**
 * [R3.1] 橡皮 footprint 批量擦除（design §4.2）：圆盘胶囊扫过区内**所有**可删钻
 * （钻心入区即删——与光标圈 WYSIWYG 同口径；替换旧单点 1.5× 命中圈）。锁定/隐藏层
 * 跳过（快照谓词）；本笔已删幽灵按 id 过滤；一笔可多点、每事件单 remove patch——
 * 单 stroke 单 undo 组既有语义保持。
 */
function eraseDiskSweep(stroke: StrokeState, center: BrushPoint): void {
  const ax = stroke.lastCenter?.x ?? center.x
  const ay = stroke.lastCenter?.y ?? center.y
  const r = stroke.diskRadiusPx
  const hits = new Map<string, DesignerGem>()
  for (const cand of stroke.index.queryRect(
    Math.min(ax, center.x) - r,
    Math.min(ay, center.y) - r,
    Math.max(ax, center.x) + r,
    Math.max(ay, center.y) + r,
  )) {
    if (stroke.removed.has(cand.id)) continue
    // [3.1] 橡皮跳过锁定层与隐藏层钻（design §6.1——锁定层保护擦除，隐藏层不参与）
    if (!stroke.erasableLayers.has(cand.layerId)) continue
    if (distToSegmentPx(cand.x, cand.y, ax, ay, center.x, center.y) <= r) hits.set(cand.id, cand)
  }
  if (hits.size > 0) {
    const doc = getEditDoc()
    if (doc !== null) {
      // 记录原文档索引（undo 按原位回插——store applyInverse 契约）
      const items = [...hits.values()].map((gem) => ({
        gem,
        index: doc.gems.indexOf(gem),
      }))
      for (const it of items) stroke.removed.add(it.gem.id)
      applyPatch({ op: 'remove', items })
    }
  }
  stroke.lastCenter = { x: center.x, y: center.y }
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
      // [R3.1] 圆盘 footprint / 流量 / 格位 pitch 起笔快照（笔中调节不扰进行中笔——确定性）
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
        snapPitchPx: brushSnapPitchPx(doc),
        diskRadiusPx: (effectiveBrushDiameterMm(doc) / 2) * doc.grid.pixelsPerMm,
        areaMode: event.intent.tool === 'draw' && event.intent.snap === 'grid',
        flowPercent: getBrushSettings().flowPercent,
        settledCells: new Set<string>(),
        lastCenter: null,
      }
      beginStroke()
      const consume = event.intent.tool === 'draw' ? consumeDraw : eraseDiskSweep
      for (const p of event.intent.points) consume(stroke, p)
      return
    }
    if (stroke === null) return // 未起笔的 move/end（防御——手势层不产此序）
    if (event.phase === 'move') {
      const consume = event.intent.tool === 'draw' ? consumeDraw : eraseDiskSweep
      for (const p of event.appended) consume(stroke, p)
      return
    }
    endStroke() // 一笔 = 单 undo 组（空组丢弃）
    stroke = null
  })
}
