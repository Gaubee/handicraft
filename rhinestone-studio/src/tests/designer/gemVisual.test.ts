/*
 * [2026-09-21 rework-designer-manual-rhinestone R5.2 走查回修 Test] 逐钻有效视觉规格
 * 纯投影（gemVisual——P1-1/P1-2 渲染断链的修复面）：
 * - pending 覆盖优先 / 缺席回落文档值（⌘T live 预览与帧 miss 回退共读单源）；
 * - 内置形剪影命令表（round/custom 回退圆快路径；四异形 bezier 序列）；
 * - traceShapeOn 命令执行序列（单位框 → 图像框坐标换算——jsdom 录制替身直驱）。
 */

import { describe, expect, it } from 'vitest'
import {
  effectiveGemVisual,
  fallbackShapeAspectOf,
  fallbackShapeBoxOf,
  fallbackShapeCommandsOf,
  traceShapeOn,
  type ShapeCommand,
  type ShapeTraceTarget,
} from '$lib/designer/gemVisual'

describe('effectiveGemVisual（pending 覆盖投影）', () => {
  const gem = { shapeId: 'marquise', diameterMm: 2.8, rotationDeg: 30 }

  it('无 pending = 文档值原样（shapeId/diameterMm/rotationDeg 缺省兜底）', () => {
    expect(effectiveGemVisual(gem)).toEqual({ shapeId: 'marquise', diameterMm: 2.8, rotationDeg: 30 })
    expect(effectiveGemVisual({})).toEqual({ shapeId: 'round', diameterMm: 0, rotationDeg: 0 })
    expect(effectiveGemVisual({ diameterMm: 3.5 })).toEqual({ shapeId: 'round', diameterMm: 3.5, rotationDeg: 0 })
  })

  it('pending 字段级覆盖：直径/角度各自独立生效（拖拽逐帧写→渲染单源读）', () => {
    expect(effectiveGemVisual(gem, { diameterMm: 8.06 })).toEqual({
      shapeId: 'marquise',
      diameterMm: 8.06,
      rotationDeg: 30,
    })
    expect(effectiveGemVisual(gem, { rotationDeg: 90 })).toEqual({
      shapeId: 'marquise',
      diameterMm: 2.8,
      rotationDeg: 90,
    })
    expect(effectiveGemVisual(gem, { diameterMm: 5.6, rotationDeg: 0 })).toEqual({
      shapeId: 'marquise',
      diameterMm: 5.6,
      rotationDeg: 0,
    })
  })
})

describe('内置形剪影命令表', () => {
  it('四异形有表；round/custom/未知形返回 null（走 arc 圆快路径）', () => {
    for (const shape of ['square', 'drop', 'heart', 'marquise']) {
      expect(fallbackShapeCommandsOf(shape)).not.toBeNull()
    }
    expect(fallbackShapeCommandsOf('round')).toBeNull()
    expect(fallbackShapeCommandsOf('custom')).toBeNull()
    expect(fallbackShapeCommandsOf('unknown')).toBeNull()
  })

  it('命令坐标全在单位框 0..1（描形不越框——描边余量语义）', () => {
    const shapes: Array<readonly ShapeCommand[]> = [
      fallbackShapeCommandsOf('square')!,
      fallbackShapeCommandsOf('drop')!,
      fallbackShapeCommandsOf('heart')!,
      fallbackShapeCommandsOf('marquise')!,
    ]
    for (const commands of shapes) {
      for (const cmd of commands) {
        for (const coord of cmd.slice(1) as number[]) {
          expect(coord).toBeGreaterThanOrEqual(0)
          expect(coord).toBeLessThanOrEqual(1)
        }
      }
      expect(commands[0][0]).toBe('M')
      expect(commands[commands.length - 1][0]).toBe('Z')
    }
  })
})

