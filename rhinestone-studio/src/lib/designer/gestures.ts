/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] §2 手势决策核（纯函数）：
 *    P1-P4 选择系——可选性判定（锁定层钻不可选中=视为空白 P1；隐藏层不渲染故不可选；
 *    框选仅收集未锁定且可见层钻 P4）。
 * 2. [P5 拖移] 移动增量决策：Shift 轴约束（初始拖向锁水平/垂直）+ 格位吸附（hexSnap，
 *    按当前 pitch）+ 松手单 patch 变更构造（buildMoveChanges）+ Alt 拖拽副本构造
 *    （buildGemCopies——design §4.1 复制行：id 走 'm-' 自增、origin='manual'、blockId=null、
 *    moved 重置、归当前目标层）。
 * 3. [rework R4.1 P9 ⌘T 自由变换态（design §3.1——P6/P7 单选专用柄退役，语义并入）]
 *    纯决策核：选集包围盒（selectionBoundsOf）+ 柄锚点（handleAnchorOf：角柄=缩放/
 *    外柄=旋转）+ 缩放系数（scaleFromDrag 径向比——语义=批量改尺寸：等比缩放直径字段，
 *    scaledDiameterMm 值域夹取）+ 组旋转增量（rotationDeltaFromDrag：Shift=15° 步进格）
 *    + 变更构造（buildTransformChanges——**§2 尺寸安全红线冻结点：只产 diameterMm/
 *    rotationDeg 字段，x/y 恒不入 changes**；round 钻 rotationDeg 恒不写）。
 *    旧 P6/P7 单柄决策（rotationFromDrag/diameterFromDrag/build*Change）随单选柄退役删除。
 * 4. [Pure] 纯 TS 零 runes/DOM——逐手势可直接 vitest；有状态会话（MoveDragSession）
 *    依赖注入 store patch 面，不触 DOM。
 */

import type { DesignerGem, EditPatch, GemLayerRecord, UpdateChange } from '$lib/stores/edit.svelte'
import { hexSnapPoint } from './hexSnap'
import type { SnapMode } from './brushGesture'

// ---------------------------------------------------------------------------
// P1-P4 选择系：可选性（锁定/隐藏层钻不可选）
// ---------------------------------------------------------------------------

/** 层记录的最小读取面（store GemLayerRecord 的结构子集——纯函数不依赖 store 模块态）。 */
export type LayerLike = Pick<GemLayerRecord, 'id' | 'visible' | 'locked'>

/**
 * 钻可选性（design §2 P1/P4 约束）：锁定层钻不可选中（点落其上视为空白）；隐藏层不
 * 渲染故不可选（与画布渲染跳过口径一致）。层记录缺席（悬空 layerId）同样不可选。
 */
export function isGemSelectable(gem: { layerId: string }, layers: readonly LayerLike[]): boolean {
  const layer = layers.find((l) => l.id === gem.layerId)
  return layer !== undefined && layer.visible && !layer.locked
}

/** 可选性谓词工厂（命中/框选热路径——一次建 Map，逐钻 O(1)）。 */
export function selectabilityFilter(
  layers: readonly LayerLike[],
): (gem: { layerId: string }) => boolean {
  const byId = new Map(layers.map((l) => [l.id, l] as const))
  return (gem) => {
    const layer = byId.get(gem.layerId)
    return layer !== undefined && layer.visible && !layer.locked
  }
}

// ---------------------------------------------------------------------------
// P5 拖移：增量决策 + 变更构造
// ---------------------------------------------------------------------------

/** 移动增量决策入参（grabbed = 被抓住的锚钻——吸附以其落点为基准）。 */
export interface MoveDeltaInput {
  rawDx: number
  rawDy: number
  /** Shift 按住 → 约束到 axis（会话在 Shift 首次按住时按主方向锁定）。 */
  shift: boolean
  /** 已锁定的约束轴（null = 未锁定/自由）。 */
  axis: 'x' | 'y' | null
  snapMode: SnapMode
  /** 吸附格距 px（snapMode='grid' 时生效；<=0 视为自由）。 */
  pitch: number
  anchor: { x: number; y: number }
}

export interface MoveDelta {
  dx: number
  dy: number
  /** 本次决策后应持有的约束轴（Shift 松开即解锁）。 */
  axis: 'x' | 'y' | null
}

/**
 * 移动增量决策（P5）：Shift 轴约束（未锁时按当前主方向锁定）→ 格位吸附（锚钻落点
 * 吸附六方格位后回算增量）→ 轴约束投影（吸附点回归约束轴，避免斜向漂移）。
 */
