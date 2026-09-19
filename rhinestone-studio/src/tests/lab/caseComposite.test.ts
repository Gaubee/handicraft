/**
 * 案例合成参照图基建（[Owner 2026-09-19 参照对退役]）：
 * - pickCaseLayout 纯函数：正方形/4:3 边界 → 横向；任一图 > 4/3（大横图）→ 纵向
 * - composeCaseComposite 的 jsdom 降级契约：无 2D 上下文 → null（调用方降级 single）；
 *   真机合成质量（角标/中缝/contain）由走查验证，不在单测覆盖
 */
import { describe, expect, it } from 'vitest'
import {
  caseLayoutLabel,
  composeCaseComposite,
  pickCaseLayout,
  VERTICAL_LAYOUT_ASPECT_THRESHOLD,
} from '$lib/lab/caseComposite'

describe('pickCaseLayout：任一图宽高比 > 4/3 → 纵向', () => {
  it('两图均为正方形 → 横向（默认）', () => {
    expect(pickCaseLayout({ width: 800, height: 800 }, { width: 512, height: 512 })).toBe('horizontal')
  })

  it('两图均为 4:3（恰好阈值，不大于）→ 横向', () => {
    expect(pickCaseLayout({ width: 1024, height: 768 }, { width: 800, height: 600 })).toBe('horizontal')
    expect(VERTICAL_LAYOUT_ASPECT_THRESHOLD).toBe(4 / 3)
  })

  it('任一图超过 4:3 → 纵向（16:9 大横图横向拼接会得到超宽合成图）', () => {
    expect(pickCaseLayout({ width: 1920, height: 1080 }, { width: 800, height: 800 })).toBe('vertical')
    expect(pickCaseLayout({ width: 800, height: 800 }, { width: 1600, height: 900 })).toBe('vertical')
  })

  it('轻微超阈（1.34 > 4/3）→ 纵向', () => {
    expect(pickCaseLayout({ width: 134, height: 100 }, { width: 100, height: 100 })).toBe('vertical')
  })

  it('零高守卫：退化 aspect=1 → 横向', () => {
    expect(pickCaseLayout({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe('horizontal')
  })
})

describe('composeCaseComposite：jsdom 降级契约', () => {
  it('无 2D 上下文（jsdom 未装 canvas 包）→ 返回 null（调用方降级取效果图单张）', () => {
    const canvas = composeCaseComposite(
      { bitmap: new Image(), width: 800, height: 800 },
      { bitmap: new Image(), width: 800, height: 800 },
      'horizontal',
    )
    expect(canvas).toBeNull()
  })
})

describe('caseLayoutLabel：UI 布局注记', () => {
  it('三态文案', () => {
    expect(caseLayoutLabel('horizontal')).toContain('横向拼接')
    expect(caseLayoutLabel('horizontal')).toContain('左原图')
    expect(caseLayoutLabel('vertical')).toContain('纵向拼接')
    expect(caseLayoutLabel('vertical')).toContain('上原图')
    expect(caseLayoutLabel('single')).toContain('单张')
  })
})