describe('traceShapeOn（单位框 → 图像框命令执行）', () => {
  interface Recorded {
    op: string
    args: number[]
  }
  function recorder(): { target: ShapeTraceTarget; calls: Recorded[] } {
    const calls: Recorded[] = []
    const rec = (op: string) => (...args: number[]) => calls.push({ op, args })
    return {
      target: {
        beginPath: () => calls.push({ op: 'beginPath', args: [] }),
        moveTo: rec('moveTo'),
        lineTo: rec('lineTo'),
        bezierCurveTo: rec('bezierCurveTo'),
        closePath: () => calls.push({ op: 'closePath', args: [] }),
      },
      calls,
    }
  }

  it('方钻：四角 lineTo 闭环——坐标 = (u-0.5)×size + 心', () => {
    const { target, calls } = recorder()
    traceShapeOn(target, fallbackShapeCommandsOf('square')!, 10, 20, 8)
    expect(calls[0]).toEqual({ op: 'beginPath', args: [] })
    const ops = calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo')
    // (0.04,0.04) → 心 + (-3.84,-3.84)
    expect(ops[0]).toEqual({ op: 'moveTo', args: [10 - 0.46 * 8, 20 - 0.46 * 8] })
    expect(ops[1]).toEqual({ op: 'lineTo', args: [10 + 0.46 * 8, 20 - 0.46 * 8] })
    expect(calls[calls.length - 1]).toEqual({ op: 'closePath', args: [] })
  })

  it('马眼：bezierCurveTo 四段（曲线剪影——非圆异形描形）', () => {
    const { target, calls } = recorder()
    traceShapeOn(target, fallbackShapeCommandsOf('marquise')!, 0, 0, 10)
    expect(calls.filter((c) => c.op === 'bezierCurveTo')).toHaveLength(4)
    // M 点 = 顶尖 (0.5, 0.04) → (0, -4.6)
    expect(calls.find((c) => c.op === 'moveTo')!.args).toEqual([0, (0.04 - 0.5) * 10])
  })
})

describe('剪影纵横比（R5.2 复验-R2 B：马眼 ≠ 方盒宽透镜）', () => {
  interface Recorded {
    op: string
    args: number[]
  }
  function recorder(): { target: ShapeTraceTarget; calls: Recorded[] } {
    const calls: Recorded[] = []
    const rec = (op: string) => (...args: number[]) => calls.push({ op, args })
    return {
      target: {
        beginPath: () => calls.push({ op: 'beginPath', args: [] }),
        moveTo: rec('moveTo'),
        lineTo: rec('lineTo'),
        bezierCurveTo: rec('bezierCurveTo'),
        closePath: () => calls.push({ op: 'closePath', args: [] }),
      },
      calls,
    }
  }

  it('fallbackShapeAspectOf：四异形与 engine SEED_ASPECTS 同值；表外形 = 1', () => {
    expect(fallbackShapeAspectOf('square')).toBe(1)
    expect(fallbackShapeAspectOf('drop')).toBeCloseTo(3 / 4.3, 10)
    expect(fallbackShapeAspectOf('heart')).toBeCloseTo(4.5 / 4.4, 10)
    expect(fallbackShapeAspectOf('marquise')).toBe(2.5 / 5)
    expect(fallbackShapeAspectOf('round')).toBe(1)
    expect(fallbackShapeAspectOf('custom')).toBe(1)
  })

  it('fallbackShapeBoxOf：长轴 = 直径；aspect < 1 宽收窄（马眼 100px → 50×100）', () => {
    expect(fallbackShapeBoxOf('marquise', 100)).toEqual({ w: 50, h: 100 })
    expect(fallbackShapeBoxOf('square', 80)).toEqual({ w: 80, h: 80 })
    // heart aspect > 1（宽 > 高）：宽 = 长轴、高 = 长轴/aspect
    const heart = fallbackShapeBoxOf('heart', 89)
    expect(heart.w).toBe(89)
    expect(heart.h).toBeCloseTo(89 / (4.5 / 4.4), 10)
  })

  it('traceShapeOn 各向异性内容盒：马眼单位框 x 压半宽、y 全高（真 2:1 透镜）', () => {
    const { target, calls } = recorder()
    traceShapeOn(target, fallbackShapeCommandsOf('marquise')!, 0, 0, 50, 100)
    // M 点 = 顶尖 (0.5, 0.04) → x = 0、y = (0.04-0.5)×100 = -46（全高映射）
    expect(calls.find((c) => c.op === 'moveTo')!.args).toEqual([0, -46])
    // 最宽段控制点 (0.96, 0.5) → x = (0.96-0.5)×50 = 23（半宽映射——旧正方盒为 46）
    const wide = calls.find((c) => c.op === 'bezierCurveTo' && (c.args[4] as number) === 23)
    expect(wide, 'x 控制点按宽 50 落位（非正方盒 46）').toBeDefined()
  })

  it('traceShapeOn h 缺省 = w（正方盒——旧调用零改动语义）', () => {
    const { target, calls } = recorder()
    traceShapeOn(target, fallbackShapeCommandsOf('square')!, 10, 20, 8)
    expect(calls.filter((c) => c.op === 'lineTo')[0]!.args).toEqual([10 + 0.46 * 8, 20 - 0.46 * 8])
  })
})
