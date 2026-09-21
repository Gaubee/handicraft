/*
 * Orthogonal intents (max 6):
 * 1. [2026-09-21 redesign-designer-workbench 2.x] 设计师工作台交互态真源（design §1.3/§7.1-①，
 *    迁移并扩展自旧 Edit 域 workbench 态模块（§7.4 退役清单））：工具五态（V 选择/B 画笔/E 橡皮/
 *    H 抓手/Z 缩放）+ 吸附（grid/free）+ 当前层（新钻/粘贴落点）+ 指针读数（图像坐标）。
 * 2. [迁移] 画布瞬时交互读数：marquee 矩形 / 笔刷光标位 / 吸附格位高亮——jsdom 无 2d 上下文，
 *    测试经本模块读取面断言，浏览器经画布重绘消费。
 * 3. [迁移] 笔刷意图流出口：onBrushStroke 订阅（begin/move/end × 落点序列 + 工具 + snap 态）
 *    ——brushEngine 消费（落钻/擦除算法）与测试共用接口。
 * 4. [迁移] 笔刷当前规格态（brushSpec——显式覆盖；null = 文档基准派生）+ 冲突拒画闪红读数
 *    （brushRejections——起笔清零、拒画点追加）+ missing-asset 报错读数（brushError——
 *    自定义形资产缺失拒画时的错误文案，起笔清零）。[redesign 3.1] custom 形判据放宽
 *    （design §6.2）：「内置五形白名单」→「custom 必带 assetId」（engine customAssetIdMissing
 *    单一语义源）——custom 物化携带 assetId，missing-asset 拒画归 brushEngine（resolver 消费
 *    gemCatalogService）。
 * 5. [Test] resetWorkbenchForTests 复位（工具/snap/当前层/指针/读数/订阅/规格/闪红/报错全清；
 *    [4.1 P17] Alt 孤立显示快照随复位面清零——同函数扩展，复位语义不变）。
 * 6. [2026-09-21 rework-designer-manual-rhinestone R3] 笔刷设定真源（design §4.1）：
 *    brushSettings{diameterMm=null（跟随当前规格直径，默认）| mm 覆盖, flowPercent=100}
 *    ——会话态，不入 gemdoc〔可推翻：可迁 localStorage〕。直径 = 笔刷「圆盘 footprint」
 *    直径（面积落子/橡皮 footprint/光标圈三消费同源），恒 ≥ 规格钻径（effective 夹取）；
 *    流量 = 吸附开时格位保留概率（brushEngine 抽稀消费）。
 */

import { baseSpecDiameterMm, customAssetIdMissing, isBuiltinShapeId, type GridSpec, type ShapeId } from '$lib/engine'
import type { BrushIntentEvent, BrushIntentListener, BrushPoint, SnapMode } from './brushGesture'
import type { MarqueeRect } from './selection'

/** 设计师工作台工具（design §1.2 五项：V/B/E/H/Z）。 */
export type DesignerTool = 'select' | 'draw' | 'erase' | 'hand' | 'zoom'

/**
 * 笔刷规格面拒绝（[redesign 3.1] design §6.2 判据替换）：形判据 = 「custom 必带 assetId」
 * （替换 R5-P1「内置五形白名单」——校准入库产物已带 assetId，笔刷物化可携带）；镜像约束：
 * assetId 仅 custom 形允许携带（engine GemSchema 同口径）。custom 缺 assetId / builtin 带
 * assetId 均 typed throw——笔刷永不物化身份不完整的钻。
 */
export class BrushSpecShapeError extends Error {
  constructor(public readonly shapeId: string) {
    super(
      `笔刷规格不接纳形「${shapeId}」的规格：形判据为 custom 必带 assetId（且 assetId 仅 custom 携带）——custom 钻形身份（custom-<assetId>）派生依据不完整。`,
    )
    this.name = 'BrushSpecShapeError'
  }
}

/**
 * 笔刷当前规格（画钻物化戳的形状×尺寸×色；规格选择器的写入口真源）。
 * [redesign 3.1] shapeId 放宽至全形枚举（custom 入列——必带 assetId，物化携带；
 * 内置五形 assetId 恒缺）。
 */
export interface BrushSpecState {
  shapeId: ShapeId
  diameterMm: number
  colorId: string
  /** shapeId='custom' 时必带（.gemshape 资产 id——物化/资产解析依据）；内置形缺席。 */
  assetId?: string
}