export function resolveMoveDelta(input: MoveDeltaInput): MoveDelta {
  let axis = input.axis
  if (input.shift) {
    if (axis === null) axis = Math.abs(input.rawDx) >= Math.abs(input.rawDy) ? 'x' : 'y'
  } else {
    axis = null
  }
  let dx = input.rawDx
  let dy = input.rawDy
  if (axis === 'x') dy = 0
  else if (axis === 'y') dx = 0
  if (input.snapMode === 'grid' && input.pitch > 0) {
    const snapped = hexSnapPoint(input.anchor.x + dx, input.anchor.y + dy, input.pitch)
    dx = snapped.x - input.anchor.x
    dy = snapped.y - input.anchor.y
    // 吸附后回归约束轴（格位行距会引入交叉轴分量——约束语义优先）
    if (axis === 'x') dy = 0
    else if (axis === 'y') dx = 0
  }
  return { dx, dy, axis }
}

/**
 * 松手单 patch 的变更构造（P5）：零位移钻不入 changes（undo 只回退真实位移）；
 * 全零（无实效拖移）返回 null。
 */
export function buildMoveChanges(
  gems: readonly DesignerGem[],
  delta: { dx: number; dy: number },
): UpdateChange[] | null {
  if (delta.dx === 0 && delta.dy === 0) return null
  const changes: UpdateChange[] = []
  for (const gem of gems) {
    changes.push({
      id: gem.id,
      before: { x: gem.x, y: gem.y },
      after: { x: gem.x + delta.dx, y: gem.y + delta.dy },
    })
  }
  return changes.length > 0 ? changes : null
}

/**
 * Alt 拖拽副本构造（P5 × design §4.1「复制」行）：副本 = 源钻全字段 + 新 id（调用方
 * nextId 注入 'm-' 自增）+ origin='manual' + blockId=null + moved 重置 + 归当前目标层
 * （跨层选集统一归目标层）+ 平移 delta。原钻原位且归属不变（由调用方只 patch add 保证）。
 */
export function buildGemCopies(
  gems: readonly DesignerGem[],
  targetLayerId: string,
  delta: { dx: number; dy: number },
  nextId: () => string,
): DesignerGem[] {
  return gems.map((gem) => ({
    ...gem,
    id: nextId(),
    x: gem.x + delta.dx,
    y: gem.y + delta.dy,
    blockId: null,
    origin: 'manual' as const,
    moved: false,
    layerId: targetLayerId,
  }))
}

// ---------------------------------------------------------------------------
// [rework R4.1 P9] ⌘T 自由变换态：角度基元（⌥[ ⌥] 键旋转/变换态组旋转共用）
// ---------------------------------------------------------------------------

/** 旋转步进档（Shift=15°；⌥[ ⌥] 键位 15°/5° 档与变换态共用同参数）。 */
export const ROTATE_STEP_DEG = 15
export const ROTATE_FINE_STEP_DEG = 5

/** 角度归一 [0,360)。 */
export function normalizeDeg(deg: number): number {
  const r = deg % 360
  return r < 0 ? r + 360 : r
}

/** 指针相对锚心的方位角（度；atan2 屏幕系 y 向下——顺时针为正，与 rotationDeg 同向）。 */
export function pointerAngleDeg(cx: number, cy: number, px: number, py: number): number {
  return (Math.atan2(py - cy, px - cx) * 180) / Math.PI
}

/** 直径值域上界（design §2 P7 沿用：变换缩放与 popover 同夹取上界 (0,50] mm）。 */
export const DIAMETER_MAX_MM = 50
/** 变换缩放下界（mm）：正数下限（缩至贴零 = 视觉消失但保留钻实体与钻位）。 */
export const TRANSFORM_MIN_DIAMETER_MM = 0.01

// ---------------------------------------------------------------------------
// [rework R4.1 P9] ⌘T 变换态：包围盒 / 柄锚点 / 缩放 / 组旋转 / 变更构造（design §3.1）
// ---------------------------------------------------------------------------

/** 选集包围盒（图像坐标；进态快照定格——§2 红线：钻位不动 ⇒ 盒在会话期恒定）。 */
export interface TransformBounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 变换柄：四角 = 缩放（等比缩放直径字段）；柄间中点外柄 = 旋转。 */
export type TransformHandleId = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w'

