/*
 * [2026-09-18 N1] computeFit 纯函数单测：jsdom 无法真渲染 canvas，
 * 移动画布取景正确性的唯一可测路径。方形/宽图/高图 × 容器尺寸组合，
 * 断言：contain 缩放系数精确、图居中、可见区占比 ≥ 90%（本实现恒为 100%）、退化输入安全。
 */

import { describe, expect, it } from 'vitest'
import { computeFit, FIT_SCALE_FACTOR } from '../../components/Studio/fit'

/** 两轴可见区占比（交叠长度 / 投影长度），断言 ≥0.9 用 */
function visibleRatio(fit: { scale: number; x: number; y: number }, cw: number, ch: number, iw: number, ih: number): number {
  const visibleX = Math.max(0, Math.min(cw, fit.x + iw * fit.scale) - Math.max(0, fit.x)) / (iw * fit.scale)
  const visibleY = Math.max(0, Math.min(ch, fit.y + ih * fit.scale) - Math.max(0, fit.y)) / (ih * fit.scale)
  return visibleX * visibleY
}

const CASES: Array<{ name: string; cw: number; ch: number; iw: number; ih: number }> = [
  // 方形图
  { name: '方形图·方形容器', cw: 600, ch: 420, iw: 512, ih: 512 },
  { name: '方形图·移动窄容器（N1 现场：341×286）', cw: 341, ch: 286, iw: 1024, ih: 1024 },
  { name: '方形图·容器远大于图', cw: 1200, ch: 900, iw: 256, ih: 256 },
  // 宽图
  { name: '宽图·桌面容器', cw: 908, ch: 440, iw: 1024, ih: 576 },
  { name: '宽图·移动窄容器（宽受限）', cw: 341, ch: 286, iw: 1024, ih: 512 },
  { name: '宽图·高容器（高富余）', cw: 300, ch: 800, iw: 1024, ih: 400 },
  // 高图
  { name: '高图·桌面容器', cw: 908, ch: 440, iw: 576, ih: 1024 },
  { name: '高图·移动窄容器', cw: 341, ch: 506, iw: 512, ih: 1024 },
  { name: '高图·宽容器（宽富余）', cw: 900, ch: 200, iw: 400, ih: 1024 },
]

describe('computeFit（N1 画布取景纯函数）', () => {
  it.each(CASES)('$name：contain 系数、居中、可见 ≥90%', ({ cw, ch, iw, ih }) => {
    const fit = computeFit(cw, ch, iw, ih)
    // contain × 留白系数，精确成立
    expect(fit.scale).toBeCloseTo(Math.min(cw / iw, ch / ih) * FIT_SCALE_FACTOR, 10)
    // 居中平移：两轴投影均落容器中央
    expect(fit.x).toBeCloseTo((cw - iw * fit.scale) / 2, 10)
    expect(fit.y).toBeCloseTo((ch - ih * fit.scale) / 2, 10)
    // 完整落在容器内（0.9 留白 ⇒ 四周各 ≥5% 边距）
    expect(fit.x).toBeGreaterThanOrEqual(0)
    expect(fit.y).toBeGreaterThanOrEqual(0)
    expect(fit.x + iw * fit.scale).toBeLessThanOrEqual(cw)
    expect(fit.y + ih * fit.scale).toBeLessThanOrEqual(ch)
    // 可见区占比 ≥ 90%（本实现恒为 100%，守住回归下限）
    expect(visibleRatio(fit, cw, ch, iw, ih)).toBeGreaterThanOrEqual(0.9)
  })

  it('等比缩放：图不变形（宽高同缩放系数）', () => {
    const fit = computeFit(720, 480, 1024, 768)
    const sx = (1024 * fit.scale) / 1024
    const sy = (768 * fit.scale) / 768
    expect(sx).toBeCloseTo(sy, 12)
  })

  it('退化输入返回单位视图（不抛 NaN）', () => {
    expect(computeFit(0, 0, 100, 100)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(computeFit(341, 286, 0, 100)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(computeFit(NaN, 286, 100, 100)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(computeFit(341, Infinity, 100, 100)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(computeFit(-341, 286, 100, 100)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('容器比图小时仍完整可见（移动端放大图不溢出）', () => {
    const fit = computeFit(100, 80, 4096, 4096)
    expect(fit.x).toBeGreaterThan(0)
    expect(fit.y).toBeGreaterThan(0)
    expect(fit.x + 4096 * fit.scale).toBeLessThanOrEqual(100)
    expect(fit.y + 4096 * fit.scale).toBeLessThanOrEqual(80)
  })
})