let tool = $state<DesignerTool>('select')
let snap = $state<SnapMode>('grid')
/** 当前层 id（design §1.3 真源——画笔/粘贴落点；失效时消费方经 currentLayerIdOf 兜底首层）。 */
let currentLayerId = $state<string | null>(null)
/** 指针读数（图像坐标系；null = 离开画布）——状态栏/手势层共用。 */
let pointer = $state<BrushPoint | null>(null)
let marquee = $state<MarqueeRect | null>(null)
let brushCursor = $state<BrushPoint | null>(null)
let snapIndicator = $state<BrushPoint | null>(null)
/** 笔刷规格显式覆盖态（null = brushEngine 按文档基准派生）。 */
let brushSpec = $state<BrushSpecState | null>(null)
/** 冲突拒画闪红读数（被拒落点；起笔清零，画布绘红 X 提示）。 */
let brushRejections = $state<BrushPoint[]>([])
/** missing-asset 拒画报错读数（自定义形资产缺失/未解析——起笔清零；画布顶部错误条显示）。 */
let brushError = $state<string | null>(null)

// ---------------------------------------------------------------------------
// [R3 笔刷设定]（design §4.1——会话态真源，不入 gemdoc〔可推翻：可迁 localStorage〕）
// ---------------------------------------------------------------------------

/**
 * 笔刷设定（design §4.1）：diameterMm = 笔刷圆盘 footprint 直径（null = 跟随当前规格直径
 * ——默认；可调大于，恒 ≥ 规格钻径）；flowPercent = 流量 0-100（默认 100——吸附开时
 * 六方格位保留概率，brushEngine 面积落子抽稀消费）。
 */
export interface BrushSettingsState {
  /** 圆盘直径 mm 覆盖态；null = 跟随当前规格直径（规格切换随之联动）。 */
  diameterMm: number | null
  /** 流量 %（0-100）。 */
  flowPercent: number
}

/** 笔刷直径上限（mm）——popover/键位调节共同夹取上界。 */
export const BRUSH_DIAMETER_MAX_MM = 100

let brushSettings = $state<BrushSettingsState>({ diameterMm: null, flowPercent: 100 })

/** 笔刷设定读数（快照拷贝防外部渗入）。 */
export function getBrushSettings(): BrushSettingsState {
  return { ...brushSettings }
}

/** 写笔刷圆盘直径覆盖（null = 回跟随规格；数值夹取 (0, BRUSH_DIAMETER_MAX_MM]、两位小数）。 */
export function setBrushDiameter(diameterMm: number | null): void {
  if (diameterMm === null) {
    brushSettings.diameterMm = null
    return
  }
  if (!Number.isFinite(diameterMm)) return
  const clamped = Math.min(Math.max(Math.round(diameterMm * 100) / 100, 0.01), BRUSH_DIAMETER_MAX_MM)
  brushSettings.diameterMm = clamped
}

/** 写流量 %（夹取 [0,100] 取整）。 */
export function setBrushFlowPercent(percent: number): void {
  if (!Number.isFinite(percent)) return
  brushSettings.flowPercent = Math.min(Math.max(Math.round(percent), 0), 100)
}

/**
 * 当前笔刷规格钻径 mm（物化钻直径——brushSpec 覆盖 ?? 文档基准派生；brushEngine
 * resolveBrushSpec 默认分支同式，模块单向依赖本侧不回引）。
 */
export function brushGemSpecDiameterMm(doc: { grid: GridSpec }): number {
  return getBrushSpec()?.diameterMm ?? baseSpecDiameterMm(doc.grid)
}

/**
 * 笔刷圆盘有效直径 mm（= max(覆盖 ?? 规格钻径, 规格钻径)——footprint 恒 ≥ 单钻径；
 * 面积落子/橡皮 footprint/光标圈三消费单源。规格切换时覆盖态不动，低于新规格径的
 * 覆盖在读取面被夹取（「默认=规格直径」语义恒成立）。
 */
export function effectiveBrushDiameterMm(doc: { grid: GridSpec }): number {
  const specDiameter = brushGemSpecDiameterMm(doc)
  const override = brushSettings.diameterMm
  return Math.max(override ?? specDiameter, specDiameter)
}

export function getTool(): DesignerTool {
  return tool
}

export function setTool(next: DesignerTool): void {
  tool = next
  // 切工具丢弃进行中的框选与笔刷读数（光标/吸附高亮由画布随 move 重建；闪红随笔废弃）
  marquee = null
  brushCursor = null
  snapIndicator = null
  brushRejections = []
  brushError = null
}

export function getSnap(): SnapMode {
  return snap
}

export function setSnap(next: SnapMode): void {
  snap = next
}

export function getCurrentLayerId(): string | null {
  return currentLayerId
}

/**
 * [4.1 P17 Alt 孤立显示] 孤立前可见性快照（layerId → visible；null = 未处于孤立态）。
 * Alt+点眼睛 = 其余层全隐藏（临时只显该层）；孤立态下再 Alt+点任意眼睛 = 按快照恢复
 * （PS 惯例「再按恢复」）。快照存本真源：右面板/移动抽屉两个图层面板实例共态；
 * 画布侧（3.x 交互核）如需读孤立态经读取面消费，不另持第二快照。
 */