/** 选集包围盒：逐钻外扩自身有效半径（直径 px）——空选集返回 null。 */
export function selectionBoundsOf(
  gems: readonly DesignerGem[],
  radiusOf: (gem: DesignerGem) => number,
): TransformBounds | null {
  if (gems.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const g of gems) {
    const r = radiusOf(g)
    if (!Number.isFinite(r) || r < 0) continue
    x0 = Math.min(x0, g.x - r)
    x1 = Math.max(x1, g.x + r)
    y0 = Math.min(y0, g.y - r)
    y1 = Math.max(y1, g.y + r)
  }
  if (x0 > x1 || y0 > y1) return null
  return { x0, y0, x1, y1 }
}

/** 外柄（柄间中点）= 旋转；四角柄 = 缩放。 */
export function isRotateHandle(handle: TransformHandleId): boolean {
  return handle === 'n' || handle === 'e' || handle === 's' || handle === 'w'
}

/** 柄锚点（图像坐标）：角柄 = 盒角；外柄 = 边中点（旋转锚——视觉件再沿法向外推）。 */
export function handleAnchorOf(
  bounds: TransformBounds,
  handle: TransformHandleId,
): { x: number; y: number } {
  const cx = (bounds.x0 + bounds.x1) / 2
  const cy = (bounds.y0 + bounds.y1) / 2
  switch (handle) {
    case 'nw':
      return { x: bounds.x0, y: bounds.y0 }
    case 'ne':
      return { x: bounds.x1, y: bounds.y0 }
    case 'sw':
      return { x: bounds.x0, y: bounds.y1 }
    case 'se':
      return { x: bounds.x1, y: bounds.y1 }
    case 'n':
      return { x: cx, y: bounds.y0 }
    case 's':
      return { x: cx, y: bounds.y1 }
    case 'e':
      return { x: bounds.x1, y: cy }
    case 'w':
      return { x: bounds.x0, y: cy }
  }
}

/**
 * 缩放系数（P9）：指针到盒心径向距 / 起拖柄到盒心径向距（柄位起拖 = 1）。等比语义——
 * 逐钻按各自直径乘同一系数（scaleFromDrag 出系数，scaledDiameterMm 出每钻新径）。
 * 基距退化（盒心即柄位）返回 1（无缩放）。
 */
export function scaleFromDrag(input: {
  center: { x: number; y: number }
  startAnchor: { x: number; y: number }
  pointer: { x: number; y: number }
}): number {
  const base = Math.hypot(input.startAnchor.x - input.center.x, input.startAnchor.y - input.center.y)
  if (!(base > 1e-9)) return 1
  const factor = Math.hypot(input.pointer.x - input.center.x, input.pointer.y - input.center.y) / base
  return Number.isFinite(factor) && factor > 0 ? factor : 1
}

/**
 * 组旋转增量（P9，°）：指针角位移——组语义下步进作用于**增量**而非绝对角（各钻起始
 * 朝向不同，绝对角步进会破坏组内相对关系）；非步进档保留 2 位小数。
 */
export function rotationDeltaFromDrag(input: {
  startPointerAngle: number
  pointerAngle: number
  shift: boolean
}): number {
  const raw = input.pointerAngle - input.startPointerAngle
  return input.shift
    ? Math.round(raw / ROTATE_STEP_DEG) * ROTATE_STEP_DEG
    : Math.round(raw * 100) / 100
}

/** 等比缩放直径字段（mm）：值域 [0.01, 50] 夹取 + 两位量化（非法系数原样返回）。 */
export function scaledDiameterMm(diameterMm: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(diameterMm)) return diameterMm
  return Math.min(
    Math.max(Math.round(diameterMm * factor * 100) / 100, TRANSFORM_MIN_DIAMETER_MM),
    DIAMETER_MAX_MM,
  )
}

/** 待提交变换字段（⌘T 会话多柄连拖累积；Enter 单 patch 提交——interaction 态真源持有）。 */
export interface TransformPendingFields {
  diameterMm?: number
  rotationDeg?: number
}

/**
 * 变更构造（P9 × §2 尺寸安全红线冻结点）：只产 diameterMm / rotationDeg 字段——**x/y
 * 恒不入 changes**（任何变换不得移动钻位、不得触发重吸附——invariant 测试冻结面）；
 * round 钻 rotationDeg 恒不写（design §3.1 裁断：round 旋转值恒 0）；值未变/字段缺席
 * 的钻不入 changes（undo 只回退真实变更）。
 */
