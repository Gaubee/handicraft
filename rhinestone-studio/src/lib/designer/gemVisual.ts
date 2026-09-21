/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 rework-designer-manual-rhinestone R5.2 走查回修 P1-1/P1-2] 逐钻「有效视觉
 *    规格」纯投影：文档值（shapeId/diameterMm/rotationDeg）⊕ ⌘T 变换态 pending 覆盖
 *    （interaction.updateTransformPending 逐帧写）→ 渲染消费单源。画布 sprite 请求与几何
 *    回退路径**共读本投影**——回退几何不再退化为「网格半径正圆」（走查实证：sprite 帧
 *    miss 时 pending 直径/非圆形状/朝向全部不可见＝读数≠效果的渲染断链根源）。
 * 2. [P1-2] 内置形剪影（单位框 0..1 的 bezier 命令表——与 engine seed 矢量轮廓同构，
 *    designer 域本地实现不触 engine 冻结面）：几何回退路径按 shapeId 描形（custom/未知
 *    形回退圆）；traceShapeOn 把命令表执行到任意 2d 上下文（浏览器真 ctx / jsdom 录制
 *    替身同构——渲染循环消费可在 jsdom 断言）。
 * 3. [Pure] 纯 TS 零 runes/DOM——vitest 直驱（pending 覆盖/文档值/命令表执行序列）。
 */

import type { TransformPendingFields } from './gestures'

/** 逐钻渲染视觉规格（sprite 帧 key 与几何回退共用——pending 覆盖后的值）。 */
export interface GemVisualSpec {
  shapeId: string
  diameterMm: number
  rotationDeg: number
}

/** 最小读取面（EditGem 结构子集——纯函数不依赖 store/engine 运行时）。 */
export interface GemVisualInput {
  shapeId?: string
  diameterMm?: number
  rotationDeg?: number
}

/**
 * 逐钻有效视觉规格：pending（⌘T 拖拽中的 live 覆盖）优先，缺席回落文档值。
 * 直径缺席兜底 0（消费方对非正值走 sprite 拒绝/回退跳过——与 requestGemSprite 门一致）。
 */
export function effectiveGemVisual(
  gem: GemVisualInput,
  pending?: TransformPendingFields,
): GemVisualSpec {
  return {
    shapeId: gem.shapeId ?? 'round',
    diameterMm: pending?.diameterMm ?? gem.diameterMm ?? 0,
    rotationDeg: pending?.rotationDeg ?? gem.rotationDeg ?? 0,
  }
}

// ---------------------------------------------------------------------------
// [P1-2] 内置形剪影（单位框 bezier 命令表——几何回退描形）
// ---------------------------------------------------------------------------

/** 单位框路径命令（坐标 0..1；C = 三次 bezier 控制点对）。 */
export type ShapeCommand =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z']

/**
 * 四异形剪影（与 engine catalog SEED_VECTOR_PATHS 同构的控制点——designer 域本地表，
 * 不触 engine 冻结面；round 走 arc 快路径不入表；custom/未知形回退圆）。
 * 单位框四周留 0.04 边量（描边不入框外）。
 */
const FALLBACK_SHAPE_PATHS: Record<string, readonly ShapeCommand[]> = {
  square: [
    ['M', 0.04, 0.04],
    ['L', 0.96, 0.04],
    ['L', 0.96, 0.96],
    ['L', 0.04, 0.96],
    ['Z'],
  ],
  drop: [
    ['M', 0.5, 0.04],
    ['C', 0.74, 0.26, 0.96, 0.46, 0.96, 0.68],
    ['C', 0.96, 0.85, 0.76, 0.96, 0.5, 0.96],
    ['C', 0.24, 0.96, 0.04, 0.85, 0.04, 0.68],
    ['C', 0.04, 0.46, 0.26, 0.26, 0.5, 0.04],
    ['Z'],
  ],
  heart: [
    ['M', 0.5, 0.96],
    ['C', 0.14, 0.72, 0.04, 0.5, 0.04, 0.32],
    ['C', 0.04, 0.14, 0.18, 0.04, 0.32, 0.04],
    ['C', 0.42, 0.04, 0.48, 0.1, 0.5, 0.18],
    ['C', 0.52, 0.1, 0.58, 0.04, 0.68, 0.04],
    ['C', 0.82, 0.04, 0.96, 0.14, 0.96, 0.32],
    ['C', 0.96, 0.5, 0.86, 0.72, 0.5, 0.96],
    ['Z'],
  ],
  marquise: [
    ['M', 0.5, 0.04],
    ['C', 0.78, 0.22, 0.96, 0.38, 0.96, 0.5],
    ['C', 0.96, 0.62, 0.78, 0.78, 0.5, 0.96],
    ['C', 0.22, 0.78, 0.04, 0.62, 0.04, 0.5],
    ['C', 0.04, 0.38, 0.22, 0.22, 0.5, 0.04],
    ['Z'],
  ],
}