let isolateSnapshot = $state<Record<string, boolean> | null>(null)

export function getIsolateSnapshot(): Record<string, boolean> | null {
  return isolateSnapshot
}

export function setIsolateSnapshot(snapshot: Record<string, boolean> | null): void {
  isolateSnapshot = snapshot === null ? null : { ...snapshot }
}

/** 设当前层（文档未载入/层不存在时拒绝——不持悬空 id）。 */
export function setCurrentLayerId(id: string | null, doc: { layers: ReadonlyArray<{ id: string }> } | null): void {
  if (id === null) {
    currentLayerId = null
    return
  }
  if (doc === null || !doc.layers.some((layer) => layer.id === id)) return
  currentLayerId = id
}

/** 当前层解析（消费方统一入口）：显式当前层有效则用之；否则兜底首层（z 序最底）；无层文档 = null。 */
export function currentLayerIdOf(doc: { layers: ReadonlyArray<{ id: string }> } | null): string | null {
  if (doc === null || doc.layers.length === 0) return null
  if (currentLayerId !== null && doc.layers.some((layer) => layer.id === currentLayerId)) {
    return currentLayerId
  }
  return doc.layers[0].id
}

export function getPointer(): BrushPoint | null {
  return pointer
}

export function setPointer(point: BrushPoint | null): void {
  pointer = point
}

export function getMarquee(): MarqueeRect | null {
  return marquee
}

export function setMarquee(rect: MarqueeRect | null): void {
  marquee = rect
}

export function getBrushCursor(): BrushPoint | null {
  return brushCursor
}

export function setBrushCursor(point: BrushPoint | null): void {
  brushCursor = point
}

export function getSnapIndicator(): BrushPoint | null {
  return snapIndicator
}

export function setSnapIndicator(point: BrushPoint | null): void {
  snapIndicator = point
}

export function getBrushSpec(): BrushSpecState | null {
  return brushSpec
}

/**
 * 规格选择器写当前笔刷规格；null 清除覆盖（回文档基准派生）。
 * [redesign 3.1] 运行时守卫（design §6.2 判据替换）：custom 必带 assetId（缺 = typed throw
 * BrushSpecShapeError）；镜像约束 assetId 仅 custom 允许携带（builtin 带 assetId 同 throw
 * ——engine GemSchema 同口径）。
 */
export function setBrushSpec(spec: BrushSpecState | null): void {
  if (spec === null) {
    brushSpec = null
    return
  }
  if (customAssetIdMissing(spec)) throw new BrushSpecShapeError(spec.shapeId)
  if (isBuiltinShapeId(spec.shapeId) && spec.assetId !== undefined) throw new BrushSpecShapeError(spec.shapeId)
  brushSpec = { ...spec }
}

export function getBrushRejections(): BrushPoint[] {
  return brushRejections
}

/** 拒画闪红写入口（brushEngine 起笔清零/拒画追加；快照拷贝防外部渗入）。 */
export function setBrushRejections(points: BrushPoint[]): void {
  brushRejections = points.map((p) => ({ ...p }))
}

export function getBrushError(): string | null {
  return brushError
}

/** missing-asset 拒画报错写入口（brushEngine 起笔清零/拒画写入）。 */
export function setBrushError(message: string | null): void {
  brushError = message
}

let brushListeners: BrushIntentListener[] = []

/** 订阅笔刷意图流；返回退订函数。 */
export function onBrushStroke(listener: BrushIntentListener): () => void {
  brushListeners.push(listener)
  return () => {
    brushListeners = brushListeners.filter((l) => l !== listener)
  }
}

/** 画布手势层唯一发事件入口（订阅方异常不中断手势）。 */
export function emitBrushEvent(event: BrushIntentEvent): void {
  for (const listener of [...brushListeners]) {
    try {
      listener(event)
    } catch {
      // 监听方异常隔离：手势层不因消费方失败而中断
    }
  }
}

/** 测试专用：整体复位（工具/snap/当前层/指针/读数/订阅/规格/闪红/报错/孤立快照/笔刷设定全清）。 */
export function resetWorkbenchForTests(): void {
  tool = 'select'
  snap = 'grid'
  currentLayerId = null
  pointer = null
  marquee = null
  brushCursor = null
  snapIndicator = null
  brushSpec = null
  brushRejections = []
  brushError = null // [3.1] 新增报错读数随复位面清零（复位面语义不变）
  brushSettings = { diameterMm: null, flowPercent: 100 } // [R3] 笔刷设定回默认（跟随规格/满流量）
  brushListeners = []
  isolateSnapshot = null // [4.1 P17] 新增态随复位面清零（复位面语义不变）
}