export function buildTransformChanges(
  gems: readonly DesignerGem[],
  pending: Readonly<Record<string, TransformPendingFields>>,
): UpdateChange[] {
  const changes: UpdateChange[] = []
  for (const gem of gems) {
    const p = pending[gem.id]
    if (p === undefined) continue
    const before: TransformPendingFields = {}
    const after: TransformPendingFields = {}
    if (p.diameterMm !== undefined && p.diameterMm !== gem.diameterMm) {
      before.diameterMm = gem.diameterMm
      after.diameterMm = p.diameterMm
    }
    const rotationBefore = gem.rotationDeg ?? 0
    if (
      p.rotationDeg !== undefined &&
      gem.shapeId !== 'round' &&
      rotationBefore !== p.rotationDeg
    ) {
      before.rotationDeg = rotationBefore
      after.rotationDeg = p.rotationDeg
    }
    if (before.diameterMm !== undefined || before.rotationDeg !== undefined) {
      changes.push({ id: gem.id, before, after })
    }
  }
  return changes
}

// ---------------------------------------------------------------------------
// P5 移动会话（有状态决策核——依赖注入 store patch 面；jsdom/纯驱动两栖）
// ---------------------------------------------------------------------------

export interface MoveDragSessionDeps {
  applyPatch(patch: EditPatch): { ok: true } | { ok: false; error: string }
  setSelection(ids: Iterable<string>): void
  nextId(): string
  /** 当前目标层（Alt 副本归层——currentLayerIdOf 语义）。 */
  currentLayerId(): string | null
  /** 预览读数写入口（interaction 态模块；拖拽中画布 ghost/读数消费）。 */
  onPreview(preview: { dx: number; dy: number; copy: boolean } | null): void
}

export interface MoveDragStartOptions {
  selected: readonly DesignerGem[]
  /** 被抓住的锚钻 id（吸附基准；缺席取首颗）。 */
  grabbedId: string | null
  /** 起拖即复制（Alt 按下起拖——会话期锁定）。 */
  alt: boolean
  snapMode: SnapMode
  pitch: number
}

export interface MoveDragSession {
  readonly active: boolean
  readonly preview: { dx: number; dy: number; copy: boolean } | null
  start(options: MoveDragStartOptions): boolean
  update(rawDx: number, rawDy: number, shift: boolean): void
  /** 松手提交：移动 = 单 update patch；复制 = 单 add patch（副本落最终位）+ 选集切副本。 */
  commit(): boolean
  /** Esc/系统打断：丢弃预览，不产 patch。 */
  cancel(): void
}

/**
 * 移动拖拽会话（P5）：start 锁定选集快照与 Alt 复制态 → update 逐帧决策（轴约束/吸附，
 * 预览不写 patch）→ commit 松手单 patch（一个 undo 组）。空选/无目标层（复制态）拒绝
 * 起拖。
 */
export function createMoveDragSession(deps: MoveDragSessionDeps): MoveDragSession {
  let started = false
  let copy = false
  let axis: 'x' | 'y' | null = null
  let delta = { dx: 0, dy: 0 }
  let selected: readonly DesignerGem[] = []
  let anchor = { x: 0, y: 0 }
  let snapMode: SnapMode = 'free'
  let pitch = 0

  return {
    get active() {
      return started
    },
    get preview() {
      return started ? { ...delta, copy } : null
    },
    start(options) {
      if (started || options.selected.length === 0) return false
      const grabbed =
        options.selected.find((g) => g.id === options.grabbedId) ?? options.selected[0]
      selected = [...options.selected]
      anchor = { x: grabbed.x, y: grabbed.y }
      copy = options.alt
      snapMode = options.snapMode
      pitch = options.pitch
      axis = null
      delta = { dx: 0, dy: 0 }
      started = true
      deps.onPreview({ ...delta, copy })
      return true
    },
    update(rawDx, rawDy, shift) {
      if (!started) return
      const resolved = resolveMoveDelta({
        rawDx,
        rawDy,
        shift,
        axis,
        snapMode,
        pitch,
        anchor,
      })
      axis = resolved.axis
      delta = { dx: resolved.dx, dy: resolved.dy }
      deps.onPreview({ ...delta, copy })
    },
    commit() {
      if (!started) return false
      started = false
      deps.onPreview(null)
      if (copy) {
        const targetLayer = deps.currentLayerId()
        if (targetLayer === null) return false
        const copies = buildGemCopies(selected, targetLayer, delta, deps.nextId)
        const result = deps.applyPatch({ op: 'add', gems: copies })
        if (result.ok) deps.setSelection(copies.map((c) => c.id))
        return result.ok
      }
      const changes = buildMoveChanges(selected, delta)
      if (changes === null) return false
      return deps.applyPatch({ op: 'update', changes }).ok
    },
    cancel() {
      if (!started) return
      started = false
      deps.onPreview(null)
    },
  }
}
