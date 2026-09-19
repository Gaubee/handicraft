/**
 * 物理锚 px/mm 不变量（gem-catalog W0 0.5，design §1.5 / spec「物理画幅与 px/mm 单源」）：
 * - 降采样锚定：pixelsPerMm = 实际交接 canvas 宽 ÷ widthMm（锚定实测 image.width，不盲用文件记录宽）
 * - 非正方形画幅：换算只取宽（heightMm 不参与 px/mm）
 * - 缺失/非法回退：恒 PIXELS_PER_MM（default 2.5 显式；消费方回退态必须写 anchorSource:'default'）
 * - 常量单源出口：engine PIXELS_PER_MM 唯一权威定义点存在（三处副本收编切换归 2.4，W0 不切）
 * 纯函数测试。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PIXELS_PER_MM, SS_TABLE, pixelsPerMmFromCanvas, PhysicalCanvasSchema } from '$lib/engine'

describe('pixelsPerMmFromCanvas 不变量（W0 0.5）', () => {
  it('降采样锚定：210×148mm 画幅以 1024px 宽交接 → 1024÷210（实测 image.width 为锚）', () => {
    const canvas = { widthMm: 210, heightMm: 148, anchorSource: 'declared' as const }
    expect(pixelsPerMmFromCanvas(1024, canvas)).toBeCloseTo(1024 / 210, 12)
    // 同一源图曾为 2048px 宽：文件记录宽不参与换算——px/mm 只随实际交接宽变
    expect(pixelsPerMmFromCanvas(2048, canvas)).toBeCloseTo(2048 / 210, 12)
    expect(pixelsPerMmFromCanvas(1024, canvas)).not.toBeCloseTo(2048 / 210, 6)
    // 物理不变量：一颗 2.8mm 钻的物理直径恒 2.8mm——px 直径 = 2.8 × px/mm，与交接分辨率共变
    expect(2.8 * pixelsPerMmFromCanvas(1024, canvas)).toBeCloseTo(2.8 * (1024 / 210), 12)
  })

  it('非正方形画幅：px/mm 只由宽派生（heightMm 不参与）', () => {
    const wide = { widthMm: 210, heightMm: 148, anchorSource: 'declared' as const }
    const tall = { widthMm: 210, heightMm: 297, anchorSource: 'declared' as const }
    expect(pixelsPerMmFromCanvas(1024, wide)).toBe(pixelsPerMmFromCanvas(1024, tall))
  })

  it('缺失/非法回退：canvas 缺席 / widthMm ≤ 0 / canvasWidthPx ≤ 0 → 恒 PIXELS_PER_MM（2.5）', () => {
    expect(PIXELS_PER_MM).toBe(2.5)
    expect(pixelsPerMmFromCanvas(1024, undefined)).toBe(2.5)
    expect(pixelsPerMmFromCanvas(1024, { widthMm: 0, heightMm: 148, anchorSource: 'declared' })).toBe(2.5)
    expect(pixelsPerMmFromCanvas(1024, { widthMm: Number.NaN, heightMm: 148, anchorSource: 'declared' })).toBe(2.5)
    expect(pixelsPerMmFromCanvas(1024, { widthMm: -3, heightMm: 148, anchorSource: 'declared' })).toBe(2.5)
    expect(pixelsPerMmFromCanvas(0, { widthMm: 210, heightMm: 148, anchorSource: 'declared' })).toBe(2.5)
    expect(pixelsPerMmFromCanvas(-5, { widthMm: 210, heightMm: 148, anchorSource: 'declared' })).toBe(2.5)
  })

  it('回退态显式：PhysicalCanvas 的 anchorSource 只有两值（declared | default——回退必须可见，schema 拒三值）', () => {
    expect(PhysicalCanvasSchema.safeParse({ widthMm: 210, heightMm: 148, anchorSource: 'default' }).success).toBe(true)
    expect(PhysicalCanvasSchema.safeParse({ widthMm: 210, heightMm: 148, anchorSource: 'guessed' }).success).toBe(false)
    expect(PhysicalCanvasSchema.safeParse({ widthMm: 210, heightMm: 148 }).success).toBe(false) // anchorSource 必填
  })

  it('常量单源出口：engine/spec.ts 定义 PIXELS_PER_MM（唯一权威点）；engine 域零第二定义', () => {
    const specSource = readFileSync(resolve(process.cwd(), 'src/lib/engine/spec.ts'), 'utf8')
    expect(specSource).toMatch(/export const PIXELS_PER_MM = 2\.5/)
    const gridSource = readFileSync(resolve(process.cwd(), 'src/lib/engine/grid.ts'), 'utf8')
    expect(gridSource).not.toMatch(/PIXELS_PER_MM\s*=/)
    const typesSource = readFileSync(resolve(process.cwd(), 'src/lib/engine/types.ts'), 'utf8')
    expect(typesSource).not.toMatch(/PIXELS_PER_MM\s*=/)
  })

  it('[gem-catalog 2.4] 三消费方收编：studio/gemprojReplay/quickLayout 零本地定义、统一 import $lib/engine（同值 2.5 行为零变化）', () => {
    const consumers = [
      'src/lib/stores/studio.svelte.ts',
      'src/lib/edit/gemprojReplay.ts',
      'src/lib/edit/quickLayout.ts',
    ]
    for (const file of consumers) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      // 零本地定义（含导出副本）——「第四处复制正在路上」防线（专家稿 §H-1）
      expect(source, `${file} 不得本地定义 PIXELS_PER_MM`).not.toMatch(/PIXELS_PER_MM\s*=/)
      // 统一出口消费（engine import 面出现常量名）
      expect(source, `${file} 应 import engine 的 PIXELS_PER_MM`).toMatch(/import[\s\S]*?\bPIXELS_PER_MM\b[\s\S]*?from '\$lib\/engine'/)
    }
    // 行为零变化（同参快照）：三消费方的推导常量同值——SS10@2.5px/mm = 7px（与 v1 引擎口径逐位一致）
    expect(SS_TABLE.SS10 * PIXELS_PER_MM).toBe(7)
    expect(PIXELS_PER_MM).toBe(2.5)
  })
})
