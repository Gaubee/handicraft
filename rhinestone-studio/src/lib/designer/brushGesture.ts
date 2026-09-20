/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.3 rename-and-expert-workbench；2026-09-21 迁移至 lib/designer] 笔刷
 *    意图流抽象：画钻/擦除起笔-move-收笔手势归约为「工具 + snap 态 + 落点序列」的纯数据流
 *    （begin/move/end 事件）；落钻/擦除算法消费接口（brushEngine）与测试共用。
 *    语义不变迁移（design §7.4 退役清单「迁移」行）。
 * 2. [2026-09-20 Pure] 纯 TS 零 runes/DOM——手势状态机可直接 vitest 驱动（起收组语义）。
 */

/** 笔刷工具（画钻/擦除共用同一手势通道；「选择/抓手/缩放」不是笔刷）。 */
export type BrushTool = 'draw' | 'erase'

/** 吸附态：格位（六方临时格）/ 自由。 */
export type SnapMode = 'grid' | 'free'

/** 图像坐标系落点。 */
export interface BrushPoint {
  x: number
  y: number
}

/** 一笔的完整意图：工具 + snap 态 + 落点序列（snap='grid' 时点已吸附格位）。 */
export interface BrushIntent {
  tool: BrushTool
  snap: SnapMode
  points: BrushPoint[]
}

export type BrushIntentEvent =
  | { phase: 'begin'; intent: BrushIntent }
  /** move：intent 为截至本次的完整意图；appended = 自上一事件新增的落点（至少 1 点） */
  | { phase: 'move'; intent: BrushIntent; appended: BrushPoint[] }
  | { phase: 'end'; intent: BrushIntent }

export type BrushIntentListener = (event: BrushIntentEvent) => void

/**
 * 笔刷手势会话（一起一收）：
 * - begin：起笔（首点），发 begin 事件；
 * - move：追加落点（与上一点完全相同则丢弃，不发事件——去重不产生空噪声）；
 * - end：收笔，发 end 事件（完整落点序列）；未起笔的 end 为 no-op。
 * 事件携带的 intent/points 均为快照拷贝（监听方持有安全）。
 */
export interface BrushGestureSession {
  readonly active: boolean
  readonly intent: BrushIntent | null
  begin(tool: BrushTool, snap: SnapMode, point: BrushPoint): void
  move(point: BrushPoint): boolean
  end(): BrushIntent | null
}

export function createBrushGesture(emit: BrushIntentListener): BrushGestureSession {
  let intent: BrushIntent | null = null
  return {
    get active(): boolean {
      return intent !== null
    },
    /** 只读快照（外部持有/改动不渗入会话）。 */
    get intent(): BrushIntent | null {
      return intent === null ? null : snapshotIntent(intent)
    },
    begin(tool: BrushTool, snap: SnapMode, point: BrushPoint): void {
      if (intent !== null) return // 连续起笔：沿用当前会话（防御）
      intent = { tool, snap, points: [{ ...point }] }
      emit({ phase: 'begin', intent: snapshotIntent(intent) })
    },
    move(point: BrushPoint): boolean {
      const current = intent
      if (current === null) return false
      const last = current.points[current.points.length - 1]
      if (last.x === point.x && last.y === point.y) return false
      current.points.push({ ...point })
      emit({ phase: 'move', intent: snapshotIntent(current), appended: [{ ...point }] })
      return true
    },
    end(): BrushIntent | null {
      const current = intent
      intent = null
      if (current === null) return null
      const snapshot = snapshotIntent(current)
      emit({ phase: 'end', intent: snapshot })
      return snapshot
    },
  }
}

function snapshotIntent(intent: BrushIntent): BrushIntent {
  return { tool: intent.tool, snap: intent.snap, points: intent.points.map((p) => ({ ...p })) }
}
