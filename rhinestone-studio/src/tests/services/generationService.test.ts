/*
 * [2026-09-20 S-4.3 Test] generationService 仅类型编译（rename-and-expert-workbench tasks 4.3）：
 * 接口位占位 + 归属注释登记（生命周期契约归姊妹 change add-lab-drill-params-and-blueprint）；
 * 禁止预填字段——零运行时导出断言 + 类型面存在性（svelte-check 编译期门）。
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenerationService } from '$lib/services/generationService'

describe('generationService 接口位', () => {
  it('类型面存在（编译期）；运行时零导出（禁止预填字段）', async () => {
    expectTypeOf<GenerationService>().not.toBeNever()
    const mod = await import('$lib/services/generationService')
    expect(Object.keys(mod)).toEqual([])
  })

  it('归属注释登记：姊妹 change 拥有契约冻结权', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/services/generationService.ts'), 'utf8')
    expect(source).toContain('add-lab-drill-params-and-blueprint')
    expect(source).toContain('禁止预填字段')
  })
})
