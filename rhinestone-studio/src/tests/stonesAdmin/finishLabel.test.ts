/*
 * finishLabel（add-stone-library S7.7 走查修复 2026-09-24）：
 * daemon 导入缺省 finish='unspecified' 不再裸露英文——统一「未声明」；
 * 空值 null（调用方隐藏）；人审值透传。纯函数直测。
 */

import { describe, expect, it } from 'vitest'
import { finishLabel } from '$lib/stonesAdmin/finishLabel'

describe('finishLabel（finish 展示标签）', () => {
  it("'unspecified'（daemon importer DEFAULT_FINISH）→「未声明」——英文裸露防线", () => {
    expect(finishLabel('unspecified')).toBe('未声明')
  })

  it('空串/纯空白 → null（调用方隐藏该段，不渲染悬挂分隔符）', () => {
    expect(finishLabel('')).toBeNull()
    expect(finishLabel('   ')).toBeNull()
  })

  it('人审值透传（glossy/matte 等改审结果不做二次翻译）', () => {
    expect(finishLabel('glossy')).toBe('glossy')
    expect(finishLabel('matte')).toBe('matte')
    expect(finishLabel('哑光')).toBe('哑光')
  })

  it('大小写敏感：Unspecified 不在映射域（只有 daemon 落的精确小写值）', () => {
    expect(finishLabel('Unspecified')).toBe('Unspecified')
  })
})
