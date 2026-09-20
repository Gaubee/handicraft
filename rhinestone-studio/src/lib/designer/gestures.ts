/*
 * Orthogonal intents (max 5):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] §2 手势决策核（纯函数）：
 *    P1-P4 选择系——可选性判定（锁定层钻不可选中=视为空白 P1；隐藏层不渲染故不可选；
 *    框选仅收集未锁定且可见层钻 P4）。
 * 2. [P5 拖移] 移动增量决策：Shift 轴约束（初始拖向锁水平/垂直）+ 格位吸附（hexSnap，
 *    按当前 pitch）+ 松手单 patch 变更构造（buildMoveChanges）+ Alt 拖拽副本构造
 *    （buildGemCopies——design §4.1 复制行：id 走 'm-' 自增、origin='manual'、blockId=null、
 *    moved 重置、归当前目标层）。
 * 3. [P6 旋转] 旋转决策：指针角→朝向角（Shift=15° 步进；归一 [0,360)）。
 * 4. [P7 直径] 改径决策：拖拽半径→直径 mm（值域 (0,50]——越域/非法返回 null 由调用方回滚）。
 * 5. [Pure] 纯 TS 零 runes/DOM——§2 逐手势可直接 vitest；有状态会话（MoveDragSession）
 *    依赖注入 store patch 面，不触 DOM。
 */

import type { EditGem } from '$lib/engine'
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
// P6 旋转手柄：指针角 → 朝向角
// ---------------------------------------------------------------------------

/** 旋转步进档（Shift=15°；键位 [ ] 的 15°/5° 档在 commands 层复用同参数）。 */
export const ROTATE_STEP_DEG = 15
export const ROTATE_FINE_STEP_DEG = 5

/** 角度归一 [0,360)。 */
export function normalizeDeg(deg: number): number {
  const r = deg % 360
  return r < 0 ? r + 360 : r
}

/**
 * 旋转决策（P6）：新朝向 = 起始朝向 + 指针角位移；Shift = 15° 步进（四舍五入到最近
 * 步进格）；结果归一 [0,360)，保留 2 位小数（浮点尾差清洁）。
 */
export function rotationFromDrag(input: {
  startPointerAngle: number
  pointerAngle: number
  startRotationDeg: number
  shift: boolean
}): number {
  const raw = input.startRotationDeg + (input.pointerAngle - input.startPointerAngle)
  const stepped = input.shift ? Math.round(raw / ROTATE_STEP_DEG) * ROTATE_STEP_DEG : raw
  return Math.round(normalizeDeg(stepped) * 100) / 100
}

/** 指针相对钻心的方位角（度；atan2 屏幕系 y 向下——顺时针为正，与 rotationDeg 同向）。 */
export function pointerAngleDeg(cx: number, cy: number, px: number, py: number): number {
  return (Math.atan2(py - cy, px - cx) * 180) / Math.PI
}

/** 旋转变更构造（值未变 → null）。 */
export function buildRotationChange(gem: EditGem, rotationDeg: number): UpdateChange | null {
  const before = gem.rotationDeg ?? 0
  if (before === rotationDeg) return null
  return { id: gem.id, before: { rotationDeg: before }, after: { rotationDeg } }
}

// ---------------------------------------------------------------------------
// P7 直径手柄：拖拽半径 → 直径 mm
// ---------------------------------------------------------------------------

/** 直径值域上界（design §2 P7：(0,50] mm——非阻塞③判据；下界由 engine spec 域兜底）。 */
export const DIAMETER_MAX_MM = 50

/**
 * 改径决策（P7）：指针到钻心距离（px）→ 直径 mm。值域 (0,50]——越域或非法（非有限/
 * 非正）返回 null，调用方保持上一有效预览；会话收笔仍非法则回滚会话前值（不产 patch）。
 */
export function diameterFromDrag(
  radiusPx: number,
  pixelsPerMm: number,
): number | null {
  if (!Number.isFinite(radiusPx) || !Number.isFinite(pixelsPerMm) || pixelsPerMm <= 0) return null
  const mm = (2 * radiusPx) / pixelsPerMm
  if (!Number.isFinite(mm) || mm <= 0 || mm > DIAMETER_MAX_MM) return null
  return Math.round(mm * 100) / 100
}

/** 直径变更构造（值未变 → null）。 */
export function buildDiameterChange(gem: EditGem, diameterMm: number): UpdateChange | null {
  if (gem.diameterMm === diameterMm) return null
  return { id: gem.id, before: { diameterMm: gem.diameterMm }, after: { diameterMm } }
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