/** 剪影命令表读取（round/custom/未知形返回 null——消费方走 arc 圆快路径）。 */
export function fallbackShapeCommandsOf(shapeId: string): readonly ShapeCommand[] | null {
  return FALLBACK_SHAPE_PATHS[shapeId] ?? null
}

/**
 * [R5.2 复验-R2 B] 内置异形物理纵横比（宽/高——designer 域本地表，与 engine SEED_ASPECTS
 * 同源常量；单位框剪影的长轴 = 高轴）。回退描形必须按纵横比落内容盒：旧实现把单位框
 * 映射到直径×直径的**正方盒**——马眼（2.5/5）被画成「圆角方块」（复验实证：Enter 后
 * 13.43mm 马眼退化为方盒宽透镜）。round/custom 未知形 = 1（正方/圆）。
 */
const FALLBACK_SHAPE_ASPECTS: Record<string, number> = {
  square: 1,
  drop: 3 / 4.3,
  heart: 4.5 / 4.4,
  marquise: 2.5 / 5,
}

/** 剪影纵横比读取（表外形 = 1——正方盒）。 */
export function fallbackShapeAspectOf(shapeId: string): number {
  return FALLBACK_SHAPE_ASPECTS[shapeId] ?? 1
}

/**
 * 直径（= 最大径/长轴 px）→ 剪影内容盒（与 gemSprites 烘焙 contentBoxOf 同语义：
 * aspect ≥ 1 → 宽 = 长轴、高 = 长轴/aspect；aspect < 1 → 宽 = 长轴×aspect、高 = 长轴）。
 */
export function fallbackShapeBoxOf(shapeId: string, diameterPx: number): { w: number; h: number } {
  const aspect = fallbackShapeAspectOf(shapeId)
  return aspect >= 1
    ? { w: diameterPx, h: diameterPx / aspect }
    : { w: diameterPx * aspect, h: diameterPx }
}

/** 命令表执行的最小 2d 面（浏览器 ctx / jsdom 录制替身同构）。 */
export interface ShapeTraceTarget {
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cx1: number, cy1: number, cx2: number, cy2: number, x: number, y: number): void
  closePath(): void
}

/**
 * 单位框剪影描到目标路径（**不 fill/stroke**——描形与着色分离，消费方控制样式）：
 * 坐标换算 (u,v) → 以 (cx,cy) 为心、宽 w × 高 h 的内容盒（[R2 B] 纵横比落盒——h 缺省
 * = w 即正方盒，旧调用零改动；异形经 fallbackShapeBoxOf 取盒后马眼为真 2:1 透镜）；
 * 调用方负责外层平移/旋转（rotate 先行时命令点在已旋转坐标系内落位）。
 */
export function traceShapeOn(
  target: ShapeTraceTarget,
  commands: readonly ShapeCommand[],
  cx: number,
  cy: number,
  w: number,
  h: number = w,
): void {
  const px = (u: number): number => (u - 0.5) * w
  const py = (v: number): number => (v - 0.5) * h
  target.beginPath()
  for (const cmd of commands) {
    switch (cmd[0]) {
      case 'M':
        target.moveTo(cx + px(cmd[1]), cy + py(cmd[2]))
        break
      case 'L':
        target.lineTo(cx + px(cmd[1]), cy + py(cmd[2]))
        break
      case 'C':
        target.bezierCurveTo(
          cx + px(cmd[1]),
          cy + py(cmd[2]),
          cx + px(cmd[3]),
          cy + py(cmd[4]),
          cx + px(cmd[5]),
          cy + py(cmd[6]),
        )
        break
      case 'Z':
        target.closePath()
        break
    }
  }
}
